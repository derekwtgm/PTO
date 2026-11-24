<# EightMax Test Workbench 0.36.2 Milestone 3.2 - plain-language summary of the standalone T5 test (RUN-M3.2-T5-TEST.cmd).
   Dot-sourced by windows\Test-Milestone31.ps1 (mode T5). Windows PowerShell 5.1 and PowerShell 7; ASCII only.
   Input: the report of tools\gameplay-acceptance-0362m3.cjs --suite t5 (t5-acceptance.json). Output: T5-SUMMARY.txt in the results folder. #>

function Get-M32Check($Scenario, [string]$Prefix) { foreach ($c in @($Scenario.checks)) { if ([string]$c.name -like ($Prefix + '*')) { return $c } }; return $null }
# Read-M31LargeJson returns dictionaries on Windows PowerShell 5.1 (JavaScriptSerializer) and objects on PowerShell 7: read both
function Get-M32Field($Object, [string]$Name) { if ($null -eq $Object) { return $null }; if ($Object -is [Collections.IDictionary]) { if ($Object.Contains($Name)) { return $Object[$Name] }; return $null }; $p = $Object.PSObject.Properties[$Name]; if ($p) { return $p.Value }; return $null }
function Format-M32Value($Value) { if ($null -eq $Value) { return 'n/a' }; if ($Value -is [string] -or $Value -is [ValueType]) { return [string]$Value }; return [string](ConvertTo-M31Json $Value) }

function Write-M32T5Summary($Doc, [string]$Path) {
    $L = New-Object Collections.ArrayList
    $sum = Get-M32Field $Doc 'summary'; $warnN = [int](Get-M32Field $sum 'withWarnings')
    [void]$L.Add('EightMax Test Workbench 0.36.2 - Milestone 3.2 standalone T5 test: what happened, in plain language')
    [void]$L.Add('====================================================================================================')
    [void]$L.Add('Real-window result: ' + [string]$Doc.overall + ' - ' + [string]$sum.passed + ' of ' + [string]$sum.scenarios + ' scenarios passed' + $(if ($warnN) { ' (' + $warnN + ' with a warning)' } else { '' }) + '; process cleanup ' + $(if ($sum.cleanupOk) { 'OK' } else { 'NOT clean' }))
    [void]$L.Add('')
    [void]$L.Add('What is tested: two EightMax test tables play at the same time; then the window of table 2 is closed.')
    [void]$L.Add('  T5   table 2 is playing when its window closes.')
    [void]$L.Add('  T5P  table 2 is first PAUSED because one of its clicks reached the table but was not applied (made to happen on purpose: the')
    [void]$L.Add('       situation on your PC on 2026-11-24), then its window closes. Milestone 3.1 never noticed a close in this state.')
    [void]$L.Add('A scenario passes when table 2 is recognised as lost (TARGET_LOST), its input permission is withdrawn (scheduler), no further')
    [void]$L.Add('mouse input goes to it, and table 1 keeps playing normally with every action matching its own table.')
    [void]$L.Add('A WARNING on "input confirmation" means an action was sent but could not be confirmed (other than the one T5P causes on purpose).')
    [void]$L.Add('The safety handling is still checked by the other assertions; the evidence of that action is saved for investigation.')
    [void]$L.Add('')
    foreach ($s in @($Doc.scenarios)) {
        $m = $s.metrics
        [void]$L.Add(('{0,-7} {1,-8} {2}' -f [string]$s.id, ([string]$s.status).ToUpperInvariant(), [string]$s.name))
        $c5 = Get-M32Check $s '5.'; $c6 = Get-M32Check $s '6.'; $c7 = Get-M32Check $s '7.'; $c8 = Get-M32Check $s '8a.'; $cp = Get-M32Check $s 'P1.'
        if ($m -and (Get-M32Field $m 'beforeClose')) { $b = $m.beforeClose; [void]$L.Add('        before the close: table 2 ' + [string]$b.lifecycle + $(if ($b.cause) { ' (' + [string]$b.cause + ')' } else { '' }) + $(if ($b.gameplayPaused) { ', gameplay paused' } else { '' }) + ', ' + [string]$b.confirmed + ' confirmed actions') }
        if ($cp) { [void]$L.Add('        pause caused on purpose: ' + $(if ($cp.pass) { 'yes - safety pause "input-rejected", the click was not repeated' } else { 'NOT as expected: ' + (Format-M32Value $cp.detail) })) }
        if ($c5) { $d = $c5.detail; [void]$L.Add('        window closed -> ' + $(if ($c5.pass) { 'TARGET_LOST after ' + (Format-M32Value (Get-M32Field $d 'detectMs')) + ' ms (found by ' + (Format-M32Value (Get-M32Field $d 'source')) + ', state before: ' + (Format-M32Value (Get-M32Field $d 'previousState')) + ')' } else { 'NOT recognised as lost (state ' + (Format-M32Value (Get-M32Field $d 'state')) + ')' })) }
        if ($c6) { [void]$L.Add('        scheduler: ' + $(if ($c6.pass) { 'only table 2 blocked, its registration revoked' } else { 'NOT as expected: ' + (Format-M32Value (Get-M32Field $c6.detail 'unavailableTables')) })) }
        if ($c7) { [void]$L.Add('        input to the closed window after the loss: ' + (Format-M32Value (Get-M32Field $c7.detail 'afterLoss'))) }
        if ($c8) { [void]$L.Add('        table 1 afterwards: ' + $(if ($c8.pass) { 'kept playing' } else { 'DID NOT keep playing' }) + ' ' + (Format-M32Value $c8.detail)) }
        $un = @(); if ($m -and (Get-M32Field $m 'unconfirmedInputs')) { $un = @($m.unconfirmedInputs) }
        if ($un.Count) { foreach ($u in $un) { [void]$L.Add('        unconfirmed input: table ' + [string]$u.table + ' ' + [string]$u.control + ' -> ' + [string]$u.inputStatus) } }
        if ($m -and (Get-M32Field $m 'evidenceFiles') -and @($m.evidenceFiles).Count) { [void]$L.Add('        evidence files (work-t5\): ' + (@($m.evidenceFiles) -join ', ')) }
        foreach ($c in @($s.checks)) { if (-not $c.pass) { $d = Format-M32Value $c.detail; if ($d.Length -gt 300) { $d = $d.Substring(0, 300) + '...' }; [void]$L.Add('        ' + $(if ($c.warning) { 'WARNING' } else { 'FAILED ' }) + ' ' + [string]$c.name + ': ' + $d) } }
        if ($s.diagnostics) { [void]$L.Add('        diagnostics: work-t5\' + [string]$s.diagnostics) }
        [void]$L.Add('')
    }
    [void]$L.Add('Everything (the full report, every check, logs, the test tables'' own records and any evidence) is in milestone3-results.zip')
    [void]$L.Add('in this folder. Send that ZIP back.')
    Write-M31AtomicText $Path (($L.ToArray() -join "`r`n") + "`r`n")
}
