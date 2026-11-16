import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { UIMessage } from 'ai';
import type {
  ArtifactRecord,
  FileRecord,
  OperationRecord,
  RunRecord,
  WorkspaceRecord,
} from '../protocol/types';

interface StoredFile extends FileRecord {
  key: string;
  workspaceId: string;
}
interface Schema extends DBSchema {
  workspaces: { key: string; value: WorkspaceRecord };
  files: { key: string; value: StoredFile; indexes: { workspaceId: string } };
  revisions: { key: string; value: StoredFile; indexes: { workspaceId: string } };
  conversations: { key: string; value: { id: string; messages: UIMessage[] } };
  runs: { key: string; value: RunRecord; indexes: { workspaceId: string } };
  operations: { key: string; value: OperationRecord; indexes: { workspaceId: string } };
  artifacts: { key: string; value: ArtifactRecord; indexes: { workspaceId: string } };
}
export type AgentDB = IDBPDatabase<Schema>;
export function openAgentDB(name = 'monkeyagent-devtools-v1'): Promise<AgentDB> {
  return openDB<Schema>(name, 1, {
    upgrade(db) {
      db.createObjectStore('workspaces', { keyPath: 'id' });
      db.createObjectStore('conversations', { keyPath: 'id' });
      for (const store of ['files', 'revisions'] as const) {
        db.createObjectStore(store, { keyPath: 'key' }).createIndex('workspaceId', 'workspaceId');
      }
      for (const store of ['runs', 'operations', 'artifacts'] as const) {
        db.createObjectStore(store, { keyPath: 'id' }).createIndex('workspaceId', 'workspaceId');
      }
    },
  });
}
