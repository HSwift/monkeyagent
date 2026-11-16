import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { openAgentDB, type AgentDB } from '../src/workspace/database';
import { WorkspaceService } from '../src/workspace/service';
import { SessionService } from '../src/workspace/session';
import { siteKey } from '../src/workspace/site';

const databases: AgentDB[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
});
async function database(name = crypto.randomUUID()) {
  const db = await openAgentDB(name);
  databases.push(db);
  return db;
}

describe('site ownership', () => {
  it('prefers the browser PSL and passes a normalized hostname', () => {
    const getDomain = vi.fn().mockReturnValue('tenant.example.com');
    vi.stubGlobal('chrome', { publicSuffix: { getDomain } });
    // The browser may know a newer private suffix than our bundled list.
    expect(siteKey('https://APP.TENANT.EXAMPLE.COM.:8443/path')).toBe('tenant.example.com');
    expect(getDomain).toHaveBeenCalledExactlyOnceWith('app.tenant.example.com');
  });

  it.each([undefined, null, ''])('uses the bundled PSL when the browser returns %s', (domain) => {
    vi.stubGlobal('chrome', { publicSuffix: { getDomain: vi.fn().mockReturnValue(domain) } });
    expect(siteKey('https://app.one.github.io')).toBe('one.github.io');
    expect(siteKey('https://two.github.io')).toBe('two.github.io');
    expect(siteKey('https://sub.example.co.uk')).toBe('example.co.uk');
    expect(siteKey('http://[::1]:8080')).toBe('[::1]');
    expect(siteKey('http://localhost:8080')).toBe('localhost');
  });

  it('uses the bundled PSL when the native API throws or is missing', () => {
    const getDomain = vi.fn(() => {
      throw new Error('API unavailable');
    });
    vi.stubGlobal('chrome', { publicSuffix: { getDomain } });
    expect(siteKey('https://app.one.github.io')).toBe('one.github.io');
    vi.stubGlobal('chrome', {});
    expect(siteKey('https://sub.example.co.uk')).toBe('example.co.uk');
    vi.stubGlobal('chrome', { publicSuffix: {} });
    expect(siteKey('https://sub.example.co.uk')).toBe('example.co.uk');
  });

  it('uses the registrable domain including private suffixes, with host fallbacks', () => {
    expect(siteKey('https://a.b.example.co.uk:8443/path')).toBe('example.co.uk');
    expect(siteKey('http://EXAMPLE.CO.UK./')).toBe('example.co.uk');
    expect(siteKey('https://app.one.github.io')).toBe('one.github.io');
    expect(siteKey('https://two.github.io')).toBe('two.github.io');
    expect(siteKey('http://127.0.0.1:1234')).toBe('127.0.0.1');
    expect(siteKey('http://[::1]:1234')).toBe('[::1]');
    expect(siteKey('http://localhost:1234')).toBe('localhost');
    expect(siteKey('about:blank')).toBe('about:blank');
  });

  it('shares files and bindings across same-site sessions while keeping baselines and other sites separate', async () => {
    const db = await database();
    const first = await WorkspaceService.create(db, 'https://one.example.com');
    const second = await WorkspaceService.create(db, 'http://two.example.com:8080');
    const other = await WorkspaceService.create(db, 'https://example.org');
    expect(first.id).toBe(second.id);
    const a = await SessionService.create(db, first.id, 'https://one.example.com', 1);
    const b = await SessionService.create(db, second.id, 'http://two.example.com:8080', 2);
    await SessionService.create(db, other.id, 'https://example.org', 3);
    const file = await first.write('/workspace/main.js', 'original');
    await a.captureBaseline(await first.allFiles());
    await first.bind(file.path, {
      path: file.path,
      scriptId: '42',
      scriptRevision: 's1',
      fileRevision: file.revision,
      installedCode: file.content,
      enabled: true,
    });
    expect((await second.metadata()).bindings[file.path].scriptId).toBe('42');
    const writes = await Promise.allSettled([
      first.write(file.path, 'one', file.revision),
      second.write(file.path, 'two', file.revision),
    ]);
    expect(writes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    });
    await b.captureBaseline(await second.allFiles());
    expect((await a.metadata()).baseline[file.path]).toBe(file.revision);
    expect((await b.metadata()).baseline[file.path]).not.toBe(file.revision);
    expect((await SessionService.list(db, first.id)).map((session) => session.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    await expect(other.read(file.path)).rejects.toMatchObject({ code: 'not_found' });
    expect(await other.revision(file.revision)).toBeUndefined();
  });

  it('migrates legacy sessions atomically and preserves conflicting files, conversations and history', async () => {
    const name = crypto.randomUUID();
    const legacy = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('workspaces', { keyPath: 'id' });
        db.createObjectStore('conversations', { keyPath: 'id' });
        for (const store of ['files', 'revisions'])
          db.createObjectStore(store, { keyPath: 'key' }).createIndex('workspaceId', 'workspaceId');
        for (const store of ['runs', 'operations', 'artifacts'])
          db.createObjectStore(store, { keyPath: 'id' }).createIndex('workspaceId', 'workspaceId');
      },
    });
    const path = '/workspace/main.user.js';
    for (const [id, url, time, content] of [
      ['session-a', 'https://one.example.com', 1, 'older'],
      ['session-b', 'https://two.example.com', 2, 'newer'],
      ['session-c', 'https://example.org', 3, 'private'],
    ] as const) {
      const revision = `revision-${id}`;
      await legacy.put('workspaces', {
        id,
        targetUrl: url,
        title: id,
        targetTabId: time,
        updatedAt: time,
        baseline: { [path]: revision },
        bindings: {
          [path]: {
            path,
            scriptId: id,
            scriptRevision: 's1',
            fileRevision: revision,
            installedCode: content,
            enabled: true,
          },
        },
      });
      const file = {
        key: `${id}:${path}`,
        workspaceId: id,
        path,
        content,
        revision,
        updatedAt: time,
      };
      await legacy.put('files', file);
      await legacy.put('revisions', { ...file, key: revision });
      await legacy.put('conversations', {
        id,
        messages: [{ id: `message-${id}`, role: 'user', parts: [{ type: 'text', text: content }] }],
      });
      await legacy.put('runs', {
        id: `run-${id}`,
        workspaceId: id,
        status: 'generating',
        startedAt: time,
        queued: [],
      });
      await legacy.put('operations', {
        id: `operation-${id}`,
        workspaceId: id,
        name: 'repl',
        status: 'started',
        startedAt: time,
      });
      await legacy.put('artifacts', {
        id: `artifact-${id}`,
        workspaceId: id,
        path: `/artifacts/${id}.txt`,
        mimeType: 'text/plain',
        size: 1,
        createdAt: time,
        blob: new Blob([content]),
      });
    }
    legacy.close();
    const db = await database(name);
    expect(await db.count('workspaces')).toBe(2);
    expect(await db.count('sessions')).toBe(3);
    const workspace = await WorkspaceService.create(db, 'https://example.com');
    const files = await workspace.allFiles();
    expect(files.map((file) => file.content).sort()).toEqual(['newer', 'older']);
    expect((await workspace.read(path)).content).toBe('newer');
    const copy = files.find((file) => file.content === 'older')!;
    expect(copy.path).toMatch(/\.migrated-session-.*\.user\.js$/);
    expect((await new SessionService(db, 'session-a').metadata()).baseline[copy.path]).toBe(
      'revision-session-a',
    );
    expect((await workspace.metadata()).bindings[copy.path].scriptId).toBe('session-a');
    expect((await workspace.revision('revision-session-a'))?.content).toBe('older');
    expect((await db.get('conversations', 'session-a'))?.messages[0].id).toBe('message-session-a');
    expect((await db.getAllFromIndex('runs', 'sessionId', 'session-a'))[0].workspaceId).toBe(
      workspace.id,
    );
    expect((await db.getAllFromIndex('operations', 'sessionId', 'session-b'))[0].workspaceId).toBe(
      workspace.id,
    );
    expect((await db.get('artifacts', 'artifact-session-a'))?.sessionId).toBe('session-a');
    expect((await SessionService.list(db, workspace.id)).map((session) => session.id)).toEqual([
      'session-b',
      'session-a',
    ]);
    const reopened = await openAgentDB(name);
    expect(await reopened.count('files')).toBe(3);
    reopened.close();
  });
});
