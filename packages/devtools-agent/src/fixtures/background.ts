import '../background/lifecycle';
import { MockScriptStore } from './mock-script-store';

const store = new MockScriptStore();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.cmd !== 'monkeyagent:scripts:v1') return;
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('agent/')))
    return;
  const { op, args } = message.data;
  const task =
    op === 'list'
      ? store.list()
      : op === 'get'
        ? store.get(args.id)
        : op === 'save'
          ? store.save(args)
          : op === 'setEnabled'
            ? store.setEnabled(args.id, args.enabled)
            : Promise.reject(new Error('Unknown script operation.'));
  task.then(
    (value) => respond({ value }),
    (error) => respond({ error: { code: error.code ?? 'host_error', message: error.message } }),
  );
  return true;
});
