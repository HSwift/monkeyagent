import { Controller } from './controller';
import { ExtensionScriptStore } from '../scripts/adapter';
import { LifecycleClient } from './lifecycle';

const fixture = chrome.runtime.getManifest().name === 'Monkey Agent Fixture';
const tabId =
  chrome.devtools?.inspectedWindow?.tabId ??
  (fixture ? Number(new URL(location.href).searchParams.get('tabId')) : 0);
if (!Number.isInteger(tabId) || tabId <= 0)
  throw new Error('Agent must be opened from the inspected tab DevTools.');
const tab = await chrome.tabs.get(tabId);
const lifecycle = new LifecycleClient(tabId);
await lifecycle.ensure();
const controller = await new Controller(tabId, new ExtensionScriptStore(), tab.url ?? '', () =>
  lifecycle.ensure(),
).init();
const origin = new URL(location.href).origin;
const panelDocuments = new WeakMap<Window, Document>();
function connect(panelWindow: Window) {
  if (panelDocuments.get(panelWindow) === panelWindow.document) return;
  panelDocuments.set(panelWindow, panelWindow.document);
  const channel = new MessageChannel();
  controller.attach(channel.port1);
  panelWindow.postMessage({ type: 'monkeyagent:connect' }, origin, [channel.port2]);
}
if (chrome.devtools?.panels) {
  chrome.devtools.panels.create('Agent', '', 'agent/panel.html', (panel) =>
    panel.onShown.addListener((window) => connect(window as Window)),
  );
} else if (fixture) {
  // Standalone fixture exercises the exact same Controller and MessageChannel without Monkey.
  const panel = document.createElement('iframe');
  panel.src = 'panel.html';
  panel.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0';
  panel.addEventListener('load', () => connect(panel.contentWindow!));
  document.body.append(panel);
}
window.addEventListener('pagehide', () => {
  void controller.dispose();
  lifecycle.dispose();
});
