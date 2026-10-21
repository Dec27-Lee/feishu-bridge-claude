'use strict';

// core 插件：话题路由、开窗、恢复会话。没有它这套东西就不成立。
//
// 只做编排——具体逻辑都在 src/ 下，按功能各自成文件。
// 单实例锁与飞书事件消费者由内核提供（kernel/daemon.js），这里只管业务定时任务。

const lib = require('../../kernel/lib');
const presence = require('../../kernel/presence');
const { runCleanup } = require('../../kernel/daemon');
const { handleEvent } = require('./src/route');
const { handleCardAction } = require('./src/cardact');
const { pollQuestions } = require('./src/qcards');
const settings = require('./src/settings');

let timers = [];

function every(fn, ms) {
  timers.push(setInterval(fn, ms));
}

function start(ctx) {
  // 把 schema 解析后的配置注入给各模块（卡片数量上限、开窗超时等）
  settings.configure(ctx.config);

  // 过期数据回收：启动一次，之后每小时一次
  runCleanup('启动');
  every(() => runCleanup('定时'), 3600000);

  // 在场采样：hook 靠它判断「人是不是就坐在电脑前」。
  // 采样器是常驻子进程（每秒一次，约 0.4ms/次），挂了每分钟重拉。
  // 没有它 hook 会退化成「一律推卡片」——功能仍然可用，只是手机上多收卡。
  const ensurePresence = () => {
    if (presence.alive()) return;
    if (presence.start()) {
      ctx.log(`在场采样已启动 (pid=${presence.status().pid})`);
    } else {
      ctx.log('无可用的在场采样器（平台未适配或采样器未编译），提问/权限确认一律推卡片');
    }
  };
  ensurePresence();
  every(ensurePresence, 60000);

  // `/resume` 会在同一进程上留下作废的 sessionId。留着它，投递就引到作废的 socket 上：
  // 消息发不出去，且毫无报错。启动扫一次，之后 5 分钟补扫（进程刚起时会话表还没落定）。
  const sweep = () => {
    try {
      const n = lib.sweepAliases();
      if (n) ctx.log(`清理了 ${n} 条 resume 残留的会话别名`);
    } catch (e) { lib.log('error', `清理会话别名失败: ${e.message}`); }
  };
  sweep();
  every(sweep, 5 * 60000);

  // 提问卡片：hook 只负责把提问落盘，这里每 2 秒扫一次并发卡片
  every(() => {
    try { pollQuestions(); } catch (e) { lib.log('error', `扫描提问失败: ${e.message}`); }
  }, 2000);
}

function stop() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

// 事件消费者由内核按插件声明的 hook 事件起，这里导出处理函数供内核转发。
// 之所以不在这里自己订阅：内核要统一管理退避重启与退出回收。
async function onMessage(ev) { return handleEvent(ev); }
async function onCardAction(ev) { return handleCardAction(ev); }

module.exports = { start, stop, onMessage, onCardAction };
