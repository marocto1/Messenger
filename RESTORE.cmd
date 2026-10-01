@echo off
cd /d "%~dp0"
if "%~1"=="" (echo Usage: RESTORE.cmd D:\path\to\backup& pause& exit /b 1)
set CONFIRM_RESTORE=YES
node scripts\restore.mjs "%~1"
pause
