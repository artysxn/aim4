@echo off
setlocal
REM Parse CS2 .dem files on this PC into .aim4replay packages for website upload.
REM Requires Node.js 20+ and (from the repo root): npm install @laihoe/demoparser2

set "SCRIPT=%~dp0parse-demo-local.js"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install Node 20+ from https://nodejs.org/ then retry.
  exit /b 1
)

node "%SCRIPT%" %*
exit /b %ERRORLEVEL%
