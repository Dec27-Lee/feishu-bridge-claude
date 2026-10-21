'use strict';

// 人在不在电脑前，决定了卡片长什么样：
//   here → 不带按钮的提醒卡（弹窗已经在终端里了，飞书只是通知）
//   away → 带选项/按钮的作答卡（手机是唯一通道）
// 本模块负责「待答记录 → 卡片」，也负责选项点击后对记录的写入。

const lib = require('../../../kernel/lib');
const q = require('../../../kernel/questions');
const { sendCardNewTopic } = require('./reply');
const settings = require('./settings');

function mentionLine(cfg) {
  // @ 谁属于 core 插件的设置，不是用户顶层配置
  const ou = (cfg && cfg.notifyOpenId) || settings.get('notifyOpenId');
  return ou ? `<at id=${ou}></at>` : '';
}

// 卡片上交代一句「我在等多久、为什么等」。
// 人就在电脑前（here）时不会推作答卡，只推一张提醒卡，文字见 buildNoticeCard。
function waitHint(rec) {
  const p = rec.presence || {};
  if (p.level === 'away') {
    // 等待上限属于产生这条记录的插件（提问是 ask，权限是 permission），
    // 两边的 awayWaitSeconds 可以各配各的，所以按 kind 去读。
    const owner = rec.kind === 'permission' ? 'permission' : 'ask';
    const cfg = lib.readPluginConfig(owner);
    const min = Math.round((cfg.awayWaitSeconds || 1800) / 60);
    return `<font color='grey'>你不在电脑前，这里一直等你（${min} 分钟上限）。`
      + `你回到电脑前，弹窗会自动交还终端。</font>`;
  }
  return '';
}

// here 档的提醒卡：不阻塞、不需要作答，只是让手机那头知道「有个窗口在等你」。
// 真正的弹窗已经在终端里了，所以这张卡绝不能带选项——带了就会让人以为要在飞书答。
function buildNoticeCard(rec) {
  const at = mentionLine(null);
  const isPerm = rec.kind === 'permission';
  const tool = isPerm ? ((rec.payload || {}).toolName || '') : '';
  const q = isPerm ? '' : (((rec.questions || [])[0] || {}).question || '');

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: isPerm ? '🔐 窗口在等你确认操作' : '❓ 窗口在等你答题' },
      template: 'blue',
    },
    body: {
      elements: [
        ...(at ? [{ tag: 'markdown', content: at }] : []),
        { tag: 'markdown', content: `📁 \`${rec.cwd || ''}\`` },
        ...(tool ? [{ tag: 'markdown', content: `🔧 工具：\`${tool}\`` }] : []),
        ...(q ? [{ tag: 'markdown', content: `**${q}**` }] : []),
        { tag: 'hr' },
        {
          tag: 'markdown',
          content: '你正在电脑前，所以**弹窗已经出在那个终端窗口里了**，直接去窗口里按即可。\n'
            + '<font color=\'grey\'>这张卡只是提醒，不用在这里作答。</font>',
        },
      ],
    },
  };
}

function buildPermissionCard(rec) {
  const p = rec.payload || {};
  const tool = p.toolName || '未知工具';
  const ti = p.toolInput || {};

  // 工具入参各工具不一样，挑人能看懂的那几个字段展示
  const detail = [];
  if (ti.command) detail.push(`\`${String(ti.command).slice(0, 400)}\``);
  if (ti.description) detail.push(String(ti.description).slice(0, 200));
  if (ti.file_path) detail.push(`文件：\`${ti.file_path}\``);
  if (ti.path && !ti.file_path) detail.push(`路径：\`${ti.path}\``);
  if (ti.url) detail.push(`地址：\`${ti.url}\``);
  if (!detail.length) {
    const raw = JSON.stringify(ti);
    detail.push('```\n' + (raw.length > 500 ? raw.slice(0, 500) + '…' : raw) + '\n```');
  }

  const at = mentionLine(null);
  const hint = waitHint(rec);
  const elements = [
    ...(at ? [{ tag: 'markdown', content: at }] : []),
    { tag: 'markdown', content: `📁 \`${rec.cwd || ''}\`` },
    { tag: 'markdown', content: `🔧 工具：\`${tool}\`` },
    { tag: 'hr' },
    ...detail.map((t) => ({ tag: 'markdown', content: t })),
    ...(hint ? [{ tag: 'markdown', content: hint }] : []),
    { tag: 'hr' },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 允许这一次' },
      type: 'primary_filled',
      width: 'fill',
      behaviors: [{ type: 'callback', value: { k: 'perm', qid: rec.id, d: 'allow' } }],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 允许，本会话不再问这个工具' },
      type: 'default',
      width: 'fill',
      behaviors: [{ type: 'callback', value: { k: 'perm', qid: rec.id, d: 'allow', always: true } }],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '⛔ 拒绝' },
      type: 'danger',
      width: 'fill',
      behaviors: [{ type: 'callback', value: { k: 'perm', qid: rec.id, d: 'deny' } }],
    },
    {
      tag: 'button',
      text: { tag: 'plain_text', content: '🖥 我在电脑前，让终端问我' },
      type: 'default',
      width: 'fill',
      behaviors: [{ type: 'callback', value: { k: 'ansskip', qid: rec.id } }],
    },
    {
      tag: 'markdown',
      content: '「本会话不再问」会把规则写进本项目的 `.claude/settings.local.json`。\n'
        + '一直不答会自动交给终端，需要有人在电脑上按。',
    },
  ];

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '🔐 等你放行一个操作' }, template: 'orange' },
    body: { elements },
  };
}

function buildPermissionDoneCard(rec, decision) {
  const p = rec.payload || {};
  const allow = decision === 'allow';
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: allow ? '✅ 已允许' : '⛔ 已拒绝' },
      template: allow ? 'green' : 'grey',
    },
    body: {
      elements: [
        { tag: 'markdown', content: `🔧 工具：\`${p.toolName || ''}\`` },
        { tag: 'markdown', content: allow ? '窗口会继续执行。' : '窗口会收到拒绝理由，可换个做法。' },
      ],
    },
  };
}

// 当前展示到第几题 —— 一次只显示一题，手机上好点
function buildQuestionCard(rec) {
  const questions = rec.questions || [];
  const idx = Math.min(rec.cursor || 0, questions.length - 1);
  const cur = questions[idx] || {};
  const sel = rec.sel || {};
  const picked = sel[idx] || [];
  const total = questions.length;

  const elements = [];
  const at = mentionLine(null);
  const hint = waitHint(rec);
  if (at) elements.push({ tag: 'markdown', content: at });
  elements.push({ tag: 'markdown', content: `📁 \`${rec.cwd || ''}\`` });
  if (total > 1) {
    elements.push({ tag: 'markdown', content: `**第 ${idx + 1} / ${total} 题**　\`${cur.header || ''}\`` });
  }
  elements.push({ tag: 'hr' });
  elements.push({ tag: 'markdown', content: `**${cur.question || ''}**` });
  if (hint) elements.push({ tag: 'markdown', content: hint });

  (cur.options || []).forEach((o, oi) => {
    const isPicked = picked.includes(oi);
    const mark = cur.multiSelect ? (isPicked ? '☑ ' : '☐ ') : '';
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${mark}${o.label}` },
      type: isPicked ? 'primary_filled' : 'default',
      width: 'fill',
      behaviors: [{
        type: 'callback',
        // oi = 选项序号；服务端据此回查 label，卡片里不塞长文本
        value: { k: 'ans', qid: rec.id, qi: idx, oi },
      }],
    });
    if (o.description) {
      elements.push({ tag: 'markdown', content: `<font color='grey'>${o.description}</font>` });
    }
  });

  if (cur.multiSelect) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '✅ 就这些' },
      type: 'primary_filled',
      width: 'fill',
      behaviors: [{ type: 'callback', value: { k: 'ansok', qid: rec.id, qi: idx } }],
    });
  }

  elements.push({ tag: 'hr' });
  // 人就在电脑边上时给个出口：点了立刻把弹窗还给终端，不必干等超时
  elements.push({
    tag: 'button',
    text: { tag: 'plain_text', content: '🖥 我在电脑前，让终端问我' },
    type: 'default',
    width: 'fill',
    behaviors: [{ type: 'callback', value: { k: 'ansskip', qid: rec.id } }],
  });
  elements.push({
    tag: 'markdown',
    content: [
      '直接在**这个话题里回复文字**，就当作自定义答案（选项里没有的那个）。',
      cur.multiSelect ? '多选：点几个再点「就这些」。' : '',
      '一直不答会自动交给终端，需要有人在电脑上按。',
    ].filter(Boolean).join('\n'),
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `❓ 需要你来选${total > 1 ? `（${total} 题）` : ''}` },
      template: 'orange',
    },
    body: { elements },
  };
}

function buildAllAnsweredCard(rec) {
  const questions = rec.questions || [];
  const answers = rec.answers || {};
  const lines = questions.map((item) => {
    const a = answers[item.question];
    return `**${item.question}**\n→ ${a === undefined ? '（未答）' : a}`;
  });
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '✅ 已把答案送回窗口' }, template: 'green' },
    body: {
      elements: [
        { tag: 'markdown', content: `📁 \`${rec.cwd || ''}\`` },
        { tag: 'hr' },
        ...lines.map((t) => ({ tag: 'markdown', content: t })),
        { tag: 'hr' },
        { tag: 'markdown', content: '窗口会接着往下跑，结果会照常推到本话题。' },
      ],
    },
  };
}

// 把一题的答案写进记录，返回最新记录
function answerOne(qid, qi, value) {
  const rec = q.read(qid);
  if (!rec || rec.done) return null;
  const item = (rec.questions || [])[qi];
  if (!item) return null;
  const answers = {};
  answers[item.question] = value;   // key 必须与 questions[].question 原文一致
  const r = q.submit(qid, answers);
  return r.ok ? r.rec : null;
}

// 点选中的选项（多选时只切换勾选并刷新卡片，不提交）
function toggleOption(qid, qi, oi) {
  const rec = q.read(qid);
  if (!rec || rec.done) return null;
  const item = (rec.questions || [])[qi] || {};
  if (!item.multiSelect) return null;
  rec.sel = rec.sel || {};
  const cur = rec.sel[qi] || [];
  rec.sel[qi] = cur.includes(oi) ? cur.filter((x) => x !== oi) : [...cur, oi];
  q.write(qid, rec);
  return rec;
}

// 多选「就这些」：把勾中的 label 用 ", " 拼成一个字符串（与终端多选的形态一致）
function commitMulti(qid, qi) {
  const rec = q.read(qid);
  if (!rec || rec.done) return null;
  const item = (rec.questions || [])[qi] || {};
  const picked = ((rec.sel || {})[qi] || []).map((oi) => (item.options || [])[oi]).filter(Boolean);
  const value = picked.length ? picked.map((o) => o.label).join(', ') : '（未选）';
  return answerOne(qid, qi, value);
}

// 卡片发到哪：优先该窗口的话题；窗口还没话题时发到群里自成一条。
// noticeOnly（人在电脑前）走的是另一张卡：纯提醒、不带按钮。
function sendQuestionCard(rec) {
  const card = rec.noticeOnly ? buildNoticeCard(rec)
    : (rec.kind === 'permission' ? buildPermissionCard(rec) : buildQuestionCard(rec));
  const saved = lib.readThreadRoot(rec.sessionId);
  if (saved && saved.rootMessageId) {
    const res = lib.larkSync(['im', '+messages-reply', '--as', 'bot',
      '--message-id', saved.rootMessageId, '--reply-in-thread',
      '--msg-type', 'interactive', '--content', JSON.stringify(card)]);
    if (!res || !res.ok || !res.data) return null;
    // lark-cli 这里回的是 { chat_id, create_time, message_id }，字段名是下划线
    return { messageId: res.data.message_id, threadId: res.data.thread_id || null };
  }
  return sendCardNewTopic(card);
}

// 定期扫 data/questions：新提问推卡片（一个提问只推一次）
const askedCarded = new Set();
function pollQuestions() {
  for (const rec of q.listOpen(90 * 60000)) {
    if (askedCarded.has(rec.id)) continue;
    // 桥接重启后内存里的已推送集合是空的，靠记录里落盘的卡片 id 去重
    if (rec.cardMessageId) { askedCarded.add(rec.id); continue; }
    const sent = sendQuestionCard(rec);
    if (sent) {
      askedCarded.add(rec.id);
      // noticeOnly = 人在电脑前那张纯提醒卡。发出去就完事，不用等作答，
      // 也不该留下"待答"状态：否则用户在话题里随口说句话会被当成答案。
      if (rec.noticeOnly) {
        q.retire(rec.id, 'notified');
        lib.log('bridge', `推送提醒卡片 ${rec.id}（${rec.kind}，人在电脑前）-> ${sent.messageId || sent.message_id || '?'}`);
        continue;
      }
      // 推卡片期间 hook 可能已超时退出并删掉了记录——那就别再把它写回来，
      // 否则会留下一条没人等的"僵尸提问"，后面用户说话还会被当成作答。
      const fresh = q.read(rec.id);
      if (fresh && !fresh.done && !fresh.cancelled) {
        fresh.cardMessageId = sent.messageId;
        fresh.cardThreadId = sent.threadId;
        q.write(rec.id, fresh);
        lib.log('bridge', `推送提问卡片 ${rec.id}（${(rec.questions || []).length} 题）-> ${sent.messageId}`);
      } else {
        // 卡片已经发出去了，但题已经作废。不撤回（撤回是高风险操作，不该由桥接自动做），
        // 留着即可——用户点它会被回一句「这道题已超时」，不会误答。
        lib.log('bridge', `提问 ${rec.id} 已结束，卡片 ${sent.messageId} 已作废`);
      }
    } else {
      lib.log('error', `提问卡片发送失败 ${rec.id}`);
      askedCarded.add(rec.id);   // 别在下一轮里死循环重试
    }
  }
}

// 回复某条消息（进它所在的话题）。工作区选择卡片就是用这个投递的。
module.exports = {
  mentionLine, waitHint, buildNoticeCard, buildPermissionCard, buildPermissionDoneCard,
  buildQuestionCard, buildAllAnsweredCard, answerOne, toggleOption, commitMulti,
  sendQuestionCard, pollQuestions, askedCarded,
};
