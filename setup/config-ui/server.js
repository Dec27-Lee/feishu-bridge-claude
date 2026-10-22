'use strict';

// 可视化配置页的后端：读 schema、校验、算 diff、写 config.json。
//
// 为什么放在 setup/ 而不是做成 plugins/ 下的插件：
// **配置是桥接的启动前置条件。** 做成插件的话，配置写坏（JSON 语法错、chatId 空、
// 某个值越界）时那个插件根本加载不起来——而那一刻恰恰是最需要打开配置页的时候。
// 所以它是一个独立进程，只要 node 能跑就行，与 bridge 的死活无关。
//
// 插件化的要求换一条路径满足：**这里不认任何插件名、字段名、分组名**。
// 页面能渲染什么，全部来自 kernel/config.js 的 dumpSchema()（插件的 config 就是
// schema）。加一个插件、给插件加一个配置项，页面一行都不用改。
//
// 写盘规则（三条，都会改用户的文件）：
//   1. 值等于 schema 的 default → 删掉该键（与「只写要覆盖的项」的约定一致）
//   2. 页面不认识的键原样保留（被删插件的残留配置不能被它悄悄清掉）
//   3. 校验有错 → 不写（save 里再校验一遍，不信前端）

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const LIB = require('../../kernel/lib');
const CONFIG = require('../../kernel/config');
const PLUGIN = require('../../kernel/plugin');
const system = require('./system');
const RESTART = require('./restart');

const PAGE_FILE = path.join(__dirname, 'page.html');
const BODY_LIMIT = 1024 * 1024;   // 配置不可能有 1MB；超过就是被打错了地址

// 顶层的 `_说明` 这类字段是写给人看的备注，不渲染也不写回。
// 不排除的话，第一次保存会因为「值等于默认值」把它从用户的文件里删掉。
const isDisplayOnly = (k) => k.startsWith('_');

function loadSchema() {
  const byId = {};
  for (const m of PLUGIN.discover()) byId[m.id] = m;
  const schema = CONFIG.dumpSchema(byId);
  // 顶层的 `plugins` 只是个结构占位（按插件 id 分组），下面每个插件已经各自成卡片。
  // 留着它会渲染出一个巨大的 JSON 文本框，和下面的卡片改同一份数据——两处能改一件事，
  // 迟早对不上。所以在出口处摘掉，页面与提交都见不到它。
  delete schema.top.properties.plugins;
  return { byId, schema };
}

// 稳定比较：值可能是对象/数组（launchAliases、launchWorkspaces）
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
}

function readRaw() {
  const file = LIB.CONFIG_FILE;
  if (!fs.existsSync(file)) return { raw: {}, exists: false, parseError: null };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('顶层不是对象');
    return { raw, exists: true, parseError: null };
  } catch (e) {
    // 解析不了就**禁止保存**：拿空对象覆盖上去，等于把用户的群号一起清了
    return { raw: {}, exists: true, parseError: e.message };
  }
}

function buildState() {
  const { byId, schema } = loadSchema();
  const { raw, exists, parseError } = readRaw();
  const r = CONFIG.resolveAll(byId, raw);

  const defaultsTop = {};
  for (const [k, spec] of Object.entries(CONFIG.TOP_SCHEMA)) {
    if (isDisplayOnly(k) || k === 'plugins') continue;
    if (spec.default !== undefined) defaultsTop[k] = spec.default;
  }
  const top = {};
  for (const [k, v] of Object.entries(r.top)) {
    if (isDisplayOnly(k)) continue;
    top[k] = v;
  }
  const defaultsPlugins = {};
  for (const [id, m] of Object.entries(byId)) defaultsPlugins[id] = CONFIG.defaults(m.config || {});

  return {
    ok: true,
    configFile: LIB.CONFIG_FILE,
    exists,
    parseError,
    writable: !parseError,
    schema,
    defaults: { top: defaultsTop, plugins: defaultsPlugins },
    values: { top, plugins: r.plugins },
    errors: r.errors,
    warnings: r.warnings,
    // 只读的运行状态（自启 / 桥接进程 / 数据体积）。抽在 system.js 里，
    // 因为它要碰文件系统与平台层，和「配置读写」是两件事。
    system: system.systemState(),
  };
}

// 把页面提交的「生效值」写成一个新的 config.json 对象。
// 以原始文件为底，只动认识的键——这是「未知键保留」规则的实现处。
//
// 「等于默认值就删掉」只对**这次真被改动过**的项生效。曾经是无条件比对默认值，
// 结果是：打开页面、什么都不改、点保存，diff 里冒出十几条「删除」——
// 文件里原本显式写着的默认值全被清掉了。用户看到的第一反应是「它要删我配置」。
// 按「只清理自己动过的」来算，不动就零改动，把一个值改回默认值才真的去掉它。
function applyValues(values, raw, byId) {
  const next = JSON.parse(JSON.stringify(raw && typeof raw === 'object' ? raw : {}));

  for (const [k, spec] of Object.entries(CONFIG.TOP_SCHEMA)) {
    if (isDisplayOnly(k) || k === 'plugins') continue;
    const v = values.top ? values.top[k] : undefined;
    if (v === undefined) continue;
    if (same(next[k], v)) continue;                 // 没动过，原样留着
    if (same(v, spec.default)) delete next[k];
    else next[k] = v;
  }

  const plugins = next.plugins && typeof next.plugins === 'object' && !Array.isArray(next.plugins)
    ? next.plugins : {};

  for (const [id, m] of Object.entries(byId)) {
    const vals = (values.plugins || {})[id];
    if (!vals) continue;
    const cur = plugins[id] && typeof plugins[id] === 'object' ? { ...plugins[id] } : {};
    for (const [k, spec] of Object.entries(m.config || {})) {
      if (vals[k] === undefined) continue;
      if (same(cur[k], vals[k])) continue;          // 没动过
      if (same(vals[k], spec.default)) delete cur[k];
      else cur[k] = vals[k];
    }
    if (Object.keys(cur).length) plugins[id] = cur;
    else delete plugins[id];
  }

  // 一条覆盖都没有时不留一个空的 plugins 对象，文件更干净
  if (Object.keys(plugins).length) next.plugins = plugins;
  else delete next.plugins;

  return next;
}

// 摊平成 `a.b.c` → 值。空对象/空数组当叶子，否则「{} 被删掉」在 diff 里看不见。
function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    const isObj = v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length;
    if (isObj) flatten(v, p, out);
    else out.set(p, v);
  }
  return out;
}

function diffOf(raw, next) {
  const a = flatten(raw, '', new Map());
  const b = flatten(next, '', new Map());
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out = [];
  for (const k of [...keys].sort()) {
    const from = a.get(k);
    const to = b.get(k);
    if (same(from, to)) continue;
    out.push({ path: k, from: from === undefined ? null : from, to: to === undefined ? null : to });
  }
  return out;
}

// 一次完整的「校验 + 算 diff」。preview 与 save 走同一条路，
// 区别只在于 save 多一步写盘——两条路分叉就会出现「看到的和写进去的不一样」。
function plan(body) {
  const { byId } = loadSchema();
  const { raw, parseError } = readRaw();
  if (parseError) {
    return { ok: false, status: 409, errors: [`config.json 当前不是合法 JSON（${parseError}），先手工修好再改`] };
  }

  const values = {
    top: (body && body.top) || {},
    plugins: (body && body.plugins) || {},
  };
  const next = applyValues(values, raw, byId);

  // 校验用「加了默认值之后的完整配置」，与桥接启动时跑的是同一个 resolveAll
  const r = CONFIG.resolveAll(byId, next);
  return {
    ok: r.errors.length === 0,
    status: r.errors.length ? 400 : 200,
    errors: r.errors,
    warnings: r.warnings,
    diff: diffOf(raw, next),
    next,
    content: JSON.stringify(next, null, 2),
  };
}

// ---- HTTP ----

function tokenOk(given, expect) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expect));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > BODY_LIMIT) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(d);
    });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8');
      if (!s.trim()) return resolve({});
      try { resolve(JSON.parse(s)); } catch (e) { reject(new Error(`请求体不是合法 JSON：${e.message}`)); }
    });
    req.on('error', reject);
  });
}

// Host 必须是本机名：挡住 DNS rebinding（把 evil.com 解析到 127.0.0.1 再访问）。
// Origin 若存在必须是本页自己：挡住任意网页向我们发起的跨站写。
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function hostOk(req) {
  const h = String(req.headers.host || '');
  const name = h.replace(/:\d+$/, '').toLowerCase();
  return LOCAL_HOSTS.has(name);
}

function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true;                  // curl / 非浏览器客户端；令牌仍然要过
  try {
    const u = new URL(o);
    return LOCAL_HOSTS.has(u.hostname.toLowerCase()) && u.port === String(req.socket.localPort);
  } catch (_) {
    return false;
  }
}

function createServer({ token, onActivity }) {
  const touch = () => { if (typeof onActivity === 'function') onActivity(); };

  const server = http.createServer(async (req, res) => {
    touch();
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;

    if (!hostOk(req)) return json(res, 403, { ok: false, errors: ['只接受本机访问'] });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    // 页面本身不含任何数据，但要拿令牌才能调 /api
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      let html;
      try { html = fs.readFileSync(PAGE_FILE, 'utf8'); } catch (e) {
        return json(res, 500, { ok: false, errors: [`读不到页面文件：${e.message}`] });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // 浏览器每次都会来要图标。返回 204 而不是让它 404——日志里少一条噪音，
    // 也不需要为这个页面维护一个图片资源。
    if (req.method === 'GET' && p === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }

    if (!p.startsWith('/api/')) return json(res, 404, { ok: false, errors: ['没有这个路径'] });
    if (!tokenOk(req.headers['x-bridge-token'], token)) {
      return json(res, 401, { ok: false, errors: ['令牌无效：请用启动时打印的那个地址打开页面'] });
    }
    if (req.method !== 'GET' && !originOk(req)) {
      return json(res, 403, { ok: false, errors: ['跨站请求被拒绝'] });
    }

    try {
      if (p === '/api/state' && req.method === 'GET') {
        return json(res, 200, buildState());
      }

      if (p === '/api/preview' && req.method === 'POST') {
        const body = await readBody(req);
        const r = plan(body);
        return json(res, r.status || 200, {
          ok: r.ok, errors: r.errors, warnings: r.warnings,
          diff: r.diff, content: r.content,
        });
      }

      if (p === '/api/save' && req.method === 'POST') {
        const body = await readBody(req);
        const r = plan(body);
        // 校验有错就停：宁可不写，也不写出一个连桥接都起不来的 config.json
        if (!r.ok) return json(res, r.status || 400, { ok: false, errors: r.errors, warnings: r.warnings });
        if (!r.diff.length) return json(res, 200, { ok: true, changed: false, diff: [] });

        // 写前留一份，出问题能翻回来（沿用 trustWorkspace 的 *.bridge-bak 命名）
        let backup = null;
        try {
          if (fs.existsSync(LIB.CONFIG_FILE)) {
            backup = `${LIB.CONFIG_FILE}.bridge-bak`;
            fs.copyFileSync(LIB.CONFIG_FILE, backup);
          }
        } catch (_) {}

        LIB.writeConfig(r.next);
        LIB.log('bridge', `配置页写入 ${LIB.CONFIG_FILE}（${r.diff.length} 处改动）`);

        // 选了「保存并重启」就在这里接着重启。**放在写完之后、单独一步**：
        // 写盘成功但重启失败时，用户至少知道配置已经保存，不会以为改动丢了。
        let restartResult = null;
        if (body && body.restart) {
          restartResult = await RESTART.restartBridge();
          LIB.log('bridge', restartResult.ok
            ? `配置页重启桥接：pid ${restartResult.oldPid || '-'} → ${restartResult.pid}`
            : `配置页重启失败：${restartResult.errors.join('；')}`);
        }
        return json(res, 200, {
          ok: true, changed: true, diff: r.diff, backup, restart: restartResult,
        });
      }

      return json(res, 404, { ok: false, errors: ['没有这个接口'] });
    } catch (e) {
      return json(res, 500, { ok: false, errors: [e.message] });
    }
  });

  return server;
}

module.exports = { createServer, buildState, applyValues, diffOf, plan, same };
