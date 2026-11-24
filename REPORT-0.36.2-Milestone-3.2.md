# EightMax Test Workbench 0.36.2 — Milestone 3.2 development report

**Input confirmation reliability, paused-window monitoring, target-loss recovery, multi-table isolation and Windows validation** · 2026-11-24 · release `EightMax-Test-Workbench-0.36.2-Milestone-3.2.zip` (SHA-256 `740e9c1fe853d8db0a57722cabbba78a66ad20525b63a7569fe51658cabeb54d`)

## 1. Summary

Milestone 3.2 repairs the one failure of your Milestone 3.1 run (T5, 2026-11-24): a table whose **gameplay was paused** — after one of its clicks was not applied by the test table — **never checked its window again**, so when the window was closed the table stayed `ACTIVE` and the input scheduler was never told. The root cause is established in the code, confirmed by the host request log from your PC, and reproduced deterministically on the Milestone 3.1 tree with the identical failure message. Every registered window is now verified by an independent window-health monitor in every state (playing, paused, safety-paused, stopped, recovering); a lost window takes the same terminal path from any state, and the scheduler now tracks registrations explicitly.

| Question | Answer |
|---|---|
| Root cause of T5 | **Established and reproduced** (section 2): gameplay pause → every later step returned before the identity check → no host request while paused → close never detected → `invalidateTable()` never called. |
| Repaired? | **Yes, on Windows CI** (your PC: pending, next row) — the paused-then-closed case (T5P, the situation on your PC made to happen on purpose) passed on every machine: **10/10 on the release ZIP itself** (final run, 10 separate machines; plus 1/1 in its full acceptance); all Milestone 3.2 CI runs: 32/32 standalone + 3/3 in full acceptances; T5 10/10 on the release ZIP (plus 1/1 in its full acceptance); all runs 32/32 + 3/3; half of the machines at a measured 125 % display scaling. |
| Why the Call was not applied | **Not established** — the oracle and diagnostic files of your run were not among the uploaded files; the available evidence rules several causes out and none in (section 6). Not marked as fixed. Every recurrence now leaves a complete evidence record. |
| Your hardware | **Pending** — run `RUN-M3.2-T5-TEST.cmd` (section 17). Windows CI is not your PC. |
| Native solver | **Unchanged**: `native/mwcli.exe` `b3e675bf…2f72`, EightMax 5.1 build `7d08acc7eb4577ee`; no executable rebuilt (every executable byte-identical to Milestone 3.1). |

Validation kinds are kept apart throughout: **development environment** (Linux, Node 22.23.5, no PowerShell), **simulated** (production code against the in-process fake desktop host — logic evidence only), **real Windows CI** (GitHub-hosted Windows Server 2025, real windows, real capture, real mouse input), **your Windows hardware** (pending).

## 2. The reproduced root cause of T5

The chain (Milestone 3.1 code):

1. Table 2's Call click was delivered (driver: success), but the test table showed no change for the whole 4 000 ms confirmation window; a fresh reading still showed the same player to act → `rejected` (clean). The executor paused the table's **gameplay**; because the result was neither "unconfirmed" nor "may have happened", no safety pause followed: **the window lifecycle stayed `ACTIVE`**.
2. `SimulatorTable._step()` returns `paused` **before** the periodic identity check, which also ran only in `ACTIVE`.
3. `run()` (the harness and the dashboard both use `stopOnPause:false`) sleeps on `paused` and makes **no host request**.
4. The window was closed → nothing probed it → no `TARGET_LOST` → `InputScheduler.invalidateTable()` never called → `unavailableTables` `[]`.

Evidence (details in `T5-ROOT-CAUSE-ANALYSIS-3.2.md`):

- **Your PC's host request log** (in the uploaded collector ZIP): T5 ran 00:04:16–00:05:07 UTC; table 2's click returned at 00:04:45.838 (r851, 1 372 ms, ok), its confirmation polled every ~100 ms until 00:04:50.04 without a change; after that no request can be attributed to table 2; **no `/api/capture/close` was issued at all** (`targetLost()` always issues one); the 15 s wait for `TARGET_LOST` expired at 00:05:07.5.
- **Deterministic reproduction** (`tools/repro-paused-target-lost-0362m32.cjs`, production code, fake host, the harness's options): on the Milestone 3.1 tree `table 2 TARGET_LOST after its window closed – "ACTIVE"` and `the scheduler blocks only table 2 – []` — your message — with **0 identity probes and 0 captures in the 15 s after the close**; on Milestone 3.2: `TARGET_LOST` after ~1.0 s (health monitor), scheduler `[2]`, no input to the closed window.
- The dashboard runs tables the same way, so the defect was not test-only.

## 3. Source files modified

| File | Change |
|---|---|
| `src/window-lifecycle.js` | **New `WindowHealthMonitor`**; plain-language message for an action that was not applied |
| `src/simulator-controls.js` | monitor in every non-terminal state; terminal path from any state records the interrupted state; registration-scoped scheduler pause; `input-rejected` safety pause; one input status per attempt; evidence record per unconfirmed input; capture failures judged only by a probe started after the failure was known; confirmation trace |
| `src/input-scheduler.js` | `registerTable()`, revoked registrations, idempotent invalidation, `unavailableTables` = tables whose *current* registration is lost, an old registration's pause never blocks its replacement, per-table metrics |
| `src/test-executor.js`, `src/execution-adapters.js`, `src/windows-input-driver.js` | additive: the driver result, the hit window and the scheduler lease travel to the evidence record; "input was sent" is explicit |
| `src/fixture-dealer.js`, `tools/test-table-035.cjs` | test fixture only: the oracle records frames the window reports as shown and the window's own clock; test control `drop-next-action` |
| `tools/gameplay-acceptance-0362m3.cjs` | T5 strengthened (numbered event-based assertions, event timeline), **T5P** added, suite `t5 --repeat N`, warning-level checks, multi-table measurements |
| `tools/lifecycle-acceptance-0362m2.cjs` | scheduler events, oracle location, `dropNextAction` for both environments |
| `windows/Test-Milestone31.ps1`, `windows/M31-Lib.ps1`, **new** `windows/M32-T5.ps1` | runner mode **T5** (same reporting system), per-check reporting, WARNING scenarios, Milestone3.2-T5 result folders found by option D, newest release record, no MSBuild node reuse during the regression phase |
| **new** `RUN-M3.2-T5-TEST.cmd`, `READ-ME-MILESTONE3.2-TESTS.txt`, `release-0362-m32.json` | the standalone T5 test, its instructions, the release record |
| **new** `tests/paused-window-0362m32.test.cjs`, `tests/release-0362m32.test.cjs`; modified `tests/runner-0362m31.test.cjs` | regression tests (section 8); one pinned Milestone 3.1 folder-name assertion now checks the same property through the new prefix variable |
| **new** `tools/repro-paused-target-lost-0362m32.cjs`, `tools/make-release-0362m32.py`, `tests/windows/M32-Display.ps1`, `.github/workflows/windows-0362-m32.yml` | reproduction, packaging, CI display helper (resolution and per-monitor scaling, measured), CI workflow |
| `START.html` (rebuilt by `tools/build.py`), `READ-ME-FIRST.txt`, `docs/CHANGELOG.md`, `SHA256SUMS.txt`, `evidence/0.36.2-m32/` | |

## 4. Window-health checks during gameplay pauses

`WindowHealthMonitor` is one object per registration, independent of gameplay and strategy:

- It probes the **original registered identity** (`window-info` through the input driver: handle, process id, process start time, window class, executable). `window-info` is not an input operation, so the driver answers it during an emergency stop too.
- **Intervals:** about **1 s** while gameplay is paused, safety-paused or the table is recovering; **5 s** once a table is stopped or its tournament finished (nothing can resume those without you); while a table plays it already probes every 5 s itself, so the monitor only acts as a backstop after 7.5 s without any probe. A timer tick only reads local state; a probe happens only when due, one at a time, and every probe of the table counts as evidence (no duplicates).
- **Outcomes:** window gone → loss (`window-closed`); handle now belonging to another window or process instance → loss (`identity-changed`); healthy → only "last seen" is recorded; unknown (driver busy, timeout) → nothing is concluded, the next probe backs off. A late answer for a registration that is already lost is discarded; at `TARGET_LOST` the monitor stops for good.
- **It never resumes anything:** it never moves a lifecycle towards `ACTIVE` or `RECOVERY_PENDING` and never authorises input. A paused table that stays open stays paused (test K; T5P assertion P3). An emergency stop or operator stop stays effective (test J).

## 5. How scheduler invalidation is now triggered

A confirmed loss from **any** source — the health monitor, a capture failure, the confirmation loop, a driver refusal, the evidence probe — calls `targetLost()` once (idempotent). It records the state it interrupted, stops the monitor, revokes capture and the driver authorisation, discards pending decisions and calls `invalidateTable(table, reason, registrationId)`:

- the registration is **revoked for good** (`registerTable` refuses it; later jobs of it are refused with `target-lost`);
- only that registration's **queued jobs are rejected** and its **running job is cancelled** (driver cancel only when the running job is that table's — test G: another table holding the lease is untouched; test H: a queued job is dropped; test I: a running job is cancelled before the press);
- `status().unavailableTables` lists exactly the tables whose current registration is lost; a table re-registered under a new registration (fresh authorisation, new identity) is available again while the old registration stays refused (tests M, Q, R);
- a repeated loss signal changes nothing (counted as a repeat).

Found while testing: a pause set by an older registration used to block its replacement forever (the scheduler's pause was per table, not per registration) — fixed.

## 6. Findings on the unconfirmed Call

| Event | Your Call |
|---|---|
| the driver reported the click | yes (r851 ok) |
| Windows delivered press and release to the test-table window | unknown |
| the table applied the action | no visible effect for 4 s; refused / never received / applied without repainting: unknown |
| the confirmation observed it | no (no new revision; fresh reading: same player to act) |

Assessment of the causes in the brief: **confirmation timeout** — not supported (on Windows CI a confirmation takes 149 ms on average, at most 197 ms — 352 confirmed actions in the final run's full acceptance (gameplay T1–T6/T5P and the 1/2/5/8-table runs); 4 000 ms is a large margin; nothing was changed); **coordinates / small target / 125 % scaling** — unlikely (deterministic centre of the control, hit-tested right before the press; every other click of the run worked; T5/T5P now pass at a measured 125 %); **window movement** — ruled out (the driver would have refused); **scheduler timing / cancellation race** — ruled out by code and log; **dealer-wide delay** — ruled out (it served table 1 normally meanwhile); **a stall of table 2's own window, a missed press/release, focus change to table 1 before the release was processed** — not determinable without the oracle. On Windows CI, **8 141 button presses** of earlier runs (2–8 tables) all produced an action the table accepted, except one the test closed 16 ms later; in all Milestone 3.2 CI runs no unconfirmed input occurred that was not caused on purpose or by the test's own close/cleanup (every one attributed: the standalone runs recorded 50 unconfirmed inputs in 64 scenario runs, each one the T5P click made to fail on purpose (32 × T5P table 2 rejected-no-change) or table 2's action in flight when the test closed its window (18 × T5 table 2 uncertain); 20 of them from the first two development runs, which predate the recorded cause, attributed from scenario, table and status; the full acceptances' gameplay phases recorded 6 (T5/T5P, the same two causes) and none in T1–T4/T6 (0); the multi-table runs recorded 16 uncertain actions — actions in flight when the test injected an emergency stop or closed a window (any other unconfirmed action safety-pauses its table, which those runs count as a violation: none occurred)).

## 7. Changes to action confirmation

- **Classification** (one per attempt): confirmed · rejected-before-input (nothing sent; a new decision from a fresh reading may follow, at most 4 in a row) · **rejected-no-change** (delivered, no visible change: now a **safety pause** `input-rejected`, "Action not applied", never repeated) · uncertain · timed-out · ambiguous · cancelled. Only "rejected before input" is ever followed by another attempt, and only from a fresh, verified reading.
- **Evidence per unconfirmed input** (`unconfirmedInputs` in the table report; T5 saves `work-t5\unconfirmed-*.json` and the window's frames before/after): table, registration, handle and identity fingerprint, action, control region, selected point, display scaling, client rectangle (at reading and after), foreground / minimised / visible / cloaked, driver result, scheduler lease, confirmation trace (polls, failed captures, status-strip revisions, new/unreadable frames, final fresh reading), frame revisions before/after, timeline. No session token; no desktop content outside the window.
- The test table's oracle records shown frames and the window clock, so the four events of section 6 can be separated next time. On Windows CI the induced case shows exactly that chain (final run, `45311974352-t5-2`, display 125 %): mouse-down and mouse-up on the enabled call at revision 3, the table's action result `dropped-by-test`; the confirmation then made 36 polls over 4089 ms and saw only revision 3 ("no change within 4000 ms; same actor still to act"); afterwards the window was not in the foreground, visible, not minimised; recorded display scaling 1.25.
- No timeout, motion speed or retry rule was relaxed.

## 8. Deterministic regression results (simulated: fake host)

`tests/paused-window-0362m32.test.cjs` — every scenario checks the state transitions **and** the input that reached each window:

| | Scenario | Linux (release ZIP) | Windows CI (final run) |
|---|---|---|---|
| A | an ACTIVE window closes -> TARGET_LOST, scheduler registration revoked, no input afterwards, the other table plays on | pass | pass |
| B | a GAMEPLAY-PAUSED window closes -> the health monitor detects it (the operator T5 failure), registration revoked, nothing resumes | pass | pass |
| C | an action the table did not apply (rejected, no change) -> SAFETY_PAUSED input-rejected; then the window closes -> TARGET_LOST | pass | pass |
| D | an UNCONFIRMED (timed-out) input, then the window closes -> the uncertain input stays recorded for review and TARGET_LOST is reached | pass | pass |
| E | the window closes DURING an identity probe -> the stale "healthy" answer authorises nothing; a late answer after the loss is discarded | pass | pass |
| F | the handle is reused by ANOTHER process while paused -> identity-changed TARGET_LOST; the old registration can never be used again | pass | pass |
| G | table 2 is lost while TABLE 1 holds the cursor lease -> table 1 is not cancelled and completes its action | pass | pass |
| H | table 2 is lost while ITS OWN input is queued -> the queued action is rejected (target-lost), table 1 continues | pass | pass |
| I | table 2 is lost while IT holds the cursor lease -> its input is cancelled before the press; table 1 is isolated | pass | pass |
| J | emergency stop and target loss together -> TARGET_LOST wins for the closed table; nothing restarts automatically after the reset | pass | pass |
| K | a paused window that stays open is monitored, its lifecycle stays accurate, and nothing resumes gameplay | pass | pass |
| L | a completed tournament stays stopped: monitoring continues but never restarts it; a later close is still recognised | pass | pass |
| M | re-registration needs a fresh authorisation and identity; the lost registration stays refused | pass | pass |
| N | a confirmation that arrives late, after the attempt was cancelled, causes no retry and no second action | pass | pass |
| O | a valid fresh action is confirmed: input status confirmed, timings recorded, no evidence record | pass | pass |
| P | a real "simulator rejected the action" outcome -> input-rejected safety pause, complete evidence, no retry, operator resume recovers | pass | pass |
| Q | two tables under repeated faults (unapplied actions, pauses, closes and replacements) -> never any cross-table input | pass | pass |
| R | several table windows close and are re-registered one after another -> each loss isolated, each replacement plays | pass | pass |

Plus 5 unit tests of the monitor and the scheduler (never towards `ACTIVE`; unknown answers back off; single-flight; one loss report; evidence sharing; intervals; registrations, repeats, pauses, isolation of queued/running jobs). Linux: 23/23 passed (18 scenarios + 5 unit tests), development environment, complete suite run from the extracted release ZIP; the same file on Windows (full acceptance, regression phase): 23/23 passed (18 scenarios + 5 unit tests; real Windows CI, final run).

## 9. Repeated Windows T5 results (real Windows CI)

The standalone `RUN-M3.2-T5-TEST.cmd`, exactly as on your PC, on **separate fresh Windows machines**, one T5 + one T5P per machine, every second machine at 125 % display scaling (applied at run time and **measured**: monitor DPI 120):

| Machine | Display (measured) | Release ZIP | Launcher | T5: table 2 lost after | T5P: table 2 lost after | Input to the closed window | Unit set | Duration |
|---|---|---|---|---|---|---|---|---|
| 1 | 1920×1080 at 100 % (monitor DPI 96) | exact ✓ | PASS (exit 0) | PASS — 49 ms (driver; was ACTIVE) | PASS — 513 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 156 s |
| 2 | 1920×1080 at 125 % (monitor DPI 120) | exact ✓ | PASS (exit 0) | PASS — 89 ms (driver; was ACTIVE) | PASS — 540 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 159 s |
| 3 | 1920×1080 at 100 % (monitor DPI 96) | exact ✓ | PASS (exit 0) | PASS — 82 ms (driver; was ACTIVE) | PASS — 725 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 202 s |
| 4 | 1920×1080 at 125 % (monitor DPI 120) | exact ✓ | PASS (exit 0) | PASS — 69 ms (driver; was ACTIVE) | PASS — 525 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 157 s |
| 5 | 1920×1080 at 100 % (monitor DPI 96) | exact ✓ | PASS (exit 0) | PASS — 2089 ms (confirmation; was ACTIVE) | PASS — 196 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 177 s |
| 6 | 1920×1080 at 125 % (monitor DPI 120) | exact ✓ | PASS (exit 0) | PASS — 2084 ms (confirmation; was ACTIVE) | PASS — 853 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 195 s |
| 7 | 1920×1080 at 100 % (monitor DPI 96) | exact ✓ | PASS (exit 0) | PASS — 84 ms (driver; was ACTIVE) | PASS — 190 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 177 s |
| 8 | 1920×1080 at 125 % (monitor DPI 120) | exact ✓ | PASS (exit 0) | PASS — 2115 ms (confirmation; was ACTIVE) | PASS — 639 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 176 s |
| 9 | 1920×1080 at 100 % (monitor DPI 96) | exact ✓ | PASS (exit 0) | PASS — 2105 ms (confirmation; was ACTIVE) | PASS — 217 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 161 s |
| 10 | 1920×1080 at 125 % (monitor DPI 120) | exact ✓ | PASS (exit 0) | PASS — 2103 ms (confirmation; was ACTIVE) | PASS — 244 ms (health-monitor; was SAFETY_PAUSED) | 0 / 0 | 82 passed, 0 failed, 0 skipped | 161 s |

All Milestone 3.2 Windows CI runs (each machine: one T5 and one T5P):

| Run | Release tested | Machines (125 %) | Launcher PASS | T5 | T5P | T5 loss found after (min / median / max; by) | T5P loss found after (min / median / max; by) |
|---|---|---|---|---|---|---|---|
| dev 1 [45306938867](https://github.com/derekwtgm/PTO/actions/runs/45306938867) | development build `f4e44faf…` | 2 (1) | 2/2 | 2/2 | 2/2 | 98 ms / 1084 ms / 2069 ms; confirmation 1, driver 1 | 343 ms / 618 ms / 894 ms; health-monitor 2 |
| dev 2 [45307833843](https://github.com/derekwtgm/PTO/actions/runs/45307833843) | development build `7b566629…` | 10 (5) | 0/10 (launcher exit 2: see section 13) | 10/10 | 10/10 | 48 ms / 2082 ms / 2123 ms; confirmation 7, driver 3 | 139 ms / 382 ms / 909 ms; health-monitor 10 |
| dev 3 [45308811354](https://github.com/derekwtgm/PTO/actions/runs/45308811354) | development build `4cacd3f5…` | 10 (5) | 10/10 | 10/10 | 10/10 | 28 ms / 1078 ms / 2114 ms; confirmation 5, driver 5 | 129 ms / 325 ms / 905 ms; health-monitor 10 |
| final [45311974352](https://github.com/derekwtgm/PTO/actions/runs/45311974352) | release ZIP `740e9c1f…` | 10 (5) | 10/10 | 10/10 | 10/10 | 49 ms / 1086 ms / 2115 ms; confirmation 5, driver 5 | 190 ms / 519 ms / 853 ms; health-monitor 10 |
| **all** | | **32 (16)** | 22/32 | **32/32** | **32/32** | 28 ms / 2074 ms / 2123 ms; confirmation 18, driver 14 | 129 ms / 448 ms / 909 ms; health-monitor 32 |

State of table 2 when the loss was recognised: T5 ACTIVE 32; T5P SAFETY_PAUSED 32. Scheduler blocked only table 2 in 64/64 scenario runs; table 1 kept playing in 64/64; input to a closed window after its loss: 0. In the full acceptances T5/T5P ran again on 3 further machines (T5 3/3, T5P 3/3).

## 10. Multi-table isolation and performance

Isolation: tests G, H, I, Q, R (section 8); T5/T5P assertion 8 (table 1 not invalidated, every action matches its own table) on every machine; the stability runs close and reopen windows under load.

Short stability runs on Windows CI (60 s configured per table count — the measured length is in the table; motion speed unchanged at 1 200 px/s, nothing sped up), compared with your Milestone 3.1 run:

| Tables | Result | Confirmed actions: final / dev 1 / dev 3 / your PC (M3.1) | Hands completed | Deadline misses (tables / scheduler) | Refused before input | Uncertain (injected faults) | Incorrect | Scheduling delay mean / p95 | Action latency mean / p95 | Confirmation mean | Window-loss response | Faults injected |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | PASS (60 s) | **45** / 46 / 47 / 47 | 4 | 0 / 0 | 1 | 2 | 0 | 63 ms / 75 ms | 972 ms / 2072 ms | 145 ms | — | closes 0, emergency stops 3 |
| 2 | PASS (61 s) | **31** / 30 / 29 / 30 | 1 | 0 / 0 | 4 | 0 | 0 | 813 ms / 2773 ms | 2757 ms / 4482 ms | 154 ms | 38 ms (n=2) | closes 2, emergency stops 1 |
| 5 | PASS (63 s) | **62** / 64 / 67 / 66 | 2 | 0 / 0 | 9 | 2 | 0 | 2810 ms / 5092 ms | 3808 ms / 5988 ms | 154 ms | 1389 ms (n=2) | closes 2, emergency stops 1 |
| 8 | PASS (74 s) | **76** / 74 / 72 / 77 | 0 | 2 / 2 | 15 | 1 | 0 | 4515 ms / 6896 ms | 5625 ms / 7992 ms | 153 ms | 1722 ms (n=2) | closes 2, emergency stops 1 |

The confirmed-action counts match your PC closely; they are the single-cursor limit (each action needs 0.3–2.4 s of cursor time, shared by all tables), not a regression. Eight tables completed no hand in 60 s (as on your PC): a short run cannot show sustained eight-table play; ten-table optimisation stays a later milestone.

## 11. Lifecycle A–K regression (real Windows CI)

| | Scenario | Group | Final run | Dev 1 | Dev 3 | Checks | Duration (final) |
|---|---|---|---|---|---|---|---|
| A | Window closes during capture | capture lifecycle | pass | pass | pass | 8 | 7.7 s |
| B | Window closes during mouse movement | input cancellation | pass | pass | pass | 7 | 12.6 s |
| C | Simulator restarts with a different handle | capture lifecycle | pass | pass | pass | 10 | 11.6 s |
| D | Temporary capture failures (injected while the window stays open) | capture lifecycle | pass | pass | pass | 6 | 11.5 s |
| E | Minimised window | capture lifecycle | pass | pass | pass | 5 | 10.2 s |
| F | Several tables, one closes | input cancellation | pass | pass | pass | 6 | 16.3 s |
| G | Emergency stop during recovery | safety | pass | pass | pass | 5 | 7.5 s |
| H | Repeated target-loss signals | capture lifecycle | pass | pass | pass | 6 | 3.9 s |
| I | Identity mismatch / handle reuse: no inherited permission | input cancellation | pass | pass | pass | 5 | 3.3 s |
| J | Scripted practice plays hand after hand (no regression) | scripted gameplay | pass | pass | pass | 6 | 31.2 s |
| K | Window resized while playing (geometry / display-scaling re-check) | capture lifecycle | pass | pass | pass | 3 | 7.8 s |

Lifecycle runner cleanup (final run): OK — 12 child processes, all exited: True; unexpected resources: none.

## 12. Unit tests: passed, failed, skipped

| Suite | Environment | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Milestone 3.1 complete Node suite (baseline, before any change) | development environment (Linux) | 1001 | 913 | 0 | 88 |
| Milestone 3.2 complete Node suite, run from the extracted release ZIP (folder with spaces) | development environment (Linux) | 1029 | 941 | 0 | 88 |
| Milestone 3.2 complete Node suite, from the extracted release ZIP | Linux CI (ubuntu-latest, Node v22.23.5, PowerShell 7 present) — final run | 1029 | 950 | 0 | 79 |
| Milestone 3.2 complete Node suite (full acceptance, regression phase) | **real Windows CI** — final run | 1029 | 982 | 0 | 47 |
| Standalone T5 unit set (7 files: Milestone 3.2 tests and the lifecycle / recovery / controller / adapter / executor tests) | **real Windows CI**, each of the 10 machines of the final run | 82 each | 82 each | 0 | 0 |
| Milestone 3.1 runner scenarios S01–S19 (start-up diagnostics, reporting, interruption, packaging) | **real Windows CI** — final run | 26 | 26 | 0 | 0 |
| Host start-up cases (prebuilt, fallback compile, cache reuse, corrupted / foreign cache, Milestone 2 cache key, build-only) | **real Windows CI** — final run, full acceptance | 91 | 86 | 0 | 5 (build-only starts no host, by design) |

Skipped tests are never counted as passed. Linux skips: native engine (Windows program), Mono / .NET SDK, PowerShell 7 not installed on the development machine (the Linux CI runner has it), Chromium / FFmpeg. Windows skips: Linux-only fixtures and tools.

## 13. Windows CI runs

| Run | Commit | Release tested | Jobs (conclusion) | Full acceptance | Result |
|---|---|---|---|---|---|
| dev 1 [45306938867](https://github.com/derekwtgm/PTO/actions/runs/45306938867) | `902839b` | development build (overlay) `f4e44faf…` | package all success, 2 × T5 machines all success, full all success, scenarios all success, linux all success | WARNING — PASS 142, WARNING 1, SKIPPED 5 | success |
| dev 2 [45307833843](https://github.com/derekwtgm/PTO/actions/runs/45307833843) | `f707524` | development build (overlay) `7b566629…` | package all success, linux all success, 10 × T5 machines all failure, scenarios all skipped, full all skipped | — | failure |
| dev 3 [45308811354](https://github.com/derekwtgm/PTO/actions/runs/45308811354) | `cf4bfe7` | development build (overlay) `4cacd3f5…` | package all success, full all success, linux all success, 10 × T5 machines all success, scenarios all skipped | WARNING — PASS 142, WARNING 1, SKIPPED 5 | success |
| **final** [45311974352](https://github.com/derekwtgm/PTO/actions/runs/45311974352) | `1f672a8` | **release ZIP** `740e9c1f…` | package all success, linux all success, full all success, scenarios all success, 10 × T5 machines all success | PASS — PASS 143, SKIPPED 5 | success |

Problems found on Windows and fixed during development: (run 1) the T5 summary printed "n/a" — the large-JSON reader returns dictionaries; (run 2) the summary writer then called `Dictionary.Contains`, which Windows PowerShell 5.1 cannot reach, so every launcher ended "HARNESS ERROR" although every T5/T5P scenario passed — keys are now compared one by one and a summary failure is a WARNING; (runs 1 and 3, full acceptance) an MSBuild worker left by the .NET build test was reported as a leftover process (WARNING) — node reuse is now disabled for the regression phase; the final run reports no leftover process (cleanup phase: PASS); (fake self-check) an action interrupted by the scenario's own cleanup was counted as a confirmation warning — now attributed to the cleanup.

## 14. Acceptance criteria

| # | Criterion | Result | Evidence |
|---|---|---|---|
| 1 | A paused table detects a confirmed window closure. | **Met** | tests B (gameplay-paused), C (safety-paused, action not applied), D, F, K, L; T5P on every machine: 32/32 standalone (final run 10/10), loss found by the health monitor after at most 909 ms (median 448 ms) while table 2 was SAFETY_PAUSED |
| 2 | The lifecycle transitions to `TARGET_LOST`. | **Met** | assertion 5 of T5/T5P on every machine (64/64 scenario runs); tests A–F, J, L, R; lifecycle A, B, C, F, H on Windows |
| 3 | The affected scheduler registration is invalidated. | **Met** | assertion 6/6b: only table 2 blocked and its registration revoked in 64/64 scenario runs, a later job of the lost registration refused; tests A, B, G, H, I, M, Q, R |
| 4 | No new input reaches a lost window. | **Met** | assertion 7: 0 inputs to a closed window after its loss in 64 scenario runs; tests A–I; lifecycle A, B, F; the multi-table runs check every injected close (6 in the final run) |
| 5 | Other tables continue without interruption. | **Met** | assertion 8a–c (table 1 keeps playing, not invalidated, every action matches its own table) in 64/64 scenario runs; tests G, H, I, Q, R; lifecycle F; multi-table runs (no cross-table input, no incorrect action) |
| 6 | Unconfirmed actions are never blindly repeated. | **Met** | tests C, D, N, P (late confirmation causes no second action); T5P assertion P2 (the unapplied click is not repeated) on every machine; "rejected, no change" is now a safety pause, never retried |
| 7 | Window monitoring does not automatically resume gameplay. | **Met** | unit test (never towards `ACTIVE`/`RECOVERY_PENDING`); tests B, K (a paused window that stays open stays paused), L (a finished tournament stays stopped); T5P assertion P3 |
| 8 | Manual override and emergency stop remain authoritative. | **Met** | test J (emergency stop and target loss together: nothing restarts after the reset); lifecycle G; gameplay T6; 6 emergency stops in the final multi-table runs with no input during a stop |
| 9 | Reused window handles do not inherit authorization. | **Met** | test F (handle reused by another process: identity-changed, the old registration refused for good), M (re-registration needs a fresh authorisation and identity); lifecycle C, I on Windows |
| 10 | The original T5 failure is covered by a deterministic regression. | **Met** | test B; `tools/repro-paused-target-lost-0362m32.cjs`: Milestone 3.1 → "DEFECT REPRODUCED: the paused table never noticed its window closed (lifecycle ACTIVE, scheduler unavailable [])", Milestone 3.2 → "REPAIRED: the paused table detected the closed window and its scheduler registration was invalidated" (also a release test); T5P reproduces it on real windows |
| 11 | Standalone T5 testing produces complete reports. | **Met** | 10/10 final-run machines produced `milestone3-results.json/.txt/.zip`, `T5-SUMMARY.txt`, every check, the operation log, phases, the test tables' records and the evidence files; failure path shown in dev run 2: every launcher ended in HARNESS ERROR and still packaged its ZIP (10/10) |
| 12 | T5 passes repeatedly on real Windows CI. | **Met** | final run on the release ZIP: 10/10 machines PASS (T5 10/10, T5P 10/10), 5 of them at 125 %; all runs: T5 32/32, T5P 32/32 standalone, plus T5 3/3, T5P 3/3 in full acceptances. **Windows CI, not your PC.** |
| 13 | Existing lifecycle scenarios A–K continue to pass. | **Met** | final run: 11/11 on real Windows (section 11) |
| 14 | Existing startup and reporting tests continue to pass. | **Met** | final run: runner scenarios S01–S19 26/26; host start-up cases 86 PASS, 0 FAIL (5 SKIPPED by design); the runner and launcher unit tests in the complete suite |
| 15 | Tournament gameplay and hand tracking remain functional. | **Met** | final run: gameplay T1/T2/T3/T4/T5/T5P/T6 7/7 on real Windows (eliminations, tournament end, hand recovery, think-time holds, emergency stop); multi-table 1/2/5/8 PASS; the hand-tracking unit tests in the complete suite |
| 16 | The native solver remains byte-identical. | **Met** | `native/mwcli.exe` `b3e675bf…2f72`, build id `7d08acc7eb4577ee`: checked by the integrity and identity checks of every Windows run, the package verification and `tests/release-0362m32.test.cjs` |
| 17 | The final release ZIP passes checksum verification. | **Met** | `sha256sum -c` OK; the package verification (every entry against `SHA256SUMS.txt`, executables against the release record) OK; every CI job compared the ZIP's SHA-256 before extracting it, and 10/10 final T5 machines report exactly `740e9c1f…` |

Beyond the criteria: the **cause of the unapplied Call is not established** (section 6) and is not marked as fixed; **your PC has not run Milestone 3.2** yet.

## 15. Known limitations and unverified assumptions

- **Your PC has not run Milestone 3.2** — please run `RUN-M3.2-T5-TEST.cmd`.
- **The cause of the unapplied Call is not established** (section 6); if it recurs, the evidence record and the oracle will show which of the four events failed.
- Windows CI: 1920 × 1080 (your desktop is 3840 × 2160); 125 % was applied per monitor at run time — the system DPI that DPI-unaware programs use stays 100 % until sign-in (the host, driver and test tables are DPI aware and ran at 1.25). Defender real-time protection is off on CI; CI machines have 2 cores and no other user software.
- The monitor detects a loss within about 1 s while paused; while a table plays, detection is usually immediate (capture or driver) but can take up to ~2 s when its probe waits in the driver queue behind another table's click (observed in T5).
- Multi-table: 60-s runs only; sustained 8- and 10-table operation is not shown.
- Each Windows CI machine ran **one** repetition (T5 + T5P): ten machines rather than ten repetitions on one machine. The launcher's default of three repetitions per run was exercised only with the fake host (3 and 5 repetitions, all passed).
- The fake-host tests are logic evidence, not Windows evidence.
- Cosmetic: `T5-SUMMARY.txt` shows table 1's continuation as a raw pair (`[5,false]`) and does not name the cause of the two expected unconfirmed inputs (the cause is recorded in `t5-acceptance.json`; step 5 of section 17 explains both). Left unchanged so that the release stays exactly the ZIP validated on Windows CI.

## 16. Native solver

`native/mwcli.exe` SHA-256 `b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72` (EightMax 5.1, build `7d08acc7eb4577ee`): byte-identical, checked by the package verification, the integrity phase of every Windows run and `tests/release-0362m32.test.cjs`; build id read with `mwcli --build-id` on Windows. No strategy interface or algorithm was changed; the scripted practice strategy is still labelled "SCRIPTED FALLBACK — not a solver decision"; automated input stays restricted to the bundled controlled test table.

## 17. Exact steps for local Windows acceptance

1. Download `EightMax-Test-Workbench-0.36.2-Milestone-3.2.zip`; optional check: in a Command Prompt in the download folder run `certutil -hashfile EightMax-Test-Workbench-0.36.2-Milestone-3.2.zip SHA256` — it must print `740e9c1fe853d8db0a57722cabbba78a66ad20525b63a7569fe51658cabeb54d`.
2. Right-click the ZIP > **Extract All…** into a **new, empty** folder (e.g. `C:\EightMax-3.2`).
3. Close the EightMax Workbench, its dashboard and any "EightMax Test Table" window.
4. Double-click **`RUN-M3.2-T5-TEST.cmd`**, press a key when asked. The README allows 8–15 minutes; on Windows CI one repetition took 2.6–3.5 minutes in total, so the default three repetitions should take about 6 minutes (an estimate from the measured phases); the mouse moves by itself inside two small test tables — do not touch mouse or keyboard (Ctrl+Alt+F12 stops all input).
5. At the end File Explorer opens with `milestone3-results.zip` selected (folder `%LOCALAPPDATA%\EightMax-Test-Workbench\TestResults\Milestone3.2-T5-<date>-<time>-t5-test\`; `T5-SUMMARY.txt` explains each repetition). **Upload that ZIP.**
   Reading `T5-SUMMARY.txt`: `table 1 afterwards: kept playing [5,false]` means table 1 made 5 more confirmed actions after table 2's window was closed (`false`: its tournament had not finished). Two "unconfirmed input" lines are expected and are not warnings: in **T5P**, `table 2 call -> rejected-no-change` is the click made to fail on purpose; in **T5**, `table 2 <action> -> uncertain` (on about half of the runs) is the action table 2 had in flight when the test closed its window. Any other unconfirmed input is reported as a **WARNING** with its evidence files.
6. Optional: the full acceptance, `RUN-0362-MILESTONE3.1-TESTS.cmd` → **C** (45–75 min; includes T5P). If a run stops, start that launcher again and press **D** to package it.

## 18. Deliverables

| File | SHA-256 | Content |
|---|---|---|
| `EightMax-Test-Workbench-0.36.2-Milestone-3.2.zip` | `740e9c1fe853d8db0a57722cabbba78a66ad20525b63a7569fe51658cabeb54d` | the release: complete application and source code, launchers, tests, CI workflow, native solver (unchanged), checksum manifest `SHA256SUMS.txt`, documentation |
| `EightMax-Test-Workbench-0.36.2-Milestone-3.2.zip.sha256` | `e7f9639069af4dd76f9401f1510c2a1062b969e1807ca99704c4ed824985c685` | SHA-256 of the ZIP (`sha256sum -c` format) |
| `REPORT-0.36.2-Milestone-3.2.md` | — | this report |
| `T5-ROOT-CAUSE-ANALYSIS-3.2.md` | `4f7a52d9510292f5dcefe8e026d73f87deadd4e6c2680e50133dc26feec61417` | root cause of T5 with the evidence from your run, the Call investigation |
| `T5-WINDOWS-VALIDATION-3.2.json` | `2ac1e73f1c2d4d04da6354cdf5d4ab90a453a1448173aa5117fb24c65269ee58` | every standalone T5 run on Windows CI (per machine and per scenario), the reproduction before/after |
| `INPUT-CONFIRMATION-VALIDATION-3.2.json` | `767583689c477a0129073e03bbe3f9fe40fe63f056c8e7c6a3a6e6735f5e2edb` | input status rules, the Call findings, confirmation latencies, the evidence record with a Windows example |
| `LIFECYCLE-REGRESSION-3.2.json` | `6f9f5280f84fa666f655528384121033a3e5d43c25e77e3da9d5c71d6f4b7f23` | deterministic tests A–R (Linux and Windows), lifecycle A–K, gameplay T1–T6/T5P, suite counts |
| `MULTITABLE-REGRESSION-3.2.json` | `b584b5e166c0adfd29b369664ad21f5708516b3c9c3561637206ca81028c4039` | 1/2/5/8-table measurements of every run, Milestone 3.1 comparison |
| `READ-ME-MILESTONE3.2-TESTS.txt` | `aa0fffb3716e32c9ca30b7befbeadbfdf94058aae58533e669248c90c2d2ba5c` | how to run the standalone T5 test and the full acceptance (identical to the copy in the ZIP) |
