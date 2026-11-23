<# EightMax Test Workbench 0.36.2 - MILESTONE 3 Windows runner, kept for compatibility (CI workflows, documents and the operator's habits).
   Milestone 3.1 replaces it with windows\Test-Milestone31.ps1, which keeps every Milestone 3 phase and check but writes its progress
   continuously, has a time limit on every step, records where a step stopped, separates application / harness / environment / time-out
   failures, never writes results into the application folder by default, and always ends with a report and a ZIP.
   Milestone 3 defects this replaces (operator PC, 2026-11-23): its results folder lay inside the application folder, so the release-
   checksum test failed on the runner's own logs; its phase state, report and ZIP were written only after the last phase, so the stop in
   the host-start phase left no report; it waited up to 900 s per start case without any output.
   The Milestone 3 parameters are accepted unchanged and passed on; this always runs the full acceptance (mode Full). #>
param([string]$OutDir, [switch]$FullSuite, [switch]$SkipAcceptance, [switch]$SkipStability, [int]$StabilitySeconds = 60, [string]$StabilityTables = '1,2,5,8', [int]$CampaignHands = 0, [int]$CampaignMinutes = 30, [string]$Phases = 'all')
$ErrorActionPreference = 'Stop'
$next = @{ Mode = 'Full'; StabilitySeconds = $StabilitySeconds; StabilityTables = $StabilityTables; CampaignHands = $CampaignHands; CampaignMinutes = $CampaignMinutes }
if ($OutDir) { $next.OutDir = $OutDir }
if ($FullSuite) { $next.FullSuite = $true }
if ($SkipAcceptance) { $next.SkipAcceptance = $true }
if ($SkipStability) { $next.SkipStability = $true }
if ($Phases -and $Phases -ne 'all') { $next.Phases = (@($Phases -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ -and $_ -ne 'results' -and $_ -ne 'machine' -and $_ -ne 'identity' }) + @(if ($Phases -match 'machine') { 'environment' }) + @(if ($Phases -match 'identity') { 'integrity' })) -join ',' }
& (Join-Path $PSScriptRoot 'Test-Milestone31.ps1') @next
exit $LASTEXITCODE
