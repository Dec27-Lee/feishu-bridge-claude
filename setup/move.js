'use strict';

// 把整个项目搬到另一个目录，并把所有「指向旧位置」的东西一起改过来。
//
//   node setup/move.js <新目录>               演练：只说要做什么，不动任何东西
//   node setup/move.js <新目录> --yes          真的搬
//   node setup/move.js <新目录> --yes --no-start      搬完不自动启动（手动起）
//   node setup/move.js <新目录> --yes --delete-old   搬完并删掉旧目录
//
// 为什么必须有这个工具：这个项目不是「装在别处的程序」，**它自己就是运行时**。
// 项目根目录的绝对路径被写进了四个地方，手工搬文件夹会留下四份指向旧位置的记录：
//
//   1. ~/.claude/settings.json 的 hooks          —— CLI 会去执行不存在的脚本
//   2. cc-switch 每个服务商的 settings_config    —— 切服务商后 hooks 全失效
//   3. 开机自启（启动文件夹 / launchd / systemd）—— 每次开机拉起旧位置的代码
//   4. 正在跑的进程（bridge、在场采样器、watch-bridge.vbs）—— 占着旧目录
//
// 漏改任何一处，症状都是「看起来还在跑，改代码却没反应」——最难查的那一类。
//
// 搬运顺序刻意做成「先停 → 再复制 → 再改指向 → 最后才删旧」：
// 复制阶段旧目录始终完整，任何一步失败都能退回去。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const platform = require('../platform');

const ARGS = process.argv.slice(2);
const YES = ARGS.includes('--yes');
const DELETE_OLD = ARGS.includes('--delete-old');
const DRY = !YES;
const TARGET = ARGS.find((a) => !a.startsWith('--'));

function say(msg) { console.log(msg); }
function step(msg) { console.log(`\n=== ${msg} ===`); }
function die(msg) { console.error(`\n✗ ${msg}`); process.exit(1); }

// ---- 1. 前置检查 ----

function preflight() {
  if (!TARGET) die('用法：node setup/move.js <新目录> [--yes] [--delete-old]');

  const dst = path.resolve(TARGET);
  const src = ROOT;
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();

  if (norm(dst) === norm(src)) die('新目录和当前目录一样，不用搬。');
  if (norm(dst).startsWith(norm(src) + '/')) die('新目录不能在当前目录里面。');
  if (norm(src).startsWith(norm(dst) + '/')) die('新目录不能是当前目录的上级。');

  if (fs.existsSync(dst)) {
    const entries = fs.readdirSync(dst);
    if (entries.length) die(`新目录已存在且非空：${dst}\n  换一个位置，或先把它清空。`);
  }

  // 同盘复制快很多，但跨盘也行——这里只提示，不阻止
  const sameDrive = path.parse(dst).root.toLowerCase() === path.parse(src).root.toLowerCase();

  return { src, dst, sameDrive };
}

// ---- 2. 停掉旧位置的所有进程 ----

// 必须连 watch-bridge.vbs 一起停。它是「bridge 挂了就拉起来」的守护进程，
// 只杀 node 的话，5 秒后它会把旧位置的代码又拉起来，搬运就成了拉锯。
function procsFromRoot(root) {
  const key = root.replace(/\\/g, '/').toLowerCase();
  const out = [];
  try {
    if (process.platform === 'win32') {
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress',
      ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      const raw = (ps.stdout || '').trim();
      if (!raw) return out;
      for (const p of [].concat(JSON.parse(raw))) {
        if (!p || !p.ProcessId || p.ProcessId === process.pid) continue;
        if (String(p.CommandLine || '').replace(/\\/g, '/').toLowerCase().includes(key)) {
          out.push({ pid: p.ProcessId, cmd: String(p.CommandLine || '').slice(0, 120) });
        }
      }
    } else {
      const ps = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 15000 });
      for (const line of (ps.stdout || '').split('\n')) {
        if (!line.replace(/\\/g, '/').toLowerCase().includes(key)) continue;
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (!pid || pid === process.pid) continue;
        out.push({ pid, cmd: line.trim().slice(0, 120) });
      }
    }
  } catch (_) {}
  return out;
}

function stopEverything(src) {
  const procs = procsFromRoot(src);
  if (!procs.length) {
    say('  没有正在运行的进程');
    return [];
  }
  procs.forEach((p) => say(`  停止 pid=${p.pid}  ${p.cmd}`));
  if (DRY) return procs;

  for (const p of procs) {
    try { process.kill(p.pid); } catch (_) {}
  }
  // 采样器是 detached 的，普通 kill 不保证收干净，再按 platform 的口径补一刀
  try { if (platform.stopAllPresence) platform.stopAllPresence(); } catch (_) {}

  // 等它们真的退出：Windows 上终结和退出之间有时间差，
  // 不等就复制，会复制到还在写的日志和半截的 pid 文件。
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && procsFromRoot(src).length) {
    spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'sleep',
      process.platform === 'win32' ? ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'] : ['0.3'],
      { timeout: 5000, windowsHide: true });
  }
  const left = procsFromRoot(src);
  if (left.length) {
    left.forEach((p) => say(`  ! 仍在运行 pid=${p.pid}  ${p.cmd}`));
    die('有进程停不掉（可能是权限或子进程）。手动结束它们后重试。');
  }
  return procs;
}

// ---- 3. 复制 ----

function copyTree(src, dst) {
  say(`  ${src}`);
  say(`  → ${dst}`);
  if (DRY) return;

  fs.mkdirSync(dst, { recursive: true });
  // 用 fs.cpSync 而不是调 robocopy/cp：三个平台行为一致，不依赖外部命令
  fs.cpSync(src, dst, {
    recursive: true,
    force: true,
    // 旧位置的运行态残留：pid 指向上一个进程，采样文件是旧的，带过去只会误导
    filter: (p) => {
      const rel = path.relative(src, p).replace(/\\/g, '/');
      return rel !== 'data/bridge.pid' && rel !== 'data/presence.json';
    },
  });
}

function sanity(dst, src) {
  // 复制完先核对几个关键文件，别等改完指向才发现少了东西
  const must = ['kernel/index.js', 'setup/install.js', 'package.json',
    'plugins/core/plugin.json', `platform/${platform.name}`];
  const missing = must.filter((f) => !fs.existsSync(path.join(dst, f)));
  if (missing.length) die(`复制不完整，缺：${missing.join(', ')}`);

  const count = (dir, ext) => {
    try { return fs.readdirSync(path.join(dir, 'plugins')).length; } catch (_) { return -1; }
  };
  if (count(dst) !== count(src)) die('插件目录数量对不上，复制不完整。');
}

// ---- 4. 把四处指向改到新位置 ----

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd: cwd || ROOT, encoding: 'utf8', timeout: 180000, windowsHide: true });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  out.split('\n').filter(Boolean).forEach((l) => say(`  ${l}`));
  return r.status === 0;
}

function rewire(dst) {
  const installJs = path.join(dst, 'setup', 'install.js');
  if (!fs.existsSync(installJs)) die(`新位置没有 setup/install.js`);

  // hooks 与 cc-switch：hooks-config 会先摘掉「本项目旧位置的条目」再加入新的，
  // 所以这里不需要手工判断旧路径长什么样——项目被搬过几次都能收拾干净。
  say('  hooks + cc-switch：');
  if (!run(process.execPath, [installJs, '--hooks', '--cc-switch', '--yes'], dst)) {
    die('改 hooks / cc-switch 失败。旧目录仍然完整，可以退回。');
  }

  say('  开机自启：');
  if (!run(process.execPath, [installJs, '--autostart', '--yes'], dst)) {
    say('  ! 自启安装失败（不影响手动启动）');
  }
}

// ---- 5. 在新位置启动 ----

function startAt(dst) {
  say('  启动新位置的 bridge：');
  try {
    if (process.platform === 'win32') {
      const watch = path.join(dst, 'platform', 'win32', 'watch-bridge.vbs');
      // 必须 detached + unref：watch-bridge.vbs 是常驻守护进程（循环拉起 bridge），
      // 永远不退出。用 spawnSync 会把它自己卡在这里直到超时。
      const c = spawn('wscript.exe', ['//B', '//Nologo', watch], {
        cwd: dst, detached: true, stdio: 'ignore', windowsHide: true,
      });
      c.unref();
    } else if (process.platform === 'darwin') {
      spawnSync('launchctl', ['start', 'com.feishu.bridge.claude'], { timeout: 30000 });
    } else {
      spawnSync('systemctl', ['--user', 'start', 'feishu-bridge.service'], { timeout: 30000 });
    }
    say('  已发出启动命令');
  } catch (e) {
    say(`  ! 启动失败：${e.message}（手动跑 node kernel/index.js）`);
  }
}

function waitPid(dst) {
  const pidFile = path.join(dst, 'data', 'bridge.pid');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      if (pid && platform.pidAlive(pid)) return pid;
    } catch (_) {}
    spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'sleep',
      process.platform === 'win32' ? ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'] : ['0.4'],
      { timeout: 5000, windowsHide: true });
  }
  return null;
}

// ---- 主流程 ----

function main() {
  const { src, dst, sameDrive } = preflight();

  say(`feishu-bridge-claude 目录迁移${DRY ? '（演练，不会改动任何东西）' : ''}`);
  say(`  从：${src}`);
  say(`  到：${dst}`);
  if (!sameDrive) say('  （跨盘复制，会慢一些，正常）');

  step('1. 停掉旧位置的进程');
  say('  包括 bridge、在场采样器，以及 watch-bridge.vbs ——');
  say('  不杀守护进程的话，它会在 5 秒后把旧位置的代码重新拉起来。');
  stopEverything(src);

  step('2. 停止旧位置的开机自启');
  const auto = platform.autostart || {};
  if (auto.remove) {
    say(`  ${auto.remove}`);
    if (!DRY) {
      const isPs = /\.ps1$/i.test(auto.remove);
      spawnSync(isPs ? 'powershell.exe' : 'bash',
        isPs ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(auto.remove)]
          : [path.resolve(auto.remove)],
        { encoding: 'utf8', timeout: 60000, windowsHide: true });
    }
  } else {
    say('  本平台没有自启方案，跳过');
  }

  step('3. 复制到新位置');
  copyTree(src, dst);
  if (!DRY) {
    sanity(dst, src);
    // 旧位置的数据被复制过来了，但要重新指认所有权
    fs.writeFileSync(path.join(dst, '.moved-from'), `${src}\n${new Date().toISOString()}\n`, 'utf8');
    say('  复制完成，关键文件核对通过');
  }

  step('4. 改指向（hooks / cc-switch / 自启）');
  if (DRY) {
    say('  将执行：node setup/install.js --hooks --cc-switch --yes');
    say('  将执行：node setup/install.js --autostart --yes');
  } else {
    rewire(dst);
  }

  step('5. 在新位置启动');
  if (DRY) {
    say('  将启动新位置的 bridge 并等待 pid 落盘');
  } else {
    startAt(dst);
    const pid = waitPid(dst);
    if (!pid) {
      say('  ! 15 秒内没等到 bridge 起来');
      say(`    手动排查：cd ${dst} && node kernel/index.js`);
    } else {
      say(`  ✓ bridge 已启动 pid=${pid}`);
    }
  }

  step('6. 体检');
  if (DRY) {
    say('  将执行：node setup/verify.js');
  } else {
    run(process.execPath, [path.join(dst, 'setup', 'verify.js')], dst);
  }

  step('结果');
  if (DRY) {
    say('  这是演练，什么都没改。确认无误后加 --yes 再跑一次。');
    return;
  }

  say(`  ✓ 新位置：${dst}`);
  say(`  ✓ hooks / cc-switch / 自启 都已指向新位置`);
  say('');
  if (DELETE_OLD) {
    // 删除是不可逆的，先确认新位置真的跑起来了
    const pid = (() => {
      try { return parseInt(fs.readFileSync(path.join(dst, 'data', 'bridge.pid'), 'utf8').trim(), 10); } catch (_) { return null; }
    })();
    if (!pid || !platform.pidAlive(pid)) {
      die(`新位置没有在运行，不敢删旧目录。旧目录仍完整保留在 ${src}`);
    }
    try {
      fs.rmSync(src, { recursive: true, force: true });
      say(`  ✓ 已删除旧目录 ${src}`);
      say('    （如果当前终端还在这个目录里，cd 到新位置再继续）');
    } catch (e) {
      say(`  ! 删除旧目录失败：${e.message}`);
      say(`    通常是因为有程序把它当工作目录。手动删：${src}`);
    }
  } else {
    say('  旧目录还在，确认新位置没问题后可以自己删掉：');
    say(`    ${src}`);
    say('  或重跑本命令加 --delete-old 让它删（会先确认新位置真的在跑）。');
  }
}

main();
