# EightMax Test Workbench 0.36.2 - Milestone 3 (tournament hand tracking, simulator stability, test automation, Windows hardening)

**Development in progress - not a release yet.** The final package, report and evidence files are added to this branch when Milestone 3 is complete.

| Path | Contents |
|---|---|
| `m3-overlay/EightMax-Test-Workbench/` | every file that Milestone 3 adds or changes relative to `EightMax-Test-Workbench-0.36.2-Milestone-2.zip` (branch `milestone-2-0362`, SHA-256 `4518a133...febc32`), including the regenerated `SHA256SUMS.txt` |
| `.github/workflows/windows-0362-m3.yml` | Windows CI: assembles the package (Milestone 2 ZIP + overlay, or the final Milestone 3 ZIP once committed), verifies every checksum, parses every PowerShell script, then runs `windows/Test-Milestone3-0362.ps1` (the same script as `RUN-0362-MILESTONE3-TESTS.cmd`) with real windows. Results: job log, artifact, and branch `m3-results/<run id>` |

The EightMax 5.1 native solver (`native/mwcli.exe`, build `7d08acc7eb4577ee`) is not modified.
