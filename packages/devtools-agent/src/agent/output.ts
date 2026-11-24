import { findArtifacts } from './tools';
import { errorData } from '../protocol/errors';
import type { ToolResult } from '../protocol/types';
import type { WorkspaceService } from '../workspace/service';

export const REPL_OUTPUT_BYTES = 8 * 1024;
export const OUTPUT_PREVIEW_BYTES = 2 * 1024;
// Preserve the existing threshold for other tools; all oversized values share the same storage.
const OTHER_OUTPUT_CHARACTERS = 128 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const OMITTED = '\n… [output truncated] …\n';

/** Bounded head/tail text, never splitting a UTF-8 character. It is not a complete JSON value. */
function preview(text: string): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= OUTPUT_PREVIEW_BYTES) return text;
  const remaining = OUTPUT_PREVIEW_BYTES - encoder.encode(OMITTED).length;
  let head = Math.floor(remaining / 2);
  let tail = bytes.length - (remaining - head);
  while (head > 0 && (bytes[head] & 0xc0) === 0x80) head--;
  while (tail < bytes.length && (bytes[tail] & 0xc0) === 0x80) tail++;
  return decoder.decode(bytes.subarray(0, head)) + OMITTED + decoder.decode(bytes.subarray(tail));
}

/** Apply only after execution: functions and QuickJS state retain their complete values. */
export async function prepareToolOutput(
  workspace: WorkspaceService,
  name: string,
  value: unknown,
): Promise<Pick<ToolResult, 'value' | 'artifacts' | 'truncated' | 'warnings'>> {
  const artifacts = findArtifacts(value);
  const text = JSON.stringify(value ?? null);
  const blob = new Blob([text], { type: 'application/json' });
  const oversized =
    name === 'repl' ? blob.size > REPL_OUTPUT_BYTES : text.length > OTHER_OUTPUT_CHARACTERS;
  if (!oversized) return { value, ...(artifacts.length ? { artifacts } : {}) };
  const shortened = preview(text);
  try {
    const artifact = await workspace.artifact(blob, 'result.json');
    return {
      value: {
        preview: shortened,
        artifact,
        notice:
          'Full JSON result saved at artifact.path; preview is incomplete text. Use Read/Grep on that path, or fs.read(path,{offset,limit:2000}) for character ranges. Do not rerun code to recover output.',
      },
      artifacts: [...artifacts, artifact],
      truncated: true,
    };
  } catch (error) {
    return {
      value: {
        preview: shortened,
        notice:
          'Full output could not be saved. Tool execution already completed; do not rerun mutations to recover output.',
      },
      ...(artifacts.length ? { artifacts } : {}),
      truncated: true,
      warnings: [
        {
          code: 'output_save_failed',
          message: `Cannot save full tool output: ${errorData(error).message.slice(0, 300)}. Execution completed; only output persistence failed.`,
          path: '$',
        },
      ],
    };
  }
}
