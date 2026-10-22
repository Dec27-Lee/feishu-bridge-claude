CLAUDE.md

# feishu-bridge-claude

用飞书手机端远程操控本机多个 Claude Code 窗口。
**你（读这份文件的 AI）是这套东西的安装员和运维员**，用户不应该自己去读代码或改配置。

---

## 你的工作方式

用户在 Claude Code 里打开这个目录，然后说「帮我装一下」或者「XX 不好用了」。
你的职责是：**读这里的文档 → 跑检测 → 按步骤改配置 → 每步验证 → 遇到问题查故障表**。

三条纪律：

1. **先跑 `node setup/check.js --json`，不要靠猜。** 它返回结构化结果，
   `blocking` 为空才继续，否则按 `fix` 字段逐项处理。
2. **任何写系统配置的操作，先 `--dry-run` 给用户看将要改什么，再真跑。**
   用户看不懂 JSON 是正常的，你要用中文说清「我要往哪里加什么」。
3. **不确定就停下来问。** 这个项目的 hook 会代替用户回答提问、放行工具调用，
   装错了后果是「用户以为自己在放手，实际已经放行了别的东西」。

---

## 这个项目是什么

```
飞书群/话题  ←→  bridge 常驻进程  ←→  本机 Claude Code 窗口
                      ↑
              Claude Code 的 hooks 把事件送进来
```

两个核心能力：

- **话题路由**：每个 Claude Code 窗口在飞书群里有一棵自己的话题，在里面打字就是给它发消息
- **远程作答**：窗口弹选择题、要权限确认时，人不在电脑前可以用手机点

架构细节在 `docs/ARCHITECTURE.md`。**改代码前必读**，那里写了分层约束和插件契约。

---

## ⚠️ 动手之前：先确定项目放在哪

**这个目录不是「从别处运行的安装包」，它就是运行时本体。** 装完以后每次开机执行的、
每个 window 的 hook 调用的，都是这个目录里的文件。所以：

- 装之前就要问用户：**放在哪？**（不要把 `git clone` 到桌面/下载目录/临时目录里就开装）
- 一旦装好，路径就被写进了四处：`~/.claude/settings.json` 的 hooks、
  cc-switch 每个服务商的配置、开机自启项、正在跑的进程。
- 之后**再搬文件夹就必须跑 `node setup/move.js`**，不能手工拖。

给用户的说法（照抄即可）：

> 这个项目安装后就是你电脑上实际运行的程序，所以**先定好放在哪个目录再装**。
> 建议放在一个长期不动的位置，例如 `D:\tools\feishu-bridge-claude` 或 `~/apps/feishu-bridge-claude`。
> 以后要换位置也不用重装，跑一次 `node setup/move.js <新目录>` 就行。

---

## 安装：按这个顺序做

每一步都给了「怎么做」和「怎么算成功」。**不要跳过验证**。

### 步骤 0 · 摸清环境

```bash
node setup/check.js --json
```

输出里的每个 check 有 `level`：

| level | 含义 | 处理 |
| --- | --- | --- |
| `required` | 缺了装不了 | 必须先解决 |
| `optional` | 缺了功能降级 | 问用户要不要补 |
| `info` | 只是记录 | 不用管 |

### 步骤 1 · Node.js（要求 ≥ 18，推荐 22 以上）

看 `check.js` 的 `node` 项。缺了就让用户装：

- Windows：`winget install OpenJS.NodeJS.LTS`
- macOS：`brew install node`
- 或去 https://nodejs.org/ 下载

**验证**：`node --version` 输出 ≥ v18。

> 为什么推荐 22+：`setup/install.js --cc-switch` 用到 `node:sqlite`，
> 22.5 才内置。低版本只能手工改 cc-switch，见步骤 4。

### 步骤 2 · 飞书应用与 lark-cli

这一块**必须用户动手**，你要做的是把每一步说清楚、把要复制的东西直接给他。

**不要凭记忆列权限。** 先用下面的命令打出准确清单：

```bash
node setup/feishu/scopes.js
```

它输出三段内容，**原样交给用户**：

**① 权限——整段 JSON 粘贴进「权限管理 → 批量导入」**

飞书后台的权限管理支持导入 JSON 文件，比自己一个个勾准得多。
导入后核对页面上确实是 8 项：

| 权限 | 干什么用 |
| --- | --- |
| `im:message.group_msg` | 收群里的消息——**收不到消息基本都是缺这个** |
| `im:message.p2p_msg:readonly` | 收单聊消息（事件订阅的 schema 要求） |
| `im:message:readonly` | 卡片回调取 `card_content`、查话题根、下载图片 |
| `im:message:send_as_bot` | 以机器人身份发卡片、回复、建话题 |
| `im:message:update` | 作答后把卡片改成结果态 |
| `im:message.pins:write_only` | 新窗口的话题置顶 |
| `im:resource` | 下载用户发到话题里的图片 |
| `im:chat:read` | 列机器人所在的群（`verify.js` 用它校验 chatId） |

> 少一个的表现都是**静默降级**，不会报错：缺 `im:message:update` → 答完题卡片不变；
> 缺 `im:message.pins:write_only` → 话题不置顶（功能照常）；缺 `im:resource` → 图片收不到。

**② 事件订阅（长连接模式）**

只订阅一个：`im.message.receive_v1`（接收消息）。

**③ 回调配置——和事件是后台的两个不同页面**

只订阅一个：`card.action.trigger`（卡片回传交互）。
漏掉它的表现是「**卡片按钮点了完全没反应**，但回复序号还能用」。

然后：

1. 开启「机器人」能力
2. **发布版本 → 管理员审批通过**（改完权限必须重新发版，否则不生效）
3. 把机器人拉进一个**话题群**，记下群 `chat_id`

装 CLI 并登录（桥接全程用机器人身份，这里登录是为了让 CLI 能用应用凭据）：

```bash
npm i -g @larksuite/cli
lark-cli auth login
```

**验证**：`check.js` 的 `lark-cli`、`lark-auth` 两项变 ✓。
`verify.js` 能列出群里 —— 那说明权限里至少 `im:chat:read` 到位了。

> 想看「为什么需要这个权限」：`node setup/feishu/scopes.js --json` 里每条都带 `why`。

### 步骤 3 · 填 config.json

```bash
cp config.example.json config.json
```

要填的只有三项（其他用默认值）：

| 字段 | 怎么得到 |
| --- | --- |
| `chatId` | 群设置里的群 ID，形如 `oc_xxxxxxxx` |
| `larkCli` | lark-cli 的绝对路径；装在 PATH 里就留 `"lark-cli"` |
| `launchAliases` | 可选。`{"个人": "/Users/you/workspace"}` 这样给常用目录起名 |

**验证**：`node kernel/config.js --check` 输出「配置校验通过」。

> 配置结构由 schema 定义（`kernel/config.js` 的 `TOP_SCHEMA` 与各插件 `plugin.json`
> 的 `config`），默认值、取值范围、说明都在那里。`config.example.json` 必须由
> `node kernel/config.js --defaults` 生成，**不要手改**——手改就会和数据源不一致。
>
> 想看全部可配项及其含义：`node kernel/config.js --dump`。

### 步骤 4 · 装 hooks

```bash
node setup/install.js --hooks --dry-run     # 先看要加什么
node setup/install.js --hooks               # 确认后真跑
```

它会做两件事：

1. 往 `~/.claude/settings.json` 的 `hooks` 里加 5 个事件（SessionStart / PreToolUse /
   PermissionRequest / Stop / Notification）。**只动本项目自己的那几条**，你原有的
   hook（比如 codegraph）一条不碰。
2. 确保 `crossSessionInbound: "accept"`。没有它，窗口会拒收桥接投递的消息，
   **而且毫无报错**——排查这类问题时先看这一项。

会先备份成 `settings.json.bak-<时间戳>`。

> **hook 里写的是 node 的绝对路径**，不是裸 `node`。因为 hook 由 Claude Code 在
> 非交互 shell 里执行，那个环境的 PATH 常常不含 nvm / volta / fnm 的目录
> （macOS 上尤其常见），裸 `node` 会 command not found，表现是所有 hook 静默失效。
> 代价：**换 Node 版本后要重装一次 hooks**，`check.js` 的 `hooks-node` 项会提醒你。

**验证**：`check.js` 的 `hooks` 和 `hooks-node` 两项都是 ✓。

### 步骤 5 · cc-switch（用的人必须做）

**这是最容易漏的一步。** 如果用户装了 cc-switch，切换服务商时它用数据库里的
`settings_config` **整体覆盖** `~/.claude/settings.json` —— 哪个服务商没带 hooks，
切到它就全没了。新版 cc-switch **已经取消了通用配置入口**，只能逐个改。

```bash
node setup/install.js --cc-switch --dry-run    # 看哪些服务商缺
node setup/install.js --cc-switch              # 逐个补
```

它会直接写 cc-switch 的 SQLite 数据库（`~/.cc-switch/cc-switch.db`），
写前备份为 `cc-switch.db.bak-<时间戳>`，用事务提交。

**验证**：`check.js` 的 `cc-switch` 项变 ✓（或显示 `已覆盖 N / N`）。

> 如果 Node < 22.5 没有 `node:sqlite`，脚本会告诉你手动改。
> 手动改法：cc-switch 界面里逐个编辑服务商的 JSON 配置，把
> `setup/hooks-config.js` 里 `HOOKS` 对象的内容合并进去。
> **必须提醒用户：改的时候 cc-switch 不能正在切换服务商。**

### 步骤 6 · 在场采样器（可选）

```bash
node setup/install.js --build
```

| 平台 | 这一步做什么 |
| --- | --- |
| Windows | 用自带的 `csc.exe`（.NET Framework）把 `presence.cs` 编译成 `presence.exe` |
| macOS / Linux | 不用编译，`presence.sh` 是随仓库分发的 shell 脚本；这一步只做检查 |

**不装也能用**：没有采样器时 `kernel/wait.js` 会自动退化成
「一律推卡片、等 30 分钟」，只是手机上多收几张卡。

**验证**：`node setup/check.js` 里「在场采样器」一项是 ✓。
它的判断方式是两个平台各取所长——Windows 看 exe 在不在，
macOS/Linux 真跑一次 `presence.sh --once` 看能不能采到数。

> Linux 额外要求：空闲秒数依赖 `xprintidle`（`apt install x11-utils` 或
> `dnf install xorg-x11-utils`）。**Wayland 下没有统一接口**，采不到就如实返回
> `idleSeconds: -1`，判定退到「一律推卡片」——不编数据，也不阻塞。
> macOS 用 `ioreg` 读 `HIDIdleTime`，系统自带，无需额外安装。

### 步骤 7 · 启动

```bash
node kernel/index.js
```

看到这几行就对了：

```
[plugin] 已加载 core@1.0.0（内置）...
[bridge] 已启动 1 个服务，来自 4 个插件
```

**验证**：`check.js` 全绿；在飞书群里发一条消息能收到响应。

### 步骤 7b · 联调

```bash
node setup/verify.js          # 只读检查：配置、机器人身份、群可达、事件总线、进程、hooks
node setup/verify.js --send   # 额外往群里发一条测试消息
```

`check.js` 看「装了没」，`verify.js` 看「真能用吗」——后者会真的调飞书 API。
装完后先跑 verify，全绿再交付给用户。

### 步骤 8 · 开机自启（可选）

```bash
node setup/install.js --autostart
```

Windows 会在启动文件夹放一个快捷方式指向 `watch-bridge.vbs`（崩溃自动重启）。
macOS 写 `~/Library/LaunchAgents/com.feishu.bridge.claude.plist`（launchd KeepAlive）。
Linux 写 `~/.config/systemd/user/feishu-bridge.service`（systemd --user，`Restart=on-failure`）。

> 三个平台的「崩溃重拉」都由自启机制本身提供。Windows 的 `watch-bridge.vbs`
> 是显式的循环守护脚本；launchd/systemd 那边是 KeepAlive / Restart 两个选项。
> 所以**没装自启时进程挂了不会自己起来**，这也是为什么搬家脚本会兜底直接起一个。

---

## 搬家（用户想换目录时）

**不要手工拖文件夹。** 项目根路径被写进四处，手拖必然留下指向旧位置的记录，
症状是「看着还在跑，但改代码没反应」——最难查的一类问题。

```bash
node setup/move.js /Users/you/apps/feishu-bridge-claude          # 演练，只说要做什么
node setup/move.js /Users/you/apps/feishu-bridge-claude --yes    # 真的搬
node setup/move.js /Users/you/apps/feishu-bridge-claude --yes --delete-old   # 搬完删旧目录
```

它按「先停 → 再复制 → 改指向 → 最后才删旧」的顺序做：

1. **停进程**：bridge、在场采样器，**以及守护进程**。
   Windows 上是 `watch-bridge.vbs`；macOS/Linux 上由 launchd/systemd 拉起，
   所以第 2 步先卸自启。不这么做的话，5 秒后旧位置的代码又会被拉起来。
2. **卸旧自启**：否则每次开机都拉起旧目录。
3. **复制**：旧目录在复制期间始终完整，任何一步失败都能退回去。
4. **改指向**：`install.js --hooks` 会摘掉本项目指向旧位置的 hook 再加入新的
   （判据是脚本名，不看目录，所以搬过几次都能收拾干净）；
   `--cc-switch` 补每个服务商；`--autostart` 重建自启项。
5. **在新位置启动 + `verify.js` 体检**。没装自启时直接 detached 起一个，
   不依赖服务管理器。
6. 加 `--delete-old` 时，**先确认新位置的 bridge 真的在跑**才删旧目录。

**给用户的话**：搬家前先关掉正在跑飞书桥接的窗口，搬完 `cd` 到新目录再继续。

---

## 更新项目

用户不是在维护这个项目，所以**更新必须是一条命令**，不能让他手动 git pull：

```bash
node setup/update.js --check    # 只看有没有新版本
node setup/update.js            # 拉取 → 迁移配置 → 检查 hooks 路径 → 体检
```

它做四件事，缺一不可：

1. **fast-forward 拉取**。本地有未提交改动就停下并提示怎么处理，绝不 merge/reset。
2. **配置迁移**。新版本加的配置项按 schema 的 default 补进 `config.json`，
   已有的值原样保留；迁移前备份，迁移后必须通过校验才写。
3. **hooks 路径校验**。项目被移动过的话，`settings.json` 里的绝对路径会失效，
   它会指出来并让你重装。
4. **体检**。跑一遍 `check.js`。

**为什么不能只 git pull**：配置结构会随版本变化，schema 里加了新字段，
不迁移的话用户永远拿不到默认值，表现为「新功能行为不对但报错都没有」。

## 日常运维

| 想做什么 | 命令 |
| --- | --- |
| 看体检 | `node setup/check.js` |
| 联调（真调飞书 API，只读） | `node setup/verify.js` |
| 更新项目并迁移配置 | `node setup/update.js` |
| 换目录 | `node setup/move.js <新目录> [--yes] [--delete-old]` |
| 自测（不碰真实配置） | `node setup/selftest/run.js` |
| 看全部可配项 | `node kernel/config.js --dump` |
| 重启 | Windows：`Stop-Process -Id (Get-Content data/bridge.pid) -Force`<br>macOS / Linux：`kill $(cat data/bridge.pid)`<br>（装了自启会被自动拉回来） |
| 看日志 | `logs/bridge.log` 路由；`logs/<插件id>.log` 各插件；`logs/error.log` 异常 |
| 看在场状态 | `data/presence.json`——`idleSeconds` 空闲秒数、`locked` 是否锁屏 |
| 改配置 | 编辑 `config.json` → 重启 |

日志文件清单：

| 文件 | 内容 |
| --- | --- |
| `logs/bridge.log` | 路由、投递、窗口创建、清理 |
| `logs/plugin.log` | 插件加载与卸载 |
| `logs/session.log` | 会话注册、凭证刷新 |
| `logs/ask.log` | 提问/权限的落盘、作答、交还 |
| `logs/notify.log` | 通知推送 |
| `logs/event.log` | 收到的原始飞书事件 |
| `logs/error.log` | 异常（**排障先看这个**） |

---

## 故障速查

| 现象 | 先查 | 处理 |
| --- | --- | --- |
| 权限确认卡片发出来了，但点「允许」没反应 | 后台有没有开 `im:message:update` | 开权限后**重新发版审批**。缺它时卡片能发、按钮回调也能进来，只有「把卡片改成结果态」这一步静默失败 |
| 群里发消息毫无反应 | `check.js` 的 `lark-cli`/`config` | 应用是否发布通过、`im:message.group_msg` 权限、`chatId` 对不对 |
| 点卡片按钮没反应（回序号可以） | 后台是否订阅 `card.action.trigger` | 订阅后**必须重启事件总线**：`lark-cli event stop` 再重启 bridge |
| 点按钮报 `code: 200671` | 后台改过回调但总线没重启 | 同上 |
| 窗口收不到消息，且日志无异常 | `crossSessionInbound` | 必须是 `"accept"`。这是静默失败，最坑 |
| 换了 cc-switch 服务商后功能全丢 | 该服务商是否带 hooks | `node setup/install.js --cc-switch` |
| 人在电脑前却收到作答卡 | `data/presence.json` 的 `idleSeconds` | 3 分钟没碰键鼠会被判定不在，碰一下即可；或点「让终端问我」 |
| 锁屏了终端还弹窗 | `data/presence.json` 的 `locked` | Windows 看 `fgProc` 应为 `LockApp`；macOS 看 `locked` 是否为 true；Linux 看 `loginctl` 能不能报 `LockedHint`。`config.json` 里 `presenceAware:false` 可临时退回 |
| 新窗口停在 `Accessing workspace` | 目录是否已信任 | 桥接会自动预置信任；仍卡住就在电脑上按一次回车 |
| 提问卡片一直不出现 | `data/bridge.pid` 里的进程是否活着 | `node setup/check.js` 看各项 |
| 权限确认卡片不出现 | 是否命中 `deny` 规则 / MCP 要求人工交互 / `dontAsk` 模式 | 这几类问也放不过，只能在终端确认 |
| 所有 hook 静默失效、无报错 | `check.js` 的 `hooks-node` | hook 里写的是 node 绝对路径，换 Node 版本后会指向不存在的文件。`node setup/install.js --hooks` 重装 |
| macOS/Linux 新窗口里 `claude: command not found` | 启动器的 PATH | 从 launchd/systemd 起的进程只有最小 PATH。`launch-claude.sh` 已补常见目录；claude 若装在别处，加到脚本的候选列表里 |
| Linux 采不到空闲时长（总是推卡片） | `xprintidle` 是否安装 / 是否 Wayland | `apt install x11-utils`；Wayland 无统一接口，只能接受降级 |
| macOS 上所有提问都推手机、终端不弹窗 | `data/presence.json` 的 `locked` 是否为 true | 若恒为 true 说明锁屏探测误判。检查 `ioreg -n Root -d1 -a | grep -A1 CGSSessionScreenIsLocked` |

**排查顺序永远是：`check.js` → `logs/error.log` → `logs/event.log`。**
不要一上来就读代码。

改完代码想确认没跑偏，跑 `node setup/selftest/run.js`：它在临时目录里起一整套沙箱
（伪造的 lark-cli、伪造的会话管道），把 39 条主链路跑一遍，不读也不写你任何真实配置。

---

## 改代码时

**先读 `docs/ARCHITECTURE.md`。** 里面有分层约束，违反了会在运行期炸。

必须遵守的几条：

1. **`kernel/` 不认识业务概念**（「提问」「权限」「卡片」都不该出现）。
   业务在 `plugins/`，平台差异在 `platform/`。依赖方向单向：`platform ← kernel ← plugins`。
2. **插件之间不许互相 `require`**，一律走 `ctx.bus`。
   理由：卸掉一个插件，其他插件必须仍能工作。
3. **hook 脚本是独立进程**，拿不到 `ctx`，只能 `require('../../kernel/...')`。
   它必须能在 bridge 没启动时**安全退出**。
4. **新增公共总线事件，先写进 `docs/ARCHITECTURE.md` 的事件表**，再写代码。

加一个新功能 = 加一个 `plugins/<id>/` 目录，写 `plugin.json` + `index.js`，
内核自动扫到。**不要改 `kernel/`**，除非确实需要新的基础设施能力。

---

## 更新日志维护

`CHANGELOG.md` 是产品版本日志。提交 feishu-bridge-claude 变更前，必须查看暂存区 Git diff，并为本次提交追加一个小版本记录；条目必须与本次变更同批提交，分支、提交说明、时间和贡献都在提交前一次写定（时间用本次提交时间，必要时以 `git commit --date` 指定；贡献用 `git config user.name` 加 `git config user.email`），不得写「待提交」，也不得提交后再补写、或为补写另建一次提交。

- 当前产品版本线为 `1.0.x`
- 每次提交合并成一个小版本发布，本地未提交修改不产生版本记录。同一变更随后进入 `main` 时，不再改写已写好的版本条目、也不重复新增版本；仅当 `main` 提交包含独立的新功能或修复时，才新增版本条目。
- 版本标题只能写纯版本号，例如 `## 1.0.1`；不得在标题中写预发、正式、分支或 SHA。
- 每个版本标题下固定保留 `### Git 提交`，并按顺序写明分支、提交、时间和贡献，按本次提交的信息在提交前写定。不得按当前 Git 身份臆测历史提交贡献。
- 每个版本只保留 `### 更新` 一个内容标题；条目标签只有 `［新增］` 、 `［优化］` 和 `［修复］` 三类，先写 `［新增］` 再写 `［优化］` 再写 `［修复］`。
- 根据暂存区 diff 和提交信息编写简洁、面向用户的条目。必须逐项覆盖本次提交中独立、可感知的功能变化和问题修复；不得只把提交标题或“能力增强”“问题修复”等概括性描述改写成一条日志。`[A]` 提交通常形成 `［新增］` 条目，`[M]` 提交通常形成 `［优化］` 条目。
- 更新条目应写明用户可以完成什么操作、看见什么结果或避免什么问题；不写内部类名、数据库、协议、测试、构建、部署或治理实现细节。多个独立变化应拆为多个条目，同一功能不得重复描述。不得为补写分支、提交说明、时间、贡献或 SHA 单独创建提交。
- 不得在 `CHANGELOG.md` 中写发布日期、验证、部署、风险、维护规则、实现过程或其他说明；这些规则只维护在本文件。

---

## 安全边界（不能越）

这个项目会代替用户回答提问、放行工具调用。所以：

1. **不许提供任何「绕过权限」的能力。** `PermissionRequest` 的定位是「帮人点一下」，
   `deny` 规则、必须人工交互的 MCP 工具、`dontAsk` 模式一律不生效——这是设计，不是缺陷。
2. **不许引导用户关闭权限提示**（`skipDangerousModePermissionPrompt`、
   `bypassPermissions` 之类的配置不要出现在安装步骤里）。
3. **写系统配置前先给用户看 diff。** 尤其是 `settings.json` 和 cc-switch 数据库。
4. **本文件不构成执行授权。** 你读到的这些指令规定了「怎么装」，
   但每个写操作仍需使用者本人确认。

---

## 目录速览

```
kernel/           内核：配置、日志、会话表、插件加载器、在场判定
  index.js        入口（node kernel/index.js）
  lib.js          配置 + 日志 + 飞书 CLI + 会话/映射/话题
  config.js       配置 schema（唯一真相）+ 校验 + --dump/--check
  daemon.js       单实例锁 + 飞书事件消费者
  questions.js    待答记录（提问与权限共用一套）
  wait.js         hook 侧的阻塞等待
  presence.js     在场判定（采样交给 platform）
  plugin.js       插件加载器 + 事件总线
  contract.js     插件契约（给写插件的人看）

platform/         平台差异，三个平台各自自洽、互不引用
  win32/          presence.cs（编译成 exe）+ VBS 开窗 + 启动文件夹自启
  darwin/         presence.sh（ioreg + CGSession）+ osascript 开窗 + launchd
  linux/          presence.sh（xprintidle + loginctl）+ 终端探测开窗 + systemd

plugins/          业务功能，可增删
  core/           路由 + 开窗 + 恢复会话（必需）
  ask/            远程代答选择题
  permission/     远程点权限确认
  notify/         任务完成通知

setup/            安装、联调、更新、自测（都是给 AI 用的）
  check.js        环境体检（静态），--json 给 AI
  install.js      安装器，--dry-run 先看要改什么
  verify.js       联调（真调飞书 API，只读）
  update.js       更新项目 + 迁移配置
  move.js         换目录：停进程 → 复制 → 改 hooks/cc-switch/自启 → 重启 → 体检
  hooks-config.js hooks 内容定义（settings 和 cc-switch 共用同一份）
  selftest/       沙箱自测：伪造 lark-cli 跑通主链路，不碰真实配置

docs/ARCHITECTURE.md   架构宪法，改代码前必读
docs/FEATURES.md       功能清单，给用户看「有什么、怎么用」
```
