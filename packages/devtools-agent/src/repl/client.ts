import { AgentError, errorData } from '../protocol/errors';
import type { HostCall } from './runtime';
import type { ToolResult } from '../protocol/types';

export class ReplClient {
  private worker?: Worker;
  private active?: { id: string; reject: (error: Error) => void };
  warnings: NonNullable<ToolResult['warnings']> = [];
  constructor(private host: HostCall) {}
  async run(code: string, timeoutMs = 15000, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.active) throw new AgentError('busy', 'REPL is already running.');
    this.warnings = [];
    timeoutMs = Math.min(Math.max(timeoutMs, 50), 60000);
    const worker = (this.worker ??= new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    }));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        worker.removeEventListener('message', message);
        worker.removeEventListener('error', failed);
        this.active = undefined;
      };
      const fail = (error: Error) => {
        cleanup();
        this.reset();
        reject(error);
      };
      const cancel = () =>
        fail(
          new AgentError(
            'aborted',
            'REPL cancelled. In-memory state was reset. Dispatched host operations may still complete.',
          ),
        );
      const failed = (event: ErrorEvent) => fail(new AgentError('worker_failed', event.message));
      const timer = setTimeout(
        () => fail(new AgentError('timeout', 'REPL deadline exceeded. In-memory state was reset.')),
        timeoutMs + 500,
      );
      const message = async (event: MessageEvent) => {
        const data = event.data;
        if (data.type === 'host') {
          if (this.active?.id !== id) return;
          try {
            signal?.throwIfAborted();
            const value = await this.host(data.method, data.args);
            if (this.active?.id === id)
              worker.postMessage({ type: 'host-result', id: data.id, value });
          } catch (error) {
            if (this.active?.id === id)
              worker.postMessage({ type: 'host-result', id: data.id, error: errorData(error) });
          }
        } else if (data.type === 'result' && data.id === id) {
          this.warnings = data.warnings ?? [];
          cleanup();
          if (data.error) {
            if (/interrupted|out of memory|memory limit/i.test(data.error.message)) this.reset();
            reject(new AgentError(data.error.code, data.error.message, data.error.details));
          } else resolve(data.value);
        }
      };
      this.active = { id, reject: fail };
      worker.addEventListener('message', message);
      worker.addEventListener('error', failed);
      signal?.addEventListener('abort', cancel, { once: true });
      worker.postMessage({ type: 'run', id, code, timeoutMs });
    });
  }
  stop() {
    this.active?.reject(new AgentError('aborted', 'REPL stopped. In-memory state was reset.'));
    this.reset();
  }
  private reset() {
    this.worker?.terminate();
    this.worker = undefined;
  }
}
