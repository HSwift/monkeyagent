import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { instrumentPanel, routeExampleSite, rpc } from './helpers';

async function fixture() {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    executablePath: process.env.AGENT_TEST_CHROMIUM,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await instrumentPanel(context);
  await routeExampleSite(context);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const target = context.pages()[0];
  await target.goto('https://example.com/');
  const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
    (tab) => tab.url === 'https://example.com/',
  )!.id!;
  const url = (id: number) => worker.url().replace('fixture.js', `devtools.html?tabId=${id}`);
  return { context, worker, target, tabId, url };
}
async function ready(page: Page) {
  await page
    .frameLocator('iframe')
    .getByRole('button', { name: 'Model settings', exact: true })
    .waitFor();
  return page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
}
async function open(context: BrowserContext, url: string) {
  const page = await context.newPage();
  await page.goto(url);
  return { page, frame: await ready(page) };
}

test('reopening waits for the previous same-tab lease instead of creating a blank conversation', async () => {
  const { context, worker, tabId, url } = await fixture();
  let held = false;
  try {
    const first = await open(context, url(tabId));
    await rpc(first.frame, 'repl.run', 'return "retained history";');
    const before = await rpc(first.frame, 'snapshot');
    await first.page.close();
    const lockName = `monkeyagent:session:${before.session.id}`;
    await worker.evaluate(async (name) => {
      await new Promise<void>((resolve) => {
        void navigator.locks.request(name, async () => {
          await new Promise<void>((release) => {
            (globalThis as any).__releaseSession = release;
            resolve();
          });
        });
      });
    }, lockName);
    held = true;
    const reopening = await context.newPage();
    await reopening.goto(url(tabId), { waitUntil: 'commit' });
    await expect
      .poll(async () =>
        worker.evaluate(
          async (name) =>
            (await navigator.locks.query()).pending?.some((lock) => lock.name === name),
          lockName,
        ),
      )
      .toBe(true);
    expect(
      await reopening
        .frameLocator('iframe')
        .getByRole('button', { name: 'Model settings', exact: true })
        .count(),
    ).toBe(0);
    await worker.evaluate(() => (globalThis as any).__releaseSession());
    held = false;
    const restored = await rpc(await ready(reopening), 'snapshot');
    expect(restored.session.id).toBe(before.session.id);
    expect(restored.history).toHaveLength(1);
    expect(restored.operations.map((operation: any) => operation.id)).toEqual(
      before.operations.map((operation: any) => operation.id),
    );
  } finally {
    if (held) await worker.evaluate(() => (globalThis as any).__releaseSession());
    await context.close();
  }
});

test('a tab remembers its selected conversation after another tab opens that conversation', async () => {
  const { context, worker, tabId, url } = await fixture();
  try {
    const first = await open(context, url(tabId));
    await rpc(first.frame, 'repl.run', 'return "first conversation";');
    const original = await rpc(first.frame, 'snapshot');
    await first.page.close();
    const otherTarget = await context.newPage();
    await otherTarget.goto('https://example.com/other');
    const otherId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/other',
    )!.id!;
    const second = await open(context, url(otherId));
    expect((await rpc(second.frame, 'snapshot')).session.id).not.toBe(original.session.id);
    await rpc(second.frame, 'session.open', original.session.id);
    await second.page.close();
    const reopened = await open(context, url(tabId));
    const restored = await rpc(reopened.frame, 'snapshot');
    expect(restored.session.id).toBe(original.session.id);
    expect(restored.history).toHaveLength(2);
    expect(restored.operations.map((operation: any) => operation.id)).toEqual(
      original.operations.map((operation: any) => operation.id),
    );
  } finally {
    await context.close();
  }
});

test('a replacement tab restores available site history when the original tab no longer exists', async () => {
  const { context, worker, target, tabId, url } = await fixture();
  try {
    const first = await open(context, url(tabId));
    const original = await rpc(first.frame, 'snapshot');
    await first.page.close();
    await target.close();
    const replacement = await context.newPage();
    await replacement.goto('https://example.com/');
    const newId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/',
    )!.id!;
    expect(newId).not.toBe(tabId);
    const reopened = await open(context, url(newId));
    const restored = await rpc(reopened.frame, 'snapshot');
    expect(restored.session.id).toBe(original.session.id);
    expect(restored.history).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test('reopening does not take over its remembered session while another tab is using it', async () => {
  const { context, worker, tabId, url } = await fixture();
  try {
    const first = await open(context, url(tabId));
    const original = await rpc(first.frame, 'snapshot');
    await first.page.close();
    const otherTarget = await context.newPage();
    await otherTarget.goto('https://example.com/busy');
    const otherId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/busy',
    )!.id!;
    const other = await open(context, url(otherId));
    await rpc(other.frame, 'session.open', original.session.id);
    const reopened = await open(context, url(tabId));
    const restored = await rpc(reopened.frame, 'snapshot');
    expect(restored.session.id).not.toBe(original.session.id);
    expect((await rpc(other.frame, 'snapshot')).session.id).toBe(original.session.id);
    await expect(rpc(reopened.frame, 'session.open', original.session.id)).rejects.toThrow(
      'session_busy',
    );
  } finally {
    await context.close();
  }
});
