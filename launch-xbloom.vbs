' xBloom AI silent launcher.
'   Starts the PowerShell watchdog in a HIDDEN window (no console at all), then exits.
'   The watchdog runs detached and survives this script ending.
'   Called by start-xbloom.bat (and by the desktop shortcut via start-xbloom.bat).
'   ASCII-only file (encoding-safe).
Option Explicit
Dim fso, sh, root, ps1, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = root & "\watchdog-xbloom.ps1"
If Not fso.FileExists(ps1) Then
    WScript.Quit 2
End If
Set sh = CreateObject("WScript.Shell")
' 0 = hidden window, False = do not wait for completion (detached).
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
sh.Run cmd, 0, False
Set sh = Nothing
Set fso = Nothing
WScript.Quit 0
