# 关掉桥接自己开的那个终端窗口（按 sessionId 前 8 位定位）。
#
#   powershell -File close-window.ps1 <前8位>
#
# 为什么不是 taskkill WindowsTerminal.exe：那会把用户自己的所有标签页一起关掉。
# 为什么不止杀进程：进程被杀后 Windows Terminal 会留下一个「进程已退出」的标签页，
# 窗口还在，用户看到的仍是「又开了一堆终端」——所以这里按窗口标题发 WM_CLOSE，
# 只关这一个标签页。
#
# 标题由 launch-claude.vbs 设定，固定是 `claude <前8位>`，不会和用户手开的窗口撞名。

param([Parameter(Mandatory = $true)][string]$Tag)

$sig = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class FeishuWin {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lp, IntPtr l);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  delegate bool EnumProc(IntPtr h, IntPtr l);

  public static int CloseByTitle(string title) {
    int n = 0;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString() == title) {
        PostMessage(h, 0x0010 /* WM_CLOSE */, IntPtr.Zero, IntPtr.Zero);
        n++;
      }
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@

try {
  Add-Type -TypeDefinition $sig -ErrorAction Stop
} catch {
  # 同一个 PowerShell 会话里重复 Add-Type 会报「类型已存在」，忽略即可
}

$count = [FeishuWin]::CloseByTitle("claude $Tag")
if ($count -gt 0) { Write-Output "closed $count" }
