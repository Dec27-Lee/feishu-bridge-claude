'use strict';

// Linux 实现。
//
// 能力与 Windows/macOS 对齐，但 Linux 上「锁屏」和「开窗」都没有统一标准，
// 所以每一项都做多路探测 + 优雅降级：
//
//   空闲秒数  xprintidle（X11）→ 退回 /proc/interrupts 估算 → 再退回「不支持」
//   锁屏      loginctl show-session 的 LockedHint（systemd）→ 读屏保状态 → 退回「不知道」
//   开窗      gnome-terminal / konsole / xfce4-terminal / xterm 依次尝试
//   自启      systemd --user（有的话）→ 否则给出手动说明
//
// 任何一项拿不到都不影响主体功能：判定会退到 away（一律推卡片），
// 开窗失败会回一张红色卡片让你手动开。

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const HERE = __dirname;
const PRESENCE_SH = path.join(HERE, 'presence.sh');
const LAUNCH_SH = path.join(HERE, 'launch-claude.sh');

let presenceChild = null;

module.exports = {
  name: 'linux',
  supportsPresence: true,   // 由 presence.sh 自己判断能不能采到；采不到就是 idle=-1

  startPresence(file, intervalMs) {
    if (presenceChild && presenceChild.exitCode === null) return true;
    if (!fs.existsSync(PRESENCE_SH)) return false;
    try {
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
      process.kill(pid, 0);
      // pid 可能被复用：核对进程名
      const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
      return (r.stdout || '').toLowerCase().includes('node');
    } catch (_) {
      return false;
    }
  },

  autostart: {
    kind: 'systemd-user',
    install: path.join(HERE, 'install-autostart.sh'),
    remove: path.join(HERE, 'remove-autostart.sh'),
  },
};
