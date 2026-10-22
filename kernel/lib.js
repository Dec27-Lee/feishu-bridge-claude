'use strict';

// 内核基础设施：路径、配置、日志、飞书 CLI、会话/映射/话题/工作区/统计。
// 本文件不认识「提问」或「权限」这类业务概念——那些在 plugins/ 里。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// 项目根 = kernel/ 的上一层。数据默认跟随项目目录，也可用环境变量挪走：
//   FEISHU_DATA_DIR / FEISHU_LOG_DIR / FEISHU_CONFIG
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = process.env.FEISHU_DATA_DIR || path.join(ROOT, 'data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const PENDING_DIR = path.join(DATA_DIR, 'pending');
const MAPPING_FILE = path.join(DATA_DIR, 'mapping.jsonl');
const LOG_DIR = process.env.FEISHU_LOG_DIR || path.join(ROOT, 'logs');
const CONFIG_FILE = process.env.FEISHU_CONFIG || path.join(ROOT, 'config.json');

function ensureDirs() {
  for (const d of [DATA_DIR, SESSIONS_DIR, PENDING_DIR, LOG_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

// 还没写 config.json 时返回空对象 + _missing 标记。
// 调用方据此判断「安装没完成」并按最保守的方式处理：
// hook 读不到插件配置就走 schema 默认值，桥接读不到顶层配置就直接退出并提示去装。
// 这里刻意不放任何业务默认值——默认值的唯一来源是 kernel/config.js 与各自的 plugin.json。
const SAFE_DEFAULTS = {};

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (!cfg || typeof cfg !== 'object') throw new Error('配置内容不是对象');
    return cfg;
  } catch (e) {
    if (e.code === 'ENOENT') return { ...SAFE_DEFAULTS, _missing: true, _configFile: CONFIG_FILE };
    throw new Error(`config.json 解析失败（${CONFIG_FILE}）：${e.message}`);
  }
}

function writeConfig(cfg) {
  ensureDirs();
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

// hook 进程读插件配置的唯一入口。
//
// 为什么要它：hook 是**独立进程**，拿不到插件的 ctx；而配置的真相在
// plugins/<id>/plugin.json 的 schema 里（默认值 + 校验），用户覆盖写在
// config.json 的 plugins.<id>。这个函数把两边合起来，行为与内核加载插件时完全一致。
//
// 拿不到 schema（插件目录被删、JSON 坏了）时返回空对象——hook 因此走
// 「所有开关都取默认分支」的保守路径，不会把工具调用卡住。
function readPluginConfig(id) {
  try {
    const cfg = readConfig();
    const manifest = path.join(ROOT, 'plugins', id, 'plugin.json');
    const schema = JSON.parse(fs.readFileSync(manifest, 'utf8')).config || {};
    const userVals = (cfg.plugins || {})[id] || {};
    // 延迟 require：本模块被 hook 引用时不希望连带拉进整个配置子系统
    const { validate } = require('./config');
    const r = validate(schema, userVals);
    if (r.errors.length) log('error', `插件 ${id} 配置有误，退回默认值：${r.errors.join('；')}`);
    return r.values;
  } catch (_) {
    return {};
  }
}

function log(tag, msg) {
  try {
    ensureDirs();
    const line = `[${new Date().toISOString()}] [${tag}] ${msg}\n`;
    fs.appendFileSync(path.join(LOG_DIR, `${tag}.log`), line);
  } catch (_) { /* 日志失败不影响主流程 */ }
}

// 同步调用 lark-cli，返回解析后的 JSON；失败返回 null
// opts: { timeoutMs, cwd }
function larkSync(args, opts = {}) {
  const cfg = readConfig();
  const bin = opts.bin || cfg.larkCli || 'lark-cli';
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 20000,
    windowsHide: true,
    shell: false,
    cwd: opts.cwd || ROOT,
  });
  if (r.error) { log('error', `lark-cli spawn 失败: ${r.error.message}`); return null; }
  const out = (r.stdout || '').trim();
  if (!out) { log('error', `lark-cli 无输出 (code=${r.status}): ${(r.stderr || '').slice(0, 300)}`); return null; }
  try {
    return JSON.parse(out);
  } catch (_) {
    log('error', `lark-cli 输出非 JSON: ${out.slice(0, 300)}`);
    return null;
  }
}

// ---- 会话注册表 ----

function sessionFile(sessionId) {
  return path.join(SESSIONS_DIR, `${sessionId}.json`);
}

function writeSession(sessionId, obj) {
  ensureDirs();
  const rec = { sessionId, updatedAt: Date.now(), ...obj };
  fs.writeFileSync(sessionFile(sessionId), JSON.stringify(rec, null, 2), 'utf8');
  return rec;
}

function readSession(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(sessionId), 'utf8'));
  } catch (_) {
    return null;
  }
}

function removeSession(sessionId) {
  try { fs.unlinkSync(sessionFile(sessionId)); } catch (_) {}
}

function listSessions() {
  ensureDirs();
  const out = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'))); } catch (_) {}
  }
  return out;
}

// ---- 映射表：飞书 message_id -> session_id ----

function appendMapping(rec) {
  ensureDirs();
  fs.appendFileSync(MAPPING_FILE, JSON.stringify(rec) + '\n', 'utf8');
}

function readMapping() {
  ensureDirs();
  const map = new Map();
  if (!fs.existsSync(MAPPING_FILE)) return map;
  for (const line of fs.readFileSync(MAPPING_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.feishuMessageId) map.set(r.feishuMessageId, r);
    } catch (_) {}
  }
  return map;
}

// ---- 清理 ----
// 图片按日期目录保留 N 天；映射表与会话注册按 TTL 回收；日志超限截尾。
function cleanup(cfg = readConfig()) {
  const now = Date.now();
  const report = { images: 0, sessions: 0, mappings: 0, logs: 0 };
  ensureDirs();

  // 1) 图片：删除过期日期目录
  const imgRoot = path.join(DATA_DIR, 'images');
  const imageTtlMs = (cfg.imageTtlDays || 7) * 86400000;
  if (fs.existsSync(imgRoot)) {
    for (const day of fs.readdirSync(imgRoot)) {
      const dir = path.join(imgRoot, day);
      try {
        const st = fs.statSync(dir);
        if (st.isDirectory() && now - st.mtimeMs > imageTtlMs) {
          fs.rmSync(dir, { recursive: true, force: true });
          report.images += 1;
        }
      } catch (_) {}
    }
  }

  // 2) 会话注册：超时未更新则删除（窗口早已关闭的残留）
  const sessionTtlMs = (cfg.sessionTtlHours || 48) * 3600000;
  for (const s of listSessions()) {
    if (now - (s.updatedAt || 0) > sessionTtlMs) {
      removeSession(s.sessionId);
      report.sessions += 1;
    }
  }

  // 3) 映射表：重写，仅保留有效期内的记录
  const mapTtlMs = (cfg.mappingTtlDays || 14) * 86400000;
  if (fs.existsSync(MAPPING_FILE)) {
    const keep = [];
    for (const line of fs.readFileSync(MAPPING_FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (now - (r.createdAt || 0) <= mapTtlMs) keep.push(line);
        else report.mappings += 1;
      } catch (_) {}
    }
    fs.writeFileSync(MAPPING_FILE, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
  }

  // 4) 日志：超过上限则只保留尾部
  const maxBytes = cfg.maxLogBytes || 5 * 1024 * 1024;
  for (const f of fs.readdirSync(LOG_DIR)) {
    const p = path.join(LOG_DIR, f);
    try {
      if (fs.statSync(p).size > maxBytes) {
        fs.writeFileSync(p, fs.readFileSync(p, 'utf8').slice(-Math.floor(maxBytes / 2)), 'utf8');
        report.logs += 1;
      }
    } catch (_) {}
  }

  // 5) 提问记录：hook 答完会自己删；这里清掉超时后残留的（含被取消的）
  const qdir = path.join(DATA_DIR, 'questions');
  if (fs.existsSync(qdir)) {
    for (const f of fs.readdirSync(qdir)) {
      const p = path.join(qdir, f);
      try {
        if (now - fs.statSync(p).mtimeMs > 2 * 3600000) fs.unlinkSync(p);
      } catch (_) {}
    }
  }

  return report;
}

// ---- 工作区发现：不再依赖手工维护的别名清单 ----
// 依据是 Claude Code 自己的记录：~/.claude.json 的 projects 键记录着所有用过的
// 工作目录，~/.claude/projects/<slug>/ 下的转录能反解出真实 cwd 与最近活动时间。
// 三个目录都允许环境变量覆盖，只为自测/多账号能把它们指到沙箱里
const CLAUDE_HOME = process.env.FEISHU_CLAUDE_HOME || path.join(os.homedir(), '.claude');
const CLAUDE_PROJECTS_DIR = process.env.FEISHU_CLAUDE_PROJECTS_DIR || path.join(CLAUDE_HOME, 'projects');
const CLAUDE_JSON = process.env.FEISHU_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');

// 只读文件尾部，避免为拿 cwd 把几十 MB 的转录整个读进来
function lastCwdFromTranscript(file) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - 400000);
    const len = size - start;
    if (len <= 0) return null;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    const hits = [...buf.toString('utf8').matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)];
    if (!hits.length) return null;
    return JSON.parse('"' + hits[hits.length - 1][1] + '"');
  } catch (_) {
    return null;
  }
}

function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

// 读出所有「已信任」路径（归一化）。同一个目录可能同时以 / 和 \ 两种写法登记，
// 归一化后天然合并。
function trustedPaths() {
  const set = new Set();
  try {
    const j = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    for (const [k, v] of Object.entries(j.projects || {})) {
      if (v && v.hasTrustDialogAccepted) set.add(normalizePath(k));
    }
  } catch (_) {}
  return set;
}

// 会话是否已有转录文件。`/resume` 在会话内切换时，进程会先以新 id 触发一次
// SessionStart，但那个 id 不会落转录——它是空壳，只有旧 id 才是真身。
function hasTranscript(sessionId) {
  try {
    for (const d of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      if (fs.existsSync(path.join(CLAUDE_PROJECTS_DIR, d, `${sessionId}.jsonl`))) return true;
    }
  } catch (_) {}
  return false;
}

// 同一个 pid + 同一个 socket 上的两个 sessionId 是同一个进程的别名。
// `--resume` 启动时会先用临时 id 注册一次，落定后再按旧 id 注册；
// 临时那条的 socket/token 随即作废。判定以会话表 `~/.claude/sessions/<pid>.json`
// 为准——它记的一定是当前真正在用的 id。只清理「进程还活着」的记录，
// 已退出的历史记录留给 mappingTtlDays 自然回收。
function dropStaleAlias(sessionId) {
  const cur = readSession(sessionId);
  if (!cur || !cur.pid) return false;
  let alive = false;
  try { process.kill(Number(cur.pid), 0); alive = true; } catch (_) {}
  if (!alive) return false;
  const real = authoritativeSessionId(cur.pid);
  if (!real || real === sessionId) return false;
  removeSession(sessionId);
  log('session', `清理过期别名 ${sessionId.slice(0, 8)}（pid=${cur.pid} 的实际会话是 ${real.slice(0, 8)}）`);
  return true;
}

// 全表扫一遍：同 pid 上只留会话表认可的那一条
function sweepAliases() {
  let n = 0;
  for (const s of listSessions()) {
    if (dropStaleAlias(s.sessionId)) n += 1;
  }
  return n;
}

// 把「空壳 id」解析成真正在跑的 id。
// `/resume` 在会话内切换时，进程会先以一个新 sessionId 触发 SessionStart，
// 随后才按恢复出来的旧 id 再注册一次；对话始终写在旧 id 的转录里。
// 新 id 于是一直留在注册表里，它的 socket/token 也很快就作废——
// 谁先把它写进 mapping，往那个话题发的消息就会永远投递失败，且毫无报错。
//
// 权威来源是 Claude Code 自己的会话表 `~/.claude/sessions/<pid>.json`：
// 同一个 pid 只有一条，里面的 sessionId 才是当前真正在用的那个。
const CLAUDE_SESSIONS_DIR = process.env.FEISHU_CLAUDE_SESSIONS_DIR || path.join(CLAUDE_HOME, 'sessions');

function authoritativeSessionId(pid) {
  if (!pid) return null;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, `${pid}.json`), 'utf8'));
    return reg && reg.sessionId ? reg.sessionId : null;
  } catch (_) {
    return null;
  }
}

function resolveSessionAlias(sessionId) {
  if (!sessionId) return sessionId;
  const cur = readSession(sessionId);
  if (!cur || !cur.pid) return sessionId;
  const real = authoritativeSessionId(cur.pid);
  if (real && real !== sessionId) {
    log('session', `空壳 ${sessionId.slice(0, 8)} → ${real.slice(0, 8)}（pid=${cur.pid}）`);
    return real;
  }
  return sessionId;
}

// 判断某目录在终端打开时**会不会弹信任确认框**。
// 实测（v2.1.305）这个框并非所有目录都弹：
//   · 纯文件夹（没有 .claude 配置、不是 git 仓库）→ 直接进，不弹
//   · 带 `.claude/settings.json`、是 git 仓库、含 MCP/hooks 的目录 → 弹「Accessing workspace」
// 已登记信任（hasTrustDialogAccepted）的目录不弹；但**信任不向上继承**，
// 信任盘根 `E:/` 不能覆盖 `E:/some/project`。
// home 目录的信任只在当前会话有效、不落盘，因此永远算需要确认。
function needsTrustPrompt(dir, trustedSet) {
  const cur = normalizePath(dir);
  if (!cur) return false;
  if (cur === normalizePath(os.homedir())) return true;

  // 命中 git 仓库就用仓库根那条记录，否则用目录自身
  let root = cur;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(root, '.git'))) break;
    const up = path.posix.dirname(root);
    if (up === root) { root = null; break; }
    root = up;
  }
  const key = root || cur;
  if (trustedSet.has(key)) return false;   // 已信任，不弹

  // 未信任：只有带「需要批准的配置」时才会弹
  if (root) return true;                                   // 是 git 仓库
  if (fs.existsSync(path.join(cur, '.claude', 'settings.json'))) return true;
  if (fs.existsSync(path.join(cur, '.claude', 'settings.local.json'))) return true;
  if (fs.existsSync(path.join(cur, '.mcp.json'))) return true;
  return false;                                            // 纯文件夹，直接进
}

// 兼容旧名
function isTrustedPath(dir, trustedSet) {
  return !needsTrustPrompt(dir, trustedSet);
}

// ---- 预置信任 ----
// 把目录写进 ~/.claude.json 的 projects["<key>"].hasTrustDialogAccepted = true，
// 让终端打开时直接进、不再弹「Accessing workspace」。
//
// 两个前提（都是踩过的坑）：
//   1. key 用**仓库根**（在 git 仓库里打开子目录时，Claude Code 只看仓库根那条记录）；
//      不在仓库内才用目录自身。
//   2. 写之前 Claude Code 可能正在跑，它退出时会整体重写这个文件、把我们的改动覆盖掉。
//      所以先备份、再写；写入后若被覆盖，下次桥接启动会再补一次。
function workspaceKey(cwd) {
  const cur = normalizePath(cwd);
  if (!cur) return null;
  let probe = cur;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(probe, '.git'))) return probe;
    const up = path.posix.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  return cur;
}

// 返回 { changed, key, error }
function trustWorkspace(cwd) {
  const key = workspaceKey(cwd);
  if (!key) return { changed: false, error: '路径无效' };

  let raw;
  try {
    raw = fs.readFileSync(CLAUDE_JSON, 'utf8');
  } catch (e) {
    return { changed: false, key, error: '读不到 ' + CLAUDE_JSON };
  }
  if (trustedPaths().has(key)) return { changed: false, key, already: true };

  let j;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return { changed: false, key, error: '.claude.json 解析失败: ' + e.message };
  }

  j.projects = j.projects || {};
  const cur = j.projects[key] || {};
  j.projects[key] = { ...cur, hasTrustDialogAccepted: true };

  try {
    // 备份一份，便于被覆盖后回溯
    try {
      fs.writeFileSync(CLAUDE_JSON + '.bridge-bak', raw, 'utf8');
    } catch (_) {}
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(j, null, 2), 'utf8');
  } catch (e) {
    return { changed: false, key, error: '写入失败: ' + e.message };
  }

  log('bridge', `已预置信任 ${key}`);
  return { changed: true, key };
}

// 返回 [{ cwd, name, lastActive, sessions, trusted }]，按最近使用倒序。
// trusted = 打开时不会弹信任确认框（见 needsTrustPrompt 的说明）。
// 会弹框的目录在卡片上单独标注，远程场景下用户看不到终端，不能静默混在里面。
function discoverWorkspaces(cfg = readConfig(), opts = {}) {
  const onlyTrusted = opts.onlyTrusted === true;
  const byPath = new Map();
  const trustSet = trustedPaths();

  const add = (cwd, lastActive) => {
    const p = normalizePath(cwd);
    if (!p) return;
    let st;
    try { st = fs.statSync(p); } catch (_) { return; }
    if (!st.isDirectory()) return;
    byPath.set(p, byPath.get(p) || { cwd: p, name: path.basename(p), lastActive: 0, sessions: 0 });
    const rec = byPath.get(p);
    if (lastActive > rec.lastActive) rec.lastActive = lastActive;
  };

  // 1) Claude Code 全局配置里登记过的项目（最全，含很久没打开的）
  try {
    const j = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    for (const k of Object.keys(j.projects || {})) add(k, 0);
  } catch (_) {}

  // 2) 转录目录：补真实 cwd 与最近活动时间
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const p = path.join(CLAUDE_PROJECTS_DIR, dir);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      const files = [];
      try {
        for (const f of fs.readdirSync(p)) {
          if (!f.endsWith('.jsonl')) continue;
          try { files.push({ f, t: fs.statSync(path.join(p, f)).mtimeMs }); } catch (_) {}
        }
      } catch (_) {}
      if (!files.length) continue;
      files.sort((a, b) => b.t - a.t);
      // slug 目录下混着子目录会话：分别取最近几条转录的 cwd。
      // 只有「已登记项目」或「带 .git 的仓库」才算候选，避免一次性子目录污染选项。
      const seen = new Set();
      for (const f of files.slice(0, 8)) {
        const cwd = lastCwdFromTranscript(path.join(p, f.f));
        if (!cwd || seen.has(cwd)) continue;
        seen.add(cwd);
        const key = normalizePath(cwd);
        if (!byPath.has(key) && !fs.existsSync(path.join(cwd, '.git'))) continue;
        add(cwd, f.t);
        const rec = byPath.get(key);
        if (rec) rec.sessions = Math.max(rec.sessions, files.length);
      }
    }
  } catch (_) {}

  // 3) 配置里显式声明的目录也并进来（即使 Claude Code 还没开过）
  for (const w of cfg.launchWorkspaces || []) add(w, 0);
  for (const w of Object.values(cfg.launchAliases || {})) add(w, 0);

  let list = [...byPath.values()];
  for (const w of list) w.trusted = isTrustedPath(w.cwd, trustSet);
  list.sort((a, b) => b.lastActive - a.lastActive);
  if (onlyTrusted) list = list.filter((w) => w.trusted);
  return list;
}

// 供直接 #路径 指定时判断（上溯到仓库根）
function isTrusted(cwd) {
  return isTrustedPath(cwd, trustedPaths());
}

// ---- 历史会话发现（用于 /resume 恢复） ----
// 每个会话的元数据全在转录里：aiTitle 是标题、cwd 是工作目录、
// 文件 mtime 是最近活动时间。只读尾部拿标题与 cwd，避免读几十 MB。
const RESUME_TTL_MS = 5 * 86400000;   // 只列近 5 天有活动的会话

function transcriptMeta(file) {
  try {
    const size = fs.statSync(file).size;
    if (size < 200) return null;

    // 标题与 cwd 通常出现在尾部；读最后 200KB 足够
    const start = Math.max(0, size - 200000);
    const len = size - start;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');

    const pick = (re) => {
      const m = [...text.matchAll(re)];
      if (!m.length) return null;
      try { return JSON.parse('"' + m[m.length - 1][1] + '"'); } catch (_) { return null; }
    };

    return {
      title: pick(/"aiTitle":"((?:[^"\\]|\\.)*)"/g),
      cwd: pick(/"cwd":"((?:[^"\\]|\\.)*)"/g),
      userTurns: (text.match(/"type":"user"/g) || []).length,
    };
  } catch (_) {
    return null;
  }
}

// 返回 [{ sessionId, title, cwd, lastActive, userTurns, running }]，按最近活动倒序。
// running 来自 `claude agents --json`：该会话当前是否还有进程在跑（含后台会话）。
// 只保留「有实际内容」的会话：至少 1 轮用户消息，或已拿到 AI 标题——
// 否则近 5 天里会混进一堆空会话，候选卡片全是「(无标题) 0轮」。
function discoverSessions(cfg = readConfig(), opts = {}) {
  const ttl = opts.ttlMs || RESUME_TTL_MS;
  const now = Date.now();
  const out = [];

  let dirs = [];
  try { dirs = fs.readdirSync(CLAUDE_PROJECTS_DIR); } catch (_) { return out; }

  for (const dir of dirs) {
    const p = path.join(CLAUDE_PROJECTS_DIR, dir);
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (!st.isDirectory()) continue;

    let files = [];
    try { files = fs.readdirSync(p); } catch (_) { continue; }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(p, f);
      let fs2;
      try { fs2 = fs.statSync(file); } catch (_) { continue; }
      if (now - fs2.mtimeMs > ttl) continue;

      const meta = transcriptMeta(file);
      if (!meta || !meta.cwd) continue;
      // 目录被删/移走的会话不列：选中了也开不起来，只会白点一次。
      // 这条以前没有，用户在一个临时目录的会话上点「换会话」，
      // 结果窗口起在别的地方，看起来像完全无关的会话。
      if (!fs.existsSync(meta.cwd)) continue;
      // 空会话（没标题、也没用户消息）不列，否则候选卡片全是「(无标题) 0轮」
      if (!meta.title && meta.userTurns < 1) continue;

      out.push({
        sessionId: f.replace(/\.jsonl$/, ''),
        title: meta.title || null,
        cwd: meta.cwd,
        lastActive: fs2.mtimeMs,
        userTurns: meta.userTurns,
        running: false,
      });
    }
  }

  // 标出还在跑的：交互会话与后台会话都算
  try {
    const r = spawnSync('claude', ['agents', '--all', '--json'], {
      encoding: 'utf8', timeout: 15000, shell: true, windowsHide: true,
    });
    if (r.stdout) {
      const arr = JSON.parse(r.stdout.replace(/^﻿/, ''));
      const live = new Set((arr || []).map((a) => a.sessionId).filter(Boolean));
      for (const s of out) if (live.has(s.sessionId)) s.running = true;
    }
  } catch (_) {}

  out.sort((a, b) => b.lastActive - a.lastActive);
  return out;
}

// ---- 待选择工作区的任务（用户发了新话题，等他在卡片上点一个目录） ----

function pendingFile(threadId) {
  return path.join(PENDING_DIR, `${threadId}.json`);
}

function writePending(threadId, obj) {
  ensureDirs();
  fs.writeFileSync(pendingFile(threadId), JSON.stringify({ threadId, at: Date.now(), ...obj }), 'utf8');
}

function readPending(threadId, maxAgeMs = 30 * 60000) {
  try {
    const r = JSON.parse(fs.readFileSync(pendingFile(threadId), 'utf8'));
    if (Date.now() - (r.at || 0) > maxAgeMs) return null;
    return r;
  } catch (_) {
    return null;
  }
}

function removePending(threadId) {
  try { fs.unlinkSync(pendingFile(threadId)); } catch (_) {}
}

// ---- 每轮结束时的会话统计（模型 / 上下文用量 / 累计 tokens） ----
// 转录里每条 assistant 消息都带 message.usage：
//   · 最近一条的 input + cache_read + cache_creation = 这一轮结束时的上下文占用
//   · 整份转录里所有 usage 相加 = 本会话累计消耗
// 累计值必须读全文件（尾部 300KB 只能覆盖最近几十轮），所以按 mtime+size 缓存，
// 只有文件变了才重算，避免每轮都扫 20MB。
const STATS_CACHE = path.join(DATA_DIR, 'stats-cache.json');

function readStatsCache() {
  try { return JSON.parse(fs.readFileSync(STATS_CACHE, 'utf8')); } catch (_) { return {}; }
}

function writeStatsCache(obj) {
  try { ensureDirs(); fs.writeFileSync(STATS_CACHE, JSON.stringify(obj), 'utf8'); } catch (_) {}
}

// 全量扫描：返回 { total: 累计 tokens, model, effort, lastUsage }
function scanTranscript(file) {
  let model = null;
  let effort = null;
  let lastUsage = null;
  let total = 0;
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // effort 出现在消息级字段上，和 usage 不一定同一行，单独捞
    if (!effort) {
      const m = line.match(/"effort":"([a-zA-Z]+)"/);
      if (m) effort = m[1];
    }
    if (!line.includes('"usage"')) continue;
    let d;
    try { d = JSON.parse(line); } catch (_) { continue; }
    const u = d && d.message && d.message.usage;
    if (!u) continue;
    total += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    lastUsage = u;
    if (d.message.model) model = d.message.model;
  }
  return lastUsage ? { total, model, effort, lastUsage } : null;
}

// 带缓存的全量统计：文件 mtime+size 未变则复用上次结果
function transcriptTotals(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  const cache = readStatsCache();
  const hit = cache[file];
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;

  const data = scanTranscript(file);
  if (!data) return null;
  cache[file] = { mtimeMs: st.mtimeMs, size: st.size, data };
  // 顺手清掉已经不存在的文件，别让缓存无限长
  for (const k of Object.keys(cache)) {
    try { if (!fs.existsSync(k)) delete cache[k]; } catch (_) { delete cache[k]; }
  }
  writeStatsCache(cache);
  return data;
}

// 千位以上取整（222k 比 222.2k 紧凑）；largeDigits 控制 M/B 是否带小数
function formatTokens(n, largeDigits = 1) {
  if (n >= 1e9) return (n / 1e9).toFixed(largeDigits) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(largeDigits) + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

// 上下文窗口大小：Claude Code 只把它喂给 statusLine 的 stdin，Stop hook 拿不到。
// 优先用 config 里的显式值；没配就尝试复用 HUD 插件按转录路径哈希落盘的缓存。
function contextWindowSize(transcriptPath, cfg) {
  if (cfg && cfg.contextWindowSize) return cfg.contextWindowSize;
  try {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(path.resolve(transcriptPath)).digest('hex');
    const cache = path.join(os.homedir(), '.claude', 'plugins', 'claude-hud-plus',
      'context-cache', `${hash}.json`);
    const j = JSON.parse(fs.readFileSync(cache, 'utf8'));
    if (j && j.context_window_size) return j.context_window_size;
  } catch (_) {}
  return null;
}

// 卡片头部那一行上下文信息：`███░░░ 47% 234k · Tokens 401.0M`
// 只放进度条、百分比、当前上下文占用、累计消耗——别的都靠 📁/🕐 两行表达。
// 取不到数据时返回空串。
function statsLine(transcriptPath, cfg = readConfig()) {
  const t = transcriptPath ? transcriptTotals(transcriptPath) : null;
  if (!t || !t.lastUsage) return '';

  const u = t.lastUsage;
  const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0)
    + (u.cache_creation_input_tokens || 0);
  const win = contextWindowSize(transcriptPath, cfg);

  const parts = [];
  if (win) {
    const pct = Math.max(0, Math.min(100, Math.round((used / win) * 100)));
    // 4 格：整行（图标+进度条+百分比+上下文+累计）在手机窄屏要能一行放下
    const cells = 4;
    const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
    parts.push(`${'█'.repeat(filled)}${'░'.repeat(cells - filled)} ${pct}%`);
  }
  parts.push(formatTokens(used));
  if (t.total) parts.push(`· Tokens ${formatTokens(t.total, 1)}`);

  return parts.join(' ');
}

// ---- 每个窗口的常驻话题（同一窗口的后续通知都接进同一话题） ----

function threadFile(sessionId) {
  return path.join(DATA_DIR, 'threads', `${sessionId}.json`);
}

function readThreadRoot(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(threadFile(sessionId), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeThreadRoot(sessionId, rootMessageId, threadId, extra) {
  const dir = path.join(DATA_DIR, 'threads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(threadFile(sessionId),
    JSON.stringify({ sessionId, rootMessageId, threadId, at: Date.now(), ...(extra || {}) }), 'utf8');
}

// 把话题根消息置顶。群一多，新窗口的话题很容易被刷到看不见的地方；
// 置顶后能在会话列表的「置顶」里直接找到。机器人置顶实测可行（operator 记为 app_id）。
// 置顶是「改善」不是「必须」：失败的常见原因是群设置里限制成员置顶，不影响收发。
function pinThreadRoot(rootMessageId) {
  if (!rootMessageId) return { ok: false, error: '没有根消息' };
  try {
    const r = larkSync(['im', 'pins', 'create', '--as', 'bot',
      '--data', JSON.stringify({ message_id: rootMessageId })]);
    if (r && r.ok) {
      log('bridge', `已置顶话题 ${rootMessageId}`);
      return { ok: true };
    }
    const msg = r && r.error ? `${r.error.code || ''} ${r.error.message || ''}`.trim() : '未知原因';
    log('bridge', `置顶失败 ${rootMessageId}: ${msg}`);
    return { ok: false, error: msg };
  } catch (e) {
    log('error', `置顶异常: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  cleanup,
  readThreadRoot, writeThreadRoot, pinThreadRoot,
  discoverWorkspaces, normalizePath, isTrusted, discoverSessions,
  workspaceKey, trustWorkspace,
  tailStats: transcriptTotals, transcriptTotals, contextWindowSize, statsLine, formatTokens,
  writePending, readPending, removePending,
  ROOT, DATA_DIR, SESSIONS_DIR, PENDING_DIR, MAPPING_FILE, LOG_DIR, CONFIG_FILE,
  ensureDirs, readConfig, log, larkSync,
  writeConfig, readPluginConfig,
  writeSession, readSession, removeSession, listSessions,
  hasTranscript, dropStaleAlias, sweepAliases, resolveSessionAlias,
  appendMapping, readMapping,
};
