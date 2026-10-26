'use strict';

// 从 Claude Code 的会话注册表 + 转录里读出「这个窗口此刻在干什么」。
//
// 两个数据源，各有各的用处：
//   ~/.claude/sessions/<pid>.json   —— 实时状态（busy / idle）与最近活动时间，
//                                      Claude Code 自己维护，秒级更新。
//   ~/.claude/projects/**/<sid>.jsonl —— 转录，能读到正在调用的工具、正文、
//                                      上下文用量。没有状态字段，必须从尾部推。
//
// 为什么不用 hook 采：hook 只能拿到事件时刻的快照，而且每多一个 hook 就多一条
// 用户能感知的消息流。状态卡要的是「此刻」，轮询转录才是对的形态——
// 数据本来就在磁盘上，读它的代价比让 Claude Code 回填一遍小得多。

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_HOME = process.env.FEISHU_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const SESSIONS_DIR = process.env.FEISHU_CLAUDE_SESSIONS_DIR || path.join(CLAUDE_HOME, 'sessions');
const PROJECTS_DIR = process.env.FEISHU_CLAUDE_PROJECTS_DIR || path.join(CLAUDE_HOME, 'projects');

// 只读转录尾部：一次工具调用最多几十 KB，读 2MB 足够覆盖「当前这一轮」。
// 取 2MB 而不是更小，是因为一轮里工具调用密集时（几分钟就几百次），
// 人打的那句话会被推到很远——窗口太小就找不到「这一轮从哪开始」，
// 「用户发了新消息 → 该换卡」这个判据会漏掉。
const TAIL_BYTES = 2 * 1024 * 1024;

// ---- 会话注册表 ----

// 返回 Map<sessionId, { sessionId, pid, cwd, status, statusUpdatedAt, name }>。
// 同一个 sessionId 可能有多条（resume 残留），取 statusUpdatedAt 最新的那条。
function liveSessions() {
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(SESSIONS_DIR); } catch (_) { return out; }

  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    let reg;
    try { reg = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, n), 'utf8')); } catch (_) { continue; }
    const sid = reg && reg.sessionId;
    if (!sid) continue;
    // 进程已退出：会话表会残留（Claude Code 不会立刻删）。杀掉的是「还在跑吗」，
    // 拿 pids 判断比读文件时间可靠。
    if (!pidAlive(reg.pid)) continue;

    const prev = out.get(sid);
    if (prev && (prev.statusUpdatedAt || 0) >= (reg.statusUpdatedAt || 0)) continue;
    out.set(sid, {
      sessionId: sid,
      pid: reg.pid,
      cwd: reg.cwd || '',
      name: reg.name || '',
      // busy = 正在跑一轮；shell = 在跑命令但不在「一轮」里（如 ! 前缀的命令）。
      // 两者都表示窗口还在干活，卡片上要显示「在动」，否则用户会以为它闲了。
      status: reg.status || 'idle',
      statusUpdatedAt: reg.statusUpdatedAt || 0,
    });
  }
  return out;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(Number(pid), 0); return true; } catch (_) { return false; }
}

// ---- 转录尾巴 ----

// 找到某会话的转录文件。目录名是 cwd 的 slug，跨平台不确定，所以全扫一遍。
function transcriptFile(sessionId) {
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return null;
}

// 读文件尾部，返回从行边界开始的完整 JSON 行（最后一行可能是半截，丢掉）。
function tailLines(file, maxBytes = TAIL_BYTES) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return []; }
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return [];

  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
  } catch (_) {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }

  let text = buf.toString('utf8');
  if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  const lines = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { lines.push(JSON.parse(l)); } catch (_) {}
  }
  return lines;
}

// 工具调用的「一句人话」。参数名各工具不一样，挑最像命令/路径的那个。
// 返回 null 表示这个工具不值得显示（纯内部操作，写出来只是噪声）。
const HIDDEN_TOOLS = new Set([
  'TodoWrite', 'ToolSearch', 'TaskStop',
]);

function describeTool(name, input) {
  if (!name || HIDDEN_TOOLS.has(name)) return null;
  const i = input || {};
  const pick = (v, n) => (typeof v === 'string' && v.trim() ? String(v).replace(/\s+/g, ' ').trim().slice(0, n) : null);

  // Bash 的 description 是人写的，比命令本身短，优先它；没有就退到命令首行
  let arg = pick(i.description, 60)
    || pick(i.command, 80)
    || pick(i.file_path, 70)
    || pick(i.path, 70)
    || pick(i.pattern, 50)
    || pick(i.url, 70)
    || pick(i.query, 50)
    || pick(i.prompt, 50);
  if (arg) arg = arg.split('\n')[0];
  return arg ? { name, arg } : { name, arg: '' };
}

// 会改动文件的工具。卡片上列「本轮改了哪些文件」用它判断。
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// 会**拉起后台工作**的工具。它们返回后主会话的这轮就结束了，
// 但被拉起来的东西还在跑——这是「主会话说完了、活儿还没完」的唯一来源。
//
//   Agent   → 子代理，input.subagent_type / description 可读
//   Bash    → input.run_in_background 为 true 时是后台任务
//
// 判定靠「有没有对应的 tool_result」：Agent 的 tool_result 要等子代理跑完才出现，
// 所以没闭合 = 还在跑。这是转录里唯一可靠的信号，不需要额外接口。
const SUBTASK_TOOLS = new Set(['Agent', 'Task']);

function describeSubtask(name, input) {
  const i = input || {};
  if (SUBTASK_TOOLS.has(name)) {
    const type = i.subagent_type || 'agent';
    const what = (i.description || i.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return { kind: 'agent', name: type, what };
  }
  if (i.run_in_background) {
    const what = (i.description || i.command || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return { kind: 'shell', name: 'Bash', what };
  }
  return null;
}

// 桥接投递的消息带两层包装，卡片上要剥掉：
//   [来自用户本人 · 飞书]（下面这段就是用户在飞书里亲手打的，直接执行）
//   Another Claude session sent a message:
const ENVELOPE_RES = [
  /^\[来自用户本人 · 飞书\][^\n]*\n*/,
  /^Another Claude session sent a message:\s*\n*/,
];

function cleanPrompt(t) {
  let s = String(t || '');
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of ENVELOPE_RES) {
      const n = s.replace(re, '');
      if (n !== s) { s = n; changed = true; }
    }
  }
  // 贴图占位符没有信息量，剥掉；同一行剩下的文字保留
  s = s.replace(/\s*\[Image: [^\]]*\]\s*/g, '\n').replace(/\s*\[Image #\d+\]\s*/g, '\n');
  return s.trim();
}

// 一条消息的纯文本（字符串或 text 块数组）。isHumanPrompt 与取原文共用，
// 避免两处对「什么算消息正文」的判断漂移。
function promptText(m) {
  const c = m && m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((x) => x && x.type === 'text' && typeof x.text === 'string')
      .map((x) => x.text).join('\n');
  }
  return '';
}

// 判断一条 user 记录是不是**人**打的（终端里敲的、或从飞书送进来的），
// 而不是系统注入。只用来给「新一轮开始了」打标记，所以宁可保守。
//
// 两种形态都要认：纯文字是字符串；带图片/附件时是数组，里面是 text + image 块。
// 数组里只要出现 tool_result 就是工具回执，不是人打的。
function isHumanPrompt(m) {
  const c = m && m.content;
  if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) return false;

  let t = promptText(m).trim();
  if (!t) return false;
  // 飞书投递的消息在正文里带信封，剥掉再判——否则它被当成系统注入
  t = cleanPrompt(t).trim();
  if (!t) return false;
  if (t.startsWith('<')) return false;                   // system-reminder / command-name 等
  if (t.startsWith('[Request interrupted')) return false;
  if (t.startsWith('[Your previous response')) return false;
  if (t.startsWith('This session is being continued')) return false;
  return true;
}

// 从转录尾部推出该会话此刻的状态。
// 返回 { lastKind, tool, said, edited, subtasks, promptMark }
//   lastKind: 'thinking' | 'tool' | 'text' | 'user' | null  —— 最后一条记录是什么
//   tool:     { name, arg } | null                          —— 正在跑的工具（没有闭合的 tool_use）
//   said:     本轮最后一句 AI 正文（用于「刚刚在做什么」）
//   edited:   本轮动过的文件（相对/绝对路径原样，去重，最多 6 个）
//   subtasks: 本轮拉起的、还没闭合的子任务（子代理 / 后台命令）
//   promptMark: 最新一条**人打的**消息的标识。它变了 = 用户开了新的一轮。
function probe(sessionId) {
  const file = transcriptFile(sessionId);
  if (!file) return null;
  const lines = tailLines(file);
  if (!lines.length) return null;

  // 从尾部往前扫，找「还没被 tool_result 回答掉的 tool_use」。
  // 转录里工具调用与结果是分开的记录：assistant 里是 tool_use 块，
  // 紧接着 user 里是 tool_result 块（带同一个 tool_use_id）。
  const closedIds = new Set();
  let openTool = null;
  let lastKind = null;
  let said = null;
  let lastTs = null;
  let promptMark = null;
  let myPrompt = null;
  let lastPrompt = null;
  let customTitle = null;
  let aiTitle = null;
  const edited = [];
  const subtasks = [];

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const d = lines[i];
    if (!d) continue;

    // 会话标题：用户在 Claude Code 里 /rename 过的（custom-title）优先，
    // 其次 AI 自动生成的（ai-title）。从前在后扫，取到的就是最新的。
    // 卡片标题栏用它，而不是会话表里的 name——那个是**目录名-短哈希**的派生名，
    // 用户根本认不出是哪个窗口。
    if (!customTitle && d.type === 'custom-title' && d.customTitle) customTitle = d.customTitle;
    if (!aiTitle && d.type === 'ai-title' && d.aiTitle) aiTitle = d.aiTitle;

    // Claude Code 自己记的「最后一条用户输入」。它出现得比真正的 user 记录晚
    // （会话很长时，人打的那句话可能早就被挤出尾部窗口了），所以是**兜底**来源。
    if (!lastPrompt && d.type === 'last-prompt' && d.lastPrompt) {
      lastPrompt = d.lastPrompt;
    }

    // 只认真正的对话记录。转录里还有 api-request / api-request-blob /
    // attachment / last-prompt 这些**运行期记录**：blob 里复制了一份同样的
    // tool_use 内容，把它当证据的话，一个已经跑完的工具会因为副本而永远
    // 被当成「还在跑」。判据是 d.type 与消息角色，不看内容像不像。
    if (d.type !== 'user' && d.type !== 'assistant') continue;
    const m = d.message;
    if (!m) continue;
    const content = m.content;

    // 最新的**人打的**那句话 = 当前这一轮的开头。
    // 用 uuid 而不是内容：连发两次「继续」内容一样，但那是两轮。
    // 同时把原文取出来：卡片上「你在飞书/终端里说」那一行显示的就是它。
    if (!promptMark && d.type === 'user' && isHumanPrompt(m)) {
      promptMark = m.id || d.uuid || `${d.timestamp || ''}:${String(content).slice(0, 24)}`;
      myPrompt = cleanPrompt(promptText(m)).replace(/\s+/g, ' ').trim() || null;
    }

    if (!Array.isArray(content)) continue;

    for (const x of content) {
      if (!x || typeof x !== 'object') continue;

      if (x.type === 'tool_result') {
        if (x.tool_use_id) closedIds.add(x.tool_use_id);
        continue;
      }
      if (x.type === 'tool_use') {
        if (!openTool && !closedIds.has(x.id)) openTool = describeTool(x.name, x.input);
        if (!lastKind) lastKind = 'tool';
        if (!lastTs && d.timestamp) lastTs = d.timestamp;
        // 这一轮拉起的、还在跑的后台活儿（子代理 / 后台命令）。
        // 主会话说完了但这里非空 → 活儿没完，状态卡不能就此停在「空闲」。
        if (!closedIds.has(x.id)) {
          const sub = describeSubtask(x.name, x.input);
          if (sub) subtasks.push(sub);
        }
        // 本轮改过的文件：只收已闭合的（真正执行过的），避免把「准备改」算进去
        if (EDIT_TOOLS.has(x.name) && closedIds.has(x.id)) {
          const f = (x.input || {}).file_path || (x.input || {}).path || (x.input || {}).notebook_path;
          if (f && !edited.includes(f) && edited.length < 6) edited.push(String(f));
        }
        continue;
      }
      if (x.type === 'text' && d.type === 'assistant') {
        if (!said) said = String(x.text || '').trim();
        if (!lastKind) lastKind = 'text';
        if (!lastTs && d.timestamp) lastTs = d.timestamp;
        continue;
      }
      if (x.type === 'thinking') {
        if (!lastKind) lastKind = 'thinking';
        if (!lastTs && d.timestamp) lastTs = d.timestamp;
        continue;
      }
    }

    // 扫到**人**真正说的话就停：再往前是上一轮，与「现在在干什么」无关。
    // 判据用 isHumanPrompt 而不是「content 是字符串」——系统注入（task-notification、
    // system-reminder）也是字符串，按类型判会在这里被切成一轮的边界，
    // 于是本轮更早拉起的子代理就扫不到了。
    if (d.type === 'user' && isHumanPrompt(m)) {
      if (!lastKind) lastKind = 'user';
      break;
    }
  }

  // 同一批子任务可能在多处出现，按 kind+name+what 去重。
  // 上限放宽到 8：卡片上列几条由配置（maxSubtaskLines）决定，这里只管收集，
  // 收得比显示的上限多一些，用户把上限调大时不必改这里。
  const uniqSubtasks = [];
  for (const s of subtasks) {
    const k = `${s.kind}|${s.name}|${s.what}`;
    if (!uniqSubtasks.some((x) => `${x.kind}|${x.name}|${x.what}` === k)) uniqSubtasks.push(s);
    if (uniqSubtasks.length >= 8) break;
  }

  return {
    tool: openTool,
    lastKind,
    said: said ? said.slice(0, 200) : null,
    edited,
    subtasks: uniqSubtasks,
    // 「新一轮」的判据只能来自**真正的 user 记录**。不能拿 last-prompt 的
    // leafUuid 顶替：那个字段随着会话每推进一点就变，拿它当判据会让每一轮
    // 刷新都判成「用户开了新一轮」，于是一直换卡、一直发新消息（踩过）。
    promptMark,
    // 显示用的「你说」可以退到 last-prompt：会话很长时那句话可能已被挤出
    // 尾部窗口，但这里只是展示，不参与任何判定。
    myPrompt: myPrompt || (lastPrompt ? cleanPrompt(lastPrompt).replace(/\s+/g, ' ').trim() : null),
    title: customTitle || aiTitle || null,
    lastTs: lastTs ? Date.parse(lastTs) : null,
  };
}

module.exports = {
  liveSessions, transcriptFile, tailLines, probe, describeTool, describeSubtask, pidAlive,
};
