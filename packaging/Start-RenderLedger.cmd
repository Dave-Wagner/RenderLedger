@echo off
cd /d "%~dp0"
renderledger.exe gui --open
if errorlevel 1 pause
