#!/bin/bash
# 安装开机自启（Linux）：systemd --user 单元。
#
#   bash platform/linux/install-autostart.sh
#
# 需要 systemd（主流发行版默认）。没有 systemd 时脚本会给出 crontab 的替代写法。

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="$UNIT_DIR/feishu-bridge.service"
NODE="$(command -v node || true)"

if [ -z "$NODE" ]; then
  echo "找不到 node，请先安装 Node.js ≥ 18" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "没有 systemd。可以用 crontab 代替："
  echo "  (crontab -l 2>/dev/null; echo \"@reboot $NODE $ROOT/kernel/index.js >> $ROOT/logs/bridge.out.log 2>&1\") | crontab -"
  exit 1
fi

mkdir -p "$UNIT_DIR" "$ROOT/logs"

cat > "$UNIT" <<EOF
[Unit]
Description=Feishu bridge for Claude Code
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/kernel/index.js
Restart=on-failure
RestartSec=10
StandardOutput=append:$ROOT/logs/systemd.out.log
StandardError=append:$ROOT/logs/systemd.err.log

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now feishu-bridge.service

echo "已安装并启动：$UNIT"
echo "看状态：systemctl --user status feishu-bridge"
echo "看日志：journalctl --user -u feishu-bridge -f"
echo
echo "提示：要让服务在未登录时也运行，需要：sudo loginctl enable-linger \$USER"
