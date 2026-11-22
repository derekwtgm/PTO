# Run visible input only against the bundled controlled simulator.
param([string]$OutDir, [switch]$Matrix)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Common.ps1')
if (-not $OutDir) { $OutDir = Join-Path $env:LOCALAPPDATA 'EightMax-Test-Workbench\Acceptance-0.36.2' }
[IO.Directory]::CreateDirectory($OutDir) | Out-Null
$checks = New-Object Collections.Generic.List[object]
$started = [DateTime]::UtcNow.ToString('o')
function Check($name, [scriptblock]$body, $evidence) {
  $start = [DateTime]::UtcNow.ToString('o'); $status='passed'; $errorText=$null
  try { & $body } catch { $status='failed'; $errorText=$_.Exception.Message }
  $checks.Add([ordered]@{name=$name;environment='Windows '+[Environment]::OSVersion.VersionString;startedAt=$start;completedAt=[DateTime]::UtcNow.ToString('o');status=$status;evidence=$evidence;error=$errorText})
}
function NativeCheck($name,$exe,$arguments,$resultFile,$timeout=180) {
  Check $name {
    $result=Invoke-EmTool -Executable $exe -Arguments $arguments -Folder $OutDir -Name $name -Seconds $timeout
    if($result.timedOut -or $result.exit -ne 0){throw ('Tool did not complete successfully: '+($result | ConvertTo-Json -Compress))}
    if(-not(Test-Path $resultFile)){throw 'Expected evidence was not produced'}
    $doc=Get-Content -Raw $resultFile | ConvertFrom-Json
    if($doc.ok -ne $true){throw 'Executed acceptance checks did not all pass'}
  } $resultFile
}
Push-Location $root
try {
  Check 'integrity' {
    foreach($line in Get-Content SHA256SUMS.txt){
      if($line -notmatch '^([0-9a-f]{64})  (.+)$'){throw 'Malformed checksum manifest'}
      $expected=$Matches[1];$file=$Matches[2]
      if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw ('Checksum mismatch: '+$file)}
    }
  } 'SHA256SUMS.txt'
  Check 'current-Windows-binaries' {
    foreach($name in 'EightMaxWorkbench.exe','EightMaxInput.exe','EightMaxTestTable.exe'){
      if((Get-Item (Join-Path 'desktop\bin' $name)).VersionInfo.FileVersion -ne '0.36.2.0'){throw ('Expected version 0.36.2.0: '+$name)}
    }
  } 'evidence/build-evidence.json'
  Check 'EightMax-5.1' {
    if((Get-FileHash native\mwcli.exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedEightMaxHash){throw 'Native solver hash mismatch'}
    $id=& .\native\mwcli.exe --build-id
    if($LASTEXITCODE -ne 0 -or $id -ne ('EightMaxBuild='+$ExpectedEightMaxBuild)){throw 'Native solver identity mismatch'}
  } 'native/mwcli.exe'
  if(@($checks | Where-Object {$_.status -eq 'failed'}).Count -eq 0){
    $node=Join-Path $root 'runtime\node\node.exe'
    NativeCheck 'input-selftest' (Join-Path $root 'desktop\bin\EightMaxInput.exe') @('--selftest','--out',(Join-Path $OutDir 'input-selftest.json')) (Join-Path $OutDir 'input-selftest.json')
    NativeCheck 'input-acceptance' $node @('tools\input-acceptance-035.cjs','--out',(Join-Path $OutDir 'input-acceptance.json'),'--oracle-dir',(Join-Path $OutDir 'oracle')) (Join-Path $OutDir 'input-acceptance.json')
    if($Matrix){
      foreach($pattern in 'straight','fixed','random'){foreach($speed in 600,1200,2000){
        $name='matrix-'+$pattern+'-'+$speed;$report=Join-Path $OutDir ($name+'.json')
        Check $name {
          $result=Invoke-EmTool -Executable $node -Arguments @('tools\simulator-benchmark-035.cjs','--tables','1,2,5,8,10','--seconds','60','--pattern',$pattern,'--speed',"$speed",'--out',$report,'--work',(Join-Path $OutDir $name)) -Folder $OutDir -Name $name -Seconds 1200
          if($result.timedOut -or $result.exit -ne 0){throw 'Benchmark execution failed'}
          $doc=Get-Content -Raw $report | ConvertFrom-Json
          foreach($workload in $doc.workloads){$baseline=if($workload.name -eq 'stress'){2}else{5};foreach($run in $workload.runs){if($run.tables -le $baseline -and $run.reliable -ne $true){throw ('Baseline reliability failed: '+$workload.name+' '+$run.tables)}}}
        } $report
      }}
    }
  }
} finally {
  Pop-Location
  $unexecuted=@('dashboard-three-consecutive-hands','validated-strict-EightMax-action','physical-manual-override','installation-uninstallation-rollback','target-PC-125-and-150-percent')
  if(-not $Matrix){$unexecuted+='multi-table-motion-matrix'}
  foreach($name in $unexecuted){$checks.Add([ordered]@{name=$name;environment='requires separate recorded execution';startedAt=$null;completedAt=$null;status='skipped';evidence=$null;error='Not executed by this runner; cannot certify this requirement'})}
  $passed=@($checks | Where-Object {$_.status -eq 'passed'}).Count
  $failed=@($checks | Where-Object {$_.status -eq 'failed'}).Count
  $skipped=@($checks | Where-Object {$_.status -eq 'skipped'}).Count
  $accepted=($checks.Count -gt 0 -and $failed -eq 0 -and $skipped -eq 0)
  $report=[ordered]@{format='eightmax-0362-acceptance';version='0.36.2-dev';startedAt=$started;completedAt=[DateTime]::UtcNow.ToString('o');checks=@($checks.ToArray());passed=$passed;failed=$failed;skipped=$skipped;fullyOperationalAcceptancePassed=$accepted;releaseDecision=$(if($accepted){'accepted'}else{'not-accepted'})}
  Write-WorkbenchUtf8 (Join-Path $OutDir 'acceptance-0362.json') ($report | ConvertTo-Json -Depth 12)
}
Write-Host ('Acceptance: '+$passed+' passed, '+$failed+' failed, '+$skipped+' skipped. '+$report.releaseDecision)
if(-not $accepted){exit 1}
