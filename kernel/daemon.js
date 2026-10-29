'use strict';

// 进程级设施：单实例锁、飞书事件消费者、定期清理。
// 这些与业务无关（内核自己就要保证只有一个实例在跑），所以放在内核而非插件里。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const lib = require('./lib');
const platform = require('../platform');

const LOCK_FILE = path.join(lib.DATA_DIR, 'bridge.pid');

// 单实例保护：同一飞书应用多个长连接会被随机分流，表现是「消息时有时无」。
//
// 判断旧 pid 时必须真的确认它活着：Windows 上被强杀（或任务管理器结束）的进程
// 拿不到 SIGTERM，我们的退出钩子不会跑，pid 文件就会残留。只看「文件里有别的 pid
// 就退出」会导致桥接再也起不来。
//
// 但**「那个 pid 上是个 node」还不够**：重启后 pid 会被系统复用，新拿到同一个号码的
// 很可能是别的 node（vite、MCP server、隔壁 Claude 窗口）。这时桥接会一直以为自己
// 已经在跑，于是永远起不来、看门狗也救不了——现象就是「手机发的消息进不来、
// 状态卡也没了」，而且日志里只有一句「已有实例在运行」，看不出是误判。
// 所以再看一眼命令行：它必须真的是本项目的 kernel/index.js。
function acquireLock() {
  lib.ensureDirs();
  try {
    const old = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (old && old !== process.pid && platform.pidAlive(old)) {
      // pidAlive 只回答「是不是 node 还活着」，这里补上「是不是我们的桥接」。
      // 读命令行要 1 秒上下（Windows 上只有 PowerShell CIM 能给），
      // 所以只在启动时做这一次，不进任何热路径。
      const cmd = platform.commandLineOf ? platform.commandLineOf(old) : null;
      const isOurs = cmd === null || /kernel[\\/]index\.js/i.test(cmd);
      if (isOurs) return { ok: false, pid: old };
      lib.log('bridge', `锁里的 pid=${old} 已被别的进程复用（${cmd.slice(0, 80)}），接管`);
    } else if (old && old !== process.pid) {
      lib.log('bridge', `接管残留的锁（旧 pid=${old} 已不在）`);
    }
  } catch (_) {}
  fs.writeFileSync(LOCK_FILE, String(process.pid), 'utf8');
  return { ok: true };
}

function releaseLock() {
  try {
    const cur = parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10);
    if (cur === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

// 记录本进程的 pid 到任意子进程，方便退出时一并回收
function livePids() {
  try {
    return parseInt(fs.readFileSync(LOCK_FILE, 'utf8').trim(), 10) || null;
  } catch (_) {
    return null;
  }
}

// 订阅一个飞书事件。lark-cli 退出就退避重启——卡回调未配置时它会以 code=2 立刻退出，
// 不退避就会变成死循环刷日志。
function startConsumer(eventKey, handler, tag, retryMs = 5000) {
  let child = null;
  let stopped = false;

  const launch = () => {
    if (stopped) return;
    const cfg = lib.readConfig();
    const bin = cfg.larkCli || 'lark-cli';

    // 用 consume 而不是 listen；stdin 必须保持打开（'pipe'），
    // 否则 lark-cli 会因 stdin EOF 立刻退出，表现成「反复重启」。
    child = spawn(bin, ['event', 'consume', eventKey, '--as', 'bot'], {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
    });

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (_) { continue; }
        // 处理函数可能是 async，必须接住它的 rejection，否则会变成 unhandledRejection
        try {
          const r = handler(ev);
          if (r && typeof r.catch === 'function') {
            r.catch((e) => lib.log('error', `${tag} 处理事件失败: ${e.stack || e.message}`));
          }
        } catch (e) {
          lib.log('error', `${tag} 处理事件失败: ${e.stack || e.message}`);
        }
      }
    });

    child.stderr.on('data', (d) => {
      const s = d.toString('utf8').trim();
      if (!s) return;
      // 回调未在开发者后台订阅时会刷屏报这个，只提示一次，别把日志冲垮
      if (s.includes('requires callbacks not subscribed')) {
        if (!startConsumer.cardWarned) {
          startConsumer.cardWarned = true;
          lib.log('error', `${eventKey} 未在开发者后台「事件与回调 → 回调配置」中订阅，卡片按钮暂时无法响应。订阅后自动恢复。`);
        }
        return;
      }
      lib.log('bridge', `[${tag}] ${s.slice(0, 500)}`);
    });

    child.on('exit', (code) => {
      if (stopped) return;
      lib.log('bridge', `${tag} 退出 code=${code}，${Math.round(retryMs / 1000)} 秒后重启`);
      setTimeout(launch, retryMs);
    });
  };

  launch();

  return {
    kill() {
      stopped = true;
      try { child.kill(); } catch (_) {}
    },
  };
}

// 过期数据回收
function runCleanup(tag) {
  try {
    const rep = lib.cleanup();
    lib.log('bridge', `${tag}清理：图片 ${rep.images}、会话 ${rep.sessions}、映射 ${rep.mappings}、日志 ${rep.logs}`);
  } catch (e) {
    lib.log('error', `${tag}清理失败: ${e.message}`);
  }
}

module.exports = { LOCK_FILE, acquireLock, releaseLock, livePids, startConsumer, runCleanup };
