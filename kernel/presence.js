'use strict';

// 在场探测。
//
// 为什么需要它：AskUserQuestion 的弹窗只有在 PreToolUse hook 不放行时才会渲染，
// 而 hook 一拦就整轮阻塞——人在电脑前也看不到弹窗，只能干等飞书。
// 所以拦之前先判断一次：**人在就立刻放行让弹窗出现，人不在才拦下来等手机答。**
//
// 分工：
//   platform/<os>/  负责采样：一个常驻子进程，每秒把空闲时长/锁屏状态
//                   原子写进 data/presence.json（单次采样几毫秒）
//   本模块          readPresence() 只读那个文件（微秒级），供 hook 调用
//
// 平台没有采样器时（Linux、未编译的 Windows、macOS 未实现），
// readPresence() 恒返回 null，判定一律退到 away —— 也就是「永远推卡片」。
// 功能不缺失，只是手机上多收几张卡。
//
// 探测失败一律 fail-open：读不到、过期、字段异常 → 当作「不知道」，
// 由调用方按最保守的等待处理，绝不因为探测挂掉就让人白等。

const fs = require('fs');
const os = require('os');
const path = require('path');

const platform = require('../platform');
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.FEISHU_DATA_DIR || path.join(ROOT, 'data');

// 自测时可以用 FEISHU_PRESENCE_FILE 指向一份伪造采样，不去碰线上真文件
const PRESENCE_FILE = process.env.FEISHU_PRESENCE_FILE || path.join(DATA_DIR, 'presence.json');

const PROJECTS_DIR = process.env.FEISHU_CLAUDE_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');

// 超过这个时间就算采样停了（bridge 被杀的典型表现），不能拿旧数据当现状
const STALE_MS = 15000;

// ---- 采样器进程管理：全部委托平台层，内核不认识 .exe ----

function alive() {
  try { return platform.presenceRunning() === true; } catch (_) { return false; }
}

function start() {
  // 自测与排障时用 FEISHU_DISABLE_PRESENCE=1 关掉采样器：
  // 否则真实采样会每秒覆盖 data/presence.json，把注入的假数据冲掉。
  if (process.env.FEISHU_DISABLE_PRESENCE === '1') return false;
  try { return platform.startPresence(PRESENCE_FILE, 1000) === true; } catch (_) { return false; }
}

function stop() {
  try { platform.stopPresence(); } catch (_) {}
}

function status() {
  const p = readPresence();
  return {
    available: !!platform.supportsPresence,
    running: alive(),
    pid: (() => { try { return platform.presencePid ? platform.presencePid() : null; } catch (_) { return null; } })(),
    file: fs.existsSync(PRESENCE_FILE),
    fresh: !!p,
    idleSeconds: p ? p.idleSeconds : null,
    locked: p ? p.locked : null,
  };
}

// ---- 读采样 ----

function readPresence() {
  try {
    const st = fs.statSync(PRESENCE_FILE);
    if (Date.now() - st.mtimeMs > STALE_MS) return null;
    const p = JSON.parse(fs.readFileSync(PRESENCE_FILE, 'utf8'));
    if (!p || p.ok !== true) return null;
    return p;
  } catch (_) {
    return null;
  }
}

// ---- 会话 ↔ 窗口 ----

// 会话名。用户自己 /rename 过的（custom-title）优先，其次 AI 生成的标题。
// 只扫转录尾部 2MB：几十 MB 的转录里 ai-title 出现在最后一屏，全量扫要上百毫秒。
function sessionTitles(sessionId) {
  let file = null;
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) { file = p; break; }
    }
  } catch (_) {}
  if (!file) return { custom: null, ai: null };

  let text = '';
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 2 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (_) {
    return { custom: null, ai: null };
  }

  let custom = null;
  let ai = null;
  for (const line of text.split('\n')) {
    if (line.includes('"custom-title"')) {
      try { const d = JSON.parse(line); if (d.customTitle) custom = d.customTitle; } catch (_) {}
    } else if (line.includes('"ai-title"')) {
      try { const d = JSON.parse(line); if (d.aiTitle) ai = d.aiTitle; } catch (_) {}
    }
  }
  return { custom, ai };
}

// Claude Code 会往窗口标题前面加状态符（✳ ◐ ◑ 等），比对时剥掉
function normalizeTitle(s) {
  return String(s || '').replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
}

// ---- 判定 ----

// 返回 { level, reason, win }
//   'here' —— 人在电脑前：弹窗直接出在终端，飞书只推一张不阻塞的提醒卡
//   'away' —— 不在：走飞书卡片作答，按 awayWaitSeconds 等
//
// 判据只有两条，缺一不可：
//   1. 电脑没锁屏
//   2. 系统 3 分钟内有键盘或鼠标输入
//
// 这样判的理由：用户可能在电脑前看浏览器、看别的窗口，这些都算「在」——
// 他在电脑上，弹窗直接给他最快。而**锁屏必须单独判**：锁屏前刚操作过，
// 空闲时长还很小，只看 idle 就会误以为人还坐在屏幕前。
//
// 窗口信息（win）只用于卡片文案和日志，不参与判定：Windows Terminal 多窗口
// 共用一个进程，靠标题匹配容易失手，一旦匹配不上就会把「人在」误判成不在。
function judge(sessionId, p, opts = {}) {
  if (!p) return { level: 'away', reason: 'no-presence', win: null };

  const awayIdle = opts.awayIdleSeconds || 180;
  const idle = Number(p.idleSeconds);

  // 锁屏 / UAC 安全桌面：人肯定不在，哪怕一秒前还在动鼠标
  if (p.locked) return { level: 'away', reason: 'locked', win: null };

  // 采样坏了（接口失败或 tick 回绕异常）：保守按不在处理
  if (!(idle >= 0)) return { level: 'away', reason: 'idle-unknown', win: null };

  // 长时间没输入：人离开了
  if (idle >= awayIdle) return { level: 'away', reason: `idle${idle}s`, win: null };

  // 窗口只给日志和卡片补一句上下文，判定结论不受它影响
  let win = null;
  try {
    const titles = sessionTitles(sessionId);
    const title = normalizeTitle(titles.custom || titles.ai || opts.fallbackTitle || '');
    if (title && Array.isArray(p.windows)) {
      win = p.windows.find((w) => normalizeTitle(w.title) === title) || null;
    }
  } catch (_) {}

  return { level: 'here', reason: `active+idle${idle}s`, win };
}

module.exports = {
  PRESENCE_FILE,
  start, stop, alive, status, readPresence, sessionTitles, judge, normalizeTitle,
};
