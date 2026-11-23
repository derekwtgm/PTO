# EightMax Test Workbench 0.36.2 - Milestone 3 (tournament hand tracking, simulator stability, test automation, Windows hardening)

| File | Contents |
|---|---|
| `EightMax-Test-Workbench-0.36.2-Milestone-3.zip` | the complete release (1,415 entries); SHA-256 in `EightMax-Test-Workbench-0.36.2-Milestone-3.zip.sha256` |
| `EightMax-Test-Workbench-0.36.2-Milestone-3-verification.json` | the ZIP extracted into an empty folder: CRCs, every checksum-manifest entry, executable identities, and the complete test suite run from the extracted copy (`...-verification-tests.tap`) |
| `REPORT-0.36.2-Milestone-3.md` | the development report (also inside the ZIP) |
| `HAND-TRACKING-VALIDATION-0362M3.json`, `GAMEPLAY-STRESS-0362M3.json`, `WINDOWS-VALIDATION-0362M3.json`, `REGRESSION-0362M3.json` | the validation records (also inside the ZIP) |
| `READ-ME-MILESTONE3-TESTS.txt` | how to run the Milestone 3 tests on your own Windows PC |
| `.github/workflows/windows-0362-m3.yml` | Windows CI of the committed ZIP (real windows on `windows-latest`); results on branch `m3-results/<run id>` |
| `.github/workflows/windows-0362-m3-driver-build.yml` | the Windows build of `EightMaxInput.exe` used in this release (run 45216843075) |

Windows validation of the final development tree: GitHub Actions run 45225443410, 51 of 51 checks passed. The run of this exact ZIP,
45236322220, also passed 51 of 51 checks (recorded in the verification file). The operator's own PC has not run the tests yet (pending).
The EightMax 5.1 native solver (`native/mwcli.exe`, build `7d08acc7eb4577ee`) is byte-identical to Milestone 2.
