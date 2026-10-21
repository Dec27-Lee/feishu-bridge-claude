'use strict';

// 环境体检。给 AI 和人看同一份输出：JSON 给人读不方便，所以两种模式都给。
//
//   node setup/check.js            人看的清单（✓ / ✗ / !）
//   node setup/check.js --json     机器读的 JSON，AI 用它决定下一步
//
// 退出码：0 = 全通过或只有可选项缺失；1 = 有阻断项（装不了）。
//
// **本脚本只读不写**。凡是要改系统配置的事，一律交给 install.js 并让用户确认。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARGS = new Set(process.argv.slice(2));
const JSON_MODE = ARGS.has('--json');

const checks = [];

// level: 'required' 缺了装不了 / 'optional' 缺了功能降级 / 'info' 只是记录
function add(level, id, ok, title, detail, fix) {
  checks.push({ level, id, ok, title, detail: detail || '', fix: fix || '' });
}

function has(cmd, args) {
  try {
    const r = spawnSync(cmd, args || ['--version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
    return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim() };
  } catch (e) {
    return { ok: false, out: e.message };
  }
}

// ---- 1. 运行时 ----

const node = has('node');
const nodeMajor = (node.out.match(/v(\d+)/) || [])[1];
add('required', 'node', node.ok && Number(nodeMajor) >= 18,
  'Node.js ≥ 18', node.ok ? node.out.split('\n')[0] : '未找到 node',
  '安装 Node.js LTS：https://nodejs.org/  或 winget install OpenJS.NodeJS.LTS');

// ---- 2. lark-cli ----

// 配置里可能写了绝对路径，写了就以它为准；否则看 PATH 里有没有
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch (_) {}

const larkBin = cfg.larkCli || 'lark-cli';
const lark = has(larkBin, ['--version']);
add('required', 'lark-cli', lark.ok,
  'lark-cli 可用', lark.ok ? lark.out.split('\n')[0] : `找不到 ${larkBin}`,
  'npm i -g @larksuite/cli   然后 lark-cli auth login（用机器人所在应用的凭据）');

if (lark.ok) {
  // 只要机器人身份 ready 就够用——桥接全程 --as bot，不依赖用户个人身份
  const st = has(larkBin, ['auth', 'status']);
  let botReady = false;
  let appId = '';
  try {
    const j = JSON.parse(st.out);
    appId = j.appId || '';
    botReady = !!(j.identities && j.identities.bot && j.identities.bot.available);
  } catch (_) {}
  add('required', 'lark-auth', botReady,
    'lark-cli 机器人身份就绪',
    botReady ? `appId=${appId}` : '未登录，或机器人身份不可用',
    `${larkBin} auth login`);
}

// ---- 3. 配置文件 ----

const cfgFile = path.join(ROOT, 'config.json');
const hasCfg = fs.existsSync(cfgFile);
add('required', 'config', hasCfg && !!cfg.chatId,
  'config.json 已填写', hasCfg ? (cfg.chatId ? `chatId=${cfg.chatId}` : 'chatId 为空') : '文件不存在',
  '复制 config.example.json 为 config.json，填入机器人所在的群 chatId');

// ---- 4. Claude Code 与 hooks ----

const home = process.env.FEISHU_INSTALL_HOME || os.homedir();
const settingsFile = path.join(home, '.claude', 'settings.json');
let settings = null;
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch (_) {}

const hooksCfg = require('./hooks-config');
const hookOk = hooksCfg.installed(settings);
add('required', 'hooks', hookOk,
  'Claude Code hooks 已安装', hookOk ? '5 个事件已注册' : '缺少本项目的 hook',
  'node setup/install.js   （会先展示将写入的 diff 再让你确认）');

// cc-switch：切换服务商会用库里的 settings_config 整体覆盖 settings.json，
// 所以每个服务商的配置里都必须带同一份 hooks，否则一切换就失效。
const ccSwitchDir = path.join(home, '.cc-switch');
const ccDb = path.join(ccSwitchDir, 'cc-switch.db');
if (fs.existsSync(ccDb)) {
  let total = 0;
  let covered = 0;
  let canRead = false;
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(ccDb, { readOnly: true });
    const rows = db.prepare("SELECT settings_config FROM providers WHERE app_type='claude'").all();
    total = rows.length;
    for (const r of rows) {
      let sc = {};
      try { sc = JSON.parse(r.settings_config) || {}; } catch (_) {}
      if (hooksCfg.installed(sc)) covered++;
    }
    db.close();
    canRead = true;
  } catch (_) {}

  if (canRead) {
    add('optional', 'cc-switch', covered === total,
      'cc-switch 各服务商都带 hooks',
      `已覆盖 ${covered} / ${total} 个 claude 服务商`,
      'node setup/install.js --cc-switch   （逐个补，会先列出要改哪些）');
  } else {
    add('info', 'cc-switch', true, '检测到 cc-switch', `数据库 ${ccDb}（读不了，跳过）`, '');
  }
} else {
  add('info', 'cc-switch', true, '未使用 cc-switch', '', '');
}

// ---- 5. 平台能力 ----

let platform = null;
try { platform = require('../platform'); } catch (_) {}
if (platform) {
  add('info', 'platform', true, `平台：${platform.name}`, '', '');

  if (platform.name === 'win32') {
    const exe = path.join(ROOT, 'platform', 'win32', 'presence.exe');
    add('optional', 'presence', fs.existsSync(exe),
      '在场采样器已编译', fs.existsSync(exe) ? exe : '未编译',
      'node setup/install.js --build   （需要 .NET Framework 的 csc，Windows 自带）');
  } else {
    add('optional', 'presence', false,
      '在场探测', `${platform.name} 暂未实现，会一律推卡片`, '见 docs/ARCHITECTURE.md 第六节');
  }

  const auto = platform.autostart || {};
  add('optional', 'autostart', auto.kind !== 'none',
    '开机自启', auto.kind === 'none' ? '本平台无自启方案' : `方式：${auto.kind}`,
    auto.kind === 'none' ? '可手动 node kernel/index.js' : 'node setup/install.js --autostart');
}

// ---- 6. Claude Code 的跨会话接收设置 ----

if (settings) {
  const accept = settings.crossSessionInbound === 'accept';
  add('required', 'inbound', accept,
    'crossSessionInbound = "accept"',
    accept ? '已开启' : `当前：${settings.crossSessionInbound || '未设置'}`,
    '没有它，窗口会拒收来自桥接的投递（且毫无报错）。install.js 会替你加上。');
}

// ---- 输出 ----

const blocking = checks.filter((c) => c.level === 'required' && !c.ok);
const warn = checks.filter((c) => c.level === 'optional' && !c.ok);

if (JSON_MODE) {
  console.log(JSON.stringify({
    ok: blocking.length === 0,
    blocking: blocking.map((c) => c.id),
    warnings: warn.map((c) => c.id),
    checks,
  }, null, 2));
} else {
  const mark = (c) => (c.ok ? '✓' : (c.level === 'required' ? '✗' : '!'));
  for (const c of checks) {
    console.log(`${mark(c)} ${c.title.padEnd(30)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`  → ${c.fix}`);
  }
  console.log('');
  if (blocking.length) {
    console.log(`有 ${blocking.length} 项阻断问题需要先解决。`);
  } else if (warn.length) {
    console.log(`可以用，但有 ${warn.length} 项功能降级（见上方 ! 开头的行）。`);
  } else {
    console.log('全部就绪。启动：node kernel/index.js');
  }
}

process.exit(blocking.length ? 1 : 0);
