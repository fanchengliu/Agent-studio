@echo off
cd /d "%~dp0"
if not exist node_modules\electron\package.json (
  echo Please run npm ci first.
  pause
  exit /b 1
)
node scripts\ensure-electron.mjs
if errorlevel 1 (
  pause
  exit /b 1
)
if not exist dist\index.html (
  call npm run build
  if errorlevel 1 exit /b 1
)
start "" node_modules\electron\dist\electron.exe .
