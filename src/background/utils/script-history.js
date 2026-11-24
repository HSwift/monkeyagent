import storage from './storage';

export const SCRIPT_HISTORY_LIMIT = 20;
export const scriptHistoryKey = id => `script-history:${id}`;
const pending = new Map();
const encoder = new TextEncoder();

function version(code, source, createdAt = Date.now()) {
  const metadata = code.match(/^[\t ]*\/\/[\t ]*==UserScript==[^\r\n]*\r?\n[\s\S]*?^[\t ]*\/\/[\t ]*==\/UserScript==/m)?.[0];
  return {
    id: crypto.randomUUID(), createdAt, source, code,
    version: metadata?.match(/^[\t ]*\/\/[\t ]*@version[\t ]+([^\r\n]*)/m)?.[1]?.trim() || null,
    size: encoder.encode(code).length,
  };
}

/** Serialize the code/history commit together; failed saves do not leave phantom versions. */
export function saveScriptVersion(id, code, data, source, previousAt) {
  const key = scriptHistoryKey(id);
  const task = (pending.get(id) || Promise.resolve()).then(async () => {
    const previous = await storage.code.getOne(id);
    if (previous === code) return storage.api.set(data);
    const history = await storage.base.getOne(key) || [];
    // The first update of a script created before history support must preserve its old code.
    if (typeof previous === 'string' && history.at(-1)?.code !== previous) {
      history.push(version(previous, 'existing', previousAt));
    }
    history.push(version(code, source));
    await storage.api.set({
      ...data,
      [storage.code.toKey(id)]: code,
      [key]: history.slice(-SCRIPT_HISTORY_LIMIT),
    });
  });
  const settled = task.catch(() => {});
  pending.set(id, settled);
  void settled.then(() => {
    if (pending.get(id) === settled) pending.delete(id);
  });
  return task;
}

export async function getScriptHistory(id) {
  const history = await storage.base.getOne(scriptHistoryKey(id)) || [];
  return history.slice().reverse().map(({ id: versionId, createdAt, source, version: declaredVersion, size }) => ({
    id: versionId, createdAt, source, version: declaredVersion, size,
  }));
}

export async function getScriptVersion(id, versionId) {
  const history = await storage.base.getOne(scriptHistoryKey(id)) || [];
  const entry = history.find(item => item.id === versionId);
  if (!entry) throw new Error('Script version no longer exists. Refresh its history.');
  return entry;
}
