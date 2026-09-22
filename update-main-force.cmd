@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-main.ps1" -Force
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  echo [FAILED] Force update did not complete. Exit code: %RC%
) else (
  echo [OK] Force update completed.
)
echo.
pause
exit /b %RC%
