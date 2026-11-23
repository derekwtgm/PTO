EightMax Test Workbench 0.36.2 Milestone 3.1 - raw evidence
============================================================

"Linux" means the development machine (x64, Node 22.23.5, PowerShell 7.4.6; no native engine, Mono or .NET SDK, so the tests that
need them are skipped there and run on Windows). "windows-ci-<run id>" files are real Windows runs (GitHub Actions windows-latest:
Windows Server 2025, Windows PowerShell 5.1, a real interactive desktop), copied from the results branches m31-results/<run id>-<job>
of derekwtgm/PTO. The operator's own result ZIPs are NOT copied here (they contain the operator's folder paths); only the analysis is.

Stage 1 - baseline
  stage1-baseline-verification-M3.json      Milestone 3 ZIP: SHA-256, entries, manifest, executable identities (before any change)
  baseline-M3-linux-node-tests.tap          complete Node suite on the unmodified Milestone 3 tree (Linux; pwsh was not installed then)

Stage 2-3 - the checksum false failure
  repro-checksum-M3-before-run1.tap         the unmodified Milestone 3 test with the operator's run-1 folder content: the failure on the
                                            run's own mwcli-build-id.err.txt, byte for byte as on the operator PC
  repro-checksum-M3-before.tap              the same with runs 1 and 2: the failure on run 1's host-prebuilt host launch.err.txt
  repro-checksum-M31-after.tap              the Milestone 3.1 tests on the same folders: pass; every tamper case still fails

Stage 5 - the host-start interruption
  operator-evidence-analysis.json           what the operator's two result ZIPs and the screen recording show (timeline, findings)
  S17-desktop-during-the-stop.jpg           Windows CI run 45275384911, scenario S17a: the desktop while the Milestone 3 start-up script
                                            waited on an INVISIBLE "Open File - Security Warning" (class #32770, visible 0) - nothing shows

Stages 8-9 - tests
  windows-ci-development-runs.json          every Windows CI development run of Milestone 3.1: scenario results, full-acceptance phases,
                                            the problems each run found and what was fixed before the next run
  windows-ci-45277279723-scenarios.json     the Windows scenario suite of development run 3 (25 of 25 passed)
  windows-ci-<run id>-full-results.txt      a complete full-acceptance report (RUN-0362-MILESTONE3.1-TESTS.cmd C) from Windows CI
  m31-linux-full-suite.tap                  the complete Node suite on the final Milestone 3.1 tree (Linux)

The validation records of the FINAL ZIP (its own Windows CI run) are outside the ZIP, next to it: WINDOWS-TEST-RUNNER-VALIDATION-3.1.json,
STARTUP-DIAGNOSTICS-VALIDATION-3.1.json, REGRESSION-3.1.json and REPORT-0.36.2-Milestone-3.1.md - a ZIP cannot contain the results of
tests run on itself.
