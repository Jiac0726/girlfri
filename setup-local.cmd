@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-local.ps1"
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" (
  echo [FAILED] Local setup failed. Exit code: %RC%
) else (
  echo [OK] Local setup completed.
)
echo.
pause
exit /b %RC%
