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
