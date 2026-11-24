import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { instrumentPanel, rpc } from './helpers';

test('CDP sources read loaded text without network replay and invalidate on reload', async () => {
  const requests = new Map<string, number>();
  const bundle = '/*' + 'x'.repeat(500000) + '*/window.sourceNeedle=42;';
  const server = createServer((request, response) => {
    const url = request.url!;
    requests.set(url, (requests.get(url) ?? 0) + 1);
    if (url.includes('.js')) {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(
        url.startsWith('/bundle')
          ? bundle
          : url.startsWith('/worker')
            ? 'self.workerNeedle=43;setInterval(()=>{},1000);'
            : 'window.lazyNeedle=44;',
      );
    } else if (url === '/style.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end('body { --source-color: blue; }');
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        url === '/frame'
          ? '<title>Child source</title><script src="/frame.js"></script><link rel="stylesheet" href="/style.css">'
          : `<title>Source fixture</title><link rel="stylesheet" href="/style.css"><script src="/bundle.js?v=1"></script><script src="/bundle.js?v=2"></script><iframe src="http://localhost:${(server.address() as { port: number }).port}/frame"></iframe><script src="http://localhost:${(server.address() as { port: number }).port}/cdn.js"></script>\n<script>window.inlineNeedle=41;new Worker("/worker.js");</script>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const targetUrl = `http://127.0.0.1:${port}/`;
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
    const target = context.pages()[0];
    await target.goto(targetUrl);
    await target.evaluate(() => {
      (0, eval)('window.evalNeedle=45;\n//# sourceURL=virtual-eval.js');
    });
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === targetUrl,
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    await page
      .frameLocator('iframe')
      .getByRole('button', { name: 'Model settings', exact: true })
      .waitFor();
    const frame = page.frames().find((f) => f.url().endsWith('/agent/panel.html'))!;
    const run = async (code: string) => {
      const result = await rpc(frame, 'repl.run', code, 30000);
      expect(result.success, JSON.stringify(result.error)).toBe(true);
      return result.value;
    };
    const before = new Map(requests);
    const list = await run('return await fs.list("/source");');
    expect(list.some((f: any) => f.provider === 'page')).toBe(true);
    const variants = list.filter(
      (f: any) => f.kind === 'script' && f.sourceUrl.includes('/bundle'),
    );
    expect(variants).toHaveLength(2);
    expect(list.some((f: any) => f.kind === 'inline')).toBe(true);
    expect(
      list.some((f: any) => f.sessionId && f.kind === 'document' && f.sourceUrl.endsWith('/frame')),
    ).toBe(true);
    const cdn = list.find((f: any) => f.sourceUrl?.endsWith('/cdn.js'));
    expect(cdn).toBeTruthy();
    expect((await run(`return await fs.read(${JSON.stringify(cdn.path)});`)).content).toContain(
      'lazyNeedle',
    );
    expect(list.some((f: any) => f.kind === 'eval' && f.sourceUrl === 'virtual-eval.js')).toBe(
      true,
    );
    const path = variants[0].path;
    const range = await run(
      `return await fs.read(${JSON.stringify(path)},{offset:500002,limit:30});`,
    );
    expect(range.content).toContain('window.sourceNeedle=42');
    expect(range.totalLength).toBe(bundle.length);
    expect(range.revision).toMatch(/^sha256:/);
    const workerSource = list.find((f: any) => f.sessionId && f.sourceUrl?.endsWith('/worker.js'));
    expect(workerSource).toBeTruthy();
    expect(
      (await run(`return await fs.read(${JSON.stringify(workerSource.path)});`)).content,
    ).toContain('workerNeedle');
    expect(
      (await run('return await fs.list();')).some((f: any) => f.path.startsWith('/source')),
    ).toBe(false);
    expect(
      await run(`try {await fs.write(${JSON.stringify(path)},'x');} catch(e) {return e.name;}`),
    ).toBe('read_only');
    for (const url of ['/bundle.js?v=1', '/bundle.js?v=2', '/style.css', '/'])
      expect(requests.get(url), url).toBe(before.get(url));
    await target.evaluate(async () => {
      const script = document.createElement('script');
      script.src = '/lazy.js';
      document.head.append(script);
      await new Promise((resolve) => (script.onload = resolve));
    });
    const lazy = await run(
      'return (await fs.list("/source")).filter(f=>f.sourceUrl?.includes("lazy.js"));',
    );
    expect(lazy.length).toBeGreaterThan(0);
    expect((await run(`return await fs.read(${JSON.stringify(lazy[0].path)});`)).content).toContain(
      'lazyNeedle',
    );
    await run('await browser.reload();return true;');
    expect(
      await run(`try {await fs.read(${JSON.stringify(path)});} catch(e) {return e.name;}`),
    ).toBe('context_changed');
    expect((await run('return await fs.list("/source");')).some((f: any) => f.path === path)).toBe(
      false,
    );
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
