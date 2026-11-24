import { AgentError } from '../protocol/errors';
import { SOURCE_CACHE_BYTES, SOURCE_FILE_BYTES } from '../workspace/source';
import type { SourceFile, SourceProvider, SourceRecord } from '../workspace/source';

interface Backend {
  ensure(): Promise<void>;
  command(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  sessions(): string[];
  pageSessions?(): string[];
  frame(contextId: number, sessionId?: string): string | undefined;
}
interface Script {
  scriptId: string;
  url: string;
  executionContextId: number;
  startLine: number;
  startColumn: number;
  hasSourceURL?: boolean;
  scriptLanguage?: string;
  sourceMapURL?: string;
  sessionId?: string;
}
interface ResourceTree {
  frame: { id: string; url: string; mimeType?: string };
  resources: { url: string; type: string; mimeType: string }[];
  childFrames?: ResourceTree[];
}
interface Entry extends SourceFile {
  identity: string;
  load(): Promise<{ content: string; encoded?: boolean }>;
}
const encoder = new TextEncoder();
const TTL = 5 * 60 * 1000;
const INDEX_LIMIT = 10000;

/** An ephemeral host-only mount. Never fetches URLs or stores source bodies in IndexedDB. */
export class PageSources implements SourceProvider {
  private epoch = 0;
  private mountId = crypto.randomUUID();
  private serial = 0;
  private active = false;
  private disposed = false;
  private enabled = new Map<string, Promise<void>>();
  private scripts = new Map<string, Script>();
  private entries = new Map<string, Entry>();
  private identities = new Map<string, string>();
  private cache = new Map<string, { file: SourceRecord; bytes: number; at: number }>();
  private pending = new Map<string, Promise<SourceRecord>>();
  private cacheBytes = 0;
  private overflow = false;
  private listing?: Promise<SourceFile[]>;
  constructor(
    private backend: Backend,
    private inspected = chrome.devtools?.inspectedWindow,
  ) {
    inspected?.onResourceContentCommitted?.addListener(this.committed);
  }
  dispose() {
    this.disposed = true;
    this.inspected?.onResourceContentCommitted?.removeListener(this.committed);
    this.invalidate();
  }
  private committed = () => this.invalidate(false);
  /** Bump the generation even for an in-flight load; its late result must not be reused. */
  invalidate(clearScripts = true, sessionId?: string) {
    this.epoch++;
    this.entries.clear();
    this.identities.clear();
    this.cache.clear();
    this.pending.clear();
    this.cacheBytes = 0;
    this.listing = undefined;
    if (clearScripts) {
      if (sessionId) {
        this.enabled.delete(sessionId);
        for (const [key, script] of this.scripts)
          if (script.sessionId === sessionId) this.scripts.delete(key);
      } else this.scripts.clear();
      this.overflow = false;
    }
  }
  disconnected() {
    this.invalidate();
    this.enabled.clear();
  }
  event(method: string, data: Record<string, any>, sessionId?: string) {
    if (method === 'Debugger.scriptParsed') {
      const key = `${sessionId ?? 'main'}:${data.scriptId}`;
      if (this.scripts.size >= INDEX_LIMIT && !this.scripts.has(key)) {
        this.overflow = true;
        return;
      }
      this.scripts.set(key, {
        scriptId: data.scriptId,
        url: data.url,
        executionContextId: data.executionContextId,
        startLine: data.startLine,
        startColumn: data.startColumn,
        hasSourceURL: data.hasSourceURL,
        scriptLanguage: data.scriptLanguage,
        sessionId,
        sourceMapURL: data.sourceMapURL,
      });
      // Live-edit emits scriptParsed with the same id.
      for (const entry of this.entries.values()) {
        if (entry.scriptId === data.scriptId && entry.sessionId === sessionId) {
          this.invalidate(false);
          break;
        }
      }
    } else if (method === 'Runtime.executionContextDestroyed') {
      for (const [key, script] of this.scripts)
        if (script.sessionId === sessionId && script.executionContextId === data.executionContextId)
          this.scripts.delete(key);
      this.invalidate(false);
    } else if (method === 'Target.detachedFromTarget') {
      this.enabled.delete(data.sessionId);
      this.invalidate(true, data.sessionId);
    }
  }
  async enable(sessionId?: string) {
    if (!this.active) return;
    const key = sessionId ?? 'main';
    let pending = this.enabled.get(key);
    if (!pending) {
      pending = this.backend
        .command('Debugger.enable', { maxScriptsCacheSize: SOURCE_CACHE_BYTES }, sessionId)
        .then(() => {});
      this.enabled.set(key, pending);
    }
    try {
      await pending;
    } catch (error) {
      this.enabled.delete(key);
      throw error;
    }
  }
  async list(): Promise<SourceFile[]> {
    if (this.listing) return this.listing;
    const epoch = this.epoch;
    const listing = this.collect(epoch);
    this.listing = listing;
    try {
      return await listing;
    } finally {
      if (this.listing === listing) this.listing = undefined;
    }
  }
  private async collect(epoch: number): Promise<SourceFile[]> {
    await this.backend.ensure();
    this.active = true;
    await Promise.all([this.enable(), ...this.backend.sessions().map((id) => this.enable(id))]);
    const tree = (await this.backend.command('Page.getResourceTree')) as {
      frameTree: ResourceTree;
    };
    const childTrees = await Promise.all(
      (this.backend.pageSessions?.() ?? []).map(async (sessionId) => {
        await this.backend.command('Page.enable', {}, sessionId);
        return {
          sessionId,
          tree: (await this.backend.command('Page.getResourceTree', {}, sessionId)) as {
            frameTree: ResourceTree;
          },
        };
      }),
    );
    this.check(epoch);
    if (this.overflow)
      throw new AgentError(
        'source_index_limit',
        'The source index exceeds 10000 scripts. Narrowing a path cannot recover an incomplete index.',
      );
    const resources: {
      frameId: string;
      url: string;
      type: string;
      mimeType?: string;
      sessionId?: string;
    }[] = [];
    const walk = (node: ResourceTree, sessionId?: string) => {
      resources.push({
        frameId: node.frame.id,
        url: node.frame.url,
        type: 'Document',
        mimeType: node.frame.mimeType,
        sessionId,
      });
      for (const resource of node.resources ?? [])
        resources.push({ ...resource, frameId: node.frame.id, sessionId });
      node.childFrames?.forEach((child) => walk(child, sessionId));
    };
    walk(tree.frameTree);
    childTrees.forEach((child) => walk(child.tree.frameTree, child.sessionId));
    if (resources.length + this.scripts.size > INDEX_LIMIT)
      throw new AgentError('source_index_limit', 'The source index exceeds 10000 entries.');
    // The DevTools resource API has no frame identity. Use it only for an unambiguous URL.
    const devtools = this.inspected
      ? await this.deadline(
          new Promise<chrome.devtools.inspectedWindow.Resource[]>((resolve, reject) =>
            this.inspected!.getResources((resources) => {
              const error = chrome.runtime.lastError;
              if (error)
                reject(
                  new AgentError(
                    'source_unavailable',
                    error.message ?? 'Cannot list DevTools resources.',
                  ),
                );
              else resolve(resources);
            }),
          ),
        )
      : [];
    this.check(epoch);
    const counts = new Map<string, number>();
    for (const item of resources) counts.set(item.url, (counts.get(item.url) ?? 0) + 1);
    const entries = new Map<string, Entry>();
    const resourceScript = new Map<string, Script>();
    const scriptResourceKey = (url: string, frameId: string | undefined, sessionId?: string) =>
      JSON.stringify([sessionId, frameId, url]);
    for (const script of this.scripts.values()) {
      if (!script.hasSourceURL && script.startLine === 0 && script.startColumn === 0)
        resourceScript.set(
          scriptResourceKey(
            script.url,
            this.backend.frame(script.executionContextId, script.sessionId),
            script.sessionId,
          ),
          script,
        );
    }
    const mappedScripts = new Set<Script>();
    const add = (
      identity: string,
      name: string,
      owner: string,
      meta: Omit<SourceFile, 'path' | 'revision' | 'updatedAt' | 'size'>,
      load: Entry['load'],
    ) => {
      let path = this.identities.get(identity);
      if (!path) {
        const id = `${this.mountId}-${epoch}-${++this.serial}`;
        const extension = /\.[a-z0-9]{1,8}$/i.exec(name)?.[0] ?? '';
        const base = extension ? name.slice(0, -extension.length) : name;
        path = `/source/${owner}/${base}~${id}${extension}`;
        this.identities.set(identity, path);
      }
      const cached = this.cache.get(path)?.file;
      entries.set(path, {
        ...meta,
        path,
        revision: cached?.revision ?? `unread:${path.split('~').pop()}`,
        updatedAt: cached?.updatedAt ?? 0,
        size: cached?.content.length ?? -1,
        availability: cached ? 'cached' : 'unread',
        identity,
        load,
      });
    };
    for (const resource of resources) {
      if (!/^(Document|Stylesheet|Script)$/.test(resource.type)) continue;
      const script =
        resource.type === 'Script'
          ? resourceScript.get(
              scriptResourceKey(resource.url, resource.frameId, resource.sessionId),
            )
          : undefined;
      if (script) mappedScripts.add(script);
      const dev =
        counts.get(resource.url) === 1 &&
        devtools.filter((r) => r.url === resource.url).length === 1
          ? devtools.find((r) => r.url === resource.url)
          : undefined;
      add(
        `resource:${resource.sessionId ?? 'main'}:${resource.frameId}:${resource.url}:${script?.scriptId ?? ''}`,
        this.urlName(
          resource.url,
          resource.type === 'Document' ? 'html' : resource.type === 'Stylesheet' ? 'css' : 'js',
        ),
        resource.sessionId
          ? `target-${encodeURIComponent(resource.sessionId)}`
          : resource.frameId === tree.frameTree.frame.id
            ? 'main'
            : `frame-${encodeURIComponent(resource.frameId)}`,
        {
          sourceUrl: resource.url,
          kind: resource.type.toLowerCase(),
          provider: script ? 'debugger' : dev ? 'devtools' : 'page',
          frameId: resource.frameId,
          sessionId: resource.sessionId,
          scriptId: script?.scriptId,
          sourceMapURL: script?.sourceMapURL,
        },
        async () => {
          // Page's generic resource loader may fill missing bodies over the network.
          // Compiled JS has a precise execution source, so use the debugger directly.
          if (script) {
            if (script.scriptLanguage === 'WebAssembly')
              throw new AgentError('binary_source', 'WebAssembly source is binary.');
            const result = (await this.backend.command(
              'Debugger.getScriptSource',
              { scriptId: script.scriptId },
              script.sessionId,
            )) as { scriptSource?: string };
            if (typeof result.scriptSource !== 'string')
              throw new AgentError(
                'resource_not_available',
                'Debugger did not provide script source.',
              );
            return { content: result.scriptSource };
          }
          if (dev)
            return new Promise((resolve, reject) =>
              dev.getContent((content, encoding) => {
                const error = chrome.runtime.lastError;
                if (error || typeof content !== 'string')
                  reject(
                    new AgentError(
                      'resource_not_available',
                      error?.message ?? 'DevTools did not provide source text.',
                    ),
                  );
                else resolve({ content, encoded: !!encoding });
              }),
            );
          const result = (await this.backend.command(
            'Page.getResourceContent',
            { frameId: resource.frameId, url: resource.url },
            resource.sessionId,
          )) as { content: string; base64Encoded: boolean };
          return { content: result.content, encoded: result.base64Encoded };
        },
      );
    }
    for (const script of this.scripts.values()) {
      if (mappedScripts.has(script)) continue;
      const frameId = this.backend.frame(script.executionContextId, script.sessionId);
      const kind =
        script.hasSourceURL || !script.url
          ? 'eval'
          : /\.(?:html?|php)(?:[?#]|$)/i.test(script.url) ||
              script.startLine > 0 ||
              script.startColumn > 0
            ? 'inline'
            : 'script';
      const name =
        kind === 'script' ? `runtime/${this.urlName(script.url, 'js')}` : `${kind}/script.js`;
      add(
        `script:${script.sessionId ?? 'main'}:${script.scriptId}`,
        name,
        script.sessionId
          ? `target-${encodeURIComponent(script.sessionId)}`
          : frameId && frameId !== tree.frameTree.frame.id
            ? `frame-${encodeURIComponent(frameId)}`
            : 'main',
        {
          sourceUrl: script.url || undefined,
          kind,
          provider: 'debugger',
          frameId,
          sessionId: script.sessionId,
          scriptId: script.scriptId,
          sourceMapURL: script.sourceMapURL,
        },
        async () => {
          if (script.scriptLanguage === 'WebAssembly')
            throw new AgentError('binary_source', 'WebAssembly source is binary.');
          const result = (await this.backend.command(
            'Debugger.getScriptSource',
            { scriptId: script.scriptId },
            script.sessionId,
          )) as { scriptSource?: string };
          if (typeof result.scriptSource !== 'string')
            throw new AgentError(
              'resource_not_available',
              'Debugger did not provide script source.',
            );
          return { content: result.scriptSource };
        },
      );
    }
    this.check(epoch);
    this.entries = entries;
    const currentIdentities = new Set([...entries.values()].map((entry) => entry.identity));
    for (const identity of this.identities.keys())
      if (!currentIdentities.has(identity)) this.identities.delete(identity);
    for (const path of this.cache.keys()) if (!entries.has(path)) this.evict(path);
    return [...entries.values()]
      .map(({ identity: _, load: __, ...file }) => file)
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  async read(path: string): Promise<SourceRecord> {
    if (!this.entries.has(path)) await this.list();
    const entry = this.entries.get(path);
    if (!entry)
      throw new AgentError(
        'context_changed',
        'This source path is no longer available. List /source again.',
      );
    const cached = this.cache.get(path);
    if (cached && Date.now() - cached.at < TTL) {
      this.cache.delete(path);
      this.cache.set(path, cached);
      return cached.file;
    }
    this.evict(path);
    const pending = this.pending.get(path);
    if (pending) return pending;
    const epoch = this.epoch;
    const loading = this.load(entry, epoch);
    this.pending.set(path, loading);
    try {
      return await loading;
    } finally {
      if (this.pending.get(path) === loading) this.pending.delete(path);
    }
  }
  private async load(entry: Entry, epoch: number): Promise<SourceRecord> {
    try {
      const result = await this.deadline(entry.load());
      this.check(epoch);
      if (result.encoded)
        throw new AgentError(
          'binary_source',
          'The browser returned base64/binary source; text decoding is unavailable.',
        );
      if (typeof result.content !== 'string')
        throw new AgentError('resource_not_available', 'The browser did not provide source text.');
      const bytes = encoder.encode(result.content);
      if (bytes.length > SOURCE_FILE_BYTES)
        throw new AgentError('resource_too_large', 'Source exceeds the 8 MiB decoded UTF-8 limit.');
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      this.check(epoch);
      const { identity: _, load: __, ...meta } = entry;
      const file = {
        ...meta,
        revision: `sha256:${hash}`,
        updatedAt: Date.now(),
        size: result.content.length,
        content: result.content,
        availability: 'cached' as const,
      };
      // Account for both UTF-8 and the JS string; never keep more than 32 MiB of source text.
      const cost = Math.max(bytes.length, result.content.length * 2);
      for (const [path, cached] of this.cache) if (Date.now() - cached.at >= TTL) this.evict(path);
      while (this.cacheBytes + cost > SOURCE_CACHE_BYTES && this.cache.size)
        this.evict(this.cache.keys().next().value!);
      this.cache.set(entry.path, { file, bytes: cost, at: Date.now() });
      this.cacheBytes += cost;
      return file;
    } catch (error) {
      this.check(epoch);
      throw new AgentError(
        error instanceof AgentError ? error.code : 'resource_not_available',
        `${entry.path}: ${error instanceof Error ? error.message : String(error)}`,
        { sourceUrl: entry.sourceUrl, provider: entry.provider },
      );
    }
  }
  private evict(path: string) {
    const cached = this.cache.get(path);
    if (cached) this.cacheBytes -= cached.bytes;
    this.cache.delete(path);
  }
  private async deadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new AgentError(
                  'source_timeout',
                  'Timed out waiting for browser source (15 seconds).',
                ),
              ),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
  }
  private check(epoch: number) {
    if (this.disposed || epoch !== this.epoch)
      throw new AgentError(
        'context_changed',
        'Page sources changed while reading. List /source again.',
      );
  }
  private urlName(url: string, fallback: string) {
    try {
      const parsed = new URL(url);
      const parts = `${parsed.protocol.slice(0, -1)}/${parsed.host}${parsed.pathname}`
        .split('/')
        .filter(Boolean)
        .slice(-8)
        .map((part) => encodeURIComponent(part).slice(0, 80));
      let name = parts.join('/');
      if (parsed.pathname.endsWith('/')) name += `/index.${fallback}`;
      else if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += `.${fallback}`;
      return name;
    } catch {
      return `anonymous.${fallback}`;
    }
  }
}
