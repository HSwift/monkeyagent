import { test, expect, chromium } from '@playwright/test';
import { instrumentPanel, rpc } from './helpers';

for (const fallback of [false, true]) {
  test(`site scope uses ${fallback ? 'the bundled PSL when the native API is unavailable' : 'the real browser publicSuffix API'}`, async () => {
    const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    try {
      await instrumentPanel(context);
      await context.addInitScript((forceFallback) => {
        if (
          location.protocol !== 'chrome-extension:' ||
          !location.pathname.endsWith('/devtools.html')
        )
          return;
        const api = chrome.publicSuffix;
        const native = api?.getDomain;
        (window as any).__nativeSuffixAvailable = typeof native === 'function';
        (window as any).__nativeSuffixCalls = [];
        if (!native) return;
        Object.defineProperty(api, 'getDomain', {
          configurable: true,
          value: forceFallback
            ? undefined
            : (hostname: string) => {
                (window as any).__nativeSuffixCalls.push(hostname);
                return native.call(api, hostname);
              },
        });
      }, fallback);
      await context.route(/^https:\/\/(one|two)\.(example\.co\.uk|github\.io)\//, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><title>Suffix fixture</title>',
        }),
      );
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const target = context.pages()[0];
      await target.goto('https://one.example.co.uk/');
      const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
        (tab) => tab.url === 'https://one.example.co.uk/',
      )!.id;
      const page = await context.newPage();
      await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
      await page
        .frameLocator('iframe')
        .getByRole('button', { name: 'Model settings', exact: true })
        .waitFor();
      const nativeAvailable = await page.evaluate(() => (window as any).__nativeSuffixAvailable);
      test.skip(
        !fallback && !nativeAvailable,
        'This Chromium version does not expose publicSuffix.',
      );
      const frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
      const initial = await rpc(frame, 'snapshot');
      expect(initial.workspace.site).toBe('example.co.uk');
      const file = await rpc(frame, 'files.write', '/workspace/shared.js', 'same site');
      await target.goto('https://two.example.co.uk/');
      const same = await rpc(frame, 'snapshot');
      expect(same.workspace.id).toBe(initial.workspace.id);
      expect(same.session.id).toBe(initial.session.id);
      expect((await rpc(frame, 'files.read', file.path)).content).toBe('same site');
      for (const tenant of ['one', 'two']) {
        await target.goto(`https://${tenant}.github.io/`);
        const site = await rpc(frame, 'snapshot');
        expect(site.workspace.site).toBe(`${tenant}.github.io`);
        expect(site.files).toEqual([]);
        expect(site.history.map((session: any) => session.id)).toEqual([site.session.id]);
      }
      const calls = await page.evaluate(() => (window as any).__nativeSuffixCalls as string[]);
      if (fallback) expect(calls).toEqual([]);
      else
        expect(calls).toEqual(
          expect.arrayContaining([
            'one.example.co.uk',
            'two.example.co.uk',
            'one.github.io',
            'two.github.io',
          ]),
        );
    } finally {
      await context.close();
    }
  });
}
