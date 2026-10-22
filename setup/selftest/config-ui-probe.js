'use strict';

// 配置页服务端的探针，由 run.js 在沙箱里 spawn，最后一行输出 JSON 结果。
//
// 为什么单独成一个文件而不是内联在 run.js 里：这一段要发十几个 HTTP 请求、
// 还要读写临时配置，内联字符串的转义会把重点淹没。它是自测的一部分，
// 不是产品代码，所以在 setup/selftest/ 下跟 mock-preload.js 放一起。
//
// 不在主进程里跑的原因：kernel/lib 在 require 时就把 CONFIG_FILE 算死了，
// 主进程前面已经加载过它（指向项目真实配置），改环境变量追不回来。

const fs = require('fs');
const http = require('http');
const server = require('../config-ui/server');

const CFG = process.env.FEISHU_CONFIG;
const TOKEN = 'probe-token-fixed';
const out = [];
const check = (name, ok, detail) => out.push({ name, ok: !!ok, detail: String(detail || '') });

function req(port, method, p, opts = {}) {
  return new Promise((resolve) => {
    const data = opts.body === undefined ? null : JSON.stringify(opts.body);
    const headers = {};
    if (opts.token) headers['x-bridge-token'] = opts.token;
    if (opts.host) headers.host = opts.host;
    if (opts.origin) headers.origin = opts.origin;
    if (data) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(s); } catch (_) {}
        resolve({ status: res.statusCode, json: j, text: s });
      });
    });
    r.on('error', (e) => resolve({ status: 0, json: null, text: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

const readCfg = () => JSON.parse(fs.readFileSync(CFG, 'utf8'));

// 初始状态刻意带上这几样，分别验证三件容易被悄悄改坏的事：
//   · `_说明` / `unknownKey` / `ghost` —— schema 里没有的东西不许被删掉
//   · `imageTtlDays: 7`（正好等于默认值）—— 不改它时不许被当成「多余」清掉
fs.writeFileSync(CFG, JSON.stringify({
  _说明: '手写的备注',
  chatId: 'oc_probe',
  imageTtlDays: 7,
  unknownKey: 'keep-me',
  plugins: { core: { pickMax: 25 }, ghost: { a: 1 } },
}, null, 2), 'utf8');

const srv = server.createServer({ token: TOKEN });

srv.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;

  // 1. 访问控制：本机 HTTP 服务不是可信边界，任意网页都能向 127.0.0.1 发请求
  let r = await req(port, 'GET', '/api/state');
  check('无令牌访问被拒', r.status === 401, `HTTP ${r.status}`);
  r = await req(port, 'GET', '/api/state', { token: 'wrong' });
  check('错误令牌被拒', r.status === 401, `HTTP ${r.status}`);
  r = await req(port, 'GET', '/api/state', { token: TOKEN, host: 'evil.example.com' });
  check('非本机 Host 被拒', r.status === 403, `HTTP ${r.status}`);

  // 2. schema 驱动：字段、分组、默认值全从 kernel/config.js 来
  r = await req(port, 'GET', '/api/state', { token: TOKEN });
  const st = r.json || {};
  const plugIds = Object.keys((st.schema && st.schema.plugins) || {});
  check('带令牌能读到 schema', r.status === 200 && plugIds.length > 0, `plugins=${plugIds.join(',')}`);
  // 沙箱里的假插件必须自动出现——页面里没有任何插件名写死
  check('新加的插件自动出现在 schema 里', plugIds.includes('probe-demo'), plugIds.join(','));
  const askUi = (((st.schema || {}).plugins || {}).ask || {}).schema || {};
  check('字段带 x-ui 分组与控件',
    !!((((askUi.properties || {}).awayWaitSeconds) || {})['x-ui'] || {}).group,
    JSON.stringify((((askUi.properties || {}).awayWaitSeconds) || {})['x-ui'] || {}));
  check('默认值随 schema 一起给出',
    Number((((st.defaults || {}).plugins || {}).ask || {}).awayWaitSeconds) === 1800,
    JSON.stringify((((st.defaults || {}).plugins || {}).ask || {}).awayWaitSeconds));

  // 2b. 左边导航的两页来自后端：页面里不写死「通用配置 / 飞书消息」这种标题。
  const pageIds = ((st.schema || {}).pages || []).map((p) => p.id);
  check('后端给出页面清单', pageIds.length >= 2 && pageIds.includes('general') && pageIds.includes('feishu'),
    pageIds.join(','));

  // 2c. 每个顶层字段都归属某一页。新增配置项忘了写 ui:page 时，它会掉进第一页
  // ——界面上不丢，但放进哪一页是猜的。这里要求显式写清楚。
  {
    const unassigned = Object.entries((st.schema || {}).top.properties || {})
      .filter(([k, s]) => !k.startsWith('_') && k !== 'plugins' && !((s['x-ui'] || {}).page))
      .map(([k]) => k);
    check('每个顶层字段都标了所属页面', unassigned.length === 0, unassigned.join(','));
  }

  // 2d. 核心路由的配置并进了「飞书消息」页：它没有自己的页面。
  // 这些项都是飞书那一侧的行为（置顶、@ 谁、卡片放几个按钮、超时回卡），
  // 单独成页会让人为了改一个 @人 去点「核心路由」。
  {
    const coreProps = ((((st.schema || {}).plugins || {}).core || {}).schema || {}).properties || {};
    const feishuBound = Object.entries(coreProps).filter(([, s]) => (s['x-ui'] || {}).page === 'feishu');
    check('核心路由的配置都归到飞书消息页',
      Object.keys(coreProps).length > 0 && feishuBound.length === Object.keys(coreProps).length,
      `${feishuBound.length}/${Object.keys(coreProps).length}`);
    // 页面只渲染没有 ui:page 的插件字段，所以核心路由那页会是空的——
    // 检查它确实全被领走了，导航里才不会出现一个空页。
    const ownLeft = Object.entries(coreProps).filter(([, s]) => !((s['x-ui'] || {}).page));
    check('核心路由不再留空页', ownLeft.length === 0, ownLeft.map(([k]) => k).join(','));
  }

  // 3. 跨站写保护
  r = await req(port, 'POST', '/api/preview',
    { token: TOKEN, origin: 'https://evil.example.com', body: { top: { chatId: 'oc_probe' }, plugins: {} } });
  check('跨站发起的写请求被拒', r.status === 403, `HTTP ${r.status}`);

  // 4a. 什么都不改就点保存，必须零改动。
  // 曾经是无条件拿值比默认值：打开页面、不改任何东西、点保存，diff 里冒出十几条
  // 「删除」，用户看到的第一反应是「它要删我配置」。
  const allTop = {};
  for (const [k, spec] of Object.entries(st.schema.top.properties)) {
    if (k === 'plugins' || k.startsWith('_')) continue;
    allTop[k] = st.values.top[k];
  }
  const allPlugins = {};
  for (const id of Object.keys(st.schema.plugins)) allPlugins[id] = { ...(st.values.plugins[id] || {}) };
  r = await req(port, 'POST', '/api/preview', {
    token: TOKEN, origin: `http://127.0.0.1:${port}`,
    body: { top: allTop, plugins: allPlugins },
  });
  check('原样回写时零改动', r.status === 200 && r.json && r.json.diff.length === 0,
    JSON.stringify((r.json && r.json.diff) || []).slice(0, 200));

  // 4b. 文件里显式写着的默认值，只要没动过就必须留在**将要写出的内容**里。
  // 无条件按「值等于默认值就删」实现时，这一条会红：用户打开页面什么都没做，
  // 保存后 imageTtlDays 就消失了（功能不变，但看起来像配置被清掉）。
  // 断的是 preview 的 content 而不是磁盘文件——preview 本来就不落盘，
  // 读文件会永远通过，等于什么都没测。
  const previewed = JSON.parse(((r.json || {}).content) || '{}');
  check('显式写着的默认值不会被顺手删掉', previewed.imageTtlDays === 7,
    JSON.stringify(previewed.imageTtlDays));

  // 4. 越界值必须被拦住，而且 preview 不能落盘
  const before = fs.readFileSync(CFG, 'utf8');
  r = await req(port, 'POST', '/api/preview', {
    token: TOKEN, origin: `http://127.0.0.1:${port}`,
    body: { top: { chatId: 'oc_probe' }, plugins: { ask: { awayWaitSeconds: 99999 } } },
  });
  check('越界值在 preview 就报错', r.status === 400 && !!(r.json && r.json.errors.length),
    JSON.stringify((r.json && r.json.errors) || []).slice(0, 120));
  check('preview 不写盘', fs.readFileSync(CFG, 'utf8') === before, '');

  // 5. 保存：把一个**本来写着的非默认值**改回默认值 → 该键被删掉
  // （原样回写不删任何东西，只有真动过的项才按默认值清掉）
  r = await req(port, 'POST', '/api/save', {
    token: TOKEN, origin: `http://127.0.0.1:${port}`,
    body: { top: { chatId: 'oc_probe' }, plugins: { core: { pickMax: 20 } } },
  });
  const after = readCfg();
  check('保存成功并报告改动数',
    r.status === 200 && r.json && r.json.changed === true && r.json.diff.length === 1,
    `HTTP ${r.status} diff=${JSON.stringify((r.json && r.json.diff) || [])}`);
  check('等于默认值的键被删掉',
    !(after.plugins && after.plugins.core && 'pickMax' in after.plugins.core),
    JSON.stringify(after.plugins));

  // 6. 不认识的键不许被页面悄悄删掉
  check('schema 里没有的顶层键保留', after.unknownKey === 'keep-me', JSON.stringify(after.unknownKey));
  check('人的备注行保留', after['_说明'] === '手写的备注', JSON.stringify(after['_说明']));
  check('已卸插件的残留配置保留',
    !!(after.plugins && after.plugins.ghost && after.plugins.ghost.a === 1),
    JSON.stringify(after.plugins));

  // 7. 有错就不写：宁可不保存，也不写出一个连桥接都起不来的 config.json
  const before2 = fs.readFileSync(CFG, 'utf8');
  r = await req(port, 'POST', '/api/save', {
    token: TOKEN, origin: `http://127.0.0.1:${port}`,
    body: { top: { chatId: '不是群号' }, plugins: {} },
  });
  check('校验不通过时拒绝保存', r.status === 400 && r.json && r.json.ok === false,
    `HTTP ${r.status}`);
  check('拒绝保存后文件没被动过', fs.readFileSync(CFG, 'utf8') === before2, '');

  // 8. 写盘前留备份：改错了能翻回来
  check('保存前留下了备份文件', fs.existsSync(`${CFG}.bridge-bak`), '');

  // 8b. 重启前先校验：配置坏了必须拒绝重启。
  // 重启失败 = 老进程已停、新进程起不来 = 从「改错一个值」变成「整台机器失联」，
  // 而配置页的典型使用场景恰恰是人不在电脑前。所以这道闸必须在重启之前。
  //
  // 这里直接调 restartBridge（不是只调 configProblem）：闸门写在 restartBridge 里，
  // 只测 configProblem 的话，把 restartBridge 那道判断删掉用例照样绿。
  // 断言要卡住「有没有真去 spawn」——只看 ok===false 不行，因为它 20 秒超时后
  // 也会返回 false，用例会以为闸门生效了。
  {
    fs.writeFileSync(CFG, '{ "chatId": "oc_probe", ', 'utf8');   // 故意写坏 JSON
    const rp = require('../config-ui/restart');
    check('配置坏了时 configProblem 有话说', !!rp.configProblem(), String(rp.configProblem()).slice(0, 80));

    const t0 = Date.now();
    const r = await rp.restartBridge();
    const ms = Date.now() - t0;
    check('配置坏了时立刻拒绝重启（没有去 spawn）',
      r.ok === false && r.pid === null && ms < 3000,
      `${ms}ms ${JSON.stringify(r).slice(0, 120)}`);
    check('拒绝重启时说明了是配置问题',
      r.errors.join('').includes('配置'), r.errors.join('；').slice(0, 120));

    fs.writeFileSync(CFG, JSON.stringify({ chatId: 'oc_probe' }, null, 2), 'utf8');
    check('配置正常时允许重启', rp.configProblem() === null, String(rp.configProblem()));
  }

  // 9. 页面本身：单文件、无外链（CDN 在离线/内网里就是一张空白页）
  const page = fs.readFileSync(require('path').join(__dirname, '..', 'config-ui', 'page.html'), 'utf8');
  check('页面没有外部资源', !/src\s*=\s*["']https?:|href\s*=\s*["']https?:/.test(page), '');
  // 页面必须按 schema 渲染，不能写死插件或字段——插件化架构的核心性质。
  // 只检查「字符串字面量里出现插件 id」这一种形态：注释里提到它们是正常的。
  check('页面没有写死插件 id',
    !/['"`](core|ask|notify|permission)['"`]/.test(page),
    (page.match(/['"`](core|ask|notify|permission)['"`]/) || [''])[0]);

  srv.close(() => {
    console.log(JSON.stringify(out));
    process.exit(0);
  });
});
