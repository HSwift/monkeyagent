import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { targetSession } from './helpers';

test('real F12 Agent writes, installs, interacts, verifies a failure and repairs a Monkey userscript', async () => {
  let calls = 0;
  const verificationResults: boolean[] = [];
  const path = '/workspace/main.user.js';
  const userscript = `// ==UserScript==
// @name Full Agent Loop
// @namespace monkeyagent-tests
// @match *://*/*
// @grant GM_getValue
// @grant GM_setValue
// @run-at document-start
// ==/UserScript==
GM_setValue('agent-value', 42);
function mount() {
 const button = document.createElement('button'); button.id = 'agent-e2e';
 button.textContent = String(GM_getValue('agent-value'));
 button.addEventListener('click', () => { button.textContent = 'Wrong'; });
 document.body.append(button);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true}); else mount();`;
  const verifyCode = `await scripts.apply(${JSON.stringify(path)});
await browser.reload({waitUntil:'domcontentloaded'});
const point = await browser.evaluate("(()=>{const r=document.querySelector('#agent-e2e').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
await browser.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,x:point.x,y:point.y});
await browser.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,x:point.x,y:point.y});
return await browser.verify(${JSON.stringify(path)}, "document.querySelector('#agent-e2e').textContent === 'Clicked'");`;
  const server = createServer(async (request, response) => {
    if (request.url === '/slow.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      setTimeout(() => response.end('// parser pause'), 400);
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        '<!doctype html><head><title>Complete Agent Loop</title><script src="/slow.js"></script></head><body><h1>Target page</h1></body>',
      );
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    calls++;
    for (const message of payload.messages)
      if (
        message.role === 'tool' &&
        ['verify-first', 'verify-fixed'].includes(message.tool_call_id)
      ) {
        const result = JSON.parse(message.content);
        if (
          result.success &&
          typeof result.value.passed === 'boolean' &&
          verificationResults.at(-1) !== result.value.passed
        )
          verificationResults.push(result.value.passed);
      }
    const tool = (id: string, name: string, args: object) => ({
      role: 'assistant',
      tool_calls: [
        { index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
      ],
    });
    let delta: object;
    if (calls === 1) delta = tool('write-first', 'Write', { file_path: path, content: userscript });
    else if (calls === 2) delta = tool('verify-first', 'repl', { code: verifyCode });
    else if (calls === 3) {
      delta = tool('repair-file', 'Edit', {
        file_path: path,
        old_string: "button.textContent = 'Wrong';",
        new_string: "button.textContent = 'Clicked';",
      });
    } else if (calls === 4) delta = tool('verify-fixed', 'repl', { code: verifyCode });
    else delta = { role: 'assistant', content: '已安装并验证按钮，修复首轮点击错误。' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null) => ({
      id: 'call-' + calls,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, calls < 5 ? 'tool_calls' : 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const extension = new URL('../../../../dist-mv3/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--auto-open-devtools-for-tabs',
    ],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    const settings = await context.newPage();
    await settings.goto('chrome://extensions/?id=' + id);
    await settings.evaluate(
      async (extensionId) =>
        (chrome as any).developerPrivate.updateExtensionConfiguration({
          extensionId,
          userScriptsAccess: true,
        }),
      id,
    );
    await worker.evaluate(
      async (baseURL) =>
        chrome.storage.local.set({
          'monkeyagent:model:v1': {
            provider: 'openai-compatible',
            baseURL,
            model: 'test-model',
            apiKey: '',
            supportsImages: false,
            theme: 'light',
          },
        }),
      `http://127.0.0.1:${port}/v1`,
    );
    const target = context.pages()[0];
    await target.goto(`http://127.0.0.1:${port}/`);
    const root = await context.browser()!.newBrowserCDPSession();
    let inspectorId: string | undefined;
    await expect
      .poll(async () => {
        inspectorId = (await root.send('Target.getTargets')).targetInfos.find(
          (info) => info.title.includes('127.0.0.1:' + port) && info.url.startsWith('devtools://'),
        )?.targetId;
        return !!inspectorId;
      })
      .toBe(true);
    const inspector = await targetSession(root, inspectorId!);
    await expect
      .poll(
        async () =>
          (
            await inspector.send('Runtime.evaluate', {
              expression: `(async()=>{const UI=await import('./ui/legacy/legacy.js');const view=UI.InspectorView.InspectorView.instance();const id=view.tabbedPane.tabIds().find(id=>id.endsWith('Agent'));if(!id)return false;await view.showPanel(id);return true;})()`,
              awaitPromise: true,
              returnByValue: true,
            })
          ).result.value,
      )
      .toBe(true);
    let panelId: string | undefined;
    await expect
      .poll(async () => {
        panelId = (await root.send('Target.getTargets')).targetInfos.find(
          (info) => info.url === `chrome-extension://${id}/agent/panel.html`,
        )?.targetId;
        return !!panelId;
      })
      .toBe(true);
    const panel = await targetSession(root, panelId!);
    await expect
      .poll(
        async () =>
          (
            await panel.send('Runtime.evaluate', {
              expression: 'document.body.textContent',
              returnByValue: true,
            })
          ).result.value,
      )
      .toContain('How can I help');
    await panel.send('Runtime.evaluate', {
      expression: `(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'创建按钮并验证点击效果，发现问题后修复。');input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    });
    await panel.send('Runtime.evaluate', {
      expression: `document.querySelector('button[aria-label="Send message"]').click()`,
    });
    await expect
      .poll(
        async () =>
          (
            await panel.send('Runtime.evaluate', {
              expression: 'document.body.textContent',
              returnByValue: true,
            })
          ).result.value,
        { timeout: 15000 },
      )
      .toContain('Completed');
    expect(calls).toBe(5);
    expect(verificationResults).toEqual([false, true]);
    await expect(target.locator('#agent-e2e')).toHaveText('Clicked');
    await expect
      .poll(
        async () =>
          (
            await panel.send('Runtime.evaluate', {
              expression: 'document.body.textContent',
              returnByValue: true,
            })
          ).result.value,
      )
      .toContain('Verification passed');
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
