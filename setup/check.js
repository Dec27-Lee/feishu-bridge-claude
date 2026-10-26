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

// 有些工具（含 Windows 上的编辑器）会给 JSON 写 BOM。Node 的 JSON.parse 不认它，
// 不剥掉就会把一份完全正常的 settings.json 判成「解析失败」，
// 表现是 check 说「缺少本项目的 hook」、verify 说「读不到 settings.json」——
// 明明装得好好的。所有读 settings.json 的地方都要先剥。
function readJsonStripBom(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
}

const home = process.env.FEISHU_INSTALL_HOME || os.homedir();
const settingsFile = path.join(home, '.claude', 'settings.json');
let settings = null;
try {
  settings = readJsonStripBom(settingsFile);
} catch (_) {}

const hooksCfg = require('./hooks-config');
const hookOk = hooksCfg.installed(settings);
add('required', 'hooks', hookOk,
  'Claude Code hooks 已安装', hookOk ? '5 个事件已注册' : '缺少本项目的 hook',
  'node setup/install.js   （会先展示将写入的 diff 再让你确认）');

// 装是装了，但 node 的绝对路径可能已经失效（换了 Node 版本、用 nvm 切了版本）。
// 这类失败是静默的：hook 报 command not found，界面上一片安静。
{
  const nodePath = hooksCfg.NODE;
  const ok = fs.existsSync(nodePath);
  add('required', 'hooks-node', ok,
    'hooks 用的 node 还在', ok ? nodePath : `${nodePath} 不存在`,
    ok ? '' : '换过 Node 版本。重装一次让 hooks 改指到当前 node：node setup/install.js --hooks');
}

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
    // macOS / Linux 的采样器是随仓库分发的 shell 脚本，不需要编译。
    // 但脚本能不能真采到数是另一回事（Linux 要 xprintidle、Wayland 下拿不到），
    // 所以这里真跑一次 --once 看输出，而不是只看文件在不在。
    const sh = path.join(ROOT, 'platform', platform.name, 'presence.sh');
    if (!fs.existsSync(sh)) {
      add('optional', 'presence', false, '在场采样器', `缺少 ${sh}`, '重新拉取仓库');
    } else {
      const r = spawnSync('bash', [sh, '--once'], { encoding: 'utf8', timeout: 15000 });
      let ok = false;
      let detail = (r.stdout || r.stderr || '').trim().slice(0, 120);
      try {
        const j = JSON.parse(detail);
        ok = j.ok === true && Number(j.idleSeconds) >= 0;
        if (j.ok === true && Number(j.idleSeconds) < 0) {
          detail = platform.name === 'linux'
            ? '采不到空闲时长（需要 xprintidle；Wayland 下无统一接口）'
            : '采不到空闲时长';
        }
      } catch (_) {}
      add('optional', 'presence', ok, '在场采样器可用', ok ? detail : detail,
        ok ? '' : (platform.name === 'linux'
          ? '装 xprintidle（apt install x11-utils / dnf install xorg-x11-utils）。'
            + '没有它也能用，只是判定退到「一律推卡片」'
          : '没有它也能用，只是判定退到「一律推卡片」'));
    }
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

// ---- 7. 项目位置 ----

// 这个目录本身就是运行时：hooks 里写的是它的绝对路径，自启项指向它，
// 正在跑的进程也是从这里加载的。放在临时目录/下载目录里，迟早会被清掉或搬走。
{
  const bad = [
    [/[\\/](Temp|tmp|Downloads|下载|Desktop|桌面)[\\/]/i, '临时目录、下载目录或桌面'],
    [/[\\/]AppData[\\/]Local[\\/]Temp/i, 'Windows 临时目录'],
  ];
  const hit = bad.find(([re]) => re.test(ROOT));
  add('info', 'location', true, '项目位置', ROOT,
    hit ? `⚠️ 看起来在${hit[1]}。这个目录就是实际运行的程序，建议换到长期位置：node setup/move.js <新目录>` : '');
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
