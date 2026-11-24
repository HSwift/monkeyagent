import { AgentError } from '../protocol/errors';

type Request = chrome.devtools.network.Request;
type Api = Pick<typeof chrome.devtools.network, 'getHAR' | 'onRequestFinished' | 'onNavigated'>;
type Entry = Omit<Request, 'getContent'> & {
  _resourceType?: string;
  response: Request['response'] & { _transferSize?: number; _error?: string };
};
type Log = {
  version: string;
  creator: unknown;
  pages?: unknown[];
  entries: Entry[];
  [key: string]: unknown;
};
interface RecordEntry {
  id: string;
  entry: Entry;
  request: Request;
}
export interface NetworkListOptions {
  urlFilter?: string;
  methods?: string[];
  types?: string[];
  statusCodes?: number[];
  offset?: number;
  limit?: number;
}
export interface NetworkBodyOptions {
  offset?: number;
  limit?: number;
}
const encoder = new TextEncoder();
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 10000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_FULL_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BRIDGE_BYTES = 3 * 1024 * 1024;
const MAX_LIST_BYTES = 16 * 1024;
const BODY_CACHE_BYTES = 32 * 1024 * 1024;
const BODY_TTL = 5 * 60 * 1000;

function nativeNetwork() {
  return typeof chrome === 'undefined' ? undefined : chrome.devtools?.network;
}
function jsonBytes(value: unknown) {
  return encoder.encode(JSON.stringify(value)).length;
}
function boundedResult<T>(value: T): T {
  if (jsonBytes(value) > MAX_BRIDGE_BYTES)
    throw new AgentError(
      'network_result_too_large',
      'Network result exceeds the 3 MiB JSON bridge limit. Use networks.list filters or responseBody character ranges.',
    );
  return value;
}
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && !Array.isArray(item) && typeof item === 'object'
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}
async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** A read-only view of the F12 HAR log. Never attaches CDP or changes DevTools recording/settings. */
export class DevtoolsNetworks {
  private records = new Map<string, RecordEntry>();
  private groups = new Map<string, { count: number; token: number }>();
  private nextIdentity = 0;
  private log?: Log;
  private revision = '';
  private observedAt = 0;
  private refreshing?: Promise<void>;
  private disposed = false;
  private generation = 0;
  private prefix = crypto.randomUUID();
  private eventsObserved = 0;
  private lastFinishedAt?: number;
  private lastNavigationUrl?: string;
  private bodies = new Map<
    string,
    { body: string; base64Encoded: boolean; bytes: number; at: number }
  >();
  private bodyBytes = 0;
  private pendingBodies = new Map<string, Promise<{ body: string; base64Encoded: boolean }>>();
  constructor(private api: Api | undefined = nativeNetwork()) {
    api?.onRequestFinished.addListener(this.finished);
    api?.onNavigated.addListener(this.navigated);
    // HAR snapshots and indexes are created lazily by queries, which also detect native UI clear.
  }
  private finished = () => {
    this.eventsObserved++;
    this.lastFinishedAt = Date.now();
  };
  private navigated = (url: string) => {
    this.generation++;
    this.lastNavigationUrl = url;
    this.bodies.clear();
    this.bodyBytes = 0;
    this.pendingBodies.clear();
    // Preserve-log is owned by F12: never clear or retain HAR records on our own.
  };
  dispose() {
    this.disposed = true;
    this.generation++;
    this.api?.onRequestFinished.removeListener(this.finished);
    this.api?.onNavigated.removeListener(this.navigated);
    this.records.clear();
    this.groups.clear();
    this.log = undefined;
    this.bodies.clear();
    this.bodyBytes = 0;
    this.pendingBodies.clear();
  }
  private check(generation = this.generation) {
    if (this.disposed || generation !== this.generation)
      throw new AgentError(
        'context_changed',
        'DevTools network view changed. Call networks.list again.',
      );
    if (!this.api)
      throw new AgentError(
        'networks_unavailable',
        'networks requires the real inspected tab DevTools. This environment does not expose chrome.devtools.network.',
      );
  }
  private callback<T>(
    register: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new AgentError(
              'network_read_timeout',
              'DevTools network read exceeded 15 seconds. The page request was not cancelled or replayed.',
            ),
          ),
        15000,
      );
      const done = (value: T) => {
        clearTimeout(timer);
        resolve(value);
      };
      const fail = (error: Error) => {
        clearTimeout(timer);
        reject(error);
      };
      try {
        register(done, fail);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  private refresh(): Promise<void> {
    this.check();
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    const task = this.snapshot(generation);
    this.refreshing = task;
    void task
      .finally(() => {
        if (this.refreshing === task) this.refreshing = undefined;
      })
      .catch(() => {});
    return task;
  }
  private async snapshot(generation: number) {
    const raw = await this.callback<Log & { entries: Request[] }>((resolve, reject) =>
      this.api!.getHAR((log) => {
        const error = typeof chrome === 'undefined' ? undefined : chrome.runtime?.lastError;
        error
          ? reject(
              new AgentError('network_read_failed', error.message ?? 'Cannot read DevTools HAR.'),
            )
          : resolve(log as unknown as Log & { entries: Request[] });
      }),
    );
    this.check(generation);
    if (!raw || !Array.isArray(raw.entries))
      throw new AgentError('network_read_failed', 'DevTools did not provide a HAR log.');
    if (raw.entries.length > MAX_ENTRIES || jsonBytes(raw) > MAX_INDEX_BYTES)
      throw new AgentError(
        'network_log_too_large',
        'DevTools HAR exceeds 10000 entries or 32 MiB of metadata. Reduce the retained log in F12 before reading it; UI filters do not reduce this snapshot. No partial index was returned.',
      );
    const log = JSON.parse(JSON.stringify(raw)) as Log;
    const records = new Map<string, RecordEntry>();
    const keys = await Promise.all(log.entries.map((entry) => hash(canonical(entry))));
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
    const groups = new Map<string, { count: number; token: number }>();
    for (const [key, count] of counts) {
      const old = this.groups.get(key);
      // A changed duplicate group cannot be associated reliably by public HAR fields.
      // Invalidate the whole group so an old ID never silently moves to its neighbour.
      groups.set(key, old?.count === count ? old : { count, token: ++this.nextIdentity });
    }
    const duplicates = new Map<string, number>();
    for (let i = 0; i < log.entries.length; i++) {
      const entry = log.entries[i];
      const key = keys[i];
      const occurrence = duplicates.get(key) ?? 0;
      duplicates.set(key, occurrence + 1);
      // HAR has no public CDP request ID. Metadata-version IDs keep same-URL requests separate.
      const id = `${this.prefix}:${groups.get(key)!.token}:${occurrence}`;
      records.set(id, { id, entry, request: raw.entries[i] });
    }
    const revision = await hash([...records.keys()].join('\n'));
    this.check(generation);
    this.records = records;
    this.groups = groups;
    this.log = log;
    this.revision = revision;
    this.observedAt = Date.now();
    for (const id of this.bodies.keys()) if (!records.has(id)) this.evict(id);
  }
  async status(signal?: AbortSignal) {
    if (!this.api)
      return { available: false, provider: 'devtools', reason: 'devtools_network_unavailable' };
    await waitFor(this.refresh(), signal);
    return {
      available: true,
      provider: 'devtools',
      observation: 'automatic',
      recordingState: 'managed-by-devtools',
      requestCount: this.records.size,
      revision: this.revision,
      observedAt: this.observedAt,
      eventsObserved: this.eventsObserved,
      lastFinishedAt: this.lastFinishedAt ?? null,
      lastNavigationUrl: this.lastNavigationUrl ?? null,
    };
  }
  async list(options: NetworkListOptions = {}, signal?: AbortSignal) {
    await waitFor(this.refresh(), signal);
    const methods = options.methods?.map((m) => m.toUpperCase());
    const types = options.types?.map((t) => t.toLowerCase());
    const matches = [...this.records.values()].filter(
      ({ entry }) =>
        (!options.urlFilter || entry.request.url.includes(options.urlFilter)) &&
        (!methods || methods.includes(entry.request.method.toUpperCase())) &&
        (!types || types.includes(String(entry._resourceType ?? '').toLowerCase())) &&
        (!options.statusCodes || options.statusCodes.includes(entry.response.status)),
    );
    const offset = options.offset ?? 0,
      limit = options.limit ?? 50;
    const requests = [];
    for (const record of matches.slice(offset, offset + limit)) {
      const e = record.entry;
      const row = {
        id: record.id,
        url: e.request.url.slice(0, 2000),
        urlTruncated: e.request.url.length > 2000,
        method: e.request.method,
        type: e._resourceType ?? null,
        status: e.response.status,
        mimeType: e.response.content.mimeType,
        startedAt: e.startedDateTime,
        durationMs: e.time,
        transferBytes: e.response._transferSize ?? null,
        error: e.response._error ?? null,
      };
      if (jsonBytes(requests.concat(row)) > MAX_LIST_BYTES - 1024) {
        if (!requests.length)
          throw new AgentError(
            'network_result_too_large',
            'A network summary exceeds the 16 KiB page budget. Narrow the filter or read the native HAR with networks.getHAR.',
          );
        break;
      }
      requests.push(row);
    }
    const next = offset + requests.length;
    return {
      requests,
      total: matches.length,
      offset,
      nextOffset: next < matches.length ? next : null,
      hasMore: next < matches.length,
      revision: this.revision,
      observedAt: this.observedAt,
      provider: 'devtools',
    };
  }
  private async record(id: string, signal?: AbortSignal) {
    const generation = this.generation;
    await waitFor(this.refresh(), signal);
    this.check(generation);
    const record = this.records.get(id);
    if (!record)
      throw new AgentError(
        'context_changed',
        'This network record was removed or its HAR metadata changed. Call networks.list again; IDs are not CDP request IDs.',
      );
    return record;
  }
  async get(id: string, signal?: AbortSignal) {
    const record = await this.record(id, signal);
    return boundedResult({ id, entry: record.entry });
  }
  async requestBody(id: string, signal?: AbortSignal) {
    const record = await this.record(id, signal);
    return boundedResult({ postData: record.entry.request.postData ?? null });
  }
  async getHAR(signal?: AbortSignal) {
    await waitFor(this.refresh(), signal);
    return boundedResult(this.log!);
  }
  async responseBody(id: string, options: NetworkBodyOptions = {}, signal?: AbortSignal) {
    const generation = this.generation;
    const record = await this.record(id, signal);
    this.check(generation);
    const cached = this.bodies.get(id);
    let result: { body: string; base64Encoded: boolean };
    if (cached && Date.now() - cached.at < BODY_TTL) {
      this.bodies.delete(id);
      this.bodies.set(id, cached);
      result = cached;
    } else {
      this.evict(id);
      let pending = this.pendingBodies.get(id);
      if (!pending) {
        pending = this.readBody(record);
        this.pendingBodies.set(id, pending);
        void pending
          .finally(() => {
            if (this.pendingBodies.get(id) === pending) this.pendingBodies.delete(id);
          })
          .catch(() => {});
      }
      result = await waitFor(pending, signal);
    }
    signal?.throwIfAborted();
    this.check(generation);
    const ranged = options.offset !== undefined || options.limit !== undefined;
    if (!ranged && encoder.encode(result.body).length > MAX_FULL_BODY_BYTES)
      throw new AgentError(
        'network_body_too_large',
        'Complete encoded body exceeds 2 MiB. Read explicit responseBody(id,{offset,limit}) ranges.',
      );
    const offset = options.offset ?? 0;
    const body = ranged
      ? result.body.slice(offset, offset + (options.limit ?? 32000))
      : result.body;
    return boundedResult({
      body,
      base64Encoded: result.base64Encoded,
      offset,
      totalLength: result.body.length,
      truncated: offset > 0 || body.length < result.body.length,
    });
  }
  private async readBody(record: RecordEntry) {
    const generation = this.generation;
    if (typeof record.request.getContent !== 'function')
      throw new AgentError(
        'network_body_unavailable',
        'DevTools did not expose getContent for this record. No new request was sent.',
      );
    const result = await this.callback<{ body: string; base64Encoded: boolean }>(
      (resolve, reject) =>
        record.request.getContent((content, encoding) => {
          const error = typeof chrome === 'undefined' ? undefined : chrome.runtime?.lastError;
          if (error || typeof content !== 'string')
            reject(
              new AgentError(
                'network_body_unavailable',
                error?.message ??
                  'DevTools did not provide the response body. No new request was sent.',
              ),
            );
          else if (encoding && encoding !== 'base64')
            reject(
              new AgentError(
                'network_body_unavailable',
                `Unsupported DevTools body encoding: ${encoding}`,
              ),
            );
          else resolve({ body: content, base64Encoded: encoding === 'base64' });
        }),
    );
    this.check(generation);
    if (result.body.length > MAX_BODY_BYTES || encoder.encode(result.body).length > MAX_BODY_BYTES)
      throw new AgentError(
        'network_body_too_large',
        'DevTools body exceeds the 8 MiB host snapshot limit. No partial body was cached.',
      );
    await this.record(record.id);
    this.check(generation);
    const bytes = Math.max(result.body.length * 2, encoder.encode(result.body).length);
    for (const [id, cached] of this.bodies) if (Date.now() - cached.at >= BODY_TTL) this.evict(id);
    while (this.bodyBytes + bytes > BODY_CACHE_BYTES && this.bodies.size)
      this.evict(this.bodies.keys().next().value!);
    this.bodies.set(record.id, { ...result, bytes, at: Date.now() });
    this.bodyBytes += bytes;
    return result;
  }
  private evict(id: string) {
    const old = this.bodies.get(id);
    if (old) this.bodyBytes -= old.bytes;
    this.bodies.delete(id);
  }
}
