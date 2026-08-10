@echo off
setlocal
cd /d "%~dp0cloudflare"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\deploy-cloudflare.ps1" %*
if errorlevel 1 pause
