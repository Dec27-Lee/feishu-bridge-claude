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

  // 收掉本目录下的采样器，含上一个 bridge 留下的孤儿进程。
  // detached 启动的采样器不会随 bridge 退出，迁移目录前必须清掉。
  stopAllPresence() {
    const killed = [];
    try {
      const ps = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 10000 });
      for (const line of (ps.stdout || '').split('\n')) {
        if (!line.includes(PRESENCE_SH)) continue;
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (!pid || pid === process.pid) continue;
        try { process.kill(pid); killed.push(pid); } catch (_) {}
      }
    } catch (_) {}
    try { if (presenceChild) presenceChild.kill(); } catch (_) {}
    presenceChild = null;
    return killed;
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

  // Linux 的终端程序没有「按 id 关窗口」的统一接口，只能靠进程命令行定位。
  // 难点：启动脚本的临时文件名是 mktemp 随机生成的，命令行里没有 sessionId。
  // 解法：启动脚本把自身的 pid 写进 /tmp/cc-launch-<前8位>.pid，这里读回来。
  closeWindow({ sessionId }) {
    const tag = String(sessionId).slice(0, 8);
    const pidFile = path.join(process.env.TMPDIR || '/tmp', `cc-launch-${tag}.pid`);
    let pid = 0;
    try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10) || 0; } catch (_) { return false; }
    if (!pid) return false;
    try { process.kill(pid, 'SIGTERM'); } catch (_) {}
    try { fs.unlinkSync(pidFile); } catch (_) {}
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
