/**
 * TBAS — Tab Baseline Archive System
 * Shared core: snapshot model, validation, dedupe, search, restore planning and renderers.
 *
 * This module is deliberately dependency-free and runs unchanged in:
 *   - the Edge extension dashboard (ES module in an extension page)
 *   - Node.js (CLI + tests)
 *
 * It contains NO chrome.* calls. Browser-specific work lives in engine.js.
 */

export const SNAPSHOT_SCHEMA = 'tbas.snapshot';
export const BUNDLE_SCHEMA = 'tbas.bundle';
export const SNAPSHOT_VERSION = 1;

export const GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

export const GROUP_COLOR_HEX = {
  grey: '#94a3b8',
  blue: '#4c6fff',
  red: '#ef4444',
  yellow: '#f59e0b',
  green: '#22c55e',
  pink: '#ec4899',
  purple: '#8b5cf6',
  cyan: '#06b6d4',
  orange: '#f97316',
};

export const DEFAULT_ENVS = [
  { id: 'office', label: '办公', color: '#4c6fff' },
  { id: 'home', label: '个人', color: '#18a957' },
];

const ENV_COLORS = ['#4c6fff', '#18a957', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316'];

const TRACKING_PARAM_RE =
  /^(utm_|ga_|mc_|pk_|mtm_|_hs|hsa_|fbclid$|gclid$|dclid$|msclkid$|yclid$|igshid$|twclid$|ttclid$|wickedid$|scid$|spm$|si$)/i;

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

export function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

/** Collapse control chars / newlines; safe for single-line UI and JSON. */
export function sanitizeText(value, max = 500) {
  return clip(String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(), max);
}

export function sanitizeEnvId(value) {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(id) ? id : 'office';
}

export function sanitizeKey(value, fallback) {
  const key = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{1,40}$/.test(key) ? key : fallback;
}

function uniqueKey(base, used, prefix) {
  let key = base;
  let n = 2;
  while (used.has(key)) {
    key = `${base}-${n}`;
    n += 1;
  }
  used.add(key);
  return key;
}

export function formatLocalDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '未知时间';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function createSnapshotId(now = new Date(), random = Math.random) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const suffix = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0').slice(-4);
  return `snap-${stamp}-${suffix}`;
}

export function hostOf(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function displayTitle(tab) {
  const title = sanitizeText(tab?.title, 500);
  if (title) return title;
  return hostOf(tab?.url) || sanitizeText(tab?.url, 200) || '（无标题）';
}

export function isInternalUrl(url) {
  try {
    const u = new URL(String(url ?? ''));
    return [
      'edge:',
      'chrome:',
      'about:',
      'view-source:',
      'devtools:',
      'edge-extension:',
      'chrome-extension:',
      'extension:',
      'data:',
      'javascript:',
      'blob:',
    ].includes(u.protocol);
  } catch {
    return false;
  }
}

export function isRestorableUrl(url) {
  try {
    const u = new URL(String(url ?? ''));
    return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * Canonical form used only for duplicate detection.
 * Keeps fragments (SPA routes), drops tracking params, sorts params.
 */
export function normalizeUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) {
      u.port = '';
    }
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM_RE.test(key)) u.searchParams.delete(key);
    }
    u.searchParams.sort();
    let out = u.toString();
    if (u.pathname === '/' && !u.search && !u.hash) out = out.replace(/\/$/, '');
    return out;
  } catch {
    return raw.toLowerCase();
  }
}

export function normalizeEnvs(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  const used = new Set();
  for (const env of list) {
    if (!isObject(env)) continue;
    const id = String(env.id ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    const safeId = /^[a-z0-9][a-z0-9_-]*$/.test(id) ? id : `env-${out.length + 1}`;
    if (used.has(safeId)) continue;
    used.add(safeId);
    out.push({
      id: safeId,
      label: sanitizeText(env.label, 24) || safeId,
      color: /^#[0-9a-f]{6}$/i.test(String(env.color ?? ''))
        ? env.color
        : ENV_COLORS[out.length % ENV_COLORS.length],
    });
  }
  if (!out.length) return DEFAULT_ENVS.map((env) => ({ ...env }));
  return out;
}

export function envOf(snapshot, envs = DEFAULT_ENVS) {
  const id = sanitizeEnvId(snapshot?.env);
  return envs.find((env) => env.id === id) || { id, label: id, color: '#64748b' };
}

/* ------------------------------------------------------------------ */
/* build                                                               */
/* ------------------------------------------------------------------ */

function activeOnce(value, seen) {
  if (!value || seen.active) return false;
  seen.active = true;
  return true;
}

/**
 * Build a canonical snapshot from live browser data.
 *
 * @param {object} input
 * @param {Array} input.windows  [{id,focused,incognito,tabs:[{id,url,title,pinned,active,index,groupId}]}]
 * @param {Array} input.groups   chrome.tabGroups results: [{id,title,color,collapsed}]
 * @param {object} input.meta    {name,env,envLabel,tags,browser,userAgent,extensionVersion,notes}
 */
export function buildSnapshot({ windows = [], groups = [], meta = {}, now = new Date() } = {}) {
  const groupById = new Map();
  for (const group of groups || []) {
    if (group && group.id !== undefined && group.id !== null) groupById.set(String(group.id), group);
  }
  for (const win of windows || []) {
    for (const group of win?.groups || []) {
      if (group && group.id !== undefined && group.id !== null && !groupById.has(String(group.id))) {
        groupById.set(String(group.id), group);
      }
    }
  }

  const prepared = [];
  for (const win of windows || []) {
    if (!isObject(win)) continue;
    const tabsIn = Array.isArray(win.tabs) ? win.tabs.slice() : [];
    tabsIn.sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0));
    if (!tabsIn.length) continue;

    const groupsOut = [];
    const groupKeyById = new Map();
    const seen = { active: false };
    const tabs = [];

    for (const tab of tabsIn) {
      const url = sanitizeText(tab?.url, 8000);
      const gid = tab?.groupId;
      const hasGroup = gid !== undefined && gid !== null && gid !== -1 && groupById.has(String(gid));
      let groupKey = null;
      if (hasGroup) {
        if (!groupKeyById.has(String(gid))) {
          const source = groupById.get(String(gid));
          const key = `g${groupKeyById.size + 1}`;
          groupKeyById.set(String(gid), key);
          groupsOut.push({
            key,
            title: sanitizeText(source?.title, 120),
            color: GROUP_COLORS.includes(source?.color) ? source.color : 'grey',
            collapsed: !!source?.collapsed,
          });
        }
        groupKey = groupKeyById.get(String(gid));
      }
      tabs.push({
        key: `t${tabs.length + 1}`,
        url,
        title: sanitizeText(tab?.title, 500),
        pinned: !!tab?.pinned,
        active: activeOnce(!!tab?.active, seen),
        group: groupKey,
        restorable: isRestorableUrl(url),
      });
    }

    prepared.push({
      focused: !!win.focused,
      incognito: !!win.incognito,
      groups: groupsOut,
      tabs,
    });
  }

  // Focused window first, then stable original order.
  prepared.sort((a, b) => Number(b.focused) - Number(a.focused));

  const windowsOut = prepared.map((win, index) => ({
    key: `w${index + 1}`,
    focused: win.focused,
    incognito: win.incognito,
    groups: win.groups,
    tabs: win.tabs,
  }));

  const env = sanitizeEnvId(meta.env);
  const nowDate = now instanceof Date ? now : new Date(now);
  const envLabel = sanitizeText(meta.envLabel, 24) || DEFAULT_ENVS.find((e) => e.id === env)?.label || env;

  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    id: sanitizeKey(meta.id, createSnapshotId(nowDate)),
    name: sanitizeText(meta.name, 120) || `${envLabel} · ${formatLocalDate(nowDate.toISOString()).slice(5)}`,
    env,
    tags: Array.isArray(meta.tags)
      ? meta.tags.map((tag) => sanitizeText(tag, 32)).filter(Boolean).slice(0, 12)
      : [],
    createdAt: nowDate.toISOString(),
    source: {
      browser: sanitizeText(meta.browser, 40) || 'unknown',
      userAgent: sanitizeText(meta.userAgent, 600),
      extensionVersion: sanitizeText(meta.extensionVersion, 24),
    },
    stats: {},
    windows: windowsOut,
  };
  if (meta.notes) snapshot.notes = sanitizeText(meta.notes, 1000);
  snapshot.stats = computeStats(snapshot);
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* stats                                                               */
/* ------------------------------------------------------------------ */

export function computeStats(snapshot) {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  let groups = 0;
  let tabs = 0;
  let pinned = 0;
  let restorable = 0;
  let duplicates = 0;
  const seen = new Set();

  for (const win of windows) {
    groups += Array.isArray(win.groups) ? win.groups.length : 0;
    for (const tab of Array.isArray(win.tabs) ? win.tabs : []) {
      tabs += 1;
      if (tab.pinned) pinned += 1;
      if (tab.restorable !== false) restorable += 1;
      const key = normalizeUrl(tab.url) || `empty:${win.key}:${tab.key}`;
      if (seen.has(key)) duplicates += 1;
      else seen.add(key);
    }
  }

  return {
    windows: windows.length,
    groups,
    tabs,
    pinned,
    restorable,
    unrestorable: tabs - restorable,
    uniqueTabs: tabs - duplicates,
    duplicates,
  };
}

export function recomputeStats(snapshot) {
  snapshot.stats = computeStats(snapshot);
  return snapshot;
}

/* ------------------------------------------------------------------ */
/* validation / import                                                 */
/* ------------------------------------------------------------------ */

/**
 * Sanitize an untrusted snapshot object (imported file, manual JSON).
 * @returns {{ok:boolean, errors:string[], snapshot?:object}}
 */
export function validateSnapshot(input, { now = new Date() } = {}) {
  const errors = [];
  if (!isObject(input)) return { ok: false, errors: ['快照不是一个 JSON 对象'] };
  if (input.schema && input.schema !== SNAPSHOT_SCHEMA) {
    errors.push(`不支持的数据类型：${sanitizeText(input.schema, 40)}`);
  }
  if (Number(input.version) > SNAPSHOT_VERSION) {
    errors.push(`快照版本 ${input.version} 高于当前支持版本 ${SNAPSHOT_VERSION}，请更新 TBAS`);
  }
  if (!Array.isArray(input.windows)) errors.push('缺少 windows 数组');
  if (errors.length) return { ok: false, errors };

  const windowsOut = [];
  const usedWindowKeys = new Set();

  for (const rawWin of input.windows) {
    if (!isObject(rawWin)) continue;

    const usedGroupKeys = new Set();
    const groups = [];
    if (Array.isArray(rawWin.groups)) {
      for (const rawGroup of rawWin.groups) {
        if (!isObject(rawGroup)) continue;
        const key = uniqueKey(sanitizeKey(rawGroup.key, `g${groups.length + 1}`), usedGroupKeys, 'g');
        groups.push({
          key,
          title: sanitizeText(rawGroup.title, 120),
          color: GROUP_COLORS.includes(rawGroup.color) ? rawGroup.color : 'grey',
          collapsed: !!rawGroup.collapsed,
        });
      }
    }
    const groupKeys = new Set(groups.map((g) => g.key));

    const tabs = [];
    const usedTabKeys = new Set();
    const seen = { active: false };
    if (Array.isArray(rawWin.tabs)) {
      for (const rawTab of rawWin.tabs) {
        if (!isObject(rawTab)) continue;
        const url = sanitizeText(rawTab.url, 8000);
        const key = uniqueKey(sanitizeKey(rawTab.key, `t${tabs.length + 1}`), usedTabKeys, 't');
        tabs.push({
          key,
          url,
          title: sanitizeText(rawTab.title, 500),
          pinned: !!rawTab.pinned,
          active: activeOnce(!!rawTab.active, seen),
          group: groupKeys.has(rawTab.group) ? rawTab.group : null,
          restorable: isRestorableUrl(url),
        });
      }
    }
    if (!tabs.length) continue;

    // Drop groups that no tab references any more.
    const usedGroups = new Set(tabs.map((tab) => tab.group).filter(Boolean));
    const finalGroups = groups.filter((group) => usedGroups.has(group.key));

    windowsOut.push({
      key: uniqueKey(sanitizeKey(rawWin.key, `w${windowsOut.length + 1}`), usedWindowKeys, 'w'),
      focused: !!rawWin.focused,
      incognito: !!rawWin.incognito,
      groups: finalGroups,
      tabs,
    });
  }

  if (!windowsOut.length) return { ok: false, errors: ['快照里没有任何标签页'] };

  let focusedSeen = false;
  for (const win of windowsOut) {
    if (win.focused && !focusedSeen) focusedSeen = true;
    else win.focused = false;
  }

  const createdAt = new Date(input.createdAt);
  const env = sanitizeEnvId(input.env);
  const envLabel = DEFAULT_ENVS.find((e) => e.id === env)?.label || env;
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    id: sanitizeKey(input.id, createSnapshotId(now)),
    name:
      sanitizeText(input.name, 120) ||
      `${envLabel} · ${formatLocalDate(Number.isNaN(createdAt.getTime()) ? now.toISOString() : createdAt.toISOString()).slice(5)}`,
    env,
    tags: Array.isArray(input.tags)
      ? input.tags.map((tag) => sanitizeText(tag, 32)).filter(Boolean).slice(0, 12)
      : [],
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date(now).toISOString() : createdAt.toISOString(),
    source: {
      browser: sanitizeText(input.source?.browser, 40) || 'imported',
      userAgent: sanitizeText(input.source?.userAgent, 600),
      extensionVersion: sanitizeText(input.source?.extensionVersion, 24),
    },
    stats: {},
    windows: windowsOut,
  };
  if (input.notes) snapshot.notes = sanitizeText(input.notes, 1000);
  snapshot.stats = computeStats(snapshot);
  return { ok: true, errors: [], snapshot };
}

export function buildBundle(snapshots, { exportedAt = new Date().toISOString(), generator = 'tbas' } = {}) {
  return {
    schema: BUNDLE_SCHEMA,
    version: SNAPSHOT_VERSION,
    exportedAt,
    generator,
    snapshots: snapshots.map((snapshot) => ({ ...snapshot })),
  };
}

/**
 * Parse a single snapshot / bundle / array from text.
 * @returns {{ok:boolean, snapshots:object[], errors:string[], kind:string}}
 */
export function parseSnapshotText(text, { filename = '', now = new Date() } = {}) {
  let data;
  try {
    data = JSON.parse(String(text ?? ''));
  } catch (error) {
    return {
      ok: false,
      snapshots: [],
      errors: [`${filename || '文件'} 不是有效的 JSON：${error.message}`],
      kind: 'invalid',
    };
  }

  const snapshots = [];
  const errors = [];
  let candidates = [];
  let kind = 'snapshot';

  if (isObject(data) && data.schema === BUNDLE_SCHEMA) {
    kind = 'bundle';
    if (!Array.isArray(data.snapshots)) {
      errors.push(`${filename || '文件'} 是 bundle，但缺少 snapshots 数组`);
    } else {
      candidates = data.snapshots;
    }
  } else if (Array.isArray(data)) {
    kind = 'array';
    candidates = data;
  } else {
    candidates = [data];
  }

  candidates.forEach((candidate, index) => {
    const result = validateSnapshot(candidate, { now });
    if (result.ok) snapshots.push(result.snapshot);
    else {
      const label = candidates.length > 1 ? `第 ${index + 1} 个快照：` : '';
      errors.push(`${filename || '文件'}${label}${result.errors.join('；')}`);
    }
  });

  return { ok: snapshots.length > 0, snapshots, errors, kind };
}


/* ------------------------------------------------------------------ */
/* selection (capture-time filtering)                                  */
/* ------------------------------------------------------------------ */

/**
 * Keep only the selected tabs in a snapshot, dropping newly empty groups and
 * windows and re-keying the result as w1/g1/t1. Used by the capture picker so
 * a manual selection can be saved as a first-class snapshot.
 *
 * @param {object} snapshot
 * @param {Set<string>|string[]} selectedTabKeys keys in the form "w1.t2"
 */
export function selectSnapshotTabs(snapshot, selectedTabKeys) {
  const selected = selectedTabKeys instanceof Set ? selectedTabKeys : new Set(selectedTabKeys || []);
  if (!selected.size) throw new Error('至少选择一个标签');
  const copy = structuredClone(snapshot);
  const windows = [];

  for (const win of copy.windows || []) {
    const tabs = (win.tabs || []).filter((tab) => selected.has(tabKeyOf(win.key, tab.key)));
    if (!tabs.length) continue;

    const usedGroups = new Set(tabs.map((tab) => tab.group).filter(Boolean));
    let activeSeen = false;
    const rekeyed = tabs.map((tab, index) => {
      const next = { ...tab, key: `t${index + 1}` };
      if (next.active && !activeSeen) activeSeen = true;
      else next.active = false;
      return next;
    });

    windows.push({
      ...win,
      key: `w${windows.length + 1}`,
      groups: (win.groups || []).filter((group) => usedGroups.has(group.key)),
      tabs: rekeyed,
    });
  }

  if (!windows.length) throw new Error('至少选择一个标签');
  if (!windows.some((win) => win.focused)) windows[0].focused = true;
  copy.windows = windows;
  copy.stats = computeStats(copy);
  return copy;
}

/* ------------------------------------------------------------------ */
/* dedupe / merge                                                      */
/* ------------------------------------------------------------------ */

/**
 * Remove duplicate tabs by normalized URL.
 * Duplicates are transferred to the kept tab (pinned/active), so cleaning
 * never loses state. Scope 'snapshot' dedupes across windows, 'window' does not.
 */
export function dedupeSnapshot(snapshot, { scope = 'window' } = {}) {
  const copy = structuredClone(snapshot);
  const removed = [];
  const globalSeen = new Map();

  for (const win of copy.windows) {
    const seen = scope === 'snapshot' ? globalSeen : new Map();
    const keptTabs = [];
    for (const tab of win.tabs) {
      const key = normalizeUrl(tab.url);
      if (!key) {
        keptTabs.push(tab);
        continue;
      }
      const kept = seen.get(key);
      if (!kept) {
        seen.set(key, tab);
        keptTabs.push(tab);
        continue;
      }
      if (tab.pinned) kept.pinned = true;
      if (tab.active) {
        const owner = copy.windows.find((candidate) => candidate.tabs.includes(kept));
        if (owner) for (const other of owner.tabs) other.active = false;
        kept.active = true;
        tab.active = false;
      }
      removed.push({
        windowKey: win.key,
        tabKey: tab.key,
        title: displayTitle(tab),
        url: tab.url,
        duplicateOf: kept.key,
      });
    }
    win.tabs = keptTabs;
    const usedGroups = new Set(keptTabs.map((tab) => tab.group).filter(Boolean));
    win.groups = win.groups.filter((group) => usedGroups.has(group.key));
    // Re-key tabs so keys stay t1..tn. Group keys are window-stable and
    // remain referenced by tab.group, so they do not need re-keying.
    win.tabs = win.tabs.map((tab, index) => ({ ...tab, key: `t${index + 1}` }));
  }

  copy.stats = computeStats(copy);
  return { snapshot: copy, removed };
}

export function mergeSnapshots(snapshots, { name = '', env = '', dedupe = true, now = new Date() } = {}) {
  const list = (Array.isArray(snapshots) ? snapshots : []).filter(isObject);
  if (!list.length) throw new Error('没有可合并的快照');
  const merged = {
    schema: SNAPSHOT_SCHEMA,
    version: SNAPSHOT_VERSION,
    id: createSnapshotId(now),
    name: sanitizeText(name, 120) || `合并快照 · ${formatLocalDate(now.toISOString()).slice(5)}`,
    env: sanitizeEnvId(env || list[0].env),
    tags: [...new Set(list.flatMap((snapshot) => snapshot.tags || []))].slice(0, 12),
    createdAt: new Date(now).toISOString(),
    source: { browser: 'merged', userAgent: '', extensionVersion: '' },
    stats: {},
    windows: [],
  };

  let windowIndex = 0;
  for (const snapshot of list) {
    for (const win of snapshot.windows || []) {
      const groupMap = new Map();
      const groups = (win.groups || []).map((group, index) => {
        const key = `g${index + 1}`;
        groupMap.set(group.key, key);
        return { ...group, key };
      });
      const tabs = (win.tabs || []).map((tab, index) => ({
        ...tab,
        key: `t${index + 1}`,
        group: tab.group ? groupMap.get(tab.group) || null : null,
      }));
      merged.windows.push({
        key: `w${++windowIndex}`,
        focused: false,
        incognito: false,
        groups,
        tabs,
      });
    }
  }
  if (merged.windows.length) merged.windows[0].focused = true;
  recomputeStats(merged);
  if (dedupe) {
    const result = dedupeSnapshot(merged, { scope: 'snapshot' });
    result.snapshot.name = merged.name;
    return result.snapshot;
  }
  return merged;
}

/* ------------------------------------------------------------------ */
/* search / selection                                                  */
/* ------------------------------------------------------------------ */

export function tabKeyOf(windowKey, tabKey) {
  return `${windowKey}.${tabKey}`;
}

export function allRestorableTabKeys(snapshot) {
  const keys = new Set();
  for (const win of snapshot?.windows || []) {
    for (const tab of win.tabs || []) {
      if (tab.restorable) keys.add(tabKeyOf(win.key, tab.key));
    }
  }
  return keys;
}

export function snapshotSearchText(snapshot) {
  const parts = [snapshot?.name, snapshot?.env, ...(snapshot?.tags || [])];
  for (const win of snapshot?.windows || []) {
    for (const group of win.groups || []) parts.push(group.title);
    for (const tab of win.tabs || []) parts.push(tab.title, tab.url);
  }
  return parts.join(' ').toLowerCase();
}

export function searchSnapshot(snapshot, query) {
  const tokens = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const matches = [];
  if (!tokens.length) return { matches, count: 0 };
  for (const win of snapshot.windows || []) {
    const groups = new Map((win.groups || []).map((group) => [group.key, group]));
    for (const tab of win.tabs || []) {
      const group = tab.group ? groups.get(tab.group) : null;
      const haystack = [
        tab.title,
        tab.url,
        snapshot.name,
        snapshot.env,
        ...(snapshot.tags || []),
        group?.title || '',
      ]
        .join(' ')
        .toLowerCase();
      if (tokens.every((token) => haystack.includes(token))) {
        matches.push({ window: win, tab, group });
      }
    }
  }
  return { matches, count: matches.length };
}

/* ------------------------------------------------------------------ */
/* restore planning                                                    */
/* ------------------------------------------------------------------ */

/**
 * Turn a snapshot + a user selection into an ordered, browser-agnostic plan.
 * @param {object} snapshot
 * @param {object} options {mode:'new'|'current', selectedTabKeys:Set|string[]|null, windowKeys, includeUnrestorable}
 */
export function buildRestorePlan(snapshot, options = {}) {
  const { mode = 'new', selectedTabKeys = null, windowKeys = null, includeUnrestorable = false } = options;
  const selected = selectedTabKeys
    ? new Set(selectedTabKeys)
    : new Set(
        (snapshot.windows || []).flatMap((win) =>
          (win.tabs || []).filter((tab) => includeUnrestorable || tab.restorable).map((tab) => tabKeyOf(win.key, tab.key)),
        ),
      );
  const allowedWindows = windowKeys ? new Set(windowKeys) : null;
  const windows = [];
  const omitted = [];
  const skipped = [];

  for (const win of snapshot.windows || []) {
    if (allowedWindows && !allowedWindows.has(win.key)) continue;
    const groupMap = new Map((win.groups || []).map((group) => [group.key, group]));
    const usedGroups = new Set();
    const tabs = [];

    for (const tab of win.tabs || []) {
      if (!includeUnrestorable && !tab.restorable) {
        skipped.push({ windowKey: win.key, tab, reason: 'internal' });
        continue;
      }
      if (!selected.has(tabKeyOf(win.key, tab.key))) {
        omitted.push({ windowKey: win.key, tab });
        continue;
      }
      tabs.push({ tab, groupKey: tab.group ? `${win.key}:${tab.group}` : null });
      if (tab.group) usedGroups.add(tab.group);
    }

    if (!tabs.length) continue;
    windows.push({
      sourceKey: win.key,
      focused: !!win.focused,
      groups: (win.groups || [])
        .filter((group) => usedGroups.has(group.key))
        .map((group) => ({ ...groupMap.get(group.key), key: `${win.key}:${group.key}` })),
      tabs,
      skipped: skipped.filter((item) => item.windowKey === win.key).map((item) => item.tab),
    });
  }

  const totalTabs = windows.reduce((sum, win) => sum + win.tabs.length, 0);
  const totalGroups = windows.reduce((sum, win) => sum + win.groups.length, 0);

  return {
    mode,
    windows,
    totals: {
      tabs: totalTabs,
      groups: totalGroups,
      skipped: skipped.length,
      omitted: omitted.length,
      windows: windows.length,
    },
    skipped,
  };
}

/* ------------------------------------------------------------------ */
/* text renderers (CLI)                                                */
/* ------------------------------------------------------------------ */

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  grey: '\x1b[90m',
  white: '\x1b[37m',
};

function ansiForColor(color) {
  return (
    {
      blue: ANSI.blue,
      red: ANSI.red,
      yellow: ANSI.yellow,
      green: ANSI.green,
      pink: ANSI.magenta,
      purple: ANSI.magenta,
      cyan: ANSI.cyan,
      orange: ANSI.yellow,
      grey: ANSI.grey,
    }[color] || ANSI.grey
  );
}

function fit(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function formatStats(stats) {
  const s = stats || {};
  return `${s.windows || 0} 窗口 · ${s.groups || 0} 组 · ${s.tabs || 0} 标签`;
}

export function renderTree(snapshot, { ansi = false, showUrls = true } = {}) {
  const paint = (code, text) => (ansi ? `${code}${text}${ANSI.reset}` : text);
  const lines = [];
  const env = DEFAULT_ENVS.find((e) => e.id === snapshot.env)?.label || snapshot.env;
  lines.push(paint(ANSI.bold, snapshot.name));
  lines.push(
    paint(
      ANSI.dim,
      `${snapshot.id}  ·  ${env}  ·  ${formatLocalDate(snapshot.createdAt)}  ·  ${formatStats(snapshot.stats)}`,
    ),
  );

  for (const win of snapshot.windows || []) {
    const groups = new Map((win.groups || []).map((group) => [group.key, group]));
    const winStats = `${(win.tabs || []).length} 标签 / ${(win.groups || []).length} 组`;
    lines.push('');
    lines.push(paint(ANSI.bold, `窗口 ${win.key.replace(/^w/, '')}`) + paint(ANSI.dim, `  ${win.focused ? '· 主窗口' : ''}  · ${winStats}`));
    let currentGroup = Symbol('none');
    for (const tab of win.tabs || []) {
      const groupKey = tab.group || null;
      if (groupKey !== currentGroup) {
        currentGroup = groupKey;
        if (groupKey) {
          const group = groups.get(groupKey);
          if (group) {
            const dot = paint(ansiForColor(group.color), '●');
            const title = group.title || '未命名分组';
            lines.push(`  ${dot} ${paint(ANSI.bold, title)} ${paint(ANSI.dim, `[${group.color}${group.collapsed ? ' · 折叠' : ''}]`)}`);
          }
        } else {
          lines.push(paint(ANSI.dim, '  ○ 未分组'));
        }
      }
      const marks = `${tab.pinned ? 'P' : ' '}${tab.active ? '*' : ' '}`;
      const title = fit(displayTitle(tab), 90);
      const suffix = showUrls && tab.url ? paint(ANSI.dim, `  ${fit(tab.url, 140)}`) : '';
      const missing = tab.restorable ? '' : paint(ANSI.yellow, '  [不可恢复]');
      lines.push(`    ${paint(ANSI.grey, `[${marks}]`)} ${title}${suffix}${missing}`);
    }
  }
  lines.push('');
  const missingCount = (snapshot.stats?.unrestorable || 0);
  if (missingCount) lines.push(paint(ANSI.yellow, `注意：${missingCount} 个标签是浏览器内部页，扩展无法重新打开。`));
  return lines.join('\n');
}

export function renderURLList(snapshot, { selectedTabKeys = null, includeUnrestorable = false } = {}) {
  const selected = selectedTabKeys ? new Set(selectedTabKeys) : null;
  const urls = [];
  for (const win of snapshot.windows || []) {
    for (const tab of win.tabs || []) {
      if (selected && !selected.has(tabKeyOf(win.key, tab.key))) continue;
      if (!includeUnrestorable && !tab.restorable) continue;
      if (tab.url) urls.push(tab.url);
    }
  }
  return urls.join('\n');
}

export function renderMarkdown(snapshot) {
  const esc = (text) => String(text ?? '').replace(/([\\[\]])/g, '\\$1');
  const lines = [];
  lines.push(`# ${snapshot.name}`);
  lines.push('');
  lines.push(`- 快照 ID：\`${snapshot.id}\``);
  lines.push(`- 环境：${DEFAULT_ENVS.find((e) => e.id === snapshot.env)?.label || snapshot.env}`);
  lines.push(`- 创建时间：${formatLocalDate(snapshot.createdAt)}`);
  lines.push(`- 规模：${formatStats(snapshot.stats)}${snapshot.stats?.unrestorable ? `（${snapshot.stats.unrestorable} 个内部页不可恢复）` : ''}`);
  lines.push('');

  for (const win of snapshot.windows || []) {
    const groups = new Map((win.groups || []).map((group) => [group.key, group]));
    lines.push(`## 窗口 ${win.key.replace(/^w/, '')}${win.focused ? '（主窗口）' : ''}`);
    lines.push('');
    let currentGroup = Symbol('none');
    for (const tab of win.tabs || []) {
      const groupKey = tab.group || null;
      if (groupKey !== currentGroup) {
        currentGroup = groupKey;
        if (groupKey) {
          const group = groups.get(groupKey);
          lines.push(`### ${group?.title || '未命名分组'} (${group?.color || 'grey'})`);
        } else {
          lines.push('### 未分组');
        }
        lines.push('');
      }
      const title = esc(displayTitle(tab));
      const pin = tab.pinned ? '📌 ' : '';
      if (tab.restorable && /^(https?|file):/i.test(tab.url)) {
        lines.push(`- ${pin}[${title}](<${tab.url}>)`);
      } else {
        lines.push(`- ${pin}${title} — \`${tab.url}\`（不可恢复）`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* standalone HTML report                                              */
/* ------------------------------------------------------------------ */

const REPORT_CSS = `
:root{--bg:#f4f6fb;--surface:#fff;--ink:#0f172a;--muted:#64748b;--line:#e5e9f2;--brand:#4c6fff;--brand2:#7c5cff;--danger:#d97706;--radius:16px;--shadow:0 10px 30px rgba(15,23,42,.06)}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:#2454d6;text-decoration:none;overflow-wrap:anywhere}
a:hover{text-decoration:underline}
.hero{background:linear-gradient(135deg,#0b1533,#17224d 45%,#1c2a61);color:#eef2ff;padding:28px 0 24px}
.wrap{max-width:1120px;margin:0 auto;padding:0 22px}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.08em;font-size:13px;text-transform:uppercase;color:#a9b8ff}
.brand .logo{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:8px;background:linear-gradient(135deg,#6d8bff,#8b5cf6);color:#fff;font-size:13px}
.hero h1{margin:14px 0 6px;font-size:28px;letter-spacing:-.02em}
.hero .sub{margin:0;color:#b9c4ee;font-size:14px}
.controls{display:flex;flex-wrap:wrap;gap:10px;margin-top:20px}
.controls input[type=search]{flex:1 1 280px;min-width:220px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#fff;border-radius:10px;padding:10px 13px;font:inherit;outline:none}
.controls input[type=search]::placeholder{color:#9da9d6}
.controls input[type=search]:focus{border-color:#8fa5ff;background:rgba(255,255,255,.12)}
.envs{display:flex;gap:6px;flex-wrap:wrap}
.envs button,.tools button{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.07);color:#dbe3ff;border-radius:999px;padding:8px 13px;font:inherit;font-size:13px;cursor:pointer}
.envs button.active{background:#fff;color:#17224d;border-color:#fff;font-weight:600}
.envs button:hover,.tools button:hover{background:rgba(255,255,255,.16)}
.envs button.active:hover{background:#fff}
main{padding:24px 0 40px}
.snap{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);margin:0 0 16px;overflow:hidden}
.snap-head{display:flex;align-items:center;gap:12px;width:100%;padding:16px 18px;background:none;border:0;font:inherit;text-align:left;cursor:pointer;color:var(--ink)}
.snap-head:hover{background:#f8faff}
.snap-head .edot{width:10px;height:10px;border-radius:50%;flex:0 0 auto;background:var(--c,#64748b)}
.snap-name{font-weight:650;font-size:16px;letter-spacing:-.01em;overflow-wrap:anywhere}
.pill{font-size:12px;padding:3px 9px;border-radius:999px;background:#eef2ff;color:#3a54c8;white-space:nowrap}
.snap-head .meta{margin-left:auto;color:var(--muted);font-size:12.5px;white-space:nowrap}
.chev{color:#94a3b8;transition:transform .18s;font-size:13px}
.snap[open] .chev{transform:rotate(180deg)}
.snap-body{padding:0 18px 18px;border-top:1px solid var(--line)}
.snap-tools{display:flex;justify-content:flex-end;padding:10px 0 2px}
.snap-tools button{border:1px solid var(--line);background:#f8faff;color:#3a54c8;border-radius:8px;padding:6px 10px;font:inherit;font-size:12.5px;cursor:pointer}
.snap-tools button:hover{background:#eef2ff}
.window{margin-top:14px}
.window h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 10px;display:flex;gap:8px;align-items:center}
.window h3 .tag{background:#eef2ff;color:#3a54c8;border-radius:6px;padding:2px 6px;font-size:11px;letter-spacing:0}
.group{border:1px solid var(--line);border-radius:12px;margin:0 0 10px;overflow:hidden;background:#fcfdff}
.group-head{display:flex;align-items:center;gap:9px;padding:9px 12px;background:#f8faff;border-bottom:1px solid var(--line)}
.group-head .gdot{width:9px;height:9px;border-radius:50%;background:var(--c,#94a3b8);flex:0 0 auto}
.group-head h4{margin:0;font-size:13.5px;font-weight:600;overflow-wrap:anywhere}
.group-head .gcount{font-size:11.5px;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:999px;padding:1px 7px}
.group-head button{margin-left:auto;border:0;background:none;color:#4c6fff;font:inherit;font-size:12px;cursor:pointer;padding:3px 4px;border-radius:6px}
.group-head button:hover{background:#eef2ff}
.tabs{list-style:none;margin:0;padding:5px 0}
.tab{display:flex;align-items:baseline;gap:9px;padding:6px 12px;border-radius:8px}
.tab:hover{background:#f6f8ff}
.tab .pin{flex:0 0 15px;color:#f59e0b;font-size:11px}
.tab .title{font-size:13.5px;overflow-wrap:anywhere}
.tab .host{font-size:11.5px;color:var(--muted);margin-left:auto;white-space:nowrap;padding-left:12px}
.tab.missing .title{color:#92400e;background:#fffbeb;border-radius:5px;padding:0 4px}
.tab.missing .host{color:#b45309}
[hidden]{display:none!important}
.empty{background:var(--surface);border:1px dashed var(--line);border-radius:var(--radius);padding:46px 20px;text-align:center;color:var(--muted)}
footer{border-top:1px solid var(--line);padding:18px 0 34px;color:#94a3b8;font-size:12px}
@media (max-width:700px){.hero h1{font-size:23px}.snap-head .meta{display:none}.snap-head{flex-wrap:wrap}.tab .host{display:none}.wrap{padding:0 14px}}
@media print{.hero{background:#fff;color:#000}.controls,.snap-tools,.group-head button,.chev{display:none}.snap{box-shadow:none;break-inside:avoid}body{background:#fff}}
`;

function groupColorStyle(color) {
  return `--c:${GROUP_COLOR_HEX[color] || GROUP_COLOR_HEX.grey}`;
}

function reportTabRow(snapshot, tab, envColor) {
  const title = escapeHtml(displayTitle(tab));
  const search = escapeHtml([tab.title, tab.url, snapshot.name, snapshot.env].join(' ').toLowerCase());
  if (tab.restorable && /^(https?|file):/i.test(tab.url)) {
    return `<li class="tab" data-search="${search}"><span class="pin">${tab.pinned ? '📌' : ''}</span><a class="title" href="${escapeHtml(tab.url)}" target="_blank" rel="noopener noreferrer">${title}</a><span class="host" style="--c:${envColor}">${escapeHtml(hostOf(tab.url))}</span></li>`;
  }
  return `<li class="tab missing" data-search="${search}"><span class="pin"></span><span class="title">${title}</span><span class="host">${escapeHtml(tab.url || '内部页')} · 不可恢复</span></li>`;
}

/**
 * Render all snapshots into a single standalone, offline HTML file.
 * No external assets, no network calls.
 */
export function renderHTMLReport(snapshots, { title = 'TBAS 标签页快照报告', generatedAt = new Date() } = {}) {
  const list = Array.isArray(snapshots) ? snapshots : [];
  const envs = new Map();
  let totalTabs = 0;
  let totalGroups = 0;
  for (const snapshot of list) {
    totalTabs += snapshot.stats?.tabs || 0;
    totalGroups += snapshot.stats?.groups || 0;
    for (const env of DEFAULT_ENVS) {
      if (env.id === snapshot.env) envs.set(env.id, env.label);
    }
    if (!envs.has(snapshot.env)) envs.set(snapshot.env, snapshot.env);
  }

  const envButtons = [...envs.entries()]
    .map(([id, label]) => `<button type="button" data-env="${escapeHtml(id)}">${escapeHtml(label)}</button>`)
    .join('');

  const sections = list.map((snapshot) => {
    const env = DEFAULT_ENVS.find((item) => item.id === snapshot.env) || { id: snapshot.env, label: snapshot.env, color: '#64748b' };
    const metaText = `${formatStats(snapshot.stats)}${snapshot.stats?.duplicates ? ` · ${snapshot.stats.duplicates} 重复` : ''} · ${formatLocalDate(snapshot.createdAt)}`;
    const metaSearch = escapeHtml([snapshot.name, env.label, ...(snapshot.tags || [])].join(' ').toLowerCase());
    const windowHtml = (snapshot.windows || [])
      .map((win, winIndex) => {
        const groups = new Map((win.groups || []).map((group) => [group.key, group]));
        const blocks = [];
        let current = Symbol('none');
        let rows = [];
        const flush = () => {
          if (!rows.length) return;
          if (current && groups.has(current)) {
            const group = groups.get(current);
            const label = group.title || '未命名分组';
            blocks.push(
              `<div class="group" data-group-search="${escapeHtml(label.toLowerCase())}"><div class="group-head"><span class="gdot" style="${groupColorStyle(group.color)}"></span><h4>${escapeHtml(label)}</h4><span class="gcount">${rows.length}</span><button type="button" data-copy>复制本组</button></div><ol class="tabs">${rows.join('')}</ol></div>`,
            );
          } else {
            blocks.push(
              `<div class="group" data-group-search="未分组"><div class="group-head"><span class="gdot"></span><h4>未分组</h4><span class="gcount">${rows.length}</span><button type="button" data-copy>复制本组</button></div><ol class="tabs">${rows.join('')}</ol></div>`,
            );
          }
          rows = [];
        };
        for (const tab of win.tabs || []) {
          const groupKey = tab.group || null;
          if (groupKey !== current) {
            flush();
            current = groupKey;
          }
          rows.push(reportTabRow(snapshot, tab, env.color));
        }
        flush();
        return `<div class="window"><h3>窗口 ${winIndex + 1}${win.focused ? '<span class="tag">主窗口</span>' : ''} · ${(win.tabs || []).length} 标签</h3>${blocks.join('')}</div>`;
      })
      .join('');
    return `<details class="snap" data-snapshot data-env="${escapeHtml(snapshot.env)}" data-meta="${metaSearch}" open>
<summary class="snap-head"><span class="edot" style="--c:${env.color}"></span><span class="snap-name">${escapeHtml(snapshot.name)}</span><span class="pill">${escapeHtml(env.label)}</span><span class="meta">${escapeHtml(metaText)}</span><span class="chev">▾</span></summary>
<div class="snap-body"><div class="snap-tools"><button type="button" data-copy>复制全部链接</button></div>${windowHtml}</div>
</details>`;
  });

  const body = sections.length
    ? sections.join('\n')
    : '<div class="empty">这个报告里还没有快照。</div>';

  const generated = formatLocalDate(new Date(generatedAt).toISOString());

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="TBAS">
<title>${escapeHtml(title)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<header class="hero">
  <div class="wrap">
    <div class="brand"><span class="logo">▤</span> TBAS · Tab Baseline Archive System</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="sub">${list.length} 个快照 · ${totalTabs} 个标签 · ${totalGroups} 个分组 · 生成于 ${escapeHtml(generated)}</p>
    <div class="controls">
      <input id="q" type="search" placeholder="搜索快照、分组、标题或网址…" autocomplete="off">
      <div class="envs" id="envs"><button type="button" data-env="" class="active">全部</button>${envButtons}</div>
      <div class="tools"><button type="button" id="expand">展开全部</button><button type="button" id="collapse">收起全部</button></div>
    </div>
  </div>
</header>
<main class="wrap" id="list">
${body}
</main>
<footer class="wrap">TBAS · 报告由本地快照生成，不包含任何外部脚本 · ${escapeHtml(generated)}</footer>
<script>
(function () {
  var q = document.getElementById('q');
  var envs = document.getElementById('envs');
  var list = document.getElementById('list');
  var activeEnv = '';

  function normalize(value) { return (value || '').toLowerCase(); }

  function matches(value, query) {
    if (!query) return true;
    var haystack = normalize(value);
    return query.split(/\\s+/).filter(Boolean).every(function (token) {
      return haystack.indexOf(token) !== -1;
    });
  }

  function apply() {
    var query = normalize(q.value).trim();
    var snapshots = list.querySelectorAll('[data-snapshot]');
    snapshots.forEach(function (snap) {
      var metaMatch = matches(snap.dataset.meta, query);
      var envMatch = !activeEnv || snap.dataset.env === activeEnv;
      var anyTab = false;
      snap.querySelectorAll('.group').forEach(function (group) {
        var groupMatch = matches(group.dataset.groupSearch, query);
        var groupHasTab = false;
        group.querySelectorAll('.tab').forEach(function (row) {
          var tabMatch = matches(row.dataset.search, query);
          var visibleTab = !query || metaMatch || groupMatch || tabMatch;
          row.hidden = !visibleTab;
          if (visibleTab) {
            anyTab = true;
            groupHasTab = true;
          }
        });
        group.hidden = !groupHasTab;
      });
      snap.querySelectorAll('.window').forEach(function (win) {
        win.hidden = win.querySelectorAll('.group:not([hidden])').length === 0;
      });
      var visible = envMatch && (metaMatch || anyTab);
      snap.hidden = !visible;
      if (query && visible) snap.open = true;
    });
  }

  q.addEventListener('input', apply);
  envs.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-env]');
    if (!btn) return;
    activeEnv = btn.dataset.env;
    envs.querySelectorAll('button').forEach(function (b) { b.classList.toggle('active', b === btn); });
    apply();
  });

  document.getElementById('expand').addEventListener('click', function () {
    list.querySelectorAll('[data-snapshot]').forEach(function (snap) { snap.open = true; });
  });
  document.getElementById('collapse').addEventListener('click', function () {
    list.querySelectorAll('[data-snapshot]').forEach(function (snap) { snap.open = false; });
  });

  function copyText(text, button) {
    function done(ok) {
      if (!button) return;
      var old = button.textContent;
      button.textContent = ok ? '已复制' : '复制失败';
      setTimeout(function () { button.textContent = old; }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
      return;
    }
    fallback();
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        done(ok);
      } catch (error) { done(false); }
    }
  }

  document.addEventListener('click', function (event) {
    var btn = event.target.closest('[data-copy]');
    if (!btn) return;
    var scope = btn.closest('.group') || btn.closest('.window') || btn.closest('[data-snapshot]');
    if (!scope) return;
    var urls = [];
    scope.querySelectorAll('a[href]').forEach(function (link) { urls.push(link.href); });
    copyText(urls.join('\\n'), btn);
  });
})();
</script>
</body>
</html>`;
}
