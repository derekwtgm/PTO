<# EightMax Test Workbench 0.36.2 Milestone 4.0 - plain-language summary of RUN-M4-PERFORMANCE-TEST.cmd (modes A-D) and the comparison
   checks of the scheduler benchmark. Dot-sourced by windows\Test-Milestone31.ps1. Windows PowerShell 5.1 and PowerShell 7; ASCII only.
   Inputs: the reports of tools\gameplay-acceptance-0362m3.cjs (stability / sustained suites) and tools\recognition-validation-040.cjs.
   Output: M4-SUMMARY.txt in the results folder. Every number is copied from a report of THIS run; nothing is estimated here. #>

# Read-M31LargeJson returns dictionaries on Windows PowerShell 5.1 (JavaScriptSerializer) and objects on PowerShell 7: read both
function Get-M40Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [Collections.IDictionary]) { foreach ($k in @($Object.Keys)) { if ([string]$k -ceq $Name) { return $Object[$k] } }; return $null }
    $p = $Object.PSObject.Properties[$Name]; if ($p) { return $p.Value }; return $null
}
function Get-M40Keys($Object) {
    if ($null -eq $Object) { return @() }
    if ($Object -is [Collections.IDictionary]) { return @($Object.Keys | ForEach-Object { [string]$_ }) }
    return @($Object.PSObject.Properties | ForEach-Object { $_.Name })
}
function Get-M40Path($Object, [string[]]$Names) { $o = $Object; foreach ($n in $Names) { $o = Get-M40Field $o $n; if ($null -eq $o) { return $null } }; return $o }
function Format-M40Number($Value, [int]$Digits = 0) { if ($null -eq $Value) { return 'n/a' }; try { return ([math]::Round([double]$Value, $Digits)).ToString([Globalization.CultureInfo]::InvariantCulture) } catch { return [string]$Value } }
function Format-M40Degradation($Doc, [string]$Id) {
    $d = Get-M40Path $Doc @('perDegradation', $Id); if (-not $d) { return 'not measured' }
    $n = [int](Get-M40Field $d 'frames'); $a = [int](Get-M40Field $d 'accepted'); $w = [int](Get-M40Field $d 'acceptedWithWrongValue')
    return ([string]$n + ' frames, ' + [string]$a + ' read (' + (Format-M40Number $(if ($n) { 100.0 * $a / $n } else { 0 }) 1) + ' %), ' + [string]($n - $a) + ' refused, accepted with a wrong value: ' + [string]$w)
}
function Get-M40Scenario($Doc, [string]$Id) { foreach ($s in @(Get-M40Field $Doc 'scenarios')) { if ([string](Get-M40Field $s 'id') -eq $Id) { return $s } }; return $null }
function Get-M40Row($Doc, [string]$Id) {
    $s = Get-M40Scenario $Doc $Id; if (-not $s) { return $null }
    $m = Get-M40Field $s 'metrics'; $ms = Get-M40Field $m 'measurements'
    return [ordered]@{ status = [string](Get-M40Field $s 'status'); tables = Get-M40Field $m 'tables'; seconds = Get-M40Field $m 'seconds'; confirmed = Get-M40Field $m 'actionsConfirmed'; hands = Get-M40Field $m 'completedHands'
        incorrect = Get-M40Field $m 'incorrectActions'; misses = Get-M40Path $ms @('deadlineMisses', 'byTables'); schedMean = Get-M40Path $ms @('schedulingDelayMs', 'mean'); schedP95 = Get-M40Path $ms @('schedulingDelayMs', 'p95')
        latMean = Get-M40Path $ms @('actionLatencyMs', 'mean'); latP95 = Get-M40Path $ms @('actionLatencyMs', 'p95'); uncertain = Get-M40Field $m 'uncertainOrUnconfirmed'; heroTimeouts = Get-M40Field $m 'heroTimeouts'
        perMinute = $(if ($null -ne (Get-M40Field $m 'seconds') -and [double](Get-M40Field $m 'seconds') -gt 0) { 60.0 * [double](Get-M40Field $m 'actionsConfirmed') / [double](Get-M40Field $m 'seconds') } else { $null }) }
}
<# Scheduler benchmark: one comparison check per table count (Milestone 3.2 pipeline vs Milestone 4.0 pipeline, same PC, same speed), and
   the Milestone 4.0 target (20-30 % lower scheduling delay at the largest table count) reported as measured: WARNING when it is not met. #>
function Add-M40Comparison($M40) {
    $a = $M40.docs['scheduler-compat-3.2']; $b = $M40.docs['scheduler-optimized']; $rows = New-Object Collections.ArrayList
    if (-not $a -or -not $b) { [void](Add-M31Check 'scheduler' 'comparison of the two input pipelines' 'FAIL' 'one of the two runs produced no report' 'harness'); return }
    $ids = @(Get-M40Field $a 'scenarios' | ForEach-Object { [string](Get-M40Field $_ 'id') })
    foreach ($id in $ids) {
        $x = Get-M40Row $a $id; $y = Get-M40Row $b $id; if (-not $x -or -not $y) { continue }
        $chg = $(if ($null -ne $x.schedMean -and [double]$x.schedMean -gt 0 -and $null -ne $y.schedMean) { 100.0 * ([double]$y.schedMean - [double]$x.schedMean) / [double]$x.schedMean } else { $null })
        $lchg = $(if ($null -ne $x.latMean -and [double]$x.latMean -gt 0 -and $null -ne $y.latMean) { 100.0 * ([double]$y.latMean - [double]$x.latMean) / [double]$x.latMean } else { $null })
        $row = [ordered]@{ scenario = $id; tables = $x.tables; compat = $x; optimized = $y; schedulingDelayChangePercent = $chg; latencyChangePercent = $lchg }; [void]$rows.Add($row)
        $d = [string]$x.tables + ' table(s): scheduling delay ' + (Format-M40Number $x.schedMean) + ' -> ' + (Format-M40Number $y.schedMean) + ' ms (' + (Format-M40Number $chg 1) + ' %), p95 ' + (Format-M40Number $x.schedP95) + ' -> ' + (Format-M40Number $y.schedP95) + ' ms; action latency ' + (Format-M40Number $x.latMean) + ' -> ' + (Format-M40Number $y.latMean) + ' ms; confirmed actions ' + [string]$x.confirmed + ' -> ' + [string]$y.confirmed + '; deadline misses ' + [string]$x.misses + ' -> ' + [string]$y.misses + '; incorrect actions ' + [string]$x.incorrect + ' -> ' + [string]$y.incorrect
        $safe = ([int]$y.incorrect -eq 0)
        [void](Add-M31Check 'scheduler' ('comparison at ' + [string]$x.tables + ' table(s): Milestone 3.2 pipeline -> Milestone 4.0 pipeline') $(if ($safe) { 'PASS' } else { 'FAIL' }) $d $(if ($safe) { $null } else { 'application' }))
    }
    $M40.comparison = $rows
    $last = $null; foreach ($r in $rows) { if (-not $last -or [int]$r.tables -gt [int]$last.tables) { $last = $r } }
    if ($last -and $null -ne $last.schedulingDelayChangePercent) {
        $red = -[double]$last.schedulingDelayChangePercent
        [void](Add-M31Check 'scheduler' ('Milestone 4.0 target: 20-30 % lower scheduling delay at ' + [string]$last.tables + ' tables (same PC, same mouse speed)') $(if ($red -ge 20) { 'PASS' } else { 'WARNING' }) ('measured ' + (Format-M40Number $red 1) + ' % lower (' + (Format-M40Number $last.compat.schedMean) + ' -> ' + (Format-M40Number $last.optimized.schedMean) + ' ms)' + $(if ($red -lt 20) { ': the target was not reached on this PC; the report states the measured value' } else { '' })))
    }
}
function Write-M40Summary($M40, [string]$Path) {
    $L = New-Object Collections.ArrayList
    [void]$L.Add('EightMax Test Workbench 0.36.2 - Milestone 4.0 performance test on this PC: what was measured, in plain language')
    [void]$L.Add('===========================================================================================================')
    [void]$L.Add('Every number below comes from a report in this folder (measured on this PC during this run). Nothing is estimated.')
    [void]$L.Add('')
    $rec = $M40.docs['recognition']
    if ($rec) {
        $fr = Get-M40Field $rec 'frames'; $v = Get-M40Field $rec 'verdict'
        [void]$L.Add('RECOGNITION (deterministic dataset: the test table as it is drawn at every size, 100-200 % display scaling)')
        [void]$L.Add('  frames read: ' + [string](Get-M40Field $fr 'accepted') + ' of ' + [string](Get-M40Field $fr 'total') + '; frames the automation would act on that held a wrong value: ' + [string](Get-M40Field $fr 'acceptedWithWrongValue') + $(if (Get-M40Field $v 'neverGuessed') { ' (never guessed)' } else { ' - SEE THE REPORT' }))
        foreach ($d in @('clean', 'noise', 'shift-1px', 'dim', 'dpi-stretched', 'blur', 'occluded')) { [void]$L.Add(('  {0,-14} {1}' -f $d, (Format-M40Degradation $rec $d))) }
        $g = Get-M40Field $rec 'geometry'; [void]$L.Add('  scaled (DPI-virtualised) captures refused as safety-critical: ' + [string](Get-M40Field $g 'refusedAsCritical') + ' of ' + [string](Get-M40Field $g 'dpiVirtualisedCaptures'))
        [void]$L.Add('')
    }
    $rw = $M40.docs['recognitionWindows']
    if ($rw) {
        [void]$L.Add('RECOGNITION ON REAL WINDOWS (this display, scaling ' + (Format-M40Number ([double](Get-M40Field $rw 'displayScale') * 100)) + ' %)')
        foreach ($t in @(Get-M40Field $rw 'tables')) { $vs = @(Get-M40Field $t 'verify'); $pass = @($vs | Where-Object { [string](Get-M40Field $_ 'verdict') -ne 'fail' }).Count; [void]$L.Add('  ' + [string](Get-M40Field $t 'width') + ' px: Verify Table Recognition ' + [string]$pass + '/' + [string]$vs.Count + ', strip-only capture = full frame ' + [string](Get-M40Field $t 'stripCropMatches') + '/' + [string](Get-M40Field $t 'stripCropChecks')) }
        [void]$L.Add('')
    }
    if ($M40.Contains('comparison') -and $M40.comparison) {
        [void]$L.Add('SCHEDULER BENCHMARK (the Milestone 3.2 multi-table workload, ' + [string]$M40.abSeconds + ' s per table count; same PC, same mouse speed 1 200 px/s)')
        [void]$L.Add('  tables  scheduling delay ms (M3.2 -> M4.0, change)   p95 ms           action latency ms     confirmed  misses  incorrect')
        foreach ($r in $M40.comparison) {
            $x = $r.compat; $y = $r.optimized
            [void]$L.Add(('  {0,6}  {1,8} -> {2,-8} {3,8} %     {4,6} -> {5,-6}  {6,6} -> {7,-6}  {8,4} -> {9,-4} {10,2} -> {11,-3} {12,2} -> {13}' -f [string]$x.tables, (Format-M40Number $x.schedMean), (Format-M40Number $y.schedMean), (Format-M40Number $r.schedulingDelayChangePercent 1), (Format-M40Number $x.schedP95), (Format-M40Number $y.schedP95), (Format-M40Number $x.latMean), (Format-M40Number $y.latMean), [string]$x.confirmed, [string]$y.confirmed, [string]$x.misses, [string]$y.misses, [string]$x.incorrect, [string]$y.incorrect))
        }
        $fast = $M40.docs['scheduler-optimized-fast']
        if ($fast) { [void]$L.Add('  Fast mouse preset (2 000 px/s), reported apart - NOT part of the comparison above:'); foreach ($s in @(Get-M40Field $fast 'scenarios')) { $z = Get-M40Row $fast ([string](Get-M40Field $s 'id')); [void]$L.Add('    ' + [string]$z.tables + ' table(s): scheduling delay ' + (Format-M40Number $z.schedMean) + ' ms, latency ' + (Format-M40Number $z.latMean) + ' ms, confirmed ' + [string]$z.confirmed + ', incorrect ' + [string]$z.incorrect) } }
        [void]$L.Add('')
    }
    $sus = @($M40.docs.Keys | Where-Object { [string]$_ -like 'sustained-*' })
    if ($sus.Count) {
        [void]$L.Add('UNINTERRUPTED PLAY (' + [string]$M40.sustainedMinutes + ' min per table count, Milestone 4.0 pipeline, no injected faults)')
        foreach ($k in $sus) { $d = $M40.docs[$k]; foreach ($s in @(Get-M40Field $d 'scenarios')) { $z = Get-M40Row $d ([string](Get-M40Field $s 'id')); [void]$L.Add('  ' + [string]$z.tables + ' tables: ' + $z.status.ToUpperInvariant() + '; ' + [string]$z.confirmed + ' confirmed actions (' + (Format-M40Number $z.perMinute 1) + '/min), ' + [string]$z.hands + ' hands, scheduling delay ' + (Format-M40Number $z.schedMean) + ' ms (p95 ' + (Format-M40Number $z.schedP95) + '), deadline misses ' + [string]$z.misses + ', incorrect actions ' + [string]$z.incorrect + ', unconfirmed ' + [string]$z.uncertain) } }
        [void]$L.Add('')
    }
    $fl = $M40.docs['faults']
    if ($fl) { [void]$L.Add('FAULT INJECTION (windows closed and reopened, emergency stops)'); foreach ($s in @(Get-M40Field $fl 'scenarios')) { $z = Get-M40Row $fl ([string](Get-M40Field $s 'id')); $fa = Get-M40Path $s @('metrics', 'faults'); [void]$L.Add('  ' + [string]$z.tables + ' tables: ' + $z.status.ToUpperInvariant() + '; faults ' + [string](ConvertTo-M31Json $fa) + '; confirmed ' + [string]$z.confirmed + ', incorrect actions ' + [string]$z.incorrect) }; [void]$L.Add('') }
    [void]$L.Add('Everything (the full report, every check, logs and the test tables'' own records) is in milestone3-results.zip in this folder')
    [void]$L.Add('(the Milestone 4.0 tests extend the Milestone 3.1 test runner and keep its file names). Send that ZIP back.')
    Write-M31AtomicText $Path (($L.ToArray() -join "`r`n") + "`r`n")
}
