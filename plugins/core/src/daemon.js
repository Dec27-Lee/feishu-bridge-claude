'use strict';

// core 插件内部的进程级设施：候选目录、话题反查。
// 注意：单实例锁与飞书事件消费者在 kernel/daemon.js 里（内核自己就要保证只有一份），
// 这里不要重复实现。

const lib = require('../../../kernel/lib');

// 工作区候选：优先只给已信任目录；全都未信任时才退回全量（卡片上会标警告）
function pickerCandidates() {
  const cfg = lib.readConfig();
  let workspaces = lib.discoverWorkspaces(cfg, { onlyTrusted: true });
  if (!workspaces.length) workspaces = lib.discoverWorkspaces(cfg);
  return workspaces;
}

// 卡片所在话题的 id。按钮回调只带 message_id，靠它反查 thread_id，
// 这样卡片上的按钮就不必预先知道自己会被发到哪棵树里。
function threadFromMessage(messageId) {
  if (!messageId) return null;
  try {
    const res = lib.larkSync(['im', '+messages-mget', '--as', 'bot', '--message-ids', messageId]);
    const msgs = res && res.ok && res.data && res.data.messages;
    return (Array.isArray(msgs) && msgs[0] && msgs[0].thread_id) || null;
  } catch (_) {
    return null;
  }
}

module.exports = { pickerCandidates, threadFromMessage };
