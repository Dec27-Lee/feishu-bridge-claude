#!/bin/bash
# 在场采样器（macOS）。
#
# 用法：presence.sh --loop <输出文件> [--interval 毫秒]
#       presence.sh --once
#
# 输出一个 JSON 文件，字段与 Windows 版保持一致：
#   ok / ts / idleSeconds / locked / fgProc / windows
#
# 两个信号怎么来的：
#   空闲秒数  ioreg -c IOHIDSystem 的 HIDIdleTime（纳秒）
#   锁屏      CGSessionCopyCurrentDictionary 的 CGSSessionScreenIsLocked
#             —— 没装 PyObjC 时退回解析 loginwindow 进程状态
#
# 窗口列表在 macOS 上留空：判定逻辑不用它（见 docs/ARCHITECTURE.md 第七节），
# 采了也没人读，还得多调一次 CGWindowList。

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

if [ -z "$MODE" ]; then
  echo "usage: presence.sh --loop <file> [--interval ms] | --once" >&2
  exit 2
fi

# 探测一次「有没有 PyObjC」，别放到 sample() 里——
# 那是每秒一次的热路径，每次起一个 python3 进程光启动就要几十毫秒。
HAVE_QUARTZ=false
if /usr/bin/python3 -c 'import Quartz' >/dev/null 2>&1; then
  HAVE_QUARTZ=true
fi

# 每个 sample 内部只用一次外部命令，避免每秒 spawn 十几个进程
sample() {
  local idle locked ts

  # HIDIdleTime 单位是纳秒。取不到就给 -1（上层据此按「不知道」处理）。
  idle=$(ioreg -c IOHIDSystem 2>/dev/null \
    | awk '/HIDIdleTime/ {printf "%d", $NF / 1000000000; exit}')
  [ -z "$idle" ] && idle=-1

  # 锁屏判定。PyObjC 在系统自带的 python3 里不一定有（多数 Mac 没有），
  # 拿不到时退回读 ioreg 的 IOConsoleUsers。
  #
  # 注意：必须核对**值**，不能只 grep 键名。ioreg -a 输出的是 plist，
  # `<key>CGSSessionScreenIsLocked</key>` 这一行在没锁屏时也存在（后面跟 <false/>）。
  # 只 grep 键名会让「锁屏」恒为 true，后果是所有提问都推手机、终端永远不弹窗。
  locked=false
  if [ "$HAVE_QUARTZ" = true ]; then
    locked=$(/usr/bin/python3 -c '
import Quartz
d = Quartz.CGSessionCopyCurrentDictionary() or {}
print("true" if d.get("CGSSessionScreenIsLocked", 0) else "false")
' 2>/dev/null || echo false)
  else
    if ioreg -n Root -d1 -a 2>/dev/null \
      | tr -d '\n' \
      | grep -q '<key>CGSSessionScreenIsLocked</key>[[:space:]]*<true/>'; then
      locked=true
    fi
  fi

  # 时间戳只要毫秒级够用。macOS 的 date 不支持 %3N，之前用 node 取——
  # 但这是每秒一次的热路径，起一个 node 进程约 30-50ms，白烧 CPU。
  # 秒级精度完全够（没人读这个字段做精确计算；新鲜度判定用的是文件 mtime）。
  ts=$(( $(date +%s) * 1000 ))

  printf '{"ok":true,"ts":%s,"idleSeconds":%s,"locked":%s,"fgProc":"","windows":[]}' \
    "$ts" "$idle" "$locked"
}

write_atomic() {
  local tmp="$1.tmp.$$"
  printf '%s' "$2" > "$tmp" && mv -f "$tmp" "$1"
}

if [ "$MODE" = "once" ]; then
  sample
  echo
  exit 0
fi

# bridge 挂掉时子进程不该一直活着：父进程 pid 变了就退出
PARENT=$PPID
trap 'exit 0' TERM INT

while true; do
  write_atomic "$OUT" "$(sample)"
  # 父进程没了（被 1 收养）就自己退，别留孤儿进程
  if [ "$PPID" = "1" ] && [ "$PARENT" != "1" ]; then
    rm -f "$OUT"
    exit 0
  fi
  sleep "$(awk "BEGIN{printf \"%.3f\", $INTERVAL/1000}")"
done
