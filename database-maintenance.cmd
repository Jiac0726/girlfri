@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0database-maintenance.ps1"
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
  echo [FAILED] Database maintenance did not complete. Exit code: %RC%
) else (
  echo [OK] Database backup and index migration completed.
)

echo.
pause
exit /b %RC%
