import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { instrumentPanel, routeExampleSite, rpc } from './helpers';

test('Files lazily lists docs and artifacts, keeps them read-only, and never exposes source', async () => {
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
    await context.route('https://example.org/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<title>Other site</title>' }),
    );
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const target = context.pages()[0];
    await target.goto('https://example.com/');
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/',
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    const frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const file = await rpc(
      frame,
      'files.write',
      '/workspace/scripts/app.js',
      '// workspace editor',
    );
    await rpc(frame, 'files.write', '/workspace/scripts', '// prefix file');
    const first = await rpc(
      frame,
      'repl.run',
      'return {value:"A".repeat(40000)+"MID_MARKER"+"B".repeat(40000)};',
    );
    const artifact = first.value.artifact.path as string;
    await frame.evaluate(() => {
      const port = (window as any).__testAgentPort as MessagePort;
      const send = port.postMessage.bind(port);
      (window as any).__fileRequests = [];
      port.postMessage = ((message: any) => {
        if (message.type === 'request')
          (window as any).__fileRequests.push({ method: message.method, args: message.args });
        send(message);
      }) as typeof port.postMessage;
    });
    const calls = (method: string, prefix: string) =>
      frame.evaluate(
        ({ method, prefix }) =>
          (window as any).__fileRequests.filter(
            (request: any) =>
              request.method === method && String(request.args[0]).startsWith(prefix),
          ).length,
        { method, prefix },
      );
    await panel.getByRole('button', { name: 'Files', exact: true }).click();
    const docs = panel.getByRole('button', { name: '/docs', exact: true });
    const artifacts = panel.getByRole('button', { name: '/artifacts', exact: true });
    await expect(panel.getByRole('button', { name: '/workspace', exact: true })).toBeVisible();
    await expect(docs).toHaveAttribute('aria-expanded', 'false');
    await expect(artifacts).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.getByRole('button', { name: '/source', exact: true })).toHaveCount(0);
    expect(await calls('files.list', '/docs')).toBe(0);
    expect(await calls('files.list', '/artifacts')).toBe(0);
    await panel.getByRole('button', { name: '/workspace/scripts', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'app.js', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'scripts', exact: true })).toBeVisible();
    await docs.click();
    const guide = panel.getByRole('button', { name: 'agent-guide.md', exact: true });
    await expect(guide).toBeVisible();
    expect(await calls('files.list', '/docs')).toBe(1);
    expect(await calls('files.read', '/docs')).toBe(0);
    await guide.click();
    await expect(panel.getByText('Read-only documentation', { exact: true })).toBeVisible();
    await expect(panel.getByRole('textbox', { name: 'Code editor', exact: true })).toHaveAttribute(
      'aria-readonly',
      'true',
    );
    await expect(panel.getByRole('button', { name: 'Rename file', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Delete file', exact: true })).toHaveCount(0);
    await docs.click();
    await docs.click();
    await expect(guide).toBeVisible();
    expect(await calls('files.list', '/docs')).toBe(1);
    const downloadPromise = page.waitForEvent('download');
    await panel.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;
    expect(await readFile((await download.path())!, 'utf8')).toContain(
      'Userscript development quick start',
    );
    await rpc(frame, 'files.write', '/workspace/later.txt', 'new file while reading docs');
    await expect(panel.getByRole('button', { name: 'later.txt', exact: true })).toBeVisible();
    await expect(panel.getByText('Read-only documentation', { exact: true })).toBeVisible();
    expect(await calls('files.read', '/docs')).toBe(1);
    await artifacts.click();
    const result = panel.getByRole('button', { name: artifact.split('/').pop()!, exact: true });
    await expect(result).toBeVisible();
    expect(await calls('files.list', '/artifacts')).toBe(1);
    expect(await calls('files.read', '/artifacts')).toBe(0);
    await result.click();
    await expect(panel.getByText('Read-only result', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(
      panel.getByText('Characters 32001–64000 of ' + first.value.artifact.size, { exact: true }),
    ).toBeVisible();
    expect(await calls('files.read', '/artifacts')).toBe(2);
    await artifacts.click();
    const second = await rpc(frame, 'repl.run', 'return "second".repeat(3000);');
    await expect
      .poll(async () => (await rpc(frame, 'snapshot')).workspace.artifactsRevision)
      .toBe(second.value.artifact.id);
    expect(await calls('files.list', '/artifacts')).toBe(1);
    await artifacts.click();
    await expect(
      panel.getByRole('button', { name: second.value.artifact.path.split('/').pop(), exact: true }),
    ).toBeVisible();
    expect(await calls('files.list', '/artifacts')).toBe(2);
    const third = await rpc(frame, 'repl.run', 'return "third".repeat(3000);');
    await expect(
      panel.getByRole('button', { name: third.value.artifact.path.split('/').pop(), exact: true }),
    ).toBeVisible();
    expect(await calls('files.list', '/artifacts')).toBe(3);
    const snapshot = await rpc(frame, 'snapshot');
    expect(snapshot.connected).toBe(false);
    expect(snapshot.files.map((file: any) => file.path)).toEqual([
      '/workspace/later.txt',
      '/workspace/scripts',
      file.path,
    ]);
    expect(await calls('files.list', '/source')).toBe(0);
    await expect(rpc(frame, 'files.list', '/source')).rejects.toThrow('invalid_path');
    expect((await rpc(frame, 'snapshot')).connected).toBe(false);
    await page.setViewportSize({ width: 420, height: 800 });
    await expect(panel.getByRole('button', { name: '/docs', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('file-roots-narrow.png') });
    await target.goto('https://example.org/');
    await expect
      .poll(async () => (await rpc(frame, 'snapshot')).workspace.site)
      .toBe('example.org');
    await expect(result).toHaveCount(0);
    await expect(artifacts).toHaveAttribute('aria-expanded', 'false');
    await artifacts.click();
    await expect(panel.getByText('No saved text results', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
