import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { classHighlighter, highlightCode } from '@lezer/highlight';
import {
  javascriptLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
} from '@codemirror/lang-javascript';
import { Check, Copy } from 'lucide-react';

/* ------------------------------------------------------------------------------------------------
 * Streaming helpers
 * ---------------------------------------------------------------------------------------------- */

const FENCE = /^\s*(`{3,}|~{3,})/;
const LIST_ITEM = /^\s{0,3}([-*+]|\d{1,9}[.)])\s/;
const REFERENCE_DEFINITION = /^\s{0,3}\[[^\]]+\]:\s/m;

/** Advances fenced-code state by one line; returns the open fence marker ('' when outside). */
function nextFence(line: string, fence: string) {
  const match = FENCE.exec(line);
  if (!match) return fence;
  if (!fence) return match[1];
  const closes =
    match[1][0] === fence[0] &&
    match[1].length >= fence.length &&
    !line.trim().slice(match[1].length).trim();
  return closes ? '' : fence;
}

/** Returns the opening fence marker if `text` ends inside an unterminated fenced code block. */
function openFence(text: string) {
  let fence = '';
  for (const line of text.split('\n')) fence = nextFence(line, fence);
  return fence;
}

/** Counts `token` outside inline code spans in a single paragraph. */
function countOutsideCode(text: string, token: string) {
  let count = 0;
  for (const [index, piece] of text.split('`').entries())
    if (index % 2 === 0) count += piece.split(token).length - 1;
  return count;
}

/**
 * Closes markdown constructs left open by a partially streamed reply so the renderer doesn't
 * flicker between layouts while tokens arrive. Only the trailing paragraph is repaired.
 */
export function repairStreamingMarkdown(text: string) {
  const fence = openFence(text);
  if (fence) return `${text}${text.endsWith('\n') ? '' : '\n'}${fence}`;
  const lastBreak = text.lastIndexOf('\n\n');
  const start = lastBreak < 0 ? 0 : lastBreak + 2;
  let tail = text.slice(start);
  // An unfinished link `[label](https://exa` renders as its label until the URL is complete.
  tail = tail.replace(/\[([^\]\n]*)\]\([^)\s]*$/, '$1');
  // Close an unmatched opener, or drop it if nothing has streamed after it yet.
  const close = (marker: string) => {
    const trimmed = tail.trimEnd();
    tail = trimmed.endsWith(marker)
      ? trimmed.slice(0, -marker.length).trimEnd()
      : trimmed + marker;
  };
  if ((tail.split('`').length - 1) % 2) close('`');
  if (countOutsideCode(tail, '**') % 2) close('**');
  if (countOutsideCode(tail, '~~') % 2) close('~~');
  return text.slice(0, start) + tail;
}

/**
 * Splits markdown into independently renderable top-level blocks (blank-line separated, fences
 * kept whole) so that only the last block re-renders while a reply streams.
 */
export function splitMarkdownBlocks(text: string): string[] {
  // Reference-style links/footnotes resolve across the whole document; render as one block.
  if (REFERENCE_DEFINITION.test(text)) return [text];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence = '';
  const flush = () => {
    if (!current.length) return;
    const block = current.join('\n');
    const previous = blocks[blocks.length - 1];
    const continuation =
      previous !== undefined &&
      (/^\s/.test(block) || (LIST_ITEM.test(block) && LIST_ITEM.test(previous)));
    if (continuation) blocks[blocks.length - 1] = `${previous}\n\n${block}`;
    else blocks.push(block);
    current = [];
  };
  for (const line of text.split('\n')) {
    const inside = !!fence;
    fence = nextFence(line, fence);
    if (!inside && !fence && !line.trim()) flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

/* ------------------------------------------------------------------------------------------------
 * Code blocks
 * ---------------------------------------------------------------------------------------------- */

const MAX_HIGHLIGHT_LENGTH = 100_000;
const PARSERS: Record<string, typeof javascriptLanguage.parser> = {
  js: javascriptLanguage.parser,
  javascript: javascriptLanguage.parser,
  mjs: javascriptLanguage.parser,
  cjs: javascriptLanguage.parser,
  userscript: javascriptLanguage.parser,
  json: javascriptLanguage.parser,
  jsonc: javascriptLanguage.parser,
  json5: javascriptLanguage.parser,
  jsx: jsxLanguage.parser,
  ts: typescriptLanguage.parser,
  typescript: typescriptLanguage.parser,
  tsx: tsxLanguage.parser,
};

function highlight(code: string, language: string): ReactNode {
  const parser = PARSERS[language];
  if (!parser || code.length > MAX_HIGHLIGHT_LENGTH) return code;
  const nodes: ReactNode[] = [];
  highlightCode(
    code,
    parser.parse(code),
    classHighlighter,
    (text, classes) =>
      nodes.push(
        classes ? (
          <span key={nodes.length} className={classes}>
            {text}
          </span>
        ) : (
          text
        ),
      ),
    () => nodes.push('\n'),
  );
  return nodes;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // DevTools panels often lack clipboard-write permission; fall back to a selection copy.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('Copy failed');
}

export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const highlighted = useMemo(() => highlight(code, language), [code, language]);
  async function copy() {
    try {
      await copyText(code);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-block-language">{language || 'text'}</span>
        <button
          type="button"
          className="code-block-copy"
          onClick={() => void copy()}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code className={language ? `language-${language}` : undefined}>{highlighted}</code>
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Markdown
 * ---------------------------------------------------------------------------------------------- */

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

const components: Components = {
  pre({ node }) {
    const code = (node as unknown as HastNode | undefined)?.children?.find(
      (child) => child.type === 'element' && child.tagName === 'code',
    );
    const classes = code?.properties?.className;
    const language =
      (Array.isArray(classes) ? classes : [])
        .map(String)
        .find((name) => name.startsWith('language-'))
        ?.slice('language-'.length)
        .toLowerCase() ?? '';
    return <CodeBlock code={hastText(code).replace(/\n$/, '')} language={language} />;
  },
  a({ node: _node, children, ...props }) {
    return (
      <a {...props} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  table({ node: _node, ...props }) {
    return (
      <div className="markdown-table">
        <table {...props} />
      </div>
    );
  },
};

const REMARK_PLUGINS = [remarkGfm];

const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} components={components}>
      {text}
    </Markdown>
  );
});

export function MessageMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(
    () => splitMarkdownBlocks(streaming ? repairStreamingMarkdown(text) : text),
    [text, streaming],
  );
  return (
    <div className="markdown">
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} text={block} />
      ))}
    </div>
  );
}
