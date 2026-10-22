'use strict';

// 沙箱自测：不碰本机任何真实配置，跑一遍主要链路。
//
//   node setup/selftest/run.js            跑全部用例
//   node setup/selftest/run.js --keep     跑完保留沙箱目录（排查用）
//
// 原理：把所有路径环境变量指向一个临时目录，用 mock-preload.js 把
// lark-cli 换成读沙箱文件，再用 NODE_OPTIONS=--require 注入到桥接进程。
// 生产代码里没有任何测试分支。
//
// 覆盖的链路：
//   1. 插件扫描与加载
//   2. 内核启动、单实例锁
//   3. 收到飞书消息 → 新话题 → 推工作区选择卡片
//   4. 回序号 → 开窗（拦截）→ 绑定话题
//   5. 已绑定话题里发言 → 投递给会话（拦截管道）
//   6. 提问 hook：here 档立刻放行、away 档落盘并阻塞
//   7. 提问卡片推出 → 点选项 → hook 拿到答案
//   8. 权限 hook：允许/拒绝两条路
//   9. 关停：锁被释放

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const KEEP = process.argv.includes('--keep');

// 内核模块在 require 时就把路径常量算死了，所以沙箱路径必须在第一次 require 之前设好。
// 下面 mkSandbox() 会覆盖这几个变量，这里只是先把顶层 require 挪到函数里。

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-selftest-'));
  const paths = {
    dir,
    data: path.join(dir, 'data'),
    logs: path.join(dir, 'logs'),
    config: path.join(dir, 'config.json'),
    mock: path.join(dir, 'mock'),
    claude: path.join(dir, 'claude'),
    socket: process.platform === 'win32'
      ? `\\\\.\\pipe\\feishu-selftest-${process.pid}`
      : path.join(dir, 'test.sock'),
  };
  for (const d of [paths.data, paths.logs, paths.mock, paths.claude,
    path.join(paths.claude, 'sessions'), path.join(paths.claude, 'projects')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(paths.config, JSON.stringify({
    chatId: 'oc_selftest',
    larkCli: 'lark-cli',
    plugins: { ask: { presenceAware: true, awayWaitSeconds: 60, awayIdleSeconds: 180 } },
    launchAliases: { demo: paths.claude },
    contextWindowSize: 200000,
  }, null, 2));
  fs.writeFileSync(path.join(paths.mock, 'messages.json'), '{}');
  for (const f of ['inbox.jsonl', 'outbox.jsonl', 'calls.jsonl']) {
    fs.writeFileSync(path.join(paths.mock, f), '');
  }
  return paths;
}

function env(p, extra) {
  return {
    ...process.env,
    FEISHU_DATA_DIR: p.data,
    FEISHU_LOG_DIR: p.logs,
    FEISHU_CONFIG: p.config,
    FEISHU_MOCK_DIR: p.mock,
    FEISHU_CLAUDE_HOME: p.claude,
    FEISHU_PRESENCE_FILE: path.join(p.data, 'presence.json'),
    // 把 away 档的等待压到 8 秒，让失败用例不至于卡满 60 秒（配置值本身仍是合法的 60）
    FEISHU_ASK_WAIT_MS: '8000',
    // 关键：关掉真实采样器。否则它会每秒覆盖 data/presence.json，
    // 把用例注入的「人在电脑前 / 人不在」假数据冲掉，判定就不可控了。
    FEISHU_DISABLE_PRESENCE: '1',
    NODE_OPTIONS: `--require ${path.join(__dirname, 'mock-preload.js').replace(/\\/g, '/')}`,
    ...extra,
  };
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

function pushEvent(p, ev) {
  fs.appendFileSync(path.join(p.mock, 'inbox.jsonl'), JSON.stringify(ev) + '\n');
}

function outbox(p) {
  return readLines(path.join(p.mock, 'outbox.jsonl'));
}

// 伪造一份「人在电脑前」的采样，让 hook 走 here 档
function writePresence(p, { idleSeconds, locked }) {
  fs.writeFileSync(path.join(p.data, 'presence.json'), JSON.stringify({
    ok: true, ts: Date.now(), idleSeconds, locked, windows: [],
  }));
}

// 启动一个假的会话收信端，验证桥接确实往管道里写了东西
function startFakeSession(p, sessionId) {
  return new Promise((resolve, reject) => {
    const got = [];
    const server = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) { try { got.push(JSON.parse(line)); } catch (_) {} }
        }
      });
    });
    server.on('error', reject);
    server.listen(p.socket, () => {
      // 让内核认为这个会话已注册
      fs.writeFileSync(path.join(p.claude, 'sessions', `${sessionId}.json`), JSON.stringify({
        sessionId, messagingSocketPath: p.socket, pid: process.pid, cwd: p.claude, name: 'selftest',
      }));
      fs.writeFileSync(path.join(p.claude, 'sessions', `${process.pid}.key`), JSON.stringify({
        peerToken: 'tok_selftest',
      }));
      resolve({ got, server });
    });
  });
}

function runHook(p, script, stdin, timeoutMs) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, script)], {
    input: JSON.stringify(stdin),
    encoding: 'utf8',
    timeout: timeoutMs || 60000,
    env: env(p),
  });
  let out = null;
  try { out = JSON.parse((r.stdout || '').trim() || 'null'); } catch (_) {}
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out, ms: Date.now() - t0 };
}

async function main() {
  const p = mkSandbox();
  console.log(`沙箱：${p.dir}\n`);

  console.log('1. 插件扫描与加载');
  const pluginLoad = spawnSync(process.execPath, ['-e', `
    const plugin = require('${path.join(ROOT, 'kernel', 'plugin.js').replace(/\\/g, '/')}');
    const lib = require('${path.join(ROOT, 'kernel', 'lib.js').replace(/\\/g, '/')}');
    const bus = plugin.createBus();
    const loaded = plugin.loadAll({ bus, lib, platform: require('${path.join(ROOT, 'platform').replace(/\\/g, '/')}'), global: { plugins: {} }, dataDir: lib.DATA_DIR });
    console.log(JSON.stringify(loaded.map((x) => ({ id: x.manifest.id, hooks: Object.keys(x.hooks), services: Object.keys(x.manifest.services || {}) }))));
  `], { cwd: ROOT, encoding: 'utf8', env: env(p) });
  let loaded = [];
  try { loaded = JSON.parse(pluginLoad.stdout.trim()); } catch (_) {}
  check('四个插件全部加载', loaded.length === 4, loaded.map((x) => x.id).join(','));
  check('core 有服务与 SessionStart hook',
    loaded.some((x) => x.id === 'core' && x.services.length === 1 && x.hooks.includes('SessionStart')));
  check('ask 带 PreToolUse hook', loaded.some((x) => x.id === 'ask' && x.hooks.includes('PreToolUse')));
  check('permission 带 PermissionRequest hook',
    loaded.some((x) => x.id === 'permission' && x.hooks.includes('PermissionRequest')));
  check('notify 带 Stop 与 Notification', loaded.some((x) => x.id === 'notify'
    && x.hooks.includes('Stop') && x.hooks.includes('Notification')));

  // 静态扫描：模块里调用了但没定义/没导入的函数。
  // node --check 查不出来（这是运行时 ReferenceError），而且只在对应代码路径
  // 被走到时才炸——「换会话」「再开一个窗口」两个按钮就是这么沉默失效的：
  // 按下去，日志里只有一行 ReferenceError，界面上毫无反应。
  console.log('\n1b. 模块引用完整性');
  {
    const srcDir = path.join(ROOT, 'plugins', 'core', 'src');
    const modFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.js'));
    const problems = [];
    const builtins = new Set(['require', 'setInterval', 'setTimeout',
      'clearInterval', 'clearTimeout', 'parseInt', 'parseFloat', 'isNaN']);

    for (const f of modFiles) {
      // 先剥注释：注释里出现 start( 之类的字样会被误判成未定义调用
      const src = fs.readFileSync(path.join(srcDir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const defined = new Set();
      for (const m of src.matchAll(/^(?:async )?function ([A-Za-z_$][\w$]*)/gm)) defined.add(m[1]);
      for (const m of src.matchAll(/const ([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
      for (const m of src.matchAll(/const \{([^}]+)\} = require/g)) {
        m[1].split(',').forEach((x) => defined.add(x.trim().split(':').pop().trim()));
      }
      for (const m of src.matchAll(/const ([A-Za-z_$][\w$]*) = require/g)) defined.add(m[1]);
      // 局部回调的参数（如 new Promise((resolve) => ...)）也算「已定义」，
      // 否则会把它们误报成未定义符号。
      for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) {
        m[1].split(',').forEach((x) => {
          const n = x.trim().replace(/[={].*$/, '').trim();
          if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
        });
      }
      for (const m of src.matchAll(/function\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) {
        m[1].split(',').forEach((x) => {
          const n = x.trim().split(/[=\s]/)[0];
          if (/^[A-Za-z_$][\w$]*$/.test(n)) defined.add(n);
        });
      }

      const missing = new Set();
      for (const m of src.matchAll(/(?:^|[^.\w])([a-z][A-Za-z0-9_]{3,})\(/g)) {
        if (!defined.has(m[1]) && !builtins.has(m[1])) missing.add(m[1]);
      }
      if (missing.size) problems.push(f + ': ' + [...missing].join(', '));
    }
    check('core 模块无未定义的函数调用', problems.length === 0, problems.join(' | '));
  }

  console.log('\n2. 内核启动');
  const bridge = spawn(process.execPath, [path.join(ROOT, 'kernel', 'index.js')], {
    cwd: ROOT, env: env(p), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let bridgeOut = '';
  bridge.stdout.on('data', (d) => { bridgeOut += d.toString(); });
  bridge.stderr.on('data', (d) => { bridgeOut += d.toString(); });

  // 等单实例锁落盘
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (fs.existsSync(path.join(p.data, 'bridge.pid'))) break;
  }
  check('进程启动并写入 pid 锁', fs.existsSync(path.join(p.data, 'bridge.pid')),
    fs.existsSync(path.join(p.data, 'bridge.pid')) ? `pid=${fs.readFileSync(path.join(p.data, 'bridge.pid'), 'utf8')}` : '无');
  await sleep(400);

  const bridgeLog = () => {
    try { return fs.readFileSync(path.join(p.logs, 'bridge.log'), 'utf8'); } catch (_) { return ''; }
  };
  check('日志记录已启动服务', /已启动 \d+ 个服务/.test(bridgeLog()), '');
  check('订阅了两个飞书事件', /card\.action\.trigger/.test(bridgeLog()), '');

  console.log('\n3. 收到新话题消息 → 推工作区选择卡片');
  // 先让沙箱里「发现」一个工作区
  fs.writeFileSync(path.join(p.claude, 'projects', 'demo.jsonl'),
    JSON.stringify({ type: 'message', cwd: p.claude, timestamp: new Date().toISOString() }) + '\n');

  // 必须在推事件**之前**登记它所属的话题——桥接收到事件后会立刻反查
  const m1 = JSON.parse(fs.readFileSync(path.join(p.mock, 'messages.json'), 'utf8') || '{}');
  m1.om_msg1 = { thread_id: 'omt_new1' };
  fs.writeFileSync(path.join(p.mock, 'messages.json'), JSON.stringify(m1));

  pushEvent(p, {
    __event: 'im.message.receive_v1',
    type: 'im.message.receive_v1',
    message_id: 'om_msg1',
    chat_type: 'group',
    content: '帮我改个 bug',
    message_type: 'text',
  });
  await sleep(1500);

  let ob = outbox(p);
  check('推出了卡片', ob.length >= 1, `${ob.length} 条`);
  const pickerCard = ob.find((o) => JSON.stringify(o.card || {}).includes('选择工作区'));
  check('卡片是「选择工作区」', !!pickerCard, '');
  check('卡片带选项按钮',
    !!(pickerCard && JSON.stringify(pickerCard.card).includes('"type":"callback"')), '');

  console.log('\n4. 回序号 → 开窗并绑定话题');
  fs.writeFileSync(path.join(p.data, 'pending', 'om_msg1.json'), JSON.stringify({
    messageId: 'om_msg1', threadId: 'omt_new1', list: [p.claude],
  }));
  const m2 = JSON.parse(fs.readFileSync(path.join(p.mock, 'messages.json'), 'utf8') || '{}');
  m2.om_pick1 = { thread_id: 'omt_new1' };
  fs.writeFileSync(path.join(p.mock, 'messages.json'), JSON.stringify(m2));

  pushEvent(p, {
    __event: 'im.message.receive_v1',
    type: 'im.message.receive_v1',
    message_id: 'om_pick1',
    chat_type: 'group',
    content: '1',
  });
  await sleep(2000);

  let mapping = '';
  try { mapping = fs.readFileSync(path.join(p.data, 'mapping.jsonl'), 'utf8'); } catch (_) {}
  check('话题已写入映射表', mapping.includes('omt_new1'), mapping ? '' : 'mapping.jsonl 不存在');

  console.log('\n5. 已绑定话题里发言 → 投递到会话');
  // 先把一个假会话注册好，让桥接能找到它的管道
  const fake = await startFakeSession(p, 'sess_selftest');
  const m3 = JSON.parse(fs.readFileSync(path.join(p.mock, 'messages.json'), 'utf8') || '{}');
  m3.om_say1 = { thread_id: 'omt_new1' };
  fs.writeFileSync(path.join(p.mock, 'messages.json'), JSON.stringify(m3));
  // 让映射指向这个假会话
  const lines = fs.readFileSync(path.join(p.data, 'mapping.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  fs.appendFileSync(path.join(p.data, 'mapping.jsonl'), JSON.stringify({
    ...last, feishuMessageId: 'omt_new1', sessionId: 'sess_selftest', sessionName: 'selftest',
  }) + '\n');

  pushEvent(p, {
    __event: 'im.message.receive_v1',
    type: 'im.message.receive_v1',
    message_id: 'om_say1',
    chat_type: 'group',
    content: '继续',
  });
  await sleep(1200);
  check('管道收到投递', fake.got.length > 0,
    fake.got.length ? `auth=${!!fake.got[0].token}` : '没收到');
  // 正文只加一句轻量来源标记：系统那条英文声明无法关闭，
  // 我们不再写大段解释（会把模型带偏成「这是另一个 Claude 发的」）。
  check('投递正文带用户信封',
    fake.got.some((g) => String(g.message && g.message.content || '')
      .startsWith('[来自用户本人 · 飞书]')), '');
  fake.server.close();

  // 话题必须在这一步就落盘。漏记的后果不只是「找不到归属」：
  // 后续提问卡/提醒卡会自己另开一棵话题，notify 再开一棵，
  // 用户看到的是「在 A 话题答完题，回复出现在 B 话题」。
  {
    const tf = path.join(p.data, 'threads', 'sess_selftest.json');
    let tr = null;
    try { tr = JSON.parse(fs.readFileSync(tf, 'utf8')); } catch (_) {}
    check('首个话题消息把窗口绑定到话题', !!(tr && tr.threadId === 'omt_new1'),
      tr ? `threadId=${tr.threadId}` : 'threads 无记录');
  }

  console.log('\n6. 提问 hook：here 档立刻放行');
  writePresence(p, { idleSeconds: 5, locked: false });
  const qHere = runHook(p, 'plugins/ask/hooks/ask-question.js', {
    hook_event_name: 'PreToolUse',
    session_id: 'sess_selftest',
    cwd: p.claude,
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '选哪个？', header: '测试', options: [{ label: 'A' }, { label: 'B' }] }] },
  });
  // here 档的意义就是「立刻放行」——超过 3 秒就说明它在白等，判定逻辑有问题
  check('here 档 3 秒内返回', qHere.ms < 3000, `${qHere.ms}ms`);
  check('here 档不输出决策（弹窗留给终端）', !qHere.out || !qHere.out.hookSpecificOutput, '');
  check('here 档记录标了 noticeOnly',
    (() => {
      try {
        const dir = path.join(p.data, 'questions');
        return fs.readdirSync(dir).some((f) => {
          const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          return r.noticeOnly === true && r.presence && r.presence.level === 'here';
        });
      } catch (_) { return false; }
    })(), '');

  console.log('\n7. 提问 hook：away 档落盘 + 卡片 + 作答回传');
  writePresence(p, { idleSeconds: 9999, locked: false });
  const awayHook = spawn(process.execPath, [path.join(ROOT, 'plugins/ask/hooks/ask-question.js')], {
    cwd: ROOT, env: env(p), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let awayOut = '';
  awayHook.stdout.on('data', (d) => { awayOut += d.toString(); });
  awayHook.stdin.write(JSON.stringify({
    hook_event_name: 'PreToolUse',
    session_id: 'sess_selftest',
    cwd: p.claude,
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '选哪个？', header: '测试', options: [{ label: 'A' }, { label: 'B' }] }] },
  }));
  awayHook.stdin.end();

  // 等记录落盘。第 6 步 here 档会留下一条 noticeOnly 记录，这里只认非 noticeOnly 的
  let qfile = null;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    const dir = path.join(p.data, 'questions');
    if (!fs.existsSync(dir)) continue;
    const hit = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).map((x) => path.join(dir, x))
      .find((f) => {
        try { return !JSON.parse(fs.readFileSync(f, 'utf8')).noticeOnly; } catch (_) { return false; }
      });
    if (hit) { qfile = hit; break; }
  }
  check('away 档写入待答记录', !!qfile, qfile ? path.basename(qfile) : '无');

  if (qfile) {
    const rec0 = JSON.parse(fs.readFileSync(qfile, 'utf8'));
    check('记录标了 away 档', rec0.presence && rec0.presence.level === 'away', rec0.presence && rec0.presence.reason);
    check('记录不是 noticeOnly', !rec0.noticeOnly, '');

    await sleep(2400);   // 等 bridge 扫描并发卡
    ob = outbox(p);
    const qCard = ob.find((o) => JSON.stringify(o.card || {}).includes('需要你来选'));
    check('桥接推出了作答卡片', !!qCard, '');

    // 模拟用户点第一个选项。直接改文件而不是 require 内核模块——
    // 内核在 require 时就把数据目录算死了，这里必须走文件。
    const rec = JSON.parse(fs.readFileSync(qfile, 'utf8'));
    rec.answers = { ...(rec.answers || {}), '选哪个？': 'A' };
    rec.done = true;
    rec.doneAt = Date.now();
    fs.writeFileSync(qfile, JSON.stringify(rec, null, 2));

    await new Promise((r) => awayHook.on('exit', r));
    let payload = null;
    try { payload = JSON.parse(awayOut.trim()); } catch (_) {}
    check('hook 返回 allow + 答案',
      !!(payload && payload.hookSpecificOutput
        && payload.hookSpecificOutput.permissionDecision === 'allow'
        && payload.hookSpecificOutput.updatedInput.answers['选哪个？'] === 'A'),
      awayOut.slice(0, 120));
  }

  console.log('\n8. 权限 hook：允许与拒绝');
  writePresence(p, { idleSeconds: 9999, locked: false });
  for (const decision of ['allow', 'deny']) {
    const h = spawn(process.execPath, [path.join(ROOT, 'plugins/permission/hooks/permission-request.js')], {
      cwd: ROOT, env: env(p), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    h.stdout.on('data', (d) => { out += d.toString(); });
    h.stdin.write(JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: 'sess_selftest',
      cwd: p.claude,
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    }));
    h.stdin.end();

    let pf = null;
    for (let i = 0; i < 40; i++) {
      await sleep(100);
      const dir = path.join(p.data, 'questions');
      if (!fs.existsSync(dir)) continue;
      const fs2 = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
      for (const name of fs2) {
        const r = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (r.kind === 'permission' && !r.done && !r.retiredAt) { pf = path.join(dir, name); break; }
      }
      if (pf) break;
    }

    if (!pf) {
      check(`权限(${decision}) 写入待答记录`, false, '没找到记录');
      continue;
    }
    const pr = JSON.parse(fs.readFileSync(pf, 'utf8'));
    pr.answers = { decision };
    pr.done = true;
    pr.doneAt = Date.now();
    fs.writeFileSync(pf, JSON.stringify(pr, null, 2));
    await new Promise((r) => h.on('exit', r));

    let pl = null;
    try { pl = JSON.parse(out.trim()); } catch (_) {}
    const got = pl && pl.hookSpecificOutput && pl.hookSpecificOutput.decision;
    check(`权限(${decision}) 返回正确决策`,
      !!(got && got.behavior === decision), got ? got.behavior : out.slice(0, 100));
  }

  console.log('\n9. 配置 schema');
  const cfgMod = require(path.join(ROOT, 'kernel', 'config.js'));
  const cfgCheck = spawnSync(process.execPath, [path.join(ROOT, 'kernel', 'config.js'), '--check'], {
    cwd: ROOT, encoding: 'utf8', env: env(p),
  });
  check('真实配置通过 schema 校验', cfgCheck.status === 0,
    (cfgCheck.stdout || cfgCheck.stderr || '').trim().split('\n')[0] || '');

  // 坏值必须被拦住，而不是静默生效
  const badRange = cfgMod.validate(
    { awayWaitSeconds: { type: 'integer', default: 1800, minimum: 60, maximum: 5700 } },
    { awayWaitSeconds: 99999 },
  );
  check('越界值被拒绝', badRange.errors.length > 0, badRange.errors[0] || '');

  const unknown = cfgMod.validate({ a: { type: 'boolean', default: true } }, { a: true, b: 1 });
  check('未知键只警告不报错', unknown.errors.length === 0 && unknown.warnings.length === 1,
    unknown.warnings[0] || '');

  const dflt = cfgMod.validate({ a: { type: 'integer', default: 7 } }, {});
  check('缺省时用 schema 的 default', dflt.values.a === 7, String(dflt.values.a));

  // 用户只写一项时，其余项应保留 schema 默认值
  const merged = cfgMod.validate(
    { x: { type: 'boolean', default: true }, y: { type: 'integer', default: 5 } },
    { y: 9 },
  );
  check('部分覆盖不影响其他默认值', merged.values.x === true && merged.values.y === 9,
    JSON.stringify(merged.values));

  const dumped = cfgMod.dumpSchema(Object.fromEntries(
    require(path.join(ROOT, 'kernel', 'plugin.js')).discover().map((m) => [m.id, m])));
  check('--dump 能导出全部插件 schema',
    Object.keys(dumped.plugins).length === 4
      && !!(dumped.plugins.ask.schema.properties.awayWaitSeconds || {})['x-ui'],
    Object.keys(dumped.plugins).join(','));

  console.log('\n9b. 介入通知不重复');
  {
    // 场景：人在电脑前，ask 插件已推过提醒卡（记录标 noticeOnly 并 retire），
    // 紧接着 Notification 事件也来了。不能因此再推一张重复卡片。
    writePresence(p, { idleSeconds: 5, locked: false });
    const qdir = path.join(p.data, 'questions');
    fs.mkdirSync(qdir, { recursive: true });
    fs.writeFileSync(path.join(qdir, 'dup-test.json'), JSON.stringify({
      id: 'dup-test', kind: 'question', sessionId: 'dedup-sess', cwd: p.claude,
      createdAt: Date.now(), noticeOnly: true, retiredAt: Date.now(),
      presence: { level: 'here' }, questions: [{ question: 'Q?', options: [] }],
    }));

    const before = outbox(p).length;
    runHook(p, 'plugins/notify/hooks/notify-input.js', {
      hook_event_name: 'Notification',
      session_id: 'dedup-sess',
      cwd: p.claude,
      notification_type: 'permission_prompt',
      message: '需要确认',
    });
    const after = outbox(p).length;
    check('已有待答记录时不再推重复通知', after === before, `${before} -> ${after}`);
  }

  console.log('\n9c. 卡片自己开的话题要登记归属');
  {
    // 窗口是手动在终端里开的，从没从飞书发过消息 → data/threads 里没有它。
    // 这时提问卡只能在群里自成新话题，但必须顺手把归属记下来，
    // 否则 notify 随后也会认为「没话题」，再开一棵。
    writePresence(p, { idleSeconds: 9999, locked: false });
    const qdir = path.join(p.data, 'questions');
    fs.mkdirSync(qdir, { recursive: true });
    fs.writeFileSync(path.join(qdir, 'notopic-test.json'), JSON.stringify({
      id: 'notopic-test', kind: 'question', sessionId: 'no-topic-sess', cwd: p.claude,
      createdAt: Date.now(), presence: { level: 'away' },
      questions: [{ question: 'Q?', options: [{ label: 'A' }] }],
    }));

    const before = outbox(p).length;
    await sleep(2600);   // 等 bridge 那一轮 2 秒的扫描
    const sent = outbox(p).slice(before);

    let tr = null;
    try {
      tr = JSON.parse(fs.readFileSync(path.join(p.data, 'threads', 'no-topic-sess.json'), 'utf8'));
    } catch (_) {}
    check('卡片发到群里并登记为新话题',
      sent.some((o) => o.kind === 'send') && !!(tr && tr.threadId), tr ? tr.threadId : '无归属记录');
  }

  console.log('\n9d. 项目挪过位置后 hooks 要改指到新位置');
  {
    // 搬目录后旧 hook 指向不存在的路径。只加不删的话，每个事件会跑两遍：
    // 一遍报「找不到文件」，一遍正常工作——这是最难查的那类问题。
    const hooksCfg = require(path.join(ROOT, 'setup', 'hooks-config.js'));
    const stale = {
      crossSessionInbound: 'accept',
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'codegraph prompt-hook' }] }],
        SessionStart: [{ hooks: [{ type: 'command',
          command: 'node D:/OldPlace/plugins/core/session-start.js', timeout: 10 }] }],
        Stop: [{ hooks: [{ type: 'command',
          command: 'node D:/OldPlace/plugins/notify/hooks/notify.js', timeout: 25 }] }],
      },
    };

    const r1 = hooksCfg.mergeInto(stale);
    const cmds = (ev) => (r1.settings.hooks[ev] || []).flatMap((e) => e.hooks.map((h) => h.command));
    check('旧位置的 hook 被摘掉', !cmds('SessionStart').some((c) => c.includes('OldPlace'))
      && !cmds('Stop').some((c) => c.includes('OldPlace')), cmds('SessionStart').join(','));
    check('用户自己的 hook 一条不动',
      cmds('UserPromptSubmit').includes('codegraph prompt-hook'), cmds('UserPromptSubmit').join(','));
    check('新位置补齐了全部 5 个事件',
      ['SessionStart', 'PreToolUse', 'PermissionRequest', 'Stop', 'Notification']
        .every((e) => cmds(e).length === 1), '');

    // 原样重跑必须幂等，否则每次 check/install 都会重写一遍 settings.json
    const r2 = hooksCfg.mergeInto(r1.settings);
    check('重复安装是幂等的', r2.added.length === 0 && r2.removed.length === 0,
      `added=${r2.added.length} removed=${r2.removed.length}`);
  }

  console.log('\n9e. 上下文进度条');
  {
    // 这段只在离线渲染时跑到，错了没人立刻发现，但它印在每一张卡片上。
    // 真实故障：分母写死 200000，而实际窗口是 500000 →
    // 305k 的用量被算成 100%，进度条永远满格、百分比再也不动。
    const { contextBar } = require(path.join(ROOT, 'kernel', 'lib.js'));
    check('62% 不满格', contextBar(310000, 500000) === '██░░ 62%', contextBar(310000, 500000));
    check('刚好 100% 才满格', contextBar(500000, 500000) === '████ 100%', contextBar(500000, 500000));
    check('超了也只是满格不越界', contextBar(900000, 500000) === '████ 100%', contextBar(900000, 500000));

    // 一致性：bar 满格 ⟺ 显示的百分比就是 100，不能出现「满格 + 98%」
    let mismatch = 0;
    for (let p = 0; p <= 100; p += 1) {
      const s = contextBar(p * 5000, 500000);
      const pct = Number((s.match(/(\d+)%/) || [])[1]);
      const full = (s.match(/█/g) || []).length === 4;
      if (full !== (pct === 100)) mismatch += 1;
    }
    check('进度条与百分比始终一致', mismatch === 0, `${mismatch} 处不一致`);
  }

  console.log('\n10. 关停与残留锁接管');
  // Windows 上 kill() 是终止进程，SIGTERM 处理器不会跑，pid 文件必然残留。
  // 所以这里验证的不是「锁被清掉」，而是「下一个实例能把残留锁接管掉」——
  // 这才是真实场景（任务管理器结束进程、断电、崩溃退出）。
  bridge.kill();
  await sleep(800);
  const staleKept = fs.existsSync(path.join(p.data, 'bridge.pid'));

  const again = spawn(process.execPath, [path.join(ROOT, 'kernel', 'index.js')], {
    cwd: ROOT, env: env(p), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let againOut = '';
  again.stdout.on('data', (d) => { againOut += d.toString(); });
  again.stderr.on('data', (d) => { againOut += d.toString(); });
  await sleep(1600);
  check('强杀后新实例能接管残留锁', !againOut.includes('已有实例在运行'),
    staleKept ? '旧锁文件仍在（符合 Windows 实际）' : '旧锁已清');
  again.kill();
  await sleep(300);

  // ---- 汇总 ----
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${'='.repeat(50)}`);
  console.log(`共 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
  if (bad.length) {
    console.log('\n失败项：');
    bad.forEach((r) => console.log(`  - ${r.name} ${r.detail}`));
    console.log('\n桥接输出：');
    console.log(bridgeOut.slice(-2000));
  }

  if (!KEEP) {
    try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch (_) {}
  } else {
    console.log(`\n沙箱保留在：${p.dir}`);
  }
  process.exit(bad.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
