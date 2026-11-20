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

test('New file uploads local text, preserves existing files and restores uploads after reload', async () => {
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
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Upload file', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'New file', exact: true }).last().click();
    const dialog = panel.getByRole('dialog', { name: 'New workspace file', exact: true });
    const picker = dialog.getByRole('button', { name: 'Upload file', exact: true });
    const upload = dialog.getByRole('button', { name: 'Upload', exact: true });
    await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled();
    const [pickerBounds, formBounds, actionsBounds] = await Promise.all([
      picker.boundingBox(),
      dialog.locator('form').boundingBox(),
      dialog.locator('.form-actions').boundingBox(),
    ]);
    expect(pickerBounds!.width).toBeCloseTo(formBounds!.width, 0);
    expect(pickerBounds!.y).toBeGreaterThan(actionsBounds!.y + actionsBounds!.height);
    const content = '// 本地上传\nconsole.log("uploaded");\n';
    const source = {
      name: 'local.user.js',
      mimeType: 'text/javascript',
      buffer: Buffer.from(content),
    };
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), picker.click()]);
    await chooser.setFiles(source);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('File path')).toHaveValue('/workspace/local.user.js');
    await dialog.getByLabel('File path').fill('/workspace/uploads/example.user.js');
    await upload.click();
    await expect(dialog).toBeHidden();
    const editor = panel.getByRole('textbox', { name: 'Code editor', exact: true });
    await expect(editor).toContainText('// 本地上传');
    await expect(editor).toContainText('console.log("uploaded");');
    await expect(panel.getByRole('button', { name: 'example.user.js', exact: true })).toBeVisible();

    await page.reload();
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(editor).toContainText('console.log("uploaded");');
    await panel.getByRole('button', { name: 'New file', exact: true }).click();
    await dialog.getByLabel('Local file').setInputFiles({
      ...source,
      buffer: Buffer.from('replacement'),
    });
    await dialog.getByLabel('File path').fill('/workspace/uploads/example.user.js');
    await upload.click();
    await expect(dialog.getByRole('alert')).toContainText('A file already exists at this path.');
    await dialog.getByLabel('File path').fill('/workspace/copy.user.js');
    await upload.click();
    await expect(dialog).toBeHidden();
    await expect(editor).toContainText('replacement');
    await panel.getByRole('button', { name: 'example.user.js', exact: true }).click();
    await expect(editor).toContainText('console.log("uploaded");');

    for (const [name, buffer, message] of [
      ['binary.dat', Buffer.from([0, 1, 2]), 'Choose a UTF-8 text file.'],
      ['invalid.txt', Buffer.from([0xff]), 'Choose a UTF-8 text file.'],
      ['large.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 'a'), 'Text files are limited to 2 MiB.'],
    ] as const) {
      await panel.getByRole('button', { name: 'New file', exact: true }).click();
      await dialog.getByLabel('Local file').setInputFiles({ name, mimeType: '', buffer });
      await upload.click();
      await expect(dialog.getByRole('alert')).toContainText(message);
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(panel.locator('button.tree-file')).toHaveCount(2);
    }
    await panel.getByRole('button', { name: 'New file', exact: true }).click();
    await dialog.getByLabel('Local file').setInputFiles({
      name: 'empty.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(0),
    });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'empty.txt', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'New file', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Confirm', exact: true })).toBeEnabled();
    await expect(upload).toHaveCount(0);
    await dialog.getByLabel('Local file').setInputFiles({
      name: 'empty.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(0),
    });
    await upload.click();
    await expect(dialog).toBeHidden();
    await expect(panel.getByRole('button', { name: 'empty.txt', exact: true })).toBeVisible();
    await expect(editor).toHaveText('');
  } finally {
    await context.close();
  }
});
