'use strict';

// 未适配的平台（Linux 等）。
//
// 只保证「装得上、不崩」：话题路由、卡片作答、任务通知全靠内核 + 插件，
// 与平台无关，所以 Linux 上主要功能是可用的。
// 缺的是自动开窗和在场探测——两者都能优雅降级。

module.exports = {
  name: process.platform,
  supportsPresence: false,
  presenceExe: null,

  startPresence() { return false; },
  presencePid() { return null; },
  presenceRunning() { return false; },
  stopPresence() {},
  stopAllPresence() { return []; },

  spawnWindow() {
    throw new Error(
      `暂未支持 ${process.platform} 上自动开窗。请在终端里手动启动 claude，`
      + '然后在新话题里发 #resume 绑定；'
      + '或参考 platform/win32/ 实现一个 platform/linux/index.js。',
    );
  },

  pidAlive(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  },

  autostart: { kind: 'none', install: null, remove: null },
};
