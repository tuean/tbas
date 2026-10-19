#!/usr/bin/env node
/**
 * TBAS CLI — offline companion for the TBAS Edge extension.
 *
 * Reads and writes plain JSON snapshots under ~/.tbas (override with TBAS_HOME).
 * No dependencies, no network, no browser required.
 */

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  displayTitle,
  envOf,
  formatLocalDate,
  formatStats,
  normalizeUrl,
  parseSnapshotText,
  renderHTMLReport,
  renderMarkdown,
  renderTree,
  renderURLList,
  searchSnapshot,
  tabKeyOf,
} from '../extension/lib/core.js';
import { demoSnapshots } from '../src/demo.js';

const VERSION = '0.1.0';
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const IS_MAC = platform() === 'darwin';
const IS_WINDOWS = platform() === 'win32';
const COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const HOME = process.env.TBAS_HOME ? resolve(process.env.TBAS_HOME) : join(homedir(), '.tbas');
const SNAP_DIR = join(HOME, 'snapshots');
const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'extension');

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  grey: '\x1b[90m',
};

if (NODE_MAJOR < 20) {
  console.error(`TBAS 需要 Node.js 20 或更高版本（当前 ${process.version}）。`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* args                                                                */
/* ------------------------------------------------------------------ */

function addFlag(flags, key, value) {
  if (key in flags) {
    if (Array.isArray(flags[key])) flags[key].push(value);
    else flags[key] = [flags[key], value];
  } else {
    flags[key] = value;
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      if (equals !== -1) {
        addFlag(flags, arg.slice(2, equals), arg.slice(equals + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        addFlag(flags, key, next);
        i += 1;
      } else {
        addFlag(flags, key, true);
      }
      continue;
    }
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '-v') {
      flags.version = true;
      continue;
    }
    if (arg === '-y') {
      flags.yes = true;
      continue;
    }
    positional.push(arg);
  }
  return { positional, flags };
}

function flagValue(flags, name, fallback = undefined) {
  const value = flags[name];
  if (value === undefined || value === true) return fallback;
  const last = Array.isArray(value) ? value[value.length - 1] : value;
  return last === true ? fallback : last;
}

function flagList(flags, name) {
  const value = flags[name];
  if (value === undefined || value === true) return [];
  return Array.isArray(value) ? value : [value];
}

function intFlag(flags, name, fallback) {
  const value = Number(flagValue(flags, name, fallback));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/* ------------------------------------------------------------------ */
/* output helpers                                                      */
/* ------------------------------------------------------------------ */

function paint(code, text) {
  return COLOR ? `${code}${text}${ANSI.reset}` : String(text);
}

function bold(text) {
  return paint(ANSI.bold, text);
}

function dim(text) {
  return paint(ANSI.dim, text);
}

function warn(message) {
  console.warn(`${paint(ANSI.yellow, '⚠')} ${message}`);
}

function fail(message, code = 1) {
  console.error(`${paint(ANSI.red, '✗')} ${message}`);
  process.exitCode = code;
}

function ok(message) {
  console.log(`${paint(ANSI.green, '✓')} ${message}`);
}

function displayWidth(text) {
  let width = 0;
  const plain = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  for (const char of plain) {
    const code = char.codePointAt(0);
    width += code >= 0x1100 &&
      (code <= 0x115f ||
        code === 0x2329 ||
        code === 0x232a ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x1f900 && code <= 0x1f9ff))
      ? 2
      : 1;
  }
  return width;
}

function pad(text, width) {
  const value = String(text ?? '');
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function truncateWidth(text, width) {
  let out = '';
  let used = 0;
  for (const char of String(text)) {
    const w = displayWidth(char);
    if (used + w > width - 1) return `${out}…`;
    out += char;
    used += w;
  }
  return out;
}

function highlight(text, query) {
  if (!COLOR || !query) return String(text);
  const source = String(text);
  const tokens = query.split(/\s+/).filter(Boolean);
  let result = source;
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), (match) => paint(ANSI.yellow, match));
  }
  return result;
}

function plural(count, unit) {
  return `${count} ${unit}`;
}

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ */
/* storage                                                             */
/* ------------------------------------------------------------------ */

async function ensureDirs() {
  await mkdir(SNAP_DIR, { recursive: true });
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readAllSnapshots() {
  await ensureDirs();
  const names = (await readdir(SNAP_DIR)).filter((name) => name.endsWith('.json')).sort();
  const byId = new Map();
  const errors = [];
  for (const name of names) {
    const file = join(SNAP_DIR, name);
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      errors.push(`${name}：${error.message}`);
      continue;
    }
    const parsed = parseSnapshotText(text, { filename: name });
    errors.push(...parsed.errors);
    for (const snapshot of parsed.snapshots) byId.set(snapshot.id, snapshot);
  }
  const snapshots = [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return { snapshots, errors };
}

async function writeSnapshotFile(snapshot, { replace = true } = {}) {
  await ensureDirs();
  const file = join(SNAP_DIR, `${snapshot.id}.json`);
  const already = await exists(file);
  if (already && !replace) return { skipped: true, file };
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  if (already) await rm(file, { force: true });
  await rename(temporary, file);
  return { skipped: false, file };
}

function summaryOf(snapshot) {
  return {
    id: snapshot.id,
    name: snapshot.name,
    env: snapshot.env,
    tags: snapshot.tags || [],
    createdAt: snapshot.createdAt,
    stats: snapshot.stats,
    source: snapshot.source?.browser || 'unknown',
  };
}

function matchesEnv(snapshot, env) {
  if (!env) return true;
  if (snapshot.env === env) return true;
  return envOf(snapshot).label === env;
}

function resolveSnapshot(snapshots, query) {
  if (!query) throw new Error('请提供快照 ID、ID 前缀或名称');
  const exact = snapshots.find((snapshot) => snapshot.id === query);
  if (exact) return exact;
  const prefixed = snapshots.filter((snapshot) => snapshot.id.startsWith(query));
  if (prefixed.length === 1) return prefixed[0];
  if (prefixed.length > 1) {
    const list = prefixed.map((snapshot) => `  ${snapshot.id}  ${snapshot.name}`).join('\n');
    throw new Error(`ID 前缀「${query}」不唯一：\n${list}`);
  }
  const byName = snapshots.filter((snapshot) => snapshot.name.toLowerCase().includes(query.toLowerCase()));
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    const list = byName.map((snapshot) => `  ${snapshot.id}  ${snapshot.name}`).join('\n');
    throw new Error(`名称「${query}」匹配多个快照：\n${list}`);
  }
  throw new Error(`找不到快照「${query}」。用 tbas list 查看已有快照。`);
}

/* ------------------------------------------------------------------ */
/* import / scan                                                       */
/* ------------------------------------------------------------------ */

async function collectJsonFiles(paths) {
  const files = [];
  for (const input of paths) {
    const target = resolve(input);
    if (!(await exists(target))) {
      warn(`路径不存在：${input}`);
      continue;
    }
    const info = await stat(target);
    if (info.isDirectory()) {
      const entries = await readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const child = join(target, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await collectJsonFiles([child])));
        } else if (entry.name.toLowerCase().endsWith('.json')) {
          files.push(child);
        }
      }
    } else {
      files.push(target);
    }
  }
  return files;
}

async function importFiles(paths, { replace = false, quiet = false } = {}) {
  const files = await collectJsonFiles(paths);
  if (!files.length) return { imported: 0, skipped: 0, errors: [], files: 0 };

  const { snapshots: existingSnapshots, errors: readErrors } = await readAllSnapshots();
  const existing = new Map(existingSnapshots.map((snapshot) => [snapshot.id, snapshot]));
  const errors = [...readErrors];
  const imported = [];
  let skipped = 0;

  for (const file of files) {
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      errors.push(`${basename(file)}：${error.message}`);
      continue;
    }
    const parsed = parseSnapshotText(text, { filename: basename(file) });
    errors.push(...parsed.errors);
    for (const snapshot of parsed.snapshots) {
      const previous = existing.get(snapshot.id);
      if (previous) {
        if (replace) {
          await writeSnapshotFile(snapshot, { replace: true });
          existing.set(snapshot.id, snapshot);
          imported.push(snapshot);
        } else {
          skipped += 1;
        }
      } else {
        await writeSnapshotFile(snapshot, { replace: true });
        existing.set(snapshot.id, snapshot);
        imported.push(snapshot);
      }
    }
  }

  if (!quiet) {
    for (const snapshot of imported) {
      console.log(`${paint(ANSI.green, '+')} ${snapshot.name}  ${dim(snapshot.id)}  ${formatStats(snapshot.stats)}`);
    }
    if (skipped) console.log(`${paint(ANSI.grey, '=')} 已存在，跳过 ${skipped} 个（用 --replace 覆盖）`);
    if (errors.length) warn(`${errors.length} 个文件或条目未能导入`);
  }
  return { imported: imported.length, skipped, errors, files: files.length };
}

async function defaultScanDirs() {
  const dirs = [];
  const downloads = join(homedir(), 'Downloads');
  dirs.push(join(downloads, 'tbas-snapshots'));
  if (process.env.TBAS_BACKUP_DIR) dirs.push(resolve(process.env.TBAS_BACKUP_DIR));
  return dirs;
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

async function cmdList(flags) {
  const { snapshots, errors } = await readAllSnapshots();
  const env = flagValue(flags, 'env');
  const filtered = snapshots.filter((snapshot) => matchesEnv(snapshot, env));

  if (flags.json) {
    console.log(JSON.stringify(filtered.map(summaryOf), null, 2));
    if (errors.length) warn(`${errors.length} 个文件无法读取`);
    return;
  }

  if (!filtered.length) {
    console.log('还没有快照。');
    console.log(dim('在 Edge 的 TBAS 面板保存快照，或运行 tbas demo 生成示例。'));
    if (errors.length) warn(`${errors.length} 个文件无法读取，可运行 tbas doctor 查看`);
    return;
  }

  const rows = filtered.map((snapshot) => {
    const envInfo = envOf(snapshot);
    const stats = snapshot.stats || {};
    return {
      id: snapshot.id,
      name: truncateWidth(snapshot.name, 30),
      env: envInfo.label,
      windows: String(stats.windows || 0),
      groups: String(stats.groups || 0),
      tabs: String(stats.tabs || 0),
      created: formatLocalDate(snapshot.createdAt),
    };
  });

  const headers = {
    id: 'ID',
    name: '名称',
    env: '环境',
    windows: '窗口',
    groups: '组',
    tabs: '标签',
    created: '创建时间',
  };
  const widths = {
    id: Math.max(displayWidth(headers.id), ...rows.map((row) => displayWidth(row.id))),
    name: Math.max(displayWidth(headers.name), ...rows.map((row) => displayWidth(row.name))),
    env: Math.max(displayWidth(headers.env), ...rows.map((row) => displayWidth(row.env))),
    windows: Math.max(displayWidth(headers.windows), ...rows.map((row) => displayWidth(row.windows))),
    groups: Math.max(displayWidth(headers.groups), ...rows.map((row) => displayWidth(row.groups))),
    tabs: Math.max(displayWidth(headers.tabs), ...rows.map((row) => displayWidth(row.tabs))),
    created: Math.max(displayWidth(headers.created), ...rows.map((row) => displayWidth(row.created))),
  };

  console.log(
    paint(
      ANSI.bold,
      [pad(headers.id, widths.id), pad(headers.name, widths.name), pad(headers.env, widths.env), pad(headers.windows, widths.windows), pad(headers.groups, widths.groups), pad(headers.tabs, widths.tabs), pad(headers.created, widths.created)].join('  '),
    ),
  );
  console.log(paint(ANSI.grey, '─'.repeat(Object.values(widths).reduce((sum, width) => sum + width, 0) + (Object.keys(widths).length - 1) * 2)));
  for (const row of rows) {
    console.log(
      [
        pad(row.id, widths.id),
        pad(row.name, widths.name),
        pad(paint(row.env === '个人' ? ANSI.green : ANSI.blue, row.env), widths.env),
        pad(row.windows, widths.windows),
        pad(row.groups, widths.groups),
        pad(row.tabs, widths.tabs),
        pad(dim(row.created), widths.created),
      ].join('  '),
    );
  }
  console.log('');
  console.log(dim(`${filtered.length} 个快照 · 数据目录 ${HOME}`));
  if (errors.length) warn(`${errors.length} 个文件无法读取，可运行 tbas doctor 查看`);
}

async function cmdShow(id, flags) {
  const { snapshots } = await readAllSnapshots();
  const snapshot = resolveSnapshot(snapshots, id);
  if (flags.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  if (flags.urls) {
    const text = renderURLList(snapshot, { includeUnrestorable: !!flags.all });
    console.log(text || '没有可输出的网址');
    return;
  }
  if (flags.md) {
    console.log(renderMarkdown(snapshot));
    return;
  }
  console.log(renderTree(snapshot, { ansi: COLOR && !flags['no-color'] }));
}

async function cmdSearch(query, flags) {
  if (!query) {
    fail('用法：tbas search <关键词…> [--env 办公] [--limit 50]', 2);
    return;
  }
  const { snapshots } = await readAllSnapshots();
  const env = flagValue(flags, 'env');
  const limit = intFlag(flags, 'limit', 60);
  const filtered = snapshots.filter((snapshot) => matchesEnv(snapshot, env));
  const results = [];
  for (const snapshot of filtered) {
    const { matches } = searchSnapshot(snapshot, query);
    if (matches.length) results.push({ snapshot, matches });
  }
  const total = results.reduce((sum, item) => sum + item.matches.length, 0);

  if (flags.json) {
    console.log(
      JSON.stringify(
        results.map((item) => ({
          snapshot: summaryOf(item.snapshot),
          matches: item.matches.map((match) => ({
            window: match.window.key,
            group: match.group ? { key: match.group.key, title: match.group.title, color: match.group.color } : null,
            tab: {
              key: match.tab.key,
              url: match.tab.url,
              title: match.tab.title,
              pinned: match.tab.pinned,
              restorable: match.tab.restorable,
            },
          })),
        })),
        null,
        2,
      ),
    );
    return;
  }

  if (!total) {
    console.log(`没有匹配「${query}」的标签页。`);
    return;
  }

  let printed = 0;
  for (const { snapshot, matches } of results) {
    if (printed >= limit) break;
    console.log('');
    console.log(`${bold(snapshot.name)}  ${dim(`[${snapshot.id}]`)}  ${dim(formatStats(snapshot.stats))}`);
    for (const match of matches) {
      if (printed >= limit) break;
      const group = match.group ? `${match.group.title}` : '未分组';
      const pin = match.tab.pinned ? paint(ANSI.yellow, '📌') + ' ' : '';
      const title = highlight(displayTitle(match.tab), query);
      const url = highlight(match.tab.url, query);
      const missing = match.tab.restorable ? '' : paint(ANSI.yellow, ' [不可恢复]');
      console.log(`  ${paint(ANSI.grey, match.window.key)} ${paint(ANSI.cyan, group)}  ${pin}${title}${missing}`);
      console.log(`      ${dim(url)}`);
      printed += 1;
    }
  }
  if (total > limit) {
    console.log('');
    console.log(dim(`还有 ${total - limit} 个匹配未显示（用 --limit ${total} 查看全部）。`));
  }
}

async function cmdStats(flags) {
  const { snapshots, errors } = await readAllSnapshots();
  const totals = snapshots.reduce(
    (acc, snapshot) => {
      acc.windows += snapshot.stats?.windows || 0;
      acc.groups += snapshot.stats?.groups || 0;
      acc.tabs += snapshot.stats?.tabs || 0;
      acc.pinned += snapshot.stats?.pinned || 0;
      acc.duplicates += snapshot.stats?.duplicates || 0;
      for (const window of snapshot.windows || []) {
        for (const tab of window.tabs || []) {
          const key = normalizeUrl(tab.url);
          if (key) acc.urls.add(key);
        }
      }
      const env = envOf(snapshot).label;
      acc.envs.set(env, (acc.envs.get(env) || 0) + 1);
      return acc;
    },
    { windows: 0, groups: 0, tabs: 0, pinned: 0, duplicates: 0, urls: new Set(), envs: new Map() },
  );

  const largest = snapshots.reduce((best, snapshot) => {
    if (!best || (snapshot.stats?.tabs || 0) > (best.stats?.tabs || 0)) return snapshot;
    return best;
  }, null);

  const data = {
    snapshots: snapshots.length,
    windows: totals.windows,
    groups: totals.groups,
    tabs: totals.tabs,
    uniqueUrls: totals.urls.size,
    duplicates: totals.duplicates,
    pinned: totals.pinned,
    envs: Object.fromEntries(totals.envs),
    largest: largest ? summaryOf(largest) : null,
    newest: snapshots[0] ? summaryOf(snapshots[0]) : null,
    oldest: snapshots[snapshots.length - 1] ? summaryOf(snapshots[snapshots.length - 1]) : null,
    home: HOME,
    errors: errors.length,
  };

  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (!snapshots.length) {
    console.log('还没有快照。运行 tbas demo 生成示例，或从 TBAS 扩展导出后运行 tbas scan。');
    return;
  }

  const rows = [
    ['快照数量', String(data.snapshots)],
    ['窗口', String(data.windows)],
    ['分组', String(data.groups)],
    ['标签页', String(data.tabs)],
    ['唯一网址', String(data.uniqueUrls)],
    ['重复标签', String(data.duplicates)],
    ['固定标签', String(data.pinned)],
    ['环境分布', [...totals.envs.entries()].map(([env, count]) => `${env} ${count}`).join(' · ')],
    ['最大快照', largest ? `${largest.name}（${largest.stats?.tabs || 0} 标签）` : '—'],
    ['最近保存', snapshots[0] ? `${snapshots[0].name} · ${formatLocalDate(snapshots[0].createdAt)}` : '—'],
    ['数据目录', HOME],
  ];
  for (const [label, value] of rows) {
    console.log(`${pad(label, 12)} ${bold(value)}`);
  }
  if (errors.length) warn(`${errors.length} 个文件无法读取，可运行 tbas doctor 查看`);
}

async function cmdExport(id, flags) {
  const { snapshots } = await readAllSnapshots();
  const snapshot = resolveSnapshot(snapshots, id);
  const formatFlag = flagValue(flags, 'format');
  let format = formatFlag;
  if (!format) {
    if (flags.html) format = 'html';
    else if (flags.md) format = 'md';
    else if (flags.urls) format = 'urls';
    else format = 'json';
  }
  if (!['html', 'md', 'json', 'urls'].includes(format)) {
    fail(`不支持的格式：${format}（可选 html / md / json / urls）`, 2);
    return;
  }

  const requested = flagValue(flags, 'out') || flagValue(flags, format, null);
  const extension = { html: 'html', md: 'md', json: 'json', urls: 'txt' }[format];
  const defaultName = `${safeFileName(snapshot.name)}-${snapshot.id}.${extension}`;
  let out = requested && requested !== true ? String(requested) : defaultName;
  if ((await exists(out)) && (await stat(out)).isDirectory()) out = join(out, defaultName);
  out = resolve(out);

  let text;
  if (format === 'html') text = renderHTMLReport([snapshot], { title: `TBAS · ${snapshot.name}` });
  else if (format === 'md') text = renderMarkdown(snapshot);
  else if (format === 'urls') text = `${renderURLList(snapshot)}\n`;
  else text = `${JSON.stringify(snapshot, null, 2)}\n`;

  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, text, 'utf8');
  ok(`已导出 ${format.toUpperCase()}：${out}`);
  console.log(dim(`  ${snapshot.name} · ${formatStats(snapshot.stats)}`));
}

async function cmdReport(flags) {
  const { snapshots } = await readAllSnapshots();
  const env = flagValue(flags, 'env');
  const filtered = snapshots.filter((snapshot) => matchesEnv(snapshot, env));
  if (!filtered.length) {
    fail('还没有快照可生成报告。运行 tbas demo，或从 TBAS 扩展导出后运行 tbas scan。');
    return;
  }
  const stamp = fileStamp(new Date().toISOString());
  const requested = flagValue(flags, 'out');
  const out = requested && requested !== true
    ? resolve(String(requested))
    : resolve(`tbas-report-${stamp}.html`);
  const html = renderHTMLReport(filtered, {
    title: env ? `TBAS 标签页快照 · ${env}` : 'TBAS 标签页快照报告',
  });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, html, 'utf8');
  ok(`报告已生成：${out}`);
  console.log(dim(`  ${filtered.length} 个快照 · ${filtered.reduce((sum, snapshot) => sum + (snapshot.stats?.tabs || 0), 0)} 个标签`));
  if (flags.open) {
    const opened = await openPath(out);
    if (opened) console.log(dim('  已在默认浏览器中打开'));
  }
}

async function cmdOpen(id, flags) {
  const { snapshots } = await readAllSnapshots();
  const snapshot = resolveSnapshot(snapshots, id);
  const wantedGroups = flagList(flags, 'group').map((group) => String(group).toLowerCase());
  const wantedWindows = flagList(flags, 'window').map((window) => String(window).toLowerCase());

  const keys = [];
  for (const window of snapshot.windows || []) {
    if (wantedWindows.length && !wantedWindows.includes(String(window.key).toLowerCase())) continue;
    const groups = new Map((window.groups || []).map((group) => [group.key, group]));
    for (const tab of window.tabs || []) {
      if (!tab.restorable) continue;
      if (wantedGroups.length) {
        const group = tab.group ? groups.get(tab.group) : null;
        const haystack = [group?.key, group?.title].filter(Boolean).join(' ').toLowerCase();
        if (!wantedGroups.some((needle) => haystack.includes(needle))) continue;
      }
      keys.push(tabKeyOf(window.key, tab.key));
    }
  }

  if (!keys.length) {
    fail('所选范围内没有可打开的标签页（浏览器内部页无法打开）。');
    return;
  }

  const urls = [];
  const seen = new Set();
  let duplicates = 0;
  for (const key of keys) {
    const [windowKey, tabKey] = key.split('.');
    const window = (snapshot.windows || []).find((item) => item.key === windowKey);
    const tab = (window?.tabs || []).find((item) => item.key === tabKey);
    if (!tab?.url) continue;
    const normalized = normalizeUrl(tab.url);
    if (seen.has(normalized)) {
      duplicates += 1;
      continue;
    }
    seen.add(normalized);
    urls.push(tab.url);
  }

  console.log(`${bold(snapshot.name)}  ${dim(`[${snapshot.id}]`)}`);
  console.log(`将打开 ${urls.length} 个标签${duplicates ? dim(`（已跳过 ${duplicates} 个重复网址）`) : ''}。`);
  console.log(dim('注意：这种方式只打开网址，不会恢复分组。完整恢复请使用 Edge 中的 TBAS 扩展。'));

  const edgeBinary = await findEdge();
  const commands = edgeOpenCommands(urls, edgeBinary);
  if (flags['dry-run']) {
    console.log('');
    for (const command of commands) console.log(`$ ${command}`);
    return;
  }

  const errors = await launchEdge(commands, urls, edgeBinary);
  if (errors.length) {
    fail(`打开失败：${errors[0]}`);
    console.log(dim('可以先运行 tbas open <id> --dry-run 查看命令。'));
    return;
  }
  ok('已发送给 Microsoft Edge');
}

async function cmdImport(paths, flags) {
  if (!paths.length) {
    fail('用法：tbas import <文件或目录…> [--replace]', 2);
    return;
  }
  const result = await importFiles(paths, { replace: !!flags.replace });
  if (result.imported === 0 && result.errors.length === 0 && result.skipped === 0) {
    fail('没有找到可导入的 .json 文件');
    return;
  }
  ok(`导入完成：${result.imported} 个新快照${result.skipped ? `，${result.skipped} 个已存在` : ''}${result.errors.length ? `，${result.errors.length} 个错误` : ''}`);
  console.log(dim(`数据目录：${HOME}`));
  if (result.errors.length) {
    for (const error of result.errors.slice(0, 5)) console.log(dim(`  · ${error}`));
    if (result.errors.length > 5) console.log(dim(`  · 还有 ${result.errors.length - 5} 条错误`));
  }
}

async function cmdScan(flags) {
  const explicit = flagList(flags, 'dir');
  const dirs = explicit.length ? explicit.map((dir) => resolve(dir)) : await defaultScanDirs();
  const existingDirs = [];
  for (const dir of dirs) {
    if (await exists(dir)) existingDirs.push(dir);
  }
  if (!existingDirs.length) {
    console.log('没有找到备份目录。');
    for (const dir of dirs) console.log(dim(`  · ${dir}`));
    console.log(dim('在 TBAS 设置中打开「自动备份到下载文件夹」，或指定 --dir <目录>。'));
    return;
  }
  const files = await collectJsonFiles(existingDirs);
  if (!files.length) {
    console.log('备份目录里还没有 JSON 快照。');
    return;
  }
  console.log(dim(`扫描 ${files.length} 个文件…`));
  const result = await importFiles(files, { replace: !!flags.replace, quiet: true });
  ok(`扫描完成：新增 ${result.imported} 个快照${result.skipped ? `，跳过 ${result.skipped} 个已存在` : ''}`);
  if (result.errors.length) {
    warn(`${result.errors.length} 个文件无法读取`);
    for (const error of result.errors.slice(0, 5)) console.log(dim(`  · ${error}`));
  }
  console.log(dim(`数据目录：${HOME}`));
}

async function cmdRemove(id, flags) {
  const { snapshots } = await readAllSnapshots();
  const snapshot = resolveSnapshot(snapshots, id);
  if (!flags.yes) {
    fail(`将删除「${snapshot.name}」（${snapshot.id}）。这是不可恢复操作，请加 --yes 确认。`);
    return;
  }
  const file = join(SNAP_DIR, `${snapshot.id}.json`);
  if (await exists(file)) await rm(file, { force: true });
  ok(`已删除：${snapshot.name}  ${dim(snapshot.id)}`);
}

async function cmdDemo(flags) {
  const outDir = flagValue(flags, 'out');
  const targetDir = outDir && outDir !== true ? resolve(String(outDir)) : SNAP_DIR;
  await mkdir(targetDir, { recursive: true });
  const snapshots = demoSnapshots();
  const written = [];
  for (const snapshot of snapshots) {
    const file = join(targetDir, `${snapshot.id}.json`);
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    written.push({ snapshot, file });
  }
  ok(`已生成 ${written.length} 个示例快照：`);
  for (const { snapshot, file } of written) {
    console.log(`  ${paint(ANSI.green, '●')} ${bold(snapshot.name)}  ${dim(snapshot.id)}  ${formatStats(snapshot.stats)}`);
    console.log(`    ${dim(file)}`);
  }
  console.log('');
  console.log(dim('下一步：tbas list · tbas show demo-office-v1 · tbas report --open'));
  if (targetDir === SNAP_DIR) {
    console.log(dim('也可以在 Edge 的 TBAS 面板点击「载入示例」，数据相同。'));
  }
}

async function cmdDoctor(flags) {
  const checks = [];
  const add = (level, label, detail = '') => checks.push({ level, label, detail });

  add('ok', 'Node.js', `${process.version}（需要 ≥20）`);
  add('ok', '平台', `${platform()} ${process.arch}`);

  let dataWritable = false;
  try {
    await ensureDirs();
    const probe = join(HOME, `.write-test-${process.pid}`);
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    dataWritable = true;
    add('ok', '数据目录可写', HOME);
  } catch (error) {
    add('error', '数据目录不可写', `${HOME}：${error.message}`);
  }

  const { snapshots, errors } = await readAllSnapshots();
  add('ok', '快照数量', `${snapshots.length} 个`);
  add(errors.length ? 'warn' : 'ok', '快照文件解析', errors.length ? `${errors.length} 个错误` : '全部正常');

  const edgePath = await findEdge();
  add(edgePath ? 'ok' : 'warn', 'Microsoft Edge', edgePath || '未找到（CLI 的 list/report 仍可用）');

  const manifestPath = join(EXTENSION_DIR, 'manifest.json');
  const manifestExists = await exists(manifestPath);
  add(manifestExists ? 'ok' : 'error', '扩展目录', manifestExists ? EXTENSION_DIR : `缺少 manifest.json：${manifestPath}`);
  if (manifestExists) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      add('ok', '扩展版本', `${manifest.name} v${manifest.version}`);
      const required = ['dashboard.html', 'dashboard.js', 'dashboard.css', 'background.js', 'lib/core.js', 'lib/engine.js', 'demo.json'];
      const missing = [];
      for (const file of required) {
        if (!(await exists(join(EXTENSION_DIR, file)))) missing.push(file);
      }
      add(missing.length ? 'error' : 'ok', '扩展文件完整性', missing.length ? `缺少：${missing.join(', ')}` : '完整');
    } catch (error) {
      add('error', 'manifest.json', error.message);
    }
  }

  const scanDirs = await defaultScanDirs();
  for (const dir of scanDirs) {
    if (await exists(dir)) {
      const files = await collectJsonFiles([dir]);
      add('ok', '自动备份目录', `${dir}（${files.length} 个 JSON）`);
    } else {
      add('warn', '自动备份目录', `${dir}（不存在，可在扩展设置中开启）`);
    }
  }

  add('ok', 'CLI 入口', process.argv[1] || 'tbas');

  if (flags.json) {
    console.log(JSON.stringify(checks, null, 2));
    return;
  }

  console.log(bold(`TBAS v${VERSION} 自检`));
  console.log('');
  for (const check of checks) {
    const icon = check.level === 'ok' ? paint(ANSI.green, '✓') : check.level === 'warn' ? paint(ANSI.yellow, '⚠') : paint(ANSI.red, '✗');
    console.log(`${icon} ${pad(check.label, 18)} ${check.detail}`);
  }
  const problems = checks.filter((check) => check.level === 'error');
  console.log('');
  if (problems.length) {
    fail(`发现 ${problems.length} 个需要修复的问题。`);
  } else {
    ok('核心检查通过。');
  }
}

/* ------------------------------------------------------------------ */
/* Edge launching                                                      */
/* ------------------------------------------------------------------ */

function shellQuote(value) {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function macAppBundle(edgeBinary) {
  return edgeBinary?.match(/^(.*\.app)(?:\/|$)/)?.[1] || 'Microsoft Edge';
}

function windowsQuote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function edgeOpenCommands(urls, edgeBinary, chunkSize = 20) {
  const groups = chunk(urls, chunkSize);
  if (IS_MAC) {
    const app = macAppBundle(edgeBinary);
    return groups.map((group) => `open -a ${shellQuote(app)} ${group.map(shellQuote).join(' ')}`);
  }
  if (IS_WINDOWS) {
    if (edgeBinary) {
      return groups.map((group) => `${windowsQuote(edgeBinary)} ${group.map(windowsQuote).join(' ')}`);
    }
    return groups.map((group) => `start "" msedge ${group.map(windowsQuote).join(' ')}`);
  }
  return urls.map((url) => `xdg-open ${shellQuote(url)}`);
}

function spawnAndWait(command, args, options = {}) {
  return new Promise((resolveSpawn) => {
    let settled = false;
    const child = spawn(command, args, { stdio: 'ignore', ...options });
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      resolveSpawn({ ok: false, error: error.message });
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      resolveSpawn({ ok: code === 0, code });
    });
  });
}

async function launchEdge(commands, urls, edgeBinary) {
  const errors = [];
  if (IS_MAC) {
    const app = macAppBundle(edgeBinary);
    for (const group of chunk(urls, 20)) {
      const result = await spawnAndWait('open', ['-a', app, ...group]);
      if (!result.ok) errors.push(result.error || `open 退出码 ${result.code}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    }
  } else if (IS_WINDOWS) {
    if (!edgeBinary) {
      // Never route snapshot URLs through cmd.exe: a crafted URL containing
      // & or | could otherwise be interpreted as a shell command.
      return ['找不到 Microsoft Edge。请安装 Edge，或设置 TBAS_EDGE_BINARY 为 msedge.exe 的完整路径'];
    }
    for (const group of chunk(urls, 20)) {
      const result = await spawnAndWait(edgeBinary, group);
      if (!result.ok) errors.push(result.error || `Edge 退出码 ${result.code}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    }
  } else {
    for (const url of urls) {
      const result = await spawnAndWait('xdg-open', [url]);
      if (!result.ok) {
        errors.push(result.error || `xdg-open 退出码 ${result.code}`);
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  return errors;
}

async function findEdge() {
  const candidates = IS_MAC
    ? [
        process.env.TBAS_EDGE_BINARY,
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
      ]
    : IS_WINDOWS
      ? [
          process.env.TBAS_EDGE_BINARY,
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        ]
      : [process.env.TBAS_EDGE_BINARY, '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome'];
  for (const candidate of candidates.filter(Boolean)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function openPath(path) {
  if (IS_MAC) {
    const result = await spawnAndWait('open', [path]);
    if (!result.ok) warn(`无法打开文件：${result.error || result.code}`);
    return result.ok;
  }
  if (IS_WINDOWS) {
    // explorer.exe opens the file with its default handler without a shell.
    const result = await spawnAndWait('explorer.exe', [path]);
    if (!result.ok) warn(`无法打开文件：${result.error || result.code}`);
    return result.ok;
  }
  const result = await spawnAndWait('xdg-open', [path]);
  if (!result.ok) warn(`无法打开文件：${result.error || result.code}`);
  return result.ok;
}

function safeFileName(value) {
  return (
    String(value || 'snapshot')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'snapshot'
  );
}

function fileStamp(iso) {
  const date = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* help                                                                */
/* ------------------------------------------------------------------ */

function printHelp() {
  console.log(`${bold('TBAS')} — Tab Baseline Archive System  ${dim(`v${VERSION}`)}`);
  console.log('把 Edge 的分组标签页保存成本地快照，离线查看、搜索和恢复。');
  console.log('');
  console.log(bold('用法'));
  console.log('  tbas <命令> [参数…]');
  console.log('');
  console.log(bold('命令'));
  console.log(`  ${pad('list', 12)} ${pad('列出所有快照', 24)} --env <环境> --json`);
  console.log(`  ${pad('show', 12)} ${pad('查看快照（分组树）', 24)} <ID|前缀|名称> --json --urls --md`);
  console.log(`  ${pad('search', 12)} ${pad('搜索标题、网址或分组', 24)} <关键词…> --limit 50`);
  console.log(`  ${pad('stats', 12)} ${pad('统计快照、标签与唯一网址', 24)} --json`);
  console.log(`  ${pad('import', 12)} ${pad('导入 JSON 快照（文件或目录）', 24)} <路径…> --replace`);
  console.log(`  ${pad('scan', 12)} ${pad('扫描导入自动备份目录', 24)} --dir <目录> --replace`);
  console.log(`  ${pad('export', 12)} ${pad('导出为 HTML/Markdown/JSON/网址列表', 24)} <ID> --html <文件>`);
  console.log(`  ${pad('report', 12)} ${pad('生成全部快照的离线 HTML 报告', 24)} --out <文件> --open`);
  console.log(`  ${pad('open', 12)} ${pad('用 Edge 打开快照网址（无分组）', 24)} <ID> --group <名称> --dry-run`);
  console.log(`  ${pad('rm', 12)} ${pad('删除一个快照', 24)} <ID> --yes`);
  console.log(`  ${pad('demo', 12)} ${pad('生成两个示例快照', 24)} --out <目录>`);
  console.log(`  ${pad('doctor', 12)} ${pad('检查数据目录、扩展与 Edge', 24)} --json`);
  console.log('');
  console.log(bold('示例'));
  console.log('  tbas demo && tbas report --open');
  console.log('  tbas scan');
  console.log('  tbas show demo-office-v1');
  console.log('  tbas search 周报 --limit 20');
  console.log('  tbas open demo-office-v1 --group 项目 --dry-run');
  console.log('  tbas export demo-home-v1 --html ~/Desktop/tbas-home.html');
  console.log('');
  console.log(bold('数据'));
  console.log(`  快照目录  ${SNAP_DIR}`);
  console.log(`  报告默认生成在当前目录（用 --out 指定路径）`);
  console.log(`  可用 TBAS_HOME 环境变量覆盖，例如 TBAS_HOME=/tmp/tbas`);
  console.log('');
  console.log(bold('扩展'));
  console.log('  在 Edge 打开 edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选择 extension/ 目录');
  console.log('  扩展会保存分组、颜色、固定页和顺序；CLI 的 open 只打开网址。');
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (flags.version) {
    console.log(VERSION);
    return;
  }
  const command = positional[0] || 'help';
  const rest = positional.slice(1);

  if (flags.help || command === 'help') {
    printHelp();
    return;
  }

  switch (command) {
    case 'list':
    case 'ls':
      await cmdList(flags);
      break;
    case 'show':
    case 'cat':
      if (!rest[0]) {
        fail('用法：tbas show <ID|前缀|名称> [--json] [--urls] [--md]', 2);
        break;
      }
      await cmdShow(rest[0], flags);
      break;
    case 'search':
    case 'find':
      await cmdSearch(rest.join(' ').trim(), flags);
      break;
    case 'stats':
      await cmdStats(flags);
      break;
    case 'import':
      await cmdImport(rest, flags);
      break;
    case 'scan':
      await cmdScan(flags);
      break;
    case 'export':
      if (!rest[0]) {
        fail('用法：tbas export <ID> [--html|--md|--json|--urls] [文件]', 2);
        break;
      }
      await cmdExport(rest[0], flags);
      break;
    case 'report':
      await cmdReport(flags);
      break;
    case 'open':
      if (!rest[0]) {
        fail('用法：tbas open <ID> [--group <分组名>] [--window w1] [--dry-run]', 2);
        break;
      }
      await cmdOpen(rest[0], flags);
      break;
    case 'rm':
    case 'remove':
      if (!rest[0]) {
        fail('用法：tbas rm <ID> --yes', 2);
        break;
      }
      await cmdRemove(rest[0], flags);
      break;
    case 'demo':
      await cmdDemo(flags);
      break;
    case 'doctor':
      await cmdDoctor(flags);
      break;
    default:
      fail(`未知命令：${command}`, 2);
      printHelp();
  }
}

main().catch((error) => {
  fail(error.message || String(error));
  if (process.env.TBAS_DEBUG) console.error(error);
});
