@echo off
cd /d "%~dp0"
title SP Advisor
echo ============================================
echo   SP Advisor - Tactical Web Server
echo ============================================
echo.
where node >nul 2>nul
if errorlevel 1 goto NONODE
echo Starting... your browser will open http://localhost:8765
echo (Close this window to stop the server.)
echo.
start "" http://localhost:8765
node server.mjs
echo.
echo Server stopped.
pause
exit /b 0
:NONODE
echo [ERROR] Node.js not found. Install it from https://nodejs.org/
echo.
pause
exit /b 1
