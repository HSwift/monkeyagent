// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import {
  HttpClient,
  HTTP_REQUEST_BYTES,
  HTTP_RESPONSE_BYTES,
  HTTP_BRIDGE_BYTES,
  type HttpOptions,
} from '../src/http/client';
import { validateHostCall } from '../src/repl/contracts';
import { AgentError, errorData } from '../src/protocol/errors';
import { ReplRuntime, newQuickJSWASMModuleFromVariant } from '../src/repl/runtime';
import variant from '@jitl/quickjs-wasmfile-release-sync';

const runtimes: ReplRuntime[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
const textResponse = (text: string, init?: ResponseInit) =>
  new Response(text, { headers: { 'content-type': 'application/json' }, ...init });
async function runtime(client: HttpClient) {
  const runtime = new ReplRuntime(
    await newQuickJSWASMModuleFromVariant(variant),
    async (method, args) => {
      validateHostCall(method, args);
      expect(method).toBe('http.request');
      return client.request(args[0] as string, args[1] as HttpOptions);
    },
  );
  runtimes.push(runtime);
  return runtime;
}

it('returns fixed response data for success and HTTP errors with explicit extension defaults', async () => {
  const fetcher = vi.fn(async () =>
    textResponse('{"items":[1,2]}', {
      status: 422,
      statusText: 'Unprocessable Content',
      headers: { 'content-type': 'application/problem+json', 'x-test': 'yes' },
    }),
  );
  const client = new HttpClient(fetcher);
  expect(await client.request('https://api.example/data')).toEqual({
    status: 422,
    statusText: 'Unprocessable Content',
    ok: false,
    url: 'https://api.example/data',
    redirected: false,
    headers: { 'content-type': 'application/problem+json', 'x-test': 'yes' },
    body: '{"items":[1,2]}',
    base64Encoded: false,
    bodyBytes: 15,
  });
  expect(fetcher).toHaveBeenCalledWith(
    'https://api.example/data',
    expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'follow' }),
  );
  await client.request('https://api.example/data', {
    method: 'POST',
    body: '{"x":1}',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    redirect: 'error',
  });
  expect(fetcher.mock.calls[1]).toEqual([
    'https://api.example/data',
    expect.objectContaining({
      method: 'POST',
      body: '{"x":1}',
      credentials: 'include',
      redirect: 'error',
    }),
  ]);
});

it.each([
  ['/relative', undefined],
  ['file:///etc/passwd', undefined],
  ['https://user:password@api.example/', undefined],
  ['https://api.example/', { method: 'GET', body: '' }],
  ['https://api.example/', { method: 'HEAD', body: 'x' }],
  ['https://api.example/', { method: 'TRACE' }],
  ['https://api.example/', { timeout: 10 }],
  ['https://api.example/', { timeoutMs: 0 }],
  ['https://api.example/', { credentials: 'same-origin' }],
  ['https://api.example/', { headers: { Cookie: 'secret' } }],
  ['https://api.example/', { headers: { 'sEc-Fetch-Site': 'none' } }],
  ['https://api.example/', { headers: { 'Content-Length': '1' } }],
  ['https://api.example/', { headers: { 'User-Agent': 'fake' } }],
  ['https://api.example/', { headers: { 'bad header': 'x' } }],
  ['https://api.example/', { headers: { Accept: 'x\r\ny' } }],
  ['https://api.example/', { body: { x: 1 } }],
  ['https://api.example/', { redirect: 'manual' }],
])('rejects invalid requests before network dispatch: %s %j', async (url, options) => {
  const fetcher = vi.fn();
  await expect(
    new HttpClient(fetcher).request(url as string, options as HttpOptions),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('validates the public host call strictly, including arity, and limits UTF-8 request bytes', async () => {
  expect(() => validateHostCall('http.request', ['https://api.example/', {}, true])).toThrow();
  expect(() =>
    validateHostCall('http.request', ['https://api.example/', { saveTo: '/workspace/a' }]),
  ).toThrow();
  expect(() =>
    validateHostCall('http.request', ['https://api.example/', { headers: { Accept: 1 } }]),
  ).toThrow();
  const fetcher = vi.fn();
  await expect(
    new HttpClient(fetcher).request('https://api.example/', {
      method: 'POST',
      body: '界'.repeat(Math.ceil(HTTP_REQUEST_BYTES / 3)),
    }),
  ).rejects.toMatchObject({ code: 'request_too_large' });
  expect(fetcher).not.toHaveBeenCalled();
});

it('encodes binary or untyped content as base64 and decodes text as UTF-8 across stream chunks', async () => {
  const bytes = new TextEncoder().encode('你好🙂');
  const client = new HttpClient(
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.subarray(0, 2));
              controller.enqueue(bytes.subarray(2));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/plain;charset=gbk' } },
        ),
    ),
  );
  expect(await client.request('https://api.example/')).toMatchObject({
    body: '你好🙂',
    bodyBytes: bytes.length,
    base64Encoded: false,
  });
  const binary = new HttpClient(
    vi.fn(
      async () =>
        new Response(new Uint8Array([0, 255, 128, 1]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    ),
  );
  expect(await binary.request('https://api.example/')).toMatchObject({
    body: 'AP+AAQ==',
    base64Encoded: true,
    bodyBytes: 4,
  });
  const empty = new HttpClient(vi.fn(async () => new Response(null, { status: 204 })));
  expect(await empty.request('https://api.example/', { method: 'HEAD' })).toMatchObject({
    body: '',
    base64Encoded: false,
    bodyBytes: 0,
  });
});

it('cancels oversized streams and rejects escape-heavy bridge payloads without returning a prefix', async () => {
  const cancel = vi.fn();
  const fetcher = vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(HTTP_RESPONSE_BYTES));
            controller.enqueue(new Uint8Array(1));
          },
          cancel,
        }),
        { headers: { 'content-type': 'application/octet-stream' } },
      ),
  );
  await expect(new HttpClient(fetcher).request('https://api.example/')).rejects.toMatchObject({
    code: 'response_too_large',
    details: { environment: 'http' },
  });
  expect(cancel).toHaveBeenCalled();
  const escaped = new HttpClient(vi.fn(async () => textResponse('\0'.repeat(HTTP_RESPONSE_BYTES))));
  await expect(escaped.request('https://api.example/')).rejects.toMatchObject({
    code: 'response_too_large',
    message: expect.stringContaining('bridge'),
  });
});

it('aborts a timeout or user cancellation without retrying and releases its in-flight slot', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(
    (_url: RequestInfo | URL, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason), {
          once: true,
        });
      }),
  );
  const client = new HttpClient(fetcher);
  const pending = expect(
    client.request('https://api.example/', { timeoutMs: 10 }),
  ).rejects.toMatchObject({ code: 'http_timeout' });
  await vi.advanceTimersByTimeAsync(10);
  await pending;
  const abort = new AbortController();
  const cancelled = expect(
    client.request('https://api.example/', {}, abort.signal),
  ).rejects.toMatchObject({ code: 'aborted' });
  abort.abort();
  await cancelled;
  expect(fetcher).toHaveBeenCalledTimes(2);
  const preflight = new AbortController();
  preflight.abort();
  await expect(client.request('https://api.example/', {}, preflight.signal)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it('bounds concurrent requests and never queues an extra request implicitly', async () => {
  const fetcher = vi.fn(
    (_url: RequestInfo | URL, options?: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason)),
      ),
  );
  const client = new HttpClient(fetcher);
  const abort = new AbortController();
  const pending = Array.from({ length: 4 }, () =>
    client.request('https://api.example/', {}, abort.signal),
  );
  const settled = Promise.allSettled(pending);
  await expect(client.request('https://api.example/')).rejects.toMatchObject({ code: 'http_busy' });
  expect(fetcher).toHaveBeenCalledTimes(4);
  abort.abort();
  expect((await settled).every((result) => result.status === 'rejected')).toBe(true);
});

it('keeps large complete responses usable inside QuickJS and state without changing the return shape', async () => {
  const body = JSON.stringify({
    items: Array.from({ length: 80000 }, (_, id) => ({ id })),
    tail: 'END',
  });
  const fetcher = vi.fn(async () => textResponse(body));
  const vm = await runtime(new HttpClient(fetcher));
  expect(
    await vm.run(
      'state.response = await http.request("https://api.example/"); state.parsed=JSON.parse(state.response.body); return {count:state.parsed.items.length,tail:state.parsed.tail,bodyChars:state.response.body.length};',
      5000,
    ),
  ).toEqual({ count: 80000, tail: 'END', bodyChars: body.length });
  expect(
    await vm.run(
      'return {last:state.parsed.items.at(-1).id,kind:typeof state.response.body,http:typeof http.request,fetch:typeof fetch,require:typeof require};',
      1000,
    ),
  ).toEqual({
    last: 79999,
    kind: 'string',
    http: 'function',
    fetch: 'undefined',
    require: 'undefined',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('preserves host error code and details through QuickJS catch and uncaught errors', async () => {
  const vm = await runtime(
    new HttpClient(
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    ),
  );
  const code = 'return await http.request("https://api.example/");';
  expect(
    await vm.run(
      `try {${code}} catch(e) {return {code:e.code,name:e.name,details:e.details};}`,
      1000,
    ),
  ).toMatchObject({
    code: 'http_network_error',
    name: 'http_network_error',
    details: { environment: 'http', method: 'GET' },
  });
  try {
    await vm.run(code, 1000);
    throw new Error('expected failure');
  } catch (error) {
    expect(errorData(error)).toMatchObject({
      code: 'http_network_error',
      details: { environment: 'http', url: 'https://api.example/' },
    });
  }
});

it.each(['text', 'escaped', 'binary'])(
  'keeps a near-limit %s response usable in QuickJS',
  async (kind) => {
    const length =
      kind === 'escaped' ? Math.floor((HTTP_BRIDGE_BYTES - 2048) / 6) : HTTP_RESPONSE_BYTES;
    const fetcher = vi.fn(async () =>
      kind === 'binary'
        ? new Response(new Uint8Array(length), {
            headers: { 'content-type': 'application/octet-stream' },
          })
        : new Response((kind === 'escaped' ? '\0' : 'x').repeat(length), {
            headers: { 'content-type': 'text/plain' },
          }),
    );
    const vm = await runtime(new HttpClient(fetcher));
    expect(
      await vm.run(
        'state.response=await http.request("https://api.example/");return {bytes:state.response.bodyBytes,kind:typeof state.response.body,base64:state.response.base64Encoded};',
        10000,
      ),
    ).toEqual({ bytes: length, kind: 'string', base64: kind === 'binary' });
    expect(await vm.run('return state.response.body.length;', 1000)).toBe(
      kind === 'binary' ? Math.ceil(length / 3) * 4 : length,
    );
  },
);
