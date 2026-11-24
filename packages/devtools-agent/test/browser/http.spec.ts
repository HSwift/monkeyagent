import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { instrumentPanel, rpc } from './helpers';

test('extension HTTP bypasses page CORS, preserves response data and cancels host requests on stop or REPL deadline', async () => {
  const counts = new Map<string, number>();
  const closed = new Set<string>();
  const large = JSON.stringify({
    items: Array.from({ length: 40000 }, (_, id) => ({ id })),
    tail: 'COMPLETE',
  });
  const api = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const label = url.searchParams.get('label') ?? url.pathname;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (url.pathname === '/slow') {
      response.on('close', () => closed.add(label));
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
      return;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { Location: '/json' });
      response.end();
      return;
    }
    if (url.pathname === '/binary') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.end(Buffer.from([0, 255, 128, 1]));
      return;
    }
    if (url.pathname === '/too-large') {
      response.setHeader('Content-Type', 'text/plain');
      response.end('x'.repeat(2 * 1024 * 1024 + 1));
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/large') {
      response.end(large);
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    if (url.pathname === '/error') response.statusCode = 422;
    response.end(
      JSON.stringify({
        answer: 42,
        method: request.method,
        body,
        cookie: request.headers.cookie ?? null,
        header: request.headers['x-test'] ?? null,
      }),
    );
  });
  const site = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>HTTP target</title>');
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const siteUrl = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    executablePath: process.env.AGENT_TEST_CHROMIUM,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await instrumentPanel(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await expect.poll(() => worker.evaluate(() => !!chrome.tabs?.query)).toBe(true);
    const target = context.pages()[0];
    await target.goto(siteUrl);
    expect(
      await target.evaluate(async (url) => {
        try {
          await fetch(url);
          return 'readable';
        } catch {
          return 'cors-blocked';
        }
      }, apiUrl + '/json'),
    ).toBe('cors-blocked');
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === siteUrl,
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    await page
      .frameLocator('iframe')
      .getByRole('button', { name: 'Model settings', exact: true })
      .waitFor();
    const frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const call = (code: string, timeout?: number) => rpc(frame, 'repl.run', code, timeout);
    const run = async (code: string) => {
      const result = await call(code);
      expect(result.success, JSON.stringify(result.error)).toBe(true);
      return result.value;
    };
    const request = (path: string, options?: object) =>
      `http.request(${JSON.stringify(apiUrl + path)}${options ? ',' + JSON.stringify(options) : ''})`;
    expect(
      await run(
        `const res=await ${request('/json')};return {status:res.status,ok:res.ok,data:JSON.parse(res.body)};`,
      ),
    ).toMatchObject({ status: 200, ok: true, data: { answer: 42, method: 'GET', cookie: null } });
    expect((await rpc(frame, 'snapshot')).connected).toBe(false);
    expect(
      await run(
        `const res=await ${request('/json', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test': 'explicit' }, body: '{"sent":true}' })};return JSON.parse(res.body);`,
      ),
    ).toMatchObject({ method: 'POST', body: '{"sent":true}', header: 'explicit' });
    expect(await run(`return await ${request('/error')};`)).toMatchObject({
      status: 422,
      ok: false,
    });
    expect(await run(`return await ${request('/binary')};`)).toMatchObject({
      body: 'AP+AAQ==',
      base64Encoded: true,
      bodyBytes: 4,
    });
    expect(await run(`return await ${request('/redirect')};`)).toMatchObject({
      url: apiUrl + '/json',
      redirected: true,
      status: 200,
    });
    await context.addCookies([
      { name: 'http_test', value: 'cookie-value', domain: '127.0.0.1', path: '/', sameSite: 'Lax' },
    ]);
    expect(await run(`return JSON.parse((await ${request('/json')}).body).cookie;`)).toBeNull();
    expect(
      await run(
        `return JSON.parse((await ${request('/json', { credentials: 'include' })}).body).cookie;`,
      ),
    ).toContain('http_test=cookie-value');
    expect(
      await run(
        `state.response=await ${request('/large')}; state.data=JSON.parse(state.response.body); return {count:state.data.items.length,tail:state.data.tail,chars:state.response.body.length};`,
      ),
    ).toEqual({ count: 40000, tail: 'COMPLETE', chars: large.length });
    expect(
      await run('return {last:state.data.items.at(-1).id,body:typeof state.response.body};'),
    ).toEqual({ last: 39999, body: 'string' });
    expect((await rpc(frame, 'snapshot')).files).toEqual([]);
    expect(
      await run(
        `try {await ${request('/too-large')};} catch(e) {return {code:e.code,environment:e.details.environment};}`,
      ),
    ).toEqual({ code: 'response_too_large', environment: 'http' });
    const invalid = await call(
      `return await ${request('/invalid', { headers: { Cookie: 'manual' } })};`,
    );
    expect(invalid).toMatchObject({ success: false, error: { code: 'invalid_input' } });
    expect(counts.has('/invalid')).toBe(false);
    const timeout = await call(
      `return await ${request('/slow?label=http-timeout', { timeoutMs: 100 })};`,
    );
    expect(timeout).toMatchObject({
      success: false,
      error: { code: 'http_timeout', details: { environment: 'http' } },
    });
    await expect.poll(() => closed.has('http-timeout')).toBe(true);
    const deadline = await call(
      `return await ${request('/slow?label=repl-timeout', { timeoutMs: 10000 })};`,
      250,
    );
    expect(deadline).toMatchObject({ success: false, error: { code: 'timeout' } });
    await expect.poll(() => closed.has('repl-timeout')).toBe(true);
    const stopping = call(`return await ${request('/slow?label=stop')};`);
    await expect.poll(() => counts.get('stop')).toBe(1);
    await rpc(frame, 'stop');
    expect(await stopping).toMatchObject({ success: false, error: { code: 'aborted' } });
    await expect.poll(() => closed.has('stop')).toBe(true);
    const early = await call(
      `state.saved=41; ${request('/slow?label=early')}; throw new Error('early failure');`,
    );
    expect(early).toMatchObject({
      success: false,
      error: { message: expect.stringContaining('early failure') },
    });
    expect(await run('return state.saved+1;')).toBe(42);
    await expect.poll(() => !counts.has('early') || closed.has('early')).toBe(true);
    expect(counts.get('http-timeout')).toBe(1);
    expect(counts.get('repl-timeout')).toBe(1);
    expect(counts.get('stop')).toBe(1);
  } finally {
    await context.close();
    api.closeAllConnections();
    site.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => api.close(() => resolve())),
      new Promise<void>((resolve) => site.close(() => resolve())),
    ]);
  }
});
