# EightMax Test Workbench 0.36.2 - Milestone 3.1 (Windows test-runner repair, startup diagnostics, crash recovery, reliable reports)

| File | Contents |
|---|---|
| `EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip` | the complete release (1,444 entries); SHA-256 in `EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip.sha256` |
| `REPORT-0.36.2-Milestone-3.1.md` | the development report: root causes, changes, test results, Windows CI results, what is not yet verified, the next test |
| `WINDOWS-TEST-RUNNER-VALIDATION-3.1.json`, `STARTUP-DIAGNOSTICS-VALIDATION-3.1.json`, `REGRESSION-3.1.json` | the validation records of this exact ZIP |
| `READ-ME-MILESTONE-3.1.txt` | how to run the Milestone 3.1 tests on your own Windows PC (also inside the ZIP) |
| `m31-overlay/EightMax-Test-Workbench/` | the Milestone 3.1 changes, browsable: every file Milestone 3.1 adds or changes relative to `EightMax-Test-Workbench-0.36.2-Milestone-3.zip`, byte-identical to the same files in the ZIP; `m31-overlay/DELETED.txt` lists removed files (none) |
| `.github/workflows/windows-0362-m31.yml` | Windows CI of the committed ZIP: package verification, the Windows scenario suite and the full acceptance (`RUN-0362-MILESTONE3.1-TESTS.cmd C`); results on the branches `m31-results/<run id>-scenarios` and `m31-results/<run id>-full` |
| `EightMax-Test-Workbench-0.36.2-Milestone-3.zip` and the Milestone 3 files | the baseline (unchanged; the Windows scenarios use it to reproduce the Milestone 3 failures) |

Windows validation of this exact ZIP: GitHub Actions run [45284015577](https://github.com/derekwtgm/PTO/actions/runs/45284015577) - scenario suite 26 of 26 passed, full acceptance PASS, exit 0 (`RUN-0362-MILESTONE3.1-TESTS.cmd C`; complete regression suite 1001 tests: 954 passed, 0 failed, 47 skipped).
Repetition of the scenario suite on the same ZIP: run [45284068127](https://github.com/derekwtgm/PTO/actions/runs/45284068127), 26 of 26 passed. All 15 acceptance criteria are met on Windows CI and Linux.
The operator's own PC has not run Milestone 3.1 yet (pending). The EightMax 5.1 native solver (`native/mwcli.exe`, build `7d08acc7eb4577ee`)
is byte-identical to Milestone 3; no executable was rebuilt.
