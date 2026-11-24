import { expect, it } from 'vitest';
import {
  evaluationExceptionMessage,
  type EvaluationException,
} from '../src/browser/evaluate-error';

const format = (
  exception: EvaluationException['exception'],
  fields: Partial<EvaluationException> = {},
) => evaluationExceptionMessage({ text: 'Uncaught', exception, ...fields });

it.each(['Error', 'ReferenceError', 'TypeError', 'AggregateError'])(
  'preserves native %s descriptions byte for byte without duplicating a stack',
  (className) => {
    const description = `${className}: probe\n    at inner (file.js:2:25)\n    at outer (file.js:3:2)`;
    expect(
      format(
        { type: 'object', subtype: 'error', className, description },
        { lineNumber: 1, columnNumber: 18 },
      ),
    ).toBe(description);
  },
);

it('only fills a missing SyntaxError position and reports 1-based backend coordinates', () => {
  const exception = {
    type: 'object',
    subtype: 'error',
    className: 'SyntaxError',
    description: "SyntaxError: Unexpected token ';'",
  };
  expect(format(exception, { lineNumber: 0, columnNumber: 10 })).toBe(
    "SyntaxError: Unexpected token ';' (line 1, column 11)",
  );
  expect(format(exception, { lineNumber: 2 })).toBe("SyntaxError: Unexpected token ';' (line 3)");
  const rich =
    'SyntaxError: bad JSON\n    at JSON.parse (<anonymous>)\n    at parse (file.js:5:10)';
  expect(format({ ...exception, description: rich }, { lineNumber: 4, columnNumber: 9 })).toBe(
    rich,
  );
  const located = 'SyntaxError: bad input (line 1, column 11)';
  expect(format({ ...exception, description: located }, { lineNumber: 0, columnNumber: 10 })).toBe(
    located,
  );
  expect(
    format(
      { ...exception, description: 'SyntaxError: bad input\nfile.js:1:11' },
      { lineNumber: 0, columnNumber: 10 },
    ),
  ).toBe('SyntaxError: bad input\nfile.js:1:11');
});

it.each([undefined, -1, NaN, Infinity, 1.5])(
  'does not invent an unknown/invalid syntax-error position: %s',
  (lineNumber) => {
    expect(
      format(
        {
          type: 'object',
          subtype: 'error',
          className: 'SyntaxError',
          description: 'SyntaxError: invalid',
        },
        { lineNumber, columnNumber: 10 },
      ),
    ).toBe('SyntaxError: invalid');
  },
);

it('leaves an ordinary Error with an empty stack alone, and handles a missing exception object', () => {
  expect(
    format(
      { type: 'object', subtype: 'error', className: 'Error', description: 'Error: no stack' },
      { lineNumber: 1, columnNumber: 2 },
    ),
  ).toBe('Error: no stack');
  expect(format(undefined, { text: 'Uncaught (in promise)' })).toBe('Uncaught (in promise)');
});

it.each([
  [{ type: 'string', value: 'probe-string' }, 'Thrown value: "probe-string"'],
  [{ type: 'string', value: '' }, 'Thrown value: ""'],
  [{ type: 'object', subtype: 'null', value: null }, 'Thrown value: null'],
  [{ type: 'boolean', value: false }, 'Thrown value: false'],
  [{ type: 'number', value: 0, description: '0' }, 'Thrown value: 0'],
  [{ type: 'number', unserializableValue: '-0' }, 'Thrown value: -0'],
  [{ type: 'number', unserializableValue: 'NaN' }, 'Thrown value: NaN'],
  [{ type: 'bigint', unserializableValue: '42n' }, 'Thrown value: 42n'],
  [{ type: 'undefined' }, 'Thrown value: undefined'],
  [{ type: 'symbol', description: 'Symbol(probe)' }, 'Thrown value: Symbol(probe)'],
])(
  'keeps non-Error thrown values recognizable without generic text duplication',
  (exception, message) => {
    expect(format(exception)).toBe(message);
  },
);

it('uses only the supplied object preview, including accessor and partial-value markers', () => {
  const exception = {
    type: 'object',
    className: 'Object',
    description: 'Object',
    preview: {
      overflow: false,
      properties: [
        { name: 'reason', type: 'string', value: 'probe-object' },
        { name: 'code', type: 'number', value: '42' },
        { name: 'child', type: 'object', value: 'Object' },
        { name: 'getter', type: 'accessor' },
      ],
    },
  };
  expect(format(exception)).toBe(
    'Thrown value (Object preview): {"reason": "probe-object", "code": 42, "child": [Object], "getter": [accessor]}',
  );
  expect(format({ ...exception, preview: { ...exception.preview, overflow: true } })).toContain(
    ', …}',
  );
  expect(format({ type: 'object', value: { reason: 'available-by-value' } })).toBe(
    'Thrown value: {"reason":"available-by-value"}',
  );
});

it('bounds new value previews and visibly marks omitted properties/content', () => {
  const message = format({ type: 'string', value: '🙂'.repeat(5000) });
  expect(message.length).toBeLessThanOrEqual(2000);
  expect(message).toMatch(/… \[truncated\]$/);
  expect(message).not.toMatch(/[\uD800-\uDBFF]…/);
  const many = format({
    type: 'object',
    description: 'Object',
    preview: {
      properties: Array.from({ length: 10 }, (_, n) => ({
        name: `p${n}`,
        type: 'number',
        value: String(n),
      })),
    },
  });
  expect(many).toContain('"p4": 4, …');
  expect(many).not.toContain('"p5"');
});
