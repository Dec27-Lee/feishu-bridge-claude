# 安装开机自启：在启动文件夹放一个指向 watch-bridge.vbs 的快捷方式。
#
# 由 setup/install.js 调用，也可以单独跑：
#   powershell -ExecutionPolicy Bypass -File platform\win32\install-autostart.ps1
#
# 为什么用「启动文件夹 + VBS」而不是注册表 Run 键：
#   VBS 能以隐藏窗口方式起 node，Run 键起的会是可见控制台窗口。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$watch = Join-Path $root 'platform\win32\watch-bridge.vbs'
if (-not (Test-Path $watch)) { throw "找不到 $watch" }

$startup = [Environment]::GetFolderPath('Startup')
$lnk = Join-Path $startup 'ClaudeFeishuBridge.lnk'

$sh = New-Object -ComObject WScript.Shell
$sc = $sh.CreateShortcut($lnk)
$sc.TargetPath = 'wscript.exe'
$sc.Arguments = "//B //Nologo `"$watch`""
$sc.WorkingDirectory = $root
$sc.WindowStyle = 7          # 最小化，实际不可见（VBS 自己也是隐藏启动）
$sc.Description = 'Claude Code 飞书桥接（常驻）'
$sc.Save()

Write-Output "已安装自启：$lnk"
Write-Output "现在起一次（不必等重启）：wscript.exe //B //Nologo `"$watch`""
