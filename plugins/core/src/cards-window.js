'use strict';

// 窗口相关卡片：工作区选择、已选择、窗口就绪。
// 卡片是纯函数——输入数据、吐出飞书卡片 JSON，发请求的事交给 reply.js。

const lib = require('../../../kernel/lib');
const settings = require('./settings');

function shortLabel(cwd) {
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return parts.slice(-2).join('/');
}

function buildPickerCard(workspaces, threadId, note, kind) {
  const max = settings.get('pickMax');
  const list = workspaces.slice(0, max);
  const elements = [];
  const actionKind = kind || 'pick';

  elements.push({ tag: 'markdown', content: actionKind === 'newwinpick' ? '**另开一个窗口**' : '**新建窗口**' });
  if (note) elements.push({ tag: 'markdown', content: note });
  elements.push({ tag: 'hr' });

  list.forEach((w, i) => {
    const mark = w.trusted ? '' : ' ⚠️需在电脑确认';
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: `${i + 1}. ${shortLabel(w.cwd)}${mark}` },
      type: i === 0 ? 'primary_filled' : 'default',
      width: 'fill',
      behaviors: [{
        type: 'callback',
        value: { k: actionKind, cwd: w.cwd, thread: threadId },
      }],
    });
  });

  elements.push({ tag: 'hr' });
  // 卡片按钮依赖「回调配置」订阅；万一没订阅，直接回数字也能选，避免卡死
  elements.push({
    tag: 'markdown',
    content: [
      '**按钮点不动的话，直接在这个话题里回复序号**（如 `1`），效果相同。',
      workspaces.length > max
        ? `共发现 ${workspaces.length} 个，卡片最多放 ${max} 个，这里列前 ${max} 个。`
        : '',
      '也可以发 `#目录名` 或 `#绝对路径` 直接指定。',
    ].filter(Boolean).join('\n'),
  });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '选择工作区' }, template: 'blue' },
    body: { elements },
  };
}

function buildPickedCard(cwd, launching) {
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: '已选择工作区' }, template: 'green' },
    body: {
      elements: [
        { tag: 'markdown', content: `📁 \`${cwd}\`` },
        { tag: 'markdown', content: launching ? '正在拉起终端窗口…' : '终端窗口已拉起。' },
      ],
    },
  };
}

// 窗口就绪卡片：带上常用操作按钮。
// 这些按钮不是斜杠指令——斜杠指令只能由人在终端里敲，机器人执行的是等价动作。
function buildReadyCard({ cwd, sessionId, resumed, threadId, messageId, note }) {
  const elements = [
    { tag: 'markdown', content: `📁 \`${cwd}\`` },
    {
      tag: 'markdown',
      content: resumed
        ? `↩️ 接续 \`${String(sessionId).slice(0, 8)}\``
        : `🆔 \`${String(sessionId).slice(0, 8)}\``,
    },
    { tag: 'markdown', content: note || '现在**直接在这个话题里发消息**即可继续。' },
  ];

  if (threadId) {
    elements.push({ tag: 'hr' });
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '🔁 换会话（resume）' },
      type: 'primary_filled',
      width: 'fill',
      behaviors: [{
        type: 'callback',
        // 点它等价于在这个话题里发一次 #resume：弹会话选择，选完改绑当前话题
        value: { k: 'pickresume', thread: threadId, messageId },
      }],
    });
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: '➕ 再开一个窗口' },
      type: 'default',
      width: 'fill',
      behaviors: [{
        type: 'callback',
        value: { k: 'newwin' },
      }],
    });
    elements.push({
      tag: 'markdown',
      content: '换会话：新窗口接续所选会话，**本话题改绑到新窗口**。\n再开一个：另起一棵新话题，本话题继续留在当前窗口。',
    });
  }

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: resumed ? '会话已恢复' : '窗口已创建' },
      template: 'green',
    },
    body: { elements },
  };
}

module.exports = { shortLabel, buildPickerCard, buildPickedCard, buildReadyCard };
