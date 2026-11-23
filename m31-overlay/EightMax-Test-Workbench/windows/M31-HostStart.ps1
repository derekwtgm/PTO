<# EightMax Test Workbench 0.36.2 Milestone 3.1 - desktop host start, instrumented. Dot-source after M31-Lib.ps1.

   Every start case runs the same twelve operations; each writes its name and start time BEFORE it runs and its outcome right after
   (operations.jsonl, console.log, checks.jsonl), so a stop is located exactly:
      1 existing EightMax processes     2 port 48713 free                 3 start-up folders prepared        4 start-up script started
      5 desktop host launched           6 host reports ready              7 session file read and valid      8 health endpoint answers
      9 input driver starts             10 authenticated shutdown         11 host and input driver exited    12 port 48713 released
   Every wait has a time limit. On a time-out the process tree, the windows of those processes (a Windows security prompt is named),
   the port owner, the start-up script's own trace and the host's stderr are saved before anything is stopped. Only processes of this
   test session are ever stopped; another program - or an EightMax the operator started - is reported and left running.
   Milestone 3 on the operator PC: the first case ("prebuilt host launch") printed nothing for at least 80 s - the runner waited up to
   900 s for windows\Start-Desktop.ps1, which never exited, and kept no record of where it stood. #>

$script:M31Port = 48713
$script:M31HostCaseResults = New-Object Collections.ArrayList

function Get-M31EightMaxProcesses([string]$AppRoot) {
    $owned = @(Get-M31SessionPids)
    $out = New-Object Collections.ArrayList
    foreach ($p in @(Get-Process -Name $script:M31HostNames -ErrorAction SilentlyContinue)) {
        $path = $null; $started = $null
        try { $path = $p.MainModule.FileName } catch {}
        try { $started = $p.StartTime.ToUniversalTime().ToString('o') } catch {}
        [void]$out.Add([ordered]@{ pid = [int]$p.Id; name = $p.ProcessName; path = $path; startedAt = $started; sessionOwned = ($owned -contains [int]$p.Id); fromThisRelease = $(if ($path -and $AppRoot) { Test-M31PathInside $path $AppRoot } else { $null }) })
    }
    return $out.ToArray()
}
function Format-M31Proc($P) { return ([string]$P.name + ' pid ' + [string]$P.pid + $(if ($P.startedAt) { ' (started ' + (ConvertTo-M31Date $P.startedAt).ToLocalTime().ToString('HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) + ')' } else { '' }) + $(if ($P.path) { ' ' + [string]$P.path } else { '' })) }
function Invoke-M31HostHttp([string]$Method, [string]$Origin, [string]$Path, [string]$Token, [string]$Body, [int]$TimeoutSec = 15) {
    $req = [Net.HttpWebRequest]::Create($Origin + $Path); $req.Method = $Method; $req.Proxy = $null; $req.Timeout = $TimeoutSec * 1000; $req.ReadWriteTimeout = $TimeoutSec * 1000; $req.KeepAlive = $false
    try { $req.ServicePoint.Expect100Continue = $false } catch {}
    if ($Token) { $req.Headers.Add('X-EightMax-Session', $Token) }
    if ($Method -eq 'POST') {
        if (-not $Body) { $Body = '{}' }
        $bytes = $script:M31Utf8.GetBytes($Body); $req.ContentType = 'application/json'; $req.ContentLength = $bytes.Length
        $s = $req.GetRequestStream(); try { $s.Write($bytes, 0, $bytes.Length) } finally { $s.Close() }
    }
    $resp = $null
    try { $resp = $req.GetResponse() } catch { $we = $_.Exception; while ($we -and -not ($we -is [Net.WebException])) { $we = $we.InnerException }; if ($we -and $we.Response) { $resp = $we.Response } else { throw } }
    try { $sr = New-Object IO.StreamReader($resp.GetResponseStream(), $script:M31Utf8); $raw = $sr.ReadToEnd(); $sr.Close(); $code = [int]$resp.StatusCode } finally { $resp.Close() }
    $json = $null; try { $json = $raw | ConvertFrom-Json } catch {}
    return [ordered]@{ status = $code; raw = $raw; json = $json }
}
function Read-M31Trace([string]$Path) {
    $ev = New-Object Collections.ArrayList
    foreach ($l in ((Read-M31Text $Path) -split "`r?`n")) { if ($l.Trim()) { try { [void]$ev.Add(($l | ConvertFrom-Json)) } catch {} } }
    return $ev.ToArray()
}
function Format-M31TraceStep($Events) {
    $e = @($Events); if (-not $e.Count) { return 'no step recorded (the script wrote no trace: it did not start, or stopped before its first step)' }
    $l = $e[$e.Count - 1]; return ('"' + [string]$l.step + '" ' + [string]$l.state + $(if ($l.detail) { ' (' + [string]$l.detail + ')' } else { '' }))
}
function Get-M31HostLogTail {
    $local = $env:LOCALAPPDATA; if (-not $local) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
    $f = Join-Path $local 'EightMax-Test-Workbench\Logs\desktop-host.log'
    if (Test-Path -LiteralPath $f) { return (Get-M31Tail $f 12 16384) }
    return ''
}
function Get-M31ErrorCategory([string]$Text) {
    if ($Text -match 'Release verification failed|missing from this release|Extract the complete release|native binary identity differs') { return 'environment' }
    if ($Text -match 'already running|already in use|port 48713') { return 'environment' }
    if ($Text -match '64-bit Windows PowerShell') { return 'environment' }
    if ($Text -match 'cannot be loaded because running scripts is disabled|execution policy|not digitally signed') { return 'environment' }
    if ($Text -match 'Access to the path|denied|is being used by another process|virus|potentially unwanted|blocked') { return 'environment' }
    return 'application'
}

function Invoke-M31HostCase {
    param([string]$Id, [string]$Name, [string]$Extra, [scriptblock]$Expect, [switch]$BuildOnly, [string]$CaseDir, [string]$AppRoot, [string]$StartScript, [int]$LaunchTimeoutSec, [int]$ReadyTimeoutSec, [switch]$SkipInput)
    $opTotal = 12; $g = 'host-start'
    $c = [ordered]@{ id = $Id; case = $Name; args = $Extra; buildOnly = [bool]$BuildOnly; startScript = $StartScript; folder = $CaseDir; operations = [ordered]@{}; hostPid = $null; launchMethod = $null; status = $null; session = $null; health = $null; input = $null; shutdown = $null; result = $null }
    $ctx = @{ script = $null; hostProc = $null; hostPid = $null; origin = $null; token = $null; stop = $null; files = $null; scriptDone = $false }
    $record = { param($op, $r) $c.operations[$op] = [ordered]@{ status = $r.status; category = $r.category; ms = $r.ms; detail = $r.detail } }
    $skip = { param($i, $op, $title, $why) $r = Invoke-M31Operation $g $Name $op $title $i $opTotal 5 { [ordered]@{ status = 'SKIPPED'; detail = ('not run: ' + $why) } }; & $record $op $r }

    # 1 ---------------------------------------------------------------------------------------------------------------------------------
    $r = Invoke-M31Operation $g $Name 'check-existing-processes' 'Check for EightMax programs that are already running' 1 $opTotal 30 {
        $procs = @(Get-M31EightMaxProcesses $AppRoot)
        $mine = @($procs | Where-Object { $_.sessionOwned })
        $note = ''
        if ($mine.Count) { foreach ($p in $mine) { [void](Stop-M31ProcessTree $p.pid 'left over by an earlier case of this test run') }; $note = ' Stopped ' + $mine.Count + ' process(es) left over by an earlier case of this run: ' + ((@($mine | ForEach-Object { Format-M31Proc $_ })) -join '; ') + '.' }
        $hosts = @($procs | Where-Object { -not $_.sessionOwned -and $_.name -eq 'EightMaxWorkbench' })
        $others = @($procs | Where-Object { -not $_.sessionOwned -and $_.name -ne 'EightMaxWorkbench' })
        if ($hosts.Count) { return [ordered]@{ status = 'FAIL'; category = 'environment'; detail = ('an EightMax desktop host that this test did not start is already running: ' + ((@($hosts | ForEach-Object { Format-M31Proc $_ })) -join '; ') + '. It was left running. Close the EightMax Workbench and its dashboard, then run the test again.' + $note); data = $procs } }
        if ($others.Count) { return [ordered]@{ status = 'WARNING'; detail = ('no desktop host is running; other EightMax programs this test did not start are running and were left alone: ' + ((@($others | ForEach-Object { Format-M31Proc $_ })) -join '; ') + $note); data = $procs } }
        return [ordered]@{ status = 'PASS'; detail = ('no EightMax program is running' + $note); data = $procs }
    }
    & $record 'check-existing-processes' $r
    $blocked = $(if ($r.status -eq 'FAIL') { 'another EightMax desktop host is running (operation 1)' } else { $null })

    # 2 ---------------------------------------------------------------------------------------------------------------------------------
    if ($blocked) { & $skip 2 'check-port' 'Check that port 48713 is free' $blocked } else {
        $r = Invoke-M31Operation $g $Name 'check-port' 'Check that port 48713 is free' 2 $opTotal 30 {
            $owners = @(Get-M31PortOwners $script:M31Port)
            if (-not $owners.Count) { return [ordered]@{ status = 'PASS'; detail = 'free' } }
            $sess = @(Get-M31SessionPids)
            foreach ($o in $owners) { if ($sess -contains [int]$o.pid) { [void](Stop-M31ProcessTree $o.pid 'held port 48713, left over by an earlier case of this run') } }
            $sw = [Diagnostics.Stopwatch]::StartNew()
            while ($sw.Elapsed.TotalSeconds -lt 15 -and @(Get-M31PortOwners $script:M31Port).Count) { Start-Sleep -Milliseconds 250 }
            $owners = @(Get-M31PortOwners $script:M31Port)
            if (-not $owners.Count) { return [ordered]@{ status = 'PASS'; detail = ('free after ' + [int]$sw.Elapsed.TotalSeconds + ' s') } }
            return [ordered]@{ status = 'FAIL'; category = 'environment'; detail = ('port 48713 is already occupied by ' + (Format-M31PortOwners $owners) + '. The desktop host needs this port. That program was left running: close it (or restart Windows), then run the test again.'); data = $owners }
        }
        & $record 'check-port' $r
        if ($r.status -eq 'FAIL') { $blocked = 'port 48713 is occupied (operation 2)' }
    }

    # 3 ---------------------------------------------------------------------------------------------------------------------------------
    if ($blocked) { & $skip 3 'prepare-directories' 'Prepare the start-up folders' $blocked } else {
        $r = Invoke-M31Operation $g $Name 'prepare-directories' 'Prepare the start-up folders' 3 $opTotal 15 {
            [void][IO.Directory]::CreateDirectory($CaseDir)
            $f = [ordered]@{ ready = (Join-Path $CaseDir 'session.json'); status = (Join-Path $CaseDir 'start-status.json'); trace = (Join-Path $CaseDir 'start-trace.jsonl'); scriptLog = (Join-Path $CaseDir 'startup-script'); hostStdout = (Join-Path $CaseDir 'session.host-stdout.txt'); hostStderr = (Join-Path $CaseDir 'session.host-stderr.txt') }
            foreach ($k in @('ready', 'status', 'trace')) { if (Test-Path -LiteralPath $f[$k]) { Remove-Item -LiteralPath $f[$k] -Force } }
            $probe = Join-Path $CaseDir '.write-test.tmp'; [IO.File]::WriteAllText($probe, 'ok'); [IO.File]::Delete($probe)
            if (-not (Test-Path -LiteralPath $StartScript -PathType Leaf)) { return [ordered]@{ status = 'FAIL'; category = 'environment'; detail = ('the start-up script is missing: ' + $StartScript) } }
            $ctx.files = $f
            return [ordered]@{ status = 'PASS'; detail = ('case folder ready: ' + $CaseDir); data = [ordered]@{ folder = (Get-M31PathInfo $CaseDir); appRoot = (Get-M31PathInfo $AppRoot) } }
        }
        & $record 'prepare-directories' $r
        if ($r.status -eq 'FAIL') { $blocked = 'the start-up folders could not be prepared (operation 3)' }
    }

    # 4 ---------------------------------------------------------------------------------------------------------------------------------
    if ($blocked) { & $skip 4 'launch-startup-script' 'Start the start-up script (windows\Start-Desktop.ps1)' $blocked } else {
        $r = Invoke-M31Operation $g $Name 'launch-startup-script' ('Start the start-up script (' + [IO.Path]::GetFileName($StartScript) + ')') 4 $opTotal 30 {
            $f = $ctx.files
            $psExe = $(if ($script:M31IsWindows -and $PSVersionTable.PSEdition -ne 'Core') { Join-Path $PSHOME 'powershell.exe' } else { (Get-Process -Id $PID).Path })
            $a = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $StartScript + '" -Headless -ReadyFile "' + $f.ready + '" -StatusFile "' + $f.status + '" -TraceFile "' + $f.trace + '"'
            if ($Extra) { $a += ' ' + $Extra }
            $ctx.script = Start-M31Process $psExe $a $f.scriptLog $AppRoot
            return [ordered]@{ status = 'PASS'; detail = ('started ' + [IO.Path]::GetFileName($psExe) + ' pid ' + $ctx.script.Pid); data = [ordered]@{ pid = $ctx.script.Pid; arguments = $a } }
        }
        & $record 'launch-startup-script' $r
        if ($r.status -ne 'PASS') { $blocked = 'the start-up script could not be started (operation 4)' }
    }

    # 5 ---------------------------------------------------------------------------------------------------------------------------------
    $t5 = $(if ($BuildOnly) { 'Wait for the start-up script to build the desktop host (no launch)' } else { 'Wait for the start-up script to launch the desktop host' })
    if ($blocked) { & $skip 5 'launch-desktop-host' $t5 $blocked } else {
        $r = Invoke-M31Operation $g $Name 'launch-desktop-host' $t5 5 $opTotal $LaunchTimeoutSec {
            $f = $ctx.files
            $tick = { param($el) Format-M31TraceStep (Read-M31Trace $f.trace) }
            $w = Wait-M31Process $ctx.script $LaunchTimeoutSec 'start-up script' $tick
            $ctx.scriptDone = $true
            $trace = @(Read-M31Trace $f.trace); $status = $null; try { $status = Read-M31JsonFile $f.status } catch {}
            $c.status = $status
            $errTail = Get-M31Tail ($f.scriptLog + '.err.txt') 6
            $data = [ordered]@{ exitCode = $w.exitCode; seconds = $w.seconds; trace = $trace; startStatus = $status; stderrTail = $errTail }
            if ($w.timedOut) {
                $data.hang = $w.diagnostics
                try { Write-M31AtomicText (Join-Path $CaseDir 'hang-diagnostics.json') (ConvertTo-M31Json $w.diagnostics) } catch {}
                $exe = Join-Path $AppRoot 'desktop\bin\EightMaxWorkbench.exe'; $z = Get-M31ZoneInfo $exe; $data.markOfTheWeb = $z
                $why = 'the start-up script did not finish within ' + $LaunchTimeoutSec + ' s; its last recorded step: ' + (Format-M31TraceStep $trace) + '.'
                if ($w.diagnostics -and $w.diagnostics.securityPrompt) { $why += ' FOUND: ' + $w.diagnostics.securityPrompt + '.' }
                elseif ($z) { $why += ' The program files are marked as downloaded from the ' + [string]$z.zone + ' (Mark of the Web), so a Windows security prompt may have been waiting.' }
                $why += ' The script and its child processes were stopped; see hang-diagnostics.json.'
                return [ordered]@{ status = 'FAIL'; category = 'timeout'; detail = $why; data = $data; evidence = @('hang-diagnostics.json', 'start-trace.jsonl', 'startup-script.err.txt') }
            }
            if ($w.exitCode -ne 0) {
                $msg = $(if ($status -and $status.error) { [string]$status.error } elseif ($errTail) { $errTail } else { 'no error text' })
                return [ordered]@{ status = 'FAIL'; category = (Get-M31ErrorCategory $msg); detail = ('the start-up script failed (exit ' + [string]$w.exitCode + ') at step ' + (Format-M31TraceStep $trace) + ': ' + $msg); data = $data; evidence = @('startup-script.err.txt', 'start-status.json', 'start-trace.jsonl') }
            }
            if (-not $status) { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('the start-up script ended (exit 0) without writing its status record; last step ' + (Format-M31TraceStep $trace)); data = $data } }
            if ($BuildOnly) { return [ordered]@{ status = 'PASS'; detail = ('built without launching: path ' + [string]$status.path + ', launched ' + [string]$status.launched); data = $data } }
            if (-not $status.launched -or -not $status.pid) { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('the start-up script ended without launching the host: ' + [string]$status.error); data = $data } }
            $ctx.hostPid = [int]$status.pid; $c.hostPid = $ctx.hostPid; $c.launchMethod = [string]$status.launchMethod
            try { $hp = [Diagnostics.Process]::GetProcessById($ctx.hostPid); $null = $hp.Handle; $ctx.hostProc = $hp; [void]$script:M31Tracked.Add($ctx.hostPid) } catch {}
            return [ordered]@{ status = 'PASS'; detail = ('host pid ' + $ctx.hostPid + ' launched (' + [string]$status.launchMethod + ', path ' + [string]$status.path + '); start-up script finished in ' + (Format-M31Duration $w.seconds)); data = $data }
        }
        & $record 'launch-desktop-host' $r
        if ($r.status -ne 'PASS') { $blocked = 'the desktop host was not launched (operation 5)' }
    }

    if ($BuildOnly) {
        $why = 'a build-only case starts no host'
        if (-not $blocked -and $Expect) { $ew = ''; try { $ew = [string](& $Expect $c.status) } catch { $ew = 'expectation could not be evaluated: ' + $_.Exception.Message }; if ($ew.Trim()) { [void](Add-M31Check $g ($Name + ' - expected result') 'FAIL' $ew.Trim() 'application') } else { [void](Add-M31Check $g ($Name + ' - expected result') 'PASS' ('path ' + [string]$c.status.path + ', nothing launched')) } }
        foreach ($s in @(@(6, 'wait-readiness', 'Wait for the host to report ready'), @(7, 'read-session-file', 'Read the session file'), @(8, 'verify-health', 'Check the health endpoint'), @(9, 'verify-input-driver', 'Check that the input driver starts'), @(10, 'authenticated-shutdown', 'Shut the host down (authenticated request)'))) { & $skip $s[0] $s[1] $s[2] $why }
    } else {
        # 6 -----------------------------------------------------------------------------------------------------------------------------
        if ($blocked) { & $skip 6 'wait-readiness' 'Wait for the host to report ready' $blocked } else {
            $r = Invoke-M31Operation $g $Name 'wait-readiness' 'Wait for the host to report ready (session file)' 6 $opTotal $ReadyTimeoutSec {
                $f = $ctx.files; $sw = [Diagnostics.Stopwatch]::StartNew(); $next = 15
                while ($sw.Elapsed.TotalSeconds -lt $ReadyTimeoutSec) {
                    if (Test-Path -LiteralPath $f.ready) { return [ordered]@{ status = 'PASS'; detail = ('ready after ' + (Format-M31Duration $sw.Elapsed.TotalSeconds)) } }
                    if (-not (Test-M31Alive $ctx.hostPid)) {
                        $code = $null; if ($ctx.hostProc -and $script:M31IsWindows) { try { $code = $ctx.hostProc.ExitCode } catch {} }
                        $herr = Get-M31Tail $f.hostStderr 8; $hlog = Get-M31HostLogTail
                        $msg = 'the desktop host exited' + $(if ($null -ne $code) { ' with code ' + $code } else { '' }) + ' before it was ready' + $(if ($herr) { '; host stderr: ' + $herr } else { '; the host wrote nothing to stderr' }) + $(if ($hlog) { ' | desktop-host.log: ' + (($hlog -split "`n" | Select-Object -Last 3) -join ' / ') } else { '' })
                        return [ordered]@{ status = 'FAIL'; category = (Get-M31ErrorCategory $msg); detail = $msg; data = [ordered]@{ exitCode = $code; hostStderr = $herr; desktopHostLog = $hlog }; evidence = @('session.host-stderr.txt') }
                    }
                    if ($sw.Elapsed.TotalSeconds -ge $next) { Write-M31Log ('     ... waiting for the host to become ready: ' + [int]$sw.Elapsed.TotalSeconds + ' s of ' + $ReadyTimeoutSec + ' s') 'DarkGray'; Update-M31Heartbeat ('ready wait ' + [int]$sw.Elapsed.TotalSeconds + ' s'); $next += 15 }
                    Start-Sleep -Milliseconds 250
                }
                $diag = Get-M31HangDiagnostics $ctx.hostPid 'host never reported ready'
                try { Write-M31AtomicText (Join-Path $CaseDir 'hang-diagnostics.json') (ConvertTo-M31Json $diag) } catch {}
                $herr = Get-M31Tail $f.hostStderr 8
                return [ordered]@{ status = 'FAIL'; category = 'timeout'; detail = ('the host (pid ' + $ctx.hostPid + ') is running but wrote no session file within ' + $ReadyTimeoutSec + ' s' + $(if ($diag.securityPrompt) { '; FOUND: ' + $diag.securityPrompt } else { '' }) + $(if ($herr) { '; host stderr: ' + $herr } else { '' })); data = $diag; evidence = @('hang-diagnostics.json') }
            }
            & $record 'wait-readiness' $r
            if ($r.status -ne 'PASS') { $blocked = 'the host never reported ready (operation 6)' }
        }
        # 7 -----------------------------------------------------------------------------------------------------------------------------
        if ($blocked) { & $skip 7 'read-session-file' 'Read the session file' $blocked } else {
            $r = Invoke-M31Operation $g $Name 'read-session-file' 'Read and validate the session file' 7 $opTotal 15 {
                $raw = ''; for ($i = 0; $i -lt 20; $i++) { $raw = Read-M31Text $ctx.files.ready; if ($raw.Trim()) { break }; Start-Sleep -Milliseconds 100 }
                $s = $null; try { $s = $raw | ConvertFrom-Json } catch { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('the session file is not valid JSON: ' + $_.Exception.Message + ' (first characters: ' + $raw.Substring(0, [math]::Min(80, $raw.Length)) + ')') } }
                $red = [ordered]@{ format = $s.format; version = $s.version; appVersion = $s.appVersion; origin = $s.origin; processId = $s.processId; requestLog = $s.requestLog; token = $(if ($s.token) { '(redacted, ' + ([string]$s.token).Length + ' characters)' } else { $null }) }
                try { Write-M31AtomicText (Join-Path $CaseDir 'session-redacted.json') (ConvertTo-M31Json $red) } catch {}
                $bad = @()
                if ([string]$s.format -ne 'eightmax-desktop-session') { $bad += ('format ' + [string]$s.format) }
                if ([string]$s.origin -ne 'http://127.0.0.1:48713') { $bad += ('origin ' + [string]$s.origin) }
                if ([string]$s.token -notmatch '^[0-9a-f]{64}$') { $bad += 'token is not 64 hexadecimal characters' }
                if ($ctx.hostPid -and [int]$s.processId -ne $ctx.hostPid) { $bad += ('processId ' + [string]$s.processId + ' is not the launched host ' + $ctx.hostPid) }
                if ([string]$s.appVersion -ne $script:M31AppVersion) { $bad += ('appVersion ' + [string]$s.appVersion) }
                if ($bad.Count) { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('invalid session file: ' + ($bad -join '; ')); data = $red } }
                $ctx.origin = [string]$s.origin; $ctx.token = [string]$s.token; $c.session = $red
                return [ordered]@{ status = 'PASS'; detail = ('session of host pid ' + [string]$s.processId + ', app ' + [string]$s.appVersion); data = $red; evidence = @('session-redacted.json') }
            }
            & $record 'read-session-file' $r
            if ($r.status -ne 'PASS') { $blocked = 'the session file was not usable (operation 7)' }
        }
        # 8 -----------------------------------------------------------------------------------------------------------------------------
        $healthOk = $false
        if ($blocked) { & $skip 8 'verify-health' 'Check the health endpoint' $blocked } else {
            $r = Invoke-M31Operation $g $Name 'verify-health' 'Check the health endpoint' 8 $opTotal 45 {
                $last = $null
                for ($i = 1; $i -le 3; $i++) {
                    try { $h = Invoke-M31HostHttp 'GET' $ctx.origin '/api/desktop/health' $ctx.token '' 12 } catch { $last = $_.Exception.Message; Start-Sleep -Seconds 2; continue }
                    $c.health = [ordered]@{ status = $h.status; appVersion = $(if ($h.json) { [string]$h.json.appVersion } else { $null }); build = $(if ($h.json) { [string]$h.json.build } else { $null }); inputDriver = $(if ($h.json) { $h.json.inputDriver } else { $null }); inputDriverRunning = $(if ($h.json) { $h.json.inputDriverRunning } else { $null }) }
                    if ($h.status -ne 200 -or -not $h.json) { $last = 'HTTP ' + $h.status + ' ' + $h.raw.Substring(0, [math]::Min(200, $h.raw.Length)); Start-Sleep -Seconds 2; continue }
                    if ([string]$h.json.format -ne 'eightmax-desktop-health' -or [string]$h.json.appVersion -ne $script:M31AppVersion) { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('unexpected health answer: format ' + [string]$h.json.format + ', appVersion ' + [string]$h.json.appVersion); data = $c.health } }
                    return [ordered]@{ status = 'PASS'; detail = ('HTTP 200, app ' + [string]$h.json.appVersion + ', input driver installed ' + [string]$h.json.inputDriver); data = $c.health }
                }
                return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('the desktop host did not answer its health check: ' + [string]$last) }
            }
            & $record 'verify-health' $r; $healthOk = ($r.status -eq 'PASS')
        }
        # 9 -----------------------------------------------------------------------------------------------------------------------------
        if ($SkipInput) { & $skip 9 'verify-input-driver' 'Check that the input driver starts' 'not part of this case' }
        elseif (-not $healthOk) { & $skip 9 'verify-input-driver' 'Check that the input driver starts' $(if ($blocked) { $blocked } else { 'the health check failed (operation 8)' }) }
        else {
            $r = Invoke-M31Operation $g $Name 'verify-input-driver' 'Check that the input driver starts (authenticated hello, no mouse movement)' 9 $opTotal 45 {
                $h = Invoke-M31HostHttp 'POST' $ctx.origin '/api/input/command' $ctx.token '{"cmd":"health","timeoutMs":20000}' 40
                if ($h.status -ne 200) { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('the input driver did not start: HTTP ' + $h.status + ' ' + $h.raw.Substring(0, [math]::Min(300, $h.raw.Length))) } }
                $s = Invoke-M31HostHttp 'GET' $ctx.origin '/api/input/status' $ctx.token '' 15
                $st = $s.json; $c.input = [ordered]@{ installed = $(if ($st) { $st.installed } else { $null }); running = $(if ($st) { $st.running } else { $null }); crashed = $(if ($st) { $st.crashed } else { $null }); starts = $(if ($st) { $st.starts } else { $null }); hotkey = $(if ($st) { $st.hotkey } else { $null }) }
                if (-not $st -or -not $st.running -or $st.crashed) { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('input driver status after start: ' + $s.raw.Substring(0, [math]::Min(300, $s.raw.Length))); data = $c.input } }
                return [ordered]@{ status = 'PASS'; detail = ('EightMaxInput.exe started and accepted the session (running, not crashed, emergency-stop hotkey ' + [string]$st.hotkey + ')'); data = $c.input }
            }
            & $record 'verify-input-driver' $r
        }
        # 10 ----------------------------------------------------------------------------------------------------------------------------
        if (-not $ctx.token) { & $skip 10 'authenticated-shutdown' 'Shut the host down (authenticated request)' $(if ($blocked) { $blocked } else { 'no session' }) } else {
            $r = Invoke-M31Operation $g $Name 'authenticated-shutdown' 'Shut the host down (authenticated request)' 10 $opTotal 30 {
                try { $h = Invoke-M31HostHttp 'POST' $ctx.origin '/api/desktop/shutdown' $ctx.token '{}' 20 } catch { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('the shutdown request failed: ' + $_.Exception.Message) } }
                $c.shutdown = [ordered]@{ status = $h.status }
                if ($h.status -ne 200) { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('shutdown refused: HTTP ' + $h.status + ' ' + $h.raw.Substring(0, [math]::Min(200, $h.raw.Length))) } }
                return [ordered]@{ status = 'PASS'; detail = 'HTTP 200 (shutdown accepted)' }
            }
            & $record 'authenticated-shutdown' $r
        }
    }

    # 11 --------------------------------------------------------------------------------------------------------------------------------
    $r = Invoke-M31Operation $g $Name 'verify-process-termination' 'Check that the host, the input driver and the start-up script have exited' 11 $opTotal 60 {
        $notes = @(); $st = 'PASS'; $cat = $null
        if ($ctx.script -and -not $ctx.scriptDone) { [void](Stop-M31ProcessTree $ctx.script.Pid 'start-up script still running after its case'); $notes += 'the start-up script was still running and was stopped' }
        if ($ctx.hostPid) {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $asked = ($c.operations.Contains('authenticated-shutdown') -and $c.operations['authenticated-shutdown'].status -eq 'PASS')
            $limit = $(if ($asked) { 30 } else { 2 })
            while ($sw.Elapsed.TotalSeconds -lt $limit -and (Test-M31Alive $ctx.hostPid)) { Start-Sleep -Milliseconds 200 }
            if (Test-M31Alive $ctx.hostPid) {
                [void](Stop-M31ProcessTree $ctx.hostPid 'host still running at the end of its case')
                if ($asked) { $st = 'FAIL'; $cat = 'application'; $notes += ('the host did not exit within 30 s after an accepted shutdown; it was stopped') }
                else { if ($st -eq 'PASS') { $st = 'WARNING' }; $notes += 'the host was stopped by the test (cleanup after the failure above)' }
            } else { $notes += ('host exited' + $(if ($ctx.hostProc -and $script:M31IsWindows) { try { ' (exit code ' + $ctx.hostProc.ExitCode + ')' } catch { '' } } else { '' }) + ' after ' + (Format-M31Duration $sw.Elapsed.TotalSeconds)) }
        }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $drivers = { @(Get-M31EightMaxProcesses $AppRoot | Where-Object { $_.sessionOwned -and $_.name -eq 'EightMaxInput' }) }
        while ($sw.Elapsed.TotalSeconds -lt 15 -and @(& $drivers).Count) { Start-Sleep -Milliseconds 200 }
        $left = @(& $drivers)
        if ($left.Count) { foreach ($d in $left) { [void](Stop-M31ProcessTree $d.pid 'input driver still running after its host') }; $st = 'FAIL'; $cat = 'application'; $notes += ('input driver still running 15 s after its host: ' + ((@($left | ForEach-Object { Format-M31Proc $_ })) -join '; ') + ' (stopped)') }
        else { $notes += 'no input driver left' }
        $other = @(Get-M31EightMaxProcesses $AppRoot | Where-Object { $_.sessionOwned })
        if ($other.Count) { foreach ($o in $other) { [void](Stop-M31ProcessTree $o.pid 'left over at the end of its case') }; if ($st -eq 'PASS') { $st = 'WARNING' }; $notes += ('stopped leftovers: ' + ((@($other | ForEach-Object { Format-M31Proc $_ })) -join '; ')) }
        return [ordered]@{ status = $st; category = $cat; detail = ($notes -join '; ') }
    }
    & $record 'verify-process-termination' $r
    # 12 --------------------------------------------------------------------------------------------------------------------------------
    if ($c.operations['check-port'] -and $c.operations['check-port'].status -eq 'FAIL') { & $skip 12 'verify-port-release' 'Check that port 48713 is released' 'the port was occupied by another program before the case (operation 2)' } else {
        $r = Invoke-M31Operation $g $Name 'verify-port-release' 'Check that port 48713 is released' 12 $opTotal 45 {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            while ($sw.Elapsed.TotalSeconds -lt 30 -and @(Get-M31PortOwners $script:M31Port).Count) { Start-Sleep -Milliseconds 200 }
            $o = @(Get-M31PortOwners $script:M31Port)
            if ($o.Count) { return [ordered]@{ status = 'FAIL'; category = 'application'; detail = ('port 48713 is still in use 30 s after the case: ' + (Format-M31PortOwners $o)); data = $o } }
            return [ordered]@{ status = 'PASS'; detail = ('free after ' + [int]$sw.Elapsed.TotalMilliseconds + ' ms') }
        }
        & $record 'verify-port-release' $r
    }
    # case expectations (path / cache behaviour) for launch cases that started
    if (-not $BuildOnly -and $Expect -and $c.status -and $c.operations.Contains('verify-health') -and $c.operations['verify-health'].status -eq 'PASS') {
        $ew = ''; try { $ew = [string](& $Expect $c) } catch { $ew = 'expectation could not be evaluated: ' + $_.Exception.Message }
        if ($ew.Trim()) { [void](Add-M31Check $g ($Name + ' - expected result') 'FAIL' $ew.Trim() 'application') } else { [void](Add-M31Check $g ($Name + ' - expected result') 'PASS' ('path ' + [string]$c.status.path + $(if ($c.status.invalidCache) { ', invalid cache: ' + [string]$c.status.invalidCache } else { '' }))) }
    }
    $c.result = $(if (@($c.operations.Values | Where-Object { $_.status -eq 'FAIL' }).Count) { 'FAIL' } else { 'PASS' })
    try { Write-M31AtomicText (Join-Path $CaseDir 'case-result.json') (ConvertTo-M31Json $c) } catch {}
    [void]$script:M31HostCaseResults.Add($c)
    return $c
}

function Invoke-M31HostStartCases {
    param([string]$AppRoot, [string]$WorkDir, [string[]]$Only, [string]$StartScript, [int]$LaunchTimeoutSec = 120, [int]$CompileTimeoutSec = 300, [int]$ReadyTimeoutSec = 60)
    # The Milestone 3 start cases (same expectations), run one after another; Quick mode runs only the first.
    if (-not $StartScript) { $StartScript = Join-Path $AppRoot 'windows\Start-Desktop.ps1' }
    $cacheRoot = Join-Path $WorkDir 'cache'
    $okHealth = { param($c) $w = ''; if (-not $c.health -or $c.health.status -ne 200) { $w += ' no healthy host;' }; return $w }
    $cases = @(
        @{ id = 'prebuilt'; name = 'prebuilt host launch'; extra = ''; expect = { param($c) $w = & $okHealth $c; if ([string]$c.status.path -ne 'prebuilt') { $w += ' path ' + [string]$c.status.path + ' (expected prebuilt);' }; return $w } },
        @{ id = 'fallback-fresh'; name = 'forced fallback compile with a fresh cache'; extra = ('-ForceCompile -CacheRoot "' + $cacheRoot + '"'); compile = $true; expect = { param($c) $w = & $okHealth $c; $s = $c.status; if ([string]$s.path -ne 'compiled' -or -not $s.compiled) { $w += ' path ' + [string]$s.path + ' (expected compiled);' }; $src = @($s.sources | ForEach-Object { [string]$_.path }); if (($src -join ',') -ne 'desktop/DesktopHost.cs,desktop/CaptureService.cs,desktop/InputBroker.cs') { $w += ' sources ' + ($src -join ',') + ';' }; return $w } },
        @{ id = 'cache-reuse'; name = 'repeated start reuses the valid cache'; extra = ('-ForceCompile -CacheRoot "' + $cacheRoot + '"'); compile = $true; needsCache = $true; expect = { param($c) $w = & $okHealth $c; $s = $c.status; if ([string]$s.path -ne 'cache' -or -not $s.reusedCache -or $s.compiled) { $w += ' path ' + [string]$s.path + ' (expected cache, not compiled);' }; if ([string]$s.exeSha256 -ne $script:M31CacheExeHash) { $w += ' cached executable changed;' }; return $w } },
        @{ id = 'invalid-exe'; name = 'invalid cache: corrupted executable is rebuilt'; extra = ('-ForceCompile -CacheRoot "' + $cacheRoot + '"'); compile = $true; needsCache = $true; before = { param($cacheDir) $e = Join-Path $cacheDir 'EightMaxWorkbench.exe'; if (Test-Path -LiteralPath $e) { [IO.File]::AppendAllText($e, 'corrupted by the Milestone 3.1 test') } }; expect = { param($c) $w = & $okHealth $c; $s = $c.status; if (-not $s.compiled -or [string]$s.invalidCache -ne 'cached executable does not match its recorded hash') { $w += ' expected a recompile after corruption, got path ' + [string]$s.path + ' / ' + [string]$s.invalidCache + ';' }; return $w } },
        @{ id = 'invalid-manifest'; name = 'invalid cache: manifest of other sources is rebuilt'; extra = ('-ForceCompile -CacheRoot "' + $cacheRoot + '"'); compile = $true; needsCache = $true; before = { param($cacheDir) $man = Join-Path $cacheDir 'cache-manifest.json'; if (Test-Path -LiteralPath $man) { $m = [IO.File]::ReadAllText($man); $m2 = $m -replace '"path":"desktop/InputBroker.cs","sha256":"[0-9a-f]{64}"', ('"path":"desktop/InputBroker.cs","sha256":"' + ('0' * 64) + '"'); [IO.File]::WriteAllText($man, $m2, $script:M31Utf8) } }; expect = { param($c) $w = & $okHealth $c; $s = $c.status; if (-not $s.compiled -or [string]$s.invalidCache -notmatch 'cache manifest') { $w += ' expected a recompile after a foreign manifest, got path ' + [string]$s.path + ' / ' + [string]$s.invalidCache + ';' }; return $w } },
        @{ id = 'old-key'; name = 'an old (Milestone 2) cache key is never reused'; extra = ('-ForceCompile -CacheRoot "' + $cacheRoot + '"'); compile = $true; beforeAll = $true; expect = { param($c) $w = & $okHealth $c; $s = $c.status; if ([string]$s.cacheFolder -eq $script:M31OldKeyDir) { $w += ' used the old cache folder;' }; if ((Get-M31Sha256 $script:M31PlantedFile) -ne $script:M31PlantedHash) { $w += ' the planted file changed;' }; if ([string]$s.fingerprint -eq $script:M31OldKey) { $w += ' fingerprint equals the Milestone 2 key;' }; return $w } },
        @{ id = 'build-only'; name = 'build-only compiles or reuses without launching'; extra = ('-BuildOnly -CacheRoot "' + $cacheRoot + '"'); compile = $true; buildOnly = $true; expect = { param($s) if (-not $s -or @('cache', 'compiled') -notcontains [string]$s.path -or $s.launched) { return ' expected a build-only result without a launch, got path ' + [string]$s.path + ', launched ' + [string]$s.launched + ';' }; return '' } }
    )
    $n = 0; $cacheDir = $null
    foreach ($case in $cases) {
        if ($Only -and @($Only).Count -and -not (@($Only) -contains $case.id)) { continue }
        $n++
        Write-M31Log ''
        Write-M31Log ('  -- start case ' + $n + ': ' + $case.name + $(if ($case.extra) { '  (' + $case.extra + ')' } else { '' })) 'Cyan'
        if ($case.needsCache) {
            if (-not $cacheDir) { [void](Add-M31Check 'host-start' ($case.name + ' - prerequisite') 'SKIPPED' 'needs the cache built by "forced fallback compile with a fresh cache", which did not produce one'); continue }
            if ($case.before) { try { & $case.before $cacheDir } catch { [void](Add-M31Exception $_ 'host-start' ($case.name + ' - preparing the cache')) } }
        }
        if ($case.id -eq 'old-key') {
            try {
                $script:M31OldKey = Get-M31TextSha256 ((Get-FileHash -LiteralPath (Join-Path $AppRoot 'desktop\DesktopHost.cs') -Algorithm SHA256).Hash + (Get-FileHash -LiteralPath (Join-Path $AppRoot 'desktop\CaptureService.cs') -Algorithm SHA256).Hash)
                $script:M31OldKeyDir = Join-Path $cacheRoot $script:M31OldKey; [void][IO.Directory]::CreateDirectory($script:M31OldKeyDir)
                $script:M31PlantedFile = Join-Path $script:M31OldKeyDir 'EightMaxWorkbench.exe'; [IO.File]::WriteAllText($script:M31PlantedFile, 'not an executable: planted under the Milestone 2 cache key'); $script:M31PlantedHash = Get-M31Sha256 $script:M31PlantedFile
            } catch { [void](Add-M31Exception $_ 'host-start' ($case.name + ' - planting the old key')); continue }
        }
        $limit = $(if ($case.compile) { $CompileTimeoutSec } else { $LaunchTimeoutSec })
        $caseDir = Join-Path $WorkDir (('{0:00}' -f $n) + '-' + $case.id)
        $res = Invoke-M31HostCase -Id $case.id -Name $case.name -Extra $case.extra -Expect $case.expect -BuildOnly:([bool]$case.buildOnly) -CaseDir $caseDir -AppRoot $AppRoot -StartScript $StartScript -LaunchTimeoutSec $limit -ReadyTimeoutSec $ReadyTimeoutSec
        if ($case.id -eq 'prebuilt') {
            $ok = ($res.result -eq 'PASS'); Set-M31Gate 'desktop-host' $ok $(if ($ok) { 'prebuilt host started, answered, shut down' } else { 'the prebuilt host start case failed' })
            $iop = $res.operations['verify-input-driver']; Set-M31Gate 'input-driver' ([bool]($iop -and $iop.status -eq 'PASS')) $(if ($iop) { [string]$iop.detail } else { 'not checked' })
        }
        if ($case.id -eq 'fallback-fresh' -and $res.status -and $res.status.cacheFolder) {
            $cacheDir = [string]$res.status.cacheFolder; $ce = Join-Path $cacheDir 'EightMaxWorkbench.exe'
            $script:M31CacheExeHash = $(if (Test-Path -LiteralPath $ce) { Get-M31Sha256 $ce } else { '' })
        }
    }
    return $script:M31HostCaseResults.ToArray()
}
