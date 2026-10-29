'use strict';

// 内核入口：读配置 → 扫插件 → 起服务 → 订阅飞书事件 → 收尾。
//
//   node kernel/index.js
//
// 只做编排，不含业务。插件通过 ctx 拿到能力，事件通过 ctx.bus 流动。

const path = require('path');
const lib = require('./lib');
const plugin = require('./plugin');
const daemon = require('./daemon');
const platform = require('../platform');

// 插件可以在 index.js 里导出 eventHandlers，声明它想接哪些飞书事件。
// 这样内核统一管理订阅与退避重启，插件不用自己 spawn lark-cli。
const EVENT_CONSUMERS = [
  { event: 'im.message.receive_v1', plugin: 'core', handler: 'onMessage', tag: 'msg', retry: 5000 },
  { event: 'card.action.trigger', plugin: 'core', handler: 'onCardAction', tag: 'card', retry: 60000 },
];

function main() {
  lib.ensureDirs();

  let config;
  try {
    config = lib.readConfig();
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (config._missing) {
    console.error([
      `还没有配置文件：${config._configFile}`,
      '',
      '跑 node setup/install.js，或复制 config.example.json 为 config.json 再填。',
    ].join('\n'));
    process.exit(1);
  }

  const lock = daemon.acquireLock();
  if (!lock.ok) {
    // 这条分支原来只往 stderr 写。看门狗（watch-bridge.vbs）用
    // `sh.Run cmd, 0, True` 起进程，stdout/stderr 全被吞掉——于是「桥接一直
    // 起不来」在磁盘上一点痕迹都不留：日志停在昨天，锁里是个活 pid，
    // 现场只剩「手机发的消息进不来、状态卡也没了」。所以补一条日志。
    lib.log('bridge', `拒绝启动：锁里的 pid=${lock.pid} 是本项目的桥接，本次退出`);
    console.error(`已有实例在运行 (pid=${lock.pid})，本次退出。`);
    process.exit(0);
  }

  const bus = plugin.createBus();
  const shared = { bus, lib, platform, global: config, dataDir: lib.DATA_DIR };

  lib.log('bridge', `启动 pid=${process.pid} 平台=${platform.name} 插件目录=${plugin.PLUGINS_DIR}`);
  lib.log('bridge', `订阅 ${EVENT_CONSUMERS.map((c) => c.event).join('、')}`);

  process.on('uncaughtException', (e) => {
    lib.log('error', `uncaughtException: ${e && e.stack ? e.stack : e}`);
  });
  process.on('unhandledRejection', (e) => {
    lib.log('error', `unhandledRejection: ${e && e.stack ? e.stack : e}`);
  });

  const loaded = plugin.loadAll(shared);
  if (!loaded.length) {
    lib.log('error', '没有加载到任何插件，退出');
    daemon.releaseLock();
    process.exit(1);
  }

  // 起服务。单个插件抛错只记日志，不影响其他插件——这是硬约束。
  const started = [];
  for (const p of loaded) {
    for (const sid of Object.keys(p.manifest.services || {})) {
      try {
        const mod = require(path.join(p.manifest.dir, p.manifest.services[sid]));
        if (typeof mod.start === 'function') {
          mod.start(p.ctx);
          started.push({ ...p, service: sid, mod });
        }
      } catch (e) {
        lib.log('error', `插件 ${p.manifest.id} 的服务 ${sid} 启动失败：${e.stack || e.message}`);
      }
    }
  }

  // 订阅飞书事件。处理函数从插件模块上取；插件没导出就跳过该事件。
  const consumers = [];
  for (const c of EVENT_CONSUMERS) {
    const owner = started.find((s) => s.manifest.id === c.plugin);
    const fn = owner && owner.mod[c.handler];
    if (typeof fn !== 'function') {
      lib.log('error', `事件 ${c.event} 的处理函数缺失（插件 ${c.plugin}.${c.handler}），该事件不订阅`);
      continue;
    }
    consumers.push(daemon.startConsumer(c.event, fn, c.tag, c.retry));
  }

  lib.log('bridge', `已启动 ${started.length} 个服务、${consumers.length} 个事件订阅，来自 ${loaded.length} 个插件`);

  let exiting = false;
  const shutdown = (sig) => {
    if (exiting) return;
    exiting = true;
    lib.log('bridge', `收到 ${sig}，正在退出`);
    for (const c of consumers) { try { c.kill(); } catch (_) {} }
    for (const s of started.slice().reverse()) {
      try {
        if (typeof s.mod.stop === 'function') s.mod.stop(s.ctx);
      } catch (e) {
        lib.log('error', `插件 ${s.manifest.id} 停止失败：${e.message}`);
      }
    }
    daemon.releaseLock();
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
  process.on('exit', daemon.releaseLock);
}

if (require.main === module) main();
