'use strict';

// macOS 实现。
//
// 与 Windows 版能力对齐，只是每个能力用 mac 的方式实现：
//   spawnWindow     osascript 让 Terminal/iTerm 新开窗口跑 launch-claude.sh
//   pidAlive        ps 校验
//   startPresence   spawn presence.sh --loop（ioreg + CGSession 两个信号）
//   autostart       launchd（~/Library/LaunchAgents）
//
// 与 Windows 的两个差别：
//   1. 没有 presence.exe，用 bash 脚本（系统自带 ioreg，锁屏靠 PyObjC 或 ioreg 兜底）
//   2. 开机自启用 launchd 而不是启动文件夹

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const PRESENCE_SH = path.join(HERE, 'presence.sh');
const LAUNCH_SH = path.join(HERE, 'launch-claude.sh');

let presenceChild = null;

module.exports = {
  name: 'darwin',
  supportsPresence: true,

  startPresence(file, intervalMs) {
    if (presenceChild && presenceChild.exitCode === null) return true;
    if (!fs.existsSync(PRESENCE_SH)) return false;
    try {
      // detached：bridge 被强杀时采样器不跟着殉葬，由下一个 bridge 重新拉起
      presenceChild = spawn('bash', [PRESENCE_SH, '--loop', file, '--interval', String(intervalMs || 1000)], {
        stdio: 'ignore', detached: true,
      });
      presenceChild.unref();
      presenceChild.on('exit', () => { presenceChild = null; });
      return true;
    } catch (_) {
      presenceChild = null;
      return false;
    }
  },

  presenceRunning() {
    return !!(presenceChild && presenceChild.exitCode === null && !presenceChild.killed);
  },

  stopPresence() {
    try { if (presenceChild) presenceChild.kill(); } catch (_) {}
    presenceChild = null;
  },

  // 新开一个 Terminal/iTerm 窗口跑 claude。
  // 脚本负责清空继承来的 CLAUDE* 会话变量——不清的话新窗口会关掉转录保存。
  spawnWindow({ sessionId, cwd, resumeId }) {
    if (!fs.existsSync(LAUNCH_SH)) throw new Error(`缺少 ${LAUNCH_SH}`);
    const args = [LAUNCH_SH, sessionId, cwd];
    if (resumeId) args.push(resumeId);
    const r = spawnSync('bash', args, { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) {
      throw new Error(`开窗失败：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
    }
    return true;
  },

  pidAlive(pid) {
    if (!pid) return false;
    try {
      const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], {
        encoding: 'utf8', timeout: 5000,
      });
      return (out.stdout || '').toLowerCase().includes('node');
    } catch (_) {
      return false;
    }
  },

  autostart: {
    kind: 'launchd',
    install: path.join(HERE, 'install-autostart.sh'),
    remove: path.join(HERE, 'remove-autostart.sh'),
  },
};
