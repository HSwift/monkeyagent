import { test, expect, chromium } from '@playwright/test';
import { instrumentPanel, rpc } from './helpers';

test('same-site tabs share files and session history while other sites remain isolated', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await instrumentPanel(context);
    await context.route(/^https:\/\/([a-z]+\.)?example\.(com|org)\//, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Site fixture</title><h1>Site fixture</h1>',
      }),
    );
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const targets = [context.pages()[0], await context.newPage(), await context.newPage()];
    const urls = ['https://one.example.com/', 'https://two.example.com/', 'https://example.org/'];
    for (let i = 0; i < targets.length; i++) {
      await targets[i].goto(urls[i]);
      await targets[i].evaluate((title) => {
        document.title = title;
      }, `Tab ${i}`);
    }
    const tabs = await worker.evaluate(() => chrome.tabs.query({}));
    const windows = await Promise.all(
      urls.map(async (url) => {
        const tabId = tabs.find((tab) => tab.url === url)!.id;
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
    const [a, b, other] = await Promise.all(windows.map((window) => rpc(window.frame, 'snapshot')));
    expect(a.workspace.id).toBe(b.workspace.id);
    expect(a.session.id).not.toBe(b.session.id);
    expect(a.workspace.id).not.toBe(other.workspace.id);
    expect(
      (await rpc(windows[0].frame, 'snapshot')).history.map((session: any) => session.id).sort(),
    ).toEqual([a.session.id, b.session.id].sort());
    expect(other.history.map((session: any) => session.id)).toEqual([other.session.id]);
    // Listen for unsolicited snapshots: another window's file changes reach the live UI.
    await windows[1].frame.evaluate(() => {
      (window as any).__testAgentPort.addEventListener('message', (event: MessageEvent) => {
        if (event.data.event === 'snapshot') (window as any).__siteSnapshot = event.data.data;
      });
    });
    const file = await rpc(windows[0].frame, 'files.write', '/workspace/shared.js', 'original');
    await expect
      .poll(() =>
        windows[1].frame.evaluate(() => (window as any).__siteSnapshot?.files[0]?.content),
      )
      .toBe('original');
    expect((await rpc(windows[1].frame, 'files.read', file.path)).revision).toBe(file.revision);
    await expect(rpc(windows[2].frame, 'files.read', file.path)).rejects.toThrow('not_found');
    const results = await Promise.allSettled([
      rpc(windows[0].frame, 'files.write', file.path, 'first', file.revision),
      rpc(windows[1].frame, 'files.write', file.path, 'second', file.revision),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      String(
        (results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason,
      ),
    ).toContain('conflict');
    const current = await rpc(windows[0].frame, 'files.read', file.path);
    expect(await rpc(windows[1].frame, 'files.read', file.path)).toEqual(current);
    for (let i = 0; i < windows.length; i++) {
      expect(
        (
          await rpc(
            windows[i].frame,
            'repl.run',
            'state.privateValue = "local"; return await browser.evaluate("document.title");',
          )
        ).value,
      ).toBe(`Tab ${i}`);
    }
    expect((await rpc(windows[0].frame, 'snapshot')).operations).toHaveLength(1);
    await expect(rpc(windows[1].frame, 'session.open', a.session.id)).rejects.toThrow(
      'session_busy',
    );
    await expect(rpc(windows[2].frame, 'session.open', a.session.id)).rejects.toThrow('site_scope');
    const next = await rpc(windows[0].frame, 'session.new');
    expect(next.workspace.id).toBe(a.workspace.id);
    expect(next.session.id).not.toBe(a.session.id);
    expect(next.files).toEqual([current]);
    expect(next.messages).toEqual([]);
    expect(next.operations).toEqual([]);
    expect(
      (await rpc(windows[0].frame, 'repl.run', 'return typeof state.privateValue;')).value,
    ).toBe('undefined');
    await rpc(windows[1].frame, 'session.open', a.session.id);
    expect(
      (await rpc(windows[1].frame, 'repl.run', 'return await browser.evaluate("document.title");'))
        .value,
    ).toBe('Tab 1');
    await windows[1].page.close();
    await rpc(windows[0].frame, 'session.open', a.session.id);
    await windows[0].page.reload();
    await windows[0].page
      .frameLocator('iframe')
      .getByRole('button', { name: '模型设置', exact: true })
      .waitFor();
    const reopened = windows[0].page
      .frames()
      .find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    expect((await rpc(reopened, 'snapshot')).session.id).toBe(a.session.id);
    expect((await rpc(reopened, 'files.read', file.path)).revision).toBe(current.revision);
  } finally {
    await context.close();
  }
});

test('navigation changes site scope with or without a debugger connection and restores site sessions', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await instrumentPanel(context);
    await context.route(/^https:\/\/([a-z]+\.)?example\.(com|org)\//, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Navigation fixture</title>',
      }),
    );
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const target = context.pages()[0];
    await target.goto('https://one.example.com/');
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://one.example.com/',
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    await page
      .frameLocator('iframe')
      .getByRole('button', { name: '模型设置', exact: true })
      .waitFor();
    const frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const original = await rpc(frame, 'snapshot');
    const file = await rpc(frame, 'files.write', '/workspace/site.js', 'site com');
    // No debugger has been attached. tabs.onUpdated must still update the panel automatically.
    await frame.evaluate(() => {
      (window as any).__testAgentPort.addEventListener('message', (event: MessageEvent) => {
        if (event.data.event === 'snapshot') (window as any).__siteSnapshot = event.data.data;
      });
    });
    await target.goto('https://example.org/');
    await expect
      .poll(() => frame.evaluate(() => (window as any).__siteSnapshot?.workspace.site))
      .toBe('example.org');
    const other = await rpc(frame, 'snapshot');
    expect(other.session.id).not.toBe(original.session.id);
    expect(other.files).toEqual([]);
    expect(other.history.map((session: any) => session.id)).toEqual([other.session.id]);
    await expect(rpc(frame, 'session.open', original.session.id)).rejects.toThrow('site_scope');
    await rpc(frame, 'files.write', file.path, 'site org');
    await rpc(
      frame,
      'repl.run',
      'state.foreign = true; return await browser.evaluate("location.hostname");',
    );
    // Exercise a tool-initiated cross-site navigation while the debugger and tool are active.
    const navigating = rpc(
      frame,
      'repl.run',
      'await browser.navigate("https://two.example.com/");',
    );
    await expect
      .poll(async () => (await rpc(frame, 'snapshot')).workspace.site)
      .toBe('example.com');
    await navigating;
    const restored = await rpc(frame, 'snapshot');
    expect(restored.session.id).toBe(original.session.id);
    expect(restored.history).toHaveLength(1);
    expect(restored.operations).toEqual([]);
    expect((await rpc(frame, 'files.read', file.path)).content).toBe('site com');
    expect((await rpc(frame, 'repl.run', 'return typeof state.foreign;')).value).toBe('undefined');
    await target.goto('https://one.example.com/path');
    const same = await rpc(frame, 'snapshot');
    expect(same.session.id).toBe(original.session.id);
    expect(same.session.targetUrl).toBe('https://one.example.com/path');
    await target.goto('https://example.org/back');
    expect((await rpc(frame, 'snapshot')).session.id).toBe(other.session.id);
    expect((await rpc(frame, 'files.read', file.path)).content).toBe('site org');
  } finally {
    await context.close();
  }
});
