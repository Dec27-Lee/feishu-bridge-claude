' Keep the Feishu bridge alive.
' Runs forever: starts the bridge, waits for it to exit, restarts after a pause.
' This is what the logon shortcut launches, so a crash recovers without you.
'
' IMPORTANT: this file must stay pure ASCII with CRLF line endings.
' Windows script hosts read .vbs in the ANSI code page (GBK on a Chinese
' Windows). Non-ASCII comments saved as UTF-8 get mangled into stray quotes,
' and cscript then exits silently at parse time: exit code 0, no error, no
' node process, nothing in the logs. That looked exactly like "the bridge
' crashed and never came back" for 35 hours after a reboot.
' `node setup/check.js` verifies both properties.
Option Explicit

Dim sh, fso, here, root, restarts
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Paths come from this file's own location - no absolute path is hardcoded,
' so this works after moving the project or copying it to another machine.
here = fso.GetParentFolderName(WScript.ScriptFullName)        ' platform\win32
root = fso.GetParentFolderName(fso.GetParentFolderName(here)) ' project root

restarts = 0

Do
  ' Single-instance protection lives in the kernel (data/bridge.pid);
  ' this loop only starts the process and blocks until it exits.
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
