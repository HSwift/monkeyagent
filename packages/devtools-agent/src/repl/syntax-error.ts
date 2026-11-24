import { appendErrorLocation, type ErrorLocation } from '../protocol/error-location';

export const REPL_FILENAME = 'agent-repl.js';
const PREFIX = '(async () => {\n';
const PREFIX_LINES = PREFIX.split('\n').length - 1;

export function wrapReplCode(code: string) {
  return `${PREFIX}${code}\n})()`;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function logicalLocation(code: string, offset: number): ErrorLocation {
  const lines = code.slice(0, offset).split(/\r\n|[\r\n\u2028\u2029]/);
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

/** QuickJS positions count LF-delimited lines and Unicode code points, unlike V8's UTF-16 columns. */
function userLocation(code: string, line: number, column?: number): ErrorLocation | undefined {
  const lines = code.split('\n');
  const index = line - PREFIX_LINES - 1;
  // An error on the generated prefix/suffix has no proven user-code coordinate.
  if (index < 0 || index >= lines.length) return;
  const sourceLine = lines[index];
  let offset = 0;
  for (let i = 0; i < index; i++) offset += lines[i].length + 1;
  if (positiveInteger(column)) {
    let units = 0,
      points = 0;
    for (const point of sourceLine) {
      if (points === column - 1) break;
      units += point.length;
      points++;
    }
    if (points === column - 1) return logicalLocation(code, offset + units);
  }
  // Without a valid column, embedded non-LF separators make even the logical line ambiguous.
  if (/[\r\u2028\u2029]/.test(sourceLine.replace(/\r$/, ''))) return;
  return { line: logicalLocation(code, offset).line };
}

/** Called only for a failed initial compile, never for rejected runtime/host/page operations. */
export function replSyntaxErrorMessage(error: Error, code: string): string {
  const cause = error.cause;
  if (!cause || typeof cause !== 'object' || Array.isArray(cause)) return error.message;
  const native = cause as Record<string, unknown>;
  if (native.name !== 'SyntaxError' || native.fileName !== REPL_FILENAME) return error.message;
  const frame =
    typeof native.stack === 'string'
      ? native.stack.match(/^\s*at agent-repl\.js:(\d+)(?::(\d+))?\s*$/m)
      : null;
  const frameLine = frame ? Number(frame[1]) : undefined;
  const line = positiveInteger(native.lineNumber) ? native.lineNumber : frameLine;
  if (!positiveInteger(line)) return error.message;
  const column = frameLine === line && frame?.[2] ? Number(frame[2]) : undefined;
  return appendErrorLocation(error.message, userLocation(code, line, column));
}
