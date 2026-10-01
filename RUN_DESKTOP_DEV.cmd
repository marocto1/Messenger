@echo off
setlocal
cd /d "%~dp0"
title Marocto Messenger 1.0
node scripts\run.mjs desktop
if errorlevel 1 pause
