import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshot } from '../extension/lib/core.js';

/**
 * Minimal chrome.storage.local fake. Keeps values as structured clones so the
 * storage layer cannot accidentally mutate what it reads.
 */
const store = new Map();
let bytes = 0;

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) {
          return Object.fromEntries([...store].map(([key, value]) => [key, structuredClone(value)]));
        }
        if (typeof keys === 'string') {
          return store.has(keys) ? { [keys]: structuredClone(store.get(keys)) } : {};
        }
        if (Array.isArray(keys)) {
          const out = {};
          for (const key of keys) if (store.has(key)) out[key] = structuredClone(store.get(key));
          return out;
        }
        const out = {};
        for (const [key, fallback] of Object.entries(keys)) {
          out[key] = store.has(key) ? structuredClone(store.get(key)) : fallback;
        }
        return out;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) store.set(key, structuredClone(value));
      },
      async remove(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        for (const key of list) store.delete(key);
      },
      async clear() {
        store.clear();
      },
      async getBytesInUse() {
        bytes = JSON.stringify([...store]).length;
        return bytes;
      },
    },
  },
};

const storage = await import('../extension/storage.js');

function fixture(name = '测试快照') {
  return buildSnapshot({
    windows: [
      {
        id: 1,
        focused: true,
        tabs: [
          { id: 1, url: 'https://example.com/a', title: 'A', pinned: false, active: true, index: 0, groupId: 10 },
          { id: 2, url: 'edge://settings', title: '设置', pinned: false, active: false, index: 1, groupId: -1 },
        ],
      },
    ],
    groups: [{ id: 10, title: '项目 A', color: 'blue', collapsed: false }],
    meta: { name, env: 'office', tags: ['test'] },
    now: new Date('2025-10-18T10:00:00Z'),
  });
}

test.beforeEach(async () => {
  store.clear();
  await storage.saveSettings({
    envs: [
      { id: 'office', label: '办公', color: '#4c6fff' },
      { id: 'home', label: '个人', color: '#18a957' },
    ],
    env: 'office',
  });
});

test('saveSnapshot writes a snapshot and a lightweight index entry', async () => {
  const snapshot = fixture();
  await storage.saveSnapshot(snapshot);

  const index = await storage.getIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].id, snapshot.id);
  assert.equal(index[0].stats.tabs, 2);
  assert.equal(index[0].name, '测试快照');

  const loaded = await storage.getSnapshot(snapshot.id);
  assert.equal(loaded.name, '测试快照');
  assert.equal(loaded.windows[0].groups[0].title, '项目 A');
  assert.equal(loaded.windows[0].tabs[1].restorable, false);
});

test('saveSnapshot updates an existing index entry instead of duplicating it', async () => {
  const snapshot = fixture();
  await storage.saveSnapshot(snapshot);
  await storage.saveSnapshot({ ...snapshot, name: '重命名后' });
  const index = await storage.getIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].name, '重命名后');
});

test('saveSnapshots and deleteSnapshot keep the index consistent', async () => {
  const a = fixture('A');
  const b = fixture('B');
  b.id = 'snap-b';
  await storage.saveSnapshots([a, b]);
  assert.equal((await storage.getIndex()).length, 2);
  await storage.deleteSnapshot(a.id);
  const index = await storage.getIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].id, 'snap-b');
  assert.equal(await storage.getSnapshot(a.id), null);
});

test('getIndex rebuilds a missing index from snapshot keys (crash recovery)', async () => {
  const snapshot = fixture('恢复我');
  await storage.saveSnapshot(snapshot);
  await chrome.storage.local.remove(storage.INDEX_KEY);
  const recovered = await storage.getIndex();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, snapshot.id);
  assert.equal(recovered[0].stats.tabs, 2);

  const storedIndex = await chrome.storage.local.get(storage.INDEX_KEY);
  assert.equal(storedIndex[storage.INDEX_KEY].length, 1);
});

test('clearAll removes orphan snapshots but keeps settings', async () => {
  const snapshot = fixture();
  await storage.saveSnapshot(snapshot);
  // Simulate an orphan snapshot that is not present in the index.
  await chrome.storage.local.set({ 'tbas.snapshot.orphan': fixture('孤儿') });
  await storage.clearAll();
  assert.equal((await storage.getIndex()).length, 0);
  assert.equal(await storage.getSnapshot(snapshot.id), null);
  assert.equal((await chrome.storage.local.get('tbas.snapshot.orphan'))['tbas.snapshot.orphan'], undefined);
  const settings = await storage.getSettings();
  assert.equal(settings.envs.length, 2);
});

test('settings round-trip, normalize environments and fall back safely', async () => {
  const defaults = await storage.getSettings();
  assert.equal(defaults.env, 'office');

  const saved = await storage.saveSettings({
    envs: [
      { id: 'client site', label: '客户现场', color: '#f59e0b' },
      { id: 'client-site', label: '重复', color: 'bad' },
      { label: '', color: '#18a957' },
    ],
    env: 'client-site',
    autoBackup: true,
    dedupeOnCapture: true,
    restoreTarget: 'current',
  });
  assert.deepEqual(saved.envs.map((env) => env.id), ['client-site', 'env-2']);
  assert.equal(saved.envs[0].label, '客户现场');
  assert.equal(saved.envs[1].color, '#18a957');
  assert.equal(saved.env, 'client-site');
  assert.equal(saved.autoBackup, true);
  assert.equal(saved.dedupeOnCapture, true);
  assert.equal(saved.restoreTarget, 'current');

  const reloaded = await storage.getSettings();
  assert.equal(reloaded.env, 'client-site');
  assert.equal(reloaded.autoBackup, true);
});

test('freshSnapshotId avoids collisions and safeFileName strips path separators', () => {
  const used = new Set(['snap-x']);
  const id = storage.freshSnapshotId(used);
  assert.match(id, /^snap-\d{8}-\d{6}-[a-z0-9]{4}$/);
  assert.equal(storage.safeFileName('a/b:c * d'), 'a-b-c-d');
  assert.equal(storage.safeFileName('   '), 'snapshot');
});
