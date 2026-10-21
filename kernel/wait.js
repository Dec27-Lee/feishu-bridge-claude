'use strict';

// 等人在飞书上作答——两个 hook（提问、权限确认）共用这一段。
//
// 关键点：不能一律死等。人就在电脑前时，弹窗本该直接出在终端里，
// 让手机去答反而是绕远路。所以先探一次「在不在场」，再决定等多久：
//
//   here（未锁屏 + 3 分钟内有键鼠输入）→ 不阻塞，立刻交还终端，飞书只推提醒卡
//   away（锁屏 / 久无输入 / 采样缺失） → 等到人回来为止（awayWaitSeconds，默认 30 分钟）
//
// **away 档为什么不能只等 4 分钟**：away 的意思是「这个人现在只能从手机答」。
// 到点就把弹窗扔回终端，等于把题丢给一个没人看的屏幕——他回来时窗口可能已经被后来的
// 输出刷走了，这比一直等着糟得多。所以 away 档的等待上限要远大于「顺手看一眼」的时间，
// 真正的出口是「人回到电脑前」或「在手机上答了」。
//
// 阻塞期间每 3 秒重探一次：人回来了就立刻交还，不必把剩下的时间等完。
// 探测读的是 bridge 常驻采样写下的 data/presence.json（微秒级），不是现调 Win32。
//
// 探测异常一律 fail-open：按 away 处理，行为退化成「原来的死等」，不会更糟。

const fs = require('fs');
const path = require('path');
const q = require('./questions');
const lib = require('./lib');
const presence = require('./presence');
const platform = require('../platform');

const POLL_MS = 1000;
const REPROBE_MS = 3000;
const BRIDGE_CHECK_MS = 10000;

// 纯阻塞，零 CPU、零子进程。不能用 execSync('ping') —— 每秒 spawn 一次太贵
function sleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

// 桥接没在跑 = 没人接卡片，调用方应直接放行，别让人白等
function bridgeAlive() {
  try {
    const pid = parseInt(fs.readFileSync(path.join(lib.DATA_DIR, 'bridge.pid'), 'utf8'), 10);
    return platform.pidAlive(pid);
  } catch (_) {
    return false;
  }
}

// away 档等多久。默认 30 分钟——够覆盖「出门一趟回来接着答」，
// 又不会让一个真的被忘掉的会话无限期卡住。
//
// 配置来源是插件 schema（plugins/<id>/plugin.json 的 config），不是 config.json 顶层：
// 同一个键在 ask 与 permission 两个插件里各有一份，可以分开调。
function awayWaitMs(cfg) {
  const envWait = Number(process.env.FEISHU_ASK_WAIT_MS || 0);
  if (envWait) return envWait;
  const sec = (cfg && cfg.awayWaitSeconds) || 1800;
  return sec * 1000;
}

// 按在场情况决定等多久。返回 { level, reason, waitMs }
//   here → 0（调用方不阻塞，走纯提醒卡）
//   away → awayWaitSeconds（默认 30 分钟）
// 只有两档：人在电脑前，或者不在。没有中间态。
function budget(sessionId, cfg) {
  const ms = awayWaitMs(cfg);
  if (!cfg || cfg.presenceAware === false) return { level: 'off', reason: 'disabled', waitMs: ms };
  // 该平台没有在场采样器：一律按 away 处理（推卡片、按上限等），功能不缺失
  if (!platform.supportsPresence) return { level: 'away', reason: 'no-sampler', waitMs: ms };

  let v = null;
  try { v = presence.judge(sessionId, presence.readPresence(), cfg); } catch (_) { v = null; }
  // 探测本身挂了 → 当作不在，行为退回「死等」，不会更糟
  if (!v) return { level: 'away', reason: 'probe-error', waitMs: ms };

  return { level: v.level, reason: v.reason, waitMs: v.level === 'here' ? 0 : ms };
}

// 阻塞等待作答。返回 { outcome, rec, waitedMs, level, reason }
//   done      —— 飞书上答完了，调用方回填 hook 输出
//   cancelled —— 用户点了「交还终端」，什么都不输出
//   handover  —— 人中途回到电脑前（或桥接挂了），交还终端
//   timeout   —— 等满了还没人答，交还终端
//
// 注意 here 档：调用方**不要**调这个函数，写了 noticeOnly 记录后立刻退出即可。
function waitForHuman(id, opts = {}) {
  // 传入 cfg（调用方已经从插件 schema 解析好）就用它；否则退回默认值。
  // 不再自己读顶层配置——那里的键属于内核，不属于插件。
  const cfg = opts.cfg || {};
  const started = Date.now();
  const b = budget(opts.sessionId, cfg);
  const deadline = started + b.waitMs;

  let lastProbe = started;
  let lastBridgeCheck = started;
  let rec = null;
  while (Date.now() < deadline) {
    rec = q.read(id);
    if (rec && (rec.done || rec.cancelled)) {
      return {
        outcome: rec.done ? 'done' : 'cancelled', rec, waitedMs: Date.now() - started,
        level: b.level, reason: b.reason,
      };
    }

    // 人回来了：立刻把弹窗还给终端。这条只在「等着的这段时间里」才有效，
    // 因为一旦这里 exit 掉，飞书卡片再怎么点也没有 hook 接了。
    if (cfg.presenceAware === true && Date.now() - lastProbe >= REPROBE_MS) {
      lastProbe = Date.now();
      let v = null;
      try { v = presence.judge(opts.sessionId, presence.readPresence(), cfg); } catch (_) { v = null; }
      if (v && v.level === 'here') {
        return {
          outcome: 'handover', rec: q.read(id), waitedMs: Date.now() - started,
          level: 'here', reason: v.reason,
        };
      }
    }

    // 桥接中途挂了：接下来没人能帮他作答，再等下去只是白等
    if (Date.now() - lastBridgeCheck >= BRIDGE_CHECK_MS) {
      lastBridgeCheck = Date.now();
      if (!bridgeAlive()) {
        return {
          outcome: 'handover', rec: q.read(id), waitedMs: Date.now() - started,
          level: b.level, reason: 'bridge-down',
        };
      }
    }
    sleep(POLL_MS);
  }

  rec = q.read(id);
  return {
    outcome: rec && rec.done ? 'done' : (rec && rec.cancelled ? 'cancelled' : 'timeout'),
    rec, waitedMs: Date.now() - started, level: b.level, reason: b.reason,
  };
}

module.exports = { sleep, bridgeAlive, budget, waitForHuman, awayWaitMs, POLL_MS };
