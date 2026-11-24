import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { ChatMessage } from '../src/components/conversation';
import type { ControllerClient } from '../src/protocol/client';

afterEach(cleanup);
it('renders actual text/tools without revealing reasoning and opens a changed file', async () => {
  const openFile = vi.fn();
  const message = {
    id: 'message',
    role: 'assistant',
    parts: [
      { type: 'reasoning', text: 'private hidden reasoning' },
      { type: 'text', text: '已完成修改。\n\n<script>window.untrusted = true;</script>' },
      {
        type: 'tool-files',
        toolCallId: 'write-file',
        state: 'output-available',
        input: { op: 'write', path: '/workspace/main.user.js', content: '// saved code' },
        output: { success: true, value: { revision: 'r1' }, durationMs: 10 },
      },
    ],
  } as UIMessage;
  const { container } = render(
    <ChatMessage message={message} openFile={openFile} client={{} as ControllerClient} />,
  );
  expect(screen.queryByText('private hidden reasoning')).toBeNull();
  expect(screen.getByText('已完成修改。')).toBeTruthy();
  expect(container.querySelector('script')).toBeNull();
  expect(screen.queryByRole('button', { name: '/workspace/main.user.js' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /write main.user.js/ }));
  await userEvent.click(screen.getByRole('button', { name: '/workspace/main.user.js' }));
  expect(openFile).toHaveBeenCalledWith('/workspace/main.user.js');
  expect(screen.getByText(/saved code/)).toBeTruthy();
  expect(screen.getByText(/"revision": "r1"/)).toBeTruthy();
});

it('opens a saved REPL output using the normalized path returned by the tool', async () => {
  const openFile = vi.fn();
  const message = {
    id: 'saved-output',
    role: 'assistant',
    parts: [
      {
        type: 'tool-repl',
        toolCallId: 'save-result',
        state: 'output-available',
        input: {
          code: 'return [1,2,3];',
          output_file: '/workspace//result.json',
          description: 'Save result',
        },
        output: {
          success: true,
          value: { path: '/workspace/result.json', revision: 'r1', size: 7, updatedAt: 1 },
          durationMs: 1,
        },
      },
    ],
  } as UIMessage;
  render(<ChatMessage message={message} openFile={openFile} client={{} as ControllerClient} />);
  await userEvent.click(screen.getByRole('button', { name: 'Save result' }));
  await userEvent.click(screen.getByRole('button', { name: '/workspace/result.json' }));
  expect(openFile).toHaveBeenCalledWith('/workspace/result.json');
});

it('opens the full automatically saved result from its virtual artifact path', async () => {
  const openFile = vi.fn();
  const artifact = {
    id: 'full-result',
    path: '/artifacts/result.json-full-result',
    mimeType: 'application/json',
    size: 20000,
  };
  const message = {
    id: 'large-output',
    role: 'assistant',
    parts: [
      {
        type: 'tool-repl',
        toolCallId: 'large',
        state: 'output-available',
        input: { code: 'return state.data;', description: 'Capture large result' },
        output: {
          success: true,
          value: { preview: 'head…tail', artifact },
          artifacts: [artifact],
          truncated: true,
          durationMs: 1,
        },
      },
    ],
  } as UIMessage;
  render(<ChatMessage message={message} openFile={openFile} client={{} as ControllerClient} />);
  await userEvent.click(screen.getByRole('button', { name: 'Capture large result' }));
  await userEvent.click(screen.getByRole('button', { name: artifact.path }));
  expect(openFile).toHaveBeenCalledWith(artifact.path);
});
