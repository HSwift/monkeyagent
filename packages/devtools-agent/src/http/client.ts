import { z } from 'zod';
import { AgentError } from '../protocol/errors';

export const HTTP_REQUEST_BYTES = 2 * 1024 * 1024;
export const HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
export const HTTP_BRIDGE_BYTES = 3 * 1024 * 1024;
export const HTTP_CONCURRENCY = 4;

export const httpOptionsSchema = z.strictObject({
  method: z.enum(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  credentials: z.enum(['omit', 'include']).optional(),
  redirect: z.enum(['follow', 'error']).optional(),
  timeoutMs: z.number().int().min(1).max(60000).optional(),
});
export const httpRequestSchema = z.tuple([
  z.string().min(1).max(8192),
  httpOptionsSchema.optional(),
]);
export type HttpOptions = z.infer<typeof httpOptionsSchema>;
export interface HttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  redirected: boolean;
  headers: Record<string, string>;
  body: string;
  base64Encoded: boolean;
  bodyBytes: number;
}

const utf8 = new TextEncoder();
const forbiddenHeaders = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'permissions-policy',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
]);

/** Extension-origin HTTP client. No page evaluation, CDP transport or implicit persistence. */
export class HttpClient {
  private active = 0;
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args)) {}

  async request(url: string, options?: HttpOptions, signal?: AbortSignal): Promise<HttpResponse> {
    const parsed = httpRequestSchema.safeParse([url, options]);
    if (!parsed.success)
      throw new AgentError(
        'invalid_input',
        'Use http.request(absoluteHttpUrl, {method?,headers?,body?,credentials?,redirect?,timeoutMs?}). See /docs/http-api.md.',
      );
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new AgentError('invalid_input', 'http.request requires an absolute HTTP(S) URL.');
    }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new AgentError(
        'invalid_input',
        'Use an absolute HTTP(S) URL without embedded credentials.',
      );
    const settings = parsed.data[1] ?? {};
    const method = settings.method ?? 'GET';
    if (settings.body !== undefined && (method === 'GET' || method === 'HEAD'))
      throw new AgentError('invalid_input', 'GET and HEAD requests cannot have a body.');
    if (settings.body !== undefined && utf8.encode(settings.body).length > HTTP_REQUEST_BYTES)
      throw new AgentError('request_too_large', 'Request body exceeds 2 MiB of UTF-8 text.');
    let headers: Headers;
    try {
      for (const name of Object.keys(settings.headers ?? {})) {
        const lower = name.toLowerCase();
        if (forbiddenHeaders.has(lower) || /^(sec-|proxy-)/.test(lower))
          throw new Error(
            `Header ${name} is browser-controlled or unsupported. Use credentials for cookies; do not supply Cookie/Origin/Referer manually.`,
          );
      }
      headers = new Headers(settings.headers);
    } catch (error) {
      throw new AgentError(
        'invalid_input',
        error instanceof Error ? error.message : 'Invalid request headers.',
      );
    }
    signal?.throwIfAborted();
    if (this.active >= HTTP_CONCURRENCY)
      throw new AgentError(
        'http_busy',
        'At most 4 HTTP requests may be in flight. Await them before starting more.',
      );
    this.active++;
    const abort = new AbortController();
    const timeoutMs = settings.timeoutMs ?? 15000;
    const timer = setTimeout(
      () => abort.abort(new AgentError('http_timeout', `HTTP request exceeded ${timeoutMs} ms.`)),
      timeoutMs,
    );
    const combined = AbortSignal.any([abort.signal, ...(signal ? [signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(target.href, {
        method,
        headers,
        body: settings.body,
        credentials: settings.credentials ?? 'omit',
        redirect: settings.redirect ?? 'follow',
        signal: combined,
      });
      combined.throwIfAborted();
      if (
        response.type === 'opaque' ||
        response.type === 'opaqueredirect' ||
        response.type === 'error'
      )
        throw new AgentError(
          'http_network_error',
          'The browser did not expose a readable HTTP response.',
        );
      const chunks: Uint8Array[] = [];
      let length = 0;
      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          combined.throwIfAborted();
          if (done) break;
          length += value.byteLength;
          if (length > HTTP_RESPONSE_BYTES) {
            const error = new AgentError(
              'response_too_large',
              'Response body exceeds 2 MiB of decoded bytes.',
            );
            abort.abort(error);
            throw error;
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const mime = (response.headers.get('content-type') ?? '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
      const text =
        /^text\//.test(mime) ||
        /^application\/(?:json|[^/]+\+json|javascript|ecmascript|xml|[^/]+\+xml|x-www-form-urlencoded)$/.test(
          mime,
        ) ||
        mime === 'image/svg+xml';
      let body: string;
      if (text || !length) body = new TextDecoder().decode(bytes);
      else {
        const parts: string[] = [];
        for (let i = 0; i < bytes.length; i += 8192)
          parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
        body = btoa(parts.join(''));
      }
      const result: HttpResponse = {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        url: response.url || target.href,
        redirected: response.redirected,
        headers: Object.fromEntries(response.headers.entries()),
        body,
        base64Encoded: !!length && !text,
        bodyBytes: length,
      };
      if (utf8.encode(JSON.stringify(result)).length > HTTP_BRIDGE_BYTES)
        throw new AgentError(
          'response_too_large',
          'Serialized HTTP response exceeds the 3 MiB bridge limit.',
        );
      combined.throwIfAborted();
      return result;
    } catch (error) {
      const reason = combined.aborted ? combined.reason : error;
      const code =
        reason instanceof AgentError
          ? reason.code
          : combined.aborted
            ? 'aborted'
            : 'http_network_error';
      throw new AgentError(
        code,
        reason instanceof Error ? reason.message.slice(0, 1000) : 'HTTP request failed.',
        { environment: 'http', url: target.href, method },
      );
    } finally {
      clearTimeout(timer);
      // Also release a stream when a mock/backend does not wire it to the fetch signal.
      if (reader) {
        if (combined.aborted) void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      this.active--;
    }
  }
}
