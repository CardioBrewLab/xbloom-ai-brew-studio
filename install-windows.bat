@echo off
setlocal EnableExtensions
title xBloom AI Brew Studio Installer
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
if errorlevel 1 (
  echo.
  echo Installation stopped. Read the message above, then run this file again.
  pause
  exit /b 1
)
exit /b 0
