@echo off
setlocal
REM AIM4 local demo parser — opens a drag-and-drop GUI.
REM   Double-click                     -> GUI
REM   Drop .dem files onto this .bat   -> GUI with those demos queued
REM   parse-demo.bat --cli match.dem   -> command-line only
REM
REM Requires Node.js 20+ and (from the repo root): npm install @laihoe/demoparser2

set "TOOLS=%~dp0"
set "GUI=%TOOLS%parse-demo-gui.ps1"
set "CLI=%TOOLS%parse-demo-local.js"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install Node 20+ from https://nodejs.org/ then retry.
  pause
  exit /b 1
)

if /I "%~1"=="--cli" goto :cli_shift

powershell -NoProfile -ExecutionPolicy Bypass -File "%GUI%" %*
if errorlevel 1 (
  echo.
  echo Could not open the GUI. You can still parse from a terminal:
  echo   "%~nx0" --cli path\to\match.dem
  pause
)
exit /b %ERRORLEVEL%

:cli_shift
shift
if "%~1"=="" (
  echo Usage: %~nx0 --cli match.dem [more.dem ...]
  exit /b 1
)
node "%CLI%" %*
exit /b %ERRORLEVEL%
