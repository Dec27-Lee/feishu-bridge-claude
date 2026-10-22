#!/bin/bash
# 卸载开机自启（Linux）。
#
#   bash platform/linux/remove-autostart.sh

set -eu

UNIT="$HOME/.config/systemd/user/feishu-bridge.service"

if [ -f "$UNIT" ] && command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now feishu-bridge.service 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "已移除自启：$UNIT"
else
  echo "没有找到 systemd 自启项，无需处理。"
fi

echo "注意：已启动的 bridge 进程仍在跑。要一并停掉："
echo "  kill \$(cat data/bridge.pid)"
