import { getScriptById, getScripts, parseScript, updateScriptInfo } from './db';
import { addOwnCommands } from './init';
import storage from './storage';
import { getScriptHistory, getScriptVersion } from './script-history';

// The Agent owns its runtime; script versions are owned by the host save path.
const namespace = 'monkeyagent:scripts:v1';
const agentRoot = chrome.runtime.getURL('agent/');
const summary = script => ({
  id: `${script.props.id}`,
  name: script.meta.name,
  enabled: !!script.config.enabled,
});
const find = id => {
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) throw new Error('Invalid script ID.');
  const script = getScriptById(+id);
  if (!script || script.config.removed) throw new Error('Script not found.');
  return script;
};
async function snapshot(id) {
  const script = find(id);
  const code = await storage.code.getOne(+id);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([code, !!script.config.enabled])));
  const revision = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return { ...summary(script), code, revision };
}
addOwnCommands({
  [namespace]: async (message, sender) => {
    if (sender?.id !== chrome.runtime.id || !sender.url?.startsWith(agentRoot)) throw new Error('Agent extension page required.');
    const url = new URL(sender.url);
    if (!['/agent/devtools.html', '/agent/panel.html'].includes(url.pathname)) throw new Error('Agent extension page required.');
    const { op, args = {} } = message;
    switch (op) {
      case 'list': return getScripts().map(summary);
      case 'get': return snapshot(args.id);
      case 'history': find(args.id); return getScriptHistory(+args.id);
      case 'version': {
        find(args.id);
        if (typeof args.versionId !== 'string') throw new Error('Invalid script version.');
        return getScriptVersion(+args.id, args.versionId);
      }
      case 'save': {
        if (typeof args.code !== 'string' || args.code.length > 2 * 1024 * 1024) throw new Error('Invalid script code.');
        if (args.id != null) find(args.id);
        const result = await parseScript({ code: args.code, id: args.id == null ? undefined : +args.id, isNew: args.id == null, reloadTab: false, historySource: 'agent' });
        return snapshot(`${result.where.id}`);
      }
      case 'setEnabled': {
        const script = find(args.id);
        if (typeof args.enabled !== 'boolean') throw new Error('enabled must be boolean.');
        await updateScriptInfo(script.props.id, { config: { enabled: +args.enabled }, props: { lastModified: Date.now() } });
        return null;
      }
      default: throw new Error('Unknown Agent script operation.');
    }
  },
});
