<# EightMax Test Workbench 0.36.2 Milestone 3.1 - WINDOWS SCENARIO SUITE for the test runner and its launchers (Windows PowerShell 5.1,
   real Windows desktop; run by .github/workflows/windows-0362-m31.yml on the exact release ZIP after it was extracted into a folder whose
   path has spaces, parentheses and non-ASCII characters). Each scenario starts the real launchers or the runner as the operator would,
   then checks the produced files. Results are written after every scenario (scenarios.json), so this suite cannot lose its own evidence.
     powershell -NoProfile -ExecutionPolicy Bypass -File tests\windows\M31-Scenarios.ps1 -App <extracted folder> -Out <results folder>
        [-M3Zip <Milestone 3 ZIP for the before/after reproductions>] [-Only S01,S05]
   Scenario letters refer to the Milestone 3.1 brief (A clean installation ... O existing results packaging). Never used on a user PC. #>
param([Parameter(Mandatory = $true)][string]$App, [Parameter(Mandatory = $true)][string]$Out, [string]$M3Zip, [string]$Only, [string]$Work)
$ErrorActionPreference = 'Stop'
$App = [IO.Path]::GetFullPath($App); [void][IO.Directory]::CreateDirectory($Out); $Out = [IO.Path]::GetFullPath($Out)
if (-not $Work) { $Work = Join-Path ([IO.Path]::GetTempPath()) 'em-m31-scenario-work' }; [void][IO.Directory]::CreateDirectory($Work); $Work = [IO.Path]::GetFullPath($Work)   # copies and extractions (never published)
$utf8 = New-Object Text.UTF8Encoding($false)
$ps = Join-Path $PSHOME 'powershell.exe'
$node = Join-Path $App 'runtime\node\node.exe'
$results = New-Object Collections.ArrayList
$suiteStart = [DateTime]::UtcNow
$env:EIGHTMAX_NONINTERACTIVE = '1'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem, System.Web.Extensions
$js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = [int]::MaxValue; $js.RecursionLimit = 100

function ConvertTo-PlainValue($v, [int]$depth = 0) {
    if ($null -eq $v) { return $null }
    if ($depth -gt 12) { return [string]$v }
    if ($v -is [string] -or $v -is [bool] -or $v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) { return $v }
    if ($v -is [Collections.IDictionary]) { $o = [ordered]@{}; foreach ($k in @($v.Keys)) { $o[[string]$k] = ConvertTo-PlainValue $v[$k] ($depth + 1) }; return $o }
    if ($v -is [Collections.IEnumerable]) { $a = New-Object Collections.ArrayList; foreach ($x in $v) { [void]$a.Add((ConvertTo-PlainValue $x ($depth + 1))) }; return ,($a.ToArray()) }
    return [string]$v
}
function Save-Results {
    try { Save-ResultsCore } catch {
        $why = $_.Exception.Message; Write-Host ('scenarios.json: full write failed (' + $why + '); facts are stored as JSON text') -ForegroundColor Yellow
        try { foreach ($r in $results) { if ($r.facts -isnot [string]) { try { $r.facts = ConvertTo-Json -InputObject $r.facts -Depth 8 -Compress } catch { $r.facts = [string]$r.facts } } }; Save-ResultsCore } catch { Write-Host ('scenarios.json could not be written: ' + $_.Exception.Message) -ForegroundColor Red }
    }
}
function Save-ResultsCore {
    $doc = [ordered]@{ format = 'eightmax-m31-windows-scenarios'; version = 1; startedAt = $suiteStart.ToString('o'); updatedAt = [DateTime]::UtcNow.ToString('o'); app = $App; powershell = $PSVersionTable.PSVersion.ToString(); os = [Environment]::OSVersion.VersionString
        counts = [ordered]@{ passed = @($results | Where-Object { $_.ok }).Count; failed = @($results | Where-Object { -not $_.ok }).Count; total = $results.Count }; scenarios = $results.ToArray() }
    [IO.File]::WriteAllText((Join-Path $Out 'scenarios.json'), $js.Serialize($doc), $utf8)
}
function Add-Result([string]$Id, [string]$Spec, [string]$Title, [bool]$Ok, [string]$Observed, [string]$Expected, $Facts) {
    [void]$results.Add([ordered]@{ id = $Id; spec = $Spec; title = $Title; ok = $Ok; expected = $Expected; observed = $Observed; facts = (ConvertTo-PlainValue $Facts); at = [DateTime]::UtcNow.ToString('o') })
    Write-Host (('[{0}] {1} {2} - {3}' -f $Id, $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Title, $Observed)) -ForegroundColor $(if ($Ok) { 'Green' } else { 'Red' })
    Save-Results
}
function Test-Scenario([string]$Id, [string]$Spec, [string]$Title, [scriptblock]$Body) {
    if ($Only -and (@($Only -split ',') -notcontains $Id)) { return }
    Write-Host ''; Write-Host ('==== ' + $Id + ' (' + $Spec + '): ' + $Title + '  ' + [DateTime]::Now.ToString('HH:mm:ss')) -ForegroundColor Cyan
    try { & $Body } catch { Add-Result $Id $Spec $Title $false ('harness exception: ' + $_.Exception.Message + ' at line ' + $_.InvocationInfo.ScriptLineNumber) 'scenario completes' $null }
}
function Invoke-Logged([string]$File, [string]$Arguments, [string]$Name, [int]$TimeoutSec = 900, [string]$WorkDir = $App) {
    $o = Join-Path $Out ($Name + '.out.txt'); $e = Join-Path $Out ($Name + '.err.txt')
    $p = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkDir -RedirectStandardOutput $o -RedirectStandardError $e -WindowStyle Hidden -PassThru; $null = $p.Handle
    $sw = [Diagnostics.Stopwatch]::StartNew()
    if (-not $p.WaitForExit($TimeoutSec * 1000)) { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null; return [ordered]@{ code = $null; timedOut = $true; seconds = [int]$sw.Elapsed.TotalSeconds; out = (Get-Content -LiteralPath $o -Raw -ErrorAction SilentlyContinue); err = (Get-Content -LiteralPath $e -Raw -ErrorAction SilentlyContinue); pid = $p.Id } }
    return [ordered]@{ code = $p.ExitCode; timedOut = $false; seconds = [int]$sw.Elapsed.TotalSeconds; out = [string](Get-Content -LiteralPath $o -Raw -ErrorAction SilentlyContinue); err = [string](Get-Content -LiteralPath $e -Raw -ErrorAction SilentlyContinue); pid = $p.Id }
}
function Invoke-Launcher([string]$AppDir, [string]$Cmd, [string]$Arguments, [string]$Name, [int]$TimeoutSec = 900) {
    return (Invoke-Logged (Join-Path $env:SystemRoot 'System32\cmd.exe') ('/d /c ""' + (Join-Path $AppDir $Cmd) + '" ' + $Arguments + '"') $Name $TimeoutSec $AppDir)
}
function Invoke-Runner([string]$AppDir, [string]$Arguments, [string]$Name, [int]$TimeoutSec = 900) {
    return (Invoke-Logged $ps ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $AppDir 'windows\Test-Milestone31.ps1') + '" -NonInteractive ' + $Arguments) $Name $TimeoutSec $AppDir)
}
function Get-OutTail($R, [int]$Lines = 12) { $t = (([string]$R.out) + ([string]$R.err)) -split "`r?`n" | Where-Object { $_.Trim() }; return ((@($t) | Select-Object -Last $Lines) -join ' / ') }
function Get-RunDirs([string]$Root) { if (-not (Test-Path -LiteralPath $Root)) { return @() }; return @(Get-ChildItem -LiteralPath $Root -Directory | Where-Object { $_.Name -like 'Milestone3.1-*' } | Sort-Object LastWriteTime -Descending | ForEach-Object { $_.FullName }) }
function Read-Json([string]$Path) { if (-not (Test-Path -LiteralPath $Path)) { return $null }; return $js.DeserializeObject([IO.File]::ReadAllText($Path)) }
function Get-ZipNames([string]$Zip) { if (-not (Test-Path -LiteralPath $Zip)) { return @() }; $z = [IO.Compression.ZipFile]::OpenRead($Zip); try { return @($z.Entries | ForEach-Object { $_.FullName }) } finally { $z.Dispose() } }
function Test-Report([string]$Dir) {
    $need = @('run-status.json', 'console.log', 'errors.log', 'checks.jsonl', 'operations.jsonl', 'milestone3-results.json', 'milestone3-results.txt', 'milestone3-results.zip', 'transcript.txt')
    $missing = @($need | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Dir $_)) })
    $names = Get-ZipNames (Join-Path $Dir 'milestone3-results.zip')
    $inZip = @('run-status.json', 'checks.jsonl', 'console.log', 'errors.log', 'milestone3-results.txt', 'milestone3-results.json') | Where-Object { $names -notcontains $_ }
    return [ordered]@{ ok = (-not $missing.Count -and -not @($inZip).Count); missing = $missing; notInZip = @($inZip); zipEntries = $names.Count }
}
function Copy-App([string]$Dest) {
    & robocopy.exe $App $Dest /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /XD test-results | Out-Null
    if ($LASTEXITCODE -ge 8) { throw ('robocopy failed with ' + $LASTEXITCODE) }
    $global:LASTEXITCODE = 0
}
function Get-Alive([int[]]$Pids) { return @($Pids | Where-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; $p -and -not $p.HasExited }) }
function Stop-EightMaxLeftovers { foreach ($p in @(Get-Process -Name EightMaxWorkbench, EightMaxInput, EightMaxTestTable -ErrorAction SilentlyContinue)) { try { $p.Kill() } catch {} }; Start-Sleep -Seconds 2 }
function New-LegacyM3Folder([string]$Parent, [string]$Name) {
    # file for file what the operator's Milestone 3 runs left (synthetic content: the operator's own files are not published)
    $d = Join-Path $Parent $Name; [void][IO.Directory]::CreateDirectory((Join-Path $d 'host-start')); [void][IO.Directory]::CreateDirectory((Join-Path $d 'state'))
    foreach ($f in @('mwcli-build-id.err.txt', 'unit-tests.err.txt', 'host-prebuilt host launch.err.txt')) { [IO.File]::WriteAllText((Join-Path $d $f), '') }
    [IO.File]::WriteAllText((Join-Path $d 'mwcli-build-id.out.txt'), "EightMaxBuild=7d08acc7eb4577ee`r`n")
    $tap = "TAP version 13`nnot ok 82 - M3 release: SHA256SUMS.txt lists every shipped file except itself`n1..116`n" + [char]35 + " tests 116`n" + [char]35 + " pass 114`n" + [char]35 + " fail 1`n" + [char]35 + " skipped 1`n"
    [IO.File]::WriteAllText((Join-Path $d 'unit-tests.tap'), $tap); [IO.File]::WriteAllText((Join-Path $d 'unit-tests.out.txt'), $tap)
    return $d
}
$res = Join-Path $Out 'runs'; [void][IO.Directory]::CreateDirectory($res)
$fixture = Join-Path $App 'tests\fixtures\m31\Start-FakeDesktop.ps1'
Stop-EightMaxLeftovers

# ------------------------------------------------------------------------------------------------------------------------------------------
Test-Scenario 'S01' 'A' 'clean installation: RUN-0362-MILESTONE3.1-TESTS.cmd A (quick verification, real desktop host)' {
    $root = Join-Path $res 'S01'
    $r = Invoke-Launcher $App 'RUN-0362-MILESTONE3.1-TESTS.cmd' ('A "' + $root + '"') 'S01-launcher' 900
    $d = @(Get-RunDirs $root)[0]; $doc = $(if ($d) { Read-Json (Join-Path $d 'milestone3-results.json') } else { $null }); $rep = $(if ($d) { Test-Report $d } else { $null })
    $hs = $(if ($doc) { @($doc['phases'] | Where-Object { $_['name'] -eq 'host-start' })[0] } else { $null })
    $ok = ($r.code -eq 0) -and $doc -and @('PASS', 'WARNING') -contains [string]$doc['overall'] -and $rep.ok -and $hs -and $hs['status'] -eq 'PASS' -and $doc['gates']['input-driver']['ok'] -and ($r.out -match 'ZIP to send back:')
    Add-Result 'S01' 'A' 'clean installation: quick verification through the main launcher' $ok ('exit ' + [string]$r.code + ', overall ' + [string]$doc['overall'] + ', host-start ' + [string]$hs['status'] + ', input driver ' + [string]$doc['gates']['input-driver']['ok'] + ', report ' + [string]$rep.ok + ', ' + [string]$r.seconds + ' s' + $(if ($r.code -ne 0) { '; launcher output: ' + (Get-OutTail $r) } else { '' })) 'exit 0, PASS/WARNING, host-start PASS, input driver initialised, complete report and ZIP' ([ordered]@{ dir = $d; counts = $doc['counts']; warnings = @($doc['checks'] | Where-Object { $_['status'] -eq 'WARNING' } | ForEach-Object { [string]$_['name'] + ': ' + [string]$_['detail'] }) })
}
Test-Scenario 'S02' 'D,N' 'standalone diagnostic: RUN-M3-HOST-DIAGNOSTIC-3.1.cmd on its own (every start case, real host)' {
    $root = Join-Path $res 'S02 diag (spaces)'
    $r = Invoke-Launcher $App 'RUN-M3-HOST-DIAGNOSTIC-3.1.cmd' ('"' + $root + '"') 'S02-diagnostic' 1500
    $d = @(Get-RunDirs $root)[0]; $doc = $(if ($d) { Read-Json (Join-Path $d 'milestone3-results.json') } else { $null }); $rep = $(if ($d) { Test-Report $d } else { $null })
    $sum = $(if ($d) { Read-Json (Join-Path $d 'host-start\host-start-summary.json') } else { $null })
    $cases = @($(if ($sum) { $sum['cases'] } else { @() }) | ForEach-Object { [string]$_['id'] + '=' + [string]$_['result'] })
    $ok = ($r.code -eq 0) -and $doc -and $rep.ok -and ($d -match '-host-diagnostic$') -and $cases.Count -eq 7 -and -not @($cases | Where-Object { $_ -notmatch '=PASS$' }).Count
    Add-Result 'S02' 'D,N' 'standalone start-up diagnostic: complete report for every case without the main suite' $ok ('exit ' + [string]$r.code + ', overall ' + [string]$doc['overall'] + ', cases ' + ($cases -join ' ') + ', report ' + [string]$rep.ok + ', ' + [string]$r.seconds + ' s' + $(if ($r.code -ne 0) { '; launcher output: ' + (Get-OutTail $r) } else { '' })) 'exit 0; 7 start cases PASS; own complete report and ZIP; folder ...-host-diagnostic' ([ordered]@{ dir = $d; counts = $doc['counts'] })
}
Test-Scenario 'S03' 'B' 'previous test results inside the application folder: release checks and the M3 release tests still pass' {
    $tr = Join-Path $App 'test-results'
    $null = New-LegacyM3Folder $tr 'Milestone3-20261123-122544'; $null = New-LegacyM3Folder $tr 'Milestone3-20261123-124637'
    [IO.File]::WriteAllText((Join-Path $tr 'Milestone3-20261123-124637\unit-tests.out.txt'), 'partial')
    $u = Invoke-Logged $node '--test --test-reporter=tap tests\release-0362m3.test.cjs tests\release-033.test.cjs tests\release-integrity-0362m31.test.cjs' 'S03-node-release-tests' 900
    $fails = [regex]::Matches([string]$u.out, '(?m)^not ok \d+ - (.+)$') | ForEach-Object { $_.Groups[1].Value }
    $root = Join-Path $res 'S03'
    $r = Invoke-Runner $App ('-Mode Quick -OutRoot "' + $root + '" -Phases environment') 'S03-runner' 600
    $d = @(Get-RunDirs $root)[0]; $ri = $(if ($d) { Read-Json (Join-Path $d 'release-integrity.json') } else { $null })
    $ok = ($u.code -eq 0) -and -not @($fails).Count -and $ri -and $ri['ok'] -and [int]$ri['runtimeOutput']['files'] -ge 12
    Add-Result 'S03' 'B' 'previous results folders do not fail the release checks (Node tests and the runner)' $ok ('node tests exit ' + [string]$u.code + ' (failed: ' + (@($fails) -join '; ') + '); runner integrity ok ' + [string]$ri['ok'] + ', runtime output files ignored ' + [string]$ri['runtimeOutput']['files']) 'Node release tests pass; integrity PASS with the result folders counted as runtime output' ([ordered]@{ dir = $d })
    if ($M3Zip -and (Test-Path -LiteralPath $M3Zip)) {
        # the same folders in the ORIGINAL Milestone 3 release reproduce the operator's failure on Windows
        $m3 = Join-Path $Work 'm3 original (spaces)'; if (-not (Test-Path -LiteralPath $m3)) { [IO.Compression.ZipFile]::ExtractToDirectory($M3Zip, $m3) }
        $m3app = Join-Path $m3 'EightMax-Test-Workbench'; $null = New-LegacyM3Folder (Join-Path $m3app 'test-results') 'Milestone3-20261123-122544'
        $v = Invoke-Logged (Join-Path $m3app 'runtime\node\node.exe') '--test --test-reporter=tap tests\release-0362m3.test.cjs' 'S03-m3-original-release-test' 300 $m3app
        $msg = [regex]::Match([string]$v.out, "error: 'listed in SHA256SUMS\.txt: ([^']+)'").Groups[1].Value
        Add-Result 'S03r' 'B' 'reproduction: the ORIGINAL Milestone 3 release test fails on the same folders (operator failure)' (($v.code -ne 0) -and ($msg -like 'test-results/Milestone3-20261123-122544/*')) ('M3 test exit ' + [string]$v.code + ', message: listed in SHA256SUMS.txt: ' + $msg) 'the Milestone 3 test fails exactly as on the operator PC' $null
    }
}
Test-Scenario 'S04' 'C' 'genuine release corruption: modified executable, planted executable, missing file' {
    $copy = Join-Path $Work ('S04 corrupted copy ' + [char]0x00e9); Copy-App $copy
    $exe = Join-Path $copy 'desktop\bin\EightMaxWorkbench.exe'; $orig = [IO.File]::ReadAllBytes($exe); $b = [byte[]]$orig.Clone(); $b[1000] = [byte]($b[1000] -bxor 0xff); [IO.File]::WriteAllBytes($exe, $b)
    $root = Join-Path $res 'S04'
    $r1 = Invoke-Runner $copy ('-Mode Quick -OutRoot "' + $root + '"') 'S04-modified' 600
    $d1 = @(Get-RunDirs $root)[0]; $doc1 = Read-Json (Join-Path $d1 'milestone3-results.json'); $f1 = @($doc1['failures'] | ForEach-Object { [string]$_['detail'] }) -join ' | '
    $hs1 = @($doc1['phases'] | Where-Object { $_['name'] -eq 'host-start' })[0]
    Add-Result 'S04a' 'C' 'a modified executable is detected; the host is not started from a damaged release' (($r1.code -eq 3) -and ($f1 -match 'desktop/bin/EightMaxWorkbench\.exe differs from its release checksum') -and $hs1['status'] -eq 'SKIPPED') ('exit ' + [string]$r1.code + '; ' + $f1.Substring(0, [math]::Min(220, $f1.Length)) + '; host-start ' + [string]$hs1['status']) 'exit 3 (environment), the file named, host-start SKIPPED' $null
    [IO.File]::WriteAllBytes($exe, $orig)
    [IO.File]::WriteAllBytes((Join-Path $copy 'desktop\bin\helper.exe'), [byte[]](0x4d, 0x5a, 0x90, 0x00))
    $r2 = Invoke-Runner $copy ('-Mode Quick -OutRoot "' + $root + '"') 'S04-planted' 600
    $d2 = @(Get-RunDirs $root)[0]; $doc2 = Read-Json (Join-Path $d2 'milestone3-results.json'); $f2 = @($doc2['failures'] | ForEach-Object { [string]$_['detail'] }) -join ' | '
    Add-Result 'S04b' 'C' 'an unexpected executable inside the protected payload is detected' (($r2.code -eq 3) -and ($f2 -match 'executable or script not in the release manifest: desktop/bin/helper\.exe')) ('exit ' + [string]$r2.code + '; ' + $f2.Substring(0, [math]::Min(220, $f2.Length))) 'exit 3, the planted file named' $null
    Remove-Item -LiteralPath (Join-Path $copy 'desktop\bin\helper.exe') -Force
    Remove-Item -LiteralPath (Join-Path $copy 'runtime\node\node.exe') -Force
    $r3 = Invoke-Runner $copy ('-Mode Quick -OutRoot "' + $root + '"') 'S04-missing' 600
    $d3 = @(Get-RunDirs $root)[0]; $doc3 = Read-Json (Join-Path $d3 'milestone3-results.json'); $f3 = @($doc3['failures'] | ForEach-Object { [string]$_['category'] + ': ' + [string]$_['detail'] }) -join ' | '
    $rep3 = Test-Report $d3
    Add-Result 'S04c' 'C,J' 'a missing manifest-listed file and a missing dependency (node.exe) give a clear environment failure and a full report' (($r3.code -eq 3) -and ($f3 -match 'runtime/node/node\.exe is listed in SHA256SUMS\.txt but missing') -and ($f3 -match 'missing dependency') -and $rep3.ok) ('exit ' + [string]$r3.code + '; report ' + [string]$rep3.ok + '; ' + $f3.Substring(0, [math]::Min(300, $f3.Length))) 'exit 3; missing file and missing dependency named; report and ZIP' $null
    Remove-Item -LiteralPath $copy -Recurse -Force -ErrorAction SilentlyContinue
}
Test-Scenario 'S05' 'E' 'host start fails: the start-up script launches a host that exits with an error' {
    $root = Join-Path $res 'S05'; $env:EIGHTMAX_FAKE_HOST_MODE = 'exit'
    try { $r = Invoke-Runner $App ('-Mode Quick -OutRoot "' + $root + '" -StartScript "' + $fixture + '"') 'S05' 600 } finally { Remove-Item Env:EIGHTMAX_FAKE_HOST_MODE }
    $d = @(Get-RunDirs $root)[0]; $doc = Read-Json (Join-Path $d 'milestone3-results.json'); $rep = Test-Report $d; $f = @($doc['failures'])
    $ok = ($r.code -eq 1) -and $rep.ok -and $f.Count -eq 1 -and ([string]$f[0]['name'] -match '6/12') -and ([string]$f[0]['detail'] -match 'exited( with code 3)? before it was ready; host stderr: The desktop host could not start')
    Add-Result 'S05' 'E' 'host start failure: the step and the host error are named; report and ZIP produced' $ok ('exit ' + [string]$r.code + '; report ' + [string]$rep.ok + '; ' + $(if ($f.Count) { [string]$f[0]['name'] + ': ' + [string]$f[0]['detail'] } else { 'no failure recorded' })) 'exit 1; failure at 6/12 with exit code 3 and the host stderr text' $null
}
Test-Scenario 'S06' 'E,K' 'an EightMax desktop host already running (started outside the test) is reported and left running' {
    $sess = Join-Path $Work 'S06-foreign-host'; [void][IO.Directory]::CreateDirectory($sess); $ready = Join-Path $sess 'session.json'
    $fh = Invoke-Logged $ps ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $App 'windows\Start-Desktop.ps1') + '" -Headless -ReadyFile "' + $ready + '"') 'S06-foreign-start' 120
    $t0 = [Diagnostics.Stopwatch]::StartNew(); while (-not (Test-Path -LiteralPath $ready) -and $t0.Elapsed.TotalSeconds -lt 60) { Start-Sleep -Milliseconds 250 }
    $info = Read-Json $ready; $hostPid = [int]$info['processId']
    $root = Join-Path $res 'S06'
    $r = Invoke-Runner $App ('-Mode Quick -OutRoot "' + $root + '"') 'S06' 600
    $alive = @(Get-Alive @($hostPid)).Count -eq 1
    $d = @(Get-RunDirs $root)[0]; $doc = Read-Json (Join-Path $d 'milestone3-results.json'); $f = @($doc['failures'] | ForEach-Object { [string]$_['category'] + ': ' + [string]$_['detail'] }) -join ' | '
    try { $req = [Net.HttpWebRequest]::Create('http://127.0.0.1:48713/api/desktop/shutdown'); $req.Method = 'POST'; $req.Proxy = $null; $req.Headers.Add('X-EightMax-Session', [string]$info['token']); $req.ContentLength = 0; $req.GetResponse().Close() } catch {}
    Start-Sleep -Seconds 3; Stop-EightMaxLeftovers
    Add-Result 'S06' 'E,K' 'existing EightMax instance: environment failure naming it; it was NOT stopped by the test' (($r.code -eq 3) -and $alive -and ($f -match 'already running') -and ($f -match ('pid ' + $hostPid))) ('exit ' + [string]$r.code + '; foreign host pid ' + $hostPid + ' still alive after the run: ' + $alive + '; ' + $f.Substring(0, [math]::Min(250, $f.Length))) 'exit 3; host named with its pid; still running afterwards' $null
}
Test-Scenario 'S07' 'F' 'host start times out: the start-up script stops responding at its launch step' {
    $root = Join-Path $res 'S07'; $env:EIGHTMAX_FAKE_HOST_MODE = 'script-hang'
    try { $r = Invoke-Runner $App ('-Mode Quick -OutRoot "' + $root + '" -StartScript "' + $fixture + '" -HostLaunchTimeoutSec 20') 'S07' 600 } finally { Remove-Item Env:EIGHTMAX_FAKE_HOST_MODE }
    $d = @(Get-RunDirs $root)[0]; $doc = Read-Json (Join-Path $d 'milestone3-results.json'); $rep = Test-Report $d; $f = @($doc['failures'])
    $hang = Read-Json (Join-Path $d 'host-start\01-prebuilt\hang-diagnostics.json')
    $treePids = @($(if ($hang) { $hang['processTree']['processes'] } else { @() }) | ForEach-Object { [int]$_['pid'] })
    $left = @(Get-Alive $treePids)
    $ok = ($r.code -eq 1) -and $rep.ok -and $f.Count -eq 1 -and [string]$f[0]['category'] -eq 'timeout' -and ([string]$f[0]['detail'] -match 'last recorded step: "launch-host" start') -and $treePids.Count -ge 1 -and $left.Count -eq 0 -and $r.seconds -lt 300
    Add-Result 'S07' 'F' 'start-up time-out: recorded with the step, process tree saved, processes stopped, report produced' $ok ('exit ' + [string]$r.code + ' after ' + [string]$r.seconds + ' s; ' + $(if ($f.Count) { [string]$f[0]['category'] + ': ' + [string]$f[0]['detail'] } else { 'none' }) + '; tree ' + $treePids.Count + ' process(es), alive afterwards ' + $left.Count) 'exit 1 (timeout) within the limit; last step named; tree recorded; nothing left running' $null
}
Test-Scenario 'S08' 'G' 'PowerShell exception inside a phase' {
    $root = Join-Path $res 'S08'
    $r = Invoke-Runner $App ('-Mode Quick -OutRoot "' + $root + '" -InjectFault exception:integrity') 'S08' 600
    $d = @(Get-RunDirs $root)[0]; $doc = Read-Json (Join-Path $d 'milestone3-results.json'); $err = [IO.File]::ReadAllText((Join-Path $d 'errors.log'))
    $hs = @($doc['phases'] | Where-Object { $_['name'] -eq 'host-start' })[0]
    $ok = ($r.code -eq 2) -and ($err -match 'EXCEPTION System\.InvalidOperationException') -and ($err -match 'where: .*M31-Lib\.ps1 line \d+') -and ($err -match 'PowerShell stack:') -and ($err -match 'phase: integrity') -and $hs['status'] -eq 'SKIPPED'
    Add-Result 'S08' 'G' 'an exception keeps type, message, script, line, stack and phase; dependants SKIPPED' $ok ('exit ' + [string]$r.code + '; host-start ' + [string]$hs['status'] + '; errors.log ' + $err.Length + ' characters') 'exit 2; errors.log with type, script line, stack, phase' $null
}
Test-Scenario 'S09' 'H' 'a test fails midway' {
    $root = Join-Path $res 'S09'
    $r = Invoke-Runner $App ('-Mode Quick -OutRoot "' + $root + '" -InjectFault check-fail:dependencies') 'S09' 600
    $d = @(Get-RunDirs $root)[0]; $doc = Read-Json (Join-Path $d 'milestone3-results.json')
    $lines = @([IO.File]::ReadAllLines((Join-Path $d 'checks.jsonl')) | Where-Object { $_.Trim() } | ForEach-Object { $js.DeserializeObject($_) })
    $i = 0; for ($k = 0; $k -lt $lines.Count; $k++) { if ($lines[$k]['status'] -eq 'FAIL') { $i = $k; break } }
    $hs = @($doc['phases'] | Where-Object { $_['name'] -eq 'host-start' })[0]
    Add-Result 'S09' 'H' 'midway failure: earlier checks saved, the failed one identified, the next phase still ran' (($r.code -eq 1) -and $i -gt 5 -and [string]$lines[$i]['phase'] -eq 'dependencies' -and $hs['status'] -eq 'PASS') ('exit ' + [string]$r.code + '; failed check number ' + ($i + 1) + ' of ' + $lines.Count + ' in phase ' + [string]$lines[$i]['phase'] + '; host-start ' + [string]$hs['status']) 'exit 1; checks before the failure on disk; host-start PASS' $null
}
Test-Scenario 'S10' 'I' 'the runner is killed while a start-up step hangs (the operator closed the window)' {
    $root = Join-Path $res 'S10'; [void][IO.Directory]::CreateDirectory($root); $env:EIGHTMAX_FAKE_HOST_MODE = 'script-hang'
    $o = Join-Path $Out 'S10.out.txt'; $e = Join-Path $Out 'S10.err.txt'
    try { $p = Start-Process -FilePath $ps -ArgumentList ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $App 'windows\Test-Milestone31.ps1') + '" -NonInteractive -Mode Quick -OutRoot "' + $root + '" -StartScript "' + $fixture + '" -HostLaunchTimeoutSec 600') -WorkingDirectory $App -RedirectStandardOutput $o -RedirectStandardError $e -WindowStyle Hidden -PassThru } finally { Remove-Item Env:EIGHTMAX_FAKE_HOST_MODE }
    $sw = [Diagnostics.Stopwatch]::StartNew(); $trace = $null; $d = $null
    while ($sw.Elapsed.TotalSeconds -lt 240) { $d = @(Get-RunDirs $root)[0]; if ($d) { $trace = Join-Path $d 'host-start\01-prebuilt\start-trace.jsonl'; if ((Test-Path -LiteralPath $trace) -and ([IO.File]::ReadAllText($trace) -match 'launch-host')) { break } }; Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 2
    $hung = @([IO.File]::ReadAllLines($trace) | ForEach-Object { [int]$js.DeserializeObject($_)['pid'] } | Select-Object -Unique)
    $before = @(Get-Alive $hung).Count
    Stop-Process -Id $p.Id -Force; Start-Sleep -Seconds 4
    $after = @(Get-Alive $hung).Count
    $st = Read-Json (Join-Path $d 'run-status.json')
    $k = Invoke-Launcher $App 'RUN-0362-MILESTONE3.1-TESTS.cmd' ('D "' + $root + '"') 'S10-package' 300
    $doc = Read-Json (Join-Path $d 'milestone3-results.json'); $hs = $(if ($doc) { @($doc['phases'] | Where-Object { $_['name'] -eq 'host-start' })[0] } else { $null })
    $ok = $before -ge 1 -and $after -eq 0 -and [string]$st['state'] -eq 'running' -and [string]$st['currentPhase'] -eq 'host-start' -and $k.code -eq 0 -and $doc -and [string]$doc['overall'] -eq 'INTERRUPTED' -and $hs['status'] -eq 'INTERRUPTED' -and (Test-Path -LiteralPath (Join-Path $d 'milestone3-results.zip'))
    Add-Result 'S10' 'I' 'killed runner: its hung child processes end with it (job object); checkpoint packaged INTERRUPTED by option D' $ok ('hung processes alive before kill ' + $before + ', after ' + $after + '; checkpoint state ' + [string]$st['state'] + '/' + [string]$st['currentPhase'] + '; package exit ' + [string]$k.code + ', overall ' + [string]$doc['overall'] + ', host-start ' + [string]$hs['status'] + $(if ($k.code -ne 0) { '; launcher output: ' + (Get-OutTail $k) } else { '' })) 'no orphaned process; checkpoint state running/host-start; D packages it as INTERRUPTED' $null
}
Test-Scenario 'S11' 'J' 'missing dependency reported by the runner itself (fault injection on an intact release)' {
    $root = Join-Path $res 'S11'
    $r = Invoke-Runner $App ('-Mode Quick -OutRoot "' + $root + '" -InjectFault node-missing') 'S11' 600
    $d = @(Get-RunDirs $root)[0]; $doc = Read-Json (Join-Path $d 'milestone3-results.json'); $f = @($doc['failures'])
    Add-Result 'S11' 'J' 'missing dependency: clear message, environment class, exit 3' (($r.code -eq 3) -and $f.Count -eq 1 -and [string]$f[0]['category'] -eq 'environment' -and ([string]$f[0]['detail'] -match '^missing dependency')) ('exit ' + [string]$r.code + '; ' + $(if ($f.Count) { [string]$f[0]['detail'] } else { 'none' })) 'exit 3; "missing dependency: ..."' $null
}
Test-Scenario 'S12' 'K' 'port 48713 already occupied by another program' {
    $holder = Start-Process -FilePath $ps -ArgumentList '-NoProfile -Command "$l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 48713); $l.Start(); Start-Sleep -Seconds 600"' -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 4
    $root = Join-Path $res 'S12'
    $r = Invoke-Runner $App ('-Mode Quick -OutRoot "' + $root + '"') 'S12' 600
    $alive = @(Get-Alive @($holder.Id)).Count -eq 1
    $d = @(Get-RunDirs $root)[0]; $doc = Read-Json (Join-Path $d 'milestone3-results.json'); $f = @($doc['failures'] | ForEach-Object { [string]$_['category'] + ': ' + [string]$_['detail'] }) -join ' | '
    try { $holder.Kill() } catch {}
    Add-Result 'S12' 'K' 'occupied port: the owner is named (process and pid); the owner is left running; exit 3' (($r.code -eq 3) -and $alive -and ($f -match ('Port 48713 is already occupied by powershell \(pid ' + $holder.Id))) ('exit ' + [string]$r.code + '; owner alive after the run ' + $alive + '; ' + $f.Substring(0, [math]::Min(250, $f.Length))) 'exit 3; "Port 48713 is already occupied by powershell (pid N, LISTEN)"; owner still running' $null
}
Test-Scenario 'S13' 'L' 'repeated runs do not interfere' {
    $root = Join-Path $res 'S13'; $codes = @()
    for ($i = 1; $i -le 3; $i++) { $r = Invoke-Launcher $App 'RUN-0362-MILESTONE3.1-TESTS.cmd' ('A "' + $root + '"') ('S13-run' + $i) 900; $codes += $r.code }
    $dirs = @(Get-RunDirs $root); $zips = @($dirs | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'milestone3-results.zip') })
    Add-Result 'S13' 'L' 'three sequential quick runs: three folders, three reports, all exit 0' ((@($codes | Where-Object { $_ -ne 0 }).Count -eq 0) -and $dirs.Count -eq 3 -and $zips.Count -eq 3) ('exit codes ' + ($codes -join ',') + '; folders ' + $dirs.Count + '; ZIPs ' + $zips.Count + $(if (@($codes | Where-Object { $_ -ne 0 }).Count) { '; last launcher output: ' + (Get-OutTail $r) } else { '' })) '0,0,0; 3 folders; 3 ZIPs' $null
}
Test-Scenario 'S14' 'M' 'long paths and names with spaces in a results folder are packaged' {
    $root = Join-Path $res 'S14'; [void][IO.Directory]::CreateDirectory($root)
    $run = Join-Path $root 'Milestone3.1-20261124-010101-quick'; [void][IO.Directory]::CreateDirectory($run)
    [IO.File]::WriteAllText((Join-Path $run 'run-status.json'), '{"format":"eightmax-m31-run-status","version":1,"runId":"longpath","mode":"Quick","state":"running","runner":{"pid":1,"processStartTime":"2000-01-01T00:00:00Z"},"phases":[{"name":"environment","status":"RUNNING","startedAt":"2026-11-24T01:01:01Z"}]}')
    [IO.File]::WriteAllText((Join-Path $run 'checks.jsonl'), '')
    $deep = $run; while ($deep.Length -lt 230) { $deep = Join-Path $deep 'a folder with spaces' }
    $long = $deep + '\a file name with spaces and more characters.txt'
    $created = $true; try { [void][IO.Directory]::CreateDirectory($deep); [IO.File]::WriteAllText($long, 'long path') } catch { try { [void][IO.Directory]::CreateDirectory('\\?\' + $deep); [IO.File]::WriteAllText('\\?\' + $long, 'long path') } catch { $created = $false } }
    $k = Invoke-Runner $App ('-Mode Package -OutRoot "' + $root + '" -PackageRun "' + $run + '"') 'S14' 300
    $names = Get-ZipNames (Join-Path $run 'milestone3-results.zip')
    $inZip = @($names | Where-Object { $_ -like '*a file name with spaces*' }).Count -eq 1
    $listed = ($names -contains 'zip-skipped-files.txt')
    try { & cmd.exe /d /c ('rd /s /q "\\?\' + (Join-Path $run 'a folder with spaces') + '"') 2>&1 | Out-Null } catch {}
    Add-Result 'S14' 'M' ('long path (' + $long.Length + ' characters) and spaces: the ZIP is created; the file is included or listed as skipped') (($k.code -eq 0) -and ($inZip -or $listed -or -not $created)) ('package exit ' + [string]$k.code + '; long file created ' + $created + ' (' + $long.Length + ' chars); in ZIP ' + $inZip + '; skipped list ' + $listed + '; entries ' + $names.Count) 'exit 0; ZIP exists; the long-path file is in it or named in zip-skipped-files.txt' $null
}
Test-Scenario 'S15' 'O' 'an incomplete Milestone 3 run (operator layout) with a log still open in another process is packaged without running tests' {
    $tr = Join-Path $App 'test-results'; $legacy = New-LegacyM3Folder $tr ('Milestone3-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
    $locked = Join-Path $legacy 'host-prebuilt host launch.out.txt'
    $fs = New-Object IO.FileStream($locked, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, ([IO.FileShare]::Read -bor [IO.FileShare]::Write))   # as Start-Process -RedirectStandardOutput holds it
    try {
        $b = [Text.Encoding]::ASCII.GetBytes('output of a start-up script that never finished'); $fs.Write($b, 0, $b.Length); $fs.Flush()
        $k = Invoke-Launcher $App 'RUN-0362-MILESTONE3.1-TESTS.cmd' ('D "' + (Join-Path $res 'S15') + '"') 'S15-package' 300
    } finally { $fs.Dispose() }
    $zip = @(Get-ChildItem -LiteralPath $legacy -Filter 'milestone3-results*.zip' | Sort-Object LastWriteTime -Descending)[0]
    $names = $(if ($zip) { Get-ZipNames $zip.FullName } else { @() })
    $ok = ($k.code -eq 0) -and ($names -contains 'host-prebuilt host launch.out.txt') -and ($names -contains 'milestone3-recovery.txt') -and ($names -contains 'unit-tests.tap')
    Add-Result 'S15' 'O' 'existing incomplete run packaged (D): the log another process holds open is included' $ok ('package exit ' + [string]$k.code + '; ZIP ' + $(if ($zip) { $zip.Name } else { 'none' }) + ' with ' + $names.Count + ' entries; locked log included ' + ($names -contains 'host-prebuilt host launch.out.txt') + $(if ($k.code -ne 0) { '; launcher output: ' + (Get-OutTail $k) } else { '' })) 'exit 0; ZIP includes the open log and the recovery summary' $null
}
Test-Scenario 'S16' 'launcher' 'launcher failures always leave a diagnostic file and a ZIP' {
    $lone = Join-Path $Work 'S16 lone launcher'; [void][IO.Directory]::CreateDirectory($lone); Copy-Item -LiteralPath (Join-Path $App 'RUN-M3-HOST-DIAGNOSTIC-3.1.cmd') -Destination $lone
    $root = Join-Path $res 'S16a'; $r = Invoke-Launcher $lone 'RUN-M3-HOST-DIAGNOSTIC-3.1.cmd' ('"' + $root + '"') 'S16a' 120
    $fail = @(Get-ChildItem -LiteralPath (Join-Path $root '_launcher') -Filter 'launcher-failure-*.txt' -ErrorAction SilentlyContinue)
    $txt = $(if ($fail.Count) { [IO.File]::ReadAllText($fail[0].FullName) } else { '' })
    Add-Result 'S16a' 'launcher' 'launcher outside the application folder: exit 5, missing files named, diagnostic file and ZIP' (($r.code -eq 5) -and ($txt -match 'files are missing: windows\\Test-Milestone31\.ps1') -and (Test-Path -LiteralPath ($fail[0].FullName + '.zip'))) ('exit ' + [string]$r.code + '; failure file ' + $fail.Count + '; ' + ($txt -split "`n" | Select-Object -First 3) -join ' / ') 'exit 5; launcher-failure-*.txt (+ .zip) naming the missing files' $null
    $inzip = Join-Path $Work 'S16 Temp1_EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip\EightMax-Test-Workbench'; [void][IO.Directory]::CreateDirectory($inzip); Copy-Item -LiteralPath (Join-Path $App 'RUN-0362-MILESTONE3.1-TESTS.cmd') -Destination $inzip
    $root = Join-Path $res 'S16b'; $r = Invoke-Launcher $inzip 'RUN-0362-MILESTONE3.1-TESTS.cmd' ('A "' + $root + '"') 'S16b' 120
    Add-Result 'S16b' 'launcher' 'launcher started from inside a ZIP: the message says to extract first; exit 5' (($r.code -eq 5) -and ($r.out -match 'started from inside the ZIP')) ('exit ' + [string]$r.code + '; message found ' + ($r.out -match 'started from inside the ZIP')) 'exit 5; "This file was started from inside the ZIP ..."' $null
    $copy = Join-Path $Work 'S16 broken runner'; Copy-App $copy
    Add-Content -LiteralPath (Join-Path $copy 'windows\Test-Milestone31.ps1') -Value 'function Broken {' -Encoding ASCII
    $root = Join-Path $res 'S16c'; $r = Invoke-Launcher $copy 'RUN-M3-HOST-DIAGNOSTIC-3.1.cmd' ('"' + $root + '"') 'S16c' 300
    $fail = @(Get-ChildItem -LiteralPath (Join-Path $root '_launcher') -Filter 'launcher-failure-*.txt' -ErrorAction SilentlyContinue); $txt = $(if ($fail.Count) { [IO.File]::ReadAllText($fail[0].FullName) } else { '' })
    Add-Result 'S16c' 'launcher' 'the runner cannot run in PowerShell (script damaged): exit 5, the PowerShell error text saved' (($r.code -eq 5) -and ($txt -match 'PowerShell error output') -and ($txt -match 'Missing closing|ParseException|ParserError|missing the terminator|Missing')) ('exit ' + [string]$r.code + '; failure file ' + $fail.Count + '; PowerShell text saved ' + ($txt -match 'PowerShell error output')) 'exit 5; the parse error of PowerShell in the failure file' $null
    Remove-Item -LiteralPath $copy -Recurse -Force -ErrorAction SilentlyContinue
}
Test-Scenario 'S17' 'host-start root cause' 'downloaded files (Mark of the Web): the Milestone 3 start path versus Milestone 3.1' {
    $zone = "[ZoneTransfer]`r`nZoneId=3`r`nHostUrl=https://github.com/`r`n"
    . (Join-Path $App 'windows\M31-Lib.ps1'); $null = Initialize-M31Helper
    function Save-Screen([string]$Png) { try { Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $b = [Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object Drawing.Bitmap($b.Width, $b.Height); $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose(); $bmp.Save($Png, [Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); return $true } catch { return $false } }
    function Invoke-M3Start([string]$M3App, [string]$Case, [int]$Seconds) {
        # exactly the Milestone 3 runner's call (Run-Logged: hidden PowerShell, output to files), bounded here
        [void][IO.Directory]::CreateDirectory($Case)
        $ready = Join-Path $Case 'prebuilt host launch-session.json'; $st = Join-Path $Case 'prebuilt host launch-status.json'
        $o = Join-Path $Case 'host-prebuilt host launch.out.txt'; $e = Join-Path $Case 'host-prebuilt host launch.err.txt'
        $before = @(Get-Process | ForEach-Object { $_.Id })
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $M3App 'windows\Start-Desktop.ps1') + '" -Headless -ReadyFile "' + $ready + '" -StatusFile "' + $st + '" ') -WorkingDirectory $M3App -RedirectStandardOutput $o -RedirectStandardError $e -WindowStyle Hidden -PassThru; $null = $p.Handle
        $sw = [Diagnostics.Stopwatch]::StartNew(); $exited = $p.WaitForExit($Seconds * 1000); $secs = [math]::Round($sw.Elapsed.TotalSeconds, 1)
        if ($exited) { $w2 = [Diagnostics.Stopwatch]::StartNew(); while (-not (Test-Path -LiteralPath $ready) -and $w2.Elapsed.TotalSeconds -lt 30) { Start-Sleep -Milliseconds 250 } }   # the M3 runner also waited 30 s for the host's ready file
        $f = [ordered]@{ startDesktopExited = $exited; seconds = $secs; exitCode = $(if ($exited) { $p.ExitCode } else { $null }); readyWritten = (Test-Path -LiteralPath $ready); status = $(if (Test-Path -LiteralPath $st) { [IO.File]::ReadAllText($st) } else { $null }); stderr = [string](Get-Content -LiteralPath $e -Raw -ErrorAction SilentlyContinue) }
        if (-not $exited) {
            $tree = @($p.Id) + @(Get-M31Descendants @($p.Id))
            $wins = New-Object Collections.ArrayList
            foreach ($w in [EightMaxM31.Win]::Windows()) { if ($tree -contains [int]$w[1] -and ($w[4] -or $w[3] -eq ([string][char]35 + '32770'))) { [void]$wins.Add(([string]$w[3] + ' | ' + [string]$w[4] + ' | visible ' + [string]$w[2] + ' | pid ' + [string]$w[1])) } }
            $f.windowsOfTheHungScript = $wins.ToArray()
            $f.newProcesses = @(Get-Process | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.ProcessName + ' ' + $_.Id })
            $f.finding = Get-M31SecurityPromptFinding @(Get-M31Windows ([int[]]$tree))
            $f.screenshot = $(if (Save-Screen (Join-Path $Out 'S17-desktop-during-the-stop.png')) { 'S17-desktop-during-the-stop.png' } else { $null })
            & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null
        }
        Stop-EightMaxLeftovers
        return $f
    }
    if ($M3Zip -and (Test-Path -LiteralPath $M3Zip)) {
        $m3c = Join-Path $Work 'm3 control (spaces)'; if (Test-Path -LiteralPath $m3c) { Remove-Item -LiteralPath $m3c -Recurse -Force }
        [IO.Compression.ZipFile]::ExtractToDirectory($M3Zip, $m3c)
        $c = Invoke-M3Start (Join-Path $m3c 'EightMax-Test-Workbench') (Join-Path $Work 'S17-m3-control') 60
        Add-Result 'S17c' 'host-start root cause' 'control: the Milestone 3 start-up script on the SAME files WITHOUT the download mark' ([bool]$c.startDesktopExited -and [bool]$c.readyWritten) ('Start-Desktop.ps1 finished: ' + [string]$c.startDesktopExited + ' after ' + [string]$c.seconds + ' s, exit ' + [string]$c.exitCode + ', host ready ' + [string]$c.readyWritten) 'finishes in seconds and the host becomes ready' $c
        $m3 = Join-Path $Work 'm3 motw (spaces)'; if (Test-Path -LiteralPath $m3) { Remove-Item -LiteralPath $m3 -Recurse -Force }
        [IO.Compression.ZipFile]::ExtractToDirectory($M3Zip, $m3); $m3app = Join-Path $m3 'EightMax-Test-Workbench'
        foreach ($f in @(Get-ChildItem -LiteralPath $m3app -Recurse -File)) { Set-Content -LiteralPath $f.FullName -Stream Zone.Identifier -Value $zone }
        $m = Invoke-M3Start $m3app (Join-Path $Work 'S17-m3-motw') 120
        Add-Result 'S17a' 'host-start root cause' 'reproduction: the Milestone 3 start-up script on files marked as downloaded (the operator condition)' (-not $m.startDesktopExited) ($(if ($m.startDesktopExited) { 'Start-Desktop.ps1 finished after ' + [string]$m.seconds + ' s (no reproduction)' } else { 'Start-Desktop.ps1 did NOT finish within 120 s - the operator symptom; windows of the stopped script: ' + (@($m.windowsOfTheHungScript) -join ' ; ') + '; finding: ' + [string]$m.finding + '; new processes: ' + (@($m.newProcesses) -join ', ') })) 'does not finish (the operator symptom), while the unmarked control does' $m
    }
    $copy = Join-Path $Work ('S17 m31 motw ' + [char]0x00fc); Copy-App $copy
    foreach ($f in @(Get-ChildItem -LiteralPath $copy -Recurse -File)) { Set-Content -LiteralPath $f.FullName -Stream Zone.Identifier -Value $zone }
    $root = Join-Path $res 'S17b'
    $r = Invoke-Runner $copy ('-Mode Quick -OutRoot "' + $root + '"') 'S17b' 600
    $d = @(Get-RunDirs $root)[0]; $doc = Read-Json (Join-Path $d 'milestone3-results.json')
    $motw = @($doc['checks'] | Where-Object { [string]$_['name'] -like 'files marked as downloaded*' })[0]
    $hs = @($doc['phases'] | Where-Object { $_['name'] -eq 'host-start' })[0]
    Add-Result 'S17b' 'host-start root cause' 'Milestone 3.1 on the same marked files: the host starts (CreateProcess) and the mark is reported' (($r.code -eq 0) -and $hs['status'] -eq 'PASS' -and [string]$motw['status'] -eq 'WARNING') ('exit ' + [string]$r.code + '; host-start ' + [string]$hs['status'] + '; ' + [string]$motw['status'] + ' ' + [string]$motw['detail']) 'exit 0; host-start PASS; Mark of the Web WARNING' $null
    Remove-Item -LiteralPath $copy -Recurse -Force -ErrorAction SilentlyContinue
}
Test-Scenario 'S18' 'cancel' 'the run is cancelled with Ctrl+C while a start-up step is running' {
    $root = Join-Path $res 'S18'; [void][IO.Directory]::CreateDirectory($root); $env:EIGHTMAX_FAKE_HOST_MODE = 'script-hang'
    $o = Join-Path $Out 'S18.out.txt'; $e = Join-Path $Out 'S18.err.txt'
    try { $p = Start-Process -FilePath $ps -ArgumentList ('-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $App 'windows\Test-Milestone31.ps1') + '" -NonInteractive -Mode Quick -OutRoot "' + $root + '" -StartScript "' + $fixture + '" -HostLaunchTimeoutSec 600') -WorkingDirectory $App -RedirectStandardOutput $o -RedirectStandardError $e -WindowStyle Hidden -PassThru; $null = $p.Handle } finally { Remove-Item Env:EIGHTMAX_FAKE_HOST_MODE }
    $sw = [Diagnostics.Stopwatch]::StartNew(); $d = $null; $trace = $null
    while ($sw.Elapsed.TotalSeconds -lt 240) { $d = @(Get-RunDirs $root)[0]; if ($d) { $trace = Join-Path $d 'host-start\01-prebuilt\start-trace.jsonl'; if ((Test-Path -LiteralPath $trace) -and ([IO.File]::ReadAllText($trace) -match 'launch-host')) { break } }; Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 2
    $hung = @([IO.File]::ReadAllLines($trace) | ForEach-Object { [int]$js.DeserializeObject($_)['pid'] } | Select-Object -Unique)
    # a real console Ctrl+C: a helper attaches to the runner's (hidden) console and raises CTRL_C_EVENT there
    $helper = 'Add-Type -TypeDefinition ''using System; using System.Runtime.InteropServices; public static class EmCtrlC { [DllImport("kernel32.dll")] static extern bool FreeConsole(); [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint p); [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(IntPtr h, bool a); [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint e, uint g); public static string Send(uint p) { FreeConsole(); if (!AttachConsole(p)) return "attach failed " + Marshal.GetLastWin32Error(); SetConsoleCtrlHandler(IntPtr.Zero, true); bool ok = GenerateConsoleCtrlEvent(0, 0); System.Threading.Thread.Sleep(1000); FreeConsole(); return ok ? "sent" : "generate failed " + Marshal.GetLastWin32Error(); } }''; [IO.File]::WriteAllText($env:EM_CTRLC_OUT, [EmCtrlC]::Send([uint32]$env:EM_CTRLC_PID))'
    $env:EM_CTRLC_PID = [string]$p.Id; $env:EM_CTRLC_OUT = Join-Path $Out 'S18-ctrlc.txt'
    try { $h = Start-Process -FilePath $ps -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($helper))) -WindowStyle Hidden -PassThru; $null = $h.WaitForExit(60000) } finally { Remove-Item Env:EM_CTRLC_PID, Env:EM_CTRLC_OUT }
    $sent = [string](Get-Content -LiteralPath (Join-Path $Out 'S18-ctrlc.txt') -Raw -ErrorAction SilentlyContinue)
    $exited = $p.WaitForExit(120000)
    if (-not $exited) { & taskkill.exe /T /F /PID $p.Id 2>&1 | Out-Null }
    Start-Sleep -Seconds 2
    $left = @(Get-Alive $hung).Count
    $st = Read-Json (Join-Path $d 'run-status.json'); $doc = Read-Json (Join-Path $d 'milestone3-results.json')
    $hs = $(if ($doc) { @($doc['phases'] | Where-Object { $_['name'] -eq 'host-start' })[0] } else { $null }); $cl = $(if ($doc) { @($doc['phases'] | Where-Object { $_['name'] -eq 'cleanup' })[0] } else { $null })
    $ok = ($sent.Trim() -eq 'sent') -and $exited -and $p.ExitCode -eq 4 -and [string]$st['state'] -eq 'interrupted' -and $doc -and [string]$doc['overall'] -eq 'INTERRUPTED' -and $hs['status'] -eq 'INTERRUPTED' -and $cl['status'] -eq 'NOT RUN' -and (Test-Path -LiteralPath (Join-Path $d 'milestone3-results.zip')) -and $left -eq 0
    Add-Result 'S18' 'cancel' 'Ctrl+C: the run ends by itself with an INTERRUPTED report and ZIP; its child processes are stopped' $ok ('Ctrl+C ' + $sent.Trim() + '; runner exited ' + $exited + ' (code ' + $(if ($exited) { [string]$p.ExitCode } else { '-' }) + '); state ' + [string]$st['state'] + '; overall ' + [string]$doc['overall'] + '; host-start ' + [string]$hs['status'] + ', cleanup ' + [string]$cl['status'] + '; hung processes left ' + $left) 'exit 4; state interrupted, overall INTERRUPTED, report + ZIP, nothing left running' $null
}
Test-Scenario 'S19' 'M' 'default results folder for a Windows user whose folder name has spaces and non-ASCII characters' {
    # RUN-0362-MILESTONE3.1-TESTS.cmd A without a results folder: %LOCALAPPDATA%\EightMax-Test-Workbench\TestResults, here under a user
    # folder such as C:\Users\Jose Mueller (accented) - the launcher, the runner and the ZIP must handle it
    $lad = Join-Path $res ('Users\Jos' + [char]0x00e9 + ' M' + [char]0x00fc + 'ller (x)\AppData\Local'); [void][IO.Directory]::CreateDirectory($lad)
    $old = $env:LOCALAPPDATA; $env:LOCALAPPDATA = $lad
    try { $r = Invoke-Launcher $App 'RUN-0362-MILESTONE3.1-TESTS.cmd' 'A' 'S19-launcher' 900 } finally { $env:LOCALAPPDATA = $old }
    $root = Join-Path $lad 'EightMax-Test-Workbench\TestResults'
    $d = @(Get-RunDirs $root)[0]; $doc = $(if ($d) { Read-Json (Join-Path $d 'milestone3-results.json') } else { $null }); $rep = $(if ($d) { Test-Report $d } else { $null })
    $ok = ($r.code -eq 0) -and $doc -and @('PASS', 'WARNING') -contains [string]$doc['overall'] -and $rep.ok -and ($r.out -match 'ZIP to send back:')
    Add-Result 'S19' 'M' 'default results folder under a user folder with spaces and non-ASCII characters (%LOCALAPPDATA%)' $ok ('exit ' + [string]$r.code + ', run folder ' + $(if ($d) { 'found under %LOCALAPPDATA%\EightMax-Test-Workbench\TestResults' } else { 'NOT found' }) + ', overall ' + [string]$doc['overall'] + ', report ' + [string]$rep.ok + ', ' + [string]$r.seconds + ' s' + $(if (-not $ok) { '; launcher output: ' + (Get-OutTail $r 8) } else { '' })) 'exit 0, report and ZIP in the default folder' ([ordered]@{ exitCode = $r.code; runFolder = $d; report = $rep })
}
Stop-EightMaxLeftovers
Save-Results
$failed = @($results | Where-Object { -not $_.ok }).Count
Write-Host ''; Write-Host ('SCENARIOS: ' + ($results.Count - $failed) + ' passed, ' + $failed + ' failed (' + $results.Count + ')') -ForegroundColor $(if ($failed) { 'Red' } else { 'Green' })
if ($failed) { exit 1 } else { exit 0 }
