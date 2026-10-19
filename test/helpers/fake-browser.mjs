/**
 * In-memory fake of the small chrome.* surface used by lib/engine.js.
 * Behaviourally close enough to Chromium for unit tests:
 *  - tabs keep an index inside their window
 *  - closing the last tab closes the window
 *  - creating a window creates one initial new-tab
 *  - tabs.group creates a new group and assigns membership
 */

export function createFakeBrowser({ windows = [], groups = [] } = {}) {
  let nextTabId = 10000;
  let nextWindowId = 500;
  let nextGroupId = 900;

  const state = {
    windows: windows.map((win) => ({
      id: win.id,
      focused: !!win.focused,
      incognito: !!win.incognito,
      tabs: (win.tabs || []).map((tab, index) => ({ ...tab, windowId: win.id, index })),
    })),
    groups: groups.map((group) => ({ ...group })),
  };

  const allTabs = () => state.windows.flatMap((win) => win.tabs);

  function getWindow(windowId) {
    const win = state.windows.find((item) => item.id === windowId);
    if (!win) throw new Error(`No window with id: ${windowId}`);
    return win;
  }

  function getTab(tabId) {
    const tab = allTabs().find((item) => item.id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}`);
    return tab;
  }

  function reindex(win) {
    win.tabs.forEach((tab, index) => {
      tab.index = index;
      tab.windowId = win.id;
    });
  }

  function removeEmptyWindow(win) {
    if (win.tabs.length) return;
    state.windows = state.windows.filter((item) => item.id !== win.id);
  }

  function addTab(windowId, { url = '', title = '', pinned = false, active = false, groupId = -1 } = {}) {
    const win = getWindow(windowId);
    if (active) for (const tab of win.tabs) tab.active = false;
    const tab = {
      id: nextTabId++,
      windowId,
      url,
      title: title || url,
      pinned: !!pinned,
      active: !!active,
      index: win.tabs.length,
      groupId,
    };
    win.tabs.push(tab);
    reindex(win);
    return { ...tab };
  }

  const api = {
    runtime: {
      id: 'testext',
      getURL(path = '') {
        return `chrome-extension://testext/${path}`;
      },
      getManifest() {
        return { version: '0.1.0' };
      },
    },
    windows: {
      async getAll() {
        return state.windows.map((win) => ({
          id: win.id,
          focused: win.focused,
          incognito: win.incognito,
          tabs: win.tabs.map((tab) => ({ ...tab })),
        }));
      },
      async get(windowId) {
        const win = getWindow(windowId);
        return { id: win.id, focused: win.focused, tabs: win.tabs.map((tab) => ({ ...tab })) };
      },
      async create({ focused = true, url = null } = {}) {
        const win = { id: nextWindowId++, focused: !!focused, incognito: false, tabs: [] };
        if (focused) for (const item of state.windows) item.focused = false;
        state.windows.push(win);
        addTab(win.id, { url: url || 'edge://newtab/', active: true });
        return { id: win.id, focused: win.focused, tabs: win.tabs.map((tab) => ({ ...tab })) };
      },
      async remove(windowId) {
        getWindow(windowId);
        state.windows = state.windows.filter((item) => item.id !== windowId);
      },
      async update(windowId, { focused } = {}) {
        const win = getWindow(windowId);
        if (focused === true) {
          for (const item of state.windows) item.focused = false;
          win.focused = true;
        } else if (focused === false) {
          win.focused = false;
        }
        return { id: win.id, focused: win.focused };
      },
    },
    tabs: {
      async query(filter = {}) {
        return allTabs()
          .filter((tab) => filter.windowId === undefined || tab.windowId === filter.windowId)
          .sort((a, b) => a.windowId - b.windowId || a.index - b.index)
          .map((tab) => ({ ...tab }));
      },
      async get(tabId) {
        return { ...getTab(tabId) };
      },
      async create({ windowId, url = '', pinned = false, active = false }) {
        if (typeof url === 'string' && /^(edge|chrome|javascript|data|blob|about):/i.test(url)) {
          throw new Error(`Cannot create tab with URL: ${url}`);
        }
        return addTab(windowId, { url, pinned, active, title: url });
      },
      async remove(tabIds) {
        const ids = new Set(Array.isArray(tabIds) ? tabIds : [tabIds]);
        const known = new Set(allTabs().map((tab) => tab.id));
        for (const id of ids) {
          if (!known.has(id)) throw new Error(`No tab with id: ${id}`);
        }
        for (const win of state.windows) {
          const removed = win.tabs.filter((tab) => ids.has(tab.id));
          if (!removed.length) continue;
          win.tabs = win.tabs.filter((tab) => !ids.has(tab.id));
          reindex(win);
          removeEmptyWindow(win);
        }
      },
      async update(tabId, { active, pinned } = {}) {
        const tab = getTab(tabId);
        if (active !== undefined) {
          const win = getWindow(tab.windowId);
          for (const item of win.tabs) item.active = item.id === tabId;
        }
        if (pinned !== undefined) tab.pinned = !!pinned;
        return { ...tab };
      },
      async group({ tabIds, createProperties = {} }) {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        if (!ids.length) throw new Error('tabs.group: no tabIds');
        const first = getTab(ids[0]);
        const windowId = createProperties.windowId ?? first.windowId;
        for (const id of ids) {
          if (getTab(id).windowId !== windowId) throw new Error('tabs.group: tabs from different windows');
        }
        const group = {
          id: nextGroupId++,
          windowId,
          title: '',
          color: 'grey',
          collapsed: false,
        };
        state.groups.push(group);
        for (const id of ids) getTab(id).groupId = group.id;
        return group.id;
      },
    },
    tabGroups: {
      async query(filter = {}) {
        return state.groups
          .filter((group) => filter.windowId === undefined || group.windowId === filter.windowId)
          .map((group) => ({ ...group }));
      },
      async update(groupId, patch = {}) {
        const group = state.groups.find((item) => item.id === groupId);
        if (!group) throw new Error(`No group with id: ${groupId}`);
        Object.assign(group, patch);
        return { ...group };
      },
    },
  };

  return { api, state };
}
