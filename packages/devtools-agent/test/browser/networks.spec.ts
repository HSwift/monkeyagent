import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { targetSession } from './helpers';

test('REPL networks reuses real F12 records and bodies, follows native clear, and never attaches debugging', async () => {
  let apiRequests = 0;
  const large = '0123456789'.repeat(10000);
  const server = createServer(async (request, response) => {
    if (request.url === '/api') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      apiRequests++;
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('X-Native-Network', 'yes');
      response.end(
        JSON.stringify({ sequence: apiRequests, posted: Buffer.concat(chunks).toString() }),
      );
    } else if (request.url === '/large') {
      response.setHeader('Content-Type', 'text/plain');
      response.end(large);
    } else if (request.url === '/binary') {
      response.setHeader('Content-Type', 'application/octet-stream');
      response.end(Buffer.from([0, 255, 128, 1]));
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Native F12 network test</title>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    executablePath: process.env.AGENT_TEST_CHROMIUM,
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--auto-open-devtools-for-tabs',
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = context.pages()[0];
    await page.goto(origin);
    const root = await context.browser()!.newBrowserCDPSession();
    let devtoolsTarget: string | undefined;
    await expect
      .poll(async () => {
        devtoolsTarget = (await root.send('Target.getTargets')).targetInfos.find(
          (t) => t.url === worker.url().replace('fixture.js', 'devtools.html'),
        )?.targetId;
        return !!devtoolsTarget;
      })
      .toBe(true);
    const devtools = await targetSession(root, devtoolsTarget!);
    const evalOn = async (session: typeof devtools, expression: string) =>
      (
        await session.send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        })
      ).result.value;
    const inspector = (await root.send('Target.getTargets')).targetInfos.find((t) =>
      t.url.startsWith('devtools://'),
    )!;
    const frontend = await targetSession(root, inspector.targetId);
    const show = async (name: string) =>
      evalOn(
        frontend,
        `(async()=>{const UI=await import('./ui/legacy/legacy.js');const view=UI.InspectorView.InspectorView.instance();const id=${name === 'Agent' ? "view.tabbedPane.tabIds().find(id=>id.endsWith('Agent'))" : JSON.stringify(name)};if(!id)return false;await view.showPanel(id);return true;})()`,
      );
    // Produce records while Agent has never been shown and its debugger has never connected.
    await page.evaluate(async () => {
      await Promise.all(
        ['first', 'second'].map((body) =>
          fetch('/api', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'X-From-Page': 'yes' },
            body,
          }).then((r) => r.text()),
        ),
      );
      await fetch('/large').then((r) => r.text());
      await fetch('/binary').then((r) => r.arrayBuffer());
    });
    await expect
      .poll(async () =>
        evalOn(
          devtools,
          `new Promise(resolve=>chrome.devtools.network.getHAR(log=>resolve(log.entries.filter(e=>e.request.url===${JSON.stringify(origin + '/api')}).length)))`,
        ),
      )
      .toBe(2);
    await expect.poll(() => show('Agent')).toBe(true);
    let panelTarget: string | undefined;
    await expect
      .poll(async () => {
        panelTarget = (await root.send('Target.getTargets')).targetInfos.find(
          (t) => t.url === worker.url().replace('fixture.js', 'panel.html'),
        )?.targetId;
        return !!panelTarget;
      })
      .toBe(true);
    const panel = await targetSession(root, panelTarget!);
    await expect
      .poll(() =>
        evalOn(
          panel,
          `[...document.querySelectorAll('header button')].some(el=>el.textContent==='Debug')`,
        ),
      )
      .toBe(true);
    await evalOn(
      panel,
      `[...document.querySelectorAll('header button')].find(el=>el.textContent==='Debug').click()`,
    );
    await expect.poll(() => evalOn(panel, `!!document.querySelector('.cm-content')`)).toBe(true);
    const run = async (code: string) => {
      const nonce = crypto.randomUUID();
      await evalOn(panel, `document.querySelector('.cm-content').focus()`);
      await panel.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        commands: ['selectAll'],
        modifiers: process.platform === 'darwin' ? 4 : 2,
      });
      await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' });
      await panel.send('Input.insertText', {
        text: `return {nonce:${JSON.stringify(nonce)},value:await(async()=>{${code}})()};`,
      });
      await evalOn(
        panel,
        `[...document.querySelectorAll('button')].find(el=>el.textContent==='Run').click()`,
      );
      let output: any;
      await expect
        .poll(async () => {
          output = await evalOn(
            panel,
            `(()=>{try{return JSON.parse(document.querySelector('.repl-output pre')?.textContent)}catch{return null}})()`,
          );
          return output?.nonce === nonce ? 'done' : (output?.code ?? 'waiting');
        })
        .toBe('done');
      return output.value;
    };
    const result = await run(`
      const status=await networks.status();
      const rows=await networks.list({urlFilter:${JSON.stringify(origin + '/api')},methods:['post'],types:['fetch']});
      state.nativeIds=rows.requests.map(r=>r.id);
      const log=await networks.getHAR();
      return {status,rows,details:await networks.get(rows.requests[0].id),posted:await networks.requestBody(rows.requests[0].id),bodies:await Promise.all(rows.requests.map(r=>networks.responseBody(r.id))),har:{version:log.version,apiCount:log.entries.filter(e=>e.request.url===${JSON.stringify(origin + '/api')}).length,hasWrapper:Object.hasOwn(log,'log')}};
    `);
    expect(result.status).toMatchObject({
      available: true,
      provider: 'devtools',
      observation: 'automatic',
      recordingState: 'managed-by-devtools',
    });
    expect(result.rows.total).toBe(2);
    expect(new Set(result.rows.requests.map((r: any) => r.id)).size).toBe(2);
    expect(result.details.entry.request.headers).toContainEqual({
      name: 'X-From-Page',
      value: 'yes',
    });
    expect(result.details.entry.response.headers).toContainEqual({
      name: 'X-Native-Network',
      value: 'yes',
    });
    expect(result.posted.postData.text).toMatch(/first|second/);
    expect(new Set(result.bodies.map((r: any) => JSON.parse(r.body).posted))).toEqual(
      new Set(['first', 'second']),
    );
    expect(result.har).toMatchObject({ version: '1.2', apiCount: 2, hasWrapper: false });
    expect(apiRequests).toBe(2);
    expect(
      await evalOn(
        devtools,
        `chrome.debugger.sendCommand({tabId:chrome.devtools.inspectedWindow.tabId},'Runtime.evaluate',{expression:'0'}).then(()=>true,()=>false)`,
      ),
    ).toBe(false);
    const bodies = await run(`
      const big=(await networks.list({urlFilter:'/large'})).requests[0];
      const binary=(await networks.list({urlFilter:'/binary'})).requests[0];
      return {range:await networks.responseBody(big.id,{offset:70001,limit:17}),binary:await networks.responseBody(binary.id)};
    `);
    expect(bodies.range).toEqual({
      body: large.slice(70001, 70018),
      base64Encoded: false,
      offset: 70001,
      totalLength: large.length,
      truncated: true,
    });
    expect(bodies.binary).toMatchObject({ body: 'AP+AAQ==', base64Encoded: true });
    await show('network');
    // Operate the actual F12 Clear button, including shadow-root toolbar elements.
    const clear = await evalOn(
      frontend,
      `(()=>{const all=root=>[...root.querySelectorAll('*')].flatMap(el=>[el,...(el.shadowRoot?all(el.shadowRoot):[])]);const button=all(document).find(el=>el.getAttribute('title')==='Clear network log'||el.getAttribute('aria-label')==='Clear network log');if(!button)return false;button.click();return true;})()`,
    );
    expect(clear).toBe(true);
    await show('Agent');
    const cleared = await run(
      `let error;try{await networks.responseBody(state.nativeIds[0]);}catch(e){error=e.code}return {rows:await networks.list({urlFilter:${JSON.stringify(origin + '/api')}}),error};`,
    );
    expect(cleared).toMatchObject({ rows: { total: 0, requests: [] }, error: 'context_changed' });
    expect(apiRequests).toBe(2);
    // Fresh events continue after reads and native clear; the native log owns capture.
    await page.evaluate(() =>
      fetch('/api', { method: 'POST', body: 'after-clear' }).then((r) => r.text()),
    );
    await expect
      .poll(async () =>
        evalOn(
          devtools,
          `new Promise(resolve=>chrome.devtools.network.getHAR(log=>resolve(log.entries.filter(e=>e.request.url===${JSON.stringify(origin + '/api')}).length)))`,
        ),
      )
      .toBe(1);
    expect(
      await run(
        `const rows=await networks.list({urlFilter:${JSON.stringify(origin + '/api')}});return {count:rows.total,body:await networks.responseBody(rows.requests[0].id)};`,
      ),
    ).toMatchObject({
      count: 1,
      body: { body: JSON.stringify({ sequence: 3, posted: 'after-clear' }) },
    });
    expect(apiRequests).toBe(3);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
