#!/bin/bash
# 安装开机自启（macOS）：往 ~/Library/LaunchAgents 放一个 plist。
#
#   bash platform/darwin/install-autostart.sh
#
# 用 launchd 而不是 crontab：
#   - 登录即启动（RunAtLoad），进程挂了 KeepAlive 会拉起来
#   - 不需要 root
#
# 日志写在项目 logs/launchd.{out,err}.log，出问题先看这两个。

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
LABEL="com.feishu.bridge.claude"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "找不到 node，请先安装 Node.js ≥ 18" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$ROOT/logs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/kernel/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/launchd.err.log</string>
</dict>
</plist>
EOF

# 已加载的先卸掉，避免 load 报 "already loaded"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "已安装自启：$PLIST"
echo "现在起一次：launchctl start $LABEL"
echo "看状态：    launchctl list | grep $LABEL"
