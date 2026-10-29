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

// 读某个 pid 的命令行；取不到返回 null（调用方据此退回保守判断）。
//
// 为什么单独有这个能力：单实例锁要回答的是「那个 pid 上跑的是**我们的**桥接吗」，
// 而不是「那里有个 node 吗」。重启后 pid 会被系统复用，只看进程名会误判成
// 「已有实例在运行」，桥接于是永远起不来，且日志里看不出任何异常。
//
// Windows 上没有任何便宜的通用办法：tasklist 不给命令行，wmic 在 Win11 已移除。
// 只有 PowerShell CIM，实测约 1.3 秒——所以它**只允许在启动时调用一次**，
// 绝不能进 hook 或轮询这类热路径。
function commandLineOf(pid) {
  if (!pid) return null;
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`,
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const s = (r.stdout || '').trim();
    return s || null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  name: 'win32',
  supportsPresence: true,

  // 只给单实例锁用（启动时一次）。热路径上不要调。
  commandLineOf,

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

  // 收掉「本目录下」的采样器，包括上一个 bridge 留下的孤儿进程。
  //
  // stopPresence() 只能杀本进程的直系子进程。采样器是 detached 启动的——
  // bridge 被强杀或换掉之后，它会继续活着并每秒写 data/presence.json。
  // 迁移目录时这既占着目标目录，又会让新实例读到旧路径的数据，必须先清掉。
  stopAllPresence() {
    const exe = path.join(HERE, 'presence.exe').toLowerCase();
    const killed = [];
    try {
      const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='presence.exe'\" | "
        + 'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress',
      ], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      const raw = (ps.stdout || '').trim();
      if (!raw) return killed;
      const rows = [].concat(JSON.parse(raw));
      for (const r of rows) {
        if (!r || !r.ProcessId) continue;
        if (String(r.ExecutablePath || '').toLowerCase() !== exe) continue;   // 不是本项目的
        try { process.kill(r.ProcessId); killed.push(r.ProcessId); } catch (_) {}
      }
    } catch (_) {}
    try { if (presenceChild) presenceChild.kill(); } catch (_) {}
    presenceChild = null;
    return killed;
  },

  // 新开一个 Windows Terminal 窗口跑 claude。
  // VBS 负责两件事：清空继承来的 CLAUDECODE / *_SESSION_ID 等环境变量
  // （否则新窗口会关掉转录保存、或把 inbox 指到错误的会话上），以及 cd 到目标目录。
  //
  // 这里刻意用 spawnSync 而不是 spawn + unref：cscript 本身只跑几百毫秒，
  // 而且**必须能看见它失败了**。之前用 spawn 的后果是——VBS 起不来时毫无痕迹，
  // 界面只显示「30 秒未注册」，完全看不出是开窗这一步就挂了。
  spawnWindow({ sessionId, cwd, resumeId }) {
    const vbs = path.join(HERE, 'launch-claude.vbs');
    if (!fs.existsSync(vbs)) throw new Error(`缺少 ${vbs}`);

    const args = ['//nologo', vbs, sessionId, cwd];
    if (resumeId) args.push(resumeId);

    const r = spawnSync('cscript.exe', args, { encoding: 'utf8', timeout: 20000 });

    if (r.error) throw new Error(`cscript 无法执行：${r.error.message}`);
    if (r.status !== 0) {
      const msg = ((r.stdout || '') + (r.stderr || '')).trim().slice(0, 400);
      throw new Error(`launch-claude.vbs 退出码 ${r.status}${msg ? `：${msg}` : ''}`);
    }

    // 退出码 0 也可能什么都没做（比如 %TEMP% 异常导致脚本写到别处）。
    // 校验中间产物确实生成了——这是能在这一秒内发现问题的唯一可靠信号。
    const bat = path.join(process.env.TEMP || '', `cc-launch-${String(sessionId).slice(0, 8)}.cmd`);
    if (!fs.existsSync(bat)) {
      throw new Error(`启动脚本没有生成（期望在 ${bat}）。检查 VBS 的 %TEMP% 是否可用。`);
    }
    return true;
  },

  // Windows 上被强杀的进程句柄回收有延迟，process.kill(pid, 0) 可能仍报「活着」。
  // 所以再核对一次 tasklist 里的进程名，避免把死掉的旧 pid 当成还在跑。
  //
  // 注意这里只判「这个 pid 上是不是一个 node」。它被热路径反复调用
  // （阻塞等待里每 10 秒一次），不能在这里读命令行——那要 1.3 秒。
  // 「是不是**我们**的桥接」这件事由单实例锁单独判，见 kernel/daemon.js。
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

  // 关掉某个 sessionId 对应的窗口。
  //
  // 两条路都要走，因为**窗口和进程不是一一对应**的：
  //   1) 进程：`cmd.exe /k %TEMP%\cc-launch-<前8位>.cmd` 是窗口里那个根进程，
  //      关它要带 /T 连子孙一起关（claude.exe 是孙进程，只关 cmd 会留孤儿）。
  //   2) 窗口：只杀进程的话 Windows Terminal 会把标签页留下显示「已退出」，
  //      窗口本身还在——用户看到的仍是「又开了一堆终端」。所以再关标签页。
  // 两处都按 sessionId 定位，不碰用户手开的窗口。
  closeWindow({ sessionId }) {
    const tag = String(sessionId).slice(0, 8);
    let acted = false;

    const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | "
      + `Where-Object { $_.CommandLine -like '*cc-launch-${tag}*' } | `
      + 'ForEach-Object { $_.ProcessId }'], { encoding: 'utf8', timeout: 15000 });
    const pids = (ps.stdout || '').trim().split(/\s+/).filter((x) => /^\d+$/.test(x));
    for (const p of pids) {
      try {
        spawnSync('taskkill', ['/PID', p, '/T', '/F'], { timeout: 15000, windowsHide: true });
        acted = true;
      } catch (_) {}
    }

    const closer = path.join(HERE, 'close-window.ps1');
    if (fs.existsSync(closer)) {
      const r = spawnSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', closer, tag],
        { encoding: 'utf8', timeout: 20000 });
      if ((r.stdout || '').includes('closed')) acted = true;
    }

    return acted;
  },

  autostart: {
    kind: 'startup-folder',
    install: path.join(HERE, 'install-autostart.ps1'),
    remove: path.join(HERE, 'remove-autostart.ps1'),
    // 装没装：看启动文件夹里那个快捷方式在不在。
    // 由平台层自己回答，页面不必知道「Windows 用的是 .lnk」这种细节。
    installed() {
      const startup = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows',
        'Start Menu', 'Programs', 'Startup', 'ClaudeFeishuBridge.lnk');
      try { return fs.existsSync(startup); } catch (_) { return false; }
    },
  },
};
