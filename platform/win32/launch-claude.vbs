' Launch a clean Claude Code window from the Feishu bridge.
' Usage: cscript //nologo launch-claude.vbs <sessionId> <cwd> [resumeSessionId]
'
'   <sessionId>        our own bookkeeping id (also the mapping key)
'   <cwd>              working directory to cd into
'   [resumeSessionId]  when given, run `claude --resume <that>` instead of
'                      `claude --session-id <sessionId>` (restore a past session)
'
' NOTE: keep this file pure ASCII. cscript reads scripts in the system ANSI code
' page, so a UTF-8 Chinese comment becomes invalid bytes and the whole script
' fails with a misleading "Expected statement" error at the first such line.
' All explanations live in docs/ARCHITECTURE.md instead.
'
' Why a .cmd is built first: the bridge runs as a child of a Claude Code session,
' so its environment carries CLAUDECODE / CLAUDE_CODE_CHILD_SESSION / *_SESSION_ID
' and the messaging socket+token. A new claude inheriting those either turns
' transcript saving off or points its inbox at the wrong session. The .cmd clears
' them before launching.
Option Explicit

Dim args, sessionId, cwd, resumeId, sh, fso, batPath, cmd, f, vars, i, wtExe, candidates

Set args = WScript.Arguments
If args.Count < 2 Then
  WScript.Echo "usage: launch-claude.vbs <sessionId> <cwd> [resumeSessionId]"
  WScript.Quit 2
End If

sessionId = args(0)
cwd       = args(1)
resumeId  = ""
If args.Count >= 3 Then resumeId = args(2)

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Fail fast when the target directory is missing. cmd.exe keeps going after a
' failed "cd /d", so claude would start in the inherited working directory and
' the user would get an unrelated session with no error at all.
If Not fso.FolderExists(Replace(cwd, "/", "\")) Then
  WScript.Echo "Directory not found: " & cwd
  WScript.Quit 3
End If

batPath = sh.ExpandEnvironmentStrings("%TEMP%") & "\cc-launch-" & Left(sessionId, 8) & ".cmd"

vars = Array("CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID", _
             "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", _
             "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_ENTRYPOINT", _
             "CLAUDE_CODE_EXECPATH", "CLAUDE_PID")

Set f = fso.CreateTextFile(batPath, True)
f.WriteLine "@echo off"
For i = 0 To UBound(vars)
  f.WriteLine "set " & vars(i) & "="
Next
' abort if cd fails, so claude never starts in the wrong cwd
f.WriteLine "cd /d """ & Replace(cwd, "/", "\") & """ || exit /b 1"
If resumeId <> "" Then
  ' resume keeps the old sessionId; the new process binds its own inbox socket
  f.WriteLine "claude --resume " & resumeId
Else
  f.WriteLine "claude --session-id " & sessionId
End If
f.Close

' -w new : brand-new terminal window; keep it open after claude exits
'
' wt.exe is usually NOT on PATH: it lives in %LOCALAPPDATA%\Microsoft\WindowsApps,
' a directory that only appears on an interactive logon PATH, and PATH inherited
' by a node child process often lacks it. Resolve the absolute path first, then
' fall back to the bare command.

wtExe = ""

candidates = Array( _
  sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Microsoft\WindowsApps\wt.exe", _
  "C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_8wekyb3d8bbwe\wt.exe")
For i = 0 To UBound(candidates)
  If wtExe = "" And fso.FileExists(candidates(i)) Then wtExe = candidates(i)
Next
If wtExe = "" Then wtExe = "wt.exe"

cmd = """" & wtExe & """ -w new new-tab --title ""claude " & Left(sessionId, 8) & """ cmd.exe /k """ & batPath & """"
sh.Run cmd, 1, False
