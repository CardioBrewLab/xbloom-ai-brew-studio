@echo off
rem ============================================================
rem  xBloom AI - one-click silent launcher (compat entry)
rem  ------------------------------------------------------------
rem  Launches a HIDDEN watchdog (watchdog-xbloom.ps1) via
rem  launch-xbloom.vbs. The watchdog starts the backend (8787)
rem  and frontend (5180) in HIDDEN windows, auto-restarts any
rem  crashed service within a few seconds, and opens the browser
rem  to http://localhost:5180 once the frontend is ready.
rem
rem  This .bat can be used as the target of a desktop shortcut. Its own window
rem  flashes only briefly then exits; NO residual terminal windows remain
rem  on the desktop or taskbar. For a fully silent (zero-flash)
rem  launch, set the shortcut's Run style to "Minimized"/Hidden.
rem  To stop everything: run stop-xbloom.bat
rem ============================================================
setlocal EnableExtensions
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

if not exist "%ROOT%\node_modules" (
    echo [xBloom] First run: preparing the local runtime and dependencies...
    call "%ROOT%\install-windows.bat"
    exit /b %ERRORLEVEL%
)

if not exist "%ROOT%\launch-xbloom.vbs" (
    echo [xBloom] ERROR: launch-xbloom.vbs not found at "%ROOT%\launch-xbloom.vbs"
    pause
    exit /b 1
)
if not exist "%ROOT%\watchdog-xbloom.ps1" (
    echo [xBloom] ERROR: watchdog-xbloom.ps1 not found at "%ROOT%\watchdog-xbloom.ps1"
    pause
    exit /b 1
)

rem wscript.exe is a GUI-subsystem host -> no console window is created at all.
start "" wscript.exe "%ROOT%\launch-xbloom.vbs"
exit /b 0
