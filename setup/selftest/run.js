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
    tmp: path.join(dir, 'tmp'),
    claude: path.join(dir, 'claude'),
    socket: process.platform === 'win32'
      ? `\\\\.\\pipe\\feishu-selftest-${process.pid}`
      : path.join(dir, 'test.sock'),
  };
  for (const d of [paths.data, paths.logs, paths.mock, paths.tmp, paths.claude,
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
  // 沙箱版的 ~/.claude.json。空 projects 是有意的：候选目录只能来自沙箱自己
  // 造的那一个（见 3. 的 demo.jsonl），这样卡片内容才是可断言的。
  fs.writeFileSync(path.join(paths.claude, '.claude.json'), JSON.stringify({ projects: {} }));
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
    // 沙箱必须把 ~/.claude.json 也隔离掉。它里面登记着本机真实用过的所有项目，
    // discoverWorkspaces 会把这些目录全当成候选——候选卡片于是被真实目录填满，
    // 沙箱自己造的那个目录反被挤到后面。以前没影响，是因为没有用例在意候选内容。
    FEISHU_CLAUDE_JSON: path.join(p.claude, '.claude.json'),
    FEISHU_PRESENCE_FILE: path.join(p.data, 'presence.json'),
    // 把 away 档的等待压到 8 秒，让失败用例不至于卡满 60 秒（配置值本身仍是合法的 60）
    FEISHU_ASK_WAIT_MS: '8000',
    // 关键：关掉真实采样器。否则它会每秒覆盖 data/presence.json，
    // 把用例注入的「人在电脑前 / 人不在」假数据冲掉，判定就不可控了。
    FEISHU_DISABLE_PRESENCE: '1',
    // 开窗脚本不要落到真实的 %TEMP%：自测每跑一次会留一个 cc-launch-*.cmd，
    // 攒下来就是用户 TEMP 里一堆垃圾。TEMP 指到沙箱，收尾一起删。
    TEMP: p.tmp,
    TMP: p.tmp,
    TMPDIR: p.tmp,
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
  check('全部插件加载', loaded.length === 5, loaded.map((x) => x.id).join(','));
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
  // 别名必须在候选里露出来：只藏在 config.json 里的话，用户不知道 #demo 能直达。
  // 沙箱配置里把 demo 这个别名指向了 p.claude，它就是候选里唯一有别名的那条。
  // 有别名时按钮上**只显示别名**，不拼路径——按钮宽度有限，拼接会把两者都拉长。
  const cardJson = JSON.stringify((pickerCard && pickerCard.card) || {});
  check('有别名的候选只显示别名',
    cardJson.includes('"content":"1. demo') && !cardJson.includes('1. demo · '),
    cardJson.slice(0, 260));
  check('卡片底部列出可用的别名', cardJson.includes('#demo'), '');

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

  // 开窗这一步必须被沙箱拦下。它以前没拦：每跑一次自测，用户桌面上就真多一个
  // Windows Terminal 窗口跑 claude，跑完也没人关——几次下来满屏终端。
  // 认 mock 记下的那条 launch 调用，光看 .cmd 文件分不出「拦下了」还是「真跑了」。
  check('开窗被沙箱拦下、没有真起终端',
    readLines(path.join(p.mock, 'calls.jsonl')).some((c) => c.note === 'launch mocked'), '');
  check('开窗脚本落在沙箱目录', fs.readdirSync(p.tmp).some((f) => /^cc-launch-/.test(f)),
    fs.readdirSync(p.tmp).join(',') || '空');

  // 非 Windows 平台开窗走 `bash launch-claude.sh`，上面的 cscript 拦截管不到，
  // 所以要单独确认这条路拦得住——否则在 mac/Linux 上跑自测会真弹终端窗口。
  check('mac/Linux 的开窗入口也认得出来',
    (() => {
      const src = fs.readFileSync(path.join(ROOT, 'setup', 'selftest', 'mock-preload.js'), 'utf8')
        // 先剥注释，否则光凭注释里提到 launch-claude.sh 就会误判通过
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return /isNixLaunch\s*=/.test(src) && /launch-claude\.sh/.test(src);
    })(), 'mock-preload 缺少 bash 开窗拦截');

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
    { awayWaitSeconds: { type: 'integer', default: 1800, minimum: 60, maximum: 1800 } },
    { awayWaitSeconds: 99999 },
  );
  check('越界值被拒绝', badRange.errors.length > 0, badRange.errors[0] || '');

  // 等待上限必须落在 hook 超时之内。写死过 5700 秒，比 hook 的 1900 秒长得多——
  // 配成那个区间，卡片还没等到就被系统先收走，而 schema 一路放行。
  {
    const HOOK_TIMEOUT_SEC = 1900;   // 与 setup/hooks-config.js 里两个阻塞 hook 一致
    const over = [];
    for (const m of require(path.join(ROOT, 'kernel', 'plugin.js')).discover()) {
      const spec = (m.config || {}).awayWaitSeconds;
      if (spec && spec.maximum > HOOK_TIMEOUT_SEC) over.push(`${m.id}=${spec.maximum}`);
    }
    check('等待上限不超过 hook 超时', over.length === 0, over.join(', '));
  }

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
    Object.keys(dumped.plugins).length === 5
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

  console.log('\n9d. 实时状态卡');
  {
    // 这个功能的核心承诺是「刷新不产生新消息」，所以用例必须同时守住两件事：
    //   1. 内容变了 → 发 patch（不是发新消息）
    //   2. 内容没变 → 一个请求都不发
    // 只验第 1 条的话，写成每秒无脑 patch 也能通过——而那就等于给用户刷屏。
    //
    // 必须在**子进程**里跑：probe 与 kernel/lib 在 require 时就把
    // ~/.claude 与 data/ 算成了常量（与生产代码一致，那是刻意的）。
    // 在主进程里 require 会读到本机真实的会话表，跑到用户自己的窗口上去。
    const script = `
      const fs = require('fs');
      const path = require('path');
      const ROOT = ${JSON.stringify(ROOT)};
      const statusMod = require(path.join(ROOT, 'plugins', 'status', 'index.js'));
      const probeMod = require(path.join(ROOT, 'plugins', 'status', 'src', 'probe.js'));
      const lib = require(path.join(ROOT, 'kernel', 'lib.js'));

      const sessDir = path.join(process.env.FEISHU_CLAUDE_HOME, 'sessions');
      const projDir = path.join(process.env.FEISHU_CLAUDE_HOME, 'projects', 'statusdemo');
      fs.mkdirSync(projDir, { recursive: true });
      const sid = 'status-sess';
      const transcript = path.join(projDir, sid + '.jsonl');
      const reg = (sessionId, status) => fs.writeFileSync(path.join(sessDir, process.pid + '.json'),
        JSON.stringify({ pid: process.pid, sessionId, cwd: lib.ROOT, name: '状态卡窗口',
          status, statusUpdatedAt: Date.now() }));

      const line = (o) => JSON.stringify(o) + '\\n';
      fs.writeFileSync(transcript,
        line({ type: 'user', message: { role: 'user', content: '跑一下测试' }, timestamp: new Date().toISOString() })
        + line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [
          { type: 'text', text: '先跑测试。' },
          { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm test', description: '跑单测' } },
        ] } })
        + line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } })
        + line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'npm run build', description: '构建产物' } },
        ] } })
        // 会话标题：卡片标题栏必须用它，不能退回「目录名-短哈希」那种派生名
        + line({ type: 'ai-title', aiTitle: '给状态卡起个好名字' }));
      reg(sid, 'busy');

      const threads = path.join(process.env.FEISHU_DATA_DIR, 'threads');
      fs.mkdirSync(threads, { recursive: true });
      fs.writeFileSync(path.join(threads, sid + '.json'),
        JSON.stringify({ sessionId: sid, rootMessageId: 'om_root_status', threadId: 'omt_status', at: Date.now() }));

      const pr = probeMod.probe(sid);
      const ctx = { config: { intervalSeconds: 2, pinCard: false, showToolDetail: true },
        dataDir: path.join(process.env.FEISHU_DATA_DIR, 'plugins', 'status'),
        log: () => {}, lib };
      // 正式运行时这步在 start() 里做；这里手动调，才能验「重启后接着用同一张卡」
      statusMod.loadCards(ctx);

      const outbox = path.join(process.env.FEISHU_MOCK_DIR, 'outbox.jsonl');
      const count = () => { try { return fs.readFileSync(outbox, 'utf8').split('\\n').filter(Boolean).length; } catch (_) { return 0; } };
      const since = (n) => { try {
        return fs.readFileSync(outbox, 'utf8').split('\\n').filter(Boolean).slice(n).map((l) => JSON.parse(l));
      } catch (_) { return []; } };
      // tick 是异步的（改用异步 spawn 是为了不阻塞主循环），逐轮 await。
      // node -e 是 CJS，没有顶层 await，所以整段包在 async 函数里。
      const tick = () => statusMod.tick(ctx, sid, {
        sessionId: sid, pid: process.pid, cwd: lib.ROOT, name: '状态卡窗口',
        status: JSON.parse(fs.readFileSync(path.join(sessDir, process.pid + '.json'), 'utf8')).status,
        statusUpdatedAt: Date.now(),
      });
      const n0 = () => { try { return fs.readFileSync(outbox, 'utf8').split('\\n').filter(Boolean).length; } catch (_) { return 0; } };
      const s0 = (n) => { try {
        return fs.readFileSync(outbox, 'utf8').split('\\n').filter(Boolean).slice(n).map((l) => JSON.parse(l));
      } catch (_) { return []; } };

      (async () => {
        // 第一轮：开卡
        let n = n0();
        const r1 = { patched: (await tick()) ? 1 : 0 };
        const wave1 = s0(n);

        // 第二轮：内容没变
        n = n0();
        const r2 = { patched: (await tick()) ? 1 : 0 };
        const wave2 = s0(n);

        // 第三轮：换了个工具（写文件），必须 patch 而不是新发
        fs.appendFileSync(transcript, line({ type: 'assistant', timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [
            { type: 'tool_use', id: 'tu_3', name: 'Write', input: { file_path: 'src/a.js', content: 'x' } }] } }));
        reg(sid, 'busy');
        n = n0();
        const r3 = { patched: (await tick()) ? 1 : 0 };
        const wave3 = s0(n);

        // 第三轮 b：一个**已经跑完**的后台命令，外加一条 api-request-blob 副本。
        // 转录会把同一批 tool_use 复制进 blob 记录里；如果拿 blob 当证据，
        // 这个已经结束的后台命令会永远被判成「还在跑」，卡片就一直黄着。
        // 这正是线上真实踩到的问题（启了个后台 shell 之后卡片再也不收）。
        fs.appendFileSync(transcript, [
          line({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [
            { type: 'tool_use', id: 'tu_bg', name: 'Bash',
              input: { run_in_background: true, description: '起个后台' } }] } }),
          line({ type: 'user', message: { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'tu_bg', content: 'running in background' }] } }),
          // blob 的 content 与真实记录同构，但没有 type=user/assistant 的语义
          line({ type: 'api-request-blob', message: { role: 'assistant', content: [
            { type: 'tool_use', id: 'tu_bg', name: 'Bash',
              input: { run_in_background: true, description: '起个后台' } }] } }),
        ].join('\\n') + '\\n');
        const prBg = probeMod.probe(sid);
        const bgSubtasks = (prBg && prBg.subtasks) || [];

        // 第四轮：窗口停下
        reg(sid, 'idle');
        n = n0();
        await tick();
        const wave4 = s0(n);

        // 第四轮 b：主会话说完了，但它拉起的子代理还没回来。
        // 这是用户要的关键区分——此时说「本轮结束」是错的，卡片必须显示
        // 「还有子任务在跑」。而且必须**另起一张**：AI 的回复卡刚落到话题底部，
        // 原来那张状态卡已经被顶到上面看不见了。
        fs.appendFileSync(transcript, line({ type: 'assistant', timestamp: new Date().toISOString(),
          message: { role: 'assistant', content: [
            { type: 'tool_use', id: 'tu_sub', name: 'Agent',
              input: { subagent_type: 'Explore', description: '扫一遍依赖', prompt: '@@@' } }] } }));
        // 先回到 busy 再回 idle，才构成一次真实的「本轮结束」翻转
        reg(sid, 'busy');
        await tick();
        reg(sid, 'idle');
        n = n0();
        await tick();
        const wave4b = s0(n);
        // 换卡时先是 retireCard 的 patch（旧卡灰化），再是 reply（新卡）。
        // 断言要看**新卡那张**，不是第一条调用。
        const new4b = wave4b.find((o) => o.kind === 'reply');
        const card4b = JSON.stringify((new4b || {}).card || {});
        const prSub = probeMod.probe(sid);
        const mainMid = (wave1[0] || {}).messageId;

        // 第四轮 c：用户又发了新的一句 → 新一轮开始，必须换一张落在底部的卡。
        // 这是「卡片被用户的新消息顶掉」那条路径；靠转录里新出现的**人打的**那句话判定。
        fs.appendFileSync(transcript,
          line({ type: 'user', timestamp: new Date().toISOString(),
            message: { role: 'user', content: '再改一版' } }));
        reg(sid, 'busy');
        n = n0();
        await tick();
        const wave4c = s0(n);

        // 落盘与重启：stop() 会立刻写盘。清空内存后重新加载，再刷一轮，
        // 不许出现任何 reply（那意味着又开了一张新卡）。
        //
        // 必须放在第五轮**之前**：那一轮会把会话表换成另一个 sessionId，
        // drain 顺着「窗口已经没了」把记录丢掉——那时再查文件自然是空的。
        statusMod.stop();
        const dataPlugins = path.join(process.env.FEISHU_DATA_DIR, 'plugins', 'status');
        const cardsFile = path.join(dataPlugins, 'cards.json');
        let saved = null;
        try { saved = JSON.parse(fs.readFileSync(cardsFile, 'utf8')); } catch (_) {}
        const persisted = !!(saved && saved[sid] && saved[sid].messageId);

        statusMod.cards.clear();
        statusMod.loadCards({ dataDir: dataPlugins, log: () => {} });
        n = n0();
        await tick();
        const afterRestart = s0(n);
        const memoryMid = (statusMod.cards.get(sid) || {}).messageId;

        // 第五轮：一个没有话题的活跃窗口，不该发卡（走 drain 才能覆盖过滤逻辑）
        reg('no-topic-status', 'busy');
        n = n0();
        await statusMod.drain(ctx);
        const wave5 = s0(n);
        statusMod.stop();

        console.log(JSON.stringify({
          probe: pr, r1, r2, r3, wave1, wave2, wave3, wave4, wave4b, wave4c, wave5,
          subTasks: prSub && prSub.subtasks,
          bgSubtasks,
          card4b, mainMid, mainMid2: (new4b || {}).messageId,
          persisted, cardsFile, restartSameCard: afterRestart.filter((o) => o.kind === 'reply').length === 0,
          restartMid: memoryMid,
        }));
      })().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
    `;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', env: env(p), timeout: 60000 });
    let res = {};
    try { res = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) {}
    if (!res || !res.r1) {
      check('状态卡用例能在沙箱里跑起来', false,
        `status=${r.status} ${(r.stderr || '').slice(0, 400)} | stdout=${(r.stdout || '').slice(0, 300)}`);
    } else {
      const pr = res.probe || {};
      // 探测：正在跑的工具要从转录里读出来，且是**没闭合**的那个（tu_1 已闭合，不算）
      check('探测到没闭合的工具', !!(pr.tool && pr.tool.name === 'Bash'), JSON.stringify(pr.tool));
      check('已完成的工具不误报为「正在跑」', pr.tool && pr.tool.arg === '构建产物', String(pr.tool && pr.tool.arg));
      check('读到本轮最后一句正文', pr.said === '先跑测试。', String(pr.said));
      // 标题栏必须是会话的名字，不能是「目录名-短哈希」那种派生名——
      // 用户看到 tt-design-space-ai-26 根本认不出是哪一个窗口。
      check('标题取会话名而不是派生名', pr.title === '给状态卡起个好名字', String(pr.title));
      check('读到这一轮人发的原话', pr.myPrompt === '跑一下测试', String(pr.myPrompt));

      const replies = res.wave1.filter((o) => o.kind === 'reply');
      check('首次刷新开出一张状态卡', replies.length === 1 && res.r1.patched === 1,
        `${res.wave1.length} 条调用`);
      check('状态卡挂在窗口自己的话题里', (replies[0] || {}).replyTo === 'om_root_status',
        String((replies[0] || {}).replyTo));
      check('状态卡带正在用的工具',
        JSON.stringify((replies[0] || {}).card || {}).includes('构建产物'), '');

      // 内容没变 → 一个请求都不发。写成每轮无脑 patch 也能过前几条用例，
      // 而那就等于给用户刷屏，所以这条必须单独守。
      check('内容没变时不发任何请求', res.wave2.length === 0 && res.r2.patched === 0,
        `${res.wave2.length} 条调用`);

      check('内容变了走原地 patch',
        res.wave3.length === 1 && res.wave3[0].kind === 'patch',
        res.wave3.map((o) => o.kind).join(',') || '没有调用');
      check('patch 打到同一张卡上（不是新消息）',
        !!(res.wave3[0] && res.wave3[0].messageId
          && res.wave3[0].messageId === (replies[0] || {}).messageId),
        res.wave3[0] ? String(res.wave3[0].messageId) : '');

      check('这轮结束后卡片标成「本轮结束」',
        res.wave4.some((o) => JSON.stringify(o.card || {}).includes('本轮结束')), '');

      // 用户要的核心区分：主会话回了消息，但子代理还在跑。
      // 卡片这时不能写「本轮结束」，否则他以为活儿完了。
      check('识别出未闭合的子代理',
        Array.isArray(res.subTasks) && res.subTasks.some((s) => s.kind === 'agent' && s.name === 'Explore'),
        JSON.stringify(res.subTasks));
      // 已闭合的后台命令 + 同名 blob 副本，都不该算「还在跑」
      check('已跑完的后台命令不算子任务', (res.bgSubtasks || []).length === 0,
        JSON.stringify(res.bgSubtasks));
      check('子代理还在跑时卡片不说「本轮结束」',
        res.card4b.includes('子任务还在跑') && !res.card4b.includes('本轮结束'), res.card4b.slice(0, 160));
      check('子代理还在跑时卡片标黄', res.card4b.includes('orange'), '');
      // 另起一张而不是 patch 旧的：旧卡在话题里已经被 AI 的回复顶到上面看不见了
      // 另起一张，而不是继续 patch 旧卡：旧卡在话题里已经被 AI 的回复顶到上面看不见了。
      // 换卡时那条 patch 是**收掉旧卡**（灰化），不是刷新它，所以不算「还在用旧卡」。
      check('有子任务续跑时另起一张卡',
        res.wave4b.some((o) => o.kind === 'reply')
          && !!res.mainMid2 && res.mainMid2 !== res.mainMid,
        `新卡=${res.mainMid2 || '无'} 旧卡=${res.mainMid}`);

      // 用户发了新消息 → 新一轮。旧卡要被收掉（灰化 patch），新卡落到底部。
      check('用户开新一轮时换一张新卡',
        res.wave4c.some((o) => o.kind === 'patch' && !!(o.card || {}).header)
          && res.wave4c.some((o) => o.kind === 'reply'),
        res.wave4c.map((o) => o.kind).join(',') || '没有调用');
      check('换卡时新卡不是原来那张',
        (res.wave4c.find((o) => o.kind === 'reply') || {}).messageId !== res.mainMid,
        String((res.wave4c.find((o) => o.kind === 'reply') || {}).messageId));
      check('没有话题的窗口不发卡', res.wave5.length === 0, `${res.wave5.length} 条调用`);

      // 卡上显示哪几行是配置项（配置页能改）。关掉一项必须真的少一行——
      // 只把配置读进来不生效，是这类「开关」最常见的假实现。
      {
        const { buildStatusCard } = require(path.join(ROOT, 'plugins', 'status', 'src', 'card.js'));
        const base = {
          title: 'T', cwd: '/w', running: true, runningSince: Date.now() - 1000, idleSince: 0,
          probe: { myPrompt: '你说的', tool: { name: 'Bash', arg: 'x' }, edited: ['/a/b.js'], said: '它说的' },
          stats: '██░░ 50%',
        };
        const full = buildStatusCard(base);
        const bare = buildStatusCard({
          ...base,
          view: {
            showPrompt: false, showToolDetail: false, showEditedFiles: false,
            showModelSaid: false, showStats: false,
          },
        });
        const text = (c) => JSON.stringify(c.body.elements);
        check('关掉显示项后卡片真的变短', bare.body.elements.length < full.body.elements.length,
          `${full.body.elements.length} -> ${bare.body.elements.length}`);
        check('关掉的项一个都不剩',
          !/你说/.test(text(bare)) && !/它说/.test(text(bare)) && !/本轮改了/.test(text(bare))
            && !/📦/.test(text(bare)) && !/🔧/.test(text(bare)),
          text(bare).slice(0, 160));
      }

      // 重启不该重开卡：卡片 id 必须落盘，否则每重启一次就是每个话题多一条新消息 + 一个未读。
      // 这个功能改代码就要重启，一天能攒出一串卡片——用户看到的就是「它在不停发新消息」。
      check('卡片记录已落盘', !!res.persisted, String(res.cardsFile || ''));
      check('重启后接着用原来那张卡，不重开', !!res.restartSameCard, `memory=${res.restartMid || '无'}`);
    }
  }

  console.log('\n9e. 项目挪过位置后 hooks 要改指到新位置');
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

    // 命令形态按平台不同，两边都必须能跑：
    //   Windows → cmd /c，不能带引号（否则整串当成一个程序名）
    //   macOS/Linux → sh -c，必须带引号（否则路径里的空格会拆开参数）
    const cmdsAll = ['SessionStart', 'PreToolUse', 'PermissionRequest', 'Stop', 'Notification']
      .flatMap((e) => cmds(e));
    const expected = hooksCfg.buildCommand(hooksCfg.NODE, 'SCRIPT', process.platform);
    check('hook 命令形态与当前平台匹配',
      cmdsAll.every((c) => c.includes(process.platform === 'win32' ? `${hooksCfg.NODE} ` : `"${hooksCfg.NODE}"`)),
      `${process.platform}: ${expected}`);
    check('hook 命令以 node 绝对路径开头',
      cmdsAll.every((c) => c.startsWith(hooksCfg.NODE) || c.startsWith(`"${hooksCfg.NODE}"`)),
      cmdsAll[0] || '');
  }

  console.log('\n9f. 上下文进度条');
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

  console.log('\n9g. 识别「用户这一轮在终端里说了什么」');
  {
    // Stop hook 的 stdin 里没有用户输入，只能从转录尾部反查。
    // 难点全在「把系统注入的文本排除掉」——转录里 user 角色混着一大堆
    // task-notification / pasted_content / 图片占位符 / 斜杠命令回显。
    const { lastUserInput } = require(path.join(ROOT, 'kernel', 'lib.js'));
    const tf = path.join(p.dir, 'transcript.jsonl');
    const line = (obj) => JSON.stringify(obj) + '\n';
    const u = (content, extra) => line({ type: 'user', message: { role: 'user', content }, ...(extra || {}) });
    const a = (text) => line({ type: 'assistant', message: { role: 'assistant', content: text } });

    const cases = [
      ['纯文本', u('帮我改个 bug'), '帮我改个 bug'],
      ['工具回执不算', u([{ type: 'tool_result', content: 'ok' }]), null],
      ['后台任务回执不算',
        u('<task-notification>\n<task-id>x</task-id>\n</task-notification>'), null],
      ['斜杠命令回显不算', u('<local-command-stdout>Compacted</local-command-stdout>'), null],
      ['系统提醒不算', u('<system-reminder>The user named this</system-reminder>'), null],
      ['中断标记不算', u('[Request interrupted by user]'), null],
      ['compact 摘要不算', u('This session is being continued from a previous one'), null],
      ['飞书来信不回音', u('[来自用户本人 · 飞书]（下面这段…）\n\n你好'), null],
      ['跨会话前缀不回音', u('Another Claude session sent a message:\n\n你好'), null],
      ['粘贴块保留内容', u('<pasted_content id="a1">\n日志如下\n</pasted_content>'), '日志如下'],
      ['图片占位符剥掉、留下文字', u('[Image #3] 这个样式不对'), '这个样式不对'],
    ];

    for (const [label, msg, expect] of cases) {
      fs.writeFileSync(tf, a('回答') + msg, 'utf8');
      const got = lastUserInput(tf);
      const ok = expect === null ? got === null : (got !== null && got.includes(expect));
      check(`终端输入识别 · ${label}`, ok, ok ? '' : `期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(got)}`);
    }

    // 真实场景：中间夹着工具回执，得一路往前跳到人那句话
    fs.writeFileSync(tf,
      a('第一轮') + u('继续改') + a('第二轮')
      + u([{ type: 'tool_result', content: 'ok' }]) + a('还在改'), 'utf8');
    check('跳过工具回执找到人那句话', lastUserInput(tf) === '继续改', lastUserInput(tf));

    // 反过来的真实场景：终端说过一句 → 接着这一轮是从飞书发起的。
    // 卡片上不该出现那句终端输入（它不是这一轮的问题）。
    // 曾经的 bug：识别到飞书来信后是 continue 继续往前翻，
    // 于是把上一轮终端里的话当成本轮输入，飞书回复的卡片上顶着无关旧话。
    fs.writeFileSync(tf,
      a('第一轮') + u('终端里敲的那句话') + a('第一轮结束')
      + u('Another Claude session sent a message:\n[来自用户本人 · 飞书]（下面这段…）\n\n飞书里问的'),
      'utf8');
    check('飞书发起的这一轮不回退到旧的终端输入', lastUserInput(tf) === null,
      JSON.stringify(lastUserInput(tf)));

    // 更早还有别的终端输入时，同样不能翻出来
    fs.writeFileSync(tf,
      a('a') + u('更早的一句話') + a('b') + u('中间那句') + a('c')
      + u('Another Claude session sent a message:\n\n飞书里的问题'),
      'utf8');
    check('飞书发起时不往前翻任何终端输入', lastUserInput(tf) === null,
      JSON.stringify(lastUserInput(tf)));
  }

  console.log('\n9h. 长的终端输入折起来而不是截断');
  {
    // 短的一行摆出来，长的用 collapsible_panel 折叠——飞书里唯一能
    // 「点一下看全文」的组件。以前是直接截到 300 字，长输入等于丢了。
    const tf = path.join(p.dir, 'transcript-long.jsonl');
    const write = (text) => fs.writeFileSync(tf, JSON.stringify({
      type: 'user', message: { role: 'user', content: text },
    }) + '\n', 'utf8');

    const outbox = path.join(p.mock, 'outbox.jsonl');
    const send = (text) => {
      write(text);
      const before = readLines(outbox).length;
      runHook(p, 'plugins/notify/hooks/notify.js', {
        hook_event_name: 'Stop',
        session_id: 'long-said-sess',
        cwd: p.claude,
        transcript_path: tf,
        last_assistant_message: '收到。',
      });
      const lines = readLines(outbox);
      return lines.length > before ? lines[lines.length - 1].card : null;
    };

    const shortCard = send('短的一句话');
    const shortEls = (shortCard && shortCard.body && shortCard.body.elements) || [];
    check('短输入直接展示，不折叠',
      shortEls.some((e) => e.tag === 'markdown' && e.content.includes('短的一句话'))
      && !shortEls.some((e) => e.tag === 'collapsible_panel'), '');

    const LONG = '这是一段很长的终端输入，用来验证折叠面板。'.repeat(30);
    const longCard = send(LONG);
    const longEls = (longCard && longCard.body && longCard.body.elements) || [];
    const panel = longEls.find((e) => e.tag === 'collapsible_panel');
    check('长输入用折叠面板', !!panel, panel ? '' : '没找到 collapsible_panel');
    check('折叠区里有完整原文',
      !!(panel && JSON.stringify(panel).includes(LONG.slice(0, 80))), '');
    check('默认是收起的', !!(panel && panel.expanded === false), '');

    // 超过卡片上限时截断，但必须说明——悄悄截断比不显示更糟
    const HUGE = '巨'.repeat(6000);
    const hugeCard = send(HUGE);
    const hugeOut = JSON.stringify(hugeCard);
    check('超长输入截断并注明原文长度',
      hugeOut.includes(`原文共 ${HUGE.length} 字`), '');
    check('卡片不超过飞书 30KB 上限', hugeOut.length < 28000, `${hugeOut.length} 字节`);
  }

  console.log('\n9h. 飞书图片落盘');
  {
    // 真实事件里图片是 markdown 写法 `![Image](img_v3_xxx)`，
    // 早期代码只认 `[Image: img_xxx]`——两种都对不上就等于「图片功能整条不通」，
    // 而且失败方式是静默的：用户以为发了图，窗口只收到一串 img_ 字面量。
    // 必须在子进程里跑：kernel/lib 在 require 时就把数据目录定死了，
    // 本进程前面已经 require 过它（指向项目真实 data/），改环境变量也追不回来。
    const sess = path.join(ROOT, 'plugins', 'core', 'src', 'session.js').replace(/\\/g, '/');
    const r = spawnSync(process.execPath, ['-e', `
      const s = require(${JSON.stringify(sess)});
      const out = {
        md: s.materializeImages('om_img1', '![Image](img_v3_aaa-111)\\n这张图有啥问题'),
        legacy: s.materializeImages('om_img2', '[Image: img_x_222] 旧格式'),
        two: s.materializeImages('om_img3', '![Image](img_a_1)\\n![Image](img_b_2)'),
        plain: s.materializeImages('om_img4', '纯文字，没有图'),
        // 纯图片消息的 content 是 JSON，跟带文字的 post 不是一个形状
        pure: s.materializeImages('om_img5', '{"image_key":"img_pure_9"}'),
      };
      const d = new Date();
      out.localDay = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0')
        + String(d.getDate()).padStart(2, '0');
      console.log(JSON.stringify(out));
    `], { cwd: ROOT, encoding: 'utf8', env: env(p), timeout: 60000 });

    let out = {};
    try { out = JSON.parse((r.stdout || '').trim().split('\n').pop()); } catch (_) {}

    check('markdown 图片标记被换成本地路径',
      /\[图片\] .*om_img1_1\.png/.test(out.md || '') && !(out.md || '').includes('img_v3_aaa-111'),
      (out.md || r.stderr || '').slice(0, 160));
    check('旧的 [Image: xxx] 写法也认',
      /\[图片\] .*om_img2_1\.png/.test(out.legacy || ''), (out.legacy || '').slice(0, 120));
    check('一条消息里两张图各自落盘成不同文件',
      /om_img3_1\.png/.test(out.two || '') && /om_img3_2\.png/.test(out.two || ''),
      (out.two || '').slice(0, 160));
    check('没有图片时正文原样返回', out.plain === '纯文字，没有图', String(out.plain));
    // 纯图片消息的 content 是 {"image_key":"img_xxx"}，不带文字。
    // 不认这个形状的话，用户在飞书里只发一张图 = 窗口收到一串 JSON。
    check('纯图片消息（JSON content）也能落盘',
      /\[图片\] .*om_img5_1\.png/.test(out.pure || '') && !(out.pure || '').includes('image_key'),
      String(out.pure).slice(0, 160));

    // 目录名按本地日期，不是 UTC。UTC+8 的早上 8 点前用 toISOString()
    // 会落到前一天，配合同样按目录名判断的过期清理，等于早 8 小时被删。
    check('图片按本地日期归档',
      !!out.localDay && fs.existsSync(path.join(p.data, 'images', out.localDay)),
      `期望目录 ${out.localDay}`);

    // 过期清理：按目录名算天数，不按 mtime——老目录里刚存进一张图会把 mtime
    // 刷新成「今天」，按 mtime 算等于「只要还在收图，旧图永远不删」。
    const imgRoot = path.join(p.data, 'images');
    const old = `${out.localDay.slice(0, 4) - 1}${out.localDay.slice(4)}`;  // 去年同一天
    fs.mkdirSync(path.join(imgRoot, old), { recursive: true });
    fs.writeFileSync(path.join(imgRoot, old, 'keep.png'), 'x');
    fs.mkdirSync(path.join(imgRoot, 'not-a-date'), { recursive: true });
    fs.writeFileSync(path.join(imgRoot, 'not-a-date', 'x'), 'x');
    const clean = spawnSync(process.execPath, ['-e', `
      const lib = require(${JSON.stringify(path.join(ROOT, 'kernel', 'lib.js').replace(/\\/g, '/'))});
      console.log(JSON.stringify(lib.cleanup()));
    `], { cwd: ROOT, encoding: 'utf8', env: env(p), timeout: 30000 });
    let rep = {};
    try { rep = JSON.parse((clean.stdout || '').trim().split('\n').pop()); } catch (_) {}
    check('过期图片目录被清掉', rep.images === 1, JSON.stringify(rep));
    check('过期的日期目录真的删了', !fs.existsSync(path.join(imgRoot, old)), old);
    check('当天的图不删', fs.existsSync(path.join(imgRoot, out.localDay)), out.localDay);
    check('不像日期目录的不碰', fs.existsSync(path.join(imgRoot, 'not-a-date', 'x')), '');
  }

  console.log('\n9i. 端到端：飞书发图 → 窗口收到本地路径');
  {
    // 上面 9h 单测的是函数本身，这里走完整链路：事件进来 → 下载 → 投递。
    // 单测绿而链路红是常见情况（比如调用点没接上），所以两层都要有。
    const f2 = await startFakeSession(p, 'sess_img');
    const m4 = JSON.parse(fs.readFileSync(path.join(p.mock, 'messages.json'), 'utf8') || '{}');
    m4.om_img_e2e = { thread_id: 'omt_img' };
    fs.writeFileSync(path.join(p.mock, 'messages.json'), JSON.stringify(m4));
    fs.appendFileSync(path.join(p.data, 'mapping.jsonl'), JSON.stringify({
      feishuMessageId: 'omt_img', sessionId: 'sess_img', sessionName: 'selftest',
      cwd: p.claude, createdAt: Date.now(), via: 'thread',
    }) + '\n');

    pushEvent(p, {
      __event: 'im.message.receive_v1',
      type: 'im.message.receive_v1',
      message_id: 'om_img_e2e',
      chat_type: 'group',
      content: '![Image](img_v3_e2e-999)\n这张图里有什么',
    });
    await sleep(1500);
    f2.server.close();

    // 管道上第一条是 auth 握手，真正的消息在它后面
    const msg = f2.got.find((g) => g && g.type !== 'auth') || {};
    const body = String((msg.message && msg.message.content) || '');
    check('窗口收到的正文带本地图片路径',
      /\[图片\] .*om_img_e2e_1\.png/.test(body),
      JSON.stringify(f2.got).slice(0, 400));
    check('图片标记没有残留到窗口',
      !body.includes('img_v3_e2e-999') && !body.includes('![Image]'), body.slice(0, 160));
    check('图片文件真的落盘了',
      (() => {
        const dir = path.join(p.data, 'images');
        try {
          return fs.readdirSync(dir).some((d) =>
            fs.existsSync(path.join(dir, d, 'om_img_e2e_1.png')));
        } catch (_) { return false; }
      })(), '');
  }

  console.log('\n9j. 可视化配置页');
  {
    // 配置页是 setup/ 下的独立进程，不是 plugins/ 下的插件——配置写坏时桥接根本
    // 起不来，而那一刻正是最需要它的时候。所以这里不起 bridge，单独 spawn 探针。
    //
    // 探针在子进程里跑：kernel/lib 在 require 时就把 CONFIG_FILE 算死了，
    // 本进程前面已经加载过它（指向沙箱前面用的那份），改环境变量追不回来。
    //
    // 顺带验证插件化：在沙箱插件目录里造一个从来没被代码提过的插件，
    // 它必须自动出现在 /api/state 里——页面里写死插件名单就会在这里变红。
    const uiPlugins = path.join(p.dir, 'ui-plugins');
    fs.mkdirSync(path.join(uiPlugins, 'probe-demo'), { recursive: true });
    fs.writeFileSync(path.join(uiPlugins, 'probe-demo', 'plugin.json'), JSON.stringify({
      id: 'probe-demo',
      name: '探针插件',
      version: '0.0.1',
      config: {
        answer: {
          type: 'integer', default: 42, minimum: 1, maximum: 99,
          title: '探针数值', 'ui:group': '探针', 'ui:widget': 'number',
        },
      },
      services: {},
    }, null, 2));
    for (const id of ['core', 'ask', 'notify', 'permission']) {
      // 真插件的 hook 文件不用复制——本用例只读 schema，不加载插件
      fs.cpSync(path.join(ROOT, 'plugins', id), path.join(uiPlugins, id), { recursive: true });
    }

    const uiCfg = path.join(p.dir, 'ui-config.json');
    const probe = spawnSync(process.execPath,
      [path.join(ROOT, 'setup', 'selftest', 'config-ui-probe.js')], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60000,
        env: {
          ...process.env,
          FEISHU_CONFIG: uiCfg,
          FEISHU_DATA_DIR: p.data,
          FEISHU_LOG_DIR: p.logs,
          FEISHU_PLUGINS_DIR: uiPlugins,
        },
      });

    let ui = [];
    try { ui = JSON.parse((probe.stdout || '').trim().split('\n').pop()); } catch (_) {}
    if (!ui.length) {
      check('配置页探针跑起来了', false,
        (probe.stderr || probe.stdout || '无输出').slice(-300));
    }
    for (const c of ui) check(`配置页 · ${c.name}`, c.ok, c.ok ? '' : c.detail);
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
