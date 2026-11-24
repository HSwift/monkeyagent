import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAgentDB, type AgentDB } from '../src/workspace/database';
import { WorkspaceService, normalizePath } from '../src/workspace/service';

const databases: AgentDB[] = [];
async function setup() {
  const db = await openAgentDB(crypto.randomUUID());
  databases.push(db);
  return WorkspaceService.create(db, 'https://example.com');
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
describe('workspace transactions', () => {
  it('admits exactly one concurrent revision writer without storing file history', async () => {
    const fs = await setup();
    const file = await fs.write('/workspace/test.js', 'original');
    const results = await Promise.allSettled([
      fs.write(file.path, 'human', file.revision),
      fs.write(file.path, 'agent', file.revision),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    });
    expect(Array.from(fs.db.objectStoreNames)).not.toContain('revisions');
    const current = await fs.read(file.path);
    await expect(fs.remove(file.path, file.revision)).rejects.toMatchObject({ code: 'conflict' });
    await fs.remove(file.path, current.revision);
    await expect(fs.read(file.path)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rejects traversal, implicit overwrites, read-only docs and ambiguous edits', async () => {
    const fs = await setup();
    expect(() => normalizePath('/workspace/../docs/x')).toThrow();
    await expect(fs.write('/docs/browser-api.md', 'oops')).rejects.toMatchObject({
      code: 'read_only',
    });
    expect((await fs.read('/docs/browser-api.md')).content).toContain('browser.evaluate');
    const file = await fs.write('/workspace/a.js', 'x x');
    await expect(fs.write(file.path, 'oops')).rejects.toMatchObject({ code: 'conflict' });
    await expect(fs.edit(file.path, 'x', 'y', file.revision)).rejects.toMatchObject({
      code: 'ambiguous_edit',
    });
  });
  it('renames atomically with bindings, isolates workspaces and restores saved files', async () => {
    const fs = await setup();
    const file = await fs.write('/workspace/a.js', 'hello');
    await fs.bind(file.path, {
      path: file.path,
      scriptId: '42',
      scriptRevision: 's1',
      fileRevision: file.revision,
      enabled: true,
    });
    const renamed = await fs.rename(file.path, '/workspace/b.js', file.revision);
    const binding = (await fs.metadata()).bindings[renamed.path];
    expect(binding.fileRevision).toBe(renamed.revision);
    expect((await fs.metadata()).bindings[file.path]).toBeUndefined();
    const reopened = new WorkspaceService(fs.db, fs.id);
    expect((await reopened.read(renamed.path)).content).toBe('hello');
    const other = await WorkspaceService.create(fs.db, 'https://other.example');
    await expect(other.read(renamed.path)).rejects.toMatchObject({ code: 'not_found' });
  });
});
