@echo off
setlocal
cd /d "%~dp0"
set WORKERS=%1
if "%WORKERS%"=="" set WORKERS=3
node start.js --workers=%WORKERS%
endlocal
