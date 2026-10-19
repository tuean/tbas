/**
 * TBAS dashboard.
 *
 * Everything here runs inside the extension page. The heavy lifting (snapshot
 * model, restore planning, validation, reports) lives in lib/core.js; browser
 * API calls live in lib/engine.js.
 */

import {
  DEFAULT_ENVS,
  allRestorableTabKeys,
  buildBundle,
  buildRestorePlan,
  dedupeSnapshot,
  displayTitle,
  envOf,
  escapeHtml,
  formatLocalDate,
  formatStats,
  hostOf,
  parseSnapshotText,
  renderHTMLReport,
  renderURLList,
  selectSnapshotTabs,
  searchSnapshot,
  snapshotSearchText,
  tabKeyOf,
} from './lib/core.js';
import { createEngine } from './lib/engine.js';
import {
  clearAll,
  deleteSnapshot,
  exportBundle,
  freshSnapshotId,
  getIndex,
  getSettings,
  getSnapshot,
  safeFileName,
  saveSettings,
  saveSnapshot,
  saveSnapshots,
  storageBytes,
} from './storage.js';

const VERSION = chrome.runtime.getManifest().version;
const engine = createEngine(chrome, { extensionVersion: VERSION });
const IS_MAC = /Mac/i.test(navigator.platform) || /Mac OS X/i.test(navigator.userAgent);
const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  index: [],
  snapshots: new Map(),
  textCache: new Map(),
  matchCache: new Map(),
  settings: null,
  envs: DEFAULT_ENVS.map((env) => ({ ...env })),
  currentEnv: 'office',
  envFilter: '',
  query: '',
  expanded: new Set(),
  selection: new Map(),
  groupCollapse: new Map(),
  ownTab: null,
  ownTabId: null,
  ownWindowId: null,
  live: { windows: 0, groups: 0, tabs: 0, capturable: 0 },
  busy: false,
  restoring: false,
  preloadPromise: null,
  lastCapture: null,
};

let liveTimer = null;
let storageTimer = null;
let searchTimer = null;

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  bindStaticEvents();
  setKeyboardLabels();

  document.title = `TBAS · 标签页快照`;

  try {
    state.ownTab = await chrome.tabs.getCurrent();
  } catch {
    state.ownTab = null;
  }
  state.ownTabId = state.ownTab?.id ?? null;
  state.ownWindowId = state.ownTab?.windowId ?? null;
  if (!state.ownWindowId) {
    try {
      state.ownWindowId = (await chrome.windows.getCurrent())?.id ?? null;
    } catch {
      state.ownWindowId = null;
    }
  }

  state.settings = await getSettings();
  state.envs = state.settings.envs;
  state.currentEnv = state.settings.env;
  $('#scope-select').value = state.settings.scope;
  $('#dedupe-toggle').checked = state.settings.dedupeOnCapture;

  renderCaptureEnv();
  refreshLive();

  $('#library-meta').textContent = '正在读取快照…';
  await refreshIndex({ render: false });
  await preloadSnapshots();
  renderAll();

  subscribeBrowserEvents();
  handleUrlAction();
  exposeDebugApi();
}

function setKeyboardLabels() {
  $('#save-kbd').textContent = IS_MAC ? '⌘S' : 'Ctrl+S';
  $('#search-kbd').textContent = IS_MAC ? '⌘K' : 'Ctrl+K';
}

function bindStaticEvents() {
  $('#capture-btn').addEventListener('click', () => doCapture());
  $('#capture-close-btn').addEventListener('click', () => doCapture({ close: true }));
  $('#capture-select-btn').addEventListener('click', openCapturePicker);
  $('#settings-btn').addEventListener('click', openSettings);

  $('#snapshot-name').addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') doCapture();
  });

  $('#scope-select').addEventListener('change', async (event) => {
    state.settings = await saveSettings({ scope: event.target.value });
  });

  $('#dedupe-toggle').addEventListener('change', async (event) => {
    state.settings = await saveSettings({ dedupeOnCapture: event.target.checked });
  });

  $('#capture-env').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-env]');
    if (!button) return;
    state.currentEnv = button.dataset.env;
    renderCaptureEnv();
    try {
      state.settings = await saveSettings({ env: state.currentEnv });
    } catch {
      /* the selection still applies to this capture */
    }
  });

  $('#env-filter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-env]');
    if (!button) return;
    state.envFilter = button.dataset.env;
    renderEnvFilters();
    renderList();
  });

  $('#search-input').addEventListener('input', (event) => {
    const value = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = value.trim();
      renderList();
    }, 110);
  });

  $('#snapshot-list').addEventListener('click', onListClick);
  $('#snapshot-list').addEventListener('change', onListChange);

  $('#import-btn').addEventListener('click', () => $('#file-input').click());
  $('#empty-import').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (event) => {
    const files = [...(event.target.files || [])];
    event.target.value = '';
    if (!files.length) return;
    const items = await Promise.all(
      files.map(async (file) => ({ filename: file.name, text: await file.text() })),
    );
    await importTexts(items);
  });

  $('#export-all-btn').addEventListener('click', exportAll);
  $('#empty-demo').addEventListener('click', loadDemo);
  $('#footer-demo').addEventListener('click', loadDemo);

  document.addEventListener('keydown', (event) => {
    const mod = IS_MAC ? event.metaKey : event.ctrlKey;
    const modalOpen = Boolean(document.querySelector('#modal-root .overlay'));
    if (mod && event.key.toLowerCase() === 's') {
      if (modalOpen) return;
      event.preventDefault();
      doCapture();
    } else if (mod && event.key.toLowerCase() === 'k') {
      if (modalOpen) return;
      event.preventDefault();
      $('#search-input').focus();
      $('#search-input').select();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLive();
  });
}

function subscribeBrowserEvents() {
  const schedule = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(refreshLive, 450);
  };
  const tabEvents = ['onCreated', 'onRemoved', 'onMoved', 'onAttached', 'onDetached', 'onUpdated', 'onActivated'];
  for (const name of tabEvents) chrome.tabs?.[name]?.addListener(schedule);
  const groupEvents = ['onCreated', 'onUpdated', 'onRemoved', 'onMoved'];
  for (const name of groupEvents) chrome.tabGroups?.[name]?.addListener(schedule);
  chrome.windows?.onRemoved?.addListener(schedule);
  chrome.windows?.onCreated?.addListener(schedule);

  chrome.storage.onChanged.addListener(onStorageChanged);
}

function onStorageChanged(changes, area) {
  if (area !== 'local') return;
  if (!Object.keys(changes).some((key) => key.startsWith('tbas.'))) return;
  clearTimeout(storageTimer);
  storageTimer = setTimeout(async () => {
    if (state.busy || state.restoring) return;
    try {
      state.settings = await getSettings();
      state.envs = state.settings.envs;
      if (!state.envs.some((env) => env.id === state.currentEnv)) state.currentEnv = state.settings.env;
      await refreshIndex({ render: false });
      await preloadSnapshots();
      renderAll();
    } catch (error) {
      console.warn('TBAS: storage refresh failed', error);
    }
  }, 300);
}

function handleUrlAction() {
  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  const restoreId = params.get('restore');
  if (restoreId) {
    state.expanded.add(restoreId);
    renderList();
    document.querySelector(`.snap-card[data-id="${restoreId}"]`)?.scrollIntoView({ block: 'start' });
  }
  if (action === 'capture') doCapture();
  else if (action === 'capture-close') doCapture({ close: true });
  if (params.size) {
    try {
      history.replaceState({}, '', location.pathname);
    } catch {
      /* chrome-extension pages may reject history rewrites */
    }
  }
}

/* ------------------------------------------------------------------ */
/* data loading                                                        */
/* ------------------------------------------------------------------ */

async function refreshIndex({ render = true } = {}) {
  state.index = await getIndex();
  const valid = new Set(state.index.map((entry) => entry.id));
  for (const id of [...state.snapshots.keys()]) {
    if (!valid.has(id)) {
      state.snapshots.delete(id);
      state.textCache.delete(id);
      state.selection.delete(id);
      state.expanded.delete(id);
      for (const key of [...state.groupCollapse.keys()]) {
        if (key.startsWith(`${id}|`)) state.groupCollapse.delete(key);
      }
    }
  }
  state.matchCache.clear();
  if (render) renderAll();
}

async function preloadSnapshots() {
  if (state.preloadPromise) return state.preloadPromise;
  const missing = state.index.filter((entry) => !state.snapshots.has(entry.id));
  if (!missing.length) return;

  state.preloadPromise = (async () => {
    let cursor = 0;
    const worker = async () => {
      while (cursor < missing.length) {
        const entry = missing[cursor];
        cursor += 1;
        try {
          const snapshot = await getSnapshot(entry.id);
          if (snapshot) putSnapshot(snapshot);
        } catch (error) {
          console.warn('TBAS: unable to load snapshot', entry.id, error);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker));
  })();

  try {
    await state.preloadPromise;
  } finally {
    state.preloadPromise = null;
  }
}

function putSnapshot(snapshot) {
  state.snapshots.set(snapshot.id, snapshot);
  state.textCache.delete(snapshot.id);
  state.matchCache.clear();
}

function ensureSelection(snapshot) {
  if (!state.selection.has(snapshot.id)) {
    state.selection.set(snapshot.id, allRestorableTabKeys(snapshot));
    return;
  }
  const valid = allRestorableTabKeys(snapshot);
  const current = state.selection.get(snapshot.id);
  for (const key of [...current]) if (!valid.has(key)) current.delete(key);
}

/* ------------------------------------------------------------------ */
/* live counters                                                       */
/* ------------------------------------------------------------------ */

async function refreshLive() {
  try {
    const [windows, groups] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
      chrome.tabGroups.query({}),
    ]);
    const normal = (windows || []).filter((win) => !win.incognito);
    const allTabs = normal.reduce((sum, win) => sum + (win.tabs?.length || 0), 0);
    const ownIncluded = normal.some((win) => (win.tabs || []).some((tab) => tab.id === state.ownTabId));
    const capturable = Math.max(0, allTabs - (ownIncluded ? 1 : 0));
    state.live = { windows: normal.length, groups: groups.length, tabs: allTabs, capturable };

    $('#live-stat').innerHTML = `<span class="live-dot"></span>${normal.length} 窗口 · ${groups.length} 组 · ${allTabs} 标签`;
    $('#capture-hint').textContent =
      capturable > 0
        ? `当前可保存 ${capturable} 个标签（不含本面板）。窗口、分组、颜色、固定页和顺序都会记录。`
        : '当前窗口只有 TBAS 面板。打开一些标签页，或切换到有内容的窗口。';

    const estimate = capturable > 0 ? memoryEstimate(capturable) : '';
    $('#capture-note').textContent = capturable > 0
      ? `保存并关闭后，按每标签约 80MB 粗略估算，可释放约 ${estimate} 内存。`
      : '';
    updateCaptureButtons();
  } catch (error) {
    console.warn('TBAS: live refresh failed', error);
    $('#live-stat').textContent = '无法读取浏览器标签';
  }
}

function memoryEstimate(tabs) {
  const mb = tabs * 80;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function updateCaptureButtons() {
  const disabled = state.busy || state.live.capturable === 0;
  $('#capture-btn').disabled = disabled;
  $('#capture-close-btn').disabled = disabled;
  $('#capture-select-btn').disabled = disabled;
  $('#capture-btn span').textContent = state.busy ? '保存中…' : '保存快照';
}

/* ------------------------------------------------------------------ */
/* capture                                                             */
/* ------------------------------------------------------------------ */

async function doCapture({ close = false } = {}) {
  if (state.busy || state.restoring) return null;
  if (close && state.ownTabId == null) {
    toast('无法确定当前面板所在的标签页，已取消关闭操作', 'error');
    return null;
  }
  if (close) {
    await refreshLive();
    const count = state.live.capturable;
    if (!count) {
      toast('没有可保存的标签页', 'info');
      return null;
    }
    const ok = await confirmDialog({
      title: '保存并关闭当前标签页？',
      messageHtml:
        `将保存当前 <b>${state.live.windows}</b> 个窗口里的 <b>${count}</b> 个标签，` +
        `然后关闭除本面板外的所有标签页。<br><br>` +
        `按每标签约 80MB 粗略估算，可释放约 <b>${memoryEstimate(count)}</b> 内存。` +
        `<br><br><span class="muted">快照会先保存到本机，浏览器重启后仍然可以恢复。` +
        `如果有未提交的表单，Edge 可能会弹出确认框。</span>`,
      confirmText: '保存并关闭',
      danger: true,
    });
    if (!ok) return null;
  }

  state.busy = true;
  state.lastCapture = { stage: 'started', at: new Date().toISOString() };
  updateCaptureButtons();
  try {
    const name = $('#snapshot-name').value.trim();
    const { snapshot, windows } = await engine.capture({
      scope: $('#scope-select').value,
      windowId: state.ownWindowId,
      excludeTabIds: state.ownTabId == null ? [] : [state.ownTabId],
      excludeUrlPrefixes: [chrome.runtime.getURL('')],
      env: state.currentEnv,
      envLabel: envLabel(state.currentEnv),
      name,
      dedupe: $('#dedupe-toggle').checked,
    });

    state.lastCapture = { stage: 'captured', snapshotId: snapshot.id, tabs: snapshot.stats.tabs };
    await saveSnapshot(snapshot);
    state.lastCapture = { stage: 'saved', snapshotId: snapshot.id, tabs: snapshot.stats.tabs };
    putSnapshot(snapshot);
    state.expanded.add(snapshot.id);
    state.selection.delete(snapshot.id);
    ensureSelection(snapshot);
    $('#snapshot-name').value = '';
    await refreshIndex({ render: false });
    renderAll();
    toast(`已保存「${snapshot.name}」· ${snapshot.stats.tabs} 个标签`, 'success');

    if (state.settings.autoBackup) autoBackupSnapshot(snapshot);

    let closeResult = null;
    if (close) {
      state.lastCapture = { stage: 'closing', snapshotId: snapshot.id, windows: windows.map((win) => win.id) };
      closeResult = await engine.closeCaptured(windows, { keepTabId: state.ownTabId });
      state.lastCapture = { stage: 'closed', snapshotId: snapshot.id, closeResult };
      if (closeResult.errors.length) {
        toast(`已保存，但有 ${closeResult.errors.length} 个窗口未能关闭`, 'error');
      } else {
        toast(`已归档并关闭 ${closeResult.closed} 个标签页`, 'success');
      }
      await refreshLive();
      await refreshIndex({ render: false });
      renderAll();
    }
    return { snapshot, closeResult };
  } catch (error) {
    console.error('TBAS: capture failed', error);
    state.lastCapture = { stage: 'failed', error: error.message, at: new Date().toISOString() };
    toast(`保存失败：${error.message}`, 'error');
    return null;
  } finally {
    state.busy = false;
    updateCaptureButtons();
  }
}

/* ------------------------------------------------------------------ */
/* capture picker (save a manual subset)                               */
/* ------------------------------------------------------------------ */

async function openCapturePicker() {
  if (state.busy || state.restoring) return;
  state.busy = true;
  updateCaptureButtons();
  let captured;
  try {
    captured = await engine.capture({
      scope: $('#scope-select').value,
      windowId: state.ownWindowId,
      excludeTabIds: state.ownTabId == null ? [] : [state.ownTabId],
      excludeUrlPrefixes: [chrome.runtime.getURL('')],
      env: state.currentEnv,
      envLabel: envLabel(state.currentEnv),
      name: $('#snapshot-name').value.trim(),
      dedupe: false,
    });
  } catch (error) {
    toast(`读取标签失败：${error.message}`, 'error');
    return;
  } finally {
    state.busy = false;
    updateCaptureButtons();
  }

  const selection = new Set();
  for (const win of captured.snapshot.windows || []) {
    for (const tab of win.tabs || []) selection.add(tabKeyOf(win.key, tab.key));
  }
  showCapturePicker(captured, selection);
}

function pickWindowKeys(snapshot, windowKey) {
  const win = (snapshot.windows || []).find((item) => item.key === windowKey);
  if (!win) return [];
  return (win.tabs || []).map((tab) => tabKeyOf(win.key, tab.key));
}

function pickGroupKeys(snapshot, windowKey, groupKey) {
  const win = (snapshot.windows || []).find((item) => item.key === windowKey);
  if (!win) return [];
  return (win.tabs || [])
    .filter((tab) => (groupKey ? tab.group === groupKey : !tab.group))
    .map((tab) => tabKeyOf(win.key, tab.key));
}

function renderPickTree(snapshot, collapse) {
  return (snapshot.windows || [])
    .map((win) => {
      const blocks = [];
      for (const run of groupRunsOf(win)) {
        const blockKey = `${win.key}:${run.runKey}`;
        const collapsed = collapse.has(blockKey) ? collapse.get(blockKey) : !!run.group?.collapsed;
        blocks.push(renderPickGroup(win, run.group, run.runKey, run.tabs, collapsed));
      }
      return `<div class="pick-window">
        <div class="pick-win-head">
          <input class="check" type="checkbox" data-pick-window="${escapeHtml(win.key)}" checked>
          <strong>窗口 ${escapeHtml(win.key.replace(/^w/, ''))}</strong>
          ${win.focused ? '<span class="badge">主窗口</span>' : ''}
          <span class="pick-win-count">${(win.tabs || []).length} 标签 · ${(win.groups || []).length} 组</span>
        </div>
        ${blocks.join('')}
      </div>`;
    })
    .join('');
}

function renderPickGroup(win, group, runKey, tabs, collapsed) {
  const groupKey = group?.key || '';
  const blockKey = `${win.key}:${runKey}`;
  const groupCheck = group
    ? `<input class="check" type="checkbox" data-pick-group="${escapeHtml(`${win.key}:${groupKey}`)}" checked>`
    : '<span class="check-spacer" aria-hidden="true"></span>';
  return `<div class="pick-group${collapsed ? ' is-collapsed' : ''}" data-pick-block="${escapeHtml(blockKey)}">
    <div class="pick-group-head" data-pick-toggle-head="${escapeHtml(blockKey)}">
      <button class="group-chevron" type="button" data-pick-toggle="${escapeHtml(blockKey)}" aria-expanded="${String(!collapsed)}" title="${collapsed ? '展开分组' : '折叠分组'}"><span class="chev-glyph" aria-hidden="true"></span></button>
      ${groupCheck}
      <span class="dot g-${escapeHtml(group?.color || 'grey')}"></span>
      <span class="group-title">${escapeHtml(group?.title || '未分组')}</span>
      <span class="group-count">${tabs.length}</span>
      ${group?.collapsed ? '<span class="tag" title="保存时该分组在 Edge 中处于折叠状态">默认折叠</span>' : ''}
    </div>
    <ul class="pick-tab-list">
      ${tabs
        .map((tab) => {
          const badges = [];
          if (tab.active) badges.push('<span class="active-badge">当前</span>');
          if (!tab.restorable) badges.push('<span class="missing-badge">内部页</span>');
          return `<li class="pick-tab">
            <input class="check" type="checkbox" data-pick-tab="${escapeHtml(tabKeyOf(win.key, tab.key))}" checked>
            <span class="tab-main">
              <span class="tab-title">${tab.pinned ? '<span class="pin">📌</span>' : ''}${escapeHtml(displayTitle(tab))}</span>
              <span class="tab-host">${escapeHtml(tab.restorable ? hostOf(tab.url) || tab.url : tab.url || '内部页')}</span>
            </span>
            ${badges.length ? `<span class="tab-badges">${badges.join('')}</span>` : ''}
          </li>`;
        })
        .join('')}
    </ul>
  </div>`;
}

function togglePickBlock(block, collapse) {
  if (!block) return;
  const collapsed = block.classList.toggle('is-collapsed');
  collapse.set(block.dataset.pickBlock, collapsed);
  const chevron = block.querySelector('.group-chevron');
  if (chevron) {
    chevron.setAttribute('aria-expanded', String(!collapsed));
    chevron.title = collapsed ? '展开分组' : '折叠分组';
  }
}

function setAllPickCollapsed(modal, collapse, collapsed) {
  modal.querySelectorAll('.pick-group').forEach((block) => {
    block.classList.toggle('is-collapsed', collapsed);
    collapse.set(block.dataset.pickBlock, collapsed);
    const chevron = block.querySelector('.group-chevron');
    if (chevron) {
      chevron.setAttribute('aria-expanded', String(!collapsed));
      chevron.title = collapsed ? '展开分组' : '折叠分组';
    }
  });
}

function updatePickUI(modal, snapshot, selection) {
  const applyTriState = (box, keys) => {
    const total = keys.length;
    const count = keys.filter((key) => selection.has(key)).length;
    box.disabled = total === 0;
    box.checked = total > 0 && count === total;
    box.indeterminate = count > 0 && count < total;
  };

  modal.querySelectorAll('[data-pick-tab]').forEach((box) => {
    box.checked = selection.has(box.dataset.pickTab);
  });
  modal.querySelectorAll('[data-pick-window]').forEach((box) => {
    applyTriState(box, pickWindowKeys(snapshot, box.dataset.pickWindow));
  });
  modal.querySelectorAll('[data-pick-group]').forEach((box) => {
    const [windowKey, groupKey = ''] = box.dataset.pickGroup.split(':');
    applyTriState(box, pickGroupKeys(snapshot, windowKey, groupKey));
  });

  const count = modal.querySelector('[data-pick-count]');
  if (count) count.textContent = String(selection.size);
  for (const selector of ['[data-pick-save]', '[data-pick-save-close]']) {
    const button = modal.querySelector(selector);
    if (button) button.disabled = selection.size === 0;
  }
}

function showCapturePicker({ snapshot, liveByKey }, selection) {
  const env = envLabel(snapshot.env);
  const collapse = new Map();
  const body = `<div class="pick-toolbar">
      <span class="pick-count"><b data-pick-count>${selection.size}</b> / ${snapshot.stats.tabs} 个标签</span>
      <button class="link-btn" type="button" data-pick-all>全选</button>
      <button class="link-btn" type="button" data-pick-none>全不选</button>
      <button class="link-btn" type="button" data-pick-collapse>全部折叠</button>
      <button class="link-btn" type="button" data-pick-expand>全部展开</button>
      <span class="pick-env">${escapeHtml(env)} · ${escapeHtml(snapshot.name)}</span>
    </div>
    <div class="pick-tree" data-pick-tree>${renderPickTree(snapshot, collapse)}</div>
    <p class="pick-note">保存到「<b>${escapeHtml(env)}</b>」环境，名称「<b>${escapeHtml(snapshot.name)}</b>」。</p>
    <p class="pick-note">「保存并关闭所选」只关闭勾选的标签，未勾选的标签会保留。</p>`;

  const { modal, close } = openModal({
    title: '选择要保存的标签',
    subtitle: '勾选窗口、分组或单个标签；未勾选的不会写入快照。',
    width: '820px',
    body,
    footer: `<button class="btn" data-close type="button">取消</button>
      <button class="btn" data-pick-save type="button">保存所选</button>
      <button class="btn danger" data-pick-save-close type="button">保存并关闭所选</button>`,
    onMount(modalElement, closeModal) {
      updatePickUI(modalElement, snapshot, selection);

      modalElement.addEventListener('change', (event) => {
        const box = event.target;
        if (box.matches('[data-pick-tab]')) {
          if (box.checked) selection.add(box.dataset.pickTab);
          else selection.delete(box.dataset.pickTab);
        } else if (box.matches('[data-pick-group]')) {
          const [windowKey, groupKey = ''] = box.dataset.pickGroup.split(':');
          for (const key of pickGroupKeys(snapshot, windowKey, groupKey)) {
            if (box.checked) selection.add(key);
            else selection.delete(key);
          }
        } else if (box.matches('[data-pick-window]')) {
          for (const key of pickWindowKeys(snapshot, box.dataset.pickWindow)) {
            if (box.checked) selection.add(key);
            else selection.delete(key);
          }
        }
        updatePickUI(modalElement, snapshot, selection);
      });

      modalElement.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-pick-toggle]');
        const head = event.target.closest('[data-pick-toggle-head]');
        if (toggle || (head && !event.target.closest('input, button, a, select, label'))) {
          const block = (toggle || head).closest('.pick-group');
          togglePickBlock(block, collapse);
          return;
        }

        const collapseAll = event.target.closest('[data-pick-collapse]');
        const expandAll = event.target.closest('[data-pick-expand]');
        if (collapseAll || expandAll) {
          setAllPickCollapsed(modalElement, collapse, Boolean(collapseAll));
          return;
        }

        const all = event.target.closest('[data-pick-all]');
        const none = event.target.closest('[data-pick-none]');
        if (all) {
          for (const win of snapshot.windows || []) {
            for (const tab of win.tabs || []) selection.add(tabKeyOf(win.key, tab.key));
          }
          updatePickUI(modalElement, snapshot, selection);
        } else if (none) {
          selection.clear();
          updatePickUI(modalElement, snapshot, selection);
        }
      });

      const saveButton = $('[data-pick-save]', modalElement);
      const closeButton = $('[data-pick-save-close]', modalElement);
      const save = async (closeAfter) => {
        if (!selection.size || state.busy || state.restoring) return;
        const labels = new Map([
          [saveButton, saveButton.textContent],
          [closeButton, closeButton.textContent],
        ]);
        state.busy = true;
        updateCaptureButtons();
        for (const button of labels.keys()) button.disabled = true;
        try {
          const filtered = selectSnapshotTabs(snapshot, selection);
          const finalSnapshot = $('#dedupe-toggle').checked
            ? dedupeSnapshot(filtered, { scope: 'window' }).snapshot
            : filtered;

          await saveSnapshot(finalSnapshot);
          putSnapshot(finalSnapshot);
          state.expanded.add(finalSnapshot.id);
          state.selection.delete(finalSnapshot.id);
          ensureSelection(finalSnapshot);
          $('#snapshot-name').value = '';
          await refreshIndex({ render: false });
          renderAll();
          toast(`已保存「${finalSnapshot.name}」· ${finalSnapshot.stats.tabs} 个标签`, 'success');
          if (state.settings.autoBackup) autoBackupSnapshot(finalSnapshot);

          if (closeAfter) {
            const ids = [...selection].map((key) => liveByKey?.[key]).filter((id) => Number.isFinite(id));
            const result = await engine.closeTabs(ids, { keepTabId: state.ownTabId });
            if (result.errors.length) {
              toast(`已保存，但有 ${result.errors.length} 个标签未能关闭`, 'error');
            } else {
              toast(`已归档并关闭所选 ${result.closed} 个标签`, 'success');
            }
            await refreshLive();
          }
          closeModal();
        } catch (error) {
          toast(`保存失败：${error.message}`, 'error');
          for (const [button, label] of labels) {
            button.disabled = false;
            button.textContent = label;
          }
        } finally {
          state.busy = false;
          updateCaptureButtons();
        }
      };

      saveButton.addEventListener('click', () => save(false));
      closeButton.addEventListener('click', () => save(true));
    },
  });

  return { modal, close };
}

/* ------------------------------------------------------------------ */
/* rendering: environment controls                                     */
/* ------------------------------------------------------------------ */

function envLabel(id) {
  return state.envs.find((env) => env.id === id)?.label || id;
}

function getEnv(id) {
  return state.envs.find((env) => env.id === id) || { id, label: id || '未分类', color: '#64748b' };
}

function renderCaptureEnv() {
  if (!state.envs.some((env) => env.id === state.currentEnv)) state.currentEnv = state.envs[0].id;
  $('#capture-env').innerHTML = state.envs
    .map(
      (env) =>
        `<button type="button" class="env-btn${env.id === state.currentEnv ? ' active' : ''}" data-env="${escapeHtml(env.id)}" style="--env:${env.color}"><span class="env-dot"></span>${escapeHtml(env.label)}</button>`,
    )
    .join('');
}

function renderEnvFilters() {
  const counts = new Map();
  for (const entry of state.index) counts.set(entry.env, (counts.get(entry.env) || 0) + 1);
  const known = new Set(state.envs.map((env) => env.id));
  const extra = [...counts.keys()].filter((id) => !known.has(id));
  const filters = [
    { id: '', label: '全部', count: state.index.length },
    ...state.envs.map((env) => ({ id: env.id, label: env.label, count: counts.get(env.id) || 0 })),
    ...extra.map((id) => ({ id, label: getEnv(id).label, count: counts.get(id) || 0 })),
  ];
  if (state.envFilter && !filters.some((filter) => filter.id === state.envFilter)) state.envFilter = '';
  $('#env-filter').innerHTML = filters
    .map(
      (filter) =>
        `<button type="button" class="filter-btn${filter.id === state.envFilter ? ' active' : ''}" data-env="${escapeHtml(filter.id)}">${escapeHtml(filter.label)}<span class="count">${filter.count}</span></button>`,
    )
    .join('');
}

/* ------------------------------------------------------------------ */
/* rendering: snapshot list                                            */
/* ------------------------------------------------------------------ */

function renderAll() {
  renderCaptureEnv();
  renderEnvFilters();
  renderList();
  updateFooter();
}

function renderList() {
  const list = $('#snapshot-list');
  const empty = $('#empty-state');
  const query = state.query.trim().toLowerCase();
  const tokens = query ? query.split(/\s+/).filter(Boolean) : [];

  const filtered = state.index.filter((entry) => {
    if (state.envFilter && entry.env !== state.envFilter) return false;
    if (!tokens.length) return true;
    const snapshot = state.snapshots.get(entry.id);
    const haystack = snapshot ? searchTextOf(snapshot) : `${entry.name} ${entry.env} ${(entry.tags || []).join(' ')}`.toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });

  if (!state.index.length) {
    list.innerHTML = '';
    empty.hidden = false;
    $('#library-meta').textContent = '';
    return;
  }

  empty.hidden = true;
  if (!filtered.length) {
    list.innerHTML = `<div class="filtered-empty">没有匹配的快照。<button type="button" class="link-btn" data-action="clear-filters">清除筛选</button></div>`;
  } else {
    list.innerHTML = filtered.map((entry) => renderCard(entry)).join('');
  }

  const totalTabs = state.index.reduce((sum, entry) => sum + (entry.stats?.tabs || 0), 0);

  const meta = [`${filtered.length} / ${state.index.length} 个快照`];
  if (query) meta.push(`搜索「${state.query}」`);
  if (state.envFilter) meta.push(`环境：${getEnv(state.envFilter).label}`);
  meta.push(`共 ${totalTabs} 个标签`);
  $('#library-meta').textContent = meta.join(' · ');

  for (const id of state.expanded) updateSelectionUI(id);
}

function searchTextOf(snapshot) {
  let text = state.textCache.get(snapshot.id);
  if (!text) {
    text = snapshotSearchText(snapshot);
    state.textCache.set(snapshot.id, text);
  }
  return text;
}

function matchCountOf(snapshot) {
  if (!state.query) return 0;
  const key = `${snapshot.id}|${state.query}`;
  if (state.matchCache.has(key)) return state.matchCache.get(key);
  const count = searchSnapshot(snapshot, state.query).count;
  state.matchCache.set(key, count);
  return count;
}

function shortDate(iso) {
  const date = new Date(iso);
  const now = new Date();
  return formatLocalDate(iso).slice(date.getFullYear() === now.getFullYear() ? 5 : 0);
}

function renderCard(entry) {
  const snapshot = state.snapshots.get(entry.id);
  if (!snapshot) return renderMissingCard(entry);

  ensureSelection(snapshot);
  const env = envOf(snapshot, state.envs);
  const stats = snapshot.stats || entry.stats || {};
  const open = state.expanded.has(snapshot.id);
  const matches = matchCountOf(snapshot);
  const tags = (snapshot.tags || []).slice(0, 3);

  return `<article class="snap-card${open ? ' is-open' : ''}" data-id="${escapeHtml(snapshot.id)}" style="--env:${env.color}">
  <span class="snap-accent" aria-hidden="true"></span>
  <div class="snap-head">
    <div class="snap-title-wrap" data-action="toggle" title="${open ? '收起' : '展开'}快照">
      <div class="snap-line">
        <h3 class="snap-title">${escapeHtml(snapshot.name)}</h3>
        <span class="env-pill">${escapeHtml(env.label)}</span>
        ${stats.duplicates ? `<span class="dup-badge">${stats.duplicates} 重复</span>` : ''}
        ${stats.unrestorable ? `<span class="dup-badge">${stats.unrestorable} 内部页</span>` : ''}
        ${matches ? `<span class="match-badge">${matches} 个匹配</span>` : ''}
      </div>
      <div class="snap-meta">
        <span>${escapeHtml(shortDate(snapshot.createdAt))}</span>
        <span class="sep">·</span>
        <span>${formatStats(stats)}</span>
        ${tags.length ? `<span class="sep">·</span><span>${tags.map((tag) => escapeHtml(tag)).join(' / ')}</span>` : ''}
      </div>
    </div>
    <div class="snap-actions">
      <button class="btn small" type="button" data-action="restore-all">恢复全部</button>
      <button class="btn small ghost" type="button" data-action="toggle">${open ? '收起' : '查看'}</button>
    </div>
  </div>
  ${open ? `<div class="snap-detail">${renderDetail(snapshot)}</div>` : ''}
</article>`;
}

function renderMissingCard(entry) {
  return `<article class="snap-card" data-id="${escapeHtml(entry.id)}">
  <div class="snap-head">
    <div class="snap-title-wrap">
      <div class="snap-line"><h3 class="snap-title">${escapeHtml(entry.name)}</h3><span class="dup-badge">数据读取失败</span></div>
      <div class="snap-meta"><span>索引存在，但快照内容缺失或已损坏。</span></div>
    </div>
    <div class="snap-actions"><button class="btn small danger" type="button" data-action="delete">删除索引</button></div>
  </div>
</article>`;
}

function renderDetail(snapshot) {
  const selected = state.selection.get(snapshot.id) || new Set();
  const total = allRestorableTabKeys(snapshot).size;
  const stats = snapshot.stats || {};
  const target = state.settings.restoreTarget;
  const windows = (snapshot.windows || []).map((win) => renderWindow(snapshot, win, selected)).join('');

  return `<div class="detail-toolbar">
    <div class="selection-info">
      <b data-role="selected-count">${selected.size}</b><span>/</span><span data-role="total-count">${total}</span><span>已选</span>
      <button class="link-btn" type="button" data-action="select-all">全选</button>
      <button class="link-btn" type="button" data-action="select-none">全不选</button>
    </div>
    <label class="target-select"><span>恢复到</span>
      <select data-target-select>
        <option value="new"${target === 'new' ? ' selected' : ''}>新窗口</option>
        <option value="current"${target === 'current' ? ' selected' : ''}>当前窗口</option>
      </select>
    </label>
    <button class="btn small primary" type="button" data-action="restore-selected"${selected.size ? '' : ' disabled'}>恢复所选</button>
    <button class="btn small" type="button" data-action="copy-selected"${selected.size ? '' : ' disabled'}>复制链接</button>
  </div>
  <div class="detail-actions">
    <button class="link-btn" type="button" data-action="export-json">导出 JSON</button>
    <button class="link-btn" type="button" data-action="export-html">导出 HTML 报告</button>
    <button class="link-btn" type="button" data-action="dedupe">去重</button>
    <button class="link-btn" type="button" data-action="collapse-groups">全部折叠</button>
    <button class="link-btn" type="button" data-action="expand-groups">全部展开</button>
    <button class="link-btn" type="button" data-action="rename">重命名</button>
    <button class="link-btn danger-text" type="button" data-action="delete">删除</button>
    <span class="grow"></span>
    ${stats.unrestorable ? `<span class="detail-hint">${stats.unrestorable} 个内部页无法恢复</span>` : ''}
  </div>
  <div class="detail-scroll">${windows}</div>`;
}

function groupRunsOf(win) {
  const groupMap = new Map((win.groups || []).map((group) => [group.key, group]));
  const runs = [];
  let current = Symbol('none');
  let buffer = [];

  const flush = () => {
    if (!buffer.length) return;
    const ungrouped = current === null;
    runs.push({
      group: ungrouped ? null : groupMap.get(current),
      runKey: ungrouped ? `u-${buffer[0].key}` : current,
      tabs: buffer,
    });
    buffer = [];
  };

  for (const tab of win.tabs || []) {
    const groupKey = tab.group || null;
    if (buffer.length && groupKey !== current) flush();
    if (!buffer.length) current = groupKey;
    buffer.push(tab);
  }
  flush();
  return runs;
}

function isGroupCollapsed(snapshotId, win, group, runKey) {
  const key = `${snapshotId}|${win.key}|${runKey}`;
  if (state.groupCollapse.has(key)) return state.groupCollapse.get(key);
  return !!group?.collapsed;
}

function renderWindow(snapshot, win, selected) {
  const restorable = (win.tabs || []).filter((tab) => tab.restorable);
  const selCount = restorable.filter((tab) => selected.has(tabKeyOf(win.key, tab.key))).length;
  const allChecked = restorable.length > 0 && selCount === restorable.length;
  const indeterminate = selCount > 0 && selCount < restorable.length;
  const blocks = groupRunsOf(win).map((run) =>
    renderGroupBlock(snapshot, win, run.group, run.runKey, run.tabs, selected),
  );

  return `<div class="win-block">
    <div class="win-head">
      <input class="check" type="checkbox" data-window-check="${escapeHtml(win.key)}"${allChecked ? ' checked' : ''}${indeterminate ? ' data-indeterminate="1"' : ''}${restorable.length ? '' : ' disabled'}>
      <span class="win-name">窗口 ${escapeHtml(win.key.replace(/^w/, ''))}</span>
      ${win.focused ? '<span class="badge">主窗口</span>' : ''}
      <span class="win-count">${(win.tabs || []).length} 标签 · ${(win.groups || []).length} 组</span>
    </div>
    ${blocks.join('')}
  </div>`;
}

function renderGroupBlock(snapshot, win, group, runKey, tabs, selected) {
  const groupKey = group?.key || '';
  const restorable = tabs.filter((tab) => tab.restorable);
  const keys = restorable.map((tab) => tabKeyOf(win.key, tab.key));
  const selCount = keys.filter((key) => selected.has(key)).length;
  const allChecked = keys.length > 0 && selCount === keys.length;
  const indeterminate = selCount > 0 && selCount < keys.length;
  const color = group?.color || 'grey';
  const collapsed = isGroupCollapsed(snapshot.id, win, group, runKey);
  const blockId = `${win.key}:${runKey}`;
  // Ungrouped runs can appear before and after real groups. A shared checkbox
  // would toggle every ungrouped tab in the window, so ungrouped rows rely on
  // the window checkbox and individual tab checkboxes instead.
  const groupCheck = group
    ? `<input class="check" type="checkbox" data-group-check="${escapeHtml(`${win.key}:${groupKey}`)}"${allChecked ? ' checked' : ''}${indeterminate ? ' data-indeterminate="1"' : ''}${keys.length ? '' : ' disabled'}>`
    : '<span class="check-spacer" aria-hidden="true"></span>';

  return `<div class="group-block${collapsed ? ' is-collapsed' : ''}" data-group="${escapeHtml(groupKey)}" data-block="${escapeHtml(blockId)}" data-window="${escapeHtml(win.key)}" data-run="${escapeHtml(runKey)}">
    <div class="group-head" data-group-toggle="${escapeHtml(blockId)}">
      <button class="group-chevron" type="button" data-action="toggle-group" data-block="${escapeHtml(blockId)}" aria-expanded="${String(!collapsed)}" title="${collapsed ? '展开分组' : '折叠分组'}"><span class="chev-glyph" aria-hidden="true"></span></button>
      ${groupCheck}
      <span class="dot g-${escapeHtml(color)}"></span>
      <span class="group-title">${escapeHtml(group?.title || '未分组')}</span>
      <span class="group-count">${tabs.length}</span>
      ${group?.collapsed ? '<span class="tag" title="保存时该分组在 Edge 中处于折叠状态">默认折叠</span>' : ''}
      <button class="link-btn" type="button" data-action="restore-group" data-window="${escapeHtml(win.key)}" data-group="${escapeHtml(groupKey)}"${keys.length ? '' : ' disabled'}>恢复本组</button>
    </div>
    <ul class="tab-list">${tabs.map((tab) => renderTabRow(win, tab, selected)).join('')}</ul>
  </div>`;
}

function toggleGroupBlock(card, block) {
  if (!card || !block) return;
  const collapsed = block.classList.toggle('is-collapsed');
  state.groupCollapse.set(
    `${card.dataset.id}|${block.dataset.window}|${block.dataset.run}`,
    collapsed,
  );
  const chevron = block.querySelector('.group-chevron');
  if (chevron) {
    chevron.setAttribute('aria-expanded', String(!collapsed));
    chevron.title = collapsed ? '展开分组' : '折叠分组';
  }
}

function setAllGroupsCollapsed(snapshot, collapsed) {
  for (const win of snapshot.windows || []) {
    for (const run of groupRunsOf(win)) {
      state.groupCollapse.set(`${snapshot.id}|${win.key}|${run.runKey}`, collapsed);
    }
  }
  const card = document.querySelector(`.snap-card[data-id="${snapshot.id}"]`);
  if (!card) return;
  card.querySelectorAll('.group-block').forEach((block) => {
    block.classList.toggle('is-collapsed', collapsed);
    const chevron = block.querySelector('.group-chevron');
    if (chevron) {
      chevron.setAttribute('aria-expanded', String(!collapsed));
      chevron.title = collapsed ? '展开分组' : '折叠分组';
    }
  });
}

function renderTabRow(win, tab, selected) {
  const globalKey = tabKeyOf(win.key, tab.key);
  const checked = tab.restorable && selected.has(globalKey);
  const classes = ['tab-row'];
  if (checked) classes.push('is-selected');
  if (!tab.restorable) classes.push('is-missing');
  const badges = [];
  if (tab.active) badges.push('<span class="active-badge">当前</span>');
  if (!tab.restorable) badges.push('<span class="missing-badge">内部页</span>');

  return `<li class="${classes.join(' ')}" data-tab-key="${escapeHtml(globalKey)}" title="${escapeHtml(tab.url || '')}">
    <input class="check" type="checkbox" data-tab-check="${escapeHtml(globalKey)}"${checked ? ' checked' : ''}${tab.restorable ? '' : ' disabled'}>
    <span class="tab-main">
      <span class="tab-title">${tab.pinned ? '<span class="pin">📌</span>' : ''}${escapeHtml(displayTitle(tab))}</span>
      <span class="tab-host">${escapeHtml(tab.restorable ? hostOf(tab.url) || tab.url : tab.url || '内部页')}</span>
    </span>
    ${badges.length ? `<span class="tab-badges">${badges.join('')}</span>` : ''}
  </li>`;
}

/* ------------------------------------------------------------------ */
/* selection                                                           */
/* ------------------------------------------------------------------ */

function groupTabsOf(snapshot, windowKey, groupKey) {
  const win = (snapshot.windows || []).find((item) => item.key === windowKey);
  if (!win) return [];
  return (win.tabs || []).filter((tab) => (groupKey ? tab.group === groupKey : !tab.group));
}

function restorableKeysOf(win, tabs) {
  return tabs.filter((tab) => tab.restorable).map((tab) => tabKeyOf(win.key, tab.key));
}

function updateSelectionUI(id) {
  const card = document.querySelector(`.snap-card[data-id="${id}"]`);
  const snapshot = state.snapshots.get(id);
  if (!card || !snapshot) return;
  const selected = state.selection.get(id) || new Set();
  const restorable = allRestorableTabKeys(snapshot);

  card.querySelectorAll('[data-tab-check]').forEach((box) => {
    const key = box.dataset.tabCheck;
    const isRestorable = restorable.has(key);
    box.disabled = !isRestorable;
    box.checked = isRestorable && selected.has(key);
    box.closest('.tab-row')?.classList.toggle('is-selected', box.checked);
  });

  const applyTriState = (box, keys) => {
    const total = keys.length;
    const count = keys.filter((key) => selected.has(key)).length;
    box.disabled = total === 0;
    box.checked = total > 0 && count === total;
    box.indeterminate = count > 0 && count < total;
  };

  card.querySelectorAll('[data-window-check]').forEach((box) => {
    const win = snapshot.windows.find((item) => item.key === box.dataset.windowCheck);
    if (win) applyTriState(box, restorableKeysOf(win, win.tabs || []));
  });

  card.querySelectorAll('[data-group-check]').forEach((box) => {
    const [windowKey, groupKey = ''] = box.dataset.groupCheck.split(':');
    const win = snapshot.windows.find((item) => item.key === windowKey);
    if (win) applyTriState(box, restorableKeysOf(win, groupTabsOf(snapshot, windowKey, groupKey)));
  });

  const countEl = card.querySelector('[data-role="selected-count"]');
  if (countEl) countEl.textContent = String(selected.size);
  const restoreBtn = card.querySelector('[data-action="restore-selected"]');
  if (restoreBtn) restoreBtn.disabled = selected.size === 0;
  const copyBtn = card.querySelector('[data-action="copy-selected"]');
  if (copyBtn) copyBtn.disabled = selected.size === 0;
}

function rerenderCard(id) {
  const card = document.querySelector(`.snap-card[data-id="${id}"]`);
  const entry = state.index.find((item) => item.id === id);
  if (!card || !entry) {
    renderList();
    return;
  }
  card.outerHTML = renderCard(entry);
  updateSelectionUI(id);
}

/* ------------------------------------------------------------------ */
/* list events                                                         */
/* ------------------------------------------------------------------ */

async function onListClick(event) {
  const groupHead = event.target.closest('[data-group-toggle]');
  if (groupHead && !event.target.closest('input, button, a, select, label')) {
    const card = groupHead.closest('.snap-card');
    toggleGroupBlock(card, groupHead.closest('.group-block'));
    return;
  }

  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'clear-filters') {
    state.query = '';
    state.envFilter = '';
    $('#search-input').value = '';
    renderEnvFilters();
    renderList();
    return;
  }

  const card = button.closest('.snap-card');
  const id = card?.dataset.id;
  if (!id) return;
  const snapshot = state.snapshots.get(id);
  if (!snapshot) {
    if (action === 'delete') await removeSnapshot(id);
    else toast('快照数据尚未加载完成', 'info');
    return;
  }
  ensureSelection(snapshot);

  switch (action) {
    case 'toggle': {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      rerenderCard(id);
      break;
    }
    case 'restore-all':
      await restoreSnapshot(id);
      break;
    case 'restore-selected': {
      const selected = state.selection.get(id) || new Set();
      await restoreSnapshot(id, { selectedTabKeys: selected });
      break;
    }
    case 'restore-group': {
      const windowKey = button.dataset.window;
      const groupKey = button.dataset.group || '';
      const keys = restorableKeysOf(
        snapshot.windows.find((win) => win.key === windowKey) || { key: windowKey },
        groupTabsOf(snapshot, windowKey, groupKey),
      );
      if (!keys.length) {
        toast('这个分组里没有可恢复的标签页', 'info');
        break;
      }
      await restoreSnapshot(id, { selectedTabKeys: keys });
      break;
    }
    case 'select-all':
      state.selection.set(id, allRestorableTabKeys(snapshot));
      updateSelectionUI(id);
      break;
    case 'select-none':
      state.selection.set(id, new Set());
      updateSelectionUI(id);
      break;
    case 'copy-selected': {
      const selected = state.selection.get(id) || new Set();
      const text = renderURLList(snapshot, { selectedTabKeys: selected });
      if (!text) {
        toast('所选标签没有可复制的网址', 'info');
        break;
      }
      if (await copyText(text)) toast(`已复制 ${selected.size} 个链接`, 'success');
      else toast('复制失败，请检查剪贴板权限', 'error');
      break;
    }
    case 'export-json':
      await exportSnapshotJson(snapshot);
      break;
    case 'export-html':
      await exportSnapshotHtml(snapshot);
      break;
    case 'dedupe':
      await dedupeSnapshotAction(snapshot);
      break;
    case 'toggle-group': {
      const block = button.closest('.group-block');
      if (block) toggleGroupBlock(button.closest('.snap-card'), block);
      break;
    }
    case 'collapse-groups':
      setAllGroupsCollapsed(snapshot, true);
      break;
    case 'expand-groups':
      setAllGroupsCollapsed(snapshot, false);
      break;
    case 'rename':
      await renameSnapshot(snapshot);
      break;
    case 'delete':
      await removeSnapshot(id);
      break;
    default:
      break;
  }
}

async function onListChange(event) {
  const target = event.target;

  if (target.matches('[data-target-select]')) {
    state.settings.restoreTarget = target.value === 'current' ? 'current' : 'new';
    try {
      state.settings = await saveSettings({ restoreTarget: state.settings.restoreTarget });
    } catch {
      /* keep the selection for this session */
    }
    return;
  }

  const card = target.closest('.snap-card');
  const id = card?.dataset.id;
  if (!id) return;
  const snapshot = state.snapshots.get(id);
  if (!snapshot) return;
  const selected = state.selection.get(id) || new Set();

  if (target.matches('[data-tab-check]')) {
    const key = target.dataset.tabCheck;
    if (target.checked) selected.add(key);
    else selected.delete(key);
    state.selection.set(id, selected);
    updateSelectionUI(id);
    return;
  }

  if (target.matches('[data-group-check]')) {
    const [windowKey, groupKey = ''] = target.dataset.groupCheck.split(':');
    const keys = restorableKeysOf(
      snapshot.windows.find((win) => win.key === windowKey) || { key: windowKey },
      groupTabsOf(snapshot, windowKey, groupKey),
    );
    for (const key of keys) {
      if (target.checked) selected.add(key);
      else selected.delete(key);
    }
    state.selection.set(id, selected);
    updateSelectionUI(id);
    return;
  }

  if (target.matches('[data-window-check]')) {
    const win = snapshot.windows.find((item) => item.key === target.dataset.windowCheck);
    if (!win) return;
    for (const key of restorableKeysOf(win, win.tabs || [])) {
      if (target.checked) selected.add(key);
      else selected.delete(key);
    }
    state.selection.set(id, selected);
    updateSelectionUI(id);
  }
}

/* ------------------------------------------------------------------ */
/* restore                                                             */
/* ------------------------------------------------------------------ */

function restoreTargetFor(id) {
  const select = document.querySelector(`.snap-card[data-id="${id}"] [data-target-select]`);
  return select?.value || state.settings.restoreTarget;
}

async function restoreSnapshot(id, { selectedTabKeys = null, mode = null } = {}) {
  if (state.restoring || state.busy) {
    toast('正在处理另一个操作，请稍候', 'info');
    return null;
  }
  let snapshot = state.snapshots.get(id);
  if (!snapshot) {
    snapshot = await getSnapshot(id);
    if (snapshot) putSnapshot(snapshot);
  }
  if (!snapshot) {
    toast('快照数据不存在', 'error');
    return null;
  }

  ensureSelection(snapshot);
  const selection = selectedTabKeys ? new Set(selectedTabKeys) : state.selection.get(id) || new Set();
  const target = mode || restoreTargetFor(id);
  if (target === 'current' && !state.ownWindowId) {
    state.ownWindowId = (await chrome.windows.getCurrent())?.id ?? null;
  }

  const plan = buildRestorePlan(snapshot, { mode: target, selectedTabKeys: selection });
  if (!plan.totals.tabs) {
    toast('没有可恢复的标签页（浏览器内部页无法重新打开）', 'info');
    return null;
  }

  if (plan.totals.tabs >= 40) {
    const ok = await confirmDialog({
      title: '恢复较大量标签？',
      messageHtml:
        `即将${target === 'current' ? '并入当前窗口' : '打开新窗口并'}恢复 <b>${plan.totals.tabs}</b> 个标签、` +
        `<b>${plan.totals.groups}</b> 个分组。` +
        (plan.totals.skipped ? `<br><br>${plan.totals.skipped} 个浏览器内部页会被跳过。` : ''),
      confirmText: `恢复 ${plan.totals.tabs} 个标签`,
    });
    if (!ok) return null;
  }

  state.restoring = true;
  const progress = showProgress('正在恢复标签页');
  try {
    const result = await engine.restore(snapshot, {
      mode: target,
      targetWindowId: state.ownWindowId,
      selectedTabKeys: selection,
      onProgress: (payload) => progress.update(payload),
    });
    progress.close();
    toast(`已恢复 ${result.created} 个标签、${result.groups} 个分组`, 'success');
    if (result.skipped.length || result.errors.length) showRestoreIssues(result);
    refreshLive();
    return result;
  } catch (error) {
    progress.close();
    console.error('TBAS: restore failed', error);
    toast(`恢复失败：${error.message}`, 'error');
    return null;
  } finally {
    state.restoring = false;
  }
}

function showProgress(title) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal progress-modal">
    <div class="spinner" aria-hidden="true"></div>
    <h2>${escapeHtml(title)}</h2>
    <p class="progress-text">准备中…</p>
    <div class="bar"><span class="bar-fill"></span></div>
    <p class="progress-sub">请保持此页面打开</p>
  </div></div>`;
  const text = $('.progress-text', root);
  const fill = $('.bar-fill', root);
  return {
    update(payload = {}) {
      const total = payload.total || 0;
      const done = payload.done || 0;
      const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
      const phase =
        payload.phase === 'tabs'
          ? '正在打开标签页'
          : payload.phase === 'groups'
            ? '正在重建分组'
            : payload.phase === 'preparing'
              ? '准备中'
              : '即将完成';
      text.textContent = total ? `${phase} · ${done} / ${total}` : phase;
      fill.style.width = `${percent}%`;
    },
    close() {
      root.innerHTML = '';
    },
  };
}

function showRestoreIssues(result) {
  const skipped = result.skipped || [];
  const errors = result.errors || [];
  const skippedHtml = skipped.length
    ? `<div class="callout">${skipped.length} 个浏览器内部页无法由扩展重新打开。它们仍保存在快照中，可以复制网址后手动处理。</div>` +
      `<div class="issue-list">${skipped
        .map(
          (item) =>
            `<div class="issue-item"><span class="issue-dot"></span><div><strong>${escapeHtml(item.title || '未命名标签')}</strong><code>${escapeHtml(item.url || '')}</code></div></div>`,
        )
        .join('')}</div>`
    : '';
  const errorsHtml = errors.length
    ? `<p><b>${errors.length} 个标签或分组没有创建成功：</b></p>` +
      `<div class="issue-list">${errors
        .map(
          (item) =>
            `<div class="issue-item"><span class="issue-dot"></span><div><strong>${escapeHtml(item.title || item.scope || '创建失败')}</strong><code>${escapeHtml(item.message || '')}${item.url ? ` · ${escapeHtml(item.url)}` : ''}</code></div></div>`,
        )
        .join('')}</div>`
    : '';

  const urls = [
    ...skipped.map((item) => item.url),
    ...errors.map((item) => item.url),
  ].filter(Boolean);

  openModal({
    title: '恢复完成，有部分内容未恢复',
    subtitle: '其余标签和分组已恢复正常。',
    body: `${skippedHtml}${errorsHtml}`,
    footer: `<button class="btn" id="copy-issues" type="button">复制未恢复链接</button><button class="btn primary" data-close type="button">知道了</button>`,
    onMount(modal, close) {
      $('#copy-issues', modal)?.addEventListener('click', async () => {
        if (!urls.length) {
          toast('没有可复制的链接', 'info');
          return;
        }
        if (await copyText(urls.join('\n'))) toast('链接已复制', 'success');
        else toast('复制失败', 'error');
        close();
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/* snapshot actions                                                    */
/* ------------------------------------------------------------------ */

async function dedupeSnapshotAction(snapshot) {
  const { snapshot: cleaned, removed } = dedupeSnapshot(snapshot, { scope: 'window' });
  if (!removed.length) {
    toast('没有发现重复标签', 'info');
    return;
  }
  const ok = await confirmDialog({
    title: '移除重复标签？',
    messageHtml:
      `发现 <b>${removed.length}</b> 个重复网址（忽略 utm 等跟踪参数）。` +
      `<br><br>每个重复项只保留第一个，固定/当前状态会合并到保留项。` +
      `<br><br><span class="muted">去重会修改这个快照，不影响浏览器里当前打开的标签。</span>`,
    confirmText: `移除 ${removed.length} 个`,
  });
  if (!ok) return;

  await saveSnapshot(cleaned);
  putSnapshot(cleaned);
  state.selection.delete(cleaned.id);
  for (const key of [...state.groupCollapse.keys()]) {
    if (key.startsWith(`${cleaned.id}|`)) state.groupCollapse.delete(key);
  }
  ensureSelection(cleaned);
  await refreshIndex({ render: false });
  renderAll();
  toast(`已移除 ${removed.length} 个重复标签`, 'success');
}

async function renameSnapshot(snapshot) {
  openModal({
    title: '重命名快照',
    subtitle: '只修改显示名称，不影响保存的标签页。',
    body: `<input id="rename-input" class="text-input" maxlength="120" value="${escapeHtml(snapshot.name)}" placeholder="快照名称">`,
    footer: `<button class="btn" data-close type="button">取消</button><button class="btn primary" id="rename-save" type="button">保存</button>`,
    onMount(modal, close) {
      const input = $('#rename-input', modal);
      input.focus();
      input.select();
      const submit = async () => {
        const name = input.value.trim();
        if (!name) {
          toast('名称不能为空', 'error');
          return;
        }
        const updated = { ...snapshot, name };
        await saveSnapshot(updated);
        putSnapshot(updated);
        await refreshIndex({ render: false });
        renderAll();
        close();
        toast('已重命名', 'success');
      };
      $('#rename-save', modal).addEventListener('click', submit);
      input.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') submit();
      });
    },
  });
}

async function removeSnapshot(id) {
  const snapshot = state.snapshots.get(id);
  const entry = state.index.find((item) => item.id === id);
  const name = snapshot?.name || entry?.name || id;
  const ok = await confirmDialog({
    title: '删除快照？',
    messageHtml: `将删除 <b>${escapeHtml(name)}</b>。删除后无法从本机恢复（已导出的 JSON 文件不受影响）。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  await deleteSnapshot(id);
  state.snapshots.delete(id);
  state.expanded.delete(id);
  state.selection.delete(id);
  state.textCache.delete(id);
  await refreshIndex({ render: false });
  renderAll();
  toast('快照已删除', 'success');
}

/* ------------------------------------------------------------------ */
/* export / import                                                     */
/* ------------------------------------------------------------------ */

function fileStamp(iso) {
  const date = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

function snapshotFileName(snapshot) {
  return `tbas-snapshots/${snapshot.env}/${fileStamp(snapshot.createdAt)}-${safeFileName(snapshot.name)}.json`;
}

async function downloadText(filename, text, mime = 'application/json') {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    try {
      await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    return true;
  } catch (error) {
    console.error('TBAS: download failed', error);
    toast(`下载失败：${error.message}`, 'error');
    return false;
  }
}

async function autoBackupSnapshot(snapshot) {
  const ok = await downloadText(snapshotFileName(snapshot), JSON.stringify(snapshot, null, 2));
  if (ok) toast('已自动备份到下载文件夹', 'info');
}

async function exportSnapshotJson(snapshot) {
  const ok = await downloadText(snapshotFileName(snapshot), JSON.stringify(snapshot, null, 2));
  if (ok) toast('已导出 JSON 快照', 'success');
}

async function exportSnapshotHtml(snapshot) {
  const html = renderHTMLReport([snapshot], { title: `TBAS · ${snapshot.name}` });
  const filename = `tbas-snapshots/${snapshot.env}/${fileStamp(snapshot.createdAt)}-${safeFileName(snapshot.name)}.html`;
  const ok = await downloadText(filename, html, 'text/html;charset=utf-8');
  if (ok) toast('已导出 HTML 报告', 'success');
}

async function exportAll() {
  const snapshots = await exportBundle();
  if (!snapshots.length) {
    toast('还没有快照可导出', 'info');
    return;
  }
  const bundle = buildBundle(snapshots);
  const ok = await downloadText(
    `tbas-snapshots/tbas-bundle-${fileStamp(new Date().toISOString())}.json`,
    JSON.stringify(bundle, null, 2),
  );
  if (ok) toast(`已导出 ${snapshots.length} 个快照`, 'success');
}

async function importTexts(items) {
  const snapshots = [];
  const errors = [];
  for (const item of items) {
    const parsed = parseSnapshotText(item.text, { filename: item.filename });
    snapshots.push(...parsed.snapshots);
    errors.push(...parsed.errors);
  }
  if (!snapshots.length) {
    toast('没有可导入的快照', 'error');
    if (errors.length) showImportErrors(errors);
    return;
  }

  const existing = new Set(state.index.map((entry) => entry.id));
  const prepared = snapshots.map((snapshot) => {
    if (existing.has(snapshot.id)) {
      const id = freshSnapshotId(existing);
      existing.add(id);
      return { ...snapshot, id, name: `${snapshot.name}（导入）` };
    }
    existing.add(snapshot.id);
    return snapshot;
  });

  try {
    await saveSnapshots(prepared);
  } catch (error) {
    toast(`导入失败：${error.message}`, 'error');
    return;
  }
  await refreshIndex({ render: false });
  await preloadSnapshots();
  renderAll();
  toast(`已导入 ${prepared.length} 个快照`, 'success');
  if (errors.length) showImportErrors(errors);
}

function showImportErrors(errors) {
  openModal({
    title: '部分内容未能导入',
    subtitle: '格式不正确或版本不兼容的文件已跳过。',
    body: `<div class="issue-list">${errors
      .map(
        (error) =>
          `<div class="issue-item"><span class="issue-dot"></span><div><strong>导入失败</strong><code>${escapeHtml(error)}</code></div></div>`,
      )
      .join('')}</div>`,
    footer: `<button class="btn primary" data-close type="button">知道了</button>`,
  });
}

async function loadDemo() {
  try {
    const response = await fetch(chrome.runtime.getURL('demo.json'));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    await importTexts([{ filename: 'demo.json', text }]);
  } catch (error) {
    toast(`示例载入失败：${error.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

function envRowHtml(env) {
  return `<div class="env-row" data-env-row data-env-id="${escapeHtml(env.id || '')}">
    <input class="env-color" type="color" value="${escapeHtml(env.color || '#4c6fff')}" aria-label="环境颜色">
    <input class="env-name" maxlength="24" value="${escapeHtml(env.label || '')}" placeholder="环境名称">
    <code class="env-id">${escapeHtml(env.id || '新环境')}</code>
    <button class="env-remove" type="button" data-remove-env title="移除环境">✕</button>
  </div>`;
}

async function openSettings() {
  if (state.restoring) return;
  const settings = await getSettings();
  const bytes = await storageBytes();
  const palette = ['#4c6fff', '#18a957', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'];

  const body = `<div class="settings-section">
    <h3>环境</h3>
    <p class="muted">用环境区分办公、个人或其他场景。快照会带上环境标签，列表顶部可按环境筛选。</p>
    <div id="env-rows">${settings.envs.map(envRowHtml).join('')}</div>
    <div class="env-add">
      <input id="new-env-label" maxlength="24" placeholder="新环境名称，例如：客户现场">
      <button class="btn small" id="add-env-btn" type="button">添加环境</button>
    </div>
  </div>
  <div class="settings-section">
    <h3>行为</h3>
    <label class="setting-row">
      <span><strong>保存时自动去重</strong><small>同一窗口内相同网址只保留一个；固定/当前状态会合并到保留项。</small></span>
      <input type="checkbox" id="set-dedupe"${settings.dedupeOnCapture ? ' checked' : ''}>
    </label>
    <label class="setting-row">
      <span><strong>自动备份到下载文件夹</strong><small>每次保存额外写入 Downloads/tbas-snapshots/，可用 CLI 离线查看。会产生文件。</small></span>
      <input type="checkbox" id="set-auto-backup"${settings.autoBackup ? ' checked' : ''}>
    </label>
    <label class="setting-row">
      <span><strong>默认恢复目标</strong><small>恢复时默认打开新窗口，还是合并进当前窗口。</small></span>
      <select id="set-target">
        <option value="new"${settings.restoreTarget === 'new' ? ' selected' : ''}>新窗口</option>
        <option value="current"${settings.restoreTarget === 'current' ? ' selected' : ''}>当前窗口</option>
      </select>
    </label>
  </div>
  <div class="settings-section">
    <h3>数据</h3>
    <p class="muted">${state.index.length} 个快照，扩展存储占用约 ${formatBytes(bytes)}。所有数据只保存在本机浏览器中。</p>
    <div class="settings-actions">
      <button class="btn small" id="set-export" type="button">导出全部</button>
      <button class="btn small" id="set-import" type="button">导入 JSON</button>
      <button class="btn small danger" id="set-clear" type="button">清空所有快照</button>
    </div>
  </div>
  <div class="settings-section">
    <h3>关于</h3>
    <p class="muted">TBAS v${escapeHtml(VERSION)} · 只使用浏览器提供的标签页和分组元数据，不读取网页内容，没有任何网络上传。</p>
    <p class="muted">离线报告：<code>node bin/tbas.mjs report --open</code> · 命令帮助：<code>node bin/tbas.mjs help</code></p>
  </div>`;

  openModal({
    title: '设置',
    subtitle: '环境、备份与数据管理',
    width: '720px',
    body,
    footer: `<button class="btn" data-close type="button">取消</button><button class="btn primary" id="save-settings" type="button">保存设置</button>`,
    onMount(modal, close) {
      const rows = $('#env-rows', modal);
      const addButton = $('#add-env-btn', modal);
      const labelInput = $('#new-env-label', modal);

      const addEnv = () => {
        const label = labelInput.value.trim();
        const color = palette[rows.querySelectorAll('[data-env-row]').length % palette.length];
        rows.insertAdjacentHTML(
          'beforeend',
          envRowHtml({ id: '', label: label || '', color }),
        );
        labelInput.value = '';
        rows.lastElementChild.querySelector('.env-name').focus();
      };

      addButton.addEventListener('click', addEnv);
      labelInput.addEventListener('keydown', (event) => {
        if (event.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          addEnv();
        }
      });
      rows.addEventListener('click', (event) => {
        const remove = event.target.closest('[data-remove-env]');
        if (!remove) return;
        remove.closest('[data-env-row]').remove();
      });

      $('#save-settings', modal).addEventListener('click', async () => {
        const envRows = [...rows.querySelectorAll('[data-env-row]')];
        if (!envRows.length) {
          toast('至少保留一个环境', 'error');
          return;
        }
        const envs = envRows.map((row, index) => {
          const id = row.dataset.envId || `custom-${Date.now().toString(36)}-${index}`;
          return {
            id,
            label: row.querySelector('.env-name').value.trim() || `环境 ${index + 1}`,
            color: row.querySelector('.env-color').value,
          };
        });
        const saved = await saveSettings({
          envs,
          env: envs.some((env) => env.id === state.currentEnv) ? state.currentEnv : envs[0].id,
          dedupeOnCapture: $('#set-dedupe', modal).checked,
          autoBackup: $('#set-auto-backup', modal).checked,
          restoreTarget: $('#set-target', modal).value === 'current' ? 'current' : 'new',
        });
        state.settings = saved;
        state.envs = saved.envs;
        state.currentEnv = saved.env;
        $('#dedupe-toggle').checked = saved.dedupeOnCapture;
        close();
        renderAll();
        toast('设置已保存', 'success');
      });

      $('#set-export', modal).addEventListener('click', () => exportAll());
      $('#set-import', modal).addEventListener('click', () => {
        close();
        $('#file-input').click();
      });
      $('#set-clear', modal).addEventListener('click', async () => {
        close();
        const ok = await confirmDialog({
          title: '清空所有快照？',
          messageHtml:
            '这会删除扩展存储中的全部快照，且无法撤销。已导出到下载文件夹的 JSON 不受影响。',
          confirmText: '全部删除',
          danger: true,
        });
        if (!ok) return;
        await clearAll();
        state.snapshots.clear();
        state.selection.clear();
        state.expanded.clear();
        state.textCache.clear();
        state.matchCache.clear();
        state.groupCollapse.clear();
        await refreshIndex({ render: false });
        renderAll();
        toast('已清空所有快照', 'success');
      });
    },
  });
}

/* ------------------------------------------------------------------ */
/* modals, toasts and small helpers                                    */
/* ------------------------------------------------------------------ */

function openModal({ title, subtitle = '', body = '', footer = '', width = '560px', onMount, onClose }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="overlay"><div class="modal" role="dialog" aria-modal="true" style="max-width:${width}">
    <div class="modal-head">
      <div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>
      <button class="close-x" type="button" data-close aria-label="关闭">✕</button>
    </div>
    <div class="modal-body">${body}</div>
    ${footer ? `<div class="modal-foot">${footer}</div>` : ''}
  </div></div>`;

  const overlay = root.firstElementChild;
  const modal = overlay.querySelector('.modal');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
    onClose?.();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  modal.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', close));
  document.addEventListener('keydown', onKey);
  onMount?.(modal, close);
  return { modal, close };
}

function confirmDialog({ title, messageHtml, confirmText = '确认', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;
    openModal({
      title,
      body: `<p>${messageHtml}</p>`,
      footer: `<button class="btn" data-cancel type="button">${escapeHtml(cancelText)}</button><button class="btn ${danger ? 'danger' : 'primary'}" id="confirm-ok" type="button">${escapeHtml(confirmText)}</button>`,
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      },
      onMount(modal, close) {
        $('#confirm-ok', modal).addEventListener('click', () => {
          settled = true;
          close();
          resolve(true);
        });
        $('[data-cancel]', modal).addEventListener('click', () => {
          settled = true;
          close();
          resolve(false);
        });
      },
    });
  });
}

function toast(message, type = 'success') {
  const icons = { success: '✓', error: '!', info: 'i' };
  const root = $('#toast-root');
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<span class="toast-icon">${icons[type] || '✓'}</span><span>${escapeHtml(message)}</span>`;
  root.appendChild(element);
  setTimeout(() => {
    element.classList.add('leaving');
    setTimeout(() => element.remove(), 260);
  }, 3600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function updateFooter() {
  $('#storage-stat').textContent = `${state.index.length} 个快照`;
  try {
    const bytes = await storageBytes();
    $('#storage-stat').textContent = `${state.index.length} 个快照 · ${formatBytes(bytes)}`;
  } catch {
    /* bytes are cosmetic */
  }
}

function exposeDebugApi() {
  // Documented in README: used by tests and for troubleshooting in DevTools.
  window.tbas = {
    state,
    engine,
    capture: (options = {}) => doCapture(options),
    openCapturePicker,
    restore: (id, options = {}) => restoreSnapshot(id, options),
    importText: (text, filename = 'import.json') => importTexts([{ text, filename }]),
    refresh: async () => {
      await refreshIndex({ render: false });
      await preloadSnapshots();
      renderAll();
    },
    saveSnapshot,
    saveSettings,
    putSnapshot,
    renderAll,
  };
}

init().catch((error) => {
  console.error('TBAS: initialization failed', error);
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="overlay"><div class="modal"><div class="modal-body"><h2>TBAS 无法启动</h2><p>${escapeHtml(error.message || String(error))}</p><p class="muted">请在 Edge 的扩展页面重新加载扩展，或查看扩展的“错误”按钮。</p></div></div></div>`,
  );
});
