@echo off
rem EightMax Test Workbench 0.36.2-dev - MILESTONE 3 Windows tests: tournament hand tracking with eliminated players, automatic recovery
rem after an untracked hand, multi-table stability, test-runner cleanup and the desktop-host fallback compile, with REAL windows.
rem Nothing needs to be installed (bundled Node.js, bundled programs, Windows PowerShell).
rem The mouse moves by itself inside the EightMax test tables for about 40-60 minutes: do not touch the mouse or keyboard.
rem Results: test-results\Milestone3-<date-time>\ next to this file (and a .zip of it). Read READ-ME-MILESTONE3-TESTS.txt.
setlocal
cd /d "%~dp0"
echo EightMax 0.36.2 Milestone 3 tests. Close the EightMax Workbench and its dashboard before continuing.
echo The mouse will move by itself inside the test tables. Do not touch the mouse or keyboard until the end (about 40-60 minutes).
pause
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0windows\Test-Milestone3-0362.ps1" %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" (echo MILESTONE 3 TESTS PASSED.) else (echo MILESTONE 3 TESTS FAILED - send the results ZIP named above.)
pause
endlocal & exit /b %RC%
