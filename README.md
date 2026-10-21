# feishu-bridge-claude

用飞书手机端远程操控本机多个 Claude Code 窗口：每个窗口一棵话题，群里打字即发消息，手机上能答选择题、点权限确认。

**这个仓库是给 AI 装、给 AI 养的。** 你不需要读代码，把仓库地址丢给 Claude Code，说「帮我装一下」即可；`CLAUDE.md` 里有完整的分步规程，检测脚本会告诉它缺什么。

---

## 它解决什么问题

电脑上开着好几个 Claude Code 窗口同时在干活，人不在电脑前时：

- 想知道哪个窗口跑完了 → 每个窗口在自己的飞书话题里汇报
- 想给某个窗口补一句 → 在那个话题里直接打字
- 窗口弹了个选择题要你选 → 手机上点一下
- 窗口要执行命令等你放行 → 手机上点「允许」

人在电脑前时它们不会来打扰你——弹窗照常出现在终端里，飞书只推一张不带按钮的提醒卡。

## 快速开始

```bash
git clone https://github.com/Dec27-Lee/feishu-bridge-claude.git
cd feishu-bridge-claude
npm run check      # 先看缺什么
npm run install    # 按提示装（会先 dry-run 给你看要改什么）
npm run verify     # 联调：真的调飞书 API 确认通
npm start          # 启动
```

以后项目更新了，一条命令同步（会顺带迁移配置）：

```bash
node setup/update.js
```

需要 Node.js ≥ 18（推荐 22+）和一个飞书自建应用的机器人。
飞书那边的准备（应用、权限、事件订阅、群）见 `CLAUDE.md` 步骤 2，**那部分必须你手动做**。

## 支持平台

| 功能 | Windows | macOS | Linux |
| --- | --- | --- | --- |
| 话题路由、卡片作答 | ✅ | ✅ | ✅ |
| 任务通知 | ✅ | ✅ | ✅ |
| 远程识别「人在不在电脑前」 | ✅ | ✅ | ✅ * |
| 从飞书新开窗口 | ✅ wt.exe | ✅ Terminal / iTerm | ✅ 常见终端 |
| 开机自启 | ✅ 启动文件夹 | ✅ launchd | ✅ systemd --user |

\* Linux 的空闲时长靠 `xprintidle`（X11），Wayland 下拿不到；拿不到时如实报「不知道」，
判定会退到「一律推卡片」——不编数据，也不阻塞。

任何一项缺失都**自动降级**，不会报错：没有在场探测就一律推卡片等你答，
不能自动开窗就手动开一个窗口用 `#resume` 绑定话题。主体能力与平台无关。

三个平台各自是一个自洽的目录（`platform/win32/`、`platform/darwin/`、`platform/linux/`），
互不引用；共同逻辑在 `kernel/` 与 `plugins/`。

## 架构

```
platform/   与操作系统相关的一切（开窗、进程校验、在场采样器）
kernel/     与业务无关的基础设施（配置、日志、会话表、插件加载器）
plugins/    业务功能，可增删
  core/         路由 + 开窗 + 恢复会话（必需）
  ask/          远程代答选择题
  permission/   远程点权限确认
  notify/       任务完成通知
```

**插件之间不互相依赖，只通过内核的事件总线通信**——所以一个功能出问题，
删掉那个目录就行，其余照常跑。加功能也是加一个目录。

细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，改代码前必读。

## 安全边界

这套东西会代替你回答提问、放行工具调用。它**不能**绕过任何权限：命中 `deny` 规则的操作、
强制人工交互的 MCP 工具、`dontAsk` 模式下都不生效。定位是「帮人点一下」，不是「替人做主」。

## 许可证

MIT
