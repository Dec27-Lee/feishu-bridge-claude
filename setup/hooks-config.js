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

// 用**当前这个 node 的绝对路径**，不用裸 `node`。
//
// 原因：hook 由 Claude Code 在非交互 shell 里起，那个环境拿到的 PATH 往往
// 不包含 nvm / volta / fnm / asdf 这些东西——macOS 上用 nvm 装 node 的人极多，
// 裸 `node` 会直接报 command not found，表现是「所有 hook 静默失效」。
// 装的时候我们已经运行在能用的 node 上，把它的绝对路径写死最稳。
//
// 代价：升级/换 node 版本后路径会变，需要重跑 `node setup/install.js --hooks`。
// 这在 check.js 里被显式检查（hooks-node 项），不会悄无声息地坏掉。
const NODE = process.execPath.split(path.sep).join('/');

function hook(event, script, matcher, timeout) {
  const h = { type: 'command', command: `"${NODE}" "${p(script)}"` };
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

// 本项目的 hook 脚本（相对项目根）。判据是**脚本名**而不是完整路径：
// 项目被移动过之后，旧记录里的绝对路径已经指向不存在的文件，
// 但「这条 hook 是谁装的」这个问题，只能靠脚本名回答。
const OWN_SCRIPTS = [
  'plugins/core/session-start.js',
  'plugins/ask/hooks/ask-question.js',
  'plugins/permission/hooks/permission-request.js',
  'plugins/notify/hooks/notify.js',
  'plugins/notify/hooks/notify-input.js',
];

function isOwnCommand(cmd) {
  const c = String(cmd || '').replace(/\\/g, '/');
  return OWN_SCRIPTS.some((s) => c.includes(s));
}

// 从一条 hook command 里取出被执行的 .js 脚本路径。
// command 的形状是 `"<node>" "<script>"`（带引号），也可能是老版本的
// `node <script>`。不要用 /node\s+(...)/ 去匹配——node 的绝对路径里
// 本身就含 node（node.exe / nodejs），那个正则匹配不上，会让路径校验静默失效。
function scriptPathFromCommand(cmd) {
  const s = String(cmd || '');
  const quoted = [...s.matchAll(/"([^"]+\.js)"/g)].map((m) => m[1]);
  if (quoted.length) return quoted[quoted.length - 1];
  const bare = s.match(/(?:^|\s)(\S+\.js)(?:\s|$)/);
  return bare ? bare[1] : null;
}

// 摘掉本项目「指向别处」的 hook——旧位置、已失效路径。
//
// 为什么需要：如果只做「同样的 command 就跳过」，项目一被移动，
// 旧路径的 hook 留着、新路径的 hook 又加一份，每个事件会跑两遍：
// 一遍报「找不到文件」，一遍正常工作。日志里全是噪音，排查时极难想到。
// 只判断「是不是本项目的脚本」而不看目录，所以项目被搬过几次都能收拾干净；
// 用户自己的 hook（比如 codegraph）一条不碰。
function stripOwn(settings) {
  const out = JSON.parse(JSON.stringify(settings || {}));
  const want = new Set(Object.values(HOOKS).map((e) => e[0].hooks[0].command));
  const removed = [];
  for (const [event, entries] of Object.entries(out.hooks || {})) {
    if (!Array.isArray(entries)) continue;
    out.hooks[event] = entries.filter((e) => {
      const hooks = (e && e.hooks) || [];
      const stale = hooks.length > 0 && hooks.every(
        (h) => isOwnCommand(h && h.command) && !want.has(h.command));
      if (stale) removed.push(`${event}: ${hooks[0].command}`);
      return !stale;
    });
    if (!out.hooks[event].length) delete out.hooks[event];
  }
  return { settings: out, removed };
}

// 把这些 hook 合并进一份 settings 对象（不覆盖用户已有的其他 hook）。
// 先摘掉本项目指向旧位置的条目再加入，保证两件事：
//   · 项目挪过位置时不会留双份
//   · 原样重跑是幂等的（已指向当前项目的条目不动）
function mergeInto(settings) {
  const { settings: base, removed } = stripOwn(settings);
  const out = JSON.parse(JSON.stringify(base));
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
  return { settings: out, added, removed };
};

// 判断一份 settings 里是否已经装齐（且指向当前项目目录）
function installed(settings) {
  if (!settings || !settings.hooks) return false;
  return Object.entries(HOOKS).every(([event, entries]) =>
    (settings.hooks[event] || []).some((e) =>
      (e.hooks || []).some((h) => h.command === entries[0].hooks[0].command)));
}

// 装是装了，但指向的可能是别处。返回那些指向非当前项目的本项目 hook。
function staleEntries(settings) {
  const want = new Set(Object.values(HOOKS).map((e) => e[0].hooks[0].command));
  const found = [];
  for (const [event, entries] of Object.entries((settings || {}).hooks || {})) {
    for (const e of entries || []) {
      for (const h of (e && e.hooks) || []) {
        if (isOwnCommand(h && h.command) && !want.has(h.command)) {
          found.push({ event, command: h.command });
        }
      }
    }
  }
  return found;
}

module.exports = {
  HOOKS, ROOT, mergeInto, installed, stripOwn, staleEntries, isOwnCommand,
  scriptPathFromCommand, OWN_SCRIPTS, NODE,
  paths: { ask: p('plugins/ask/hooks/ask-question.js') },
};
