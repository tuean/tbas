/**
 * Real end-to-end test for the TBAS Edge extension.
 *
 * Launches a throwaway headless Edge profile, loads the unpacked extension,
 * creates real tabs and tab groups on a local HTTP server, then exercises:
 *   1. UI capture (button click) with groups, pinned + internal tab
 *   2. group-aware restore through the UI
 *   3. "save and close" archiving, while keeping the dashboard alive
 *
 * Run: npm run test:e2e
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const extensionDir = join(root, 'extension');

const EDGE_CANDIDATES = [
  process.env.TBAS_EDGE_BINARY,
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
].filter(Boolean);
const edgePath = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));

if (!edgePath) {
  console.log('SKIP: Microsoft Edge not found. Set TBAS_EDGE_BINARY to run this test.');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function freePort() {
  const server = createNetServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: resolvePending, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolvePending(message.result);
      } else if (message.method) {
        this.events.push(message);
      }
    };
    await new Promise((resolveOpen, reject) => {
      this.ws.onopen = resolveOpen;
      this.ws.onerror = () => reject(new Error(`WebSocket failed: ${this.url}`));
    });
  }

  send(method, params = {}) {
    return new Promise((resolveSend, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: resolveSend, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails);
      throw new Error(`Page evaluation failed: ${description}`);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tbas-e2e-'));
  const port = await freePort();
  const httpServer = createServer((request, response) => {
    const name = (request.url || '/').replace(/^\//, '') || 'home';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TBAS E2E ${name}</title></head><body><h1>${name}</h1></body></html>`);
  });
  await new Promise((resolveListen) => httpServer.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${httpServer.address().port}`;

  let edgeLog = '';
  const edge = spawn(
    edgePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,1000',
      `--user-data-dir=${profile}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--remote-debugging-port=${port}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  edge.stdout.on('data', (chunk) => {
    edgeLog += chunk;
  });
  edge.stderr.on('data', (chunk) => {
    edgeLog += chunk;
  });

  let page = null;
  try {
    let dashboard = null;
    let extId = null;
    for (let attempt = 0; attempt < 160 && !dashboard; attempt += 1) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        dashboard = targets.find((target) => target.type === 'page' && target.url.includes('/dashboard.html'));
        if (!dashboard) {
          const worker = targets.find(
            (target) => target.type === 'service_worker' && target.url.includes('chrome-extension://') && target.url.endsWith('/background.js'),
          );
          if (worker) extId = new URL(worker.url).host;
        }
      } catch {
        /* browser still starting */
      }
      if (!dashboard) await sleep(250);
    }

    if (dashboard) extId = new URL(dashboard.url).host;
    if (!extId) throw new Error(`extension did not load.\n${edgeLog.slice(-4000)}`);

    if (!dashboard) {
      dashboard = await (
        await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`chrome-extension://${extId}/dashboard.html`)}`, {
          method: 'PUT',
        })
      ).json();
    }

    console.log(`• Edge ${edgePath}`);
    console.log(`• extension ${extId}`);
    page = new CDP(dashboard.webSocketDebuggerUrl);
    await page.connect();
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

    const waitFor = async (expression, label, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      let lastError = '';
      while (Date.now() < deadline) {
        try {
          const value = await page.evaluate(expression);
          if (value) return value;
          lastError = `got ${JSON.stringify(value)}`;
        } catch (error) {
          lastError = error.message;
        }
        await sleep(200);
      }
      throw new Error(`Timed out waiting for ${label || expression} (${lastError})`);
    };

    await waitFor('Boolean(window.tbas)', 'dashboard boot');

    // Clean slate: remove old snapshots and all windows/tabs except this dashboard.
    const self = await page.evaluate(`(async () => {
      const stored = await chrome.storage.local.get(null);
      const keys = Object.keys(stored).filter((key) => key === 'tbas.index.v1' || key.startsWith('tbas.snapshot.'));
      if (keys.length) await chrome.storage.local.remove(keys);
      const me = await chrome.tabs.getCurrent();
      const windows = await chrome.windows.getAll({ populate: true });
      for (const window of windows) {
        if (window.id !== me.windowId) {
          try { await chrome.windows.remove(window.id); } catch {}
        }
      }
      const tabs = await chrome.tabs.query({ windowId: me.windowId });
      for (const tab of tabs) {
        if (tab.id !== me.id) {
          try { await chrome.tabs.remove(tab.id); } catch {}
        }
      }
      await window.tbas.refresh();
      return { tabId: me.id, windowId: me.windowId };
    })()`);
    assert.ok(self?.tabId, 'dashboard tab id');

    // Build a real window with groups, a pinned tab and one internal page.
    const fixture = await page.evaluate(`(async () => {
      const waitUrl = async (id, prefix) => {
        for (let i = 0; i < 80; i += 1) {
          const tab = await chrome.tabs.get(id);
          if (tab.url && tab.url.startsWith(prefix)) return;
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        throw new Error('tab URL did not settle');
      };
      const window = await chrome.windows.create({ focused: true });
      const alpha = await chrome.tabs.create({ windowId: window.id, url: ${JSON.stringify(`${base}/alpha`)} });
      const beta = await chrome.tabs.create({ windowId: window.id, url: ${JSON.stringify(`${base}/beta`)} });
      const gamma = await chrome.tabs.create({ windowId: window.id, url: ${JSON.stringify(`${base}/gamma`)} });
      const delta = await chrome.tabs.create({ windowId: window.id, url: ${JSON.stringify(`${base}/delta`)} });
      await waitUrl(alpha.id, ${JSON.stringify(base)});
      await waitUrl(beta.id, ${JSON.stringify(base)});
      await waitUrl(gamma.id, ${JSON.stringify(base)});
      await waitUrl(delta.id, ${JSON.stringify(base)});
      const groupA = await chrome.tabs.group({ tabIds: [alpha.id, beta.id], createProperties: { windowId: window.id } });
      await chrome.tabGroups.update(groupA, { title: 'E2E 组 A', color: 'blue' });
      const groupB = await chrome.tabs.group({ tabIds: [gamma.id], createProperties: { windowId: window.id } });
      await chrome.tabGroups.update(groupB, { title: 'E2E 组 B', color: 'green', collapsed: true });
      await chrome.tabs.update(delta.id, { pinned: true });
      await chrome.tabs.update(alpha.id, { active: true });
      const tabs = await chrome.tabs.query({ windowId: window.id });
      return {
        windowId: window.id,
        alpha: alpha.id,
        beta: beta.id,
        gamma: gamma.id,
        delta: delta.id,
        tabs: tabs.map((tab) => ({ id: tab.id, url: tab.url, pinned: tab.pinned, groupId: tab.groupId, index: tab.index })),
      };
    })()`);
    assert.equal(fixture.tabs.length, 5, 'window has 5 tabs');

    // 1. Capture through the actual button.
    await page.evaluate(`(async () => {
      document.querySelector('#snapshot-name').value = 'E2E 快照';
      document.querySelector('#scope-select').value = 'all';
      document.querySelector('#dedupe-toggle').checked = false;
      document.querySelector('#capture-btn').click();
    })()`);
    await waitFor('window.tbas.state.index.length === 1', 'first snapshot');
    await waitFor('window.tbas.state.busy === false', 'capture finished');
    const snapshot = await page.evaluate(
      'JSON.parse(JSON.stringify(window.tbas.state.snapshots.get(window.tbas.state.index[0].id)))',
    );

    assert.equal(snapshot.name, 'E2E 快照');
    assert.equal(snapshot.windows.length, 1, 'dashboard window excluded');
    assert.equal(snapshot.stats.groups, 2, 'two groups captured');
    assert.equal(snapshot.stats.tabs, 5, 'five tabs captured');
    assert.equal(snapshot.stats.pinned, 1, 'pinned tab captured');
    assert.equal(snapshot.stats.unrestorable, 1, 'new-tab page marked unrestorable');
    assert.equal(snapshot.stats.restorable, 4);

    const groupTitles = snapshot.windows[0].groups.map((group) => group.title).sort();
    assert.deepEqual(groupTitles, ['E2E 组 A', 'E2E 组 B']);
    const urls = snapshot.windows[0].tabs.map((tab) => tab.url);
    assert.ok(urls[0].endsWith('/delta'), `pinned delta first, got ${urls[0]}`);
    assert.deepEqual(
      urls.slice(2),
      [`${base}/alpha`, `${base}/beta`, `${base}/gamma`],
      'group tab order preserved',
    );
    const activeTab = snapshot.windows[0].tabs.find((tab) => tab.active);
    assert.ok(activeTab && activeTab.url.endsWith('/alpha'), 'active tab captured');
    assert.equal(await page.evaluate('document.querySelectorAll(".tab-row").length'), 5);

    // Environment filtering hides snapshots from the other environment.
    await page.evaluate(`document.querySelector('#env-filter [data-env="home"]').click()`);
    await sleep(200);
    assert.equal(await page.evaluate('document.querySelectorAll("#snapshot-list .snap-card").length'), 0);
    assert.equal(await page.evaluate('Boolean(document.querySelector(".filtered-empty"))'), true);
    await page.evaluate(`document.querySelector('#env-filter [data-env=""]').click()`);
    await sleep(200);
    assert.equal(await page.evaluate('document.querySelectorAll("#snapshot-list .snap-card").length'), 1);

    // Settings panel opens and closes without errors.
    await page.evaluate(`document.querySelector('#settings-btn').click()`);
    await waitFor('Boolean(document.querySelector(".modal #env-rows"))', 'settings modal');
    assert.match(await page.evaluate('document.querySelector(".modal h2").textContent'), /设置/);
    await page.evaluate(`document.querySelector('.modal [data-close]').click()`);
    await waitFor('!document.querySelector(".modal")', 'settings modal closed');

    // 2. Restore all restorable tabs through the UI.
    const snapshotId = snapshot.id;
    await page.evaluate(`document.querySelector('.snap-card[data-id="${snapshotId}"] [data-action="restore-all"]').click()`);
    await waitFor(
      `(async () => { const groups = await chrome.tabGroups.query({}); return groups.filter((g) => g.title === 'E2E 组 A').length >= 2; })()`,
      'restored groups',
    );
    await waitFor('window.tbas.state.restoring === false', 'restore finished');

    const restored = await page.evaluate(`(async () => {
      const windows = await chrome.windows.getAll({ populate: true });
      const allGroups = await chrome.tabGroups.query({});
      const target = windows.find((window) =>
        window.id !== ${fixture.windowId} &&
        window.tabs.some((tab) => tab.url && tab.url.endsWith('/alpha'))
      );
      if (!target) return null;
      const groups = allGroups.filter((group) => group.windowId === target.id);
      const tabs = await chrome.tabs.query({ windowId: target.id });
      return {
        windowId: target.id,
        tabs: tabs.map((tab) => ({ url: tab.url, pinned: tab.pinned, active: tab.active })),
        groups: groups.map((group) => ({ title: group.title, color: group.color, collapsed: group.collapsed })),
      };
    })()`);
    assert.ok(restored, 'restored window exists');
    assert.deepEqual(
      restored.tabs.map((tab) => tab.url),
      [`${base}/delta`, `${base}/alpha`, `${base}/beta`, `${base}/gamma`],
      'restored order with pinned tab first',
    );
    assert.equal(restored.tabs[0].pinned, true, 'pin restored');
    assert.equal(restored.tabs.find((tab) => tab.active)?.url, `${base}/alpha`, 'active tab restored');
    assert.deepEqual(
      restored.groups.map((group) => [group.title, group.color, group.collapsed]).sort(),
      [
        ['E2E 组 A', 'blue', false],
        ['E2E 组 B', 'green', true],
      ],
    );

    // 3. "Save and close": archive every non-dashboard window, keep this page alive.
    await page.evaluate(`(async () => {
      const window = await chrome.windows.create({ focused: false });
      await chrome.tabs.create({ windowId: window.id, url: ${JSON.stringify(`${base}/archive-a`)} });
      await chrome.tabs.create({ windowId: window.id, url: ${JSON.stringify(`${base}/archive-b`)} });
    })()`);
    await sleep(400);
    await page.evaluate(`document.querySelector('#capture-close-btn').click()`);
    await waitFor('Boolean(document.querySelector("#confirm-ok"))', 'archive confirmation');
    await page.evaluate(`document.querySelector('#confirm-ok').click()`);
    try {
      await waitFor(
        `(async () => { const windows = await chrome.windows.getAll({ populate: true }); return windows.length === 1 && windows[0].tabs.length === 1; })()`,
        'all non-dashboard windows closed',
        20000,
      );
    } catch (error) {
      const diagnostic = await page.evaluate(`(async () => ({
        windows: (await chrome.windows.getAll({ populate: true })).map((window) => ({
          id: window.id,
          focused: window.focused,
          tabs: window.tabs.map((tab) => ({ url: tab.url, active: tab.active })),
        })),
        index: window.tbas.state.index.length,
        busy: window.tbas.state.busy,
        restoring: window.tbas.state.restoring,
        toasts: [...document.querySelectorAll('.toast')].map((toast) => toast.innerText),
        modal: document.querySelector('#modal-root')?.innerText || '',
        storage: document.querySelector('#storage-stat')?.innerText || '',
        lastCapture: window.tbas.state.lastCapture,
        errors: window.tbas ? [] : null,
      }))()`);
      const manual = await page.evaluate(`(async () => {
        const windows = await chrome.windows.getAll({ populate: true });
        const targets = windows.filter((window) => window.tabs.every((tab) => !(tab.url || '').includes('/dashboard.html')));
        const results = [];
        for (const window of targets) {
          try {
            await chrome.windows.remove(window.id);
            results.push({ id: window.id, ok: true });
          } catch (error) {
            results.push({ id: window.id, ok: false, error: String(error) });
          }
        }
        return results;
      })()`);
      console.error('MANUAL REMOVE', JSON.stringify(manual, null, 2));
      console.error('ARCHIVE DIAGNOSTIC', JSON.stringify(diagnostic, null, 2));
      throw error;
    }
    await waitFor('window.tbas.state.busy === false', 'archive finished');
    assert.equal(await page.evaluate('window.tbas.state.index.length'), 2, 'archive snapshot saved');
    assert.equal(await page.evaluate('Boolean(window.tbas)'), true, 'dashboard survived archive');
    assert.equal(await page.evaluate('document.querySelectorAll(".snap-card").length'), 2);

    // Capture a screenshot of the real run for documentation.
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(root, 'docs', 'e2e-dashboard.png'), Buffer.from(shot.data, 'base64'));

    // 4. Restore one group into the current window (target select = current).
    const archiveId = await page.evaluate('window.tbas.state.index[0].id');
    await page.evaluate(`(async () => {
      const card = document.querySelector('.snap-card[data-id="${archiveId}"]');
      if (!card.querySelector('.snap-detail')) card.querySelector('[data-action="toggle"]').click();
      await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      const select = card.querySelector('[data-target-select]');
      select.value = 'current';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    const groupHandle = await page.evaluate(`(() => {
      const card = document.querySelector('.snap-card[data-id="${archiveId}"]');
      const button = [...card.querySelectorAll('[data-action="restore-group"]')].find((candidate) =>
        candidate.closest('.group-block').querySelector('.group-title').textContent.includes('E2E 组 A')
      );
      return button ? { window: button.dataset.window, group: button.dataset.group } : null;
    })()`);
    assert.ok(groupHandle, 'group restore button exists');
    await page.evaluate(`document.querySelector('.snap-card[data-id="${archiveId}"] [data-action="restore-group"][data-window="${groupHandle.window}"][data-group="${groupHandle.group}"]').click()`);
    await waitFor(
      `(async () => {
        const groups = await chrome.tabGroups.query({ windowId: ${self.windowId} });
        return groups.some((group) => group.title === 'E2E 组 A');
      })()`,
      'group restored into current window',
    );
    const currentWindow = await page.evaluate(`(async () => {
      const windows = await chrome.windows.getAll({ populate: true });
      const groups = await chrome.tabGroups.query({ windowId: ${self.windowId} });
      return {
        windows: windows.length,
        tabs: windows.find((window) => window.id === ${self.windowId}).tabs.map((tab) => tab.url),
        groups: groups.map((group) => ({ title: group.title, color: group.color })),
      };
    })()`);
    assert.equal(currentWindow.windows, 1, 'still a single window');
    assert.equal(currentWindow.tabs.filter((url) => url.endsWith('/alpha') || url.endsWith('/beta')).length, 2);
    assert.ok(currentWindow.groups.some((group) => group.title === 'E2E 组 A' && group.color === 'blue'));

    // 5. Manual capture picker: choose a subset of groups/tabs, then close only
    //    the selected tabs.
    await waitFor('window.tbas.state.live.capturable === 2', 'picker availability');
    await waitFor('window.tbas.state.restoring === false && window.tbas.state.busy === false', 'dashboard idle');
    await page.evaluate('document.querySelector("#capture-select-btn").click()');
    await waitFor('Boolean(document.querySelector("[data-pick-tree]"))', 'capture picker');

    assert.equal(await page.evaluate('document.querySelectorAll("[data-pick-tab]").length'), 2);
    assert.equal(await page.evaluate('document.querySelectorAll("[data-pick-group]").length'), 1);
    assert.equal(await page.evaluate('document.querySelector("[data-pick-count]").textContent'), '2');

    // Edge-style folding: chevron collapses the whole group, expand-all restores it.
    await page.evaluate('document.querySelector("[data-pick-toggle]").click()');
    assert.equal(await page.evaluate('document.querySelector(".pick-group").classList.contains("is-collapsed")'), true);
    assert.equal(await page.evaluate('getComputedStyle(document.querySelector(".pick-tab-list")).display'), 'none');
    assert.equal(await page.evaluate('document.querySelector("[data-pick-toggle]").getAttribute("aria-expanded")'), 'false');
    await page.evaluate('document.querySelector("[data-pick-expand]").click()');
    assert.equal(await page.evaluate('[...document.querySelectorAll(".pick-group")].every((group) => !group.classList.contains("is-collapsed"))'), true);

    await page.evaluate('document.querySelector("[data-pick-group]").click()');
    assert.equal(await page.evaluate('document.querySelector("[data-pick-count]").textContent'), '0');
    assert.equal(await page.evaluate('document.querySelector("[data-pick-save]").disabled'), true);

    await page.evaluate('document.querySelector("[data-pick-tab]").click()');
    assert.equal(await page.evaluate('document.querySelector("[data-pick-count]").textContent'), '1');
    assert.equal(await page.evaluate('document.querySelector("[data-pick-save]").disabled'), false);
    await page.evaluate('document.querySelector("[data-pick-save]").click()');
    await waitFor('window.tbas.state.index.length === 3', 'picker snapshot saved');
    await waitFor('!document.querySelector("[data-pick-tree]")', 'picker closed');
    const picked = await page.evaluate(`(() => {
      const entry = window.tbas.state.index[0];
      const snapshot = window.tbas.state.snapshots.get(entry.id);
      return {
        id: entry.id,
        stats: entry.stats,
        urls: snapshot.windows[0].tabs.map((tab) => tab.url),
        groups: snapshot.windows[0].groups.length,
      };
    })()`);
    assert.equal(picked.stats.tabs, 1);
    assert.equal(picked.stats.groups, 1);
    assert.equal(picked.groups, 1, 'the selected tab keeps its group');
    assert.ok(picked.urls[0].endsWith('/alpha'), `first tab saved, got ${picked.urls[0]}`);

    // The same folding is available in the snapshot detail view.
    const pickedCard = `.snap-card[data-id="${picked.id}"]`;
    await page.evaluate(`document.querySelector('${pickedCard} [data-action="toggle-group"]').click()`);
    assert.equal(await page.evaluate(`document.querySelector('${pickedCard} .group-block').classList.contains('is-collapsed')`), true);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('${pickedCard} .tab-list')).display`), 'none');
    await page.evaluate(`document.querySelector('${pickedCard} [data-action="expand-groups"]').click()`);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('${pickedCard} .group-block')].every((group) => !group.classList.contains('is-collapsed'))`), true);

    // Open the picker again, choose one tab, and close only that tab.
    await page.evaluate('document.querySelector("#capture-select-btn").click()');
    await waitFor('Boolean(document.querySelector("[data-pick-tree]"))', 'capture picker again');
    await page.evaluate('document.querySelector("[data-pick-none]").click()');
    await page.evaluate('document.querySelectorAll("[data-pick-tab]")[0].click()');
    await page.evaluate('document.querySelector("[data-pick-save-close]").click()');
    await waitFor('window.tbas.state.index.length === 4', 'picker close snapshot saved');
    await waitFor(
      `(async () => {
        const tabs = await chrome.tabs.query({ windowId: ${self.windowId} });
        return tabs.length === 2 && tabs.some((tab) => tab.url && tab.url.endsWith('/beta'));
      })()`,
      'only the selected tab closed',
    );
    const remaining = await page.evaluate(`(async () => {
      const tabs = await chrome.tabs.query({ windowId: ${self.windowId} });
      return tabs.map((tab) => tab.url);
    })()`);
    assert.equal(remaining.some((url) => url.endsWith('/alpha')), false, 'selected alpha closed');
    assert.equal(remaining.some((url) => url.endsWith('/beta')), true, 'unselected beta kept');
    console.log('• picker: manual selection saved + only selected tab closed ✓');

    const errors = page.events.filter(
      (event) => event.method === 'Runtime.exceptionThrown' ||
        (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'),
    );
    const relevant = errors.filter((event) => {
      const text = JSON.stringify(event);
      return !text.includes('favicon');
    });
    assert.equal(relevant.length, 0, `page console errors:\n${JSON.stringify(relevant, null, 2).slice(0, 4000)}`);

    console.log('• capture: 5 tabs / 2 groups / pinned + internal page ✓');
    console.log('• restore: order, pin, active tab and group colors ✓');
    console.log('• archive & close: dashboard survived, snapshot persisted ✓');
    console.log('E2E PASSED');
  } finally {
    page?.close();
    edge.kill('SIGKILL');
    await new Promise((resolveClose) => httpServer.close(resolveClose));
    await sleep(400);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('E2E FAILED');
  console.error(error);
  process.exitCode = 1;
});
