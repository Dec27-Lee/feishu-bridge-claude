'use strict';

// 真机联调。装完之后跑一遍，确认「本机 + 飞书」这条链路真的通。
//
//   node setup/verify.js              逐项检查，不改任何配置
//   node setup/verify.js --send       额外往你的飞书群发一条测试消息（需要真实配置）
//   node setup/verify.js --json       机器可读结果（给 AI 用）
//
// 与 setup/check.js 的区别：
//   check  = 静态体检，看「该装的东西装了没」，不联网
//   verify = 动态联调，真的去调飞书 API，看「装了的东西真的能用吗」
//
// 全部只读，唯一的写操作是 --send 时往群里发一条明确标注的测试消息。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARGS = new Set(process.argv.slice(2));
const JSON_MODE = ARGS.has('--json');
const DO_SEND = ARGS.has('--send');

const results = [];
function add(id, ok, title, detail, fix) {
  results.push({ id, ok, title, detail: detail || '', fix: fix || '' });
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
    shell: process.platform === 'win32',
    ...opts,
  });
  return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim(), status: r.status };
}

const lib = require('../kernel/lib');
const config = require('../kernel/config');
const plugin = require('../kernel/plugin');

// ---- 1. 配置是否可解析 ----

let cfg = null;
let byId = {};
try {
  byId = Object.fromEntries(plugin.discover().map((m) => [m.id, m]));
  cfg = lib.readConfig();
  if (cfg._missing) {
    add('config', false, '配置可读取', '没有 config.json', 'node setup/install.js');
    cfg = null;
  } else {
    const r = config.resolveAll(byId, cfg);
    add('config', r.errors.length === 0,
      '配置通过 schema 校验',
      r.errors.length ? r.errors[0] : `${Object.keys(byId).length} 个插件，${r.warnings.length} 条提示`,
      r.errors.length ? `修掉这些再跑：${r.errors.join('；')}` : '');
    if (r.errors.length) cfg = null;
  }
} catch (e) {
  add('config', false, '配置可读取', e.message, '检查 config.json 是否是合法 JSON');
}

// ---- 2. lark-cli 与机器人身份 ----

if (cfg) {
  const bin = cfg.larkCli || 'lark-cli';
  const st = run(bin, ['auth', 'status']);
  let botReady = false;
  let appId = '';
  try {
    const j = JSON.parse(st.out);
    appId = j.appId || '';
    botReady = !!(j.identities && j.identities.bot && j.identities.bot.available);
  } catch (_) {}
  add('bot', botReady, '机器人身份可用', botReady ? `appId=${appId}` : st.out.slice(0, 200),
    botReady ? '' : `${bin} auth login`);

  // ---- 3. 群可达 ----

  if (botReady && cfg.chatId) {
    // 没有「按 chat_id 查单个群」的接口，只能列出机器人所在的所有群再找。
    // 好处是顺带能发现「chatId 填错了但机器人其实在别的群里」这种常见错误。
    const r = run(bin, ['im', '+chat-list', '--as', 'bot', '--types', 'group']);
    let ok = false;
    let name = '';
    let others = 0;
    let why = r.out.slice(0, 200);
    try {
      const j = JSON.parse(r.out);
      const chats = (j.data && j.data.chats) || [];
      others = chats.length;
      const hit = chats.find((c) => c.chat_id === cfg.chatId);
      ok = !!hit;
      name = (hit && hit.name) || '';
      if (!hit && chats.length) {
        why = `机器人在这 ${chats.length} 个群里，但没有 ${cfg.chatId}：`
          + chats.slice(0, 3).map((c) => `${c.name}(${c.chat_id})`).join('、');
      }
    } catch (_) {}
    add('chat', ok, '目标群可达', ok ? `${name || cfg.chatId}` : why,
      ok ? '' : '确认 chatId 正确、机器人已被拉进这个群');
  } else if (cfg && !cfg.chatId) {
    add('chat', false, '目标群可达', 'chatId 为空', '在 config.json 里填 chatId');
  }

  // ---- 4. 事件总线 ----

  const ev = run(bin, ['event', 'status']);
  add('event-bus', ev.ok, '事件总线可用',
    ev.ok ? '已连接（能收到飞书事件）' : ev.out.slice(0, 200),
    ev.ok ? '' : `事件订阅没配好。先 ${bin} event stop 再重启 bridge；后台确认订阅了 im.message.receive_v1 与 card.action.trigger`);

  // ---- 5. bridge 进程 ----

  const pidFile = path.join(lib.DATA_DIR, 'bridge.pid');
  let pid = 0;
  try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch (_) {}
  const platform = require('../platform');
  const alive = pid && platform.pidAlive(pid);
  add('bridge', alive, '桥接进程在跑', alive ? `pid=${pid}` : (pid ? `pid=${pid} 已失效` : '没有 pid 文件'),
    alive ? '' : '启动：node kernel/index.js（或装自启 node setup/install.js --autostart）');

  // ---- 6. 在场采样 ----

  if (platform.supportsPresence) {
    const p = require('../kernel/presence').readPresence();
    add('presence', !!p, '在场采样可用',
      p ? `空闲 ${p.idleSeconds}s，锁屏=${p.locked}` : '读不到采样（采样器没起来或未编译）',
      p ? '' : (process.platform === 'win32'
        ? 'node setup/install.js --build；或忽略（功能会退化为「一律推卡片」）'
        : '先启动 bridge 让它拉起采样器；或忽略（功能会退化为「一律推卡片」）'));
  } else {
    add('presence', true, '在场采样可用（本平台未实现）',
      `${platform.name} 上会一律推卡片，功能不缺失`, '');
  }

  // ---- 7. hooks 指向的脚本是否存在 ----

  const hooksCfg = require('./hooks-config');
  const home = process.env.FEISHU_INSTALL_HOME || os.homedir();
  let settings = null;
  // 有些工具会给 JSON 写 BOM，JSON.parse 不认——不剥掉会把一份正常的
  // settings.json 判成「读不到」（check.js 里也有同一个处理）。
  try {
    const raw = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    settings = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (_) {}
  if (!settings) {
    add('hooks', false, 'hooks 已安装', '读不到 ~/.claude/settings.json', 'node setup/install.js --hooks');
  } else if (!hooksCfg.installed(settings)) {
    add('hooks', false, 'hooks 已安装', '缺少本项目的 hook', 'node setup/install.js --hooks');
  } else {
    const missing = [];
    for (const entries of Object.values(settings.hooks || {})) {
      for (const e of entries) {
        for (const h of (e.hooks || [])) {
          // 用 hooks-config 的解析器：command 里 node 的绝对路径本身含 "node"，
          // 拿 /node\s+(\.js)/ 去匹配会漏掉这些条目，校验就静默通过了。
          const script = hooksCfg.scriptPathFromCommand(h && h.command);
          if (script && !fs.existsSync(script)) missing.push(script);
        }
      }
    }
    add('hooks', missing.length === 0, 'hooks 已安装且路径有效',
      missing.length ? `${missing.length} 个脚本不存在` : '5 个事件已注册',
      missing.length ? `项目可能被移动过，重装：node setup/install.js --hooks` : '');
  }
}

// ---- 7b. shell 脚本行尾（macOS / Linux 上 CRLF 会让脚本直接跑不起来） ----

if (process.platform !== 'win32') {
  const shDir = path.join(ROOT, 'platform', process.platform);
  if (fs.existsSync(shDir)) {
    const CR = String.fromCharCode(13);
    const bad = fs.readdirSync(shDir).filter((f) => f.endsWith('.sh')).filter((f) => {
      try { return fs.readFileSync(path.join(shDir, f), 'utf8').includes(CR); } catch (_) { return false; }
    });
    add('eol', bad.length === 0, 'shell 脚本行尾是 LF',
      bad.length ? `${bad.length} 个文件是 CRLF` : 'OK',
      bad.length ? `先 git config core.autocrlf false 再重新 checkout；已存在的用 sed -i 去掉回车：${bad.join(' ')}` : '');
  }
}

// ---- 8. 真发一条测试消息（可选） ----

if (cfg && DO_SEND) {
  const bin = cfg.larkCli || 'lark-cli';
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  const r = run(bin, ['im', '+messages-send', '--as', 'bot',
    '--chat-id', cfg.chatId, '--msg-type', 'text',
    '--content', JSON.stringify({ text: `【联调测试 ${stamp}】收到这条说明桥接可以往这个群发消息。` })]);
  let ok = false;
  let mid = '';
  try {
    const j = JSON.parse(r.out);
    ok = !!(j.ok && j.data && j.data.message_id);
    mid = (j.data && j.data.message_id) || '';
  } catch (_) {}
  add('send', ok, '往群里发消息', ok ? mid : r.out.slice(0, 200),
    ok ? '去飞书确认能收到；收不到说明 chatId 或机器人权限有问题' : '');
} else if (cfg) {
  add('send', true, '往群里发消息（未执行）', '加 --send 才会真发', '');
}

// ---- 输出 ----

if (JSON_MODE) {
  console.log(JSON.stringify({
    ok: results.every((r) => r.ok),
    failed: results.filter((r) => !r.ok).map((r) => r.id),
    results,
  }, null, 2));
} else {
  for (const r of results) {
    console.log(`${r.ok ? '✓' : '✗'} ${r.title.padEnd(24)} ${r.detail}`);
    if (!r.ok && r.fix) console.log(`  → ${r.fix}`);
  }
  const bad = results.filter((r) => !r.ok);
  console.log('');
  console.log(bad.length ? `${bad.length} 项未通过，见上方 → 提示。` : '全部通过，联调完成。');
}

process.exit(results.every((r) => r.ok) ? 0 : 1);
