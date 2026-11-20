@echo off
setlocal
cd /d "%~dp0"

echo Spielkiste - local video sound workbench
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required.
  echo Please install Node.js LTS, then run Spielkiste.bat again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm was not found. Please reinstall Node.js LTS with npm enabled.
  pause
  exit /b 1
)

if not exist "node_modules\typescript\bin\tsc" (
  echo First run: installing dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

call npm run sfx
if errorlevel 1 pause

endlocal
