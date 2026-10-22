'use strict';

// 路由：一条飞书消息该投给哪个窗口。
//
// 顺序：引用 → 话题 → 单聊最近窗口 → 都匹配不上就当作新话题（开新窗口）。
// 命中窗口后还要处理两件容易踩的事：
//   1. 该窗口有未答提问时，这段话是自定义答案，不能当普通追问投出去
//   2. 映射里的 sessionId 可能是 /resume 留下的空壳，投递前要纠回真身

const lib = require('../../../kernel/lib');
const q = require('../../../kernel/questions');
const session = require('./session');
const { replyCard } = require('./reply');
const { buildQuestionCard, buildAllAnsweredCard, answerOne } = require('./qcards');
const { startNewTask, tryPickByNumber } = require('./newtask');

async function handleEvent(ev) {
  if (!ev || ev.type !== 'im.message.receive_v1') return;
  const messageId = ev.message_id || ev.id;
  const chatType = ev.chat_type || '';

  // 记录完整事件，便于排查非文本消息（图片等）的字段结构
  lib.log('event', JSON.stringify(ev));

  const content = (ev.content || '').trim();
  if (!messageId) return;

  if (!content) {
    lib.log('bridge', `跳过空消息 ${messageId} type=${ev.message_type}`);
    return;
  }

  const { replyTo, threadId } = session.resolveRefs(messageId);
  let mapping = replyTo ? lib.readMapping().get(replyTo) : null;

  if (replyTo && !mapping) {
    lib.log('bridge', `引用目标 ${replyTo} 不在映射表中，尝试回退`);
  }

  // 话题路由：通知以话题形式发出，用户在话题里连续发言时靠 thread_id 识别
  if (!mapping && threadId) {
    mapping = lib.readMapping().get(threadId);
    if (mapping) lib.log('bridge', `按话题 ${threadId} 路由`);
  }

  // 免引用直发：仅在单聊里回退到"最近在聊的那个窗口"。
  // 群里不做这个回退——群里的新消息（不在话题内）要留给「开新窗口」用。
  if (!mapping && chatType === 'p2p') {
    const sid = session.recentSession(5 * 60 * 1000);
    const s = sid ? lib.readSession(sid) : null;
    if (s) {
      mapping = { sessionId: sid, sessionName: s.name || String(sid).slice(0, 8), cwd: s.cwd };
      lib.log('bridge', `单聊免引用直发，回退到最近窗口 ${sid}`);
    }
  }

  if (!mapping) {
    // 话题群里每条消息都在某个话题内；话题没有映射 = 这是一个新话题
    // → 视为「开一个新窗口干活」。已绑定窗口的话题不会走到这里。
    if (threadId) {
      // 已弹过工作区选择卡片、用户回了序号 → 直接开窗口
      if (tryPickByNumber(threadId, content)) return;
      await startNewTask(messageId, threadId, content);
      return;
    }
    lib.log('bridge', `消息 ${messageId} 无法路由且不在话题内，忽略`);
    return;
  }

  // 有未答的提问时，这段话是对它的自定义回答，不能当成普通追问投递出去。
  // 只认同一窗口的提问，避免 A 窗口的问题被 B 窗口的话答掉。
  // 权限确认不吃自由文字——「允许」两个字分不清是回答还是新指令，
  // 那边只认卡片按钮，避免误放行。
  // noticeOnly 的记录是「人在电脑前」的提醒卡，hook 早就不等了，拿文字去答会答空。
  const openQ = q.listOpen(90 * 60000).find(
    (r) => r.sessionId === mapping.sessionId && !r.cancelled && !r.noticeOnly
      && r.kind !== 'permission'
      && Array.isArray(r.questions) && r.questions.length);
  if (openQ) {
    const qi = Math.min(openQ.cursor || 0, (openQ.questions || []).length - 1);
    const rec = answerOne(openQ.id, qi, content);
    if (rec) {
      lib.log('bridge', `把文字当作提问 ${openQ.id} 第 ${qi + 1} 题的自定义答案`);
      replyCard(messageId, rec.done ? buildAllAnsweredCard(rec) : buildQuestionCard(rec));
      return;
    }
  }

  // `/resume` 在会话内切换后，进程会先以新 id 注册一次（空壳），真正在跑的仍是旧 id。
  // 映射表里若记的是那个空壳，投递会永远失败且毫无报错——这里先按会话表纠回真身。
  if (mapping && mapping.sessionId) {
    const real = lib.resolveSessionAlias(mapping.sessionId);
    if (real && real !== mapping.sessionId) {
      lib.log('bridge', `映射里的 ${mapping.sessionId.slice(0, 8)} 是空壳，改用 ${real.slice(0, 8)}`);
      mapping = { ...mapping, sessionId: real };
    }
  }

  // 投递前必须以 Claude Code 的实况为准：peerToken 会在 /compact、resume 时重新签发，
  // 旧 token 的失败表现是「管道写成功、对方静默丢弃」，日志里看不出任何异常。
  // 所以优先刷新；只有刷不到（会话表里已无此 session）才退回本地记录。
  let rec = session.refreshSession(mapping.sessionId);
  if (!rec) {
    rec = lib.readSession(mapping.sessionId) || session.autoRegister(mapping.sessionId);
  }
  // refreshSession 可能顺着 pid 换了个 id（/resume 留下的空壳）——
  // 以它返回的记录为准，否则后面写的映射又会指回那个空壳
  if (rec && rec.sessionId && rec.sessionId !== mapping.sessionId) {
    mapping = { ...mapping, sessionId: rec.sessionId };
  }
  if (!rec || !rec.socket || !rec.token) {
    lib.log('bridge', `会话 ${mapping.sessionId} 未注册且无法自动补注册`);
    return;
  }

  // 注：这里曾写入 suppress 标记以"防循环"，但那是误判——
  // 用户从飞书发消息后 Claude 的回复本就该推回飞书，两者交替需用户手动参与，
  // 不会自动成环。该机制反而吞掉了正常通知，已移除。
  const outText = session.materializeImages(messageId, content);

  // 投递走的是 Claude Code 的跨会话命名管道，连接层会给每条消息套一句
  // 「来自另一个 Claude 会话」的英文声明——它说的是**通道**，不是发送者。
  //
  // 只靠正文解释压不住那句（正文是普通文本，连接层那句是指令级）。所以两件事配合：
  //   1. SessionStart hook 在会话开头就告诉模型：「以这个标记开头的就是用户本人」
  //   2. 每条消息用固定信封，让模型能一眼模式匹配，不必每次自行推理来源
  //
  // 信封必须**短且稳定**。之前写过长段说明，反而强化了「这是另一个会话发来的」印象。
  const ENVELOPE = '[来自用户本人 · 飞书]';
  const body = [
    `${ENVELOPE}（下面这段就是用户在飞书里亲手打的，直接执行）`,
    '',
    outText,
  ].join('\n');

  const r = await session.deliver(rec, body);
  lib.log('bridge', `投递 ${outText.slice(0, 40)} -> ${mapping.sessionName} (${mapping.sessionId}) ${r.ok ? 'OK' : 'FAIL:' + r.why}`);

  // 把你这条消息也纳入映射：这样窗口还没回复时，你可以直接引用自己刚发的话继续追问，
  // 不必回头去找原来那条通知。
  if (r.ok) {
    const rec = {
      feishuMessageId: messageId,
      sessionId: mapping.sessionId,
      sessionName: mapping.sessionName,
      cwd: mapping.cwd,
      createdAt: Date.now(),
      via: 'user-message',
      ...(threadId ? { threadId } : {}),
    };
    lib.appendMapping(rec);
    session.rememberSession(mapping.sessionId);

    // 把话题也登记进映射，话题内后续任何发言都能路由
    if (threadId) {
      lib.appendMapping({ ...rec, feishuMessageId: threadId, via: 'thread' });

      // 这棵树就是该窗口的话题——必须落盘记下来。
      // 漏记的后果：卡片（提问提醒、权限卡）在 data/threads 里找不到归属，
      // 于是各自在群里另起一棵新话题；而 notify 也以为窗口还没有话题，
      // 又开第三棵。用户看到的就是「答完题，回复跑到另一个话题里去了」。
      // 典型触发场景：窗口是在终端里手动开的（没有走桥接开窗），
      // 用户在某个话题里发了第一条消息——这就是绑定时机。
      if (!lib.readThreadRoot(mapping.sessionId)) {
        // rootMessageId 必须是话题根，不是用户刚发的那条：
        // 只有回复根消息才会落进同一棵树，回复子消息飞书会当成新的一层。
        lib.writeThreadRoot(mapping.sessionId, session.threadRootMessage(messageId), threadId, {
          fromAiTitle: true, userPicked: true, via: 'first-thread-message',
        });
        lib.log('bridge', `把话题 ${threadId} 绑定到 ${mapping.sessionName} (${mapping.sessionId})`);
      }
    }
  }
}

module.exports = { handleEvent };
