' Launch a clean Claude Code window from the Feishu bridge.
' Usage: cscript //nologo launch-claude.vbs <sessionId> <cwd> [resumeSessionId]
'
'   <sessionId>        our own bookkeeping id (also the mapping key)
'   <cwd>              working directory to cd into
'   [resumeSessionId]  when given, run `claude --resume <that>` instead of
'                      `claude --session-id <sessionId>` (restore a past session)
'
' Critical: the bridge runs as a child of a Claude Code session, so its
' environment carries CLAUDECODE / CLAUDE_CODE_CHILD_SESSION / *_SESSION_ID
' and the messaging socket+token. A new claude inheriting those either turns
' transcript saving off or points its inbox at the wrong session. We therefore
' build a small .cmd that clears them before launching.
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
f.WriteLine "cd /d " & Replace(cwd, "/", "\")
If resumeId <> "" Then
  ' 恢复历史会话：复用旧 sessionId，新进程会绑定自己的 inbox socket
  f.WriteLine "claude --resume " & resumeId
Else
  f.WriteLine "claude --session-id " & sessionId
End If
f.Close

' -w new : brand-new terminal window; keep it open after claude exits
'
' wt.exe 不在 PATH 里是常态：它装在 %LOCALAPPDATA%\Microsoft\WindowsApps，
' 而这个目录只在交互式登录的 PATH 里出现，从 node 子进程继承来的 PATH 往往没有。
' 所以先找绝对路径，找不到再退回裸命令（PATH 里有的话仍能work）。

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
