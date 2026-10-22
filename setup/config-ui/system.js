'use strict';

// 配置页的「系统状态」：哪些东西装了、桥接在不在跑。
//
// 为什么要单独一个文件：状态查询和配置读写是两件事。前者要碰文件系统、进程表、
// 平台适配层，后者只碰 schema 与 config.json。混在一起，读一次页面就要把平台层
// 全拉进来（在 Windows 上还会连带拉 presence.exe 的路径判断）。
//
// 这里**只读不写**。安装/卸载动作由 setup/install.js 负责——它能打印 diff 并要求确认，
// 配置页不该变成第二个改系统配置的入口。

const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = require('../../kernel/lib');

function fileOk(p) {
  try { return fs.existsSync(p); } catch (_) { return false; }
}

// 开机自启：直接问平台层「装没装」，而不是在页面里写死各平台的路径。
// 平台层没有 autostart 方案（unsupported）时如实说没有。
function autostartState() {
  let platform;
  try { platform = require('../../platform'); } catch (_) { return { supported: false, installed: null }; }
  const auto = platform.autostart || {};
  if (auto.kind === 'none' || !auto.install) return { supported: false, installed: null, kind: auto.kind || 'none' };

  // 各平台的「装没装」判据不同（快捷方式 / plist / unit），但都由平台层自己回答，
  // 配置页不需要知道这些细节。
  let installed = null;
  if (typeof auto.installed === 'function') {
    try { installed = !!auto.installed(); } catch (_) { installed = null; }
  }
  return { supported: true, installed, kind: auto.kind };
}

// 桥接在不在跑：看单实例锁里的 pid 是否还活着
function bridgeState() {
  const lock = path.join(LIB.DATA_DIR, 'bridge.pid');
  let pid = null;
  try { pid = parseInt(fs.readFileSync(lock, 'utf8').trim(), 10) || null; } catch (_) { return { running: false, pid: null }; }
  if (!pid) return { running: false, pid: null };
  let alive = false;
  try {
    const platform = require('../../platform');
    alive = platform.pidAlive(pid);
  } catch (_) {
    try { process.kill(pid, 0); alive = true; } catch (_) { alive = false; }
  }
  return { running: alive, pid };
}

// 目录体积。只统计到两层，别为了一个数字把几万个文件全走一遍——
// 这个值只是用来判断「是不是该清理了」，不需要精确到字节。
function dirSize(dir, depth = 2) {
  let total = 0;
  let files = 0;
  (function walk(d, lv) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) { if (lv > 0) walk(p, lv - 1); }
        else { const st = fs.statSync(p); total += st.size; files += 1; }
      } catch (_) {}
    }
  })(dir, depth);
  return { bytes: total, files };
}

function dataState() {
  const images = path.join(LIB.DATA_DIR, 'images');
  const days = [];
  try {
    for (const d of fs.readdirSync(images)) {
      if (!/^\d{8}$/.test(d)) continue;
      const n = (() => { try { return fs.readdirSync(path.join(images, d)).length; } catch (_) { return 0; } })();
      days.push({ day: d, files: n });
    }
  } catch (_) {}
  days.sort((a, b) => b.day.localeCompare(a.day));

  return {
    dataDir: LIB.DATA_DIR,
    logDir: LIB.LOG_DIR,
    configFile: LIB.CONFIG_FILE,
    images: { total: days.reduce((a, b) => a + b.files, 0), days: days.slice(0, 8) },
    logs: dirSize(LIB.LOG_DIR, 1),
    sessions: (() => { try { return fs.readdirSync(LIB.SESSIONS_DIR).filter((f) => f.endsWith('.json')).length; } catch (_) { return 0; } })(),
  };
}

// 页面顶部那一行「现在什么状态」。readonly，供 UI 展示，不参与保存。
function systemState() {
  return {
    platform: (() => { try { return require('../../platform').name; } catch (_) { return process.platform; } })(),
    node: process.version,
    autostart: autostartState(),
    bridge: bridgeState(),
    data: dataState(),
    home: os.homedir(),
  };
}

module.exports = { systemState, autostartState, bridgeState, dataState };
