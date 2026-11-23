<# EightMax Test Workbench 0.36.2-dev - MILESTONE 2 Windows verification: simulator WINDOW LIFECYCLE, safe recovery, input
   cancellation, emergency-stop priority and the preserved scripted gameplay - on YOUR computer, with real windows.
   Needs nothing installed: it uses the bundled Node.js (runtime\node\node.exe) and the bundled executables.
   What it does (about 10-15 minutes; the mouse moves by itself inside the EightMax test tables - do not touch mouse or keyboard):
     1. machine details (Windows, CPU, RAM, GPU, displays and scaling)
     2. executable identities (SHA-256, versions, release checksums, EightMax 5.1 build id - must be 7d08acc7eb4577ee)
     3. lifecycle unit and regression tests (bundled Node, no windows)
     4. real-window lifecycle acceptance: tools\lifecycle-acceptance-0362m2.cjs (closes, minimises, reopens and resizes test tables)
     5. cleanup check (no leftover EightMax processes, port 48713 free)
   Usage: powershell -NoProfile -ExecutionPolicy Bypass -File windows\Test-Milestone2-0362.ps1 [-OutDir DIR] [-SkipAcceptance] [-Only A,B]
   Results: <OutDir>\milestone2-results.json, milestone2-results.txt, the raw logs, and <OutDir>.zip to send back.
   Exit code 0 only when every required check passed. #>
param([string]$OutDir, [switch]$SkipAcceptance, [string]$Only = '')
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
Add-Type -AssemblyName System.Web.Extensions, System.Windows.Forms
$root = Get-WorkbenchRoot
$TestStart = [DateTime]::Now; $stamp = $TestStart.ToString('yyyyMMdd-HHmmss')
if (-not $OutDir) {
    $OutDir = Join-Path $root ('test-results\Milestone2-' + $stamp)
    try { [IO.Directory]::CreateDirectory($OutDir) | Out-Null; [IO.File]::WriteAllText((Join-Path $OutDir '.write-test'), 'ok'); Remove-Item -LiteralPath (Join-Path $OutDir '.write-test') -Force }
    catch { $OutDir = Join-Path $env:LOCALAPPDATA ('EightMax-Test-Workbench\Milestone2-0.36.2\run-' + $stamp) }
}
[IO.Directory]::CreateDirectory($OutDir) | Out-Null
$js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = [int]::MaxValue; $js.RecursionLimit = 200
$node = Join-Path $root 'runtime\node\node.exe'
$ExpectedBuild = '7d08acc7eb4577ee'; $ExpectedMwcliSha = 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72'
$script:checks = @()
# 0.36.2 M3: check and identity records are ordered dictionaries. As [pscustomobject] they made JavaScriptSerializer fail on Windows
# PowerShell 5.1 ("A circular reference was detected") when the results were written - the crash of GitHub Actions run 45163715758.
function Add-Check([string]$Group, [string]$Name, [string]$Status, [string]$Detail) {
    $script:checks += [ordered]@{ group = $Group; name = $Name; status = $Status; detail = $Detail; at = [DateTime]::UtcNow.ToString('o') }
    Write-Host ('[{0}] {1,-4} {2}: {3}' -f $Group, $Status.ToUpperInvariant(), $Name, $Detail)
}
function Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Run-Logged([string]$Exe, [string]$Arguments, [string]$LogName, [int]$TimeoutSec) {
    # Output goes to files (never pipes), the same pattern the Milestone 1 checks proved on Windows.
    $of = Join-Path $OutDir ($LogName + '.out.txt'); $ef = Join-Path $OutDir ($LogName + '.err.txt')
    $p = Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $root -RedirectStandardOutput $of -RedirectStandardError $ef -WindowStyle Hidden -PassThru; $null = $p.Handle
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { try { $p.Kill() } catch {}; return [pscustomobject]@{ code = -1; timedOut = $true; out = $of; err = $ef } }
    return [pscustomobject]@{ code = $p.ExitCode; timedOut = $false; out = $of; err = $ef }
}
function Sha-String([string]$Text) { $h = [Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$Text))) -replace '-', '').Substring(0, 12).ToLowerInvariant() } finally { $h.Dispose() } }
function Short($Value) { if ($null -eq $Value) { return '' }; $t = $(if ($Value -is [string]) { $Value } else { $js.Serialize($Value) }); if ($t.Length -gt 140) { $t = $t.Substring(0, 140) + '...' }; return $t }
function Read-Text([string]$Path) { for ($i = 0; $i -lt 20; $i++) { try { return [IO.File]::ReadAllText($Path) } catch { Start-Sleep -Milliseconds 100 } }; return '' }
function Port-Busy { return @(Get-NetTCPConnection -LocalPort 48713 -State Listen -ErrorAction SilentlyContinue).Count -gt 0 }

Write-Host ('EightMax 0.36.2 Milestone 2 tests. Results folder: ' + $OutDir)
Write-Host 'The mouse will move by itself inside the EightMax test tables. Do not touch the mouse or keyboard until this finishes.'

# ---------------- 1. machine details ----------------
$machine = [ordered]@{}
try {
    $os = Get-CimInstance Win32_OperatingSystem; $cs = Get-CimInstance Win32_ComputerSystem
    $machine.windows = [ordered]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture }
    $machine.cpu = @(Get-CimInstance Win32_Processor | ForEach-Object { $_.Name.Trim() + ' (' + $_.NumberOfCores + ' cores, ' + $_.NumberOfLogicalProcessors + ' threads)' })
    $machine.ramGiB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    $machine.gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { [ordered]@{ name = $_.Name; driver = $_.DriverVersion; resolution = ([string]$_.CurrentHorizontalResolution + 'x' + [string]$_.CurrentVerticalResolution) } })
    $machine.screens = @([Windows.Forms.Screen]::AllScreens | ForEach-Object { [ordered]@{ device = $_.DeviceName; primary = $_.Primary; boundsAsSeenByThisScript = ([string]$_.Bounds.Width + 'x' + [string]$_.Bounds.Height) } })
    try { $logPix = (Get-ItemProperty -Path 'HKCU:\Control Panel\Desktop\WindowMetrics' -Name AppliedDPI -ErrorAction Stop).AppliedDPI; $machine.appliedDpi = $logPix; $machine.displayScalingPercent = [math]::Round($logPix / 96 * 100) } catch { $machine.displayScalingPercent = 'unknown' }
    try { $machine.dotNetFrameworkRelease = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release -ErrorAction Stop).Release } catch { $machine.dotNetFrameworkRelease = 'unknown' }
    $machine.powershell = $PSVersionTable.PSVersion.ToString(); $machine.computerNameHash = (Sha-String $env:COMPUTERNAME)
    $cpuText = $machine.cpu -join '; '; Add-Check 'machine' 'machine details collected' 'pass' ([string]$machine.windows.caption + ' build ' + [string]$machine.windows.build + '; ' + $cpuText + '; ' + [string]$machine.ramGiB + ' GiB; scaling ' + [string]$machine.displayScalingPercent + '%')
} catch { Add-Check 'machine' 'machine details collected' 'warn' $_.Exception.Message }

# ---------------- 2. executable identities ----------------
$identities = @()
foreach ($rel in @('desktop\bin\EightMaxWorkbench.exe', 'desktop\bin\EightMaxInput.exe', 'desktop\bin\EightMaxTestTable.exe', 'desktop\bin\EightMaxCapture.exe', 'desktop\bin\EightMaxWgc.exe', 'native\mwcli.exe', 'runtime\node\node.exe')) {
    $p = Join-Path $root $rel
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Add-Check 'identity' ($rel + ' present') 'fail' 'missing'; continue }
    $v = (Get-Item -LiteralPath $p).VersionInfo
    $identities += [ordered]@{ file = $rel; sha256 = (Sha $p); bytes = (Get-Item -LiteralPath $p).Length; fileVersion = $v.FileVersion; productVersion = $v.ProductVersion }
}
foreach ($i in $identities) { Add-Check 'identity' ($i.file) 'pass' ('sha256 ' + $i.sha256.Substring(0, 16) + '... version ' + [string]$i.fileVersion + ' / ' + [string]$i.productVersion) }
try { $fails = @(Get-WorkbenchHashFailures $root); if ($fails.Count) { Add-Check 'identity' 'release checksums (SHA256SUMS.txt)' 'fail' (($fails | Select-Object -First 5) -join '; ') } else { Add-Check 'identity' 'release checksums (SHA256SUMS.txt)' 'pass' 'every shipped file matches' } } catch { Add-Check 'identity' 'release checksums (SHA256SUMS.txt)' 'fail' $_.Exception.Message }
$mw = $identities | Where-Object { $_.file -eq 'native\mwcli.exe' }
if ($mw) { if ($mw.sha256 -eq $ExpectedMwcliSha) { Add-Check 'identity' 'EightMax 5.1 binary unchanged' 'pass' $mw.sha256 } else { Add-Check 'identity' 'EightMax 5.1 binary unchanged' 'fail' ('sha256 ' + $mw.sha256 + ' differs from ' + $ExpectedMwcliSha) } }
try { $b = Run-Logged (Join-Path $root 'native\mwcli.exe') '--build-id' 'mwcli-build-id' 30; $t = (Read-Text $b.out).Trim(); if ($t -match $ExpectedBuild) { Add-Check 'identity' 'EightMax 5.1 build id' 'pass' $t } else { Add-Check 'identity' 'EightMax 5.1 build id' 'fail' ('got: ' + $t) } } catch { Add-Check 'identity' 'EightMax 5.1 build id' 'fail' $_.Exception.Message }

# ---------------- 3. lifecycle unit and regression tests (no windows) ----------------
$unitFiles = @('tests\lifecycle-0362m2.test.cjs', 'tests\simulator-controls-035.test.cjs', 'tests\execution-adapters.test.cjs', 'tests\executor.test.cjs', 'tests\movement-settings-036.test.cjs', 'tests\simulator-decision-036.test.cjs')
$unit = [ordered]@{ files = $unitFiles }
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { Add-Check 'unit' 'bundled Node.js present' 'fail' 'runtime\node\node.exe missing' }
else {
    $r = Run-Logged $node ('--test ' + (($unitFiles | ForEach-Object { '"' + $_ + '"' }) -join ' ')) 'unit-tests' 900
    $tap = Read-Text $r.out; Copy-Item -LiteralPath $r.out -Destination (Join-Path $OutDir 'unit-tests.tap') -Force
    $pass = 0; $fail = 0; if ($tap -match '# pass (\d+)') { $pass = [int]$Matches[1] }; if ($tap -match '# fail (\d+)') { $fail = [int]$Matches[1] }
    $unit.passed = $pass; $unit.failed = $fail; $unit.exitCode = $r.code; $unit.failedNames = @([regex]::Matches($tap, '(?m)^not ok \d+ - (.+)$') | ForEach-Object { $_.Groups[1].Value })
    if ($r.timedOut) { Add-Check 'unit' 'lifecycle and regression tests' 'fail' 'timed out after 15 minutes' }
    elseif ($fail -eq 0 -and $pass -gt 0 -and $r.code -eq 0) { Add-Check 'unit' 'lifecycle and regression tests' 'pass' ([string]$pass + ' passed, 0 failed') }
    else { $names = $unit.failedNames -join '; '; Add-Check 'unit' 'lifecycle and regression tests' 'fail' ([string]$pass + ' passed, ' + [string]$fail + ' failed (exit ' + [string]$r.code + '): ' + $names) }
}

# ---------------- 4. real-window lifecycle acceptance ----------------
$acc = $null
$groups = [ordered]@{ 'capture lifecycle' = @('A', 'C', 'D', 'E', 'H', 'K'); 'input cancellation' = @('B', 'F', 'I'); 'safety' = @('G', 'I'); 'scripted gameplay' = @('J') }
if ($SkipAcceptance) { Add-Check 'acceptance' 'real-window lifecycle acceptance' 'warn' 'skipped (-SkipAcceptance)' }
elseif (Port-Busy) { Add-Check 'acceptance' 'real-window lifecycle acceptance' 'fail' 'port 48713 is in use: close the EightMax Workbench (and its dashboard) first, then run this again' }
else {
    $accFile = Join-Path $OutDir 'lifecycle-acceptance.json'; $a = '"tools\lifecycle-acceptance-0362m2.cjs" --out "' + $accFile + '" --work "' + (Join-Path $OutDir 'work') + '"'; if ($Only) { $a += ' --only ' + $Only }
    $env:EIGHTMAX_TEST_CLI = (Join-Path $root 'native\mwcli.exe')
    $r = Run-Logged $node $a 'lifecycle-acceptance' 2400
    if (Test-Path -LiteralPath $accFile -PathType Leaf) {
        $acc = $js.DeserializeObject((Read-Text $accFile))
        foreach ($s in $acc['scenarios']) {
            $failed = @(); foreach ($c in @($s['checks'])) { if (-not $c['pass']) { $failed += ([string]$c['name'] + ' (' + (Short $c['detail']) + ')') } }
            $grp = 'acceptance'; foreach ($g in $groups.Keys) { if ($groups[$g] -contains $s['id']) { $grp = $g; break } }
            $st = 'fail'; if ($s['status'] -eq 'pass') { $st = 'pass' }
            $detail = ([string]@($s['checks']).Count + ' checks passed in ' + [string][math]::Round($s['durationMs'] / 1000) + ' s'); if ($failed.Count -gt 0) { $detail = 'failed: ' + ($failed -join '; ') }
            Add-Check $grp ([string]$s['id'] + ': ' + [string]$s['name']) $st $detail
        }
        if ($r.timedOut) { Add-Check 'acceptance' 'acceptance finished in time' 'fail' 'timed out after 40 minutes' }
    } else { $tail = @((Read-Text $r.err).Trim() -split "`n" | Select-Object -Last 5); $tailText = $tail -join ' | '; Add-Check 'acceptance' 'real-window lifecycle acceptance' 'fail' ('no result file; exit ' + [string]$r.code + '; ' + $tailText) }
}

# ---------------- 5. cleanup ----------------
Start-Sleep -Seconds 3
$left = @(Get-Process -Name EightMaxWorkbench, EightMaxInput, EightMaxTestTable, mwcli -ErrorAction SilentlyContinue | Where-Object { try { $_.StartTime -gt $TestStart } catch { $false } })
if ($left.Count) { Add-Check 'cleanup' 'no leftover processes started by these tests' 'warn' (($left | ForEach-Object { $_.ProcessName + ' pid ' + $_.Id }) -join ', ') } else { Add-Check 'cleanup' 'no leftover processes started by these tests' 'pass' 'none' }
if (Port-Busy) { Add-Check 'cleanup' 'port 48713 released' 'warn' 'still in use' } else { Add-Check 'cleanup' 'port 48713 released' 'pass' 'free' }

# ---------------- results ----------------
$errorsN = @($script:checks | Where-Object { $_.status -eq 'fail' }).Count; $warnN = @($script:checks | Where-Object { $_.status -eq 'warn' }).Count; $passN = @($script:checks | Where-Object { $_.status -eq 'pass' }).Count
$overall = $(if ($errorsN -eq 0 -and -not $SkipAcceptance) { 'PASS' } elseif ($errorsN -eq 0) { 'PASS (acceptance skipped)' } else { 'FAIL' })
$byGroup = [ordered]@{}; foreach ($c in $script:checks) { if (-not $byGroup.Contains($c.group)) { $byGroup[$c.group] = [ordered]@{ pass = 0; fail = 0; warn = 0 } }; $byGroup[$c.group][$c.status]++ }
$doc = [ordered]@{ format = 'eightmax-m2-windows-results'; version = 1; app = '0.36.2-dev'; milestone = '0.36.2-milestone-2'; at = [DateTime]::UtcNow.ToString('o'); resultsFolder = $OutDir
    machine = $machine; executables = $identities; unitTests = $unit; acceptance = $(if ($acc) { [ordered]@{ overall = $acc['overall']; summary = $acc['summary']; host = $acc['host']; file = 'lifecycle-acceptance.json' } } else { $null })
    groups = $byGroup; counts = [ordered]@{ passed = $passN; failed = $errorsN; warnings = $warnN }; overall = $overall; checks = $script:checks }
Write-WorkbenchUtf8 (Join-Path $OutDir 'milestone2-results.json') ($js.Serialize($doc))
$cpuText = ''; $gpuText = ''; try { $cpuText = $machine.cpu -join '; '; $gpuText = @($machine.gpu | ForEach-Object { [string]$_.name + ' ' + [string]$_.resolution }) -join '; ' } catch {}
$lines = @('EightMax Test Workbench 0.36.2 - Milestone 2 Windows results', ('Date: ' + [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss')), ('Machine: ' + [string]$machine.windows.caption + ' build ' + [string]$machine.windows.build + ' | ' + $cpuText + ' | ' + [string]$machine.ramGiB + ' GiB | GPU ' + $gpuText + ' | scaling ' + [string]$machine.displayScalingPercent + '%'), ('Results folder: ' + $OutDir), '')
foreach ($g in $byGroup.Keys) { $lines += ('{0,-20} pass {1,3}  fail {2,3}  warn {3,3}' -f $g, $byGroup[$g].pass, $byGroup[$g].fail, $byGroup[$g].warn) }
$lines += ''; foreach ($c in $script:checks) { $lines += ('[{0}] {1} {2}: {3}' -f $c.group, $c.status.ToUpperInvariant(), $c.name, $c.detail) }
$lines += ''; $lines += ('Errors: ' + [string]$errorsN + '   Warnings: ' + [string]$warnN + '   Passed: ' + [string]$passN); $lines += ('OVERALL: ' + $overall)
Write-WorkbenchUtf8 (Join-Path $OutDir 'milestone2-results.txt') (($lines -join "`r`n") + "`r`n")
$zip = $OutDir.TrimEnd('\') + '.zip'
try { if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }; Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $zip -Force; Write-Host ('Results ZIP to send back: ' + $zip) } catch { Write-Host ('Could not create the results ZIP: ' + $_.Exception.Message) }
Write-Host ''; Write-Host ('Errors: ' + [string]$errorsN + '   Warnings: ' + [string]$warnN + '   Passed: ' + [string]$passN); Write-Host ('OVERALL: ' + $overall); Write-Host ('Results folder: ' + $OutDir)
try { Start-Process explorer.exe -ArgumentList ('"' + $OutDir + '"') } catch {}
if ($errorsN -eq 0) { exit 0 } else { exit 1 }
