EightMax Test Workbench 0.36.2 Milestone 3 - raw evidence
==========================================================

Every number in REPORT-0.36.2-Milestone-3.md and in the four *-0362M3.json records is read from the files in this folder
(tools/make-evidence-0362m3.py). "Linux" means the development machine (x64, Node 22.23.5, Chromium/Playwright, Mono 6.8):
results marked "fake" use the in-process fake desktop host (simulated capture and input) with the REAL fixture dealer, recognition,
hand tracker, scheduler and adapter - they are NOT Windows evidence. "windows-ci-<run id>" folders are real Windows runs (GitHub
Actions windows-latest: real windows, screen capture and input), copied from the results branch m3-results/<run id>.

Stage 1 - baseline
  baseline-verification-M2.json              Milestone 2 ZIP: SHA-256, entries, manifest, executable identities (verified before any change)
  baseline-M2-linux-node-tests.tap           complete Node suite on the unmodified Milestone 2 tree (Linux)
  baseline-M2-exit-audit.json                Milestone 2 lifecycle runner: 119 s from report to exit (the timer leak)
  windows-ci-45163715758-milestone2-runner.txt   the Milestone 2 Windows runner crashing on PowerShell 5.1 (run 45163715758)

Stage 2-3 - eliminated players, recovery
  repro-elimination-M2-before.json           tools/repro-elimination-stall-0362m3.cjs on the unmodified Milestone 2 tree: the stall
  repro-elimination-M3-after-2500.json       the same tool on Milestone 3, 2,500-chip stacks, 60 s
  repro-elimination-M3-after-1000.json       the same tool on Milestone 3, 1,000-chip stacks, played to the end of the tournament

Stage 4 - test-runner cleanup
  exit-audit-M3-lifecycle-fake-10runs.*      tools/exit-audit-0362m3.cjs: 10 runs of the lifecycle runner (fake host)
  exit-audit-M3-genuine-timeout.*            the same with a 2.5-s scenario limit: a real timeout is still a failure

Stage 6 - gameplay (fake host, Windows fixture size 800 px and the Windows run's dealer seeds)
  gameplay-acceptance-fake.*                 T1-T6
  gameplay-stability-fake.*                  1, 2, 5, 8 tables, 60 s each
  campaign-fake-5p400.*, -8p300.*, -8p1500.* long campaigns (120+ hands each), tournaments played to the end
  lifecycle-acceptance-fake.*                Milestone 2 scenarios A-K (no regression)
  lifecycle-stress-M3-120s.*                 8 tables, 120 s of closures, reopenings, minimising, handle reuse, emergency stops

Builds
  build-check.json                           Mono compile check of every C# component (outputs discarded) + fallback-compile source lists
  driver-build/                              the Windows build of EightMaxInput.exe (GitHub Actions run 45216843075): job record,
                                             windows\Build-Executables.ps1's own record, build log

Windows CI (real Windows; see REPORT section 10 for what each run found)
  windows-ci-45181140222/  run 1 (partial)      windows-ci-45202807377/  run 2 (runner defect, logs only)
  windows-ci-45203097931/  run 3 (37/47)        windows-ci-45217637720/  run 4 (49/50)
  windows-ci-<final run>/  the validation run recorded in evidence/windows-ci-runs.json

Regression
  m3-linux-full-suite.tap                    the complete Node suite on the final tree (Linux)
