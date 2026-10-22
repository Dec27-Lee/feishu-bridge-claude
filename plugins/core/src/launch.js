'use strict';

// 拉起一个 Claude Code 窗口，并把话题绑定到新会话。
// 开窗动作本身是平台专有的，交给 platform/；本模块只管绑定关系与等待注册。

const path = require('path');
const lib = require('../../../kernel/lib');
const platform = require('../../../platform');
const { replyCard } = require('./reply');
const { buildReadyCard } = require('./cards-window');
const settings = require('./settings');

async function announceAndLaunch(messageId, threadId, cwd) {
  let trusted = lib.isTrusted(cwd);
  let trustNote = null;

  // 会弹确认框的目录：先尝试替用户预置信任，成功就不必再回电脑按回车。
  // 写 ~/.claude.json 有可能被正在跑的 Claude Code 覆盖，因此只当「改善」不做保证。
  if (!trusted) {
    const t = lib.trustWorkspace(cwd);
    if (t.changed) {
      trusted = lib.isTrusted(cwd);
      trustNote = trusted
        ? `已自动把它加入信任目录（写入 \`${t.key}\`）。`
        : `尝试预置信任 \`${t.key}\`，但校验仍未通过，终端可能仍会弹确认框。`;
    } else if (t.already) {
      trusted = lib.isTrusted(cwd);
    } else if (t.error) {
      trustNote = `自动信任失败：${t.error}`;
    }
  }

  replyCard(messageId, {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: trusted ? '正在拉起窗口…' : '正在拉起窗口（需确认）' },
      template: trusted ? 'blue' : 'orange',
    },
    body: {
      elements: [
        { tag: 'markdown', content: `📁 \`${cwd}\`` },
        ...(trustNote ? [{ tag: 'markdown', content: trustNote }] : []),
        ...(trusted ? [] : [{ tag: 'markdown', content: '⚠️ 这个目录还没被 Claude Code 信任过，终端会先弹一次确认框，**需要你在电脑上按回车**。' }]),
      ],
    },
  });
  await launchWindow(threadId, messageId, cwd);
}

// 拉起终端窗口并把这条话题绑定到新会话。
// 不再投递任何内容：用户选完工作区后只回一张「创建成功」，正文由用户自己再发。
// resumeSid 有值时走 `claude --resume <旧id>`（恢复历史会话），否则新建一个会话。
async function launchWindow(threadId, messageId, cwd, resumeSid) {
  const crypto = require('crypto');
  // 恢复会话时，Claude 侧沿用旧的 sessionId；映射也必须用同一个 id，
  // 否则 SessionStart hook 注册上来的记录对不上，话题就路由不到。
  const sessionId = resumeSid || crypto.randomUUID();
  const isResume = !!resumeSid;

  const rec = {
    sessionId,
    sessionName: isResume ? `恢复 ${sessionId.slice(0, 8)}` : `新窗口 ${path.basename(cwd) || sessionId.slice(0, 4)}`,
    cwd,
    createdAt: Date.now(),
    via: isResume ? 'resume' : 'launch',
  };
  // 引出这条话题的消息本身也进映射（引用它也能路由）
  lib.appendMapping({ ...rec, feishuMessageId: messageId });
  // 关键：把这个话题绑定到新窗口，用户建好后在该话题里打字即可路由。
  // 这棵树是用户在飞书里挑定/新开的，notify.js 不能因为「拿到 AI 标题」就另开话题，
  // 否则用户刚选的树会被丢下，回复全跑到新话题里。
  if (threadId) {
    lib.appendMapping({ ...rec, feishuMessageId: threadId, via: 'thread' });
    lib.writeThreadRoot(sessionId, messageId, threadId, { fromAiTitle: true, userPicked: true });
    // 新话题顺手置顶：群里话题一多，新窗口很容易被刷到看不见的地方
    if (settings.get('pinTopics') !== false) {
      const pin = lib.pinThreadRoot(messageId);
      if (!pin.ok) lib.log('bridge', `话题置顶失败（不影响收发）: ${pin.error}`);
    }
  }

  // 开窗一律走平台层。这里曾经自己拼了一份 cscript 命令直接 spawn，
  // 结果平台层的所有修复（wt.exe 绝对路径、失败可见性）全都绕过了——
  // 出问题时表现为「永远 30 秒超时」，而平台的报错逻辑一次都没跑到。
  try {
    platform.spawnWindow({ sessionId, cwd, resumeId: isResume ? sessionId : null });
  } catch (e) {
    lib.log('error', `开窗失败 ${sessionId}：${e.message}`);
    replyCard(messageId, {
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '窗口拉不起来' }, template: 'red' },
      body: {
        elements: [
          { tag: 'markdown', content: `📁 \`${cwd}\`` },
          { tag: 'hr' },
          { tag: 'markdown', content: e.message },
          { tag: 'hr' },
          { tag: 'markdown', content: '这通常是终端或脚本层面的问题，不是目录权限。'
            + '在电脑上手动开一个窗口，然后在这个话题里发 `#resume` 绑定即可继续。' },
        ],
      },
    });
    return;
  }

  lib.log('bridge', `${isResume ? '恢复会话' : '开新窗口'} ${sessionId} (cwd=${cwd})，等待注册`);

  // 等 SessionStart hook 注册（约 3-10 秒）后再回「创建成功」
  const timeoutSec = settings.get('launchTimeoutSeconds');
  for (let i = 0; i < timeoutSec; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const s = lib.readSession(sessionId);
    if (s && s.socket) {
      lib.log('bridge', `${isResume ? '恢复' : '新窗口'} ${sessionId} 已注册（${i + 1}s）`);
      replyCard(messageId, buildReadyCard({
        cwd, sessionId, resumed: isResume, threadId, messageId,
      }));
      return;
    }
  }
  lib.log('error', `${isResume ? '恢复会话' : '新窗口'} ${sessionId} ${timeoutSec} 秒内未注册`);
  replyCard(messageId, {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: isResume ? '恢复会话超时' : '窗口创建超时' },
      template: 'red',
    },
    body: {
      elements: [
        { tag: 'markdown', content: `📁 \`${cwd}\`` },
        { tag: 'markdown', content: isResume
          ? '该会话可能仍在别处运行（同一会话不能在两个窗口同时打开），或终端没起来。'
          : '终端可能没起来，或目录停在信任确认框上等人按回车。' },
      ],
    },
  });
}

module.exports = { announceAndLaunch, launchWindow };
