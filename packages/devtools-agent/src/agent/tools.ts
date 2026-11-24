import { tool, type ToolResultPart } from 'ai';
import { z } from 'zod';
import type { WorkspaceService } from '../workspace/service';
import { fileSummary, normalizePath } from '../workspace/service';
import type { ToolResult, ArtifactRef } from '../protocol/types';
import { AgentError, errorData } from '../protocol/errors';
import { FileTools } from './file-tools';

export const ACTIVE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'repl'] as const;

const string = z.string();
const fileSchemas = {
  list: z.object({ prefix: string.optional() }),
  read: z.object({
    path: string,
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(64000).optional(),
  }),
  write: z.object({ path: string, content: string, expectedRevision: string.optional() }),
  edit: z.object({ path: string, search: string, replacement: string, expectedRevision: string }),
  search: z.object({ query: string, prefix: string.optional() }),
  remove: z.object({ path: string, expectedRevision: string }),
};
export type FileInput = {
  op: keyof typeof fileSchemas;
  path?: string;
  prefix?: string;
  content?: string;
  expectedRevision?: string;
  search?: string;
  replacement?: string;
  query?: string;
  offset?: number;
  limit?: number;
};
export async function executeFiles(workspace: WorkspaceService, input: FileInput) {
  switch (input.op) {
    case 'list': {
      const data = fileSchemas.list.parse(input);
      return workspace.list(data.prefix);
    }
    case 'read': {
      const data = fileSchemas.read.parse(input);
      return workspace.read(
        data.path,
        data.offset != null || data.limit != null
          ? { offset: data.offset, limit: data.limit }
          : undefined,
      );
    }
    case 'write': {
      const data = fileSchemas.write.parse(input);
      return fileSummary(await workspace.write(data.path, data.content, data.expectedRevision));
    }
    case 'edit': {
      const data = fileSchemas.edit.parse(input);
      return fileSummary(
        await workspace.edit(data.path, data.search, data.replacement, data.expectedRevision),
      );
    }
    case 'search': {
      const data = fileSchemas.search.parse(input);
      return workspace.search(data.query, data.prefix);
    }
    case 'remove': {
      const data = fileSchemas.remove.parse(input);
      return workspace.remove(data.path, data.expectedRevision);
    }
  }
}
export function findArtifacts(value: unknown): ArtifactRef[] {
  const result = new Map<string, ArtifactRef>();
  function visit(data: unknown, depth: number) {
    if (!data || typeof data !== 'object' || depth > 12) return;
    const ref = data as ArtifactRef;
    if (
      typeof ref.id === 'string' &&
      typeof ref.mimeType === 'string' &&
      typeof ref.path === 'string' &&
      ref.path.startsWith('/artifacts/')
    )
      result.set(ref.id, ref);
    for (const child of Object.values(data)) visit(child, depth + 1);
  }
  visit(value, 0);
  return [...result.values()];
}
export function createTools(options: {
  workspace: WorkspaceService;
  fileTools?: FileTools;
  execute: (
    name: string,
    input: unknown,
    fn: () => Promise<unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  repl: (code: string, timeoutMs?: number, signal?: AbortSignal) => Promise<unknown>;
  supportsImages: boolean;
}) {
  const files = options.fileTools ?? new FileTools(options.workspace);
  const filePath = string.describe(
    'Absolute virtual file path. Script source belongs under /workspace/, e.g. /workspace/main.user.js. Guides are under /docs/.',
  );
  const contextLines = z.number().int().min(0).max(200).optional();
  async function runRepl(
    input: { code: string; timeout?: number; output_file?: string },
    signal?: AbortSignal,
  ) {
    let outputPath: string | undefined;
    if (input.output_file !== undefined) {
      try {
        signal?.throwIfAborted();
        outputPath = normalizePath(input.output_file);
        if (!outputPath.startsWith('/workspace/'))
          throw new AgentError('read_only', 'output_file must be a file under /workspace/.');
        try {
          await options.workspace.read(outputPath);
          throw new AgentError('conflict', 'The output file already exists. Choose a new path.');
        } catch (error) {
          if (!(error instanceof AgentError && error.code === 'not_found')) throw error;
        }
      } catch (error) {
        const data = errorData(error);
        throw new AgentError(data.code, `REPL was not executed. ${data.message}`, {
          ...data.details,
          phase: 'preflight',
          replCompleted: false,
          output_file: input.output_file,
        });
      }
    }
    const value = await options.repl(input.code, input.timeout, signal);
    if (outputPath === undefined) return value;
    try {
      signal?.throwIfAborted();
      const content = JSON.stringify(value ?? null);
      return fileSummary(await options.workspace.write(outputPath, content));
    } catch (error) {
      const data = errorData(error);
      throw new AgentError(data.code, `REPL completed, but saving output failed. ${data.message}`, {
        ...data.details,
        phase: 'output',
        replCompleted: true,
        output_file: outputPath,
      });
    }
  }
  return {
    Read: tool({
      description:
        'Read a text file with line numbers. offset is a 1-based LINE number; limit counts lines (default 2000), not characters. Lines above 2000 characters are shortened. Read existing files before Write/Edit. Do not include displayed line-number prefixes in Edit.old_string. Start development tasks by reading /docs/agent-guide.md.',
      inputSchema: z.strictObject({
        file_path: filePath,
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(2000).optional(),
      }),
      execute: (input, { abortSignal }) =>
        options.execute('Read', input, () => files.read(input), abortSignal),
    }),
    Write: tool({
      description:
        'Create or overwrite an entire text file. Parameters follow Claude Code: file_path and content. Read an existing file first; the harness tracks its revision and rejects concurrent changes. Prefer Edit for partial changes. Returns revision metadata, not another copy of the source.',
      inputSchema: z.strictObject({ file_path: filePath, content: string.max(2 * 1024 * 1024) }),
      execute: (input, { abortSignal }) =>
        options.execute('Write', input, () => files.write(input), abortSignal),
    }),
    Edit: tool({
      description:
        'Exact string replacement in a previously read/written file. Preserve whitespace and indentation in old_string. It must match exactly once unless replace_all:true. No regex/fuzzy edits. The harness tracks revisions; reread on conflict instead of overwriting manual edits.',
      inputSchema: z.strictObject({
        file_path: filePath,
        old_string: string.min(1),
        new_string: string,
        replace_all: z.boolean().optional(),
      }),
      execute: (input, { abortSignal }) =>
        options.execute('Edit', input, () => files.edit(input), abortSignal),
    }),
    Glob: tool({
      description:
        'Find virtual files by glob pattern, e.g. **/*.user.js. path scopes a directory (default /workspace); use path:"/source" for loaded page HTML/CSS/JS and runtime scripts. Supports **, *, ?, classes and braces. Returns matching absolute paths sorted by modification time, at most 1000 files. Use returned source paths; relist after navigation/context_changed.',
      inputSchema: z.strictObject({ pattern: string.min(1).max(1024), path: string.optional() }),
      execute: (input, { abortSignal }) =>
        options.execute('Glob', input, () => files.glob(input), abortSignal),
    }),
    Grep: tool({
      description:
        'Search file contents with RE2 regex syntax (no backreferences/lookarounds). path scopes a file/directory, default /workspace. glob/type filter files. output_mode defaults to files_with_matches; content includes line numbers, count counts matching lines per file. Supports context, case-insensitive, multiline and pagination. head_limit:0 requests all subject to a 1000-entry cap.',
      inputSchema: z.strictObject({
        pattern: string.min(1).max(2048),
        path: string.optional(),
        glob: string.max(1024).optional(),
        type: string.optional(),
        output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
        '-i': z.boolean().optional(),
        '-n': z.boolean().optional(),
        '-o': z.boolean().optional(),
        '-A': contextLines,
        '-B': contextLines,
        '-C': contextLines,
        context: contextLines,
        head_limit: z.number().int().min(0).optional(),
        offset: z.number().int().min(0).optional(),
        multiline: z.boolean().optional(),
      }),
      execute: (input, { abortSignal }) =>
        options.execute('Grep', input, () => files.grep(input, abortSignal), abortSignal),
    }),
    // Historical conversations retain their original tool parts. This alias is not advertised.
    files: tool({
      description:
        'Read docs and list/read/write/edit/search/remove text files. ALWAYS include op. Writable paths start with /workspace/, e.g. /workspace/main.user.js; /docs and /artifacts are read-only. write/edit return revision metadata without echoing content; read returns content. Read revision first; overwrite/edit/remove require expectedRevision. Start development tasks with /docs/agent-guide.md.',
      inputSchema: z.strictObject({
        op: z
          .enum(['list', 'read', 'write', 'edit', 'search', 'remove'])
          .describe('Required for EVERY call; choose exactly one operation.'),
        path: string
          .describe(
            'Absolute path. Write scripts under /workspace/, e.g. /workspace/main.user.js. Read guides under /docs/.',
          )
          .optional(),
        prefix: string.optional(),
        content: string.optional(),
        expectedRevision: string
          .describe(
            'Exact revision from read or the preceding write/edit. Required to overwrite, edit or remove an existing file. Omit only for a new file.',
          )
          .optional(),
        search: string.optional(),
        replacement: string.optional(),
        query: string.optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(64000).optional(),
      }),
      execute: (input, { abortSignal }) =>
        options.execute('files', input, () => executeFiles(options.workspace, input), abortSignal),
    }),
    repl: tool({
      description:
        'Run JavaScript with await and explicit return. Optional output_file saves the final return value as JSON to a NEW /workspace/ file and returns only file metadata; functions and state are unchanged. Existing paths are rejected before execution when possible. An error with details.replCompleted:true means code ran but output saving failed: do not rerun mutations. Call fs, browser, scripts DIRECTLY (never __hosts__). Use state across calls and await sleep(ms) for delays. No setTimeout/setInterval, shell, Node, global fetch, DOM or chrome globals in this interpreter; DOM and page timers belong inside browser.evaluate(expression). Use browser.navigate(url) for navigation and browser.reload() after installation. Read /docs/agent-guide.md before the first development operation.',
      inputSchema: z.strictObject({
        code: string.max(200000),
        timeout: z
          .number()
          .int()
          .min(50)
          .max(60000)
          .describe(
            'Total timeout in milliseconds. Default 15000, maximum 60000. No background execution.',
          )
          .optional(),
        description: string
          .max(200)
          .describe('Brief purpose of this JavaScript operation, like a command description.')
          .optional(),
        output_file: string
          .min(1)
          .describe(
            'Optional absolute NEW /workspace/ file for the final return value as JSON, e.g. /workspace/scratch/result.json. Returns path/revision/size/updatedAt without the value. Create-only; existing paths and workspace size limits still apply. Strings are JSON-quoted. Omit for the usual return behavior.',
          )
          .optional(),
      }),
      execute: (input, { abortSignal }) =>
        options.execute('repl', input, () => runRepl(input, abortSignal), abortSignal),
      toModelOutput: async ({ output }): Promise<ToolResultPart['output']> => {
        if (!options.supportsImages || !output.artifacts?.length)
          return { type: 'text', value: JSON.stringify(output) };
        const images: { type: 'image-data'; data: string; mediaType: string }[] = [];
        for (const ref of output.artifacts.slice(0, 3)) {
          const artifact = await options.workspace.db.get('artifacts', ref.id);
          if (
            !artifact ||
            artifact.workspaceId !== options.workspace.id ||
            !artifact.mimeType.startsWith('image/') ||
            artifact.size > 5 * 1024 * 1024
          )
            continue;
          const bytes = new Uint8Array(await artifact.blob.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          images.push({ type: 'image-data', data: btoa(binary), mediaType: artifact.mimeType });
        }
        return {
          type: 'content',
          value: [{ type: 'text', text: JSON.stringify(output) }, ...images],
        };
      },
    }),
  };
}
