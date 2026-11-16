import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { instrumentPanel, rpc, routeExampleSite } from './helpers';

test('internal console export reads a session and its site workspace without changing data and redacts credentials', async () => {
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
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
    await context.pages()[0].goto('https://example.com/');
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/',
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    await page
      .frameLocator('iframe')
      .getByRole('button', { name: 'Model settings', exact: true })
      .waitFor();
    const frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    await rpc(frame, 'files.write', '/workspace/other.js', 'OTHER_WORKSPACE_PRIVATE_DATA');
    await context.pages()[0].goto('https://example.org/');
    const current = await rpc(frame, 'snapshot');
    await rpc(frame, 'settings.save', {
      provider: 'openai-compatible',
      baseURL: 'https://model.example/v1',
      model: 'test-model',
      apiKey: 'MODEL_SECRET_123',
      supportsImages: false,
      theme: 'light',
    });
    const original = await rpc(frame, 'files.write', '/workspace/main.js', 'MODEL_SECRET_123');
    await rpc(frame, 'files.write', original.path, 'second revision', original.revision);
    await rpc(
      frame,
      'repl.run',
      'return { headers: { Authorization: "Bearer HEADER_SECRET", Cookie: "COOKIE_SECRET" }, url: "https://example.com/?access_token=QUERY_SECRET", embedded: JSON.stringify({password:"EMBEDDED_SECRET"}) };',
    );
    await rpc(frame, 'repl.run', 'throw new Error("observed harness failure");');
    await worker.evaluate(
      async ({ workspaceId, sessionId }) => {
        const request = indexedDB.open('monkeyagent-devtools-v1');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const tx = db.transaction(['conversations', 'runs', 'artifacts'], 'readwrite');
        tx.objectStore('conversations').put({
          id: sessionId,
          messages: [
            {
              id: 'request',
              role: 'user',
              parts: [{ type: 'text', text: 'Analyze the observed harness failure.' }],
            },
          ],
        });
        tx.objectStore('runs').put({
          id: 'run',
          workspaceId,
          sessionId,
          startedAt: 1,
          endedAt: 2,
          status: 'failed',
          queued: [],
        });
        tx.objectStore('artifacts').put({
          id: 'text',
          workspaceId,
          sessionId,
          path: '/artifacts/result.json',
          mimeType: 'application/json',
          size: 31,
          createdAt: 1,
          blob: new Blob(['{"api_key":"ARTIFACT_SECRET"}'], { type: 'application/json' }),
        });
        tx.objectStore('artifacts').put({
          id: 'image',
          workspaceId,
          sessionId,
          path: '/artifacts/screenshot.png',
          mimeType: 'image/png',
          size: 10,
          createdAt: 2,
          blob: new Blob(['IMAGE_DATA'], { type: 'image/png' }),
        });
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        db.close();
        (globalThis as any).copy = (text: string) => {
          (globalThis as any).__exportedTrace = text;
        };
      },
      { workspaceId: current.workspace.id, sessionId: current.session.id },
    );
    const source = await readFile(
      new URL('../../scripts/export-debug-data.js', import.meta.url),
      'utf8',
    );
    await worker.evaluate(source);
    const json = await worker.evaluate(() => (globalThis as any).__exportedTrace as string);
    const trace = JSON.parse(json);
    expect(trace.format).toBe('monkeyagent-debug');
    expect(trace.workspace.id).toBe(current.workspace.id);
    expect(trace.session.id).toBe(current.session.id);
    expect(trace.conversation.messages[0].parts[0].text).toContain('observed harness failure');
    expect(trace.runs).toHaveLength(1);
    expect(
      trace.operations.some((op: any) =>
        op.output?.error?.message.includes('observed harness failure'),
      ),
    ).toBe(true);
    expect(trace.files[0].content).toBe('second revision');
    expect(trace.revisions).toHaveLength(2);
    expect(trace.artifacts.find((item: any) => item.id === 'text').text).toContain('[REDACTED]');
    expect(trace.artifacts.find((item: any) => item.id === 'image').contentOmitted).toBeTruthy();
    expect(trace.configurationAtExport.model).toBe('test-model');
    for (const secret of [
      'MODEL_SECRET_123',
      'HEADER_SECRET',
      'COOKIE_SECRET',
      'QUERY_SECRET',
      'EMBEDDED_SECRET',
      'ARTIFACT_SECRET',
      'IMAGE_DATA',
      'OTHER_WORKSPACE_PRIVATE_DATA',
    ]) {
      expect(json).not.toContain(secret);
    }
    expect((await rpc(frame, 'settings.get')).apiKey).toBe('MODEL_SECRET_123');
    expect((await rpc(frame, 'files.read', original.path)).content).toBe('second revision');
  } finally {
    await context.close();
  }
});
