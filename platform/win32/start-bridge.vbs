' Start the Feishu bridge silently (no console window).
' Double-click to run. Single-instance protection lives in the kernel
' (data/bridge.pid), so running this twice is harmless.
'
' Keep this file pure ASCII with CRLF line endings - see watch-bridge.vbs
' for why (cscript reads .vbs in the ANSI code page and fails silently).
Option Explicit

Dim sh, fso, here, root
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(fso.GetParentFolderName(here))

sh.CurrentDirectory = root
sh.Run "node """ & root & "\kernel\index.js""", 0, False
