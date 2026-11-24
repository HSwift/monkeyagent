import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { instrumentPanel, rpc } from './helpers';

test('familiar tools recover from validation errors, run browser JS and persist unique IDs and terminal diagnostics', async () => {
  const requests: any[] = [];
  const file_path = '/workspace/main.user.js';
  const output_file = '/workspace/scratch/browser-check.json';
  const source =
    '// ==UserScript==\n// @name Harness replay\n// @match http://127.0.0.1/*\n// ==/UserScript==\nconst value = "before";';
  let targetUrl = '';
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        '<!doctype html><title>Harness target</title><main><div class="target">target</div><h1>Preserved sibling</h1></main>',
      );
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const call = requests.length;
    if (call === 9) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'simulated terminal provider failure' } }));
      return;
    }
    const tool = (name: string, args: object) => ({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `tool-${call}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    let delta: object;
    if (call === 1) delta = tool('Write', { file_path: '/scripts/main.user.js', content: source });
    else if (call === 2)
      delta = tool('Write', { content: source + '\n' + 'LARGE_ERROR_INPUT'.repeat(500) });
    else if (call === 3) delta = tool('Write', { file_path, content: source });
    else if (call === 4)
      delta = tool('Edit', { file_path, old_string: '"before"', new_string: '"after"' });
    else if (call === 5)
      delta = tool('repl', {
        description: '安装并检查原生导航和状态',
        timeout: 30000,
        output_file,
        code: `state.outputCalls = (state.outputCalls || 0) + 1; await sleep(5); await scripts.apply(${JSON.stringify(file_path)}); await browser.navigate(${JSON.stringify(targetUrl + '?check')}); return {page:await browser.evaluate('({title:document.title,sibling:!!document.querySelector("h1")})'),status:await scripts.status(${JSON.stringify(file_path)}),payload:"FILE_ONLY_PAYLOAD".repeat(12000)+"_TAIL_TARGET"};`,
      });
    else if (call === 7)
      delta = {
        role: 'assistant',
        tool_calls: [
          { name: 'Read', args: { file_path } },
          { name: 'Glob', args: { pattern: '**/*.user.js' } },
          { name: 'Grep', args: { pattern: 'value.*after', output_mode: 'content' } },
          {
            name: 'Grep',
            args: {
              pattern: 'TAIL_TARGET',
              path: output_file,
              output_mode: 'content',
              char_context: 20,
            },
          },
        ].map(({ name, args }, index) => ({
          index,
          id: `read-${index}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        })),
      };
    else
      delta = {
        role: 'assistant',
        content: call === 6 ? '接口检查完成；未验证脚本注入。' : '第二轮完成。',
      };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (content: object, finish: string | null) => ({
      id: `call-${call}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta: content, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
    });
    response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    response.write(
      `data: ${JSON.stringify(chunk({}, 'tool_calls' in delta ? 'tool_calls' : 'stop'))}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  targetUrl = `http://127.0.0.1:${port}/`;
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await instrumentPanel(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await context.pages()[0].goto(targetUrl);
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === targetUrl,
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    let frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    await rpc(frame, 'settings.save', {
      provider: 'openai-compatible',
      baseURL: targetUrl + 'v1',
      model: 'test-model',
      apiKey: 'test-key-not-in-run',
      supportsImages: false,
      theme: 'light',
    });
    const input = panel.getByRole('textbox', { name: 'Message Agent' });
    await input.fill('重放文件工具错误并检查浏览器接口');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByText('接口检查完成；未验证脚本注入。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.status).toBe('completed');
    const names = requests[0].tools.map((item: any) => item.function.name);
    expect(names).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'repl']);
    const schema = requests[0].tools.find((item: any) => item.function.name === 'Edit').function
      .parameters;
    expect(Object.keys(schema.properties)).toEqual([
      'file_path',
      'old_string',
      'new_string',
      'replace_all',
    ]);
    const validationError = requests[2].messages.find(
      (message: any) => message.tool_call_id === 'tool-2',
    );
    expect(validationError.content).toContain('file_path');
    expect(validationError.content).not.toContain('LARGE_ERROR_INPUT');
    const modelOutput = requests[5].messages.find(
      (message: any) => message.tool_call_id === 'tool-5',
    ).content;
    const savedOutput = JSON.parse(modelOutput).value;
    expect(savedOutput).toMatchObject({ path: output_file, size: expect.any(Number) });
    expect(modelOutput).not.toContain('FILE_ONLY_PAYLOAD');
    expect(savedOutput).not.toHaveProperty('page');
    const savedContents = (await rpc(frame, 'files.read', output_file)).content;
    const lastResult = JSON.parse(savedContents);
    expect(lastResult.page).toEqual({ title: 'Harness target', sibling: true });
    expect(lastResult.status).not.toHaveProperty('installedCode');
    expect(lastResult.status.state).toBe('installed');
    expect(lastResult.payload).toBe('FILE_ONLY_PAYLOAD'.repeat(12000) + '_TAIL_TARGET');
    expect((await rpc(frame, 'repl.run', 'return state.outputCalls;')).value).toBe(1);
    const first = await rpc(frame, 'snapshot');
    expect(first.run.steps).toHaveLength(6);
    expect(first.run.steps[0]).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect(first.run.finishReason).toBe('stop');
    expect(JSON.stringify(first.run)).not.toContain('test-key-not-in-run');
    expect(first.error).toBeUndefined();
    await input.fill('继续第二轮');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByText('第二轮完成。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.status).toBe('completed');
    await page.reload();
    const readResult = (id: string) =>
      JSON.parse(requests[7].messages.find((message: any) => message.tool_call_id === id).content)
        .value;
    expect(readResult('read-0').content).toContain('1→// ==UserScript==');
    expect(readResult('read-1').files).toContain(file_path);
    expect(readResult('read-2').results[0].text).toContain('"after"');
    expect(readResult('read-3')).toMatchObject({
      output_mode_detail: 'char_window',
      total_matches: 1,
    });
    expect(readResult('read-3').results[0]).toMatchObject({
      offset: savedContents.indexOf('TAIL_TARGET'),
      match_length: 11,
    });
    expect(readResult('read-3').results[0].offset).toBeGreaterThan(128 * 1024);
    expect(readResult('read-3').results[0].text).toContain('TAIL_TARGET');
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    const assistants = (await rpc(frame, 'snapshot')).messages.filter(
      (message: any) => message.role === 'assistant',
    );
    expect(assistants).toHaveLength(2);
    expect(assistants.every((message: any) => message.id)).toBe(true);
    expect(new Set(assistants.map((message: any) => message.id)).size).toBe(2);
    await input.fill('检查真正的模型连接失败');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.status).toBe('failed');
    expect((await rpc(frame, 'snapshot')).run.error).toContain(
      'simulated terminal provider failure',
    );
    await page.reload();
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    expect((await rpc(frame, 'snapshot')).run.error).toContain(
      'simulated terminal provider failure',
    );
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
