import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { openAgentDB, type AgentDB } from '../src/workspace/database';
import { WorkspaceService } from '../src/workspace/service';
import { FileTools } from '../src/agent/file-tools';
import { normalizeMessageIds } from '../src/agent/messages';
import type { UIMessage } from 'ai';

const databases: AgentDB[] = [];
async function setup() {
  const db = await openAgentDB(crypto.randomUUID());
  databases.push(db);
  const workspace = await WorkspaceService.create(db, 'https://example.com');
  return { workspace, tools: new FileTools(workspace) };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

it('uses line-based Read and exact Edit with automatic revision tracking and literal replacements', async () => {
  const { tools, workspace } = await setup();
  const file_path = '/workspace/main.js';
  const written = await tools.write({ file_path, content: 'one\nfoo foo\nthree' });
  expect(written).not.toHaveProperty('content');
  expect(await tools.read({ file_path, offset: 2, limit: 1 })).toMatchObject({
    content: '     2→foo foo',
    next_offset: 3,
    total_lines: 3,
  });
  await expect(
    tools.edit({ file_path, old_string: 'foo', new_string: 'bar' }),
  ).rejects.toMatchObject({ code: 'ambiguous_edit' });
  expect(
    await tools.edit({ file_path, old_string: 'foo', new_string: '$&', replace_all: true }),
  ).toMatchObject({ replacements: 2 });
  expect((await workspace.read(file_path)).content).toBe('one\n$& $&\nthree');
  await expect(
    tools.edit({ file_path, old_string: 'missing', new_string: 'x' }),
  ).rejects.toMatchObject({ code: 'old_string_not_found' });
  tools.reset();
  await expect(tools.write({ file_path, content: 'lost source' })).rejects.toMatchObject({
    code: 'file_not_read',
  });
});

it('refuses stale writes and admits only one concurrent editor without model-supplied revision parameters', async () => {
  const { tools, workspace } = await setup();
  const file_path = '/workspace/concurrent.js';
  await tools.write({ file_path, content: 'original' });
  const other = new FileTools(workspace);
  await other.read({ file_path });
  const edits = await Promise.allSettled([
    tools.edit({ file_path, old_string: 'original', new_string: 'one' }),
    other.edit({ file_path, old_string: 'original', new_string: 'two' }),
  ]);
  expect(edits.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(edits.filter((result) => result.status === 'rejected')[0]).toMatchObject({
    reason: { code: 'conflict' },
  });
  await expect(other.write({ file_path: '/scripts/bad.js', content: 'x' })).rejects.toMatchObject({
    code: 'invalid_path',
  });
});

it('scopes glob and regex search, supports contexts/counts/multiline, and distinguishes empty pagination from no match', async () => {
  const { tools } = await setup();
  await tools.write({
    file_path: '/workspace/sub/a.js',
    content: 'before\nconst foo = 1;\nconst FOO = 2;\nafter',
  });
  await tools.write({ file_path: '/workspace/sub/b.md', content: 'foo' });
  await tools.write({ file_path: '/workspace/sub-other.js', content: 'foo' });
  expect((await tools.glob({ pattern: '**/*.{js,ts}', path: '/workspace/sub' })).files).toEqual([
    '/workspace/sub/a.js',
  ]);
  const matches = await tools.grep({
    pattern: 'foo = \\d',
    path: '/workspace/sub',
    type: 'js',
    '-i': true,
    output_mode: 'content',
    '-C': 1,
  });
  expect(matches.total_matches).toBe(2);
  expect(matches.results.map((row) => row.line)).toEqual([1, 2, 3, 4]);
  expect(
    (await tools.grep({ pattern: 'foo', path: '/workspace/sub', '-i': true, output_mode: 'count' }))
      .total_matches,
  ).toBe(3);
  expect(
    (
      await tools.grep({
        pattern: '1;\nconst FOO',
        path: '/workspace/sub/a.js',
        multiline: true,
        output_mode: 'content',
      })
    ).results,
  ).toHaveLength(2);
  expect((await tools.grep({ pattern: 'foo', offset: 100 })).message).toContain(
    'No entries at this offset',
  );
  await expect(tools.grep({ pattern: '(?=foo)' })).rejects.toMatchObject({
    code: 'invalid_pattern',
  });
});

it('repairs empty/duplicate legacy message IDs while preserving valid IDs and their contents', () => {
  const messages = [
    { id: 'user', role: 'user', parts: [] },
    { id: '', role: 'assistant', parts: [] },
    { id: '', role: 'assistant', parts: [] },
    { id: 'user', role: 'user', parts: [] },
  ] as UIMessage[];
  const normalized = normalizeMessageIds(messages);
  expect(normalized[0]).toBe(messages[0]);
  expect(new Set(normalized.map((message) => message.id)).size).toBe(4);
  expect(normalized.every((message) => !!message.id)).toBe(true);
  expect(normalized.map((message) => message.parts)).toEqual(
    messages.map((message) => message.parts),
  );
});
