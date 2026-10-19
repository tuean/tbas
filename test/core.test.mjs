import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allRestorableTabKeys,
  buildBundle,
  buildRestorePlan,
  buildSnapshot,
  computeStats,
  createSnapshotId,
  dedupeSnapshot,
  escapeHtml,
  formatStats,
  isInternalUrl,
  isRestorableUrl,
  mergeSnapshots,
  normalizeEnvs,
  normalizeUrl,
  parseSnapshotText,
  renderHTMLReport,
  renderMarkdown,
  renderTree,
  renderURLList,
  searchSnapshot,
  selectSnapshotTabs,
  snapshotSearchText,
  tabKeyOf,
  validateSnapshot,
} from '../extension/lib/core.js';

const GROUP_A = { id: 10, title: '项目 A', color: 'blue', collapsed: false };
const GROUP_B = { id: 11, title: '文档', color: 'green', collapsed: true };

function fixtureWindows() {
  return [
    {
      id: 1,
      focused: true,
      tabs: [
        { id: 101, url: 'https://example.com/a?utm_source=news', title: 'A 页面', pinned: true, active: true, index: 0, groupId: 10 },
        { id: 102, url: 'https://example.com/a', title: 'A 页面（重复）', pinned: false, active: false, index: 1, groupId: 10 },
        { id: 103, url: 'https://example.com/docs', title: '文档', pinned: false, active: false, index: 2, groupId: 11 },
        { id: 104, url: 'edge://settings', title: 'Edge 设置', pinned: false, active: false, index: 3, groupId: -1 },
      ],
    },
    {
      id: 2,
      focused: false,
      tabs: [
        { id: 201, url: 'https://example.org/', title: '另一个窗口', pinned: false, active: true, index: 0, groupId: -1 },
        { id: 202, url: 'file:///tmp/report.html', title: '本地报告', pinned: false, active: false, index: 1, groupId: -1 },
      ],
    },
  ];
}

function fixtureSnapshot(overrides = {}) {
  const snapshot = buildSnapshot({
    windows: fixtureWindows(),
    groups: [GROUP_A, GROUP_B],
    meta: { name: '周五下班', env: 'office', tags: ['w41'], browser: 'Edge', extensionVersion: '0.1.0' },
    now: new Date('2025-10-18T10:00:00Z'),
  });
  return { ...snapshot, ...overrides };
}

test('normalizeUrl removes tracking params, sorts params and keeps fragments', () => {
  assert.equal(
    normalizeUrl('https://Example.com:443/a/?utm_source=x&b=2&a=1#frag'),
    'https://example.com/a/?a=1&b=2#frag',
  );
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/a?fbclid=1&gclid=2'), 'https://example.com/a');
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('buildSnapshot maps groups, order, active state and restorable flags', () => {
  const snapshot = fixtureSnapshot();
  assert.equal(snapshot.schema, 'tbas.snapshot');
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.name, '周五下班');
  assert.equal(snapshot.env, 'office');
  assert.deepEqual(snapshot.tags, ['w41']);

  assert.equal(snapshot.windows.length, 2);
  assert.equal(snapshot.windows[0].key, 'w1');
  assert.equal(snapshot.windows[0].focused, true);
  assert.deepEqual(
    snapshot.windows[0].groups.map((group) => [group.key, group.title, group.color]),
    [
      ['g1', '项目 A', 'blue'],
      ['g2', '文档', 'green'],
    ],
  );
  assert.deepEqual(
    snapshot.windows[0].tabs.map((tab) => [tab.key, tab.group, tab.active, tab.restorable]),
    [
      ['t1', 'g1', true, true],
      ['t2', 'g1', false, true],
      ['t3', 'g2', false, true],
      ['t4', null, false, false],
    ],
  );
  assert.equal(snapshot.stats.windows, 2);
  assert.equal(snapshot.stats.groups, 2);
  assert.equal(snapshot.stats.tabs, 6);
  assert.equal(snapshot.stats.pinned, 1);
  assert.equal(snapshot.stats.duplicates, 1);
  assert.equal(snapshot.stats.restorable, 5);
  assert.equal(snapshot.stats.unrestorable, 1);
});

test('dedupeSnapshot keeps the first tab and transfers pinned/active state', () => {
  const snapshot = fixtureSnapshot();
  // Make the second (tracking-param) tab the active one; the first is pinned.
  snapshot.windows[0].tabs[0].active = false;
  snapshot.windows[0].tabs[1].active = true;

  const { snapshot: cleaned, removed } = dedupeSnapshot(snapshot, { scope: 'window' });
  assert.equal(removed.length, 1);
  assert.equal(removed[0].url, 'https://example.com/a');
  assert.deepEqual(
    cleaned.windows[0].tabs.map((tab) => tab.url),
    ['https://example.com/a?utm_source=news', 'https://example.com/docs', 'edge://settings'],
  );
  assert.equal(cleaned.windows[0].tabs[0].pinned, true);
  assert.equal(cleaned.windows[0].tabs[0].active, true);
  assert.equal(cleaned.windows[0].tabs.filter((tab) => tab.active).length, 1);
  assert.equal(cleaned.stats.duplicates, 0);
  assert.equal(cleaned.stats.tabs, 5);
});

test('dedupeSnapshot can dedupe across windows', () => {
  const snapshot = fixtureSnapshot();
  snapshot.windows[1].tabs[0].url = 'https://example.com/a';
  const { snapshot: sameWindowScope } = dedupeSnapshot(snapshot, { scope: 'window' });
  assert.equal(sameWindowScope.stats.tabs, 5);
  const { snapshot: snapshotScope } = dedupeSnapshot(snapshot, { scope: 'snapshot' });
  assert.equal(snapshotScope.stats.tabs, 4);
});

test('validateSnapshot sanitizes keys, drops orphans and keeps one active tab', () => {
  const result = validateSnapshot({
    schema: 'tbas.snapshot',
    id: 'bad id !',
    name: '',
    env: 'home',
    windows: [
      {
        key: 'w1',
        focused: true,
        groups: [
          { key: 'g1', title: '好的组', color: 'pink', collapsed: true },
          { key: 'g1', title: '重复键', color: 'nope' },
        ],
        tabs: [
          { key: 't1', url: 'https://a.test/', title: 'a', active: true, group: 'g1' },
          { key: 't1', url: 'https://b.test/', title: 'b', active: true, group: 'g2' },
          { key: 't3', url: 'edge://flags', title: 'flags', group: 'nope' },
        ],
      },
    ],
  });
  assert.equal(result.ok, true);
  const snapshot = result.snapshot;
  assert.equal(/^snap-/.test(snapshot.id), true);
  assert.equal(snapshot.name.startsWith('个人 · '), true);
  assert.equal(snapshot.windows[0].tabs.length, 3);
  assert.deepEqual(snapshot.windows[0].tabs.map((tab) => tab.group), ['g1', null, null]);
  assert.deepEqual(snapshot.windows[0].groups.map((group) => group.key), ['g1']);
  assert.equal(snapshot.windows[0].tabs.filter((tab) => tab.active).length, 1);
  assert.equal(snapshot.stats.unrestorable, 1);
});

test('validateSnapshot rejects malformed payloads and future versions', () => {
  assert.equal(validateSnapshot(null).ok, false);
  assert.equal(validateSnapshot({ windows: 'nope' }).ok, false);
  assert.equal(validateSnapshot({ windows: [{ tabs: [] }] }).ok, false);
  assert.equal(validateSnapshot({ version: 99, windows: [{ tabs: [{ url: 'https://a.test' }] }] }).ok, false);
});

test('parseSnapshotText accepts single snapshots, bundles and arrays', () => {
  const snapshot = fixtureSnapshot();
  const single = parseSnapshotText(JSON.stringify(snapshot));
  assert.equal(single.ok, true);
  assert.equal(single.kind, 'snapshot');
  assert.equal(single.snapshots.length, 1);

  const bundle = buildBundle([snapshot, { ...snapshot, id: 'second', name: '第二个' }]);
  const bundleResult = parseSnapshotText(JSON.stringify(bundle));
  assert.equal(bundleResult.ok, true);
  assert.equal(bundleResult.kind, 'bundle');
  assert.equal(bundleResult.snapshots.length, 2);

  const arrayResult = parseSnapshotText(JSON.stringify([snapshot]));
  assert.equal(arrayResult.ok, true);
  assert.equal(arrayResult.snapshots.length, 1);

  const broken = parseSnapshotText('{not json', { filename: 'x.json' });
  assert.equal(broken.ok, false);
  assert.match(broken.errors[0], /x\.json/);

  const mixed = parseSnapshotText(JSON.stringify([snapshot, { nope: true }]));
  assert.equal(mixed.ok, true);
  assert.equal(mixed.errors.length, 1);
});

test('buildRestorePlan selects tabs, skips internal pages and filters groups', () => {
  const snapshot = fixtureSnapshot();
  const selection = allRestorableTabKeys(snapshot);
  assert.equal(selection.size, 5);
  const plan = buildRestorePlan(snapshot, { selectedTabKeys: selection });
  assert.equal(plan.totals.tabs, 5);
  assert.equal(plan.totals.skipped, 1);
  assert.equal(plan.totals.windows, 2);
  const first = plan.windows[0];
  assert.equal(first.groups.length, 2);
  assert.deepEqual(first.groups.map((group) => group.key), ['w1:g1', 'w1:g2']);
  assert.deepEqual(first.tabs.map((item) => item.tab.key), ['t1', 't2', 't3']);
  assert.deepEqual(first.tabs.map((item) => item.groupKey), ['w1:g1', 'w1:g1', 'w1:g2']);
  assert.equal(plan.skipped[0].tab.url, 'edge://settings');

  const onlyGroup = buildRestorePlan(snapshot, {
    selectedTabKeys: [...selection].filter((key) => key.startsWith('w1.')),
  });
  assert.equal(onlyGroup.totals.tabs, 3);
  assert.equal(onlyGroup.totals.windows, 1);

  const none = buildRestorePlan(snapshot, { selectedTabKeys: [] });
  assert.equal(none.totals.tabs, 0);
});

test('selectSnapshotTabs keeps only chosen tabs, drops empty groups and rekeys', () => {
  const snapshot = fixtureSnapshot();
  const selected = selectSnapshotTabs(snapshot, ['w1.t1', 'w1.t3', 'w2.t1']);

  assert.equal(selected.stats.tabs, 3);
  assert.equal(selected.stats.groups, 2);
  assert.equal(selected.windows.length, 2);
  assert.deepEqual(
    selected.windows[0].tabs.map((tab) => [tab.key, tab.url, tab.group]),
    [
      ['t1', 'https://example.com/a?utm_source=news', 'g1'],
      ['t2', 'https://example.com/docs', 'g2'],
    ],
  );
  assert.deepEqual(selected.windows[0].groups.map((group) => group.key), ['g1', 'g2']);
  assert.deepEqual(selected.windows[1].tabs.map((tab) => [tab.key, tab.url]), [['t1', 'https://example.org/']]);
  assert.equal(selected.windows[0].tabs.filter((tab) => tab.active).length, 1);
  assert.equal(selected.windows[0].tabs[0].active, true);

  const onlySecondWindow = selectSnapshotTabs(snapshot, ['w2.t1']);
  assert.equal(onlySecondWindow.windows.length, 1);
  assert.equal(onlySecondWindow.windows[0].key, 'w1');
  assert.equal(onlySecondWindow.windows[0].focused, true, 'the first selected window becomes focused');

  // The source snapshot is untouched.
  assert.equal(snapshot.stats.tabs, 6);
  assert.equal(snapshot.windows[0].tabs.length, 4);
});

test('selectSnapshotTabs can save internal pages and rejects an empty selection', () => {
  const snapshot = fixtureSnapshot();
  const internal = selectSnapshotTabs(snapshot, ['w1.t4']);
  assert.equal(internal.stats.tabs, 1);
  assert.equal(internal.stats.restorable, 0);
  assert.equal(internal.stats.unrestorable, 1);
  assert.deepEqual(internal.windows[0].tabs[0].url, 'edge://settings');
  assert.deepEqual(internal.windows[0].groups, []);
  assert.throws(() => selectSnapshotTabs(snapshot, []), /至少选择一个标签/);
});

test('mergeSnapshots rekeys windows and can dedupe across snapshots', () => {
  const a = fixtureSnapshot();
  const b = fixtureSnapshot({ id: 'snap-b', name: '周一早上', env: 'home' });
  const merged = mergeSnapshots([a, b], { name: '合并', env: 'office', dedupe: true });
  assert.equal(merged.windows.length, 4);
  assert.deepEqual(merged.windows.map((win) => win.key), ['w1', 'w2', 'w3', 'w4']);
  assert.equal(merged.name, '合并');
  assert.equal(merged.env, 'office');
  // Identical tabs across the two snapshots are removed.
  assert.equal(merged.stats.tabs, a.stats.tabs - 1);
});

test('searchSnapshot matches title, URL and group name', () => {
  const snapshot = fixtureSnapshot();
  assert.equal(searchSnapshot(snapshot, '项目 a').count, 2);
  assert.equal(searchSnapshot(snapshot, 'docs').count, 1);
  assert.equal(searchSnapshot(snapshot, 'example.org').count, 1);
  assert.equal(searchSnapshot(snapshot, 'no-such-thing').count, 0);
  assert.equal(searchSnapshot(snapshot, '周五 项目').count, 2);
});

test('renderTree shows groups, pinned and internal tabs', () => {
  const snapshot = fixtureSnapshot();
  const text = renderTree(snapshot);
  assert.match(text, /周五下班/);
  assert.match(text, /● 项目 A \[blue\]/);
  assert.match(text, /● 文档 \[green · 折叠\]/);
  assert.match(text, /\[P\*\]/);
  assert.match(text, /edge:\/\/settings/);
  assert.match(text, /不可恢复/);
  assert.match(text, /2 窗口 · 2 组 · 6 标签/);
});

test('renderURLList respects selection and restorable filtering', () => {
  const snapshot = fixtureSnapshot();
  const all = renderURLList(snapshot).split('\n');
  assert.equal(all.length, 5);
  assert.equal(all.includes('edge://settings'), false);
  const subset = renderURLList(snapshot, { selectedTabKeys: ['w1.t1', 'w1.t3'] }).split('\n');
  assert.deepEqual(subset, ['https://example.com/a?utm_source=news', 'https://example.com/docs']);
});

test('renderMarkdown escapes link text and marks internal pages', () => {
  const snapshot = fixtureSnapshot();
  snapshot.windows[0].tabs[0].title = 'A [brackets]';
  const markdown = renderMarkdown(snapshot);
  assert.match(markdown, /# 周五下班/);
  assert.match(markdown, /\[A \\\[brackets\\\]\]\(<https:\/\/example\.com\/a\?utm_source=news>\)/);
  assert.match(markdown, /edge:\/\/settings.*不可恢复/);
});

test('renderHTMLReport is standalone, escaped and filters internal links', () => {
  const snapshot = fixtureSnapshot({ name: '<script>alert(1)</script>' });
  const html = renderHTMLReport([snapshot], { title: '报告 <测试>' });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /报告 &lt;测试&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('href="edge://'), false);
  assert.equal(html.includes('href="javascript:'), false);
  assert.match(html, /https:\/\/example\.com\/a\?utm_source=news/);
  assert.match(html, /data-env="office"/);
  assert.match(html, /query\.split\(\/\\s\+\/\)/);
  assert.match(html, /复制本组/);
  assert.equal(html.includes('<link '), false);
  assert.equal(html.includes('https://fonts.'), false);
});

test('renderHTMLReport handles an empty library', () => {
  const html = renderHTMLReport([]);
  assert.match(html, /这个报告里还没有快照/);
  assert.match(html, /0 个快照/);
});

test('normalizeEnvs dedupes, fills colors and falls back', () => {
  const envs = normalizeEnvs([
    { id: 'office', label: '办公', color: '#123456' },
    { id: 'office', label: '重复' },
    { id: 'bad id', label: '自定义' },
  ]);
  assert.deepEqual(envs.map((env) => env.id), ['office', 'bad-id']);
  assert.equal(envs[0].color, '#123456');
  assert.match(envs[1].color, /^#[0-9a-f]{6}$/i);
  assert.deepEqual(normalizeEnvs([]).map((env) => env.id), ['office', 'home']);
});

test('url helpers and misc', () => {
  assert.equal(isRestorableUrl('https://a.test'), true);
  assert.equal(isRestorableUrl('file:///tmp/x.html'), true);
  assert.equal(isRestorableUrl('edge://settings'), false);
  assert.equal(isRestorableUrl('javascript:alert(1)'), false);
  assert.equal(isInternalUrl('chrome://extensions'), true);
  assert.equal(isInternalUrl('https://a.test'), false);
  assert.equal(formatStats({ windows: 1, groups: 2, tabs: 3 }), '1 窗口 · 2 组 · 3 标签');
  assert.match(createSnapshotId(new Date(2025, 0, 2, 3, 4, 5), () => 0.5), /^snap-20250102-030405-[a-z0-9]{4}$/);
  assert.equal(escapeHtml('<a href="x">'), '&lt;a href=&quot;x&quot;&gt;');
  assert.equal(computeStats({ windows: [] }).tabs, 0);
  assert.equal(tabKeyOf('w1', 't2'), 'w1.t2');
  assert.match(snapshotSearchText(fixtureSnapshot()), /项目 a/);
});
