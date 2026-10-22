'use strict';

// 飞书应用所需的权限与事件——给用户复制到开发者后台用。
//
//   node setup/feishu/scopes.js           打印要复制的 JSON（权限批量导入用）
//   node setup/feishu/scopes.js --check   用当前 lark-cli 凭据核对哪些权限还缺
//   node setup/feishu/scopes.js --json    同一份数据，机器读
//
// 为什么单独成文件：早期文档里让用户「开 im:message 等 4 个权限」是错的——
// 4 个权限跑不起这套功能。真实需求是 8 个，而且事件订阅和回调配置还各要配一处。
// 权限名写错一个的表现是「功能悄悄少了」（比如点不了卡片按钮），
// 而飞书后台支持整份 JSON 导入，所以直接给文件比给列表可靠。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;
const SCOPES = JSON.parse(fs.readFileSync(path.join(HERE, 'scopes.json'), 'utf8'));
const EVENTS = JSON.parse(fs.readFileSync(path.join(HERE, 'events.json'), 'utf8'));

const ARGS = new Set(process.argv.slice(2));

// 每条权限对应代码里的哪一处调用。做排查时「为什么需要这个」比「它叫什么」更有用。
const WHY = {
  'im:message.group_msg': '收群里的消息（话题群里打字 → 桥接）',
  'im:message.p2p_msg:readonly': '收单聊消息（事件订阅的 schema 要求）',
  'im:message:readonly': '读消息：卡片回调取 card_content、查话题根、下载图片',
  'im:message:send_as_bot': '以机器人身份发卡片、回复、新建话题',
  'im:message:update': '作答后把卡片改成结果态（card/update）',
  'im:message.pins:write_only': '新窗口的话题置顶',
  'im:resource': '下载用户发到话题里的图片',
  'im:chat:read': '列机器人所在的群（verify 用它校验 chatId）',
};

function main() {
  const list = SCOPES.scopes.tenant;

  if (ARGS.has('--check')) {
    const bin = (() => {
      try { return JSON.parse(fs.readFileSync(path.resolve(HERE, '..', '..', 'config.json'), 'utf8')).larkCli; } catch (_) { return null; }
    })() || 'lark-cli';

    // auth scopes 只返回**用户级**已授权清单；机器人权限在后台配置，CLI 读不到。
    // 所以这里只能给出「用户级里已经有哪些」作为参考，不能断言缺不缺——
    // 编一个假的结论比不查更糟。
    const r = spawnSync(bin, ['auth', 'scopes', '--json'], { encoding: 'utf8', timeout: 30000, shell: process.platform === 'win32' });
    if (r.status !== 0) {
      console.error('读不到权限清单，直接去后台核对吧。');
      process.exit(1);
    }
    let j = null;
    try { j = JSON.parse((r.stdout || '').slice((r.stdout || '').indexOf('{'))); } catch (_) {}
    const have = new Set((j && j.userScopes) || []);
    console.log('注意：下面是**用户级**已授权清单。本项目的功能全走机器人身份，');
    console.log('机器人权限只能在开发者后台看，CLI 读不到。这里只作参考。\n');
    list.forEach((s) => console.log(`${have.has(s) ? '✓' : '·'} ${s}  ${WHY[s] || ''}`));
    console.log('\n以开发者后台「权限管理」实际显示为准。可用批量导入：');
    console.log(`  ${path.join(HERE, 'scopes.json')}`);
    return;
  }

  if (ARGS.has('--json')) {
    console.log(JSON.stringify({ scopes: SCOPES.scopes, events: EVENTS, why: WHY }, null, 2));
    return;
  }

  console.log('把下面整段复制到 开发者后台 → 权限管理 → 批量导入：\n');
  console.log(fs.readFileSync(path.join(HERE, 'scopes.json'), 'utf8').trim());
  console.log('\n---\n');
  console.log(`共 ${list.length} 项，每一项都有实际用途（不用的权限不要，避免过度授权）：\n`);
  list.forEach((s) => console.log(`  ${s.padEnd(30)} ${WHY[s] || ''}`));

  console.log('\n---\n');
  console.log('另外两处配置（在后台不同页面，漏掉回调的表现是「卡片按钮点了没反应」）：\n');
  console.log('事件订阅（长连接模式）：');
  EVENTS.event_subscribe.forEach((e) => console.log(`  · ${e.key}  ${e.name} —— ${e.why}`));
  console.log('\n回调配置：');
  EVENTS.callback_subscribe.forEach((e) => console.log(`  · ${e.key}  ${e.name} —— ${e.why}`));
  console.log('\n改完权限必须**重新发布版本并等管理员审批**，否则不生效。');
}

main();
