GitHub Actions run 45181140222 (https://github.com/derekwtgm/PTO/actions/runs/45181140222) - first Milestone 3 Windows run,
GitHub-hosted windows-latest (Windows Server 2025 Datacenter build 26100, real desktop), CANCELLED after 2 h. Files as published
by the run to branch m3-results/45181140222.
What it shows (real Windows): executable identities and release checksums pass; native\mwcli.exe --build-id printed
EightMaxBuild=7d08acc7eb4577ee; the complete regression suite ran with the bundled Node.js: 951 tests, 885 passed, 1 failed (the
repository's structural PowerShell lint misread a '#' inside a string of the new runner - fixed), 65 skipped (results/unit-tests.tap);
the prebuilt desktop host started headless and wrote its session file.
What went wrong (defects of the NEW Milestone 3 runner, all fixed before the next run): the launcher's status record was not written
(JavaScriptSerializer on Windows PowerShell 5.1), the check then threw before shutting the host down, the left-over host kept port
48713 busy (every later phase failed with "port in use") and Start-Process -Wait in the workflow waited for that host for 2 hours;
the runner's TAP summary parsing matched a test's "# PASS 10-table ..." diagnostic line (case-insensitive -match), so
milestone3-results.json shows "passed: 10" instead of 885 - the raw TAP above is authoritative.
Superseded by the later Milestone 3 Windows runs recorded in WINDOWS-VALIDATION-0362M3.json.
