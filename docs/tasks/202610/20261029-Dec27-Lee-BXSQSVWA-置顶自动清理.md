# 20261029-Dec27-Lee-BXSQSVWA 置顶自动清理

- **任务 ID**：20261029-Dec27-Lee-BXSQSVWA
- **任务名**：置顶自动清理
- **创建人**：Dec27-Lee
- **创建时间**：2026-10-29 16:07:42
- **最后更新人**：Dec27-Lee
- **更新时间**：2026-10-29 16:07:42
- **相关材料**：
  - [任务索引](../INDEX.md)
  - [话题实时状态卡](20261024-Dec27-Lee-8ZM5NK28-话题实时状态卡.md)

## 现状与目标

用户在飞书「置顶」里找不到要用的会话——列表里堆满已经关掉的窗口。

查下来：群里 235 条置顶，其中 **220 条是换卡残留**、12 条是已关闭窗口的话题根、
只有 2 条是活窗口当前的状态卡。根因在 `plugins/status/index.js` 的 `createCard()`：
每次换卡都 `im pins create` 新卡，**从来没取消旧卡的 pin**。状态卡日志里
「状态卡已创建」有 303 次，就是这些。

目标：置顶跟窗口生命周期走——活窗口的话题和卡片留着，其余全撤。

## 接口调研

| 想做的事 | lark-cli | 结论 |
| --- | --- | --- |
| 取消置顶 | `im pins delete --message-id <om_xxx> --yes` | 支持。真实请求 `DELETE /open-apis/im/v1/pins/{message_id}`，机器人身份可删自己置的 |
| 列出置顶 | `im pins list --chat-id <oc_xxx>` | 支持，每页 50，带 `operator_id`/`operator_id_type`/`create_time` |
| 订阅 / 取消订阅话题 | 无 | 飞书 IM 开放接口没有「话题订阅」概念。`im.threads` 只有 `forward` 一个方法 |
| 近似替代 | `im +flag-create / +flag-cancel`（书签）、`im chat.user_setting`（免打扰） | 都是 user 身份，且是另一个列表，帮不上 |

所以「不好找」只能靠管 pin 解决。

## 方案

清理挂在已有生命周期上，不新增定时器概念：

1. **换卡时**（`retireCard`）：旧卡 patch 成灰卡的同时撤掉它的置顶。
2. **每分钟兜底**（`maybeSweepPins`，挂在状态卡轮询里）：列一遍群里的置顶，
   撤掉不属于「活窗口话题根 + 当前有效卡」的，每次最多 10 条。

保留集由 `liveSessions()` 现算，不落盘——窗口关掉后下一轮自然就不在里面了。

三道安全阀：

- **只撤自己置的**：`operator_id_type === 'app_id'` 且 `operator_id` 等于本机器人
  `app_id`（从 `auth status` 读，进程内缓存）。人手动置顶的一条不动。
- **5 分钟内的不动**：会话表偶尔漏一拍（窗口刚起、pid 未回收），那一拍里窗口
  看起来是「已关闭」，撤了下一秒又要重新置顶。
- **每分钟最多 10 条**：一次 `pins delete` 约 1.5 秒，235 条要六七分钟，
  一轮做完会把状态卡刷新饿死。

配置项 `plugins.status.autoUnpin`（默认开），配置页在「实时状态卡」组里。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `plugins/status/src/lark.js` | 新增。从 `index.js` 抽出异步 lark 调用（`pins.js` 也要用） |
| `plugins/status/src/pins.js` | 新增。`unpin` / `listPins` / `botAppId` / `sweep` |
| `plugins/status/index.js` | `retireCard` 撤置顶并改 await；`drain` 末尾调 `maybeSweepPins`；删掉本地 `lark` |
| `plugins/status/plugin.json` | 新增 `autoUnpin` |
| `setup/selftest/mock-preload.js` | `im pins list/create/delete` 落地到 `pins.jsonl`（**不**混进 outbox） |
| `setup/selftest/run.js` | 新增 9d2 节，7 条用例 |

## 验证

- 自测 146 项全绿（新增 7 条）；故意删掉 `keep.has()` 判断，三条用例立刻变红，恢复后转绿。
- 一次性清了生产群的历史遗留：237 条 → 5 条，再跑一轮 sweep → 2 条（只留活窗口的当前卡）。
- 重启桥接后 `logs/status.log` 出现「清理了 3 条不再需要的置顶（共 5 条）」，自动清理生效。

## 风险

- `im pins delete` 是 lark-cli 的 high-risk-write，代码里带 `--yes`。这不是绕过确认：
  撤的全部是机器人自己置的、已被替换的卡片，用户明确要求了这个行为。人置的一条不动。
  注释里写清了这一点。
- `sweep` 每分钟发一次 `pins list`（含分页）+ 至多 10 次 delete，都是异步串行，
  不阻塞主循环，但会让状态卡刷新慢一拍。已在 `SWEEP_INTERVAL_MS` 里留了调节点。
