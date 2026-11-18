import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MessageMarkdown,
  repairStreamingMarkdown,
  splitMarkdownBlocks,
} from '../src/components/markdown';

afterEach(cleanup);

describe('MessageMarkdown', () => {
  it('renders GFM tables, task lists, strikethrough and autolinks', () => {
    const { container } = render(
      <MessageMarkdown
        text={[
          '| Name | Value |',
          '| --- | --- |',
          '| a | 1 |',
          '',
          '- [x] done',
          '- [ ] todo',
          '',
          '~~old~~ see https://example.com',
        ].join('\n')}
      />,
    );
    expect(container.querySelector('.markdown-table table')).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'a' })).toBeTruthy();
    const boxes = container.querySelectorAll<HTMLInputElement>('input[type=checkbox]');
    expect([...boxes].map((box) => box.checked)).toEqual([true, false]);
    expect(container.querySelector('del')?.textContent).toBe('old');
    const link = screen.getByRole('link', { name: 'https://example.com' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('highlights JavaScript code blocks and labels the language', () => {
    const { container } = render(
      <MessageMarkdown text={'```js\nconst answer = "42"; // note\n```'} />,
    );
    expect(screen.getByText('js')).toBeTruthy();
    expect(container.querySelector('.tok-keyword')?.textContent).toBe('const');
    expect(container.querySelector('.tok-string')?.textContent).toBe('"42"');
    expect(container.querySelector('.tok-comment')?.textContent).toBe('// note');
    expect(container.querySelector('pre code')?.textContent).toBe(
      'const answer = "42"; // note',
    );
  });

  it('renders unknown languages as plain text', () => {
    const { container } = render(<MessageMarkdown text={'```\n<b>plain</b>\n```'} />);
    expect(screen.getByText('text')).toBeTruthy();
    expect(container.querySelector('pre code')?.textContent).toBe('<b>plain</b>');
    expect(container.querySelector('b')).toBeNull();
  });

  it('copies code to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    // user-event installs its own clipboard stub in setup(); replace it afterwards.
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MessageMarkdown text={'```ts\nlet x: number = 1;\n```'} />);
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('let x: number = 1;');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('drops unsafe link protocols and raw HTML', () => {
    const { container } = render(
      <MessageMarkdown text={'[click](javascript:alert(1)) <img src=x onerror=alert(1)>'} />,
    );
    expect(container.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript');
    expect(container.querySelector('img')).toBeNull();
  });

  it('keeps an unterminated code fence inside a code block while streaming', () => {
    const { container } = render(
      <MessageMarkdown streaming text={'Here:\n\n```js\nconst a = 1;\n\nconst b'} />,
    );
    expect(container.querySelector('pre code')?.textContent).toBe('const a = 1;\n\nconst b');
  });
});

describe('repairStreamingMarkdown', () => {
  it('closes open fences', () => {
    expect(repairStreamingMarkdown('```js\nfoo')).toBe('```js\nfoo\n```');
    expect(repairStreamingMarkdown('~~~~\nfoo\n')).toBe('~~~~\nfoo\n~~~~');
  });
  it('closes or drops dangling inline markers', () => {
    expect(repairStreamingMarkdown('a **bold')).toBe('a **bold**');
    expect(repairStreamingMarkdown('a **bold ')).toBe('a **bold**');
    expect(repairStreamingMarkdown('a **')).toBe('a');
    expect(repairStreamingMarkdown('use `code')).toBe('use `code`');
    expect(repairStreamingMarkdown('~~gone')).toBe('~~gone~~');
    expect(repairStreamingMarkdown('`a ** b`')).toBe('`a ** b`');
  });
  it('renders partial links as their label', () => {
    expect(repairStreamingMarkdown('see [docs](https://exa')).toBe('see docs');
  });
  it('leaves complete markdown alone', () => {
    const text = '# Title\n\n**bold** and `code`\n\n```js\nx\n```';
    expect(repairStreamingMarkdown(text)).toBe(text);
  });
});

describe('splitMarkdownBlocks', () => {
  it('splits on blank lines but keeps fences, lists and indented continuations whole', () => {
    const text = [
      'Intro',
      '',
      '```js',
      'a',
      '',
      'b',
      '```',
      '',
      '1. one',
      '',
      '2. two',
      '   more',
      '',
      '    indented',
      '',
      'End',
    ].join('\n');
    expect(splitMarkdownBlocks(text)).toEqual([
      'Intro',
      '```js\na\n\nb\n```',
      '1. one\n\n2. two\n   more\n\n    indented',
      'End',
    ]);
  });
  it('does not split documents with reference definitions', () => {
    const text = 'See [docs][1].\n\n[1]: https://example.com';
    expect(splitMarkdownBlocks(text)).toEqual([text]);
  });
});
