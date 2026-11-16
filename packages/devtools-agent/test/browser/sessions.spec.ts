import { test, expect, chromium } from '@playwright/test';
import { instrumentPanel, routeExampleSite, rpc } from './helpers';

test('simultaneous inspected tabs keep targets and workspaces isolated and cannot execute the same conversation', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await instrumentPanel(context);
    await routeExampleSite(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const targets = [context.pages()[0], await context.newPage()];
    await targets[0].goto('https://example.com/one');
    await targets[1].goto('https://example.com/two');
    await targets[0].evaluate(() => {
      document.title = 'Tab One';
    });
    await targets[1].evaluate(() => {
      document.title = 'Tab Two';
    });
    const tabs = await worker.evaluate(() => chrome.tabs.query({}));
    const tabIds = ['one', 'two'].map(
      (name) => tabs.find((tab) => tab.url === `https://example.com/${name}`)!.id,
    );
    const windows = await Promise.all(
      tabIds.map(async (tabId) => {
        const page = await context.newPage();
        await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
        await page
          .frameLocator('iframe')
          .getByRole('button', { name: '模型设置', exact: true })
          .waitFor();
        return {
          page,
          frame: page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!,
        };
      }),
    );
    const first = await rpc(windows[0].frame, 'snapshot');
    const second = await rpc(windows[1].frame, 'snapshot');
    expect(first.workspace.id).not.toBe(second.workspace.id);
    await rpc(windows[0].frame, 'files.write', '/workspace/shared-name.js', 'first');
    await rpc(windows[1].frame, 'files.write', '/workspace/shared-name.js', 'second');
    expect((await rpc(windows[0].frame, 'files.read', '/workspace/shared-name.js')).content).toBe(
      'first',
    );
    expect((await rpc(windows[1].frame, 'files.read', '/workspace/shared-name.js')).content).toBe(
      'second',
    );
    expect(
      (await rpc(windows[0].frame, 'repl.run', 'return await browser.evaluate("document.title");'))
        .value,
    ).toBe('Tab One');
    expect(
      (await rpc(windows[1].frame, 'repl.run', 'return await browser.evaluate("document.title");'))
        .value,
    ).toBe('Tab Two');
    await expect(rpc(windows[1].frame, 'workspace.open', first.workspace.id)).rejects.toThrow(
      'workspace_busy',
    );
    await windows[1].page.close();
    expect(
      (await rpc(windows[0].frame, 'repl.run', 'return await browser.evaluate("document.title");'))
        .value,
    ).toBe('Tab One');
    await rpc(windows[0].frame, 'workspace.new');
    await rpc(windows[0].frame, 'workspace.open', first.workspace.id);
    await windows[0].page.reload();
    await windows[0].page
      .frameLocator('iframe')
      .getByRole('button', { name: '模型设置', exact: true })
      .waitFor();
    const reopened = windows[0].page
      .frames()
      .find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    expect((await rpc(reopened, 'snapshot')).workspace.id).toBe(first.workspace.id);
    expect((await rpc(reopened, 'files.read', '/workspace/shared-name.js')).content).toBe('first');
  } finally {
    await context.close();
  }
});
