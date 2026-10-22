'use strict';

// 配置的单一真相：schema。
//
// 为什么要有这个文件：配置结构一变，测过的链路就要重测，而可视化配置页、
// 安装器、hook 都读同一份结构。所以把结构**声明**出来，默认值写在 schema 里，
// 代码从 schema 推导默认值——这样只有一处定义，不会漂移。
//
// schema 用 JSON Schema 的一个小子集 + 几个 ui: 前缀的扩展键：
//
//   type      'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'enum'
//   default   默认值（唯一来源，plugin.json 不再单独写一份）
//   title     给人看的字段名（前端表单的标签、安装器的提示语）
//   description  一句话说明，写「改了会怎样」
//   minimum / maximum / pattern   数值与字符串约束
//   values    type=enum 时的候选值 [{ value, label }]
//   ui:widget 'switch' | 'number' | 'text' | 'textarea' | 'select' | 'path' | 'password'
//   ui:group  分组名，前端按它分栏
//   secret    true 表示这是凭据，导出 schema 时前端要按密码框渲染
//
// 未来做可视化配置页时，前端直接读 `--dump-schema` 的输出就能渲染出表单，
// 不需要再改一遍参数结构——这就是现在就把它定下来的原因。

const fs = require('fs');
const path = require('path');

// ---- 校验 ----

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'enum']);

function typeOk(type, v) {
  switch (type) {
    case 'string': return typeof v === 'string';
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'integer': return typeof v === 'number' && Number.isInteger(v);
    case 'boolean': return typeof v === 'boolean';
    case 'array': return Array.isArray(v);
    case 'object': return v && typeof v === 'object' && !Array.isArray(v);
    case 'enum': return true;   // 由 values 判
    default: return true;
  }
}

// 校验一组值。返回 { values, errors, warnings }
//   errors   值不合法，调用方应拒绝启动（或退回默认值）
//   warnings 未知键——不拒绝，只提示，方便插件加字段时不至于打挂老配置
function validate(schema, input) {
  const values = {};
  const errors = [];
  const warnings = [];
  const src = input && typeof input === 'object' ? input : {};

  for (const [key, spec] of Object.entries(schema || {})) {
    const has = Object.prototype.hasOwnProperty.call(src, key);
    let v = has ? src[key] : spec.default;

    if (v === undefined) {
      if (spec.required) errors.push(`${key} 是必填项，但没有值`);
      continue;
    }

    // null 视同「用默认值」：配置文件里删字段和写 null 是一个意思
    if (v === null) v = spec.default;
    if (v === undefined) continue;

    if (!TYPES.has(spec.type || 'string')) {
      warnings.push(`${key} 的 type "${spec.type}" 不认识，跳过校验`);
      values[key] = v;
      continue;
    }

    if (!typeOk(spec.type || 'string', v)) {
      errors.push(`${key} 应为 ${spec.type}，实际是 ${JSON.stringify(v)}`);
      continue;
    }

    if (spec.type === 'number' || spec.type === 'integer') {
      if (spec.minimum !== undefined && v < spec.minimum) {
        errors.push(`${key} 最小是 ${spec.minimum}，实际 ${v}`);
      }
      if (spec.maximum !== undefined && v > spec.maximum) {
        errors.push(`${key} 最大是 ${spec.maximum}，实际 ${v}`);
      }
    }

    if (spec.type === 'string' && spec.pattern) {
      try {
        if (!new RegExp(spec.pattern).test(v)) {
          errors.push(`${key} 不符合格式 ${spec.pattern}`);
        }
      } catch (_) {}
    }

    if (spec.values && spec.type === 'enum') {
      const allowed = spec.values.map((x) => (typeof x === 'object' ? x.value : x));
      if (!allowed.includes(v)) {
        errors.push(`${key} 只能是 ${allowed.join(' / ')}，实际 ${JSON.stringify(v)}`);
      }
    }

    values[key] = v;
  }

  for (const key of Object.keys(src)) {
    if (!(key in (schema || {}))) warnings.push(`未知配置项 ${key}（会被忽略）`);
  }

  return { values, errors, warnings };
}

// schema → 默认值对象
function defaults(schema) {
  const out = {};
  for (const [key, spec] of Object.entries(schema || {})) {
    if (spec && spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

// schema → 标准 JSON Schema（给前端/编辑器用）。
// 扩展键（ui:*、secret）不塞进标准字段，另放一个 x-ui 里，避免被严格校验器拒掉。
function toJsonSchema(schema, meta) {
  const props = {};
  for (const [key, spec] of Object.entries(schema || {})) {
    const p = {};
    const t = spec.type || 'string';
    if (t === 'enum') {
      p.type = typeof (spec.values || [])[0] === 'number' ? 'number' : 'string';
      p.enum = (spec.values || []).map((x) => (typeof x === 'object' ? x.value : x));
    } else if (t === 'integer') {
      p.type = 'integer';
    } else if (t === 'number') {
      p.type = 'number';
    } else {
      p.type = t;
    }
    if (spec.default !== undefined) p.default = spec.default;
    if (spec.minimum !== undefined) p.minimum = spec.minimum;
    if (spec.maximum !== undefined) p.maximum = spec.maximum;
    if (spec.pattern) p.pattern = spec.pattern;
    if (spec.title) p.title = spec.title;
    if (spec.description) p.description = spec.description;

    const ui = {};
    if (spec['ui:widget']) ui.widget = spec['ui:widget'];
    if (spec['ui:group']) ui.group = spec['ui:group'];
    if (spec.secret) ui.secret = true;
    if (spec.values) {
      ui.options = spec.values.map((x) => (typeof x === 'object'
        ? { value: x.value, label: x.label || String(x.value) }
        : { value: x, label: String(x) }));
    }
    if (Object.keys(ui).length) p['x-ui'] = ui;
    props[key] = p;
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: (meta && meta.title) || '配置',
    type: 'object',
    properties: props,
  };
}

// ---- 全量解析 ----

// 把「插件的 schema」和「用户在 config.json 里写的值」合起来，得到最终生效配置。
// pluginsById: { <id>: { config: <schema>, name, version, dir } }
// userConfig:  config.json 的完整内容（顶层 + plugins.<id>）
function resolve(pluginsById, userConfig) {
  const errors = [];
  const warnings = [];
  const plugins = {};

  for (const [id, m] of Object.entries(pluginsById || {})) {
    const schema = m.config || {};
    const userVals = (userConfig && userConfig.plugins && userConfig.plugins[id]) || {};
    const r = validate(schema, { ...defaults(schema), ...userVals });
    r.errors.forEach((e) => errors.push(`plugins.${id}.${e}`));
    r.warnings.forEach((w) => warnings.push(`plugins.${id}.${w}`));
    plugins[id] = r.values;
  }

  return {
    plugins,
    errors,
    warnings,
    // 顶层配置的 schema 见 TOP_SCHEMA
  };
}

// 顶层（非插件）配置。同样是「schema 即真相」。
const TOP_SCHEMA = {
  // 给人看的说明行，代码不读；声明出来是为了让校验不把它当未知键
  _说明: {
    type: 'string',
    default: '由 kernel/config.js 的 schema 生成。只写你要覆盖的项，其余用默认值。',
    title: '说明',
    description: '自由文本，代码不读。用来在配置文件里写给你自己看的备注。',
    'ui:group': '关于',
  },
  chatId: {
    type: 'string',
    default: '',
    required: true,
    title: '飞书群 ID',
    description: '机器人所在的话题群。群设置里能看到，形如 oc_xxxxxxxx。',
    pattern: '^$|^oc_[A-Za-z0-9]+$',
    'ui:group': '飞书',
    'ui:widget': 'text',
  },
  larkCli: {
    type: 'string',
    default: 'lark-cli',
    title: 'lark-cli 路径',
    description: '装在 PATH 里就留 lark-cli；否则写绝对路径。',
    'ui:group': '飞书',
    'ui:widget': 'text',
  },
  launchAliases: {
    type: 'object',
    default: {},
    title: '目录别名',
    description: '给常用目录起短名，发 #个人 就能直接进。可留空。',
    'ui:group': '开窗',
  },
  launchWorkspaces: {
    type: 'array',
    default: [],
    title: '额外候选目录',
    description: '通常不需要填——桥接会自动发现用过的目录。',
    'ui:group': '开窗',
  },
  contextWindowSize: {
    type: 'integer',
    default: 200000,
    minimum: 1000,
    title: '上下文窗口上限',
    description: '通知卡片上用量百分比的分母。默认读 HUD 缓存里的真实值（推荐，能跟着模型换代走）；只有缓存取不到时才用这里的值。',
    'ui:group': '显示',
    'ui:widget': 'number',
  },
  chunkChars: {
    type: 'integer',
    default: 4000,
    minimum: 200,
    maximum: 30000,
    title: '长回复分段字数',
    description: '超过这个长度的回复会拆成多条消息。',
    'ui:group': '显示',
    'ui:widget': 'number',
  },
  sessionTtlHours: {
    type: 'integer', default: 48, minimum: 1, title: '会话记录保留（小时）',
    'ui:group': '清理', 'ui:widget': 'number',
  },
  mappingTtlDays: {
    type: 'integer', default: 14, minimum: 1, title: '消息映射保留（天）',
    'ui:group': '清理', 'ui:widget': 'number',
  },
  imageTtlDays: {
    type: 'integer', default: 7, minimum: 1, title: '图片保留（天）',
    'ui:group': '清理', 'ui:widget': 'number',
  },
  maxLogBytes: {
    type: 'integer', default: 5242880, minimum: 65536, title: '单个日志上限（字节）',
    'ui:group': '清理', 'ui:widget': 'number',
  },
  // 插件各自的参数放这里，键是插件 id。每个插件的合法键由它自己的 schema 定义，
  // 所以这一项只做「结构占位」，不校验内部——具体校验在 resolve() 里逐个插件做。
  plugins: {
    type: 'object',
    default: {},
    title: '插件配置',
    description: '按插件 id 分组。只写要改的项，其余用插件的默认值。',
    'ui:group': '插件',
  },
};

// 解析全量配置（顶层 + 各插件）。失败时给出可直接念给人听的错误列表。
function resolveAll(pluginsById, userConfig) {
  const top = validate(TOP_SCHEMA, userConfig || {});
  const sub = resolve(pluginsById, userConfig || {});
  return {
    top: top.values,
    topSchema: TOP_SCHEMA,
    plugins: sub.plugins,
    errors: [...top.errors, ...sub.errors],
    warnings: [...top.warnings, ...sub.warnings],
  };
}

// 导出完整 schema（顶层 + 各插件），供前端渲染配置页。
function dumpSchema(pluginsById) {
  return {
    version: 1,
    top: toJsonSchema(TOP_SCHEMA, { title: '基础配置' }),
    plugins: Object.fromEntries(Object.entries(pluginsById || {}).map(([id, m]) => [id, {
      name: m.name || id,
      version: m.version || '0.0.0',
      core: !!m.core,
      description: m.description || '',
      schema: toJsonSchema(m.config || {}, { title: m.name || id }),
    }])),
  };
}

module.exports = { TOP_SCHEMA, validate, defaults, toJsonSchema, resolve, resolveAll, dumpSchema };

// ---- CLI：把 schema 吐出来给前端/编辑器用 ----
//
//   node kernel/config.js --dump          完整 schema（顶层 + 各插件）
//   node kernel/config.js --check         用真实 config.json 校验一遍
//   node kernel/config.js --defaults      只输出默认值（生成 config.example.json 用）
//
// 这是「现在不做可视化配置页」的替代方案：结构先定死、可被机器读，
// 将来写网页时直接吃 --dump 的输出，不用再改一遍参数。
if (require.main === module) {
  const plugin = require('./plugin');
  const manifests = plugin.discover();
  const byId = Object.fromEntries(manifests.map((m) => [m.id, m]));

  if (process.argv.includes('--dump')) {
    console.log(JSON.stringify(dumpSchema(byId), null, 2));
  } else if (process.argv.includes('--defaults')) {
    const lib = require('./lib');
    let user = {};
    try { user = lib.readConfig(); } catch (_) {}
    const r = resolveAll(byId, user);
    console.log(JSON.stringify({ ...r.top, plugins: r.plugins }, null, 2));
  } else if (process.argv.includes('--check')) {
    const lib = require('./lib');
    let user = {};
    try { user = lib.readConfig(); } catch (e) {
      console.error(`读不到配置：${e.message}`);
      process.exit(1);
    }
    if (user._missing) {
      console.error(`还没有配置文件：${user._configFile}`);
      process.exit(1);
    }
    const r = resolveAll(byId, user);
    if (r.errors.length) {
      console.error('配置有误：');
      r.errors.forEach((e) => console.error(`  ✗ ${e}`));
      process.exit(1);
    }
    if (r.warnings.length) {
      r.warnings.forEach((w) => console.log(`  ! ${w}`));
    }
    console.log('配置校验通过。');
  } else {
    console.log('用法：node kernel/config.js --dump | --defaults | --check');
  }
}
