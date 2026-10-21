'use strict';

// Windows 实现。
//
// 提供内核要求的五个能力：
//   spawnWindow      cscript + VBS → wt.exe
//   pidAlive         tasklist 名称校验（Windows 上 process.kill 会误报活）
//   startPresence    spawn presence.exe --loop，每秒写一次采样
//   presenceRunning  采样进程还在不在
//   stopPresence     收掉采样进程

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const EXE = path.join(HERE, 'presence.exe');

let presenceChild = null;

module.exports = {
  name: 'win32',
  supportsPresence: true,

  get presenceExe() {
    return fs.existsSync(EXE) ? EXE : null;
  },

  // 采样器还没编译时返回 false：内核据此退到「恒 away」（推卡片），
  // 而不是拿一个不存在的路径去 spawn、然后每分钟失败一次。
  startPresence(file, intervalMs) {
    if (presenceChild && presenceChild.exitCode === null) return true;
    if (!fs.existsSync(EXE)) return false;
    try {
      // detached：bridge 被强杀时采样器不跟着殉葬，由下一个 bridge 重新拉起
      presenceChild = spawn(EXE, ['--loop', file, '--interval', String(intervalMs || 1000)], {
        stdio: 'ignore', windowsHide: true, detached: true,
      });
      presenceChild.unref();
      presenceChild.on('exit', () => { presenceChild = null; });
      return true;
    } catch (_) {
      presenceChild = null;
      return false;
    }
  },

  presencePid() {
    return presenceChild ? presenceChild.pid : null;
  },

  presenceRunning() {
    return !!(presenceChild && presenceChild.exitCode === null && !presenceChild.killed);
  },

  stopPresence() {
    try { if (presenceChild) presenceChild.kill(); } catch (_) {}
    presenceChild = null;
  },

  // 新开一个 Windows Terminal 窗口跑 claude。
  // VBS 负责两件事：清空继承来的 CLAUDECODE / *_SESSION_ID 等环境变量
  // （否则新窗口会关掉转录保存、或把 inbox 指到错误的会话上），以及 cd 到目标目录。
  spawnWindow({ sessionId, cwd, resumeId }) {
    const vbs = path.join(HERE, 'launch-claude.vbs');
    if (!fs.existsSync(vbs)) throw new Error(`缺少 ${vbs}`);
    const args = ['//nologo', vbs, sessionId, cwd];
    if (resumeId) args.push(resumeId);
    spawn('cscript.exe', args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return true;
  },

  // Windows 上被强杀的进程句柄回收有延迟，process.kill(pid, 0) 可能仍报「活着」。
  // 所以再核对一次 tasklist 里的进程名，避免把死掉的旧 pid 当成还在跑。
  pidAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
    } catch (_) {
      return false;
    }
    try {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      const text = (out.stdout || '').toLowerCase();
      return text.includes(String(pid)) && text.includes('node');
    } catch (_) {
      return true; // tasklist 不可用时只能相信 process.kill
    }
  },

  autostart: {
    kind: 'startup-folder',
    install: path.join(HERE, 'install-autostart.ps1'),
    remove: path.join(HERE, 'remove-autostart.ps1'),
  },
};
