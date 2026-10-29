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

1. **功能会长**。窗口提问、工具授权、通知推送是一条线；开窗、恢复会话是另一条线；
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
│    status/       话题里的实时状态卡（原地刷新）           │
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
│    darwin/       osascript 开窗、presence.sh、launchd     │
│    linux/        终端探测开窗、presence.sh、systemd       │
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
    "type": "integer", "default": 1800, "minimum": 60, "maximum": 1800,
    "title": "人不在时最多等多久",
    "description": "默认 1800 秒。上限也是 1800：hook 超时 1900 秒，再大只会被系统先收走。",
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
   （扩展键收在 `x-ui` 里），前端不需要再写一遍参数结构——可视化配置页
   （`setup/config-ui.js`，见 5.1c）就是这么做的，页面里没有任何插件名或字段名。

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

### 5.1c 可视化配置页：为什么是 `setup/` 而不是插件

`node setup/config-ui.js` 起一个只监听 `127.0.0.1` 的页面，在浏览器里改 `config.json`。
表单的字段、分组、控件、默认值、取值范围**全部从 `dumpSchema()` 推导**，
页面里没有任何插件 id 或字段名——加一个插件、给插件加一项配置，刷新就出现。

它**不是** `plugins/` 下的插件，这是刻意的：

| | 做成插件 | 做成 `setup/` 下的独立进程（现状） |
| --- | --- | --- |
| 配置坏了时能不能用 | 不能——插件加载走的正是那份坏配置 | 能，只要 node 能跑 |
| 攻击面 | 一个常驻、能代替用户放行工具调用的进程多开一个端口 | 只在人主动启动的几十秒里存在 |
| 语义 | 「业务功能」 | 「安装/维护工具」，与 check/install/verify 同类 |

决定性的是第一行：**配置是桥接的启动前置条件**，把改配置的能力挂在一个
「配置正确才能起来」的进程里，等于把钥匙锁在门里。所以插件化的要求换一条路径满足——
**不认插件名，全部从 schema 推导**。自测 `9j` 里造了一个假插件目录专门守这条性质。

页面分两页：「通用配置」（工具自身：清理规则、外观、运行状态）与「飞书消息」
（所有和飞书有关的：群与 lark-cli、工作目录、消息显示、提醒、恢复会话）。
**页面清单与字段归属都来自后端**：`kernel/config.js` 的 `PAGES` 定义有哪几页，
每个字段自己用 `ui:page` 声明属于哪一页。所以核心插件的「置顶 / @谁 / 候选几个」
写在 `plugins/core/plugin.json` 里，却出现在「飞书消息」页——是数据说的，页面没写死。
新增一个顶层配置项必须写 `ui:page`（自测 `9j` 有一条用例守这个）。

写盘有四条规则，都在 `setup/config-ui/server.js` 的 `applyValues` 里：

| 规则 | 为什么 |
| --- | --- |
| 只动**这次被改动过**的键 | 无条件按默认值清理的话，打开页面什么都不做、点保存，文件里写明着的默认值会被一条条删掉 |
| 改回到默认值的键删掉 | 与「只写要覆盖的项」的约定一致，文件不会越写越长 |
| 认不出的键原样保留 | 页面不渲染的东西不能被它悄悄删掉（含已卸插件的残留配置、人写的 `_说明`） |
| 校验有错就不写 | save 里再跑一遍 `resolveAll`，与前端的校验是同一个函数 |

另外：`config.json` 解析失败时**禁止保存**（否则会用空对象覆盖掉用户的群号等配置），
写盘前留一份 `config.json.bridge-bak`。

访问控制：随机令牌打进 URL、`/api/*` 必须带、`timingSafeEqual` 比对，
并校验 `Host`（挡 DNS rebinding）与 `Origin`（挡跨站写）。**本机不是可信边界**——
任意网页都能向 `127.0.0.1` 发请求，而写 `config.json` 等于能改这台机器怎么跑。

刻意**不做**「页面上一键重启桥接」的反面：**做了，但加了闸门**。配置写坏时重启等于
「老进程已停、新进程起不来 = 整台机器失联」，而配置页的典型场景恰恰是人不在电脑前。
所以 `setup/config-ui/restart.js` 在 spawn 之前先跑一遍与桥接启动时相同的 `resolveAll`，
有错就拒绝重启并说明原因；停掉旧进程后等它真的退出，再拉起新进程并等锁被**新 pid** 写下。

### 5.2 plugin.json

```json
{
  "id": "ask",
  "name": "窗口提问",
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

`platform/` 只暴露 8 个能力，全部是「换系统就必须重写」的东西：

| 能力 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| `spawnWindow(opts)` | `cscript launch-claude.vbs` → `wt.exe` | `osascript` → Terminal/iTerm | 试 gnome-terminal / konsole / xfce4-terminal / xterm |
| `pidAlive(pid)` | `tasklist` 名称校验 | `ps -p comm=` | `process.kill` + `ps` 名称校验 |
| `startPresence` / `presenceRunning` / `presencePid` / `stopPresence` | `presence.exe --loop`（C# 编译） | `presence.sh --loop`（ioreg + CGSession） | `presence.sh --loop`（xprintidle + loginctl） |
| `stopAllPresence()` | 按 `ExecutablePath` 收掉本目录的 presence.exe | `ps` 匹配 `presence.sh` 路径 | 同 macOS |
| 自启方式 | 启动文件夹 + VBS | launchd（LaunchAgents） | systemd --user |
| 实现文件 | `presence.cs` / 3 个 `.vbs` | `presence.sh` / `launch-claude.sh` / `*.sh` | 同 macOS 结构 |

`stopAllPresence()` 存在的原因：采样器是 detached 启动的，bridge 被强杀或换掉后
它会继续活着并每秒写 `data/presence.json`。只杀 bridge 自己那一份子进程不够——
换目录（`setup/move.js`）时必须把旧位置的孤儿也收掉，否则它一直往旧路径写。

**三个平台各自是一个自洽的子目录**，互不引用；共同逻辑一律在 `kernel/` 与 `plugins/`。
给一个新平台做适配 = 在那一个目录里实现上面这组接口 + 在 `platform/index.js` 加一个分支，
业务代码一行都不用改。

Linux 上有些能力拿不到（Wayland 没统一空闲接口、锁屏各家不同），这时采样脚本如实返回
`idleSeconds: -1`，判定会自动退到 away（推卡片）——**不编造数据，也不阻塞**。

**`supportsPresence === false` 时功能不缺失**：`kernel/wait.js` 会退化成
「一律推卡片、按 awayWaitSeconds 等」，也就是没有在场探测的老行为。

### 6.1 hook 里的 node 用绝对路径

`setup/hooks-config.js` 写进 settings 的 command 形如
`"<node 绝对路径>" "<脚本绝对路径>"`，**不用裸 `node`**。

原因：hook 由 Claude Code 在非交互 shell 里起，那个环境拿到的 PATH 常常不含
nvm / volta / fnm / asdf 的 shim 目录——macOS 上用 nvm 装 node 的人极多。裸 `node`
会直接 command not found，表现是**所有 hook 静默失效**（没有报错弹窗，只是功能不动）。

代价是换 node 版本后路径失效，所以 `check.js` 有 `hooks-node` 一项会核对；
`verify.js` / `update.js` 解析脚本路径时也走 `hooks-config.scriptPathFromCommand()`，
不要自己写 `/node\s+(.+\.js)/`——node 的绝对路径本身含 `node`，那个正则匹配不上，
校验会静默通过。

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

### 8.2b 窗口此刻在干什么（status 插件）

不经过 hook，也不产生任何新消息：

```
bridge 每 2 秒 → plugins/status/index.js
  ├─ liveSessions()  读 ~/.claude/sessions/<pid>.json 的 status（busy/idle）
  ├─ probe()         读转录尾部，找**没闭合**的 tool_use + 本轮最后一句正文
  └─ 内容签名变了？
       ├─ 是 → patch 已有卡片（im messages patch）；从未发过则 reply 到话题根
       └─ 否 → 什么都不发
```

两条硬约束，改这里时别弄丢：

1. **只能 patch，不能发新消息。** 发新消息就进未读列表、把话题顶起来，
   这个功能的存在意义就是把「看进度」和「收推送」分开。
2. **不能阻塞主循环。** `kernel/lib.js` 的 `larkSync` 是 `spawnSync`，
   实测一次 1.5 秒；状态卡每 2 秒一次，用它会把事件消费和卡片回调一起堵住。
   所以这个插件自己起异步 `spawn`，串行排队，`MAX_PER_TICK` 控制每轮刷几张。

**置顶的生命周期**（`src/pins.js`）：话题根和状态卡创建时会置顶，用起来方便，
但置顶只增不减就会堆满「置顶」列表——关掉的窗口和换掉的旧卡都还挂在那儿，
真要找在用的反而翻不到（实测一天 235 条）。所以：

| 时机 | 谁做 | 撤什么 |
| --- | --- | --- |
| 换卡 | `retireCard()` | 旧卡的置顶 |
| 每分钟兜底 | `sweep()` | 不属于「活窗口话题根 + 当前有效卡」的 |
| 关窗 | 同上（下一轮 sweep） | 话题根和卡片 |

`sweep()` 只撤 `operator_id_type === 'app_id'` 且 appId 是本机器人的，
**人手动置顶的一条都不动**；置顶时间在 5 分钟内的也跳过（会话表偶尔漏一拍，
窗口会短暂显示成「已关闭」，撤了下一秒又要重新置顶）。每分钟 budget 10 条，
防止一次 235 条撤不完把状态卡刷新饿死。

### 8.3 「一个窗口只能有一棵树」——话题归属的不变式

`data/threads/<sessionId>.json` 是**唯一**的话题归属记录。凡是要往飞书发东西的模块，
都必须优先读它，读不到才允许开新话题；而一旦开了，**必须立刻写回去**。

三个写入时机：

| 时机 | 代码位置 | 为什么 |
| --- | --- | --- |
| 桥接开窗 / 恢复会话 | `core/src/launch.js` | 用户在飞书里选定了工作区，那棵树就是它的 |
| 窗口首次在某话题里收到消息 | `core/src/route.js` | 终端里手动开的窗口没有归属，第一条消息就是绑定时 |
| 卡片在群里自成新话题 | `core/src/qcards.js` | 卡片开了树却不登记，notify 会以为没树，再开一棵 |

**违反这条不变式的表现是「话题漂移」**：在 A 话题里答题，答完 Claude 的回复出现在 B 话题。
原因是提问卡在 `threads` 里查不到归属 → 自己新开一棵 B；随后 notify 也查不到 → 再开 C。
三个模块各自「正确地」退了同一个兜底分支，合起来就把一个窗口拆成了三棵树。

查这类问题的顺序：`data/threads/<sessionId>.json` 有没有 → 该文件里的 `threadId`
是否等于用户正在看的那个话题 → 对应 `mapping.jsonl` 里 `via: 'thread'` 的条目是否指向同一棵树。

### 8.4 反查「用户这一轮在终端里说了什么」

Claude Code 的 **Stop hook 只给 `last_assistant_message`，不给用户输入**。
所以人坐在电脑前敲的那句话，飞书那头天然看不见——手机上只看到 AI 在自说自话。

唯一的来源是转录文件（`transcript_path` 由 hook stdin 提供）：
`kernel/lib.js` 的 `lastUserInput()` 从**尾部往前**扫，取第一条「人打的」消息。

难点全在过滤，因为转录里 `type: "user"` 混着大量系统注入：

| 形态 | 处理 |
| --- | --- |
| `tool_result`（数组形态） | 跳过 |
| `<task-notification>…</task-notification>` | 整条丢弃（最多的一种，最容易误判） |
| `<system-reminder>` / `<local-command-stdout>` / `<command-name>` | 整条丢弃 |
| `[Your previous response had no visible output…]` / `[Request interrupted by user]` | 整条丢弃 |
| `isCompactSummary` 的摘要 | 跳过 |
| `<pasted_content>…</pasted_content>` | **剥壳保留内容**——里面是用户自己粘的东西 |
| `[Image #3]` / `[Image: source: …]` | 剥掉占位符，留下同一行的文字 |
| 正文含 `[来自用户本人 · 飞书]` 或 `Another Claude session sent a message` | 跳过（这轮是飞书发起的，推回去是回音） |

**规则不是「以 `<` 开头就丢」。** 那样会漏掉 task-notification（它不是以 `<` 无关，
而是与其误杀用户粘贴的内容），正好两边都错。判断依据是「剥掉系统块之后还剩不剩东西」。

新增一种注入形态时，**先在这张表里补一行，再改代码**——这跟事件表是同一个规矩。

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
| `kernel/presence.js` | 窗口枚举对判定无用（`windows` 字段谁都不读），但仍在采集 | 下次改在场判定时一起删 |
| macOS / Linux 的 `presence.sh` | 都是单文件 shell，没有像 Windows 那样编译过的采样器；`ioreg` 每秒被调一次，实测开销可接受但不算低 | 有性能反馈时改成常驻进程（Windows 的 presence.exe 模式） |
| `setup/` | 有 check/install/verify/update/move/selftest/config-ui，尚无 doctor（运行期交互式排障） | 下一轮 |
| `plugins/status/` | 靠轮询转录推状态（约 3ms/窗口），飞书侧一次刷新约 1.5 秒。两者都不是事件驱动；若将来有会话状态变化的 hook，可改推 | 有性能反馈时 |
| ~~配置页~~ | 已实现：`setup/config-ui.js`，读 `--dump` 的同源 schema 起单页，后端零改动 | 见 5.1c |
