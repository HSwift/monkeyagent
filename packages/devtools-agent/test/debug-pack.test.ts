// @vitest-environment node
import 'fake-indexeddb/auto';
import { inflateRawSync, crc32 as zlibCrc32 } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { openAgentDB, type AgentDB } from '../src/workspace/database';
import { WorkspaceService } from '../src/workspace/service';
import { SessionService } from '../src/workspace/session';
import { createZip, crc32 } from '../src/debug/zip';
import { createRedactor, REDACTED } from '../src/debug/redact';
import { prepareToolOutput } from '../src/agent/output';
import { buildDebugPack } from '../src/debug/export';
import type { ModelSettings, OperationRecord } from '../src/protocol/types';

/** Independent reader: walks the central directory and inflates entries with node:zlib. */
function readZip(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const end = zip.byteLength - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(pointer, true)).toBe(0x02014b50);
    const method = view.getUint16(pointer + 10, true);
    const crc = view.getUint32(pointer + 16, true);
    const compressed = view.getUint32(pointer + 20, true);
    const size = view.getUint32(pointer + 24, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const offset = view.getUint32(pointer + 42, true);
    const name = decoder.decode(zip.subarray(pointer + 46, pointer + 46 + nameLength));
    expect(view.getUint32(offset, true)).toBe(0x04034b50);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;
    const body = zip.subarray(start, start + compressed);
    const data = method === 8 ? new Uint8Array(inflateRawSync(body)) : body;
    expect(data.length).toBe(size);
    expect(zlibCrc32(data) >>> 0).toBe(crc);
    entries.set(name, data);
    pointer += 46 + nameLength;
  }
  return entries;
}
const text = (data?: Uint8Array) => new TextDecoder().decode(data);

describe('zip writer', () => {
  it('computes standard CRC32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });
  it('round-trips text, unicode names, empty and binary entries', async () => {
    const binary = new Uint8Array(1000).map((_, i) => (i * 37) % 256);
    const zip = await createZip([
      { name: 'a.txt', data: 'hello '.repeat(200) },
      { name: 'dir/日本語.md', data: '# 你好' },
      { name: 'empty', data: '' },
      { name: 'bin', data: binary },
    ]);
    const entries = readZip(zip);
    expect([...entries.keys()]).toEqual(['a.txt', 'dir/日本語.md', 'empty', 'bin']);
    expect(text(entries.get('a.txt'))).toBe('hello '.repeat(200));
    expect(text(entries.get('dir/日本語.md'))).toBe('# 你好');
    expect(entries.get('empty')?.length).toBe(0);
    expect([...entries.get('bin')!]).toEqual([...binary]);
  });
  it('rejects duplicate names', async () => {
    await expect(
      createZip([
        { name: 'x', data: '1' },
        { name: '/x', data: '2' },
      ]),
    ).rejects.toThrow(/duplicate/);
  });
});

describe('redactor', () => {
  it('removes known and discovered secrets from structure, text, JSON strings and URLs', () => {
    const redact = createRedactor(
      ['sk-live-12345'],
      [{ headers: { Authorization: 'Bearer abcdef' }, nested: '{"password":"hunter22"}' }],
    );
    const result = redact.value({
      apiKey: 'sk-live-12345',
      code: 'fetch(u, { headers: { key: "sk-live-12345" } }); login("hunter22")',
      log: 'Authorization: Bearer xyz.123',
      url: 'https://user:pw@example.com/api?token=t0k3n&page=2',
      json: '{"access_token":"zzzz","ok":true}',
      count: 3,
    });
    const serialized = JSON.stringify(result);
    for (const secret of ['sk-live-12345', 'hunter22', 'xyz.123', 't0k3n', 'zzzz', 'pw@'])
      expect(serialized).not.toContain(secret);
    expect(result.apiKey).toBe(REDACTED);
    expect(result.url).toContain('page=2');
    expect(result.count).toBe(3);
    expect(redact.text('key sk-live-12345 end')).toBe(`key ${REDACTED} end`);
  });
});

describe('buildDebugPack', () => {
  const databases: AgentDB[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('exports only the current session with agent context, workspace, REPL history and events', async () => {
    const db = await openAgentDB(crypto.randomUUID());
    databases.push(db);
    const workspace = await WorkspaceService.create(db, 'https://www.example.com/page');
    const session = await SessionService.create(db, workspace.id, 'https://www.example.com/page');
    const other = await SessionService.create(db, workspace.id, 'https://www.example.com/other');
    await workspace.write('/workspace/main.user.js', '// ==UserScript==\nconsole.log(1);');
    const apiKey = 'sk-secret-key-123';
    const operation = (id: string, sessionId: string, runId?: string): OperationRecord => ({
      id,
      workspaceId: workspace.id,
      sessionId,
      runId,
      name: 'repl',
      input: { code: `return "${id}" + "${apiKey}";` },
      status: 'completed',
      startedAt: Date.now(),
      endedAt: Date.now() + 5,
      output: { success: true, value: id, durationMs: 5 },
    });
    await db.put('operations', operation('manual-op', session.id));
    await db.put('operations', operation('agent-op', session.id, 'run-1'));
    await db.put('operations', operation('other-op', other.id));
    workspace.sessionId = session.id;
    const largeValue = { body: 'x'.repeat(20000), tail: 'EXPORTED_COMPLETE_TAIL' };
    const savedOutput = await prepareToolOutput(workspace, 'repl', largeValue);
    const agentOperation = operation('agent-op', session.id, 'run-1');
    agentOperation.output = { success: true, ...savedOutput, durationMs: 5 };
    await db.put('operations', agentOperation);
    await db.put('runs', {
      id: 'run-1',
      workspaceId: workspace.id,
      sessionId: session.id,
      status: 'completed',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      queued: [],
      model: {
        provider: 'openai-compatible',
        baseURL: 'https://api',
        model: 'm1',
        supportsImages: false,
      },
      steps: [
        {
          index: 1,
          endedAt: Date.now(),
          finishReason: 'stop',
          inputTokens: 10,
          outputTokens: 2,
          toolCalls: [],
        },
      ],
    });
    const settings: ModelSettings = {
      provider: 'openai-compatible',
      baseURL: 'https://api.example.com/v1',
      model: 'm1',
      apiKey,
      supportsImages: false,
      theme: 'system',
    };
    const pack = await buildDebugPack({
      db,
      workspaceId: workspace.id,
      sessionId: session.id,
      messages: [
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Hide the banner' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
      ],
      modelMessages: [{ role: 'user', content: 'Hide the banner' }],
      instructions: 'You are Monkey Agent.',
      tools: { repl: { description: 'Run JS', inputSchema: z.object({ code: z.string() }) } },
      activeTools: ['repl'],
      docs: { '/docs/agent-guide.md': '# Guide' },
      settings,
      browser: {
        tabId: 7,
        targetUrl: 'https://www.example.com/page',
        connected: true,
        events: [{ seq: 1, method: 'Runtime.consoleAPICalled', params: { args: [] }, at: 1 }],
      },
      runtime: { extension: 'Monkey', version: '0.1.0', userAgent: 'test' },
      now: new Date('2026-11-18T08:00:00Z'),
    });

    expect(pack.filename).toBe('monkeyagent-debug-example.com-2026-11-18T08-00-00-000.zip');
    const entries = readZip(pack.data);
    for (const name of [
      'manifest.json',
      'settings.json',
      'agent/instructions.md',
      'agent/tools.json',
      'agent/docs/agent-guide.md',
      'session/session.json',
      'session/messages.json',
      'session/model-messages.json',
      'session/runs.json',
      'session/operations.json',
      'session/repl-history.json',
      'session/transcript.md',
      'workspace/workspace.json',
      'workspace/revisions.json',
      'workspace/files/workspace/main.user.js',
      'browser/target.json',
      'browser/events.json',
    ])
      expect(entries.has(name), name).toBe(true);

    const manifest = JSON.parse(text(entries.get('manifest.json')));
    expect(manifest).toMatchObject({
      format: 'monkeyagent-debug-pack',
      scope: { type: 'session', sessionId: session.id },
      counts: { replRuns: 2, operations: 2, files: 1, browserEvents: 1 },
    });
    const history = JSON.parse(text(entries.get('session/repl-history.json')));
    expect(
      history.map((entry: { id: string; source: string }) => [entry.id, entry.source]),
    ).toEqual(
      expect.arrayContaining([
        ['manual-op', 'manual'],
        ['agent-op', 'agent'],
      ]),
    );
    expect(history).toHaveLength(2);
    const tools = JSON.parse(text(entries.get('agent/tools.json')));
    expect(tools[0]).toMatchObject({ name: 'repl', active: true, inputSchema: { type: 'object' } });
    expect(text(entries.get('workspace/files/workspace/main.user.js'))).toContain('console.log(1)');
    expect(text(entries.get('session/transcript.md'))).toContain('Hide the banner');
    expect(JSON.parse(text(entries.get('settings.json')))).toMatchObject({
      model: 'm1',
      apiKeyConfigured: true,
    });

    const everything = [...entries.values()].map(text).join('\n');
    const exportedArtifacts = JSON.parse(text(entries.get('workspace/artifacts.json')));
    const savedArtifact = exportedArtifacts.find(
      (artifact: any) => artifact.id === savedOutput.artifacts?.at(-1)?.id,
    );
    expect(savedArtifact.path).toMatch(/^\/artifacts\//);
    expect(JSON.parse(text(entries.get(`workspace/${savedArtifact.file}`)))).toEqual(largeValue);
    expect(everything).not.toContain(apiKey);
    expect(everything).not.toContain('other-op');
  });
});
