# EightMax Test Workbench 0.36.2 - Milestone 4.0 (in development: multi-table scheduler optimisation, 4K display recognition, input reliability, extended gameplay validation, ten-table feasibility)

| File | Contents |
|---|---|
| `m40-overlay/EightMax-Test-Workbench/` | every file Milestone 4.0 adds or changes relative to `EightMax-Test-Workbench-0.36.2-Milestone-3.2.zip`; `m40-overlay/DELETED.txt` lists removed files (none) |
| `.github/workflows/windows-0362-m40.yml` | Windows CI: build of the changed executables on Windows, package, Linux suite, baseline comparison, sustained multi-table play, full acceptance, T5; results on the branches `m40-results/<run id>-*` |
| `ci-request-m40.json` | which CI jobs the current commit requests |

Development in progress - the release ZIP and the report are added when the Windows validation is complete.

---

# EightMax Test Workbench 0.36.2 - Milestone 3.2 (input confirmation reliability, paused-window monitoring, target-loss recovery, multi-table isolation)

| File | Contents |
|---|---|
| `EightMax-Test-Workbench-0.36.2-Milestone-3.2.zip` | the complete release (1,464 entries); SHA-256 in `EightMax-Test-Workbench-0.36.2-Milestone-3.2.zip.sha256` |
| `REPORT-0.36.2-Milestone-3.2.md` | the development report: root cause, changes, test results, Windows CI results, acceptance criteria, limitations, the next test |
| `T5-ROOT-CAUSE-ANALYSIS-3.2.md` | the T5 failure of 2026-11-24: evidence, timeline, root cause, the unconfirmed Call |
| `T5-WINDOWS-VALIDATION-3.2.json`, `INPUT-CONFIRMATION-VALIDATION-3.2.json`, `LIFECYCLE-REGRESSION-3.2.json`, `MULTITABLE-REGRESSION-3.2.json` | the validation records |
| `READ-ME-MILESTONE3.2-TESTS.txt` | how to run the standalone T5 test on your own Windows PC (also inside the ZIP) |
| `m32-overlay/EightMax-Test-Workbench/` | every file Milestone 3.2 adds or changes relative to `EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip`, byte-identical to the same files in the ZIP; `m32-overlay/DELETED.txt` lists removed files (none) |
| `.github/workflows/windows-0362-m32.yml` | Windows CI of the committed ZIP: package verification, Linux suite, the standalone T5 test on separate machines (100 % and 125 % display scaling), full acceptance, Milestone 3.1 scenario suite; results on the branches `m32-results/<run id>-*` |
| `EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip` and the earlier files | the baseline (unchanged) |

Windows validation of this exact ZIP (SHA-256 `740e9c1fe853d8db0a57722cabbba78a66ad20525b63a7569fe51658cabeb54d`): GitHub Actions run
[45311974352](https://github.com/derekwtgm/PTO/actions/runs/45311974352) - the standalone T5 test (`RUN-M3.2-T5-TEST.cmd`) on 10 separate Windows
machines, 5 of them at a measured 125 % display scaling: 10/10 PASS (T5 10/10, T5P 10/10); full acceptance PASS, exit 0 (143 PASS, 0 FAIL,
0 WARNING, 5 SKIPPED by design; complete regression suite 1029 tests: 982 passed, 0 failed, 47 skipped; lifecycle A-K 11/11; gameplay T1-T6 and
T5P 7/7; multi-table 1/2/5/8 PASS); Milestone 3.1 scenario suite 26/26; Linux suite 1029 tests: 950 passed, 0 failed, 79 skipped.
All 17 acceptance criteria are met on Windows CI and Linux; the three development runs are listed in the report.
Not established: why the one Call on the operator PC was not applied (the oracle and diagnostic files of that run were not available; not marked
as fixed). The operator's own PC has not run Milestone 3.2 yet (pending). The EightMax 5.1 native solver (`native/mwcli.exe`, build
`7d08acc7eb4577ee`) is byte-identical; no executable was rebuilt.

---

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
