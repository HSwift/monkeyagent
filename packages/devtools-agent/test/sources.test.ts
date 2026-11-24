// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { PageSources } from '../src/browser/sources';
import { WorkspaceService } from '../src/workspace/service';
import { openAgentDB } from '../src/workspace/database';
import { FileTools } from '../src/agent/file-tools';
import { SOURCE_FILE_BYTES } from '../src/workspace/source';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup(devtools = false) {
  vi.stubGlobal('chrome', { runtime: {} });
  let source = 'const needle = 42;';
  let body: (() => Promise<{ content: string; base64Encoded: boolean }>) | undefined;
  const resource = {
    url: 'https://cdn.example/bundle.js?v=1',
    type: 'Script',
    mimeType: 'text/javascript',
  };
  const tree = {
    frame: { id: 'main', url: 'https://example.com/' },
    resources: [resource],
    childFrames: [
      { frame: { id: 'child', url: 'https://example.com/frame' }, resources: [{ ...resource }] },
    ],
  };
  const command = vi.fn(async (method: string) => {
    if (method === 'Page.getResourceTree') return { frameTree: tree };
    if (method === 'Page.getResourceContent')
      return body ? body() : { content: source, base64Encoded: false };
    if (method === 'Debugger.getScriptSource') return { scriptSource: source };
    return {};
  });
  const getContent = vi.fn((callback) => callback(source, ''));
  const listeners = new Set<() => void>();
  const inspected = devtools
    ? {
        getResources: (cb: (r: unknown[]) => void) =>
          cb([
            { url: 'https://example.com/', getContent },
            { ...resource, getContent },
          ]),
        onResourceContentCommitted: {
          addListener: (cb: () => void) => listeners.add(cb),
          removeListener: (cb: () => void) => listeners.delete(cb),
        },
      }
    : undefined;
  const sources = new PageSources(
    { ensure: async () => {}, command, sessions: () => [], frame: () => 'main' },
    inspected as any,
  );
  return {
    sources,
    command,
    getContent,
    tree,
    listeners,
    setSource: (value: string) => {
      source = value;
    },
    setBody: (value: typeof body) => {
      body = value;
    },
  };
}

it('indexes without reading, distinguishes query/frame/inline identities and prefers unambiguous DevTools resources', async () => {
  const f = setup(true);
  f.tree.resources.push({ ...f.tree.resources[0], url: 'https://cdn.example/bundle.js?v=2' });
  for (const scriptId of ['1', '2'])
    f.sources.event('Debugger.scriptParsed', {
      scriptId,
      url: 'https://example.com/',
      executionContextId: 1,
      startLine: 4,
      startColumn: 0,
    });
  f.sources.event('Debugger.scriptParsed', {
    scriptId: '3',
    url: 'virtual.js',
    hasSourceURL: true,
    executionContextId: 1,
    startLine: 0,
    startColumn: 0,
    sourceMapURL: 'virtual.js.map',
  });
  const files = await f.sources.list();
  expect(files).toHaveLength(8);
  expect(new Set(files.map((r) => r.path)).size).toBe(8);
  expect(files.every((r) => r.size === -1)).toBe(true);
  expect(files.filter((r) => r.kind === 'inline')).toHaveLength(2);
  expect(files.find((r) => r.kind === 'eval')).toMatchObject({ sourceMapURL: 'virtual.js.map' });
  expect(f.command.mock.calls.some(([m]) => /getResourceContent|getScriptSource/.test(m))).toBe(
    false,
  );
  const doc = files.find(
    (r) => r.sourceUrl === 'https://example.com/' && r.provider === 'devtools',
  )!;
  const file = await f.sources.read(doc.path);
  expect(file.content).toContain('needle');
  expect(file.revision).toMatch(/^sha256:/);
  await f.sources.read(doc.path);
  expect(f.getContent).toHaveBeenCalledTimes(1);
  const ambiguous = files.find((r) => r.sourceUrl?.endsWith('?v=1'))!;
  expect(ambiguous.provider).toBe('page');
  await f.sources.read(ambiguous.path);
  expect(f.command).toHaveBeenCalledWith(
    'Page.getResourceContent',
    expect.objectContaining({ frameId: ambiguous.frameId }),
    undefined,
  );
  expect((await f.sources.list()).map((r) => r.path)).toEqual(files.map((r) => r.path));
});

it('invalidates late loads and old paths, refreshes revision after TTL and resource edits', async () => {
  const f = setup(true);
  const path = (await f.sources.list()).find((r) => r.provider === 'page')!.path;
  let finish!: (value: { content: string; base64Encoded: boolean }) => void;
  f.setBody(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.sources.read(path);
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.sources.invalidate();
  finish({ content: 'old', base64Encoded: false });
  await expect(pending).rejects.toMatchObject({ code: 'context_changed' });
  await expect(f.sources.read(path)).rejects.toMatchObject({ code: 'context_changed' });
  f.setBody(undefined);
  const fresh = (await f.sources.list()).find((r) => r.provider === 'page')!.path;
  const first = await f.sources.read(fresh);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 300001);
  f.setSource('changed');
  expect((await f.sources.read(fresh)).revision).not.toBe(first.revision);
  for (const cb of f.listeners) cb();
  await expect(f.sources.read(fresh)).rejects.toMatchObject({ code: 'context_changed' });
  f.sources.dispose();
  expect(f.listeners.size).toBe(0);
});

it('rejects binary and oversized bodies without pretending a prefix is full source', async () => {
  const f = setup();
  const path = (await f.sources.list())[0].path;
  f.setBody(async () => ({ content: 'AA==', base64Encoded: true }));
  await expect(f.sources.read(path)).rejects.toMatchObject({ code: 'binary_source' });
  f.setBody(undefined);
  f.setSource('x'.repeat(SOURCE_FILE_BYTES + 1));
  await expect(f.sources.read(path)).rejects.toMatchObject({ code: 'resource_too_large' });
});

it('gives a recompiled URL a new identity instead of reusing its cached body', async () => {
  const f = setup();
  const script = {
    scriptId: '1',
    url: 'https://cdn.example/bundle.js?v=1',
    executionContextId: 1,
    startLine: 0,
    startColumn: 0,
  };
  f.sources.event('Debugger.scriptParsed', script);
  const first = (await f.sources.list()).find(
    (entry) => entry.scriptId === '1' && !entry.path.includes('/runtime/'),
  )!;
  const old = await f.sources.read(first.path);
  f.setSource('recompiled');
  f.sources.event('Debugger.scriptParsed', { ...script, scriptId: '2' });
  const next = (await f.sources.list()).find((entry) => entry.scriptId === '2')!;
  expect(next.path).not.toBe(first.path);
  const fresh = await f.sources.read(next.path);
  expect(fresh.content).toBe('recompiled');
  expect(fresh.revision).not.toBe(old.revision);
});

it('times out stalled source callbacks without caching their late result', async () => {
  const f = setup();
  const path = (await f.sources.list())[0].path;
  let finish!: (value: { content: string; base64Encoded: boolean }) => void;
  f.setBody(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.useFakeTimers();
  const pending = expect(f.sources.read(path)).rejects.toMatchObject({ code: 'source_timeout' });
  await vi.advanceTimersByTimeAsync(15000);
  await pending;
  finish({ content: 'late', base64Encoded: false });
  f.setBody(undefined);
  f.setSource('fresh');
  expect((await f.sources.read(path)).content).toBe('fresh');
});

it('bounds cache memory and refetches an evicted snapshot from the provider', async () => {
  const f = setup();
  f.setSource('x'.repeat(6 * 1024 * 1024));
  const paths = (await f.sources.list()).map((r) => r.path);
  for (const path of paths) await f.sources.read(path);
  const count = f.command.mock.calls.filter(([m]) => m === 'Page.getResourceContent').length;
  await f.sources.read(paths[0]);
  expect(f.command.mock.calls.filter(([m]) => m === 'Page.getResourceContent')).toHaveLength(
    count + 1,
  );
});

it('mounts only explicit /source, preserves ranges and full line reads, rejects every write path and reports skipped search', async () => {
  const f = setup();
  const db = await openAgentDB(crypto.randomUUID());
  try {
    const workspace = await WorkspaceService.create(db, 'https://example.com/');
    workspace.sources = f.sources;
    const tools = new FileTools(workspace);
    expect((await workspace.list()).some((r) => r.path.startsWith('/source'))).toBe(false);
    expect(f.command).not.toHaveBeenCalled();
    const files = await workspace.list('/source');
    expect(await tools.grep({ path: '/source', glob: '**/*.ts', pattern: 'absent' })).toMatchObject(
      { search_complete: true, scanned_bytes: 0, skipped_count: 0 },
    );
    const path = files[0].path;
    f.setSource('first\n' + 'x'.repeat(500000) + 'needle\nlast');
    expect(
      (await tools.glob({ path: '/source', pattern: '**/*.html' })).files.length,
    ).toBeGreaterThan(0);
    const grep = await tools.grep({
      path,
      pattern: 'needle',
      output_mode: 'content',
      char_context: 5,
    });
    expect(grep).toMatchObject({ search_complete: true, skipped_count: 0 });
    expect(grep.results[0].offset).toBe(500006);
    expect((await workspace.read(path, { offset: 500006, limit: 6 })).content).toBe('needle');
    expect(await tools.read({ file_path: path, offset: 3, limit: 1 })).toMatchObject({
      content: '     3→last',
      total_lines: 3,
    });
    await expect(workspace.write(path, 'x')).rejects.toMatchObject({ code: 'read_only' });
    await expect(workspace.edit(path, 'needle', 'x', 'rev')).rejects.toMatchObject({
      code: 'read_only',
    });
    await expect(workspace.remove(path, 'rev')).rejects.toMatchObject({ code: 'read_only' });
    await expect(workspace.rename('/workspace/a.js', path, 'rev')).rejects.toMatchObject({
      code: 'read_only',
    });
    await expect(tools.write({ file_path: path, content: 'x' })).rejects.toMatchObject({
      code: 'read_only',
    });
    await expect(
      tools.edit({ file_path: path, old_string: 'needle', new_string: 'x' }),
    ).rejects.toMatchObject({ code: 'read_only' });
    expect(await workspace.allFiles()).toEqual([]);
    await expect(workspace.search('needle', '/source')).rejects.toMatchObject({
      code: 'unsupported_operation',
    });
    f.sources.invalidate();
    f.setSource('x'.repeat(5 * 1024 * 1024));
    const limited = await tools.grep({
      path: '/source',
      pattern: 'absent',
      output_mode: 'content',
      char_context: 2,
    });
    expect(limited).toMatchObject({ total_matches: 0, search_complete: false });
    expect(limited.skipped_count).toBeGreaterThan(0);
    expect(limited.skipped?.some((r) => r.reason === 'scan_budget')).toBe(true);
    f.sources.invalidate();
    f.setBody(async () => {
      throw new Error('resource evicted');
    });
    expect(await tools.grep({ path: '/source', pattern: 'absent' })).toMatchObject({
      search_complete: false,
      skipped_count: 4,
    });
  } finally {
    db.close();
  }
});
