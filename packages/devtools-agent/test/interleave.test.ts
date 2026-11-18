import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { applyInjections, interleave, type Injection } from '../src/agent/interleave';

const step = { type: 'step-start' } as const;
const text = (value: string) => ({ type: 'text', text: value }) as const;
const assistant: UIMessage = {
  id: 'a',
  role: 'assistant',
  parts: [step, text('step 0'), step, text('step 1'), step, text('step 2')],
};
const injection = (id: string, stepNumber: number, at = 0): Injection => ({
  id,
  text: id,
  step: stepNumber,
  at,
});
const shape = (messages: UIMessage[]) =>
  messages.map((message) => [
    message.id,
    message.role,
    message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(','),
  ]);

describe('interleave', () => {
  it('places a consumed message before the step that received it', () => {
    expect(shape(interleave(assistant, [injection('q1', 2)]))).toEqual([
      ['a', 'assistant', 'step 0,step 1'],
      ['q1', 'user', 'q1'],
      ['a-1', 'assistant', 'step 2'],
    ]);
  });

  it('keeps queue order and handles several split points', () => {
    expect(
      shape(interleave(assistant, [injection('q2', 2), injection('q1', 1), injection('q3', 2)])),
    ).toEqual([
      ['a', 'assistant', 'step 0'],
      ['q1', 'user', 'q1'],
      ['a-1', 'assistant', 'step 1'],
      ['q2', 'user', 'q2'],
      ['q3', 'user', 'q3'],
      ['a-2', 'assistant', 'step 2'],
    ]);
  });

  it('shows a message at the end while its step has not streamed yet', () => {
    expect(shape(interleave(assistant, [injection('q1', 5)]))).toEqual([
      ['a', 'assistant', 'step 0,step 1,step 2'],
      ['q1', 'user', 'q1'],
    ]);
  });

  it('drops empty segments and handles a missing assistant message', () => {
    const early: UIMessage = { id: 'a', role: 'assistant', parts: [step] };
    expect(shape(interleave(early, [injection('q1', 0)]))).toEqual([['q1', 'user', 'q1']]);
    expect(shape(interleave(undefined, [injection('q1', 0)]))).toEqual([['q1', 'user', 'q1']]);
    expect(interleave(assistant, [])).toEqual([assistant]);
  });
});

describe('applyInjections', () => {
  it('re-inserts every consumed message at its original model-input position', () => {
    const toMessage = (content: string) => ({ role: 'user', content });
    const messages = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'a0' },
      { role: 'tool', content: 't0' },
      { role: 'assistant', content: 'a1' },
      { role: 'tool', content: 't1' },
    ];
    expect(
      applyInjections(messages, [injection('q1', 1, 3), injection('q2', 2, 5)], toMessage).map(
        (message) => message.content,
      ),
    ).toEqual(['task', 'a0', 't0', 'q1', 'a1', 't1', 'q2']);
  });
});
