# Development acceptance runner. An unexecuted mandatory GUI check is never a pass.
param([string]$OutDir,[switch]$Matrix)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if(-not $OutDir){$OutDir=Join-Path $env:LOCALAPPDATA 'EightMax-Test-Workbench\Acceptance-0.36.1'}
New-Item -ItemType Directory -Force $OutDir | Out-Null
$checks=[ordered]@{}
$node=Join-Path $root 'runtime\node\node.exe'
Push-Location $root
try {
  $bad=@()
  foreach($line in Get-Content SHA256SUMS.txt){
    if($line -notmatch '^([0-9a-f]{64})  (.+)$'){throw 'Malformed SHA256 manifest'}
    $expected=$Matches[1];$name=$Matches[2]
    if((Get-FileHash -LiteralPath $name -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){$bad+=$name}
  }
  $checks.integrity=if($bad.Count -eq 0){'passed'}else{'failed'}
  if($bad.Count){throw ('Checksum mismatch: '+($bad -join ', '))}
  foreach($exe in 'EightMaxWorkbench.exe','EightMaxInput.exe','EightMaxTestTable.exe'){
    $v=(Get-Item (Join-Path 'desktop\bin' $exe)).VersionInfo.FileVersion
    $checks[$exe]=if($v -eq '0.36.2.0'){'passed'}else{'unverified: binary is '+$v}
    if($v -ne '0.36.2.0'){throw ('Rebuilt 0.36.1 binary required: '+$exe)}
  }
  $id=& .\native\mwcli.exe --build-id
  $checks.engine=if($LASTEXITCODE -eq 0 -and $id -eq 'EightMaxBuild=7d08acc7eb4577ee'){'passed'}else{'failed'}
  if($checks.engine -ne 'passed'){throw 'Engine identity failed'}
  & .\desktop\bin\EightMaxInput.exe --selftest --out (Join-Path $OutDir 'input-selftest.json')
  $checks.inputSelfTest=if($LASTEXITCODE -eq 0){'passed'}else{'failed'}
  & $node tools\input-acceptance-035.cjs --out (Join-Path $OutDir 'input-acceptance.json') --oracle-dir (Join-Path $OutDir 'oracle')
  $checks.inputAcceptance=if($LASTEXITCODE -eq 0){'passed'}else{'failed'}
  if($Matrix){foreach($pattern in 'straight','fixed','random'){foreach($speed in 600,1200,2000){
    $name=$pattern+'-'+$speed
    & $node tools\simulator-benchmark-035.cjs --tables 1,2,5,8,10 --seconds 60 --pattern $pattern --speed $speed --out (Join-Path $OutDir ($name+'.json')) --work (Join-Path $OutDir $name)
    $checks[$name]=if($LASTEXITCODE -eq 0){'executed: inspect per-table reliability'}else{'failed'}
  }}}else{$checks.matrix='unexecuted: use -Matrix'}
} catch {$checks.error=$_.Exception.Message} finally {
  Pop-Location
  $report=[ordered]@{version='0.36.2-dev';at=[DateTime]::UtcNow.ToString('o');checks=$checks;fullyOperationalAcceptancePassed=$false;unverified=@('Dashboard launcher-to-three-hand demonstration','Validated strict-mode Windows action','Physical manual override and hotkey during active movement','Installation/uninstallation/two-version rollback','Exact target PC 3840x2160 at 150% scaling')}
  $report | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 (Join-Path $OutDir 'acceptance-0361.json')
}
Write-Host 'Development checks recorded. Mandatory interactive acceptance remains unverified; release NOT certified.'
exit 1
