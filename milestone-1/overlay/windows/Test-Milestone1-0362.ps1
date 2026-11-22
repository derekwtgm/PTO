<# EightMax Test Workbench 0.36.2-dev - MILESTONE 1 focused Windows verification.
   Scope: the rebuilt executables exist, are x64, carry version 0.36.2.0, match the build evidence and their sources,
   start, initialise, talk to each other through their EXISTING interfaces, and shut down cleanly.
   It does NOT test poker strategy, tournaments, multi-table capacity or the dashboard gameplay flow.
   Non-intrusive by default: no clicks or key presses are sent. -WithInputSelfTest additionally runs the driver's own
   self-test (moves the visible cursor inside its own test window; do not touch the mouse for ~20 s).
   Usage: powershell -NoProfile -ExecutionPolicy Bypass -File windows\Test-Milestone1-0362.ps1 [-OutDir DIR] [-WithInputSelfTest]
   Exit code 0 only when every required check passed. Results: <OutDir>\milestone1-results.json and .txt #>
param([string]$OutDir, [switch]$WithInputSelfTest)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Common.ps1')
Add-Type -AssemblyName System.Web.Extensions, System.Drawing, System.Windows.Forms
$root = Get-WorkbenchRoot
if (-not $OutDir) { $OutDir = Join-Path $env:LOCALAPPDATA ('EightMax-Test-Workbench\Milestone1-0.36.2\run-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss')) }
[IO.Directory]::CreateDirectory($OutDir) | Out-Null
$ExpectedFileVersion = '0.36.2.0'; $ExpectedAppVersion = '0.36.2-dev'; $ExpectedBuild = '7d08acc7eb4577ee'
$Primary = @('EightMaxWorkbench.exe', 'EightMaxInput.exe', 'EightMaxTestTable.exe')
$js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = [int]::MaxValue; $js.RecursionLimit = 200
$checks = New-Object Collections.Generic.List[object]
$started = New-Object Collections.Generic.List[object]   # every process this script started (name, pid, role)
$facts = [ordered]@{}
function Add-Check([string]$Group, [string]$Name, [bool]$Passed, [string]$Detail, [bool]$Required = $true) {
    $checks.Add([ordered]@{ group = $Group; name = $Name; status = $(if ($Passed) { 'pass' } elseif ($Required) { 'fail' } else { 'warn' }); required = $Required; detail = $Detail; at = [DateTime]::UtcNow.ToString('o') })
    Write-Host ('[{0}] {1,-4} {2}: {3}' -f $Group, $(if ($Passed) { 'PASS' } elseif ($Required) { 'FAIL' } else { 'WARN' }), $Name, $Detail)
}
function Check([string]$Group, [string]$Name, [scriptblock]$Body, [bool]$Required = $true) {
    try { $d = & $Body; Add-Check $Group $Name $true ([string]$d) $Required } catch { Add-Check $Group $Name $false ($_.Exception.Message) $Required }
}
function Sha([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Bin([string]$Name) { Join-Path $root ('desktop\bin\' + $Name) }
function Track($Process, [string]$Role) { $started.Add([ordered]@{ role = $Role; name = $Process.ProcessName; pid = $Process.Id }) }
function Wait-Until([scriptblock]$Condition, [int]$Ms, [int]$Step = 100) { $w = [Diagnostics.Stopwatch]::StartNew(); while ($w.ElapsedMilliseconds -lt $Ms) { if (& $Condition) { return $true }; Start-Sleep -Milliseconds $Step }; return [bool](& $Condition) }
function Alive([int]$ProcessId) { try { $p = [Diagnostics.Process]::GetProcessById($ProcessId); return -not $p.HasExited } catch { return $false } }
function Screenshot([string]$Name) {
    try { $b = [Windows.Forms.SystemInformation]::VirtualScreen; $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height; $g = [Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size); $f = Join-Path $OutDir $Name; $bmp.Save($f, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose(); return $f } catch { return $null }
}
# Run a console program, capture stdout/stderr, enforce a timeout (works for GUI-subsystem executables too).
function Run-Exe([string]$Exe, [string]$Arguments, [int]$TimeoutMs = 30000) {
    $psi = New-Object Diagnostics.ProcessStartInfo($Exe, $Arguments); $psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
    $p = [Diagnostics.Process]::Start($psi); $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
    if (-not $p.WaitForExit($TimeoutMs)) { try { $p.Kill() } catch {}; throw ('Timed out after ' + $TimeoutMs + ' ms: ' + $Exe + ' ' + $Arguments) }
    $p.WaitForExit(); return [pscustomobject]@{ code = $p.ExitCode; out = $o.Result.Trim(); err = $e.Result.Trim() }
}
# PE header: PE32+ (0x20B) and AMD64 machine (0x8664); CLR header present for managed assemblies.
function Get-PeInfo([string]$Path) {
    $b = [IO.File]::ReadAllBytes($Path); if ($b[0] -ne 0x4D -or $b[1] -ne 0x5A) { throw 'not an MZ executable' }
    $pe = [BitConverter]::ToInt32($b, 0x3C); if ([BitConverter]::ToUInt32($b, $pe) -ne 0x4550) { throw 'PE signature missing' }
    $machine = [BitConverter]::ToUInt16($b, $pe + 4); $opt = $pe + 24; $magic = [BitConverter]::ToUInt16($b, $opt); $subsystem = [BitConverter]::ToUInt16($b, $opt + 68)
    $clr = $(if ($magic -eq 0x20B) { [BitConverter]::ToUInt32($b, $opt + 112 + 14 * 8) } else { [BitConverter]::ToUInt32($b, $opt + 96 + 14 * 8) })
    return [pscustomobject]@{ machine = ('0x{0:X4}' -f $machine); magic = ('0x{0:X3}' -f $magic); subsystem = $(switch ($subsystem) { 2 { 'gui' } 3 { 'console' } default { [string]$subsystem } }); managed = ($clr -ne 0) }
}
# ---- desktop host HTTP client (session-token header, no proxy, no Expect: 100-continue) ----
$script:Origin = $null; $script:Token = $null
function HostCall([string]$Method, [string]$Path, $Body = $null, [int]$TimeoutSec = 30) {
    $req = [Net.HttpWebRequest]::Create($script:Origin + $Path); $req.Method = $Method; $req.Proxy = $null; $req.Timeout = $TimeoutSec * 1000; $req.ReadWriteTimeout = $TimeoutSec * 1000; $req.KeepAlive = $false
    $req.ServicePoint.Expect100Continue = $false; if ($script:Token) { $req.Headers.Add('X-EightMax-Session', $script:Token) }
    if ($null -ne $Body) { $text = $(if ($Body -is [string]) { $Body } else { $js.Serialize($Body) }); $bytes = [Text.Encoding]::UTF8.GetBytes($text); $req.ContentType = 'application/json'; $req.ContentLength = $bytes.Length; $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close() }
    $resp = $null
    try { $resp = $req.GetResponse() } catch { $we = $_.Exception; while ($we -and -not ($we -is [Net.WebException])) { $we = $we.InnerException }; if ($we -and $we.Response) { $resp = $we.Response } else { throw } }
    $sr = New-Object IO.StreamReader($resp.GetResponseStream(), [Text.Encoding]::UTF8); $raw = $sr.ReadToEnd(); $sr.Close(); $status = [int]$resp.StatusCode; $resp.Close()
    $parsed = $null; try { $parsed = $js.DeserializeObject($raw) } catch {}
    return [pscustomobject]@{ status = $status; raw = $raw; json = $parsed }
}
function Driver([string]$Cmd, $Extra = @{}) { $m = @{ cmd = $Cmd }; foreach ($k in $Extra.Keys) { $m[$k] = $Extra[$k] }; $r = HostCall 'POST' '/api/input/command' $m; if ($r.status -ne 200) { throw ('HTTP ' + $r.status + ' for driver ' + $Cmd + ': ' + $r.raw) }; if (-not $r.json -or $r.json['ok'] -ne $true) { throw ('driver refused ' + $Cmd + ': ' + $r.raw) }; return $r.json }
function Start-HostProcess([bool]$Headless, [string]$Ready) {
    if (Test-Path -LiteralPath $Ready) { Remove-Item -LiteralPath $Ready -Force }
    $a = '--root ' + (Quote-WorkbenchPath $root) + ' --ready ' + (Quote-WorkbenchPath $Ready) + $(if ($Headless) { ' --headless' } else { '' })
    $psi = New-Object Diagnostics.ProcessStartInfo((Bin 'EightMaxWorkbench.exe'), $a); $psi.UseShellExecute = $false; $psi.WorkingDirectory = $root
    $watch = [Diagnostics.Stopwatch]::StartNew(); $p = [Diagnostics.Process]::Start($psi); Track $p $(if ($Headless) { 'desktop host (headless)' } else { 'desktop host (window)' })
    if (-not (Wait-Until { (Test-Path -LiteralPath $Ready) -or $p.HasExited } 30000)) { throw 'host did not write its ready file within 30 s' }
    if ($p.HasExited) { $log = Join-Path $env:LOCALAPPDATA 'EightMax-Test-Workbench\Logs\desktop-host.log'; $tail = $(if (Test-Path $log) { (Get-Content $log -Tail 3) -join ' | ' } else { 'no host log' }); throw ('host exited during startup with code ' + $p.ExitCode + '; ' + $tail) }
    $session = $js.DeserializeObject([IO.File]::ReadAllText($Ready)); $script:Origin = [string]$session['origin']; $script:Token = [string]$session['token']
    return [pscustomobject]@{ process = $p; session = $session; ms = $watch.ElapsedMilliseconds }
}
function Stop-HostByApi($HostProcess) {
    $r = HostCall 'POST' '/api/desktop/shutdown' @{}; if ($r.status -ne 200 -or $r.json['stopping'] -ne $true) { throw ('shutdown refused: HTTP ' + $r.status + ' ' + $r.raw) }
    $w = [Diagnostics.Stopwatch]::StartNew(); if (-not $HostProcess.WaitForExit(20000)) { throw 'host still running 20 s after authenticated shutdown' }
    return $w.ElapsedMilliseconds
}
function Driver-Pid($StatusJson) { $id = $null; foreach ($e in @($StatusJson['events'])) { if ($e['event'] -eq 'driver-started' -and ([string]$e['detail']) -match 'pid (\d+)') { $id = [int]$Matches[1] } }; return $id }
function Our-Leftovers { @($started | Where-Object { Alive $_.pid } | ForEach-Object { $_.role + ' pid ' + $_.pid }) }
function Name-Leftovers([string[]]$Names, $Before) { @(Get-Process -Name $Names -ErrorAction SilentlyContinue | Where-Object { $Before -notcontains $_.Id } | ForEach-Object { $_.ProcessName + ' pid ' + $_.Id }) }

$watchedNames = @('EightMaxWorkbench', 'EightMaxInput', 'EightMaxTestTable', 'EightMaxCapture', 'EightMaxWgc', 'mwcli')
$preexisting = @(Get-Process -Name $watchedNames -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$facts.machine = $env:COMPUTERNAME; $facts.os = (Get-CimInstance Win32_OperatingSystem | ForEach-Object { $_.Caption + ' ' + $_.Version + ' build ' + $_.BuildNumber })
$facts.powershell = $PSVersionTable.PSVersion.ToString(); $facts.is64BitProcess = [Environment]::Is64BitProcess; $facts.ciRun = $env:GITHUB_RUN_ID
try { $facts.netFrameworkRelease = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -Name Release).Release } catch { $facts.netFrameworkRelease = $null }
$b = [Windows.Forms.SystemInformation]::VirtualScreen; $facts.virtualScreen = ('{0}x{1} at {2},{3}' -f $b.Width, $b.Height, $b.X, $b.Y); $facts.interactiveDesktop = [Environment]::UserInteractive
if ($preexisting.Count) { Write-Warning ('EightMax processes were already running before this test: ' + ($preexisting -join ', ')) }

try {
    # ===== 10. Executable and dependency integrity =====
    Check 'integrity' 'Release checksum manifest' { $f = @(Get-WorkbenchHashFailures $root); if ($f.Count) { throw (($f | Select-Object -First 5) -join '; ') }; ([IO.File]::ReadAllLines((Join-Path $root 'SHA256SUMS.txt')).Count.ToString() + ' files match SHA256SUMS.txt') }
    $evidence = $null
    Check 'integrity' 'Build evidence present for this application version' { $script:evidence = $js.DeserializeObject([IO.File]::ReadAllText((Join-Path $root 'evidence\build-evidence.json'))); if ($script:evidence['appVersion'] -ne $ExpectedAppVersion) { throw ('build-evidence.json is for ' + $script:evidence['appVersion']) }; ('built ' + $script:evidence['builtAt'] + ' on ' + $script:evidence['buildHost'] + '; CI run ' + $script:evidence['ci']['runId']) }
    $facts.executables = [ordered]@{}
    foreach ($exe in @($Primary + 'EightMaxCapture.exe')) {
        $path = Bin $exe; $rel = 'desktop/bin/' + $exe; $isPrimary = $Primary -contains $exe
        Check 'integrity' ($exe + ': exists, x64 PE32+ managed') { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'missing' }; $pe = Get-PeInfo $path; if ($pe.machine -ne '0x8664' -or $pe.magic -ne '0x20B' -or -not $pe.managed) { throw ('machine ' + $pe.machine + ', magic ' + $pe.magic + ', managed ' + $pe.managed) }; $an = [Reflection.AssemblyName]::GetAssemblyName($path); if ([string]$an.ProcessorArchitecture -ne 'Amd64') { throw ('assembly architecture ' + $an.ProcessorArchitecture) }; ('AMD64 PE32+ ' + $pe.subsystem + ' .NET assembly, ProcessorArchitecture=' + $an.ProcessorArchitecture + ', ' + (Get-Item $path).Length + ' bytes') }
        $vi = (Get-Item -LiteralPath $path).VersionInfo; $h = Sha $path
        $facts.executables[$rel] = [ordered]@{ sha256 = $h; fileVersion = $vi.FileVersion; productVersion = $vi.ProductVersion; assemblyVersion = ([Reflection.AssemblyName]::GetAssemblyName($path)).Version.ToString(); bytes = (Get-Item $path).Length }
        if ($isPrimary) {
            Check 'version' ($exe + ': file/assembly version 0.36.2.0') { $av = ([Reflection.AssemblyName]::GetAssemblyName($path)).Version.ToString(); if ($vi.FileVersion -ne $ExpectedFileVersion -or $av -ne $ExpectedFileVersion -or $vi.ProductVersion -ne $ExpectedAppVersion) { throw ('FileVersion ' + $vi.FileVersion + ', AssemblyVersion ' + $av + ', ProductVersion ' + $vi.ProductVersion) }; ('FileVersion ' + $vi.FileVersion + ', AssemblyVersion ' + $av + ', ProductVersion ' + $vi.ProductVersion) }
        } else {
            Check 'version' ($exe + ': carried source version 0.35.0 (source unchanged)') { if ($vi.FileVersion -ne '0.35.0.0') { throw ('FileVersion ' + $vi.FileVersion) }; ('FileVersion ' + $vi.FileVersion) }
        }
        Check 'integrity' ($exe + ': SHA-256 and sources match build evidence') {
            $o = $script:evidence['outputs'][$rel]; if (-not $o) { throw 'no build-evidence entry' }; if ($o['sha256'] -ne $h) { throw ('file ' + $h + ' but evidence ' + $o['sha256']) }
            $bad = @(); foreach ($k in $o['sourceHashes'].Keys) { if ((Sha (Join-Path $root $k)) -ne $o['sourceHashes'][$k]) { $bad += $k } }; if ($bad.Count) { throw ('source changed since build: ' + ($bad -join ', ')) }
            ('sha256 ' + $h + '; compiled from ' + (@($o['sourceHashes'].Keys) -join ', ') + ' (hashes match)')
        }
        Check 'integrity' ($exe + ': referenced assemblies resolve') {
            $asm = [Reflection.Assembly]::ReflectionOnlyLoadFrom($path); $refs = @($asm.GetReferencedAssemblies()); $missing = @()
            foreach ($r in $refs) { try { $null = [Reflection.Assembly]::ReflectionOnlyLoad($r.FullName) } catch { $missing += $r.FullName } }
            if ($missing.Count) { throw ('unresolved: ' + ($missing -join '; ')) }; ('all ' + $refs.Count + ' references resolve from the .NET Framework: ' + (@($refs | ForEach-Object { $_.Name }) -join ', '))
        }
    }
    Check 'integrity' '.NET Framework 4.8+ runtime present' { if (-not $facts.netFrameworkRelease -or [int]$facts.netFrameworkRelease -lt 528040) { throw ('NDP v4 Release ' + $facts.netFrameworkRelease) }; ('NDP v4 Full Release ' + $facts.netFrameworkRelease) }
    Check 'integrity' 'Bundled Node runtime' { $r = Run-Exe (Join-Path $root 'runtime\node\node.exe') '--version' 15000; if ($r.code -ne 0 -or $r.out -ne 'v22.23.5') { throw ('exit ' + $r.code + ' ' + $r.out) }; $facts.nodeSha256 = Sha (Join-Path $root 'runtime\node\node.exe'); ('runtime\node\node.exe ' + $r.out + ', sha256 ' + $facts.nodeSha256) }
    Check 'integrity' 'Bundled WGC capture helper (carried over)' { $p = Bin 'EightMaxWgc.exe'; $r = Run-Exe $p '--version' 30000; if ($r.code -ne 0 -or $r.out -notmatch '"version":"0\.35\.0"') { throw ('exit ' + $r.code + ' ' + $r.out + ' ' + $r.err) }; $facts.wgcSha256 = Sha $p; ($r.out + ' sha256 ' + $facts.wgcSha256) } $false

    # ===== 4. Native EightMax 5.1 detection =====
    Check 'native' 'EightMax 5.1 binary preserved byte-for-byte' { $h = Sha (Join-Path $root 'native\mwcli.exe'); if ($h -ne $ExpectedEightMaxHash) { throw ('sha256 ' + $h) }; ('native\mwcli.exe sha256 ' + $h) }
    Check 'native' 'EightMax 5.1 build identity' { $r = Run-Exe (Join-Path $root 'native\mwcli.exe') '--build-id' 30000; if ($r.code -ne 0 -or $r.out -ne ('EightMaxBuild=' + $ExpectedBuild)) { throw ('exit ' + $r.code + ': ' + $r.out + ' ' + $r.err) }; $r.out }

    # ===== 9. Version reporting from the executables themselves =====
    Check 'version' 'EightMaxInput.exe --version' { $r = Run-Exe (Bin 'EightMaxInput.exe') '--version' 15000; if ($r.code -ne 0 -or $r.out -notmatch ('^EightMaxInput ' + [regex]::Escape($ExpectedAppVersion) + ' ')) { throw ('exit ' + $r.code + ': ' + $r.out) }; $r.out }
    Check 'version' 'EightMaxTestTable.exe --version' { $r = Run-Exe (Bin 'EightMaxTestTable.exe') '--version' 15000; if ($r.code -ne 0 -or $r.out -notmatch ('^EightMaxTestTable ' + [regex]::Escape($ExpectedAppVersion) + ' ')) { throw ('exit ' + $r.code + ': ' + $r.out) }; $r.out }

    # ===== 1. Desktop host startup (headless) + 4b native detection by the host =====
    $hostRun = $null
    Check 'host' 'Desktop host starts (headless) and writes its private session' {
        $script:hostRun = Start-HostProcess $true (Join-Path $OutDir 'host-headless-session.json')
        $s = $script:hostRun.session; if ($s['format'] -ne 'eightmax-desktop-session' -or $s['appVersion'] -ne $ExpectedAppVersion -or $s['token'] -notmatch '^[0-9a-f]{64}$') { throw ('unexpected session ' + $js.Serialize(@{ format = $s['format']; appVersion = $s['appVersion'] })) }
        ('pid ' + $script:hostRun.process.Id + ' ready in ' + $script:hostRun.ms + ' ms at ' + $s['origin'] + ', appVersion ' + $s['appVersion'])
    }
    if ($hostRun) {
        $health = $null
        Check 'host' 'Health endpoint reports 0.36.2-dev and EightMax build' { $r = HostCall 'GET' '/api/desktop/health'; if ($r.status -ne 200) { throw ('HTTP ' + $r.status + ' ' + $r.raw) }; $script:health = $r.json; if ($r.json['appVersion'] -ne $ExpectedAppVersion -or $r.json['build'] -ne $ExpectedBuild -or $r.json['nativeCPU'] -ne $true -or $r.json['inputDriver'] -ne $true -or $r.json['simulatorControls'] -ne $true) { throw $r.raw.Substring(0, [Math]::Min(600, $r.raw.Length)) }; [IO.File]::WriteAllText((Join-Path $OutDir 'host-health.json'), $r.raw); ('appVersion ' + $r.json['appVersion'] + ', build ' + $r.json['build'] + ', nativeCPU, inputDriver installed, capture methods ' + (@($r.json['captureMethods']) -join '/')) }
        Check 'host' 'Session token is enforced' { $t = $script:Token; $script:Token = $null; try { $r = HostCall 'GET' '/api/desktop/health' } finally { $script:Token = $t }; if ($r.status -ne 403) { throw ('expected 403 without token, got ' + $r.status) }; 'request without X-EightMax-Session refused with HTTP 403' }
        Check 'native' 'Host verified the EightMax 5.1 binary at startup' { 'the host constructor refuses to start unless native\mwcli.exe has SHA-256 ' + $ExpectedEightMaxHash + '; it started and reports build ' + $script:health['build'] }

        # ===== 2. Input driver startup through the host's input broker; 5. capability reporting; 6. host <-> driver =====
        $status = $null; $driverPid = $null
        Check 'input' 'Input driver starts and accepts the host session' { $h = Driver 'health'; $r = HostCall 'GET' '/api/input/status'; $script:status = $r.json; if ($r.status -ne 200 -or $r.json['running'] -ne $true -or $r.json['crashed'] -ne $false) { throw $r.raw }; $script:driverPid = Driver-Pid $r.json; if (-not $script:driverPid) { throw 'no driver-started event' }; [IO.File]::WriteAllText((Join-Path $OutDir 'input-status.json'), $r.raw); $started.Add([ordered]@{ role = 'input driver (host child)'; name = 'EightMaxInput'; pid = $script:driverPid }); ('EightMaxInput.exe pid ' + $script:driverPid + ' started by the host, hello/token accepted, starts=' + $r.json['starts']) }
        if ($status) {
            $d = $status['driver']; $caps = $d['capabilities']
            Check 'input' 'Driver reports version 0.36.2-dev on win32 SendInput' { if ($d['driver'] -ne $ExpectedAppVersion -or $d['platform'] -ne 'win32' -or $caps['sendInput'] -ne $true) { throw ('driver ' + $d['driver'] + ', platform ' + $d['platform'] + ', sendInput ' + $caps['sendInput']) }; ('driver ' + $d['driver'] + ', platform ' + $d['platform'] + ', estop=' + $d['estop'] + ', armed=' + $d['armed']) }
            Check 'capabilities' '0.36.1 motion capabilities (dashboard gate)' { if ($caps['signedCurves'] -ne $true -or $caps['maxDeviationPx'] -ne $true) { throw ('signedCurves ' + $caps['signedCurves'] + ', maxDeviationPx ' + $caps['maxDeviationPx']) }; 'signedCurves=true, maxDeviationPx=true (required by src/simulator-controls-ui.js and tools/simulator-benchmark-035.cjs)' }
            Check 'capabilities' 'Operation list complete' { $need = @('cursor', 'monitors', 'list-windows', 'window-info', 'exe-identity', 'register-target', 'unregister-target', 'focus', 'move', 'move-click', 'click', 'double-click', 'mouse-down', 'mouse-up', 'key', 'type', 'clear-field', 'read-text', 'enter-text', 'uia-controls', 'wait'); $have = @($caps['operations']); $miss = @($need | Where-Object { $have -notcontains $_ }); if ($miss.Count) { throw ('missing ' + ($miss -join ', ')) }; ($have.Count.ToString() + ' operations') }
            Check 'capabilities' 'Click guard, DPI awareness, UI Automation' { $g = $caps['singleClickGuardMaxMs']; if (-not ($g -is [int] -and $g -gt 0) -or $caps['dpiAwareness'] -ne 'per-monitor-v2' -or $caps['uiAutomation'] -ne $true) { throw ('guard ' + $g + ', dpi ' + $caps['dpiAwareness'] + ', uia ' + $caps['uiAutomation']) }; ('singleClickGuardMaxMs ' + $g + ', dpiAwareness ' + $caps['dpiAwareness'] + ', uiAutomation true, maxQueue ' + $caps['maxQueue'] + ', rawInputOverride ' + $caps['rawInputOverride']) }
            Check 'capabilities' 'Emergency-stop hotkey registered' { if ($caps['hotkeyRegistered'] -ne $true) { throw ('hotkey ' + $caps['hotkey'] + ' registered=' + $caps['hotkeyRegistered']) }; ('hotkey ' + $caps['hotkey'] + ' registered') }
            Check 'ipc' 'Host -> driver queries (cursor, monitors)' { $c = Driver 'cursor'; $m = Driver 'monitors'; $mons = @($m['monitors']); if ($mons.Count -lt 1) { throw 'no monitors reported' }; ('cursor at ' + $c['x'] + ',' + $c['y'] + '; ' + $mons.Count + ' monitor(s), first ' + $js.Serialize($mons[0]['bounds']) + ' dpiScale ' + $mons[0]['dpiScale']) }
        }

        # ===== 3. Test table startup (dealer stdio protocol); 7. desktop host <-> simulator =====
        $tt = $null; $ready = $null; $describe = $null
        Check 'testtable' 'Test table opens a window and reports ready' {
            $psi = New-Object Diagnostics.ProcessStartInfo((Bin 'EightMaxTestTable.exe'), '--table 1 --x 60 --y 60 --width 960 --title "EightMax M1 Test Table 01"'); $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
            $script:tt = [Diagnostics.Process]::Start($psi); Track $script:tt 'test table'; $script:ttErr = $script:tt.StandardError.ReadToEndAsync()
            $line = $script:tt.StandardOutput.ReadLineAsync(); if (-not $line.Wait(20000)) { throw 'no ready event within 20 s' }
            $script:ready = $js.DeserializeObject($line.Result); if ($script:ready['type'] -ne 'ready') { throw ('first event ' + $line.Result) }
            if (-not (Wait-Until { $script:tt.Refresh(); $script:tt.MainWindowHandle -ne [IntPtr]::Zero } 10000)) { throw 'no main window handle' }
            ('pid ' + $script:tt.Id + ', hwnd ' + $script:ready['hwnd'] + ', title "' + $script:tt.MainWindowTitle + '"')
        }
        function TT-Send($Obj) { $script:tt.StandardInput.WriteLine($js.Serialize($Obj)); $script:tt.StandardInput.Flush() }
        function TT-Read([string]$Type, [int]$Ms = 10000) { $w = [Diagnostics.Stopwatch]::StartNew(); while ($w.ElapsedMilliseconds -lt $Ms) { $t = $script:tt.StandardOutput.ReadLineAsync(); if (-not $t.Wait([Math]::Max(1, $Ms - [int]$w.ElapsedMilliseconds))) { break }; if ($null -eq $t.Result) { throw 'test table closed its output' }; $m = $js.DeserializeObject($t.Result); if ($m['type'] -eq $Type) { return $m } }; throw ('no ' + $Type + ' event within ' + $Ms + ' ms') }
        if ($ready) {
            Check 'testtable' 'Test table answers describe over its dealer protocol' { TT-Send @{ type = 'describe' }; $script:describe = TT-Read 'describe'; $c = $script:describe['client']; $names = @($script:describe['controls'].Keys); if ($names.Count -lt 2) { throw ('controls: ' + $js.Serialize($script:describe['controls'])) }; ('client ' + $js.Serialize($c) + '; controls ' + ($names -join ', ')) }
            $frameSent = $null
            Check 'testtable' 'Test table renders a frame sent by the dealer protocol' {
                $c = $script:describe['client']; $w = [int]$c['w']; $h = [int]$c['h']
                $bmp = New-Object Drawing.Bitmap $w, $h; $g = [Drawing.Graphics]::FromImage($bmp)
                $g.FillRectangle((New-Object Drawing.Drawing2D.LinearGradientBrush((New-Object Drawing.Rectangle 0, 0, $w, $h), [Drawing.Color]::FromArgb(10, 90, 40), [Drawing.Color]::FromArgb(30, 160, 80), 45.0)), 0, 0, $w, $h)
                $g.FillEllipse((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(200, 40, 40))), [int]($w * 0.40), [int]($h * 0.10), [int]($w * 0.20), [int]($h * 0.20))
                $g.DrawString('EightMax 0.36.2 Milestone 1 frame', (New-Object Drawing.Font 'Segoe UI', 18), [Drawing.Brushes]::White, 20, 20); $g.Dispose()
                $ms = New-Object IO.MemoryStream; $bmp.Save($ms, [Drawing.Imaging.ImageFormat]::Png); $script:frameSent = $bmp
                TT-Send @{ type = 'frame'; rev = 1; png = [Convert]::ToBase64String($ms.ToArray()); legal = @{ fold = $true; call = $true }; title = ' - M1 frame' }
                $shown = TT-Read 'shown'; if ([int]$shown['rev'] -ne 1) { throw ('shown rev ' + $shown['rev']) }; ('frame rev 1 ' + $w + 'x' + $h + ' shown')
            }
            $hwnd = [string]$ready['hwnd']
            Check 'ipc' 'Host capture lists the test table window' { $r = HostCall 'GET' '/api/capture/windows'; if ($r.status -ne 200) { throw ('HTTP ' + $r.status) }; $rows = @($r.json['windows']); if (-not $rows.Count) { $rows = @($r.json) }; $hit = @($rows | Where-Object { $_['pid'] -eq $script:tt.Id }); if (-not $hit.Count) { throw ('test table pid ' + $script:tt.Id + ' not among ' + $rows.Count + ' windows') }; ('found "' + $hit[0]['title'] + '" hwnd ' + $hit[0]['hwnd'] + ' ' + $hit[0]['clientWidth'] + 'x' + $hit[0]['clientHeight']) }
            Check 'ipc' 'Host captures the test table pixels it rendered' {
                Start-Sleep -Milliseconds 500
                $o = HostCall 'POST' '/api/capture/open' @{ consent = $true; target = @{ kind = 'window'; hwnd = $hwnd; pid = $script:tt.Id } }; if ($o.status -ne 200 -or $o.json['ok'] -eq $false) { throw ('capture open: HTTP ' + $o.status + ' ' + $o.raw) }
                $r = HostCall 'POST' '/api/capture/frame' @{ target = @{ kind = 'window'; hwnd = $hwnd; pid = $script:tt.Id } } 30
                if ($r.status -ne 200 -or $r.json['ok'] -ne $true) { throw ('capture: HTTP ' + $r.status + ' ' + $r.raw.Substring(0, [Math]::Min(500, $r.raw.Length))) }
                $png = [Convert]::FromBase64String([string]$r.json['png']); [IO.File]::WriteAllBytes((Join-Path $OutDir 'host-capture-testtable.png'), $png)
                $got = New-Object Drawing.Bitmap (New-Object IO.MemoryStream (, $png)); $sent = $script:frameSent
                if ($got.Width -ne $sent.Width -or $got.Height -ne $sent.Height) { throw ('captured ' + $got.Width + 'x' + $got.Height + ' but frame ' + $sent.Width + 'x' + $sent.Height) }
                $cl = $script:describe['client']; $boxes = @($script:describe['controls'].Values | ForEach-Object { New-Object Drawing.Rectangle ([int]$_['x'] - [int]$cl['x'] - 4), ([int]$_['y'] - [int]$cl['y'] - 4), ([int]$_['w'] + 8), ([int]$_['h'] + 8) })
                $pts = @(); foreach ($fx in 0.04, 0.2, 0.35, 0.5, 0.65, 0.8, 0.96) { foreach ($fy in 0.06, 0.2, 0.35, 0.5, 0.65, 0.8, 0.94) { $pt = New-Object Drawing.Point ([int]($sent.Width * $fx)), ([int]($sent.Height * $fy)); if (-not @($boxes | Where-Object { $_.Contains($pt) }).Count) { $pts += $pt } } }
                if ($pts.Count -lt 10) { throw ('only ' + $pts.Count + ' sample points clear of controls') }; $worst = 0
                foreach ($pt in $pts) { $x = $pt.X; $y = $pt.Y; $a = $sent.GetPixel($x, $y); $c = $got.GetPixel($x, $y); $d = [Math]::Max([Math]::Abs($a.R - $c.R), [Math]::Max([Math]::Abs($a.G - $c.G), [Math]::Abs($a.B - $c.B))); if ($d -gt $worst) { $worst = $d } }
                if ($worst -gt 24) { throw ('captured pixels differ from the rendered frame by up to ' + $worst + '/255') }
                ('method ' + $r.json['method'] + ', ' + $got.Width + 'x' + $got.Height + ', ' + $pts.Count + ' sample pixels (clear of controls) within ' + $worst + '/255 of the frame sent to the table')
            }
            Check 'ipc' 'Host -> driver sees the test table window' { $wi = Driver 'window-info' @{ hwnd = $hwnd }; $w = $wi['window']; if (-not ([string]$w['exe']).EndsWith('EightMaxTestTable.exe', [StringComparison]::OrdinalIgnoreCase) -or $w['pid'] -ne $script:tt.Id) { throw $js.Serialize($w) }; ('window-info: pid ' + $w['pid'] + ', exe ' + $w['exe'] + ', visible ' + $w['visible'] + ', client ' + $js.Serialize($w['client'])) }
            $shot = Screenshot 'desktop-headless-host-and-testtable.png'; if ($shot) { Write-Host ('screenshot ' + $shot) }
            # ===== 8a. test table shutdown through its protocol =====
            Check 'shutdown' 'Test table closes on the dealer close command' { TT-Send @{ type = 'close' }; if (-not $script:tt.WaitForExit(10000)) { throw 'still running 10 s after close' }; ('exited with code ' + $script:tt.ExitCode + $(if ($script:ttErr.IsCompleted -and $script:ttErr.Result) { '; stderr: ' + $script:ttErr.Result } else { '' })) }
        }
        # ===== 8b. host + driver shutdown through the authenticated API =====
        Check 'shutdown' 'Headless host: authenticated shutdown stops host and input driver' {
            $ms = Stop-HostByApi $script:hostRun.process; $code = $script:hostRun.process.ExitCode
            $driverGone = Wait-Until { -not (Alive $script:driverPid) } 5000; if (-not $driverGone) { throw ('host exited in ' + $ms + ' ms but input driver pid ' + $script:driverPid + ' is still running') }
            ('host exited in ' + $ms + ' ms (exit code ' + $code + '); input driver pid ' + $script:driverPid + ' gone')
        }
    }

    # ===== 1b. Desktop host with its window (normal operator launch); 8c. closing the window =====
    Check 'host' 'Desktop host starts with its window (non-headless)' {
        $script:gui = Start-HostProcess $false (Join-Path $OutDir 'host-window-session.json')
        if (-not (Wait-Until { $script:gui.process.Refresh(); $script:gui.process.MainWindowHandle -ne [IntPtr]::Zero } 15000)) { throw 'no main window within 15 s' }
        $r = HostCall 'GET' '/api/desktop/health'; if ($r.status -ne 200 -or $r.json['appVersion'] -ne $ExpectedAppVersion) { throw ('health HTTP ' + $r.status) }
        $null = Driver 'status'; $st = (HostCall 'GET' '/api/input/status').json; $script:guiDriver = Driver-Pid $st; if ($script:guiDriver) { $started.Add([ordered]@{ role = 'input driver (window host child)'; name = 'EightMaxInput'; pid = $script:guiDriver }) }
        Start-Sleep -Milliseconds 700; $shot = Screenshot 'desktop-host-window.png'
        ('pid ' + $script:gui.process.Id + ' window "' + $script:gui.process.MainWindowTitle + '" ready in ' + $script:gui.ms + ' ms; health OK; driver pid ' + $script:guiDriver + $(if ($shot) { '; screenshot desktop-host-window.png' } else { '' }))
    }
    if ($gui) {
        Check 'shutdown' 'Window host: closing the window stops host and input driver' {
            if (-not $script:gui.process.CloseMainWindow()) { throw 'WM_CLOSE could not be posted' }
            if (-not $script:gui.process.WaitForExit(20000)) { throw 'still running 20 s after the window was closed' }
            $driverGone = (-not $script:guiDriver) -or (Wait-Until { -not (Alive $script:guiDriver) } 5000); if (-not $driverGone) { throw ('input driver pid ' + $script:guiDriver + ' still running') }
            ('host exited with code ' + $script:gui.process.ExitCode + ' after the window closed; input driver gone')
        }
    }
    # The single-instance mutex and port 48713 were released by both hosts (a host start after both shutdowns proves it).
    Check 'shutdown' 'Port and single-instance lock released' { $r = Start-HostProcess $true (Join-Path $OutDir 'host-restart-session.json'); $ms = Stop-HostByApi $r.process; ('a fresh host started (ready in ' + $r.ms + ' ms) and stopped again in ' + $ms + ' ms') }

    # ===== optional: driver self-test (real visible input inside the driver's own window) =====
    if ($WithInputSelfTest) {
        Check 'input' 'Input driver self-test (EightMaxInput.exe --selftest)' { $out = Join-Path $OutDir 'input-selftest.json'; $r = Run-Exe (Bin 'EightMaxInput.exe') ('--selftest --out ' + (Quote-WorkbenchPath $out)) 120000; $j = $null; try { $j = $js.DeserializeObject([IO.File]::ReadAllText($out)) } catch {}; $sum = $(if ($j) { 'driver ' + $j['driver'] + ', ' + $j['passed'] + '/' + $j['total'] + ' checks passed, ok=' + $j['ok'] + ', dpi ' + $j['dpiAwareness'] } else { 'no report' }); if ($j -and $j['ok'] -ne $true) { throw ('self-test not ok: ' + $sum) }; if ($r.code -ne 0) { throw ('exit ' + $r.code + '; ' + $sum + '; ' + $r.err) }; ('exit 0; ' + $sum) }
    }
} catch {
    Add-Check 'harness' 'Unexpected harness error' $false ($_.Exception.Message + ' at ' + $_.InvocationInfo.PositionMessage)
} finally {
    # ===== 8d. no process this script started may survive =====
    foreach ($s in @($started)) { if (Alive $s.pid) { Start-Sleep -Milliseconds 500 } }
    $left = @(Our-Leftovers); $leftNames = @(Name-Leftovers $watchedNames $preexisting)
    Add-Check 'shutdown' 'No leftover processes' (($left.Count + $leftNames.Count) -eq 0) $(if (($left.Count + $leftNames.Count) -eq 0) { ($started.Count.ToString() + ' processes started by this test have all exited; no new EightMax/mwcli processes remain') } else { 'still running: ' + ((@($left) + @($leftNames) | Select-Object -Unique) -join ', ') })
    foreach ($s in @($started)) { if (Alive $s.pid) { try { Stop-Process -Id $s.pid -Force } catch {} } }
    $failedReq = @($checks | Where-Object { $_.status -eq 'fail' }); $passed = @($checks | Where-Object { $_.status -eq 'pass' }); $warn = @($checks | Where-Object { $_.status -eq 'warn' })
    $report = [ordered]@{ format = 'eightmax-milestone1-results'; version = 1; appVersion = $ExpectedAppVersion; expectedFileVersion = $ExpectedFileVersion; engineBuild = $ExpectedBuild
        completedAt = [DateTime]::UtcNow.ToString('o'); machine = $facts; processes = $started; counts = [ordered]@{ total = $checks.Count; passed = $passed.Count; failed = $failedReq.Count; warnings = $warn.Count }
        milestone1Passed = ($failedReq.Count -eq 0); checks = $checks
        scope = 'Milestone 1 only: build identity, startup, initialisation, existing-interface communication and shutdown. Not a gameplay, strategy, multi-table or target-PC acceptance.' }
    $json = $report | ConvertTo-Json -Depth 8; [IO.File]::WriteAllText((Join-Path $OutDir 'milestone1-results.json'), $json, (New-Object Text.UTF8Encoding($false)))
    $lines = @('EightMax 0.36.2-dev Milestone 1 focused Windows checks - ' + $report.completedAt, ('Machine: ' + $facts.os + ', PowerShell ' + $facts.powershell + ', screen ' + $facts.virtualScreen), ('Result: ' + $passed.Count + ' passed, ' + $failedReq.Count + ' failed, ' + $warn.Count + ' warnings of ' + $checks.Count), '')
    foreach ($c in $checks) { $lines += ('[' + $c.group + '] ' + $c.status.ToUpper() + ' ' + $c.name + ': ' + $c.detail) }
    [IO.File]::WriteAllLines((Join-Path $OutDir 'milestone1-results.txt'), [string[]]$lines, (New-Object Text.UTF8Encoding($false)))
    Write-Host ''; Write-Host ('Milestone 1 checks: ' + $passed.Count + ' passed, ' + $failedReq.Count + ' failed, ' + $warn.Count + ' warnings. Report: ' + (Join-Path $OutDir 'milestone1-results.txt'))
}
if (@($checks | Where-Object { $_.status -eq 'fail' }).Count) { exit 1 } else { exit 0 }
