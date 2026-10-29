'use strict';

// 自测用的 lark-cli 替身。
//
// 通过 NODE_OPTIONS=--require 预加载进每一个 node 进程（包括 hook 子进程），
// 把 child_process 里对 lark-cli 的调用换成读沙箱文件。
// 生产代码里没有任何测试钩子——这是纯外部注入。
//
// 沙箱由 FEISHU_MOCK_DIR 指定，里面用几个文件模拟飞书侧状态：
//   messages.json   已知消息 { <message_id>: { reply_to, thread_id } }
//   outbox.jsonl    我们发出去的东西（卡片/回复），一行一条
//   inbox.jsonl     要「推给桥接」的事件，一行一条；mock 轮询增量 feed
//   calls.jsonl     所有 lark-cli 调用记录，排查用

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const MOCK_DIR = process.env.FEISHU_MOCK_DIR;
if (!MOCK_DIR) return;   // 没指定沙箱就什么都不拦

function ensure() {
  try { fs.mkdirSync(MOCK_DIR, { recursive: true }); } catch (_) {}
}
ensure();

const MESSAGES = path.join(MOCK_DIR, 'messages.json');
const OUTBOX = path.join(MOCK_DIR, 'outbox.jsonl');
const INBOX = path.join(MOCK_DIR, 'inbox.jsonl');
const CALLS = path.join(MOCK_DIR, 'calls.jsonl');

let seq = 0;

function append(file, obj) {
  try { fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8'); } catch (_) {}
}

function readMessages() {
  try { return JSON.parse(fs.readFileSync(MESSAGES, 'utf8')) || {}; } catch (_) { return {}; }
}

function isLark(cmd) {
  const s = String(cmd || '');
  return /lark-cli/i.test(s) || s === 'lark-cli';
}

function ok(stdout) {
  return { status: 0, stdout: JSON.stringify(stdout), stderr: '', error: null };
}

// 按 argv 分派，覆盖项目实际用到的全部命令
function handle(argv, opts) {
  const a = argv.slice();
  // 跳过可能存在的 --as bot 之类的通用参数不影响判断，按位置识别
  const first = a[0] || '';

  if (first === 'auth') {
    return ok({
      appId: 'cli_mock', brand: 'feishu',
      identities: { bot: { status: 'ready', available: true } },
    });
  }

  if (first === 'event') return ok({ ok: true });

  if (first === 'im') {
    const sub = a[1] || '';
    if (sub === '+messages-mget') {
      const i = a.indexOf('--message-ids');
      const ids = i >= 0 ? String(a[i + 1] || '').split(',') : [];
      const known = readMessages();
      return ok({
        ok: true,
        data: {
          messages: ids.map((id) => ({
            message_id: id,
            reply_to: (known[id] || {}).reply_to || null,
            thread_id: (known[id] || {}).thread_id || null,
          })),
        },
      });
    }

    if (sub === '+messages-reply' || sub === '+messages-send') {
      const i = a.indexOf('--content');
      const raw = i >= 0 ? a[i + 1] : '';
      let card = null;
      try { card = JSON.parse(raw); } catch (_) {}
      const mid = `om_mock_${Date.now()}_${++seq}`;
      append(OUTBOX, {
        at: new Date().toISOString(),
        kind: sub === '+messages-reply' ? 'reply' : 'send',
        messageId: mid,
        replyTo: (() => { const j = a.indexOf('--message-id'); return j >= 0 ? a[j + 1] : null; })(),
        card,
      });
      return ok({ ok: true, data: { message_id: mid, thread_id: 'omt_mock' } });
    }

    if (sub === '+messages-resources-download') {
      // 真的落一个文件：调用方下载完是用 existsSync 判断成败的，
      // 只回 ok 不落地会让所有图片都被判成「下载失败」。
      const j = a.indexOf('--output');
      const out = j >= 0 ? a[j + 1] : '';
      const cwd = (opts && opts.cwd) || process.cwd();
      if (out) {
        try { fs.writeFileSync(path.resolve(cwd, out), 'mock-image'); } catch (_) {}
      }
      return ok({ ok: true, data: { saved_path: out, size_bytes: 10 } });
    }
    // 置顶的增删记进 pins.jsonl（**不**混进 outbox）。
    //
    // 为什么单独一个文件：outbox 的语义是「我们发出去的消息」，多处用例靠
    // 「最后一条」判断这次发的是哪张卡。置顶不是消息，混进去会把那些断言
    // 全部错位到一条没有卡片的记录上。
    if (sub === 'pins') {
      const op = a[2] || '';
      let mid = null;
      const mi = a.indexOf('--message-id');
      if (mi >= 0) mid = a[mi + 1];
      if (!mid) {
        const di = a.indexOf('--data');
        try { mid = (JSON.parse(a[di + 1]) || {}).message_id || null; } catch (_) {}
      }
      if (op === 'delete') {
        append(path.join(MOCK_DIR, 'pins.jsonl'), { at: new Date().toISOString(), op: 'unpin', messageId: mid });
        return ok({ ok: true, data: {} });
      }
      if (op === 'create') {
        append(path.join(MOCK_DIR, 'pins.jsonl'), { at: new Date().toISOString(), op: 'pin', messageId: mid });
        return ok({ ok: true, data: {} });
      }
      if (op === 'list') {
        // 群里的置顶由沙箱文件给出，用例可以预置一批「历史残留」
        let list = [];
        try { list = JSON.parse(fs.readFileSync(path.join(MOCK_DIR, 'pins.json'), 'utf8')) || []; } catch (_) {}
        return ok({ ok: true, data: { has_more: false, items: list } });
      }
      return ok({ ok: true });
    }
    if (sub === '+pins' || sub === 'pin') return ok({ ok: true });

    // 原地更新卡片（状态卡靠它刷新）。记进 outbox，用例据此断言「刷新了」与
    // 「内容没变时没刷新」——只回 ok 的话，两者在调用方看来完全一样。
    if (sub === 'messages' && a[2] === 'patch') {
      const mi = a.indexOf('--message-id');
      const di = a.indexOf('--data');
      let content = null;
      try { content = JSON.parse((JSON.parse(a[di + 1]) || {}).content); } catch (_) {}
      append(OUTBOX, {
        at: new Date().toISOString(),
        kind: 'patch',
        messageId: mi >= 0 ? a[mi + 1] : null,
        card: content,
      });
      return ok({ ok: true, data: {} });
    }

    return ok({ ok: true });
  }

  if (first === 'api') {
    const method = a[1] || '';
    const url = a[2] || '';
    if (method === 'GET' && /\/messages\//.test(url)) {
      return ok({ ok: true, data: { items: [{ thread_id: 'omt_mock' }] } });
    }
    if (method === 'POST' && /card\/update/.test(url)) return ok({ ok: true });
    return ok({ ok: true, data: {} });
  }

  return ok({ ok: true });
}

function intercept(cmd) {
  if (!isLark(cmd)) return false;
  append(CALLS, { at: new Date().toISOString(), cmd: String(cmd) });
  return true;
}

// ---- 拦截 spawnSync ----

const realSpawnSync = cp.spawnSync;
cp.spawnSync = function patched(cmd, args, opts) {
  if (intercept(cmd)) {
    const argv = Array.isArray(args) ? args : [];
    append(CALLS, { argv });
    return handle(argv, opts);
  }
  // 开窗一律拦掉：自测跑一遍要「回序号 → 开窗」，照直执行会在用户桌面上
  // 真弹一个终端跑 claude，而且跑完没人关，几次下来满屏终端。
  // 这里只模拟「脚本生成成功」这一步——spawnWindow 正是用它判定成败的。
  //
  // 两个平台拦的是不同的东西：
  //   Windows  platform/win32 → spawnSync('cscript.exe', [...])
  //   macOS/Linux platform/{darwin,linux} → spawnSync('bash', [launch-claude.sh, ...])
  // 只拦 cscript 的话，在 mac/Linux 上跑自测会真的开终端窗口。
  const isWinLaunch = /^cscript(\.exe)?$/i.test(String(cmd));
  const isNixLaunch = /^bash$/i.test(String(cmd))
    && Array.isArray(args) && String(args[0] || '').endsWith('launch-claude.sh');
  if (isWinLaunch || isNixLaunch) {
    const argv = Array.isArray(args) ? args : [];
    // win: //nologo <vbs> <sessionId> <cwd> [resumeId]
    // nix: <launch-claude.sh> <sessionId> <cwd> [resumeId]
    const sid = isWinLaunch ? (argv[2] || `mock${++seq}`) : (argv[1] || `mock${++seq}`);
    const ext = isWinLaunch ? 'cmd' : 'sh';
    const bat = path.join(process.env.TEMP || process.env.TMPDIR || path.join(MOCK_DIR, 'tmp'),
      `cc-launch-${String(sid).slice(0, 8)}.${ext}`);
    try {
      fs.mkdirSync(path.dirname(bat), { recursive: true });
      fs.writeFileSync(bat, '@echo off\r\nrem mock launch\r\n', 'utf8');
    } catch (_) {}
    append(CALLS, { note: 'launch mocked', sessionId: sid });
    return { status: 0, stdout: '', stderr: '', error: null };
  }
  // tasklist / ps：桥接用来判断进程是否活着，自测里一律回答「活着」
  if (/^tasklist(\.exe)?$/i.test(String(cmd))) {
    const pid = (Array.isArray(args) ? args : []).join(' ').match(/\d+/);
    return { status: 0, stdout: `node.exe ${pid ? pid[0] : '1'} Console 1 1,000 K`, stderr: '', error: null };
  }
  if (/^ps$/i.test(String(cmd))) {
    // macOS/Linux 的 pidAlive / stopAllPresence 用 `ps -p <pid> -o comm=`
    const pid = (Array.isArray(args) ? args : []).join(' ').match(/\d+/);
    return { status: 0, stdout: `${pid ? pid[0] : '1'} node\n`, stderr: '', error: null };
  }
  return realSpawnSync.apply(this, arguments);
};

// ---- 拦截 spawn（事件消费者）----

const realSpawn = cp.spawn;
cp.spawn = function patched(cmd, args, opts) {
  if (isLark(cmd)) {
    const argv = Array.isArray(args) ? args : [];
    append(CALLS, { argv });
    // 只有 event consume 需要长驻喂事件，其余立刻结束
    if (argv[0] === 'event' && argv[1] === 'consume') {
      return fakeConsumer(argv[2]);
    }
    const out = handle(argv);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() { return true; }, end() {} };
    child.pid = ++seq;
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(out.stdout + '\n'));
      child.emit('exit', 0);
      // 异步调用方（status 插件用 spawn 而不是 spawnSync）等的是 'close'：
      // 只发 'exit' 的话那个 Promise 永远不 resolve，事件循环空了进程就悄悄退出，
      // 表现是「脚本跑完了但一行输出都没有」。
      child.emit('close', 0);
    });
    return child;
  }
  return realSpawn.apply(this, arguments);
};

// 假的 event consume：轮询 inbox.jsonl 新增行，逐条当作事件推给桥接
function fakeConsumer(eventKey) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() { return true; }, end() {} };
  child.pid = ++seq;

  let offset = 0;
  try { offset = fs.statSync(INBOX).size; } catch (_) { offset = 0; }

  const timer = setInterval(() => {
    let size;
    try { size = fs.statSync(INBOX).size; } catch (_) { return; }
    if (size <= offset) return;
    let text = '';
    try {
      const fd = fs.openSync(INBOX, 'r');
      const len = size - offset;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      fs.closeSync(fd);
      offset = size;
      text = buf.toString('utf8');
    } catch (_) { return; }

    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let ev;
      try { ev = JSON.parse(s); } catch (_) { continue; }
      if (ev.__event && ev.__event !== eventKey) continue;
      child.stdout.emit('data', Buffer.from(JSON.stringify(ev) + '\n'));
    }
  }, 60);
  timer.unref();

  child.kill = () => { clearInterval(timer); child.emit('exit', 0); };
  return child;
}

// 让自测脚本能主动「收到」某条飞书事件；用 global 暴露，
// 这样无论通过 --require 还是 require 加载都能拿到。
global.__feishuMock = { pushEvent(event) { append(INBOX, event); }, dir: MOCK_DIR };
