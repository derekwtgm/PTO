<# EightMax 0.36.2 Milestone 3.1 TEST FIXTURE - stands in for windows\Start-Desktop.ps1 in the runner self-checks and fault scenarios
   (-StartScript). Same parameters and the same status / trace records; it starts tests\fixtures\m31\fake-desktop-host.cjs instead of the
   desktop host. $env:EIGHTMAX_FAKE_HOST_MODE: ok (default), exit, noready, badsession, noshutdown (passed to the fake host), or
   script-fail (the script itself fails at its release check) / script-hang (the script stops responding at its launch step, as the
   Milestone 3 start-up script did on the operator PC). Never used by the release itself. #>
param([switch]$BuildOnly, [switch]$Headless, [string]$ReadyFile, [switch]$ForceCompile, [string]$CacheRoot, [string]$StatusFile, [string]$TraceFile)
$ErrorActionPreference = 'Stop'
$mode = $env:EIGHTMAX_FAKE_HOST_MODE; if (-not $mode) { $mode = 'ok' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
$utf8 = New-Object Text.UTF8Encoding($false)
$status = [ordered]@{ format = 'eightmax-desktop-start'; version = 1; at = [DateTime]::UtcNow.ToString('o'); path = 'prebuilt'; fixture = $true; fixtureMode = $mode; launched = $false; pid = $null; launchMethod = $null; error = $null }
function Write-Trace([string]$Step, [string]$State, [string]$Detail) { if ($TraceFile) { $e = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); pid = $PID; step = $Step; state = $State; detail = $Detail }; [IO.File]::AppendAllText($TraceFile, (ConvertTo-Json -InputObject $e -Compress) + "`r`n", $utf8) } }
function Write-Status { if ($StatusFile) { [IO.File]::WriteAllText($StatusFile, (ConvertTo-Json -InputObject $status -Compress), $utf8) } }
Write-Trace 'script' 'start' ('fixture mode ' + $mode)
try {
    Write-Trace 'release-verification' 'start' 'fixture'
    if ($mode -eq 'script-fail') { throw 'Release verification failed: simulated failure of the start-up script (test fixture, mode script-fail)' }
    Write-Trace 'release-verification' 'end' 'fixture'
    if ($BuildOnly) { $status.path = 'cache'; Write-Status; Write-Trace 'script' 'end' 'build-only'; exit 0 }
    $nodeExe = $(if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { Join-Path $root 'runtime\node\node.exe' } else { (Get-Command node).Source })
    Write-Trace 'launch-host' 'start' ('CreateProcess: fake host, mode ' + $mode)
    if ($mode -eq 'script-hang') { Start-Sleep -Seconds 3600 }
    $base = Join-Path ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReadyFile))) ([IO.Path]::GetFileNameWithoutExtension($ReadyFile))
    $sp = @{ FilePath = $nodeExe; ArgumentList = ('"' + (Join-Path $PSScriptRoot 'fake-desktop-host.cjs') + '" --ready "' + $ReadyFile + '" --mode ' + $mode); RedirectStandardOutput = ($base + '.host-stdout.txt'); RedirectStandardError = ($base + '.host-stderr.txt'); PassThru = $true }
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $sp.WindowStyle = 'Hidden' }
    if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $p = Start-Process @sp }
    else {
        # PowerShell 7 on Linux copies redirected output through this (short-lived) process and re-joins argument arrays; start the
        # shell with exact arguments and let it redirect, as Windows does with inherited file handles
        $psi = New-Object Diagnostics.ProcessStartInfo('/bin/sh'); $psi.UseShellExecute = $false
        foreach ($a in @('-c', 'exec "$0" "$1" --ready "$2" --mode "$3" >"$4" 2>"$5"', $nodeExe, (Join-Path $PSScriptRoot 'fake-desktop-host.cjs'), $ReadyFile, $mode, ($base + '.host-stdout.txt'), ($base + '.host-stderr.txt'))) { $psi.ArgumentList.Add($a) }
        $p = [Diagnostics.Process]::Start($psi)
    }
    $status.launched = $true; $status.pid = $p.Id; $status.launchMethod = 'CreateProcess'; Write-Status
    Write-Trace 'launch-host' 'end' ('pid ' + $p.Id)
    Write-Trace 'script' 'end' 'host launched: exit 0'
    exit 0
} catch {
    $status.error = $_.Exception.Message; Write-Status
    Write-Trace 'script' 'error' $_.Exception.Message
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
