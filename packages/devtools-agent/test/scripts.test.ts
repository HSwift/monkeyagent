import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { openAgentDB } from '../src/workspace/database';
import { WorkspaceService } from '../src/workspace/service';
import { MockScriptStore } from '../src/fixtures/mock-script-store';
import { ScriptService, installedSummary } from '../src/scripts/service';

const code =
  '// ==UserScript==\n// @name Test\n// @namespace tests\n// @version 1.2.3\n// @match https://example.com/*\n// ==/UserScript==\n';
it('restores only an observed script version into a guarded draft and preserves unseen edits', async () => {
  const db = await openAgentDB(crypto.randomUUID());
  try {
    const fs = await WorkspaceService.create(db, 'https://example.com');
    const adapter = new MockScriptStore(),
      scripts = new ScriptService(fs, adapter);
    const file = await fs.write('/workspace/main.user.js', code);
    const installed = await scripts.apply(file.path);
    const first = (await scripts.history(file.path)).versions[0];
    const outside = await adapter.save({ id: installed.id, code: code + '// native editor' });
    await expect(
      scripts.restore(file.path, first.id, file.revision, installed.revision),
    ).rejects.toMatchObject({ code: 'external_conflict' });
    const edited = await fs.write(file.path, code + '// another draft', file.revision);
    await expect(
      scripts.restore(file.path, first.id, file.revision, outside.revision),
    ).rejects.toMatchObject({ code: 'conflict' });
    const restored = await scripts.restore(file.path, first.id, edited.revision, outside.revision);
    expect(restored.content).toBe(code);
    expect((await adapter.get(installed.id)).code).toContain('native editor');
    expect((await scripts.history(file.path)).versions).toHaveLength(2);
    await scripts.apply(file.path);
    expect((await adapter.get(installed.id)).code).toBe(code);
    expect((await scripts.history(file.path)).versions).toHaveLength(3);
  } finally {
    db.close();
  }
});
it('separates workspace save, installation and verification and detects external edits', async () => {
  const db = await openAgentDB(crypto.randomUUID());
  try {
    const fs = await WorkspaceService.create(db, 'https://example.com');
    const store = new MockScriptStore();
    const scripts = new ScriptService(fs, store);
    const file = await fs.write('/workspace/main.user.js', code);
    expect(await scripts.status(file.path)).toMatchObject({ state: 'uninstalled' });
    const installed = await scripts.apply(file.path);
    expect(await scripts.status(file.path)).toMatchObject({
      state: 'installed',
      enabled: true,
      verification: null,
      version: '1.2.3',
      workspaceRevision: file.revision,
      currentScriptRevision: installed.revision,
    });
    await scripts.verify(file.path, true, 'document.body.dataset.test === "pass"');
    expect(await scripts.status(file.path)).toMatchObject({ verification: { passed: true } });
    await fs.write(file.path, code + '// changed', file.revision);
    expect(await scripts.status(file.path)).toMatchObject({
      state: 'modified',
      verification: null,
    });
    await expect(scripts.verify(file.path, true, 'true')).rejects.toMatchObject({
      code: 'not_installed',
    });
    await store.save({ id: installed.id, code: code + '// outside editor' });
    await expect(scripts.apply(file.path)).rejects.toMatchObject({ code: 'external_conflict' });
    expect((await store.get(installed.id)).code).toContain('outside editor');
    await expect(store.save({ code })).rejects.toMatchObject({ code: 'namespace_conflict' });
  } finally {
    db.close();
  }
});

it('reads installed metadata and suppresses verification after external edits or disabling', async () => {
  const db = await openAgentDB(crypto.randomUUID());
  try {
    const fs = await WorkspaceService.create(db, 'https://example.com');
    const store = new MockScriptStore();
    const scripts = new ScriptService(fs, store);
    const file = await fs.write('/workspace/main.user.js', code);
    const installed = await scripts.apply(file.path);
    await scripts.verify(file.path, true, 'document.body != null');
    // An adapter may version source separately from its enabled flag.
    const get = store.get.bind(store);
    const disabled = vi.spyOn(store, 'get').mockImplementation(async (id) => ({
      ...(await get(id)),
      enabled: false,
    }));
    expect(await scripts.status(file.path)).toMatchObject({ enabled: false, verification: null });
    await expect(scripts.verify(file.path, true, 'true')).rejects.toMatchObject({
      code: 'disabled',
    });
    disabled.mockRestore();
    const edited = await store.save({
      id: installed.id,
      code: code.replace('@version 1.2.3', '@version 2.0.0'),
    });
    expect(await scripts.status(file.path)).toMatchObject({
      version: '2.0.0',
      workspaceRevision: file.revision,
      scriptRevision: installed.revision,
      currentScriptRevision: edited.revision,
      externalChanged: true,
      verification: null,
    });
    expect(
      installedSummary({
        ...edited,
        code: code.replace('// @version 1.2.3\n', '') + '\n// @version 99',
      }).version,
    ).toBeNull();
    expect(
      installedSummary({
        ...edited,
        code: code.replace('@version 1.2.3', '@version   ').replaceAll('\n', '\r\n'),
      }).version,
    ).toBeNull();
  } finally {
    db.close();
  }
});
