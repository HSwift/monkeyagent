import type { AgentErrorData } from './types';

export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentError';
  }
}
export function errorData(error: unknown): AgentErrorData {
  return {
    code:
      error instanceof AgentError
        ? error.code
        : error instanceof DOMException && error.name === 'AbortError'
          ? 'aborted'
          : error instanceof Error && /^[a-z][a-z_]+$/.test(error.name)
            ? error.name
            : 'error',
    message: error instanceof Error ? error.message : String(error),
  };
}
export function aborted(signal?: AbortSignal) {
  signal?.throwIfAborted();
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0 || ms > 60000)
    throw new AgentError('invalid_input', 'sleep(ms) requires 0–60000 milliseconds.');
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const cancel = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(signal?.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

/** A single lane shared by model tools, the editor's install actions and manual REPL. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  size = 0;
  async onIdle() {
    await this.tail;
  }
  execute<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.size++;
    const result = this.tail
      .then(() => {
        aborted(signal);
        return task();
      })
      .finally(() => {
        this.size--;
      });
    this.tail = result.catch(() => {});
    return result;
  }
}
