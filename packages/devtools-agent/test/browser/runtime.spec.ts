import { test, expect, chromium } from '@playwright/test';
import { readdir } from 'node:fs/promises';

import { targetSession } from './helpers';

test('real F12 page can attach native debugging and run packaged QuickJS under MV3 CSP', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
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
    const root = await context.browser()!.newBrowserCDPSession();
    await expect
      .poll(
        async () =>
          (await root.send('Target.getTargets')).targetInfos.filter(
            (target) => target.url === worker.url().replace('fixture.js', 'devtools.html'),
          ).length,
      )
      .toBeGreaterThan(0);
    const targets = (await root.send('Target.getTargets')).targetInfos;
    expect(targets.some((target) => target.url.startsWith('devtools://'))).toBe(true);
    const devtools = targets.find(
      (target) => target.url === worker.url().replace('fixture.js', 'devtools.html'),
    )!;
    const session = await targetSession(root, devtools.targetId);
    const evaluate = async (expression: string) => {
      const response = await session.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    };
    const native = await evaluate(`(async () => {
      const tabId = chrome.devtools.inspectedWindow.tabId;
      await chrome.debugger.attach({tabId}, '1.3');
      const result = await chrome.debugger.sendCommand({tabId}, 'Runtime.evaluate', {expression: '1 + 2', returnByValue:true});
      const screenshot = await chrome.debugger.sendCommand({tabId}, 'Page.captureScreenshot', {format:'png'});
      await chrome.debugger.detach({tabId});
      return {tabId, value:result.result.value, screenshotBytes:screenshot.data.length};
    })()`);
    expect(native.value).toBe(3);
    expect(native.screenshotBytes).toBeGreaterThan(100);
    const workerName = (await readdir(new URL('../../dist/assets/', import.meta.url))).find(
      (name) => /^worker-.*\.js$/.test(name),
    )!;
    const repl = await evaluate(`(async () => {
      const worker = new Worker(${JSON.stringify(`assets/${workerName}`)}, {type:'module'});
      const run = (id, code, timeoutMs) => new Promise((resolve, reject) => {
        const listener = event => {
          if (event.data.type === 'host') worker.postMessage({type:'host-result', id:event.data.id, value:'host title'});
          if (event.data.type === 'result' && event.data.id === id) {worker.removeEventListener('message',listener); resolve(event.data);}
        };
        worker.addEventListener('message',listener); worker.addEventListener('error',event => reject(new Error(event.message)), {once:true});
        worker.postMessage({type:'run',id,code,timeoutMs});
      });
      try {
        const first = await run('one','state.title = await browser.evaluate("document.title"); return state.title;',1000);
        const second = await run('two','return {title:state.title, chrome:typeof chrome};',1000);
        const third = await run('three','while (true) {}',50);
        return {first,second,third};
      } finally {worker.terminate();}
    })()`);
    expect(repl.first.value).toBe('host title');
    expect(repl.second.value).toEqual({ title: 'host title', chrome: 'undefined' });
    expect(repl.third.error.message).toContain('interrupted');
    const inspector = (await root.send('Target.getTargets')).targetInfos.find((target) =>
      target.url.startsWith('devtools://'),
    )!;
    const frontend = await targetSession(root, inspector.targetId);
    const showAgent = `(async()=>{const UI=await import('./ui/legacy/legacy.js');const view=UI.InspectorView.InspectorView.instance();const id=view.tabbedPane.tabIds().find(id=>id.endsWith('Agent'));if(!id)return false;await view.showPanel(id);return true;})()`;
    await expect
      .poll(
        async () =>
          (
            await frontend.send('Runtime.evaluate', {
              expression: showAgent,
              awaitPromise: true,
              returnByValue: true,
            })
          ).result.value,
      )
      .toBe(true);
    let panelTarget: string | undefined;
    await expect
      .poll(async () => {
        panelTarget = (await root.send('Target.getTargets')).targetInfos.find(
          (target) => target.url === worker.url().replace('fixture.js', 'panel.html'),
        )?.targetId;
        return !!panelTarget;
      })
      .toBe(true);
    const panel = await targetSession(root, panelTarget!);
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
    await expect
      .poll(
        async () =>
          (
            await panel.send('Runtime.evaluate', {
              expression: `[...document.querySelectorAll('header button')].some(el=>el.textContent==='Debug')`,
              returnByValue: true,
            })
          ).result.value,
      )
      .toBe(true);
    await panel.send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('header button')].find(el=>el.textContent==='Debug').click()`,
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
      )
      .toContain('Connect to page');
    await panel.send('Runtime.evaluate', {
      expression: `[...document.querySelectorAll('button')].find(el=>el.textContent==='Run').click()`,
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
      )
      .toContain('Result');
    // Switching native panels keeps the hidden Controller and its debugger alive.
    await frontend.send('Runtime.evaluate', {
      expression: `(async()=>{const UI=await import('./ui/legacy/legacy.js');await UI.InspectorView.InspectorView.instance().showPanel('network');})()`,
      awaitPromise: true,
    });
    const afterSwitch = await evaluate(
      'chrome.debugger.sendCommand({tabId:chrome.devtools.inspectedWindow.tabId},"Runtime.evaluate",{expression:"6*7",returnByValue:true})',
    );
    expect(afterSwitch.result.value).toBe(42);
    for (const side of ['bottom', 'undocked', 'right']) {
      await frontend.send('Runtime.evaluate', {
        expression: `(async()=>{const UI=await import('./ui/legacy/legacy.js');UI.DockController.DockController.instance().setDockSide(${JSON.stringify(side)});})()`,
        awaitPromise: true,
      });
      const state = await evaluate(
        'chrome.debugger.sendCommand({tabId:chrome.devtools.inspectedWindow.tabId},"Runtime.evaluate",{expression:"21*2",returnByValue:true})',
      );
      expect(state.result.value).toBe(42);
    }
    // Close the actual F12 frontend; its lifecycle Port must release native debugging.
    await root.send('Target.closeTarget', { targetId: inspector.targetId });
    // Playwright itself remains attached, so native target.attached alone cannot prove cleanup.
    await expect
      .poll(() =>
        worker.evaluate(async (tabId) => {
          try {
            await chrome.debugger.attach({ tabId }, '1.3');
            await chrome.debugger.detach({ tabId });
            return true;
          } catch {
            return false;
          }
        }, native.tabId),
      )
      .toBe(true);
  } finally {
    await context.close();
  }
});
