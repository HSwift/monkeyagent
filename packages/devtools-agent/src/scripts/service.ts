import { AgentError } from '../protocol/errors';
import type { ScriptBinding, ScriptSnapshot, ScriptStoreAdapter } from '../protocol/types';
import type { WorkspaceService } from '../workspace/service';

export function installedSummary(script: ScriptSnapshot) {
  const metadata = script.code.match(
    /^[\t ]*\/\/[\t ]*==UserScript==[^\r\n]*\r?\n[\s\S]*?^[\t ]*\/\/[\t ]*==\/UserScript==/m,
  )?.[0];
  const version =
    metadata?.match(/^[\t ]*\/\/[\t ]*@version[\t ]+([^\r\n]*)/m)?.[1]?.trim() || null;
  const { id, name, enabled, revision } = script;
  return { id, name, enabled, revision, version };
}

export class ScriptService {
  constructor(
    private workspace: WorkspaceService,
    private adapter: ScriptStoreAdapter,
  ) {}
  list() {
    return this.adapter.list();
  }
  async import(id: string, path: string) {
    const script = await this.adapter.get(id);
    const file = await this.workspace.write(path, script.code);
    await this.workspace.bind(file.path, {
      path: file.path,
      scriptId: id,
      scriptRevision: script.revision,
      fileRevision: file.revision,
      enabled: script.enabled,
    });
    return file;
  }
  async apply(path: string) {
    const file = await this.workspace.read(path);
    const binding = (await this.workspace.metadata()).bindings[file.path];
    if (binding) await this.checkExternal(binding);
    const script = await this.adapter.save({ id: binding?.scriptId, code: file.content });
    await this.workspace.bind(file.path, {
      path: file.path,
      scriptId: script.id,
      scriptRevision: script.revision,
      fileRevision: file.revision,
      enabled: script.enabled,
    });
    return script;
  }
  async status(path: string) {
    const file = await this.workspace.read(path);
    const binding = (await this.workspace.metadata()).bindings[file.path];
    if (!binding)
      return {
        state: 'uninstalled',
        path: file.path,
        workspaceRevision: file.revision,
        version: null,
        verification: null,
      };
    const current = await this.adapter.get(binding.scriptId);
    const externalChanged = current.revision !== binding.scriptRevision;
    return {
      ...binding,
      state: file.revision === binding.fileRevision ? 'installed' : 'modified',
      workspaceRevision: file.revision,
      currentScriptRevision: current.revision,
      version: installedSummary(current).version,
      enabled: current.enabled,
      externalChanged,
      verification:
        file.revision === binding.fileRevision && !externalChanged && current.enabled
          ? (binding.verification ?? null)
          : null,
    };
  }
  async setEnabled(path: string, enabled: boolean) {
    const file = await this.workspace.read(path);
    const binding = (await this.workspace.metadata()).bindings[file.path];
    if (!binding) throw new AgentError('not_installed', 'Install this file first.');
    await this.checkExternal(binding);
    await this.adapter.setEnabled(binding.scriptId, enabled);
    const script = await this.adapter.get(binding.scriptId);
    await this.workspace.bind(file.path, {
      ...binding,
      enabled: script.enabled,
      scriptRevision: script.revision,
      verification: undefined,
    });
    return { enabled: script.enabled };
  }
  private async boundScript(path: string) {
    const file = await this.workspace.read(path);
    const binding = (await this.workspace.metadata()).bindings[file.path];
    if (!binding) throw new AgentError('not_installed', 'Install or import this userscript first.');
    return binding.scriptId;
  }
  async history(path: string) {
    const id = await this.boundScript(path);
    return {
      script: installedSummary(await this.adapter.get(id)),
      versions: await this.adapter.history(id),
    };
  }
  async version(path: string, versionId: string) {
    const id = await this.boundScript(path);
    return versionId === 'current'
      ? { code: (await this.adapter.get(id)).code }
      : this.adapter.version(id, versionId);
  }
  /** Explicit UI restore: acknowledge the observed host revision, never an unseen edit. */
  async restore(
    path: string,
    versionId: string,
    expectedFileRevision: string,
    expectedScriptRevision: string,
  ) {
    const id = await this.boundScript(path);
    const current = await this.adapter.get(id);
    if (current.revision !== expectedScriptRevision)
      throw new AgentError(
        'external_conflict',
        'The installed script changed. Refresh its history before restoring.',
      );
    const version = versionId === 'current' ? current : await this.adapter.version(id, versionId);
    const file = await this.workspace.write(path, version.code, expectedFileRevision);
    const binding = (await this.workspace.metadata()).bindings[file.path];
    await this.workspace.bind(file.path, {
      ...binding,
      scriptRevision: current.revision,
      fileRevision: current.code === file.content ? file.revision : binding.fileRevision,
      enabled: current.enabled,
      verification: undefined,
    });
    return file;
  }
  async verify(path: string, passed: boolean, detail: string) {
    const file = await this.workspace.read(path);
    const binding = (await this.workspace.metadata()).bindings[file.path];
    if (!binding || file.revision !== binding.fileRevision)
      throw new AgentError(
        'not_installed',
        'Install the current file revision before verification.',
      );
    const current = await this.checkExternal(binding);
    if (!current.enabled)
      throw new AgentError('disabled', 'Enable the script before verification.');
    const verification = { passed, detail, at: Date.now() };
    await this.workspace.bind(file.path, { ...binding, verification });
    return verification;
  }
  private async checkExternal(binding: ScriptBinding) {
    const current = await this.adapter.get(binding.scriptId);
    if (current.revision !== binding.scriptRevision)
      throw new AgentError(
        'external_conflict',
        'The installed script changed outside this workspace. Import it into a new file before applying changes.',
      );
    return current;
  }
}
