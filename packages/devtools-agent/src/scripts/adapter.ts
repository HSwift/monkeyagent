import type { ScriptSnapshot, ScriptStoreAdapter, ScriptSummary } from '../protocol/types';
import { AgentError } from '../protocol/errors';

/** This transport is the only dependency on the host extension. */
export class ExtensionScriptStore implements ScriptStoreAdapter {
  private async call<T>(op: string, args: unknown): Promise<T> {
    const result = await chrome.runtime.sendMessage({
      cmd: 'monkeyagent:scripts:v1',
      data: { op, args },
    });
    if (!result)
      throw new AgentError('host_unavailable', 'The host script adapter is unavailable.');
    // Monkey's own-command transport wraps responses as [value, error]. The independent
    // fixture uses a native {value, error} envelope. No host runtime is imported here.
    if (Array.isArray(result)) {
      if (result[1]) throw new AgentError('host_error', String(result[1][0] ?? result[1]));
      return result[0] as T;
    }
    if (result.error) throw new AgentError(result.error.code ?? 'host_error', result.error.message);
    return result.value as T;
  }
  list() {
    return this.call<ScriptSummary[]>('list', {});
  }
  get(id: string) {
    return this.call<ScriptSnapshot>('get', { id });
  }
  save(input: { id?: string; code: string }) {
    return this.call<ScriptSnapshot>('save', input);
  }
  setEnabled(id: string, enabled: boolean) {
    return this.call<void>('setEnabled', { id, enabled });
  }
}
