'use strict';

// 卡片长什么样：一行状态 + 正在用的工具 + 本轮动过的文件 + 最后一句 + 上下文用量。
//
// 这张卡是**原地刷新**的，不产生新消息，所以内容要能自己说明「现在怎么样」：
// 用户在群里点开话题看到它，一眼就该知道窗口在跑还是在等。

// 运行中的计时：两分钟以内精确到秒（看得出在动），再往上只到分钟，
// 免得每秒一次的刷新变成纯噪声——卡片内容变了才发请求，见 index.js 的签名比较。
function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 120) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

// 空闲计时**只到分钟**，精确到秒没有意义——而且这里的粒度直接决定发多少请求：
// 卡片在内容签名变化时才 patch，秒级的「59 秒前 → 1 分钟前」会让空闲窗口
// 每秒都刷新一次，纯属噪声。
function formatAgo(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

// 文件名在卡片上只留最后两段，路径太长会把一行撑爆
function shortPath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  const parts = s.split('/').filter(Boolean);
  if (parts.length <= 2) return s;
  return '…/' + parts.slice(-2).join('/');
}

function esc(s) {
  return String(s || '').replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›'));
}

// 卡片上显示哪几行由配置决定（`plugin.json` 的 `config`，配置页可改）。
// 这里给出**缺省全开**的一份，好让直接调 buildStatusCard 的地方不必都传。
const DEFAULT_VIEW = {
  showPrompt: true,
  showToolDetail: true,
  showEditedFiles: true,
  showModelSaid: true,
  showStats: true,
  promptMaxChars: 1200,
  textMaxChars: 140,
  maxSubtaskLines: 3,
};

// 状态卡的唯一构造函数。所有变化都体现在参数里，函数本身无状态。
//
// opts: { title, cwd, running, runningSince, idleSince, probe, stats, view }
//   title 已经由调用方定好顺序（/rename 的名字 → AI 标题 → 会话表名），
//   这里只负责渲染。
//   view  见 DEFAULT_VIEW：哪几行显示、各自截多少字。
function buildStatusCard(opts) {
  const {
    title, cwd, running, runningSince, idleSince, probe, stats,
  } = opts;

  const view = { ...DEFAULT_VIEW, ...(opts.view || {}) };
  const maxText = view.textMaxChars;

  const elements = [];
  const p = probe || {};
  const subs = (p.subtasks || []).slice(0, view.maxSubtaskLines);

  // 「你这一轮说了什么」——终端里敲的和飞书发的都在这里，正是用户要的那一行。
  // 放在最上面：先知道这一轮在回答什么，再看窗口在干什么。
  // promptLines() 返回的是**卡片元素数组**（短的一行 markdown、长的折叠面板），
  // 直接展开进 elements；包成 `{tag:'markdown', content: {...}}` 会渲染不出来。
  if (view.showPrompt) elements.push(...promptLines(p.myPrompt, view.promptMaxChars, maxText));

  if (running) {
    let head = `🟢 **正在运行**`;
    if (runningSince) head += ` · 已 ${formatElapsed(Date.now() - runningSince)}`;
    elements.push({ tag: 'markdown', content: head });

    if (view.showToolDetail && p.tool && p.tool.name) {
      const arg = p.tool.arg ? `：\`${esc(p.tool.arg)}\`` : '';
      elements.push({ tag: 'markdown', content: `🔧 \`${esc(p.tool.name)}\`${arg}` });
    } else if (p.lastKind === 'thinking') {
      elements.push({ tag: 'markdown', content: '<font color=\'grey\'>🤔 正在思考…</font>' });
    }
  } else if (subs.length) {
    // 主会话这一轮说完了，但它拉起的子代理 / 后台命令还在跑。
    // 这时候说「空闲」是错的——用户看到的应该是「还在干活，只是不在主线程上」。
    let head = `🟡 **本轮已回复，${subs.length} 个子任务还在跑**`;
    if (idleSince) head += ` · 主会话 ${formatAgo(Date.now() - idleSince)}停下`;
    elements.push({ tag: 'markdown', content: head });

    elements.push({ tag: 'markdown', content: subLines(subs) });
  } else {
    let head = '⚪ **本轮结束**';
    if (idleSince) head += ` · ${formatAgo(Date.now() - idleSince)}`;
    elements.push({ tag: 'markdown', content: head });
  }

  // 正在跑的那一支也要能看到后台活儿：主线程在动，同时有子代理在跑是常态
  if (running && subs.length) {
    elements.push({ tag: 'markdown', content: `**另有 ${subs.length} 个子任务在跑**\n${subLines(subs)}` });
  }

  if (view.showEditedFiles && running && p.edited && p.edited.length) {
    elements.push({
      tag: 'markdown',
      content: `✏️ 本轮改了 ${p.edited.length} 个文件：`
        + p.edited.map((f) => `\`${esc(shortPath(f))}\``).join('、'),
    });
  }

  // AI 这一轮说了什么也留着：末态时它就是本轮结论，运行中是「刚才那句」。
  // 跟「你说」区分开，两行都用 💬 会分不清谁说的，所以这里用 🤖。
  if (view.showModelSaid && p.said) {
    const oneLine = esc(p.said).replace(/\s+/g, ' ').trim();
    elements.push({
      tag: 'markdown',
      content: `<font color='grey'>🤖 它说：${oneLine.slice(0, maxText)}${oneLine.length > maxText ? '…' : ''}</font>`,
    });
  }

  elements.push({ tag: 'markdown', content: `📁 \`${esc(cwd || '')}\`` });
  if (view.showStats && stats) elements.push({ tag: 'markdown', content: `📦 ${stats}` });

  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title || '窗口状态' },
      template: running ? 'blue' : (subs.length ? 'orange' : 'grey'),
    },
    body: { elements },
  };
}

function subLines(subs) {
  return (subs || []).map((s) => {
    const tag = s.kind === 'agent' ? '🤖' : '⚙️';
    const what = s.what ? `：${esc(s.what)}` : '';
    return `${tag} \`${esc(s.name)}\`${what}`;
  }).join('\n');
}

// 「你说」那一行的渲染。
//
// 短的一句话就一行灰色引文；长的（贴了几千字、多行需求）折成
// collapsible_panel——卡片不是正文，塞一屏会把下面的状态全挤走，
// 但悄悄截断更糟（用户会以为自己的话没被收到）。所以标题给摘要，点开看全文。
const PROMPT_INLINE_MAX = 100;

function promptLines(text, fullMax = 1200, textMax = 140) {
  if (!text) return [];
  const t = String(text).trim();
  if (!t) return [];

  if (t.length <= Math.min(PROMPT_INLINE_MAX, textMax) && !t.includes('\n')) {
    return [{ tag: 'markdown', content: `<font color='grey'>💬 你说：${esc(t)}</font>` }];
  }

  const clipped = t.length > fullMax;
  const shown = clipped ? `${t.slice(0, fullMax)}\n…（原文共 ${t.length} 字，此处截断）` : t;
  const head = (t.split('\n')[0] || t).slice(0, 36);
  return [{
    tag: 'collapsible_panel',
    expanded: false,
    header: {
      title: { tag: 'plain_text', content: `💬 你说：${head}…（${t.length} 字）` },
      width: 'fill',
      icon_position: 'right',
      icon_expanded_angle: 180,
    },
    vertical_spacing: '4px',
    elements: [{ tag: 'markdown', content: esc(shown) }],
  }];
}

// 状态卡的「内容签名」：内容没变就不发请求。
// 用它而不是直接比整张卡的 JSON，是因为 JSON 里还有 schema/config 这类常量，
// 比它们没有意义；这里只关心真正会显示给用户的那几个字段。
//
// view 也要进签名：关掉某一行、或把字数上限改小，卡片内容会立刻变——
// 不进签名的话，改完配置要等下一次状态变化才生效，看起来像「配置没生效」。
function signature(opts) {
  const p = opts.probe || {};
  const v = { ...DEFAULT_VIEW, ...(opts.view || {}) };
  return JSON.stringify([
    opts.running,
    opts.running ? formatElapsed(Date.now() - (opts.runningSince || Date.now())) : '',
    opts.running ? '' : formatAgo(Date.now() - (opts.idleSince || Date.now())),
    v.showToolDetail ? (p.tool ? `${p.tool.name}|${p.tool.arg}` : '') : '',
    p.lastKind || '',
    v.showEditedFiles ? (p.edited || []).join(',') : '',
    v.showSubagentCard === false ? '' : (p.subtasks || []).map((s) => `${s.kind}:${s.name}:${s.what}`).join(','),
    v.showModelSaid ? (p.said || '') : '',
    v.showPrompt ? (p.myPrompt || '') : '',
    v.showStats ? (opts.stats || '') : '',
    JSON.stringify(v),
    opts.title || '',
  ]);
}

module.exports = {
  buildStatusCard, signature, formatElapsed, formatAgo, shortPath, DEFAULT_VIEW,
};
