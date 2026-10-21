'use strict';

// PermissionRequest hook：把工具权限确认搬到飞书去答——同样只在人不在电脑前的时候。
//
// 与 hooks/ask-question.js 是同一套机制（探在场 → 落盘 → 阻塞等 → 回填），只是事件不同：
//   PreToolUse(AskUserQuestion)   → { permissionDecision:'allow', updatedInput:{questions,answers} }
//   PermissionRequest(任意工具)   → { decision: { behavior:'allow' | 'deny', ... } }
//
// 注意这边的几个硬边界（官方文档）：
//   · deny 规则仍然优先，hook 返回 allow 也压不住；
//   · 标了 requiresUserInteraction 的 MCP 工具、网络路径读取、关键路径的 rm 一律放不过；
//   · exit code 2 在本事件上**不生效**，必须走 decision 对象；
//   · dontAsk 模式下本 hook 根本不运行。
//
// 所以这里的定位是「帮人点一下」，不是「绕过权限系统」。

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

// 交还终端时响一声，人在别的窗口也听得见
function bell() {
  process.stdout.write(JSON.stringify({ terminalSequence: '\u0007' }));
}

const input = readStdin();
if (input.hook_event_name !== 'PermissionRequest') process.exit(0);
if (!w.bridgeAlive()) process.exit(0);

const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || '';
const toolName = input.tool_name || '';
const toolInput = input.tool_input || {};

// 这几类问了也放不过，别拿去做卡片浪费人的时间
const NEVER = /^(EndConversation)$/;
if (NEVER.test(toolName)) process.exit(0);

// 人在电脑前：不代答、不阻塞，确认框照常出在终端里；飞书只推一张纯提醒卡。
// 配置来自插件 schema（plugins/permission/plugin.json），与 ask 插件各自独立。
const cfg = lib.readPluginConfig('permission');
const b = w.budget(sessionId, cfg);
const noticeOnly = b.level === 'here' && cfg.notifyWhenPresent !== false;

const id = q.newId();

q.write(id, {
  id,
  kind: 'permission',
  sessionId,
  cwd: input.cwd || process.cwd(),
  createdAt: Date.now(),
  payload: {
    toolName,
    toolInput,
    suggestions: input.permission_suggestions || [],
    permissionMode: input.permission_mode || null,
  },
  answers: {},
  done: false,
  // 卡片上直接标出「人可能还在电脑前」，点了就知道不用等太久
  presence: { level: b.level, reason: b.reason },
  ...(noticeOnly ? { noticeOnly: true } : {}),
});

if (noticeOnly) {
  log(`人在电脑前（${b.reason}），确认框留给终端，飞书只推提醒卡：${toolName}`);
  process.exit(0);
}

const r = w.waitForHuman(id, { sessionId, cfg });

if (r.outcome === 'done') {
  const a = (r.rec && r.rec.answers) || {};
  const allow = a.decision === 'allow';
  log(`权限${allow ? '放行' : '拒绝'} ${id} ${toolName}${a.always ? '（本会话不再问）' : ''} ` +
      `（${Math.round(r.waitedMs / 1000)}s，${r.level}）`);

  const decision = { behavior: allow ? 'allow' : 'deny' };
  if (allow) {
    // updatedInput 是整体替换，必须原样回传，否则字段会被清空
    decision.updatedInput = toolInput;
    if (a.always) {
      // 一次授权、后续不再问：写进本项目的 .claude/settings.local.json
      decision.updatedPermissions = [{
        type: 'addRules',
        rules: [{ toolName }],
        behavior: 'allow',
        destination: 'localSettings',
      }];
    }
  } else {
    decision.message = a.note || '用户在飞书上拒绝了这次操作。';
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
  }));
  q.retire(id, 'done');
} else {
  // 超时/交还：什么都不输出 = 交还给正常流程，终端里弹框等人
  const why = r.outcome === 'cancelled' ? '用户点了交还'
    : (r.outcome === 'handover' ? '人回到电脑前' : '等待超时');
  log(`放弃代确认 ${id} ${toolName} ${why}（${Math.round(r.waitedMs / 1000)}s，${r.level}/${r.reason}），改在终端确认`);
  q.retire(id, r.outcome === 'cancelled' ? 'cancelled'
    : (r.outcome === 'handover' ? 'handover' : 'timeout'));
  bell();
}
process.exit(0);
