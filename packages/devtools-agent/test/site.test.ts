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
  it('upgrades v2 by deleting workspace history while preserving current files, bindings, conversations and context', async () => {
    const name = crypto.randomUUID();
    const legacy = await openDB(name, 2, {
      upgrade(db) {
        db.createObjectStore('workspaces', { keyPath: 'id' });
        db.createObjectStore('sessions', { keyPath: 'id' }).createIndex(
          'workspaceId',
          'workspaceId',
        );
        db.createObjectStore('conversations', { keyPath: 'id' });
        for (const store of ['files', 'revisions'])
          db.createObjectStore(store, { keyPath: 'key' }).createIndex('workspaceId', 'workspaceId');
        for (const store of ['runs', 'operations', 'artifacts']) {
          const object = db.createObjectStore(store, { keyPath: 'id' });
          object.createIndex('workspaceId', 'workspaceId');
          if (store !== 'artifacts') object.createIndex('sessionId', 'sessionId');
        }
      },
    });
    const workspaceId = 'site:example.com',
      path = '/workspace/main.user.js';
    const binding = {
      path,
      scriptId: '17',
      scriptRevision: 'installed',
      fileRevision: 'current',
      enabled: true,
      installedCode: 'installed source',
    };
    await legacy.put('workspaces', {
      id: workspaceId,
      site: 'example.com',
      updatedAt: 1,
      bindings: { [path]: binding },
      lastSessionByTab: { '3': 'session' },
    });
    await legacy.put('sessions', {
      id: 'session',
      workspaceId,
      title: 'Keep conversation',
      targetUrl: 'https://example.com/',
      updatedAt: 1,
      baseline: { [path]: 'old' },
      context: { summary: 'Continue the task' },
    });
    await legacy.put('conversations', {
      id: 'session',
      messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'preserved' }] }],
    });
    await legacy.put('files', {
      key: workspaceId + ':' + path,
      workspaceId,
      path,
      content: 'current source',
      revision: 'current',
      updatedAt: 1,
    });
    await legacy.put('revisions', {
      key: 'old',
      workspaceId,
      path,
      content: 'old draft',
      revision: 'old',
      updatedAt: 0,
    });
    legacy.close();
    const db = await database(name);
    expect(Array.from(db.objectStoreNames)).not.toContain('revisions');
    expect((await db.get('files', workspaceId + ':' + path))?.content).toBe('current source');
    expect((await db.get('sessions', 'session'))?.context?.summary).toBe('Continue the task');
    expect(await db.get('sessions', 'session')).not.toHaveProperty('baseline');
    expect((await db.get('workspaces', workspaceId))?.bindings[path]).toMatchObject({
      scriptId: '17',
      scriptRevision: 'installed',
      fileRevision: 'current',
    });
    expect((await db.get('workspaces', workspaceId))?.bindings[path]).not.toHaveProperty(
      'installedCode',
    );
    expect((await db.get('workspaces', workspaceId))?.lastSessionByTab).toEqual({ '3': 'session' });
    expect((await db.get('conversations', 'session'))?.messages[0].parts).toEqual([
      { type: 'text', text: 'preserved' },
    ]);
  });

  it('remembers each tab selection independently of the current session target and preserves shared bindings', async () => {
    const db = await database();
    const url = 'https://example.com/';
    const workspace = await WorkspaceService.create(db, url);
    const binding = {
      path: '/workspace/shared.js',
      scriptId: 'script',
      scriptRevision: 'installed',
      fileRevision: 'file',
      enabled: true,
    };
    await workspace.bind(binding.path, binding);
    const a = await SessionService.create(db, workspace.id, url, 1);
    const b = await SessionService.create(db, workspace.id, url, 2);
    await a.activate(url, 1);
    await b.activate(url, 2);
    await a.activate(url, 2);
    expect((await workspace.metadata()).lastSessionByTab).toEqual({ '1': a.id, '2': a.id });
    expect((await a.metadata()).targetTabId).toBe(2);
    await b.activate(url, 1);
    expect((await workspace.metadata()).lastSessionByTab).toEqual({ '1': b.id, '2': a.id });
    await expect(a.activate('https://example.org/', 1)).rejects.toMatchObject({
      code: 'site_scope',
    });
    expect((await workspace.metadata()).lastSessionByTab?.['1']).toBe(b.id);
    expect((await workspace.metadata()).bindings).toEqual({ [binding.path]: binding });
  });

  it('shows English default titles for legacy sessions while preserving user content', async () => {
    const db = await database();
    const workspace = await WorkspaceService.create(db, 'https://example.com');
    const session = await SessionService.create(db, workspace.id, 'https://example.com');
    expect((await session.metadata()).title).toBe('New session');
    await session.patch({ title: '新会话' });
    expect((await session.metadata()).title).toBe('New session');
    expect((await SessionService.list(db, workspace.id))[0].title).toBe('New session');
    await db.put('conversations', {
      id: session.id,
      messages: [
        {
          id: 'user-message',
          role: 'user',
          parts: [{ type: 'text', text: '新会话' }],
        },
      ],
    });
    expect((await session.metadata()).title).toBe('新会话');
    expect((await SessionService.list(db, workspace.id))[0].title).toBe('新会话');
    expect((await db.get('conversations', session.id))?.messages[0].parts[0]).toEqual({
      type: 'text',
      text: '新会话',
    });
  });

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

  it('shares current files and bindings across same-site sessions while keeping other sites separate', async () => {
    const db = await database();
    const first = await WorkspaceService.create(db, 'https://one.example.com');
    const second = await WorkspaceService.create(db, 'http://two.example.com:8080');
    const other = await WorkspaceService.create(db, 'https://example.org');
    expect(first.id).toBe(second.id);
    const a = await SessionService.create(db, first.id, 'https://one.example.com', 1);
    const b = await SessionService.create(db, second.id, 'http://two.example.com:8080', 2);
    await SessionService.create(db, other.id, 'https://example.org', 3);
    const file = await first.write('/workspace/main.js', 'original');
    await first.bind(file.path, {
      path: file.path,
      scriptId: '42',
      scriptRevision: 's1',
      fileRevision: file.revision,
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
    expect(await a.metadata()).not.toHaveProperty('baseline');
    expect((await SessionService.list(db, first.id)).map((session) => session.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    await expect(other.read(file.path)).rejects.toMatchObject({ code: 'not_found' });
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
    expect(await new SessionService(db, 'session-a').metadata()).not.toHaveProperty('baseline');
    expect((await workspace.metadata()).bindings[copy.path].scriptId).toBe('session-a');
    expect(Array.from(db.objectStoreNames)).not.toContain('revisions');
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
