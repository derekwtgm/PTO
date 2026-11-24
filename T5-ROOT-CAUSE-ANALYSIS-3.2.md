# T5 root-cause analysis — EightMax Test Workbench 0.36.2 Milestone 3.2

**Failure analysed:** T5 "Two tables: eliminations on both, one window closes; no input crosses tables", Milestone 3.1 full acceptance on the operator PC (Windows 11 Home, i7-13700F, 3840 × 2160 at 125 %), 2026-11-24 00:04:16–00:05:07 UTC. Reported: `table 2 TARGET_LOST after its window closed ("ACTIVE"); the scheduler blocks only table 2 ([])`.

## 1. Evidence used — and what was not available

| Evidence | Source | Used for |
|---|---|---|
| The failure text and the description of the diagnostic log (Call click reported by the driver, no state change within 4 000 ms, classified rejected, gameplay paused) | the brief | the starting point |
| `Logs/desktop-requests.log` of the operator PC, covering the failing run (requests until 00:09:50 UTC) | the uploaded collector ZIP `EightMax-Windows-Test-Results-20261123-172312.zip` | the request-level timeline of T5 (section 3) |
| The Milestone 3.1 source code and ZIP (`49d0d7a4…`) | branch `milestone-3.1-0362` | the code path (section 2) |
| Oracle files of 8 Windows CI runs of Milestone 3 / 3.1 (8 141 button presses) | branches `m3-results/*`, `m31-results/*` | how a delivered click normally ends (section 4) |
| **Not available:** `milestone3-results(2).zip` of the failing run (`work-gameplay/diag-acceptance-T5.json`, `oracle-table-02.jsonl`) | it was not among the uploaded files | — |

Because the T5 diagnostic file and the test table's oracle were not available, the **window-loss defect** is established from the code, the operator's request log and a deterministic reproduction, while the **reason the Call was not applied remains undetermined** (section 4).

## 2. Root cause of the T5 failure (established and reproduced)

The failure is a chain of four facts in the Milestone 3.1 code:

1. **A delivered action without a visible effect only paused GAMEPLAY.** `_confirm()` polled table 2 for the whole `postActionTimeoutMs` (4 000 ms), saw no new status-strip revision, then a fresh reading showed the same player still to act: `{status:'rejected', clean:true}`. `TestExecutor.execute()` paused the table (`pauseTable(... 'Action visibly rejected by the simulator')`). In `SimulatorTable._step()` this is neither `unconfirmed` nor `inputMayHaveHappened`, so no safety pause followed: `this.paused` was copied from the executor and the **window lifecycle stayed `ACTIVE`**.
2. **Every later step returned before any window check.** `_step()` returns `{kind:'paused'}` as soon as `this.paused` is set, *before* the periodic identity check — and that check also ran only in `ACTIVE`.
3. **The run loop of a paused table makes no host request at all.** `run()` (harness and dashboard: `stopOnPause:false`) handles `paused` with `sleep(250)` — "local state only, no host requests".
4. **So nothing ever probed the window after it was closed.** The lifecycle never reached `TARGET_LOST`, `targetLost()` never ran, so `InputScheduler.invalidateTable()` was never called: `status().unavailableTables` stayed `[]`.

**Corroboration in the operator's request log:** no `/api/capture/close` was issued during T5 (`targetLost()` always sends one), no request can be attributed to table 2 after its 4-second confirmation window, and the harness's 15-second wait for `TARGET_LOST` expired (cleanup requests at 00:05:07.53).

**Deterministic reproduction** (`tools/repro-paused-target-lost-0362m32.cjs`, production controller / scheduler / executor / driver client, fake desktop host, the harness's run options; table 2's next click delivered but not applied, then its window closed):

| Tree | Table 2 after the pause | After the close (15 s) | Probes / captures of table 2 after the close | Scheduler `unavailableTables` | Verdict |
|---|---|---|---|---|---|
| Milestone 3.1 | `ACTIVE`, gameplay paused | **`ACTIVE`** | **0 / 0** | **`[]`** | the operator's exact message, reproduced |
| Milestone 3.2 | `SAFETY_PAUSED` (input-rejected) | `TARGET_LOST` after ~1.0 s (health monitor) | 1 / 0 | `[2]` | repaired |

The defect is not test-only: the dashboard also runs tables with `stopOnPause:false`, so a paused table on the operator's own simulator would equally have missed a window loss.

## 3. Timeline of T5 on the operator PC (request log)

Facts are read from the log; attributions to table 1 / table 2 are **inferences** (the log has no window handle and no command name). Full detail: `evidence/0.36.2-m32/operator-T5-timeline.json`, raw lines: `operator-T5-requests-excerpt.txt`.

| UTC (2026-11-24) | Request(s) | Fact | Inference |
|---|---|---|---|
| 00:04:16.129 / .133 | r755, r757 `capture/open` | two capture sessions open | T5 starts: tables 1 and 2 registered |
| 00:04:16 – 00:04:44 | … | both tables act: long `input/command` (move-click 0.4–2.4 s), captures, short commands | both tables play; several pairs of commands complete in the same millisecond = one table's identity probe queued in the driver behind the other table's click |
| 00:04:44.466 → 00:04:45.838 | r851 `input/command` 1 372 ms, ok | a long command returns success | **table 2's Call move-click; the driver reports the click done** |
| 00:04:44.523 → 00:04:45.838 | r853 `input/command` 1 314.7 ms | completes in the same millisecond as r851 | table 1's periodic identity probe, queued behind r851 |
| 00:04:45.841 – 00:04:47.503 | r854–r857 | capture, capture, 0.8 ms command, 1 450.8 ms command | table 1 reads, revalidates in its lease, checks the window, clicks |
| 00:04:46.087 → 00:04:50.040 | r858 … r919 | captures at a steady ~100 ms cadence for 4.2 s | **table 2's confirmation polls** (first poll = click + 150 ms settle + 60 ms poll delay): the strip revision never changes |
| ~00:04:50.04 | — | cadence ends | 4 000 ms elapsed; fresh reading: same actor → `rejected` → gameplay paused; lifecycle `ACTIVE` |
| after 00:04:50.04 | — | no further request attributable to table 2 | the paused loop makes no request (the defect) |
| ~00:04:52.5 | — | (derived from the 15 s wait that ended at 00:05:07.5) | the test closes table 2's window |
| 00:04:56.687 | r957 | last request, then 10.8 s silence | table 1 finished its tournament (normal end) |
| 00:05:07.532–.540 | r958–r960 | three short commands | cleanup (disarm, unregister ×2) after the checks failed |

## 4. The unconfirmed Call — investigation

**What is known.** The driver returned success for a move-click at the Call control (status 200 after 1 372 ms; the brief: "at the intended location"). For 4 000 ms the window never showed a new status-strip revision, and a fresh reading afterwards still showed table 2's same player to act. The four events the brief asks to keep apart:

| Event | Status for the operator's Call |
|---|---|
| 1. the driver reported that a click was issued | **yes** (request log: r851 ok) |
| 2. Windows delivered the press/release to the test-table window | **unknown** (would be in `oracle-table-02.jsonl`: mouse-down / mouse-up) |
| 3. the table applied the action | **no visible effect for 4 s**, but whether the dealer refused it, never received it, or applied it without the window repainting is **unknown** (oracle: action result, accepted list) |
| 4. the confirmation observed the action | **no** (no new revision; final reading: same actor) |

**Hypotheses examined** (the brief's list), with the evidence for each:

| Hypothesis | Assessment |
|---|---|
| Confirmation timeout too short | **Not supported.** On Windows CI a confirmation takes 117–125 ms on average, p99 ≤ 145 ms (123 confirmations of T1–T6, Milestone 3.1 final run); 4 000 ms is a ~28× margin, and the screen had not changed at all. No timing was changed. |
| Cursor position / hit-test coordinates / small target / display scaling 125 % | **Unlikely.** The click point is the deterministic centre of the inset Call region (≈ 56 × 25 px control at 800 px), the driver checks that the point is inside the region and that the window under it is the target immediately before pressing; every other click of the same run (same code, same scaling) worked. A systematic scaling error is ruled out; a one-off coordinate error is not explained by scaling. |
| Window movement during input | **Ruled out:** the driver re-checks the client rectangle during the movement and before the press and would have returned `layout-changed`, not success. |
| Multi-table scheduler timing / input cancellation race | **Ruled out by code and log:** cancellation happens only on invalidation, emergency stop or an operator cancel; none occurred in T5 (no `/api/input/estop`, no invalidation ever ran). Table 1's next input started 0.2 s *after* table 2's click had returned. |
| Simulator (dealer) processing delay | **A dealer-wide stall is ruled out:** the same dealer process served table 1 normally during those 4 s (table 1's clicks were confirmed). A stall of table 2's *window* (its UI thread) is not ruled out — fast captures do not prove the window repainted, because PrintWindow with full-content rendering can return the last composed surface. |
| Stale frame revision (dealer "stale-click") | **Unlikely:** in T5 the dealer's revision changes only by an accepted action or a new hand (no turn delay, no action clock, no resize), so the window shows the revision the Workbench decided on. Not provable without the oracle. |
| Missed mouse-down / mouse-up; focus switching between the two windows; another table acquiring focus | **Not determinable** from the available files. One possible mechanism: if table 2's UI thread was busy when the press arrived and table 1 was activated ~0.2 s later (its own click), the button may lose its capture before processing the release, so its Click never fires. This was **not** reproduced: on Windows CI all 8 141 button presses of 2- to 8-table runs produced an action the dealer accepted (the one exception was a window the test closed 16 ms after the press). |

**Conclusion:** the cause of the unapplied Call **is not established**. It did not recur in any Windows CI run (development and final runs of Milestone 3.2 are listed in the report), and nothing in the available evidence supports a specific defect in the Workbench's click path. It is therefore **not marked as fixed**.

**What Milestone 3.2 changed so that a recurrence is explained and handled safely:**

- An action that was delivered but visibly not applied is now a **safety pause** (`SAFETY_PAUSED`, cause `input-rejected`, dashboard: "Action not applied"), never retried automatically; the window keeps being monitored and the operator resumes through `RECOVERY_PENDING` (fresh readings first). Milestone 3.1 left a gameplay pause behind an `ACTIVE` lifecycle — the state in which the closed window went unnoticed.
- Every attempt has one **input status**: confirmed / rejected-before-input (nothing sent; may be retried from a fresh reading) / rejected-no-change / uncertain / timed-out / cancelled-after-input / ambiguous.
- Every input that was sent but not confirmed leaves an **evidence record** (`unconfirmedInputs` in the table report; T5 writes `work-t5\unconfirmed-*.json` plus the window's frames before/after as PNG): table, registration, handle and identity fingerprint, action, control region, selected point, display scaling, client rectangle at reading and after, foreground / minimised / visible / cloaked state after the confirmation window, driver result (planned/actual time, travel, final error, hit window class, double-click-guard wait), scheduler lease (id, queue wait, run time), confirmation trace (polls, failed captures by code, status-strip revisions seen, new and unreadable frames, final fresh reading), frame revisions before/after, timeline. No session token and no desktop content outside the registered window.
- The **test table's oracle** now records every frame the window reports as shown (with its revision) and the window's own clock on presses, releases and actions, so the four events above can be told apart. The T5 acceptance attaches the oracle facts around the click to the evidence (the Workbench itself never reads the oracle).
- T5 reports **input confirmation separately** (a WARNING with the evidence), so a recurrence cannot hide behind, or be confused with, the window-loss checks.

## 5. The repair (window loss in every state)

- **`WindowHealthMonitor`** (`src/window-lifecycle.js`) verifies the original registered identity (window-info: handle, process id, process start time, class, executable) on its own timer, independent of gameplay and strategy: about once a second while gameplay is paused, safety-paused, stopped or the table is not `ACTIVE`; as a backstop (7.5 s without any probe) while it plays. It reports only a confirmed loss (window gone; handle now belonging to another window / process instance), never moves a lifecycle towards `ACTIVE`, never authorises input and never resumes gameplay. One probe at a time, shared with the table's own probes; unknown answers (driver busy, timeout) prove nothing and back off; an answer arriving after the registration is lost is discarded; it stops for good at `TARGET_LOST`. `window-info` is not an input operation, so the driver answers it during an emergency stop as well.
- **Terminal path from any state:** `targetLost()` (idempotent) records the state it interrupted (`previousState`, gameplay pause), stops the monitor, revokes capture and the driver authorisation (a reused handle can never inherit it), discards pending decisions and invalidates the scheduler registration — queued input rejected, running input cancelled (only that table's), later jobs of that registration refused. A capture failure is now judged only by a probe that started after the failure was known (a probe answer taken just before a close could otherwise turn a loss into "temporarily unavailable").
- **Scheduler registrations** (`src/input-scheduler.js`): explicit `registerTable()`; invalidation revokes a registration for good and is idempotent; `unavailableTables` lists exactly the tables whose current registration is lost; a re-registered table (new registration, fresh authorisation) is available again while its old registration stays refused; a pause set by an older registration no longer blocks its replacement (a latent Milestone 3.1 defect found by the new regression tests: the replacement window of a paused table could never act).

## 6. How the repair was verified

| Level | What | Result |
|---|---|---|
| Deterministic reproduction | `tools/repro-paused-target-lost-0362m32.cjs` on Milestone 3.1 vs 3.2 | defect reproduced on 3.1; repaired on 3.2 (section 2) |
| Deterministic regression (fake host) | `tests/paused-window-0362m32.test.cjs`: scenarios A–R of the brief + monitor and scheduler units, each checking state transitions **and** per-window input | see the report (`LIFECYCLE-REGRESSION-3.2.json`) |
| Real Windows CI | standalone `RUN-M3.2-T5-TEST.cmd` on separate fresh machines (T5 + T5P each, half at a measured 125 % display scaling), full acceptance, Milestone 3.1 scenario suite | see the report (`T5-WINDOWS-VALIDATION-3.2.json`) |
| Operator PC | `RUN-M3.2-T5-TEST.cmd` | **pending** — CI is not the operator's hardware |
