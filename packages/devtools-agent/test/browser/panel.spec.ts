import { routeExampleSite } from './helpers';
import { test, expect, chromium } from '@playwright/test';

test('fixture panel edits files, saves model settings, runs native browser REPL and restores the workspace', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    locale: 'zh-CN',
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
    const englishUI = async () => {
      await expect(panel.locator('html')).toHaveAttribute('lang', 'en');
      expect(await panel.locator('body').innerText()).not.toMatch(/\p{Script=Han}/u);
      const labels = await panel.locator('body').evaluate((body) =>
        Array.from(body.querySelectorAll('*'))
          .flatMap((element) =>
            ['aria-label', 'placeholder', 'title'].map((name) => element.getAttribute(name) ?? ''),
          )
          .filter((text) => /\p{Script=Han}/u.test(text)),
      );
      expect(labels).toEqual([]);
    };
    await expect(panel.getByRole('heading', { name: 'How can I help?' })).toBeVisible();
    await englishUI();
    await expect(panel.locator('#tool-drawer')).toBeHidden();
    for (const name of ['Files', 'Changes', 'Debug'])
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
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
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
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(panel.locator('#tool-drawer')).toBeHidden();
    await panel.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'Changes', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel.locator('#tool-drawer')).toBeHidden();
    await expect(panel.getByRole('button', { name: 'Changes', exact: true })).toBeFocused();
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    await panel.getByRole('button', { name: 'New file', exact: true }).first().click();
    await englishUI();
    await panel.getByLabel('File path').fill('/workspace/test.user.js');
    await panel.getByRole('button', { name: 'Confirm', exact: true }).click();
    const editor = panel.getByRole('textbox', { name: 'Code editor', exact: true });
    await editor.fill(
      '// ==UserScript==\n// @name Browser Test\n// ==/UserScript==\nconsole.log("edited");',
    );
    await expect(panel.getByText('Saved · Not installed', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Install to Monkey' }).click();
    await expect(panel.getByText('Installed · Not verified', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Model settings', exact: true }).click();
    await englishUI();
    await panel.getByLabel('API Base URL').fill('https://provider.example/v1');
    await panel.getByLabel('Model name').fill('test-model');
    await panel.getByLabel('API Key').fill('test-key-not-for-export');
    await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Model settings', exact: true })).toContainText(
      'test-model',
    );
    await panel.getByRole('button', { name: 'Debug', exact: true }).click();
    const repl = panel.getByRole('textbox', { name: 'JavaScript REPL', exact: true });
    await repl.fill('const title = await browser.evaluate("document.title"); return title;');
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    await panel.getByRole('button', { name: 'Debug', exact: true }).click();
    await expect(repl).toContainText('const title');
    await panel.getByLabel('Debug tool', { exact: true }).selectOption('network');
    await englishUI();
    await panel.getByLabel('Debug tool', { exact: true }).selectOption('logs');
    await englishUI();
    await panel.getByLabel('Debug tool', { exact: true }).selectOption('screenshots');
    await englishUI();
    await panel.getByLabel('Debug tool', { exact: true }).selectOption('repl');
    await expect(repl).toContainText('const title');
    await expect(panel.getByRole('tablist')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(panel.getByText('"Example Domain"', { exact: true })).toBeVisible();
    await englishUI();
    await page.reload();
    await expect(panel.locator('#tool-drawer')).toBeHidden();
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'test.user.js', exact: true })).toBeVisible();
    await expect(panel.getByRole('textbox', { name: 'Code editor' })).toContainText(
      'console.log("edited");',
    );
    for (const action of ['Rename file', 'Delete file', 'Import Monkey script']) {
      await panel.getByRole('button', { name: action, exact: true }).click();
      await englishUI();
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
    await panel.getByRole('button', { name: 'Close drawer', exact: true }).click();
    for (const item of ['Session history', 'Clear context']) {
      await panel.getByRole('button', { name: 'More actions', exact: true }).click();
      await panel.getByRole('menuitem', { name: item, exact: true }).click();
      await englishUI();
      await panel.getByRole('button', { name: 'Close', exact: true }).click();
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
