// @vitest-environment node
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { afterEach, expect, it } from 'vitest';
import { ReplRuntime } from '../src/repl/runtime';
import { sleep } from '../src/protocol/errors';

const runtimes: ReplRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
async function runtime(host = async (_method: string, _args: unknown[]): Promise<unknown> => null) {
  const runtime = new ReplRuntime(await newQuickJSWASMModuleFromVariant(variant), host);
  runtimes.push(runtime);
  return runtime;
}
it('runs async host calls and explicit persistent state without extension or Node globals', async () => {
  const calls: string[] = [];
  const vm = await runtime(async (method, args) => {
    calls.push(method);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { method, expression: args[0], title: 'Test page' };
  });
  const value = await vm.run(
    'state.result = await browser.evaluate("document.title"); return state.result;',
    1000,
  );
  expect(value).toEqual({
    method: 'browser.evaluate',
    expression: 'document.title',
    title: 'Test page',
  });
  expect(
    await vm.run(
      'return { title: state.result.title, chrome: typeof chrome, fetch: typeof fetch, process: typeof process };',
      1000,
    ),
  ).toEqual({ title: 'Test page', chrome: 'undefined', fetch: 'undefined', process: 'undefined' });
  expect(calls).toEqual(['browser.evaluate']);
});
it('returns host exceptions and interrupts a busy loop', async () => {
  const vm = await runtime(async () => {
    throw new Error('page context disappeared');
  });
  await expect(vm.run('return await browser.evaluate("document.title");', 1000)).rejects.toThrow(
    'page context disappeared',
  );
  await expect(vm.run('while (true) {}', 30)).rejects.toThrow(/interrupted/);
});
it('drains unawaited host calls and chained effects before releasing the operation queue', async () => {
  const calls: unknown[] = [];
  const vm = await runtime(async (method, args) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    calls.push({ method, args });
    return 'done';
  });
  await vm.run('browser.evaluate("one").then(() => browser.evaluate("two")); return 42;', 1000);
  expect(calls).toEqual([
    { method: 'browser.evaluate', args: ['one'] },
    { method: 'browser.evaluate', args: ['two'] },
  ]);
});

it('offers cancellable sleep and actionable errors for the exact unsupported globals seen in the trace', async () => {
  const vm = await runtime(async (method, args) => {
    expect(method).toBe('runtime.sleep');
    return sleep(args[0] as number);
  });
  expect(await vm.run('await sleep(5); return 42;', 1000)).toBe(42);
  await expect(vm.run('return await __hosts__.scripts.list();', 1000)).rejects.toMatchObject({
    code: 'unsupported_global',
    message: expect.stringContaining('Call fs, http, browser and scripts directly'),
  });
  await expect(vm.run('await new Promise(r => setTimeout(r, 5));', 1000)).rejects.toMatchObject({
    code: 'unsupported_global',
    message: expect.stringContaining('await sleep(ms)'),
  });
  const abort = new AbortController();
  const waiting = sleep(60000, abort.signal);
  abort.abort();
  await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
});

it('reports fields lost to JSON serialization without changing normal values or failing mutations', async () => {
  const vm = await runtime(async () => ({ verification: { passed: true } }));
  const result = await vm.run(
    'const status = await scripts.status("/workspace/a.js"); return {verified:status.verified, actual:status.verification.passed, nested:[{missing:undefined}], intentional:null};',
    1000,
  );
  expect(result).toEqual({ actual: true, nested: [{}], intentional: null });
  expect(vm.warnings).toEqual([
    expect.objectContaining({ code: 'undefined_field', path: '$["verified"]' }),
    expect.objectContaining({ code: 'undefined_field', path: '$["nested"]["0"]["missing"]' }),
  ]);
  expect(await vm.run('state.saved = true;', 1000)).toBeUndefined();
  expect(vm.warnings).toEqual([expect.objectContaining({ code: 'undefined_return' })]);
  expect(await vm.run('return {saved:state.saved, optional:null};', 1000)).toEqual({
    saved: true,
    optional: null,
  });
  expect(vm.warnings).toEqual([]);
});
