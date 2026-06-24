@echo off
setlocal
cd /d "%~dp0"

set "PORT=3784"
if not "%~1"=="" set "PORT=%~1"

echo Stopping AIM4 servers on port %PORT%...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  echo   Killing PID %%a
  taskkill /F /PID %%a >nul 2>&1
)

echo Done.
pause
