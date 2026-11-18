import type { UIMessage } from 'ai';

/** A user message queued while a run was active and consumed at the start of `step`. */
export interface Injection {
  id: string;
  text: string;
  /** 0-based step number whose input first included the message. */
  step: number;
  /** Index in that step's model input where the message was inserted. */
  at: number;
}

export function injectionMessage(injection: Pick<Injection, 'id' | 'text'>): UIMessage {
  return { id: injection.id, role: 'user', parts: [{ type: 'text', text: injection.text }] };
}

/**
 * Splits a run's single assistant message at the steps where queued user messages were consumed,
 * so each message appears where the agent actually received it instead of after the whole reply.
 * Every step of the UI stream starts with a `step-start` part, which marks the split points.
 * The first segment keeps the assistant message id so streaming updates stay attached.
 */
export function interleave(
  assistant: UIMessage | undefined,
  injections: readonly Injection[],
): UIMessage[] {
  if (!assistant) return injections.map(injectionMessage);
  if (!injections.length) return [assistant];
  const starts: number[] = [];
  assistant.parts.forEach((part, index) => {
    if (part.type === 'step-start') starts.push(index);
  });
  const result: UIMessage[] = [];
  let from = 0;
  let segments = 0;
  const pushSegment = (to: number) => {
    const parts = assistant.parts.slice(from, to);
    from = to;
    if (!parts.some((part) => part.type !== 'step-start')) return;
    result.push({ ...assistant, id: segments ? `${assistant.id}-${segments}` : assistant.id, parts });
    segments++;
  };
  // Stable sort keeps the queue order for messages consumed at the same step.
  for (const injection of [...injections].sort((a, b) => a.step - b.step)) {
    // While streaming, the step may not have started in the UI yet; show the message at the end.
    pushSegment(Math.max(from, starts[injection.step] ?? assistant.parts.length));
    result.push(injectionMessage(injection));
  }
  pushSegment(assistant.parts.length);
  return result;
}

/**
 * Re-inserts consumed user messages into a step's model input. The SDK rebuilds each step's input
 * from the initial messages plus response messages, so a message returned by one prepareStep would
 * otherwise be forgotten by later steps. `at` indices refer to the un-injected input, which only
 * grows by appending, so they stay valid.
 */
export function applyInjections<M extends { role: string }>(
  stepMessages: readonly M[],
  injections: readonly Injection[],
  toMessage: (text: string) => M,
): M[] {
  const result = [...stepMessages];
  let offset = 0;
  for (const injection of [...injections].sort((a, b) => a.at - b.at)) {
    result.splice(Math.min(injection.at, stepMessages.length) + offset, 0, toMessage(injection.text));
    offset++;
  }
  return result;
}
