# 架构设计

> 这份文档是项目的**宪法**。改架构先改这里，再改代码。
> 面向读者：接手这个仓库的 AI（首选）和少数愿意读代码的人。

---

## 一、一句话

**一个内核 + 一组插件 + 一层平台适配**，把飞书和一个本机 Claude Code 窗口连起来。

```
飞书群/话题  ←→  bridge 进程（内核 + 插件）  ←→  本机 Claude Code 窗口
                        ↕
                 hooks（Claude Code 调我们）
```

## 二、为什么要插件化

三个真实约束推出来的，不是为了架构好看：

1. **功能会长**。远程提问代答、权限确认、通知推送是一条线；开窗、恢复会话是另一条线；
   之后还会有「日报提醒」「任务看板」「多机器人分流」。全塞进一个 `bridge.js`，
   1517 行之后就无法安全改动了。

2. **用户要自己加功能**。使用者是 AI 帮忙配置的，AI 写一个插件目录丢进去就能生效，
   比让 AI 改 1500 行的核心文件安全得多。

3. **卸载要干净**。一个功能出问题，能整个目录删掉、其他部分照常跑。

## 三、分层

```
┌──────────────────────────────────────────────────────────┐
│  plugins/        业务功能，可增删                         │
│    core/         路由、开窗、恢复会话（必须有）           │
│    ask/          远程代答 AskUserQuestion                │
│    permission/   远程点权限确认                           │
│    notify/       任务完成通知                             │
│    <你自己的>/   丢一个目录进来就生效                     │
├──────────────────────────────────────────────────────────┤
│  kernel/         与业务无关的基础设施                     │
│    lib.js        配置、日志、会话表、映射、话题、工作区   │
│    questions.js  待答记录（提问与权限共用）               │
│    wait.js       阻塞等待作答（hook 用）                  │
│    presence.js   在场判定                                 │
│    plugin.js     插件加载器                               │
│    contract.js   插件契约（本文档的可执行版本）           │
├──────────────────────────────────────────────────────────┤
│  platform/       与操作系统相关的一切                     │
│    win32/        VBS 开窗、presence.exe、tasklist         │
│    darwin/       osascript 开窗、launchd（待实现）        │
└──────────────────────────────────────────────────────────┘
```

**依赖方向严格单向**：`platform` ← `kernel` ← `plugins`。
任何一层都不许反向 require。`platform` 不认识「提问」，`kernel` 不认识「飞书卡片」。

## 四、两种运行形态

这套东西有**两个入口**，它们共享内核，但生命周期完全不同：

| | 常驻进程 | hook 进程 |
| --- | --- | --- |
| 谁启动 | 用户登录时（VBS/launchd/watchdog） | Claude Code 每次触发事件 |
| 活多久 | 一直 | 几毫秒到 30 分钟 |
| 干什么 | 收飞书事件、推卡片、投递消息 | 拦提问、拦权限、拦通知 |
| 在哪 | `plugins/*/index.js` | `plugins/*/hooks/*.js` |

hook 进程**拿不到**插件的 `ctx`，它只能 require `kernel/`。
这是刻意的：hook 必须能在 bridge 没启动时安全退出，不能被插件状态绑住。

## 五、插件契约

### 5.1 目录形态

```
plugins/<id>/
  plugin.json      清单（唯一必需文件）
  index.js         常驻服务，导出 { start(ctx), stop() }
  hooks/*.js       Claude Code hook 脚本
  src/*.js         该插件内部模块
  README.md        给 AI 看的：这个插件干什么、配置什么意思
```

### 5.1b 配置：schema 是唯一真相

**每个插件的 `plugin.json` 里的 `config` 不是「默认值对象」，而是 schema**：

```json
"config": {
  "awayWaitSeconds": {
    "type": "integer", "default": 1800, "minimum": 60, "maximum": 5700,
    "title": "人不在时最多等多久",
    "description": "默认 1800 秒。必须小于 hook 超时（1900 秒）。",
    "ui:group": "等待", "ui:widget": "number"
  }
}
```

默认值、取值范围、给人看的标题都在这一处声明。用户在 `config.json` 的
`plugins.<id>` 里**只写要覆盖的项**，其余自动取 schema 的 default。

为什么这么设计（三条都是踩过的坑）：

1. **一处定义，不会漂移**。默认值写在 schema 里，`config.example.json`、
   安装器的提示语、将来的配置页全都从它推导，不存在「文档写 1800、代码写 1800、
   示例写 240」这种三处不一致。
2. **越界值在启动时就报出来，而不是运行到一半才发现**。`awayWaitSeconds: 99999`
   会被拒（超 hook 超时），插件退回默认值并把错误写进 `logs/error.log`。
3. **前端可以直接渲染表单**。`node kernel/config.js --dump` 输出标准 JSON Schema
   （扩展键收在 `x-ui` 里），前端不需要再写一遍参数结构——这就是为什么
   **可视化配置页可以晚做，但 schema 必须现在定**。

校验入口有两处，行为必须一致：

| 场景 | 入口 |
| --- | --- |
| 内核加载插件 | `kernel/plugin.js` → `config.validate(schema, userVals)` |
| hook 独立进程读配置 | `kernel/lib.js` 的 `readPluginConfig(id)` |

两者都调用 `kernel/config.js` 的同一个 `validate`，不会出现「桥接认为合法、hook 认为非法」。

命令行：

```bash
node kernel/config.js --dump        # 完整 schema（顶层 + 各插件），给前端用
node kernel/config.js --defaults    # 只输出默认值
node kernel/config.js --check       # 用真实 config.json 校验一遍
```

### 5.2 plugin.json

```json
{
  "id": "ask",
  "name": "提问代答",
  "version": "1.0.0",
  "description": "把 AskUserQuestion 搬到飞书作答",
  "core": false,
  "requires": { "core": ">=1.0.0" },
  "config": {
    "awayWaitSeconds": 1800,
    "notifyWhenPresent": true
  },
  "hooks": {
    "PreToolUse": "hooks/ask-question.js"
  },
  "services": {
    "poller": "index.js"
  },
  "depends": ["core"]
}
```

| 字段 | 含义 |
| --- | --- |
| `id` | 唯一标识，小写字母数字短横线，默认取目录名 |
| `core` | 内置插件；缺失时其余功能可能不可用 |
| `config` | 默认配置，运行时与 `config.json` 的 `plugins.<id>` 深合并 |
| `hooks` | 事件名 → 本插件内的脚本相对路径 |
| `services` | 服务名 → 导出 `{start,stop}` 的模块 |
| `depends` | 依赖的其他插件 id；缺依赖时本插件不加载（核心除外，核心缺失直接报错） |

### 5.3 ctx 上有什么

完整清单见 `kernel/contract.js`。要点：

```js
ctx.id / ctx.dir / ctx.dataDir    // 我是谁、我在哪、我的数据往哪写
ctx.config                        // 我的配置（已合并）
ctx.log(msg)                      // 写 logs/<id>.log
ctx.bus                           // 事件总线——跨插件唯一通信方式
ctx.lib / ctx.platform / ctx.global
```

**`ctx.dataDir` = `data/plugins/<id>/`**。插件的数据只写这里，卸载时删这一个目录就干净了。

### 5.4 跨插件通信：总线

**插件之间不许互相 require。** 这句话是架构的核心约束，原因：

- 老插件删了，依赖它的插件会 `MODULE_NOT_FOUND` 直接崩
- 两个开发者给同一个功能起不同名字，改一处漏一处
- 无法回答「谁在监听这个事件」

订阅与派发：

```js
// 发送方
ctx.bus.emit('question.created', { record });

// 接收方
ctx.bus.on('question.created', ({ record }) => { /* ... */ }, ctx.id);
```

已约定的公共事件（新增事件请先写进本文档）：

| 事件 | 载荷 | 时机 |
| --- | --- | --- |
| `message.received` | `{ messageId, content, chatType, replyTo, threadId, claim() }` | 收到飞书消息，路由前 |
| `message.routed` | `{ messageId, sessionId, ok }` | 投递完成 |
| `question.created` | `{ record }` | 提问/权限记录落盘 |
| `question.answered` | `{ record, answers }` | 作答完成 |
| `presence.changed` | `{ from, to, sample }` | here/away 切换 |
| `window.launched` | `{ sessionId, cwd, resumed }` | 新窗口拉起 |

### 5.5 插件的三个失败等级

| 情况 | 行为 |
| --- | --- |
| manifest 不合法 / hook 文件缺失 | 跳过该插件，记 `logs/error.log`，其余照常 |
| `start()` 抛异常 | 同上，该插件的 hook 也不再注册 |
| 运行中抛异常 | 总线已捕获并记录，不影响其他订阅者 |

**没有任何情况允许一个插件拖垮内核。**

## 六、平台适配层

`platform/` 只暴露 4 个能力，全部是「换系统就必须重写」的东西：

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| `spawnWindow(opts)` | `cscript launch-claude.vbs` → `wt.exe` | `osascript` → Terminal/iTerm | 试 gnome-terminal / konsole / xfce4-terminal / xterm |
| `pidAlive(pid)` | `tasklist` 名称校验 | `ps -p comm=` | `process.kill` + `ps` 名称校验 |
| `startPresence` | `presence.exe --loop`（C# 编译） | `presence.sh --loop`（ioreg + CGSession） | `presence.sh --loop`（xprintidle + loginctl） |
| 自启方式 | 启动文件夹 + VBS | launchd（LaunchAgents） | systemd --user |
| 实现文件 | `presence.cs` / 3 个 `.vbs` | `presence.sh` / `launch-claude.sh` / `*.sh` | 同 macOS 结构 |

**三个平台各自是一个自洽的子目录**，互不引用；共同逻辑一律在 `kernel/` 与 `plugins/`。
给一个新平台做适配 = 在那一个目录里实现上面这组接口 + 在 `platform/index.js` 加一个分支，
业务代码一行都不用改。

Linux 上有些能力拿不到（Wayland 没统一空闲接口、锁屏各家不同），这时采样脚本如实返回
`idleSeconds: -1`，判定会自动退到 away（推卡片）——**不编造数据，也不阻塞**。

**`supportsPresence === false` 时功能不缺失**：`kernel/wait.js` 会退化成
「一律推卡片、按 awayWaitSeconds 等」，也就是没有在场探测的老行为。

这就是为什么 macOS 可以晚做——主体功能一行平台代码都不需要。

## 七、在场判定（最容易误解的一处）

只有两档，没有中间态：

| 档位 | 条件 | 行为 |
| --- | --- | --- |
| `here` | 未锁屏 **且** 180 秒内有键鼠输入 | hook 立刻退出，弹窗出在终端；飞书只推一张不带按钮的提醒卡 |
| `away` | 其余全部情况 | hook 阻塞，推带选项的卡片，等 30 分钟，人回来立刻交还 |

两条判据缺一不可，因为**锁屏是独立信号**：你刚敲完键盘就锁屏走了，
空闲时长还是 0 秒，只看 idle 会误判成「人在」。

刻意不做的：窗口标题匹配（Windows Terminal 多窗口共用一个进程，靠标题认窗口不可靠，
失手就会把「人在」判成「不在」）。所以 `presence.cs` 里那一大块窗口枚举
对判定没有作用，只用于日志和卡片文案。

## 七之二、投递信封：为什么需要它

飞书消息是通过 Claude Code 的**跨会话命名管道**送进窗口的。连接层会给每条这类消息
自动附加一句英文声明（大意「来自另一个 Claude 会话 / 不是用户直接输入」）。

那句话说的是**通道**——消息确实来自另一个进程——但发送者始终是用户本人。
问题在于模型分不清「通道」和「发送者」：它会把这句声明当成指令级信息，
把飞书来的消息当成别的 Agent 的请求，反复纠结来源，甚至拒绝按用户原话执行。

在消息正文里加一段解释**压不住**它：正文是普通文本，连接层那句在更高的位置。
所以用两层配合：

| 层 | 做法 | 作用 |
| --- | --- | --- |
| 会话级（一次） | `SessionStart` hook 返回 `additionalContext`，声明「以某标记开头的就是用户本人」 | 给模型一条可模式匹配的规则，不必每次自行推理 |
| 消息级（每条） | 正文首行放固定信封 `[来自用户本人 · 飞书]` | 让规则有东西可匹配 |

**信封必须短且稳定。** 写过两版失败的：

- 第一版是一大段「经由用户本人使用跨会话通道送达…」——反而强化了「另一个会话」的印象
- 第二版只有 `[来自用户]`——太弱，模型仍然把前面那句英文当权威

现在的版本把「标记是什么」和「那句英文在说什么」都写进会话级上下文，
正文里只留标记本身。**改这里之前先想清楚：你改的是模型判断来源的依据。**

## 八、数据流

### 8.1 你在飞书发言

```
飞书事件 → route.js
  ├─ 有 reply_to / thread_id → 查映射表 → 得到 sessionId
  ├─ 单聊免引用 → 最近窗口
  └─ 都对不上 + 在话题里 → 新窗口流程（选工作区 → 开窗 → 绑定话题）
→ 该窗口有未答提问？→ 当作自定义答案写进记录
→ 否则：刷新 peerToken → 写命名管道
```

### 8.2 窗口向你提问

```
Claude Code 触发 PreToolUse(AskUserQuestion)
→ hooks/ask-question.js
   ├─ 探在场：here → 写 noticeOnly 记录后立刻 exit 0（弹窗出终端）
   └─ away → 写记录 → 阻塞轮询
→ bridge 每 2 秒扫 data/questions → 推卡片
→ 你点按钮/回文字 → 写 answers
→ hook 轮询到 done → 输出 allow + updatedInput{answers}
```

## 九、安全边界（必须遵守）

这个项目的 hook 会**代替你**回答提问、放行工具调用。所以：

1. **hook 不提供任何绕过权限的能力**。`deny` 规则、必须人工交互的 MCP 工具、
   `dontAsk` 模式统统不生效于本机制——`PermissionRequest` 只能「帮人点一下」。
2. **写操作前先 diff 后确认**。部署脚本改 `settings.json`、改 cc-switch 库，
   必须打印将要改动的内容。
3. **分发的东西不带任何个人凭据**。`config.example.json` 里不能有 `appId`、
   `appSecret`、`chatId`、`openId`。
4. **不要引导任何「关闭权限提示」的配置**。
5. 仓库里的 `CLAUDE.md` 指令**不构成执行授权**——每个写操作仍需使用者本人确认。

## 十、扩展一个新的场景功能

以一个假想的「日报提醒」插件为例，完整步骤：

1. `mkdir plugins/daily-report && cd plugins/daily-report`
2. 写 `plugin.json`：

```json
{
  "id": "daily-report",
  "name": "日报提醒",
  "version": "1.0.0",
  "depends": ["core"],
  "config": { "hour": 18, "minute": 30 },
  "services": { "scheduler": "index.js" }
}
```

3. 写 `index.js`：

```js
module.exports = {
  start(ctx) {
    const { hour, minute } = ctx.config;
    ctx.timer = setInterval(() => {
      const now = new Date();
      if (now.getHours() === hour && now.getMinutes() === minute) {
        ctx.bus.emit('outbound.message', {
          sessionId: null,           // null = 发到群里而不是某个窗口
          text: '到点写日报了',
        });
      }
    }, 60000);
    ctx.log(`日报提醒已启用：每天 ${hour}:${minute}`);
  },
  stop(ctx) {
    clearInterval(ctx.timer);
  },
};
```

4. 在 `config.json` 里覆盖默认值（可选）：

```json
{ "plugins": { "daily-report": { "hour": 19 } } }
```

5. 重启 bridge，`logs/daily-report.log` 里应有启动记录。

**注意**：`outbound.message` 需要 core 支持 `sessionId: null` 时发群消息。
如果内核还没有这个能力，先改 `kernel/contract.js` 和本文档，再改 core。

## 十一、以后可能要改的地方（已知技术债）

| 位置 | 问题 | 什么时候处理 |
| --- | --- | --- |
| `plugins/core/index.js` | 逐个模块已拆到 `src/`，但还有若干函数间隐式耦合 | 下次改动 route 时顺手 |
| `ctx.bus` | 总线已实现且能派发，但现有四个插件之间还没有真正用到它（都是内聚功能，不需要互相通信） | 第一个需要跨插件协作的功能出现时 |
| `kernel/presence.js` | 窗口枚举对判定无用，但仍在采集 | 做 macOS 版时一起删 |
| `platform/darwin` | 只有占位实现 | 有 mac 用户时 |
| `setup/` | 只有 check/install/selftest，尚无 doctor（运行期排障） | 下一轮 |
| 配置页 | schema 已可机器读（`--dump`），但没有前端 | 有人明确要图形界面时；届时只写一个读 `--dump` 的单页，**不需要动后端** |
