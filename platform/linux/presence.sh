#!/bin/bash
# 在场采样器（Linux）。
#
# 用法：presence.sh --loop <输出文件> [--interval 毫秒] | --once
#
# 输出与 Windows/macOS 版同构的 JSON：
#   ok / ts / idleSeconds / locked / fgProc / windows
#
# 采不到就是采不到，绝不编：
#   空闲  xprintidle（X11）→ /dev/input 无权限时返回 -1（上层按「不知道」处理）
#   锁屏  loginctl LockedHint（systemd-logind）→ 拿不到返回 false 并照常工作
#   窗口  不采（判定不用；见 docs/ARCHITECTURE.md 第七节）

set -u

OUT=""
INTERVAL=1000
MODE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --loop) MODE="loop"; OUT="$2"; shift 2 ;;
    --once) MODE="once"; shift ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) shift ;;
  esac
done

[ -z "$MODE" ] && { echo "usage: presence.sh --loop <file> [--interval ms] | --once" >&2; exit 2; }

have() { command -v "$1" >/dev/null 2>&1; }

sample() {
  local idle=-1 locked=false ts

  # X11 下最可靠的来源
  if have xprintidle; then
    local ms
    ms=$(xprintidle 2>/dev/null || echo "")
    [ -n "$ms" ] && idle=$((ms / 1000))
  elif [ -n "${WAYLAND_DISPLAY:-}" ]; then
    # Wayland 没有通用接口。gnome 有扩展能提供，但不可靠，直接报「不知道」。
    idle=-1
  fi

  # 会话锁屏状态。systemd-logind 是主流发行版默认的。
  if have loginctl; then
    local sid
    sid=$(loginctl show-user "$(id -u)" -p Display --value 2>/dev/null || echo "")
    [ -z "$sid" ] && sid="${XDG_SESSION_ID:-}"
    if [ -n "$sid" ]; then
      case "$(loginctl show-session "$sid" -p LockedHint --value 2>/dev/null || echo '')" in
        yes) locked=true ;;
      esac
    fi
  fi

  ts=$(date +%s%3N 2>/dev/null || echo $(($(date +%s) * 1000)))
  printf '{"ok":true,"ts":%s,"idleSeconds":%s,"locked":%s,"fgProc":"","windows":[]}' \
    "$ts" "$idle" "$locked"
}

write_atomic() {
  local tmp="$1.tmp.$$"
  printf '%s' "$2" > "$tmp" && mv -f "$tmp" "$1"
}

if [ "$MODE" = "once" ]; then
  sample; echo; exit 0
fi

PARENT=$PPID
trap 'exit 0' TERM INT

while true; do
  write_atomic "$OUT" "$(sample)"
  if [ "$PPID" = "1" ] && [ "$PARENT" != "1" ]; then
    rm -f "$OUT"
    exit 0
  fi
  sleep "$(awk "BEGIN{printf \"%.3f\", $INTERVAL/1000}")"
done
