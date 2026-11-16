import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { instrumentPanel, rpc, routeExampleSite } from './helpers';

test('queued user input reaches the next model step once and stop aborts a streaming model request', async () => {
  let calls = 0;
  let modelAborted = false;
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    calls++;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null) => ({
      id: 'call-' + calls,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    if (calls === 3) {
      response.write(
        `data: ${JSON.stringify(chunk({ role: 'assistant', content: '正在等待模型输出' }, null))}\n\n`,
      );
      response.on('close', () => {
        modelAborted = true;
      });
      return;
    }
    const delta =
      calls === 1
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'wait',
                type: 'function',
                function: {
                  name: 'repl',
                  arguments: JSON.stringify({
                    code: 'const waiting=browser.waitForEvent("Runtime.consoleAPICalled",{timeoutMs:10000}); await fs.write("/workspace/waiting.txt","ready"); return await waiting;',
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: '已按补充要求完成。' };
    response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(chunk({}, calls === 1 ? 'tool_calls' : 'stop'))}\n\n`);
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
    await routeExampleSite(context);
    await instrumentPanel(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const target = context.pages()[0];
    await target.goto('https://example.com');
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/',
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    let frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    await rpc(frame, 'settings.save', {
      provider: 'openai-compatible',
      baseURL: `http://127.0.0.1:${port}/v1`,
      model: 'test-model',
      apiKey: 'secret-key',
      supportsImages: false,
      theme: 'light',
    });
    const input = panel.getByRole('textbox', { name: 'Message Agent' });
    await input.fill('先等待网页事件，再完成任务');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect
      .poll(async () => {
        const value = await rpc(frame, 'snapshot');
        return (
          value.connected && value.files.some((file: any) => file.path === '/workspace/waiting.txt')
        );
      })
      .toBe(true);
    await input.fill('请补充一个清晰的验证结果');
    await panel.getByRole('button', { name: 'Queue message', exact: true }).click();
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.queued.length).toBe(1);
    await target.evaluate(() => console.log('release agent step'));
    await expect(panel.getByText('Completed', { exact: true })).toBeVisible();
    expect(
      requests[1].messages.filter(
        (message: any) => message.role === 'user' && message.content === '请补充一个清晰的验证结果',
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(requests)).not.toContain('secret-key');
    await page.reload();
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const restored = await rpc(frame, 'snapshot');
    expect(
      restored.messages.filter(
        (message: any) =>
          message.role === 'user' &&
          message.parts.some((part: any) => part.text === '请补充一个清晰的验证结果'),
      ),
    ).toHaveLength(1);
    await input.fill('开始第二轮长请求');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByText('正在等待模型输出', { exact: true })).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Stop current run (Ctrl/⌘ .)', exact: true }),
    ).toBeVisible();
    await input.press('Control+.');
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.status).toBe('interrupted');
    await expect.poll(() => modelAborted).toBe(true);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
