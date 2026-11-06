@echo off
set "SETUP=%LOCALAPPDATA%\RenderLedger\Setup-Runtime.ps1"
if not exist "%SETUP%" (
  echo Run Install-RenderLedger.cmd first.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SETUP%" -CloudOnly
set "RESULT=%ERRORLEVEL%"
pause
exit /b %RESULT%
