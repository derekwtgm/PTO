# EightMax Test Workbench 0.36.2 - Milestone 4.0 (multi-table input performance, mouse speed control, recognition at display scaling, input-confirmation reliability, extended tests, ten-table feasibility)

| File | Contents |
|---|---|
| `EightMax-Test-Workbench-0.36.2-Milestone-4.0.zip` | the complete release (1,487 entries); SHA-256 in `EightMax-Test-Workbench-0.36.2-Milestone-4.0.zip.sha256` |
| `REPORT-0.36.2-Milestone-4.0.md` | the development report: what changed, before/after on the same machines, lease composition, policies, mouse input, recognition, input-confirmation reliability, 30-minute runs, ten tables, safety, the twenty questions, validation status, known issues, Milestone 4.1 priorities |
| `TEN-TABLE-FEASIBILITY-4.0.md` | the ten-table question: method, measurements, criteria, model, limits |
| `SCHEDULER-PERFORMANCE-4.0.json`, `MOUSE-INPUT-PERFORMANCE-4.0.json`, `RECOGNITION-VALIDATION-4.0.json`, `MULTITABLE-STRESS-4.0.json`, `WINDOWS-VALIDATION-4.0.json`, `REGRESSION-4.0.json` | the evidence records (every number names its CI run, job and result file) |
| `READ-ME-MILESTONE4-TESTS.txt` | how to run `RUN-M4-PERFORMANCE-TEST.cmd` (modes A-E) on your own Windows PC (also inside the ZIP) |
| `m40-overlay/EightMax-Test-Workbench/` | every file Milestone 4.0 adds or changes relative to `EightMax-Test-Workbench-0.36.2-Milestone-3.2.zip` (the three executables rebuilt on Windows are in the ZIP); `m40-overlay/DELETED.txt` lists removed files (none) |
| `.github/workflows/windows-0362-m40.yml`, `ci-request-m40.json` | Windows CI of the committed ZIP; results on the branches `m40-results/<run id>-*` |
| `m40-evidence/` | the job log of the final run's Linux job, attempt 2 (its results-branch push was rejected because attempt 1 had created the branch; `REGRESSION-4.0.json` cites it) |

Windows validation of this exact ZIP (SHA-256 `ab85ee9215daedd5ad72d9bb4e10f1924b82dd719d8e6caf76f8dcf5d6b22f0e`): GitHub Actions run
[45441870852](https://github.com/derekwtgm/PTO/actions/runs/45441870852) (and [45451149720](https://github.com/derekwtgm/PTO/actions/runs/45451149720) for the repeated 5-table run) -
same-machine comparison of the Milestone 3.2 workload at 8 tables on three machines: scheduling delay **-20.4 / -22.0 / -21.4 %**, action latency -16.5 %,
0 incorrect actions; 30 minutes at 8 tables: 66.7 → 78.7 actions/min, missed deadlines 96 → 41; **ten tables validated** with one hero seat per
table and a 12 s or 15 s table clock (30 minutes each, every criterion met), not with an 8 s clock; recognition 0 wrong values in 1,620 dataset frames and
3,016 / 3,016 on real windows at 100-175 % (3840 x 2160 not available on CI); mouse motion at 400-2,800 px/s exact; full acceptance PASS (143 / 0 / 0 / 5);
T5 / T5P PASS on 5 machines (2 at 125 %); Linux suite PASS.
Open: about 1 in 1,400 optimized-pipeline actions (0-0.4 % per 30-minute run) is "delivered, not applied" (detected, never repeated, cause not established; never with the
Milestone 3.2 sequence on CI). Your own PC has not run Milestone 4.0 yet (`RUN-M4-PERFORMANCE-TEST.cmd`, modes A and B first). The EightMax 5.1
native solver (`native/mwcli.exe`, build `7d08acc7eb4577ee`) is byte-identical.

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
