@echo off
rem EightMax Test Workbench 0.36.2-dev - MILESTONE 3 Windows tests (kept for compatibility).
rem Milestone 3.1 replaces this runner: this file now starts RUN-0362-MILESTONE3.1-TESTS.cmd with option C (full acceptance).
rem The Milestone 3 options still work and are passed on, for example:  RUN-0362-MILESTONE3-TESTS.cmd -FullSuite -StabilitySeconds 60
rem Results are no longer written into this folder: see READ-ME-MILESTONE-3.1.txt (the Milestone 3 test-results\ location made the
rem release-checksum test fail on the operator's PC).
setlocal
set "EIGHTMAX_M31_ARGS=%*"
call "%~dp0RUN-0362-MILESTONE3.1-TESTS.cmd" C
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
