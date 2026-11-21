@echo off
setlocal

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo Game Audio Outsourcing Doc Tool
echo Project directory: %ROOT%
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js LTS, then run this file again.
  start "" "https://nodejs.org/zh-cn/download"
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please reinstall Node.js LTS with npm enabled.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Building UI and server...
call npm run build
if errorlevel 1 (
  echo npm run build failed.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://localhost:4317/api/health' -TimeoutSec 2; if ($r.ok) { exit 0 } else { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
  echo Starting local server: http://localhost:4317/
  start "Spielkiste Web" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:PORT='4317'; Set-Location -LiteralPath '%ROOT%'; node scripts/start-web.mjs"
)

echo Waiting for local server...
for /l %%i in (1,1,20) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://localhost:4317/api/health' -TimeoutSec 1; if ($r.ok) { exit 0 } else { exit 1 } } catch { exit 1 }"
  if not errorlevel 1 goto READY
  ping -n 2 127.0.0.1 >nul
)

echo Local server start timed out. Please check whether port 4317 is occupied.
pause
exit /b 1

:READY
set "SFX_PORT=4320"
echo Starting or refreshing video sound workspace: http://127.0.0.1:4320/sfx
start "Video Sound Workspace" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "$env:PORT='4320'; $env:SFX_OPEN_BROWSER='0'; $env:SFX_FORCE_REFRESH='1'; $env:SPIELKISTE_DISABLE_TOOL_WATCHER='1'; Set-Location -LiteralPath '%ROOT%'; node scripts/start-sfx.mjs"
for /l %%i in (1,1,20) do (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-RestMethod -Uri 'http://127.0.0.1:4320/api/sfx/health' -TimeoutSec 1; if ($r.ok) { exit 0 } else { exit 1 } } catch { exit 1 }"
  if not errorlevel 1 goto SFX_READY
  ping -n 2 127.0.0.1 >nul
)
echo Video sound workspace start timed out; opening the main tool instead.
start "" "http://127.0.0.1:4317/"
goto DONE

:SFX_READY
echo Opening video sound workspace: http://127.0.0.1:4320/sfx
start "" "http://127.0.0.1:4320/sfx"

:DONE
echo Ready. One launcher now starts both local workspaces.
ping -n 4 127.0.0.1 >nul
endlocal
