import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { targetSession } from './helpers';

test('actual Monkey adapter installs, toggles and injects document-start/GM userscripts on the bound tab', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/slow.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      setTimeout(
        () => response.end('// Keep the parser loading while the extension obtains script data.'),
        400,
      );
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<!doctype html><head><title>Agent injection test</title><script src="/slow.js"></script></head><body><h1>Local test page</h1></body>',
    );
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
    // This is the normal Chrome extension setting, enabled only in the isolated test profile.
    await settings.evaluate(
      async (extensionId) =>
        (chrome as any).developerPrivate.updateExtensionConfiguration({
          extensionId,
          userScriptsAccess: true,
        }),
      id,
    );
    const target = context.pages()[0];
    await target.goto(`http://127.0.0.1:${port}/`);
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === `http://127.0.0.1:${port}/`,
    )!.id;
    const root = await context.browser()!.newBrowserCDPSession();
    let agent: Awaited<ReturnType<typeof targetSession>> | undefined;
    await expect
      .poll(async () => {
        for (const info of (await root.send('Target.getTargets')).targetInfos.filter(
          (info) => info.url === `chrome-extension://${id}/agent/devtools.html`,
        )) {
          const session = await targetSession(root, info.targetId);
          const value = await session.send('Runtime.evaluate', {
            expression: 'chrome.devtools.inspectedWindow.tabId',
            returnByValue: true,
          });
          if (value.result.value === tabId) {
            agent = session;
            return true;
          }
        }
        return false;
      })
      .toBe(true);
    const evaluate = async (expression: string) => {
      const response = await agent!.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const api = async (op: string, args = {}) =>
      evaluate(
        `chrome.runtime.sendMessage(${JSON.stringify({ cmd: 'monkeyagent:scripts:v1', data: { op, args } })})`,
      );
    const injector = await evaluate('chrome.runtime.sendMessage({cmd:"GetInjectorError"})');
    expect(injector[1]).toBeFalsy();
    expect(injector[0]).toBeNull();
    const code = `// ==UserScript==
// @name Agent injection proof
// @namespace monkeyagent-tests
// @match *://*/*
// @grant GM_getValue
// @grant GM_setValue
// @run-at document-start
// ==/UserScript==
const ready = document.readyState;
GM_setValue('agent-test', 'working');
function mount() {
 const button = document.createElement('button'); button.id = 'agent-proof';
 button.dataset.ready = ready; button.dataset.gm = GM_getValue('agent-test');
 button.textContent = 'Run check'; button.addEventListener('click', () => button.textContent = 'Clicked');
 document.body.append(button);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, {once:true}); else mount();`;
    const saved = await api('save', { code });
    expect(saved[1]).toBeFalsy();
    expect(saved[0]).toMatchObject({ name: 'Agent injection proof', enabled: true, code });
    const scriptId = saved[0].id;
    const conflict = await api('save', { code });
    expect(conflict[1]).toBeTruthy();
    expect((await api('list'))[0]).toHaveLength(1);
    expect((await api('get', { id: scriptId }))[0].revision).toBe(saved[0].revision);
    await target.reload();
    await expect(target.locator('#agent-proof')).toHaveAttribute('data-ready', 'loading');
    await expect(target.locator('#agent-proof')).toHaveAttribute('data-gm', 'working');
    await target.locator('#agent-proof').click();
    await expect(target.locator('#agent-proof')).toHaveText('Clicked');
    await api('setEnabled', { id: scriptId, enabled: false });
    expect((await api('get', { id: scriptId }))[0].enabled).toBe(false);
    await target.reload();
    await expect(target.locator('#agent-proof')).toHaveCount(0);
    await api('setEnabled', { id: scriptId, enabled: true });
    await target.reload();
    await expect(target.locator('#agent-proof')).toBeVisible();
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
