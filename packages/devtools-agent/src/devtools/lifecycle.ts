import { AgentError } from '../protocol/errors';

/** Rebind before attaching: an idle extension service worker may have been suspended. */
export class LifecycleClient {
  private port?: chrome.runtime.Port;
  constructor(private tabId: number) {}
  async ensure() {
    let port = this.port;
    if (!port) {
      port = this.port = chrome.runtime.connect({ name: 'monkeyagent:devtools:v1' });
      const current = port;
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        if (this.port === current) this.port = undefined;
      });
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        port.onMessage.removeListener(message);
        port.onDisconnect.removeListener(disconnect);
      };
      const message = (data: { type: string; tabId: number }) => {
        if (data.type === 'bound' && data.tabId === this.tabId) {
          cleanup();
          resolve();
        }
      };
      const disconnect = () => {
        void chrome.runtime.lastError;
        if (this.port === port) this.port = undefined;
        cleanup();
        reject(
          new AgentError(
            'lifecycle_unavailable',
            'Background lifecycle connection closed. Retry connecting debugging.',
          ),
        );
      };
      const timer = setTimeout(() => {
        cleanup();
        if (this.port === port) this.port = undefined;
        port.disconnect();
        reject(new AgentError('lifecycle_unavailable', 'Background lifecycle binding timed out.'));
      }, 5000);
      port.onMessage.addListener(message);
      port.onDisconnect.addListener(disconnect);
      try {
        port.postMessage({ type: 'bind', tabId: this.tabId });
      } catch {
        disconnect();
      }
    });
  }
  dispose() {
    this.port?.disconnect();
    this.port = undefined;
  }
}
