/** Background-only lifecycle cleanup. Contains no model or workspace logic. */
chrome.runtime.onConnect.addListener(port => {
  const root = chrome.runtime.getURL('');
  if (port.name !== 'monkeyagent:devtools:v1' || port.sender?.id !== chrome.runtime.id
    || !port.sender.url?.startsWith(`${root}agent/devtools.html`)) return;
  /** @type {number | undefined} */
  let tabId;
  port.onMessage.addListener(message => {
    if (message.type === 'bind' && Number.isInteger(message.tabId) && (tabId === undefined || tabId === message.tabId)) {
      tabId = message.tabId;
      port.postMessage({ type: 'bound', tabId });
    }
  });
  port.onDisconnect.addListener(() => {
    if (tabId !== undefined) chrome.debugger.detach({ tabId }, () => { void chrome.runtime.lastError; });
  });
});
