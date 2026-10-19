import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const CLI = join(root, 'bin', 'tbas.mjs');
const DEMO_BUNDLE = join(root, 'extension', 'demo.json');

function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'tbas-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

function run(args, { home, cwd } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd || home,
    env: { ...process.env, TBAS_HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 30000,
  });
  return result;
}

function expectOk(result) {
  assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

test('demo creates two snapshots and list/show expose them', (t) => {
  const home = makeHome(t);
  const demo = run(['demo'], { home });
  expectOk(demo);
  assert.match(demo.stdout, /示例 · 办公周五归档/);
  assert.match(demo.stdout, /示例 · 周末个人/);
  assert.equal(existsSync(join(home, 'snapshots', 'demo-office-v1.json')), true);
  assert.equal(existsSync(join(home, 'snapshots', 'demo-home-v1.json')), true);

  const list = run(['list'], { home });
  expectOk(list);
  assert.match(list.stdout, /demo-office-v1/);
  assert.match(list.stdout, /demo-home-v1/);
  assert.match(list.stdout, /demo-office-v1.*18/);

  const json = run(['list', '--json'], { home });
  const entries = JSON.parse(json.stdout);
  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.id === 'demo-office-v1').stats.tabs, 18);

  const env = run(['list', '--env', '个人'], { home });
  assert.match(env.stdout, /demo-home-v1/);
  assert.equal(env.stdout.includes('demo-office-v1'), false);
});

test('show renders the group tree, JSON, markdown and URL list', (t) => {
  const home = makeHome(t);
  run(['demo'], { home });

  const tree = run(['show', 'demo-office-v1'], { home });
  expectOk(tree);
  assert.match(tree.stdout, /项目 · 客户门户/);
  assert.match(tree.stdout, /周报素材/);
  assert.match(tree.stdout, /edge:\/\/settings\/profiles/);
  assert.match(tree.stdout, /\[P\*\]/);

  const json = JSON.parse(run(['show', 'demo-office-v1', '--json'], { home }).stdout);
  assert.equal(json.windows.length, 2);
  assert.equal(json.stats.groups, 5);

  const urls = run(['show', 'demo-office-v1', '--urls'], { home });
  expectOk(urls);
  assert.equal(urls.stdout.includes('edge://settings'), false);
  assert.equal(urls.stdout.trim().split('\n').length, 17);

  const markdown = run(['show', 'demo-office-v1', '--md'], { home });
  expectOk(markdown);
  assert.match(markdown.stdout, /^# 示例 · 办公周五归档/m);
  assert.match(markdown.stdout, /不可恢复/);
});

test('search matches group names and URLs, with JSON output', (t) => {
  const home = makeHome(t);
  run(['demo'], { home });

  const result = run(['search', '周报'], { home });
  expectOk(result);
  assert.match(result.stdout, /周报素材/);
  assert.match(result.stdout, /演示周报模板/);

  const json = JSON.parse(run(['search', 'semanticscholar', '--json', '--limit', '5'], { home }).stdout);
  assert.equal(json.length, 1);
  assert.equal(json[0].matches.length, 1);
  assert.match(json[0].matches[0].tab.url, /semanticscholar/);

  const none = run(['search', 'no-such-thing'], { home });
  expectOk(none);
  assert.match(none.stdout, /没有匹配/);
});

test('stats aggregates snapshots and unique URLs', (t) => {
  const home = makeHome(t);
  run(['demo'], { home });
  const stats = run(['stats'], { home });
  expectOk(stats);
  assert.match(stats.stdout, /快照数量\s+2/);
  assert.match(stats.stdout, /标签页\s+28/);
  assert.match(stats.stdout, /唯一网址\s+27/);
  assert.match(stats.stdout, /环境分布\s+个人 1 · 办公 1/);

  const json = JSON.parse(run(['stats', '--json'], { home }).stdout);
  assert.equal(json.snapshots, 2);
  assert.equal(json.tabs, 28);
  assert.equal(json.duplicates, 1);
});

test('export writes HTML, Markdown, JSON and URL files', (t) => {
  const home = makeHome(t);
  run(['demo'], { home });

  const htmlPath = join(home, 'office.html');
  const html = run(['export', 'demo-office-v1', '--html', htmlPath], { home });
  expectOk(html);
  assert.equal(existsSync(htmlPath), true);
  const htmlText = readFileSync(htmlPath, 'utf8');
  assert.match(htmlText, /^<!doctype html>/);
  assert.match(htmlText, /TBAS · 示例 · 办公周五归档/);
  assert.match(htmlText, /data-snapshot/);

  const mdPath = join(home, 'office.md');
  expectOk(run(['export', 'demo-office-v1', '--md', mdPath], { home }));
  assert.match(readFileSync(mdPath, 'utf8'), /# 示例 · 办公周五归档/);

  const jsonPath = join(home, 'office.json');
  expectOk(run(['export', 'demo-office-v1', '--json', jsonPath], { home }));
  const snapshot = JSON.parse(readFileSync(jsonPath, 'utf8'));
  assert.equal(snapshot.id, 'demo-office-v1');

  const urlsPath = join(home, 'office.txt');
  expectOk(run(['export', 'demo-office-v1', '--urls', urlsPath], { home }));
  assert.equal(readFileSync(urlsPath, 'utf8').trim().split('\n').length, 17);
});

test('report generates a standalone HTML file and honours environment filtering', (t) => {
  const home = makeHome(t);
  run(['demo'], { home });

  const out = join(home, 'report.html');
  const result = run(['report', '--out', out], { home });
  expectOk(result);
  const html = readFileSync(out, 'utf8');
  assert.match(html, /示例 · 办公周五归档/);
  assert.match(html, /示例 · 周末个人/);
  assert.match(html, /data-env="office"/);
  assert.equal(html.includes('<link '), false);

  const homeOnly = join(home, 'home.html');
  expectOk(run(['report', '--out', homeOnly, '--env', '个人'], { home }));
  const homeHtml = readFileSync(homeOnly, 'utf8');
  assert.match(homeHtml, /示例 · 周末个人/);
  assert.equal(homeHtml.includes('示例 · 办公周五归档'), false);
});

test('open --dry-run prints Edge commands and respects group selection', (t) => {
  const home = makeHome(t);
  run(['demo'], { home });

  const all = run(['open', 'demo-office-v1', '--dry-run'], { home });
  expectOk(all);
  assert.match(all.stdout, /将打开 16 个标签/);
  assert.match(all.stdout, /已跳过 1 个重复网址/);
  assert.match(all.stdout, /不会恢复分组/);
  assert.match(all.stdout, /open -a .*Microsoft Edge/);

  const group = run(['open', 'demo-office-v1', '--group', '项目', '--dry-run'], { home });
  expectOk(group);
  assert.match(group.stdout, /将打开 3 个标签/);
  assert.match(group.stdout, /已跳过 1 个重复网址/);
  assert.match(group.stdout, /DEMO-10895/);
  assert.equal(group.stdout.includes('outlook.office.com'), false);
});

test('rm requires --yes and import restores exported snapshots', (t) => {
  const home = makeHome(t);
  run(['demo'], { home });
  const exported = join(home, 'office.json');
  run(['export', 'demo-office-v1', '--json', exported], { home });

  const refused = run(['rm', 'demo-office-v1'], { home });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--yes/);
  assert.equal(existsSync(join(home, 'snapshots', 'demo-office-v1.json')), true);

  expectOk(run(['rm', 'demo-office-v1', '--yes'], { home }));
  assert.equal(existsSync(join(home, 'snapshots', 'demo-office-v1.json')), false);

  const imported = run(['import', exported], { home });
  expectOk(imported);
  assert.match(imported.stdout, /导入完成：1 个新快照/);

  const list = JSON.parse(run(['list', '--json'], { home }).stdout);
  assert.equal(list.length, 2);
  assert.ok(list.some((entry) => entry.id === 'demo-office-v1'));

  const again = run(['import', exported], { home });
  expectOk(again);
  assert.match(again.stdout, /已存在，跳过 1 个/);
});

test('import accepts a bundle and resolves duplicate IDs with --replace', (t) => {
  const home = makeHome(t);

  const first = run(['import', DEMO_BUNDLE], { home });
  expectOk(first);
  assert.match(first.stdout, /导入完成：2 个新快照/);

  const second = run(['import', DEMO_BUNDLE], { home });
  expectOk(second);
  assert.match(second.stdout, /已存在，跳过 2 个/);

  const replaced = run(['import', DEMO_BUNDLE, '--replace'], { home });
  expectOk(replaced);
  assert.match(replaced.stdout, /导入完成：2 个新快照/);
});

test('scan imports files from a backup directory', (t) => {
  const home = makeHome(t);
  const backup = join(home, 'backup', 'nested');
  mkdirSync(backup, { recursive: true });
  copyFileSync(join(root, 'extension', 'demo.json'), join(backup, 'bundle.json'));

  const result = run(['scan', '--dir', join(home, 'backup')], { home });
  expectOk(result);
  assert.match(result.stdout, /新增 2 个快照/);

  const list = JSON.parse(run(['list', '--json'], { home }).stdout);
  assert.equal(list.length, 2);
});

test('doctor and help report a healthy install', (t) => {
  const home = makeHome(t);
  const doctor = run(['doctor'], { home });
  expectOk(doctor);
  assert.match(doctor.stdout, /Node\.js/);
  assert.match(doctor.stdout, /扩展文件完整性/);
  assert.match(doctor.stdout, /核心检查通过/);

  const json = JSON.parse(run(['doctor', '--json'], { home }).stdout);
  assert.ok(Array.isArray(json));
  assert.ok(json.some((check) => check.label === '扩展版本'));

  const help = run(['help'], { home });
  expectOk(help);
  assert.match(help.stdout, /tbas <命令>/);
  assert.match(help.stdout, /report/);
  assert.match(help.stdout, /edge:\/\/extensions/);

  const version = run(['--version'], { home });
  expectOk(version);
  assert.match(version.stdout, /^0\.1\.0/);
});

test('unknown commands and missing arguments fail cleanly', (t) => {
  const home = makeHome(t);
  const unknown = run(['nope'], { home });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /未知命令：nope/);

  const noShow = run(['show'], { home });
  assert.equal(noShow.status, 2);
  assert.match(noShow.stderr, /用法/);

  const missing = run(['show', 'not-a-real-id'], { home });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /找不到快照/);
});

test('demo --out writes snapshots to a custom directory', (t) => {
  const home = makeHome(t);
  const outDir = join(home, 'custom');
  const result = run(['demo', '--out', outDir], { home });
  expectOk(result);
  assert.equal(existsSync(join(outDir, 'demo-office-v1.json')), true);
  assert.equal(existsSync(join(outDir, 'demo-home-v1.json')), true);
});
