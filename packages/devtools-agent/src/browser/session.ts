import { AgentError } from '../protocol/errors';
import type { BrowserEvent } from '../protocol/types';
import type { WorkspaceService } from '../workspace/service';
import { PageSources } from './sources';

interface EventQuery {
  after?: number;
  methods?: string[];
  limit?: number;
  tail?: boolean;
}
type Context = {
  id: number;
  uniqueId?: string;
  name: string;
  origin: string;
  auxData?: { isDefault?: boolean; frameId?: string };
  sessionId?: string;
};

export class BrowserSession {
  readonly sources: PageSources;
  connected = false;
  private attaching?: Promise<void>;
  private detachedReason?: string;
  private seq = 0;
  private bytes = 0;
  private buffer: (BrowserEvent & { bytes: number })[] = [];
  private executionContexts = new Map<string, Context>();
  private waiters = new Set<{
    method: string;
    sessionId?: string;
    resolve: (event: BrowserEvent) => void;
    reject: (error: Error) => void;
  }>();
  private childSessions = new Set<string>();
  private childPages = new Set<string>();
  private mainFrameId?: string;
  private invalidHandles = new Set<string>();
  private handles = new Map<string, string | undefined>();
  constructor(
    public tabId: number,
    private workspace: WorkspaceService,
    private changed: () => void,
    private detached: (reason: string) => void,
    private beforeAttach: () => Promise<void> = async () => {},
    private navigated: (url: string) => void = () => {},
  ) {
    this.sources = new PageSources({
      ensure: () => this.ensure(),
      command: (method, params, sessionId) => this.command(method, params, sessionId),
      sessions: () => [...this.childSessions],
      pageSessions: () => [...this.childPages],
      frame: (id, sessionId) =>
        this.executionContexts.get(this.contextKey(id, sessionId))?.auxData?.frameId,
    });
    this.workspace.sources = this.sources;
    chrome.debugger.onEvent.addListener(this.onEvent);
    chrome.debugger.onDetach.addListener(this.onDetach);
  }
  async connect() {
    if (this.connected) return;
    if (this.attaching) return this.attaching;
    this.attaching = (async () => {
      await this.beforeAttach();
      await new Promise<void>((resolve, reject) =>
        chrome.debugger.attach({ tabId: this.tabId }, '1.3', () => {
          const error = chrome.runtime.lastError;
          error
            ? reject(new AgentError('attach_failed', error.message ?? 'Cannot attach debugger.'))
            : resolve();
        }),
      );
      this.connected = true;
      this.detachedReason = undefined;
      try {
        await this.enableDomains();
        const tree = (await this.command('Page.getFrameTree')) as {
          frameTree: { frame: { id: string } };
        };
        this.mainFrameId = tree.frameTree.frame.id;
        await this.command('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
      } catch (error) {
        await this.disconnect();
        throw error;
      }
      this.changed();
    })();
    try {
      await this.attaching;
    } finally {
      this.attaching = undefined;
    }
  }
  async disconnect() {
    if (!this.connected) return;
    await this.releaseExecution();
    await new Promise<void>((resolve) =>
      chrome.debugger.detach({ tabId: this.tabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      }),
    );
    this.reset('disconnected');
    this.changed();
  }
  async releaseExecution() {
    if (!this.connected) return;
    // Resume paused targets and stop interception before letting go of the client.
    for (const sessionId of [undefined, ...this.childSessions]) {
      await this.command('Debugger.resume', {}, sessionId).catch(() => {});
      await this.command('Fetch.disable', {}, sessionId).catch(() => {});
    }
  }
  async dispose() {
    await this.disconnect();
    this.sources.dispose();
    chrome.debugger.onEvent.removeListener(this.onEvent);
    chrome.debugger.onDetach.removeListener(this.onDetach);
  }
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    // Child targets are attached by this session, never by an arbitrary model-supplied target ID.
    if (method.startsWith('Target.') && !(method === 'Target.getTargetInfo' && !params.targetId)) {
      throw new AgentError(
        'target_scope',
        'Target discovery/attachment is owned by BrowserSession. Commands are limited to the inspected tab and its attached child sessions.',
      );
    }
    await this.ensure();
    for (const key of ['objectId', 'callFrameId']) {
      if (typeof params[key] === 'string' && this.invalidHandles.has(params[key] as string))
        throw new AgentError(
          'context_changed',
          'Navigation invalidated this handle. Query the new context.',
        );
    }
    if (sessionId && !this.childSessions.has(sessionId))
      throw new AgentError('context_changed', 'Child session no longer exists.');
    const result = await this.command(method, params, sessionId);
    this.trackHandles(result, sessionId);
    const text = JSON.stringify(result);
    if (text && text.length > 256 * 1024)
      throw new AgentError(
        'size_limit',
        'Protocol result exceeds 256 KiB. Use a smaller query or a saved artifact.',
      );
    return result;
  }
  async evaluate(expression: string, options: { contextId?: number; sessionId?: string } = {}) {
    if (typeof expression !== 'string')
      throw new AgentError('invalid_input', 'evaluate expects a JavaScript expression string.');
    await this.ensure();
    if (
      options.contextId &&
      !this.executionContexts.has(this.contextKey(options.contextId, options.sessionId))
    )
      throw new AgentError('context_changed', 'Execution context no longer exists.');
    const result = (await this.send(
      'Runtime.evaluate',
      {
        expression,
        contextId: options.contextId,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      options.sessionId,
    )) as {
      result: { value?: unknown; unserializableValue?: string; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails)
      throw new AgentError(
        'page_exception',
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      );
    return result.result.value ?? result.result.unserializableValue ?? null;
  }
  async contexts() {
    await this.ensure();
    return [...this.executionContexts.values()];
  }
  events({ after = 0, methods, limit = 50, tail = false }: EventQuery = {}) {
    const matches = this.buffer.filter(
      (event) => event.seq > after && (!methods?.length || methods.includes(event.method)),
    );
    const count = Math.max(1, Math.min(limit, 200));
    return (tail ? matches.slice(-count) : matches.slice(0, count)).map(
      ({ bytes: _, ...event }) => event,
    );
  }
  recentEvents(limit = 200) {
    return this.buffer.slice(-Math.min(limit, 200)).map(({ bytes: _, ...event }) => event);
  }
  /** Entire in-memory event buffer, for debug export. */
  allEvents(): BrowserEvent[] {
    return this.buffer.map(({ bytes: _, ...event }) => event);
  }
  async waitForEvent(
    method: string,
    options: { timeoutMs?: number; sessionId?: string } = {},
    signal?: AbortSignal,
  ) {
    await this.ensure();
    signal?.throwIfAborted();
    return this.wait(method, options, signal);
  }
  async reload(
    options: { waitUntil?: 'domcontentloaded' | 'load'; timeoutMs?: number } = {},
    signal?: AbortSignal,
  ) {
    return this.navigateCommand('Page.reload', { ignoreCache: true }, options, signal);
  }
  async navigate(
    url: string,
    options: { waitUntil?: 'domcontentloaded' | 'load'; timeoutMs?: number } = {},
    signal?: AbortSignal,
  ) {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new AgentError('invalid_input', 'browser.navigate requires an absolute HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(target.protocol))
      throw new AgentError('invalid_input', 'browser.navigate requires an absolute HTTP(S) URL.');
    return this.navigateCommand('Page.navigate', { url: target.href }, options, signal);
  }
  private async navigateCommand(
    method: 'Page.reload' | 'Page.navigate',
    params: Record<string, unknown>,
    options: { waitUntil?: 'domcontentloaded' | 'load'; timeoutMs?: number },
    signal?: AbortSignal,
  ) {
    await this.ensure();
    signal?.throwIfAborted();
    const cleanup = new AbortController();
    const waitingSignal = AbortSignal.any([cleanup.signal, ...(signal ? [signal] : [])]);
    const pending = this.wait(
      options.waitUntil === 'load' ? 'Page.loadEventFired' : 'Page.domContentEventFired',
      options,
      waitingSignal,
    );
    const withinDocument =
      method === 'Page.navigate'
        ? this.wait('Page.navigatedWithinDocument', options, waitingSignal)
        : undefined;
    // Observe rejections immediately, even if the command takes longer than the deadline.
    void pending.catch(() => {});
    void withinDocument?.catch(() => {});
    try {
      const result = (await this.command(method, params)) as {
        loaderId?: string;
        errorText?: string;
      };
      if (result.errorText) throw new AgentError('navigation_failed', result.errorText);
      if (withinDocument && !result.loaderId) return await Promise.race([pending, withinDocument]);
      return await pending;
    } finally {
      cleanup.abort();
    }
  }
  async screenshot(options: { format?: 'png' | 'jpeg' } = {}) {
    await this.ensure();
    const format = options.format ?? 'png';
    const result = (await this.command('Page.captureScreenshot', {
      format,
      captureBeyondViewport: false,
    })) as { data: string };
    const bytes = Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0));
    return this.workspace.artifact(
      new Blob([bytes], { type: `image/${format}` }),
      `screenshot.${format}`,
    );
  }
  async responseBody(requestId: string, sessionId?: string) {
    return this.send('Network.getResponseBody', { requestId }, sessionId);
  }
  private async ensure() {
    if (this.connected) return;
    if (this.detachedReason)
      throw new AgentError(
        'debugger_detached',
        `${this.detachedReason}. Reconnect explicitly with browser.connect() or the UI.`,
      );
    await this.connect();
  }
  private command(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<unknown> {
    return new Promise((resolve, reject) =>
      chrome.debugger.sendCommand(
        { tabId: this.tabId, ...(sessionId ? { sessionId } : {}) },
        method,
        params,
        (result) => {
          const error = chrome.runtime.lastError;
          if (error && /debugger is not attached/i.test(error.message ?? '')) {
            this.reset('Debugging connection lost');
            this.changed();
            this.detached('Debugging connection lost');
            reject(
              new AgentError(
                'debugger_detached',
                'Debugging connection lost. Reconnect explicitly.',
              ),
            );
          } else if (error)
            reject(
              new AgentError(
                /context|object.*not found|could not find object|call.?frame|session.*not found/i.test(
                  error.message ?? '',
                )
                  ? 'context_changed'
                  : 'protocol_error',
                error.message ?? 'Protocol command failed.',
              ),
            );
          else resolve(result ?? null);
        },
      ),
    );
  }
  private async enableDomains(sessionId?: string) {
    for (const domain of ['Runtime', 'Log', 'Page', 'Network']) {
      if (sessionId && domain === 'Page') continue;
      await this.command(`${domain}.enable`, {}, sessionId);
    }
  }
  private wait(
    method: string,
    options: { timeoutMs?: number; sessionId?: string },
    signal?: AbortSignal,
  ) {
    return new Promise<BrowserEvent>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        signal?.removeEventListener('abort', abort);
      };
      const waiter = {
        method,
        sessionId: options.sessionId,
        resolve: (event: BrowserEvent) => {
          cleanup();
          resolve(event);
        },
        reject: (error: Error) => {
          cleanup();
          reject(error);
        },
      };
      const abort = () => waiter.reject(new DOMException('Cancelled', 'AbortError'));
      const timer = setTimeout(
        () => waiter.reject(new AgentError('timeout', `Timed out waiting for ${method}.`)),
        Math.min(options.timeoutMs ?? 15000, 60000),
      );
      this.waiters.add(waiter);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
  }
  private contextKey(id: number, sessionId?: string) {
    return `${sessionId ?? 'main'}:${id}`;
  }
  private invalidate(sessionId?: string) {
    for (const [key, context] of this.executionContexts)
      if (context.sessionId === sessionId) this.executionContexts.delete(key);
    for (const [handle, owner] of this.handles)
      if (owner === sessionId) {
        this.invalidHandles.add(handle);
        this.handles.delete(handle);
      }
    // Remember previously exposed protocol handles, including paused call frames.
    for (const event of this.buffer) {
      if (event.sessionId !== sessionId) continue;
      const text = JSON.stringify(event.params);
      for (const match of text.matchAll(/"(?:objectId|callFrameId)":"([^"]+)"/g))
        this.invalidHandles.add(match[1]);
    }
    if (this.invalidHandles.size > 5000) this.invalidHandles.clear();
  }
  private trackHandles(value: unknown, sessionId?: string) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'objectId' || key === 'callFrameId') && typeof child === 'string')
        this.handles.set(child, sessionId);
      else if (child && typeof child === 'object') this.trackHandles(child, sessionId);
    }
  }
  private onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== this.tabId) return;
    const sessionId = (source as chrome.debugger.Debuggee & { sessionId?: string }).sessionId;
    if (sessionId && !this.childSessions.has(sessionId)) return;
    const data = (params ?? {}) as Record<string, any>;
    this.sources.event(method, data, sessionId);
    if (method === 'Runtime.executionContextCreated') {
      const context = { ...data.context, sessionId } as Context;
      this.executionContexts.set(this.contextKey(context.id, sessionId), context);
    } else if (method === 'Runtime.executionContextDestroyed') {
      this.executionContexts.delete(this.contextKey(data.executionContextId, sessionId));
    } else if (method === 'Runtime.executionContextsCleared') {
      this.invalidate(sessionId);
      this.sources.invalidate(true, sessionId);
    } else if (
      method === 'Page.navigatedWithinDocument' &&
      !sessionId &&
      data.frameId === this.mainFrameId
    ) {
      this.sources.invalidate(false);
      this.navigated(data.url);
    } else if (method === 'Page.frameNavigated') {
      this.sources.invalidate(false);
      if (!data.frame.parentId) {
        this.invalidate(sessionId);
        if (!sessionId) {
          this.mainFrameId = data.frame.id;
          this.navigated(data.frame.url);
        }
      } else {
        for (const [key, context] of this.executionContexts) {
          if (context.sessionId === sessionId && context.auxData?.frameId === data.frame.id)
            this.executionContexts.delete(key);
        }
      }
    } else if (method === 'Page.frameDetached') {
      this.sources.invalidate(false);
    } else if (method === 'Target.attachedToTarget') {
      this.childSessions.add(data.sessionId);
      if (data.targetInfo?.type === 'iframe') this.childPages.add(data.sessionId);
      this.enableDomains(data.sessionId)
        .then(() => this.sources.enable(data.sessionId))
        .then(() =>
          this.command(
            'Target.setAutoAttach',
            { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
            data.sessionId,
          ).catch(() => {}),
        )
        .catch((error) =>
          this.push('Agent.childSessionError', { message: String(error) }, data.sessionId),
        );
    } else if (method === 'Target.detachedFromTarget') {
      this.childSessions.delete(data.sessionId);
      this.childPages.delete(data.sessionId);
      this.invalidate(data.sessionId);
    }
    const event = this.push(method, params ?? {}, sessionId);
    for (const waiter of [...this.waiters])
      if (waiter.method === method && waiter.sessionId === sessionId) waiter.resolve(event);
  };
  private onDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (source.tabId !== this.tabId) return;
    this.reset(reason);
    this.changed();
    this.detached(reason);
  };
  private push(method: string, params: unknown, sessionId?: string): BrowserEvent {
    let text = JSON.stringify(params);
    if (text.length > 64 * 1024) {
      params = { truncated: true, preview: text.slice(0, 64 * 1024) };
      text = JSON.stringify(params);
    }
    const event = {
      seq: ++this.seq,
      method,
      params,
      sessionId,
      at: Date.now(),
      bytes: text.length * 2,
    };
    this.buffer.push(event);
    this.bytes += event.bytes;
    while (this.buffer.length > 2000 || this.bytes > 2 * 1024 * 1024)
      this.bytes -= this.buffer.shift()!.bytes;
    this.changed();
    return event;
  }
  private reset(reason: string) {
    this.sources.disconnected();
    this.connected = false;
    this.detachedReason = reason;
    this.handles.clear();
    this.executionContexts.clear();
    this.childSessions.clear();
    this.childPages.clear();
    for (const waiter of [...this.waiters])
      waiter.reject(new AgentError('debugger_detached', reason));
  }
}
