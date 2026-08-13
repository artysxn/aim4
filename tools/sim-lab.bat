@echo off
setlocal
REM AIM4 local sim lab. Opens http://127.0.0.1:8742 in the browser.
REM Double-click this file, or from the repo root: npm run sim:lab

set "TOOLS=%~dp0"
set "ROOT=%TOOLS%.."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install Node 22+ from https://nodejs.org/ then retry.
  pause
  exit /b 1
)

cd /d "%ROOT%"
node "%TOOLS%sim-lab.mjs"
if errorlevel 1 (
  echo.
  echo Sim lab exited with an error.
  pause
)
exit /b %ERRORLEVEL%
