// @vitest-environment node
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

it('locates separate occurrences inside a 500KB minified line and reads the same windows by character range', async () => {
  const { workspace, tools } = await setup();
  const content =
    'a'.repeat(170000) + 'NEEDLE' + 'b'.repeat(170000) + 'NEEDLE' + 'c'.repeat(170000) + 'NEEDLE';
  const file = await workspace.write('/workspace/bundle.js', content);
  const result = await tools.grep({
    pattern: 'NEEDLE',
    path: file.path,
    output_mode: 'content',
    char_context: 200,
  });
  expect(result).toMatchObject({
    output_mode_detail: 'char_window',
    total_matches: 3,
    total_results: 3,
    truncated: false,
  });
  expect(result.results.map((row) => row.offset)).toEqual([170000, 340006, 510012]);
  for (const row of result.results) {
    expect(row).toMatchObject({
      revision: file.revision,
      match_length: 6,
      is_match: true,
      truncated: false,
    });
    expect(row.window_start).toBe(Math.max(0, row.offset! - 200));
    expect(row.text).toBe(content.slice(row.window_start, row.offset! + 6 + 200));
    expect(
      (await workspace.read(file.path, { offset: row.window_start, limit: row.text!.length }))
        .content,
    ).toBe(row.text);
  }
  // Searching exposes a source revision, but does not count as reading before editing.
  await expect(
    tools.edit({ file_path: file.path, old_string: 'NEEDLE', new_string: 'changed' }),
  ).rejects.toMatchObject({ code: 'file_not_read' });
});

it('keeps UTF-16 offsets, line scoping, filters and explicit multiline semantics', async () => {
  const { workspace, tools } = await setup();
  const content = '头😀alpha\nbeta😀END\nalpha';
  const file = await workspace.write('/workspace/sub/a.js', content);
  await workspace.write('/workspace/sub/b.md', 'alpha');
  await workspace.write('/workspace/sub-other.js', 'alpha');
  const result = await tools.grep({
    pattern: 'alpha|😀',
    path: '/workspace/sub',
    type: 'js',
    output_mode: 'content',
    char_context: 2,
  });
  const expected = [...content.matchAll(/alpha|😀/gu)];
  expect(result.results.map((row) => row.offset)).toEqual(expected.map((match) => match.index));
  expect(result.results.map((row) => row.match_length)).toEqual(
    expected.map((match) => match[0].length),
  );
  expect(result.results.every((row) => row.file_path === file.path)).toBe(true);
  for (const row of result.results)
    expect(row.text).toBe(content.slice(row.window_start, row.window_start! + row.text!.length));
  const input = { path: file.path, output_mode: 'content' as const, char_context: 0 };
  expect((await tools.grep({ ...input, pattern: 'alpha\nbeta' })).total_matches).toBe(0);
  expect(
    (await tools.grep({ ...input, pattern: 'alpha\nbeta', multiline: true })).results,
  ).toMatchObject([{ offset: content.indexOf('alpha'), match_length: 10, text: 'alpha\nbeta' }]);
  expect((await tools.grep({ ...input, pattern: '^beta😀END$' })).results).toMatchObject([
    { offset: content.indexOf('beta'), text: 'beta😀END' },
  ]);
});

it('paginates by output bytes without losing matches or splitting the page cursor', async () => {
  const { workspace, tools } = await setup();
  const content = ('前'.repeat(2000) + 'NEEDLE' + '后'.repeat(2000) + '\n').repeat(12);
  const file = await workspace.write('/workspace/dense.js', content);
  const input = {
    pattern: 'NEEDLE',
    path: file.path,
    output_mode: 'content' as const,
    char_context: 2000,
    head_limit: 1000,
  };
  const offsets: number[] = [];
  let offset = 0;
  for (let page = 0; page < 20; page++) {
    const result = await tools.grep({ ...input, offset });
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(16 * 1024);
    expect(result.total_matches).toBe(12);
    expect(result.results.length).toBeGreaterThan(0);
    offsets.push(...result.results.map((row) => row.offset!));
    if (!result.truncated) break;
    expect(result.truncation_reason).toBe('output_budget');
    expect(result.next_offset).toBe(offset + result.results.length);
    offset = result.next_offset!;
  }
  expect(offsets).toEqual([...content.matchAll(/NEEDLE/g)].map((match) => match.index));
  const empty = await tools.grep({ ...input, offset: 100 });
  expect(empty.results).toEqual([]);
  expect(empty.message).toContain('No entries at this offset');
  expect((await tools.grep({ ...input, pattern: 'missing' })).message).toBeUndefined();
});

it('bounds escaped or oversized windows while retaining the match and accurate source positions', async () => {
  const { workspace, tools } = await setup();
  const escaped = '\0'.repeat(2000) + 'NEEDLE' + '\0'.repeat(2000);
  const file = await workspace.write('/workspace/escaped.txt', escaped);
  const result = await tools.grep({
    pattern: 'NEEDLE',
    path: file.path,
    output_mode: 'content',
    char_context: 2000,
  });
  expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThanOrEqual(16 * 1024);
  expect(result.results[0]).toMatchObject({ offset: 2000, match_length: 6, truncated: true });
  expect(result.results[0].text).toContain('NEEDLE');
  expect(result.results[0].text).toBe(
    escaped.slice(
      result.results[0].window_start,
      result.results[0].window_start! + result.results[0].text!.length,
    ),
  );
  expect(result.truncated).toBe(false); // Per-window shortening is separate from result pagination.
  await workspace.write('/workspace/long.txt', 'x'.repeat(30000));
  const long = await tools.grep({
    pattern: 'x+',
    path: '/workspace/long.txt',
    output_mode: 'content',
    char_context: 0,
  });
  expect(long.results[0]).toMatchObject({
    offset: 0,
    window_start: 0,
    match_length: 30000,
    truncated: true,
  });
  expect(long.results[0].text).toHaveLength(4000);
});

it('advances zero-length Unicode matches and supports head-limit pagination', async () => {
  const { workspace, tools } = await setup();
  await workspace.write('/workspace/zero.txt', '😀a\n');
  const input = {
    pattern: '(?:)',
    path: '/workspace/zero.txt',
    output_mode: 'content' as const,
    char_context: 0,
    head_limit: 2,
  };
  const first = await tools.grep(input);
  expect(first.results.map((row) => row.offset)).toEqual([0, 2]);
  expect(first).toMatchObject({
    total_matches: 4,
    next_offset: 2,
    truncation_reason: 'head_limit',
  });
  const last = await tools.grep({ ...input, offset: first.next_offset });
  expect(last.results.map((row) => row.offset)).toEqual([3, 4]);
  expect(last.truncated).toBe(false);
  expect(last.results.every((row) => row.text === '' && row.match_length === 0)).toBe(true);
});

it.each([{ '-o': true }, { '-o': false }, { '-A': 0 }, { '-B': 1 }, { '-C': 0 }, { context: 0 }])(
  'rejects line-context/only-match options mixed with character windows: %j',
  async (flags) => {
    const { tools } = await setup();
    await expect(
      tools.grep({ pattern: 'x', output_mode: 'content', char_context: 20, ...flags }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  },
);

it.each(['count', 'files_with_matches', undefined] as const)(
  'requires content mode for character windows, got %s',
  async (output_mode) => {
    const { tools } = await setup();
    await expect(tools.grep({ pattern: 'x', output_mode, char_context: 20 })).rejects.toMatchObject(
      { code: 'invalid_input' },
    );
  },
);

it.each([-1, 2001, 1.5])('rejects invalid character context %s', async (char_context) => {
  const { tools } = await setup();
  await expect(
    tools.grep({ pattern: 'x', output_mode: 'content', char_context }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});

it('remains cancellable while counting dense matches beyond a filled output page', async () => {
  const { workspace, tools } = await setup();
  await workspace.write('/workspace/cancel.txt', 'a'.repeat(100000));
  const controller = new AbortController();
  const searching = tools.grep(
    {
      pattern: 'a',
      path: '/workspace/cancel.txt',
      output_mode: 'content',
      char_context: 0,
      head_limit: 1,
    },
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(), 0);
  try {
    await expect(searching).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    clearTimeout(timer);
  }
});

it('searches a full text artifact while preserving public artifact read limits', async () => {
  const { workspace, tools } = await setup();
  const content = 'prefix'.repeat(20000) + 'ARTIFACT_TAIL';
  const artifact = await workspace.artifact(
    new Blob([content], { type: 'text/plain' }),
    'large.txt',
  );
  const preview = await workspace.read(artifact.path);
  expect(preview.content).toHaveLength(32000);
  expect(preview).toMatchObject({ truncated: true, totalLength: content.length });
  const result = await tools.grep({
    pattern: 'ARTIFACT_TAIL',
    path: artifact.path,
    output_mode: 'content',
    char_context: 10,
  });
  expect(result.results).toMatchObject([
    { offset: 120000, match_length: 13, text: 'efixprefixARTIFACT_TAIL', revision: artifact.id },
  ]);
  expect((await workspace.read(artifact.path, { offset: 119990, limit: 23 })).content).toBe(
    result.results[0].text,
  );
});
