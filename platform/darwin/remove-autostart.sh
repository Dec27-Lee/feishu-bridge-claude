#!/bin/bash
# 卸载开机自启（macOS）。
#
#   bash platform/darwin/remove-autostart.sh

set -eu

LABEL="com.feishu.bridge.claude"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已移除自启：$PLIST"
else
  echo "没有找到自启项，无需处理。"
fi

echo "注意：已启动的 bridge 进程仍在跑。要一并停掉："
echo "  kill \$(cat data/bridge.pid)"
