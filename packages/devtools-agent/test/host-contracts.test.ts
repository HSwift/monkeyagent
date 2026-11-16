import { expect, it } from 'vitest';
import { validateHostCall } from '../src/repl/contracts';

it('rejects misspelled helper options and invalid argument types before dispatch', () => {
  expect(() => validateHostCall('browser.reload', [{ timeout: 1000 }])).toThrow('timeout');
  expect(() => validateHostCall('scripts.setEnabled', ['/workspace/a.js', 'false'])).toThrow(
    'scripts.setEnabled',
  );
  expect(() => validateHostCall('browser.evaluate', [{ expression: 'document.title' }])).toThrow(
    'browser.evaluate',
  );
  expect(() => validateHostCall('fs.read', ['/workspace/a.js', { limit: 0 }])).toThrow();
  expect(() => validateHostCall('toString', [])).toThrow('Unknown host method');
});

it('leaves native CDP parameters to the browser and never strips or rewrites them', () => {
  const params = {
    expression: 'document.body',
    returnByValue: false,
    serializationOptions: { serialization: 'deep', maxDepth: 2 },
    browserSpecificFutureOption: true,
  };
  const before = structuredClone(params);
  expect(() => validateHostCall('browser.send', ['Runtime.evaluate', params])).not.toThrow();
  expect(params).toEqual(before);
  expect(() => validateHostCall('browser.send', ['Page.navigate'])).not.toThrow();
});
