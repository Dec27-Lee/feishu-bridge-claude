'use strict';

// 插件加载器。
//
// 一个插件 = plugins/<id>/ 目录 + 一份 plugin.json。加载器只做四件事：
//   1. 扫目录、读清单、校验必填字段
//   2. 把默认配置与 config.json 里 plugins.<id> 合并成该插件的运行时配置
//   3. 收集插件声明的 hook 与服务
//   4. 单个插件加载失败只记日志并跳过，绝不拖垮整体
//
// 清单字段见 docs/ARCHITECTURE.md 第 5.2 节。

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const config = require('./config');

const PLUGINS_DIR = process.env.FEISHU_PLUGINS_DIR || path.join(lib.ROOT, 'plugins');

// 极简事件总线：插件之间只通过具名事件通信，不互相 require。
// 这样卸掉一个插件，其他插件的代码一行都不用改。
function createBus() {
  const handlers = new Map();
  return {
    on(event, fn, owner) {
      if (typeof fn !== 'function') throw new Error(`bus.on(${event}) 需要函数`);
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push({ fn, owner: owner || 'unknown' });
      return () => {
        const list = handlers.get(event) || [];
        const i = list.findIndex((h) => h.fn === fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    // 同步派发，按注册顺序。单个订阅者抛错只记日志，不影响其他订阅者。
    emit(event, payload) {
      const list = handlers.get(event) || [];
      for (const h of list.slice()) {
        try {
          h.fn(payload);
        } catch (e) {
          lib.log('error', `插件 ${h.owner} 处理事件 ${event} 失败: ${e.message}`);
        }
      }
      return list.length;
    },
    listeners(event) {
      return (handlers.get(event) || []).map((h) => h.owner);
    },
    // 没有订阅者时返回 0 —— 插件卸载后其他插件必须仍能安静地工作
    count(event) {
      return (handlers.get(event) || []).length;
    },
  };
}

function readManifest(dir) {
  const file = path.join(dir, 'plugin.json');
  if (!fs.existsSync(file)) return null;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`plugin.json 不是合法 JSON：${e.message}`);
  }

  const id = raw.id || path.basename(dir);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`id "${id}" 不合法，只允许小写字母、数字和短横线`);
  }
  return {
    id,
    name: raw.name || id,
    version: raw.version || '0.0.0',
    description: raw.description || '',
    core: raw.core === true,
    depends: Array.isArray(raw.depends) ? raw.depends : [],
    config: raw.config || {},
    hooks: raw.hooks || {},
    services: raw.services || {},
    dir,
  };
}

// 扫出全部插件清单。core 优先，其余按 id 排序——保证每次启动顺序一致。
function discover() {
  let entries;
  try {
    entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  const found = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const m = readManifest(path.join(PLUGINS_DIR, e.name));
      if (m) found.push(m);
    } catch (err) {
      lib.log('error', `跳过插件目录 ${e.name}：${err.message}`);
    }
  }
  found.sort((a, b) => (Number(b.core) - Number(a.core)) || a.id.localeCompare(b.id));
  return found;
}

// 载入插件，为每个插件构造独立的 ctx。
// shared 是所有插件共用的基础设施（bus / lib / platform / global / dataDir）。
//
// 配置的解析走 kernel/config.js：plugin.json 里的 config 是 **schema**（带默认值与
// 校验规则），用户在 config.json 的 plugins.<id> 里只写要覆盖的项。
// 校验失败时：记日志 + 退回默认值继续跑，绝不因为一处笔误让整个桥接起不来。
function loadAll(shared) {
  const manifests = discover();
  const byId = new Map(manifests.map((m) => [m.id, m]));
  const loaded = [];

  for (const m of manifests) {
    // 依赖是否都在。核心插件缺失是致命问题，其他插件缺依赖就跳过它自己。
    const missing = m.depends.filter((d) => !byId.has(d));
    if (missing.length) {
      lib.log('error', `插件 ${m.id} 缺少依赖 [${missing.join(', ')}]，已跳过`);
      continue;
    }

    const userVals = (shared.global.plugins || {})[m.id] || {};
    const r = config.validate(m.config || {}, userVals);
    if (r.errors.length) {
      lib.log('error', `插件 ${m.id} 配置有误，退回默认值：${r.errors.join('；')}`);
    }
    if (r.warnings.length) {
      lib.log('plugin', `插件 ${m.id} 配置提示：${r.warnings.join('；')}`);
    }

    const ctx = {
      ...shared,
      id: m.id,
      dir: m.dir,
      version: m.version,
      config: r.values,
      dataDir: path.join(shared.dataDir, 'plugins', m.id),
    };
    ctx.log = (msg) => lib.log(m.id, msg);

    // 插件专属数据目录：卸载该插件只需删这一个目录
    try { fs.mkdirSync(ctx.dataDir, { recursive: true }); } catch (_) {}

    try {
      const hooks = {};
      for (const [event, rel] of Object.entries(m.hooks)) {
        const file = path.join(m.dir, rel);
        if (!fs.existsSync(file)) throw new Error(`hook 文件缺失：${rel}`);
        hooks[event] = file;
      }
      loaded.push({ manifest: m, ctx, hooks });
      lib.log('plugin', `已加载 ${m.id}@${m.version}${m.core ? '（内置）' : ''}：hook ${Object.keys(hooks).length} 个，服务 ${Object.keys(m.services).length} 个`);
    } catch (e) {
      lib.log('error', `插件 ${m.id} 加载失败：${e.message}`);
    }
  }
  return loaded;
}

module.exports = { PLUGINS_DIR, createBus, discover, loadAll };
