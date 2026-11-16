import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { UIMessage } from 'ai';
import { migrateSessions } from './migrate';
import type {
  ArtifactRecord,
  FileRecord,
  OperationRecord,
  RunRecord,
  WorkspaceRecord,
  SessionRecord,
} from '../protocol/types';

export interface StoredFile extends FileRecord {
  key: string;
  workspaceId: string;
}
export interface Schema extends DBSchema {
  workspaces: { key: string; value: WorkspaceRecord };
  sessions: { key: string; value: SessionRecord; indexes: { workspaceId: string } };
  files: { key: string; value: StoredFile; indexes: { workspaceId: string } };
  revisions: { key: string; value: StoredFile; indexes: { workspaceId: string } };
  conversations: { key: string; value: { id: string; messages: UIMessage[] } };
  runs: { key: string; value: RunRecord; indexes: { workspaceId: string; sessionId: string } };
  operations: {
    key: string;
    value: OperationRecord;
    indexes: { workspaceId: string; sessionId: string };
  };
  artifacts: { key: string; value: ArtifactRecord; indexes: { workspaceId: string } };
}
export type AgentDB = IDBPDatabase<Schema>;
export function openAgentDB(name = 'monkeyagent-devtools-v1'): Promise<AgentDB> {
  return openDB<Schema>(name, 2, {
    upgrade(db, oldVersion, _version, tx) {
      if (oldVersion < 1) {
        db.createObjectStore('workspaces', { keyPath: 'id' });
        db.createObjectStore('conversations', { keyPath: 'id' });
        for (const store of ['files', 'revisions'] as const) {
          db.createObjectStore(store, { keyPath: 'key' }).createIndex('workspaceId', 'workspaceId');
        }
        for (const store of ['runs', 'operations', 'artifacts'] as const) {
          db.createObjectStore(store, { keyPath: 'id' }).createIndex('workspaceId', 'workspaceId');
        }
      }
      db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('workspaceId', 'workspaceId');
      tx.objectStore('runs').createIndex('sessionId', 'sessionId');
      tx.objectStore('operations').createIndex('sessionId', 'sessionId');
      if (oldVersion === 1) void migrateSessions(tx).catch(() => tx.abort());
    },
  });
}
