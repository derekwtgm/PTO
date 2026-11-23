# EightMax Test Workbench 0.36.2 — Milestone 3.1 development report

**Windows test-runner repair, startup diagnostics, crash recovery and reliable test reporting** · 2026-11-23 · release `EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip` (SHA-256 `49d0d7a4cf3c4e1e130b5d0a2d08f9dc9fe97419cd3651deae9460aa642bdf1f`)

## 1. Summary

Milestone 3.1 repairs the Windows test runner that failed on your PC on 2026-11-23. Both problems are explained and were reproduced: the release-checksum test failed on the runner's own log files (reproduced byte for byte), and the host-start step stopped because the Milestone 3 start-up script launched the desktop host through the Windows shell, which — for files extracted from a downloaded ZIP — waits on a security prompt that was invisible because the script had been started hidden (reproduced on real Windows).

The new main launcher `RUN-0362-MILESTONE3.1-TESTS.cmd` (A quick, B start-up diagnostics, C full acceptance, D package an earlier run) and the standalone `RUN-M3-HOST-DIAGNOSTIC-3.1.cmd` save every check the moment it completes, put a time limit on every step, classify every failure (application / harness / environment / timeout), keep the results outside the application folder, and always end with a report and a ZIP — also after an exception, a time-out, Ctrl+C or a closed window. The EightMax program, its gameplay and the EightMax 5.1 engine are unchanged.

The **exact release ZIP** was tested on Windows (GitHub Actions run [45284015577](https://github.com/derekwtgm/PTO/actions/runs/45284015577), Windows Server 2025, Windows PowerShell 5.1): **26 of 26 scenarios passed** (and 26 of 26 again in a repeat run, [45284068127](https://github.com/derekwtgm/PTO/actions/runs/45284068127)), and the **full acceptance** — complete regression suite (1001 tests: 954 passed, 0 failed, 47 skipped), all seven host-start cases, window lifecycle, tournament gameplay, multi-table stability — ended **PASS (exit 0)**. On Linux the complete suite passed from the extracted ZIP (1001 tests: 934 passed, 0 failed, 67 skipped). The run on your own PC is still outstanding (section 12).

| Question | Answer |
|---|---|
| Root cause of the checksum failure | **Established and reproduced byte for byte.** The release test walked the whole application folder and required every file to be listed in `SHA256SUMS.txt`, while the Milestone 3 runner wrote its own logs into `test-results\` inside that folder before the test ran (section 2). |
| Root cause of the diagnostic-launcher failure | **Not established** — the earlier `RUN-M3-HOST-DIAGNOSTIC.cmd` was not provided and is not in the repository. The new `RUN-M3-HOST-DIAGNOSTIC-3.1.cmd` is hardened against every common failure mode and was tested on Windows on its own (section 5). |
| Was the host-start interruption reproduced? | **Yes, on real Windows.** On files marked as downloaded, the Milestone 3 start-up script did not finish within 120 s: it waited on an *invisible* "Open File - Security Warning" dialog (`#32770`, visible 0) that nobody could answer; on the same files without the mark it finished in about 2–3 s; Milestone 3.1 starts the host on the marked files (section 4). |
| Native solver | Unchanged: `native/mwcli.exe` `b3e675bf…2f72`, EightMax 5.1 build `7d08acc7eb4577ee`; no executable rebuilt. |
| Acceptance | **All 15 acceptance criteria are met** on Windows CI and Linux (section 11), with the exact release ZIP. Not yet verified: the run on your own PC (section 12) — Milestone 3.1 is therefore complete as far as it can be tested without your computer, and final acceptance waits for your first run. |

## 2. The checksum failure — root cause, reproduction, repair

**Root cause (established, reproduced byte for byte).** `tests/release-0362m3.test.cjs` ("SHA256SUMS.txt lists every shipped file except itself") walked the *entire* application folder and required every file to appear in `SHA256SUMS.txt`. `windows\Test-Milestone3-0362.ps1` wrote its results to `test-results\Milestone3-<date>\` *inside that folder*, and the identity phase wrote `mwcli-build-id.err.txt` there **before** the unit phase ran. The test therefore failed on every run started by the launcher:

| Run | Failure reported on your PC | Reproduced here |
|---|---|---|
| 12:25:44 | `listed in SHA256SUMS.txt: test-results/Milestone3-20261123-122544/mwcli-build-id.err.txt` — the run's own identity log | identical message |
| 12:46:37 | `listed in SHA256SUMS.txt: test-results/Milestone3-20261123-122544/host-prebuilt host launch.err.txt` — run 1's leftover | identical message |

Windows CI never saw it because the CI workflow passed `-OutDir` outside the folder. `tests/release-033.test.cjs` (full suite) had the same walk.

**Repair.** `release-integrity-policy.json` defines the immutable payload; `tools/release-integrity.cjs` (Node tests) and `windows/M31-Integrity.ps1` (runner, no Node needed — it also verifies `node.exe`) apply the same rules. The policy is only used after `SHA256SUMS.txt` has verified the policy file itself.

| Rule | Result |
|---|---|
| a listed file is missing or its SHA-256 differs | **FAIL** |
| a malformed, duplicate or path-escaping manifest line | **FAIL** |
| an unlisted executable or script (.exe .dll .ps1 .cmd .js .cjs .cs … 51 types, any case) anywhere in the payload | **FAIL** |
| a link (junction/symlink) inside the payload | **FAIL** (never followed) |
| another unlisted file inside the payload | **WARNING**, named |
| runtime output in `test-results\` (old logs, partial output, failed runs, temp files) | ignored, counted |
| an unrecognised executable in `test-results\` | **WARNING** (a host-start compile cache is recognised only when its `compiler-output.sha256` matches) |
| `Thumbs.db`, `desktop.ini`, `.DS_Store`; `.git` | ignored |

Packaging stays strict: `tools/make-release-0362m31.py package` refuses any unlisted payload file, and `verify` requires every ZIP entry to be listed and every listed file to be in the ZIP with its SHA-256.

## 3. Missing reports — root cause and the new reporting design

**Root cause (established by reading the runner).** The Milestone 3 runner kept every check in memory; phase state files were written only after the *last* phase (lines 277–281), and `milestone3-results.json/.txt/.zip` only at the end (lines 286–311). When the host-start phase stopped responding and the window was closed, nothing but raw tool logs remained — exactly the content of your two ZIPs (identity and unit logs only; `state\` empty).

**New design (`windows\Test-Milestone31.ps1` + `windows\M31-Lib.ps1`).**

| File | Written |
|---|---|
| `run-status.json` | at start, at every phase/operation/check/child-process change and every 5–15 s while waiting (atomic: temp file, flushed, `File.Replace`) — mode, phases with start/end/status, current phase and operation (with its time limit), last successful check, current child process, last exit code, heartbeat |
| `console.log` | every line shown, time-stamped, appended immediately (plus a full PowerShell `transcript.txt`) |
| `errors.log` | every failure and exception: type, message, script, line, column, source line, PowerShell and .NET stack, phase, operation, last successful check, child process, exit code, time — as text and as one JSON line |
| `checks.jsonl` | one line per check, appended the moment it completes |
| `operations.jsonl` | one line when an instrumented operation **starts** and one when it **ends** |
| `phases\NN-name.json` | each phase's result as soon as it ends |
| `milestone3-results.json/.txt/.zip` | at the end — also after an exception, a time-out or Ctrl+C |

Status words: checks PASS / FAIL / WARNING / SKIPPED; phases additionally NOT RUN and INTERRUPTED. Every failure carries a class: **application** (the Workbench failed a test), **harness** (the runner failed), **environment** (the PC prevented the test), **timeout**. Phases declare requirements ("gates"); a phase whose requirement failed is **SKIPPED with the reason** and never counted as passed — mouse input never starts unless the release verified, Node runs, the input driver initialised, no foreign EightMax runs, port 48713 is free and the desktop is interactive. Exit codes: 0 PASS (warnings allowed), 1 FAIL, 2 harness error, 3 environment problem, 4 interrupted, 5 launcher could not start, 6 nothing to package.

**Abrupt termination.** The runner places itself in a Windows job object with *kill on close*: whatever ends the runner (window closed, process killed, crash), every process it started ends with it — no orphaned hidden PowerShell keeping logs open (the pattern in your ZIPs). The checkpoint files survive; the next launch finds a run whose `state` is `running` but whose runner process is gone, marks it **INTERRUPTED** (a phase that had started becomes INTERRUPTED, a phase that never started stays NOT RUN — nothing invented) and packages it; option **D** does the same on request, also for the Milestone 3 folders in `test-results\` (including files another process still holds open, which Explorer's ZIP skipped on your PC).

## 4. The host-start interruption — evidence, investigation, repair

**What your results show** (reconstructed from the two ZIPs — whose directory times and missing files are telling — and the 4.75-s screen recording):

1. Both runs reached `==== host-start`; the recording shows no output 80 s into the first start case. On the Windows CI runner the same case took 2–4 s.
2. The Milestone 3 runner prints a start case's result only after `windows\Start-Desktop.ps1` **exits** (it waited up to 900 s per case, silently). So in both runs the start-up script never exited.
3. The ZIPs you made lack exactly the two files that script held open for writing (`host-prebuilt host launch.out.txt/.err.txt`), while run 2 found the run-1 file on disk: the hidden start-up PowerShell was **still alive** when you zipped the folders (Explorer's ZIP cannot read a file another process is writing).
4. When run 2 started, no desktop host was running, so run 1's script had never launched one (a headless host keeps running until shut down). The stop happened **inside `Start-Desktop.ps1`, before or at the host launch**.

**Cause.** `Start-Desktop.ps1` launched the host with a plain `Start-Process`, i.e. through the Windows shell (`ShellExecuteEx`). Files extracted from a downloaded ZIP carry the *Mark of the Web*; for such an unsigned program the shell asks for confirmation (SmartScreen / "Open File – Security Warning") and waits. Every other program in your run (node.exe, mwcli.exe) was started with CreateProcess and ran normally. A process started hidden shows its *first* window with the hidden flag it was started with, so a prompt raised by the hidden start-up PowerShell is itself invisible: nobody can answer it, and the script waits forever.

**Reproduction on real Windows — confirmed** (scenario S17, GitHub-hosted Windows Server 2025 with a real desktop; Windows CI runs 45275384911 and 45277279723): the Milestone 3 start-up script, called exactly as the Milestone 3 runner calls it (hidden PowerShell, `-Headless`):

| Files | Result |
|---|---|
| without the download mark (control, S17c) | finished after 3.2 s, exit 0, host ready |
| marked as downloaded, as after extracting a downloaded ZIP (S17a) | **did not finish within 120 s** — your symptom. Its hidden PowerShell owned one window: class `#32770`, title **"Open File - Security Warning"**, **visible = 0**. A screenshot taken during the stop shows an empty desktop (`evidence/0.36.2-m31/S17-desktop-during-the-stop.jpg`). |
| the same marked files with Milestone 3.1 (S17b) | host-start PASS; the report adds a WARNING that 408 of 408 program files carry the mark |

So the mechanism is proven on Windows: an invisible shell security prompt that nobody can answer. Whether your PC showed this prompt or the SmartScreen variant ("Windows protected your PC") cannot be read from your files — both are shell prompts for downloaded unsigned programs, both block the Milestone 3 script, and neither can occur with the Milestone 3.1 test launch, which never goes through the shell. If a start step ever stops again, the new runner names the step and every window of the stopped processes, visible or not.

**Repairs.**
- `Start-Desktop.ps1`, headless (test) launches only: CreateProcess (`Start-Process` with redirection never uses the shell), the host's own stdout/stderr captured beside its session file (in headless mode the host reports start-up errors only on stderr, which was discarded), and a JSON trace line before and after every step (`-TraceFile`). The interactive launch (`START-DESKTOP.cmd`) is unchanged: there Windows shows its prompt to you, as it should.
- `windows\M31-HostStart.ps1` runs every start case as twelve instrumented operations — existing EightMax processes, port 48713, folders, start-up script started, host launched, ready, session file, health endpoint, **input driver started** (authenticated hello, no mouse movement), authenticated shutdown, processes exited, port released — each written to `operations.jsonl` *before* it runs and after it ends, each with a time limit (start-up script 120 s, compile cases 300 s; ready 60 s; health 12 s per request and 45 s in all; input driver 40 s; shutdown request 20 s; process exit 30 s after an accepted shutdown; port release 30 s; `-TimeoutScale` for slow PCs) and progress lines every 15 s.
- On a time-out: the start-up script's last traced step, the process tree with command lines, the windows of those processes (including invisible ones — a security dialog is named, with "invisible" when its process was hidden), SmartScreen/UAC windows, the port owner and the Mark of the Web status go to `hang-diagnostics.json` **before** anything is stopped; then only processes of this test session are stopped (job membership / descendants of processes this run started). Another program on port 48713 or an EightMax you started is reported by name and pid and left running.
- Environment checks also record: SmartScreen and Smart App Control settings, Defender real-time protection and controlled folder access, antivirus products, execution policies, PowerShell language mode, .NET Framework release, paths with spaces / non-ASCII characters / long paths, free disk space, interactive session, and (on failure) Application, Defender and Code Integrity events naming EightMax since the run started.

## 5. The diagnostic launcher

**The earlier `RUN-M3-HOST-DIAGNOSTIC.cmd`** was not attached and is not in any branch of `derekwtgm/PTO`, so the reason it did not work **cannot be established from its source**. The new launcher is built to survive every common way a CMD file fails on a home PC: LF-only line endings (labels and `GOTO` break) or a UTF-8 BOM (cmd.exe then reports that a command starting with invisible characters before `@echo` is not recognized), started from inside the ZIP (Explorer extracts only that one file to a temporary folder), started from another folder, paths with spaces, parentheses, `&` or non-ASCII characters, a 32-bit console (PowerShell from `SysWOW64` cannot start the 64-bit host), PowerShell that cannot run or cannot run the script, and a window that closes before the message can be read.

**`RUN-M3-HOST-DIAGNOSTIC-3.1.cmd`** (standalone; mode B with its own report): checks it is in the extracted application folder (and says so when started from inside the ZIP), checks the runner scripts exist, creates and test-writes the results folder (falls back to `%TEMP%`), proves PowerShell starts (`exit 7` round trip, 64-bit via `Sysnative` when needed), runs every start case with progress shown, captures PowerShell's error output, finds its run folder by a random token (a non-ASCII path is never decoded from a file), ZIPs with `tar.exe`/`Compress-Archive` if the runner could not, prints the exact ZIP path, opens File Explorer with the ZIP selected, never closes without a pause, and returns the runner's exit code. If anything before the runner fails it writes `launcher-failure-….txt` (problem, paths, PowerShell exit code and error text, Windows version) plus a ZIP of it, and returns 5. CRLF, ASCII, no BOM; `GOTO`-based flow (no parenthesised blocks around paths).

## 6. The main launcher

**`RUN-0362-MILESTONE3.1-TESTS.cmd`** — the same safeguards, an earlier-run notice before the menu, and:

| Key | Mode | Runs | Mouse |
|---|---|---|---|
| A | Quick verification | integrity, identities, components, prebuilt host start, input driver, shutdown, report | no |
| B | Startup diagnostics | A + fallback compile, cache reuse, invalid caches, old cache key, build-only | no |
| C | Full acceptance | B + regression suite + lifecycle, input cancellation, tournament gameplay, hand tracking, emergency stop, multi-table stability, cleanup | yes |
| D | Package an earlier run | finds incomplete runs (M3.1, and Milestone 3 `test-results\`), packages them | none — no test runs |
| L | Choose another results folder | | |

Non-interactive: `RUN-0362-MILESTONE3.1-TESTS.cmd A|B|C|D ["results folder"]`. `RUN-0362-MILESTONE3-TESTS.cmd` now starts option C and passes its Milestone 3 options on; `windows\Test-Milestone3-0362.ps1` forwards to the new runner.

Results go to `%LOCALAPPDATA%\EightMax-Test-Workbench\TestResults\Milestone3.1-<date>-<time>-<mode>\` by default (never overwritten; a second run in the same second gets `-2`). Inside the application folder only `test-results\` is accepted; a refused or unwritable location falls back (TEMP, user profile) and the report says so.

## 7. Changes to the PowerShell scripts

| File | Status | What changed and why |
|---|---|---|
| `windows\Test-Milestone31.ps1` | new | The runner for modes Quick / Startup / Full / Package / Detect. Phases environment, integrity, dependencies, unit, host-start, lifecycle, gameplay, multi-table, cleanup; requirement gates; failure classes; exit codes 0–6; Ctrl+C ends the run with an INTERRUPTED report (exit 4); transcript; detection and packaging of earlier runs. Every Milestone 3 phase and check is kept. |
| `windows\M31-Lib.ps1` | new | Continuous persistence (atomic `run-status.json`, `console.log`, `errors.log`, `checks.jsonl`, `operations.jsonl`, `phases\`), checks, phases and gates, bounded execution of every tool with progress lines, the session job object, a small C# helper compiled at run time (process tree with command lines, port owner, windows of a process tree including invisible ones), Mark-of-the-Web and Windows-security settings, report text/JSON/ZIP (long paths, files held open by other processes), recovery of interrupted runs, TAP parsing (a test file that stops without reporting is named with its exit code). |
| `windows\M31-HostStart.ps1` | new | The seven start cases (prebuilt, forced fallback compile, cache reuse, corrupted cached executable, cache manifest of other sources, Milestone 2 cache key, build only), each as twelve traced operations with time limits; hang diagnostics before anything is stopped; only session-owned processes are stopped. |
| `windows\M31-Integrity.ps1` | new | The release-integrity policy for the runner, without Node.js (so it can also verify `node.exe`). |
| `windows\Start-Desktop.ps1` | changed | Headless (test) launches use CreateProcess with the host's stdout/stderr captured; `-TraceFile` writes a JSON line before and after every step; the start status records the launch method. The interactive launch is unchanged. |
| `windows\Test-Milestone3-0362.ps1` | changed | Compatibility wrapper: accepts the Milestone 3 parameters and runs `Test-Milestone31.ps1 -Mode Full`. |
| `tests\windows\M31-Scenarios.ps1` | new | The Windows CI scenario suite (section 9). |
| `tests\fixtures\m31\Start-FakeDesktop.ps1` | new | Fault-injection start-up script (host exits, never becomes ready, start-up script hangs) used by the scenario tests. |

All runner scripts are ASCII, parse with the Windows PowerShell 5.1 parser (checked on Windows CI) and with PowerShell 7, and follow the repository's lint rules.

## 8. Changes to release verification

- `release-integrity-policy.json` (new) — the immutable payload versus runtime output (`test-results\`), development metadata (`.git`) and operating-system metadata; 51 executable/script extensions; the only recognised runtime executable is a host-start compile cache whose `compiler-output.sha256` matches.
- `tools/release-integrity.cjs` (new, Node) and `windows\M31-Integrity.ps1` (new, PowerShell) — the same rules (section 2). Command line: `node tools/release-integrity.cjs [--root DIR] [--json FILE]`, exit 0 pass / 1 fail / 2 error.
- `tests/release-0362m3.test.cjs` and `tests/release-033.test.cjs` — the two checksum tests now call the integrity check instead of walking the whole folder: runtime output is excluded, every tamper case still fails.
- `tests/release-integrity-0362m31.test.cjs` (new, 15 tests) — clean release; one and several previous result folders (Milestone 2, Milestone 3 runs 1 and 2, Milestone 3.1); partial output, a previous failed run, temporary files; a modified, appended or missing executable; planted executables and scripts of any type and letter case (`evil.exe`, `Extra.PS1`, `inject.js`, `helper.DLL`, `EightMaxWorkbench.exe.bak.cmd`, a top-level `test-results.exe`); an unexpected non-executable file (warning, named); a compile-cache executable in `test-results\` recognised only with its matching record (otherwise a named warning — it is not part of the release); a malformed, path-escaping or duplicate manifest line; a policy that would widen the runtime-output list (refused unless `SHA256SUMS.txt` verifies it); links; the command-line tool's exit codes.
- `tools/make-release-0362m31.py` (new) — strict packaging (refuses an unlisted payload file or a listed file whose bytes changed) and verification of the ZIP from a fresh extraction into a folder with spaces (CRCs, every entry listed, every listed file present with its SHA-256, no runtime output, release integrity, `mwcli.exe` unchanged).
- Windows CI checks the ZIP's SHA-256 in every job against the packaged one.

## 9. Tests passed, failed and skipped

### 9.1 Linux development machine (Node 22.23.5, PowerShell 7.4.6)

| Suite | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|
| Complete Node suite, unmodified Milestone 3 tree (baseline) | 965 | 892 | 0 | 73 |
| Complete Node suite, final Milestone 3.1 tree (development folder) | 1001 | 934 | 0 | 67 |
| Complete Node suite, **the final ZIP** extracted into a new folder (path with spaces) | 1001 | 934 | 0 | 67 |
| Repetition 1: runner, release-integrity and start-up script tests from the extracted ZIP | 40 | 39 | 0 | 1 |
| Repetition 2: runner, release-integrity and start-up script tests from the extracted ZIP | 40 | 39 | 0 | 1 |
| Repetition 3: runner, release-integrity and start-up script tests from the extracted ZIP | 40 | 39 | 0 | 1 |

The Milestone 3.1 tree has 36 new tests (15 release-integrity, 20 runner/launcher, 1 start-up script). Skipped on Linux (none counted as passed): the native EightMax engine is a Windows program (tests needing `EIGHTMAX_TEST_CLI`), Mono and the .NET SDK are not installed (C# compilation checks). The baseline skipped 6 more because PowerShell was not yet installed on the machine; these 6 now run and pass. Modified tests: `release-0362m3`, `release-033` (checksum tests use the integrity check), `start-desktop-0362m3` (the launch call changed), `windows-findings-0362m3` (it pinned Milestone 3 runner internals), `release-consistency` (no `fs.cpSync`, section 10). The 15 live runner tests run on Linux with PowerShell 7 against a fake desktop host (Linux scenarios D–O and three more); on Windows they are skipped and replaced by the real scenario suite below.

### 9.2 Windows scenario suite (the final ZIP, extracted into a new folder; Windows PowerShell 5.1, real desktop host, real launchers)

| # | Spec | Scenario | Result | Observed |
|---|---|---|---|---|
| S01 | A | clean installation: quick verification through the main launcher | **PASS** | exit 0, overall PASS, host-start PASS, input driver True, report True, 26 s |
| S02 | D,N | standalone start-up diagnostic: complete report for every case without the main suite | **PASS** | exit 0, overall PASS, cases prebuilt=PASS fallback-fresh=PASS cache-reuse=PASS invalid-exe=PASS invalid-manifest=PASS old-key=PASS build-only=PASS, report True, 71 s |
| S03 | B | previous results folders do not fail the release checks (Node tests and the runner) | **PASS** | node tests exit 0 (failed: ); runner integrity ok True, runtime output files ignored 12 |
| S03r | B | reproduction: the ORIGINAL Milestone 3 release test fails on the same folders (operator failure) | **PASS** | M3 test exit 1, message: listed in SHA256SUMS.txt: test-results/Milestone3-20261123-122544/host-prebuilt host launch.err.txt |
| S04a | C | a modified executable is detected; the host is not started from a damaged release | **PASS** | exit 3; FAIL: 1442 of 1443 listed files verified; missing 0, modified 1, unexpected executables 0, other unlisted files 0; runtime output ignored: 0 file(s) in 0 folder(s); warnings 0: desktop/bin/EightMaxWorkbench.exe differs f; host-start SKIPPED |
| S04b | C | an unexpected executable inside the protected payload is detected | **PASS** | exit 3; FAIL: 1443 of 1443 listed files verified; missing 0, modified 0, unexpected executables 1, other unlisted files 0; runtime output ignored: 0 file(s) in 0 folder(s); warnings 0: executable or script not in the release man |
| S04c | C,J | a missing manifest-listed file and a missing dependency (node.exe) give a clear environment failure and a full report | **PASS** | exit 3; report True; environment: FAIL: 1442 of 1443 listed files verified; missing 1, modified 0, unexpected executables 0, other unlisted files 0; runtime output ignored: 0 file(s) in 0 folder(s); warnings 0: runtime/node/node.exe is listed in SHA256SUMS.txt but missing. Extract the complete ZIP again into a new, empt |
| S05 | E | host start failure: the step and the host error are named; report and ZIP produced | **PASS** | exit 1; report True; prebuilt host launch - 6/12 Wait for the host to report ready (session file): the desktop host exited before it was ready; host stderr: The desktop host could not start: simulated start-up failure (test fixture, mode exit). [0 s] |
| S06 | E,K | existing EightMax instance: environment failure naming it; it was NOT stopped by the test | **PASS** | exit 3; foreign host pid 7020 still alive after the run: True; environment: already running (not started by this test, left running): EightMaxWorkbench pid 7020 (started 22:58:08) D:\a\_temp\EightMax CI (scenarios) ü\EightMax-Test-Workbench\desktop\bin\EightMaxWorkbench.exe. Close the EightMax Workbench and its  |
| S07 | F | start-up time-out: recorded with the step, process tree saved, processes stopped, report produced | **PASS** | exit 1 after 43 s; timeout: the start-up script did not finish within 20 s; its last recorded step: "launch-host" start (CreateProcess: fake host, mode script-hang). The script and its child processes were stopped; see hang-diagnostics.json. [20.6 s]; tree 2 process(es), alive afterwards 0 |
| S08 | G | an exception keeps type, message, script, line, stack and phase; dependants SKIPPED | **PASS** | exit 2; host-start SKIPPED; errors.log 2756 characters |
| S09 | H | midway failure: earlier checks saved, the failed one identified, the next phase still ran | **PASS** | exit 1; failed check number 26 of 42 in phase dependencies; host-start PASS |
| S10 | I | killed runner: its hung child processes end with it (job object); checkpoint packaged INTERRUPTED by option D | **PASS** | hung processes alive before kill 1, after 0; checkpoint state running/host-start; package exit 0, overall INTERRUPTED, host-start INTERRUPTED |
| S11 | J | missing dependency: clear message, environment class, exit 3 | **PASS** | exit 3; missing dependency: D:\a\_temp\EightMax CI (scenarios) ü\EightMax-Test-Workbench\runtime\node\node-missing-by-fault-injection.exe does not exist. The regression and real-window tests need it. Extract the complete ZIP again. |
| S12 | K | occupied port: the owner is named (process and pid); the owner is left running; exit 3 | **PASS** | exit 3; owner alive after the run True; environment: Port 48713 is already occupied by powershell (pid 9332, LISTEN). The desktop host needs this port; the program was left running. Close it or restart Windows, then run the test again. |
| S13 | L | three sequential quick runs: three folders, three reports, all exit 0 | **PASS** | exit codes 0,0,0; folders 3; ZIPs 3 |
| S14 | M | long path (284 characters) and spaces: the ZIP is created; the file is included or listed as skipped | **PASS** | package exit 0; long file created True (284 chars); in ZIP True; skipped list False; entries 5 |
| S15 | O | existing incomplete run packaged (D): the log another process holds open is included | **PASS** | package exit 0; ZIP milestone3-results.zip with 9 entries; locked log included True |
| S16a | launcher | launcher outside the application folder: exit 5, missing files named, diagnostic file and ZIP | **PASS** | exit 5; failure file 1; EightMax Test Workbench 0.36.2 - Milestone 3.1 - the launcher could not run the test (host-diagnostic) Time: Mon 11/23/2026 23:02:17.90 Problem: "This file must be run from the extracted EightMax-Test-Workbench folder (next to START-EIGHTMAX.cmd), but files are missing: windows\Test-Milestone31.ps1, windows\M31-Lib.ps1, windows\M31-Integrity.ps1, windows\M31-HostStart.ps1 |
| S16b | launcher | launcher started from inside a ZIP: the message says to extract first; exit 5 | **PASS** | exit 5; message found True |
| S16c | launcher | the runner cannot run in PowerShell (script damaged): exit 5, the PowerShell error text saved | **PASS** | exit 5; failure file 1; PowerShell text saved True |
| S17c | host-start root cause | control: the Milestone 3 start-up script on the SAME files WITHOUT the download mark | **PASS** | Start-Desktop.ps1 finished: True after 3.1 s, exit 0, host ready True |
| S17a | host-start root cause | reproduction: the Milestone 3 start-up script on files marked as downloaded (the operator condition) | **PASS** | Start-Desktop.ps1 did NOT finish within 120 s - the operator symptom; windows of the stopped script: #32770 \| Open File - Security Warning \| visible 0 \| pid 6000 ; ConsoleWindowClass \| Administrator: C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe \| visible 0 \| pid 6000 ; MSCTFIME UI \| MSCTFIME UI \| visible 0 \| pid 6000 ; IME \| Default IME \| visible 0 \| pid 6000 ; IME \| Defa |
| S17b | host-start root cause | Milestone 3.1 on the same marked files: the host starts (CreateProcess) and the mark is reported | **PASS** | exit 0; host-start PASS; WARNING 408 of 408 program files carry the internet zone mark (e.g. BUILD-WGC.cmd, CANCEL-TRAINING.cmd, COLLECT-TEST-RESULTS.cmd, CONTINUE-TRAINING.cmd, EXPORT-STRATEGIES.cmd). Windows may ask for confirmation (SmartScreen / security warning) when the Workbench is started by double-click; the tests start programs directly and are not blocked by it. See READ-ME-MILESTONE-3. |
| S18 | cancel | Ctrl+C: the run ends by itself with an INTERRUPTED report and ZIP; its child processes are stopped | **PASS** | Ctrl+C sent; runner exited True (code 4); state interrupted; overall INTERRUPTED; host-start INTERRUPTED, cleanup NOT RUN; hung processes left 0 |
| S19 | M | default results folder under a user folder with spaces and non-ASCII characters (%LOCALAPPDATA%) | **PASS** | exit 0, run folder found under %LOCALAPPDATA%\EightMax-Test-Workbench\TestResults, overall PASS, report True, 25 s |

**26 of 26 scenarios passed** (run 45284015577).
Repetition on the same ZIP (run 45284068127): 26 of 26 passed.

### 9.3 Windows full acceptance — `RUN-0362-MILESTONE3.1-TESTS.cmd C`, exactly as on your PC (the final ZIP)

| Phase | Status | Checks (pass / fail / warning / skipped) | Time |
|---|---|---|---|
| environment | **PASS** | 9 / 0 / 0 / 0 | 4.5 s |
| integrity | **PASS** | 10 / 0 / 0 / 0 | 3.0 s |
| dependencies | **PASS** | 6 / 0 / 0 / 0 | 1.0 s |
| unit | **PASS** | 1 / 0 / 0 / 0 | 6 min 21 s |
| host-start | **PASS** | 86 / 0 / 0 / 5 | 33.6 s |
| lifecycle | **PASS** | 13 / 0 / 0 / 0 | 2 min 4 s |
| gameplay | **PASS** | 8 / 0 / 0 / 0 | 3 min 33 s |
| multi-table | **PASS** | 6 / 0 / 0 / 0 | 12 min 15 s |
| cleanup | **PASS** | 3 / 0 / 0 / 0 | 2.4 s |

**Overall PASS, exit code 0** — 147 checks: 142 passed, 0 failed, 0 warnings, 5 skipped. Regression suite on Windows (complete): 1001 tests, 954 passed, 0 failed, 47 skipped.

Real-window checks (the mouse moves inside the controlled test tables only):

- J: Scripted practice plays hand after hand (no regression) — **PASS** — 6 checks passed in 30 s
- A: Window closes during capture — **PASS** — 8 checks passed in 7 s
- B: Window closes during mouse movement — **PASS** — 7 checks passed in 12 s
- C: Simulator restarts with a different handle — **PASS** — 10 checks passed in 11 s
- D: Temporary capture failures (injected while the window stays open) — **PASS** — 6 checks passed in 11 s
- E: Minimised window — **PASS** — 5 checks passed in 10 s
- F: Several tables, one closes — **PASS** — 6 checks passed in 16 s
- G: Emergency stop during recovery — **PASS** — 5 checks passed in 8 s
- H: Repeated target-loss signals — **PASS** — 6 checks passed in 4 s
- I: Identity mismatch / handle reuse: no inherited permission — **PASS** — 5 checks passed in 3 s
- K: Window resized while playing (geometry / display-scaling re-check) — **PASS** — 3 checks passed in 9 s
- lifecycle-acceptance: process cleanup (children exited, no live timers) — **PASS** — ok
- lifecycle runner exits by itself after its report; exit code matches — **PASS** — report -> exit 13 ms, exit 0
- T1: Hands that start with eliminated players are tracked (the Milestone 2 stall) — **PASS** — 6 checks passed in 42 s
- T2: A tournament is played to its end; the end is a normal stop — **PASS** — 12 checks passed in 38 s
- T3: A hand first seen after its opening: untracked, no input; recovery at the next verified hand — **PASS** — 8 checks passed in 20 s
- T4: Think-time holds: one seat acting on consecutive streets with every control hidden (pre-existing defect fixed in M3) — **PASS** — 4 checks passed in 36 s
- T5: Two tables: eliminations on both, one window closes; no input crosses tables — **PASS** — 6 checks passed in 54 s
- T6: Emergency stop right after an elimination: stop wins, no input, no automatic recovery — **PASS** — 6 checks passed in 21 s
- gameplay-acceptance: process cleanup (children exited, no live timers) — **PASS** — ok
- gameplay-acceptance: exit code matches the result — **PASS** — overall PASS, exit 0
- M1: 1 table(s): short-stack tournaments with eliminations, a window closed and reopened, emergency stops, finished tournaments replaced — **PASS** — 5 checks passed in 182 s
- M2: 2 table(s): short-stack tournaments with eliminations, a window closed and reopened, emergency stops, finished tournaments replaced — **PASS** — 5 checks passed in 181 s
- M5: 5 table(s): short-stack tournaments with eliminations, a window closed and reopened, emergency stops, finished tournaments replaced — **PASS** — 5 checks passed in 183 s
- M8: 8 table(s): short-stack tournaments with eliminations, a window closed and reopened, emergency stops, finished tournaments replaced — **PASS** — 5 checks passed in 188 s
- gameplay-stability: process cleanup (children exited, no live timers) — **PASS** — ok
- gameplay-stability: exit code matches the result — **PASS** — overall PASS, exit 0

Skipped checks are never counted as passed: in the host-start phase, steps 6–10 of the build-only case (it starts no host by design). Regression tests skipped on Windows (47, none counted as passed): 15 Milestone 3.1 live runner tests (on Windows they are the scenario suite); 14 Mono / monodis / mcs (Linux tooling for C# checks); 8 Playwright / Chromium browser checks; 6 FFmpeg video checks; 3 Linux shell-script fixtures; 1 a non-Windows-only test (native engine probe on Linux).

## 10. Windows CI results (actual)

Repository `derekwtgm/PTO`, branch `milestone-3.1-0362`, workflow `.github/workflows/windows-0362-m31.yml`, runner `windows-latest` (Windows Server 2025 Datacenter 10.0.26100, Windows PowerShell 5.1.26100, a real interactive desktop set to 1920×1080). The ZIP is extracted into a new folder whose path has spaces, parentheses and a non-ASCII character; every Windows job checks the ZIP's SHA-256 against the packaged file.

| Run | Kind | ZIP SHA-256 | Scenarios | Full acceptance | Launcher exit |
|---|---|---|---|---|---|
| [45284015577](https://github.com/derekwtgm/PTO/actions/runs/45284015577) | **the final release ZIP** (committed; SHA-256 checked by every job) | `49d0d7a4cf3c4e1e…` | **26/26** | **PASS** (unit 954/1001, 0 failed) | 0 |
| [45284068127](https://github.com/derekwtgm/PTO/actions/runs/45284068127) | repetition of the scenario suite on the same final ZIP | `49d0d7a4cf3c4e1e…` | **26/26** | not run (scenarios only) | — |
| [45272448662](https://github.com/derekwtgm/PTO/actions/runs/45272448662) | development run 1: Milestone 3 ZIP + m31-overlay, packaged by tools/make-release-0362m31.py | `0864c17720422aaf…` | 15/21 | FAIL (unit 947/993) | 5 |
| [45275384911](https://github.com/derekwtgm/PTO/actions/runs/45275384911) | development run 2: the fixes of run 1 | `0feff9244b545aea…` | 22/25 | FAIL (unit 948/993) | 1 |
| [45277279723](https://github.com/derekwtgm/PTO/actions/runs/45277279723) | development run 3: the fixes of run 2 | `17384daf69393aaa…` | 25/25 | FAIL (unit 948/994) | 1 |
| [45281425813](https://github.com/derekwtgm/PTO/actions/runs/45281425813) | development run 4 (scenarios only): the fixes of run 3 and the new scenario S19 | `a0ed066dc3642090…` | 26/26 | not run (scenarios-only development run; the full acceptance runs on the final ZIP) | — |

Problems found on Windows and fixed during development (all re-tested):

- after run 45272448662: launchers: the run-folder token line had no line end, so findstr /x never matched and the launcher reported exit 5 after a completed run; the token is now written with CRLF and matched with findstr /b
- after run 45272448662: results branch push: a 284-character file name failed in git; core.longpaths is now set (CI only)
- after run 45272448662: S14 (harness): a window title built with + in command-argument mode; parenthesised
- after run 45272448662: S17 (harness): saving the results failed on a circular object; facts are converted to plain values first
- after run 45272448662: S17 (harness): the window list excluded invisible windows - exactly the ones that matter; they are now included (runner and harness)
- after run 45272448662: regression suite: tests/windows-findings-0362m3.test.cjs pinned Milestone 3 runner internals (900 s wait, Safe-Name); it now checks the Milestone 3.1 equivalents
- after run 45275384911: S14: packaging an interrupted run whose status file lacked the result field threw (a property set on a JSON object that does not have it); missing fields are now added with Add-Member
- after run 45275384911: S15: option D looked only for Milestone3.1-* folders and missed the Milestone 3 run folders; every run folder is now examined
- after run 45275384911: S17c (harness): the control checked the host before it was ready; it now waits up to 30 s
- after run 45275384911: Ctrl+C ended the runner with exit code 0; it now ends with 4 (interrupted), and S18 requires 4
- after run 45275384911: regression suite on Windows: tests/release-consistency.test.cjs stopped Node.js (exit 0xC0000409) in the folder with a non-ASCII character (fs.cpSync); the test now copies with directory reads (fixed after run 3, see below)
- after run 45277279723: tests/release-consistency.test.cjs: fs.cpSync replaced by a plain recursive copy (fs.cpSync stopped the bundled Node.js 22 when the application folder path has a non-ASCII character); a CI probe step records fs.cpSync's exit code from such a folder
- after run 45277279723: runner: a test file that stops without reporting its tests is now named with its exit code (Get-M31TapFailures), escaped backslashes in test names are unescaped
- after run 45277279723: runner: empty Windows security values are named ('not set', 'none reported') instead of printed as nothing
- after run 45281425813: scenario harness: scenarios.json stopped being updated at S17 - a string read by Get-Content is wrapped in a PSObject and JavaScriptSerializer met its PSMethod members ("circular reference"); in runs 2 and 3 the fallback had silently replaced every scenario's facts by a type name. Scalars are now unwrapped and the file is written with ConvertTo-Json.

## 11. Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Previous results folders no longer cause false release-integrity failures | **met** | tests/release-integrity-0362m31 (B, B2, partial output, failed run, temporary files); Windows S03; the operator folders reproduce the Milestone 3 failure (S03r) and pass with Milestone 3.1 |
| 2 | Genuine executable corruption is still detected | **met** | tests/release-integrity-0362m31 (C: modified, appended, missing, planted, policy tampering); Windows S04a-c |
| 3 | Every completed test is persisted immediately | **met** | checks.jsonl appended per check; Linux H and I; Windows S09 (checks before the failure on disk), S10 (checkpoint after a kill) |
| 4 | Ordinary startup failures produce useful reports | **met** | Linux E; Windows S05 (host exits: step 6/12, exit code and host stderr named), S06 (another EightMax running) |
| 5 | Startup timeouts cannot hang the test runner indefinitely | **met** | Linux F; Windows S07 (time-out at the traced step, tree recorded and stopped, report) |
| 6 | The standalone host diagnostic produces a report without running the full suite | **met** | Linux N; Windows S02: RUN-M3-HOST-DIAGNOSTIC-3.1.cmd, 7 start cases with the real host |
| 7 | Unexpected errors preserve available logs and identify the interrupted phase | **met** | Linux G and I; Windows S08 (exception details), S10 (killed runner), S18 (Ctrl+C) |
| 8 | A previous incomplete test run can be packaged without rerunning tests | **met** | Linux I and O; Windows S10, S15 (option D, a log held open by another process included) |
| 9 | Test results are written outside the immutable release payload by default | **met** | default %LOCALAPPDATA%\EightMax-Test-Workbench\TestResults (Windows S19: the launcher without a results folder, under a user folder with spaces and non-ASCII characters); a folder inside the application folder is refused except test-results, and an unwritable one falls back (Linux tests) |
| 10 | All test modes produce valid JSON, text and ZIP outputs | **met** | A: S01, S13; B: S02; C: full acceptance job; D: S10, S15 |
| 11 | The test runners exit with correct status codes | **met** | observed on Windows: 0 (S01, S02, S13, S19 and the final full acceptance), 1 (S05, S07, S09 and the development full runs 2 and 3, which had a failing test), 2 (S08), 3 (S04a-c, S06, S11, S12), 4 (S18, Ctrl+C), 5 (S16a-c); 6 (nothing to package) in Linux scenario O |
| 12 | Existing Milestone 3 gameplay and safety features remain functional | **met** | full acceptance job (lifecycle A-K, gameplay T1-T6, multi-table 1/2/5/8) and the Linux full suite |
| 13 | The native solver remains unchanged | **met** | native/mwcli.exe SHA-256 b3e675bf...2f72 checked by the integrity phase and tests; build id 7d08acc7eb4577ee read on Windows |
| 14 | Windows acceptance tests are executed where infrastructure is available | **met** | GitHub Actions windows-latest, runs listed under ci |
| 15 | The final ZIP passes independent checksum and release verification | **met** | package job verification (fresh extraction, every entry listed and hashed, release integrity) and the exact-ZIP CI run |

## 12. What is not yet verified on your PC

- The operator's own PC (Windows 11 Home): Milestone 3.1 has not run there yet. Everything else in this record ran on GitHub-hosted Windows Server 2025 and on Linux.
- Which shell prompt stopped the Milestone 3 start on the operator PC ('Open File - Security Warning' was reproduced on Windows CI; SmartScreen is the other possibility). The Milestone 3.1 test launch triggers neither; its environment check records the Mark of the Web and the SmartScreen, Smart App Control and Defender settings, and a stopped step would name every window of the stopped processes.
- Why the earlier RUN-M3-HOST-DIAGNOSTIC.cmd did not work (the file is not available).
- Windows Defender real-time protection was off and Smart App Control absent on the CI runner. On the operator PC scanning can slow the starts (the time limits are generous and scalable with -TimeoutScale); if Smart App Control is ON it can block the unsigned EightMax programs outright - the runner reports that state, but it cannot be tested on CI.
- Display scaling other than 100 % (the CI desktop is 100 %; the operator PC uses 125 %). Lifecycle scenario K re-checks geometry after a resize, but a 125 % desktop was not available on CI.
- A real Windows account whose user name has non-ASCII characters: simulated on Windows by scenario S19 (%LOCALAPPDATA% under such a folder) and by the non-ASCII application folders of every Windows job.
- A real power failure or forced shutdown during a run: covered by the killed-runner scenarios (Windows S10, Linux I - the checkpoint is packaged INTERRUPTED), not by a real power loss.

## 13. The next test — exact instructions

1. Download `EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip` (and optionally check it: open a Command Prompt in the download folder and run `certutil -hashfile EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip SHA256` — the result must be `49d0d7a4cf3c4e1e130b5d0a2d08f9dc9fe97419cd3651deae9460aa642bdf1f`).
2. Right-click the ZIP > **Extract All…** into a **new, empty** folder, for example `C:\EightMax-3.1`. (Optional, removes Windows' "downloaded" mark once for all files: right-click the ZIP > Properties > tick **Unblock** > OK *before* extracting.)
3. Close the EightMax Workbench and its dashboard if they are open.
4. **First test (3–8 minutes, the mouse does not move):** double-click `RUN-M3-HOST-DIAGNOSTIC-3.1.cmd` in the extracted folder. If Windows asks whether to run the file, choose **Run** (or **More info > Run anyway**). Press a key when asked. The window shows every step. At the end File Explorer opens with `milestone3-results.zip` selected — send that file.
5. **Second test (45–75 minutes):** double-click `RUN-0362-MILESTONE3.1-TESTS.cmd`, press **C**. Small "EightMax Test Table" windows open and the mouse moves by itself inside them: do not touch the mouse or keyboard until the window says the tests ended (Ctrl+Alt+F12 stops all input at any time). Keep the PC awake and plugged in. Send the `milestone3-results.zip` that File Explorer shows at the end.
6. If anything stops or the window closes: start `RUN-0362-MILESTONE3.1-TESTS.cmd` again and press **D** — it packages the unfinished run without running a test. If a launcher cannot start at all, it writes `launcher-failure-….txt` and a ZIP of it and opens File Explorer there — send that ZIP.

Results are kept in `%LOCALAPPDATA%\EightMax-Test-Workbench\TestResults\` (never inside the application folder); each run has its own folder and is never overwritten.

## 14. Deliverables

| File | SHA-256 / contents |
|---|---|
| `EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip` | `49d0d7a4cf3c4e1e130b5d0a2d08f9dc9fe97419cd3651deae9460aa642bdf1f` (80,958,422 bytes, 1,444 entries: 1,443 manifest entries + `SHA256SUMS.txt`) |
| `EightMax-Test-Workbench-0.36.2-Milestone-3.1.zip.sha256` | the line above, `sha256sum` format |
| `REPORT-0.36.2-Milestone-3.1.md` | this report |
| `WINDOWS-TEST-RUNNER-VALIDATION-3.1.json` | the Windows scenario results of the final ZIP, the full-acceptance summary, the acceptance criteria |
| `STARTUP-DIAGNOSTICS-VALIDATION-3.1.json` | the host-start operations, time limits, start cases, the root-cause evidence and the operator-evidence analysis |
| `REGRESSION-3.1.json` | Linux and Windows regression counts, new and modified tests, unchanged components |
| `READ-ME-MILESTONE-3.1.txt` | the operator instructions (also inside the ZIP) |

Inside the ZIP: the complete application, the new launchers and runner, `release-integrity-policy.json`, the integrity tools, the regression tests, the CI workflow, `release-0362-m31.json` (release record), `evidence/0.36.2-m31/` (baseline verification, reproduction TAPs, operator-evidence analysis, the S17 screenshot, the development CI runs, the final Linux suite) and `SHA256SUMS.txt`. The EightMax 5.1 engine `native/mwcli.exe` is byte-identical (`b3e675bf…2f72`, build `7d08acc7eb4577ee`); no executable was rebuilt.
