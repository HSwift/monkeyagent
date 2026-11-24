import { Controller } from '../devtools/controller';
import { MockScriptStore } from './mock-script-store';
import type { ControllerClient } from '../protocol/client';

/** UI development only. The production build erases the import of this module. */
export async function startPreview(client: ControllerClient) {
  const event = () => {
    const listeners = new Set<(...args: unknown[]) => void>();
    return {
      addListener: (fn: (...args: unknown[]) => void) => listeners.add(fn),
      removeListener: (fn: (...args: unknown[]) => void) => listeners.delete(fn),
    };
  };
  const runtime: { lastError?: { message: string } } = {};
  const unavailable = (_source: unknown, _version: unknown, callback: () => void) => {
    runtime.lastError = {
      message:
        'Browser debugging is unavailable in the web preview. Load fixtures/extension or the Monkey MV3 build, then open DevTools on the target page.',
    };
    callback();
    delete runtime.lastError;
  };
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      runtime,
      tabs: { get: async () => ({ url: 'https://preview.invalid/' }), query: async () => [] },
      debugger: { onEvent: event(), onDetach: event(), attach: unavailable },
    },
  });
  const controller = await new Controller(
    0,
    new MockScriptStore(),
    'https://preview.invalid/',
  ).init();
  const channel = new MessageChannel();
  controller.attach(channel.port1);
  client.connect(channel.port2);
  window.addEventListener('pagehide', () => {
    void controller.dispose();
  });
}
