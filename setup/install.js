'use strict';

// 安装器。按「先展示、后确认、可回滚」的顺序改系统配置。
//
//   node setup/install.js                 交互式：逐项问你要不要做
//   node setup/install.js --yes           非交互：全部默认项直接做（给 AI 用）
//   node setup/install.js --dry-run       只打印将要改什么，一个字节都不写
//   node setup/install.js --hooks         只装 Claude Code hooks
//   node setup/install.js --cc-switch     只补 cc-switch 各服务商
//   node setup/install.js --build         只编译在场采样器
//   node setup/install.js --autostart     只装开机自启
//
// 设计原则：
//   - 每个写操作都先备份原文件（*.bak-<时间戳>），失败可手工还原
//   - 只增不删：往 settings.json 里加 hook，不动你已有的任何配置
//   - 幂等：重复跑不会重复添加

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

// 自测用：把「用户主目录」指到沙箱，避免动真实配置。
// 生产里不设这个变量，行为与直接用 os.homedir() 完全一致。
const HOME = process.env.FEISHU_INSTALL_HOME || os.homedir();
const ARGS = new Set(process.argv.slice(2));
const YES = ARGS.has('--yes');
const DRY = ARGS.has('--dry-run');
const ONLY = ['--hooks', '--cc-switch', '--build', '--autostart'].filter((a) => ARGS.has(a));
const want = (flag) => ONLY.length === 0 || ARGS.has(flag);

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function backup(file) {
  if (DRY || !fs.existsSync(file)) return null;
  const bak = `${file}.bak-${stamp}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function writeJson(file, obj) {
  if (DRY) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function say(msg) { console.log(msg); }
function step(msg) { console.log(`\n=== ${msg} ===`); }

async function confirm(question, def = true) {
  if (YES) return def;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question(`${question} ${def ? '[Y/n]' : '[y/N]'} `, res));
  rl.close();
  const s = String(ans).trim().toLowerCase();
  if (!s) return def;
  return s === 'y' || s === 'yes';
}

// ---- 1. Claude Code hooks ----

function installHooks() {
  const file = path.join(HOME, '.claude', 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
      throw new Error(`${file} 解析失败：${e.message}`);
    }
  }

  const hooksCfg = require('./hooks-config');
  const { settings: next, added } = hooksCfg.mergeInto(settings);

  // crossSessionInbound 不在就补上：没有它窗口会拒收投递，而且毫无报错
  let inboundNote = '';
  if (next.crossSessionInbound !== 'accept') {
    inboundNote = `crossSessionInbound: ${next.crossSessionInbound || '（未设置）'} → "accept"`;
    next.crossSessionInbound = 'accept';
  }

  if (!added.length && !inboundNote) {
    say('  hooks 已是最新，无需改动');
    return true;
  }

  say('  将要添加：');
  added.forEach((a) => say(`    + ${a}`));
  if (inboundNote) say(`    ~ ${inboundNote}`);

  if (DRY) { say('  （--dry-run：未写入）'); return true; }

  const bak = backup(file);
  writeJson(file, next);
  say(`  已写入 ${file}`);
  if (bak) say(`  原文件备份：${bak}`);
  return true;
}

// ---- 2. cc-switch ----

// cc-switch 切换服务商时，会用库里的 settings_config 整体覆盖 settings.json。
// 所以每个 claude 服务商的配置里都必须带同一份 hooks——漏一个，切到它就全没了。
// 新版本已经去掉了「通用配置」入口，只能逐个改。
function installCcSwitch() {
  const dbFile = path.join(HOME, '.cc-switch', 'cc-switch.db');
  if (!fs.existsSync(dbFile)) {
    say('  未检测到 cc-switch，跳过');
    return true;
  }

  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch (_) {
    say('  当前 Node 版本没有 node:sqlite（需要 ≥ 22.5），跳过。');
    say('  可以手动在每个服务商的配置里加 hooks，内容见 setup/hooks-config.js 的 HOOKS。');
    return false;
  }

  const hooksCfg = require('./hooks-config');
  const db = new DatabaseSync(dbFile);
  const rows = db.prepare("SELECT id, name, settings_config FROM providers WHERE app_type='claude'").all();

  const todo = [];
  for (const r of rows) {
    let sc;
    try { sc = JSON.parse(r.settings_config) || {}; } catch (_) { continue; }
    if (hooksCfg.installed(sc)) continue;
    todo.push({ id: r.id, name: r.name, next: hooksCfg.mergeInto(sc).settings });
  }

  if (!todo.length) {
    say(`  全部 ${rows.length} 个 claude 服务商都已带 hooks，无需改动`);
    db.close();
    return true;
  }

  say(`  共 ${rows.length} 个 claude 服务商，其中 ${todo.length} 个缺 hooks：`);
  todo.forEach((t) => say(`    + ${t.name || t.id}`));

  if (DRY) { say('  （--dry-run：未写入）'); db.close(); return true; }

  const bak = backup(dbFile);
  const update = db.prepare('UPDATE providers SET settings_config = ? WHERE id = ? AND app_type = ?');
  const tx = db.prepare('BEGIN');
  try {
    tx.run();
    for (const t of todo) update.run(JSON.stringify(t.next), t.id, 'claude');
    db.prepare('COMMIT').run();
    say(`  已更新 ${todo.length} 个服务商`);
    if (bak) say(`  数据库备份：${bak}`);
  } catch (e) {
    try { db.prepare('ROLLBACK').run(); } catch (_) {}
    throw e;
  } finally {
    db.close();
  }
  return true;
}

// ---- 3. 编译在场采样器 ----

function buildPresence() {
  const platform = require('../platform');
  if (platform.name !== 'win32') {
    // macOS / Linux 的采样器是随仓库分发的 shell 脚本，不需要编译
    const sh = path.join(ROOT, 'platform', platform.name, 'presence.sh');
    if (fs.existsSync(sh)) {
      say(`  ${platform.name} 用 ${path.relative(ROOT, sh)}（shell 脚本，无需编译）`);
      if (platform.name === 'linux') {
        say('  提示：空闲时长依赖 xprintidle（多数发行版需 apt/dnf install x11-utils 或 xprintidle）');
      }
      return true;
    }
    say(`  ${platform.name} 暂无采样器实现，跳过（判定会退化为「一律推卡片」）`);
    return true;
  }

  const src = path.join(ROOT, 'platform', 'win32', 'presence.cs');
  const out = path.join(ROOT, 'platform', 'win32', 'presence.exe');
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) {
    say(`  已是最新：${out}`);
    return true;
  }

  const csc = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) {
    say(`  找不到 csc.exe（${csc}）。Windows 自带 .NET Framework，通常在这个路径。`);
    say('  没有采样器不影响主体功能，只是提问/权限确认一律推卡片。');
    return false;
  }

  if (DRY) { say(`  （--dry-run：将执行 csc /out:${out} ${src}）`); return true; }

  const r = spawnSync(csc, ['/nologo', '/target:exe', `/out:${out}`, src], {
    encoding: 'utf8', timeout: 120000,
  });
  if (r.status !== 0) {
    say('  编译失败：');
    say(((r.stdout || '') + (r.stderr || '')).slice(0, 1500));
    return false;
  }
  say(`  已编译 ${out}`);
  return true;
}

// ---- 4. 开机自启 ----

function installAutostart() {
  const platform = require('../platform');
  const auto = platform.autostart || {};
  if (!auto.install) {
    say(`  ${platform.name} 暂无自启方案，跳过`);
    return true;
  }

  // auto.install 已经是绝对路径（由 platform/<os>/index.js 用 __dirname 拼好）
  const script = path.resolve(auto.install);
  if (!fs.existsSync(script)) {
    say(`  缺少 ${script}，跳过`);
    return false;
  }
  if (DRY) { say(`  （--dry-run：将执行 ${script}）`); return true; }

  // Windows 的 .ps1 要用 powershell 跑，类 Unix 的 .sh 用 bash 跑
  const isPs = /\.ps1$/i.test(script);
  const cmd = isPs ? 'powershell.exe' : 'bash';
  const args = isPs ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] : [script];
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 90000, windowsHide: true });
  say(((r.stdout || '') + (r.stderr || '')).trim() || `  已执行 ${script}`);
  return r.status === 0;
}

// ---- 主流程 ----

async function main() {
  say(`feishu-bridge-claude 安装器${DRY ? '（dry-run）' : ''}`);
  say(`项目目录：${ROOT}`);

  const results = [];

  if (want('--hooks')) {
    step('1. Claude Code hooks');
    try {
      const ok = await (YES || DRY ? Promise.resolve(true) : confirm('把 hook 写入 ~/.claude/settings.json？')) && installHooks();
      results.push(['hooks', ok]);
    } catch (e) { say(`  失败：${e.message}`); results.push(['hooks', false]); }
  }

  if (want('--cc-switch')) {
    step('2. cc-switch 各服务商');
    say('  切换服务商时 cc-switch 会用库里的配置整体覆盖 settings.json，');
    say('  所以每个服务商都要带同一份 hooks，否则切到哪个就丢哪个。');
    if (YES || DRY || await confirm('逐个补齐？')) {
      try { results.push(['cc-switch', installCcSwitch()]); }
      catch (e) { say(`  失败：${e.message}`); results.push(['cc-switch', false]); }
    }
  }

  if (want('--build')) {
    step('3. 在场采样器');
    try { results.push(['build', buildPresence()]); }
    catch (e) { say(`  失败：${e.message}`); results.push(['build', false]); }
  }

  if (want('--autostart')) {
    step('4. 开机自启');
    if (YES || DRY || await confirm('安装开机自启？')) {
      try { results.push(['autostart', installAutostart()]); }
      catch (e) { say(`  失败：${e.message}`); results.push(['autostart', false]); }
    }
  }

  step('结果');
  for (const [k, ok] of results) say(`  ${ok ? '✓' : '✗'} ${k}`);
  if (DRY) say('\n这是 dry-run，什么都没写。去掉 --dry-run 再跑一次才会真正执行。');
  else say('\n下一步：node setup/check.js 复查，然后 node kernel/index.js 启动。');
}

main().catch((e) => { console.error(e); process.exit(1); });
