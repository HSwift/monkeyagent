import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { instrumentPanel, rpc, routeExampleSite } from './helpers';

test('clearing context persists, preserves the workspace and excludes old messages from future model requests', async () => {
  const requests: any[] = [];
  let modelAborted = false;
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const call = requests.length;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null) => ({
      id: `context-${call}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const text = call === 1 ? '旧上下文的回复' : call === 2 ? '模型仍在输出' : '全新上下文的回复';
    response.write(
      `data: ${JSON.stringify(chunk({ role: 'assistant', content: text }, null))}\n\n`,
    );
    if (call === 2) {
      response.on('close', () => {
        modelAborted = true;
      });
      return;
    }
    response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
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
    let frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const settings = {
      provider: 'openai-compatible',
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      apiKey: 'context-test-key',
      supportsImages: false,
      theme: 'light',
      autoCompactTokenLimit: 64000,
    };
    await rpc(frame, 'settings.save', settings);
    const file = await rpc(
      frame,
      'files.write',
      '/workspace/main.user.js',
      '// ==UserScript==\n// @name Preserve Context Test\n// ==/UserScript==\nconsole.log("preserve");',
    );
    await rpc(frame, 'scripts.apply', file.path);
    await rpc(frame, 'repl.run', 'state.oldContext = "must be reset";');
    const input = panel.getByRole('textbox', { name: 'Message Agent' });
    await input.fill('旧对话专用标记：old-context-token');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByText('Completed', { exact: true })).toBeVisible();
    const before = await rpc(frame, 'snapshot');
    const oldConversationId = before.session.conversationId ?? before.session.id;

    // Cancelling the dialog must preserve the conversation.
    await panel.getByRole('button', { name: 'More actions', exact: true }).click();
    await panel.getByRole('menuitem', { name: 'Clear context', exact: true }).click();
    await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel.getByText('旧上下文的回复', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'More actions', exact: true }).click();
    await panel.getByRole('menuitem', { name: 'Clear context', exact: true }).click();
    await panel.getByRole('button', { name: 'Clear', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'How can I help?' })).toBeVisible();
    const cleared = await rpc(frame, 'snapshot');
    expect(cleared.workspace.id).toBe(before.workspace.id);
    expect(cleared.session.conversationId).not.toBe(oldConversationId);
    expect(cleared.workspace.bindings).toEqual(before.workspace.bindings);
    expect(cleared.files).toEqual(before.files);
    expect(cleared.messages).toEqual([]);
    expect(cleared.run).toBeUndefined();
    expect((await rpc(frame, 'repl.run', 'return typeof state.oldContext;')).value).toBe(
      'undefined',
    );
    expect(await rpc(frame, 'settings.get')).toEqual(settings);
    await expect(
      rpc(frame, 'chat.start', 'stale-stream', before.messages, oldConversationId),
    ).rejects.toThrow('context_changed');

    await page.reload();
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const restored = await rpc(frame, 'snapshot');
    expect(restored.messages).toEqual([]);
    expect(restored.run).toBeUndefined();
    expect(restored.session.conversationId).toBe(cleared.session.conversationId);
    expect((await rpc(frame, 'files.read', file.path)).revision).toBe(file.revision);
    await input.fill('新的独立要求');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByText('模型仍在输出', { exact: true })).toBeVisible();
    expect(requests[1].messages.filter((message: any) => message.role === 'user')).toEqual([
      { role: 'user', content: '新的独立要求' },
    ]);
    expect(JSON.stringify(requests[1])).not.toContain('old-context-token');
    expect(JSON.stringify(requests[1])).not.toContain('旧上下文的回复');
    await input.fill('即将丢弃的补充要求');
    await panel.getByRole('button', { name: 'Queue message', exact: true }).click();
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.queued.length).toBe(1);
    await panel.getByRole('button', { name: 'More actions', exact: true }).click();
    await panel.getByRole('menuitem', { name: 'Clear context', exact: true }).click();
    await panel.getByRole('button', { name: 'Stop and clear', exact: true }).click();
    await expect(panel.getByRole('heading', { name: 'How can I help?' })).toBeVisible();
    await expect.poll(() => modelAborted).toBe(true);
    expect((await rpc(frame, 'snapshot')).run).toBeUndefined();
    await input.fill('清空后继续开发');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByText('全新上下文的回复', { exact: true })).toBeVisible();
    expect(requests[2].messages.filter((message: any) => message.role === 'user')).toEqual([
      { role: 'user', content: '清空后继续开发' },
    ]);
    expect(JSON.stringify(requests[2])).not.toContain('新的独立要求');
    expect(JSON.stringify(requests[2])).not.toContain('即将丢弃的补充要求');
    await page.reload();
    await expect(panel.getByText('全新上下文的回复', { exact: true })).toBeVisible();
    await expect(panel.getByText('旧上下文的回复', { exact: true })).toHaveCount(0);
    await expect(panel.getByText('模型仍在输出', { exact: true })).toHaveCount(0);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
