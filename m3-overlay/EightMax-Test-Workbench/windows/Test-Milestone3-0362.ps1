<# EightMax Test Workbench 0.36.2-dev - MILESTONE 3 Windows verification: tournament hand tracking with eliminated players, hand
   recovery, multi-table stability, test-runner cleanup and the desktop-host fallback compile - on YOUR computer, with real windows.
   Needs nothing installed: it uses the bundled Node.js (runtime\node\node.exe), the bundled executables and Windows PowerShell.
   What it does (about 30-60 minutes; the mouse moves by itself inside the EightMax test tables - do not touch mouse or keyboard):
     1. machine details (Windows, CPU, RAM, GPU, displays and scaling)
     2. executable identities (SHA-256, versions, release checksums, EightMax 5.1 build id - must be 7d08acc7eb4577ee)
     3. regression tests (bundled Node, no windows): the Milestone 3 tests, or the complete suite with -FullSuite
     4. desktop host start: prebuilt host, forced fallback compile (fresh cache), cache reuse, invalid-cache recovery, old cache key not
        reused, build-only; health check, authenticated shutdown, port 48713 released, no input driver left running
     5. Milestone 2 lifecycle acceptance with real windows (scenarios A-K), measured by the process-exit audit (report -> exit time)
     6. Milestone 3 gameplay acceptance with real windows (T1-T6: eliminated players, tournament end, untracked-hand recovery, think-time
        holds, two tables with a closure, emergency stop after an elimination)
     7. multi-table stability with real windows: 1, 2, 5 and 8 tables (closures, reopen, emergency stops, eliminations)
     8. optional long campaign (-CampaignHands N): tournaments played to the end until N hands are completed
     9. cleanup check (no leftover EightMax processes, port 48713 free)
   Usage: powershell -NoProfile -ExecutionPolicy Bypass -File windows\Test-Milestone3-0362.ps1 [-OutDir DIR] [-FullSuite] [-SkipAcceptance]
          [-SkipStability] [-StabilitySeconds 60] [-StabilityTables 1,2,5,8] [-CampaignHands 0] [-CampaignMinutes 30]
   Results: <OutDir>\milestone3-results.json, milestone3-results.txt, every raw log, and <OutDir>.zip to send back.
   Exit code 0 only when every required check passed. #>
param([string]$OutDir, [switch]$FullSuite, [switch]$SkipAcceptance, [switch]$SkipStability, [int]$StabilitySeconds = 60, [string]$StabilityTables = '1,2,5,8', [int]$CampaignHands = 0, [int]$CampaignMinutes = 30)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
Add-Type -AssemblyName System.Web.Extensions, System.Windows.Forms
$root = Get-WorkbenchRoot
$TestStart = [DateTime]::Now; $stamp = $TestStart.ToString('yyyyMMdd-HHmmss')
if (-not $OutDir) {
    $OutDir = Join-Path $root ('test-results\Milestone3-' + $stamp)
    try { [IO.Directory]::CreateDirectory($OutDir) | Out-Null; [IO.File]::WriteAllText((Join-Path $OutDir '.write-test'), 'ok'); Remove-Item -LiteralPath (Join-Path $OutDir '.write-test') -Force }
    catch { $OutDir = Join-Path $env:LOCALAPPDATA ('EightMax-Test-Workbench\Milestone3-0.36.2\run-' + $stamp) }
}
[IO.Directory]::CreateDirectory($OutDir) | Out-Null
$js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = [int]::MaxValue; $js.RecursionLimit = 200
$node = Join-Path $root 'runtime\node\node.exe'
$ExpectedBuild = '7d08acc7eb4577ee'; $ExpectedMwcliSha = 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72'
$script:checks = New-Object Collections.ArrayList
$script:phases = [ordered]@{}
# Every record is an ordered dictionary: JavaScriptSerializer cannot serialise PSCustomObject on Windows PowerShell 5.1 (a circular
# reference through PSObject.Members) - the defect that made the Milestone 2 runner crash after its tests in CI run 45163715758.
function Add-Check([string]$Group, [string]$Name, [string]$Status, [string]$Detail) {
    [void]$script:checks.Add([ordered]@{ group = $Group; name = $Name; status = $Status; detail = $Detail; at = [DateTime]::UtcNow.ToString('o') })
    Write-Host ('[{0}] {1,-4} {2}: {3}' -f $Group, $Status.ToUpperInvariant(), $Name, $Detail)
}
function ConvertTo-Plain($v) {
    if ($null -eq $v) { return $null }
    if ($v -is [string] -or $v -is [bool] -or $v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) { return $v }
    if ($v -is [DateTime]) { return $v.ToUniversalTime().ToString('o') }
    if ($v -is [Collections.IDictionary]) { $o = [ordered]@{}; foreach ($k in @($v.Keys)) { $o[[string]$k] = ConvertTo-Plain $v[$k] }; return $o }
    if ($v -is [Management.Automation.PSCustomObject]) { $o = [ordered]@{}; foreach ($p in $v.PSObject.Properties) { $o[$p.Name] = ConvertTo-Plain $p.Value }; return $o }
    if ($v -is [Collections.IEnumerable]) { $a = New-Object Collections.ArrayList; foreach ($x in $v) { [void]$a.Add((ConvertTo-Plain $x)) }; return ,($a.ToArray()) }
    if ($v -is [ValueType]) { return [string]$v }
    return [string]$v
}
function Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Read-Text([string]$Path) { for ($i = 0; $i -lt 20; $i++) { try { return [IO.File]::ReadAllText($Path) } catch { Start-Sleep -Milliseconds 100 } }; return '' }
function Run-Logged([string]$Exe, [string]$Arguments, [string]$LogName, [int]$TimeoutSec) {
    # Output goes to files (never pipes), the pattern the Milestone 1 checks proved on Windows.
    $of = Join-Path $OutDir ($LogName + '.out.txt'); $ef = Join-Path $OutDir ($LogName + '.err.txt'); $w = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $root -RedirectStandardOutput $of -RedirectStandardError $ef -WindowStyle Hidden -PassThru; $null = $p.Handle
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch {}; return [ordered]@{ code = -1; timedOut = $true; out = $of; err = $ef; seconds = [math]::Round($w.Elapsed.TotalSeconds) } }
    return [ordered]@{ code = $p.ExitCode; timedOut = $false; out = $of; err = $ef; seconds = [math]::Round($w.Elapsed.TotalSeconds) }
}
function Short($Value) { if ($null -eq $Value) { return '' }; $t = $(if ($Value -is [string]) { $Value } else { $js.Serialize((ConvertTo-Plain $Value)) }); if ($t.Length -gt 160) { $t = $t.Substring(0, 160) + '...' }; return $t }
function Sha-String([string]$Text) { $h = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$Text))) -replace '-', '').ToLowerInvariant() } finally { $h.Dispose() } }
function Port-Owners([int]$Port = 48713) { @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { 'pid ' + $_.OwningProcess }) }
function Wait-Until([scriptblock]$Condition, [int]$Ms, [int]$Step = 100) { $w = [Diagnostics.Stopwatch]::StartNew(); while ($w.ElapsedMilliseconds -lt $Ms) { if (& $Condition) { return $true }; Start-Sleep -Milliseconds $Step }; return [bool](& $Condition) }
function Wait-PortFree([int]$Ms = 15000) { $w = [Diagnostics.Stopwatch]::StartNew(); while ($w.ElapsedMilliseconds -lt $Ms) { if (-not @(Port-Owners).Count) { return $w.ElapsedMilliseconds }; Start-Sleep -Milliseconds 200 }; return -1 }
function Alive([int]$ProcessId) { try { $p = [Diagnostics.Process]::GetProcessById($ProcessId); return -not $p.HasExited } catch { return $false } }
function New-Leftovers([string[]]$Names) { @(Get-Process -Name $Names -ErrorAction SilentlyContinue | Where-Object { try { $_.StartTime -gt $TestStart } catch { $false } } | ForEach-Object { $_.ProcessName + ' pid ' + $_.Id }) }
function HostCall([string]$Method, [string]$Path, $Body = $null, [int]$TimeoutSec = 30) {
    $req = [Net.HttpWebRequest]::Create($script:Origin + $Path); $req.Method = $Method; $req.Proxy = $null; $req.Timeout = $TimeoutSec * 1000; $req.ReadWriteTimeout = $TimeoutSec * 1000; $req.KeepAlive = $false
    $req.ServicePoint.Expect100Continue = $false; if ($script:Token) { $req.Headers.Add('X-EightMax-Session', $script:Token) }
    if ($null -ne $Body) { $text = $(if ($Body -is [string]) { $Body } else { $js.Serialize($Body) }); $bytes = [Text.Encoding]::UTF8.GetBytes($text); $req.ContentType = 'application/json'; $req.ContentLength = $bytes.Length; $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close() }
    $resp = $null
    try { $resp = $req.GetResponse() } catch { $we = $_.Exception; while ($we -and -not ($we -is [Net.WebException])) { $we = $we.InnerException }; if ($we -and $we.Response) { $resp = $we.Response } else { throw } }
    $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8); $raw = $sr.ReadToEnd(); $sr.Close(); $status = [int]$resp.StatusCode; $resp.Close()
    $parsed = $null; try { $parsed = $js.DeserializeObject($raw) } catch {}
    return [ordered]@{ status = $status; raw = $raw; json = $parsed }
}
function Phase([string]$Name, [scriptblock]$Body) {
    $w = [Diagnostics.Stopwatch]::StartNew(); Write-Host ''; Write-Host ('==== ' + $Name)
    try { & $Body } catch { Add-Check 'harness' ($Name + ' ran to completion') 'fail' $_.Exception.Message }
    $script:phases[$Name] = [math]::Round($w.Elapsed.TotalSeconds)
}

Write-Host ('EightMax 0.36.2 Milestone 3 tests. Results folder: ' + $OutDir)
Write-Host 'The mouse will move by itself inside the EightMax test tables. Do not touch the mouse or keyboard until this finishes.'

# ---------------- 1. machine details ----------------
$machine = [ordered]@{}
Phase 'machine' {
    $os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem
    $machine.windows = [ordered]@{ caption = [string]$os.Caption; version = [string]$os.Version; build = [string]$os.BuildNumber; architecture = [string]$os.OSArchitecture }
    $machine.cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { [string]$_.Name.Trim() + ' (' + $_.NumberOfCores + ' cores, ' + $_.NumberOfLogicalProcessors + ' threads)' })
    $machine.ramGiB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    $machine.gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { [ordered]@{ name = [string]$_.Name; driver = [string]$_.DriverVersion; resolution = ([string]$_.CurrentHorizontalResolution + 'x' + [string]$_.CurrentVerticalResolution) } })
    $machine.screens = @([Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ device = [string]$_.DeviceName; primary = [bool]$_.Primary; bounds = ([string]$_.Bounds.Width + 'x' + [string]$_.Bounds.Height) } })
    try { $logPix = (Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction Stop).AppliedDPI; $machine.appliedDpi = [int]$logPix; $machine.displayScalingPercent = [math]::Round($logPix / 96 * 100) } catch { $machine.displayScalingPercent = 'unknown' }
    try { $machine.dotNetFrameworkRelease = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release -ErrorAction Stop).Release } catch { $machine.dotNetFrameworkRelease = 'unknown' }
    $machine.powershell = $PSVersionTable.PSVersion.ToString(); $machine.computerNameHash = (Sha-String $env:COMPUTERNAME).Substring(0, 12)
    $machine.ci = [ordered]@{ githubActions = [bool]$env:GITHUB_ACTIONS; runId = [string]$env:GITHUB_RUN_ID; runner = [string]$env:RUNNER_NAME; repository = [string]$env:GITHUB_REPOSITORY; sha = [string]$env:GITHUB_SHA }
    Add-Check 'machine' 'machine details collected' 'pass' ($machine.windows.caption + ' build ' + $machine.windows.build + '; ' + ($machine.cpu -join '; ') + '; ' + [string]$machine.ramGiB + ' GiB; scaling ' + [string]$machine.displayScalingPercent + '%')
}

# ---------------- 2. executable identities ----------------
$identities = New-Object Collections.ArrayList
Phase 'identity' {
    foreach ($rel in @('desktop\bin\EightMaxWorkbench.exe', 'desktop\bin\EightMaxInput.exe', 'desktop\bin\EightMaxTestTable.exe', 'desktop\bin\EightMaxCapture.exe', 'desktop\bin\EightMaxWgc.exe', 'native\mwcli.exe', 'runtime\node\node.exe')) {
        $p = Join-Path $root $rel
        if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Add-Check 'identity' ($rel + ' present') 'fail' 'missing'; continue }
        $v = (Get-Item -LiteralPath $p).VersionInfo; $h = Sha $p
        [void]$identities.Add([ordered]@{ file = $rel; sha256 = $h; bytes = [long](Get-Item -LiteralPath $p).Length; fileVersion = [string]$v.FileVersion; productVersion = [string]$v.ProductVersion })
        Add-Check 'identity' $rel 'pass' ('sha256 ' + $h.Substring(0, 16) + '... version ' + [string]$v.FileVersion + ' / ' + [string]$v.ProductVersion)
    }
    try { $fails = @(Get-WorkbenchHashFailures $root); if ($fails.Count) { Add-Check 'identity' 'release checksums (SHA256SUMS.txt)' 'fail' (($fails | Select-Object -First 5) -join '; ') } else { Add-Check 'identity' 'release checksums (SHA256SUMS.txt)' 'pass' 'every shipped file matches' } } catch { Add-Check 'identity' 'release checksums (SHA256SUMS.txt)' 'fail' $_.Exception.Message }
    $mw = @($identities | Where-Object { $_['file'] -eq 'native\mwcli.exe' })
    if ($mw.Count) { if ($mw[0]['sha256'] -eq $ExpectedMwcliSha) { Add-Check 'identity' 'EightMax 5.1 binary unchanged' 'pass' $mw[0]['sha256'] } else { Add-Check 'identity' 'EightMax 5.1 binary unchanged' 'fail' ('sha256 ' + $mw[0]['sha256'] + ' differs from ' + $ExpectedMwcliSha) } }
    $b = Run-Logged (Join-Path $root 'native\mwcli.exe') '--build-id' 'mwcli-build-id' 30; $t = (Read-Text $b['out']).Trim()
    if ($t -match $ExpectedBuild) { Add-Check 'identity' 'EightMax 5.1 build id' 'pass' $t } else { Add-Check 'identity' 'EightMax 5.1 build id' 'fail' ('got: ' + $t) }
}

# ---------------- 3. regression tests (no windows) ----------------
$unit = [ordered]@{}
Phase 'unit' {
    $focused = @('tests\tournament-0362m3.test.cjs', 'tests\recovery-0362m3.test.cjs', 'tests\start-desktop-0362m3.test.cjs', 'tests\hand-ledger.test.cjs', 'tests\hand-tracker.test.cjs', 'tests\hand-state.test.cjs', 'tests\lifecycle-0362m2.test.cjs', 'tests\simulator-controls-035.test.cjs', 'tests\execution-adapters.test.cjs', 'tests\executor.test.cjs', 'tests\movement-settings-036.test.cjs', 'tests\simulator-decision-036.test.cjs', 'tests\release-0362m3.test.cjs')
    if ($FullSuite) { $files = @(Get-ChildItem (Join-Path $root 'tests') -Filter '*.test.cjs' | Sort-Object Name | ForEach-Object { 'tests\' + $_.Name }) } else { $files = $focused }
    $unit.mode = $(if ($FullSuite) { 'complete suite' } else { 'Milestone 3 focused set' }); $unit.files = $files.Count
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Add-Check 'unit' 'bundled Node.js present' 'fail' 'runtime\node\node.exe missing'; return }
    $r = Run-Logged $node ('--test --test-reporter=tap --test-concurrency=2 ' + (($files | ForEach-Object { '"' + $_ + '"' }) -join ' ')) 'unit-tests' 3600
    $tap = Read-Text $r['out']; Copy-Item -LiteralPath $r['out'] -Destination (Join-Path $OutDir 'unit-tests.tap') -Force
    $n = { param($k) if ($tap -match ('(?m)^# ' + $k + ' (\d+)')) { [int]$Matches[1] } else { 0 } }
    $unit.tests = & $n 'tests'; $unit.passed = & $n 'pass'; $unit.failed = & $n 'fail'; $unit.skipped = & $n 'skipped'; $unit.exitCode = $r['code']; $unit.seconds = $r['seconds']
    $unit.failedNames = @([regex]::Matches($tap, '(?m)^not ok \d+ - (.+)$') | ForEach-Object { $_.Groups[1].Value })
    if ($r['timedOut']) { Add-Check 'unit' 'regression tests' 'fail' 'timed out' }
    elseif ($unit.failed -eq 0 -and $unit.passed -gt 0 -and $r['code'] -eq 0) { Add-Check 'unit' ('regression tests (' + $unit.mode + ')') 'pass' ([string]$unit.passed + ' passed, 0 failed, ' + [string]$unit.skipped + ' skipped') }
    else { Add-Check 'unit' ('regression tests (' + $unit.mode + ')') 'fail' ([string]$unit.passed + ' passed, ' + [string]$unit.failed + ' failed (exit ' + [string]$r['code'] + '): ' + ($unit.failedNames -join '; ')) }
}

# ---------------- 4. desktop host start: prebuilt, fallback compile, cache ----------------
$hostStart = New-Object Collections.ArrayList
$hostWork = Join-Path $OutDir 'host-start'; [IO.Directory]::CreateDirectory($hostWork) | Out-Null; $cacheRoot = Join-Path $hostWork 'cache'
function Start-ViaLauncher([string]$Name, [string]$Extra) {
    $ready = Join-Path $hostWork ($Name + '-session.json'); $st = Join-Path $hostWork ($Name + '-status.json')
    foreach ($f in @($ready, $st)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } }
    if (@(Port-Owners).Count) { if ((Wait-PortFree 20000) -lt 0) { throw ('port 48713 is still in use before ' + $Name + ': ' + (@(Port-Owners) -join ', ')) } }
    $a = '-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $root 'windows\Start-Desktop.ps1') + '" -Headless -ReadyFile "' + $ready + '" -StatusFile "' + $st + '" ' + $Extra
    $r = Run-Logged 'powershell.exe' $a ('host-' + $Name) 900
    $status = $null; if (Test-Path -LiteralPath $st) { $status = $js.DeserializeObject((Read-Text $st)) }
    if ($r['code'] -ne 0) { throw ('Start-Desktop.ps1 exit ' + $r['code'] + ': ' + ((Read-Text $r['err']).Trim() -split "`n" | Select-Object -Last 3) -join ' | ') }
    if ($Extra -match '-BuildOnly') { return [ordered]@{ status = $status; session = $null; health = $null; launcherSeconds = $r['seconds'] } }
    if (-not (Wait-Until { Test-Path -LiteralPath $ready } 30000)) { throw ('the host did not write its ready file within 30 s (' + $Name + ')') }
    $session = $js.DeserializeObject((Read-Text $ready)); $script:Origin = [string]$session['origin']; $script:Token = [string]$session['token']
    $health = HostCall 'GET' '/api/desktop/health'
    return [ordered]@{ status = $status; session = $session; health = $health; launcherSeconds = $r['seconds'] }
}
function Stop-ViaApi($Info) {
    $hostPid = [int]$Info['session']['processId']; $r = HostCall 'POST' '/api/desktop/shutdown' @{}
    if ($r['status'] -ne 200) { throw ('shutdown refused: HTTP ' + $r['status'] + ' ' + $r['raw']) }
    $exited = Wait-Until { -not (Alive $hostPid) } 20000 200; $free = Wait-PortFree 15000
    $driver = @(Get-Process -Name EightMaxInput -ErrorAction SilentlyContinue | Where-Object { try { $_.StartTime -gt $TestStart } catch { $false } })
    $driverGone = Wait-Until { @(Get-Process -Name EightMaxInput -ErrorAction SilentlyContinue | Where-Object { try { $_.StartTime -gt $TestStart } catch { $false } }).Count -eq 0 } 10000 200
    return [ordered]@{ hostExited = [bool]$exited; portFreeMs = $free; inputDriverGone = [bool]$driverGone; inputDriversSeen = $driver.Count }
}
function Host-Case([string]$Name, [string]$Extra, [scriptblock]$Expect) {
    $rec = [ordered]@{ case = $Name; args = $Extra }
    try {
        $i = Start-ViaLauncher $Name $Extra; $rec.status = $i['status']; $rec.launcherSeconds = $i['launcherSeconds']
        if ($i['health']) { $rec.healthStatus = $i['health']['status']; $rec.appVersion = $(if ($i['health']['json']) { [string]$i['health']['json']['appVersion'] } else { $null }) }
        $why = & $Expect $i
        if ($i['session']) { $s = Stop-ViaApi $i; $rec.shutdown = $s; if (-not $s['hostExited']) { $why += ' host still running after shutdown;' }; if ($s['portFreeMs'] -lt 0) { $why += ' port 48713 not released;' }; if (-not $s['inputDriverGone']) { $why += ' input driver still running;' } }
        if ($why) { Add-Check 'host-start' $Name 'fail' $why } else { Add-Check 'host-start' $Name 'pass' ('path ' + [string]$i['status']['path'] + $(if ($i['status']['invalidCache']) { ', invalid cache: ' + [string]$i['status']['invalidCache'] } else { '' }) + $(if ($rec.shutdown) { '; shutdown ok, port free after ' + [string]$rec.shutdown['portFreeMs'] + ' ms, input driver gone' } else { '' })) }
    } catch { $rec.error = $_.Exception.Message; Add-Check 'host-start' $Name 'fail' $_.Exception.Message }
    [void]$hostStart.Add($rec)
}
Phase 'host-start' {
    if (@(Get-Process -Name EightMaxWorkbench -ErrorAction SilentlyContinue).Count) { Add-Check 'host-start' 'no EightMax host already running' 'fail' 'close the EightMax Workbench (and its dashboard) first, then run this again'; return }
    $okHealth = { param($i) if ($i['health']['status'] -ne 200) { return ' health HTTP ' + $i['health']['status'] + ';' } elseif ([string]$i['health']['json']['appVersion'] -ne $WorkbenchVersion) { return ' appVersion ' + [string]$i['health']['json']['appVersion'] + ';' } else { return '' } }
    Host-Case 'prebuilt host launch' '' { param($i) $w = & $okHealth $i; if ($i['status']['path'] -ne 'prebuilt') { $w += ' path ' + $i['status']['path'] + ' (expected prebuilt);' }; return $w }
    Host-Case 'forced fallback compile with a fresh cache' ('-ForceCompile -CacheRoot "' + $cacheRoot + '"') { param($i) $w = & $okHealth $i; $s = $i['status']; if ($s['path'] -ne 'compiled' -or -not $s['compiled']) { $w += ' path ' + $s['path'] + ' (expected compiled);' }; $src = @($s['sources'] | ForEach-Object { $_['path'] }); if (($src -join ',') -ne 'desktop/DesktopHost.cs,desktop/CaptureService.cs,desktop/InputBroker.cs') { $w += ' sources ' + ($src -join ',') + ';' }; return $w }
    $first = $hostStart[$hostStart.Count - 1]; $cacheDir = $(if ($first['status']) { [string]$first['status']['cacheFolder'] } else { '' }); $cachedExe = Join-Path $cacheDir 'EightMaxWorkbench.exe'; $exeHash1 = $(if (Test-Path -LiteralPath $cachedExe) { Sha $cachedExe } else { '' })
    Host-Case 'repeated start reuses the valid cache' ('-ForceCompile -CacheRoot "' + $cacheRoot + '"') { param($i) $w = & $okHealth $i; $s = $i['status']; if ($s['path'] -ne 'cache' -or -not $s['reusedCache'] -or $s['compiled']) { $w += ' path ' + $s['path'] + ' (expected cache, not compiled);' }; if ([string]$s['exeSha256'] -ne $exeHash1) { $w += ' cached executable changed;' }; return $w }
    if (Test-Path -LiteralPath $cachedExe) { [IO.File]::AppendAllText($cachedExe, 'corrupted by the Milestone 3 test') }
    Host-Case 'invalid cache: corrupted executable is rebuilt' ('-ForceCompile -CacheRoot "' + $cacheRoot + '"') { param($i) $w = & $okHealth $i; $s = $i['status']; if (-not $s['compiled'] -or [string]$s['invalidCache'] -ne 'cached executable does not match its recorded hash') { $w += ' expected recompile after corruption, got path ' + $s['path'] + ' / ' + [string]$s['invalidCache'] + ';' }; return $w }
    $man = Join-Path $cacheDir 'cache-manifest.json'; if (Test-Path -LiteralPath $man) { $m = Read-Text $man; $m2 = $m -replace '"path":"desktop/InputBroker.cs","sha256":"[0-9a-f]{64}"', ('"path":"desktop/InputBroker.cs","sha256":"' + ('0' * 64) + '"'); Write-WorkbenchUtf8 $man $m2 }
    Host-Case 'invalid cache: manifest of other sources is rebuilt' ('-ForceCompile -CacheRoot "' + $cacheRoot + '"') { param($i) $w = & $okHealth $i; $s = $i['status']; if (-not $s['compiled'] -or [string]$s['invalidCache'] -notmatch 'cache manifest') { $w += ' expected recompile after a foreign manifest, got path ' + $s['path'] + ' / ' + [string]$s['invalidCache'] + ';' }; return $w }
    # an executable cached under the Milestone 2 key (two sources only) must never be used
    $m2key = Sha-String ((Get-FileHash -LiteralPath (Join-Path $root 'desktop\DesktopHost.cs') -Algorithm SHA256).Hash + (Get-FileHash -LiteralPath (Join-Path $root 'desktop\CaptureService.cs') -Algorithm SHA256).Hash)
    $oldDir = Join-Path $cacheRoot $m2key; [IO.Directory]::CreateDirectory($oldDir) | Out-Null; $planted = Join-Path $oldDir 'EightMaxWorkbench.exe'; [IO.File]::WriteAllText($planted, 'not an executable: planted under the Milestone 2 cache key'); $plantedHash = Sha $planted
    Host-Case 'an old (Milestone 2) cache key is never reused' ('-ForceCompile -CacheRoot "' + $cacheRoot + '"') { param($i) $w = & $okHealth $i; $s = $i['status']; if ([string]$s['cacheFolder'] -eq $oldDir) { $w += ' used the old cache folder;' }; if ((Sha $planted) -ne $plantedHash) { $w += ' the planted file changed;' }; if ($s['fingerprint'] -eq $m2key) { $w += ' fingerprint equals the M2 key;' }; return $w }
    Host-Case 'build-only compiles or reuses without launching' ('-BuildOnly -CacheRoot "' + $cacheRoot + '"') { param($i) $s = $i['status']; if (-not $s -or @('cache', 'compiled') -notcontains [string]$s['path'] -or $s['launched']) { return ' expected a build-only result without a launch, got ' + (Short $s) + ';' }; return '' }
}

# ---------------- 5-8. real-window acceptance (Node tools) ----------------
$runs = [ordered]@{}
function Run-NodeTool([string]$Key, [string]$Group, [string]$Arguments, [string]$ReportFile, [int]$TimeoutSec) {
    if (@(Port-Owners).Count) { if ((Wait-PortFree 30000) -lt 0) { Add-Check $Group ($Key + ' could start') 'fail' ('port 48713 is in use: ' + (@(Port-Owners) -join ', ')); return $null } }
    $env:EIGHTMAX_TEST_CLI = (Join-Path $root 'native\mwcli.exe')
    $r = Run-Logged $node $Arguments $Key $TimeoutSec
    $doc = $null; if (Test-Path -LiteralPath $ReportFile -PathType Leaf) { try { $doc = $js.DeserializeObject((Read-Text $ReportFile)) } catch {} }
    $runs[$Key] = [ordered]@{ exitCode = $r['code']; timedOut = $r['timedOut']; seconds = $r['seconds']; report = [IO.Path]::GetFileName($ReportFile); overall = $(if ($doc) { [string]$doc['overall'] } else { $null }) }
    if (-not $doc) { $tail = @((Read-Text $r['err']).Trim() -split "`n" | Select-Object -Last 5) -join ' | '; Add-Check $Group ($Key + ' produced a result') 'fail' ('no result file; exit ' + [string]$r['code'] + '; ' + $tail); return $null }
    foreach ($s in @($doc['scenarios'])) {
        $failed = @(); foreach ($c in @($s['checks'])) { if (-not $c['pass']) { $failed += ([string]$c['name'] + ' (' + (Short $c['detail']) + ')') } }
        $st = 'fail'; if ($s['status'] -eq 'pass') { $st = 'pass' }
        $detail = ([string]@($s['checks']).Count + ' checks passed in ' + [string][math]::Round($s['durationMs'] / 1000) + ' s'); if ($failed.Count -gt 0) { $detail = 'failed: ' + ($failed -join '; ') }
        Add-Check $Group ([string]$s['id'] + ': ' + [string]$s['name']) $st $detail
    }
    if ($doc['cleanup']) { if ($doc['cleanup']['ok']) { Add-Check $Group ($Key + ': process cleanup (children exited, no live timers)') 'pass' (Short $doc['cleanup']['activeResources']) } else { Add-Check $Group ($Key + ': process cleanup') 'fail' (Short $doc['cleanup']) } }
    if ($r['timedOut']) { Add-Check $Group ($Key + ' finished in time') 'fail' ('timed out after ' + $TimeoutSec + ' s') }
    elseif (($doc['overall'] -eq 'PASS') -ne ($r['code'] -eq 0)) { Add-Check $Group ($Key + ': exit code matches the result') 'fail' ('overall ' + $doc['overall'] + ', exit ' + $r['code']) }
    else { Add-Check $Group ($Key + ': exit code matches the result') 'pass' ('overall ' + $doc['overall'] + ', exit ' + $r['code']) }
    return $doc
}
if ($SkipAcceptance) { Add-Check 'acceptance' 'real-window acceptance' 'warn' 'skipped (-SkipAcceptance)' } else {
    Phase 'lifecycle' {
        # Milestone 2 scenarios A-K with real windows, under the process-exit audit (the Milestone 2 runner stayed alive for minutes)
        $audit = Join-Path $OutDir 'lifecycle-exit-audit.json'; $work = Join-Path $OutDir 'work-lifecycle'
        $r = Run-Logged $node ('"tools\exit-audit-0362m3.cjs" --runs 1 --max-exit-ms 15000 --out "' + $audit + '" --work "' + $work + '" -- "tools\lifecycle-acceptance-0362m2.cjs" --work "' + (Join-Path $OutDir 'work-m2') + '"') 'lifecycle-acceptance' 3600
        $rep = Join-Path $work 'run-1-report.json'; if (Test-Path -LiteralPath $rep) { Copy-Item -LiteralPath $rep -Destination (Join-Path $OutDir 'lifecycle-acceptance.json') -Force }
        $doc = $null; if (Test-Path -LiteralPath (Join-Path $OutDir 'lifecycle-acceptance.json')) { $doc = $js.DeserializeObject((Read-Text (Join-Path $OutDir 'lifecycle-acceptance.json'))) }
        $groups = [ordered]@{ 'capture lifecycle' = @('A', 'C', 'D', 'E', 'H', 'K'); 'input cancellation' = @('B', 'F', 'I'); 'safety' = @('G'); 'scripted gameplay' = @('J') }
        if ($doc) { foreach ($s in @($doc['scenarios'])) { $failed = @(); foreach ($c in @($s['checks'])) { if (-not $c['pass']) { $failed += ([string]$c['name'] + ' (' + (Short $c['detail']) + ')') } }; $grp = 'lifecycle'; foreach ($g in $groups.Keys) { if ($groups[$g] -contains $s['id']) { $grp = 'lifecycle: ' + $g; break } }; $st = 'fail'; if ($s['status'] -eq 'pass') { $st = 'pass' }; $d = ([string]@($s['checks']).Count + ' checks passed in ' + [string][math]::Round($s['durationMs'] / 1000) + ' s'); if ($failed.Count) { $d = 'failed: ' + ($failed -join '; ') }; Add-Check $grp ([string]$s['id'] + ': ' + [string]$s['name']) $st $d } }
        else { Add-Check 'lifecycle' 'Milestone 2 lifecycle acceptance produced a result' 'fail' ('no result; exit ' + [string]$r['code'] + '; ' + ((Read-Text $r['err']).Trim() -split "`n" | Select-Object -Last 3) -join ' | ') }
        if (Test-Path -LiteralPath $audit) { $a = $js.DeserializeObject((Read-Text $audit)); $run1 = @($a['runs'])[0]; $runs['lifecycle'] = [ordered]@{ overall = $(if ($doc) { [string]$doc['overall'] } else { $null }); reportToExitMs = $run1['reportToExitMs']; exitCode = $run1['exitCode']; exitCodeMatchesVerdict = $run1['exitCodeMatchesVerdict'] }
            if ($run1['reportWritten'] -and $null -ne $run1['reportToExitMs'] -and [int]$run1['reportToExitMs'] -le 15000 -and $run1['exitCodeMatchesVerdict']) { Add-Check 'runner cleanup' 'lifecycle runner exits by itself after its report; exit code matches' 'pass' ('report -> exit ' + [string]$run1['reportToExitMs'] + ' ms, exit ' + [string]$run1['exitCode'] + ', live at report: ' + (Short $run1['activeAtReport']['counts'])) }
            else { Add-Check 'runner cleanup' 'lifecycle runner exits by itself after its report; exit code matches' 'fail' (Short $run1) } }
        else { Add-Check 'runner cleanup' 'exit audit produced a result' 'fail' 'no exit-audit file' }
    }
    Phase 'gameplay' { $f = Join-Path $OutDir 'gameplay-acceptance.json'; $null = Run-NodeTool 'gameplay-acceptance' 'gameplay' ('"tools\gameplay-acceptance-0362m3.cjs" --suite acceptance --out "' + $f + '" --work "' + (Join-Path $OutDir 'work-gameplay') + '"') $f 3600 }
    if ($SkipStability) { Add-Check 'multi-table' 'multi-table stability' 'warn' 'skipped (-SkipStability)' } else {
        Phase 'multi-table' { $f = Join-Path $OutDir 'gameplay-stability.json'; $null = Run-NodeTool 'gameplay-stability' 'multi-table' ('"tools\gameplay-acceptance-0362m3.cjs" --suite stability --tables ' + $StabilityTables + ' --seconds ' + $StabilitySeconds + ' --out "' + $f + '" --work "' + (Join-Path $OutDir 'work-stability') + '"') $f 7200 }
    }
    if ($CampaignHands -gt 0) { Phase 'campaign' { $f = Join-Path $OutDir 'gameplay-campaign.json'; $null = Run-NodeTool 'gameplay-campaign' 'campaign' ('"tools\gameplay-acceptance-0362m3.cjs" --suite campaign --tables 1 --hands ' + $CampaignHands + ' --max-minutes ' + $CampaignMinutes + ' --out "' + $f + '" --work "' + (Join-Path $OutDir 'work-campaign') + '"') $f (($CampaignMinutes + 15) * 60) } }
}

# ---------------- 9. cleanup ----------------
Phase 'cleanup' {
    Start-Sleep -Seconds 3
    $left = @(New-Leftovers @('EightMaxWorkbench', 'EightMaxInput', 'EightMaxTestTable', 'mwcli'))
    if ($left.Count) { Add-Check 'cleanup' 'no leftover processes started by these tests' 'fail' ($left -join ', ') } else { Add-Check 'cleanup' 'no leftover processes started by these tests' 'pass' 'none' }
    if (@(Port-Owners).Count) { Add-Check 'cleanup' 'port 48713 released' 'fail' (@(Port-Owners) -join ', ') } else { Add-Check 'cleanup' 'port 48713 released' 'pass' 'free' }
}

# ---------------- results (never lost: a failure while writing falls back to a minimal record) ----------------
$errorsN = @($script:checks | Where-Object { $_['status'] -eq 'fail' }).Count; $warnN = @($script:checks | Where-Object { $_['status'] -eq 'warn' }).Count; $passN = @($script:checks | Where-Object { $_['status'] -eq 'pass' }).Count
$overall = $(if ($errorsN -eq 0 -and -not $SkipAcceptance) { 'PASS' } elseif ($errorsN -eq 0) { 'PASS (acceptance skipped)' } else { 'FAIL' })
$byGroup = [ordered]@{}; foreach ($c in $script:checks) { if (-not $byGroup.Contains($c['group'])) { $byGroup[$c['group']] = [ordered]@{ pass = 0; fail = 0; warn = 0 } }; $byGroup[$c['group']][$c['status']]++ }
$doc = [ordered]@{ format = 'eightmax-m3-windows-results'; version = 1; app = $WorkbenchVersion; milestone = '0.36.2-milestone-3'; at = [DateTime]::UtcNow.ToString('o'); startedAt = $TestStart.ToUniversalTime().ToString('o'); durationSeconds = [math]::Round(([DateTime]::Now - $TestStart).TotalSeconds); resultsFolder = $OutDir
    environment = $(if ($env:GITHUB_ACTIONS) { 'GitHub Actions Windows runner (real Windows, real windows and input)' } else { 'Windows PC (real windows and input)' })
    machine = $machine; executables = $identities; unitTests = $unit; hostStart = $hostStart; tools = $runs; phasesSeconds = $script:phases
    groups = $byGroup; counts = [ordered]@{ passed = $passN; failed = $errorsN; warnings = $warnN; checks = $script:checks.Count }; overall = $overall; exitCode = $(if ($errorsN -eq 0) { 0 } else { 1 }); checks = $script:checks }
try { Write-WorkbenchUtf8 (Join-Path $OutDir 'milestone3-results.json') ($js.Serialize((ConvertTo-Plain $doc))) }
catch { Write-Host ('Full result record could not be written (' + $_.Exception.Message + '); writing the check list only.'); try { Write-WorkbenchUtf8 (Join-Path $OutDir 'milestone3-results.json') ($js.Serialize((ConvertTo-Plain ([ordered]@{ format = 'eightmax-m3-windows-results'; version = 1; overall = $overall; counts = $doc.counts; checks = $script:checks; writeError = $_.Exception.Message })))) } catch { Write-Host ('Check list could not be written either: ' + $_.Exception.Message) } }
$lines = @('EightMax Test Workbench 0.36.2 - Milestone 3 Windows results', ('Date: ' + [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')), ('Machine: ' + [string]$machine.windows.caption + ' build ' + [string]$machine.windows.build + ' | ' + (@($machine.cpu) -join '; ') + ' | ' + [string]$machine.ramGiB + ' GiB | scaling ' + [string]$machine.displayScalingPercent + '%'), ('Results folder: ' + $OutDir), '')
foreach ($g in $byGroup.Keys) { $lines += ('{0,-28} pass {1,3}  fail {2,3}  warn {3,3}' -f $g, $byGroup[$g]['pass'], $byGroup[$g]['fail'], $byGroup[$g]['warn']) }
$lines += ''; foreach ($c in $script:checks) { $lines += ('[{0}] {1} {2}: {3}' -f $c['group'], ([string]$c['status']).ToUpperInvariant(), $c['name'], $c['detail']) }
$lines += ''; $lines += ('Errors: ' + [string]$errorsN + '   Warnings: ' + [string]$warnN + '   Passed: ' + [string]$passN); $lines += ('OVERALL: ' + $overall)
Write-WorkbenchUtf8 (Join-Path $OutDir 'milestone3-results.txt') (($lines -join "`r`n") + "`r`n")
$zip = $OutDir.TrimEnd('\') + '.zip'
try { if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }; Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $zip -Force; Write-Host ('Results ZIP to send back: ' + $zip) } catch { Write-Host ('Could not create the results ZIP: ' + $_.Exception.Message) }
Write-Host ''; Write-Host ('Errors: ' + [string]$errorsN + '   Warnings: ' + [string]$warnN + '   Passed: ' + [string]$passN); Write-Host ('OVERALL: ' + $overall); Write-Host ('Results folder: ' + $OutDir)
if (-not $env:GITHUB_ACTIONS) { try { Start-Process explorer.exe -ArgumentList ('"' + $OutDir + '"') } catch {} }
if ($errorsN -eq 0) { exit 0 } else { exit 1 }
