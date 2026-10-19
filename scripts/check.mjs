#!/usr/bin/env node
/**
 * Static checks: syntax, manifest, packaged extension files, demo data.
 * Run: npm run check
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSnapshotText, SNAPSHOT_SCHEMA } from '../extension/lib/core.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const notes = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function note(message) {
  notes.push(message);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', '.dsh', 'docs', '.DS_Store'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(root);
const scriptFiles = files.filter((file) => ['.js', '.mjs'].includes(extname(file)));

for (const file of scriptFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    fail(`语法错误：${relative(root, file)}\n${String(error.stderr || error.message).slice(0, 600)}`);
  }
}
note(`检查 ${scriptFiles.length} 个 JS/MJS 文件的语法`);

/* ---------------- manifest ---------------- */

const manifestPath = join(root, 'extension', 'manifest.json');
let manifest;
if (!existsSync(manifestPath)) {
  fail('缺少 extension/manifest.json');
} else {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`manifest.json 不是有效 JSON：${error.message}`);
  }
}

if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version 必须为 3');
  if (!manifest.name || !manifest.version || !manifest.description) fail('manifest 缺少 name/version/description');
  const permissions = new Set(manifest.permissions || []);
  for (const required of ['tabs', 'tabGroups', 'storage', 'unlimitedStorage', 'downloads']) {
    if (!permissions.has(required)) fail(`manifest 缺少权限：${required}`);
  }
  if (manifest.host_permissions?.length) fail('manifest 不应声明 host_permissions（TBAS 不读取网页内容）');
  if (manifest.content_scripts?.length) fail('manifest 不应声明 content_scripts');
  if (permissions.has('scripting')) fail('manifest 不应申请 scripting 权限');
  if (manifest.background?.service_worker !== 'background.js') fail('background service worker 必须指向 background.js');
  if (!manifest.action?.default_icon) fail('action 缺少图标');
  if (!manifest.icons) fail('缺少 icons');

  const iconPaths = new Set([
    ...Object.values(manifest.icons || {}),
    ...Object.values(manifest.action?.default_icon || {}),
  ]);
  for (const icon of iconPaths) {
    const file = join(root, 'extension', icon);
    if (!existsSync(file)) {
      fail(`缺少图标：${icon}`);
      continue;
    }
    const signature = readFileSync(file).subarray(0, 8).toString('hex');
    if (signature !== '89504e470d0a1a0a') fail(`图标不是有效 PNG：${icon}`);
  }

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (packageJson.version !== manifest.version) {
    fail(`版本不一致：package.json ${packageJson.version} vs manifest ${manifest.version}`);
  }

  const requiredFiles = [
    'dashboard.html',
    'dashboard.css',
    'dashboard.js',
    'background.js',
    'storage.js',
    'demo.json',
    'lib/core.js',
    'lib/engine.js',
  ];
  for (const file of requiredFiles) {
    if (!existsSync(join(root, 'extension', file))) fail(`扩展缺少文件：${file}`);
  }
  note(`扩展 ${manifest.name} v${manifest.version}`);
}

/* ---------------- demo data ---------------- */

const demoPath = join(root, 'extension', 'demo.json');
if (existsSync(demoPath)) {
  const parsed = parseSnapshotText(readFileSync(demoPath, 'utf8'), { filename: 'demo.json' });
  if (!parsed.ok) fail(`demo.json 无效：${parsed.errors.join('；')}`);
  else {
    if (parsed.snapshots.length !== 2) fail(`demo.json 应包含 2 个快照，实际 ${parsed.snapshots.length}`);
    for (const snapshot of parsed.snapshots) {
      if (snapshot.schema !== SNAPSHOT_SCHEMA) fail(`demo 快照 schema 错误：${snapshot.id}`);
      if (!snapshot.stats?.tabs) fail(`demo 快照没有标签：${snapshot.id}`);
    }
    note(`示例数据：${parsed.snapshots.map((snapshot) => `${snapshot.name}(${snapshot.stats.tabs})`).join(' · ')}`);
  }
}

/* ---------------- extension code hygiene ---------------- */

const dashboardJs = join(root, 'extension', 'dashboard.js');
if (existsSync(dashboardJs)) {
  const source = readFileSync(dashboardJs, 'utf8');
  if (/\beval\s*\(/.test(source) || /new\s+Function\s*\(/.test(source)) {
    fail('dashboard.js 不应使用 eval / new Function');
  }
  if (/https?:\/\//.test(source)) warn('dashboard.js 中出现外部 URL，请确认不是网络请求');
}

for (const file of ['dashboard.html', 'dashboard.css', 'background.js']) {
  const path = join(root, 'extension', file);
  if (!existsSync(path)) continue;
  const source = readFileSync(path, 'utf8');
  if (/https?:\/\//.test(source)) warn(`${file} 中出现外部 URL，请确认不是外部资源`);
}

const cliPath = join(root, 'bin', 'tbas.mjs');
if (!existsSync(cliPath)) fail('缺少 bin/tbas.mjs');
else {
  const source = readFileSync(cliPath, 'utf8');
  if (!source.startsWith('#!/usr/bin/env node')) fail('bin/tbas.mjs 缺少 shebang');
  if (/\brequire\s*\(/.test(source)) fail('bin/tbas.mjs 应使用 ESM import');
}

const extensionBytes = files
  .filter((file) => file.startsWith(join(root, 'extension')))
  .reduce((sum, file) => sum + statSync(file).size, 0);
note(`扩展体积 ${(extensionBytes / 1024).toFixed(1)} KB`);
if (extensionBytes > 500 * 1024) warn('扩展体积超过 500 KB');

/* ---------------- report ---------------- */

console.log('TBAS static check');
console.log('');
for (const message of notes) console.log(`  · ${message}`);
for (const message of warnings) console.log(`  ! ${message}`);
if (errors.length) {
  console.error('');
  for (const message of errors) console.error(`  ✗ ${message}`);
  console.error('');
  console.error(`FAILED: ${errors.length} 个错误`);
  process.exit(1);
}
console.log('');
console.log(`PASSED${warnings.length ? `（${warnings.length} 个警告）` : ''}`);
