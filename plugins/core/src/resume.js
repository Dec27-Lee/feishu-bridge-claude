'use strict';

// 恢复历史会话：/resume 的远程等价物。
// 只列近 5 天有活动、且当前没在运行的会话——同一份转录不能被两个进程同时持有。
// 话题已绑定窗口时，候选再按同一工作区过滤：跨目录恢复会把对话带到错误的目录里。

const lib = require('../../../kernel/lib');
const settings = require('./settings');
const { replyCard } = require('./reply');
const { shortLabel } = require('./cards-window');
const { launchWindow } = require('./launch');

// ---- 恢复历史会话（/resume 的远程等价物） ----
// 触发：#resume（或 #恢复 / #继续）发在一个新话题里。
// 只列近 5 天有活动的会话；正在运行的会被标出来并禁止选择——
// 同一份转录不能被两个进程同时持有，硬开只会撞锁。

function sessionLabel(s) {
  // 无标题的就用「无标题 · 目录 · 时间」；有标题的标题是主信息，放前面
  const title = s.title || '无标题';
  const short = title.length > 18 ? title.slice(0, 18) + '…' : title;
  const when = new Date(s.lastActive).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const tail = `${shortLabel(s.cwd)} · ${when} · ${s.userTurns}轮`;
  return `${short} ｜ ${tail}${s.running ? ' 🔒运行中' : ''}`;
}

// 从话题反查它当前绑定的窗口工作目录（用于把会话候选限制在同一工作区）
function threadCwd(threadId) {
  if (!threadId) return null;
  const m = lib.readMapping().get(threadId);
  if (m && m.cwd) return m.cwd;
  return null;
}

// 同工作区判定：完全一致，或候选目录在该目录之下
function sameWorkspace(a, b) {
  if (!a || !b) return false;
  const x = lib.normalizePath(a);
  const y = lib.normalizePath(b);
  return x === y || y.startsWith(x + '/') || x.startsWith(y + '/');
}

function buildResumeCard(sessions, threadId, note, scopeCwd) {
  // 只把可恢复的（未运行）放进候选，序号与 pending.list 严格对应
  const pickable = sessions.filter((s) => !s.running).slice(0, settings.get('resumeMax'));
  const elements = [];

  elements.push({ tag: 'markdown', content: '**恢复历史会话**' });
  if (scopeCwd) elements.push({ tag: 'markdown', content: `📁 \`${scopeCwd}\`` });
  if (note) elements.push({ tag: 'markdown', content: note });
  elements.push({ tag: 'hr' });

  pickable.forEach((s, i) => {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${i + 1}. ${sessionLabel(s)}` },
      type: i === 0 ? 'primary_filled' : 'default',
      width: 'fill',
      behaviors: [{
        type: 'callback',
        value: { k: 'resume', sid: s.sessionId, cwd: s.cwd, thread: threadId },
      }],
    });
  });

  elements.push({ tag: 'hr' });
  const running = sessions.filter((s) => s.running).length;
  elements.push({
    tag: 'markdown',
    content: [
      '**按钮点不动的话，直接在这个话题里回复序号**，效果相同。',
      running ? `另有 ${running} 个会话正在运行，未列出（同一会话不能在两个窗口同时打开）。` : '',
      '恢复后窗口就绪时会提示，你再发正文。',
    ].filter(Boolean).join('\n'),
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '恢复会话' }, template: 'turquoise' },
    body: { elements },
  };
}

async function startResume(messageId, threadId, content) {
  const key = threadId || messageId;
  // 恢复的会话必须落在同一个工作区：话题已绑定窗口时按该窗口目录过滤，
  // 新话题里发 #resume 则不限。跨目录恢复只会把对话带到一个不该去的目录里。
  const scopeCwd = threadCwd(threadId);
  const all = lib.discoverSessions();
  const sessions = scopeCwd
    ? all.filter((s) => sameWorkspace(scopeCwd, s.cwd))
    : all;

  if (!sessions.length) {
    replyCard(messageId, {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '没有可恢复的会话' }, template: 'red' },
      body: {
        elements: [{
          tag: 'markdown',
          content: scopeCwd
            ? `\`${scopeCwd}\` 这个工作区近 5 天没有可恢复的会话。`
            : '近 5 天没有找到任何 Claude Code 会话记录。',
        }],
      },
    });
    return;
  }

  const pickable = sessions.filter((s) => !s.running).slice(0, settings.get('resumeMax'));
  if (!pickable.length) {
    replyCard(messageId, {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '没有可恢复的会话' }, template: 'orange' },
      body: {
        elements: [{
          tag: 'markdown',
          content: `近 5 天在${scopeCwd ? ` \`${scopeCwd}\` ` : ''}发现 ${sessions.length} 个会话，但**全部正在运行**。\n同一会话不能在两个窗口同时打开，请先关掉原窗口再试。`,
        }],
      },
    });
    return;
  }

  // 候选只存可选的，序号必须与卡片一致
  lib.writePending(key, {
    kind: 'resume',
    messageId,
    threadId,
    list: pickable.map((s) => ({ sid: s.sessionId, cwd: s.cwd })),
  });

  replyCard(messageId, buildResumeCard(sessions, key, '选一个要接着聊的会话：', scopeCwd));
  lib.log('bridge', `恢复会话候选 ${pickable.length} 个（${scopeCwd ? '限定 ' + scopeCwd + '，' : ''}共 ${sessions.length}，运行中 ${sessions.length - pickable.length}）`);
}

// 恢复：新窗口直接 --resume 旧 sessionId，不再生成新 id
async function resumeSession(messageId, threadId, sid, cwd) {
  replyCard(messageId, {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '正在恢复会话…' }, template: 'blue' },
    body: { elements: [{ tag: 'markdown', content: `↩️ \`${sid.slice(0, 8)}\`\n📁 \`${cwd}\`` }] },
  });
  await launchWindow(threadId, messageId, cwd, sid);
}

// 先回「正在拉起窗口」，再拉起；窗口就绪后回「已创建」
module.exports = {
  sessionLabel, threadCwd, sameWorkspace, buildResumeCard,
  startResume, resumeSession,
};
