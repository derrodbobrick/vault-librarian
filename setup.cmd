@echo off
rem Double-clickable wrapper for setup.ps1 - Bobrick OT Knowledge Base installer
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
echo.
pause
