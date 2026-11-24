import type { IDBPTransaction, StoreNames } from 'idb';
import type { Schema, StoredFile } from './database';
import type { ScriptBinding, SessionRecord, WorkspaceRecord } from '../protocol/types';
import { siteKey, siteWorkspaceId } from './site';

type LegacySession = Omit<SessionRecord, 'workspaceId'> & {
  bindings: Record<string, ScriptBinding>;
};

/** Keep conversations and current files; preserve conflicting files as named copies. */
export async function migrateSessions(
  tx: IDBPTransaction<Schema, StoreNames<Schema>[], 'versionchange'>,
) {
  const [legacy, files, runs, operations, artifacts] = await Promise.all([
    tx.objectStore('workspaces').getAll() as unknown as Promise<LegacySession[]>,
    tx.objectStore('files').getAll(),
    tx.objectStore('runs').getAll(),
    tx.objectStore('operations').getAll(),
    tx.objectStore('artifacts').getAll(),
  ]);
  const oldSessions = new Map(legacy.map((session) => [session.id, session]));
  const workspaces = new Map<string, WorkspaceRecord>();
  const owners = new Map<string, string>();
  for (const session of legacy) {
    const id = siteWorkspaceId(session.targetUrl);
    owners.set(session.id, id);
    const existing = workspaces.get(id);
    workspaces.set(id, {
      id,
      site: siteKey(session.targetUrl),
      bindings: {},
      updatedAt: Math.max(session.updatedAt, existing?.updatedAt ?? 0),
    });
  }
  await tx.objectStore('workspaces').clear();
  await tx.objectStore('files').clear();
  const current = new Map<string, StoredFile>();
  for (const file of files.sort(
    (a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key),
  )) {
    const workspaceId = owners.get(file.workspaceId);
    if (!workspaceId) continue;
    let path = file.path;
    let canonical = current.get(`${workspaceId}:${path}`);
    if (canonical && canonical.content !== file.content) {
      const suffix = path.endsWith('.user.js') ? '.user.js' : (/\.[^/.]+$/.exec(path)?.[0] ?? '');
      const stem = suffix ? path.slice(0, -suffix.length) : path;
      let n = 0;
      do {
        path = `${stem}.migrated-${file.workspaceId.slice(0, 8)}${n++ ? `-${n}` : ''}${suffix}`;
      } while (current.has(`${workspaceId}:${path}`));
      canonical = undefined;
    }
    if (!canonical) {
      canonical = { ...file, workspaceId, path, key: `${workspaceId}:${path}` };
      current.set(canonical.key, canonical);
      await tx.objectStore('files').put(canonical);
    }
    const binding = oldSessions.get(file.workspaceId)?.bindings?.[file.path];
    const workspace = workspaces.get(workspaceId)!;
    if (binding && !workspace.bindings[path])
      workspace.bindings[path] = {
        ...binding,
        path,
        fileRevision:
          binding.fileRevision === file.revision ? canonical.revision : binding.fileRevision,
      };
  }
  for (const workspace of workspaces.values()) await tx.objectStore('workspaces').put(workspace);
  for (const { bindings: _, ...session } of legacy) {
    await tx.objectStore('sessions').put({
      ...session,
      workspaceId: owners.get(session.id)!,
    });
  }
  for (const [store, records] of [
    ['runs', runs],
    ['operations', operations],
    ['artifacts', artifacts],
  ] as const) {
    for (const record of records) {
      const workspaceId = owners.get(record.workspaceId);
      if (workspaceId)
        await tx.objectStore(store).put({ ...record, workspaceId, sessionId: record.workspaceId });
    }
  }
}
