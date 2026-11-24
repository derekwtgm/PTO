<# EightMax Test Workbench 0.36.2 - MILESTONE 3.1 Windows test runner (Windows PowerShell 5.1, nothing to install).
   Started by RUN-0362-MILESTONE3.1-TESTS.cmd (modes A-D), RUN-M3-HOST-DIAGNOSTIC-3.1.cmd (startup diagnostics) and, for compatibility,
   RUN-0362-MILESTONE3-TESTS.cmd / windows\Test-Milestone3-0362.ps1 (full acceptance).

   -Mode Quick     A  package integrity, executable identities, required components, desktop host start + input driver + shutdown (2-5 min)
   -Mode Startup   B  the same plus every Milestone 3 start case: fallback compile, cache reuse, invalid caches, old cache key, build-only
   -Mode Full      C  B plus the regression tests and the real-window acceptance: lifecycle, gameplay, multi-table (45-75 min; the mouse moves)
   -Mode T5           0.36.2 Milestone 3.2 standalone T5 test (RUN-M3.2-T5-TEST.cmd): environment, integrity, components, the Milestone 3.2
                      regression tests, desktop host + input driver, then T5 (two real test tables, table 2's window closes) and T5P (table 2
                      paused by an action its table did not apply, then closed - the operator's failure), -T5Repeat times; cleanup (8-15 min)
   -Mode M4Recognition  0.36.2 Milestone 4.0 RUN-M4-PERFORMANCE-TEST.cmd A: recognition verification - the deterministic recognition dataset
                      (every table size at 100-200 % display scaling) and real test-table windows on this display, each checked by Verify
                      Table Recognition and compared with the table's own state; no mouse input (5-15 min)
   -Mode M4Scheduler    Milestone 4.0 B: scheduler benchmark - the Milestone 3.2 multi-table workload (1/2/5/8 tables) with the Milestone 3.2
                      input pipeline and then with the Milestone 4.0 pipeline on THIS PC, same mouse speed; -ABFast adds the Fast preset,
                      reported apart (about 15-25 min; the mouse moves)
   -Mode M4Extended     Milestone 4.0 C: extended simulator test - uninterrupted play for -SustainedMinutes (default 30) at 5 and at 8 tables,
                      then a fault-injection run (windows closed and reopened, emergency stops) (about 70-80 min; the mouse moves)
   -Mode M4Full         Milestone 4.0 D: full acceptance - the Milestone 3.1 full acceptance (regression tests, lifecycle, gameplay T1-T6 + T5P,
                      multi-table) plus A, B and C (sustained play -SustainedMinutes, default 10 in this mode) (about 2-2.5 h)
   -Mode Package   D  finds an earlier (incomplete) run and packages its logs; runs NO test (RUN-M4-PERFORMANCE-TEST.cmd E)
   -Mode Detect       lists earlier runs that did not finish (used by the launcher before its menu)

   Results: %LOCALAPPDATA%\EightMax-Test-Workbench\TestResults\Milestone3.1-<date>-<time>-<mode>\ (never inside the application folder;
   -OutRoot chooses another place, -OutDir names the exact folder). The folder holds run-status.json, console.log, errors.log, checks.jsonl
   and operations.jsonl from the first second, phases\*.json as each phase ends, and at the end milestone3-results.json / .txt / .zip.
   Exit codes: 0 PASS, 1 FAIL, 2 harness error, 3 environment problem, 4 interrupted, 6 nothing to package (mode D).

   Test-only options (CI): -InjectFault exception:<phase> | check-fail:<phase> | terminate:<phase> | node-missing, -StartScript <fixture>,
   -HostCases <ids>, -HostLaunchTimeoutSec / -HostReadyTimeoutSec. A run with an injected fault says so in every report. #>
param(
    [ValidateSet('Quick', 'Startup', 'Full', 'T5', 'M4Recognition', 'M4Scheduler', 'M4Extended', 'M4Full', 'Package', 'Detect')][string]$Mode = 'Quick', [int]$T5Repeat = 3,
    [int]$SustainedMinutes = 30, [string]$SustainedTables = '5,8', [int]$ABSeconds = 60, [string]$ABTables = '1,2,5,8', [switch]$ABFast, [int]$FaultSeconds = 300, [int]$FaultTables = 8, [int]$RecognitionFrames = 10,
    [string]$OutRoot, [string]$OutDir, [string]$Label, [string]$RunPathFile, [string]$LauncherLog, [string]$LauncherStderr,
    [string]$PackageRun, [switch]$NonInteractive,
    [switch]$FullSuite, [switch]$SkipAcceptance, [switch]$SkipStability, [int]$StabilitySeconds = 60, [string]$StabilityTables = '1,2,5,8', [int]$CampaignHands = 0, [int]$CampaignMinutes = 30,
    [string]$Phases = 'all', [double]$TimeoutScale = 1.0, [int]$HostLaunchTimeoutSec = 0, [int]$HostCompileTimeoutSec = 0, [int]$HostReadyTimeoutSec = 0,
    [string]$StartScript, [string]$InjectFault, [string]$HostCases, [string]$LauncherToken
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
. (Join-Path $PSScriptRoot 'M31-Lib.ps1')
# 0.36.2 Milestone 3.2: the standalone T5 test has its own results folders (Milestone3.2-T5-<date>-<time>-<label>) and report title
if ($Mode -eq 'T5') { $script:M31RunPrefix = 'Milestone3.2-T5'; $script:M31Version = '0.36.2-milestone-3.2'; $script:M31ReportTitle = 'EightMax Test Workbench 0.36.2 - Milestone 3.2 standalone T5 test results' }
# 0.36.2 Milestone 4.0 (RUN-M4-PERFORMANCE-TEST.cmd): its own results folders (Milestone4.0-<date>-<time>-<label>) and report title
$script:M40Mode = $Mode -like 'M4*'
if ($script:M40Mode) { $script:M31RunPrefix = 'Milestone4.0'; $script:M31Version = '0.36.2-milestone-4.0'; $script:M31ReportTitle = 'EightMax Test Workbench 0.36.2 - Milestone 4.0 performance test results' }
if ($Mode -eq 'M4Full' -and -not $PSBoundParameters.ContainsKey('SustainedMinutes')) { $SustainedMinutes = 10 }
if ($Mode -eq 'M4Full') { $FullSuite = $true }   # D: the complete regression suite
$SustainedMinutes = [math]::Max(1, [math]::Min(240, $SustainedMinutes)); $ABSeconds = [math]::Max(20, [math]::Min(1800, $ABSeconds)); $FaultSeconds = [math]::Max(60, [math]::Min(3600, $FaultSeconds)); $FaultTables = [math]::Max(1, [math]::Min(10, $FaultTables)); $RecognitionFrames = [math]::Max(2, [math]::Min(40, $RecognitionFrames))
$T5Repeat = [math]::Max(1, [math]::Min(20, $T5Repeat))
. (Join-Path $PSScriptRoot 'M31-Integrity.ps1')
. (Join-Path $PSScriptRoot 'M31-HostStart.ps1')
. (Join-Path $PSScriptRoot 'M32-T5.ps1')   # 0.36.2 M3.2: plain-language T5 summary
. (Join-Path $PSScriptRoot 'M40-Summary.ps1')   # 0.36.2 M4.0: plain-language performance summary (M4-SUMMARY.txt)
$root = Get-WorkbenchRoot
$ExpectedBuild = '7d08acc7eb4577ee'; $ExpectedMwcliSha = 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72'
$node = Join-Path $root 'runtime\node\node.exe'
if (-not $script:M31IsWindows) { $node = (Get-Command node -ErrorAction SilentlyContinue).Source }   # Linux self-checks of this runner
$scale = [math]::Max(0.2, [math]::Min(10.0, $TimeoutScale))
function Get-M31Limit([int]$Explicit, [int]$Default) { if ($Explicit -gt 0) { return $Explicit }; return [int][math]::Ceiling($Default * $scale) }
$interactive = (-not $NonInteractive) -and (-not $env:GITHUB_ACTIONS) -and (-not $env:EIGHTMAX_NONINTERACTIVE) -and [Environment]::UserInteractive
function Get-M31DefaultOutRoot { if ($OutRoot) { return $OutRoot }; $l = $env:LOCALAPPDATA; if (-not $l) { $l = [Environment]::GetFolderPath('LocalApplicationData') }; return (Join-Path $l 'EightMax-Test-Workbench\TestResults') }
function Write-Plain([string]$Text, [string]$Color = '') { try { if ($Color) { Write-Host $Text -ForegroundColor $Color } else { Write-Host $Text } } catch { [Console]::WriteLine($Text) } }

# ------------------------------------------------------------------------------------------------------------------------------------------
# D and Detect: earlier runs (no test is run)
# ------------------------------------------------------------------------------------------------------------------------------------------
if ($Mode -eq 'Detect') {
    $runs = @(Find-M31Runs (Get-M31DefaultOutRoot) $root)
    $open = @($runs | Where-Object { -not $_.complete -and -not $_.runnerAlive })
    foreach ($r in ($open | Select-Object -First 5)) { Write-Plain ('  NOTE: an earlier test run did not finish: ' + $r.name + ' (' + $r.state + '). Choose D to package its logs.') 'Yellow' }
    $live = @($runs | Where-Object { $_.runnerAlive })
    foreach ($r in $live) { Write-Plain ('  NOTE: a test run is still in progress in another window: ' + $r.name) 'Yellow' }
    exit 0
}
if ($Mode -eq 'Package') {
    $outRootUsed = Get-M31DefaultOutRoot
    Write-Plain 'EightMax 0.36.2 Milestone 3.1 - package an earlier test run (no test is run)' 'Cyan'
    Write-Plain ('Looking in: ' + $outRootUsed + ', ' + (Join-Path $root 'test-results') + ' and the Milestone 3 fallback folder')
    $runs = @(Find-M31Runs $outRootUsed $root)
    if (-not $runs.Count) { Write-Plain 'No earlier test run was found. Nothing to package.' 'Yellow'; exit 6 }
    $pick = $null
    if ($PackageRun) { $pick = @($runs | Where-Object { $_.path -eq [IO.Path]::GetFullPath($PackageRun) -or $_.name -eq $PackageRun })[0]; if (-not $pick) { Write-Plain ('Not found among the runs: ' + $PackageRun) 'Red'; exit 6 } }
    else {
        $show = @($runs | Select-Object -First 15)
        for ($i = 0; $i -lt $show.Count; $i++) { $r = $show[$i]; Write-Plain (('  {0,2}  {1,-44} {2,-36} {3}' -f ($i + 1), $r.name, $r.state, [IO.Path]::GetDirectoryName($r.path))) }
        $default = 0; for ($i = 0; $i -lt $show.Count; $i++) { if (-not $show[$i].complete) { $default = $i; break } }
        $choice = $default
        if ($interactive) {
            $a = Read-Host ('Number of the run to package [' + ($default + 1) + ']')
            if ($a -match '^\s*(\d+)\s*$' -and [int]$Matches[1] -ge 1 -and [int]$Matches[1] -le $show.Count) { $choice = [int]$Matches[1] - 1 }
        }
        $pick = $show[$choice]
    }
    # 0.36.2 M4.0: a run that FINISHED is never rewritten as a recovered one (Windows CI run 45409782425: option E after a completed run
    # replaced its report with "rebuilt from the saved progress of a run that did not finish"): its ZIP is shown, or made again from its
    # files, and its report stays exactly as it was written
    if ($pick.complete) {
        if ($LauncherToken) { try { [IO.File]::WriteAllText((Join-Path $pick.path 'launcher-token.txt'), $LauncherToken + "`r`n") } catch {} }
        $zp = Join-Path $pick.path 'milestone3-results.zip'
        if (Test-Path -LiteralPath $zp) { Write-Plain ('This run finished normally; its report is unchanged and its results ZIP already exists: ' + $zp) 'Green'; exit 0 }
        $z = New-M31Zip $pick.path $zp
        if ($z.ok) { Write-Plain ('This run finished normally; its report is unchanged. Results ZIP made again from its files: ' + $zp) 'Green'; exit 0 }
        Write-Plain ('The ZIP could not be created: ' + [string]$z.error) 'Red'; exit 2
    }
    Write-Plain ('Packaging ' + $pick.path + ' ...')
    $res = Complete-M31RecoveredRun $pick.path 'Packaged on request (mode D); no test was run.'
    if ($LauncherToken) { try { [IO.File]::WriteAllText((Join-Path $pick.path 'launcher-token.txt'), $LauncherToken + "`r`n") } catch {} }
    if ($res.zipOk) { Write-Plain ('Run status: ' + [string]$res.overall) ; Write-Plain ('Results ZIP: ' + $res.zip) 'Green'; if (@($res.skipped).Count) { Write-Plain ('  (' + @($res.skipped).Count + ' file(s) could not be read; listed in zip-skipped-files.txt)') 'Yellow' }; exit 0 }
    Write-Plain ('The ZIP could not be created: ' + [string]$res.zipError) 'Red'; exit 2
}

# ------------------------------------------------------------------------------------------------------------------------------------------
# A, B, C: a new run
# ------------------------------------------------------------------------------------------------------------------------------------------
$labelUsed = $Label; if (-not $labelUsed) { $labelUsed = $Mode.ToLowerInvariant() }
$plan = switch ($Mode) {
    'Quick' { @('environment', 'integrity', 'dependencies', 'host-start', 'cleanup') }
    'Startup' { @('environment', 'integrity', 'dependencies', 'host-start', 'cleanup') }
    'Full' { @('environment', 'integrity', 'dependencies', 'unit', 'host-start', 'lifecycle', 'gameplay', 'multi-table') + $(if ($CampaignHands -gt 0) { @('campaign') } else { @() }) + @('cleanup') }
    'T5' { @('environment', 'integrity', 'dependencies', 'unit', 'host-start', 't5', 'cleanup') }
    'M4Recognition' { @('environment', 'integrity', 'dependencies', 'host-start', 'recognition', 'recognition-windows', 'cleanup') }
    'M4Scheduler' { @('environment', 'integrity', 'dependencies', 'host-start', 'scheduler', 'cleanup') }
    'M4Extended' { @('environment', 'integrity', 'dependencies', 'host-start', 'sustained', 'faults', 'cleanup') }
    'M4Full' { @('environment', 'integrity', 'dependencies', 'unit', 'host-start', 'recognition', 'lifecycle', 'gameplay', 'multi-table', 'scheduler', 'sustained', 'cleanup') }
}
# -Phases selects the test phases; the environment, integrity, dependency and cleanup checks always run (every run is self-contained:
# a phase never relies on another invocation's results, which is what left the Milestone 3 report missing when one phase stopped)
$selected = $plan; if ($Phases -and $Phases -ne 'all') { $selected = @($Phases -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }); foreach ($x in $selected) { if ($plan -notcontains $x) { [Console]::Error.WriteLine('Unknown phase for mode ' + $Mode + ': ' + $x + ' (phases: ' + ($plan -join ', ') + ')'); exit 2 } }; $selected = @($plan | Where-Object { $selected -contains $_ -or @('environment', 'integrity', 'dependencies', 'cleanup') -contains $_ }) }
try { $null = New-M31Run $Mode $labelUsed $root $OutRoot $OutDir $plan $RunPathFile $InjectFault }
catch { [Console]::Error.WriteLine('EightMax M3.1 tests: the results folder could not be created: ' + $_.Exception.Message); exit 2 }
$M = $script:M31
# the launcher finds its run folder by this token (a folder path with non-ASCII characters cannot be passed back through a file to CMD)
if ($LauncherToken) { try { [IO.File]::WriteAllText((Join-Path $M.Dir 'launcher-token.txt'), $LauncherToken + "`r`n") } catch {} }   # CRLF: findstr does not match an unterminated last line
# complete console transcript (everything shown in the window, including output that does not pass through the run log)
$transcript = $false; try { $null = Start-Transcript -LiteralPath (Join-Path $M.Dir 'transcript.txt') -Force -ErrorAction Stop; $transcript = $true } catch {}
$completed = $false; $final = $null
try {
    $modeTitle = switch ($Mode) { 'M4Recognition' { 'A - Recognition verification (test-table windows open; no mouse input)' } 'M4Scheduler' { 'B - Scheduler benchmark (real windows; the mouse moves by itself)' } 'M4Extended' { 'C - Extended simulator test, ' + $SustainedMinutes + ' min per table count, then fault injection (the mouse moves by itself)' } 'M4Full' { 'D - Full acceptance (Milestone 3.1 full acceptance + A + B + sustained play; the mouse moves by itself)' } 'Quick' { 'A - Quick verification' } 'Startup' { 'B - Startup diagnostics (desktop host start and fallback compile)' } 'Full' { 'C - Full acceptance (real windows; the mouse moves by itself)' } 'T5' { 'standalone T5 test, ' + $T5Repeat + ' repetition(s) of T5 and T5P (real windows; the mouse moves by itself)' } }
    Write-M31Log ('EightMax Test Workbench 0.36.2 - ' + $(if ($Mode -eq 'T5') { 'Milestone 3.2' } elseif ($script:M40Mode) { 'Milestone 4.0 performance' } else { 'Milestone 3.1' }) + ' tests, mode ' + $modeTitle) 'Cyan'
    Write-M31Log ('Results folder: ' + $M.Dir)
    Write-M31Log ('Application:    ' + $root)
    if ($Mode -eq 'Full' -or $Mode -eq 'T5' -or ($script:M40Mode -and $Mode -ne 'M4Recognition')) { Write-M31Log 'The mouse will move by itself inside the EightMax test tables. Do not touch the mouse or keyboard until this finishes. Ctrl+Alt+F12 stops all input.' 'Yellow' }
    else { Write-M31Log 'This mode does not move the mouse. Progress is shown below; every step has a time limit.' }
    if ($InjectFault) { Write-M31Log ('TEST MODE: fault injected on purpose: ' + $InjectFault + ' (this run is not a real result)') 'Magenta' }
    foreach ($n in $M.OutRootNotes) { Write-M31Log ('  results location: ' + $n) 'Yellow' }
    foreach ($x in $plan) { if ($selected -notcontains $x) { $M.Phases[$x].reason = 'not selected (-Phases)' } }
    if ($LauncherLog) { [void]$M.Notes.Add('launcher log: ' + $LauncherLog) }
    $jobOk = Enable-M31SessionJob
    if ($jobOk) { Write-M31Log 'Session job active: every process this run starts ends with the run, however it ends.' 'DarkGray' } else { Write-M31Log ('Session job not available (' + $script:M31JobError + '); cleanup uses process tracking.') 'Yellow' }
    # earlier runs that did not finish (runner gone): marked INTERRUPTED and packaged, nothing invented
    $recoveredRuns = New-Object Collections.ArrayList
    foreach ($r in @(Find-M31Runs $M.OutRoot $root | Where-Object { $_.kind -eq 'm31' -and -not $_.complete -and -not $_.runnerAlive -and $_.path -ne $M.Dir })) {
        try { $rr = Complete-M31RecoveredRun $r.path ('Detected when the run ' + $M.RunId + ' started.'); [void]$recoveredRuns.Add($rr); Write-M31Log ('Earlier run did not finish: ' + $r.name + '. Its logs were packaged: ' + $rr.zip) 'Yellow' } catch { Write-M31Log ('Earlier run ' + $r.name + ' could not be packaged: ' + $_.Exception.Message) 'Yellow' }
    }
    function Invoke-Selected([string]$Name, [string]$Title, [string[]]$Needs, [scriptblock]$Body) {
        if ($selected -notcontains $Name) { if ($M.Phases.Contains($Name)) { Skip-M31Phase $Name 'not selected (-Phases)' 'NOT RUN' }; return }
        Invoke-M31Phase $Name $Title $Needs $Body
    }

    # ---- environment ---------------------------------------------------------------------------------------------------------------
    Invoke-Selected 'environment' 'Computer and environment' @() {
        $env1 = Get-M31EnvironmentSnapshot $root
        Write-M31AtomicText (Join-Path $M.Dir 'environment.json') (ConvertTo-M31Json $env1)
        $mc = $env1.machine
        [void](Add-M31Check 'environment' 'machine details collected' 'PASS' ([string]$mc.windows + '; ' + [string]$mc.cpu + '; ' + [string]$mc.ramGiB + ' GiB; display scaling ' + [string]$mc.displayScalingPercent + '%; PowerShell ' + $env1.powershell.version + ' ' + $env1.powershell.edition) $null @('environment.json'))
        $p = $env1.paths.appRoot; $pd = 'application folder ' + $root + ' (' + [string]$p.length + ' characters' + $(if ($p.hasSpaces) { ', spaces' } else { '' }) + $(if ($p.hasNonAscii) { ', non-ASCII characters' } else { '' }) + $(if ($p.hasParentheses) { ', parentheses' } else { '' }) + ')'
        if ($p.isUnc -or $p.longerThan200 -or $p.hasPercentOrBang) { [void](Add-M31Check 'environment' 'application folder path' 'WARNING' ($pd + ': a network path, a very long path or % / ! in the path can break Windows command scripts; a short local folder such as C:\EightMax is safest')) }
        else { [void](Add-M31Check 'environment' 'application folder path' 'PASS' $pd) }
        [void](Add-M31Check 'environment' 'results folder' $(if (@($M.OutRootNotes).Count) { 'WARNING' } else { 'PASS' }) ($M.Dir + ' (' + $M.OutRootWhy + ')' + $(if (@($M.OutRootNotes).Count) { '; ' + (@($M.OutRootNotes) -join '; ') } else { '' })))
        [void](Add-M31Check 'environment' 'session process control' $(if ($script:M31JobOk) { 'PASS' } else { 'WARNING' }) $(if ($script:M31JobOk) { 'job object: every process of this run ends with the run' } else { 'job object unavailable (' + $script:M31JobError + '); processes are tracked by id instead' }))
        if ($recoveredRuns.Count) { [void](Add-M31Check 'environment' 'earlier runs that did not finish' 'WARNING' ((@($recoveredRuns | ForEach-Object { [IO.Path]::GetFileName($_.path) + ' -> ' + $_.zip })) -join '; ')) }
        if ($script:M31IsWindows) {
            $mw = $env1.security.markOfTheWeb
            if ($mw.marked) { [void](Add-M31Check 'environment' 'files marked as downloaded from the internet (Mark of the Web)' 'WARNING' ([string]$mw.marked + ' of ' + [string]$mw.scanned + ' program files carry the internet zone mark (e.g. ' + (@($mw.examples) -join ', ') + '). Windows may ask for confirmation (SmartScreen / security warning) when the Workbench is started by double-click; the tests start programs directly and are not blocked by it. See READ-ME-MILESTONE-3.1.txt.')) }
            else { [void](Add-M31Check 'environment' 'files marked as downloaded from the internet (Mark of the Web)' 'PASS' ('none of ' + [string]$mw.scanned + ' program files is marked')) }
            $sec = $env1.security; $def = $sec.defender
            $nz = { param($v, [string]$d) $s = [string]$v; if ($s.Trim()) { $s } else { $d } }   # an empty value is named, not printed as nothing
            $sd = 'SmartScreen ' + (& $nz $sec.smartScreen.explorerSetting 'not set (Windows default)') + $(if ($null -ne $sec.smartScreen.policy) { ' (policy ' + [string]$sec.smartScreen.policy + ')' } else { '' }) + '; Smart App Control ' + (& $nz $sec.smartAppControl 'unknown') + '; antivirus ' + (& $nz $mc.antivirus 'none reported by Windows Security Center') + '; Defender real-time protection ' + (& $nz $def.realTimeProtection 'unknown') + ', controlled folder access ' + (& $nz $def.controlledFolderAccess 'unknown')
            if ([string]$sec.smartAppControl -eq 'on') { [void](Add-M31Check 'environment' 'Windows security settings' 'WARNING' ($sd + '. Smart App Control is ON: it can block unsigned programs (the EightMax programs are unsigned).')) }
            elseif ([string]$def.controlledFolderAccess -match '^(1|Enabled|AuditMode)$' -and $env1.paths.appInFolderProtectedByControlledFolderAccess) { [void](Add-M31Check 'environment' 'Windows security settings' 'WARNING' ($sd + '. The application folder is inside a folder protected by controlled folder access; Windows may block EightMax programs from writing there.')) }
            else { [void](Add-M31Check 'environment' 'Windows security settings' 'PASS' $sd) }
            $ep = $sec.executionPolicy; [void](Add-M31Check 'environment' 'PowerShell execution policy' 'PASS' ((@($ep.Keys | ForEach-Object { $_ + '=' + $ep[$_] })) -join ', ') )
            if ($env1.powershell.languageMode -ne 'FullLanguage') { [void](Add-M31Check 'environment' 'PowerShell language mode' 'WARNING' ($env1.powershell.languageMode + ': an application-control policy restricts PowerShell; some diagnostics are unavailable')) }
        }
        $procs = @(Get-M31EightMaxProcesses $root | Where-Object { -not $_.sessionOwned })
        $foreignHost = @($procs | Where-Object { $_.name -eq 'EightMaxWorkbench' })
        $foreignOther = @($procs | Where-Object { @('EightMaxInput', 'EightMaxTestTable') -contains $_.name })
        if ($foreignHost.Count) { [void](Add-M31Check 'environment' 'no EightMax desktop host already running' 'FAIL' ('already running (not started by this test, left running): ' + ((@($foreignHost | ForEach-Object { Format-M31Proc $_ })) -join '; ') + '. Close the EightMax Workbench and its dashboard, then run the test again.') 'environment') }
        else { [void](Add-M31Check 'environment' 'no EightMax desktop host already running' 'PASS' 'none') }
        if ($foreignOther.Count) { [void](Add-M31Check 'environment' 'no other EightMax test program running' 'WARNING' ('running (left alone): ' + ((@($foreignOther | ForEach-Object { Format-M31Proc $_ })) -join '; '))) }
        Set-M31Gate 'no-foreign-host' (-not $foreignHost.Count) $(if ($foreignHost.Count) { 'an EightMax desktop host this test did not start is running' } else { 'none' })
        Set-M31Gate 'no-foreign-input' (-not $foreignOther.Count) $(if ($foreignOther.Count) { 'another EightMax input driver or test table is running' } else { 'none' })
        $owners = @(Get-M31PortOwners 48713)
        if ($owners.Count) { [void](Add-M31Check 'environment' 'port 48713 free' 'FAIL' ('Port 48713 is already occupied by ' + (Format-M31PortOwners $owners) + '. The desktop host needs this port; the program was left running. Close it or restart Windows, then run the test again.') 'environment' $null $owners) }
        else { [void](Add-M31Check 'environment' 'port 48713 free' 'PASS' 'free') }
        Set-M31Gate 'port-free' (-not $owners.Count) $(if ($owners.Count) { 'port 48713 occupied by ' + (Format-M31PortOwners $owners) } else { 'free' })
        $inter = [bool]$env1.session.userInteractive -and ($env1.session.sessionId -ne 0)
        Set-M31Gate 'interactive-desktop' $inter $(if ($inter) { 'interactive desktop session ' + [string]$env1.session.sessionId } else { 'no interactive desktop (service session)' })
        if (-not $inter) { [void](Add-M31Check 'environment' 'interactive desktop' $(if ($Mode -eq 'Full' -or $script:M40Mode) { 'FAIL' } else { 'WARNING' }) 'this PowerShell does not run on an interactive desktop: windows and mouse input cannot be tested' 'environment') }
    }

    # ---- integrity -----------------------------------------------------------------------------------------------------------------
    Invoke-Selected 'integrity' 'Release integrity and executable identities' @() {
        $ri = Test-M31ReleaseIntegrity $root
        Write-M31AtomicText (Join-Path $M.Dir 'release-integrity.json') (ConvertTo-M31Json $ri)
        $sum = Format-M31IntegritySummary $ri
        if ($ri.ok) { [void](Add-M31Check 'integrity' 'release files match SHA256SUMS.txt (runtime output excluded by release-integrity-policy.json)' 'PASS' ($sum + ' (' + [string]$ri.seconds + ' s)') $null @('release-integrity.json')) }
        else { [void](Add-M31Check 'integrity' 'release files match SHA256SUMS.txt (runtime output excluded by release-integrity-policy.json)' 'FAIL' ($sum + ': ' + ((@($ri.failures | Select-Object -First 6 | ForEach-Object { $_.message })) -join '; ') + '. Extract the complete ZIP again into a new, empty folder.') 'environment' @('release-integrity.json')) }
        foreach ($w in @($ri.warnings | Select-Object -First 10)) { [void](Add-M31Check 'integrity' 'release folder note' 'WARNING' $w.message) }
        Set-M31Gate 'release-integrity' ([bool]$ri.ok) $(if ($ri.ok) { 'verified' } else { 'the release files failed verification' })
        $rel = $null; foreach ($rr in @('release-0362-m40.json', 'release-0362-m32.json', 'release-0362-m31.json')) { if (-not $rel -and (Test-Path -LiteralPath (Join-Path $root $rr))) { try { $rel = Read-M31JsonFile (Join-Path $root $rr) } catch {} } }   # 0.36.2 M3.2/M4.0: the newest release record
        $missingExe = 0
        foreach ($x in @('desktop\bin\EightMaxWorkbench.exe', 'desktop\bin\EightMaxInput.exe', 'desktop\bin\EightMaxTestTable.exe', 'desktop\bin\EightMaxCapture.exe', 'desktop\bin\EightMaxWgc.exe', 'native\mwcli.exe', 'runtime\node\node.exe')) {
            $pth = Join-Path $root $x
            if (-not (Test-Path -LiteralPath $pth -PathType Leaf)) { $missingExe++; [void](Add-M31Check 'identity' $x 'FAIL' 'missing: extract the complete ZIP again' 'environment'); continue }
            $h = Get-M31Sha256 $pth; $v = (Get-Item -LiteralPath $pth).VersionInfo
            $want = $null; if ($rel -and $rel.executables) { $k = ($x -replace '\\', '/'); $p2 = $rel.executables.PSObject.Properties[$k]; if ($p2) { $want = [string]$p2.Value.sha256 } }
            if ($want -and $want -ne $h) { [void](Add-M31Check 'identity' $x 'FAIL' ('sha256 ' + $h + ' differs from the release record ' + $want) 'environment') }
            else { [void](Add-M31Check 'identity' $x 'PASS' ('sha256 ' + $h.Substring(0, 16) + '... version ' + [string]$v.FileVersion + ' / ' + [string]$v.ProductVersion)) }
        }
        Set-M31Gate 'executables' ($missingExe -eq 0) $(if ($missingExe) { [string]$missingExe + ' program(s) missing' } else { 'present' })
        $mw = Join-Path $root 'native\mwcli.exe'
        if (Test-Path -LiteralPath $mw) {
            $h = Get-M31Sha256 $mw
            if ($h -eq $ExpectedMwcliSha) { [void](Add-M31Check 'identity' 'EightMax 5.1 binary unchanged' 'PASS' $h) } else { [void](Add-M31Check 'identity' 'EightMax 5.1 binary unchanged' 'FAIL' ('sha256 ' + $h + ' differs from ' + $ExpectedMwcliSha) 'environment') }
            if ($script:M31IsWindows) {
                $b = Invoke-M31Tool $mw '--build-id' (Join-Path $M.Dir 'mwcli-build-id') (Get-M31Limit 0 30) 'mwcli --build-id' $root
                $t = (Read-M31Text $b.out).Trim()
                if ($b.timedOut) { [void](Add-M31Check 'identity' 'EightMax 5.1 build id' 'FAIL' 'mwcli.exe --build-id did not answer within its time limit' 'timeout') }
                elseif ($t -match $ExpectedBuild) { [void](Add-M31Check 'identity' 'EightMax 5.1 build id' 'PASS' $t) }
                else { [void](Add-M31Check 'identity' 'EightMax 5.1 build id' 'FAIL' ('got: ' + $t + ' (exit ' + [string]$b.exitCode + ') ' + (Get-M31Tail $b.err 3)) 'application') }
            }
        }
    }

    # ---- dependencies --------------------------------------------------------------------------------------------------------------
    Invoke-Selected 'dependencies' 'Required components' @() {
        $x64 = [Environment]::Is64BitOperatingSystem -and [Environment]::Is64BitProcess
        [void](Add-M31Check 'dependencies' '64-bit Windows and 64-bit PowerShell' $(if ($x64) { 'PASS' } else { 'FAIL' }) $(if ($x64) { 'yes' } else { 'the desktop host needs 64-bit Windows PowerShell (C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe)' }) 'environment')
        Set-M31Gate 'powershell-64bit' $x64 $(if ($x64) { 'yes' } else { 'not 64-bit' })
        if ($script:M31IsWindows) {
            $rel = Get-M31RegValue 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' 'Release'
            if ($null -eq $rel) { [void](Add-M31Check 'dependencies' '.NET Framework 4.x' 'FAIL' '.NET Framework 4 is not installed' 'environment') }
            elseif ([int]$rel -lt 394802) { [void](Add-M31Check 'dependencies' '.NET Framework 4.x' 'FAIL' ('release ' + $rel + ' is older than 4.6.2') 'environment') }
            elseif ([int]$rel -lt 528040) { [void](Add-M31Check 'dependencies' '.NET Framework 4.x' 'WARNING' ('release ' + $rel + ' (older than 4.8; the tested configuration is 4.8)')) }
            else { [void](Add-M31Check 'dependencies' '.NET Framework 4.x' 'PASS' ('release ' + $rel + ' (4.8 or later)')) }
            $csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
            [void](Add-M31Check 'dependencies' 'csc.exe compiler of .NET Framework (used only by the fallback start)' $(if (Test-Path -LiteralPath $csc) { 'PASS' } else { 'WARNING' }) $csc)
        }
        $need = @('desktop\bin\EightMaxWorkbench.exe', 'desktop\bin\EightMaxInput.exe', 'windows\Start-Desktop.ps1', 'windows\Common.ps1', 'native\mwcli.exe', 'SHA256SUMS.txt', 'release-integrity-policy.json')
        if ($Mode -eq 'Full' -or $Mode -eq 'T5' -or $script:M40Mode) { $need += @('desktop\bin\EightMaxTestTable.exe', 'tools\gameplay-acceptance-0362m3.cjs', 'tools\lifecycle-acceptance-0362m2.cjs', 'tools\exit-audit-0362m3.cjs', 'tools\test-table-035.cjs') }
        if ($script:M40Mode) { $need += @('tools\recognition-validation-040.cjs', 'src\recognition-check.js', 'src\coordinate-spaces.js', 'src\input-presets.js', 'src\action-timeline.js', 'windows\M40-Summary.ps1') }
        if ($Mode -eq 'T5') { $need += @('tests\paused-window-0362m32.test.cjs', 'src\window-lifecycle.js', 'src\input-scheduler.js', 'src\simulator-controls.js') }
        $miss = @($need | Where-Object { -not (Test-Path -LiteralPath (Join-Path $root $_)) })
        [void](Add-M31Check 'dependencies' 'required release files present' $(if ($miss.Count) { 'FAIL' } else { 'PASS' }) $(if ($miss.Count) { 'missing: ' + ($miss -join ', ') + '. Extract the complete ZIP again.' } else { [string]$need.Count + ' files present' }) 'environment')
        $nodePath = $node; if ($M.FaultInjected -eq 'node-missing') { $nodePath = Join-Path $root 'runtime\node\node-missing-by-fault-injection.exe' }
        if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
            [void](Add-M31Check 'dependencies' 'bundled Node.js (runtime\node\node.exe) runs' 'FAIL' ('missing dependency: ' + [string]$nodePath + ' does not exist. The regression and real-window tests need it. Extract the complete ZIP again.') 'environment')
            Set-M31Gate 'node-runtime' $false 'runtime\node\node.exe is missing'
        } else {
            $r = Invoke-M31Tool $nodePath '--version' (Join-Path $M.Dir 'node-version') (Get-M31Limit 0 30) 'node --version' $root
            $v = (Read-M31Text $r.out).Trim()
            $ok = (-not $r.timedOut) -and $r.exitCode -eq 0 -and $v -match '^v\d+'
            [void](Add-M31Check 'dependencies' 'bundled Node.js (runtime\node\node.exe) runs' $(if ($ok) { 'PASS' } else { 'FAIL' }) $(if ($ok) { $v } elseif ($r.timedOut) { 'node --version did not answer within its time limit' } else { 'exit ' + [string]$r.exitCode + ': ' + (Get-M31Tail $r.err 3) }) $(if ($r.timedOut) { 'timeout' } else { 'environment' }))
            Set-M31Gate 'node-runtime' $ok $(if ($ok) { $v } else { 'node.exe does not run' })
        }
        $helper = Initialize-M31Helper
        [void](Add-M31Check 'dependencies' 'Windows helper for diagnostics (process tree, port owner, prompt windows)' $(if ($helper -or -not $script:M31IsWindows) { 'PASS' } else { 'WARNING' }) $(if ($helper) { 'compiled' } elseif (-not $script:M31IsWindows) { 'not Windows (self-check)' } else { 'unavailable: ' + $script:M31HelperError + ' - fallbacks are used' }))
    }

    # ---- unit (Full) ---------------------------------------------------------------------------------------------------------------
    $unit = [ordered]@{}
    Invoke-Selected 'unit' 'Regression tests (bundled Node, no windows)' @('node-runtime') {
        $focused = @('tests\release-integrity-0362m31.test.cjs', 'tests\runner-0362m31.test.cjs', 'tests\tournament-0362m3.test.cjs', 'tests\recovery-0362m3.test.cjs', 'tests\start-desktop-0362m3.test.cjs', 'tests\hand-ledger.test.cjs', 'tests\hand-tracker.test.cjs', 'tests\hand-state.test.cjs', 'tests\lifecycle-0362m2.test.cjs', 'tests\simulator-controls-035.test.cjs', 'tests\execution-adapters.test.cjs', 'tests\executor.test.cjs', 'tests\movement-settings-036.test.cjs', 'tests\simulator-decision-036.test.cjs', 'tests\release-0362m3.test.cjs')
        # 0.36.2 M3.2: the standalone T5 test runs the Milestone 3.2 deterministic tests (paused-window monitoring A-R, lifecycle, recovery, controls)
        if ($Mode -eq 'T5') { $focused = @('tests\paused-window-0362m32.test.cjs', 'tests\lifecycle-0362m2.test.cjs', 'tests\recovery-0362m3.test.cjs', 'tests\simulator-controls-035.test.cjs', 'tests\execution-adapters.test.cjs', 'tests\executor.test.cjs', 'tests\release-0362m32.test.cjs') }
        if ($FullSuite) { $files = @(Get-ChildItem (Join-Path $root 'tests') -Filter '*.test.cjs' | Sort-Object Name | ForEach-Object { 'tests\' + $_.Name }) } else { $files = @($focused | Where-Object { Test-Path -LiteralPath (Join-Path $root $_) }) }
        $unit.mode = $(if ($FullSuite) { 'complete suite' } elseif ($Mode -eq 'T5') { 'Milestone 3.2 paused-window / lifecycle set' } else { 'Milestone 3 / 3.1 focused set' }); $unit.files = $files.Count
        $env:EIGHTMAX_TEST_CLI = (Join-Path $root 'native\mwcli.exe')
        # 0.36.2 M3.2: where the .NET SDK is installed, tests\wgc-027 builds with dotnet; MSBuild's node reuse would keep a worker process
        # alive for minutes after the build (found as a leftover session process by the cleanup phase on Windows CI): no node reuse, no build server
        $env:MSBUILDDISABLENODEREUSE = '1'; $env:DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER = '1'
        $log = Join-Path $M.Dir 'unit-tests'
        $tick = { param($el) $t = Read-M31Text ($log + '.out.txt'); [string]([regex]::Matches($t, '(?m)^(not )?ok \d+ ').Count) + ' tests finished' }
        $r = Invoke-M31Tool $node ('--test --test-reporter=tap --test-concurrency=2 --test-timeout=600000 ' + (($files | ForEach-Object { '"' + $_ + '"' }) -join ' ')) $log (Get-M31Limit 0 3600) 'regression tests' $root $tick
        $tap = Read-M31Text $r.out; try { Copy-Item -LiteralPath $r.out -Destination (Join-Path $M.Dir 'unit-tests.tap') -Force } catch {}
        $n = { param($k) $ms = [regex]::Matches($tap, '(?m)^' + [string][char]35 + ' ' + $k + ' (\d+)\r?$'); if ($ms.Count) { [int]$ms[$ms.Count - 1].Groups[1].Value } else { 0 } }
        $unit.tests = & $n 'tests'; $unit.passed = & $n 'pass'; $unit.failed = & $n 'fail'; $unit.skipped = & $n 'skipped'; $unit.exitCode = $r.exitCode; $unit.seconds = $r.seconds
        $tf = Get-M31TapFailures $tap; $unit.failedNames = @($tf.failed); $unit.stoppedFiles = @($tf.stopped)
        if ($r.timedOut) { [void](Add-M31Check 'unit' 'regression tests' 'FAIL' ('timed out after ' + [string]$r.seconds + ' s; finished so far: ' + [string]([regex]::Matches($tap, '(?m)^(not )?ok \d+ ').Count)) 'timeout' @('unit-tests.tap')) }
        elseif ($unit.failed -eq 0 -and $unit.passed -gt 0 -and $r.exitCode -eq 0) { [void](Add-M31Check 'unit' ('regression tests (' + $unit.mode + ')') 'PASS' ([string]$unit.passed + ' passed, 0 failed, ' + [string]$unit.skipped + ' skipped') $null @('unit-tests.tap') $unit) }
        else { [void](Add-M31Check 'unit' ('regression tests (' + $unit.mode + ')') 'FAIL' ([string]$unit.passed + ' passed, ' + [string]$unit.failed + ' failed (exit ' + [string]$r.exitCode + '): ' + ($unit.failedNames -join '; ')) 'application' @('unit-tests.tap') $unit) }
    }

    # ---- host-start ----------------------------------------------------------------------------------------------------------------
    Invoke-Selected 'host-start' $(if ($Mode -eq 'Quick') { 'Desktop host start (prebuilt host, input driver, shutdown)' } else { 'Desktop host start: prebuilt, fallback compile, cache cases' }) @('release-integrity', 'powershell-64bit', 'no-foreign-host', 'port-free') {
        $only = @(); if ($HostCases) { $only = @($HostCases -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } elseif ($Mode -eq 'Quick' -or $Mode -eq 'T5') { $only = @('prebuilt') }
        if (-not $HostCases -and $script:M40Mode -and $Mode -ne 'M4Full') { $only = @('prebuilt') }   # 0.36.2 M4.0 A-C: the prebuilt start only (D runs every start case)
        $ss = $StartScript; if ($ss) { $ss = [IO.Path]::GetFullPath($ss); Write-M31Log ('TEST MODE: start-up script replaced by ' + $ss) 'Magenta' }
        $res = @(Invoke-M31HostStartCases -AppRoot $root -WorkDir (Join-Path $M.Dir 'host-start') -Only $only -StartScript $ss -LaunchTimeoutSec (Get-M31Limit $HostLaunchTimeoutSec 120) -CompileTimeoutSec (Get-M31Limit $HostCompileTimeoutSec 300) -ReadyTimeoutSec (Get-M31Limit $HostReadyTimeoutSec 60))
        Write-M31AtomicText (Join-Path $M.Dir 'host-start\host-start-summary.json') (ConvertTo-M31Json ([ordered]@{ format = 'eightmax-m31-host-start'; version = 1; cases = $res }))
        if (-not $res.Count) { [void](Add-M31Check 'host-start' 'start cases' 'SKIPPED' 'no start case was selected') }
    }

    # ---- real-window acceptance (Full) ---------------------------------------------------------------------------------------------
    $runs = [ordered]@{}
    $mouseNeeds = @('release-integrity', 'node-runtime', 'executables', 'input-driver', 'no-foreign-host', 'no-foreign-input', 'interactive-desktop')
    function Test-M31PortBeforeTool([string]$Group, [string]$Key) {
        $sw = [Diagnostics.Stopwatch]::StartNew(); while ($sw.Elapsed.TotalSeconds -lt 30 -and @(Get-M31PortOwners 48713).Count) { Start-Sleep -Milliseconds 250 }
        $o = @(Get-M31PortOwners 48713)
        if ($o.Count) { [void](Add-M31Check $Group ($Key + ' could start') 'FAIL' ('port 48713 is occupied by ' + (Format-M31PortOwners $o) + '; the tool was not started') 'environment'); return $false }
        return $true
    }
    function Invoke-M31NodeTool([string]$Key, [string]$Group, [string]$Arguments, [string]$ReportFile, [int]$TimeoutSec, [switch]$PerCheck) {
        if (-not (Test-M31PortBeforeTool $Group $Key)) { return $null }
        $env:EIGHTMAX_TEST_CLI = (Join-Path $root 'native\mwcli.exe')
        $tick = { param($el) $t = Get-M31Tail (Join-Path $M.Dir ($Key + '.out.txt')) 1 4096; if ($t.Length -gt 120) { $t = $t.Substring(0, 120) }; $t }
        $r = Invoke-M31Tool $node $Arguments (Join-Path $M.Dir $Key) $TimeoutSec $Key $root $tick
        $doc = $null; if (Test-Path -LiteralPath $ReportFile -PathType Leaf) { try { $doc = Read-M31LargeJson $ReportFile } catch {} }
        $runs[$Key] = [ordered]@{ exitCode = $r.exitCode; timedOut = $r.timedOut; seconds = $r.seconds; report = [IO.Path]::GetFileName($ReportFile); overall = $(if ($doc) { [string]$doc.overall } else { $null }) }
        if ($r.timedOut) { [void](Add-M31Check $Group ($Key + ' finished in time') 'FAIL' ('timed out after ' + $TimeoutSec + ' s (stopped; see ' + $Key + '.out.txt)') 'timeout') }
        if (-not $doc) { if (-not $r.timedOut) { [void](Add-M31Check $Group ($Key + ' produced a result') 'FAIL' ('no result file; exit ' + [string]$r.exitCode + '; ' + ((Get-M31Tail $r.err 5) -replace "`n", ' | ')) 'harness') }; return $null }
        foreach ($s in @($doc.scenarios)) {
            $failed = @(); foreach ($c in @($s.checks)) { if (-not $c.pass) { $d = [string](ConvertTo-M31Json $c.detail); if ($d.Length -gt 160) { $d = $d.Substring(0, 160) + '...' }; $failed += ([string]$c.name + ' (' + $d + ')') } }
            $st = $(if ([string]$s.status -eq 'pass') { 'PASS' } elseif ([string]$s.status -eq 'warning') { 'WARNING' } else { 'FAIL' })
            $detail = $(if ($failed.Count) { $(if ($st -eq 'WARNING') { 'warning: ' } else { 'failed: ' }) + ($failed -join '; ') } else { [string]@($s.checks).Count + ' checks passed in ' + [string][math]::Round([double]$s.durationMs / 1000) + ' s' })
            [void](Add-M31Check $Group ([string]$s.id + ': ' + [string]$s.name) $st $detail $(if ($st -eq 'FAIL') { 'application' } else { $null }))
            if ($PerCheck) {   # 0.36.2 M3.2 (T5): every numbered assertion is its own check in the report
                foreach ($c in @($s.checks)) { $d = [string](ConvertTo-M31Json $c.detail); if ($d.Length -gt 400) { $d = $d.Substring(0, 400) + '...' }; $cs = $(if ($c.pass) { 'PASS' } elseif ($c.warning) { 'WARNING' } else { 'FAIL' }); [void](Add-M31Check ($Group + ' ' + [string]$s.id) ([string]$c.name) $cs $d $(if ($cs -eq 'FAIL') { 'application' } else { $null })) }
            }
        }
        if ($doc.cleanup) { $cj = [string](ConvertTo-M31Json $doc.cleanup); if ($cj.Length -gt 300) { $cj = $cj.Substring(0, 300) + '...' }; if ($doc.cleanup.ok) { [void](Add-M31Check $Group ($Key + ': process cleanup (children exited, no live timers)') 'PASS' 'ok') } else { [void](Add-M31Check $Group ($Key + ': process cleanup') 'FAIL' $cj 'application') } }
        if (-not $r.timedOut) {
            if (([string]$doc.overall -eq 'PASS') -ne ($r.exitCode -eq 0)) { [void](Add-M31Check $Group ($Key + ': exit code matches the result') 'FAIL' ('overall ' + [string]$doc.overall + ', exit ' + [string]$r.exitCode) 'application') }
            else { [void](Add-M31Check $Group ($Key + ': exit code matches the result') 'PASS' ('overall ' + [string]$doc.overall + ', exit ' + [string]$r.exitCode)) }
        }
        return $doc
    }
    if ($Mode -eq 'Full' -or $Mode -eq 'M4Full') {
        if ($SkipAcceptance) { foreach ($x in @('lifecycle', 'gameplay', 'multi-table', 'campaign')) { if ($M.Phases.Contains($x)) { Skip-M31Phase $x 'skipped by option -SkipAcceptance' } } }
        else {
            Invoke-Selected 'lifecycle' 'Milestone 2 lifecycle acceptance A-K with real windows (process-exit audit)' $mouseNeeds {
                if (-not (Test-M31PortBeforeTool 'lifecycle' 'lifecycle-acceptance')) { return }
                $audit = Join-Path $M.Dir 'lifecycle-exit-audit.json'; $work = Join-Path $M.Dir 'work-lifecycle'
                $tick = { param($el) $t = Get-M31Tail (Join-Path $M.Dir 'lifecycle-acceptance.out.txt') 1 4096; if ($t.Length -gt 120) { $t = $t.Substring(0, 120) }; $t }
                $r = Invoke-M31Tool $node ('"tools\exit-audit-0362m3.cjs" --runs 1 --max-exit-ms 15000 --out "' + $audit + '" --work "' + $work + '" -- "tools\lifecycle-acceptance-0362m2.cjs" --work "' + (Join-Path $M.Dir 'work-m2') + '"') (Join-Path $M.Dir 'lifecycle-acceptance') (Get-M31Limit 0 3600) 'lifecycle acceptance' $root $tick
                $rep = Join-Path $work 'run-1-report.json'; if (Test-Path -LiteralPath $rep) { Copy-Item -LiteralPath $rep -Destination (Join-Path $M.Dir 'lifecycle-acceptance.json') -Force }
                $doc = $null; if (Test-Path -LiteralPath (Join-Path $M.Dir 'lifecycle-acceptance.json')) { $doc = Read-M31LargeJson (Join-Path $M.Dir 'lifecycle-acceptance.json') }
                $groups = [ordered]@{ 'capture lifecycle' = @('A', 'C', 'D', 'E', 'H', 'K'); 'input cancellation' = @('B', 'F', 'I'); 'safety' = @('G'); 'scripted gameplay' = @('J') }
                if ($r.timedOut) { [void](Add-M31Check 'lifecycle' 'lifecycle acceptance finished in time' 'FAIL' ('timed out after ' + [string]$r.seconds + ' s') 'timeout') }
                if ($doc) {
                    foreach ($s in @($doc.scenarios)) {
                        $failed = @(); foreach ($c in @($s.checks)) { if (-not $c.pass) { $d = [string](ConvertTo-M31Json $c.detail); if ($d.Length -gt 160) { $d = $d.Substring(0, 160) + '...' }; $failed += ([string]$c.name + ' (' + $d + ')') } }
                        $grp = 'lifecycle'; foreach ($gk in $groups.Keys) { if ($groups[$gk] -contains [string]$s.id) { $grp = 'lifecycle: ' + $gk; break } }
                        [void](Add-M31Check $grp ([string]$s.id + ': ' + [string]$s.name) $(if ([string]$s.status -eq 'pass') { 'PASS' } else { 'FAIL' }) $(if ($failed.Count) { 'failed: ' + ($failed -join '; ') } else { [string]@($s.checks).Count + ' checks passed in ' + [string][math]::Round([double]$s.durationMs / 1000) + ' s' }) 'application')
                    }
                    if ($doc.cleanup) { [void](Add-M31Check 'runner cleanup' 'lifecycle-acceptance: process cleanup (children exited, no live timers)' $(if ($doc.cleanup.ok) { 'PASS' } else { 'FAIL' }) $(if ($doc.cleanup.ok) { 'ok' } else { 'not clean' }) 'application') }
                } elseif (-not $r.timedOut) { [void](Add-M31Check 'lifecycle' 'Milestone 2 lifecycle acceptance produced a result' 'FAIL' ('no result; exit ' + [string]$r.exitCode + '; ' + ((Get-M31Tail $r.err 3) -replace "`n", ' | ')) 'harness') }
                if (Test-Path -LiteralPath $audit) {
                    $a = Read-M31LargeJson $audit; $run1 = @($a.runs)[0]
                    $runs['lifecycle'] = [ordered]@{ overall = $(if ($doc) { [string]$doc.overall } else { $null }); reportToExitMs = $run1.reportToExitMs; exitCode = $run1.exitCode; exitCodeMatchesVerdict = $run1.exitCodeMatchesVerdict }
                    if ($run1.reportWritten -and $null -ne $run1.reportToExitMs -and [int]$run1.reportToExitMs -le 15000 -and $run1.exitCodeMatchesVerdict) { [void](Add-M31Check 'runner cleanup' 'lifecycle runner exits by itself after its report; exit code matches' 'PASS' ('report -> exit ' + [string]$run1.reportToExitMs + ' ms, exit ' + [string]$run1.exitCode)) }
                    else { $rj = [string](ConvertTo-M31Json $run1); if ($rj.Length -gt 300) { $rj = $rj.Substring(0, 300) + '...' }; [void](Add-M31Check 'runner cleanup' 'lifecycle runner exits by itself after its report; exit code matches' 'FAIL' $rj 'application') }
                } elseif (-not $r.timedOut) { [void](Add-M31Check 'runner cleanup' 'exit audit produced a result' 'FAIL' 'no exit-audit file' 'harness') }
            }
            Invoke-Selected 'gameplay' 'Milestone 3 gameplay acceptance T1-T6 (and the Milestone 3.2 T5P) with real windows' $mouseNeeds { $f = Join-Path $M.Dir 'gameplay-acceptance.json'; $null = Invoke-M31NodeTool 'gameplay-acceptance' 'gameplay' ('"tools\gameplay-acceptance-0362m3.cjs" --suite acceptance --out "' + $f + '" --work "' + (Join-Path $M.Dir 'work-gameplay') + '"') $f (Get-M31Limit 0 3600) }
            if ($SkipStability) { if ($M.Phases.Contains('multi-table')) { Skip-M31Phase 'multi-table' 'skipped by option -SkipStability' } }
            else { Invoke-Selected 'multi-table' 'Multi-table stability (1, 2, 5, 8 tables) with real windows' $mouseNeeds { $f = Join-Path $M.Dir 'gameplay-stability.json'; $null = Invoke-M31NodeTool 'gameplay-stability' 'multi-table' ('"tools\gameplay-acceptance-0362m3.cjs" --suite stability --tables ' + $StabilityTables + ' --seconds ' + $StabilitySeconds + ' --out "' + $f + '" --work "' + (Join-Path $M.Dir 'work-stability') + '"') $f (Get-M31Limit 0 7200) } }
            if ($CampaignHands -gt 0) { Invoke-Selected 'campaign' 'Long campaign: tournaments to the end' $mouseNeeds { $f = Join-Path $M.Dir 'gameplay-campaign.json'; $null = Invoke-M31NodeTool 'gameplay-campaign' 'campaign' ('"tools\gameplay-acceptance-0362m3.cjs" --suite campaign --tables 1 --hands ' + $CampaignHands + ' --max-minutes ' + $CampaignMinutes + ' --out "' + $f + '" --work "' + (Join-Path $M.Dir 'work-campaign') + '"') $f (Get-M31Limit 0 (($CampaignMinutes + 15) * 60)) } }
        }
    }

    # ---- t5 (Milestone 3.2 standalone) ------------------------------------------------------------------------------------------------
    if ($Mode -eq 'T5') {
        Invoke-Selected 't5' ('T5 and T5P with real windows (' + $T5Repeat + ' repetition(s)): one of two tables closes - while active and while paused') $mouseNeeds {
            $f = Join-Path $M.Dir 't5-acceptance.json'
            $doc = Invoke-M31NodeTool 't5-acceptance' 't5' ('"tools\gameplay-acceptance-0362m3.cjs" --suite t5 --repeat ' + $T5Repeat + ' --out "' + $f + '" --work "' + (Join-Path $M.Dir 'work-t5') + '"') $f (Get-M31Limit 0 (600 + 900 * 2 * $T5Repeat)) -PerCheck
            # the plain-language summary is a convenience: if it cannot be written the test results are still complete (WARNING, with the error)
            if ($doc) { try { Write-M32T5Summary $doc (Join-Path $M.Dir 'T5-SUMMARY.txt') } catch { $er = $_; [void](Add-M31Check 't5' 'T5 plain-language summary (T5-SUMMARY.txt)' 'WARNING' ('could not be written: ' + $er.Exception.GetType().FullName + ': ' + $er.Exception.Message + ' (' + [string]$er.InvocationInfo.ScriptName + ' line ' + [string]$er.InvocationInfo.ScriptLineNumber + '); every result is in milestone3-results.txt')); Write-M31ErrorLog ('T5 summary: ' + $er.Exception.ToString()) } }
        }
    }

    # ---- Milestone 4.0 performance tests (RUN-M4-PERFORMANCE-TEST.cmd A-D) -------------------------------------------------------------
    $m40 = [ordered]@{ mode = $Mode; sustainedMinutes = $SustainedMinutes; abSeconds = $ABSeconds; abTables = $ABTables; docs = [ordered]@{} }
    if ($script:M40Mode) {
        Invoke-Selected 'recognition' ('Recognition dataset: every table size at 100-200 % display scaling, clean and degraded, ' + $RecognitionFrames + ' game states per size (no windows, no input)') @('node-runtime') {
            $f = Join-Path $M.Dir 'recognition-dataset.json'
            $tick = { param($el) $t = Get-M31Tail (Join-Path $M.Dir 'recognition-dataset.out.txt') 1 4096; if ($t.Length -gt 120) { $t = $t.Substring(0, 120) }; $t }
            $r = Invoke-M31Tool $node ('"tools\recognition-validation-040.cjs" --frames ' + $RecognitionFrames + ' --out "' + $f + '"') (Join-Path $M.Dir 'recognition-dataset') (Get-M31Limit 0 2400) 'recognition dataset' $root $tick
            $doc = Read-M31LargeJson $f; $m40.docs['recognition'] = $doc
            if ($r.timedOut) { [void](Add-M31Check 'recognition' 'recognition dataset finished in time' 'FAIL' ('timed out after ' + [string]$r.seconds + ' s') 'timeout') }
            if (-not $doc) { if (-not $r.timedOut) { [void](Add-M31Check 'recognition' 'recognition dataset produced a result' 'FAIL' ('no result; exit ' + [string]$r.exitCode + '; ' + ((Get-M31Tail $r.err 3) -replace "`n", ' | ')) 'harness') }; return }
            $v = Get-M40Field $doc 'verdict'; $fr = Get-M40Field $doc 'frames'; $g = Get-M40Field $doc 'geometry'
            [void](Add-M31Check 'recognition' 'no frame the automation would act on holds a wrong value (never guessed)' $(if (Get-M40Field $v 'neverGuessed') { 'PASS' } else { 'FAIL' }) ([string](Get-M40Field $fr 'accepted') + ' of ' + [string](Get-M40Field $fr 'total') + ' frames accepted; accepted with a wrong value: ' + [string](Get-M40Field $fr 'acceptedWithWrongValue')) 'application')
            [void](Add-M31Check 'recognition' 'every clean frame is read at every size (800-3840 px)' $(if (Get-M40Field $v 'cleanFramesAllAccepted') { 'PASS' } else { 'FAIL' }) (Format-M40Degradation $doc 'clean') 'application')
            [void](Add-M31Check 'recognition' 'a DPI-virtualised (scaled) capture is refused as safety-critical' $(if (Get-M40Field $v 'dpiVirtualisedCapturesAllRefused') { 'PASS' } else { 'FAIL' }) ([string](Get-M40Field $g 'refusedAsCritical') + ' of ' + [string](Get-M40Field $g 'dpiVirtualisedCaptures') + ' refused') 'application')
            [void](Add-M31Check 'recognition' 'Verify Table Recognition passes on every clean frame at its display scaling' $(if (Get-M40Field $v 'verifyCleanAllPass') { 'PASS' } else { 'FAIL' }) ([string](Get-M40Field $g 'verifyCleanPass') + ' of ' + [string](Get-M40Field $g 'verifyClean')) 'application')
            foreach ($d in @('noise', 'shift-1px', 'dim', 'dpi-stretched', 'blur', 'occluded')) { [void](Add-M31Check 'recognition' ('degraded frames: ' + $d + ' (read, or refused - never guessed)') 'PASS' (Format-M40Degradation $doc $d)) }
        }
        if ($Mode -eq 'M4Recognition') {
            Invoke-Selected 'recognition-windows' 'Recognition on real EightMax test-table windows on this display (host capture, Verify Table Recognition, compared with the table''s own state; no mouse input)' $mouseNeeds {
                if (-not (Test-M31PortBeforeTool 'recognition-windows' 'recognition-windows')) { return }
                $f = Join-Path $M.Dir 'recognition-windows.json'
                $tick = { param($el) $t = Get-M31Tail (Join-Path $M.Dir 'recognition-windows.out.txt') 1 4096; if ($t.Length -gt 120) { $t = $t.Substring(0, 120) }; $t }
                $r = Invoke-M31Tool $node ('"tools\recognition-validation-040.cjs" --windows --steps 8 --out "' + $f + '" --work "' + (Join-Path $M.Dir 'work-recognition') + '"') (Join-Path $M.Dir 'recognition-windows') (Get-M31Limit 0 1800) 'recognition on real windows' $root $tick
                $doc = Read-M31LargeJson $f; $m40.docs['recognitionWindows'] = $doc
                if ($r.timedOut) { [void](Add-M31Check 'recognition-windows' 'recognition on real windows finished in time' 'FAIL' ('timed out after ' + [string]$r.seconds + ' s') 'timeout') }
                if (-not $doc) { if (-not $r.timedOut) { [void](Add-M31Check 'recognition-windows' 'recognition on real windows produced a result' 'FAIL' ('no result; exit ' + [string]$r.exitCode + '; ' + ((Get-M31Tail $r.err 3) -replace "`n", ' | ')) 'harness') }; return }
                foreach ($t in @(Get-M40Field $doc 'tables')) {
                    $vs = @(Get-M40Field $t 'verify'); $pass = @($vs | Where-Object { [string](Get-M40Field $_ 'verdict') -ne 'fail' }).Count
                    $crit = @($vs | Where-Object { [string](Get-M40Field $_ 'verdict') -eq 'fail' } | ForEach-Object { @(Get-M40Field $_ 'critical') -join '; ' } | Select-Object -First 2)
                    $sc = [int](Get-M40Field $t 'stripCropChecks'); $sm = [int](Get-M40Field $t 'stripCropMatches')
                    [void](Add-M31Check 'recognition-windows' ('Verify Table Recognition at ' + [string](Get-M40Field $t 'width') + ' px') $(if ($vs.Count -and $pass -eq $vs.Count) { 'PASS' } else { 'FAIL' }) ([string]$pass + ' of ' + [string]$vs.Count + ' checks passed' + $(if ($crit.Count) { '; ' + ($crit -join ' | ') } else { '' }) + '; strip-only capture = full frame ' + [string]$sm + '/' + [string]$sc) 'application')
                }
                $fe = Get-M40Field $doc 'features'; $wrong = 0; $n = 0; foreach ($k in @(Get-M40Keys $fe)) { $x = Get-M40Field $fe $k; $wrong += [int](Get-M40Field $x 'falsePositives'); $n += [int](Get-M40Field $x 'readings') }
                [void](Add-M31Check 'recognition-windows' 'recognised values match the tables'' own state' $(if ($n -gt 0 -and $wrong -eq 0) { 'PASS' } elseif ($n -eq 0) { 'WARNING' } else { 'FAIL' }) ([string]$n + ' values compared, ' + [string]$wrong + ' different') 'application')
            }
        }
        Invoke-Selected 'scheduler' ('Scheduler benchmark on this PC: the Milestone 3.2 multi-table workload (' + $ABTables + ' tables, ' + $ABSeconds + ' s each) with the Milestone 3.2 input pipeline, then with the Milestone 4.0 pipeline (same mouse speed)') $mouseNeeds {
            $runsAB = @(@{ key = 'compat-3.2'; pipe = 'compat-3.2'; extra = '' }, @{ key = 'optimized'; pipe = 'optimized'; extra = '' })
            if ($ABFast) { $runsAB += @(@{ key = 'optimized-fast'; pipe = 'optimized'; extra = ' --speed 2000 --accel 15000' }) }
            foreach ($x in $runsAB) {
                $f = Join-Path $M.Dir ('scheduler-' + $x.key + '.json')
                $doc = Invoke-M31NodeTool ('scheduler-' + $x.key) 'scheduler' ('"tools\gameplay-acceptance-0362m3.cjs" --suite stability --tables ' + $ABTables + ' --seconds ' + $ABSeconds + ' --pipeline ' + $x.pipe + ' --policy edf' + $x.extra + ' --out "' + $f + '" --work "' + (Join-Path $M.Dir ('work-scheduler-' + $x.key)) + '"') $f (Get-M31Limit 0 (900 + 240 * @($ABTables -split ',').Count + 4 * $ABSeconds))
                $m40.docs[('scheduler-' + $x.key)] = $doc
            }
            Add-M40Comparison $m40
        }
        if ($Mode -eq 'M4Extended' -or $Mode -eq 'M4Full') {
            Invoke-Selected 'sustained' ('Uninterrupted play, ' + $SustainedMinutes + ' min at each of ' + $SustainedTables + ' tables (Milestone 4.0 pipeline, no injected faults)') $mouseNeeds {
                foreach ($n in @($SustainedTables -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' })) {
                    $f = Join-Path $M.Dir ('sustained-' + $n + '.json')
                    $doc = Invoke-M31NodeTool ('sustained-' + $n) 'sustained' ('"tools\gameplay-acceptance-0362m3.cjs" --suite sustained --tables ' + $n + ' --seconds ' + (60 * $SustainedMinutes) + ' --pipeline optimized --policy edf --out "' + $f + '" --work "' + (Join-Path $M.Dir ('work-sustained-' + $n)) + '"') $f (Get-M31Limit 0 (60 * $SustainedMinutes + 1200))
                    $m40.docs[('sustained-' + $n)] = $doc
                }
            }
        }
        if ($Mode -eq 'M4Extended') {
            Invoke-Selected 'faults' ('Fault injection: ' + $FaultTables + ' tables for ' + $FaultSeconds + ' s with windows closed and reopened and emergency stops while they play') $mouseNeeds {
                $f = Join-Path $M.Dir 'fault-injection.json'
                $doc = Invoke-M31NodeTool 'fault-injection' 'faults' ('"tools\gameplay-acceptance-0362m3.cjs" --suite stability --tables ' + $FaultTables + ' --seconds ' + $FaultSeconds + ' --pipeline optimized --policy edf --out "' + $f + '" --work "' + (Join-Path $M.Dir 'work-faults') + '"') $f (Get-M31Limit 0 ($FaultSeconds + 1200))
                $m40.docs['faults'] = $doc
            }
        }
        # the plain-language summary is a convenience: if it cannot be written every result is still in milestone3-results.txt (WARNING)
        try { Write-M40Summary $m40 (Join-Path $M.Dir 'M4-SUMMARY.txt') } catch { $er = $_; [void](Add-M31Check 'summary' 'Milestone 4.0 plain-language summary (M4-SUMMARY.txt)' 'WARNING' ('could not be written: ' + $er.Exception.GetType().FullName + ': ' + $er.Exception.Message + ' (line ' + [string]$er.InvocationInfo.ScriptLineNumber + ')')); Write-M31ErrorLog ('M4 summary: ' + $er.Exception.ToString()) }
    }

    # ---- cleanup -------------------------------------------------------------------------------------------------------------------
    Invoke-Selected 'cleanup' 'Cleanup: nothing left running, port released' @() {
        Start-Sleep -Seconds 2
        $left = @(Get-M31EightMaxProcesses $root | Where-Object { $_.sessionOwned })
        if ($left.Count) { foreach ($p in $left) { [void](Stop-M31ProcessTree $p.pid 'left over at the end of the run') }; [void](Add-M31Check 'cleanup' 'no leftover EightMax processes started by these tests' 'FAIL' ('left running: ' + ((@($left | ForEach-Object { Format-M31Proc $_ })) -join '; ') + ' (stopped now)') 'application') }
        else { [void](Add-M31Check 'cleanup' 'no leftover EightMax processes started by these tests' 'PASS' 'none') }
        $foreign = @(Get-M31EightMaxProcesses $root | Where-Object { -not $_.sessionOwned })
        if ($foreign.Count) { [void](Add-M31Check 'cleanup' 'EightMax programs this test did not start' 'WARNING' ('still running and left alone: ' + ((@($foreign | ForEach-Object { Format-M31Proc $_ })) -join '; '))) }
        $sess = @(Get-M31SessionPids | Where-Object { Test-M31Alive $_ })
        if ($sess.Count) { $names = @(Stop-M31SessionProcesses 'end of the run'); [void](Add-M31Check 'cleanup' 'no other process of this test session left' 'WARNING' ('stopped: ' + ($names -join ', '))) }
        else { [void](Add-M31Check 'cleanup' 'no other process of this test session left' 'PASS' 'none') }
        $o = @(Get-M31PortOwners 48713)
        if ($o.Count) { [void](Add-M31Check 'cleanup' 'port 48713 released' $(if ($M.Gates.Contains('port-free') -and -not $M.Gates['port-free'].ok) { 'WARNING' } else { 'FAIL' }) ('in use by ' + (Format-M31PortOwners $o)) 'application') }
        else { [void](Add-M31Check 'cleanup' 'port 48713 released' 'PASS' 'free') }
    }
    $completed = $true
} catch {
    if ($_.Exception -is [Management.Automation.PipelineStoppedException]) { throw }   # Ctrl+C: finalised as INTERRUPTED below
    try { [void](Add-M31Exception $_ 'harness' 'test runner main sequence') } catch { [Console]::Error.WriteLine('EightMax M3.1 runner error: ' + $_.Exception.Message) }
    $completed = $true
} finally {
    if ($transcript) { try { $null = Stop-Transcript } catch {} }
    if (-not $completed) {
        try { Write-M31Log 'The run was stopped before it finished (Ctrl+C or the runner was stopped). Saving what was done ...' 'Yellow' } catch {}
        try { $null = Stop-M31SessionProcesses 'run stopped' } catch {}
        $final = Complete-M31Run 'interrupted' 'the run was stopped before it finished (Ctrl+C or the runner was stopped)'
    } else {
        try { $null = Stop-M31SessionProcesses 'end of the run' } catch {}
        $final = Complete-M31Run 'completed'
    }
    if ($LauncherStderr -and (Test-Path -LiteralPath $LauncherStderr)) { try { $t = Read-M31Text $LauncherStderr; if ($t.Trim()) { [IO.File]::WriteAllText((Join-Path $M.Dir 'powershell-stderr.txt'), $t, $script:M31Utf8) } } catch {} }
    if ($final) {
        $color = switch ($final.overall) { 'PASS' { 'Green' } 'WARNING' { 'Yellow' } default { 'Red' } }
        $interruptedRun = -not $completed
        Write-M31Log ''
        if ($final.document) { $d = $final.document; Write-M31Log ('Checks: ' + [string]$d.counts.PASS + ' passed, ' + [string]$d.counts.FAIL + ' failed, ' + [string]$d.counts.WARNING + ' warnings, ' + [string]$d.counts.SKIPPED + ' skipped') }
        Write-M31Log ('OVERALL: ' + $final.overall + '  (exit code ' + $final.exitCode + ': ' + (Get-M31ExitMeaning $final.exitCode) + ')') $color
        Write-M31Log ('Results folder: ' + $M.Dir)
        if ($final.zip.ok) { Write-M31Log ('Results ZIP to send back: ' + $final.zip.path) 'Green' } else { Write-M31Log ('The results ZIP could not be created (' + [string]$final.zip.error + '); send the results folder instead.') 'Red' }
        # after Ctrl+C the script cannot reach its own exit statement: end with 4 (INTERRUPTED) now that the report and ZIP are written
        if ($interruptedRun) { [Environment]::Exit(4) }
    }
}
if ($final) { exit $final.exitCode } else { exit 2 }
