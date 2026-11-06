@echo off
cd /d "%~dp0"
renderledger.exe gui
if errorlevel 1 pause
