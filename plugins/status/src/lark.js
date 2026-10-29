'use strict';

// 异步调 lark-cli，返回解析后的 JSON（失败返回 null）。
//
// 为什么不用 kernel/lib 的 larkSync：那是 spawnSync，实测一次调用含进程启动
// 约 1.5 秒，**同步阻塞主线程**。状态卡每 2 秒就要刷几张，一阻塞就把事件消费
// 和卡片回调一起堵住，表现是「你在飞书说的话这几秒没反应」。
// 所以这里走异步 spawn，由调用方自己控制并发。

const { spawn } = require('child_process');
const lib = require('../../../kernel/lib');

function lark(args) {
  return new Promise((resolve) => {
    let cfg;
    try { cfg = lib.readConfig(); } catch (_) { cfg = {}; }
    const bin = cfg.larkCli || 'lark-cli';
    const child = spawn(bin, args, {
      cwd: lib.ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 20000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const s = out.trim();
      if (!s) return resolve(null);
      try { resolve(JSON.parse(s)); } catch (_) { resolve({ ok: false, raw: s.slice(0, 200) }); }
    });
  });
}

module.exports = { lark };
