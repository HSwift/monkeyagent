import type { ScriptSnapshot, ScriptStoreAdapter } from '../protocol/types';
import { AgentError } from '../protocol/errors';

/** No injection emulation: real injection is tested with the built Monkey extension. */
export class MockScriptStore implements ScriptStoreAdapter {
  private data = new Map<string, ScriptSnapshot>();
  async list() {
    return [...this.data.values()].map(({ id, name, enabled }) => ({ id, name, enabled }));
  }
  async get(id: string) {
    const data = this.data.get(id);
    if (!data) throw new AgentError('not_found', 'Script not found.');
    return { ...data };
  }
  async save(input: { id?: string; code: string }) {
    const name = input.code.match(/\/\/\s*@name\s+(.+)/)?.[1]?.trim();
    if (!name) throw new AgentError('invalid_script', 'Missing @name.');
    const namespace = input.code.match(/\/\/\s*@namespace\s+(.+)/)?.[1]?.trim() ?? '';
    for (const script of this.data.values()) {
      const otherNamespace = script.code.match(/\/\/\s*@namespace\s+(.+)/)?.[1]?.trim() ?? '';
      if (script.id !== input.id && script.name === name && namespace === otherNamespace)
        throw new AgentError('namespace_conflict', 'Name and namespace already exist.');
    }
    if (input.id && !this.data.has(input.id))
      throw new AgentError('not_found', 'Script not found.');
    const snapshot = {
      id: input.id ?? crypto.randomUUID(),
      name,
      enabled: input.id ? (await this.get(input.id)).enabled : true,
      code: input.code,
      revision: crypto.randomUUID(),
    };
    this.data.set(snapshot.id, snapshot);
    return { ...snapshot };
  }
  async setEnabled(id: string, enabled: boolean) {
    this.data.set(id, { ...(await this.get(id)), enabled, revision: crypto.randomUUID() });
  }
}
