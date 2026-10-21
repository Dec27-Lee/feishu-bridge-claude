' Keep the Feishu bridge alive.
' Runs forever: starts the bridge, waits for it to exit, restarts after a pause.
' This is what the logon shortcut launches, so a crash recovers without you.
Option Explicit

Dim sh, fso, here, root, restarts
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 路径取自本文件所在目录，不写死任何绝对路径——换机器、换目录都能用
here = fso.GetParentFolderName(WScript.ScriptFullName)        ' platform\win32
root = fso.GetParentFolderName(fso.GetParentFolderName(here)) ' 项目根

restarts = 0

Do
  ' Wait for node's own single-instance lock is handled by the kernel;
  ' 这里只管跑起来并阻塞到它退出。
  sh.CurrentDirectory = root
  sh.Run "node """ & root & "\kernel\index.js""", 0, True
  restarts = restarts + 1

  ' Back off a little so a permanently broken config does not spin the CPU.
  If restarts < 5 Then
    WScript.Sleep 5000
  ElseIf restarts < 20 Then
    WScript.Sleep 30000
  Else
    WScript.Sleep 300000
  End If
Loop
