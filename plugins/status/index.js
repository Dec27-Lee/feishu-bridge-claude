'use strict';

// 每个窗口一张常驻状态卡，原地刷新。
//
// 为什么能「不产生未读」：飞书里**只有新消息才会进未读列表**，patch 一条已存在的
// 交互卡片不会产生新消息、不动未读计数、也不改变它在话题里的位置。实测确认过：
// 连续 patch 四次，手机上没有任何红点。这正是这个功能成立的前提——如果每次刷新
// 都发一张新卡，手机就会被刷屏，和「不想收推送」的需求正好相反。
//
// 卡片挂在哪：该窗口自己的话题里（data/threads/<sid>.json 记的 rootMessageId）。
// 多窗口并行时每个窗口各自一棵话题，所以各自各挂一张，互不干扰。
//
// 什么时候发请求：只有**内容签名变了**才 patch。签名里带了计时，
// 所以正在跑的窗口每轮都在变（这就是想要的「在动」的观感）；
// 空闲的窗口签名按分钟变，一分钟才动一次。
//
// 为什么不用 kernel/lib 的 larkSync：它是 spawnSync，实测一次调用含进程启动
// 约 1.5 秒，**同步阻塞主线程**。每 2 秒刷几张卡就把事件消费和卡片回调一起堵住，
// 表现是「你在飞书说的话这几秒没反应」。所以这里走异步 spawn + 串行队列：
// 同一时刻只有一个 lark-cli 在跑，主循环永远不等。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const lib = require('../../kernel/lib');
const probe = require('./src/probe');
const { buildStatusCard, signature } = require('./src/card');

// 每个会话的卡片状态：{ messageId, sig, running, runningSince, idleSince, refreshedAt }
//
// **必须落盘。** 只放内存的话，桥接每重启一次，每个窗口就重新开一张卡——
// 一次部署等于给所有话题各塞一条新消息、各产生一个未读。本项目改代码就要重启，
// 一天下来卡片能排成一串，用户看到的就是「它在不停给我发新消息」。
// 落盘后重启只是接着上一次那张卡 patch，内容没变甚至一个请求都不发。
const cards = new Map();
let cardsFile = null;
let saveTimer = null;

function loadCards(ctx) {
  cardsFile = path.join(ctx.dataDir, 'cards.json');
  try {
    const j = JSON.parse(fs.readFileSync(cardsFile, 'utf8'));
    for (const [sid, st] of Object.entries(j || {})) cards.set(sid, st);
    ctx.log(`恢复了 ${cards.size} 张状态卡的记录（重启后接着用，不重开）`);
  } catch (_) { /* 第一次跑，没有文件 */ }
}

// 立刻写盘。stop() 里直接调它——攒批的那个定时器到时候已经被取消，
// 再走 saveCards() 只会重新排一个永远不会跑的定时器，记录就丢了。
function flushCards() {
  if (!cardsFile) return;
  try {
    const obj = Object.fromEntries(cards.entries());
    fs.mkdirSync(path.dirname(cardsFile), { recursive: true });
    const tmp = `${cardsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, cardsFile);
  } catch (_) { /* 写不进去只影响下次重启会重开一张，不影响当前刷新 */ }
}

// 攒一下再写：一轮里可能连刷两张，没必要写两次盘。
function saveCards() {
  if (!cardsFile || saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flushCards(); }, 500);
  if (saveTimer.unref) saveTimer.unref();
}

// 同一时刻只有一个 lark-cli 调用在飞。inFlight 记录的是 sessionId——
// 2 秒一轮、一次调用 1.5 秒，不收口的话同一个窗口的刷新会越积越多。
let inFlight = null;

function lark(args) {
  return new Promise((resolve) => {
    let cfg;
    try { cfg = lib.readConfig(); } catch (_) { cfg = {}; }
    const bin = cfg.larkCli || 'lark-cli';
    const child = spawn(bin, args, {
      cwd: lib.ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 20000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const s = out.trim();
      if (!s) return resolve(null);
      try { resolve(JSON.parse(s)); } catch (_) { resolve({ ok: false, raw: s.slice(0, 200) }); }
    });
  });
}

function patchCard(messageId, card) {
  return lark(['im', 'messages', 'patch', '--as', 'bot',
    '--message-id', messageId, '--data', JSON.stringify({ content: JSON.stringify(card) })])
    .then((r) => !!(r && r.ok));
}

// 在话题根下回一张新卡，并把它变成该窗口的常驻状态卡
async function createCard(ctx, sessionId, rootMessageId, card) {
  const res = await lark(['im', '+messages-reply', '--as', 'bot',
    '--message-id', rootMessageId, '--reply-in-thread',
    '--msg-type', 'interactive', '--content', JSON.stringify(card)]);
  if (!res || !res.ok || !res.data || !res.data.message_id) {
    ctx.log(`状态卡创建失败 ${sessionId.slice(0, 8)}: ${JSON.stringify(res).slice(0, 200)}`);
    return null;
  }
  const mid = res.data.message_id;
  ctx.log(`状态卡已创建 ${sessionId.slice(0, 8)} -> ${mid}`);

  if (ctx.config.pinCard !== false) {
    // 卡片是话题里的一条消息，被后续回复刷上去就不好找了。置顶后从群里的
    // 「置顶」列表能一键点回来。失败不影响刷新，只是没那么好找。
    const pin = await lark(['im', 'pins', 'create', '--as', 'bot',
      '--data', JSON.stringify({ message_id: mid })]);
    if (!pin || !pin.ok) {
      ctx.log(`状态卡置顶失败（不影响刷新）: ${JSON.stringify(pin).slice(0, 160)}`);
    }
  }
  return mid;
}

// 换卡时把旧卡「收掉」：改成一张灰掉的收尾卡。
//
// 为什么是 patch 而不是撤回：撤回是高风险操作，且消息一消失，用户回头看
// 话题时就分不清「这里本来有没有东西」。留一张灰卡说明「这一轮已结束，
// 状态见下方最新一张」，比凭空少一条消息清楚得多。
function retireCard(st) {
  if (!st || !st.messageId) return;
  const card = {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '上一轮的状态' }, template: 'grey' },
    body: { elements: [{ tag: 'markdown', content: '<font color=\'grey\'>这一轮已结束，状态见下方最新一张。</font>' }] },
  };
  patchCard(st.messageId, card).catch(() => {});
}

// 一张卡的一次刷新。返回 true 表示这次真的发了请求。
async function tick(ctx, sessionId, live) {
  const saved = lib.readThreadRoot(sessionId);
  if (!saved || !saved.rootMessageId) return false;   // 这个窗口在飞书里还没有话题

  const now = Date.now();
  // shell = 在跑命令但不在「一轮」里（比如终端里直接敲 ! 命令）。
  // 也是干活，卡片上不能显示成空闲。
  const running = live.status === 'busy' || live.status === 'shell';

  let st = cards.get(sessionId);
  if (!st) st = { messageId: null, running: null, runningSince: 0, idleSince: 0, sig: '', promptMark: null };

  const pr = probe.probe(sessionId);

  // 状态翻转的时间点：用来算「已运行多久 / 上次活动多久前」。
  // busy 的起点拿不到精确值（会话表只给最后一次变更时间），够用。
  const flippedToIdle = st.running === true && running === false;
  if (st.running !== running) {
    if (running) st.runningSince = live.statusUpdatedAt || now;
    else st.idleSince = live.statusUpdatedAt || now;
    st.running = running;
  }

  // ---- 什么时候**换一张新卡** ----
  //
  // 常驻卡是话题里的一条消息，任何后来的回复都会把它顶到上面去，
  // 手机进话题看到的是最新那条，等于看不见。两种被顶的情况，处理不同：
  //
  // 1. 被**用户的新消息**顶掉 —— 新一轮对话开始了，旧卡已经过时。
  //    但我们可能整轮都看不到这条消息（用户从窗口里直接打字时，桥接根本不知道），
  //    所以真正的判据不是「谁顶的」，而是**转录里出现了新的、人打的那句话**。
  // 2. 被 **AI 的回复**顶掉 —— 这一轮结束。没有后台活儿在跑，就让它停在
  //    「本轮结束」不再动（这就是用户说的「关闭」），一条新消息都不产生；
  //    但如果这轮拉起的子代理/后台命令还没回来，活儿其实没完，这时才补一张。
  //
  // 两个判据都是「有没有发生」，不会自己循环：promptMark 只在人来新消息时变，
  // flippedToIdle 只翻转一次。
  const newPrompt = !!(
    ctx.config.newCardOnUserMessage !== false
    && pr && pr.promptMark && st.promptMark && pr.promptMark !== st.promptMark
  );
  const hasSubtasks = !!(
    ctx.config.showSubagentCard !== false && pr && pr.subtasks && pr.subtasks.length
  );
  if (newPrompt || (flippedToIdle && hasSubtasks)) {
    if (newPrompt) ctx.log(`${sessionId.slice(0, 8)} 用户开了新一轮，换一张状态卡`);
    else ctx.log(`${sessionId.slice(0, 8)} 本轮已回复但还有 ${pr.subtasks.length} 个子任务，换一张卡`);
    retireCard(st);
    st.messageId = null;
    st.sig = '';
  }
  if (pr && pr.promptMark) st.promptMark = pr.promptMark;

  const opts = {
    // 标题优先用会话转录里的名字（/rename 过的 → AI 自动标题），
    // 最后才退回会话表里的 name。那个 name 是「目录名-短哈希」的派生名，
    // 用户认不出是哪个窗口。
    title: (pr && pr.title) || live.name || sessionId.slice(0, 8),
    cwd: live.cwd || '',
    running,
    runningSince: st.runningSince,
    idleSince: st.idleSince,
    probe: pr,
    // 上下文用量按 mtime+size 缓存，同一转录不会重复全量扫描；
    // 关掉显示时连读都不读（statsLine 要扫转录，没必要为不用它的人付这份钱）。
    stats: ctx.config.showStats === false ? '' : lib.statsLine(probe.transcriptFile(sessionId) || '', {}),
    view: ctx.config,
  };

  const sig = signature(opts);
  if (st.messageId && sig === st.sig) {
    cards.set(sessionId, st);
    return false;                                   // 内容没变，不发请求
  }

  const card = buildStatusCard(opts);
  if (!st.messageId) {
    st.messageId = await createCard(ctx, sessionId, saved.rootMessageId, card);
    if (!st.messageId) { cards.set(sessionId, st); return false; }
  } else if (!(await patchCard(st.messageId, card))) {
    // patch 失败最常见的原因是「卡片太旧」（14 天上限）或消息被撤回。
    // 换一张新卡继续，别让这个窗口永远停在旧内容上。
    ctx.log(`状态卡更新失败，重开一张 ${sessionId.slice(0, 8)}`);
    st.messageId = await createCard(ctx, sessionId, saved.rootMessageId, card);
    if (!st.messageId) { cards.set(sessionId, st); return false; }
  }

  st.sig = sig;
  cards.set(sessionId, st);
  saveCards();
  return true;
}

// 扫一遍活的会话，把「有话题、该刷新」的窗口按最久未刷排序。
// 真正发请求的是 drain()——它一个接一个地跑，同一时刻只占一个 lark-cli。
function queueOf(now) {
  const live = probe.liveSessions();
  const list = [...live.entries()]
    .filter(([sessionId]) => !!lib.readThreadRoot(sessionId))
    .map(([sessionId, info]) => ({
      sessionId,
      info,
      age: now - ((cards.get(sessionId) || {}).refreshedAt || 0),
    }))
    .sort((a, b) => b.age - a.age);

  // 窗口没了就丢掉内存记录（卡片留在话题里当历史）
  for (const sid of [...cards.keys()]) if (!live.has(sid)) cards.delete(sid);
  return { live, list };
}

// 每轮最多连刷几个窗口。
//
// 这是拿实测数据算出来的，不是拍脑袋：一次 lark-cli 调用含进程启动约
// **1.5 秒**。虽然这里已经是异步 spawn（不阻塞主循环），但一轮里串太多张，
// 每张卡轮到自己就更慢。两个是速度与响应的折中：窗口三五个时，
// 每张卡十秒内必然动一次。
const MAX_PER_TICK = 2;

// 队列调度：每轮最多连刷 MAX_PER_TICK 个，一个跑完再起下一个。
// 这样无论多少个窗口，同一时刻最多一个 lark-cli，主循环永远不被阻塞。
async function drain(ctx) {
  if (inFlight) return { skipped: true };

  const { live, list } = queueOf(Date.now());
  let patched = 0;
  let tried = 0;

  for (const item of list) {
    if (tried >= MAX_PER_TICK) break;
    tried += 1;
    inFlight = item.sessionId;
    try {
      if (await tick(ctx, item.sessionId, item.info)) {
        patched += 1;
        ctx.log(`刷新状态卡 ${item.sessionId.slice(0, 8)}`);
      }
      const st = cards.get(item.sessionId);
      if (st) st.refreshedAt = Date.now();
      else cards.set(item.sessionId, { refreshedAt: Date.now() });
    } catch (e) {
      ctx.log(`刷新 ${item.sessionId.slice(0, 8)} 失败: ${e.message}`);
    } finally {
      inFlight = null;
    }
  }
  return { live: live.size, tried, patched };
}

let timer = null;

module.exports = {
  start(ctx) {
    const everyMs = Math.max(2, ctx.config.intervalSeconds || 2) * 1000;
    loadCards(ctx);

    // 第一轮先跳过：桥接刚起来时会话表还没落定，事件流也在重连，
    // 立刻发卡片容易拿到半截状态。
    let first = true;
    timer = setInterval(() => {
      if (first) { first = false; return; }
      try {
        const p = drain(ctx);
        if (p && typeof p.catch === 'function') {
          p.catch((e) => ctx.log(`状态卡轮询异常: ${e.message}`));
        }
      } catch (e) {
        ctx.log(`状态卡轮询异常: ${e.message}`);
      }
    }, everyMs);
    ctx.log(`实时状态卡已启用：每 ${everyMs / 1000} 秒刷新一次`);
  },
  stop() {
    if (timer) clearInterval(timer);
    timer = null;
    // 顺序有讲究：先取消攒批定时器，再**立刻**写盘，最后才清内存。
    // 反过来（先清内存、或让那个 500ms 定时器事后触发）会把空对象写进文件，
    // 下次启动就以为一张卡都没有，又把所有窗口重开一遍。
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    flushCards();
    cards.clear();
    inFlight = null;
  },
  // 给自测用：不启定时器，手动跑一轮（异步，需要 await）
  tick,
  drain,
  loadCards,
  cards,
};
