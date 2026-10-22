#!/bin/bash
# 在 macOS / Linux 上开一个干净的 Claude Code 窗口。
#
# 用法：launch-claude.sh <sessionId> <cwd> [resumeSessionId]
#
# macOS：用 osascript 让 Terminal.app 新开一个窗口执行；装了 iTerm 就优先 iTerm。
# Linux：依次试 gnome-terminal / konsole / xfce4-terminal / xterm，都没有就报错让人手动开。
#
# 与 Windows 版同样的关键动作：清空继承来的 CLAUDE* 会话变量，
# 否则新窗口会关掉转录保存、或把 inbox 指到错误的会话上。

set -u

SESSION_ID="${1:-}"
CWD="${2:-}"
RESUME_ID="${3:-}"

if [ -z "$SESSION_ID" ] || [ -z "$CWD" ]; then
  echo "usage: launch-claude.sh <sessionId> <cwd> [resumeSessionId]" >&2
  exit 2
fi

if [ -n "$RESUME_ID" ]; then
  CLAUDE_ARGS="--resume $RESUME_ID"
else
  CLAUDE_ARGS="--session-id $SESSION_ID"
fi

# 解析 claude 的绝对路径。
# 从 launchd / systemd 起来的进程拿到的是最小 PATH（通常只有 /usr/bin:/bin），
# 而 claude 多半装在 ~/.npm-global/bin、/usr/local/bin 或 nvm 目录下——
# 不解析就会在终端里报 command not found，而 bridge 那边只看到「30 秒未注册」。
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [ -z "$CLAUDE_BIN" ]; then
  for c in "$HOME/.local/bin/claude" "$HOME/.npm-global/bin/claude" \
           "/usr/local/bin/claude" "/opt/homebrew/bin/claude" \
           "$HOME/.volta/bin/claude" "$HOME/.bun/bin/claude"; do
    [ -x "$c" ] && CLAUDE_BIN="$c" && break
  done
fi

# 写一个临时启动脚本：清环境 → 补 PATH → cd → 起 claude → 退出时保留窗口（方便看报错）
# mktemp 会先建一个空文件，而我们要写的是它加 .sh 的名字——把空文件删掉，别每次泄漏一个
TMP="$(mktemp -t cc-launch-XXXXXX)"
BAT="${TMP}.sh"
rm -f "$TMP"
cat > "$BAT" <<EOF
#!/bin/bash
unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN
unset CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_PID
# 从服务管理器继承来的 PATH 往往缺用户级目录，补上常见的几处
export PATH="\$HOME/.local/bin:\$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:\$HOME/.volta/bin:\$PATH"
if [ ! -d "$CWD" ]; then
  echo "目录不存在：$CWD" >&2
  rm -f "\$0"
  exec bash
fi
cd "$CWD" || { rm -f "\$0"; exec bash; }
CLAUDE_CMD="$CLAUDE_BIN"
\${CLAUDE_CMD:-claude} $CLAUDE_ARGS
# 跑到这里说明 claude 已退出，本脚本自身的内容已全部读完，可以安全删掉
rm -f "\$0"
exec bash
EOF
chmod +x "$BAT"

if [ -z "$CLAUDE_BIN" ]; then
  echo "警告：没找到 claude 命令，窗口里可能会报 command not found" >&2
fi

if [ "$(uname)" = "Darwin" ]; then
  if [ -d "/Applications/iTerm.app" ]; then
    osascript <<APPLESCRIPT
tell application "iTerm"
  activate
  set newWindow to (create window with default profile)
  tell current session of newWindow
    write text "bash '$BAT'"
  end tell
end tell
APPLESCRIPT
  else
    osascript <<APPLESCRIPT
tell application "Terminal"
  activate
  do script "bash '$BAT'"
end tell
APPLESCRIPT
  fi
else
  for term in gnome-terminal konsole xfce4-terminal xterm; do
    if command -v "$term" >/dev/null 2>&1; then
      # 后台启动 + 立刻返回。不用 exec：exec 会把这个脚本换成常驻的终端进程，
      # 调用方（bridge 的 spawnSync）就永远等不到退出，最后只能吃满 20 秒超时。
      # 也不用前台：xterm / konsole 会阻塞到窗口关闭为止。
      case "$term" in
        gnome-terminal) "$term" -- bash "$BAT" >/dev/null 2>&1 & ;;
        konsole)        "$term" -e bash "$BAT" >/dev/null 2>&1 & ;;
        *)              "$term" -e "bash '$BAT'" >/dev/null 2>&1 & ;;
      esac
      sleep 0.5
      exit 0
    fi
  done
  echo "找不到可用的终端程序（试过 gnome-terminal / konsole / xfce4-terminal / xterm）" >&2
  echo "请手动开一个终端并执行：bash '$BAT'" >&2
  exit 1
fi
