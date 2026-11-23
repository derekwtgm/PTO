# EightMax Test Workbench 0.36.2 — Milestone 2 (simulator window lifecycle)

Development build, **acceptance incomplete**: validated on Linux only; the Windows run is pending.

| File | Contents |
|---|---|
| `EightMax-Test-Workbench-0.36.2-Milestone-2.zip` | complete application, unchanged Windows executables, preserved EightMax 5.1 (build 7d08acc7eb4577ee), full source, tests, Windows test runner |
| `EightMax-Test-Workbench-0.36.2-Milestone-2.zip.sha256` | package checksum |
| `REPORT-0.36.2-Milestone-2.md` | development report (root cause, changes, tests, what remains unverified) |
| `EightMax-Test-Workbench-0.36.2-Milestone-2-verification.json` | re-verification of the extracted package (Linux) |
| `evidence/changes-M1-to-M2.diff` | source diff from Milestone 1 (START.html excluded: generated) |
| `evidence/verify-*` | raw TAP / JSON results of the extracted-package checks |
| `.github/workflows/windows-0362-m2.yml` | Windows CI: parses every PowerShell script, then runs `windows/Test-Milestone2-0362.ps1` (same as `RUN-0362-MILESTONE2-TESTS.cmd`) on the package |

On the target PC: extract the ZIP into a new folder and run `RUN-0362-MILESTONE2-TESTS.cmd` (see `READ-ME-MILESTONE2-TESTS.txt` inside).
