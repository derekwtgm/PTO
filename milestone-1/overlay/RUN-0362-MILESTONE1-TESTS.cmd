@echo off
rem EightMax Test Workbench 0.36.2-dev - Milestone 1 focused Windows checks: build identity, startup, communication, shutdown.
rem The input self-test moves the visible cursor inside its own small window for about 20 seconds: do not touch the mouse.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Test-Milestone1-0362.ps1" -WithInputSelfTest %*
if errorlevel 1 (echo MILESTONE 1 CHECKS FAILED - see the report path printed above) else (echo Milestone 1 checks passed.)
pause
endlocal
