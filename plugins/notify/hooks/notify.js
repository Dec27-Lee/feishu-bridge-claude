'use strict';

// Stop hook：Claude 结束一轮响应时，把结果推到飞书，并记录
// 飞书 message_id -> 本会话 session_id 的映射，供引用回复时反查路由。
//
// 长回复按段落切成多张卡片连续发送，保证在手机飞书里能完整读完。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('../../../kernel/lib');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (_) {
    return {};
  }
}

function sessionName(sessionId, cwd, transcriptPath) {
  // 用户自己在终端敲 /rename 定过的名字优先（转录里是 custom-title 记录）。
  // 只看转录不够时再问 agents 列表，最后才退到派生名。
  try {
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      let custom = null;
      let auto = null;
      for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
        if (line.includes('"custom-title"')) {
          try {
            const d = JSON.parse(line);
            if (d.customTitle) custom = d.customTitle;
          } catch (_) {}
        } else if (line.includes('"ai-title"')) {
          try {
            const d = JSON.parse(line);
            if (d.aiTitle) auto = d.aiTitle;
          } catch (_) {}
        }
      }
      if (custom) return { name: custom, fromAiTitle: true, custom: true };
      if (auto) return { name: auto, fromAiTitle: true };
    }
  } catch (_) {}

  try {
    const r = spawnSync('claude', ['agents', '--json'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true, shell: true,
    });
    if (r.stdout) {
      const arr = JSON.parse(r.stdout);
      const hit = arr.find((a) => a.sessionId === sessionId);
      if (hit && hit.name) return { name: hit.name, fromAiTitle: false };
    }
  } catch (_) {}
  const base = path.basename(cwd || '') || 'unknown';
  return { name: `${base}-${String(sessionId).slice(0, 4)}`, fromAiTitle: false };
}

// 按段落/换行优先切分，避免把句子拦腰截断
function splitText(text, size) {
  const chunks = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n\n', size);
    if (cut < size * 0.4) cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.4) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function buildCard({ name, cwd, body, index, total, continued, stats }) {
  // 首条卡片标题直接取窗口名，飞书据此生成话题名（话题名 = 会话名）。
  // 状态一律用标题栏颜色表达，标题文字里不再放 emoji 或状态词。
  const title = !continued
    ? name
    : (total > 1 ? `${name} (${index}/${total})` : name);

  const elements = [];
  if (index === 1) {
    // 目录、时间、上下文各占一行：飞书 markdown 会把同一元素里的单换行折成一个段落，
    // 塞进 ``` 代码块也会被折成 plain_text。
    elements.push({ tag: 'markdown', content: `📁 \`${cwd}\`` });
    elements.push({
      tag: 'markdown',
      content: `🕐 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
    });
    // 与 📁/🕐 一样，上下文行前面也带个图标；📦 取「上下文容器」之意
    if (stats) elements.push({ tag: 'markdown', content: `📦 ${stats}` });
    elements.push({ tag: 'hr' });
  }
  elements.push({ tag: 'markdown', content: body });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'green' },
    body: { elements },
  };
}

const input = readStdin();
const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID;
const cwd = input.cwd || process.cwd();
const text = (input.last_assistant_message || '').trim();

if (!sessionId) process.exit(0);
if (!text) { lib.log('notify', `跳过（空回复）${sessionId}`); process.exit(0); }

// 三个来源分开：顶层配置给 chatId 这类全局项，插件配置给本插件参数，
// core 的配置只借 pinTopics（置顶能力由 core 拥有）。
const cfg = lib.readConfig();
const my = lib.readPluginConfig('notify');
const coreCfg = lib.readPluginConfig('core');
// `/resume` 之后进程可能同时挂着新旧两个 sessionId，hook stdin 给的是旧的那个；
// 而桥接的会话注册表记的是新的那个。统一纠到会话表里的真身，
// 否则话题记录、映射、注册表三者对不上，回消息就路由不回去。
const realSid = lib.resolveSessionAlias(sessionId);
if (realSid !== sessionId) lib.log('notify', `会话 ${sessionId.slice(0, 8)} 解析为 ${realSid.slice(0, 8)}`);
const nameInfo = sessionName(sessionId, cwd, input.transcript_path);
const name = nameInfo.name;
const chunks = splitText(text, my.chunkChars || 4000);
const stats = lib.statsLine(input.transcript_path, cfg);

let sent = 0;
// 同一窗口复用同一个常驻话题：首次通知开话题，之后所有通知都接进去
const saved = my.threadMode !== false ? lib.readThreadRoot(realSid) : null;
let threadRoot = saved && saved.rootMessageId ? saved.rootMessageId : null;
let threadId = saved && saved.threadId ? saved.threadId : null;

// 首轮通知时 ai-title 往往还没生成，话题只能用派生短名开。
// 一旦拿到真正的 AI 会话标题，就换个正确名字重开话题（旧话题保留可查）。
// 例外：话题是用户在飞书里建好并选定的（bridge 拉起的窗口 / 恢复的会话），不能再另开——
// 否则用户刚选的那棵树就被丢下，回复全跑到新话题里去。
// 判定有两个来源：threads 记录里的 userPicked，以及 mapping 里该 session 的 via=thread 绑定
// （后者能纠正本次改动之前就写下的旧记录）。
function boundByBridge(who) {
  try {
    for (const rec of lib.readMapping().values()) {
      if (rec.sessionId === who && rec.via === 'thread') return true;
    }
  } catch (_) {}
  return false;
}

const namedWithFallback = !!(saved && saved.fromAiTitle === false);
const userPickedThread = !!(saved && saved.userPicked) || boundByBridge(realSid);
if (threadRoot && namedWithFallback && nameInfo.fromAiTitle && !userPickedThread) {
  lib.log('notify', `已拿到 AI 会话标题「${name}」，重开话题（旧话题 ${threadId || threadRoot} 保留）`);
  threadRoot = null;
  threadId = null;
}

let reused = !!threadRoot;

chunks.forEach((chunk, i) => {
  const card = buildCard({ name, cwd, body: chunk, index: i + 1, total: chunks.length, continued: reused, stats });
  let payload = JSON.stringify(card);

  // 卡片请求体上限 30KB，极端情况下再压缩本段
  if (payload.length > 28000) {
    card.body.elements[card.body.elements.length - 1].content =
      chunk.slice(0, Math.max(200, chunk.length - (payload.length - 28000) - 60)) + '\n…';
    payload = JSON.stringify(card);
  }

  // 话题模式：首条开话题，其余接在同一话题下
  let res;
  if (my.threadMode !== false && threadRoot) {
    res = lib.larkSync(['im', '+messages-reply', '--as', 'bot',
      '--message-id', threadRoot, '--reply-in-thread',
      '--msg-type', 'interactive', '--content', payload]);
  } else {
    res = lib.larkSync(['im', '+messages-send', '--as', 'bot',
      '--chat-id', cfg.chatId, '--msg-type', 'interactive', '--content', payload]);
  }

  if (res && res.ok && res.data && res.data.message_id) {
    sent += 1;
    const mid = res.data.message_id;
    // 新开的话题顺便置顶：否则窗口一多，它很快被刷到看不见的地方
    const freshTopic = !threadRoot;
    if (!threadRoot) threadRoot = mid;
    if (freshTopic && coreCfg.pinTopics !== false) {
      const pin = lib.pinThreadRoot(mid);
      if (!pin.ok) lib.log('notify', `话题置顶失败（不影响收发）: ${pin.error}`);
    }

    lib.appendMapping({
      feishuMessageId: mid,
      sessionId: realSid, sessionName: name, cwd, createdAt: Date.now(),
    });

    // 话题模式下补查 thread_id 并登记，话题内任意后续发言都能路由回本窗口
    if (my.threadMode !== false && !threadId) {
      const info = lib.larkSync(['api', 'GET',
        `https://open.feishu.cn/open-apis/im/v1/messages/${mid}`, '--as', 'bot']);
      const item = ((info && info.data && info.data.items) || [])[0] || {};
      if (item.thread_id) {
        threadId = item.thread_id;
        lib.appendMapping({
          feishuMessageId: threadId,
          sessionId: realSid, sessionName: name, cwd, createdAt: Date.now(), via: 'thread',
        });
      }
    }

    if (my.threadMode !== false && threadRoot) {
      // userPicked 必须继承：它是「这棵树是用户挑的，别再另开」的标记
      lib.writeThreadRoot(realSid, threadRoot, threadId, {
        fromAiTitle: nameInfo.fromAiTitle,
        ...(userPickedThread ? { userPicked: true } : {}),
      });
    }

    // 记录"最近在聊的窗口"，供免引用直发时自动路由
    try {
      fs.writeFileSync(path.join(lib.DATA_DIR, 'last-session.json'),
        JSON.stringify({ sessionId: realSid, at: Date.now() }), 'utf8');
    } catch (_) {}
  } else {
    lib.log('error', `第 ${i + 1}/${chunks.length} 段发送失败 ${name}: ${JSON.stringify(res).slice(0, 200)}`);
  }

  // 同一用户 5 QPS 限流，分段之间稍作停顿（约 1 秒）
  if (i < chunks.length - 1) {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    } catch (_) {}
  }
});

lib.log('notify', `已通知 ${name} (${realSid}) ${sent}/${chunks.length} 段，正文 ${text.length} 字`);
process.exit(0);
