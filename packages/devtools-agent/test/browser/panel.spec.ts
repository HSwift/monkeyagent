import { routeExampleSite } from './helpers';
import { test, expect, chromium } from '@playwright/test';

test('fixture panel edits files, saves model settings, runs native browser REPL and restores the workspace', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await routeExampleSite(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const target = context.pages()[0];
    await target.goto('https://example.com/');
    const tabs = await worker.evaluate(() => chrome.tabs.query({}));
    const tabId = tabs.find((tab) => tab.url === 'https://example.com/')!.id;
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await expect(panel.getByRole('heading', { name: '有什么可以帮你？' })).toBeVisible();
    await expect(panel.locator('#tool-drawer')).toBeHidden();
    for (const name of ['文件', '变更', '调试'])
      await expect(panel.getByRole('button', { name, exact: true })).toBeVisible();
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    await panel.locator('.chat-layout').evaluate((chat) => {
      const initialX = chat.getBoundingClientRect().x;
      const offsets: number[] = [];
      let frame: number;
      const sample = () => {
        offsets.push(chat.getBoundingClientRect().x - initialX);
        frame = requestAnimationFrame(sample);
      };
      (window as any).__drawerMotion = { offsets, stop: () => cancelAnimationFrame(frame) };
      sample();
    });
    await panel.getByRole('button', { name: '文件', exact: true }).click();
    await expect(panel.locator('#tool-drawer')).toBeVisible();
    await panel.locator('#tool-drawer').evaluate(async (drawer) => {
      await Promise.all(drawer.getAnimations().map((animation) => animation.finished));
    });
    const offsets = await panel.locator('.chat-layout').evaluate(() => {
      const motion = (window as any).__drawerMotion;
      motion.stop();
      delete (window as any).__drawerMotion;
      return motion.offsets as number[];
    });
    expect(Math.max(...offsets.map(Math.abs))).toBeLessThanOrEqual(0.5);
    await panel.getByRole('button', { name: '文件', exact: true }).click();
    await expect(panel.locator('#tool-drawer')).toBeHidden();
    await panel.getByRole('button', { name: '变更', exact: true }).click();
    await expect(panel.getByRole('heading', { name: '变更', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel.locator('#tool-drawer')).toBeHidden();
    await expect(panel.getByRole('button', { name: '变更', exact: true })).toBeFocused();
    await panel.getByRole('button', { name: '文件', exact: true }).click();
    await panel.getByRole('button', { name: '新建文件', exact: true }).first().click();
    await panel.getByLabel('文件路径').fill('/workspace/test.user.js');
    await panel.getByRole('button', { name: '确认', exact: true }).click();
    const editor = panel.getByRole('textbox', { name: '代码编辑器', exact: true });
    await editor.fill(
      '// ==UserScript==\n// @name Browser Test\n// ==/UserScript==\nconsole.log("edited");',
    );
    await expect(panel.getByText('已保存 · 尚未安装', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '安装到 Monkey' }).click();
    await expect(panel.getByText('已安装 · 待验证', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: '模型设置', exact: true }).click();
    await panel.getByLabel('API Base URL').fill('https://provider.example/v1');
    await panel.getByLabel('模型名称').fill('test-model');
    await panel.getByLabel('API Key').fill('test-key-not-for-export');
    await panel.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(panel.getByRole('button', { name: '模型设置', exact: true })).toContainText(
      'test-model',
    );
    await panel.getByRole('button', { name: '调试', exact: true }).click();
    const repl = panel.getByRole('textbox', { name: 'JavaScript REPL', exact: true });
    await repl.fill('const title = await browser.evaluate("document.title"); return title;');
    await panel.getByRole('button', { name: '文件', exact: true }).click();
    await panel.getByRole('button', { name: '调试', exact: true }).click();
    await expect(repl).toContainText('const title');
    await panel.getByLabel('调试工具', { exact: true }).selectOption('network');
    await panel.getByLabel('调试工具', { exact: true }).selectOption('repl');
    await expect(repl).toContainText('const title');
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    await panel.getByRole('button', { name: '执行', exact: true }).click();
    await expect(panel.getByText('"Example Domain"', { exact: true })).toBeVisible();
    await page.reload();
    await expect(panel.locator('#tool-drawer')).toBeHidden();
    await panel.getByRole('button', { name: '文件', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'test.user.js', exact: true })).toBeVisible();
    await expect(panel.getByRole('textbox', { name: '代码编辑器' })).toContainText(
      'console.log("edited");',
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
