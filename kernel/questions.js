'use strict';

// 远程代答 AskUserQuestion。
//
// Claude Code 的提问弹窗只认键盘，飞书这边没法直接点。可用的官方接口只有一处：
// PreToolUse hook（matcher=AskUserQuestion）返回
//   { permissionDecision: 'allow', updatedInput: { questions, answers } }
// 就能跳过弹窗、把 answers 直接当作 user 的作答交给模型。
//
// 于是：
//   hooks/ask-question.js  —— 拦下提问，把 questions 落到 data/questions/<id>.json，
//                             然后同步阻塞轮询，等飞书那边写入 answer。
//   bridge.js              —— 读到待答记录就推一张飞书卡片，用户点按钮/回序号后写 answer。
//
// 这份模块是两边共用的：目录、文件名、读写都只在这里定义一次。

const fs = require('fs');
const path = require('path');

// 与 lib.js 保持一致：数据目录默认在项目根下，可由 FEISHU_DATA_DIR 覆盖。
// 这里刻意不 require('./lib')，让本模块保持无依赖，hook 单独引用时不会牵进整条链路。
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.FEISHU_DATA_DIR || path.join(ROOT, 'data');
const QUESTIONS_DIR = path.join(DATA_DIR, 'questions');

// 问题卡片里每个选项的回调值上限；飞书自定义参数不宜过长，用 qid + 序号足够
const QID_PREFIX = 'q';

function ensureDir() {
  try { fs.mkdirSync(QUESTIONS_DIR, { recursive: true }); } catch (_) {}
}

function qfile(id) {
  return path.join(QUESTIONS_DIR, `${id}.json`);
}

function newId() {
  return QID_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 「是否需要人介入」的统一登记簿，问卷（AskUserQuestion）与工具权限确认共用一套。
// 一张卡片、一套按钮、一条「没答就交还终端」的兜底逻辑，不必为两者各写一遍。
//
// kind: 'question'  —— AskUserQuestion 的选择题，payload = { questions }
//       'permission' —— 工具的权限确认，payload = { toolName, toolInput, suggestions }
//
// 记录结构：
// { id, kind, sessionId, cwd, createdAt, payload,
//   answers: {问题文本: 答案} / {decision: 'allow'|'deny', note},
//   cursor, done, cancelled, doneAt, cardMessageId, cardThreadId, sel }
function write(id, rec) {
  ensureDir();
  const tmp = qfile(id) + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), 'utf8');
    fs.renameSync(tmp, qfile(id));
  } catch (_) {}
}

function read(id) {
  try {
    return JSON.parse(fs.readFileSync(qfile(id), 'utf8'));
  } catch (_) {
    return null;
  }
}

function remove(id) {
  try { fs.unlinkSync(qfile(id)); } catch (_) {}
}

// 答完之后先别删，留一小会儿。删太干净的话，用户随后再点那张卡片，
// 桥接分不清「已经答过了」和「等太久超时了」，只能一律回「已超时」——
// 明明自己刚点完却被告知超时，很容易以为功能坏了。
function retire(id, note) {
  const rec = read(id);
  if (!rec) return;
  rec.retiredAt = Date.now();
  if (note) rec.retireNote = note;
  write(id, rec);
}

// 所有未完成的提问，按时间正序（先问的先答）
function listOpen(maxAgeMs = 60 * 60000) {
  ensureDir();
  let names = [];
  try { names = fs.readdirSync(QUESTIONS_DIR); } catch (_) {}
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const rec = read(n.slice(0, -5));
    if (!rec || rec.done || rec.retiredAt) continue;
    if (Date.now() - (rec.createdAt || 0) > maxAgeMs) continue;
    out.push(rec);
  }
  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return out;
}

// 提交一题（或多选）的答案。answers 的 key 必须与 questions[].question 原文一致，
// 否则 Claude Code 侧对不上问题。返回 { ok, done, answered, total, error }
function submit(id, answers) {
  const rec = read(id);
  if (!rec) return { ok: false, error: '提问记录不存在或已过期' };
  if (rec.done) return { ok: false, error: '这道题已经答过了' };

  rec.answers = rec.answers || {};
  for (const [q, a] of Object.entries(answers || {})) {
    const known = (rec.questions || []).some((item) => item.question === q);
    if (!known) return { ok: false, error: `问题不在本次提问里：${q.slice(0, 30)}` };
    rec.answers[q] = a;
  }

  const total = (rec.questions || []).length;
  const answered = (rec.questions || []).filter((q) => rec.answers[q.question] !== undefined).length;
  rec.cursor = answered;

  // 全部答完才算完成：hook 那边只有看到 done 才会把整份答案交回去
  if (answered >= total) {
    rec.done = true;
    rec.doneAt = Date.now();
  }
  write(id, rec);
  return { ok: true, done: !!rec.done, answered, total, rec };
}

// 取消（用户在飞书上选择不回答）：让 hook 原样放行，弹窗回到终端里等人按
function cancel(id) {
  const rec = read(id);
  if (!rec) return { ok: false, error: '提问记录不存在或已过期' };
  rec.cancelled = true;
  write(id, rec);
  return { ok: true };
}

// 工具权限确认的作答：decision = 'allow' | 'deny'，always 表示「本会话不再问这个工具」
function decide(id, decision, opts = {}) {
  const rec = read(id);
  if (!rec) return { ok: false, error: '请求不存在或已过期' };
  if (rec.done) return { ok: false, error: '这条请求已经处理过了' };
  rec.answers = {
    decision,
    ...(opts.always ? { always: true } : {}),
    ...(opts.note ? { note: opts.note } : {}),
  };
  rec.done = true;
  rec.doneAt = Date.now();
  write(id, rec);
  return { ok: true, rec };
}

// 统一的「作答」入口：按 kind 分派
function answer(id, value, opts = {}) {
  const rec = read(id);
  if (!rec) return { ok: false, error: '请求不存在或已过期' };
  if (rec.kind === 'permission') return decide(id, value, opts);
  if (opts.answers) return submit(id, opts.answers);
  return { ok: false, error: '不知道该怎么答这条请求' };
}

module.exports = {
  DATA_DIR, QUESTIONS_DIR, ensureDir, newId, read, write, remove, retire,
  listOpen, submit, cancel, decide, answer, qfile,
};
