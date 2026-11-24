# 0.36.2-dev - Milestone 4.0: multi-table input performance, recognition at display scaling, input reliability, performance tests

Operator PC (Windows 11 Home, i7-13700F, 3840 x 2160 at 125 %), Milestone 3.2: 142 passed / 0 failed / 1 warning / 5 skipped; eight tables: scheduling delay 4.40 s, action latency 5.43 s, 77 confirmed actions, 2 deadline misses. Everything below is optional per setting or per command: with the input pipeline "Milestone 3.2 compatibility" and the policy edf the Workbench sends exactly the Milestone 3.2 input sequence (the before/after comparisons ran both on the same Windows machines).

- **Profiling:** `src/action-timeline.js` - up to 21 monotonic stages per action (capture, recognition, validation, decision, queue, lease, revalidation, wager, movement, click, driver acknowledgement, settle, confirmation) and 23 intervals, aggregated per table and overall (mean / median / P90 / P95 / P99 / max); the driver reports its own phase times; `tools/resource-sampler-040.cjs` (CPU, memory, GPU 3D engine).
- **Input pipeline `optimized` (dashboard default):** the cursor lease holds only the work that needs the cursor - the 150 ms settle runs after the lease once the driver confirmed the clicked button processed the release; no second window check (the driver's own identity and client-rectangle check remains); the raise of a covered window polls instead of a fixed 30 ms wait; the double-click spacing applies per target process (globally after any click whose processing was not confirmed); revalidation inside the lease and confirmation polls read the status-strip region (every check unchanged; the 4 000 ms confirmation timeout unchanged); a reserved host slot for input-critical requests; a decision deadline counts from the request of the last capture that still showed the PREVIOUS status-strip revision - the turn began after it - instead of from the decision reading, so a late first reading can no longer move the deadline past a table clock that started with the turn (stricter, never longer; the decision window itself unchanged).
- **Scheduler:** policies edf (default, the Milestone 3.2 order), fifo, lst, edf-aging, fair-rr, nearest-guarded; bounded bypass (no starvation); fairness, utilisation, queue-depth and wait metrics; deadline check from the planned movement at the configured speed.
- **Input driver (rebuilt on Windows):** capture barrier (a WinForms button raises Click only if, when its window PROCESSES the release, the button is still under the cursor; the control that took the press holds the mouse capture until then, so the click reply - and with it the cursor lease - waits until that capture is released, at most 600 ms; a capture never seen keeps the settle inside the lease and the next click under the global spacing; `BM_GETSTATE` cannot show this for owner-drawn WinForms buttons); press guard (a press that reached another window because its target closed or was covered at that instant is released off that control - no click there - and reported `press-misdirected`; never repeated); phase timings; read-only queries answered during a movement.
- **Mouse speed:** presets Conservative 800 / Normal 1 200 / Fast 2 000 px/s and Custom 400-2 800 px/s; the current speed shown in plain language; presets change speed and acceleration only, only when picked; saved settings load unchanged (an unmatched speed shows as Custom).
- **Recognition at display scaling:** `src/coordinate-spaces.js` (physical / logical / client / capture / normalised); exact-width templates; **Verify Table Recognition** (dashboard, and before automation starts; `src/recognition-check.js`): a safety-critical failure keeps that table's input off; automated play refuses a scaled capture.
- **Tests and tools:** `RUN-M4-PERFORMANCE-TEST.cmd` (A recognition verification, B scheduler benchmark, C extended simulator test, D full acceptance, E package an earlier run; `READ-ME-MILESTONE4-TESTS.txt`); `tools/recognition-validation-040.cjs`, `motion-validation-040.cjs`, `capacity-model-040.cjs`, `make-m40-evidence.cjs`; one-hero-per-table workload in the test fixture (hero timeouts reported apart for hands the Workbench tracked and for hands it never saw from their opening, where it never acts by design); evidence of every unconfirmed input of a multi-table run (the click reply's press-guard, capture and drain fields, the table's own events and every other window's presses and actions around it); the fixture's oracle records a press and release on an enabled button that raised no click (`release-without-action`); tests `tests/scheduler-0362m40`, `input-driver-0362m40`, `paused-window-optimized-0362m40`, `recognition-check-0362m40`, `release-0362m40`, `fixture-dealer-0362m40`, `deadline-anchor-0362m40`.
- **Found by Windows CI and repaired:** a press could reach another table's window when the target window closed at that instant (Milestone 3.2 pipeline, run 45401450070; press guard); option D/E of the runner rewrote a COMPLETED run's report as a recovered one (run 45409782425; a finished run is no longer rewritten); a driver test assumed a fast machine (run 45395967209); a resource-sampler timer outlived the run (run 45395967209); a 4.0 edit of the test fixture's dealer had turned the revision step and the oracle record of the table clock's own action into a comment (found while analysing the one-hero runs; the Milestone 3.2 behaviour is restored and tested).
- EightMax 5.1 (`native/mwcli.exe`, build 7d08acc7eb4577ee) byte-identical; no strategy, GTO or decision-policy change; scripted practice decisions remain labelled non-GTO.

# 0.36.2-dev - Milestone 3.2: input confirmation reliability, paused-window monitoring, target-loss recovery, multi-table isolation

Operator PC (Windows 11 Home, 3840 x 2160 at 125 %, 2026-11-24), Milestone 3.1 full acceptance: 140 passed / 1 failed / 1 warning / 5 skipped. The failure, T5: `table 2 TARGET_LOST after its window closed ("ACTIVE"); the scheduler blocks only table 2 ([])`.

- **Root cause (established in the code, reproduced deterministically on the Milestone 3.1 tree with `tools/repro-paused-target-lost-0362m32.cjs`):** table 2's Call click was delivered but its table showed no change for the 4 000 ms confirmation window; the executor classified it rejected and paused the table's GAMEPLAY while its window lifecycle stayed ACTIVE. Every later `SimulatorTable._step()` returned "paused" before the periodic identity check (which also ran only in ACTIVE), and `run()` slept without any host request. When T5 closed the window, nothing ever probed it: the lifecycle stayed ACTIVE and `InputScheduler.invalidateTable()` was never called. The host request log from the operator PC confirms it: no identity probe and no `capture/close` for table 2 after its pause.
- **`WindowHealthMonitor` (`src/window-lifecycle.js`):** verifies the original registered identity (window-info: handle, process id, process start time, class) on its own timer in every non-terminal state - gameplay paused, SAFETY_PAUSED, STOPPED, REGISTERED, TEMPORARILY_UNAVAILABLE, RECOVERY_PENDING, ACTIVE (backstop) - about once a second while paused or recovering, every 5 s once a table is stopped or its tournament finished (nothing can resume those without the operator); reports only a confirmed loss (closed window, reused handle); never resumes gameplay, never authorises input; single-flight, shares evidence with the table's own probes, backs off on unknown answers, discards late answers after a loss, stops for good at TARGET_LOST.
- **Terminal path from any state:** `targetLost()` records the state it interrupted, stops the monitor, revokes capture and the driver authorisation, invalidates the scheduler registration (queued input rejected, running input cancelled), discards pending decisions. A capture failure is judged only by a probe that started after the failure was known (a probe answer taken just before a close no longer turns a loss into "temporarily unavailable").
- **Scheduler (`src/input-scheduler.js`):** explicit registrations (`registerTable`); invalidation revokes a registration for good and is idempotent; `unavailableTables` lists exactly the tables whose current registration is lost; a re-registered table is available again; a pause set by an older registration no longer blocks its replacement (latent: the replacement window of a safety-paused table could never act); per-table scheduling metrics.
- **Input confirmation:** one input status per attempt (confirmed / rejected before input / rejected without a state change / uncertain / timed out / cancelled); an action delivered but not applied is now a SAFETY_PAUSE (`input-rejected`, "Action not applied") instead of a gameplay pause behind an ACTIVE lifecycle; never retried automatically. Every input that was sent but not confirmed leaves an evidence record (table, registration, handle and identity fingerprint, action, control region, click point, display scaling, client rectangle, foreground state, driver result, scheduler lease, confirmation trace with status-strip revisions, frames before/after); no session key or desktop content outside the window.
- **T5 strengthened, T5P added (`tools/gameplay-acceptance-0362m3.cjs`):** numbered event-based assertions 1-9 with bounded waits and an event timeline; T5P reproduces the operator condition on real Windows (the fixture dealer ignores one click on purpose: `drop-next-action`); input-confirmation reported separately as a WARNING with evidence. Suite `t5 --repeat N`.
- **Standalone `RUN-M3.2-T5-TEST.cmd`** (runner mode `-Mode T5`): environment, integrity, components, the Milestone 3.2 regression tests, host + input driver, T5/T5P x3, cleanup (port 48713); results `Milestone3.2-T5-<date>-<time>-t5-test\milestone3-results.zip` and `T5-SUMMARY.txt`.
- **Tests:** `tests/paused-window-0362m32.test.cjs` (scenarios A-R of the brief and unit tests of the monitor and scheduler), `tests/release-0362m32.test.cjs`. Multi-table measurements in the stability report (scheduling delay, cursor travel, input operation, confirmation, action latency, deadline misses, rejected / uncertain actions, window-loss response).
- No executable rebuilt; EightMax 5.1 (`native/mwcli.exe`, build 7d08acc7eb4577ee) byte-identical.

# 0.36.2-dev - Milestone 3.1: Windows test-runner repair, startup diagnostics, crash recovery, reliable reports

Operator PC (Windows 11 Home, 2026-11-23), two Milestone 3 runs: 114 passed / 1 failed / 1 skipped regression tests, then the host-start phase showed nothing and no report was produced. Causes found and repaired:

- **Release-checksum test failed on the runner's own logs (reproduced byte for byte):** `tests/release-0362m3.test.cjs` (and `release-033`) walked the whole application folder and required every file to be listed in `SHA256SUMS.txt`, while `windows\Test-Milestone3-0362.ps1` wrote `test-results\Milestone3-<date>\` into that folder before the unit phase (run 1 failed on its own `mwcli-build-id.err.txt`, run 2 on run 1's `host-prebuilt host launch.err.txt`; CI passed only because it used `-OutDir` elsewhere). New `release-integrity-policy.json` defines the immutable payload; `tools/release-integrity.cjs` and `windows/M31-Integrity.ps1` verify every listed file's SHA-256, fail on missing or changed files and on any unlisted executable or script, never count runtime output (`test-results\`), and report other unlisted files by name.
- **No report after an interrupted run:** the Milestone 3 runner kept results in memory and wrote phase state, report and ZIP only after the last phase. `windows/Test-Milestone31.ps1` (+ `M31-Lib.ps1`) writes `run-status.json` (atomically), `console.log`, `errors.log`, `checks.jsonl`, `operations.jsonl` and `phases\*.json` continuously, finalises the report and ZIP after exceptions, time-outs and Ctrl+C, and packages a run whose process was killed (window closed, shutdown) on the next start or with option D - marked INTERRUPTED, nothing invented.
- **host-start stopped responding (reproduced on Windows):** `Start-Desktop.ps1` launched the host with a plain `Start-Process` (Windows shell). On files extracted from a downloaded ZIP (Mark of the Web) the shell opens "Open File - Security Warning" and waits - and because the runner started the script hidden, that dialog was invisible (`#32770`, visible 0, owned by the hidden PowerShell), so it could never be answered; the runner waited up to 900 s per case with no output. The same script on unmarked files finishes in about 2 s. Headless (test) launches now use CreateProcess with the host's stdout/stderr captured, every Start-Desktop step is traced, and the twelve host-start operations each have a time limit, progress output, and on a time-out the process tree, prompt windows (SmartScreen / security warning), port owner and Mark of the Web are recorded before only this session's processes are stopped (Windows job object).
- **New launchers:** `RUN-0362-MILESTONE3.1-TESTS.cmd` (A quick, B startup diagnostics, C full acceptance, D package an earlier run, L results folder) and `RUN-M3-HOST-DIAGNOSTIC-3.1.cmd` (standalone): CRLF/ASCII, checked application folder, 64-bit PowerShell even from a 32-bit console, PowerShell proven before the test, stderr captured, a diagnostic file and ZIP even when PowerShell or the runner cannot start, exit codes 0-6, File Explorer opens at the ZIP. Results default to `%LOCALAPPDATA%\EightMax-Test-Workbench\TestResults\`. `RUN-0362-MILESTONE3-TESTS.cmd` now starts option C.
- **Regression suite in a folder with a non-ASCII character (found by the Windows CI full acceptance):** `tests/release-consistency.test.cjs` copied the sources with `fs.cpSync`, which made the bundled Node.js 22 stop (exit 0xC0000409) when the application folder path contains a character such as an accented letter; the test now copies with plain directory reads. The runner names a test file that stops without reporting its tests together with its exit code.
- **Unchanged:** EightMax 5.1 (`native/mwcli.exe`, build 7d08acc7eb4577ee), every executable (no C# source changed), the simulator, gameplay, hand tracking and input-driver safety.

# 0.36.2-dev — Milestone 3: tournament hand tracking, simulator stability, test automation, Windows hardening

Root cause of the elimination stall (found in Milestone 2, pre-existing since 0.36.1): the bundled simulator shows an eliminated (zero-chip) tournament player with the folded marker from the first frame of every later hand; `HandStateEngine._track()` treated any folded seat in a hand's first frame as a missed hand start (`missed-hand-start`, then `untracked-hand` for the whole hand), the ledger charged every seat an ante and placed the blinds at fixed offsets from the button, and `_build()` expected the eight-handed 2.3 BB opening pot. Every hand after the first elimination was refused and the controlled table, which only advances when its player to act acts, waited forever.

- **`src/hand-ledger.js`:** explicit participation per seat (`inHand`, `outReason`: eliminated / sitting-out; `folded` means folded in this hand only); antes only from players dealt in (short stacks post what they have); moving button; blinds skip seats that are not dealt in; heads-up button posts the small blind; a short big blind does not lower the amount to call (simulator rule); `forcedBets()`; settlement checks that a seat not dealt in neither pays nor wins; serialization version 1 unchanged for full tables, version 2 with eliminated seats; old version-1 data still restores. Differentially tested against the simulator over 40 complete tournaments.
- **`src/hand-state.js`:** seat statuses active / folded / all-in / eliminated / sitting-out / unknown; opening reconstruction checks hand number, participation, button, blind positions, antes, stacks, opening pot, first actor and board, each with a specific reason; a seat shown folded WITH chips is still a missed action; a tournament seating model (eliminations, heads-up, settled stacks, previous button, completion) with tournament rules `auto` / `strict` / `off`; explicit untracked-hand status, reason, observed hand, expected recovery, last valid hand and recovery counter; a persistent contradiction becomes an explicit untracked hand; checkpoint version 2 (version 1 still restores). Also fixed (pre-existing since 0.35): a reading with NO controls shown while the viewer is to act (think-time hold, one seat acting on two streets) was refused, which made the Workbench's own action unconfirmable and paused the table.
- **`src/simulator-controls.js` / dashboard:** gameplay conditions (waiting for a valid hand, reconstruction failure, player eliminated, invalid chip accounting, strategy unavailable, capture unavailable, target lost, emergency stop, manual override, input confirmation failure, tournament finished, ...) shown separately and written to the diagnostics only on change; no decision until fresh readings agree after a recovery (`verifying`); a finished tournament ends `run()` normally (lifecycle STOPPED, cause `tournament-complete`, "Tournament finished. Automated gameplay has stopped normally."); strict tournament rules for the bundled fixture.
- **`windows/Start-Desktop.ps1`:** the fallback compile includes `desktop/InputBroker.cs` (it could never compile before); cache folder named after a fingerprint of format, options, references, runtime and every source; a cache manifest is checked before reuse; invalid caches are rebuilt; `-Headless` is kept on the fallback path; `-CacheRoot` / `-StatusFile` for tests.
- **Test runners:** cancellable timeouts and per-scenario resource scopes in `tools/lifecycle-acceptance-0362m2.cjs` (the Milestone 2 runner stayed alive up to 8 minutes after writing its report); same repair in the stress, benchmark and repro tools and in three tests; `tools/exit-audit-0362m3.cjs` measures report-to-exit time and exit codes. `tests/ui.test.cjs` no longer writes screenshots into the shipped tree.
- **Fixture:** optional action clock (`--action-timeout`, `--action-timeout-until-hand`), per-seat `--stacks`, `act` / `clock` test commands, full oracle summaries.
- **Tests and tools (new):** `tests/tournament-0362m3`, `recovery-0362m3`, `negative-0362m3`, `start-desktop-0362m3`, `simulator-ui-0362m3`, `release-0362m3`; `tools/gameplay-acceptance-0362m3.cjs` (acceptance T1–T6, multi-table stability 1/2/5/8, long campaign; real windows or `--fake`), `tools/repro-elimination-stall-0362m3.cjs`, `tools/build-check-0362m3.py`; `RUN-0362-MILESTONE3-TESTS.cmd`, `windows/Test-Milestone3-0362.ps1`, `.github/workflows/windows-0362-m3.yml`. The Milestone 3 Windows runner writes plain dictionaries only (the Milestone 2 runner crashed while writing its results on Windows PowerShell 5.1).
- **Found by the first real-Windows run of these tests (GitHub Actions run 45203097931) and fixed:**
  - *Card recognition at 800 px (pre-existing since 0.24, reproduced on the Milestone 2 code):* card templates were calibrated from the first board slot only; the other slots sit at other sub-pixel offsets, and at 800 px four cards drawn in the turn slot (5h, 6c, 8s, Td) read with confidence 0.883–0.892, under the 0.9 threshold. A table showing one of them on the turn could not be read for the rest of the hand, so the Workbench paused ("no reliable reading", or "hand changed with no record of the action" when the result screen could not be read). `src/sim-display.js` now calibrates from every board and hero slot (each card drawn once per width): every card in every slot at every calibrated width reads at 1.0, uncalibrated widths improve (cards under 0.9: 66 → 13 of 1,820), reading is faster (22 vs 34 ms per frame).
  - *Unreadable frames escalated (introduced in Milestone 3):* 25 consecutive low-confidence readings turned the hand untracked ("persistent contradiction"). Unreadable frames (`UNREADABLE_CODES`: low confidence, missing or impossible fields) are still refused and still block input, but no longer end the tracking of a hand that resumes as soon as the screen reads reliably.
  - *Readings refused while confirming an action were silent:* they are now recorded in the diagnostics (coalesced) and counted as refused readings.
  - *Input driver (pre-existing since 0.35):* after an operation of its own that stopped part-way (window closed or moved, cancelled), `EightMaxInput.exe` did not update the cursor position it remembers, so the NEXT operation — for any table — failed as "the cursor was moved by someone else" (two-table stability run). The remembered position now follows the driver's own last point when the cursor is still exactly there (a person's movement is still detected; never after a manual override or an emergency stop). `desktop/input/Driver.cs` changed, so **`EightMaxInput.exe` was rebuilt on Windows** (GitHub Actions run 45216843075, `windows\Build-Executables.ps1 -SkipWgc`, .NET Framework 4.x compiler; record in `evidence/build-evidence.json` and `evidence/0.36.2-m3/driver-build/`). Every other executable is the unchanged Milestone 1 binary.
  - *Strategy library on Windows (pre-existing):* a lock file another worker thread had just removed can be "delete pending"; creating it failed with EPERM instead of EEXIST (intermittent regression-test failure on the runner). EPERM / EACCES / EBUSY now mean "lock busy" on Windows and are retried within the same time limit; releasing the lock retries the same way.
  - *Test fixture:* a hand in which nobody has to act (everyone all-in from the forced bets) kept the previous hand's view — possibly an eliminated seat holding no cards — so the final screen of a tournament could not be read; the table now always shows a seat dealt in to the hand. A window that had already exited crashed the fixture at shutdown (asynchronous EPIPE, exit code 1). A reopened table (each new tournament of the campaign and stability runs) dealt with the same seed as the table it replaced, so every replacement tournament replayed the first one hand for hand; each generation now deals its own hands.
  - *Windows runner and tools:* check names with a colon were used as file names (NTFS alternate data stream: the two invalid-cache start cases failed); the cleanup audit sampled a closing child-process handle as a leak; a failed scenario now leaves a diagnostics dump (`diag-*.json`: tracking status, lifecycle, last recorder events); the Linux `--fake` self-checks now use the Windows fixture's table size (800 px) and dealer seeds, so they deal the hands the Windows run deals (with 960 px they had missed the card defect).
- **Unchanged:** EightMax 5.1 (`native/mwcli.exe`, build 7d08acc7eb4577ee), every Windows executable except `EightMaxInput.exe` (byte-identical to Milestone 1), solver mathematics and interfaces, strategy coverage, mouse-movement algorithms, Milestone 2 lifecycle safety.

# 0.36.2-dev — Milestone 2: simulator window lifecycle, safe recovery, bounded diagnostics

Root cause of the operator's repeated `target-lost` report (592 of 592 table frames rejected, 801 capture events, 0 actions): `SimulatorTable.look()` turned every capture failure into "no reading yet" and `run()` (started by the dashboard with `run(Infinity)`, `stopOnPause:false`) retried every `idlePollMs` (120 ms) forever, without asking whether the window still existed; the dashboard also started automation for a registration whose window was already gone, and every failed frame was logged individually.

- **`src/window-lifecycle.js` (new):** explicit per-window state machine REGISTERED / ACTIVE / TEMPORARILY_UNAVAILABLE / RECOVERY_PENDING / TARGET_LOST / STOPPED / SAFETY_PAUSED with a documented transition table, generation tokens (late async results are dropped), operator-only exits from STOPPED and SAFETY_PAUSED, absorbing TARGET_LOST; capture-failure classification; driver identity probe (handle, process id, process start time, class, executable, SHA-256); bounded exponential backoff (250 ms … 4 s, attempt and time budget); replacement-candidate search.
- **`src/simulator-controls.js`:** every capture failure is confirmed with the input driver; confirmed loss revokes capture locally, cancels the table's queued and running input through the scheduler, revokes the driver authorisation, ends `run()`; temporary failures back off and return to ACTIVE only through RECOVERY_PENDING after identity verification and fresh readings; every decision carries a lifecycle token checked in the lease, by a guard immediately before the click, and by the driver identity check; an action that may have been delivered before a loss is recorded `uncertain` with `reviewRequired`, never re-sent; periodic identity check of healthy tables; strategy-unavailable is its own diagnostic family.
- **`src/input-scheduler.js`:** `invalidateTable(table, reason, registrationId)` / `reinstateTable`; registration-scoped refusal (`target-lost`); re-check after revalidation.
- **`src/execution-adapters.js`:** lease and lifecycle guard checked before typing and before clicking; new clean refusal codes; `DiagnosticsRecorder` coalesces identical consecutive failures (first event + one `repeat-summary`), keeps exact `counts` and `failureTotals`, `flush()`, `success()`; export fields are additive.
- **`src/windows-input-driver.js`:** identity re-check from `window-info` and lifecycle guard right before every click / wager; driver cancellations reported "before button-down" map to `cancelled-before-input`.
- **Dashboard (`src/simulator-controls-ui.js`, `dashboard.html`, `START.html`):** lifecycle column with plain-language messages, last successful capture, failure reason, whether the original window exists, automation state, cancelled queued action, recovery availability, re-registration requirement; Refresh registered windows, Review replacement window, Re-register (three confirmations + dialog, fresh authorisation, SHA-256, profile binding, calibration check, dry run when geometry or scaling changed), Remove lost registration, Enable automation for this table, Export diagnostic report (registrations, retired registrations, lifecycle events, failure summary). Start checks every registration first and never captures a lost one. Emergency stop puts every registration into SAFETY_PAUSED and replacement registration is refused while it is latched.
- **Tests:** `tests/lifecycle-0362m2.test.cjs` (Tests A–J + state machine), `tests/simulator-ui-0362m2.test.cjs` (dashboard recovery in Chromium), `tests/lifecycle-host-fixture.cjs`; fake hosts now report the identity fields the real driver reports; `tests/windows-025.test.cjs` component versions corrected (host 0.36.2).
- **Windows:** `RUN-0362-MILESTONE2-TESTS.cmd`, `windows/Test-Milestone2-0362.ps1`, `tools/lifecycle-acceptance-0362m2.cjs` (real windows, scenarios A–K), `READ-ME-MILESTONE2-TESTS.txt`; `tools/test-table-035.cjs` gains `reopen` and `--keep-alive`.
- **Unchanged:** every Windows executable (byte-identical to Milestone 1), EightMax 5.1 (`native/mwcli.exe`, build 7d08acc7eb4577ee), solver mathematics, strategy coverage, native interfaces, mouse-movement algorithms.

# 0.36.2-dev — Milestone 1: Windows compilation and executable verification

Rebuilds EightMaxWorkbench.exe, EightMaxInput.exe and EightMaxTestTable.exe from the unchanged 0.36.1 application sources on Windows (assembly/file version 0.36.2.0, application version 0.36.2-dev). EightMaxCapture.exe is recompiled from its unchanged 0.35.0 source by the same build script; the EightMaxWgc.exe helper, the EightMax 5.1 engine (build 7d08acc7eb4577ee) and the Node runtime are carried over byte-for-byte. One Windows startup defect found by the Milestone 1 tests is repaired in DesktopHost.cs: the host's listening socket (and each accepted connection) is now non-inheritable, because the dashboard browser the window host opens inherited it and kept port 48713 bound after the host exited, so the next host start failed with "port already in use". No solver, strategy, simulator or mouse-movement changes. Adds a focused Windows verification script (windows/Test-Milestone1-0362.ps1). See REPORT-0.36.2-Milestone-1.md for the exact results.

# 0.36.1-dev — Integration candidate, acceptance incomplete

Signed and bounded mouse curves, seeded direction and magnitude, input diagnostics and cancellation repairs, strict postflop library routing, persistent tournament stacks, elimination, and a guided dashboard setup flow.

Windows source changes require new binaries. The carried-over binaries are identified separately in COMPONENT-VERSIONS.json; historical Windows results are not validation of this release. See REPORT-0.36.1.md for exact checks and remaining work.

# 0.35.0 — Simulator Controls

Real Windows mouse and keyboard automation for the operator's OWN simulator (or the bundled test table), from Workbench 0.33.0.
EightMax 5.1 unchanged (build 7d08acc7eb4577ee, `native/mwcli.exe` identical). **Not 1.0.** Not related to the 0.34 EightMax 5.4
integration branch. Guide: docs/SIMULATOR-CONTROLS.md. Final report: docs/0.35-validation-report.md.

- **EightMaxInput.exe** (`desktop/input/*.cs`): SendInput mouse and keyboard; minimum-jerk cursor movement at ~60 updates/s bounded by
  speed, acceleration and a minimum time (never sped up for a deadline); window identity (handle, pid, process start time, class),
  client-rectangle guard, hit test before every press, double-click guard; exact wager entry (click field, verify focus, clear,
  type key by key, read back with WM_GETTEXT / UI Automation); cancel, emergency-stop hotkey (RegisterHotKey, default
  Ctrl+Alt+F12), manual override via Raw Input (no hooks), manual mode; executable-hash-bound authorisation (max 8 h); bounded
  queue; parent watchdog; always releases buttons/keys. Self-test: `--selftest`. Virtual desktop backend for automated tests.
- **Desktop host input broker** (`desktop/InputBroker.cs`, `/api/input/*`): the host owns the one driver process (job object),
  forwards whitelisted commands, never restarts a crashed driver silently.
- **Screen-to-action controller** (`src/simulator-controls.js`): capture → recognise → state → decision → executor → scheduler lease →
  in-lease revalidation by fresh capture → input → capture → confirmAction (confirmed / rejected / ambiguous / timed-out / cancelled).
- **Centralised input scheduler** (`src/input-scheduler.js`): one cursor owner, earliest deadline first, refuses rather than rushes.
- **Calibration** (`src/simulator-profiles.js`, dashboard wizard): drag regions on a screenshot or take UI Automation suggestions;
  preview with click points, DPI and confidence; dry run; profiles in the existing checksummed platform-profile format, bound to the
  simulator's executable; raise-to / raise-by conventions, chip unit, optional All-in.
- **Controlled Windows test table** (`desktop/testtable`, `src/fixture-dealer.js`, `tools/test-table-035.cjs`): real buttons and wager
  field, resizable, status strip, independent oracle used only for grading.
- **Dashboard**: "Simulator controls" panel (connect, calibrate, preview, test click, test bet entry, start/pause/stop, emergency stop,
  manual mode, settings, diagnostics export).
- **Tools/launchers**: RUN-INPUT-SELFTEST, RUN-INPUT-ACCEPTANCE, RUN-SIMULATOR-BENCHMARK, START-TEST-TABLES, RUN-035-ACCEPTANCE;
  COLLECT-TEST-RESULTS also collects Acceptance-0.35.
- **Fixed** (found while building/testing 0.35): UI adapter could send a slow click twice on an executor retry; visible input is no
  longer retried; scheduler race allowed overlapping input; a clean pre-input refusal consumed the state slot; two single clicks on
  one spot became a Windows double-click (found on Windows); state reconstruction rejected every frame in which another player is to
  act with the controls off (normal client behaviour), delaying confirmation and making hand-ending actions ambiguous.
- Version 0.35.0 in launchers, scripts and C# sources; every executable rebuilt on Windows.

# 0.33.0

Compact preflop research, exact restricted flop solving, independent multiway evaluation, Windows-built executables. **Not 1.0.**
EightMax 5.1 engine unchanged (build 7d08acc7eb4577ee; the compact modes are game definitions). Final report:
docs/0.33-validation-report.md. Design: docs/PREFLOP-MODES.md, docs/FLOP-SOLVER.md, docs/MULTIWAY-VALIDATION.md.

- **Preflop solver modes** (`src/preflop-compact.js`, `tools/preflop-modes-033.cjs`, RUN-PREFLOP-MODES.cmd): A full linked (0.32,
  unchanged identity), B check-down continuation, B169 check-down with 169 hand-class keys (lossless for that game), C one flop betting
  round; Mode D comparison (memory, speed, checkpoints, rows per street, coverage per position, first-in deviation gains, seed noise vs
  model difference). All approximate modes are labelled approximate. B169: 904 MiB at 2M updates (A: 2,864 MiB) and 8M updates in
  1,415 MiB.
- **State anatomy** (`tools/state-anatomy-033.cjs`): rows, bytes and contexts per street; found 99.98 % of postflop rows alone in their
  (state, board) context.
- **Reach-weighted preflop coverage for both layouts** (`tools/preflop-reach-coverage-033.cjs`).
- **Class-keyed shared preflop snapshot** (format version 2, `buildClassSnapshot`): compact studies drive simulations through the same
  shared-memory path, labelled approximate (`tools/solver-factory.cjs`, `--preflopSnapshotFile` in tools/benchmark-032.cjs).
- **Check-down calibration** (`tools/checkdown-calibration-033.cjs`): exact flop equilibria vs check-down values (mean error 12.3 % of
  the pot; out-of-position realisation 68 %, in-position 120 %).
- **Restricted heads-up flop CFR+** (`src/flop-solver.js`, worker `src/flop-solver-worker.js`, `tools/flop-solver-benchmark-033.cjs`,
  RUN-FLOP-SOLVER-CHECK.cmd): flat per-street tables, exact chance enumeration and card removal, all-in runout equity, deterministic
  turn-card partitioning over worker threads, checksummed checkpoints (bit-identical resume), cancellation, memory limits; complete
  linked continuations (0 unvisited rows); evaluated by the independent `src/fast-multistreet.js` and cross-checked by
  `src/independent-eval.js` (agreement 1e-15).
- **Independent N-player evaluator** (`src/independent-eval.js`, `tools/multiway-validation-033.cjs`, RUN-MULTIWAY-VALIDATION.cmd): own
  rules, side pots, evaluator, state reader and best response; analytic references (Kuhn 2/3-player, passive hold'em), equals the
  engine's exact best response at every training length (60.75 / 27.66 / 13.73 / 7.52 % NashConv). Multiway linked records now get an
  exact independent NashConv when they carry their rules (0.33 exports store them).
- **Windows**: executables built and smoke-tested on a GitHub-hosted Windows runner (`windows/Build-Executables.ps1`, workbench-ci/);
  evidence-generated component statuses; the validation stage runs the release ZIP on Windows (see windows-ci/README.md).
- **Dashboard**: "Solver research 0.33" panel (preflop modes, positions, gains, distances, calibration, flop solver, multiway, coverage,
  performance) with launch buttons; host allow-list extended; RUN-033-ACCEPTANCE.cmd for the target PC.
- **Fixes**: native state verification accepted only the exact-row layout (class-keyed states are now CRC-verified); PowerShell
  argument construction in the Windows build script.
- **Tests**: tests/preflop-033, flop-033, multiway-033, release-033 (new); 0.31/0.32 tests changed only where they assert the current
  version or the Windows-execution status (now evidence-based).

# 0.32.0

Preflop research, linked flop-to-river studies, exact turn solving, shared preflop memory. **Not 1.0.** EightMax 5.1 engine
unchanged (build 7d08acc7eb4577ee). Final report: docs/0.32-validation-report.md. Design: docs/PREFLOP-RESEARCH.md,
docs/LINKED-STUDIES.md, docs/TURN-SOLVER.md, docs/SHARED-PREFLOP-MEMORY.md, docs/ABSTRACTION.md (0.32 section).

- **Preflop research** (`src/preflop-research.js`, `tools/preflop-research-032.cjs`, RUN-PREFLOP-RESEARCH.cmd): exact information-set
  counts per preflop state, sampled reach and reach-weighted coverage per position, missing branches, the 0.31 range-support
  measurement (reproduced: 5.03 % / 53.66 %), per-position first-in deviation gains with 95 % intervals (lower-bound estimates via the
  native engine), seed stability, training modes Fast / Standard / High-Accuracy (targets met only by measurement), continuation from a
  shorter study (bit-identical to an uninterrupted run), research sampler variants. Full eight-handed exploitability is reported as
  unavailable, never as zero.
- **Linked multi-street records** (`src/linked-study.js`, `.emlk`): every later-street strategy of a trained study, lossless, lazily
  inflated per board, checksummed, bound to its street record by a bit-for-bit continuity check. `StrategyLibrary.putLinked/getLinked`.
  0.31 records keep working (unverified without a linked record).
- **Exact multi-street evaluation and CFR+** (`src/fast-multistreet.js`): heads-up flop/turn/river games with every card enumerated,
  equal to an independent brute-force enumeration to 1e-9. Flop/turn records with a linked record are evaluated exactly; incomplete
  continuations are never validated.
- **On-demand heads-up turn solver** (opt-in, bounded, labelled `solved-on-demand`); quality-targeted turn training stores validated
  turn records with complete river continuations.
- **Shared preflop memory** (`src/preflop-snapshot.js`): one SharedArrayBuffer snapshot read by every worker. Ten tables, identical
  workload: peak RSS 4,463 MB -> 938 MB with identical decisions.
- **Validated approximations at run time** (`src/approximate-lookup.js`): chip-scale and pot-bucket-10pct, off by default, labelled,
  legality re-checked, re-validated on independent examples (p95 0.052 % / 0.73 % of the pot).
- **Benchmarks:** `tools/benchmark-032.cjs` (shared preflop, deep stacks 15-100 bb, per-street accounting, workloads F/G),
  `tools/coverage-032.cjs`, `tools/turn-solver-benchmark-032.cjs`, `tools/abstraction-validation-032.cjs`, `tools/memory-check-032.cjs`.
- **Dashboard:** Research panel (preflop analysis, multi-street studies, coverage, turn solver, memory) with host route
  `/api/research/summary` and four new launchers; RUN-032-ACCEPTANCE.cmd for the target PC.
- **Defect fixed (present since 0.30):** worker threads opening a NEW strategy library at the same time could fail with ENOENT
  (`LIBRARY.json` was written outside the write lock while another thread's recovery removed temp files): 28 of 240 concurrent opens
  failed with 0.31 code, 0 with 0.32 (regression test in tests/release-032).
- **Windows:** host, capture tool and WGC helper rebuilt as 0.32.0 (cross-compiled; NOT run on Windows). Windows CI prepared for 0.32 but
  not run: this session could not push to the repository.

# 0.31.0

Strategy-quality, opponent-range and retrieval release. **Not 1.0.** EightMax 5.1 engine unchanged (build 7d08acc7eb4577ee).
Final report: docs/0.31-validation-report.md. Design: docs/STRATEGY-QUALITY.md, docs/OPPONENT-RANGES.md, docs/ABSTRACTION.md.

- **Quality gates** (`src/strategy-quality.js`): five classifications (validated / estimated / restricted-evaluation / unverified /
  failed-quality-check), policies `strict` / `research` (default) / `exploratory` / `off`, heads-up exploitability and multiway
  NashConv thresholds kept separate, quality ledger bound to each record's exact bytes, decision-time gate (`code: 'quality-gate'`),
  every decision reports its quality status. Nothing is promoted automatically.
- **Exact evaluation, 100x faster** (`src/fast-river.js`): vectorised heads-up river best response and full-width CFR+, equal to the
  independent 0.30 evaluator to 4e-11 bb.
- **Quality-targeted training** (`src/adaptive-training.js`): train, measure the stored bytes, continue in checkpointed doubling blocks
  until the target, a limit or a stall. Heads-up rivers use the exact full-width CFR+. Measured: the 0.30 default (20,000 updates)
  failed the research target on every tested river (any-two-cards 1.72 bb = 28.7 % of the pot); the 0.31 trainers validated them
  (0.48 % of the pot in 0.44 s). Continue Training refines stored studies. Trainer-variant study: the 0.30 MCCFR variant is the best
  of EightMax's four, so it is unchanged.
- **Opponent ranges** (`src/range-engine.js`, `src/range-model.js`): 1,326-combo weighted ranges, exact Bayesian action
  conditioning on the stored preflop strategy, flop -> turn -> river continuity using the stored street strategies, card removal,
  multiway, provenance on every range, unsupported combos reported (never invented), labelled fallback. Default preflop study for
  derived ranges: 2,000,000 updates (range support 5.0 % -> 53.7 % of flops vs 500,000).
- **Abstraction validation** (`src/strategy-abstraction.js`): seven mappings defined and measured by exact EV loss; chip scale and
  10 % pot bucketing accepted, stack/SPR bucketing and river-blank substitution rejected. None enabled for decisions.
- **Coverage**: in-sample vs out-of-sample report (`tools/coverage-031.cjs`), exact / abstracted / solved-on-demand / unavailable
  kept apart; optional exact on-demand solving of heads-up rivers in the decision path.
- **Shared strategy service v2**: dedicated thread, synchronous replies (Atomics.wait + receiveMessageOnPort), lock-free shared
  directory for misses; 0.30 host kept for comparison.
- **Precompute**: quality-targeted jobs, refinement jobs, quality stored per job.
- **Fixed**: study adapter refused per-combination postflop ranges longer than 2,000 characters (found by the 0.31 benchmark);
  adaptive resume did not load a checkpoint that already covered the first block (found by a test);
  `PrecomputeQueue.drain()` never resolved when the queue was paused with jobs left (0.30 defect: `--minutes=N` budgets and
  Ctrl+C could end the process silently without the final status) - found by the 0.31 coverage run.
- **Windows**: host 0.31.0 with `GET /api/library/quality`, `GET /api/ranges/latest` and six new launch tools; capture tool and WGC
  helper rebuilt as 0.31.0 (no Windows execution yet: see COMPONENT-VERSIONS.json); new launchers VALIDATE-STRATEGIES,
  CONTINUE-TRAINING, PRECOMPUTE-COMMON-HANDS, VIEW-OPPONENT-RANGES, RUN-SELF-TEST, RUN-LONG-ACCEPTANCE; long-duration acceptance
  script `windows/Test-LongDuration.ps1`; collector includes it.
- **Dashboard**: Strategy quality and Opponent ranges panels (with an offline range calculator), Strategy research buttons,
  library panel shows quality and range-model counts.

# 0.30.0

Precomputed strategy library and measurement release. **Not 1.0.** EightMax 5.1 engine unchanged (build 7d08acc7eb4577ee).
Final report: docs/0.30-validation-report.md. Design: docs/STRATEGY-LIBRARY.md.

- **Strategy library**: exact-identity (SHA-256) persistent store of trained postflop street studies, compact bit-exact snapshots,
  checksums, transactional writes, crash recovery, quarantine, LRU cache with byte budget, import/export bundles, shared-memory
  cache across table threads, suit isomorphism (exact) as the only transformation.
- **Decision path**: lookup first. Decision Mode never trains; a miss is `unavailable`/`library-miss` with the missing configuration,
  logged for training. Deadline and Study modes are explicit options. 10-table worst-table P95 on the 0.29 workload: 1,557 ms (0.29,
  re-run) → 221 ms (library on disk) / 244 ms (pre-loaded).
- **Precomputation**: persistent priority queue from simulation miss frequencies or a full flop catalogue, checkpointed resumable
  native training, cancellation, memory and workload throttling, worker threads.
- **Mathematical validation**: independent evaluator, exact best response / exploitability / NashConv, independent CFR+ reference,
  convergence curves over 5 seeds, sampled-CI coverage check, exact evaluation of stored library records (heads-up rivers: up to
  20 % of the pot exploitable with the default settings).
- **Fixed**: native training result lost under concurrency (`exit` vs `close`); multi-MB queue rewrites per job.
- **Changed model**: library range model any-two-cards (0.29 added the hero's hand, making studies unusable twice); compact action
  trees for 4–6 player pots; 20,000 updates per postflop study.
- **Windows**: host gains `GET /api/library/status` and six library launch tools; all three C#/.NET executables rebuilt (0.30.0);
  `desktop/COMPONENT-VERSIONS.json` generated from build and CI evidence (0.29's "never executed on Windows" flags were out of date).
- **Dashboard**: Strategy library panel; decision lines show strategy source, cache hit/miss, lookup latency and accuracy status.

# 0.29.0

Consolidated release: a deliberate three-way merge of 0.27.0 and 0.28.0 (common ancestor 0.26.0; docs/CONSOLIDATION-0.29.md),
plus fixes found by running the release on **real Windows** (GitHub-hosted Windows Server 2025 runners; docs/WINDOWS-CI.md).
**Not 1.0.** It has still not run on the target PC (Windows 11 Home, 3840×2160 @ 150 %, RTX 4060 Ti).
EightMax 5.1 engine unchanged (build 7d08acc7eb4577ee); 5.3 still evaluated, not adopted (docs/ENGINE-5.3-EVALUATION.md).

- **Consolidation**: 0.27's 2–8 seat image reading, layouts, multi-seat tests, solver-in-the-loop benchmark D, multi-seed 240-hand
  reports, PNG writer and runtime docs restored on top of 0.28's Windows repairs. 33 conflicts resolved and logged; every file either
  side added is kept or listed as replaced (`docs/CONSOLIDATION-INVENTORY-0.29.json`, `tests/consolidation-029.test.cjs`).
- **HTTP 400 root cause (target PC, 0.26)**: the host was compiled with Mono against Mono's class library; `text.Split(' ')` bound to
  `String.Split(char, StringSplitOptions)`, which .NET Framework lacks, so every request threw `MissingMethodException` → HTTP 400
  (health and shutdown alike). Seen on a Windows runner; 0.26, 0.27 and 0.28 binaries all contain it. All executables are now compiled
  against the .NET Framework 4.8 reference assemblies; IL guard `tests/netfx-029.test.cjs`.
- **Windows Server 2025 runner, candidate ci9: RUN-RELEASE-ACCEPTANCE passed, 81/81 checks** (see docs/0.29-validation-report.md for the exact
  checks): capture self-test 8/8, WGC self-test 13/13, desktop API, native solver jobs / cancel / resume / history / batches,
  graceful shutdown, no orphans, install / uninstall (rollback only as its single-release refusal), Node suite on Windows.
- **Further Windows-only defects found and fixed**: hidden test window (first ShowWindow), installer `$uninstall`/`[switch]$Uninstall`
  clash, `-isnot [pscustomobject]` in the native runner, `[IO.File]::Replace(...,$null)`, `@(List)` "Argument types do not match",
  timeout killing only the top process, Python line endings in `build.py` (docs/WINDOWS-CI.md; lint tests `tests/powershell-029.test.cjs`).
- **Desktop protocol**: RFC 7230 absolute-form targets accepted for the host's own loopback authority only (local proxies); request
  corpus of Windows PowerShell / proxy / security-product formats replayed against the 0.26 and 0.29 hosts; first-request diagnosis in
  `Test-Desktop.ps1` (raw socket vs system proxy vs no proxy).
- **Continuous capture**: the host keeps ONE persistent Windows Graphics Capture session per window (helper `--session --emit-png`)
  instead of a new session per frame; newest frame, duplicate marking, close / target-loss / shutdown clean-up; window-move and
  DPI-change handling in the capture session. 0.27's manual-only rule for WGC kept.
- **Seat states**: vacant / sitting-out / in-hand per position, departed via `SeatTracker`, inconsistent pictures rejected; the
  8-handed strategy restriction kept (docs/SEAT-COUNTS.md).
- **Solver in the loop**: 0.27's ten-table P95 (~1.6 s) investigated: it is the cost of training fresh postflop studies in the decision
  path, not contention (a cross-worker solve cap did not lower it) and not duplication across workers; concurrent requests for a study
  that is still training now share it. Decisions also carry actor and legal actions.
- **Fixed 0.27 regression**: `variableStacks(rng, seats)` was called with the hand number as seat count (variable-stack runs stopped).
- **Node.js v22.23.5** (from 0.27, re-verified) chosen over 0.28's v22.23.4; `RUN-TOOL.cmd` + `RUN-NODE-TOOL.cmd`.
- **Collector**: skips files shipped with the release; CI-verified.

# 0.28.0

Windows repair release driven by real results from the target PC (EightMax-Windows-Test-Results-20261118-084905.zip, produced with
0.26.0). **Not 1.0. Nothing in 0.28.0 has been executed on Windows** — every Windows component was built on Linux and every repair is
confirmed only by Linux evidence (Mono runtime, PowerShell 7, .NET 8 cross-compilation) until RUN-RELEASE-ACCEPTANCE.cmd passes on
the target PC. **Baseline note:** the archive supplied as the starting point was 0.26.0, not 0.27.0 (see docs/0.28-baseline-verification.md).
The bundled EightMax 5.1 engine files and `native/mwcli.exe` are unchanged (build 7d08acc7eb4577ee).

- **Capture self-test crash fixed** (`desktop/capture/EightMaxCapture.cs`): after closing its test form the 0.26 tool read
  `Form.Handle` of the disposed form → `ObjectDisposedException`; the run died right after "minimised window correctly reported".
  The handle is now captured once while the window is alive; every stage (create, capture, verify, resize, capture, verify,
  minimise, restore, close → target-lost) is recorded with its name in `selftest-result.json`; exit codes 0/1/4, never a crash.
- **Capture harness fixed** (`windows/Test-Capture.ps1`): native stderr was piped through PowerShell with `ErrorActionPreference=Stop`,
  so the first stderr line aborted the script and the report said `acceptance-run` with an **empty** detail. Tools now run with output
  redirected to files and a timeout; each stage is its own check; no failure has an empty message.
- **Desktop HTTP 400 fixed at a confirmed cause** (`desktop/DesktopHost.cs`): Windows PowerShell 5.1 POSTs carry
  `Expect: 100-continue`, which 0.26 refused as "Invalid local request framing/host" — no job could be submitted from PowerShell.
  The host now answers `100 Continue`. The first GET also failed with 400 on the target PC; that part could NOT be reproduced, so every
  refusal now returns a structured code, method, route, step and request id, framing refusals list header names, a host-side
  request log is kept (`Logs\desktop-requests.log`, no tokens), and the acceptance test records each request and runs raw-socket probes.
- **Graceful shutdown repaired**: shutdown refuses new work, stops native job objects, closes the listener, flushes logs and ends the
  message loop through an invoker control (WM_QUIT kept as fallback), with a logged 10 s watchdog. Connections are served concurrently
  (an idle connection no longer stalls shutdown). The test harness always attempts an authenticated shutdown, waits 20 s, and records
  forced termination only as a last resort; owned `mwcli.exe` processes are checked.
- **Windows Graphics Capture helper compiled for the first time** (`desktop/bin/EightMaxWgc.exe`, .NET 8 self-contained): 0.26 source had
  two compile errors (fixed). New persistent session mode with frame sequence numbers, timestamps, configurable frequency, bounded
  queue, resize detection (frame-pool recreate), stall/timeout detection, clean stop; own-window self-test with 13 stages. The host
  advertises and runs it only when selected and never substitutes another backend. **Not run on Windows.**
- **Diagnostics**: shared structured reporting (`windows/Common.ps1`): name, stage, start/end time, pass/fail/skip, error class
  (application, harness, missing dependency/executable, timeout, unsupported environment, configuration), error code, message, files,
  executable and app versions; every run in its own folder.
- **One-click results collection**: `COLLECT-TEST-RESULTS.cmd` (`windows/Collect-TestResults.ps1`) — finds EightMax reports, redacts
  tokens/secrets/user and computer names, never modifies originals, writes `collect-summary.json` + `README-RESULTS.txt`, saves one
  ZIP (portable forward-slash paths) on the Desktop. `RUN-RELEASE-ACCEPTANCE.cmd` now ends by creating it, and maps results onto the
  12 critical acceptance criteria (`critical-acceptance.json`).
- **Dashboard**: *Test results & checks* panel — last test date/status, passed/failed/skipped, plain-language failure explanations with
  technical detail, report location, and buttons for simulation/study control, capture/WGC/Windows/hardware checks, results collection,
  results folder and diagnostics export. Desktop client errors keep the host's error code.
- **Ten-table scheduling**: memory pressure now includes system free memory (other programs), not only this process; new
  `nativeConcurrency()` planner (on the target PC's 5.17 GiB free: two 1 GiB native jobs, a 4 GiB job refused as insufficient memory).
  Fixed a race (also in 0.26): a table paused for memory while waiting for the solver ran its scripted fallback on the paused table
  and the error was counted as a worker crash; it now defers.
- **Bundled Node.js** v22.23.4 win-x64 (`runtime/node/node.exe`, checksum-verified official binary) + `RUN-NODE-TOOL.cmd`. FFmpeg is still
  not bundled (size/licence; user-supplied path unchanged).
- **Versions**: every Windows executable carries a 0.28.0 version resource; `desktop/COMPONENT-VERSIONS.json` lists hashes, compilers
  and `executedOnWindows:false`.
- Tests: see docs/0.28-test-results.txt and docs/0.28-validation-report.md. Updated pre-existing assertions are listed there.
# 0.27.0

Windows-capture, seat-count and runtime release. **Not 1.0. Still nothing has run on Windows.** Built on the attached 0.26.0 (see docs/0.27-baseline-verification.md: the upload was already 0.26.0).
The bundled EightMax 5.1 engine files are unchanged (build 7d08acc7eb4577ee); the supplied 5.3 engine was evaluated, not adopted (docs/ENGINE-5.3-EVALUATION.md).

- **Windows Graphics Capture compiled and shipped** (`desktop/wgc`, `desktop/bin/EightMaxWgc.exe`, docs/WINDOWS-GRAPHICS-CAPTURE.md): first compile with the .NET 8 SDK (cross-targeting) found and fixed real errors in the 0.26 source; `System.Drawing` replaced by an own PNG writer whose output is verified bit-exact. The host has a WGC route (identity checks first, 8-second limit, no silent fallback) and the dashboard a *Capture method* selector. Manual-only; **never run on Windows**.
- **Host and capture tool rebuilt from source** with Mono mcs (they were the stale 0.25.0 binaries); component versions all 0.27.0 (`desktop/COMPONENT-VERSIONS.json`).
- **2–8 seats in the image reader, hand-state engine and pipeline** (docs/SEAT-COUNTS.md): conflict-free generated layouts (8-seat geometry byte-identical to 0.26.0), seat-count-aware profile selection with an explicit `ambiguous-layout`, `HandStateEngine({seats})`, complete hands from pixels at every seat count. Other seat counts get `player-count-unsupported` instead of an 8-handed strategy.
- **Node.js v22.23.5 bundled** (`runtime/node`, `RUN-TOOL.cmd`, docs/RUNTIME-AND-TOOLS.md) so the QA tools need no installation. Not run on Windows.
- **Benchmark D: complete simulation with the real solver in the loop** (`tools/multitable-benchmark-027.cjs`, `reports/0.27-benchmark-D-solver-in-loop-linux-simulated.json`), kept apart from lookup, pipeline-only and isolated-solving numbers; the 0.26 log line that printed `undefined` fixed.
- **Multi-seed 240-hand solver coverage** (`reports/0.27-scenario240-seed*.json`, docs/0.27-validation-report.md).
- Tests: 621 → see docs/0.27-test-results.txt (new: wgc-027 replacing wgc-026, seats-027; several 0.25/0.26 assertions updated on purpose: WGC catalogue status and host/executable versions).

# 0.26.0

Strategy-memory, coverage and replay release. **Not 1.0. Nothing was run on Windows.** The build environment had no C# compiler, no .NET SDK, no PowerShell and no GPU (docs/RELEASE-STATUS-0.26.md).
The bundled EightMax 5.1 engine files are unchanged (build 7d08acc7eb4577ee).

- **Strategy-memory bottleneck fixed at its causes** (docs/STRATEGY-MEMORY.md): a native run that filled its budget stopped early with exit status 0 and was accepted as complete; the budget was a hard-coded 256; a native state was copied whole into the Node heap (1.1 GB for 183 MiB). New `src/strategy-budget.js` (planner + honest run classification), `src/strategy-store.js` (streaming, CRC-checked, bounded lazy reader, identical to a full import on 9,600 lookups), `tools/native-training.cjs` (budgeted, resumable, atomic, cancellable), `trainStudyLazy`. Resume across a memory-limited stop is byte-identical to an uninterrupted run.
- **Solver coverage** (same 240-hand reference path and 30-hand seeds 2024/7/99): 0.25 baseline 90.1 % → **92.1 %** at 250,000 preflop updates → **99.0 %** at 1,000,000 updates (see docs/0.26-validation-report.md). Missing strategy rows are still reported as unavailable and still fall back only in labelled Simulation mode.
- **Video replay** (`src/video-replay.js`, docs/VIDEO-REPLAY.md): FFmpeg-backed probe, interval sampling, pause/resume, seek, truncation errors, scoring in a new `video-replay` metrics domain. FFmpeg is not bundled.
- **Windows Graphics Capture: source only** (`desktop/wgc`, `windows/Build-WgcCapture.ps1`, `windows/Test-Wgc.ps1`, `BUILD-WGC.cmd`, `RUN-WGC-CHECK.cmd`). Never compiled, never run; unselectable; catalogue status `source-only-unbuilt`. See docs/WINDOWS-GRAPHICS-CAPTURE.md.
- **Adapter**: JavaScript strategy budget limited to the engine's real 8–256 MiB; new `nativeMemoryMiB` (64–16384, default 256 = 0.25 behaviour) in native jobs.
- **Dashboard**: Platform workspace → Performance → *Strategy memory* panel (budget planner).
- **GPU finding** (docs/RELEASE-STATUS-0.26.md): the native CUDA path scores showdown tables / equity only; training traversal is CPU. Scoring is <0.5 % of training time here, so GPU offload could save at most that. Unverified on a GPU.
- **Versions**: application, scripts, dashboard 0.26.0. `desktop/DesktopHost.cs`, `CaptureService.cs`, `EightMaxCapture.cs` and the two executables are the **unchanged 0.25.0 components** (declared in `desktop/COMPONENT-VERSIONS.json`).
- Tests: 594 → see docs/0.26-test-results.txt (new: strategy-memory-026, video-replay-026, wgc-026). Two existing assertions were updated on purpose (catalogue status of WGC; script/host version rule).

# 0.25.0

Platform-independent testing foundation. **Not 1.0.** Built and tested on Linux only; **nothing was run on Windows** (see docs/RELEASE-STATUS-0.25.md).
No external poker site was chosen, inspected or integrated. The bundled EightMax 5.1 engine files are unchanged.

- **Resource accounting repaired** (`src/resource-monitor.js`, `tools/pipeline-worker.cjs`, `tools/multitable-benchmark-024.cjs`, `src/multitable.js`): 0.24 summed process-wide CPU and RSS over worker threads
  (2 workers reported "4.0 cores busy"). Process CPU/RSS are now measured once by the owning thread; workers report only their own heap and an event-loop busy-time estimate; every figure has units and a
  source; a validator rejects impossible / double-counted / stale / negative / incomplete samples. GPU stays `supported:false, measured:false`. See docs/RESOURCE-ACCOUNTING.md.
- **Platform profiles** (`src/platform-profile.js`, `examples/profiles/`): data-only description of layout, capture methods, scaling, OCR settings, structure (players, blinds, antes, stacks, betting) and the
  authorised execution interface; validation, SHA-256 integrity on save/load, region editing, template for a new platform. Shipped profiles cover **only the application's own controlled renderer**.
- **Capture manager** (`src/capture-manager.js`): honest backend catalogue (Windows Graphics Capture listed as *not implemented*), profile-driven backend selection with fallback, run-time switching, bounded
  frame queue, capture-health roll-up, window-identity validation, `ObservationGate` (last check before an observation may be used), labelled non-optical structured feed.
- **Calibration** (`src/calibration.js`, dashboard *Platform workspace*): advisory table-boundary / card-rectangle detection, region editor, labelled-sample learning, held-out evaluation, template export/import,
  `variantLayout` for unseen-layout tests. `sim-display.renderTable` accepts a layout so unseen layouts can be tested.
- **Solver coverage** (`src/solver-tree.js`, `src/full-hand.js`): structured *unavailable* results (`code`, `missingCapability`, `executable:false`), every decision stamped with `decidedAt`, `inputFingerprint`,
  `solverVersion`, `coverage`; optional off-tree wager **translation** (nearest tree size, bounded, always reported as an approximate state); scripted fallbacks stay on the tree menu so later decisions remain
  answerable (fixes the cascade of off-tree "bet-facing-a-wager" failures).
- **Execution/acknowledgment/diagnostics adapters** (`src/execution-adapters.js`): adapter contract, profile-selected adapter, generic UI-automation adapter (profile regions only; mock-driver tested), pure
  `confirmAction` (confirmed / rejected / ambiguous), bounded `DiagnosticsRecorder`.
- **Dashboard**: new *Platform workspace* (Capture, Calibration, Solver, Execution, Performance). External QA mode stays disabled.
- **Defect fixed**: `tests/multitable.test.cjs` "memory budget" was flaky in 0.24 (4 of 6 runs failed): the governor first ran on a 20 ms timer that a short run could outlive; it now runs once before the first decision (8/8 stable).
- **Windows**: `windows/Test-Release.ps1` + `RUN-RELEASE-ACCEPTANCE.cmd` (integrity, parse, capture self-test, desktop checks, optional install/rollback/uninstall); host and capture tool rebuilt with Mono (x64) for 0.25.0.
- **Tests**: 589 → see docs/0.25-test-results.txt (new: resource-monitor, platform-profile, capture-manager, calibration, execution-adapters, solver-coverage-025, windows-025, platform-ui in Chromium).

Unchanged and still true: no Windows run, no GPU path, no external client, Windows Graphics Capture not implemented, real-client recognition accuracy not measured, strategies are sampled and "unproven".

# 0.24.0

One controlled table, end to end: **screen capture -> image recognition -> hand-state reconstruction -> EightMax decision -> validated action -> acknowledgement
from the next screen reading**. **It is not 1.0.** Nothing in this release has been run on Windows; see docs/RELEASE-STATUS-0.24.md and docs/0.24-validation-report.md.

- **Screen capture** (`src/screen-capture.js`, `desktop/CaptureService.cs`, `desktop/capture/EightMaxCapture.cs`, `windows/Test-Capture.ps1`, `RUN-CAPTURE-CHECK.cmd`): window / region
  sources, user-controlled start/stop, configurable frequency, frame sequencing and monotonic timestamps, stale / lost / minimised / covered / resized / identity-change detection,
  interruption and recovery, bounded debug recording, multi-monitor and DPI geometry. Windows uses PrintWindow + BitBlt + DWM (documented APIs); Windows Graphics Capture is **not** implemented.
  Host routes `/api/capture/*` need the session token and explicit consent.
- **Vision** (`src/vision-ocr.js`, `src/sim-display.js`, `src/vision-track.js`, `src/vision-metrics.js`, `src/image-codec.js`): layout v2 (hand id, all-in markers, hand-over banner,
  action controls, call amount, minimum raise), eight hero-seat views, alignment tolerance, split rank/suit card reader, operator calibration from labelled screenshots, animation / stability
  gate and reading consensus, PNG/BMP codec, per-category accuracy metrics with separate synthetic / browser-render / real-client domains. Template matching is 5x faster.
- **Hand state** (`src/hand-ledger.js`, `src/hand-state.js`): independent rules ledger (min-raise, reopening, side pots, uncalled refunds, split pots, settlement feasibility) verified against the
  simulator on 4,000+ randomized hands; frame-to-frame tracking derives history/contributions/legal actions from screens and rejects ambiguity; configurable stakes; checkpoint/restart.
- **Solver mapping** (`src/solver-tree.js`, `src/solver-service.js`): linked preflop tree and on-demand flop/turn/river studies built from the reconstructed state; strict node validation
  (history walk, pot, chips, live flags, legality); per-action EV when exposed; pooled suit-equivalent preflop hands; explicit `unavailable` reasons; no fabricated strategies.
- **Executor** (`src/test-executor.js`): bet vs raise, labelled scripted path (Simulation only), acknowledgement hook, latency statistics. `src/qa-client.js` + `tools/qa-test-server.cjs`:
  authorized QA protocol over HTTP (token, idempotency, revision binding).
- **Pipeline** (`src/full-hand.js`): `SingleTablePipeline`, `OfflineClient`; strict vs labelled-fallback modes; exact solver/scripted attribution; stale, timeout, stop, restart handling.
- **Multi-table** (`src/solver-pool.js`, `src/solver-worker.js`, `tools/*-024.cjs`): worker-thread solver pool (parallel decisions; runaway/crashed/stale jobs terminated and replaced);
  benchmarks keep lookup, pipeline and solving separate.
- **Dashboard**: *Capture & one-table run* panel (source selector, capture start/stop, live preview with calibration overlay, confidence, reconstructed hand, decision, execution, emergency stop,
  hand history/replay, diagnostics export).
- **Engine/adapter**: `Table.setNextStacks`, optional strategy-budget parameter in the study adapter; EightMax 5.1 files are unchanged.
- Tests: 440 baseline tests preserved (one assertion kept byte-identical behaviour); see docs/0.24-test-results.txt for the new total.

# 0.23.0

Integration release covering the planned 0.19 to 0.23 work. **It is not 1.0**: nothing in
this release has been run on Windows, and the installer, prebuilt host and PowerShell
scripts are unexecuted. See docs/RELEASE-STATUS-0.23.md for what is and is not verified.

- 0.19 Windows reliability: host reports a port conflict in plain words, writes a bounded
  `Logs\desktop-host.log` on startup failure, ships a prebuilt x64 host (`desktop/bin`,
  built with Mono `mcs`, unverified on Windows) that START-DESKTOP prefers, with automatic
  fallback to compiling the shipped source; new `ROLLBACK-WINDOWS.cmd` re-verifies and
  re-activates the previous installed release; every .ps1 parse-checked with PowerShell 7.4.
- 0.20 Observation and hand state: `src/hand-state.js` reconstructs the eight-seat table
  from observations or a structured feed with confidence gates and explicit rejection
  (layout, cards, pot/stack accounting, continuity, history); never invents data and pauses
  the table. `src/vision-ocr.js` adds glyph OCR, layout profiles, marker reading, an image
  observer, precision/recall reporting and recorded-observation replay (synthetic simulator
  renderings only; no real client screenshots were available).
- 0.21 Solver integration: `src/solver-service.js` engine identification, capability
  negotiation, request validation, a decision source mapping the eight-seat 25 BB preflop
  push/fold study (the only verified mapping), bounded priority queue, exact-input cache with
  byte budget, timeouts, cancellation and stale-decision discard. Results carry updates,
  convergence verdict (default "unproven"), warnings and `certification: none`.
- 0.22 Test executor: `src/test-executor.js` with Study (default), Simulation and
  Authorized QA modes, QA authorization record, stale/duplicate/age/legal checks, retries
  with idempotency keys, per-table pause, global emergency stop, replayable log.
- 0.23 Multi-table: `src/multitable.js` ten isolated cooperative workers sharing one
  solver service, resource budgets, fault isolation and recovery, checkpoint/restore,
  latency/deadline/CPU/memory metrics. Benchmarks and an acceptance run are in docs/.
- Dashboard: new "Ten-table solver run" panel (ten table cards, global controls, monitor,
  diagnostics export, self-test, hardware view) and a standalone hardware validation utility
  (`RUN-HARDWARE-CHECK.cmd`, `windows/Test-Hardware.ps1`, `src/hardware-report.js`).
- Tests: 438 Node cases (was 367) run against a Linux build of the supplied engine source.
  Engine files and the Windows mwcli.exe are unchanged. Older workspaces/checkpoints open
  unchanged; no stored format was altered.

# 0.18.0

- Added convergence checks for native studies using the unmodified engine's own
  response-gain query (`mwcli --gain`): exact best response, with automatic fallback
  to restricted and sampled lower bounds when a tree is too large or slow.
- New native controls: method, check every N checkpoints (curve), per-check time
  limit and a target in % of the starting pot. Checks pause the training clock and
  never fail a study.
- Results show a verdict (within target / keep training / not proven / unavailable),
  per-seat gains in BB and % of pot, heads-up exploitability, a trend line and a
  curve. Summaries are validated against the job, checkpoint counters and seat count,
  and kept in workspace backups.
- Raised limits: native updates to 10,000,000 (engine maximum), strategy memory to
  16,384 MiB with a RAM check, total training time to 7 days, checkpoint interval
  to 1,000,000 updates. Restore/query budgets scale with memory. Browser time
  budget raised to 10 minutes.
- Earlier jobs, results and workspaces remain readable. Missing settings use defaults.
- Added 11 tests (8 using the Linux native engine) and updated 2 bound tests. Total:
  364 Node cases plus 20 core simulation cases (384), and the original UI handler check.
- PowerShell runner and C# host changes are not executed here. Engine files unchanged.

# 0.17.0

- Added persistent native job records/summaries with atomic record replacement,
  bounded history browsing, explicit prior-folder import and version-checked opening.
- Reopen completed results or interrupted checkpoint references after host restart
  without training. Restore the original slot/proof through existing result checks;
  compatibility remains checked by the original engine on explicit Resume.
- Added 1–10-slot native draft batches with zero-training preparation, separate JSON
  Save/Open, fresh bindings and a 1-MB combined request bound.
- Added a host-owned sequential batch pump, per-study result archives, duplicate-
  delivery refusal/reuse, cancellation-before-delivery fencing and fail-fast partial/
  failure handling. Closing the dashboard does not stop an accepted host batch.
- Keep batch metadata across restart with queued work stopped. Unfinished snapshots
  can be copied into a fresh draft; existing checkpoints continue individually.
- Add host history/queue controls, background progress reads, stale reply protection,
  resource exclusion and runtime/credential-free workspace separation.
- Extended the actual Windows acceptance script with host restart, archive open/
  resume/stale-record and sequential batch/delivery checks; these remain unexecuted.
- Added 28 tests, including two Linux native-engine integrations. Total: 353 Node
  cases plus 20 core simulation cases (373), and the original UI handler check.
- No C#/PowerShell/Windows/installer/browser visual execution or signed installer
  is claimed. The original EightMax 5.1 libraries, C++ and Windows binary are unchanged.

# 0.16.0

- Added shared in-page compute ownership and an activity panel for running/queued
  study slots, native preparation/recovery, capacity tests, diagnostics and images.
- Prevent conflicting workflows before worker allocation, keep the one-worker study
  queue, and protect newer work from a cancelled operation's late cleanup.
- Added read-only desktop-idle preflight for browser CPU studies, checkpoint opening,
  capacity testing, image validation and diagnostics, including after dashboard reload.
  Unreachable/active hosts block startup; stopped preflights cannot start late work.
- Preserve explicit preemption of ordinary studies for capacity/image checks and of
  study/capacity/image workflows for browser diagnostics. Native work stays explicit.
- Native Stop also cancels browser job preparation. Ownership remains transient and
  absent from workspace backups; no cross-window scheduler or RAM/VRAM meter is claimed.
- Fixed Windows runner restore status to keep the original cumulative update target
  and validate counters before promoting a restored checkpoint. Extended the supplied
  Windows acceptance polling checks; those Windows paths remain unexecuted here.
- Added 22 ownership/protocol/in-memory UI cases. Total: 325 Node cases plus 20 core
  simulation regressions (345), with the original UI handler check separately.
- Engine libraries, C++ source and the supplied EightMax 5.1 Windows binary unchanged.

# 0.15.0

- Added read-only Find and explicit Recover controls for the live host's current
  native job after reload, including original slot/config/proof restoration, result
  collection and interrupted checkpoint adoption without starting training.
- Added canonical bound-job submission deduplication, changed/older-binding refusal
  and a bounded per-session submission/cancellation ledger with no silent eviction.
- Added attempt revisions, conditional Cancel/Resume and idempotent duplicate resume.
  Pre-acknowledgment cancellation fences both initial jobs and intended resumes.
- Keep unconfirmed native submissions busy, exclude new runs/capacity tests and
  confirm cancellation before resolving uncertainty through recovery. Stale recovery
  previews and late replies cannot overwrite changed drafts. Blocked session storage
  no longer prevents a valid private launch fragment from opening the session.
- Expanded the provided Windows acceptance script for actual host recovery,
  deduplication, stale cancellation and cancellation-before-delivery/resume checks.
- Added 29 protocol-model/in-memory UI cases. Total: 303 Node cases plus 20 core
  simulation regressions (323), and the original UI handler check separately.
- C# compilation, Windows/Win32/PowerShell execution, install/update/uninstall and
  browser visuals remain unexecuted here. The original EightMax 5.1 engine is unchanged.

# 0.14.0

- Added Windows C# desktop-host source and a first-launch x64 build through built-in
  Windows PowerShell/.NET components; no additional runtime download is used.
- Added per-user versioned install/update/uninstall scripts and Start menu/registry
  registration, with release verification, manager locks and user-data preservation.
- Added direct dashboard Run/Stop/Resume controls over a session-bound loopback API,
  retaining exact prepared job bindings and existing native result validation.
- Added suspended native-manager creation in a kill-on-close Windows Job Object,
  headless runner mode, completed-checkpoint resume and owned process cancellation.
- Added stale/in-flight submission cancellation, global emergency hooks and refusal
  of capacity testing while a managed native request remains active/unconfirmed.
- Added RUN-DESKTOP-CHECKS.cmd for actual Windows compilation/protocol/native/cancel/
  resume acceptance and an importable diagnostic report without session credentials.
- Added 20 protocol/UI/package tests using mock transport/in-memory DOM/source checks.
  Total: 274 Node cases plus 20 core simulation regressions (294).
- C# compilation, Windows/Win32/PowerShell execution, installer behavior and visual
  browser checks remain UNEXECUTED here. No prebuilt/signed installer was produced.
  Engine libraries, C++ and supplied native Windows executable remain unchanged.

# 0.13.0

- Added separate binary CPU checkpoints with Save/Open/Continue controls for
  portable root and captured reviewed studies; no training starts on opening.
- Continue toward a cumulative target with exact normalized settings/proof and
  preserve the prior retained state on cancellation, failures and stale responses.
- Bound retained state bytes across slots, validate container/native checksums,
  identity/counters/parser allocations/path depth, and report eviction/failure.
- Preserve typed bytes through the queue without JSON expansion or ownership loss.
- Keep training bytes out of result files, caches and workspace recovery; workspace
  v3 remains compatible, and reports record added-versus-prior update counts.
- Added 22 checkpoint/UI/native cases, 2 queue cases and 4 generated-worker cases.
  Total: 254 Node cases plus 20 core simulation regressions (274).
- Resumed final states matched uninterrupted examples byte-for-byte; the independent
  Linux CLI also resumed exported state to matching policies. Engine files unchanged.
- Actual Windows, visual browser/file-dialog behavior, target-PC memory/speed,
  installer, GPU scheduling and live-client integration remain unverified/pending.

# 0.12.0

- Added native CPU export for exact matched reviewed positions without browser
  training, reusing the unchanged EightMax 5.1 CLI and existing resource controls.
- Added version-2 native jobs/results with captured path/card queries and separate
  root/target queries from one completed checkpoint in the Windows manager.
- Validate latest slot/token/job, full histories, public ledgers/menus, ordered
  ranges, blocker flags, probabilities and consistent completed counters on import.
- Keep unavailable/zero-average native rows unavailable, preserve original input
  weights and discard native reach/aggregate estimates from displayed policies.
- Added workspace version 3 for bound reviewed native exports/results, with v1/v2
  migration, target/draft consistency checks and paused restoration.
- Preserve version-1 root exchange; reject non-root queries disguised as v1 roots.
- Added 21 native exchange/UI/continuation cases and 2 generated-worker cases.
  Total: 226 Node cases plus 20 core simulation regressions (246).
- Linux CLI and in-memory UI validation passed. Windows PowerShell/PE execution,
  visual browser testing, target-PC speed and live integration remain unverified.

# 0.11.0

- Added captured reviewed-position drafts and exact menu/path matching before
  portable training, including preflop-to-postflop and combined action/card steps.
- Query the actual acting seat's stored hand policies at the matched node; preserve
  missing rows and distinguish root input weights from posterior probabilities.
- Added explicit original/current-street anchor selection and selected-step study
  preparation from completed-hand inspection without importing future evidence.
- Added slot-bound links, reviewed draft/report exchange, hero labeling, native-root
  restrictions and exclusion of mapped results from the root-only cache.
- Added workspace version 2 with reviewed links/reports and version-1 migration.
- Added 21 mapping/UI/native-comparison tests and 2 generated-worker cases.
  Total: 203 Node cases plus 20 core simulation regressions (223).
- EightMax 5.1 libraries/C++/Windows binary remain unchanged. Windows/browser visual
  execution, real recognition and live client integration remain unverified/pending.

# 0.10.0

- Added whole-workspace backups with optional embedded source screenshots, pending
  form edits, results, calibration, labels, review progress and diagnostics.
- Added separate automatic metadata recovery, validated/paused restore, rollback,
  stale-import suppression and image reattachment reporting.
- Added Windows launch/check scripts and browser diagnostics with report exchange.
- Added bounded native CPU controls, per-slot export bindings and status imports.
- Replaced the Windows runner with a progress/cancel manager using alternating
  checkpoints and compatible resume toward a total target, including query-only
  recovery when a checkpoint is already complete.
- Added 26 tests: 18 workspace/diagnostic cases and 8 native-management cases.
  Total: 180 Node cases plus 20 core simulation regressions (200).
- Native continuation/refusal checks ran on Linux; Windows PowerShell/Forms/launcher
  execution remains unverified. EightMax 5.1 source/executable are unchanged.

# 0.9.0

- Added labeled recorded-image evaluation, guided expected-field creation/editing,
  local image preview and manifest/report export without editing JSON.
- Added per-table/field outcomes, confusion counts, wrong labels, false accepts,
  known-field coverage, explicit missing-evidence accounting and null denominators.
- Flag exact normalized reference-crop overlap and report a separate scored subset;
  no holdout independence or real-client accuracy claim is made.
- Added bounded sequential image decoding, cancellation/stale-result suppression,
  calibration-change invalidation and browser CPU-work exclusion/emergency stopping.
- Added six synthetic PNG examples, manifest and calibration with deliberate errors.
- Added 28 tests. Total: 154 Node cases plus 20 core simulation regressions (174).
- Preserved EightMax 5.1 solver/native files and 0.8 review-format compatibility.

# 0.8.0

- Added resumable observation-review files containing original frames, cursor,
  supported settings and an ordered frame/reset journal.
- Rebuild reviews by re-auditing the processed prefix; preserve candidates, pauses,
  reset boundaries, refunds and completed records without advancing remaining frames.
- Added separate automatic review recovery, manual reopening, clear controls and
  storage-failure feedback. Startup never processes an earlier review automatically.
- Added a completed-hand selector and accepted-snapshot inspector with original
  frame indices, bounded history, partial-anchor labels and report export.
- Added bounded UTF-8 file validation, journal/rules checks, atomic imports and
  cancellation of stale asynchronous imports; render batches once per click.
- Added a saved-progress synthetic example and 23 continuation/recovery tests.
  Total: 127 Node cases plus 20 core simulation regressions (147).

# 0.7.0

- Added explicit refund, showdown and settled accounting phases.
- Added uncalled current-street bet refunds, main/side pots and exposed-card ranking.
- Added split-pot integer rounding, merged eligible layers and a fixed odd-chip policy.
- Added exact award/refund/stack checks, with missing/contradictory evidence pauses.
- Added bounded completed-hand records with initial snapshots, retained transitions,
  gross awards, cumulative refunds, final balances and partial-anchor/truncation labels.
- Added guarded automatic next-hand admission after verified payouts only.
- Added summary rendering to avoid cloning full archives on every frame.
- Added synthetic accounting demos and completed-hand export.
- Added 20 tests, including 100 seeded comparisons against EightMax pot layers/ranking
  and a 105-hand retention scenario. Total: 104 Node cases plus 20 core regressions.

# 0.6.0

- Added explicit full-post preflop anchors with verified dealer/SB/BB positions,
  dealt-seat count and 0.1 BB individual antes; heads-up order handled separately.
- Connected preflop round completion to correctly ordered flop reconstruction.
- Added initial-preflop study handoff with restored pre-post stacks and canonical
  action-order mapping, preventing doubled blinds/antes.
- Added 2/6/8-seat synthetic sequences, import inventory and readable action timeline.
- Added ten tests including 100 seeded preflop simulator comparisons and actual
  EightMax spec pot checks; 104 total test cases including simulator regressions.

# 0.5.0

- Added an explicitly anchored postflop betting-round reconstruction model.
- Added checks, action order, minimum raises, short all-in reopening and round closure.
- Added transactionally checked combined final-action / next-street transitions.
- Retained conservative legacy auditing when position/history evidence is absent.
- Added manual reviewed street-start study preparation with explicit ranges,
  chip/BB conversion, prior/folded contribution preservation and original seat mapping.
- Added a new synthetic walkthrough and ten tests, including 100 seeded comparisons
  against the independent scripted simulator's betting rules.
- Expanded validation to 74 Node cases plus 20 simulator regressions (94 total).

# 0.4.0

- Added a ten-table read-only temporal observation audit and review workspace.
- Requires distinct stable frames and thresholds before accepting snapshot evidence.
- Added visible-card, pot/contribution, per-seat conservation and continuity checks.
- Added conservative call/fold movement audit; ambiguous bets/raises and turn changes pause.
- Added per-table fault isolation, explicit review resets and bounded audit export.
- Connected raw template results to review without inventing missing game-state fields.
- Added a synthetic walkthrough, sequence schema and 11 new regression cases.
- All audit output retains decisionReady=false; no client action path was added.

# 0.3.0

- Added guided study settings with validation and preservation of advanced inputs.
- Added deterministic controlled study play using real EightMax policy rows,
  source-engine betting paths, replay frames and pot settlement; missing rows stop play.
- Added exact-settings LRU caching for completed portable studies, with labeled hits.
- Added a bounded two-worker pool, end-to-end deadlines and queue timing.
- Added fresh-study burst benchmarks for 1/2/5/10 slots and separate cache probes.
- Added exportable reports without a live-capacity certification or GPU claim.
- Added import checks for contradictory strategy rows and invalid study metadata.
- Preserved completed benchmark reports when no active test is being stopped.
- Expanded validation to 53 Node test cases plus 20 simulator regressions.

# 0.2.0

- Integrated the unmodified EightMax 5.1 reference engine into disposable workers.
- Added configurable root studies, explicit missing strategies, paginated hand
  frequencies, source identity, CPU resource limits and result export/import.
- Added a serialized ten-slot study queue with cancellation and stale-UI protection.
- Included the user's unmodified native mwcli.exe and a bounded Windows job runner.
- Added validated simulation checkpoints and paused automatic/local recovery.
- Added experimental recorded-image ROI calibration and labeled-template matching,
  with rejection of ambiguous, low-similarity, blank, mismatched-layout and duplicate-card fields.
- Preserved the independent scripted simulator and its original 20 regression cases.
- Added 29 tests and actual native/reference comparisons from supplied source.

# 0.1.0

Initial offline ten-table simulation dashboard, independent table state, betting,
showdown evaluation, side pots, stop/pause controls and read-only replay.
