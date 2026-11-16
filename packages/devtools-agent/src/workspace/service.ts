import type { AgentDB } from './database';
import { API_DOCS } from './docs';
import { AgentError } from '../protocol/errors';
import type { ArtifactRef, FileRecord, ScriptBinding, WorkspaceRecord } from '../protocol/types';
import { siteKey, siteWorkspaceId } from './site';

/** Mutations acknowledge a revision; use read() when the full source is actually needed. */
export function fileSummary(file: FileRecord) {
  return {
    path: file.path,
    revision: file.revision,
    updatedAt: file.updatedAt,
    size: file.content.length,
  };
}

export function normalizePath(path: string): string {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.includes('\0') ||
    path.includes('\\')
  ) {
    throw new AgentError('invalid_path', 'Use an absolute workspace path.');
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new AgentError('invalid_path', 'Parent traversal is not allowed.');
    parts.push(part);
  }
  if (!['workspace', 'artifacts', 'docs'].includes(parts[0]))
    throw new AgentError(
      'invalid_path',
      'Use /workspace/<name> for script files, for example /workspace/main.user.js. /docs and /artifacts are read-only; /scripts is not a workspace directory.',
    );
  return '/' + parts.join('/');
}

export class WorkspaceService {
  constructor(
    public db: AgentDB,
    public id: string,
    public changed: () => void = () => {},
    public sessionId?: string,
  ) {}
  static async create(db: AgentDB, targetUrl: string): Promise<WorkspaceService> {
    const id = siteWorkspaceId(targetUrl);
    const tx = db.transaction('workspaces', 'readwrite');
    if (!(await tx.store.get(id)))
      await tx.store.put({ id, site: siteKey(targetUrl), updatedAt: Date.now(), bindings: {} });
    await tx.done;
    return new WorkspaceService(db, id);
  }
  async metadata(): Promise<WorkspaceRecord> {
    const result = await this.db.get('workspaces', this.id);
    if (!result) throw new AgentError('not_found', 'Workspace not found.');
    return result;
  }
  async bind(path: string, binding: ScriptBinding) {
    const tx = this.db.transaction('workspaces', 'readwrite');
    const data = await tx.store.get(this.id);
    if (!data) throw new AgentError('not_found', 'Workspace not found.');
    data.bindings[path] = binding;
    data.updatedAt = Date.now();
    await tx.store.put(data);
    await tx.done;
    this.changed();
  }
  async list(prefix = '/') {
    const files = await this.db.getAllFromIndex('files', 'workspaceId', this.id);
    return [
      ...files.map(({ path, content, revision, updatedAt }) => ({
        path,
        revision,
        updatedAt,
        size: content.length,
      })),
      ...Object.entries(API_DOCS).map(([path, content]) => ({
        path,
        revision: 'docs-v1',
        updatedAt: 0,
        size: content.length,
      })),
    ]
      .filter((f) => f.path.startsWith(prefix))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
  async allFiles(): Promise<FileRecord[]> {
    return (await this.db.getAllFromIndex('files', 'workspaceId', this.id)).map(
      ({ path, content, revision, updatedAt }) => ({ path, content, revision, updatedAt }),
    );
  }
  async read(
    path: string,
    options?: { offset?: number; limit?: number },
  ): Promise<FileRecord & { offset?: number; totalLength?: number; truncated?: boolean }> {
    path = normalizePath(path);
    if (API_DOCS[path]) return { path, content: API_DOCS[path], revision: 'docs-v1', updatedAt: 0 };
    const result = await this.db.get('files', this.key(path));
    if (!result) {
      const artifact = (await this.db.getAllFromIndex('artifacts', 'workspaceId', this.id)).find(
        (artifact) => artifact.path === path,
      );
      if (!artifact) throw new AgentError('not_found', `File not found: ${path}`);
      if (!/^(text\/|application\/json)/.test(artifact.mimeType))
        throw new AgentError(
          'binary_artifact',
          `Binary artifact ${artifact.id} (${artifact.mimeType}, ${artifact.size} bytes). Use the artifact reference to inspect images.`,
        );
      const content = await artifact.blob.text();
      return this.slice(
        { path, content, revision: artifact.id, updatedAt: artifact.createdAt },
        { limit: 32000, ...options },
      );
    }
    const { content, revision, updatedAt } = result;
    return options
      ? this.slice({ path, content, revision, updatedAt }, options)
      : { path, content, revision, updatedAt };
  }
  async write(path: string, content: string, expectedRevision?: string): Promise<FileRecord> {
    path = this.writable(path);
    if (typeof content !== 'string' || content.length > 2 * 1024 * 1024)
      throw new AgentError('size_limit', 'Text files are limited to 2 MiB.');
    const tx = this.db.transaction(['files', 'revisions', 'workspaces'], 'readwrite');
    const old = await tx.objectStore('files').get(this.key(path));
    if ((old?.revision ?? undefined) !== expectedRevision) {
      await tx.done;
      throw new AgentError(
        'conflict',
        `Revision changed for ${path}. Read it again before writing.`,
      );
    }
    const record = {
      key: this.key(path),
      workspaceId: this.id,
      path,
      content,
      revision: crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    await tx.objectStore('files').put(record);
    await tx.objectStore('revisions').put({ ...record, key: record.revision });
    const meta = await tx.objectStore('workspaces').get(this.id);
    if (meta) {
      meta.updatedAt = record.updatedAt;
      await tx.objectStore('workspaces').put(meta);
    }
    await tx.done;
    this.changed();
    return { path, content, revision: record.revision, updatedAt: record.updatedAt };
  }
  async edit(path: string, search: string, replacement: string, expectedRevision: string) {
    const file = await this.read(path);
    if (!search || file.content.split(search).length !== 2)
      throw new AgentError('ambiguous_edit', 'Search must match exactly once.');
    return this.write(
      path,
      file.content.replace(search, () => replacement),
      expectedRevision,
    );
  }
  async remove(path: string, expectedRevision: string) {
    path = this.writable(path);
    const tx = this.db.transaction(['files', 'workspaces'], 'readwrite');
    const old = await tx.objectStore('files').get(this.key(path));
    if (!old || old.revision !== expectedRevision) {
      await tx.done;
      throw new AgentError('conflict', 'Read the current revision before deleting.');
    }
    await tx.objectStore('files').delete(this.key(path));
    const meta = await tx.objectStore('workspaces').get(this.id);
    if (meta) {
      delete meta.bindings[path];
      meta.updatedAt = Date.now();
      await tx.objectStore('workspaces').put(meta);
    }
    await tx.done;
    this.changed();
    return { removed: path };
  }
  async rename(path: string, to: string, expectedRevision: string) {
    path = this.writable(path);
    to = this.writable(to);
    const tx = this.db.transaction(['files', 'revisions', 'workspaces'], 'readwrite');
    const old = await tx.objectStore('files').get(this.key(path));
    const exists = await tx.objectStore('files').get(this.key(to));
    if (!old || old.revision !== expectedRevision || exists) {
      await tx.done;
      throw new AgentError('conflict', 'Source changed or destination already exists.');
    }
    const file = {
      ...old,
      path: to,
      key: this.key(to),
      revision: crypto.randomUUID(),
      updatedAt: Date.now(),
    };
    await tx.objectStore('files').delete(this.key(path));
    await tx.objectStore('files').put(file);
    await tx.objectStore('revisions').put({ ...file, key: file.revision });
    const meta = await tx.objectStore('workspaces').get(this.id);
    if (meta) {
      if (meta.bindings[path]) {
        const binding = meta.bindings[path];
        delete meta.bindings[path];
        meta.bindings[to] = {
          ...binding,
          path: to,
          fileRevision:
            binding.fileRevision === old.revision ? file.revision : binding.fileRevision,
        };
      }
      meta.updatedAt = file.updatedAt;
      await tx.objectStore('workspaces').put(meta);
    }
    await tx.done;
    this.changed();
    return this.read(to);
  }
  async search(query: string, prefix = '/workspace/') {
    if (!query) throw new AgentError('invalid_input', 'Search text is required.');
    const results = [];
    for (const file of await this.allFiles()) {
      if (!file.path.startsWith(prefix)) continue;
      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length && results.length < 100; i++) {
        if (lines[i].includes(query))
          results.push({
            path: file.path,
            revision: file.revision,
            line: i + 1,
            text: lines[i].slice(0, 500),
          });
      }
    }
    return results;
  }
  async revision(revision: string): Promise<FileRecord | undefined> {
    const file = await this.db.get('revisions', revision);
    if (file?.workspaceId !== this.id) return;
    return file;
  }
  async artifact(blob: Blob, name = 'artifact'): Promise<ArtifactRef> {
    const id = crypto.randomUUID();
    const ref = { id, path: `/artifacts/${name}-${id}`, mimeType: blob.type, size: blob.size };
    await this.db.put('artifacts', {
      ...ref,
      workspaceId: this.id,
      sessionId: this.sessionId,
      blob,
      createdAt: Date.now(),
    });
    this.changed();
    return ref;
  }
  private writable(path: string) {
    path = normalizePath(path);
    if (path.startsWith('/docs/') || !/^\/(workspace|artifacts)\/.+/.test(path))
      throw new AgentError('read_only', 'This path is read-only.');
    return path;
  }
  private slice(file: FileRecord, options: { offset?: number; limit?: number }) {
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 32000)), 64000);
    if (!Number.isFinite(offset) || !Number.isFinite(limit))
      throw new AgentError('invalid_input', 'Read range must be finite.');
    return {
      ...file,
      content: file.content.slice(offset, offset + limit),
      offset,
      totalLength: file.content.length,
      truncated: offset > 0 || offset + limit < file.content.length,
    };
  }
  private key(path: string) {
    return `${this.id}:${path}`;
  }
}
