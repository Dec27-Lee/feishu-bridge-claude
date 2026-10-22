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
  // detached 启动的采样器不会随 bridge 退出，迁移目录前必须清掉，
  // 否则它会一直往旧路径写 data/presence.json，新实例读到过期数据。
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

  // 关掉某个 sessionId 开的窗口。macOS 没有「按启动参数找窗口」的接口，
  // 所以启动脚本把窗口 id 落在 %TMPDIR%/cc-launch-<前8位>.id 里，这里读回来关。
  closeWindow({ sessionId }) {
    const tag = String(sessionId).slice(0, 8);
    const idFile = path.join(process.env.TMPDIR || '/tmp', `cc-launch-${tag}.id`);
    let winId = '';
    try { winId = fs.readFileSync(idFile, 'utf8').trim(); } catch (_) { return false; }
    if (!winId) return false;
    const script = `tell application "Terminal" to close (every window whose id is ${winId})`;
    spawnSync('osascript', ['-e', script], { encoding: 'utf8', timeout: 10000 });
    try { fs.unlinkSync(idFile); } catch (_) {}
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
