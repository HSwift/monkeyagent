import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { instrumentPanel, rpc } from './helpers';

test('evaluate fills missing syntax/value messages once and preserves native Error stacks without duplicate details', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/loaded.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(
        'function loadedInner(){\nthrow new TypeError("external-probe");\n}\nwindow.loadedOuter=()=>loadedInner();',
      );
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Evaluate errors</title><script src="/loaded.js"></script>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
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
    await target.goto(url);
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === url,
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    await page
      .frameLocator('iframe')
      .getByRole('button', { name: 'Model settings', exact: true })
      .waitFor();
    const frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    // Capture the response to the actual helper call, without running the submitted code twice.
    await page.evaluate(() => {
      const original = chrome.debugger.sendCommand.bind(chrome.debugger);
      (window as any).__evaluateResponses = [];
      chrome.debugger.sendCommand = ((debuggee: any, method: string, params: any, callback: any) =>
        original(debuggee, method, params, (result) => {
          if (method === 'Runtime.evaluate')
            (window as any).__evaluateResponses.push(structuredClone(result));
          callback(result);
        })) as typeof chrome.debugger.sendCommand;
    });
    const run = async (expression: string) => {
      const result = await rpc(
        frame,
        'repl.run',
        `return await browser.evaluate(${JSON.stringify(expression)});`,
      );
      const captures = await page.evaluate(() => (window as any).__evaluateResponses.splice(0));
      expect(captures).toHaveLength(1);
      expect(result).toMatchObject({ success: false, error: { code: 'page_exception' } });
      expect(Object.keys(result.error).sort()).toEqual(['code', 'message']);
      return { error: result.error, raw: captures[0] };
    };
    for (const expression of [
      'function outer(){function inner(){throw new Error("ordinary-probe");}inner();}outer();\n//# sourceURL=ordinary-probe.js',
      'missingProbe.member;\n//# sourceURL=reference-probe.js',
      '(async function asyncProbe(){await Promise.resolve();throw new Error("async-probe");})()\n//# sourceURL=async-probe.js',
      'window.loadedOuter();\n//# sourceURL=external-caller.js',
      'JSON.parse("{");\n//# sourceURL=runtime-syntax.js',
      'const e=new Error("no-stack-probe");e.stack="";throw e;',
    ]) {
      const { error, raw } = await run(expression);
      expect(error.message).toBe(raw.exceptionDetails.exception.description);
    }
    const syntax = await run('const a=1;\nconst x = ;\n//# sourceURL=syntax-probe.js');
    const details = syntax.raw.exceptionDetails;
    expect(syntax.error.message).toBe(
      `${details.exception.description} (line ${details.lineNumber + 1}, column ${details.columnNumber + 1})`,
    );
    expect(syntax.error.message.match(/\(line \d+, column \d+\)/g)).toHaveLength(1);
    for (const [expression, message] of [
      ['throw "string-probe";', 'Thrown value: "string-probe"'],
      ['throw "";', 'Thrown value: ""'],
      ['throw null;', 'Thrown value: null'],
      ['throw undefined;', 'Thrown value: undefined'],
      ['throw false;', 'Thrown value: false'],
      ['throw 0;', 'Thrown value: 0'],
      ['throw NaN;', 'Thrown value: NaN'],
      ['throw -0;', 'Thrown value: -0'],
      ['throw 42n;', 'Thrown value: 42n'],
    ])
      expect((await run(expression)).error.message).toBe(message);
    const object = await run('throw {reason:"object-probe",code:42};');
    expect(object.error.message).toBe(
      'Thrown value (Object preview): {"reason": "object-probe", "code": 42}',
    );
    const accessor = await run(
      'globalThis.getterCalls=0;throw Object.defineProperty({reason:"accessor-probe"},"unsafe",{enumerable:true,get(){globalThis.getterCalls++;throw new Error("do not invoke");}});',
    );
    expect(accessor.error.message).toContain('accessor-probe');
    expect(await target.evaluate(() => (window as any).getterCalls)).toBe(0);
    const once = await run(
      'globalThis.evaluateCalls=(globalThis.evaluateCalls||0)+1;throw new Error("once-probe");',
    );
    expect(once.error.message).toBe(once.raw.exceptionDetails.exception.description);
    expect(await target.evaluate(() => (window as any).evaluateCalls)).toBe(1);
    const caught = await rpc(
      frame,
      'repl.run',
      'try {await browser.evaluate("throw \\\"caught-probe\\\"");}catch(e){return {code:e.code,message:e.message,details:e.details??null};}',
    );
    expect(caught).toMatchObject({
      success: true,
      value: { code: 'page_exception', message: 'Thrown value: "caught-probe"', details: null },
    });
    expect(await page.evaluate(() => (window as any).__evaluateResponses.splice(0))).toHaveLength(
      1,
    );
    // The packaged QuickJS Worker and V8 share position formatting and UTF-16 coordinates.
    for (const code of [
      'const text = "🙂"; const x = ;',
      'const a=1;\r\nconst x = ;',
      'const a=1;\rconst x = ;',
      'const a=1;\u2028const x = ;',
    ]) {
      const repl = await rpc(frame, 'repl.run', code);
      const lines = code.split(/\r\n|[\r\n\u2028\u2029]/);
      const suffix = `(line ${lines.length}, column ${lines.at(-1)!.lastIndexOf(';') + 1})`;
      expect(repl).toMatchObject({ success: false, error: { code: 'error' } });
      expect(repl.error.message.endsWith(suffix)).toBe(true);
      expect(repl.error.message.match(/\(line \d+, column \d+\)/g)).toHaveLength(1);
      expect(Object.keys(repl.error).sort()).toEqual(['code', 'message']);
      expect(await page.evaluate(() => (window as any).__evaluateResponses.splice(0))).toEqual([]);
      const { error } = await run(code);
      expect(error.message.endsWith(suffix)).toBe(true);
    }
    const parsed = await rpc(
      frame,
      'repl.run',
      'state.parseRuns=(state.parseRuns||0)+1; return JSON.parse("{");',
    );
    expect(parsed).toMatchObject({
      success: false,
      error: { code: 'error', message: 'expecting property name' },
    });
    expect(await rpc(frame, 'repl.run', 'return state.parseRuns;')).toMatchObject({
      success: true,
      value: 1,
    });
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
