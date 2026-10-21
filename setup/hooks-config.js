'use strict';

// 生成要写进 Claude Code settings.json 的 hooks 段落。
//
// 单独抽出来是因为**有两个地方要写同一份内容**：
//   1. ~/.claude/settings.json
//   2. cc-switch 里**每一个** claude 服务商的 settings_config
// 第二条很容易漏：cc-switch 切换服务商时会用库里的 settings_config 整体覆盖
// settings.json，哪个服务商没带 hooks，一切到它就全没了。

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 统一用正斜杠：Claude Code 的 hook command 在 Windows 上按 POSIX 解析，
// 反斜杠会被当转义符吃掉。
function p(rel) {
  return path.join(ROOT, rel).split(path.sep).join('/');
}

const NODE = 'node';

function hook(event, script, matcher, timeout) {
  const h = { type: 'command', command: `${NODE} ${p(script)}` };
  if (timeout) h.timeout = timeout;
  return matcher ? { matcher, hooks: [h] } : { hooks: [h] };
}

// timeout 说明：
//   ask/permission 要阻塞等人在手机上答，默认等 30 分钟，hook 超时必须比它长。
//   官方文档里 hook 的 timeout 是默认值不是上限，所以 1900 秒有效。
const HOOKS = {
  SessionStart: [hook('SessionStart', 'plugins/core/session-start.js', null, 10)],
  PreToolUse: [hook('PreToolUse', 'plugins/ask/hooks/ask-question.js', 'AskUserQuestion', 1900)],
  PermissionRequest: [
    hook('PermissionRequest', 'plugins/permission/hooks/permission-request.js',
      'Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit|WebFetch', 1900),
  ],
  Stop: [hook('Stop', 'plugins/notify/hooks/notify.js', null, 25)],
  Notification: [
    hook('Notification', 'plugins/notify/hooks/notify-input.js',
      'permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input', 25),
  ],
};

// 把这些 hook 合并进一份 settings 对象（不覆盖用户已有的其他 hook）。
// 同一个事件下，如果已有完全相同的 command 就跳过，保证可重复执行。
function mergeInto(settings) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  out.hooks = out.hooks || {};

  const added = [];
  for (const [event, entries] of Object.entries(HOOKS)) {
    if (!Array.isArray(out.hooks[event])) out.hooks[event] = [];
    for (const entry of entries) {
      const cmd = entry.hooks[0].command;
      const exists = out.hooks[event].some(
        (e) => (e.hooks || []).some((h) => h.command === cmd),
      );
      if (exists) continue;
      out.hooks[event].push(JSON.parse(JSON.stringify(entry)));
      added.push(`${event}: ${cmd}`);
    }
  }
  return { settings: out, added };
}

// 判断一份 settings 里是否已经装齐
function installed(settings) {
  if (!settings || !settings.hooks) return false;
  return Object.entries(HOOKS).every(([event, entries]) =>
    (settings.hooks[event] || []).some((e) =>
      (e.hooks || []).some((h) => h.command === entries[0].hooks[0].command)));
}

module.exports = { HOOKS, ROOT, mergeInto, installed, paths: { ask: p('plugins/ask/hooks/ask-question.js') } };
