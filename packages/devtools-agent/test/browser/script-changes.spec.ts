import { test, expect, chromium } from '@playwright/test';
import { instrumentPanel, routeExampleSite, rpc } from './helpers';

test('Changes belongs to installed userscripts and restores history into a draft before explicit installation', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    executablePath: process.env.AGENT_TEST_CHROMIUM,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await instrumentPanel(context);
    await routeExampleSite(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await context.pages()[0].goto('https://example.com/');
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/',
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    const frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const plain = await rpc(frame, 'files.write', '/workspace/notes.txt', 'first note');
    await rpc(frame, 'files.write', plain.path, 'updated note', plain.revision);
    await panel.getByRole('button', { name: 'Changes', exact: true }).click();
    await expect(
      panel.getByText('No installed userscript selected', { exact: true }),
    ).toBeVisible();
    const code =
      '// ==UserScript==\n// @name Script history\n// @namespace tests\n// @version 1\n// ==/UserScript==\n// ORIGINAL_SCRIPT';
    const file = await rpc(frame, 'files.write', '/workspace/main.user.js', code);
    await expect(rpc(frame, 'scripts.history', file.path)).rejects.toThrow('not_installed');
    await rpc(frame, 'scripts.apply', file.path);
    const first = await rpc(frame, 'scripts.history', file.path);
    expect(first.versions).toHaveLength(1);
    expect(first.versions[0].code).toBeUndefined();
    const changed = code
      .replace('@version 1', '@version 2')
      .replace('ORIGINAL_SCRIPT', 'UPDATED_SCRIPT');
    await rpc(frame, 'files.write', file.path, changed, file.revision);
    expect((await rpc(frame, 'scripts.history', file.path)).versions).toHaveLength(1);
    await rpc(frame, 'scripts.apply', file.path);
    await rpc(frame, 'scripts.apply', file.path);
    const second = await rpc(frame, 'scripts.history', file.path);
    expect(second.versions).toHaveLength(2);
    await expect(panel.getByLabel('Userscript', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('Script version', { exact: true })).toBeEnabled();
    await panel.getByLabel('Script version', { exact: true }).selectOption(first.versions[0].id);
    await expect(panel.locator('.changes-pane')).toContainText('ORIGINAL_SCRIPT');
    await expect(panel.locator('.changes-pane')).toContainText('UPDATED_SCRIPT');
    await page.screenshot({ path: test.info().outputPath('script-changes.png') });
    await page.setViewportSize({ width: 420, height: 800 });
    await expect(
      panel.getByRole('button', { name: 'Restore to editor', exact: true }),
    ).toBeVisible();
    expect(
      await panel
        .locator('.changes-pane')
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath('script-changes-narrow.png') });
    await panel.getByRole('button', { name: 'Restore to editor', exact: true }).click();
    await expect.poll(async () => (await rpc(frame, 'files.read', file.path)).content).toBe(code);
    expect((await rpc(frame, 'scripts.history', file.path)).script.version).toBe('2');
    expect((await rpc(frame, 'scripts.history', file.path)).versions).toHaveLength(2);
    await rpc(frame, 'scripts.apply', file.path);
    const restored = await rpc(frame, 'scripts.history', file.path);
    expect(restored.versions.map((version: any) => version.version)).toEqual(['1', '2', '1']);
    expect(restored.versions[0].id).not.toBe(first.versions[0].id);
    const other = await rpc(
      frame,
      'files.write',
      '/workspace/other.user.js',
      code.replace('@name Script history', '@name Other script'),
    );
    await rpc(frame, 'scripts.apply', other.path);
    await expect(rpc(frame, 'scripts.version', other.path, first.versions[0].id)).rejects.toThrow(
      'not_found',
    );
    await page.reload();
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    const reopened = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    expect((await rpc(reopened, 'scripts.history', file.path)).versions).toHaveLength(3);
  } finally {
    await context.close();
  }
});
