/* global copy */
// Paste this entire file into the extension Service Worker DevTools Console.
// Read-only: no database writes, no model requests, no UI changes or extension reload needed.
(async (copyToClipboard) => {
  // Leave empty for the most recently used session, or paste an ID from the printed table.
  const sessionId = '';
  const databaseName = 'monkeyagent-devtools-v1';
  const read = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  if (!(await indexedDB.databases()).some(database => database.name === databaseName)) {
    throw new Error('No Agent database in this context. Use the Monkey extension Service Worker Console.');
  }
  const db = await read(indexedDB.open(databaseName));
  let records;
  try {
    const sessions = (await read(db.transaction('sessions').objectStore('sessions').getAll()))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    console.table(sessions.map(({ id, title, targetUrl, updatedAt }) => ({
      id, title, targetUrl, updatedAt: new Date(updatedAt).toISOString(),
    })));
    const selected = sessionId ? sessions.find(item => item.id === sessionId) : sessions[0];
    if (!selected) throw new Error('Session not found. Set sessionId to an ID from the table.');
    const indexedStores = ['files', 'revisions', 'artifacts'];
    const tx = db.transaction(['workspaces', 'sessions', 'conversations', 'runs', 'operations', ...indexedStores], 'readonly');
    const [workspace, session, conversation, runs, operations, ...values] = await Promise.all([
      read(tx.objectStore('workspaces').get(selected.workspaceId)),
      read(tx.objectStore('sessions').get(selected.id)),
      read(tx.objectStore('conversations').get(selected.id)),
      read(tx.objectStore('runs').index('sessionId').getAll(selected.id)),
      read(tx.objectStore('operations').index('sessionId').getAll(selected.id)),
      ...indexedStores.map(name => read(tx.objectStore(name).index('workspaceId').getAll(selected.workspaceId))),
    ]);
    records = { workspace, session, conversation: conversation || { id: selected.id, messages: [] }, runs, operations, ...Object.fromEntries(indexedStores.map((name, i) => [name, values[i]])) };
  } finally {
    db.close();
  }
  // Large tool results are text artifacts. Screenshots retain references and metadata only.
  records.artifacts = await Promise.all(records.artifacts.map(async ({ blob, ...metadata }) => ({
    ...metadata,
    ...(/^(text\/|application\/json)/.test(metadata.mimeType) && blob.size <= 2 * 1024 * 1024
      ? { text: await blob.text() }
      : { contentOmitted: 'Binary content or text above 2 MiB' }),
  })));
  records.runs.sort((a, b) => a.startedAt - b.startedAt);
  records.operations.sort((a, b) => a.startedAt - b.startedAt);
  const storage = await chrome.storage.local.get('monkeyagent:model:v1');
  const settings = storage['monkeyagent:model:v1'] || {};
  const sensitive = key => /^(apikey|authorization|proxyauthorization|cookie|setcookie|password|passwd|clientsecret|accesstoken|refreshtoken|idtoken|token|secret)$/i.test(key.replace(/[-_\s]/g, ''));
  // A credential returned as a structured field may also appear in the REPL source.
  const secrets = new Set(settings.apiKey ? [settings.apiKey] : []);
  function collectSecrets(value) {
    if (Array.isArray(value)) value.forEach(collectSecrets);
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (sensitive(key) && typeof item === 'string' && item.length >= 4) secrets.add(item);
      collectSecrets(item);
    }
    else if (typeof value === 'string' && /^\s*[[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') collectSecrets(parsed);
      } catch { /* Plain source code is retained for diagnosis. */ }
    }
  }
  collectSecrets(records);
  const secretValues = [...secrets].sort((a, b) => b.length - a.length);
  function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive(key) ? '[REDACTED]' : redact(item)]));
    if (typeof value !== 'string') return value;
    for (const secret of secretValues) value = value.split(secret).join('[REDACTED]');
    // Tool outputs and text artifacts may themselves contain serialized JSON.
    if (/^\s*[[{]/.test(value)) {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') return JSON.stringify(redact(parsed));
      } catch { /* Keep non-JSON file contents as text. */ }
    }
    return value.replace(/\bBearer\s+[a-zA-Z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/https?:\/\/[^\s"'<>`]+/g, candidate => {
        try {
          const url = new URL(candidate);
          let changed = false;
          if (url.username || url.password) {
            url.username = '[REDACTED]';
            url.password = '';
            changed = true;
          }
          for (const key of [...url.searchParams.keys()]) if (sensitive(key)) {
            url.searchParams.set(key, '[REDACTED]');
            changed = true;
          }
          return changed ? url.href : candidate;
        } catch { return candidate; }
      });
  }
  const manifest = chrome.runtime.getManifest();
  const trace = redact({
    format: 'monkeyagent-debug', schemaVersion: 2, exportedAt: new Date().toISOString(),
    runtime: { extension: manifest.name, version: manifest.version, userAgent: navigator.userAgent },
    configurationAtExport: {
      provider: settings.provider, baseURL: settings.baseURL, model: settings.model,
      supportsImages: settings.supportsImages,
      autoCompactTokenLimit: settings.autoCompactTokenLimit ?? 64000,
    },
    ...records,
    limitations: [
      'Configuration is captured at export time, not reconstructed for each previous run.',
      'Raw model HTTP streams and in-memory browser event buffers are not persisted. Older runs may not contain step/token statistics.',
      'Screenshot binaries are omitted. Saved text artifacts are included up to 2 MiB each.',
      'Common authentication fields and the configured model key are redacted. Review scripts and page data before sharing.',
    ],
  });
  copyToClipboard(JSON.stringify(trace, null, 2));
  console.info('Agent debug data copied. Paste it into monkeyagent-debug.json.', {
    workspaceId: trace.workspace.id, sessionId: trace.session.id, title: trace.session.title,
    messages: trace.conversation.messages.length, runs: trace.runs.length,
    operations: trace.operations.length, files: trace.files.length,
  });
})(copy);
