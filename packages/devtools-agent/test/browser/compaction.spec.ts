import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { instrumentPanel, rpc } from './helpers';

test('auto-compaction preserves state and steering, resumes, cancels, and rejects truncated summaries', async () => {
  const normal: any[] = [],
    summaries: any[] = [];
  const effects = new Map<string, number>();
  let origin = '',
    mode = 'work',
    steps = 0,
    release!: () => void,
    summaryAborted = false;
  const server = createServer(async (request, response) => {
    if (request.url?.startsWith('/effect')) {
      const label = new URL(request.url, 'http://localhost').searchParams.get('label')!;
      effects.set(label, (effects.get(label) ?? 0) + 1);
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Content-Type', 'text/html');
      response.end('<title>Compaction fixture</title>');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (!payload.stream) {
      summaries.push(payload);
      if (mode === 'cancel') {
        response.on('close', () => {
          summaryAborted = true;
        });
        return;
      }
      if (summaries.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          id: 'summary',
          object: 'chat.completion',
          created: 1,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content:
                  mode === 'truncated'
                    ? 'PARTIAL_HANDOFF_MUST_NOT_BE_USED'
                    : 'HANDOFF_CHECKPOINT: Keep the footer and sidebar. Completed operations already took effect. Continue from retained tool state without replaying mutations. Preserve /workspace/ and /artifacts/ references.',
              },
              finish_reason: mode === 'truncated' ? 'length' : 'stop',
            },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050 },
        }),
      );
      return;
    }
    normal.push(payload);
    steps++;
    let delta: object;
    if (mode !== 'resume' && steps <= 8)
      delta = {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `${mode}-call-${steps}`,
            type: 'function',
            function: {
              name: 'repl',
              arguments: JSON.stringify({
                description: `Work step ${steps}`,
                code: `/* OLD_DETAIL_${mode}_${steps} ${'x'.repeat(8000)} */ await http.request(${JSON.stringify(origin + `/effect?label=${mode}-${steps}`)}); state.count=(state.count||0)+1; return state.count;`,
              }),
            },
          },
        ],
      };
    else
      delta = {
        role: 'assistant',
        content: mode === 'resume' ? 'Resumed from checkpoint.' : 'Compaction task completed.',
      };
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta: object, finish: string | null) => ({
      id: `call-${normal.length}`,
      object: 'chat.completion.chunk',
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(finish
        ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }
        : {}),
    });
    response.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
    response.end(
      `data: ${JSON.stringify(chunk({}, 'tool_calls' in delta ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`,
    );
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
    await context.pages()[0].goto(origin);
    const tabId = (await worker.evaluate(() => chrome.tabs.query({}))).find(
      (t) => t.url === origin + '/',
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
      theme: 'light',
    });
    await panel.getByRole('button', { name: 'Model settings', exact: true }).click();
    await expect(panel.getByLabel('Auto-compact threshold (tokens)', { exact: false })).toHaveValue(
      '64000',
    );
    await panel.getByLabel('Auto-compact threshold (tokens)', { exact: false }).fill('12000');
    await panel.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect
      .poll(async () => (await rpc(frame, 'settings.get')).autoCompactTokenLimit)
      .toBe(12000);
    await panel
      .getByRole('textbox', { name: 'Message Agent' })
      .fill('Keep the footer and complete all eight operations.');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => summaries.length).toBe(1);
    await expect(panel.getByText('Compacting context…', { exact: true })).toBeVisible();
    const nextRequest = normal.length;
    await rpc(frame, 'chat.queue', 'Also preserve the existing sidebar.');
    release();
    await expect(panel.getByText('Compaction task completed.', { exact: true })).toBeVisible();
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.status).toBe('completed');
    expect(
      normal[nextRequest].messages.filter(
        (m: any) => m.role === 'user' && m.content === 'Also preserve the existing sidebar.',
      ),
    ).toHaveLength(1);
    expect(summaries[0].tools).toBeUndefined();
    expect(summaries[0].messages[0].content).toContain('constraints and preferences');
    expect(JSON.stringify(summaries[0].messages)).toContain('OLD_DETAIL_work_1');
    expect(JSON.stringify(normal[nextRequest].messages)).toContain('HANDOFF_CHECKPOINT');
    expect(JSON.stringify(normal[nextRequest].messages)).not.toContain('OLD_DETAIL_work_1');
    expect((await rpc(frame, 'repl.run', 'return state.count;')).value).toBe(8);
    expect([...effects.values()]).toEqual(Array(8).fill(1));
    const snapshot = await rpc(frame, 'snapshot');
    expect(snapshot.session.context).toMatchObject({
      summary: expect.stringContaining('HANDOFF_CHECKPOINT'),
      coveredMessages: expect.any(Number),
    });
    expect(JSON.stringify(snapshot.messages)).toContain('OLD_DETAIL_work_1');
    const summaryCount = summaries.length;
    expect(summaryCount).toBeGreaterThan(1);
    for (const payload of summaries.slice(1)) {
      const transcript = JSON.parse(
        payload.messages.find((message: any) => message.role === 'user').content,
      );
      expect(transcript.previousSummary).toContain('HANDOFF_CHECKPOINT');
      expect(JSON.stringify(transcript.messages)).not.toContain('OLD_DETAIL_work_1');
    }
    // Turning automatic compaction off still reuses the saved checkpoint.
    const settings = await rpc(frame, 'settings.get');
    await rpc(frame, 'settings.save', { ...settings, autoCompactTokenLimit: 0 });
    await page.reload();
    await panel.getByRole('button', { name: 'Model settings', exact: true }).waitFor();
    frame = page.frames().find((frame) => frame.url().endsWith('/agent/panel.html'))!;
    mode = 'resume';
    await panel
      .getByRole('textbox', { name: 'Message Agent' })
      .fill('Continue using the saved summary.');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByText('Resumed from checkpoint.', { exact: true })).toBeVisible();
    expect(summaries).toHaveLength(summaryCount);
    expect(JSON.stringify(normal.at(-1).messages)).toContain('HANDOFF_CHECKPOINT');
    expect(JSON.stringify(normal.at(-1).messages)).not.toContain('OLD_DETAIL_work_1');
    expect(normal.at(-1).messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'Continue using the saved summary.',
    });
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.status).toBe('completed');
    await rpc(frame, 'chat.clear');
    await expect(panel.getByRole('heading', { name: 'How can I help?' })).toBeVisible();
    expect((await rpc(frame, 'snapshot')).session.context).toBeUndefined();
    await rpc(frame, 'settings.save', { ...settings, autoCompactTokenLimit: 12000 });
    mode = 'cancel';
    steps = 0;
    await panel.getByRole('textbox', { name: 'Message Agent' }).fill('Start another task.');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(() => summaries.length).toBe(summaryCount + 1);
    const requestsAtStop = normal.length;
    await rpc(frame, 'stop');
    await expect.poll(() => summaryAborted).toBe(true);
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.status).toBe('interrupted');
    expect((await rpc(frame, 'snapshot')).session.context).toBeUndefined();
    expect(normal).toHaveLength(requestsAtStop);
    await rpc(frame, 'chat.clear');
    await expect(panel.getByRole('heading', { name: 'How can I help?' })).toBeVisible();
    mode = 'truncated';
    steps = 0;
    const summariesBeforeTruncation = summaries.length;
    await panel
      .getByRole('textbox', { name: 'Message Agent' })
      .fill('Finish despite a cut-off summary.');
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await rpc(frame, 'snapshot')).run.status).toBe('completed');
    const preserved = await rpc(frame, 'snapshot');
    expect(preserved.session.context).toBeUndefined();
    expect(preserved.run.compaction).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('length'),
    });
    expect(summaries).toHaveLength(summariesBeforeTruncation + 1);
    expect(JSON.stringify(normal.at(-1).messages)).toContain('OLD_DETAIL_truncated_1');
    expect(JSON.stringify(normal.at(-1).messages)).not.toContain(
      'PARTIAL_HANDOFF_MUST_NOT_BE_USED',
    );
  } finally {
    release?.();
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
