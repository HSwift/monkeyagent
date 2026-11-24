import picomatch from 'picomatch';
import { RE2JS } from 're2js';
import { AgentError } from '../protocol/errors';
import { WorkspaceService, fileSummary, normalizePath } from '../workspace/service';
import type { FileRecord } from '../protocol/types';
import { SOURCE_SCAN_BYTES } from '../workspace/source';

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
  char_context?: number;
  head_limit?: number;
  offset?: number;
  multiline?: boolean;
}

interface GrepEntry {
  file_path: string;
  line?: number;
  text?: string;
  count?: number;
  is_match?: boolean;
  revision?: string;
  offset?: number;
  window_start?: number;
  match_length?: number;
  truncated?: boolean;
}

interface GrepResult {
  search_complete?: boolean;
  scanned_bytes?: number;
  skipped_count?: number;
  skipped?: { file_path: string; reason: string }[];
  output_mode: NonNullable<GrepInput['output_mode']>;
  output_mode_detail?: 'char_window';
  results: GrepEntry[];
  total_matches: number;
  total_results: number;
  truncated: boolean;
  next_offset?: number;
  truncation_reason?: 'output_budget' | 'head_limit';
  message?: string;
}

const WINDOW_OUTPUT_BYTES = 16 * 1024;
const WINDOW_ENTRY_BYTES = WINDOW_OUTPUT_BYTES - 1024; // Reserve the result envelope and tool metadata.
const WINDOW_TEXT_CHARS = 4000;
const utf8 = new TextEncoder();

function characterWindow(file: FileRecord, start: number, end: number, context: number) {
  const desiredStart = Math.max(0, start - context);
  const desiredEnd = Math.min(file.content.length, end + context);
  const makeEntry = (maxChars: number) => {
    const length = Math.min(desiredEnd - desiredStart, maxChars);
    const before = Math.min(
      start - desiredStart,
      Math.floor((length - Math.min(end - start, length)) / 2),
    );
    const windowStart = Math.max(desiredStart, Math.min(start - before, desiredEnd - length));
    const windowEnd = windowStart + length;
    return {
      file_path: file.path,
      revision: file.revision,
      offset: start,
      window_start: windowStart,
      match_length: end - start,
      text: file.content.slice(windowStart, windowEnd),
      is_match: true,
      truncated: windowStart > desiredStart || windowEnd < desiredEnd,
    };
  };
  let entry = makeEntry(WINDOW_TEXT_CHARS);
  let bytes = utf8.encode(JSON.stringify(entry)).length;
  if (bytes > WINDOW_ENTRY_BYTES) {
    let low = end > start ? 1 : 0;
    let high = entry.text.length;
    if (utf8.encode(JSON.stringify(makeEntry(low))).length > WINDOW_ENTRY_BYTES)
      throw new AgentError(
        'size_limit',
        'The match metadata exceeds the character-window output budget.',
      );
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (utf8.encode(JSON.stringify(makeEntry(middle))).length <= WINDOW_ENTRY_BYTES) low = middle;
      else high = middle - 1;
    }
    entry = makeEntry(low);
    bytes = utf8.encode(JSON.stringify(entry)).length;
  }
  return { entry, bytes };
}

function* searchChunks(content: string, multiline: boolean) {
  if (multiline) {
    yield { text: content, offset: 0 };
    return;
  }
  let offset = 0;
  for (;;) {
    const newline = content.indexOf('\n', offset);
    yield { text: content.slice(offset, newline < 0 ? content.length : newline), offset };
    if (newline < 0) return;
    offset = newline + 1;
  }
}

/** Familiar file tools; optimistic revisions stay inside the harness rather than model inputs. */
export class FileTools {
  private observed = new Map<string, string>();
  constructor(private workspace: WorkspaceService) {}
  reset() {
    this.observed.clear();
  }
  async read(input: { file_path: string; offset?: number; limit?: number }) {
    const path = normalizePath(input.file_path);
    const file = await this.workspace.readForSearch(path);
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
      ...('sourceUrl' in file ? { sourceUrl: file.sourceUrl } : {}),
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
              'Lines above 2000 characters are shortened. Use Grep with output_mode:"content",char_context:200 for match windows, or fs.read(path,{offset,limit}) for character ranges.',
          }
        : {}),
    };
  }
  private async current(path: string): Promise<FileRecord> {
    path = normalizePath(path);
    if (path === '/artifacts' || path.startsWith('/artifacts/'))
      throw new AgentError(
        'read_only',
        'Tool-result artifacts are read-only. Copy data to /workspace/ before editing.',
      );
    if (path === '/source' || path.startsWith('/source/'))
      throw new AgentError(
        'read_only',
        'Page sources are read-only. Copy source to /workspace/ before editing.',
      );
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
  async grep(input: GrepInput, signal?: AbortSignal): Promise<GrepResult> {
    const mode = input.output_mode ?? 'files_with_matches';
    if (input.char_context !== undefined) {
      if (
        !Number.isInteger(input.char_context) ||
        input.char_context < 0 ||
        input.char_context > 2000
      )
        throw new AgentError(
          'invalid_input',
          'char_context must be an integer between 0 and 2000.',
        );
      if (mode !== 'content')
        throw new AgentError('invalid_input', 'char_context requires output_mode:"content".');
      if (
        ['-o', '-A', '-B', '-C', 'context'].some(
          (key) => input[key as keyof GrepInput] !== undefined,
        )
      )
        throw new AgentError(
          'invalid_input',
          'char_context cannot be combined with -o, -A, -B, -C or context.',
        );
    }
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
    const accepts = (item: { path: string }) => {
      const relative = item.path.slice(root.length + 1) || item.path.split('/').pop()!;
      const name = item.path.split('/').pop()!;
      return (!glob || glob(relative) || glob(name)) && (!type || type(relative) || type(name));
    };
    const scan = this.sourceScan(signal, root === '/source' || root.startsWith('/source/'));
    if (input.char_context !== undefined) {
      const result = await this.grepCharacterWindows(
        input,
        files.filter(accepts),
        regex,
        input.char_context,
        signal,
        scan.read,
      );
      return { ...result, ...scan.report() };
    }
    const entries: GrepEntry[] = [];
    let total = 0;
    for (const item of files) {
      signal?.throwIfAborted();
      if (!accepts(item)) continue;
      const file = await scan.read(item.path, false);
      if (!file) continue;
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
      ...scan.report(),
      ...(offset >= entries.length && total > 0
        ? { message: 'No entries at this offset. Reset or reduce offset; the pattern does match.' }
        : {}),
    };
  }

  private async grepCharacterWindows(
    input: GrepInput,
    files: { path: string }[],
    regex: RE2JS,
    context: number,
    signal?: AbortSignal,
    read: (path: string, full: boolean) => Promise<FileRecord | undefined> = (path) =>
      this.workspace.readForSearch(path),
  ): Promise<GrepResult> {
    const offset = input.offset ?? 0;
    const limit = Math.min(input.head_limit === 0 ? 1000 : (input.head_limit ?? 200), 1000);
    const results: GrepEntry[] = [];
    let total = 0;
    let outputBytes = 0;
    let budgetReached = false;
    let work = 0;
    for (const item of files) {
      signal?.throwIfAborted();
      const file = await read(item.path, true);
      if (!file) continue;
      for (const chunk of searchChunks(file.content, !!input.multiline)) {
        signal?.throwIfAborted();
        const matcher = regex.matcher(chunk.text);
        while (matcher.find()) {
          const index = total++;
          if (index >= offset && results.length < limit && !budgetReached) {
            const { entry, bytes } = characterWindow(
              file,
              chunk.offset + matcher.start(),
              chunk.offset + matcher.end(),
              context,
            );
            const additionalBytes = bytes + (results.length ? 1 : 0);
            if (outputBytes + additionalBytes > WINDOW_ENTRY_BYTES) budgetReached = true;
            else {
              results.push(entry);
              outputBytes += additionalBytes;
            }
          }
          // Yield even after filling the page: counting dense/zero-length matches must remain cancellable.
          if (++work % 2048 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            signal?.throwIfAborted();
          }
        }
        if (++work % 2048 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          signal?.throwIfAborted();
        }
      }
    }
    signal?.throwIfAborted();
    const next = offset + results.length;
    const truncated = next < total;
    return {
      output_mode: 'content',
      output_mode_detail: 'char_window',
      results,
      total_matches: total,
      total_results: total,
      truncated,
      ...(truncated
        ? {
            next_offset: next,
            truncation_reason: budgetReached ? ('output_budget' as const) : ('head_limit' as const),
          }
        : {}),
      ...(offset >= total && total > 0
        ? { message: 'No entries at this offset. Reset or reduce offset; the pattern does match.' }
        : {}),
    };
  }

  private sourceScan(signal?: AbortSignal, used = false) {
    let bytes = 0;
    let skippedCount = 0;
    const started = Date.now();
    const skipped: { file_path: string; reason: string }[] = [];
    const skip = (path: string, reason: string) => {
      skippedCount++;
      const item = { file_path: path, reason };
      // Keep the search report within the character-window envelope reservation.
      if (utf8.encode(JSON.stringify([...skipped, item])).length <= 650) skipped.push(item);
    };
    return {
      read: async (path: string, full: boolean): Promise<FileRecord | undefined> => {
        signal?.throwIfAborted();
        if (!path.startsWith('/source/'))
          return full || path.startsWith('/artifacts/')
            ? this.workspace.readForSearch(path)
            : this.workspace.read(path);
        used = true;
        if (bytes >= SOURCE_SCAN_BYTES || Date.now() - started > 30000) {
          skip(path, bytes >= SOURCE_SCAN_BYTES ? 'scan_budget' : 'time_budget');
          return;
        }
        try {
          const file = await this.workspace.readForSearch(path);
          signal?.throwIfAborted();
          const size = utf8.encode(file.content).length;
          if (bytes + size > SOURCE_SCAN_BYTES) {
            skip(path, 'scan_budget');
            return;
          }
          bytes += size;
          return file;
        } catch (error) {
          signal?.throwIfAborted();
          if (
            error instanceof AgentError &&
            !['context_changed', 'debugger_detached', 'attach_failed'].includes(error.code)
          ) {
            skip(path, error.code);
            return;
          }
          throw error;
        }
      },
      report: () =>
        used
          ? {
              search_complete: skippedCount === 0,
              scanned_bytes: bytes,
              skipped_count: skippedCount,
              skipped,
            }
          : {},
    };
  }
}
