@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0v2-migrate-legacy.ps1" %*
set "code=%ERRORLEVEL%"
echo.
if not "%code%"=="0" (
  echo [FAILED] V2 legacy migration did not complete. Exit code: %code%
) else (
  echo [OK] Migration command completed. Verify marker.status = completed before release.
)
echo.
pause
exit /b %code%
