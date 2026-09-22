@echo off
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] PowerShell not found.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-main.ps1"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
  echo [FAILED] Update did not complete. Exit code: %RC%
) else (
  echo [OK] Update completed.
)

echo.
pause
exit /b %RC%
