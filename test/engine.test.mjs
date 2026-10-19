import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSnapshot } from '../extension/lib/core.js';
import { createEngine } from '../extension/lib/engine.js';
import { createFakeBrowser } from './helpers/fake-browser.mjs';

function fixtureBrowser() {
  return createFakeBrowser({
    windows: [
      {
        id: 1,
        focused: true,
        tabs: [
          { id: 101, url: 'https://example.com/alpha', title: 'Alpha', pinned: true, active: true, index: 0, groupId: 10 },
          { id: 102, url: 'https://example.com/alpha?utm_source=x', title: 'Alpha dup', pinned: false, active: false, index: 1, groupId: 10 },
          { id: 103, url: 'https://example.com/beta', title: 'Beta', pinned: false, active: false, index: 2, groupId: 11 },
          { id: 104, url: 'edge://settings', title: 'Edge 设置', pinned: false, active: false, index: 3, groupId: -1 },
          { id: 105, url: 'chrome-extension://testext/dashboard.html', title: 'TBAS', pinned: false, active: false, index: 4, groupId: -1 },
        ],
      },
      {
        id: 2,
        focused: false,
        tabs: [
          { id: 201, url: 'https://example.org/', title: 'Org', pinned: false, active: true, index: 0, groupId: -1 },
        ],
      },
    ],
    groups: [
      { id: 10, title: 'Alpha 组', color: 'blue', collapsed: false },
      { id: 11, title: 'Beta 组', color: 'red', collapsed: true },
    ],
  });
}

async function captureFixture(engine, api) {
  return engine.capture({
    scope: 'all',
    excludeTabIds: [105],
    excludeUrlPrefixes: [api.runtime.getURL('')],
    env: 'office',
    name: '测试快照',
    dedupe: true,
  });
}

test('engine.capture excludes its own UI and chrome-extension tabs, applies dedupe', async () => {
  const { api } = fixtureBrowser();
  const engine = createEngine(api);
  const { snapshot, windows } = await captureFixture(engine, api);

  assert.equal(windows.length, 2);
  assert.equal(snapshot.name, '测试快照');
  assert.equal(snapshot.source.browser, 'Chromium');
  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0].focused, true);
  assert.deepEqual(
    snapshot.windows[0].tabs.map((tab) => tab.url),
    ['https://example.com/alpha', 'https://example.com/beta', 'edge://settings'],
  );
  assert.deepEqual(snapshot.windows[0].groups.map((group) => group.title), ['Alpha 组', 'Beta 组']);
  assert.equal(snapshot.stats.tabs, 4);
  assert.equal(snapshot.stats.groups, 2);
  assert.equal(snapshot.stats.unrestorable, 1);
  assert.equal(snapshot.stats.duplicates, 0);
  assert.equal(snapshot.windows[0].tabs[0].pinned, true);
});

test('engine.capture returns a live-tab map when dedupe is off', async () => {
  const { api } = fixtureBrowser();
  const engine = createEngine(api);
  const { snapshot, liveByKey } = await engine.capture({
    scope: 'all',
    excludeTabIds: [105],
    excludeUrlPrefixes: [api.runtime.getURL('')],
    env: 'office',
    name: '选择测试',
    dedupe: false,
  });

  assert.equal(liveByKey['w1.t1'], 101);
  assert.equal(liveByKey['w1.t2'], 102);
  assert.equal(liveByKey['w1.t3'], 103);
  assert.equal(liveByKey['w1.t4'], 104);
  assert.equal(liveByKey['w2.t1'], 201);
  assert.equal(Object.keys(liveByKey).length, snapshot.stats.tabs);

  const deduped = await engine.capture({
    scope: 'all',
    excludeTabIds: [105],
    excludeUrlPrefixes: [api.runtime.getURL('')],
    dedupe: true,
  });
  assert.equal(deduped.liveByKey, null);
});

test('engine.capture can restrict to the current window and throws when nothing remains', async () => {
  const { api } = fixtureBrowser();
  const engine = createEngine(api);
  const { snapshot } = await engine.capture({ scope: 'current', windowId: 2, excludeTabIds: [], env: 'home' });
  assert.equal(snapshot.windows.length, 1);
  assert.equal(snapshot.windows[0].tabs.length, 1);
  assert.equal(snapshot.env, 'home');

  await assert.rejects(
    () => engine.capture({ scope: 'current', windowId: 1, excludeTabIds: [101, 102, 103, 104, 105], env: 'office' }),
    /没有可保存的标签页/,
  );
});

test('engine.restore recreates windows, tab order, pins, groups and skips internal pages', async () => {
  const { api, state } = fixtureBrowser();
  const engine = createEngine(api);
  const { snapshot } = await captureFixture(engine, api);

  const result = await engine.restore(snapshot, { mode: 'new' });
  assert.equal(result.created, 3);
  assert.equal(result.groups, 2);
  assert.equal(result.total, 3);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].url, 'edge://settings');
  assert.equal(result.windowIds.length, 2);
  assert.equal(result.errors.length, 0);

  const restoredFirst = state.windows.find((win) => win.id === result.windowIds[0]);
  assert.deepEqual(
    restoredFirst.tabs.map((tab) => tab.url),
    ['https://example.com/alpha', 'https://example.com/beta'],
  );
  assert.equal(restoredFirst.tabs[0].pinned, true);
  assert.equal(restoredFirst.tabs[0].active, true);
  assert.equal(restoredFirst.focused, true);

  const groups = state.groups.filter((group) => group.windowId === restoredFirst.id);
  assert.deepEqual(
    groups.map((group) => [group.title, group.color, group.collapsed]).sort(),
    [
      ['Alpha 组', 'blue', false],
      ['Beta 组', 'red', true],
    ],
  );

  const restoredSecond = state.windows.find((win) => win.id === result.windowIds[1]);
  assert.deepEqual(restoredSecond.tabs.map((tab) => tab.url), ['https://example.org/']);
});

test('engine.restore focuses the first window when the snapshot has no focused flag', async () => {
  const snapshot = buildSnapshot({
    windows: [
      {
        id: 1,
        focused: false,
        tabs: [{ id: 1, url: 'https://focus.test/', title: 'Focus', pinned: false, active: true, index: 0, groupId: -1 }],
      },
    ],
  });
  const { api, state } = createFakeBrowser();
  const engine = createEngine(api);
  const result = await engine.restore(snapshot, { mode: 'new' });
  assert.equal(result.created, 1);
  const restored = state.windows.find((win) => win.id === result.windowIds[0]);
  assert.equal(restored.focused, true);
});

test('engine.restore supports restoring selected groups into the current window', async () => {
  const source = fixtureBrowser();
  const sourceEngine = createEngine(source.api);
  const { snapshot } = await captureFixture(sourceEngine, source.api);

  const { api, state } = createFakeBrowser({
    windows: [
      {
        id: 300,
        focused: true,
        tabs: [
          { id: 900, url: 'https://keep.me/', title: 'Keep', pinned: false, active: true, index: 0, groupId: -1 },
        ],
      },
    ],
  });
  const engine = createEngine(api);
  const result = await engine.restore(snapshot, {
    mode: 'current',
    targetWindowId: 300,
    selectedTabKeys: ['w1.t1', 'w1.t2'],
  });

  assert.equal(result.created, 2);
  assert.equal(result.groups, 2);
  assert.equal(result.windowIds.length, 0);
  const target = state.windows.find((win) => win.id === 300);
  assert.deepEqual(
    target.tabs.map((tab) => tab.url),
    ['https://keep.me/', 'https://example.com/alpha', 'https://example.com/beta'],
  );
  assert.equal(target.tabs[0].active, false);
  const groups = state.groups.filter((group) => group.windowId === 300);
  assert.deepEqual(groups.map((group) => group.title).sort(), ['Alpha 组', 'Beta 组']);
});

test('engine.closeTabs closes only selected tabs and leaves the rest untouched', async () => {
  const { api, state } = createFakeBrowser({
    windows: [
      {
        id: 1,
        focused: true,
        tabs: [
          { id: 1, url: 'chrome-extension://testext/dashboard.html', title: 'TBAS', pinned: false, active: true, index: 0, groupId: -1 },
          { id: 2, url: 'https://keep.test/', title: 'Keep', pinned: false, active: false, index: 1, groupId: -1 },
        ],
      },
      {
        id: 2,
        focused: false,
        tabs: [
          { id: 3, url: 'https://close.test/a', title: 'A', pinned: false, active: true, index: 0, groupId: -1 },
          { id: 4, url: 'https://close.test/b', title: 'B', pinned: false, active: false, index: 1, groupId: -1 },
        ],
      },
    ],
  });
  const engine = createEngine(api);
  const result = await engine.closeTabs([3, 4, 9999], { keepTabId: 1 });
  assert.equal(result.closed, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(state.windows.length, 1);
  assert.deepEqual(state.windows[0].tabs.map((tab) => tab.id), [1, 2]);
});

test('engine.closeCaptured keeps the dashboard tab and closes other windows', async () => {
  const { api, state } = createFakeBrowser({
    windows: [
      {
        id: 1,
        focused: true,
        tabs: [
          { id: 1, url: 'chrome-extension://testext/dashboard.html', title: 'TBAS', pinned: false, active: true, index: 0, groupId: -1 },
          { id: 2, url: 'https://work.example/a', title: 'Work', pinned: false, active: false, index: 1, groupId: -1 },
        ],
      },
      {
        id: 2,
        focused: false,
        tabs: [
          { id: 3, url: 'https://work.example/b', title: 'B', pinned: false, active: true, index: 0, groupId: -1 },
          { id: 4, url: 'https://work.example/c', title: 'C', pinned: false, active: false, index: 1, groupId: -1 },
        ],
      },
    ],
  });
  const engine = createEngine(api);
  const result = await engine.closeCaptured(
    [
      { id: 1, tabs: [{ id: 1 }, { id: 2 }] },
      { id: 2, tabs: [{ id: 3 }, { id: 4 }] },
    ],
    { keepTabId: 1 },
  );

  assert.equal(result.closed, 3);
  assert.equal(result.keptWindows, 1);
  assert.equal(state.windows.length, 1);
  assert.deepEqual(state.windows[0].tabs.map((tab) => tab.id), [1]);
  assert.equal(state.windows[0].tabs[0].active, true);
});

test('engine.restore rejects invalid and all-internal snapshots', async () => {
  const { api } = createFakeBrowser();
  const engine = createEngine(api);
  await assert.rejects(() => engine.restore({ windows: [] }, { mode: 'new' }), /快照无效/);

  const internalOnly = buildSnapshot({
    windows: [
      {
        id: 1,
        focused: true,
        tabs: [{ id: 1, url: 'edge://settings', title: '设置', pinned: false, active: true, index: 0, groupId: -1 }],
      },
    ],
  });
  await assert.rejects(() => engine.restore(internalOnly, { mode: 'new' }), /没有可恢复的标签页/);
});

test('engine.restore reports tab creation errors without aborting the rest', async () => {
  const { api, state } = createFakeBrowser({
    windows: [
      {
        id: 1,
        focused: true,
        tabs: [
          { id: 1, url: 'https://ok.test/', title: 'OK', pinned: false, active: true, index: 0, groupId: -1 },
          { id: 2, url: 'https://bad.test/', title: 'Bad', pinned: false, active: false, index: 1, groupId: -1 },
        ],
      },
    ],
  });
  const engine = createEngine(api);
  const snapshot = buildSnapshot({
    windows: [
      {
        id: 1,
        focused: true,
        tabs: [
          { id: 1, url: 'https://ok.test/', title: 'OK', pinned: false, active: true, index: 0, groupId: -1 },
          { id: 2, url: 'https://bad.test/', title: 'Bad', pinned: false, active: false, index: 1, groupId: -1 },
        ],
      },
    ],
  });

  const originalCreate = api.tabs.create;
  api.tabs.create = async (props) => {
    if (props.url.includes('bad.test')) throw new Error('simulated failure');
    return originalCreate(props);
  };

  const result = await engine.restore(snapshot, { mode: 'new' });
  assert.equal(result.created, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /simulated failure/);
  const restored = state.windows.find((win) => win.id === result.windowIds[0]);
  assert.deepEqual(restored.tabs.map((tab) => tab.url), ['https://ok.test/']);
});
