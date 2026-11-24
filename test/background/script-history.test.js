import { randomUUID } from 'node:crypto';
import storage from '@/background/utils/storage';
import { getScriptHistory, getScriptVersion, saveScriptVersion, scriptHistoryKey } from '@/background/utils/script-history';

jest.mock('@/background/utils/storage', () => ({
  __esModule: true,
  default: { code: { getOne: jest.fn(), toKey: id => `code:${id}` }, base: { getOne: jest.fn() }, api: { set: jest.fn() } },
}));
const records = new Map();
beforeEach(() => {
  records.clear();
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: randomUUID });
  storage.code.getOne.mockImplementation(async id => records.get(`code:${id}`));
  storage.base.getOne.mockImplementation(async key => JSON.parse(JSON.stringify(records.get(key) || [])));
  storage.api.set.mockReset().mockImplementation(async data => {
    Object.entries(data).forEach(([key, value]) => records.set(key, JSON.parse(JSON.stringify(value))));
  });
});
const code = n => `// ==UserScript==\n// @name Test\n// @version ${n}\n// ==/UserScript==\n// ${n}`;

test('records successful changed script saves by ID, deduplicates unchanged saves, and excludes toggles', async () => {
  await saveScriptVersion(1, code(1), {}, 'agent');
  await saveScriptVersion(1, code(1), { 'scr:1': { enabled: false } }, 'editor');
  await saveScriptVersion(1, code(2), {}, 'editor');
  await saveScriptVersion(2, code(1), {}, 'install');
  const history = await getScriptHistory(1);
  expect(history.map(item => [item.version, item.source])).toEqual([['2', 'editor'], ['1', 'agent']]);
  expect(history.every(item => !('code' in item))).toBe(true);
  expect((await getScriptVersion(1, history[1].id)).code).toBe(code(1));
  await expect(getScriptVersion(2, history[1].id)).rejects.toThrow('no longer exists');
});

test('seeds a preexisting script and retains only the latest 20 saves, including a restored version', async () => {
  records.set('code:1', code(0));
  await saveScriptVersion(1, code(1), {}, 'agent', 123);
  expect((await getScriptHistory(1))[1]).toMatchObject({ createdAt: 123, source: 'existing' });
  await Promise.all(Array.from({ length: 25 }, (_, i) => saveScriptVersion(1, code(i + 2), {}, 'editor')));
  expect(await getScriptHistory(1)).toHaveLength(20);
  expect(records.get('code:1')).toBe(code(26));
  const prior = await getScriptHistory(1);
  await saveScriptVersion(1, (await getScriptVersion(1, prior[10].id)).code, {}, 'agent');
  expect((await getScriptHistory(1))[0].id).not.toBe(prior[10].id);
  expect((await getScriptHistory(1))[1].id).toBe(prior[0].id);
});

test('a failed save leaves code and history intact and does not block the next save', async () => {
  await saveScriptVersion(1, code(1), {}, 'agent');
  const original = records.get(scriptHistoryKey(1));
  storage.api.set.mockRejectedValueOnce(new Error('Storage full'));
  await expect(saveScriptVersion(1, code(2), {}, 'editor')).rejects.toThrow('Storage full');
  expect(records.get('code:1')).toBe(code(1));
  expect(records.get(scriptHistoryKey(1))).toEqual(original);
  await saveScriptVersion(1, code(3), {}, 'editor');
  expect((await getScriptHistory(1)).map(item => item.version)).toEqual(['3', '1']);
});
