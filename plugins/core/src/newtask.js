'use strict';

// 新话题 = 新窗口。触发消息本身不发给 Claude，只当「我要开个窗口」的信号；
// 用户选完工作区、窗口就绪后，再自己在话题里发正文。
// 也负责「候选卡片已发过、用户直接回了序号」这条路。

const path = require('path');
const lib = require('../../../kernel/lib');
const { replyCard } = require('./reply');
const { buildPickerCard } = require('./cards-window');
const settings = require('./settings');
const { announceAndLaunch } = require('./launch');
const { startResume, resumeSession } = require('./resume');
const { pickerCandidates } = require('./daemon');

function resolveCwd(content) {
  const cfg = lib.readConfig();
  const aliases = cfg.launchAliases || {};

  const m = content.match(/(?:^|\s)#([\w一-龥\/\\.:-]+)/);
  if (m) {
    const key = m[1].replace(/[，,。.]+$/, '');
    if (aliases[key]) return { cwd: aliases[key], hit: key, explicit: true };
    if (/^[a-zA-Z]:[\\/]/.test(key)) return { cwd: key, hit: key, explicit: true };
    const discovered = lib.discoverWorkspaces(cfg);
    const byName = discovered.find((w) =>
      path.basename(w.cwd).toLowerCase().includes(key.toLowerCase()));
    if (byName) return { cwd: byName.cwd, hit: key, explicit: true };
    // 写了 #xxx 却没匹配上，不能静默用默认目录——否则用户以为进了 A，实际在 B
    return { cwd: null, hit: key, explicit: true, unmatched: true };
  }

  return { cwd: null, hit: null, explicit: false, unmatched: false };
}


async function startNewTask(messageId, threadId, content) {
  // `#resume` / `#恢复` = 恢复一个历史会话，走另一条路
  if (/^#(resume|恢复|继续)(\s|$)/i.test(content.trim())) {
    await startResume(messageId, threadId, content);
    return;
  }

  const pick = resolveCwd(content);

  if (pick.cwd) {
    // 写了可解析的 #目录 → 跳过选择，直接开
    await announceAndLaunch(messageId, threadId, pick.cwd);
    return;
  }

  // 没写 #，或者写了但没匹配上 —— 都把候选目录推给用户点选。
  // 优先只给「已信任」目录：未信任目录在终端会先停在一屏确认框上等回车，
  // 远程场景下点下去只会得到一个卡住的窗口。全部未信任时才退回全量（并标警告）。
  const workspaces = pickerCandidates();
  if (!workspaces.length) {
    replyCard(messageId, {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '没有可用工作区' }, template: 'red' },
      body: { elements: [{ tag: 'markdown', content: '没有在 Claude Code 记录里找到任何工作目录。' }] },
    });
    return;
  }

  const key = threadId || messageId;
  const list = workspaces.slice(0, settings.get('pickMax')).map((w) => w.cwd);

  // 记住候选列表：按钮回调靠它，用户回数字也靠它（序号必须与卡片一致）
  lib.writePending(key, {
    messageId, threadId, unmatched: pick.unmatched, hit: pick.hit, list,
  });

  const note = pick.unmatched
    ? `未找到目录 \`${pick.hit}\`，请重新选择。`
    : '选好工作区后我会拉起终端窗口，**建好之后你再发正文**。';
  replyCard(messageId, buildPickerCard(workspaces, key, note));
  lib.log('bridge', `新话题 ${key} 待选工作区，候选 ${list.length} 个`);
}


function tryPickByNumber(threadId, content) {
  const pending = lib.readPending(threadId);
  if (!pending || !Array.isArray(pending.list) || !pending.list.length) return false;

  const m = content.trim().match(/^#?(\d{1,2})$/);
  if (!m) return false;
  const idx = parseInt(m[1], 10) - 1;
  if (idx < 0 || idx >= pending.list.length) return false;

  const entry = pending.list[idx];
  const isResume = pending.kind === 'resume';
  const cwd = isResume ? entry.cwd : entry;
  const sid = isResume ? entry.sid : null;
  lib.removePending(threadId);
  lib.log('bridge', `按序号 ${idx + 1} 选定 ${isResume ? '会话 ' + String(sid).slice(0, 8) : '工作区 ' + cwd}（thread=${threadId}）`);

  if (isResume) {
    resumeSession(pending.messageId, threadId, sid, cwd)
      .catch((e) => lib.log('error', `按序号恢复会话失败: ${e.message}`));
  } else {
    announceAndLaunch(pending.messageId, threadId, cwd)
      .catch((e) => lib.log('error', `按序号开窗口失败: ${e.message}`));
  }
  return true;
}

// 拉起终端窗口并把这条话题绑定到新会话。
// 不再投递任何内容：用户选完工作区后只回一张「创建成功」，正文由用户自己再发。
module.exports = { resolveCwd, startNewTask, tryPickByNumber };
