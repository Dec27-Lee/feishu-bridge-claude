'use strict';

// 重启桥接。给配置页的「保存并重启」用。
//
// 为什么值得做这件事：配置只在桥接启动时解析一次，保存完不重启等于没生效。
// 而配置页的使用场景里，人往往不在电脑前（这个项目就是为这个场景写的）——
// 让他去终端敲两条命令，等于让他在手机上做一件做不到的事。
//
// 但一键重启有真实风险：**重启失败就等于桥接彻底没了**，远程场景下再也没法从手机
// 把它叫回来。所以有一条硬性前提：
//
//   **只重启配置能通过校验的桥接。**
//
// 配置写坏时（JSON 语法错、越界值），新进程会起来就挂；老进程已经停掉，
// 结果就是从「改错一个值」变成「整台机器失联」。所以入口先跑一遍与桥接启动时
// 完全相同的 resolveAll，有错直接拒绝，让用户先把配置改对。
//
// 停与起的顺序，以及每一步的探测方式都在下面写清楚了；不依赖开机自启是否安装——
// 有人就是手敲 node kernel/index.js 在跑。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LIB = require('../../kernel/lib');

const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'kernel', 'index.js');
const LOCK = path.join(LIB.DATA_DIR, 'bridge.pid');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPid() {
  try { return parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10) || null; } catch (_) { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try {
    return !!require('../../platform').pidAlive(pid);
  } catch (_) {
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
  }
}

async function waitGone(pid, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await sleep(200);
  }
  return !alive(pid);
}

async function waitUp(prevPid, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const pid = readPid();
    // 要的是「**新**进程写下的锁」：老进程的锁文件可能还没被清掉，
    // 只看存在性会立刻误判成「起来了」。
    if (pid && pid !== prevPid && alive(pid)) return pid;
    await sleep(200);
  }
  return null;
}

// 停掉一个进程。Windows 上没有 SIGTERM 的优雅语义（Node 会走 TerminateProcess），
// 所以这里不做「先礼后兵」的分支——两种平台都是直接结束，再靠新实例接管残留锁
// （kernel/daemon.js 的 acquireLock 本来就是按这个前提写的）。
function stop(pid) {
  try { process.kill(pid, 'SIGTERM'); return true; } catch (_) { return false; }
}

// 起一个新进程。detached + unref：配置页关掉、终端关掉，桥接都还在。
function start() {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

// 重启前先确认「磁盘上的配置能让桥接起来」。有错就不动，返回错误让人先改。
function configProblem() {
  try {
    const CONFIG = require('../../kernel/config');
    const PLUGIN = require('../../kernel/plugin');
    const byId = {};
    for (const m of PLUGIN.discover()) byId[m.id] = m;
    const raw = LIB.readConfig();
    if (raw._missing) return '还没有 config.json，先保存一次配置';
    const r = CONFIG.resolveAll(byId, raw);
    return r.errors.length ? `配置有错，重启后会起不来：${r.errors.join('；')}` : null;
  } catch (e) {
    return `读配置失败：${e.message}`;
  }
}

// 返回 { ok, wasRunning, oldPid, pid, errors }
async function restartBridge(opts = {}) {
  const bad = configProblem();
  if (bad) return { ok: false, wasRunning: alive(readPid()), oldPid: readPid(), pid: null, errors: [bad] };

  if (!fs.existsSync(ENTRY)) {
    return { ok: false, errors: [`找不到 ${ENTRY}`], wasRunning: false, oldPid: null, pid: null };
  }

  const oldPid = readPid();
  const wasRunning = alive(oldPid);

  if (wasRunning) {
    stop(oldPid);
    const gone = await waitGone(oldPid, opts.stopTimeoutMs || 10000);
    if (!gone) {
      // 停不掉就别起新的：两个实例抢同一个飞书长连接，消息会随机漏
      return {
        ok: false, wasRunning, oldPid, pid: null,
        errors: [`进程 ${oldPid} 在 10 秒内没有退出，已放弃重启。请手动结束它再启动。`],
      };
    }
  }

  // 老进程的锁文件可能残留（Windows 强杀不会跑退出钩子）。
  // 留着也无妨——新实例会接管它；清掉只是让「等它起来」这一步更干净。
  if (readPid() === oldPid) {
    try { fs.unlinkSync(LOCK); } catch (_) {}
  }

  try {
    start();
  } catch (e) {
    return { ok: false, wasRunning, oldPid, pid: null, errors: [`启动失败：${e.message}`] };
  }

  const pid = await waitUp(oldPid, opts.startTimeoutMs || 20000);
  if (!pid) {
    return {
      ok: false, wasRunning, oldPid, pid: null,
      errors: ['新进程 20 秒内没有注册成功。看 logs/error.log，或手动运行 node kernel/index.js。'],
    };
  }
  return { ok: true, wasRunning, oldPid, pid, errors: [] };
}

module.exports = { restartBridge, configProblem, readPid, alive };
