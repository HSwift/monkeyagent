import picomatch from 'picomatch';
import { RE2JS } from 're2js';
import { AgentError } from '../protocol/errors';
import { WorkspaceService, fileSummary, normalizePath } from '../workspace/service';
import type { FileRecord } from '../protocol/types';

export interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-i'?: boolean;
  '-n'?: boolean;
  '-o'?: boolean;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  context?: number;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

/** Familiar file tools; optimistic revisions stay inside the harness rather than model inputs. */
export class FileTools {
  private observed = new Map<string, string>();
  constructor(private workspace: WorkspaceService) {}
  reset() {
    this.observed.clear();
  }
  async read(input: { file_path: string; offset?: number; limit?: number }) {
    const file = await this.workspace.read(input.file_path);
    const lines = file.content.split('\n');
    const offset = input.offset ?? 1;
    const limit = input.limit ?? 2000;
    const selected = lines.slice(offset - 1, offset - 1 + limit);
    let characters = 0;
    const rendered: string[] = [];
    let shortenedLine = false;
    for (let i = 0; i < selected.length; i++) {
      const line = selected[i];
      const text = `${String(offset + i).padStart(6)}→${line.slice(0, 2000)}`;
      if (characters + text.length + 1 > 64000) break;
      shortenedLine ||= line.length > 2000;
      rendered.push(text);
      characters += text.length + 1;
    }
    this.observed.set(file.path, file.revision);
    return {
      file_path: file.path,
      revision: file.revision,
      offset,
      total_lines: lines.length,
      content: rendered.join('\n'),
      truncated: shortenedLine || offset + rendered.length - 1 < lines.length,
      ...(offset + rendered.length - 1 < lines.length
        ? { next_offset: offset + rendered.length }
        : {}),
      ...(shortenedLine
        ? {
            notice:
              'Lines above 2000 characters are shortened. Use fs.read(path,{offset,limit}) for character ranges.',
          }
        : {}),
    };
  }
  private async current(path: string): Promise<FileRecord> {
    const file = await this.workspace.read(path);
    const revision = this.observed.get(file.path);
    if (!revision)
      throw new AgentError(
        'file_not_read',
        `Read ${file.path} before modifying this existing file.`,
      );
    if (revision !== file.revision)
      throw new AgentError(
        'conflict',
        `${file.path} changed since you last read it. Read it again and reconcile the changes.`,
      );
    return file;
  }
  async write(input: { file_path: string; content: string }) {
    const path = normalizePath(input.file_path);
    let revision: string | undefined;
    try {
      revision = (await this.current(path)).revision;
    } catch (error) {
      if (!(error instanceof AgentError && error.code === 'not_found')) throw error;
    }
    const file = await this.workspace.write(path, input.content, revision);
    this.observed.set(file.path, file.revision);
    return fileSummary(file);
  }
  async edit(input: {
    file_path: string;
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }) {
    if (!input.old_string || input.old_string === input.new_string)
      throw new AgentError(
        'invalid_input',
        'old_string must be nonempty and different from new_string.',
      );
    const file = await this.current(input.file_path);
    const pieces = file.content.split(input.old_string);
    const matches = pieces.length - 1;
    if (!matches)
      throw new AgentError(
        'old_string_not_found',
        'old_string must match current source exactly, including whitespace. Read the file again.',
      );
    if (matches > 1 && !input.replace_all)
      throw new AgentError(
        'ambiguous_edit',
        `${matches} occurrences found. Include more surrounding context or set replace_all:true.`,
      );
    const content = input.replace_all
      ? pieces.join(input.new_string)
      : file.content.replace(input.old_string, () => input.new_string);
    const edited = await this.workspace.write(file.path, content, file.revision);
    this.observed.set(edited.path, edited.revision);
    return { ...fileSummary(edited), replacements: input.replace_all ? matches : 1 };
  }
  private async candidates(path = '/workspace') {
    const root = normalizePath(path).replace(/\/$/, '');
    const files = (await this.workspace.list(root)).filter(
      (file) => file.path === root || file.path.startsWith(root + '/'),
    );
    if (!files.length && root.startsWith('/artifacts/')) {
      const file = await this.workspace.read(root);
      return { root, files: [fileSummary(file)] };
    }
    return { root, files };
  }
  async glob(input: { pattern: string; path?: string }) {
    const { root, files } = await this.candidates(input.path);
    const match = picomatch(input.pattern, { dot: true, maxLength: 1024 });
    const matches = files
      .filter((file) =>
        match(input.pattern.startsWith('/') ? file.path : file.path.slice(root.length + 1)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path));
    return {
      files: matches.slice(0, 1000).map((file) => file.path),
      truncated: matches.length > 1000,
    };
  }
  async grep(input: GrepInput, signal?: AbortSignal) {
    const { root, files } = await this.candidates(input.path);
    const extensions: Record<string, string> = {
      js: '**/*.{js,jsx,mjs,cjs}',
      ts: '**/*.{ts,tsx}',
      json: '**/*.json',
      css: '**/*.css',
      html: '**/*.{html,htm}',
      md: '**/*.md',
    };
    if (input.type && !extensions[input.type])
      throw new AgentError(
        'invalid_input',
        'Supported type filters: js, ts, json, css, html, md. Use glob for other extensions.',
      );
    let regex: RE2JS;
    try {
      regex = RE2JS.compile(
        input.pattern,
        (input['-i'] ? RE2JS.CASE_INSENSITIVE : 0) |
          (input.multiline ? RE2JS.MULTILINE | RE2JS.DOTALL : 0),
      );
    } catch (error) {
      throw new AgentError(
        'invalid_pattern',
        `Grep uses RE2 syntax without backreferences/lookarounds: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const glob = input.glob ? picomatch(input.glob, { dot: true, maxLength: 1024 }) : undefined;
    const type = input.type ? picomatch(extensions[input.type], { dot: true }) : undefined;
    const entries: {
      file_path: string;
      line?: number;
      text?: string;
      count?: number;
      is_match?: boolean;
    }[] = [];
    const mode = input.output_mode ?? 'files_with_matches';
    let total = 0;
    for (const item of files) {
      signal?.throwIfAborted();
      const relative = item.path.slice(root.length + 1) || item.path.split('/').pop()!;
      const name = item.path.split('/').pop()!;
      if ((glob && !glob(relative) && !glob(name)) || (type && !type(relative) && !type(name)))
        continue;
      const file = await this.workspace.read(item.path);
      const lines = file.content.split('\n');
      const matched = new Map<number, string>();
      if (input.multiline) {
        const matcher = regex.matcher(file.content);
        while (matcher.find()) {
          const start = file.content.slice(0, matcher.start()).split('\n').length - 1;
          const end =
            file.content.slice(0, Math.max(matcher.start(), matcher.end() - 1)).split('\n').length -
            1;
          for (let line = start; line <= end; line++) matched.set(line, lines[line]);
        }
      } else {
        lines.forEach((line, i) => {
          if (!regex.test(line)) return;
          if (input['-o']) {
            const matcher = regex.matcher(line);
            const parts: string[] = [];
            while (matcher.find()) parts.push(matcher.group() ?? '');
            matched.set(i, parts.join(' '));
          } else matched.set(i, line);
        });
      }
      if (!matched.size) continue;
      total += matched.size;
      if (mode === 'files_with_matches') entries.push({ file_path: file.path });
      else if (mode === 'count') entries.push({ file_path: file.path, count: matched.size });
      else {
        const context = input.context ?? input['-C'] ?? 0;
        const before = input['-B'] ?? context;
        const after = input['-A'] ?? context;
        const selected = new Set<number>();
        for (const line of matched.keys())
          for (
            let i = Math.max(0, line - before);
            i <= Math.min(lines.length - 1, line + after);
            i++
          )
            selected.add(i);
        for (const line of [...selected].sort((a, b) => a - b))
          entries.push({
            file_path: file.path,
            ...(input['-n'] !== false ? { line: line + 1 } : {}),
            text: (matched.get(line) ?? lines[line]).slice(0, 2000),
            is_match: matched.has(line),
          });
      }
    }
    const offset = input.offset ?? 0;
    const requestedLimit = input.head_limit === 0 ? 1000 : (input.head_limit ?? 200);
    const limit = Math.min(requestedLimit, 1000);
    return {
      output_mode: mode,
      results: entries.slice(offset, offset + limit),
      total_matches: total,
      total_results: entries.length,
      truncated: offset + limit < entries.length,
      ...(offset >= entries.length && total > 0
        ? { message: 'No entries at this offset. Reset or reduce offset; the pattern does match.' }
        : {}),
    };
  }
}
