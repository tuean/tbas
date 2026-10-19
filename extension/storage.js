/**
 * TBAS persistence layer (extension only).
 *
 * Storage layout in chrome.storage.local:
 *   tbas.index.v1     -> lightweight metadata for every snapshot
 *   tbas.snapshot.<id> -> full snapshot
 *   tbas.settings.v1  -> user settings
 *
 * Keeping metadata separate means listing the library never loads every tab.
 */

import { DEFAULT_ENVS, computeStats, createSnapshotId, normalizeEnvs, sanitizeText, validateSnapshot } from './lib/core.js';

export const INDEX_KEY = 'tbas.index.v1';
export const SETTINGS_KEY = 'tbas.settings.v1';
export const SNAPSHOT_PREFIX = 'tbas.snapshot.';
export const STORAGE_PREFIX = 'tbas.';

export const DEFAULT_SETTINGS = {
  env: 'office',
  envs: DEFAULT_ENVS.map((env) => ({ ...env })),
  autoBackup: false,
  dedupeOnCapture: false,
  scope: 'all',
  restoreTarget: 'new',
};

// Serialize index updates so two dashboard tabs cannot clobber each other.
let writeQueue = Promise.resolve();
function serial(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

export function indexEntry(snapshot) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    env: snapshot.env,
    tags: snapshot.tags || [],
    createdAt: snapshot.createdAt,
    stats: snapshot.stats || computeStats(snapshot),
    source: { browser: snapshot.source?.browser || 'unknown' },
    notes: snapshot.notes || '',
  };
}

function sortIndex(index) {
  return index.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getIndex() {
  const stored = await chrome.storage.local.get(INDEX_KEY);
  let index = stored?.[INDEX_KEY];

  // Crash recovery: snapshots are written before the index. If the index is
  // missing or empty while snapshot keys exist, rebuild it instead of hiding
  // perfectly good snapshots from the library.
  if (!Array.isArray(index) || index.length === 0) {
    const everything = await chrome.storage.local.get(null);
    const recovered = Object.entries(everything)
      .filter(([key, snapshot]) => key.startsWith(SNAPSHOT_PREFIX) && snapshot && typeof snapshot === 'object')
      .map(([, snapshot]) => indexEntry(snapshot));
    if (recovered.length) {
      index = sortIndex(recovered);
      await chrome.storage.local.set({ [INDEX_KEY]: index });
    } else if (!Array.isArray(index)) {
      index = [];
    }
  }

  return sortIndex(index);
}

export async function getSnapshot(id) {
  const key = `${SNAPSHOT_PREFIX}${id}`;
  const stored = await chrome.storage.local.get(key);
  const snapshot = stored?.[key];
  if (!snapshot) return null;
  // Validate on read so corrupted storage can never break the UI.
  const result = validateSnapshot(snapshot);
  return result.ok ? result.snapshot : null;
}

export async function saveSnapshot(snapshot) {
  return serial(async () => {
    const index = await getIndex();
    await chrome.storage.local.set({ [`${SNAPSHOT_PREFIX}${snapshot.id}`]: snapshot });
    const next = index.filter((entry) => entry.id !== snapshot.id);
    next.push(indexEntry(snapshot));
    await chrome.storage.local.set({ [INDEX_KEY]: sortIndex(next) });
    return snapshot;
  });
}

export async function saveSnapshots(snapshots) {
  const list = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
  if (!list.length) return [];
  return serial(async () => {
    const index = await getIndex();
    const values = {};
    for (const snapshot of list) values[`${SNAPSHOT_PREFIX}${snapshot.id}`] = snapshot;
    await chrome.storage.local.set(values);
    const incoming = new Map(list.map((snapshot) => [snapshot.id, snapshot]));
    const next = index.filter((entry) => !incoming.has(entry.id));
    for (const snapshot of list) next.push(indexEntry(snapshot));
    await chrome.storage.local.set({ [INDEX_KEY]: sortIndex(next) });
    return list;
  });
}

export async function deleteSnapshot(id) {
  return serial(async () => {
    await chrome.storage.local.remove(`${SNAPSHOT_PREFIX}${id}`);
    const index = await getIndex();
    await chrome.storage.local.set({ [INDEX_KEY]: index.filter((entry) => entry.id !== id) });
  });
}

export async function clearAll() {
  return serial(async () => {
    // Remove every snapshot key, including orphans not present in the index.
    const everything = await chrome.storage.local.get(null);
    const keys = Object.keys(everything).filter((key) => key.startsWith(SNAPSHOT_PREFIX));
    if (keys.length) await chrome.storage.local.remove(keys);
    await chrome.storage.local.set({ [INDEX_KEY]: [] });
  });
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored?.[SETTINGS_KEY] || {};
  const envs = normalizeEnvs(raw.envs);
  const env = envs.some((item) => item.id === raw.env) ? raw.env : envs[0].id;
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    env,
    envs,
    scope: raw.scope === 'current' ? 'current' : 'all',
    restoreTarget: raw.restoreTarget === 'current' ? 'current' : 'new',
    autoBackup: !!raw.autoBackup,
    dedupeOnCapture: !!raw.dedupeOnCapture,
  };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    envs: normalizeEnvs(patch?.envs || current.envs),
  };
  if (!next.envs.some((item) => item.id === next.env)) next.env = next.envs[0].id;
  if (patch?.scope) next.scope = patch.scope === 'current' ? 'current' : 'all';
  if (patch?.restoreTarget) next.restoreTarget = patch.restoreTarget === 'current' ? 'current' : 'new';
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function storageBytes() {
  try {
    return await chrome.storage.local.getBytesInUse(null);
  } catch {
    return 0;
  }
}

export function freshSnapshotId(existingIds) {
  let id = createSnapshotId();
  const used = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  let guard = 0;
  while (used.has(id) && guard < 20) {
    id = createSnapshotId();
    guard += 1;
  }
  return id;
}

export async function exportBundle() {
  const index = await getIndex();
  const snapshots = [];
  for (const entry of index) {
    const snapshot = await getSnapshot(entry.id);
    if (snapshot) snapshots.push(snapshot);
  }
  return snapshots;
}

export function safeFileName(value, fallback = 'snapshot') {
  const cleaned = sanitizeText(value, 80)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}
