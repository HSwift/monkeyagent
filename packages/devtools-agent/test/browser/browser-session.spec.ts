import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { instrumentPanel, rpc } from './helpers';

test('browser contexts, navigation invalidation, screenshots and explicit reconnection work through the real REPL', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/worker.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end('self.answer = 42; setInterval(()=>{},1000);');
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        request.url?.startsWith('/frame')
          ? '<title>Child frame</title>'
          : '<title>Browser test</title><iframe src="/frame"></iframe><script>new Worker("/worker.js")</script>',
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await instrumentPanel(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const target = context.pages()[0];
    await target.goto(`http://127.0.0.1:${port}/`);
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === `http://127.0.0.1:${port}/`,
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    const frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const run = (code: string) => rpc(frame, 'repl.run', code);
    expect((await run('return await browser.evaluate("document.title");')).value).toBe(
      'Browser test',
    );
    const native = await worker.evaluate(
      async (tabId) =>
        chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: '({title:document.title, count:2})',
          returnByValue: true,
          awaitPromise: true,
        }),
      tabId,
    );
    const bridged = await run(
      'return await browser.send("Runtime.evaluate", {expression:"({title:document.title, count:2})",returnByValue:true,awaitPromise:true});',
    );
    expect(bridged.success).toBe(true);
    expect(bridged.value).toEqual(native);
    expect(bridged.value.result).toMatchObject({
      type: 'object',
      value: { title: 'Browser test', count: 2 },
    });
    const nativeException = await run(
      `return await browser.send("Runtime.evaluate", {expression:${JSON.stringify('throw new Error("native-probe")')},returnByValue:true});`,
    );
    expect(nativeException.success).toBe(true);
    expect(nativeException.value.exceptionDetails.exception.description).toContain('native-probe');
    const helperException = await run(
      `return await browser.evaluate(${JSON.stringify('throw new Error("helper-probe")')});`,
    );
    expect(helperException.success).toBe(false);
    expect(helperException.error.message).toContain('helper-probe');
    const invalidOption = await run('return await browser.reload({timeout:1});');
    expect(invalidOption.success).toBe(false);
    expect(invalidOption.error.code).toBe('invalid_input');
    expect(invalidOption.error.message).toContain('timeout');
    const missingField = await run(
      'const value = await browser.evaluate("({title:document.title})"); return {title:value.title, missing:value.verified};',
    );
    expect(missingField.success).toBe(true);
    expect(missingField.value).toEqual({ title: 'Browser test' });
    expect(missingField.warnings).toEqual([
      expect.objectContaining({ code: 'undefined_field', path: '$["missing"]' }),
    ]);
    await run('state.logStart = (await browser.events({tail:true,limit:1})).at(-1)?.seq ?? 0;');
    await target.evaluate(() => {
      console.log('harness-earlier-log');
      console.error('harness-current-log');
    });
    await expect
      .poll(
        async () =>
          (
            await run(
              'return await browser.events({tail:true,limit:1,methods:["Runtime.consoleAPICalled"]});',
            )
          ).value[0]?.params.args[0]?.value,
      )
      .toBe('harness-current-log');
    await expect
      .poll(async () =>
        (
          await run(
            'return await browser.events({after:state.logStart,methods:["Runtime.consoleAPICalled"]});',
          )
        ).value.some((event: any) =>
          event.params.args.some((arg: any) => arg.value === 'harness-current-log'),
        ),
      )
      .toBe(true);
    let contexts: any[] = [];
    await expect
      .poll(async () => {
        contexts = (await run('return await browser.contexts();')).value;
        return contexts.filter((value) => value.sessionId).length;
      })
      .toBeGreaterThan(0);
    const mainFrameId = (await run('return await browser.send("Page.getFrameTree");')).value
      .frameTree.frame.id;
    const child = contexts.find(
      (value) =>
        value.auxData?.isDefault &&
        value.auxData.frameId &&
        value.auxData.frameId !== mainFrameId &&
        !value.sessionId,
    );
    expect(child).toBeTruthy();
    expect(
      (await run(`return await browser.evaluate('document.title', {contextId:${child.id}});`))
        .value,
    ).toBe('Child frame');
    const workerContext = contexts.find((value) => value.sessionId);
    expect(
      (
        await run(
          `return await browser.evaluate('self.answer', {contextId:${workerContext.id},sessionId:${JSON.stringify(workerContext.sessionId)}});`,
        )
      ).value,
    ).toBe(42);
    await target.locator('iframe').evaluate((iframe) => {
      (iframe as HTMLIFrameElement).src = '/frame?next';
    });
    await expect
      .poll(() => target.frames().some((frame) => frame.url().endsWith('/frame?next')))
      .toBe(true);
    await expect
      .poll(async () =>
        (await run('return await browser.contexts();')).value.some(
          (context: any) => context.auxData?.frameId === mainFrameId && context.auxData?.isDefault,
        ),
      )
      .toBe(true);
    await run(
      'state.handle = (await browser.send("Runtime.evaluate", {expression:"document.body"})).result.objectId;',
    );
    expect(
      (await run('await browser.reload(); return await browser.evaluate("document.title");')).value,
    ).toBe('Browser test');
    const stale = await run(
      'return await browser.send("Runtime.getProperties", {objectId:state.handle});',
    );
    expect(stale.success).toBe(false);
    expect(stale.error.message).toContain('Navigation invalidated');
    const screenshot = await run('return await browser.screenshot();');
    expect(screenshot.artifacts[0]).toMatchObject({ mimeType: 'image/png' });
    expect(
      (await rpc(frame, 'artifact.get', screenshot.artifacts[0].id)).blob.size,
    ).toBeGreaterThan(100);
    const large = await run('return "x".repeat(140000);');
    expect(large.truncated).toBe(true);
    const range = await run(
      `return await fs.read(${JSON.stringify(large.value.artifact.path)}, {offset:64000,limit:20});`,
    );
    expect(range.value.content).toBe('x'.repeat(20));
    expect(range.value.totalLength).toBe(140002);
    const scope = await run(
      'return await browser.send("Target.createTarget", {url:"https://example.com"});',
    );
    expect(scope.success).toBe(false);
    expect(scope.error.message).toContain('inspected tab');
    await worker.evaluate(async (tabId) => chrome.debugger.detach({ tabId }), tabId);
    await run('return await browser.evaluate("document.title");');
    const disconnected = await run('return await browser.evaluate("document.title");');
    expect(disconnected.success).toBe(false);
    expect(disconnected.error.message).toContain('Reconnect explicitly');
    await rpc(frame, 'browser.connect');
    expect((await run('return await browser.evaluate("document.title");')).value).toBe(
      'Browser test',
    );
    await run(
      `return await browser.send('Page.navigate', {url:${JSON.stringify(`http://127.0.0.1:${port}/navigated`)}});`,
    );
    await expect
      .poll(async () => (await rpc(frame, 'snapshot')).session.targetUrl)
      .toBe(`http://127.0.0.1:${port}/navigated`);
    const sameDocument = await run(
      `return await browser.navigate(${JSON.stringify(`http://127.0.0.1:${port}/navigated#fragment`)});`,
    );
    expect(sameDocument.success).toBe(true);
    expect(sameDocument.value.method).toBe('Page.navigatedWithinDocument');
    await expect
      .poll(async () => (await rpc(frame, 'snapshot')).session.targetUrl)
      .toBe(`http://127.0.0.1:${port}/navigated#fragment`);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
