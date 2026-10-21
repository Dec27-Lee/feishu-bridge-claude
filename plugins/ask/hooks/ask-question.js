'use strict';

// PreToolUse hook（matcher=AskUserQuestion）：把终端里的提问搬到飞书去答——
// **但只在人不在电脑前的时候。**
//
// 官方只提供一条代答通道：本 hook 返回
//   { permissionDecision: 'allow', updatedInput: { questions, answers } }
// 就能跳过弹窗，answers 直接作为用户作答交给模型。
// 代价是：只要返回了这个，弹窗就不会渲染。所以「人就在电脑前」时绝不能拦。
//
// 流程：
//   0. 探一次在场（hooks/wait.js）。人在这个窗口前 → 直接 exit 0，弹窗照常出现
//   1. 不在/可能不在：把 questions 写进 data/questions/<id>.json，bridge 推卡片
//   2. 阻塞等待；期间人回来了就提前交还终端
//   3. 拿到答案 → 输出 allow + updatedInput；超时/交还 → 什么都不输出
//
// 阻塞是安全的：hook 默认同步执行，超时也不会阻断工具调用（settings.json 里给了 300s）。

const fs = require('fs');
const path = require('path');
const lib = require('../../../kernel/lib');
const q = require('../../../kernel/questions');
const w = require('../../../kernel/wait');

function readStdin() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (_) {
    return {};
  }
}

function log(msg) {
  try {
    fs.appendFileSync(path.join(__dirname, '..', 'logs', 'ask.log'),
      `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

// 交还终端时响一声：人在电脑前但在看别的窗口，也得知道「这里有东西等你」。
// BEL（\u0007）是 terminalSequence 白名单里少数能往终端写东西的口子。
function bell() {
  process.stdout.write(JSON.stringify({ terminalSequence: '\u0007' }));
}

const input = readStdin();
const toolName = input.tool_name;
const questions = (input.tool_input && input.tool_input.questions) || [];

// 不是出题就立刻放行，绝不干扰其它工具
if (toolName !== 'AskUserQuestion' || !questions.length) process.exit(0);

// 桥接没跑 = 没人接卡片，别拦
if (!w.bridgeAlive()) process.exit(0);

const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';

// 先探在场。人在电脑前时**不代答、不阻塞**：弹窗照常出现在终端里，
// 飞书那头只推一张纯提醒卡（noticeOnly），让人在手机上也瞄得到「某个窗口在等你」。
// 这条记录不参与作答，bridge 发完卡就退休掉。
// 配置来自插件 schema（plugins/ask/plugin.json），用户覆盖写在 config.json 的 plugins.ask。
// 不走顶层配置：那里的键属于内核，插件自己有哪些参数由 schema 声明。
const cfg = lib.readPluginConfig('ask');
const b = w.budget(sessionId, cfg);
const noticeOnly = b.level === 'here' && cfg.notifyWhenPresent !== false;

const id = q.newId();

q.write(id, {
  id,
  kind: 'question',
  sessionId,
  cwd: input.cwd || process.cwd(),
  createdAt: Date.now(),
  toolUseId: input.tool_use_id || null,
  payload: { questions },
  questions,          // 兼容：卡片侧按 kind 分派，两种布局都读得到
  answers: {},
  cursor: 0,
  done: false,
  presence: { level: b.level, reason: b.reason },
  ...(noticeOnly ? { noticeOnly: true } : {}),
});

if (noticeOnly) {
  log(`人在电脑前（${b.reason}），弹窗留给终端，飞书只推提醒卡`);
  process.exit(0);
}

const r = w.waitForHuman(id, { sessionId, cfg });

if (r.outcome === 'done') {
  const answers = (r.rec && r.rec.answers) || {};
  log(`已代答 ${id} ${Object.entries(answers).map(([k, v]) => `${k.slice(0, 20)}=${v}`).join('; ')} ` +
      `（${Math.round(r.waitedMs / 1000)}s，${r.level}）`);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { questions, answers },
    },
  }));
  q.retire(id, 'done');
} else {
  // 什么都不输出 = 交还给正常流程（终端里弹框等人）
  const why = r.outcome === 'cancelled' ? '用户点了交还'
    : (r.outcome === 'handover' ? '人回到电脑前' : '等待超时');
  log(`放弃代答 ${id} ${why}（${Math.round(r.waitedMs / 1000)}s，${r.level}/${r.reason}），改在终端作答`);
  q.retire(id, r.outcome === 'cancelled' ? 'cancelled'
    : (r.outcome === 'handover' ? 'handover' : 'timeout'));
  bell();
}
process.exit(0);
