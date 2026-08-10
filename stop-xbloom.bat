@echo off
rem xBloom AI - stop the hidden watchdog + services (8787 / 5180).
setlocal EnableExtensions
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\stop-xbloom.ps1"
exit /b 0
