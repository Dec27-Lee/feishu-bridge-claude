'use strict';

// 卡片按钮回调的分发中心。value.k 对应按钮类型，处理完各自更新卡片。

const lib = require('../../../kernel/lib');
const q = require('../../../kernel/questions');
const { replyCard, sendCardNewTopic } = require('./reply');
const {
  buildPermissionDoneCard, buildQuestionCard, buildAllAnsweredCard,
  answerOne, toggleOption, commitMulti,
} = require('./qcards');
const { buildPickedCard, buildPickerCard } = require('./cards-window');
const { launchWindow } = require('./launch');
const { resumeSession, startResume } = require('./resume');
const { threadFromMessage, pickerCandidates } = require('./daemon');

async function handleCardAction(ev) {
  if (!ev || ev.type !== 'card.action.trigger') return;
  lib.log('card', JSON.stringify(ev).slice(0, 800));

  let val = {};
  try { val = typeof ev.action_value === 'string' ? JSON.parse(ev.action_value) : (ev.action_value || {}); }
  catch (_) { return; }

  const isResume = val.k === 'resume';
  const isPickResume = val.k === 'pickresume';
  const isNewWin = val.k === 'newwin';

  // 工具权限确认的按钮
  if (val.k === 'perm') {
    const rec = q.read(val.qid);
    if (!rec || rec.done) {
      lib.log('card', `权限请求 ${val.qid} 已结束，忽略点击`);
      const whyP = rec && rec.retireNote;
      // handover = 人在电脑前，hook 主动交还了；和 timeout 一样「已经不在飞书这头等了」
      const expiredP = whyP === 'timeout' || whyP === 'handover' || !rec;
      replyCard(ev.message_id, {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: expiredP ? '这个请求已交还终端' : '这条已经处理过了' },
          template: 'grey',
        },
        body: {
          elements: [{
            tag: 'markdown',
            content: expiredP
              ? (whyP === 'handover'
                ? '检测到你回到了电脑前，确认框已经交还给终端，**在窗口里按**即可。'
                : '等太久了，确认框已经交还给终端，**需要有人在电脑上按一次**。')
              : ((rec.answers || {}).decision === 'allow'
                ? '已经允许过了，窗口会继续执行。'
                : '已经拒绝过了，窗口会换个做法。'),
          }],
        },
      });
      return;
    }
    const r = q.decide(val.qid, val.d === 'allow' ? 'allow' : 'deny', { always: !!val.always });
    if (!r.ok) { lib.log('card', `权限作答失败: ${r.error}`); return; }
    lib.log('card', `权限 ${val.qid} -> ${val.d}${val.always ? '（本会话不再问）' : ''}`);
    try {
      if (ev.token) {
        lib.larkSync(['api', 'POST', '/open-apis/interactive/v1/card/update', '--as', 'bot',
          '--data', JSON.stringify({ token: ev.token, card: buildPermissionDoneCard(r.rec, val.d) })]);
      }
    } catch (e) { lib.log('error', `权限结果卡片更新失败: ${e.message}`); }
    return;
  }

  // 提问卡片的按钮：选项 / 多选确认 / 交还终端
  if (val.k === 'ansskip') {
    const rec = q.read(val.qid);
    if (rec && !rec.done) {
      q.cancel(val.qid);
      lib.log('card', `${rec.kind === 'permission' ? '权限确认' : '提问'} ${val.qid} 交还终端`);
      replyCard(ev.message_id, {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: '已交还终端' }, template: 'grey' },
        body: {
          elements: [{
            tag: 'markdown',
            content: '弹窗马上会出现在那个窗口里，**在电脑上按**即可。',
          }],
        },
      });
    }
    return;
  }

  if (val.k === 'ans' || val.k === 'ansok') {
    const rec0 = q.read(val.qid);
    if (!rec0 || rec0.done) {
      lib.log('card', `提问 ${val.qid} 已结束，忽略点击`);
      // 四种情况要分开说，否则「我刚点完却被告知超时」会让人以为功能坏了：
      //   retireNote=done      → 题目已经答完并交回窗口
      //   retireNote=timeout   → 等太久，弹窗已还给终端
      //   retireNote=handover  → 探测到你回到电脑前，hook 主动交还了
      //   retireNote=cancelled → 本人点了「交还终端」
      const why = rec0 && rec0.retireNote;
      const gone = why === 'timeout' || why === 'handover' || !rec0;
      const title = gone ? '这道题已交还终端' : '这道题已经答过了';
      const text = why === 'handover'
        ? '检测到你回到了电脑前，弹窗已经交给终端，**在窗口里按**即可。'
        : (gone
          ? '等太久了，弹窗已经交还给终端，**需要有人在电脑上按一次**。\n下一次提问会重新推卡片。'
          : '答案已经送回窗口，等它的结果就行。');
      replyCard(ev.message_id, {
        schema: '2.0',
        config: { wide_screen_mode: true },
        header: { title: { tag: 'plain_text', content: title }, template: 'grey' },
        body: { elements: [{ tag: 'markdown', content: text }] },
      });
      return;
    }
    let rec;
    if (val.k === 'ans') {
      const item = (rec0.questions || [])[val.qi] || {};
      if (item.multiSelect) {
        rec = toggleOption(val.qid, val.qi, val.oi);
        if (rec) {
          // 多选只切勾选：原地把卡片换成新状态，不提交
          try {
            if (ev.token) {
              lib.larkSync(['api', 'POST', '/open-apis/interactive/v1/card/update', '--as', 'bot',
                '--data', JSON.stringify({ token: ev.token, card: buildQuestionCard(rec) })]);
            }
          } catch (e) { lib.log('error', `提问卡片刷新失败: ${e.message}`); }
        }
        return;
      }
      const label = ((item.options || [])[val.oi] || {}).label;
      if (label === undefined) return;
      rec = answerOne(val.qid, val.qi, label);
    } else {
      rec = commitMulti(val.qid, val.qi);
    }
    if (!rec) return;

    if (rec.done) {
      lib.log('card', `提问 ${val.qid} 全部答完，回交窗口`);
      // 答完就不再显示选项，换成结果卡片
      try {
        if (ev.token) {
          lib.larkSync(['api', 'POST', '/open-apis/interactive/v1/card/update', '--as', 'bot',
            '--data', JSON.stringify({ token: ev.token, card: buildAllAnsweredCard(rec) })]);
        }
      } catch (e) { lib.log('error', `提问结果卡片更新失败: ${e.message}`); }
      return;
    }
    // 还有下一题：把下一题推成新卡片（旧卡片内容已过时，标记一下）
    const next = buildQuestionCard(rec);
    replyCard(ev.message_id, next);
    return;
  }

  // 「再开一个窗口」→ 先弹工作区卡片；选中的按钮带 k='newwinpick'
  if (isNewWin) {
    lib.log('card', `再开一个窗口（from ${ev.message_id}）`);
    await replyCard(ev.message_id, buildPickerCard(
      pickerCandidates(), null, '选一个工作区，我会**另起一棵新话题**，本话题保持不动。', 'newwinpick'));
    return;
  }
  if (val.k === 'newwinpick') {
    if (!val.cwd) {
      lib.log('card', `另开窗口缺 cwd: ${ev.action_value}`);
      return;
    }
    lib.log('card', `另开窗口 ${val.cwd}`);
    // 新话题：直接发到群里（不带 reply），它自成一颗新话题
    const created = sendCardNewTopic({
      schema: '2.0',
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '正在拉起窗口…' }, template: 'blue' },
      body: { elements: [{ tag: 'markdown', content: `📁 \`${val.cwd}\`` }] },
    });
    if (!created) {
      lib.log('error', '另开窗口：新话题创建失败');
      return;
    }
    await launchWindow(created.threadId, created.messageId, val.cwd);
    return;
  }
  if (isPickResume) {
    const tid = val.thread || threadFromMessage(ev.message_id);
    lib.log('card', `换会话（thread=${tid}）`);
    await startResume(ev.message_id, tid, '#resume');
    return;
  }

  if (!isResume && (val.k !== 'pick' || !val.cwd)) {
    lib.log('card', `未识别的按钮动作 ${ev.action_value}`);
    return;
  }
  if (isResume && !val.sid) {
    lib.log('card', `恢复会话回调缺 sid: ${ev.action_value}`);
    return;
  }

  const threadId = val.thread || null;
  const pending = (threadId && lib.readPending(threadId)) || null;

  // 恢复会话的按钮只带 sid，cwd 要从 pending 候选里取回来
  const hit = (isResume && pending && Array.isArray(pending.list))
    ? pending.list.find((x) => x && x.sid === val.sid) : null;
  const cwd = val.cwd || (hit && hit.cwd) || null;

  // 卡片置为已选：先更新（token 有效期短，优先做）
  try {
    if (ev.token && cwd) {
      lib.larkSync(['api', 'POST', '/open-apis/interactive/v1/card/update', '--as', 'bot',
        '--data', JSON.stringify({ token: ev.token, card: buildPickedCard(cwd, true) })]);
    }
  } catch (e) {
    lib.log('error', `卡片更新失败: ${e.message}`);
  }

  // 卡片本身只带 cwd/sid；原话题的消息 id 在发卡片时写进了 data/pending/<threadId>.json
  const messageId = pending && pending.messageId ? pending.messageId : ev.message_id;
  if (threadId) lib.removePending(threadId);

  if (isResume) {
    if (!cwd) {
      lib.log('error', `恢复会话缺 cwd（sid=${val.sid}）`);
      return;
    }
    lib.log('card', `恢复会话 ${String(val.sid).slice(0, 8)}（thread=${threadId}）`);
    await resumeSession(messageId, threadId, val.sid, cwd);
    return;
  }

  lib.log('card', `选择工作区 ${cwd}（thread=${threadId}）`);
  await launchWindow(threadId, messageId, cwd);
}

module.exports = { handleCardAction };
