/**
 * TBAS browser engine.
 *
 * Thin, testable adapter over browser APIs. It receives the `chrome` namespace
 * (or a fake implementing the same subset) so the same code can be unit-tested
 * in Node and used by the extension dashboard.
 *
 * Required API surface:
 *   runtime.getURL / runtime.id / runtime.getManifest
 *   windows.getAll({populate, windowTypes}) / windows.create / windows.remove / windows.update
 *   tabs.query / tabs.create / tabs.remove / tabs.update / tabs.group
 *   tabGroups.query / tabGroups.update
 */

import {
  allRestorableTabKeys,
  buildRestorePlan,
  buildSnapshot,
  dedupeSnapshot,
  tabKeyOf,
  validateSnapshot,
} from './core.js';

function messageOf(error) {
  return String(error?.message || error || '未知错误');
}

function detectBrowser(userAgent) {
  if (/Edg\//.test(userAgent)) return 'Edge';
  if (/Chrome\//.test(userAgent)) return 'Chrome';
  if (/Chromium\//.test(userAgent)) return 'Chromium';
  return 'Chromium';
}

export function createEngine(api, options = {}) {
  const version = options.extensionVersion || '0.1.0';
  const userAgent = options.userAgent || (typeof navigator !== 'undefined' ? navigator.userAgent : '');

  function progress(callback, payload) {
    if (typeof callback !== 'function') return;
    try {
      callback(payload);
    } catch {
      /* a UI callback must never break a restore */
    }
  }

  /**
   * List normal, capturable windows. Incognito windows are excluded because an
   * extension cannot reliably read them (and should not persist them).
   */
  async function listWindows() {
    const windows = await api.windows.getAll({ populate: true, windowTypes: ['normal'] });
    return (windows || []).filter((win) => !win.incognito);
  }

  /**
   * Capture live tabs into a snapshot.
   *
   * @param {object} opts
   * @param {'all'|'current'} opts.scope
   * @param {number} [opts.windowId] required for scope=current
   * @param {number[]} opts.excludeTabIds tabs to skip (the dashboard itself)
   * @param {string[]} opts.excludeUrlPrefixes URL prefixes to skip
   * @param {string} opts.env
   * @param {string} opts.name
   * @param {boolean} opts.dedupe
   */
  async function capture(opts = {}) {
    const {
      scope = 'all',
      windowId = null,
      excludeTabIds = [],
      excludeUrlPrefixes = [],
      env = 'office',
      envLabel = '',
      name = '',
      tags = [],
      dedupe = false,
      notes = '',
    } = opts;

    const excludedTabs = new Set(excludeTabIds.filter((id) => Number.isFinite(id)));
    let windows = await listWindows();
    if (scope === 'current') {
      if (!Number.isFinite(windowId)) throw new Error('scope=current 但未提供 windowId');
      windows = windows.filter((win) => win.id === windowId);
    }

    const groups = await api.tabGroups.query({});
    const shaped = [];
    for (const win of windows) {
      const tabs = (win.tabs || [])
        .slice()
        .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0))
        .filter((tab) => !excludedTabs.has(tab.id))
        .filter((tab) => {
          const url = String(tab.url || '');
          return !excludeUrlPrefixes.some((prefix) => prefix && url.startsWith(prefix));
        })
        .map((tab) => ({
          id: tab.id,
          url: tab.url || tab.pendingUrl || '',
          title: tab.title || '',
          pinned: !!tab.pinned,
          active: !!tab.active,
          index: Number(tab.index) || 0,
          groupId: tab.groupId,
        }));
      if (!tabs.length) continue;
      shaped.push({
        id: win.id,
        focused: !!win.focused,
        incognito: !!win.incognito,
        tabs,
      });
    }

    if (!shaped.length) {
      throw new Error('没有可保存的标签页（当前窗口可能只有 TBAS 面板）');
    }

    // buildSnapshot puts the focused window first; sort here as well so the
    // live-tab map below can be zipped with the resulting snapshot windows.
    shaped.sort((a, b) => Number(b.focused) - Number(a.focused));

    let snapshot = buildSnapshot({
      windows: shaped,
      groups,
      meta: {
        name,
        env,
        envLabel,
        tags,
        notes,
        browser: detectBrowser(userAgent),
        userAgent,
        extensionVersion: version,
      },
    });

    // Map snapshot keys back to live tab ids for the capture picker. This is
    // only valid without dedupe (dedupe re-keys tabs); the picker always
    // captures without dedupe and applies it after filtering.
    let liveByKey = null;
    if (!dedupe) {
      liveByKey = {};
      snapshot.windows.forEach((win, windowIndex) => {
        const liveWindow = shaped[windowIndex];
        if (!liveWindow) return;
        win.tabs.forEach((tab, tabIndex) => {
          const liveTab = liveWindow.tabs[tabIndex];
          if (liveTab) liveByKey[`${win.key}.${tab.key}`] = liveTab.id;
        });
      });
    }

    if (dedupe) {
      snapshot = dedupeSnapshot(snapshot, { scope: 'window' }).snapshot;
    }
    return { snapshot, windows, liveByKey };
  }

  /**
   * Close all captured windows, keeping the dashboard tab alive when possible.
   * This is what frees memory after a snapshot has been persisted.
   */
  async function windowExists(windowId) {
    try {
      await api.windows.get(windowId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close one window without the dashboard.
   *
   * Some Chromium/Edge builds (notably headless Edge) resolve
   * windows.remove() but leave windows containing pinned tabs alive. Unpin
   * first, then verify, then fall back to closing the tabs themselves.
   */
  async function closeWindow(windowId, tabs) {
    const ids = tabs.map((tab) => tab.id);
    try {
      for (const tab of tabs) {
        if (tab.pinned) await api.tabs.update(tab.id, { pinned: false });
      }
      await api.windows.remove(windowId);
    } catch {
      /* fall through to the tab-level fallback */
    }

    if (!(await windowExists(windowId))) return { closed: ids.length };

    try {
      if (ids.length) await api.tabs.remove(ids);
      else await api.windows.remove(windowId);
    } catch (error) {
      return { closed: 0, error: messageOf(error) };
    }

    if (await windowExists(windowId)) {
      return { closed: 0, error: '窗口未能关闭（可能包含未提交的表单）' };
    }
    return { closed: ids.length };
  }

  async function closeCaptured(windows, { keepTabId = null } = {}) {
    const results = [];
    for (const win of windows || []) {
      let tabs = [];
      try {
        tabs = await api.tabs.query({ windowId: win.id });
      } catch (error) {
        results.push({ windowId: win.id, closed: 0, kept: false, error: messageOf(error) });
        continue;
      }
      const keepHere = Number.isFinite(keepTabId) && tabs.some((tab) => tab.id === keepTabId);
      if (keepHere) {
        const removeIds = tabs.filter((tab) => tab.id !== keepTabId).map((tab) => tab.id);
        let closed = 0;
        try {
          if (removeIds.length) {
            await api.tabs.remove(removeIds);
            closed = removeIds.length;
          }
          await api.tabs.update(keepTabId, { active: true });
        } catch (error) {
          results.push({ windowId: win.id, closed, kept: true, error: messageOf(error) });
          continue;
        }
        results.push({ windowId: win.id, closed, kept: true });
      } else {
        const outcome = await closeWindow(win.id, tabs);
        results.push({ windowId: win.id, kept: false, ...outcome });
      }
    }
    return {
      results,
      closed: results.reduce((sum, item) => sum + (item.closed || 0), 0),
      keptWindows: results.filter((item) => item.kept).length,
      errors: results.filter((item) => item.error),
    };
  }

  /**
   * Close a specific set of tabs, leaving every unselected tab open. Windows
   * that become empty are closed by Chromium automatically. Used by the
   * capture picker's "save and close selected" action.
   */
  async function closeTabs(tabIds, { keepTabId = null } = {}) {
    const ids = [...new Set((tabIds || []).filter((id) => Number.isFinite(id) && id !== keepTabId))];
    let closed = 0;
    const errors = [];
    for (const tabId of ids) {
      try {
        await api.tabs.remove(tabId);
        closed += 1;
      } catch (error) {
        errors.push({ tabId, message: messageOf(error) });
      }
    }
    return { closed, errors };
  }

  /**
   * Restore a snapshot (or a selection of it) into new windows, or into an
   * existing window. Groups are recreated with title/color/collapsed state.
   */
  async function restore(snapshot, opts = {}) {
    const {
      mode = 'new',
      targetWindowId = null,
      selectedTabKeys = null,
      includeUnrestorable = false,
      focus = true,
      onProgress = null,
    } = opts;

    const validated = validateSnapshot(snapshot);
    if (!validated.ok) throw new Error(`快照无效：${validated.errors.join('；')}`);
    const snap = validated.snapshot;

    if (mode === 'current' && !Number.isFinite(targetWindowId)) {
      throw new Error('恢复到当前窗口需要 targetWindowId');
    }

    const selection = selectedTabKeys ? new Set(selectedTabKeys) : allRestorableTabKeys(snap);
    const plan = buildRestorePlan(snap, { mode, selectedTabKeys: selection, includeUnrestorable });
    if (!plan.totals.tabs) {
      throw new Error('没有可恢复的标签页（内部页面无法由扩展重新打开）');
    }

    const total = plan.totals.tabs;
    let done = 0;
    let createdCount = 0;
    let groupCount = 0;
    const windowIds = [];
    const created = [];
    const errors = [];
    const skipped = plan.skipped.map((item) => ({
      windowKey: item.windowKey,
      title: item.tab.title,
      url: item.tab.url,
      reason: 'internal',
    }));

    const taskWindows =
      mode === 'current'
        ? [
            {
              sourceKey: 'current',
              focused: false,
              groups: plan.windows.flatMap((win) => win.groups),
              tabs: plan.windows.flatMap((win) => win.tabs),
            },
          ]
        : plan.windows;

    progress(onProgress, { phase: 'preparing', done: 0, total });
    const anyFocusedPlan = plan.windows.some((win) => win.focused);
    let focusAssigned = false;

    for (const task of taskWindows) {
      let windowId = mode === 'current' ? targetWindowId : null;
      let initialTabId = null;

      if (windowId === null) {
        try {
          const createdWindow = await api.windows.create({ focused: false });
          windowId = createdWindow.id;
          const initialTabs = createdWindow.tabs?.length
            ? createdWindow.tabs
            : await api.tabs.query({ windowId });
          initialTabId = initialTabs?.[0]?.id ?? null;
        } catch (error) {
          errors.push({ scope: 'window', message: messageOf(error) });
          continue;
        }
        windowIds.push(windowId);
      }

      const groupsByKey = new Map((task.groups || []).map((group) => [group.key, group]));
      const createdHere = [];

      for (const item of task.tabs) {
        const tab = item.tab;
        try {
          const newTab = await api.tabs.create({
            windowId,
            url: tab.url,
            pinned: !!tab.pinned,
            active: false,
          });
          const record = { id: newTab.id, groupKey: item.groupKey, source: tab };
          createdHere.push(record);
          created.push(record);
          createdCount += 1;
        } catch (error) {
          errors.push({
            scope: 'tab',
            title: tab.title,
            url: tab.url,
            message: messageOf(error),
          });
        }
        done += 1;
        progress(onProgress, { phase: 'tabs', done, total, windowId });
      }

      // Group contiguous runs. Chromium tab groups are always contiguous.
      let index = 0;
      while (index < createdHere.length) {
        const groupKey = createdHere[index].groupKey;
        if (!groupKey) {
          index += 1;
          continue;
        }
        let end = index;
        while (end + 1 < createdHere.length && createdHere[end + 1].groupKey === groupKey) end += 1;
        const tabIds = createdHere.slice(index, end + 1).map((item) => item.id);
        const group = groupsByKey.get(groupKey);
        try {
          const groupId = await api.tabs.group({ tabIds, createProperties: { windowId } });
          if (group) {
            await api.tabGroups.update(groupId, {
              title: group.title || '',
              color: group.color || 'grey',
              collapsed: !!group.collapsed,
            });
          }
          groupCount += 1;
        } catch (error) {
          errors.push({
            scope: 'group',
            title: group?.title || '',
            message: messageOf(error),
          });
        }
        index = end + 1;
        progress(onProgress, { phase: 'groups', done, total, windowId });
      }

      if (initialTabId !== null) {
        if (createdHere.length) {
          try {
            await api.tabs.remove(initialTabId);
          } catch {
            /* the blank tab may already be gone */
          }
        } else if (mode !== 'current') {
          try {
            await api.windows.remove(windowId);
            const pos = windowIds.indexOf(windowId);
            if (pos !== -1) windowIds.splice(pos, 1);
          } catch {
            /* ignore */
          }
        }
      }

      if (createdHere.length) {
        const active = createdHere.find((item) => item.source.active) || createdHere[0];
        try {
          await api.tabs.update(active.id, { active: true });
        } catch {
          /* ignore */
        }
        if (mode === 'new' && focus && (task.focused || (!anyFocusedPlan && !focusAssigned))) {
          focusAssigned = true;
          try {
            await api.windows.update(windowId, { focused: true });
          } catch {
            /* ignore */
          }
        }
      }
    }

    progress(onProgress, { phase: 'done', done: total, total });

    return {
      mode,
      windowIds,
      created: createdCount,
      groups: groupCount,
      total,
      skipped,
      errors,
      plan,
    };
  }

  return { capture, closeCaptured, closeTabs, restore, listWindows };
}

// Re-export small helpers so the dashboard can import everything from engine.
export { allRestorableTabKeys, tabKeyOf };
