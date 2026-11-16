import type { AgentDB } from './database';
import type { FileRecord, SessionRecord } from '../protocol/types';
import { AgentError } from '../protocol/errors';
import { siteWorkspaceId } from './site';

export class SessionService {
  constructor(
    public db: AgentDB,
    public id: string,
  ) {}

  static async create(db: AgentDB, workspaceId: string, targetUrl: string, targetTabId?: number) {
    if (siteWorkspaceId(targetUrl) !== workspaceId)
      throw new AgentError('site_scope', 'Session belongs to a different site.');
    const id = crypto.randomUUID();
    await db.put('sessions', {
      id,
      workspaceId,
      targetUrl,
      targetTabId,
      title: '新会话',
      updatedAt: Date.now(),
      baseline: {},
    });
    return new SessionService(db, id);
  }

  static async list(db: AgentDB, workspaceId: string) {
    return (await db.getAllFromIndex('sessions', 'workspaceId', workspaceId)).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }

  async metadata(): Promise<SessionRecord> {
    const session = await this.db.get('sessions', this.id);
    if (!session) throw new AgentError('not_found', 'Session not found.');
    return session;
  }

  async patch(
    patch: Partial<Pick<SessionRecord, 'title' | 'targetUrl' | 'targetTabId' | 'baseline'>>,
  ) {
    const tx = this.db.transaction('sessions', 'readwrite');
    const session = await tx.store.get(this.id);
    if (!session) throw new AgentError('not_found', 'Session not found.');
    if (patch.targetUrl !== undefined && siteWorkspaceId(patch.targetUrl) !== session.workspaceId)
      throw new AgentError('site_scope', 'Session belongs to a different site.');
    await tx.store.put({ ...session, ...patch, updatedAt: Date.now() });
    await tx.done;
  }

  async captureBaseline(files: FileRecord[]) {
    await this.patch({
      baseline: Object.fromEntries(files.map((file) => [file.path, file.revision])),
    });
  }
}
