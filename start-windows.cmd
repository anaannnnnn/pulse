@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.13 or newer from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist "server\.env" (
  copy /y "server\.env.example" "server\.env" >nul
  echo A server\.env file was created. Add your keys, save, and close Notepad.
  notepad "server\.env"
)
cd /d "%~dp0server"
call npm install --omit=dev
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)
echo.
echo Pulse is running at http://localhost:8787
echo Leave this window open. Close it to stop the server.
echo.
node dist\index.js
echo.
echo Pulse stopped.
pause
