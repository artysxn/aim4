@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=3784"
if not "%~1"=="" set "PORT=%~1"

echo.
echo ============================================================
echo   AIM4.io - Host Server
echo ============================================================
echo.

echo [1/4] Stopping old servers on port %PORT%...
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)

echo [2/4] Allowing port %PORT% through Windows Firewall (needs admin)...
netsh advfirewall firewall delete rule name="AIM4 %PORT%" >nul 2>&1
netsh advfirewall firewall add rule name="AIM4 %PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul 2>&1
if errorlevel 1 (
  echo   ^(Could not add firewall rule - run this script as Administrator,
  echo    or manually allow TCP port %PORT% if friends cannot connect.^)
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not on PATH.
  echo Install from https://nodejs.org/ then run this script again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo [3/4] Building game client...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)

echo [4/4] Starting server on all network interfaces, port %PORT%...
echo.
set AIM4_SERVE_STATIC=1
set AIM4_HOST=0.0.0.0
set AIM4_API_PORT=%PORT%

node server\index.js

echo.
echo Server stopped.
pause
