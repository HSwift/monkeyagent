// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { DevtoolsNetworks } from '../src/networks/service';
import { validateHostCall } from '../src/repl/contracts';
import { ReplRuntime, newQuickJSWASMModuleFromVariant } from '../src/repl/runtime';

const views: DevtoolsNetworks[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function event<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  return {
    addListener: vi.fn((listener: T) => listeners.add(listener)),
    removeListener: vi.fn((listener: T) => listeners.delete(listener)),
    emit: (...args: Parameters<T>) => {
      for (const listener of listeners) listener(...args);
    },
  };
}
function request(body = 'body', url = 'https://example.com/api', encoding = '') {
  return {
    startedDateTime: '2026-11-23T00:00:00.000Z',
    time: 12,
    request: {
      method: 'POST',
      url,
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Cookie', value: 'a=b' }],
      queryString: [{ name: 'q', value: '1' }],
      cookies: [],
      headersSize: -1,
      bodySize: 7,
      postData: { mimeType: 'application/json', text: '{"x":1}' },
    },
    response: {
      status: 200,
      statusText: 'OK',
      httpVersion: 'HTTP/1.1',
      headers: [{ name: 'Set-Cookie', value: 'c=d' }],
      cookies: [],
      content: { mimeType: 'text/plain', size: body.length },
      redirectURL: '',
      headersSize: -1,
      bodySize: body.length,
      _transferSize: 42,
    },
    cache: {},
    timings: { send: 1, wait: 10, receive: 1 },
    _resourceType: 'fetch',
    _initiator: { type: 'script' },
    getContent: vi.fn((callback: (body: string, encoding: string) => void) =>
      callback(body, encoding),
    ),
  };
}
function fixture(entries = [request()]) {
  const log = { version: '1.2', creator: { name: 'Chrome', version: '136' }, pages: [], entries };
  const api = {
    getHAR: vi.fn((callback: (log: unknown) => void) => callback(log)),
    onRequestFinished: event<(request: unknown) => void>(),
    onNavigated: event<(url: string) => void>(),
  };
  const view = new DevtoolsNetworks(
    api as unknown as ConstructorParameters<typeof DevtoolsNetworks>[0],
  );
  views.push(view);
  return { log, api, view };
}
it('subscribes immediately and follows UI clear without accumulating events', async () => {
  const { view, api, log } = fixture();
  expect(api.onRequestFinished.addListener).toHaveBeenCalledOnce();
  expect(api.getHAR).not.toHaveBeenCalled();
  const first = await view.list();
  expect(first.requests).toHaveLength(1);
  api.onRequestFinished.emit(request('unrelated'));
  expect(await view.status()).toMatchObject({
    available: true,
    requestCount: 1,
    eventsObserved: 1,
    recordingState: 'managed-by-devtools',
  });
  log.entries = [];
  expect(await view.list()).toMatchObject({
    requests: [],
    total: 0,
    hasMore: false,
    nextOffset: null,
  });
  await expect(view.get(first.requests[0].id)).rejects.toMatchObject({ code: 'context_changed' });
  view.dispose();
  expect(api.onRequestFinished.removeListener).toHaveBeenCalledOnce();
  await expect(view.list()).rejects.toMatchObject({ code: 'context_changed' });
});
it('defers snapshots until the first query and shares concurrent initial reads of the current native log', async () => {
  const { view, api, log } = fixture();
  api.onRequestFinished.emit(log.entries[0]);
  api.onNavigated.emit('https://example.com/next');
  // Native Preserve log can retain existing requests and add records before our first read.
  log.entries.push(request('later', 'https://example.com/later'));
  await Promise.resolve();
  expect(api.getHAR).not.toHaveBeenCalled();
  const [status, page, har] = await Promise.all([view.status(), view.list(), view.getHAR()]);
  expect(api.getHAR).toHaveBeenCalledOnce();
  expect(status).toMatchObject({
    available: true,
    requestCount: 2,
    eventsObserved: 1,
    lastNavigationUrl: 'https://example.com/next',
  });
  expect(page.requests.map((row) => row.url)).toEqual(
    log.entries.map((entry) => entry.request.url),
  );
  expect(har.entries).toHaveLength(2);
  expect(log.entries.every((entry) => entry.getContent.mock.calls.length === 0)).toBe(true);
});
it('keeps same-URL and identical-metadata requests distinct and binds each native body separately', async () => {
  const entries = [request('one'), request('two'), request('alt')];
  entries[2].time = 20;
  const { view, log } = fixture(entries);
  const first = await view.list();
  expect(new Set(first.requests.map((r) => r.id)).size).toBe(3);
  expect((await view.list()).requests.map((r) => r.id)).toEqual(first.requests.map((r) => r.id));
  expect(await Promise.all(first.requests.map((r) => view.responseBody(r.id)))).toMatchObject([
    { body: 'one' },
    { body: 'two' },
    { body: 'alt' },
  ]);
  expect(entries.every((entry) => entry.getContent.mock.calls.length === 1)).toBe(true);
  log.entries[0].response.status = 201;
  await expect(view.get(first.requests[0].id)).rejects.toMatchObject({ code: 'context_changed' });
});
it('preserves native HAR metadata and request postData without reading response bodies', async () => {
  const { view, log } = fixture();
  const { id } = (await view.list()).requests[0];
  const detail = await view.get(id);
  expect(detail.entry).toMatchObject({
    _initiator: { type: 'script' },
    request: {
      headers: log.entries[0].request.headers,
      queryString: log.entries[0].request.queryString,
    },
    response: { headers: log.entries[0].response.headers },
    timings: { send: 1 },
  });
  expect(await view.requestBody(id)).toEqual({ postData: log.entries[0].request.postData });
  expect(await view.getHAR()).toEqual(JSON.parse(JSON.stringify(log)));
  expect(log.entries[0].getContent).not.toHaveBeenCalled();
  delete (log.entries[0].request as { postData?: unknown }).postData;
  const updated = (await view.list()).requests[0];
  expect(await view.requestBody(updated.id)).toEqual({ postData: null });
});
it('paginates bounded summaries with forward progress and literal/case-aware filters', async () => {
  const { view } = fixture(
    Array.from({ length: 30 }, (_, i) =>
      request(String(i), 'https://example.com/api?q=' + i + 'x'.repeat(2000)),
    ),
  );
  let offset = 0;
  const ids = new Set<string>();
  do {
    const page = await view.list({
      urlFilter: '/api?',
      methods: ['post'],
      types: ['Fetch'],
      statusCodes: [200],
      offset,
      limit: 200,
    });
    expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(16 * 1024);
    expect(page.requests.length).toBeGreaterThan(0);
    expect(page.requests.every((r) => r.urlTruncated)).toBe(true);
    page.requests.forEach((r) => ids.add(r.id));
    if (!page.hasMore) break;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset!;
  } while (true);
  expect(ids.size).toBe(30);
  expect(await view.list({ urlFilter: '.*' })).toMatchObject({ total: 0 });
  expect(await view.list({ methods: [] })).toMatchObject({ total: 0 });
});
it('rejects an oversized summary instead of returning an unadvanceable page', async () => {
  const entry = request();
  entry.response.statusText = 'OK';
  entry.response.content.mimeType = 'x'.repeat(20000);
  const { view } = fixture([entry]);
  await expect(view.list()).rejects.toMatchObject({ code: 'network_result_too_large' });
});
it('returns text/base64 bodies with explicit UTF-16 ranges, stable caching and no HTTP replay', async () => {
  const entries = [
    request('界🙂'.repeat(20000)),
    request('AP+AAQ==', 'https://example.com/binary', 'base64'),
  ];
  const { view, log, api } = fixture(entries);
  const page = await view.list();
  expect(await view.responseBody(page.requests[0].id, { offset: 32000, limit: 17 })).toEqual({
    body: '界🙂'.repeat(20000).slice(32000, 32017),
    base64Encoded: false,
    offset: 32000,
    totalLength: 60000,
    truncated: true,
  });
  expect(await view.responseBody(page.requests[0].id)).toMatchObject({
    totalLength: 60000,
    truncated: false,
  });
  expect(entries[0].getContent).toHaveBeenCalledOnce();
  expect(await view.responseBody(page.requests[1].id, { offset: 4, limit: 4 })).toEqual({
    body: 'AQ==',
    base64Encoded: true,
    offset: 4,
    totalLength: 8,
    truncated: true,
  });
  api.onNavigated.emit('https://example.com/next');
  // Preserve log follows the native log, but our body snapshots are released on navigation.
  expect((await view.list()).total).toBe(2);
  await view.responseBody(page.requests[0].id);
  expect(entries[0].getContent).toHaveBeenCalledTimes(2);
  log.entries = [];
  await expect(view.responseBody(page.requests[0].id)).rejects.toMatchObject({
    code: 'context_changed',
  });
});
it('requires explicit ranges for large bodies and rejects host/JSON limits without truncation', async () => {
  const { view } = fixture([
    request('x'.repeat(2 * 1024 * 1024 + 1)),
    request('x'.repeat(8 * 1024 * 1024 + 1), 'https://example.com/huge'),
    request('\0'.repeat(600000), 'https://example.com/escaped'),
  ]);
  const page = await view.list();
  await expect(view.responseBody(page.requests[0].id)).rejects.toMatchObject({
    code: 'network_body_too_large',
  });
  expect(await view.responseBody(page.requests[0].id, { offset: 2100000, limit: 5 })).toMatchObject(
    { body: '', totalLength: 2097153, truncated: true },
  );
  await expect(view.responseBody(page.requests[1].id, { limit: 5 })).rejects.toMatchObject({
    code: 'network_body_too_large',
  });
  await expect(view.responseBody(page.requests[2].id)).rejects.toMatchObject({
    code: 'network_result_too_large',
  });
  expect(await view.responseBody(page.requests[2].id, { limit: 10 })).toMatchObject({
    body: '\0'.repeat(10),
    truncated: true,
  });
});
it('rejects missing native body support and native callback errors without a fallback', async () => {
  const entry = request();
  const { view } = fixture([entry]);
  const id = (await view.list()).requests[0].id;
  entry.getContent.mockImplementation((callback) => callback(undefined as unknown as string, ''));
  await expect(view.responseBody(id)).rejects.toMatchObject({ code: 'network_body_unavailable' });
  entry.getContent.mockImplementation((callback) => callback('body', 'gzip'));
  await expect(view.responseBody(id)).rejects.toMatchObject({ code: 'network_body_unavailable' });
  vi.stubGlobal('chrome', { runtime: { lastError: { message: 'Response evicted' } } });
  await expect(view.responseBody(id)).rejects.toMatchObject({
    code: 'network_read_failed',
    message: 'Response evicted',
  });
});
it('cancels a reader promptly and rejects a late body after native clear/navigation', async () => {
  const entry = request();
  const { view, log, api } = fixture([entry]);
  const id = (await view.list()).requests[0].id;
  let complete!: (body: string, encoding: string) => void;
  entry.getContent.mockImplementation((callback) => {
    complete = callback;
  });
  const abort = new AbortController();
  const pending = view.responseBody(id, {}, abort.signal);
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  abort.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  log.entries = [];
  complete('stale', '');
  await expect(view.responseBody(id)).rejects.toMatchObject({ code: 'context_changed' });
  log.entries = [entry];
  const nextId = (await view.list()).requests[0].id;
  expect(nextId).not.toBe(id);
  const next = expect(view.responseBody(nextId)).rejects.toMatchObject({ code: 'context_changed' });
  await vi.waitFor(() => expect(entry.getContent).toHaveBeenCalledTimes(2));
  api.onNavigated.emit('https://example.com/next');
  complete('stale too', '');
  await next;
});
it('expires body snapshots and bounds native reads to 15 seconds without cancelling the page request', async () => {
  const entry = request();
  const { view } = fixture([entry]);
  const id = (await view.list()).requests[0].id;
  await view.responseBody(id);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
  await view.responseBody(id);
  expect(entry.getContent).toHaveBeenCalledTimes(2);
  vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
  entry.getContent.mockImplementation(() => {});
  const pending = expect(view.responseBody(id)).rejects.toMatchObject({
    code: 'network_read_timeout',
  });
  await vi.waitFor(() => expect(entry.getContent).toHaveBeenCalledTimes(3));
  await vi.advanceTimersByTimeAsync(15001);
  await pending;
});
it('reports native capability absence honestly', async () => {
  vi.stubGlobal('chrome', {});
  const view = new DevtoolsNetworks();
  views.push(view);
  expect(await view.status()).toMatchObject({ available: false, provider: 'devtools' });
  await expect(view.list()).rejects.toMatchObject({ code: 'networks_unavailable' });
});
it('validates the public interface and exposes ordinary frozen async functions to QuickJS', async () => {
  for (const [method, args] of [
    ['networks.start', []],
    ['networks.status', [{}]],
    ['networks.getHAR', [{}]],
    ['networks.list', [{ url: 'typo' }]],
    ['networks.list', [{ limit: 201 }]],
    ['networks.list', [{ statusCodes: [-1] }]],
    ['networks.get', []],
    ['networks.requestBody', ['id', {}]],
    ['networks.responseBody', ['id', { saveTo: '/workspace/a' }]],
    ['networks.responseBody', ['id', { limit: 64001 }]],
  ] as [string, unknown[]][])
    expect(() => validateHostCall(method, args)).toThrow();
  const { view } = fixture();
  const vm = new ReplRuntime(
    await newQuickJSWASMModuleFromVariant(variant),
    async (method, args) => {
      validateHostCall(method, args);
      if (method === 'networks.list') return view.list();
      if (method === 'networks.responseBody') return view.responseBody(args[0] as string);
      throw new Error(method);
    },
  );
  try {
    expect(
      await vm.run(
        'state.rows = await networks.list(); const r=await networks.responseBody(state.rows.requests[0].id); return {body:r.body, frozen:Object.isFrozen(networks), start:typeof networks.start};',
        1000,
      ),
    ).toEqual({ body: 'body', frozen: true, start: 'undefined' });
    expect(await vm.run('return state.rows.total;', 1000)).toBe(1);
  } finally {
    vm.dispose();
  }
});
