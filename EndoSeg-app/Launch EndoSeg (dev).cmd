@echo off
rem Double-click launcher for running EndoSeg in development mode.
rem Node lives in Program Files and may not be on PATH on this machine.
set "PATH=%PATH%;C:\Program Files\nodejs"
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing dependencies for the first time...
  call npm.cmd install
)
echo Starting EndoSeg...
call npm.cmd run dev
pause
