import {
  ToolLoopAgent,
  asSchema,
  generateText,
  convertToModelMessages,
  readUIMessageStream,
  InvalidToolInputError,
  NoSuchToolError,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import { BrowserSession } from '../browser/session';
import { ReplClient } from '../repl/client';
import { HttpClient, type HttpOptions } from '../http/client';
import {
  DevtoolsNetworks,
  type NetworkListOptions,
  type NetworkBodyOptions,
} from '../networks/service';
import { validateHostCall } from '../repl/contracts';
import { ScriptService, installedSummary } from '../scripts/service';
import { openAgentDB, type AgentDB } from '../workspace/database';
import { WorkspaceService, fileSummary } from '../workspace/service';
import { acquireSessionLease } from '../workspace/lease';
import { DEFAULT_SESSION_TITLE, SessionService } from '../workspace/session';
import { siteWorkspaceId } from '../workspace/site';
import { createModel, loadSettings, saveSettings, checkConnection } from '../model/settings';
import { ACTIVE_TOOLS, createTools } from '../agent/tools';
import { prepareToolOutput } from '../agent/output';
import { FileTools } from '../agent/file-tools';
import { INSTRUCTIONS } from '../agent/prompt';
import { API_DOCS } from '../workspace/docs';
import { buildDebugPack, type DebugPackTool } from '../debug/export';
import { normalizeMessageIds, toolInputHint } from '../agent/messages';
import { applyInjections, interleave } from '../agent/interleave';
import { ContextCompactor, COMPACTION_PROMPT, applyContextCheckpoint } from '../agent/context';
import { AgentError, SerialQueue, errorData, sleep } from '../protocol/errors';
import type {
  ModelSettings,
  OperationRecord,
  PortEvent,
  PortRequest,
  RunRecord,
  ScriptStoreAdapter,
  Snapshot,
  ToolResult,
} from '../protocol/types';

const ACTIVE = new Set(['generating', 'executing', 'stopping']);
export class Controller {
  private db!: AgentDB;
  workspace!: WorkspaceService;
  session!: SessionService;
  browser!: BrowserSession;
  private scripts!: ScriptService;
  private fileTools!: FileTools;
  private repl!: ReplClient;
  private http = new HttpClient();
  private networks = new DevtoolsNetworks();
  private queue = new SerialQueue();
  private messages: UIMessage[] = [];
  private conversationId!: string;
  private clearing?: Promise<void>;
  private run?: RunRecord;
  private abort?: AbortController;
  private toolsAbort = new AbortController();
  private operationSignal?: AbortSignal;
  private activeStream?: string;
  private chunks: UIMessageChunk[] = [];
  private ports = new Set<MessagePort>();
  private timer?: ReturnType<typeof setTimeout>;
  private streamTask?: Promise<void>;
  private error?: string;
  private releaseSession?: () => void;
  private siteChanges: Promise<void> = Promise.resolve();
  private updates?: BroadcastChannel;
  private disposed = false;
  private onTabUpdated = (id: number, change: chrome.tabs.OnUpdatedInfo) => {
    if (id === this.tabId && change.url) void this.syncTarget(change.url).catch(() => {});
  };
  constructor(
    public tabId: number,
    private adapter: ScriptStoreAdapter,
    private targetUrl = '',
    private beforeAttach: () => Promise<void> = async () => {},
  ) {}
  async init() {
    this.db = await openAgentDB();
    this.workspace = await WorkspaceService.create(this.db, this.targetUrl || 'about:blank');
    await this.restoreSession();
    this.browser = this.createBrowser();
    await this.loadSession();
    this.updates = new BroadcastChannel('monkeyagent:workspace-changes');
    this.updates.onmessage = ({ data }) => {
      if (data === this.workspace.id) this.publish();
    };
    chrome.tabs.onUpdated?.addListener(this.onTabUpdated);
    return this;
  }
  private async restoreSession() {
    const [history, workspace, tabs] = await Promise.all([
      SessionService.list(this.db, this.workspace.id),
      this.workspace.metadata(),
      chrome.tabs.query({}),
    ]);
    const preferred = workspace.lastSessionByTab?.[this.tabId];
    const liveTabs = new Set(tabs.map((tab) => tab.id));
    const available = history.filter(
      (session) => session.targetTabId === undefined || !liveTabs.has(session.targetTabId),
    );
    const latest =
      history.find((session) => session.id === preferred) ??
      history.find((session) => session.targetTabId === this.tabId) ??
      available.find((session) => session.targetUrl === this.targetUrl) ??
      available[0];
    this.session = latest
      ? new SessionService(this.db, latest.id)
      : await SessionService.create(this.db, this.workspace.id, this.targetUrl, this.tabId);
    try {
      // Chrome may still be releasing the previous renderer's lock during a quick reopen.
      // The same inspected tab has one native DevTools window; wait for its handover.
      this.releaseSession = await acquireSessionLease(
        this.session.id,
        latest?.targetTabId === this.tabId,
      );
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'session_busy') throw error;
      this.session = await SessionService.create(
        this.db,
        this.workspace.id,
        this.targetUrl,
        this.tabId,
      );
      this.releaseSession = await acquireSessionLease(this.session.id);
    }
    await this.session.activate(this.targetUrl, this.tabId);
  }
  private syncTarget(url: string): Promise<void> {
    const change = this.siteChanges.then(async () => {
      if (url === this.targetUrl || this.disposed) return;
      await this.clearing;
      if (siteWorkspaceId(url) === this.workspace.id) {
        this.targetUrl = url;
        await this.session.patch({ targetUrl: url });
      } else {
        this.stop();
        await this.streamTask;
        await this.queue.onIdle();
        this.workspace.changed = () => {};
        await this.browser.dispose();
        this.releaseSession?.();
        this.targetUrl = url;
        this.workspace = await WorkspaceService.create(this.db, url);
        await this.restoreSession();
        this.browser = this.createBrowser();
        await this.loadSession();
        this.error = undefined;
      }
      this.notifyWorkspace();
    });
    this.siteChanges = change.catch((error) => {
      this.error = errorData(error).message;
      this.publish();
    });
    return change;
  }
  private notifyWorkspace() {
    this.updates?.postMessage(this.workspace.id);
    this.publish();
  }
  async dispose() {
    this.disposed = true;
    this.networks.dispose();
    clearTimeout(this.timer);
    this.timer = undefined;
    chrome.tabs.onUpdated?.removeListener(this.onTabUpdated);
    this.updates?.close();
    this.updates = undefined;
    this.stop();
    await this.streamTask;
    await this.queue.onIdle();
    await this.siteChanges;
    await this.browser.dispose();
    this.releaseSession?.();
    this.db.close();
  }
  private createBrowser() {
    return new BrowserSession(
      this.tabId,
      this.workspace,
      () => this.publish(),
      (reason) => {
        this.error = `Debugger disconnected: ${reason}`;
        this.stop();
        this.publish();
      },
      this.beforeAttach,
      (url) => {
        void this.syncTarget(url).catch(() => {});
      },
    );
  }
  private async loadSession() {
    this.workspace.sessionId = this.session.id;
    const workspaceId = this.workspace.id;
    this.workspace.changed = () => {
      this.updates?.postMessage(workspaceId);
      if (workspaceId === this.workspace.id) this.publish();
    };
    for (const run of await this.db.getAllFromIndex('runs', 'sessionId', this.session.id))
      if (ACTIVE.has(run.status))
        await this.db.put('runs', { ...run, status: 'interrupted', endedAt: Date.now() });
    for (const operation of await this.db.getAllFromIndex(
      'operations',
      'sessionId',
      this.session.id,
    ))
      if (operation.status === 'started')
        await this.db.put('operations', { ...operation, status: 'unknown' });
    this.scripts = new ScriptService(this.workspace, this.adapter);
    this.fileTools = new FileTools(this.workspace);
    this.repl?.stop();
    this.repl = new ReplClient((method, args, signal) => this.hostCall(method, args, signal));
    const storedMessages = (await this.db.get('conversations', this.session.id))?.messages ?? [];
    this.messages = normalizeMessageIds(storedMessages);
    if (this.messages.some((message, index) => message !== storedMessages[index]))
      await this.persistMessages();
    this.conversationId = (await this.session.metadata()).conversationId ?? this.session.id;
    this.run = (await this.db.getAllFromIndex('runs', 'sessionId', this.session.id))
      .filter((run) => (run.conversationId ?? run.sessionId) === this.conversationId)
      .sort((a, b) => b.startedAt - a.startedAt)[0];
  }
  attach(port: MessagePort) {
    for (const previous of this.ports) previous.close();
    this.ports.clear();
    this.ports.add(port);
    port.onmessage = async ({ data }: MessageEvent<PortRequest>) => {
      if (data.type !== 'request') return;
      try {
        port.postMessage({
          type: 'response',
          id: data.id,
          result: await this.dispatch(data.method, data.args),
        });
      } catch (error) {
        port.postMessage({ type: 'response', id: data.id, error: errorData(error) });
      }
    };
    port.onmessageerror = () => {
      this.ports.delete(port);
      port.close();
    };
    port.start();
    this.publish();
  }
  async snapshot(): Promise<Snapshot> {
    for (;;) {
      await this.siteChanges;
      const workspace = this.workspace;
      const session = this.session;
      const [metadata, current, files, history, operations] = await Promise.all([
        workspace.metadata(),
        session.metadata(),
        workspace.allFiles(),
        SessionService.list(this.db, workspace.id),
        this.db.getAllFromIndex('operations', 'sessionId', session.id),
      ]);
      // Navigation or a session switch may have happened while reading IndexedDB.
      if (workspace !== this.workspace || session !== this.session) continue;
      return {
        workspace: metadata,
        session: current,
        files,
        messages: this.messages,
        run: this.run,
        connected: this.browser.connected,
        events: this.browser.recentEvents(),
        history,
        operations: operations.sort((a, b) => b.startedAt - a.startedAt).slice(0, 100),
        error: this.error,
      };
    }
  }

  private emit(event: PortEvent) {
    for (const port of this.ports)
      try {
        port.postMessage(event);
      } catch {
        this.ports.delete(port);
      }
  }
  private publish() {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      try {
        this.emit({ type: 'event', event: 'snapshot', data: await this.snapshot() });
      } catch (error) {
        console.error(error);
      }
    }, 100);
  }
  async dispatch(method: string, args: unknown[]): Promise<unknown> {
    const requestSignal = this.toolsAbort.signal;
    if (method !== 'stop') {
      await this.siteChanges;
      const target = await chrome.tabs.get(this.tabId);
      if (target.url) await this.syncTarget(target.url);
    }
    if (
      [
        'chat.start',
        'repl.run',
        'scripts.import',
        'scripts.apply',
        'scripts.setEnabled',
        'browser.connect',
      ].includes(method)
    )
      requestSignal.throwIfAborted();
    if (
      this.clearing &&
      [
        'chat.start',
        'chat.resume',
        'chat.queue',
        'workspace.new',
        'session.new',
        'session.open',
        'workspace.open',
        'repl.run',
        'scripts.import',
        'scripts.apply',
        'scripts.setEnabled',
        'browser.connect',
      ].includes(method)
    )
      throw new AgentError('busy', 'Wait for the conversation context to finish clearing.');
    // Explicit surface, never index arbitrary properties on privileged services.
    switch (method) {
      case 'snapshot':
        return this.snapshot();
      case 'error.clear':
        this.error = undefined;
        this.publish();
        return;
      case 'settings.get':
        return loadSettings();
      case 'settings.save':
        return saveSettings(args[0] as ModelSettings);
      case 'settings.check':
        return checkConnection(args[0] as ModelSettings);
      case 'chat.start': {
        if (this.streamTask) throw new AgentError('busy', 'A task is already running.');
        const [streamId, messages, conversationId] = args as [string, UIMessage[], string];
        if (conversationId !== this.conversationId)
          throw new AgentError(
            'context_changed',
            'The conversation was reset. Send from the current conversation.',
          );
        this.activeStream = streamId;
        this.chunks = [];
        this.streamTask = this.start(messages).finally(() => {
          this.streamTask = undefined;
        });
        return { streamId };
      }
      case 'chat.resume': {
        if (args[2] !== this.conversationId || !this.streamTask || !this.activeStream) return null;
        const streamId = args[0] as string;
        this.activeStream = streamId;
        for (const chunk of this.chunks)
          this.emit({ type: 'event', event: 'chunk', streamId, data: chunk });
        return { streamId };
      }
      case 'chat.clear': {
        await (this.clearing ??= this.clearConversation().finally(() => {
          this.clearing = undefined;
        }));
        return this.snapshot();
      }
      case 'chat.queue': {
        if (!this.streamTask || !this.run || !this.abort || this.abort.signal.aborted)
          throw new AgentError('not_running', 'No running task to steer.');
        const text = String(args[0]).trim();
        if (!text || text.length > 100000)
          throw new AgentError('invalid_input', 'Message is empty or too long.');
        this.run.queued.push(text);
        await this.saveRun();
        return;
      }
      case 'stop':
        return this.stop();
      case 'browser.connect':
        return this.browser.connect();
      case 'browser.disconnect': {
        this.stop();
        return this.browser.disconnect();
      }
      case 'repl.run': {
        const [code, timeoutMs] = args as [string, number?];
        return this.execute('repl', { code, timeoutMs }, () =>
          this.repl.run(code, timeoutMs, this.operationSignal),
        );
      }
      case 'files.write':
        return this.workspace.write(...(args as [string, string, string?]));
      case 'files.rename':
        return this.workspace.rename(...(args as [string, string, string]));
      case 'files.remove':
        return this.workspace.remove(...(args as [string, string]));
      case 'files.read':
        return this.workspace.read(...(args as [string, { offset?: number; limit?: number }?]));
      case 'files.list': {
        const root = args[0];
        if (root !== '/workspace' && root !== '/docs' && root !== '/artifacts')
          throw new AgentError(
            'invalid_path',
            'Files panel roots are /workspace, /docs and /artifacts.',
          );
        return this.workspace.list(root);
      }
      case 'scripts.history':
        return this.scripts.history(args[0] as string);
      case 'scripts.version':
        return this.scripts.version(args[0] as string, args[1] as string);
      case 'scripts.restore':
        return this.scripts.restore(
          args[0] as string,
          args[1] as string,
          args[2] as string,
          args[3] as string,
        );
      case 'scripts.list':
        return this.scripts.list();
      case 'scripts.status':
        return this.scripts.status(args[0] as string);
      case 'scripts.import':
        return this.execute(method, args, () => this.scripts.import(...(args as [string, string])));
      case 'scripts.apply':
        return this.execute(method, args, () => this.scripts.apply(args[0] as string));
      case 'scripts.setEnabled':
        return this.execute(method, args, () =>
          this.scripts.setEnabled(...(args as [string, boolean])),
        );
      case 'session.new':
      case 'workspace.new':
        return this.switchSession();
      case 'session.open':
      case 'workspace.open':
        return this.switchSession(args[0] as string);
      case 'artifact.get': {
        const ref = await this.db.get('artifacts', args[0] as string);
        if (ref?.workspaceId !== this.workspace.id)
          throw new AgentError('not_found', 'Artifact not found.');
        return ref;
      }
      case 'artifacts.list':
        return (await this.db.getAllFromIndex('artifacts', 'workspaceId', this.workspace.id)).map(
          ({ blob: _, ...ref }) => ref,
        );
      case 'debug.export':
        return this.exportDebugPack();
      default:
        throw new AgentError('unknown_method', `Unknown controller method: ${method}`);
    }
  }
  private async switchSession(id?: string) {
    const change = this.siteChanges.then(async () => {
      if (this.streamTask || this.queue.size)
        throw new AgentError(
          'busy',
          'Stop the current task and wait for tools to finish before switching sessions.',
        );
      if (id === this.session.id) return;
      const next = id
        ? new SessionService(this.db, id)
        : await SessionService.create(this.db, this.workspace.id, this.targetUrl, this.tabId);
      if ((await next.metadata()).workspaceId !== this.workspace.id)
        throw new AgentError('site_scope', 'Session belongs to a different site.');
      const release = await acquireSessionLease(next.id);
      try {
        await next.activate(this.targetUrl, this.tabId);
      } catch (error) {
        release();
        throw error;
      }
      this.repl.stop();
      this.session = next;
      this.releaseSession?.();
      this.releaseSession = release;
      await this.browser.dispose();
      this.browser = this.createBrowser();
      await this.loadSession();
      this.error = undefined;
      this.notifyWorkspace();
    });
    this.siteChanges = change.catch(() => {});
    await change;
    return this.snapshot();
  }
  private async clearConversation() {
    this.stop();
    // Let persistence and queued tools settle before deleting messages. A late stream must
    // never repopulate the cleared conversation or continue with the next user request.
    await this.streamTask;
    await this.queue.onIdle();
    const conversationId = crypto.randomUUID();
    const tx = this.db.transaction(['sessions', 'conversations', 'runs'], 'readwrite');
    const session = await tx.objectStore('sessions').get(this.session.id);
    if (!session) throw new AgentError('not_found', 'Session not found.');
    await tx.objectStore('sessions').put({
      ...session,
      conversationId,
      title: DEFAULT_SESSION_TITLE,
      context: undefined,
      updatedAt: Date.now(),
    });
    await tx.objectStore('conversations').put({ id: this.session.id, messages: [] });
    if (this.run) await tx.objectStore('runs').put({ ...this.run, queued: [] });
    await tx.done;
    this.conversationId = conversationId;
    this.messages = [];
    this.fileTools.reset();
    this.run = undefined;
    this.chunks = [];
    this.activeStream = undefined;
    this.error = undefined;
    this.notifyWorkspace();
  }
  private async start(messages: UIMessage[]) {
    messages = normalizeMessageIds(messages);
    const abort = (this.abort = new AbortController());
    this.messages = [...messages];
    this.error = undefined;
    this.run = {
      id: crypto.randomUUID(),
      workspaceId: this.workspace.id,
      sessionId: this.session.id,
      conversationId: this.conversationId,
      startedAt: Date.now(),
      status: 'generating',
      queued: [],
      injected: [],
      steps: [],
    };
    let failed = false;
    try {
      await this.persistMessages();
      await this.saveRun();
      const lastText =
        messages
          .at(-1)
          ?.parts.filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join(' ') ?? '';
      if (messages.filter((m) => m.role === 'user').length === 1)
        await this.session.patch({ title: lastText.slice(0, 60) || DEFAULT_SESSION_TITLE });
      const settings = await loadSettings();
      this.run.model = {
        provider: settings.provider,
        baseURL: settings.baseURL,
        model: settings.model,
        supportsImages: settings.supportsImages,
        autoCompactTokenLimit: settings.autoCompactTokenLimit ?? 64000,
      };
      const target = await chrome.tabs.get(this.tabId);
      const targetUrl = target.url ?? this.targetUrl;
      if (siteWorkspaceId(targetUrl) !== this.workspace.id)
        throw new AgentError(
          'site_changed',
          'The inspected tab changed site. Send from its current session.',
        );
      this.targetUrl = targetUrl;
      await this.session.patch({ targetUrl: this.targetUrl });
      this.notifyWorkspace();
      const tools = createTools({
        workspace: this.workspace,
        fileTools: this.fileTools,
        supportsImages: settings.supportsImages,
        execute: (name, input, fn, signal) => this.execute(name, input, fn, signal),
        repl: (code, timeout, signal) =>
          this.repl.run(code, timeout, this.operationSignal ?? signal),
      });
      let steps = 0;
      const injected = this.run.injected!;
      let assistant: UIMessage | undefined;
      // Queued user messages are shown where the agent consumed them, splitting the reply.
      const compose = () => {
        this.messages = [...messages, ...interleave(assistant, injected)];
      };
      const modelMessages = await convertToModelMessages(messages, {
        tools,
        ignoreIncompleteToolCalls: true,
      });
      const model = createModel(settings);
      const instructions = await this.buildInstructions(settings.supportsImages);
      const toolDefinitions = await Promise.all(
        ACTIVE_TOOLS.map(async (name) => ({
          name,
          description: tools[name].description,
          schema: await asSchema<unknown>(tools[name].inputSchema!).jsonSchema,
        })),
      );
      const session = this.session;
      const conversationId = this.conversationId;
      const context = new ContextCompactor({
        limit: settings.autoCompactTokenLimit ?? 64000,
        overhead: { instructions, tools: toolDefinitions },
        checkpoint: (await session.metadata()).context,
        summarize: async (transcript, maxOutputTokens, signal) => {
          const result = await generateText({
            model,
            system: COMPACTION_PROMPT,
            prompt: transcript,
            maxOutputTokens,
            maxRetries: 0,
            abortSignal: signal,
          });
          return result.text;
        },
        save: (checkpoint) => session.saveContext(checkpoint, conversationId),
        status: async (status) => {
          this.run!.compaction = status;
          await this.saveRun();
        },
      });
      const agent = new ToolLoopAgent({
        model,
        tools,
        activeTools: [...ACTIVE_TOOLS],
        // No step cap: the loop ends when the model stops calling tools, or when the user stops it.
        // An explicit condition is required; omitting stopWhen falls back to the SDK default cap.
        stopWhen: () => false,
        toolCallConcurrency: 1,
        maxRetries: 1,
        instructions,
        prepareStep: async ({ initialMessages, responseMessages, stepNumber }) => {
          this.run!.status = 'generating';
          // SDK message overrides carry forward. Always derive checkpoint boundaries from
          // the original transcript, rather than summarizing an already shortened view.
          const stepMessages = [...initialMessages, ...responseMessages];
          const consumeQueued = () => {
            const queued = this.run!.queued.splice(0);
            for (const text of queued)
              injected.push({
                id: crypto.randomUUID(),
                text,
                step: stepNumber,
                at: stepMessages.length,
              });
            return queued;
          };
          consumeQueued();
          compose();
          await this.persistMessages();
          await this.saveRun();
          const toMessage = (content: string) => ({ role: 'user' as const, content });
          const input = applyInjections(stepMessages, injected, toMessage);
          const prepared = await context.prepare(input, abort.signal);
          const lateQueued = consumeQueued();
          if (lateQueued.length) {
            compose();
            await this.persistMessages();
            await this.saveRun();
          }
          return { messages: [...prepared, ...lateQueued.map(toMessage)] };
        },
        onStepEnd: async (step) => {
          context.observe(step.usage.inputTokens);
          steps++;
          this.run!.steps!.push({
            index: steps,
            endedAt: Date.now(),
            finishReason: step.finishReason,
            inputTokens: step.usage.inputTokens,
            outputTokens: step.usage.outputTokens,
            toolCalls: step.toolCalls.map(({ toolCallId, toolName }) => ({ toolCallId, toolName })),
          });
          await this.saveRun();
        },
      });
      const result = await agent.stream({
        messages: modelMessages,
        abortSignal: abort.signal,
      });
      const stream = result.toUIMessageStream({
        originalMessages: messages,
        generateMessageId: () => crypto.randomUUID(),
        sendReasoning: false,
        onError: (error) => {
          // SDK invokes this for recoverable tool validation errors as well as fatal errors.
          // Only a real `error` stream chunk (handled below) fails the run.
          if (InvalidToolInputError.isInstance(error)) return toolInputHint(error.toolName);
          if (NoSuchToolError.isInstance(error))
            return 'Unknown tool. Available tools are Read, Write, Edit, Glob, Grep and repl; read /docs/agent-guide.md.';
          return errorData(error).message;
        },
      });
      const [ui, persistence] = stream.tee();
      const consumeUI = (async () => {
        for await (const chunk of ui) {
          this.chunks.push(chunk);
          this.emit({ type: 'event', event: 'chunk', streamId: this.activeStream, data: chunk });
        }
      })();
      for await (const message of readUIMessageStream({
        stream: persistence,
        onError: (error) => {
          failed = true;
          this.error ??= errorData(error).message;
        },
      })) {
        assistant = message;
        compose();
        await this.persistMessages();
        this.publish();
      }
      await consumeUI;
      this.run.finishReason = failed ? 'error' : await result.finishReason;
      if (this.run.finishReason === 'error') failed = true;
      this.run.status = abort.signal.aborted ? 'interrupted' : failed ? 'failed' : 'completed';
      if (failed) this.run.error = this.error ?? 'Model stream ended with an error.';
    } catch (error) {
      this.error ??= errorData(error).message;
      this.run.status = abort.signal.aborted ? 'interrupted' : 'failed';
      this.run.error = this.error;
      this.emit({
        type: 'event',
        event: 'stream-error',
        streamId: this.activeStream,
        data: this.error,
      });
    } finally {
      // this.messages already includes consumed messages: compose() runs on every injection.
      this.run.endedAt = Date.now();
      try {
        await this.persistMessages();
        await this.saveRun();
      } catch (error) {
        this.error = errorData(error).message;
        this.emit({
          type: 'event',
          event: 'stream-error',
          streamId: this.activeStream,
          data: this.error,
        });
      } finally {
        this.emit({ type: 'event', event: 'stream-end', streamId: this.activeStream, data: null });
        this.abort = undefined;
        this.publish();
      }
    }
  }
  /** System prompt for a run started now; shared by runs and debug export. */
  private async buildInstructions(supportsImages: boolean) {
    const directory = await this.workspace.list();
    const interrupted = (await this.db.getAllFromIndex('operations', 'sessionId', this.session.id))
      .filter((op) => op.status === 'unknown')
      .map(({ id, name }) => ({ id, name }));
    return `${INSTRUCTIONS}\nImage input: ${supportsImages ? 'enabled' : 'disabled; screenshots can be saved but you cannot inspect pixels'}\nBound inspected tab: ${this.tabId}\nTarget URL: ${this.targetUrl}\nWorkspace directory: ${JSON.stringify(directory)}\nInterrupted operations: ${JSON.stringify(interrupted)}`;
  }
  private async exportDebugPack() {
    const settings = await loadSettings();
    const unavailable = async (): Promise<never> => {
      throw new AgentError('debug_export', 'Tools cannot run during debug export.');
    };
    const tools = createTools({
      workspace: this.workspace,
      fileTools: this.fileTools,
      supportsImages: settings.supportsImages,
      execute: unavailable,
      repl: unavailable,
    });
    const messages = normalizeMessageIds(this.messages);
    let modelMessages: unknown;
    try {
      modelMessages = await applyContextCheckpoint(
        await convertToModelMessages(messages, {
          tools,
          ignoreIncompleteToolCalls: true,
        }),
        (await this.session.metadata()).context,
      );
    } catch (error) {
      modelMessages = { error: errorData(error).message };
    }
    const manifest = chrome.runtime.getManifest();
    const pack = await buildDebugPack({
      db: this.db,
      workspaceId: this.workspace.id,
      sessionId: this.session.id,
      messages,
      modelMessages,
      instructions: await this.buildInstructions(settings.supportsImages),
      tools: tools as unknown as Record<string, DebugPackTool>,
      activeTools: ACTIVE_TOOLS,
      docs: API_DOCS,
      settings,
      browser: {
        tabId: this.tabId,
        targetUrl: this.targetUrl,
        connected: this.browser.connected,
        events: this.browser.allEvents(),
      },
      runtime: {
        extension: manifest.name,
        version: manifest.version,
        userAgent: navigator.userAgent,
      },
    });
    return {
      filename: pack.filename,
      blob: new Blob([pack.data as BlobPart], { type: 'application/zip' }),
      counts: pack.counts,
    };
  }
  stop() {
    this.abort?.abort();
    this.toolsAbort.abort();
    this.toolsAbort = new AbortController();
    this.repl?.stop();
    void this.browser?.releaseExecution();
    if (this.run && ACTIVE.has(this.run.status)) {
      this.run.status = 'stopping';
      void this.saveRun();
    }
  }
  private async execute(
    name: string,
    input: unknown,
    fn: () => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    signal = AbortSignal.any([this.toolsAbort.signal, ...(signal ? [signal] : [])]);
    return this.queue.execute(async () => {
      const start = performance.now();
      const operation: OperationRecord = {
        id: crypto.randomUUID(),
        workspaceId: this.workspace.id,
        sessionId: this.session.id,
        runId: this.abort ? this.run?.id : undefined,
        name,
        input,
        status: 'started',
        startedAt: Date.now(),
      };
      await this.db.put('operations', operation);
      if (this.abort && this.run) {
        this.run.status = 'executing';
        await this.saveRun();
      }
      this.publish();
      this.operationSignal = signal;
      let result: ToolResult;
      try {
        const value = await fn();
        signal?.throwIfAborted();
        result = {
          success: true,
          ...(await prepareToolOutput(this.workspace, name, value)),
          durationMs: performance.now() - start,
        };
        if (name === 'repl' && this.repl.warnings.length)
          result.warnings = [...(result.warnings ?? []), ...this.repl.warnings];
        operation.status = 'completed';
      } catch (error) {
        result = { success: false, error: errorData(error), durationMs: performance.now() - start };
        operation.status =
          signal?.aborted || result.error?.code === 'timeout' ? 'unknown' : 'failed';
      }
      operation.endedAt = Date.now();
      operation.output = result;
      this.operationSignal = undefined;
      await this.db.put('operations', operation);
      this.publish();
      return result;
    }, signal);
  }
  private async hostCall(
    method: string,
    args: unknown[],
    runSignal?: AbortSignal,
  ): Promise<unknown> {
    const signal = this.operationSignal;
    signal?.throwIfAborted();
    validateHostCall(method, args);
    switch (method) {
      case 'runtime.sleep':
        return sleep(args[0] as number, signal);
      case 'http.request':
        return this.http.request(
          args[0] as string,
          args[1] as HttpOptions | undefined,
          AbortSignal.any([...(signal ? [signal] : []), ...(runSignal ? [runSignal] : [])]),
        );
      case 'networks.status':
      case 'networks.getHAR':
      case 'networks.list':
      case 'networks.get':
      case 'networks.requestBody':
      case 'networks.responseBody': {
        const readSignal = AbortSignal.any([
          ...(signal ? [signal] : []),
          ...(runSignal ? [runSignal] : []),
        ]);
        if (method === 'networks.status') return this.networks.status(readSignal);
        if (method === 'networks.getHAR') return this.networks.getHAR(readSignal);
        if (method === 'networks.list')
          return this.networks.list(args[0] as NetworkListOptions | undefined, readSignal);
        if (method === 'networks.get') return this.networks.get(args[0] as string, readSignal);
        if (method === 'networks.requestBody')
          return this.networks.requestBody(args[0] as string, readSignal);
        return this.networks.responseBody(
          args[0] as string,
          args[1] as NetworkBodyOptions | undefined,
          readSignal,
        );
      }
      case 'fs.list':
        return this.workspace.list(...(args as [string?]));
      case 'fs.read':
        return this.workspace.read(...(args as [string, { offset?: number; limit?: number }?]));
      case 'fs.write':
        return fileSummary(await this.workspace.write(...(args as [string, string, string?])));
      case 'fs.edit':
        return fileSummary(
          await this.workspace.edit(...(args as [string, string, string, string])),
        );
      case 'fs.remove':
        return this.workspace.remove(...(args as [string, string]));
      case 'fs.rename':
        return fileSummary(await this.workspace.rename(...(args as [string, string, string])));
      case 'fs.search':
        return this.workspace.search(...(args as [string, string?]));
      case 'browser.connect':
        return this.browser.connect();
      case 'browser.disconnect':
        return this.browser.disconnect();
      case 'browser.evaluate':
        return this.browser.evaluate(
          ...(args as [string, { contextId?: number; sessionId?: string }?]),
        );
      case 'browser.send':
        return this.browser.send(...(args as [string, Record<string, unknown>?, string?]));
      case 'browser.contexts':
        return this.browser.contexts();
      case 'browser.events':
        return this.browser.events(...(args as [Parameters<BrowserSession['events']>[0]?]));
      case 'browser.waitForEvent':
        return this.browser.waitForEvent(args[0] as string, args[1] as object, signal);
      case 'browser.reload':
        return this.browser.reload(args[0] as object, signal);
      case 'browser.navigate':
        return this.browser.navigate(args[0] as string, args[1] as object, signal);
      case 'browser.screenshot':
        return this.browser.screenshot(...(args as [object?]));
      case 'browser.responseBody':
        return this.browser.responseBody(...(args as [string, string?]));
      case 'browser.verify': {
        const [path, expression] = args as [string, string];
        const passed = await this.browser.evaluate(expression);
        if (typeof passed !== 'boolean')
          throw new AgentError(
            'invalid_verification',
            'Verification expression must return a boolean.',
          );
        return this.scripts.verify(path, passed, expression);
      }
      case 'scripts.list':
        return this.scripts.list();
      case 'scripts.import':
        return fileSummary(await this.scripts.import(...(args as [string, string])));
      case 'scripts.apply': {
        return installedSummary(await this.scripts.apply(...(args as [string])));
      }
      case 'scripts.status':
        return this.scripts.status(...(args as [string]));
      case 'scripts.setEnabled':
        return this.scripts.setEnabled(...(args as [string, boolean]));
      default:
        throw new AgentError('unknown_host_method', method);
    }
  }
  private async persistMessages() {
    await this.db.put('conversations', { id: this.session.id, messages: this.messages });
  }
  private async saveRun() {
    if (this.run) await this.db.put('runs', this.run);
    this.publish();
  }
}
