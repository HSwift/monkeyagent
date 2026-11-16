import { routeExampleSite } from './helpers';
import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';

test('AI SDK browser loop streams a multi-step tool call conversation and persists tool results', async () => {
  let calls = 0;
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    calls++;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Access-Control-Allow-Origin': '*',
    });
    const delta =
      calls === 1
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'file-create',
                type: 'function',
                function: {
                  name: 'Write',
                  arguments: JSON.stringify({
                    file_path: '/workspace/agent.user.js',
                    content: '// ==UserScript==\n// @name Agent Test\n// ==/UserScript==\n',
                  }),
                },
              },
            ],
          }
        : calls === 2
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'page-title',
                  type: 'function',
                  function: {
                    name: 'repl',
                    arguments: JSON.stringify({
                      code: 'return {title: await browser.evaluate("document.title"), screenshot: await browser.screenshot()};',
                    }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: '已创建 agent.user.js，并读取当前网页标题。' };
    const payload = (delta: object, finish: string | null) => ({
      id: 'completion-' + calls,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    response.write(`data: ${JSON.stringify(payload(delta, null))}\n\n`);
    response.write(`data: ${JSON.stringify(payload({}, calls < 3 ? 'tool_calls' : 'stop'))}\n\n`);
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
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const target = context.pages()[0];
    await target.goto('https://example.com');
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === 'https://example.com/',
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: '模型设置', exact: true }).click();
    await panel.getByLabel('API Base URL').fill(`http://127.0.0.1:${port}/v1`);
    await panel.getByLabel('模型名称').fill('test-model');
    await panel.getByLabel('模型支持图片，可查看页面截图').check();
    await panel.getByRole('button', { name: '保存设置', exact: true }).click();
    await panel
      .getByRole('textbox', { name: '发送给 Agent 的需求' })
      .fill('创建脚本并读取网页标题');
    await panel.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(panel.getByText('任务完成', { exact: true })).toBeVisible();
    await expect(
      panel.getByText('已创建 agent.user.js，并读取当前网页标题。', { exact: true }),
    ).toBeVisible();
    expect(calls).toBe(3);
    expect(
      requests[1].messages.some(
        (message: any) => message.role === 'tool' && message.content.includes('"success":true'),
      ),
    ).toBe(true);
    expect(
      requests[2].messages.some(
        (message: any) => message.role === 'tool' && message.content.includes('Example Domain'),
      ),
    ).toBe(true);
    expect(
      requests[2].messages
        .filter((message: any) => message.role === 'tool')
        .every((message: any) => !message.content.includes('base64')),
    ).toBe(true);
    expect(
      requests[2].messages.some(
        (message: any) =>
          message.role === 'user' &&
          Array.isArray(message.content) &&
          message.content.some(
            (part: any) =>
              part.type === 'image_url' && part.image_url.url.startsWith('data:image/png;base64,'),
          ),
      ),
    ).toBe(true);
    await page.reload();
    await expect(
      panel.getByText('已创建 agent.user.js，并读取当前网页标题。', { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
