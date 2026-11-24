@echo off
rem ==============================================================================================================================
rem EightMax Test Workbench 0.36.2 - MILESTONE 3.2 STANDALONE T5 TEST (the repaired window-loss handling, without the full suite)
rem Two EightMax test tables play at the same time with real screen capture and real mouse input; the window of table 2 is closed
rem while it plays (T5) and while it is paused by a click its table did not apply (T5P - the situation of the 2026-11-24 run).
rem Checks: TARGET_LOST, the scheduler blocks only table 2, no input reaches the closed window, table 1 keeps playing, cleanup.
rem Before that: release integrity, components, the Milestone 3.2 regression tests and the desktop host + input driver start.
rem ALWAYS saves a report and a ZIP - also after a failure, a time-out, Ctrl+C or when PowerShell itself cannot run.
rem About 8-15 minutes. THE MOUSE MOVES BY ITSELF inside the test tables. Nothing needs to be installed.
rem   Double-click it.   Optional:  RUN-M3.2-T5-TEST.cmd "D:\another results folder"
rem   Repetitions (default 3):      set EIGHTMAX_T5_REPEAT=5  before starting it from a Command Prompt
rem Results: %LOCALAPPDATA%\EightMax-Test-Workbench\TestResults\Milestone3.2-T5-<date>-<time>-t5-test\milestone3-results.zip
rem Exit codes: 0 PASS  1 FAIL  2 test-runner error  3 environment problem  4 interrupted  5 the launcher could not start the test
rem ==============================================================================================================================
setlocal EnableExtensions DisableDelayedExpansion
title EightMax Milestone 3.2 - standalone T5 test
set "EM_NAME=t5-test"
set "EM_MODE=T5"
set "EM_REPEAT=3"
if defined EIGHTMAX_T5_REPEAT set "EM_REPEAT=%EIGHTMAX_T5_REPEAT%"
set "EM_APP=%~dp0"
if "%EM_APP:~-1%"=="\" set "EM_APP=%EM_APP:~0,-1%"
set "EM_INTERACTIVE=1"
if defined GITHUB_ACTIONS set "EM_INTERACTIVE="
if defined EIGHTMAX_NONINTERACTIVE set "EM_INTERACTIVE="
set "EM_RC=5"
set "EM_PROBLEM="
set "EM_RUNDIR="
set "EM_ZIP="
set "EM_PS="
set "EM_LOG="
set "EM_ERR="
set "EM_TOKEN=%RANDOM%%RANDOM%%RANDOM%"
set "EM_STAMP=%date%-%time%"
set "EM_STAMP=%EM_STAMP:/=-%"
set "EM_STAMP=%EM_STAMP:\=-%"
set "EM_STAMP=%EM_STAMP::=-%"
set "EM_STAMP=%EM_STAMP:.=-%"
set "EM_STAMP=%EM_STAMP:,=-%"
set "EM_STAMP=%EM_STAMP: =0%"
set "EM_STAMP=%EM_STAMP%-%EM_TOKEN%"
echo(
echo  EightMax Test Workbench 0.36.2 - Milestone 3.2 standalone T5 test
echo  ===================================================================
echo  Two EightMax test tables play at the same time; then the window of table 2 is closed - once while it
echo  plays (T5) and once while it is paused by a click its table did not apply (T5P). %EM_REPEAT% repetition(s).
echo  About 8-15 minutes. THE MOUSE MOVES BY ITSELF inside the small test tables: do not touch the mouse or
echo  keyboard until this window says the test ended. Ctrl+Alt+F12 stops all mouse input at any time.
echo  A report and a ZIP are saved even if something fails.
echo(

echo %EM_REPEAT%| findstr /r /x "[1-9] 1[0-9] 20" >nul || set "EM_REPEAT=3"
call :pick_outroot "%~1"
if defined EM_PROBLEM goto :launcher_failure
call :check_app
if defined EM_PROBLEM goto :launcher_failure
call :find_powershell
if defined EM_PROBLEM goto :launcher_failure

echo  Application folder: "%EM_APP%"
echo  Results folder:     "%EM_OUTROOT%"
echo  Close the EightMax Workbench, its dashboard and any EightMax test table before you continue.
echo  Keep the PC awake and plugged in.
echo(
if defined EM_INTERACTIVE pause
echo(
>>"%EM_LOG%" echo [%time%] starting the test runner: mode %EM_MODE%, label %EM_NAME%
"%EM_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EM_APP%\windows\Test-Milestone31.ps1" -Mode %EM_MODE% -T5Repeat %EM_REPEAT% -Label %EM_NAME% -OutRoot "%EM_OUTROOT%" -LauncherToken %EM_TOKEN% -LauncherLog "%EM_LOG%" -LauncherStderr "%EM_ERR%" 2>>"%EM_ERR%"
set "EM_RC=%ERRORLEVEL%"
>>"%EM_LOG%" echo [%time%] test runner exit code %EM_RC%

call :find_rundir
if defined EM_RUNDIR goto :have_rundir
set "EM_PROBLEM=The test runner did not create its results folder (PowerShell exit code %EM_RC%). The PowerShell error output is included below."
goto :launcher_failure

:have_rundir
>>"%EM_LOG%" echo [%time%] results folder: "%EM_RUNDIR%"
copy /y "%EM_LOG%" "%EM_RUNDIR%\launcher.log" >nul 2>&1
set "EM_ZIP=%EM_RUNDIR%\milestone3-results.zip"
if exist "%EM_ZIP%" goto :show_result
>>"%EM_LOG%" echo [%time%] the test runner made no ZIP; packaging the folder with tar.exe
set "EM_ZIP=%EM_RUNDIR%-launcher.zip"
call :zip_folder "%EM_RUNDIR%" "%EM_ZIP%"
if not exist "%EM_ZIP%" set "EM_ZIP="

:show_result
echo(
echo  --------------------------------------------------------------------------
if exist "%EM_RUNDIR%\milestone3-results.txt" findstr /b /c:"RESULT:" "%EM_RUNDIR%\milestone3-results.txt"
if exist "%EM_RUNDIR%\T5-SUMMARY.txt" findstr /b /c:"Real-window result:" "%EM_RUNDIR%\T5-SUMMARY.txt"
if exist "%EM_RUNDIR%\T5-SUMMARY.txt" echo  Plain-language summary: "%EM_RUNDIR%\T5-SUMMARY.txt"
call :explain_rc
echo  Results folder:
echo    "%EM_RUNDIR%"
if not defined EM_ZIP goto :no_zip
echo  ZIP to send back:
echo    "%EM_ZIP%"
if defined EM_INTERACTIVE start "" explorer.exe /select,"%EM_ZIP%"
goto :finish
:no_zip
echo  No ZIP could be created. Please send the whole results folder shown above.
if defined EM_INTERACTIVE start "" explorer.exe "%EM_RUNDIR%"
goto :finish

rem ------------------------------------------------------------------------------------------------------------------------------
:launcher_failure
set "EM_RC=5"
if not defined EM_LAUNCH set "EM_LAUNCH=%TEMP%\EightMax-Test-Workbench"
if not exist "%EM_LAUNCH%" mkdir "%EM_LAUNCH%" >nul 2>&1
set "EM_FAIL=%EM_LAUNCH%\launcher-failure-%EM_NAME%-%EM_STAMP%.txt"
>"%EM_FAIL%" echo EightMax Test Workbench 0.36.2 - Milestone 3.2 - the launcher could not run the test (%EM_NAME%)
>>"%EM_FAIL%" echo Time: %date% %time%
>>"%EM_FAIL%" echo Problem: "%EM_PROBLEM%"
>>"%EM_FAIL%" echo Launcher: "%~f0"
>>"%EM_FAIL%" echo Application folder: "%EM_APP%"
>>"%EM_FAIL%" echo PowerShell: "%EM_PS%"
>>"%EM_FAIL%" echo Results folder: "%EM_OUTROOT%"
>>"%EM_FAIL%" ver
>>"%EM_FAIL%" echo PROCESSOR_ARCHITECTURE=%PROCESSOR_ARCHITECTURE% PROCESSOR_ARCHITEW6432=%PROCESSOR_ARCHITEW6432%
if defined EM_LOG if exist "%EM_LOG%" >>"%EM_FAIL%" echo --- launcher log ---
if defined EM_LOG if exist "%EM_LOG%" type "%EM_LOG%" >>"%EM_FAIL%" 2>nul
if defined EM_ERR if exist "%EM_ERR%" >>"%EM_FAIL%" echo --- PowerShell error output ---
if defined EM_ERR if exist "%EM_ERR%" type "%EM_ERR%" >>"%EM_FAIL%" 2>nul
set "EM_ZIP=%EM_FAIL%.zip"
call :zip_file "%EM_FAIL%" "%EM_ZIP%"
if not exist "%EM_ZIP%" set "EM_ZIP="
echo(
echo  --------------------------------------------------------------------------
echo  THE TEST COULD NOT BE STARTED.
echo  %EM_PROBLEM%
echo(
echo  A diagnostic file was saved:
echo    "%EM_FAIL%"
if defined EM_ZIP echo  ZIP to send back:
if defined EM_ZIP echo    "%EM_ZIP%"
if defined EM_INTERACTIVE start "" explorer.exe /select,"%EM_FAIL%"
goto :finish

:finish
echo(
if defined EM_INTERACTIVE pause
endlocal & exit /b %EM_RC%

rem ------------------------------------------------------------------------------------------------------------------------------
:explain_rc
if "%EM_RC%"=="0" echo  The standalone T5 test PASSED (exit code 0). Warnings, if any, are listed in the report.
if "%EM_RC%"=="1" echo  Some checks FAILED (exit code 1). T5-SUMMARY.txt and the report name each failed step.
if "%EM_RC%"=="2" echo  The test runner itself failed (exit code 2). The report and errors.log show where.
if "%EM_RC%"=="3" echo  This computer prevented the test (exit code 3), for example port 48713 in use. See the report.
if "%EM_RC%"=="4" echo  The test was interrupted (exit code 4). Everything done so far was saved.
goto :eof

:check_app
set "EM_MISSING="
for %%F in ("windows\Test-Milestone31.ps1" "windows\M31-Lib.ps1" "windows\M31-Integrity.ps1" "windows\M31-HostStart.ps1" "windows\M32-T5.ps1" "windows\Start-Desktop.ps1" "windows\Common.ps1" "desktop\bin\EightMaxWorkbench.exe" "desktop\bin\EightMaxInput.exe" "desktop\bin\EightMaxTestTable.exe" "runtime\node\node.exe" "tools\gameplay-acceptance-0362m3.cjs" "tools\lifecycle-acceptance-0362m2.cjs" "tools\test-table-035.cjs" "SHA256SUMS.txt" "release-integrity-policy.json") do if not exist "%EM_APP%\%%~F" call :add_missing "%%~F"
>>"%EM_LOG%" echo [%time%] application folder "%EM_APP%", missing: "%EM_MISSING%"
if not defined EM_MISSING goto :eof
set "EM_PROBLEM=This file must be run from the extracted EightMax-Test-Workbench folder (next to START-EIGHTMAX.cmd), but files are missing: %EM_MISSING%. Extract the complete ZIP into a new folder and run it from there."
echo "%EM_APP%" | find /i ".zip\" >nul && set "EM_PROBLEM=This file was started from inside the ZIP. Right-click the ZIP, choose Extract All, then run RUN-M3.2-T5-TEST.cmd from the extracted EightMax-Test-Workbench folder."
goto :eof
:add_missing
if defined EM_MISSING set "EM_MISSING=%EM_MISSING%, %~1"
if not defined EM_MISSING set "EM_MISSING=%~1"
goto :eof

:pick_outroot
set "EM_OUTROOT=%~1"
if not defined EM_OUTROOT if defined LOCALAPPDATA set "EM_OUTROOT=%LOCALAPPDATA%\EightMax-Test-Workbench\TestResults"
if not defined EM_OUTROOT set "EM_OUTROOT=%USERPROFILE%\AppData\Local\EightMax-Test-Workbench\TestResults"
if "%EM_OUTROOT:~-1%"=="\" set "EM_OUTROOT=%EM_OUTROOT:~0,-1%"
call :try_writable "%EM_OUTROOT%"
if not defined EM_NOWRITE goto :outroot_ok
echo  Cannot write to "%EM_OUTROOT%". Using the TEMP folder instead.
set "EM_OUTROOT=%TEMP%\EightMax-Test-Workbench\TestResults"
call :try_writable "%EM_OUTROOT%"
if not defined EM_NOWRITE goto :outroot_ok
set "EM_PROBLEM=No folder for the results could be created (tried the requested folder, LOCALAPPDATA and TEMP)."
goto :eof
:outroot_ok
set "EM_LAUNCH=%EM_OUTROOT%\_launcher"
if not exist "%EM_LAUNCH%" mkdir "%EM_LAUNCH%" >nul 2>&1
set "EM_LOG=%EM_LAUNCH%\%EM_NAME%-%EM_STAMP%.log"
set "EM_ERR=%EM_LAUNCH%\%EM_NAME%-%EM_STAMP%.powershell-stderr.txt"
>"%EM_LOG%" echo EightMax Milestone 3.2 launcher log (%EM_NAME%) - %date% %time%
>>"%EM_LOG%" echo [%time%] launcher "%~f0"
>>"%EM_LOG%" echo [%time%] results folder "%EM_OUTROOT%"
goto :eof

:try_writable
set "EM_NOWRITE="
if not exist "%~1" mkdir "%~1" >nul 2>&1
if not exist "%~1" set "EM_NOWRITE=1"
if defined EM_NOWRITE goto :eof
(echo ok)>"%~1\.write-test-%EM_TOKEN%.tmp" 2>nul
if not exist "%~1\.write-test-%EM_TOKEN%.tmp" set "EM_NOWRITE=1"
del /q "%~1\.write-test-%EM_TOKEN%.tmp" >nul 2>&1
goto :eof

:find_powershell
set "EM_PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "EM_PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%EM_PS%" set "EM_PS=powershell.exe"
"%EM_PS%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "exit 7" >nul 2>>"%EM_ERR%"
set "EM_PSRC=%ERRORLEVEL%"
>>"%EM_LOG%" echo [%time%] PowerShell check: "%EM_PS%" returned %EM_PSRC% (expected 7)
if "%EM_PSRC%"=="7" goto :eof
set "EM_PROBLEM=Windows PowerShell could not be started (it returned %EM_PSRC% instead of 7). The tests need Windows PowerShell 5.1, which is part of Windows."
goto :eof

:find_rundir
set "EM_RUNDIR="
call :find_rundir_in "%EM_OUTROOT%"
if defined EM_RUNDIR goto :eof
if defined LOCALAPPDATA call :find_rundir_in "%LOCALAPPDATA%\EightMax-Test-Workbench\TestResults"
if defined EM_RUNDIR goto :eof
call :find_rundir_in "%TEMP%\EightMax-Test-Workbench\TestResults"
if defined EM_RUNDIR goto :eof
call :find_rundir_in "%USERPROFILE%\EightMax-TestResults"
if defined EM_RUNDIR goto :eof
call :find_rundir_in "%EM_APP%\test-results"
goto :eof
:find_rundir_in
if not exist "%~1" goto :eof
for /f "delims=" %%D in ('dir /b /ad /o-d "%~1" 2^>nul') do (
  if exist "%~1\%%D\launcher-token.txt" findstr /b /c:"%EM_TOKEN%" "%~1\%%D\launcher-token.txt" >nul 2>&1 && set "EM_RUNDIR=%~1\%%D" && goto :eof
)
goto :eof

:zip_folder
set "EM_ZIPSRC=%~1"
set "EM_ZIPDST=%~2"
if exist "%SystemRoot%\System32\tar.exe" "%SystemRoot%\System32\tar.exe" -a -c -f "%~2" -C "%~1" . >nul 2>&1
if exist "%~2" goto :eof
"%EM_PS%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Compress-Archive -Path ($env:EM_ZIPSRC + '\*') -DestinationPath $env:EM_ZIPDST -Force" >nul 2>&1
goto :eof

:zip_file
if exist "%SystemRoot%\System32\tar.exe" "%SystemRoot%\System32\tar.exe" -a -c -f "%~2" -C "%~dp1." "%~nx1" >nul 2>&1
goto :eof
