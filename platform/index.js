'use strict';

// 平台适配层。
//
// 把所有「换操作系统就要重写」的东西收在这一个目录里。kernel/ 和 plugins/
// 只调这里导出的能力，不出现 process.platform 判断、不出现 .exe / VBS / osascript。
//
// 每个平台导出同一组接口（这是内核唯一认得的契约）：
//
//   name                     平台名，写日志用
//   supportsPresence         有没有在场采样能力
//   startPresence(file, ms)  启动采样器；成功 true，没有实现或未编译 false
//   presenceRunning()        采样器还活着吗
//   stopPresence()           收掉本进程的采样器
//   stopAllPresence()        收掉「本目录下」所有采样器（含上一个 bridge 的孤儿），返回 pid 列表
//   spawnWindow(opts)        开一个新终端窗口跑 claude，失败抛错
//   pidAlive(pid)            进程是否真的还活着
//   autostart                { kind, install, remove }，install/remove 为脚本绝对路径或 null
//
// 三个已实现的平台各自用一个子目录整套实现（Windows/macOS/Linux 互不引用），
// 共同逻辑一律留在 kernel/ 与 plugins/ —— 平台层里不该出现业务判断。
//
// 新增平台：在 platform/<name>/ 下实现这组接口，并在下面加一个分支。调用方一行都不用改。

const platform = process.platform;

if (platform === 'win32') {
  module.exports = require('./win32');
} else if (platform === 'darwin') {
  module.exports = require('./darwin');
} else if (platform === 'linux') {
  module.exports = require('./linux');
} else {
  module.exports = require('./unsupported');
}
