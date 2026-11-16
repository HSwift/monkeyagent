import { expect, it } from 'vitest';
import { SerialQueue } from '../src/protocol/errors';

it('serializes manual and agent operations and never dispatches cancelled queued work', async () => {
  const queue = new SerialQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const a = queue.execute(async () => {
    order.push('agent start');
    await gate;
    order.push('agent end');
  });
  const abort = new AbortController();
  const b = queue
    .execute(async () => {
      order.push('cancelled');
    }, abort.signal)
    .catch((error) => error);
  const c = queue.execute(async () => {
    order.push('manual');
  });
  abort.abort();
  release();
  await Promise.all([a, b, c]);
  expect(order).toEqual(['agent start', 'agent end', 'manual']);
  expect((await b).name).toBe('AbortError');
});
