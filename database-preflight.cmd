@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0database-preflight.ps1"
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo [OK] Pre-flight passed. No database data was changed.
) else (
  echo [STOP] Pre-flight found a problem or could not complete. Exit code: %RC%
)
echo.
pause
exit /b %RC%
