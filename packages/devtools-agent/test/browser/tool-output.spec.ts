import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { instrumentPanel, rpc } from './helpers';

test('Agent receives a bounded artifact preview, reads the omitted middle, and opens/downloads the full saved result', async () => {
  const value = {
    head: 'HEAD_MARKER',
    body: 'x'.repeat(40000) + 'MIDDLE_NEEDLE' + 'y'.repeat(40000),
    tail: 'TAIL_MARKER',
  };
  const full = JSON.stringify(value);
  const requests: any[] = [];
  let dataRequests = 0,
    origin = '',
    artifactPath = '';
  const server = createServer(async (request, response) => {
    if (request.url === '/data') {
      dataRequests++;
      response.setHeader('Content-Type', 'application/json');
      response.end(full);
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Output test</title>');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    const step = requests.length;
    const tool = (name: string, args: object) => ({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `step-${step}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    });
    let delta: object;
    if (step === 1)
      delta = tool('repl', {
        description: 'Capture large result',
        code: `state.once=(state.once||0)+1;state.response=await http.request(${JSON.stringify(origin + '/data')});state.full=JSON.parse(state.response.body);return state.full;`,
      });
    else if (step === 2) {
      const output = payload.messages.find((m: any) => m.tool_call_id === 'step-1');
      artifactPath =
        JSON.parse(output?.content ?? '{}').value?.artifact?.path ?? '/artifacts/missing';
      delta = tool('Grep', {
        path: artifactPath,
        pattern: 'MIDDLE_NEEDLE',
        output_mode: 'content',
        char_context: 30,
      });
    } else if (step === 3)
      delta = tool('repl', {
        description: 'Check full state',
        code: `const part=await fs.read(${JSON.stringify(artifactPath)},{offset:${full.indexOf('MIDDLE_NEEDLE')},limit:13});return {once:state.once,length:state.full.body.length,middle:part.content};`,
      });
    else delta = { role: 'assistant', content: 'Full result saved and recovered.' };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null) => ({
      id: `call-${step}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    response.write(
      `data: ${JSON.stringify(chunk({}, 'tool_calls' in delta ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`,
    );
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const extension = new URL('../../fixtures/extension/', import.meta.url).pathname;
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    executablePath: process.env.AGENT_TEST_CHROMIUM,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await instrumentPanel(context);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const target = context.pages()[0];
    await target.goto(origin);
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (tab) => tab.url === origin + '/',
    )!.id;
    const page = await context.newPage();
    await page.goto(worker.url().replace('fixture.js', `devtools.html?tabId=${tabId}`));
    const panel = page.frameLocator('iframe');
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    let frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    await rpc(frame, 'settings.save', {
      provider: 'openai-compatible',
      baseURL: origin + '/v1',
      model: 'test-model',
      apiKey: 'test-key',
      supportsImages: false,
      theme: 'system',
    });
    await panel
      .getByRole('textbox', { name: 'Message Agent' })
      .fill('Capture and inspect the large response');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(
      panel.getByText('Full result saved and recovered.', { exact: true }),
    ).toBeVisible();
    const firstText = requests[1].messages.find((m: any) => m.tool_call_id === 'step-1').content;
    const first = JSON.parse(firstText);
    expect(first).toMatchObject({
      success: true,
      truncated: true,
      value: {
        artifact: {
          path: expect.stringMatching(/^\/artifacts\//),
          mimeType: 'application/json',
          size: Buffer.byteLength(full),
        },
        notice: expect.stringContaining('Read/Grep'),
      },
    });
    expect(Buffer.byteLength(firstText)).toBeLessThan(8 * 1024);
    expect(Buffer.byteLength(first.value.preview)).toBeLessThanOrEqual(2 * 1024);
    expect(first.value.preview).toContain('HEAD_MARKER');
    expect(first.value.preview).toContain('TAIL_MARKER');
    expect(first.value.preview).not.toContain('MIDDLE_NEEDLE');
    const grep = JSON.parse(
      requests[2].messages.find((m: any) => m.tool_call_id === 'step-2').content,
    );
    expect(grep).toMatchObject({
      success: true,
      value: {
        total_matches: 1,
        results: [
          { offset: full.indexOf('MIDDLE_NEEDLE'), text: expect.stringContaining('MIDDLE_NEEDLE') },
        ],
      },
    });
    const check = JSON.parse(
      requests[3].messages.find((m: any) => m.tool_call_id === 'step-3').content,
    );
    expect(check).toMatchObject({
      success: true,
      value: { once: 1, length: value.body.length, middle: 'MIDDLE_NEEDLE' },
    });
    expect(dataRequests).toBe(1);
    await panel.getByRole('button', { name: 'Capture large result', exact: true }).click();
    await panel.getByRole('button', { name: artifactPath, exact: true }).click();
    await expect(panel.getByText('Read-only result', { exact: true })).toBeVisible();
    await expect(
      panel.getByText(`Characters 1–32000 of ${full.length}`, { exact: true }),
    ).toBeVisible();
    await panel.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(
      panel.getByText(`Characters 32001–64000 of ${full.length}`, { exact: true }),
    ).toBeVisible();
    const downloadPromise = page.waitForEvent('download', { timeout: 5000 });
    await panel.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;
    expect(await readFile((await download.path())!, 'utf8')).toBe(full);
    await page.reload();
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    expect(
      await rpc(frame, 'files.read', artifactPath, {
        offset: full.indexOf('MIDDLE_NEEDLE'),
        limit: 13,
      }),
    ).toMatchObject({ content: 'MIDDLE_NEEDLE', totalLength: full.length });
    expect((await rpc(frame, 'snapshot')).files).toEqual([]);
    expect(dataRequests).toBe(1);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
