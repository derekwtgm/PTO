@echo off
rem ==============================================================================================================================
rem EightMax Test Workbench 0.36.2 - MILESTONE 4.0 PERFORMANCE TESTS (multi-table scheduler, mouse input, recognition at display scaling)
rem   A  Recognition verification  the recognition dataset (every table size at 100-200 percent display scaling, clean and degraded) and
rem                                real EightMax test-table windows on THIS display, each checked by Verify Table Recognition.
rem                                About 5-15 minutes. Windows open and close; the mouse does not move.
rem   B  Scheduler benchmark       the Milestone 3.2 multi-table workload (1, 2, 5, 8 tables) with the Milestone 3.2 input pipeline,
rem                                then with the Milestone 4.0 pipeline, on THIS PC at the same mouse speed. About 15-25 minutes;
rem                                the mouse moves by itself inside the test tables.
rem   C  Extended simulator test   uninterrupted play for 30 minutes at 5 tables and 30 minutes at 8 tables, then fault injection
rem                                (windows closed and reopened, emergency stops). About 70-80 minutes; the mouse moves by itself.
rem   D  Full acceptance           the Milestone 3.1 full acceptance (all regression tests, window lifecycle, tournament gameplay
rem                                T1-T6 and T5P, multi-table) plus A, B and 10 minutes of uninterrupted play at 5 and 8 tables.
rem                                About 2-2.5 hours; the mouse moves by itself.
rem   E  Package an interrupted run (runs no test).        L  choose another results folder.        Q  quit
rem Every run saves its progress continuously and ends with a report, M4-SUMMARY.txt and milestone3-results.zip (the Milestone 4.0
rem tests extend the Milestone 3.1 test runner and keep its file names) - also after a failure, a time-out, Ctrl+C or a crash.
rem Results: %LOCALAPPDATA%\EightMax-Test-Workbench\TestResults\Milestone4.0-<date>-<time>-<mode>\ (never inside this folder).
rem Without the menu (advanced, CI):  RUN-M4-PERFORMANCE-TEST.cmd A|B|C|D|E ["results folder"]
rem   extra runner options:           set EIGHTMAX_M4_ARGS=-SustainedMinutes 60 -ABFast -ABSeconds 120
rem Exit codes: 0 PASS  1 FAIL  2 test-runner error  3 environment problem  4 interrupted  5 the launcher could not start the test
rem             6 nothing to package
rem ==============================================================================================================================
setlocal EnableExtensions DisableDelayedExpansion
title EightMax Milestone 4.0 performance tests
set "EM_NAME=tests"
set "EM_MODE="
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
echo  EightMax Test Workbench 0.36.2 - Milestone 4.0 performance tests
echo  ===================================================================
echo  Nothing needs to be installed. Every run saves its progress continuously and ends with a report and a ZIP,
echo  also when a test fails or stops responding.
echo(

call :pick_outroot "%~2"
if defined EM_PROBLEM goto :launcher_failure
call :check_app
if defined EM_PROBLEM goto :launcher_failure
call :find_powershell
if defined EM_PROBLEM goto :launcher_failure

set "EM_KEY=%~1"
if defined EM_KEY goto :have_key
if not defined EM_INTERACTIVE set "EM_KEY=A"
if not defined EM_INTERACTIVE goto :have_key

:menu
"%EM_PS%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%EM_APP%\windows\Test-Milestone31.ps1" -Mode Detect -OutRoot "%EM_OUTROOT%" 2>>"%EM_ERR%"
set "EM_DRC=%ERRORLEVEL%"
>>"%EM_LOG%" echo [%time%] earlier-run check exit code %EM_DRC%
if "%EM_DRC%"=="0" goto :show_menu
set "EM_PROBLEM=The test runner could not start in Windows PowerShell (exit code %EM_DRC%). The PowerShell error output is included below."
goto :launcher_failure
:show_menu
echo(
echo  Choose what to run:
echo(
echo    A  Recognition verification - every table size at 100-200 %% display scaling, and real
echo       test-table windows on this display. About 5-15 minutes. The mouse does not move.
echo    B  Scheduler benchmark - 1, 2, 5 and 8 tables, Milestone 3.2 input pipeline and then the
echo       Milestone 4.0 pipeline, same mouse speed. About 15-25 minutes. The mouse moves by itself.
echo    C  Extended simulator test - 30 minutes of play at 5 tables and at 8 tables, then fault
echo       injection. About 70-80 minutes. The mouse moves by itself.
echo    D  Full acceptance - every regression and real-window test, A, B and 10 minutes of play
echo       at 5 and 8 tables. About 2-2.5 hours. The mouse moves by itself.
echo    E  Package an earlier test run that did not finish (runs no test)
echo    L  Choose another folder for the results
echo    Q  Quit
echo(
echo  Results are saved under:
echo    "%EM_OUTROOT%"
echo(
set "EM_KEY="
choice /c ABCDELQ /n /m "Press A, B, C, D, E, L or Q: "
set "EM_K=%ERRORLEVEL%"
if "%EM_K%"=="1" set "EM_KEY=A"
if "%EM_K%"=="2" set "EM_KEY=B"
if "%EM_K%"=="3" set "EM_KEY=C"
if "%EM_K%"=="4" set "EM_KEY=D"
if "%EM_K%"=="5" set "EM_KEY=E"
if "%EM_K%"=="6" set "EM_KEY=L"
if "%EM_K%"=="7" set "EM_KEY=Q"
if defined EM_KEY goto :have_key
set /p "EM_KEY=Type A, B, C, D, E, L or Q and press Enter: "

:have_key
set "EM_MODE="
if /i "%EM_KEY%"=="A" (set "EM_MODE=M4Recognition" & set "EM_NAME=recognition")
if /i "%EM_KEY%"=="recognition" (set "EM_MODE=M4Recognition" & set "EM_NAME=recognition")
if /i "%EM_KEY%"=="B" (set "EM_MODE=M4Scheduler" & set "EM_NAME=scheduler")
if /i "%EM_KEY%"=="scheduler" (set "EM_MODE=M4Scheduler" & set "EM_NAME=scheduler")
if /i "%EM_KEY%"=="C" (set "EM_MODE=M4Extended" & set "EM_NAME=extended")
if /i "%EM_KEY%"=="extended" (set "EM_MODE=M4Extended" & set "EM_NAME=extended")
if /i "%EM_KEY%"=="D" (set "EM_MODE=M4Full" & set "EM_NAME=full")
if /i "%EM_KEY%"=="full" (set "EM_MODE=M4Full" & set "EM_NAME=full")
if /i "%EM_KEY%"=="E" (set "EM_MODE=Package" & set "EM_NAME=package")
if /i "%EM_KEY%"=="package" (set "EM_MODE=Package" & set "EM_NAME=package")
if /i "%EM_KEY%"=="L" goto :change_root
if /i "%EM_KEY%"=="Q" goto :quit
if defined EM_MODE goto :run_mode
echo  Unknown choice "%EM_KEY%".
if defined EM_INTERACTIVE goto :show_menu
set "EM_PROBLEM=Unknown mode %EM_KEY% (use A, B, C, D or E)."
goto :launcher_failure

:change_root
echo(
set "EM_NEWROOT="
set /p "EM_NEWROOT=Folder for the results (press Enter to keep the current one): "
if not defined EM_NEWROOT goto :show_menu
set "EM_NEWROOT=%EM_NEWROOT:"=%"
call :pick_outroot "%EM_NEWROOT%"
if defined EM_PROBLEM goto :launcher_failure
goto :show_menu

:quit
set "EM_RC=0"
endlocal & exit /b 0

:run_mode
>>"%EM_LOG%" echo [%time%] mode %EM_MODE%
if "%EM_MODE%"=="Package" goto :run_package
if "%EM_MODE%"=="M4Recognition" goto :run_tests
echo(
echo  "EightMax Test Table" windows open and THE MOUSE MOVES BY ITSELF inside them until this window says
echo  the tests ended (B about 15-25 minutes, C about 70-80 minutes, D about 2-2.5 hours). Do not touch the mouse or keyboard.
echo  Ctrl+Alt+F12 stops all input at any time. Keep the computer awake and plugged in.
echo  Close the EightMax Workbench and its dashboard first.
echo(
if defined EM_INTERACTIVE pause

:run_tests
echo(
>>"%EM_LOG%" echo [%time%] starting the test runner: mode %EM_MODE%, label %EM_NAME%
"%EM_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EM_APP%\windows\Test-Milestone31.ps1" -Mode %EM_MODE% -Label %EM_NAME% -OutRoot "%EM_OUTROOT%" -LauncherToken %EM_TOKEN% -LauncherLog "%EM_LOG%" -LauncherStderr "%EM_ERR%" %EIGHTMAX_M4_ARGS% 2>>"%EM_ERR%"
set "EM_RC=%ERRORLEVEL%"
>>"%EM_LOG%" echo [%time%] test runner exit code %EM_RC%
call :find_rundir
if defined EM_RUNDIR goto :have_rundir
set "EM_PROBLEM=The test runner did not create its results folder (PowerShell exit code %EM_RC%). The PowerShell error output is included below."
goto :launcher_failure

:run_package
echo(
"%EM_PS%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%EM_APP%\windows\Test-Milestone31.ps1" -Mode Package -OutRoot "%EM_OUTROOT%" -LauncherToken %EM_TOKEN% 2>>"%EM_ERR%"
set "EM_RC=%ERRORLEVEL%"
>>"%EM_LOG%" echo [%time%] package exit code %EM_RC%
if "%EM_RC%"=="6" goto :nothing_to_package
call :find_rundir
if not defined EM_RUNDIR call :find_rundir_in "%LOCALAPPDATA%\EightMax-Test-Workbench\Milestone3-0.36.2"
if defined EM_RUNDIR goto :package_zip
set "EM_PROBLEM=Packaging did not complete (PowerShell exit code %EM_RC%). The PowerShell error output is included below."
goto :launcher_failure
:package_zip
set "EM_ZIP="
for /f "delims=" %%Z in ('dir /b /a-d /o-d "%EM_RUNDIR%\milestone3-results*.zip" 2^>nul') do if not defined EM_ZIP set "EM_ZIP=%EM_RUNDIR%\%%Z"
goto :show_result
:nothing_to_package
echo  No earlier test run was found. Nothing to package.
goto :finish

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
if exist "%EM_RUNDIR%\M4-SUMMARY.txt" echo  Plain-language summary: "%EM_RUNDIR%\M4-SUMMARY.txt"
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
>"%EM_FAIL%" echo EightMax Test Workbench 0.36.2 - Milestone 4.0 - the launcher could not run the test (%EM_NAME%)
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
if "%EM_RC%"=="0" echo  The tests PASSED (exit code 0). Warnings, if any, are listed in the report (a missed performance target is a warning).
if "%EM_RC%"=="1" echo  Some checks FAILED (exit code 1). The report names each failed step and what to do.
if "%EM_RC%"=="2" echo  The test runner itself failed (exit code 2). The report and errors.log show where.
if "%EM_RC%"=="3" echo  This computer prevented the test (exit code 3), for example port 48713 in use. See the report.
if "%EM_RC%"=="4" echo  The test was interrupted (exit code 4). Everything done so far was saved.
if "%EM_RC%"=="6" echo  Nothing was found to package (exit code 6).
goto :eof

:check_app
set "EM_MISSING="
for %%F in ("windows\Test-Milestone31.ps1" "windows\M31-Lib.ps1" "windows\M31-Integrity.ps1" "windows\M31-HostStart.ps1" "windows\M40-Summary.ps1" "tools\recognition-validation-040.cjs" "tools\gameplay-acceptance-0362m3.cjs" "desktop\bin\EightMaxTestTable.exe" "runtime\node\node.exe" "windows\Start-Desktop.ps1" "windows\Common.ps1" "desktop\bin\EightMaxWorkbench.exe" "desktop\bin\EightMaxInput.exe" "SHA256SUMS.txt" "release-integrity-policy.json") do if not exist "%EM_APP%\%%~F" call :add_missing "%%~F"
>>"%EM_LOG%" echo [%time%] application folder "%EM_APP%", missing: "%EM_MISSING%"
if not defined EM_MISSING goto :eof
set "EM_PROBLEM=This file must be run from the extracted EightMax-Test-Workbench folder (next to START-EIGHTMAX.cmd), but files are missing: %EM_MISSING%. Extract the complete ZIP into a new folder and run it from there."
echo "%EM_APP%" | find /i ".zip\" >nul && set "EM_PROBLEM=This file was started from inside the ZIP. Right-click the ZIP, choose Extract All, then run RUN-M4-PERFORMANCE-TEST.cmd from the extracted EightMax-Test-Workbench folder."
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
>"%EM_LOG%" echo EightMax Milestone 4.0 launcher log (%EM_NAME%) - %date% %time%
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
