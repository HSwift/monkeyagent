// @vitest-environment node
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { FileTools } from '../src/agent/file-tools';
import { prepareToolOutput, REPL_OUTPUT_BYTES, OUTPUT_PREVIEW_BYTES } from '../src/agent/output';
import { ReplRuntime, newQuickJSWASMModuleFromVariant } from '../src/repl/runtime';
import { openAgentDB, type AgentDB } from '../src/workspace/database';
import { WorkspaceService } from '../src/workspace/service';
import type { ArtifactRef } from '../src/protocol/types';

const databases: AgentDB[] = [];
const runtimes: ReplRuntime[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const vm of runtimes.splice(0)) vm.dispose();
  for (const db of databases.splice(0)) db.close();
});
async function setup() {
  const db = await openAgentDB(crypto.randomUUID());
  databases.push(db);
  const workspace = await WorkspaceService.create(db, 'https://example.com');
  workspace.sessionId = 'current-session';
  return { workspace, files: new FileTools(workspace) };
}
function saved(output: Awaited<ReturnType<typeof prepareToolOutput>>) {
  return output.value as { artifact: ArtifactRef; preview: string; notice: string };
}

it('keeps values up to 8 KiB of serialized UTF-8 JSON inline and spills only larger REPL results', async () => {
  const { workspace } = await setup();
  const boundary = 'x'.repeat(REPL_OUTPUT_BYTES - 2);
  expect(await prepareToolOutput(workspace, 'repl', boundary)).toEqual({ value: boundary });
  expect(await workspace.db.count('artifacts')).toBe(0);
  const output = await prepareToolOutput(workspace, 'repl', boundary + 'x');
  expect(output.truncated).toBe(true);
  expect(saved(output).artifact).toMatchObject({
    path: expect.stringMatching(/^\/artifacts\//),
    mimeType: 'application/json',
    size: REPL_OUTPUT_BYTES + 1,
  });
  expect(JSON.parse((await workspace.readForSearch(saved(output).artifact.path)).content)).toBe(
    boundary + 'x',
  );
  const unicode = await prepareToolOutput(workspace, 'repl', '界'.repeat(3000));
  expect(unicode.truncated).toBe(true);
  expect(saved(unicode).artifact.size).toBe(9002);
  expect((await workspace.db.get('artifacts', saved(output).artifact.id))?.sessionId).toBe(
    'current-session',
  );
  expect(await workspace.allFiles()).toEqual([]);
});

it('uses a 2 KiB Unicode-safe head/tail preview, retains exact full JSON and supports search in the omitted middle', async () => {
  const { workspace, files } = await setup();
  const value = {
    head: 'HEAD_MARKER',
    body: '🙂界"\\\n'.repeat(10000) + 'MIDDLE_NEEDLE' + '中'.repeat(10000),
    tail: 'TAIL_MARKER',
  };
  const output = await prepareToolOutput(workspace, 'repl', value);
  const { artifact, preview, notice } = saved(output);
  expect(new TextEncoder().encode(preview).length).toBeLessThanOrEqual(OUTPUT_PREVIEW_BYTES);
  expect(preview).toContain('HEAD_MARKER');
  expect(preview).toContain('TAIL_MARKER');
  expect(preview).not.toContain('MIDDLE_NEEDLE');
  expect(preview).not.toContain('�');
  expect(notice).toContain('Read/Grep');
  expect(output.artifacts).toEqual([artifact]);
  const text = JSON.stringify(value);
  expect((await workspace.readForSearch(artifact.path)).content).toBe(text);
  expect(
    await files.grep({
      path: artifact.path,
      pattern: 'MIDDLE_NEEDLE',
      output_mode: 'content',
      char_context: 20,
    }),
  ).toMatchObject({
    total_matches: 1,
    results: [
      { offset: text.indexOf('MIDDLE_NEEDLE'), text: expect.stringContaining('MIDDLE_NEEDLE') },
    ],
  });
  expect(
    await workspace.read(artifact.path, { offset: text.indexOf('MIDDLE_NEEDLE'), limit: 13 }),
  ).toMatchObject({ content: 'MIDDLE_NEEDLE', totalLength: text.length });
  expect((await files.read({ file_path: artifact.path })).truncated).toBe(true);
  const reopened = new WorkspaceService(workspace.db, workspace.id);
  expect(JSON.parse((await reopened.readForSearch(artifact.path)).content)).toEqual(value);
});

it('shares /artifacts storage with other tools while preserving their existing output threshold', async () => {
  const { workspace } = await setup();
  const medium = 'x'.repeat(20000);
  expect(await prepareToolOutput(workspace, 'Read', medium)).toEqual({ value: medium });
  const output = await prepareToolOutput(workspace, 'Read', 'x'.repeat(128 * 1024 + 1));
  expect(output.truncated).toBe(true);
  expect(saved(output).artifact.path).toMatch(/^\/artifacts\//);
  expect((await workspace.readForSearch(saved(output).artifact.path)).content).toHaveLength(
    128 * 1024 + 3,
  );
});

it('retains existing screenshot references before the saved full-result reference', async () => {
  const { workspace } = await setup();
  const image = await workspace.artifact(
    new Blob(['image'], { type: 'image/png' }),
    'screenshot.png',
  );
  const output = await prepareToolOutput(workspace, 'repl', { image, text: 'x'.repeat(10000) });
  expect(output.artifacts).toEqual([image, saved(output).artifact]);
});

it('reports a save failure with a bounded preview without pretending execution failed or saving a different path', async () => {
  const { workspace } = await setup();
  let calls = 0;
  const vm = new ReplRuntime(await newQuickJSWASMModuleFromVariant(variant), async () => {
    calls++;
    return { text: 'x'.repeat(20000) };
  });
  runtimes.push(vm);
  const value = await vm.run(
    'state.calls=(state.calls||0)+1;state.value=await http.request("https://example.com/");return state.value;',
    1000,
  );
  vi.spyOn(workspace, 'artifact').mockRejectedValue(
    new DOMException('Storage full', 'QuotaExceededError'),
  );
  const output = await prepareToolOutput(workspace, 'repl', value);
  expect(output).toMatchObject({
    truncated: true,
    warnings: [
      { code: 'output_save_failed', message: expect.stringContaining('Execution completed') },
    ],
  });
  expect(output.value).not.toHaveProperty('artifact');
  expect(saved(output).notice).toContain('do not rerun');
  expect(new TextEncoder().encode(saved(output).preview).length).toBeLessThanOrEqual(
    OUTPUT_PREVIEW_BYTES,
  );
  expect(await vm.run('return {calls:state.calls,length:state.value.text.length};', 1000)).toEqual({
    calls: 1,
    length: 20000,
  });
  expect(calls).toBe(1);
  expect(await workspace.db.count('artifacts')).toBe(0);
  expect(await workspace.allFiles()).toEqual([]);
});

it('lets the REPL compute and retain full values before the final result is spilled', async () => {
  const { workspace } = await setup();
  const vm = new ReplRuntime(await newQuickJSWASMModuleFromVariant(variant), async () => null);
  runtimes.push(vm);
  const value = await vm.run(
    'state.runs=(state.runs||0)+1;state.data={items:Array.from({length:5000},(_,id)=>id),tail:"COMPLETE"};return state.data;',
    1000,
  );
  const output = await prepareToolOutput(workspace, 'repl', value);
  expect(output.truncated).toBe(true);
  const recovered = JSON.parse(
    (await workspace.readForSearch(saved(output).artifact.path)).content,
  );
  expect(recovered).toMatchObject({ tail: 'COMPLETE' });
  expect(recovered.items).toHaveLength(5000);
  expect(
    await vm.run(
      'return {runs:state.runs,length:state.data.items.length,last:state.data.items.at(-1)};',
      1000,
    ),
  ).toEqual({ runs: 1, length: 5000, last: 4999 });
});

it('lists text artifacts explicitly, reads/searches past 32000 characters, and protects the reserved root', async () => {
  const { workspace, files } = await setup();
  const content = Array.from(
    { length: 2000 },
    (_, i) => `${i + 1}: ${'line content '.repeat(3)}`,
  ).join('\n');
  const artifact = await workspace.artifact(
    new Blob([content], { type: 'text/plain' }),
    'multiline.txt',
  );
  await workspace.artifact(new Blob(['binary'], { type: 'image/png' }), 'image.png');
  const other = await WorkspaceService.create(workspace.db, 'https://other.example');
  await other.artifact(new Blob(['other'], { type: 'application/json' }), 'other.json');
  expect(await workspace.list('/artifacts')).toMatchObject([
    { path: artifact.path, revision: artifact.id, size: artifact.size },
  ]);
  expect((await workspace.list()).some((file) => file.path.startsWith('/artifacts/'))).toBe(false);
  expect(await files.glob({ path: '/artifacts', pattern: '**/*' })).toMatchObject({
    files: [artifact.path],
  });
  expect(await files.read({ file_path: artifact.path, offset: 1900, limit: 1 })).toMatchObject({
    total_lines: 2000,
    content: expect.stringContaining('1900: line content'),
  });
  expect(
    await files.grep({ path: '/artifacts', pattern: '2000:', output_mode: 'content' }),
  ).toMatchObject({ total_matches: 1, results: [{ line: 2000 }] });
  await expect(workspace.write(artifact.path, 'overwrite')).rejects.toMatchObject({
    code: 'read_only',
  });
  await expect(workspace.remove(artifact.path, artifact.id)).rejects.toMatchObject({
    code: 'read_only',
  });
  await expect(
    workspace.rename(artifact.path, '/workspace/other.txt', artifact.id),
  ).rejects.toMatchObject({ code: 'read_only' });
  await expect(workspace.edit(artifact.path, 'line', 'other', artifact.id)).rejects.toMatchObject({
    code: 'read_only',
  });
  await expect(
    files.write({ file_path: artifact.path, content: 'overwrite' }),
  ).rejects.toMatchObject({ code: 'read_only' });
  await expect(other.read(artifact.path)).rejects.toMatchObject({ code: 'not_found' });
  expect((await workspace.readForSearch(artifact.path)).content).toBe(content);
});
