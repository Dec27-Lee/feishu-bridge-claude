' Start the Feishu bridge silently (no console window).
' Double-click to run. 单实例保护在内核里（data/bridge.pid）。
Option Explicit

Dim sh, fso, here, root
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(fso.GetParentFolderName(here))

sh.CurrentDirectory = root
sh.Run "node """ & root & "\kernel\index.js""", 0, False
