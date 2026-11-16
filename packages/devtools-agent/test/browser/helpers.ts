import type { CDPSession, BrowserContext, Frame } from '@playwright/test';

export async function routeExampleSite(context: BrowserContext) {
  await context.route('https://example.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Example Domain</title><h1>Example Domain</h1><p>Local browser test fixture.</p>',
    }),
  );
}

export async function instrumentPanel(context: BrowserContext) {
  await context.addInitScript(() =>
    window.addEventListener('message', (event) => {
      if (
        event.origin === location.origin &&
        event.data?.type === 'monkeyagent:connect' &&
        event.ports[0]
      )
        (window as any).__testAgentPort = event.ports[0];
    }),
  );
}
export function rpc<T = any>(frame: Frame, method: string, ...args: unknown[]): Promise<T> {
  return frame.evaluate(
    ({ method, args }) =>
      new Promise((resolve, reject) => {
        const port = (window as any).__testAgentPort as MessagePort;
        const id = crypto.randomUUID();
        const listener = (event: MessageEvent) => {
          if (event.data.type !== 'response' || event.data.id !== id) return;
          port.removeEventListener('message', listener);
          if (event.data.error) reject(new Error(JSON.stringify(event.data.error)));
          else {
            const result = event.data.result;
            resolve(
              result?.blob instanceof Blob
                ? { ...result, blob: { size: result.blob.size, type: result.blob.type } }
                : result,
            );
          }
        };
        port.addEventListener('message', listener);
        port.postMessage({ type: 'request', id, method, args });
      }),
    { method, args },
  ) as Promise<T>;
}

/** CDP is used only by the test driver to reach the real hidden F12 extension page. */
export async function targetSession(root: CDPSession, targetId: string) {
  const { sessionId } = await root.send('Target.attachToTarget', { targetId, flatten: false });
  let id = 0;
  return {
    async send(method: string, params: object = {}): Promise<any> {
      const current = ++id;
      const response = new Promise((resolve, reject) => {
        const listener = (event: { sessionId: string; message: string }) => {
          if (event.sessionId !== sessionId) return;
          const data = JSON.parse(event.message);
          if (data.id !== current) return;
          root.off('Target.receivedMessageFromTarget', listener);
          if (data.error) reject(new Error(JSON.stringify(data.error)));
          else if (method === 'Runtime.evaluate' && data.result?.exceptionDetails)
            reject(new Error(JSON.stringify(data.result.exceptionDetails)));
          else resolve(data.result);
        };
        root.on('Target.receivedMessageFromTarget', listener);
      });
      await root.send('Target.sendMessageToTarget', {
        sessionId,
        message: JSON.stringify({ id: current, method, params }),
      });
      return response;
    },
  };
}
