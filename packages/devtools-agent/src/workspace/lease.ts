import { AgentError } from '../protocol/errors';

/** Locks are automatically released if the DevTools renderer exits. */
export function acquireWorkspaceLease(id: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    void navigator.locks
      .request(
        `monkeyagent:workspace:${id}`,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (!lock) {
            reject(
              new AgentError(
                'workspace_busy',
                'This conversation is open in another DevTools window. Open a new session or close the other window first.',
              ),
            );
            return;
          }
          await new Promise<void>((release) => resolve(release));
        },
      )
      .catch(reject);
  });
}
