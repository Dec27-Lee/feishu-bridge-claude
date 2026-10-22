'use strict';

// 可视化配置页。在浏览器里改 config.json，字段与校验全部来自 kernel/config.js 的 schema。
//
//   node setup/config-ui.js                 # 起服务并打开浏览器
//   node setup/config-ui.js --no-open       # 只起服务，自己复制地址（远程/无桌面时）
//   node setup/config-ui.js --port 9000
//   node setup/config-ui.js --idle-exit 0   # 不自动退出（默认 15 分钟没人访问就退）
//
// 为什么它不是 plugins/ 下的插件：**配置是桥接的启动前置条件**。配置写坏时插件根本
// 加载不起来，而那一刻正是最需要打开配置页的时候。所以这是个独立进程，只要 node 能跑
// 就行，与 bridge 的死活无关。它是 setup/ 里的维护工具，与 check/install/verify 同类。
//
// 访问控制：只监听 127.0.0.1，每次启动生成随机令牌打进 URL，/api/* 必须带它。
// 「本机就是可信的」不成立——任意网页都能向 127.0.0.1 发请求，而写 config.json
// 等于能改这台机器怎么跑。

const crypto = require('crypto');
const { spawn } = require('child_process');

const server = require('./config-ui/server');
const lib = require('../kernel/lib');

const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const val = (f, dflt) => {
  const i = ARGS.indexOf(f);
  if (i < 0 || i + 1 >= ARGS.length) return dflt;
  return ARGS[i + 1];
};

const PORT = Number(val('--port', 8787));
const IDLE_MIN = Number(val('--idle-exit', 15));
const OPEN = !has('--no-open');

function openBrowser(url) {
  // 用系统默认浏览器打开。失败不影响使用——地址已经打印在终端里。
  const cmd = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const c = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true });
    c.on('error', () => {});
    c.unref();
  } catch (_) {}
}

let lastActive = Date.now();
const token = crypto.randomBytes(16).toString('hex');
const srv = server.createServer({ token, onActivity: () => { lastActive = Date.now(); } });

function announce(port) {
  const url = `http://127.0.0.1:${port}/?t=${token}`;
  const lines = [
    '配置页已启动',
    `  地址：${url}`,
    `  配置：${lib.CONFIG_FILE}`,
    '',
    // 令牌在 URL 里：截图/录屏时会一起被别人看到，这里明说一句
    '  地址里的 t= 是本次启动的令牌，只能用它访问。别把带令牌的地址发给别人。',
    IDLE_MIN > 0 ? `  ${IDLE_MIN} 分钟没人操作会自动退出（--idle-exit 0 可关）。` : '',
    '  保存后需要重启桥接才生效。Ctrl+C 退出。',
  ].filter(Boolean);
  console.log(lines.join('\n'));

  if (OPEN) openBrowser(url);
}

srv.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && PORT !== 0) {
    // 端口被占就换一个，而不是让用户去查哪个进程占了 8787
    console.log(`端口 ${PORT} 被占用，改用系统分配的空闲端口。`);
    srv.listen(0, '127.0.0.1', () => announce(srv.address().port));
  } else {
    console.error(`起服务失败：${e.message}`);
    process.exit(1);
  }
});

srv.listen(PORT, '127.0.0.1', () => announce(srv.address().port));

if (IDLE_MIN > 0) {
  const tick = setInterval(() => {
    if (Date.now() - lastActive < IDLE_MIN * 60000) return;
    clearInterval(tick);
    console.log(`\n${IDLE_MIN} 分钟无操作，配置页已退出。`);
    srv.close(() => process.exit(0));
    // close 不会打断已建立的 keep-alive 连接，兜底退出
    setTimeout(() => process.exit(0), 2000).unref();
  }, 30000);
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
