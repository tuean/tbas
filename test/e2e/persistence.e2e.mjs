/**
 * Persistence E2E: prove that snapshots survive closing the browser.
 *
 * 1. Launch Edge with the extension, capture a real grouped window, save it.
 * 2. Kill the browser process (simulating "close the browser / computer").
 * 3. Relaunch with the same profile, reopen the dashboard, verify the snapshot
 *    is still there, and restore it with its group.
 *
 * Run: npm run test:e2e
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

async function waitForTargets(port, { attempts = 160 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) return await response.json();
    } catch {
      /* browser still starting */
    }
    await sleep(250);
  }
  throw new Error('Edge DevTools endpoint did not become ready');
}

async function attachDashboard({ profile, extId, port }) {
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
  let log = '';
  edge.stdout.on('data', (chunk) => {
    log += chunk;
  });
  edge.stderr.on('data', (chunk) => {
    log += chunk;
  });

  let target = null;
  let resolvedId = extId;
  for (let attempt = 0; attempt < 120 && !target; attempt += 1) {
    for (const candidate of await waitForTargets(port, { attempts: 1 }).catch(() => [])) {
      if (candidate.type === 'page' && candidate.url.includes('/dashboard.html')) {
        target = candidate;
        resolvedId = new URL(candidate.url).host;
        break;
      }
      if (!resolvedId && candidate.type === 'service_worker' && candidate.url.endsWith('/background.js')) {
        resolvedId = new URL(candidate.url).host;
      }
    }
    if (!target) await sleep(250);
  }

  if (!target && resolvedId) {
    const response = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`chrome-extension://${resolvedId}/dashboard.html`)}`,
      { method: 'PUT' },
    );
    if (response.ok) target = await response.json();
  }
  if (!target) throw new Error(`extension dashboard did not open.\n${log.slice(-4000)}`);

  const page = new CDP(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  return { edge, page, extId: resolvedId, log };
}

async function stopBrowser(browser, profile) {
  browser?.edge?.kill('SIGKILL');
  browser?.page?.close();
  await sleep(900);
  // A SIGKILL leaves Chromium's profile singleton files behind; remove them so
  // the same profile can be opened again by a fresh process.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(join(profile, name), { force: true });
  }
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'tbas-persist-'));
  const server = createServer((request, response) => {
    const name = (request.url || '/').replace(/^\//, '') || 'home';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TBAS ${name}</title></head><body><h1>${name}</h1></body></html>`);
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;

  let browser = null;
  try {
    const firstPort = await freePort();
    browser = await attachDashboard({ profile, extId: null, port: firstPort });
    const page = browser.page;
    const waitFor = async (expression, label, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      let last = '';
      while (Date.now() < deadline) {
        try {
          const value = await page.evaluate(expression);
          if (value) return value;
          last = `got ${JSON.stringify(value)}`;
        } catch (error) {
          last = error.message;
        }
        await sleep(200);
      }
      throw new Error(`Timed out waiting for ${label || expression} (${last})`);
    };

    await waitFor('Boolean(window.tbas)', 'first dashboard boot');

    // Clean state and create a real grouped window.
    await page.evaluate(`(async () => {
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
    })()`);

    await page.evaluate(`(async () => {
      const waitUrl = async (id, prefix) => {
        for (let i = 0; i < 80; i += 1) {
          const tab = await chrome.tabs.get(id);
          if (tab.url && tab.url.startsWith(prefix)) return;
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
        throw new Error('tab URL did not settle');
      };
      const window = await chrome.windows.create({ focused: true });
      const one = await chrome.tabs.create({ windowId: window.id, url: ${JSON.stringify(`${base}/one`)} });
      const two = await chrome.tabs.create({ windowId: window.id, url: ${JSON.stringify(`${base}/two`)} });
      await waitUrl(one.id, ${JSON.stringify(base)});
      await waitUrl(two.id, ${JSON.stringify(base)});
      const group = await chrome.tabs.group({ tabIds: [one.id, two.id], createProperties: { windowId: window.id } });
      await chrome.tabGroups.update(group, { title: 'PERSIST 组', color: 'purple', collapsed: true });
      await chrome.tabs.update(one.id, { active: true });
    })()`);
    await sleep(400);

    const saved = await page.evaluate(`(async () => {
      const result = await window.tbas.engine.capture({
        scope: 'all',
        env: 'office',
        envLabel: '办公',
        name: '持久化测试',
        excludeUrlPrefixes: [chrome.runtime.getURL('')],
      });
      await window.tbas.saveSnapshot(result.snapshot);
      await window.tbas.refresh();
      return {
        id: result.snapshot.id,
        name: result.snapshot.name,
        stats: result.snapshot.stats,
        entries: window.tbas.state.index.length,
      };
    })()`);

    assert.equal(saved.entries, 1, 'one snapshot saved');
    assert.equal(saved.stats.tabs, 3, 'two pages + the initial new-tab page');
    assert.equal(saved.stats.restorable, 2);
    assert.equal(saved.stats.groups, 1);
    assert.equal(saved.name, '持久化测试');
    console.log('• first session: captured and saved a grouped snapshot ✓');

    // Close the browser completely, then reopen the same profile.
    const extensionId = browser.extId;
    await stopBrowser(browser, profile);
    browser = null;

    const secondPort = await freePort();
    browser = await attachDashboard({ profile, extId: extensionId, port: secondPort });
    const secondPage = browser.page;
    const waitSecond = async (expression, label, timeout = 20000) => {
      const deadline = Date.now() + timeout;
      let last = '';
      while (Date.now() < deadline) {
        try {
          const value = await secondPage.evaluate(expression);
          if (value) return value;
          last = `got ${JSON.stringify(value)}`;
        } catch (error) {
          last = error.message;
        }
        await sleep(200);
      }
      throw new Error(`Timed out waiting for ${label || expression} (${last})`);
    };

    await waitSecond('Boolean(window.tbas)', 'second dashboard boot');
    const persisted = await secondPage.evaluate(`(async () => {
      const id = window.tbas.state.index[0]?.id;
      const snapshot = id ? window.tbas.state.snapshots.get(id) : null;
      return {
        count: window.tbas.state.index.length,
        id,
        name: window.tbas.state.index[0]?.name,
        stats: window.tbas.state.index[0]?.stats,
        tabs: snapshot ? snapshot.windows[0].tabs.map((tab) => tab.url) : [],
        groups: snapshot ? snapshot.windows[0].groups.map((group) => group.title) : [],
      };
    })()`);

    assert.equal(persisted.count, 1, 'snapshot survived the browser restart');
    assert.equal(persisted.id, saved.id);
    assert.equal(persisted.name, '持久化测试');
    assert.equal(persisted.stats.tabs, 3);
    assert.equal(persisted.stats.groups, 1);
    assert.deepEqual(persisted.groups, ['PERSIST 组']);
    assert.equal(persisted.tabs.filter((url) => url.startsWith(base)).length, 2);
    console.log('• second session: snapshot still present after a full restart ✓');

    // Remove any window restored by Edge's own session restore so the next
    // assertion targets the window TBAS creates.
    await secondPage.evaluate(`(async () => {
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
    })()`);

    // Restore it through the real engine and verify the group comes back.
    const restored = await secondPage.evaluate(`(async () => {
      const snapshot = window.tbas.state.snapshots.get(window.tbas.state.index[0].id);
      const result = await window.tbas.engine.restore(snapshot, { mode: 'new' });
      const windowId = result.windowIds[0];
      let tabs = [];
      for (let i = 0; i < 80; i += 1) {
        tabs = await chrome.tabs.query({ windowId });
        if (tabs.length === 2 && tabs.every((tab) => tab.url && tab.url.startsWith(${JSON.stringify(base)}))) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      const windows = await chrome.windows.getAll({ populate: true });
      const groups = await chrome.tabGroups.query({ windowId });
      const target = windows.find((window) => window.id === windowId);
      return {
        result: { created: result.created, groups: result.groups, skipped: result.skipped.length },
        target: target
          ? {
              tabs: tabs.map((tab) => tab.url),
              groups: groups.map((group) => ({ title: group.title, color: group.color, collapsed: group.collapsed })),
            }
          : null,
      };
    })()`);

    assert.equal(restored.result.created, 2);
    assert.equal(restored.result.groups, 1);
    assert.equal(restored.result.skipped, 1, 'the captured edge://newtab page is reported as unrestorable');
    assert.ok(restored.target, 'restored window exists');
    assert.deepEqual(restored.target.tabs, [`${base}/one`, `${base}/two`]);
    assert.deepEqual(restored.target.groups, [{ title: 'PERSIST 组', color: 'purple', collapsed: true }]);
    console.log('• restore after restart: order + group title/color/collapsed ✓');

    const errors = secondPage.events.filter(
      (event) => event.method === 'Runtime.exceptionThrown' ||
        (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error'),
    );
    assert.equal(errors.length, 0, `page console errors:\n${JSON.stringify(errors, null, 2).slice(0, 4000)}`);

    console.log('E2E PERSISTENCE PASSED');
  } finally {
    await stopBrowser(browser, profile);
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('E2E PERSISTENCE FAILED');
  console.error(error);
  process.exitCode = 1;
});
