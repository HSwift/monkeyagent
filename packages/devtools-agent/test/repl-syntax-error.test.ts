// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import variant from '@jitl/quickjs-wasmfile-release-sync';
import { AgentError, errorData } from '../src/protocol/errors';
import { appendErrorLocation } from '../src/protocol/error-location';
import { evaluationExceptionMessage } from '../src/browser/evaluate-error';
import { ReplRuntime, newQuickJSWASMModuleFromVariant, type HostCall } from '../src/repl/runtime';
import { replSyntaxErrorMessage, REPL_FILENAME } from '../src/repl/syntax-error';

const runtimes: ReplRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
async function runtime(host: HostCall = async () => null) {
  const vm = new ReplRuntime(await newQuickJSWASMModuleFromVariant(variant), host);
  runtimes.push(vm);
  return vm;
}
function native(cause: Record<string, unknown>, message = "unexpected token in expression: ';'") {
  return new Error(message, { cause: { name: 'SyntaxError', fileName: REPL_FILENAME, ...cause } });
}

it.each([
  'const x = ;',
  'const a = 1;\nconst x = ;',
  'const a = 1;\r\nconst x = ;',
  'const a = 1;\rconst x = ;',
  'const a = 1;\u2028const x = ;',
  'const a = 1;\u2029const x = ;',
  'const text = "界🙂é"; const x = ;',
  '\tconst text = "🙂"; const x = ;',
  '\n\nconst text = "🙂";\r\nconst x = ;',
])(
  'maps actual QuickJS compile coordinates to the same 1-based UTF-16 format as browser: %j',
  async (code) => {
    const vm = await runtime();
    const lines = code.split(/\r\n|[\r\n\u2028\u2029]/);
    const line = lines.length,
      column = lines.at(-1)!.lastIndexOf(';') + 1;
    try {
      await vm.run(code, 1000);
      expect.fail('Expected a compilation failure');
    } catch (error) {
      const data = errorData(error);
      expect(data.message).toBe(
        `unexpected token in expression: ';' (line ${line}, column ${column})`,
      );
      expect(Object.keys(data).sort()).toEqual(['code', 'message']);
      const pageMessage = evaluationExceptionMessage({
        text: 'Uncaught',
        lineNumber: line - 1,
        columnNumber: column - 1,
        exception: {
          type: 'object',
          subtype: 'error',
          className: 'SyntaxError',
          description: "SyntaxError: Unexpected token ';'",
        },
      });
      expect(data.message.match(/\(line \d+, column \d+\)$/)?.[0]).toBe(
        pageMessage.match(/\(line \d+, column \d+\)$/)?.[0],
      );
    }
  },
);

it('does not execute an invalid program or replay runtime side effects to add a position', async () => {
  let calls = 0;
  const vm = await runtime(async () => {
    calls++;
    return null;
  });
  await expect(
    vm.run('await browser.evaluate("mutation"); state.ran=true; const x=;', 1000),
  ).rejects.toThrow(/\(line 1, column \d+\)$/);
  expect(calls).toBe(0);
  expect(await vm.run('return state.ran ?? null;', 1000)).toBeNull();
  await expect(
    vm.run('state.runs=(state.runs||0)+1; return JSON.parse("{");', 1000),
  ).rejects.toMatchObject({ name: 'SyntaxError', message: 'expecting property name' });
  expect(await vm.run('return state.runs;', 1000)).toBe(1);
});

it('preserves runtime, host and page errors, including their existing message and details', async () => {
  const pageMessage = "SyntaxError: Unexpected token ';' (line 7, column 5)";
  const vm = await runtime(async () => {
    throw new AgentError('page_exception', pageMessage);
  });
  await expect(vm.run('return await browser.evaluate("bad source");', 1000)).rejects.toMatchObject({
    code: 'page_exception',
    message: pageMessage,
  });
  await expect(vm.run('throw new Error("runtime-probe");', 1000)).rejects.toMatchObject({
    message: 'runtime-probe',
  });
  await expect(vm.run('return missingProbe.value;', 1000)).rejects.toMatchObject({
    name: 'ReferenceError',
    message: "'missingProbe' is not defined",
  });
  const host = await runtime(async () => {
    throw new AgentError('http_network_error', 'Connection failed', { environment: 'http' });
  });
  await expect(
    host.run('return await http.request("https://example.com/");', 1000),
  ).rejects.toMatchObject({
    code: 'http_network_error',
    message: 'Connection failed',
    details: { environment: 'http' },
  });
});

it.each(['const x = (', 'if (true) {'])(
  'does not invent a user coordinate for an error pointing into the generated suffix: %s',
  async (code) => {
    const vm = await runtime();
    try {
      await vm.run(code, 1000);
      expect.fail('Expected a compilation failure');
    } catch (error) {
      expect(errorData(error).message).not.toContain('(line ');
    }
  },
);

it('uses line-only locations when columns are missing or invalid and leaves ambiguous locations alone', () => {
  const code = 'const a = 1;\nconst x = ;';
  expect(replSyntaxErrorMessage(native({ lineNumber: 3 }), code)).toBe(
    "unexpected token in expression: ';' (line 2)",
  );
  expect(
    replSyntaxErrorMessage(native({ lineNumber: 3, stack: '    at agent-repl.js:3:9999\n' }), code),
  ).toBe("unexpected token in expression: ';' (line 2)");
  const ambiguous = 'const a = 1;\u2028const x = ;';
  expect(replSyntaxErrorMessage(native({ lineNumber: 2 }), ambiguous)).not.toContain('(line ');
  for (const cause of [
    { lineNumber: -1 },
    { lineNumber: NaN },
    { lineNumber: Infinity },
    { lineNumber: 2.5 },
    { lineNumber: 99999 },
    { lineNumber: 3, fileName: '<input>' },
    { lineNumber: 3, name: 'TypeError' },
  ]) {
    const error = native(cause);
    expect(replSyntaxErrorMessage(error, code)).toBe(error.message);
  }
  expect(replSyntaxErrorMessage(new Error('no engine location'), code)).toBe('no engine location');
});

it('keeps a located message/native stack intact through the shared formatter', () => {
  for (const message of [
    'bad input (line 2, column 11)',
    'bad input (line 2)',
    'bad input\n    at source.js:2:11',
    'bad input\nsource.js:2:11',
  ]) {
    expect(appendErrorLocation(message, { line: 9, column: 9 })).toBe(message);
    expect(
      replSyntaxErrorMessage(
        native({ lineNumber: 2, stack: '    at agent-repl.js:2:11\n' }, message),
        'const x = ;',
      ),
    ).toBe(message);
  }
  expect(appendErrorLocation('bad input', { line: 2, column: 0 })).toBe('bad input (line 2)');
  expect(appendErrorLocation('bad input', { line: 0, column: 1 })).toBe('bad input');
});
