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

# 写一个临时启动脚本：清环境 → cd → 起 claude → 退出时保留窗口（方便看报错）
TMP="$(mktemp -t cc-launch-XXXXXX)"
BAT="${TMP}.sh"
cat > "$BAT" <<EOF
#!/bin/bash
unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ID
unset CLAUDE_CODE_MESSAGING_SOCKET CLAUDE_CODE_MESSAGING_TOKEN
unset CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_EXECPATH CLAUDE_PID
cd "$CWD" || exit 1
claude $CLAUDE_ARGS
exec bash
EOF
chmod +x "$BAT"

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
      case "$term" in
        gnome-terminal) exec "$term" -- bash "$BAT" ;;
        konsole)        exec "$term" -e bash "$BAT" ;;
        *)              exec "$term" -e "bash '$BAT'" ;;
      esac
    fi
  done
  echo "找不到可用的终端程序（试过 gnome-terminal / konsole / xfce4-terminal / xterm）" >&2
  echo "请手动开一个终端并执行：bash '$BAT'" >&2
  exit 1
fi
