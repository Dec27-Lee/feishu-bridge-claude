'use strict';

// core 插件自己的设置。
//
// 为什么需要它：卡片构造函数是纯函数（输入数据、吐卡片 JSON），但「候选最多列几个」
// 这类参数来自插件配置。与其把这些值一路当参数穿十几层，不如在插件启动时
// 一次性注入，其余模块按需读。
//
// 只在 core 插件内部使用——别的插件请读自己的 ctx.config，不要读这里。

const DEFAULTS = {
  pickMax: 20,
  resumeMax: 8,
  launchTimeoutSeconds: 30,
};

let current = { ...DEFAULTS };

// 由 core/index.js 的 start(ctx) 调用，把 schema 解析后的配置塞进来
function configure(cfg) {
  current = { ...DEFAULTS, ...(cfg || {}) };
  return current;
}

function get(key) {
  return current[key] === undefined ? DEFAULTS[key] : current[key];
}

function all() {
  return { ...current };
}

module.exports = { DEFAULTS, configure, get, all };
