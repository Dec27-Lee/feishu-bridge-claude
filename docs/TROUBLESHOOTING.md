# 排查与运维

> 出问题时的顺序：**`setup/check.js` → `logs/error.log` → `logs/event.log`**。
> 不要一上来就读代码。

---

## 日常命令

| 想做什么 | 命令 |
| --- | --- |
| 看体检 | `node setup/check.js` |
| 联调（真调飞书 API，只读） | `node setup/verify.js` |
| 更新项目并迁移配置 | `node setup/update.js` |
| 换目录 | `node setup/move.js <新目录> [--yes] [--delete-old]` |
| 自测（不碰真实配置） | `node setup/selftest/run.js` |
| 看全部可配项 | `node kernel/config.js --dump` |
| 网页上改配置 | `node setup/config-ui.js [--port 8787] [--no-open] [--idle-exit 0]`（详见 `docs/FEATURES.md` 第 11 节） |
| 打印飞书权限/事件清单 | `node setup/feishu/scopes.js` |
| 发 GitHub Release | `node setup/release.js [版本] [--dry-run]`（发版流程见 `CLAUDE.md`） |
| 重启 | Windows：`Stop-Process -Id (Get-Content data/bridge.pid) -Force`<br>macOS / Linux：`kill $(cat data/bridge.pid)`<br>（装了自启会被自动拉回来） |
| 看在场状态 | `data/presence.json`——`idleSeconds` 空闲秒数、`locked` 是否锁屏 |
| 改配置 | 编辑 `config.json` → 重启 |

## 日志文件

| 文件 | 内容 |
| --- | --- |
| `logs/bridge.log` | 路由、投递、窗口创建、清理 |
| `logs/plugin.log` | 插件加载与卸载 |
| `logs/session.log` | 会话注册、凭证刷新 |
| `logs/ask.log` | 提问/权限的落盘、作答、交还 |
| `logs/notify.log` | 通知推送 |
| `logs/event.log` | 收到的原始飞书事件 |
| `logs/image.log` | 图片下载（下载失败会写明 key 和目标路径） |
| `logs/hook-boot.log` | SessionStart hook 每次被执行的痕迹（**判断 hook 有没有跑起来先看它**） |
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
| 新窗口里报 `SessionStart:startup hook error`（状态码 34，提示语是乱码） | `logs/hook-boot.log` 有没有这一次的记录 | **没有** = hook 根本没被执行：Windows 上命令不能加引号，`"node.exe" "x.js"` 会被 `cmd /c` 当成一个程序名。重跑 `node setup/install.js --hooks --cc-switch` 换成不带引号的形式。**有** = 执行了但后面崩了，按那行的 `argv`／环境变量继续查 |
| macOS/Linux 新窗口里 `claude: command not found` | 启动器的 PATH | 从 launchd/systemd 起的进程只有最小 PATH。`launch-claude.sh` 已补常见目录；claude 若装在别处，加到脚本的候选列表里 |
| Linux 采不到空闲时长（总是推卡片） | `xprintidle` 是否安装 / 是否 Wayland | `apt install x11-utils`；Wayland 无统一接口，只能接受降级 |
| macOS 上所有提问都推手机、终端不弹窗 | `data/presence.json` 的 `locked` 是否为 true | 若恒为 true 说明锁屏探测误判。检查 `ioreg -n Root -d1 -a \| grep -A1 CGSSessionScreenIsLocked` |
| 通知卡里没带「你在终端里说」 | `plugins.notify.showUserPrompt` | 默认开。若开着仍没有，看这一轮是不是从飞书发起的（那种情况故意不回音） |
| 通知卡里的进度条一直是 100% | `data/stats-cache.json` 是否陈旧 | 分母优先读 HUD 缓存（24 小时内有效），取不到才用 `contextWindowSize`。清掉 `stats-cache.json` 再等一轮 |
| 飞书回复跑到另一棵话题里 | `data/threads/<sessionId>.json` | 见 `docs/ARCHITECTURE.md` 8.3「一个窗口只能有一棵树」 |
| 桌面上堆了一堆空终端窗口 | 是不是窗口创建超时留下的 | 超时的窗口现在会自动关掉（按 sessionId 定位，不动你手动开的）。历史残留按 `%TEMP%\cc-launch-*.cmd` 里的 sessionId 对照 `data/sessions/` 手工清 |
| 新窗口开出来了但窗口留着一句「已退出进程」 | 正常现象 | 桥接只能关掉自己开的那个会话；窗口里的 `claude` 自己退出后，`cmd /k` 会保留标签页方便看报错。要关直接点标签页上的 ×，或在飞书里让桥接关（超时路径会自动关） |
| 飞书里发的图，窗口收不到 | `logs/image.log`、`data/images/<日期>/` | 正文里应出现 `[图片] /...png`。若窗口只收到 `img_v3_xxx` 字面量，说明图片标记没被识别——见 `plugins/core/src/session.js` 的 `IMAGE_MARK_RE`（飞书目前是 markdown 写法 `![Image](img_xxx)`，早期是 `[Image: img_xxx]`，两种都要认） |
| 图片文件越攒越多 | `imageTtlDays`（默认 7 天）、`data/images/` | 清理按**日期目录名**算，每小时一次。手工清理直接删 `data/images/<YYYYMMDD>/` 整个目录 |
| 配置页改完没生效 | 点的是「保存」还是「保存并重启」 | 配置只在启动时解析一次。「保存」只写文件；要生效用「保存并重启」 |
| 配置页点「保存并重启」失败 | 页面上的红字 | 它会先校验配置：有错就拒绝重启（否则进程停了新的起不来，就彻底失联）。按红字改完再试；`logs/error.log` 里有新进程起不来的原因 |
| 配置页报「令牌无效」 | 地址里的 `t=` 参数 | 每次启动换一个令牌。用**当前**终端里打印的完整地址，别用收藏的旧地址 |
| 配置页打不开 / 端口被占 | `--port` | 8787 被占时会自动换一个端口，看终端里打印的实际地址；也可以 `--port 9000` 指定 |
| 配置页拒绝保存 | 弹窗里的红字 | 它和 `kernel/config.js --check` 用的是同一个 `validate`，按红字改；`config.json` 本身不是合法 JSON 时会禁止保存，先手工修好 |
| 配置页改了值又改回去，文件里这个键没了 | 正常 | 值回到默认值就把该键删掉（省得文件越写越长）。没动过的键不会被动 |
| macOS/Linux 上换目录后数据目录跟着跑的疑问 | — | `data/` 在项目目录内，`setup/move.js` 会连它一起搬到新位置；图片等历史数据不会丢 |

---

## 自测

改完代码想确认没跑偏：

```bash
node setup/selftest/run.js
```

它在临时目录里起一整套沙箱（伪造的 lark-cli、伪造的会话管道、伪造的在场采样），
把主链路跑一遍，**不读也不写你任何真实配置**。加 `--keep` 保留沙箱目录便于排查。

> 沙箱有一道安全闸：数据目录必须在系统临时目录下，且不能是项目自己的 `data/`。
> 这道检查是补上来的——曾经因为环境变量没生效，自测清掉过一次真实数据。
