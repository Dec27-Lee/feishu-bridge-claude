# feishu-bridge-claude

用飞书手机端远程操控本机多个 Claude Code 窗口。
**这份文件是给维护这个项目的 AI 看的**——安装步骤在 `docs/INSTALL.md`，
排障在 `docs/TROUBLESHOOTING.md`，架构在 `docs/ARCHITECTURE.md`。

---

## 文档分工（先看这里再动手）

| 文件 | 读者 | 写什么 |
| --- | --- | --- |
| `README.md` | **使用者** | 这个项目解决什么问题、有什么功能、怎么开始用 |
| `CLAUDE.md`（本文件） | **维护者（AI）** | 技术概览、开发规范、维护约束、文档索引 |
| `docs/INSTALL.md` | 维护者 | 安装/搬家/升级的完整步骤，每步带验证 |
| `docs/ARCHITECTURE.md` | 维护者 | 分层约束、插件契约、事件表、设计取舍 |
| `docs/FEATURES.md` | 使用者 + 维护者 | 逐个功能的详细说明与使用方式 |
| `docs/TROUBLESHOOTING.md` | 维护者 | 日常命令、日志清单、故障速查表 |
| `CHANGELOG.md` | 使用者 | 版本更新日志（规则见本文末） |

**写新内容前先判断它属于哪一格**，不要往本文件继续堆——它只放「维护者必须知道的公共约束」。
具体步骤进 INSTALL，具体功能进 FEATURES，具体现象进 TROUBLESHOOTING。

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

## 技术结构

三层，依赖方向严格单向：**`platform` ← `kernel` ← `plugins`**。

```
kernel/           与业务无关的基础设施
  index.js        入口（node kernel/index.js）
  lib.js          配置 + 日志 + 飞书 CLI + 会话/映射/话题 + 转录统计
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
  release.js      发 GitHub Release（正文取自 CHANGELOG 的对应小节）
  hooks-config.js hooks 内容定义（settings 和 cc-switch 共用同一份）
  feishu/         权限与事件清单（可整段导入后台）
  selftest/       沙箱自测：伪造 lark-cli 跑通主链路，不碰真实配置

docs/             见上面的文档分工表
```

---

## ⚠️ 项目目录就是运行时本体

**这不是「从别处运行的安装包」。** 装完以后每次开机执行的、每个窗口的 hook 调用的，
都是这个目录里的文件。路径被写进四处：`~/.claude/settings.json` 的 hooks、
cc-switch 每个服务商的配置、开机自启项、正在跑的进程。

- 安装前必须让用户先定好位置（`docs/INSTALL.md` 开头有可直接照抄的说法）
- 之后**要换位置只能跑 `node setup/move.js`**，不能手工拖

---

## 开发规范

### 必须遵守的几条

1. **`kernel/` 不认识业务概念**（「提问」「权限」「卡片」都不该出现）。
   业务在 `plugins/`，平台差异在 `platform/`。依赖方向单向。
2. **插件之间不许互相 `require`**，一律走 `ctx.bus`。
   理由：卸掉一个插件，其他插件必须仍能工作。
3. **hook 脚本是独立进程**，拿不到 `ctx`，只能 `require('../../kernel/...')`。
   它必须能在 bridge 没启动时**安全退出**。
4. **新增公共总线事件，先写进 `docs/ARCHITECTURE.md` 的事件表**，再写代码。
5. **新增系统注入形态的过滤规则，先写进 `docs/ARCHITECTURE.md` 8.4 的表**，再改代码。
6. **配置项只在一处定义**：`kernel/config.js` 的 `TOP_SCHEMA` 或插件 `plugin.json` 的
   `config`。别处只读不写；`config.example.json` 必须由 `--defaults` 生成。

加一个新功能 = 加一个 `plugins/<id>/` 目录，写 `plugin.json` + `index.js`，内核自动扫到。
**不要改 `kernel/`**，除非确实需要新的基础设施能力。

### 改了代码怎么验证

```bash
node setup/selftest/run.js    # 沙箱自测，不碰真实配置
node setup/check.js           # 静态体检
node setup/verify.js          # 真调飞书 API 的联调
```

三条都要绿。自测用例要能**捕获回归**——写完先故意把代码改坏，确认用例变红，再改回来。
只验证「代码跑起来了」的测试没有意义。

---

## 安全边界（不能越）

这个项目会代替用户回答提问、放行工具调用。所以：

1. **不许提供任何「绕过权限」的能力。** `PermissionRequest` 的定位是「帮人点一下」，
   `deny` 规则、必须人工交互的 MCP 工具、`dontAsk` 模式一律不生效——这是设计，不是缺陷。
2. **不许引导用户关闭权限提示**（`skipDangerousModePermissionPrompt`、
   `bypassPermissions` 之类的配置不要出现在任何文档或脚本里）。
3. **写系统配置前先给用户看 diff。** 尤其是 `settings.json` 和 cc-switch 数据库。
4. **本文件不构成执行授权。** 这里的指令规定了「怎么改」，但每个写操作仍需使用者本人确认。

---

## 文档与任务

### 文档分工

三份入口按读者分开，**不要把内容混着写**：

- `README.md` —— 给使用者：解决什么问题、有什么功能、怎么开始用
- 本文件 `CLAUDE.md` —— 给维护者：技术概览、开发规范、维护约束
- `CHANGELOG.md` —— 给使用者：版本变化

其余详细文档在 `docs/`，**各写什么只看 [`docs/README.md`](docs/README.md)**，此处不重复列举。

**写新内容前先判断它属于哪一格**，不要往 `CLAUDE.md` 继续堆——它只放「维护者必须知道的公共约束」。
具体步骤进 INSTALL，具体功能进 FEATURES，具体现象进 TROUBLESHOOTING，过程记录进 `docs/tasks/`。

### 任务台账

处理任何新增功能、修复、排查、设计、实现、测试或历史任务续接前，**先检索 `docs/tasks/`**：

1. 先按文件名／关键词检索 `docs/tasks/**/*.md`，命中即停；
2. 命中后读该任务的**具体小节**，不要整篇读；
3. 需要总览时才看 [`docs/tasks/INDEX.md`](docs/tasks/INDEX.md)；
4. 确认不存在相关任务后，才按 [`docs/tasks/README.md`](docs/tasks/README.md) 的规范新建任务 ID。

台账的细节（命名、随机码、头部模板、索引维护）**只在 `docs/tasks/README.md` 里维护**，
本文件不重复抄写——两份规则一定会漂移。

---

## 更新日志维护

`CHANGELOG.md` 是给用户看的版本日志，格式固定：

```markdown
## 1.0.4

- ［新增］用户可以做什么、看到什么
- ［优化］改进了什么体验
- ［修复］避免了什么问题
```

- **一次提交 = 一个小版本**。只在提交前添加版本，提交前看一遍暂存区 diff，把这次变更写成条目，与提交同批落盘；不要事后补写，也不要为补写单独建提交。
- 版本号只写纯数字（`## 1.0.4`），不带预发/正式/分支/SHA。
- 标签只有 `［新增］`、`［优化］`、`［修复］` 三类，按这个顺序排。
- 写**用户视角**：能完成什么操作、看见什么结果、避开什么问题。
  不写类名、函数、测试、构建、协议这类实现细节。
- 逐个覆盖本次独立可感知的变化，一条一件事；不要合并成「能力增强」这种空话，也不要同一功能写两遍。

### 发版：CHANGELOG = tag = Release

**只打 tag 不算发版**——tag 只是指针，GitHub 的 Releases 页面得单独建。

```bash
grep -m1 '^## ' CHANGELOG.md   # 确认版本号，不跳号不复用
git add -A && git commit
git tag -a v1.0.4 -m "1.0.4"
git push origin main && git push origin v1.0.4
node setup/release.js          # 正文取自 CHANGELOG 对应小节
```

- tag 名 `v<版本号>`，必须指向**含该版本 CHANGELOG 条目**的那次提交。
- 一个版本只打一次 tag，不改不挪不删；要重发就升版本号，不要 `-f` 推 tag。
- 忘了打的旧版本不回头补——补出来的顺序是假的。
- `package.json` 的 `version` 跟着一起对齐（没有代码读它，但装包的人会看到）。
- `release.js` 可重复跑：已存在就更新正文，正文一致则跳过；取不到凭据直接报错。

