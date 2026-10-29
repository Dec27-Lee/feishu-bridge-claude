'use strict';

// 置顶的清理：让群里的「置顶」列表只留下**还在用的**话题和卡片。
//
// 为什么需要：话题根和状态卡都会在创建时置顶，好用。但置顶只增不减——
// 换一次卡多一条、关一个窗口留一条，一个月下来置顶列表能攒到两百多条，
// 真要找某个在用的会话反而翻不到。实测一天就有 235 条（220 条是换卡残留）。
//
// 两条清理时机，都挂在已有生命周期上，不新增定时器：
//   1. 换卡/收掉旧卡时 —— 顺手把那条的置顶撤掉（retireCard）
//   2. 窗口关掉后 —— 话题根不要再置顶（sweep 在状态卡轮询里跑）
//
// 只撤**机器人自己置顶**的：置顶列表里带 operator_id，人手动置顶的留着不动。

const { lark } = require('./lark');

// 撤回一条置顶。
//
// `--yes` 是 lark-cli 对 high-risk-write 的强制要求；这里加它不是「绕过确认」——
// 用户明确选择了「置顶跟窗口生命周期走」，撤掉自己置的旧卡就在这个授权范围内。
// 它也不触碰任何权限提示：受影响的对象全部是机器人自己创建的置顶。
// 只撤 operator 是机器人的，人手动置顶的一条都不会动（见 sweep）。
async function unpin(messageId) {
  if (!messageId) return false;
  const r = await lark(['im', 'pins', 'delete', '--as', 'bot', '--yes',
    '--message-id', messageId]);
  return !!(r && r.ok);
}

// 群里的全部置顶：[{ messageId, operatorId, operatorType, createdAt }]
//
// 一次一页地翻，最多 MAX_PAGES 页（50×8=400 条），防止群被别的东西刷爆时
// 无限翻页把状态卡刷新卡住。翻不完就只处理前 400 条——它们足够覆盖最近的。
async function listPins(chatId, maxPages = 8) {
  if (!chatId) return [];
  const out = [];
  let token = null;
  for (let page = 0; page < maxPages; page += 1) {
    const args = ['im', 'pins', 'list', '--as', 'bot', '--chat-id', chatId, '--page-size', '50'];
    if (token) args.push('--page-token', token);
    const r = await lark(args);
    if (!r || !r.ok || !r.data) break;
    for (const it of r.data.items || []) {
      out.push({
        messageId: it.message_id,
        operatorId: it.operator_id || '',
        operatorType: it.operator_id_type || '',
        createdAt: Number(it.create_time) || 0,
      });
    }
    token = r.data.page_token;
    if (!r.data.has_more || !token) break;
  }
  return out;
}

// 当前机器人自己的 app_id。用来区分「我们置的」和「人置的」。
// 只读一次，进程内缓存——auth status 要 1 秒多。
let cachedAppId = null;
async function botAppId() {
  if (cachedAppId !== null) return cachedAppId;
  const r = await lark(['auth', 'status']);
  cachedAppId = (r && r.appId) || '';
  return cachedAppId;
}

module.exports = { unpin, listPins, botAppId };

// 给自测用：缓存会跨用例，重置一下
module.exports._resetAppId = () => { cachedAppId = null; };

// 扫一遍群里的置顶，把「不再需要」的撤掉，最多撤 budget 条。
//
// keep 是要保留的 messageId 集合：活窗口的话题根 + 当前有效状态卡。
// 只撤我们自己置的（operator 是机器人的 app_id），人手动置顶的不动。
//
// 为什么按预算分批：一次 pins delete 约 1.5 秒，235 条要六七分钟，
// 一轮里全做完会把状态卡刷新堵死。每轮撤几条，几轮自然就清干净了。
async function sweep({ chatId, keep, budget = 10, log }) {
  if (!chatId) return { removed: 0 };
  const appId = await botAppId();
  const all = await listPins(chatId);
  // 刚置顶的先不动：会话表偶尔会漏一拍（窗口刚起、Zombie 未回收），
  // 那一拍里窗口看起来是「已关闭」，撤了它下一秒又要重新置顶，白白折腾。
  // 五分钟足够跨过任何一次抖动，对清理来说毫无影响。
  const cutoff = Date.now() - 5 * 60000;
  let removed = 0;
  for (const p of all) {
    if (removed >= budget) break;
    if (keep.has(p.messageId)) continue;
    if (p.createdAt && p.createdAt > cutoff) continue;
    if (p.operatorType !== 'app_id' || (appId && p.operatorId !== appId)) continue;
    if (await unpin(p.messageId)) removed += 1;
  }
  if (removed && log) log(`清理了 ${removed} 条不再需要的置顶（共 ${all.length} 条）`);
  return { total: all.length, removed };
}

module.exports.sweep = sweep;
