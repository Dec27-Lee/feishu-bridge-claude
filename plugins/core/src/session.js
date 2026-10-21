'use strict';

// 会话侧：Claude Code 的活会话发现、凭证刷新、消息投递、引用反查、图片落盘。
//
// 这里是整个桥接最容易出错的地方，两个坑写在前面：
//   1. peerToken 会在 /compact、resume 时**重新签发**。拿旧 token 写管道不报错，
//      对方只是静默丢弃。所以每次投递前都要以 Claude Code 的会话表为准刷新一次。
//   2. `/resume` 会在同一进程上留下一个作废的 sessionId 空壳。映射里记了它，
//      投递就会永远失败且毫无报错。要顺着 pid 找回真身。

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const lib = require('../../../kernel/lib');

const CLAUDE_SESSIONS_DIR = process.env.FEISHU_CLAUDE_SESSIONS_DIR
  || path.join(process.env.FEISHU_CLAUDE_HOME || path.join(os.homedir(), '.claude'), 'sessions');
const IMAGES_DIR = path.join(lib.DATA_DIR, 'images');
const LAST_SESSION_FILE = path.join(lib.DATA_DIR, 'last-session.json');

// 从 Claude Code 的会话表里读出某 session 的实时 socket + peerToken。
// 用的是 .key 里的 peerToken（peer 身份，非 own-child），
// 因此接收会话必须设置 crossSessionInbound: "accept" 才会直接投递。
function livePeer(sessionId) {
  try {
    const files = fs.readdirSync(CLAUDE_SESSIONS_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let reg;
      try {
        reg = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, f), 'utf8'));
      } catch (_) { continue; }
      if (reg.sessionId !== sessionId || !reg.messagingSocketPath) continue;

      const keyFile = files.find((k) => k.startsWith(`${reg.pid}.`) && k.endsWith('.key'));
      if (!keyFile) return null;
      const peer = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, keyFile), 'utf8')).peerToken;
      if (!peer) return null;
      return { socket: reg.messagingSocketPath, token: peer, cwd: reg.cwd, pid: reg.pid, name: reg.name };
    }
  } catch (_) {}
  return null;
}

// 把桥接侧记录刷新到实况；token 变了就更新并返回刷新后的记录。
// 返回的 rec.sessionId 可能**不是**传入的那个（顺 pid 纠回了真身），调用方以返回值为准。
function refreshSession(sessionId) {
  let live = livePeer(sessionId);
  let sid = sessionId;

  if (!live) {
    const cur = lib.readSession(sessionId);
    const real = cur ? lib.resolveSessionAlias(sessionId) : null;
    if (real && real !== sessionId) {
      live = livePeer(real);
      if (live) {
        lib.log('session', `${sessionId.slice(0, 8)} 已不是活会话，改按 ${real.slice(0, 8)} 投递`);
        sid = real;
      }
    }
  }
  if (!live) return null;

  const cur = lib.readSession(sid);
  if (cur && cur.socket === live.socket && cur.token === live.token) return cur;
  const rec = lib.writeSession(sid, { ...live, source: 'refreshed' });
  lib.log('session', `刷新凭证 ${sid} (${live.name})：token 已重新签发`);
  return rec;
}

// SessionStart hook 只在会话启动时触发；配 hook 之前就已打开的窗口不会注册。
// 这里从 Claude Code 自己的会话表里补出 socket 与凭证。
function autoRegister(sessionId) {
  const live = livePeer(sessionId);
  if (!live) return null;
  const rec = lib.writeSession(sessionId, { ...live, source: 'auto-registered' });
  lib.log('session', `自动补注册 ${sessionId} (${live.name})`);
  return rec;
}

// 记录「最近在聊的窗口」，供单聊免引用直发时自动路由
function rememberSession(sessionId) {
  try {
    fs.writeFileSync(LAST_SESSION_FILE, JSON.stringify({ sessionId, at: Date.now() }), 'utf8');
  } catch (_) {}
}

function recentSession(maxAgeMs) {
  try {
    const r = JSON.parse(fs.readFileSync(LAST_SESSION_FILE, 'utf8'));
    if (Date.now() - r.at <= maxAgeMs) return r.sessionId;
  } catch (_) {}
  return null;
}

// 反查被引用消息 / 所属话题：lark-cli 的归一化事件不含这些字段，必须再查一次。
// reply_to 用于常规引用回复；thread_id 用于「话题内回复」——用户在话题里连续发言时，
// 消息本身不带 reply_to，但会带同一个 thread_id。
function resolveRefs(messageId) {
  const res = lib.larkSync(['im', '+messages-mget', '--as', 'bot', '--message-ids', messageId]);
  const msgs = res && res.ok && res.data && res.data.messages;
  if (!Array.isArray(msgs) || !msgs.length) return { replyTo: null, threadId: null };
  return { replyTo: msgs[0].reply_to || null, threadId: msgs[0].thread_id || null };
}

// 投递：命名管道 + auth 行 + JSON 信封
function deliver(session, text) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, why) => { if (!done) { done = true; resolve({ ok, why }); } };

    const c = net.connect(session.socket, () => {
      c.write(JSON.stringify({ type: 'auth', token: session.token }) + '\n');
      c.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
      setTimeout(() => { c.end(); finish(true, 'sent'); }, 400);
    });
    c.on('error', (e) => finish(false, e.message));
    c.on('close', () => finish(true, 'closed'));
    setTimeout(() => { try { c.destroy(); } catch (_) {} finish(false, 'timeout'); }, 8000);
  });
}

// 图片消息（message_type=post）在 content 里以 [Image: img_xxx] 形式出现。
// 下载到本地后把标记换成绝对路径，窗口里的 Claude 可以用 Read 工具读图。
function materializeImages(messageId, content) {
  const keys = [...content.matchAll(/\[Image:\s*(img_[A-Za-z0-9_-]+)\]/g)].map((m) => m[1]);
  if (!keys.length) return content;

  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.join(IMAGES_DIR, day);
  fs.mkdirSync(dir, { recursive: true });

  let text = content;
  keys.forEach((key, i) => {
    const rel = `${messageId}_${i + 1}.png`; // --output 只接受相对路径，故配合 cwd
    const abs = path.join(dir, rel);
    lib.larkSync(['im', '+messages-resources-download', '--as', 'bot',
      '--message-id', messageId, '--file-key', key, '--type', 'image',
      '--output', rel], { cwd: dir, timeoutMs: 40000 });

    const ok = fs.existsSync(abs);
    text = text.replace(`[Image: ${key}]`, ok ? `[图片] ${abs}` : `[图片下载失败: ${key}]`);
    lib.log('image', `${ok ? '已下载' : '下载失败'} ${key} -> ${abs}`);
  });
  return text;
}

module.exports = {
  livePeer, refreshSession, autoRegister, rememberSession, recentSession,
  resolveRefs, deliver, materializeImages, CLAUDE_SESSIONS_DIR,
};
