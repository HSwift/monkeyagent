// @vitest-environment node
import 'fake-indexeddb/auto';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTools } from '../src/agent/tools';
import { errorData } from '../src/protocol/errors';
import type { ToolResult } from '../src/protocol/types';
import { ReplRuntime } from '../src/repl/runtime';
import { openAgentDB, type AgentDB } from '../src/workspace/database';
import { fileSummary, WorkspaceService } from '../src/workspace/service';
import { HttpClient, type HttpOptions } from '../src/http/client';

const databases: AgentDB[] = [];
const runtimes: ReplRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const db of databases.splice(0)) db.close();
});

type Input = { code: string; timeout?: number; description?: string; output_file?: string };
async function setup(pageValue: unknown = null) {
  const db = await openAgentDB(crypto.randomUUID());
  databases.push(db);
  const workspace = await WorkspaceService.create(db, 'https://example.com');
  const httpFetch = vi.fn(
    async () =>
      new Response(typeof pageValue === 'string' ? pageValue : JSON.stringify(pageValue), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  const http = new HttpClient(httpFetch);
  const runtime = new ReplRuntime(
    await newQuickJSWASMModuleFromVariant(variant),
    async (method, args) => {
      if (method === 'browser.evaluate') return pageValue;
      if (method === 'http.request') return http.request(args[0] as string, args[1] as HttpOptions);
      if (method === 'fs.write')
        return fileSummary(await workspace.write(...(args as [string, string, string?])));
      throw new Error(`Unexpected host method: ${method}`);
    },
  );
  runtimes.push(runtime);
  const run = vi.fn((code: string, timeout = 1000) => runtime.run(code, timeout));
  const tools = createTools({
    workspace,
    supportsImages: false,
    repl: run,
    execute: async (name, _input, fn) => {
      try {
        const output = { value: await fn(), warnings: [] };
        return {
          success: true,
          ...output,
          durationMs: 0,
          warnings: [...(output.warnings ?? []), ...runtime.warnings],
        };
      } catch (error) {
        return { success: false, error: errorData(error), durationMs: 0 };
      }
    },
  });
  async function call(input: Input) {
    const parsed = (tools.repl.inputSchema as z.ZodType<Input>).parse(input);
    return (await tools.repl.execute!(parsed, {
      toolCallId: 'test',
      messages: [],
      context: {},
    })) as ToolResult;
  }
  return { workspace, runtime, run, tools, call, httpFetch };
}

it('keeps normal return behavior and exposes the optional output path in the exported tool schema', async () => {
  const { workspace, tools, call } = await setup();
  expect(await call({ code: 'return {answer:42};' })).toMatchObject({
    success: true,
    value: { answer: 42 },
  });
  expect(await workspace.allFiles()).toEqual([]);
  const schema = z.toJSONSchema(tools.repl.inputSchema as z.ZodType);
  expect(schema.properties?.output_file).toMatchObject({ type: 'string', minLength: 1 });
  expect(schema.required).toEqual(['code']);
});

it('saves the full final JSON result without changing host values or persistent state', async () => {
  const value = { text: 'FULL_RESULT_MARKER'.repeat(15000), numbers: [1, 2, 3] };
  const { workspace, runtime, run, call } = await setup(value);
  const result = await call({
    code: 'state.calls = (state.calls || 0) + 1; state.value = await browser.evaluate("capture"); return state.value;',
    output_file: '/workspace//scratch/./result.json',
  });
  const file = await workspace.read('/workspace/scratch/result.json');
  expect(file.content).toBe(JSON.stringify(value));
  expect(result).toMatchObject({ success: true, value: fileSummary(file) });
  expect(JSON.stringify(result)).not.toContain('FULL_RESULT_MARKER');
  expect(run).toHaveBeenCalledTimes(1);
  expect(
    await runtime.run(
      'return {calls:state.calls, length:state.value.text.length, numbers:state.value.numbers.map(n=>n*2)};',
      1000,
    ),
  ).toEqual({
    calls: 1,
    length: value.text.length,
    numbers: [2, 4, 6],
  });
  expect(await workspace.db.count('artifacts')).toBe(0);
});

it('saves an HTTP result explicitly after one request while retaining its complete response in state', async () => {
  const body = JSON.stringify({
    items: Array.from({ length: 15000 }, (_, id) => ({ id })),
    tail: 'HTTP_FULL_TAIL',
  });
  const { call, workspace, runtime, httpFetch } = await setup(body);
  const output_file = '/workspace/scratch/http.json';
  const result = await call({
    code: 'state.response=await http.request("https://api.example.com/items"); return {response:state.response,count:JSON.parse(state.response.body).items.length};',
    output_file,
  });
  expect(result).toMatchObject({ success: true, value: { path: output_file } });
  expect(JSON.stringify(result)).not.toContain('HTTP_FULL_TAIL');
  const saved = JSON.parse((await workspace.read(output_file)).content);
  expect(saved).toMatchObject({
    count: 15000,
    response: { body, base64Encoded: false, status: 200 },
  });
  expect(
    await runtime.run(
      'return {body:typeof state.response.body,tail:JSON.parse(state.response.body).tail};',
      1000,
    ),
  ).toEqual({ body: 'string', tail: 'HTTP_FULL_TAIL' });
  expect(httpFetch).toHaveBeenCalledTimes(1);
  expect((await workspace.allFiles()).map((file) => file.path)).toEqual([output_file]);
  expect(await workspace.db.count('artifacts')).toBe(0);
});

it.each([
  {
    name: 'string',
    code: 'return "line\\n\\\"quoted\\\"";',
    expected: JSON.stringify('line\n"quoted"'),
    warning: undefined,
  },
  { name: 'null', code: 'return null;', expected: 'null', warning: undefined },
  { name: 'undefined', code: 'return undefined;', expected: 'null', warning: 'undefined_return' },
  {
    name: 'nested undefined',
    code: 'return {missing:undefined, values:[undefined]};',
    expected: '{"values":[null]}',
    warning: 'undefined_field',
  },
])(
  'uses the existing JSON serialization and warnings for $name',
  async ({ code, expected, warning }) => {
    const { workspace, call } = await setup();
    const result = await call({ code, output_file: '/workspace/result.json' });
    expect(result.success).toBe(true);
    expect((await workspace.read('/workspace/result.json')).content).toBe(expected);
    if (warning) expect(result.warnings).toContainEqual(expect.objectContaining({ code: warning }));
    else expect(result.warnings).toEqual([]);
  },
);

it.each([
  '/docs/result.json',
  '/artifacts/result.json',
  '/workspace/../other.json',
  'relative.json',
  '/workspace/',
])('rejects %s before executing code', async (output_file) => {
  const { workspace, run, call } = await setup();
  const result = await call({ code: 'state.executed = true; return 1;', output_file });
  expect(result).toMatchObject({
    success: false,
    error: { details: { phase: 'preflight', replCompleted: false, output_file } },
  });
  expect(run).not.toHaveBeenCalled();
  expect(await workspace.allFiles()).toEqual([]);
});

it('refuses a known existing destination before the REPL runs', async () => {
  const { workspace, run, call } = await setup();
  const original = await workspace.write('/workspace/existing.json', 'original');
  expect(
    await call({ code: 'state.executed = true; return 42;', output_file: original.path }),
  ).toMatchObject({
    success: false,
    error: { code: 'conflict', details: { phase: 'preflight', replCompleted: false } },
  });
  expect(run).not.toHaveBeenCalled();
  expect(await workspace.read(original.path)).toEqual(original);
});

it('reports a destination created during execution without rerunning code or discarding state', async () => {
  const { workspace, runtime, run, call } = await setup();
  const result = await call({
    code: 'state.calls = (state.calls || 0) + 1; await fs.write("/workspace/result.json", "other writer"); return state.calls;',
    output_file: '/workspace/result.json',
  });
  expect(result).toMatchObject({
    success: false,
    error: {
      code: 'conflict',
      details: { phase: 'output', replCompleted: true, output_file: '/workspace/result.json' },
    },
  });
  expect((await workspace.read('/workspace/result.json')).content).toBe('other writer');
  expect(run).toHaveBeenCalledTimes(1);
  expect(await runtime.run('return state.calls;', 1000)).toBe(1);
});

it('preserves state and reports output-stage size failures without falling back to artifacts', async () => {
  const { workspace, runtime, run, call } = await setup();
  expect(
    await call({
      code: 'state.completed = true; return "x".repeat(2 * 1024 * 1024 + 1);',
      timeout: 5000,
      output_file: '/workspace/large.json',
    }),
  ).toMatchObject({
    success: false,
    error: { code: 'size_limit', details: { phase: 'output', replCompleted: true } },
  });
  expect(run).toHaveBeenCalledTimes(1);
  expect(await runtime.run('return state.completed;', 1000)).toBe(true);
  expect(await workspace.allFiles()).toEqual([]);
  expect(await workspace.db.count('artifacts')).toBe(0);
});

it('does not create a file when execution fails', async () => {
  const { workspace, call } = await setup();
  const result = await call({
    code: 'throw new Error("execution failed");',
    output_file: '/workspace/result.json',
  });
  expect(result).toMatchObject({ success: false });
  expect(result.error?.message).toContain('execution failed');
  expect(result.error?.details).toBeUndefined();
  expect(await workspace.allFiles()).toEqual([]);
});
