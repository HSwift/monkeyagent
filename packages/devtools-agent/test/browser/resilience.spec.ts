import { test, expect, chromium } from '@playwright/test';
import { instrumentPanel, rpc, routeExampleSite } from './helpers';

test('stopping cancels queued tools, records uncertain outcomes and never replays them after reopening', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await routeExampleSite(context);
    await instrumentPanel(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const target = context.pages()[0];
    await target.goto('https://example.com');
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/',
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: '模型设置', exact: true }).waitFor();
    let frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const active = rpc(
      frame,
      'repl.run',
      'await browser.waitForEvent("Agent.never",{timeoutMs:60000}); return await fs.write("/workspace/dispatched.js","bad");',
      60000,
    );
    await expect
      .poll(async () =>
        (await rpc(frame, 'snapshot')).operations.some((op: any) => op.status === 'started'),
      )
      .toBe(true);
    const queued = rpc(
      frame,
      'repl.run',
      'return await fs.write("/workspace/queued.js","bad");',
    ).catch((error) => error);
    await rpc(frame, 'stop');
    expect((await active).success).toBe(false);
    expect(await queued).toBeInstanceOf(Error);
    expect((await rpc(frame, 'snapshot')).files).toHaveLength(0);
    expect((await rpc(frame, 'snapshot')).operations[0].status).toBe('unknown');
    expect((await rpc(frame, 'repl.run', 'while(true){}', 50)).success).toBe(false);
    expect((await rpc(frame, 'repl.run', 'return 42;')).value).toBe(42);
    await page.reload();
    await panel.getByRole('button', { name: '模型设置', exact: true }).waitFor();
    frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const restored = await rpc(frame, 'snapshot');
    expect(restored.files).toHaveLength(0);
    expect(restored.operations.filter((op: any) => op.status === 'unknown')).toHaveLength(1);
    expect(
      restored.operations.some(
        (op: any) => op.status === 'failed' && op.output.error.message.includes('interrupted'),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test('human drafts survive agent conflicts, diff restoration and narrow workspace switching', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await routeExampleSite(context);
    await instrumentPanel(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const target = context.pages()[0];
    await target.goto('https://example.com');
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/',
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: '模型设置', exact: true }).waitFor();
    const frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const path = '/workspace/test.user.js';
    const original = '// ==UserScript==\n// @name Draft test\n// ==/UserScript==\n// original';
    const file = await rpc(frame, 'files.write', path, original);
    await rpc(frame, 'scripts.apply', path);
    await panel.getByRole('button', { name: '文件', exact: true }).click();
    const editor = panel.getByRole('textbox', { name: '代码编辑器', exact: true });
    await expect(editor).toContainText('original');
    const human = original + '\n// human draft';
    await editor.fill(human);
    await rpc(frame, 'files.write', path, original + '\n// agent draft', file.revision);
    await expect(panel.getByText('版本冲突，草稿已保留', { exact: true })).toBeVisible();
    await expect(editor).toContainText('human draft');
    expect((await rpc(frame, 'files.read', path)).content).toContain('agent draft');
    await panel.getByRole('button', { name: '变更', exact: true }).click();
    await panel.getByRole('button', { name: '文件', exact: true }).click();
    await expect(editor).toContainText('human draft');
    await panel.getByRole('button', { name: '用当前草稿覆盖新版本', exact: true }).click();
    await expect.poll(async () => (await rpc(frame, 'files.read', path)).content).toBe(human);
    await panel.getByRole('button', { name: '变更', exact: true }).click();
    await panel.getByLabel('差异基线').selectOption('installed');
    await panel.getByRole('button', { name: '恢复基线', exact: true }).click();
    await expect.poll(async () => (await rpc(frame, 'files.read', path)).content).toBe(original);
    const restored = await rpc(frame, 'files.read', path);
    expect(restored.revision).not.toBe(file.revision);
    await page.setViewportSize({ width: 420, height: 800 });
    await expect(panel.locator('#tool-drawer')).toBeVisible();
    await panel.getByRole('button', { name: '文件', exact: true }).click();
    await editor.fill(original + '\n// narrow draft');
    await panel.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    await expect(panel.getByRole('textbox', { name: '发送给 Agent 的需求' })).toBeVisible();
    await panel.getByRole('button', { name: '文件', exact: true }).click();
    await expect(editor).toContainText('narrow draft');
  } finally {
    await context.close();
  }
});
