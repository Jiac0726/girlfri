@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0database-migrate.ps1"
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo [OK] Database migration completed.
) else (
  echo [STOP] Database migration did not fully complete. Exit code: %RC%
)
echo.
pause
exit /b %RC%
