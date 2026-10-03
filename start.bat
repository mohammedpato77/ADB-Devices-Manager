@echo off
REM ============================================================
REM  ADB Device Setup - Windows start script
REM  Installs dependencies (first run), then starts the local
REM  server on http://localhost:3000
REM ============================================================
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is required but was not found in PATH.
  echo Install Node.js from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo Starting ADB Device Setup...
echo Open http://localhost:3000 in your browser
start "" http://localhost:3000
node server.js
