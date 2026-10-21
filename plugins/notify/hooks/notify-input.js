'use strict';

// Notification hook：窗口需要用户介入时（权限提示、询问对话框、空闲等待等），
// 推一张醒目的卡片到飞书，避免窗口在终端里干等你却无人知晓。

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
  // 优先用 Claude Code 的 AI 会话标题（终端顶部显示的名字），取不到再退回 agents 列表
  try {
    if (transcriptPath && fs.existsSync(transcriptPath)) {
      let last = null;
      for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
        if (!line.includes('"ai-title"')) continue;
        try {
          const d = JSON.parse(line);
          if (d.aiTitle) last = d.aiTitle;
        } catch (_) {}
      }
      if (last) return last;
    }
  } catch (_) {}
  try {
    const r = spawnSync('claude', ['agents', '--json'], {
      encoding: 'utf8', timeout: 8000, windowsHide: true, shell: true,
    });
    if (r.stdout) {
      const arr = JSON.parse(r.stdout);
      const hit = arr.find((a) => a.sessionId === sessionId);
      if (hit && hit.name) return hit.name;
    }
  } catch (_) {}
  return `${path.basename(cwd || '') || 'unknown'}-${String(sessionId).slice(0, 4)}`;
}

const input = readStdin();
const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID;
const cwd = input.cwd || process.cwd();
const message = (input.message || '').trim();

if (!sessionId) process.exit(0);

// 通知类型：Claude Code 传入的字段名可能是 notification_type 或 matcher 命中的类型
const kind = input.notification_type || input.notificationType || input.matcher || 'needs_input';

const LABELS = {
  permission_prompt: '🔐 等待权限确认',
  idle_prompt: '⏳ 空闲等待中',
  elicitation_dialog: '❓ 有问题要问你',
  elicitation_url_dialog: '❓ 有问题要问你',
  agent_needs_input: '❓ 需要你输入',
};
const label = LABELS[kind] || '⚠️ 需要你介入';

const cfg = lib.readConfig();
const name = sessionName(sessionId, cwd, input.transcript_path);

// 去重：同一窗口、同一类型、同一文案，10 分钟内只推一次，
// 避免 idle_prompt 之类的轮询型通知把群刷屏。
const DEDUP_MS = 10 * 60 * 1000;
const dedupFile = path.join(lib.DATA_DIR, 'notify-dedup.json');
let dedup = {};
try { dedup = JSON.parse(fs.readFileSync(dedupFile, 'utf8')); } catch (_) {}
const key = `${sessionId}|${kind}|${message}`;
const last = dedup[key] || 0;
if (Date.now() - last < DEDUP_MS) {
  lib.log('input', `跳过（10 分钟内已推过同类通知）${name} ${kind}`);
  process.exit(0);
}

const card = {
  schema: '2.0',
  config: { wide_screen_mode: true },
  header: {
    title: { tag: 'plain_text', content: `${label} · [${name}]` },
    template: 'orange',
  },
  body: {
    elements: [
      { tag: 'markdown', content: `📁 \`${cwd}\`` },
      { tag: 'hr' },
      { tag: 'markdown', content: message || '（未提供说明，请到终端查看）' },
      { tag: 'hr' },
      {
        tag: 'markdown',
        content: kind === 'permission_prompt'
          ? '🔐 **权限确认无法在飞书代答**，需要到该窗口的终端里选择。'
          : '💬 引用本条回复，或在终端里作答。',
      },
    ],
  },
};

// 接到该窗口的常驻话题里，而不是在群里新开一条
const saved = cfg.threadMode ? lib.readThreadRoot(sessionId) : null;
let res;
if (cfg.threadMode && saved && saved.rootMessageId) {
  res = lib.larkSync(['im', '+messages-reply', '--as', 'bot',
    '--message-id', saved.rootMessageId, '--reply-in-thread',
    '--msg-type', 'interactive', '--content', JSON.stringify(card)]);
} else {
  res = lib.larkSync(['im', '+messages-send', '--as', 'bot',
    '--chat-id', cfg.chatId, '--msg-type', 'interactive', '--content', JSON.stringify(card)]);
}

if (res && res.ok && res.data && res.data.message_id) {
  lib.appendMapping({
    feishuMessageId: res.data.message_id,
    sessionId, sessionName: name, cwd, createdAt: Date.now(), via: 'notification',
  });
  dedup[key] = Date.now();
  try { fs.writeFileSync(dedupFile, JSON.stringify(dedup), 'utf8'); } catch (_) {}
  try {
    fs.writeFileSync(path.join(lib.DATA_DIR, 'last-session.json'),
      JSON.stringify({ sessionId, at: Date.now() }), 'utf8');
  } catch (_) {}
  lib.log('input', `${label} ${name} (${sessionId}) -> ${res.data.message_id}`);
} else {
  lib.log('error', `介入通知发送失败 ${name}: ${JSON.stringify(res).slice(0, 200)}`);
}

process.exit(0);
