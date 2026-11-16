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
    await expect(panel.getByRole('heading', { name: '把想法变成 网页上的改变。' })).toBeVisible();
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
    await expect(panel.getByRole('button', { name: 'test-model', exact: true })).toBeVisible();
    await panel.getByRole('tab', { name: '调试', exact: true }).click();
    await panel.getByRole('button', { name: '执行', exact: true }).click();
    await expect(panel.getByText('"Example Domain"', { exact: true })).toBeVisible();
    await page.reload();
    await expect(panel.getByRole('button', { name: 'test.user.js', exact: true })).toBeVisible();
    await expect(panel.getByRole('textbox', { name: '代码编辑器' })).toContainText(
      'console.log("edited");',
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
