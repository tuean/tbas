/**
 * TBAS service worker.
 *
 * The toolbar button (and Alt+Shift+T) opens/focuses the dashboard. There is
 * no content script and no host permission: TBAS can only see tab metadata
 * that the browser exposes through the tabs/tabGroups APIs.
 */

const DASHBOARD_URL = chrome.runtime.getURL('dashboard.html');

async function openDashboard() {
  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((tab) => {
      const url = typeof tab.url === 'string' ? tab.url.split('#')[0].split('?')[0] : '';
      return url === DASHBOARD_URL;
    });

    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      if (Number.isFinite(existing.windowId)) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    }

    await chrome.tabs.create({ url: DASHBOARD_URL });
  } catch (error) {
    // A toolbar click must never take the service worker down.
    console.error('TBAS: unable to open dashboard', error);
  }
}

chrome.action.onClicked.addListener(() => {
  openDashboard();
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'open-dashboard') openDashboard();
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') openDashboard();
});
