# 卸载开机自启。
#   powershell -ExecutionPolicy Bypass -File platform\win32\remove-autostart.ps1

$ErrorActionPreference = 'Stop'

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'ClaudeFeishuBridge.lnk'

if (Test-Path $lnk) {
  Remove-Item $lnk -Force
  Write-Output "已移除自启：$lnk"
} else {
  Write-Output "没有找到自启项，无需处理。"
}

Write-Output '注意：已启动的 bridge 进程仍在跑。要一并停掉：'
Write-Output '  Get-Content data\bridge.pid | ForEach-Object { Stop-Process -Id $_ -Force }'
