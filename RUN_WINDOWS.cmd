@echo off
setlocal
cd /d "%~dp0"
title Marocto Messenger 1.0
node scripts\run.mjs web
if errorlevel 1 pause
