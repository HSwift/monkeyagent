import type { ScriptSnapshot, ScriptStoreAdapter, ScriptVersion } from '../protocol/types';
import { AgentError } from '../protocol/errors';

/** No injection emulation: real injection is tested with the built Monkey extension. */
export class MockScriptStore implements ScriptStoreAdapter {
  private data = new Map<string, ScriptSnapshot>();
  private versions = new Map<string, ScriptVersion[]>();
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
    const history = this.versions.get(snapshot.id) ?? [];
    if (history.at(-1)?.code !== snapshot.code) {
      history.push({
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        source: 'agent',
        code: snapshot.code,
        version: snapshot.code.match(/\/\/\s*@version\s+([^\r\n]+)/)?.[1]?.trim() ?? null,
        size: new TextEncoder().encode(snapshot.code).length,
      });
      this.versions.set(snapshot.id, history.slice(-20));
    }
    return { ...snapshot };
  }
  async setEnabled(id: string, enabled: boolean) {
    this.data.set(id, { ...(await this.get(id)), enabled, revision: crypto.randomUUID() });
  }
  async history(id: string) {
    await this.get(id);
    return (this.versions.get(id) ?? [])
      .slice()
      .reverse()
      .map(({ code: _, ...info }) => info);
  }
  async version(id: string, versionId: string) {
    await this.get(id);
    const version = (this.versions.get(id) ?? []).find((item) => item.id === versionId);
    if (!version) throw new AgentError('not_found', 'Script version no longer exists.');
    return { ...version };
  }
}
