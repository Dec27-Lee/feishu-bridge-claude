'use strict';

// SessionStart hook：把本会话的 inbox 管道地址与 token 注册到共享目录，
// 供飞书桥接进程向本窗口投递消息。
// 必须在极短时间内返回，不做任何网络或重量级调用。

const lib = require('../../kernel/lib');

function readStdin() {
  try {
    return JSON.parse(require('fs').readFileSync(0, 'utf8'));
  } catch (_) {
    return {};
  }
}

const input = readStdin();
const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID;
const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;

if (!sessionId || !socket || !token) {
  lib.log('error', `注册跳过：sessionId=${!!sessionId} socket=${!!socket} token=${!!token}`);
  process.exit(0);
}

lib.writeSession(sessionId, {
  socket,
  token,
  cwd: input.cwd || process.cwd(),
  pid: process.env.CLAUDE_PID || null,
  entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT || null,
  source: input.source || null,
  registeredAt: Date.now(),
});

// `--resume` 会先用临时 id 注册一次，随后按旧 id 再注册；临时那条留着会把
// 投递引到已作废的 socket 上（表现：窗口收不到消息，且毫无报错）。
lib.dropStaleAlias(sessionId);

lib.log('session', `注册 ${sessionId} cwd=${input.cwd || ''} socket=${socket}`);
process.exit(0);
