# 安装与升级

> 这份文档是**给 AI 执行的步骤清单**，每一步都写了「怎么做」和「怎么算成功」。
> 用户不需要读它；AI 执行时要按顺序做，**不要跳过验证**。

开始之前先确认一件事：**项目放在哪个目录**。这个目录不是「从别处运行的安装包」，
它就是运行时本体——装完以后每次开机执行的、每个窗口的 hook 调用的，都是这里的文件。

---

## 步骤 0 · 摸清环境

```bash
node setup/check.js --json
```

输出里每个 check 有 `level`：

| level | 含义 | 处理 |
| --- | --- | --- |
| `required` | 缺了装不了 | 必须先解决 |
| `optional` | 缺了功能降级 | 问用户要不要补 |
| `info` | 只是记录 | 不用管 |

`blocking` 为空才继续，否则按每项的 `fix` 字段逐项处理。

## 步骤 1 · Node.js（≥ 18，推荐 22 以上）

看 `check.js` 的 `node` 项。缺了就让用户装：

- Windows：`winget install OpenJS.NodeJS.LTS`
- macOS：`brew install node`
- 或去 https://nodejs.org/ 下载

**验证**：`node --version` 输出 ≥ v18。

> 为什么推荐 22+：`setup/install.js --cc-switch` 用到 `node:sqlite`，22.5 才内置。
> 低版本只能手工改 cc-switch，见步骤 5。

## 步骤 2 · 飞书应用与 lark-cli

这一块**必须用户动手**。你要做的是把每一步说清楚、把要复制的东西直接给他。

**不要凭记忆列权限。** 先用下面的命令打出准确清单：

```bash
node setup/feishu/scopes.js
```

它输出三段内容，**原样交给用户**：

### ① 权限——整段 JSON 粘贴进「权限管理 → 批量导入」

飞书后台的权限管理支持导入 JSON 文件，比自己一个个勾准得多。导入后核对页面上确实是 8 项：

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

### ② 事件订阅（长连接模式）

只订阅一个：`im.message.receive_v1`（接收消息）。

### ③ 回调配置——和事件是后台的两个不同页面

只订阅一个：`card.action.trigger`（卡片回传交互）。
漏掉它的表现是「**卡片按钮点了完全没反应**，但回复序号还能用」。

### 然后

1. 开启「机器人」能力
2. **发布版本 → 管理员审批通过**（改完权限必须重新发版，否则不生效）
3. 把机器人拉进一个**话题群**，记下群 `chat_id`

装 CLI 并登录（桥接全程用机器人身份，这里登录是为了让 CLI 能用应用凭据）：

```bash
npm i -g @larksuite/cli
lark-cli auth login
```

**验证**：`check.js` 的 `lark-cli`、`lark-auth` 两项变 ✓。
`verify.js` 能列出群 —— 那说明 `im:chat:read` 至少到位了。

> 想看「为什么需要这个权限」：`node setup/feishu/scopes.js --json` 里每条都带 `why`。

## 步骤 3 · 填 config.json

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

## 步骤 4 · 装 hooks

```bash
node setup/install.js --hooks --dry-run     # 先看要加什么
node setup/install.js --hooks               # 确认后真跑
```

它会做两件事：

1. 往 `~/.claude/settings.json` 的 `hooks` 里加 5 个事件（SessionStart / PreToolUse /
   PermissionRequest / Stop / Notification）。**只动本项目自己的那几条**，用户原有的
   hook（比如 codegraph）一条不碰。
2. 确保 `crossSessionInbound: "accept"`。没有它，窗口会拒收桥接投递的消息，
   **而且毫无报错**——排查这类问题时先看这一项。

会先备份成 `settings.json.bak-<时间戳>`。

> **hook 里写的是 node 的绝对路径**，不是裸 `node`。因为 hook 由 Claude Code 在
> 非交互 shell 里执行，那个环境的 PATH 常常不含 nvm / volta / fnm 的目录
> （macOS 上尤其常见），裸 `node` 会 command not found，表现是所有 hook 静默失效。
> 代价：**换 Node 版本后要重装一次 hooks**，`check.js` 的 `hooks-node` 项会提醒。

**验证**：`check.js` 的 `hooks` 和 `hooks-node` 两项都是 ✓。

## 步骤 5 · cc-switch（装了这个工具的必须做）

**最容易漏的一步。** 它切换服务商时用数据库里的 `settings_config` **整体覆盖**
`~/.claude/settings.json` —— 哪个服务商没带 hooks，切到它就全没了。
新版 cc-switch **已经取消了通用配置入口**，只能逐个改。

```bash
node setup/install.js --cc-switch --dry-run    # 看哪些服务商缺
node setup/install.js --cc-switch              # 逐个补
```

它直接写 cc-switch 的 SQLite 数据库（`~/.cc-switch/cc-switch.db`），
写前备份为 `cc-switch.db.bak-<时间戳>`，用事务提交。

**验证**：`check.js` 的 `cc-switch` 项变 ✓（或显示 `已覆盖 N / N`）。

> 如果 Node < 22.5 没有 `node:sqlite`，脚本会提示手动改：
> cc-switch 界面里逐个编辑服务商的 JSON 配置，把 `setup/hooks-config.js` 里
> `HOOKS` 对象的内容合并进去。**必须提醒用户：改的时候 cc-switch 不能正在切换服务商。**

## 步骤 6 · 在场采样器（可选）

```bash
node setup/install.js --build
```

| 平台 | 这一步做什么 |
| --- | --- |
| Windows | 用自带的 `csc.exe`（.NET Framework）把 `presence.cs` 编译成 `presence.exe` |
| macOS / Linux | 不用编译，`presence.sh` 是随仓库分发的 shell 脚本；这一步只做检查 |

**不装也能用**：没有采样器时 `kernel/wait.js` 会自动退化成
「一律推卡片、等 30 分钟」，只是手机上多收几张卡。

**验证**：`node setup/check.js` 里「在场采样器」一项是 ✓。它两个平台各取所长——
Windows 看 exe 在不在，macOS/Linux 真跑一次 `presence.sh --once` 看能不能采到数。

> Linux 额外要求：空闲秒数依赖 `xprintidle`（`apt install x11-utils` 或
> `dnf install xorg-x11-utils`）。**Wayland 下没有统一接口**，采不到就如实返回
> `idleSeconds: -1`，判定退到「一律推卡片」——不编数据，也不阻塞。
> macOS 用 `ioreg` 读 `HIDIdleTime`，系统自带，无需额外安装。

## 步骤 7 · 启动

```bash
node kernel/index.js
```

看到这几行就对了：

```
[plugin] 已加载 core@1.0.0（内置）...
[bridge] 已启动 1 个服务，来自 4 个插件
```

**验证**：`check.js` 全绿；在飞书群里发一条消息能收到响应。

## 步骤 7b · 联调

```bash
node setup/verify.js          # 只读：配置、机器人身份、群可达、事件总线、进程、hooks
node setup/verify.js --send   # 额外往群里发一条测试消息
```

`check.js` 看「装了没」，`verify.js` 看「真能用吗」——后者会真的调飞书 API。
装完后先跑 verify，全绿再交付给用户。

## 步骤 8 · 开机自启（可选）

```bash
node setup/install.js --autostart
```

| 平台 | 做法 |
| --- | --- |
| Windows | 启动文件夹放一个快捷方式指向 `watch-bridge.vbs`（崩溃自动重启） |
| macOS | `~/Library/LaunchAgents/com.feishu.bridge.claude.plist`（launchd KeepAlive） |
| Linux | `~/.config/systemd/user/feishu-bridge.service`（systemd --user，`Restart=on-failure`） |

> 三个平台的「崩溃重拉」都由自启机制本身提供。Windows 的 `watch-bridge.vbs`
> 是显式的循环守护脚本；launchd/systemd 那边是 KeepAlive / Restart 两个选项。
> 所以**没装自启时进程挂了不会自己起来**，这也是为什么搬家脚本会兜底直接起一个。

---

## 搬家（换目录）

**不要手工拖文件夹。** 项目根路径被写进四处，手拖必然留下指向旧位置的记录，
症状是「看着还在跑，但改代码没反应」——最难查的一类问题。

```bash
node setup/move.js /Users/you/apps/feishu-bridge-claude          # 演练，只说要做什么
node setup/move.js /Users/you/apps/feishu-bridge-claude --yes    # 真的搬
node setup/move.js /Users/you/apps/feishu-bridge-claude --yes --delete-old
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

用户不是在维护这个项目，所以**更新必须是一条命令**：

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
