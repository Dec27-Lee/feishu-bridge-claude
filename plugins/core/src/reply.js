'use strict';

// 把卡片发回飞书：回复某条消息（进它所在的话题），或在群里另起一条。

const lib = require('../../../kernel/lib');

function replyCard(messageId, card) {
  const res = lib.larkSync(['im', '+messages-reply', '--as', 'bot',
    '--message-id', messageId, '--reply-in-thread',
    '--msg-type', 'interactive', '--content', JSON.stringify(card)]);
  return res && res.ok ? res.data : null;
}

// 直接发到群里（不开新话题分支）——话题群里一条不带 reply 的消息会自成新话题。
// 用于「再开一个窗口」：给新窗口配一棵全新的話題，原话题继续归原窗口。
function sendCardNewTopic(card) {
  const cfg = lib.readConfig();
  const res = lib.larkSync(['im', '+messages-send', '--as', 'bot',
    '--chat-id', cfg.chatId, '--msg-type', 'interactive', '--content', JSON.stringify(card)]);
  if (!res || !res.ok || !res.data || !res.data.message_id) return null;

  const mid = res.data.message_id;
  let threadId = null;
  try {
    const info = lib.larkSync(['api', 'GET',
      `https://open.feishu.cn/open-apis/im/v1/messages/${mid}`, '--as', 'bot']);
    const item = ((info && info.data && info.data.items) || [])[0] || {};
    threadId = item.thread_id || null;
  } catch (_) {}
  return { messageId: mid, threadId };
}

// 新话题 = 新建窗口。触发消息本身**不发给 Claude**，只当作「我要开个窗口」的信号；
module.exports = { replyCard, sendCardNewTopic };
