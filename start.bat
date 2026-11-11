@echo off
title Unity Orchestrator
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install it from https://nodejs.org
  pause
  exit /b 1
)
where claude >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Claude Code CLI "claude" not found in PATH.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

rem Open the page after the server is up
start "" /min cmd /c "timeout /t 6 >nul & start http://localhost:5173"

echo Starting Unity Orchestrator. Close this window to stop it.
call npm run dev
pause
