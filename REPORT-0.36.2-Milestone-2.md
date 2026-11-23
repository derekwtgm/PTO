# EightMax Test Workbench 0.36.2 — Milestone 2 development report

**Scope: simulator window lifecycle, safe recovery, input cancellation and bounded diagnostics.** This is a focused stability release built on
`EightMax-Test-Workbench-0.36.2-Milestone-1.zip` (SHA-256 `b02bb563e68f422dd69d58d390e23cf0af09b867a96955dce1d33f8e82b29358`). Application
version `0.36.2-dev`. EightMax 5.1, build `7d08acc7eb4577ee`, **unchanged** (`native/mwcli.exe` SHA-256 `b3e675bf…2f72`).

**Status in one paragraph.** The repeated lost-window defect is reproduced, its root cause is identified and repaired, the lifecycle state
machine, cancellation, guided recovery, dashboard and bounded diagnostics are implemented, and everything that can run outside Windows was run
here (Linux, Node 22.23.5, Chromium/Playwright, Mono 6.8): **all results below are from that environment.** No Windows machine or Windows CI runner
was available to this session, so **nothing in Milestone 2 has been executed on Windows yet**. The Windows test runner
(`RUN-0362-MILESTONE2-TESTS.cmd`) and a CI workflow (`.github/workflows/windows-0362-m2.yml`) are ready for that run; until it passes,
Milestone 2 is not accepted. No C# source changed, so no Windows executable needed rebuilding: the shipped executables are the Windows-built
Milestone 1 binaries, byte-identical (§9).

| Acceptance criterion | Status |
|---|---|
| 1 Lost window stops generating capture requests | **Met (Linux, fake host + Chromium):** 1 capture + 1 driver probe, then none (§1, §7) |
| 2 Queued and active input cancelled or marked uncertain | **Met (Linux):** Tests B, B2, B3, F, stress |
| 3 No stale registration authorises input to an unrelated window | **Met (Linux):** Tests C, I, I2; driver check unchanged |
| 4 Temporary failures without uncontrolled retries | **Met (Linux):** bounded backoff, Tests D, E |
| 5 Replacement needs fresh operator confirmation | **Met (Linux + Chromium):** Test C, dashboard test |
| 6 Emergency stop / manual override take priority | **Met (Linux):** Test G, dashboard test, stress |
| 7 Dashboard explains why a table stopped | **Met (Chromium):** messages and lifecycle column |
| 8 Bounded diagnostics with failure counts | **Met (Linux):** coalescing, exact totals |
| 9 Scripted gameplay still works | **Met (Linux):** Test J, existing suite; Windows run pending |
| 10 Existing regression tests | **Met (Linux):** see §7 for counts and the three pre-existing environment failures that were repaired or explained |
| 11 Windows executables rebuilt and verified | **Not applicable as worded:** no C# changed; binaries unchanged and identity-verified (§9). Windows execution of Milestone 2 **pending** |
| 12 EightMax 5.1 unchanged | **Met:** byte-identical |

## 1. Exact root cause of the repeated capture failures

The diagnostics file `eightmax-simulator-diagnostics (1).json` was **not available** to this session (it was not in the session's files and
not in the repository); the analysis uses the figures quoted in the assignment (592 table frames attempted and rejected, 0 successful frames,
801 capture events, `target-lost` "The window no longer exists", 0 actions, 0 driver errors).

The defect was in the dashboard-side automation loop, not in the Windows executables:

1. **Every capture failure was "no reading yet".** `SimulatorTable.look()` (Milestone 1 `src/simulator-controls.js`) returned
   `{reject: 'capture target-lost: …'}` for any failed `/api/capture/frame`, and `step()` turned that into `{kind:'no-reading'}`. Nothing
   classified the code or asked whether the window still existed.
2. **The loop never ends.** The dashboard starts each table with `run(Infinity)` and `stopOnPause:false`; `run()` sleeps `idlePollMs`
   (120 ms) after a `no-reading` and tries again — for as long as automation runs.
3. **Start did not check registrations.** `start()` in `src/simulator-controls-ui.js` built a `SimulatorTable` for every entry of
   `st.registered`, including one whose window had been closed (or a simulator that had been restarted with a new handle). That table could
   never capture a single frame: exactly the "0 successful frames for the affected table".
4. **Every failure was logged individually.** `DiagnosticsRecorder.record()` stored each rejected frame, so one closed window produced one
   event per 120 ms.
5. The desktop host behaved correctly: `CaptureService.CheckWindow()` answers `target-lost` on every request when `IsWindow` is false. It
   is stateless per request, so it cannot stop a client that keeps asking. (It also uses `target-lost` for an invisible window; Milestone 2
   handles that by confirming with the driver, see §3.)

**Reproduction** (unmodified Milestone 1 code, the dashboard's own loop settings, window gone before automation starts):
`evidence/0.36.2-m2/phase1-repro-M1-dashboard-loop-71s.json` — **590 capture requests in 71 s, 590 rejected frames, 0 successful frames,
0 inputs, loop still running** (≈ 499 requests per minute), matching the reported 592. With realistic driver answers
(`tools/repro-target-lost-0362m2.cjs`, 20 s): Milestone 1 166 captures and never stops; Milestone 2 **1 capture, 1 identity probe,
TARGET_LOST, loop ended** (`repro-target-lost-M1-before.json`, `repro-target-lost-M2-before.json`). Closing the window during play:
Milestone 1 154 further captures, loop never ends; Milestone 2 **0 captures and 0 inputs after the close** (`…-1500.json`).

## 2. Source files modified

New: `src/window-lifecycle.js` (state machine, classification, identity, backoff, replacement candidates).
Changed: `src/simulator-controls.js`, `src/simulator-controls-ui.js`, `src/input-scheduler.js`, `src/execution-adapters.js`,
`src/windows-input-driver.js`, `dashboard.html` (+ regenerated `START.html`), `tools/build.py` (inline the new module),
`tools/test-table-035.cjs` (`reopen`, `--keep-alive`), `docs/SIMULATOR-CONTROLS.md`, `docs/CHANGELOG.md`, `READ-ME-FIRST.txt`.
Tests: new `tests/lifecycle-0362m2.test.cjs`, `tests/lifecycle-host-fixture.cjs`, `tests/simulator-ui-0362m2.test.cjs`,
`tests/release-0362m2.test.cjs`; adjusted `tests/simulator-controls-035.test.cjs`, `tests/simulator-host-fixture.cjs`,
`tests/simulator-ui-035.test.cjs`, `tests/simulator-ui-036.test.cjs`, `tests/capture-029.test.cjs` (execute bit of a stub, §7) (their fake drivers now also report `pid`/`processStart`/`className`
in `window-info`, as the real driver does; one message regex widened because the earlier identity probe makes the same refusal happen in
the lease revalidation), `tests/windows-025.test.cjs` (stale version literal, §7).
Windows / tools: new `RUN-0362-MILESTONE2-TESTS.cmd`, `READ-ME-MILESTONE2-TESTS.txt`, `windows/Test-Milestone2-0362.ps1`,
`tools/lifecycle-acceptance-0362m2.cjs`, `tools/lifecycle-stress-0362m2.cjs`, `tools/build-check-0362m2.py`,
`tools/repro-target-lost-0362m2.cjs`, `tools/repro-elimination-stall-0362m2.cjs`, `.github/workflows/windows-0362-m2.yml`, `release-0362-m2.json`.
**Not modified:** any file under `desktop/` (C#), `native/`, `vendor/`, `runtime/`, solver/strategy sources. Full diff:
`evidence/0.36.2-m2/changes-M1-to-M2.diff` (START.html excluded there: it is generated by `tools/build.py`).

The investigation also read `src/screen-capture.js`, `src/test-executor.js`, `desktop/DesktopHost.cs`, `desktop/CaptureService.cs`,
`desktop/InputBroker.cs` and `desktop/input/Driver.cs`; they needed no change (the executor already never re-sends; the driver already
re-checks handle, process id, process start time and class before and during every input, and removes a registration whose window is gone).

## 3. How terminal window loss is detected

`src/window-lifecycle.js` defines REGISTERED, ACTIVE, TEMPORARILY_UNAVAILABLE, RECOVERY_PENDING, TARGET_LOST, STOPPED and SAFETY_PAUSED with an
explicit transition table. TARGET_LOST has no exits. STOPPED and SAFETY_PAUSED leave only to RECOVERY_PENDING, only with `operator: true`.
TEMPORARILY_UNAVAILABLE never goes straight to ACTIVE. Every transition increments a **generation**; a capture, decision or queued click
started under an older generation is dropped (`transition(…, {ifGeneration})`, `valid(token)`).

1. **Classification** (`classifyCaptureFailure`): `target-lost`, `target-identity-changed`, `window-gone`, `identity-changed` are *terminal
   candidates*; `target-minimized`, `target-occluded`, `no-frame`, `capture-interrupted`, `capture-failed`, `decode-failed`, `invalid-frame`,
   `size-mismatch`, host errors are *transient*; `backend-unavailable` etc. are *configuration* (SAFETY_PAUSED).
2. **Confirmation with the driver** after every failed capture (`probeIdentity`): `window-info` for the registered handle. `window-gone` →
   TARGET_LOST "window closed"; a window whose pid / process start time / class / executable differ → TARGET_LOST "identity changed"; the same
   window (also when the host said `target-lost` because the window is merely invisible) → TEMPORARILY_UNAVAILABLE; no answer → stays
   unavailable (an unknown result never confirms a loss *and* never confirms health). Concurrent signals share one probe.
3. **Healthy tables** re-check their identity every 5 s, and the driver-level identity check runs before every click.
4. **On TARGET_LOST** (`SimulatorTable.targetLost`, idempotent): capture is revoked locally (later grabs never reach the host — the handle
   may be reused), the last reading/state is discarded, the scheduler invalidates the registration (§4), the executor pauses the table, the
   driver authorisation is revoked (`unregister-target`), the capture session is closed, one lifecycle record is written, and `run()` returns.
5. **Temporary failures** back off 250 ms → 500 ms → … → 4 s (attempt budget 120, time budget 5 min; then SAFETY_PAUSED "capture unavailable
   for too long"). When capture works again: RECOVERY_PENDING, the hand tracker is paused until fresh readings agree with the screen (as for
   a restored checkpoint), the identity is probed again, the calibration is checked against the current client rectangle, and only after
   two fresh accepted readings does the table return to ACTIVE. Decisions taken before the interruption are invalid (generation).

## 4. How stale input is cancelled

* **Scheduler** (`InputScheduler.invalidateTable(table, reason, registrationId)`): rejects that registration's queued jobs (`target-lost`),
  voids the running job's lease and calls `onCancel` (driver `cancel-all`) **only when the running job belongs to that table**, refuses
  every later job of that registration, and leaves other tables' queue positions alone. A replacement window has a new registration id
  and is not affected (`reinstateTable` exists for an explicit re-enable).
* **Adapter** (`UiAutomationAdapter.submit`): the lease and a lifecycle guard are checked before typing the wager and again before pressing
  the action button; a refusal there is a clean "nothing sent" (`lease-invalid`, `lifecycle-blocked`, `target-lost`).
* **Driver wrapper** (`WindowsUiDriver`): immediately before each `move-click` / `enter-text` it re-reads `window-info`, compares
  pid / process start time / class with the registration, and runs the table's guard (ACTIVE, same generation as the decision). The real
  driver then repeats its own identity check before and during the movement.
* **Races** between capture, reconstruction, decision, scheduling, movement, press and confirmation are covered: a decision whose
  generation changed is discarded before scheduling; the lease revalidation re-captures and re-checks the generation; the guard runs before
  the press; a capture during confirmation that reports a loss is confirmed with the driver.
* **Uncertain actions:** if the window disappears (or automation is stopped) after the driver accepted the click but before the next
  reading confirmed it, the log entry is `uncertain` with `reviewRequired: true`, the table is SAFETY_PAUSED or lost, and the action is
  **never re-sent** (the executor's slot stays "sent"). A driver cancellation the driver reports as "before button-down" is recorded as a
  clean `cancelled-before-input`.

## 5. How replacement-window registration works

1. A lost registration stays visible as TARGET_LOST ("Simulator window closed … Reopen the simulator and register its window again").
2. **Refresh registered windows** / **Review replacement window** list top-level windows through the driver and offer only windows of the
   same executable file name that are not the lost (handle, process instance), not registered and not minimised; each is then checked with
   `exe-identity` and offered **only if its SHA-256 equals the lost registration's**. Title is used only for ranking, never as identity; a
   reused handle number is shown as such and accepted only because the process instance differs and the SHA-256 matches.
3. The card shows lost vs candidate (handle, process, executable, SHA-256, client size, display scaling). Registering requires the three
   confirmations in the card and a confirmation dialog; it is refused while the emergency stop is latched.
4. Registration re-verifies the SHA-256 and the profile's executable binding, issues a **fresh** authorisation (`register-target`), checks
   the calibration against the new window (`calibrationReport` must be ready), opens capture, and creates a **new** lifecycle
   (REGISTERED, `replaces: <old id>`). If the size or scaling changed, a dry run (Preview mouse movement) is required before automation.
5. Nothing is inherited: automation for the replacement is off until the operator presses **Enable automation for this table** (while a
   session runs) or **Start**; even then it acts only after identity verification and a fresh reading. The old registration is retired
   (kept in the diagnostic export). **Remove lost registration** deletes a lost entry. No window is ever launched automatically.

## 6. How emergency-stop priority is preserved

The existing driver latch, hotkey, scheduler `emergencyStop` and executor behaviour are unchanged. In addition the dashboard puts **every**
registration (running or not, including unavailable ones) into SAFETY_PAUSED; SAFETY_PAUSED and STOPPED leave only by an explicit operator
action and only to RECOVERY_PENDING (fresh verification); a late capture result cannot change the state (generation); replacement
registration and per-table enable are refused while the stop is latched; reset leaves automation off and every table paused. Manual
override (driver yield) and an unconfirmed action now also put the table into SAFETY_PAUSED. Verified by Test G, the dashboard test and the
stress test (emergency stops with input attempts counted: none reached the driver while latched).

## 7. What was tested, and results

All on Linux (x64, Node 22.23.5 — the version bundled for Windows —, Chromium via Playwright, Mono 6.8). **None of it is Windows evidence.**

| Suite | Result | Evidence |
|---|---|---|
| Phase 1/2 reproduction, Milestone 1 vs 2 | M1: 590 captures / 71 s, endless; M2: 1 capture, TARGET_LOST, loop ended | `evidence/0.36.2-m2/repro-*.json`, `phase1-*.json` |
| Lifecycle regression Tests A–J (+ B2, B3, I2) and state-machine units | **18 passed, 0 failed**, 5 consecutive clean runs | `tests/lifecycle-0362m2.test.cjs` |
| Dashboard recovery flow in Chromium | **1 passed**: start with a closed window → no capture, no arm; lost message; candidate offered; refusals without confirmations and while estop latched; fresh authorisation; automation stays off; export | `tests/simulator-ui-0362m2.test.cjs` |
| Lifecycle acceptance scenarios A–K, `--fake` self-check of the Windows tool | **11/11 scenarios passed** (logic only) | `evidence/0.36.2-m2/lifecycle-acceptance-linux-fake.json` |
| Stress: 8 tables, 120 s, random closes/reopens, minimise, transient failures, handle reuse, emergency stops | **PASS, 0 violations** (28 registrations (27 lost), 387 confirmed actions, 2 uncertain (never re-sent), faults {"close": 20, "reopen": 20, "minimize": 13, "transient": 19, "reuse": 7, "estop": 9}, diagnostics 2792 stored of 3715 records) | `evidence/0.36.2-m2/lifecycle-stress-linux-fake.json` |
| Complete existing + new Node suite | 920 tests: **866 passed, 2 failed, 52 skipped**. The 2 failures were the checksum manifest (regenerated when packaging) and `release-0362m2` (run before this report existed); both pass against the final package. Skipped: tests that need the Windows `mwcli.exe`, PowerShell or the .NET SDK (same categories as the Milestone 1 baseline) | `evidence/0.36.2-m2/m2-linux-node-tests.tap` |
| Build check (Mono, .NET Framework 4.8 reference assemblies) | all 4 C# components compile; all shipped binaries identical to the Windows build; sources identical | `evidence/0.36.2-m2/build-check.json` |

**Milestone 1 baseline on the same Linux machine** (before any change): 897 tests, 825 passed, 0 failed, 72 skipped
(`baseline-M1-linux-node-tests.tap`). Installing Mono and openbox here enabled 17 previously skipped tests; three of them **failed identically
on the unmodified Milestone 1 tree** (`baseline-M1-linux-mono-tests.tap`): (a) a WGC session stub lost its execute bit in the Windows-made
ZIP — `tests/capture-029.test.cjs` now sets it before running the stub (an extracted ZIP never needs to preserve it); (b) `tests/windows-025.test.cjs` still expected `0.35.0` inside the host that Milestone 1 rebuilt as `0.36.2` —
literal corrected per component (it was skipped on the Windows runner because Mono is absent there); (c) the host-shutdown harness needs the
`openbox` window manager — installed. All three pass now.

**Failures found and repaired during Milestone 2 development** (all before packaging): confirmation polling consumed the retry budget in 1 s
(confirmation now only checks for a loss, rate-limited); a fresh hand tracker after an interruption could never follow a hand in progress
(the tracker is now paused instead of replaced); the recovery card was rebuilt every 2 s and would reset the operator's ticks (now only on
change) and used a CSS class that made it 23×30 px; `identityOf()` briefly dropped `processStart`/`className`/`exe` through a misplaced comment —
caught by the acceptance self-check, fixed, and pinned by two new tests (I2 and an identityOf unit test); handle text was normalised before being
sent back to the driver (now sent verbatim, compared normalised); the acceptance tool did not pass the driver capabilities to the scheduler
(now does, like the dashboard).

**Pre-existing defect found (not fixed, not caused by Milestone 2):** the bundled simulator shows eliminated (zero-stack) tournament players as
folded from the first frame of the next hand, and `HandStateEngine` treats any folded seat in a hand's first frame as a missed hand start, so it
refuses every later hand and automation stops acting (safely — no input). Reproduced identically on Milestone 1 and Milestone 2
(`tools/repro-elimination-stall-0362m2.cjs`, `preexisting-elimination-stall-M1.json` / `-M2.json`). The acceptance scenarios therefore use
deep stacks. Fixing it changes hand reconstruction (the ledger has no notion of eliminated seats) and is proposed for Milestone 3.
Also observed, not changed: `windows/Start-Desktop.ps1`'s fallback compile (used only when the prebuilt host cannot start) omits
`desktop/InputBroker.cs`, which the host needs.

## 8. Which tests passed and failed

Passed: everything listed in §7. Failed at the end: **none** in the final package (the two manifest/report-order failures above are resolved by packaging; the re-run of the extracted package is recorded next to the ZIP in `EightMax-Test-Workbench-0.36.2-Milestone-2-verification.json`, outside the ZIP because a ZIP cannot contain its own verification). Known pre-existing, not fixed: the elimination stall and the `Start-Desktop.ps1` fallback compile (§7). Not run: anything on Windows (§10).

## 9. Were Windows executables rebuilt?

**No — deliberately, because no Windows component changed.** Milestone 2 modifies no C# file; every source file of every executable is
byte-identical to the one the Milestone 1 Windows build compiled (`evidence/build-evidence.json`, csc 4.8.9221.0, GitHub Actions run
45083913369), and every shipped executable is byte-identical to that build (`evidence/0.36.2-m2/build-check.json`, also asserted by
`tests/release-0362m2.test.cjs`). Rebuilding would only have replaced Windows-compiled, Windows-verified binaries with binaries that could not
be executed on Windows in this session. The build check additionally compiled all four components with Mono against the .NET Framework 4.8
reference assemblies (outputs discarded; the input driver without UI Automation, whose reference assemblies are Windows-only).

| File | Version | SHA-256 (unchanged from Milestone 1) |
|---|---|---|
| `desktop/bin/EightMaxWorkbench.exe` | 0.36.2.0 | `845578b9a6596009e68ce6f182d47ae20ddd511f58b9c37a3d4b12e1c7f32290` |
| `desktop/bin/EightMaxInput.exe` | 0.36.2.0 | `93867a03f43534d65d41853901b706bb892456894cb118f89b5d4a80bce71da1` |
| `desktop/bin/EightMaxTestTable.exe` | 0.36.2.0 | `3e5a76995a24d169336179e7e3805ddeb57271d951029226b43653c217464348` |
| `desktop/bin/EightMaxCapture.exe` | 0.35.0.0 | `8180c32910bfd1d5053c42f8c9ccf484bb6146022dc1284e45dbbde622124da0` |
| `desktop/bin/EightMaxWgc.exe` | 0.35.0 | `bc001504382306e180af0f76abf0836d561faa07e8c210317df73048e55cafc1` |
| `native/mwcli.exe` | EightMax 5.1, build 7d08acc7eb4577ee | `b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72` |
| `runtime/node/node.exe` | v22.23.5 | `247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a` |

The dashboard (`START.html`) was regenerated from the changed sources (`tools/build.py`).

## 10. Was the native engine preserved?

Yes. `native/mwcli.exe` and `vendor/` are byte-identical (SHA-256 above, checked by `tests/release-0362m2.test.cjs`, the build check and
the Windows runner, which also runs `mwcli.exe --build-id`). No solver mathematics, strategy coverage or native interface changed. Strict
EightMax still pauses with "No compatible EightMax preflop study is loaded" when no compatible study is loaded; that condition is recorded as
its own diagnostic family (`strategy-unavailable`), never as a capture failure, and never switches to scripted practice.

## 11. What remains unverified on your computer

Everything that needs Windows:

* **Real-window lifecycle behaviour** (scenarios A–K with the real host, driver, capture and test tables) — run `RUN-0362-MILESTONE2-TESTS.cmd`
  (instructions in `READ-ME-MILESTONE2-TESTS.txt`; results in `test-results\Milestone2-<date-time>\` plus a ZIP). The same scenario code passed
  against the fake host here, but timing, window messages, minimise/restore and capture behaviour on Windows are untested.
* **`windows/Test-Milestone2-0362.ps1` has never been executed or even parsed by Windows PowerShell** (no PowerShell was available here). It
  follows the patterns of the Milestone 1 script that ran on Windows and passed the repository's static PowerShell checks; the CI workflow
  parses every script with the Windows PowerShell 5.1 parser first.
* The dashboard on Windows with your real simulator windows (tested here only in Chromium against a fake host).
* Your hardware: Windows 11 Home x64, i7-13700F, 16 GB, RTX 4060 Ti, 3840×2160 at 125 %. Display-scaling and resize behaviour is covered by
  scenario K and recorded per monitor by the runner, but has not run at 125 % anywhere.
* Earlier open items from Milestone 1 (dashboard-driven strict-mode action with a validated study, multi-table capacity, install/rollback).

## 12. Proposed for Milestone 3

1. Run the Milestone 2 Windows tests (your PC and `windows-0362-m2.yml`) and fix whatever they find.
2. Hand tracker: follow hands that start with eliminated / sitting-out players (the stall in §7), with a recovery path for "untracked hand"
   when the simulator waits for the hero.
3. Host defence in depth: `CaptureService` reports an invisible window as `target-hidden` instead of `target-lost`, verifies the process start
   time like the driver, and counts requests for lost targets; a driver `cancel-target` command so cancellation never needs `cancel-all`.
   (Both need a Windows rebuild, which is why they were not done blind here.)
4. Integrate the upgraded native solver once it is ready (identity, compatibility checks, strict-mode acceptance with a validated study).
5. Fix the `Start-Desktop.ps1` fallback compile (`InputBroker.cs`), the intermittent strategy-library concurrency test from Milestone 1, and
   complete install / uninstall / rollback acceptance.

## Package

`EightMax-Test-Workbench-0.36.2-Milestone-2.zip`: the complete application tree (Milestone 1 tree plus the changes above), unchanged
executables and runtimes, full sources (`source-0.36.1-original/` kept from Milestone 1), the Windows Milestone 2 runner and instructions,
tests and tools, `evidence/0.36.2-m2/` (raw machine-readable results: reproductions, Linux test TAP, stress, fake acceptance, build check,
diff), `release-0362-m2.json`, this report and a regenerated `SHA256SUMS.txt`. The ZIP's own SHA-256 is published next to it
(`.sha256`), since a file cannot contain its own hash.
