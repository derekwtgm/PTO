# EightMax Test Workbench 0.36.2 — Milestone 3 development report

**Scope: tournament hand tracking (eliminated players), hand recovery, test-runner cleanup, Windows start-up fallback, extended
gameplay testing and Windows CI.** Built on `EightMax-Test-Workbench-0.36.2-Milestone-2.zip` (SHA-256
`4518a133090be292d3e6d190e6259173d25807323e2156d95f10fcc523febc32`, 899 entries, 898 checksum-manifest entries, verified before any
change). Application version `0.36.2-dev`. EightMax 5.1, build `7d08acc7eb4577ee`, **unchanged** (`native/mwcli.exe` SHA-256
`b3e675bf…2f72`, byte-identical).

**Status in one paragraph.** The elimination stall is reproduced on the Milestone 2 code, its root cause is found and repaired in the hand
ledger and the hand tracker, untracked hands recover safely, the test runners exit cleanly, the desktop host's fallback compile works,
and extended gameplay was tested on Linux (fake desktop host, real dealer) **and on real Windows** (GitHub Actions `windows-latest`
runner: real windows, real screen capture, real mouse and keyboard input). The first real-Windows runs found further defects — two of
them pre-existing since 0.24 / 0.35 (card recognition at 800 px; the input driver's cursor bookkeeping after an aborted movement) —
which are fixed; the input driver was **rebuilt on Windows**. The final Windows validation run 45225443410 passed all 51 of its checks: the complete test suite with the bundled Node, executable identities, the seven desktop-host start cases, lifecycle scenarios A–K, gameplay scenarios T1–T6, multi-table stability with 1, 2, 5 and 8 tables and a 135-hand campaign of distinct tournaments, with nothing left running afterwards. **Not yet
done: the operator's own PC** (Windows 11 Home, 3840×2160 at 125 %), so Milestone 3 is not declared fully operational.

Status words used below: **Implemented** (in the code), **Validated** (an automated test passed — environment named), **Windows-tested**
(passed on the real Windows CI desktop), **Simulated / mocked** (fake desktop host on Linux: capture and input are simulated, the
dealer, recognition, tracker, scheduler and adapter are real), **Pending** (not yet run), **Not implemented**.

| # | Release acceptance criterion | Status |
|---|---|---|
| 1 | Eliminated-player handling | **Met.** Implemented; validated on Linux (repro before/after, 16 tracker/ledger tests, differential tests over 2,093 hands); Windows-tested (T1, T2, campaign, multi-table) |
| 2 | Accurate accounting (blinds, antes, pot, stacks, side pots) | **Met.** Ledger differential vs the simulator: 657 hands, 128 side pots, short blinds/antes, heads-up; settlement and chip conservation checked every hand; every finished tournament's winner equals the dealer's |
| 3 | Hand recovery after an untracked hand | **Met.** Unit tests and T3 on Linux and Windows: no input during the untracked hand, recovery at the next verified hand, counted |
| 4 | Automated gameplay without the elimination stall | **Met.** Linux: 498-hand campaigns (19 tournaments to the end); Windows: run 45225443410: 135 hands, 10 distinct tournaments (9 played to the end), 685 of 685 actions confirmed; run 45217637720: 136 hands |
| 5 | No unsafe actions | **Met.** Oracle cross-check in every run: 0 incorrect actions, 0 invalid wagers, 0 confirmed-but-not-applied; untracked and unreadable hands get no input; negative tests (contradictory stacks, duplicate cards, wrong hand numbers, late frames, stale submissions, closed windows, emergency stop) |
| 6 | Test-runner cleanup | **Met.** Milestone 2 runner: 119,271 ms from report to exit; Milestone 3: 10/10 runs ≤ 30 ms, genuine timeouts still fail; Windows: the runner exits 15 ms after its report and its own cleanup check passes (run 45225443410) |
| 7 | Fallback compilation | **Met, Windows-tested.** Seven start cases on the Windows runner (prebuilt, forced fallback with a fresh cache, cache reuse, corrupted executable rebuilt, foreign manifest rebuilt, old key never reused, build-only), each with shutdown, port 48713 released and the input driver gone |
| 8 | Lifecycle preservation (Milestone 2) | **Met, Windows-tested.** Scenarios A–K with real windows; lifecycle stress (8 tables, 120 s) on Linux |
| 9 | Regression coverage | **Met.** Linux 965 tests: 913 passed, 0 failed, 52 skipped; Windows 965 tests: 900 passed, 0 failed, 65 skipped (run 45225443410) (§11) |
| 10 | Native solver preservation | **Met.** `native/mwcli.exe` byte-identical; build id printed by the binary on Windows; every `native/` and `vendor/` file unchanged (93 files) |
| 11 | Release integrity | **Met.** Checksum manifest over every file, executable identities, ZIP re-verified after extraction (§ Package) |
| — | The operator's PC | **Pending** (run `RUN-0362-MILESTONE3-TESTS.cmd`, see `READ-ME-MILESTONE3-TESTS.txt`) |

## 1. Root cause of the eliminated-player defect

The bundled simulator (`src/engine.js`, `Table.startHand`) plays tournaments: chips carry over, and a player who loses every chip stays
in their seat with `stack = 0`, `folded = true` from the first frame of every later hand, receives no cards, posts no ante and no blind;
the button moves to the next funded seat and the blinds skip empty seats. The Workbench's hand tracker had no notion of such a seat:

1. **`HandStateEngine._track()`** (`src/hand-state.js`) treated *any* folded seat in the first reading of a hand as proof that the
   reading came after some action — a fold — had already happened, i.e. that the start of the hand was missed (`missed-hand-start`).
   The hand was refused, and every later reading of it was refused as `untracked-hand`.
2. **`HandLedger`** (`src/hand-ledger.js`), the independent rules engine the tracker replays every hand in, required a positive stack
   for every seat, charged every seat an ante and put the blinds at fixed offsets from the button. A hand that began with eliminated
   players could not even be represented, so the opening pot and blind positions the screen showed contradicted the ledger.

Because the bundled tables wait for the player to act and the Workbench was the only player acting, the refused hand never ended:
**the table stalled at the first hand after the first elimination.** Reproduced on the unmodified Milestone 2 tree with
`tools/repro-elimination-stall-0362m3.cjs` (evidence/0.36.2-m3/repro-elimination-M2-before.json): 16 confirmed actions in hand 1,
seats 2 and 6 eliminated at its end, hand 2 refused (`missed-hand-start` once, then `untracked-hand` for every frame), six funded
players left and the dealer waiting for seat 5 indefinitely. The last confirmed action was seat 2's call of 365 on the flop of hand 1.

## 2. Exact source-code changes

Every change is in the package; against the unmodified Milestone 2 tree, 49 source, test, tool, script and documentation files change (3,362 lines added, 145 removed), plus the generated `START.html`, the rebuilt `desktop/bin/EightMaxInput.exe` and the regenerated build and component records.

**Hand tracking and accounting (Stage 2–3)**
* `src/hand-ledger.js` — participation per seat (`inHand`, `outReason`, `seatStatus()`, `displayFolded()`), antes from dealt-in seats
  only, moving button, blind seats that skip eliminated seats, heads-up rule, short antes / blinds all-in, `currentBet` stays the big
  blind, side pots and settlement over dealt-in players, out seats must not change, chip conservation, `forcedBets()` (opening position
  without building a ledger), JSON version 2 for hands with out seats (version 1 unchanged and still read).
* `src/hand-state.js` — seat statuses (active, folded, all-in, eliminated, sitting-out, unknown) read from the screen; the opening of
  every hand reconstructed and checked element by element (`_openHand`) with explicit reasons; untracked-hand state with hand, code,
  reason, refused frames, last valid hand and recovery counter; recovery only at the verified opening of a later hand plus two consistent
  readings; tournament seating model (eliminations, heads-up, completion, continuity checks `auto` / `strict` / `off`); persistent
  contradictions (25 readings) end the tracking of a hand explicitly; unreadable frames never do (`UNREADABLE_CODES`, Windows finding);
  hidden controls no longer refused while the viewer acts (pre-existing think-time defect); checkpoint version 2 (version 1 restored).
* `src/simulator-controls.js` — one gameplay condition per table, recorded only when it changes (no repeated log lines; the bounded,
  coalescing diagnostics of Milestone 2 are kept): *waiting for a valid hand* ("The current hand could not be reconstructed. Automated
  input is paused until the next verified hand."), *verifying fresh readings*, *hand reconstruction failure*, *player eliminated*
  ("Player elimination detected. Tournament seating and hand state updated."), *invalid chip accounting*, *strategy unavailable*,
  *recognition / capture unavailable*, *target lost*, *emergency stop*, *manual override*, *input confirmation failure*, *tournament
  finished* ("Tournament finished. Automated gameplay has stopped normally." — lifecycle STOPPED, Resume refused); recovery counters
  in the table report; readings refused while confirming an action are recorded and counted (Windows finding).
* `src/simulator-controls-ui.js`, `dashboard.html`, `START.html` — gameplay, hand-tracking and tournament lines in the table row.
* `src/window-lifecycle.js`, `src/execution-adapters.js` — STOPPED cause `tournament-complete`; diagnostics stage `gameplay`.

**Recognition (Windows finding)**
* `src/sim-display.js` — card templates calibrated from every board and hero card position at each width (they came from the first
  board position only; four cards in the turn position read under the 0.9 threshold at 800 px).

**Input driver (Windows finding; executable rebuilt on Windows)**
* `desktop/input/Driver.cs` — the driver's last commanded cursor point is kept (`cmdX`, `cmdY`); after an operation of its own that
  stopped part-way, the remembered position follows it if the cursor is still exactly there (`ResyncAfterOwnAbort`), never after a
  manual override or an emergency stop. `desktop/bin/EightMaxInput.exe` rebuilt by GitHub Actions run 45216843075.

**Strategy library (Windows finding)**
* `src/strategy-library.js` — Windows "delete pending" lock files (EPERM / EACCES / EBUSY) are a busy lock, retried within the time limit.

**Test fixture**
* `src/fixture-dealer.js` — optional action clock, per-seat stacks, `act` / `clock` test commands, full oracle summaries, `dispose()`;
  the view is always a seat dealt in to the hand (Windows finding).
* `tools/test-table-035.cjs` — `--action-timeout`, `--action-timeout-until-hand`, `--stacks`; a window gone before shutdown no longer
  crashes the fixture.

**Windows start-up (Stage 5)**
* `windows/Start-Desktop.ps1` — fallback compile with all three host sources, fingerprinted cache with manifest, invalid-cache rebuild,
  status record (`-ForceCompile`, `-CacheRoot`, `-StatusFile` for tests).

**Test runners and tools (Stage 4, 6, 7)**
* `tools/lifecycle-acceptance-0362m2.cjs` — cancellable timeouts, scenario scopes, awaited process exits, cleanup audit, failure dumps,
  Windows-matched fake environment; same timer repairs in `tools/lifecycle-stress-0362m2.cjs`, `tools/repro-*.cjs`,
  `tools/simulator-benchmark-035.cjs` and four test files.
* New: `tools/gameplay-acceptance-0362m3.cjs` (T1–T6, stability 1/2/5/8, campaign), `tools/repro-elimination-stall-0362m3.cjs`,
  `tools/exit-audit-0362m3.cjs` (+ preload), `tools/build-check-0362m3.py`, `tools/package-0362m3.py`, `tools/make-evidence-0362m3.py`,
  `tools/record-driver-build-0362m3.py`, `tools/record-windows-run-0362m3.py`.
* Windows: `RUN-0362-MILESTONE3-TESTS.cmd`, `READ-ME-MILESTONE3-TESTS.txt`, `windows/Test-Milestone3-0362.ps1`; CI:
  `.github/workflows/windows-0362-m3.yml`, `.github/workflows/windows-0362-m3-driver-build.yml`; the Milestone 2 runner's
  PowerShell 5.1 serialization crash repaired (`windows/Test-Milestone2-0362.ps1`).
* Tests (new): `tests/tournament-0362m3`, `recovery-0362m3`, `negative-0362m3`, `start-desktop-0362m3`, `simulator-ui-0362m3`,
  `release-0362m3`, `windows-findings-0362m3`; updated: `hand-ledger` (zero stacks are now eliminated seats), `release-0362m2`
  (scoped to the documented driver rebuild), `lifecycle-host-fixture` (Windows fixture size and seeds), `ui` (screenshots to a
  temporary folder).

## 3. Corrected tournament accounting

The ledger now follows the simulator's rules exactly (they are listed in the header of `src/hand-ledger.js`):

* A seat is **dealt in** (takes part in the hand) or **not dealt in**: *eliminated* (no chips) or *sitting out* (chips, not dealt in).
  `inHand` and `folded` are separate facts; `outReason` says why a seat is out. "Folded" means folded in this hand only.
* **Antes** are paid only by dealt-in seats; a stack shorter than the ante posts all it has (all-in).
* **Button** moves to the next dealt-in seat; it never rests on an eliminated seat.
* **Blinds**: with three or more players the small blind is the first dealt-in seat after the button and the big blind the next
  dealt-in seat (eliminated seats are skipped); **heads-up** the button posts the small blind and acts first preflop.
* A blind shorter than its amount posts everything (all-in). The amount to call preflop stays the full big blind and the minimum
  raise one big blind (as in the simulator); a player put all-in by the forced bets does not act; if nobody can act the board runs out.
* **Side pots** are built from the dealt-in players' total contributions only; folded chips stay in the pot they were put in.
* **Settlement check**: the final stacks must equal starting stacks minus contributions plus awards; out seats must not change; the
  total of all stacks (chip conservation) must be unchanged.
* **Serialization**: version 1 is unchanged for hands in which every seat is dealt in (old saved hands load as before); hands with
  out seats are written as version 2; `fromJSON` reads both (tested with Milestone 2 data).
* 8-handed defaults are unchanged: SB 0.5 BB, BB 1 BB, ante 0.1 BB per dealt-in player, opening pot 2.3 BB with eight players.

The tracker reconstructs each new hand's **opening** from the screen and checks it element by element against these rules: hand number
(must increase), participation (dealt-in vs. eliminated vs. sitting out), button, blind seats and amounts, antes, stacks before the
forced bets, opening pot, first player to act, and an empty board. Each failed check has its own reason in the dashboard. Nothing is
invented: a hand whose opening was not seen, or whose opening contradicts the rules, is **untracked** — no input — until the opening of
a later hand is verified (two consistent fresh readings), and the recovery is counted and shown.

## 4. Player-elimination regression tests — results

| Test | Where | Result |
|---|---|---|
| Reproduction on the **unmodified Milestone 2** tree (`tools/repro-elimination-stall-0362m3.cjs`, 2,500-chip stacks) | Linux, fake desktop host + real dealer | **Stall**: hand 2 refused (`missed-hand-start` ×1, `untracked-hand` ×156), 16 confirmed actions, dealer waiting for seat 5 with 6 funded players |
| Same tool, **Milestone 3**, 2,500-chip stacks, 60 s | Linux | 41 hands, 306 confirmed actions, 6 eliminations, **0 refused readings**, no stall |
| Same tool, Milestone 3, 1,000-chip stacks, 120 s | Linux | **Tournament completed** at hand 89 (seat 5 wins, verified settlement), 562 confirmed actions, 7 eliminations, 0 refused readings |
| `tests/tournament-0362m3.test.cjs` (16 tests) | Linux + Windows CI (complete suite) | pass — includes the Milestone 2 defect case, a genuine missed fold still refused, each opening check with its reason, short ante / SB / BB, continuity strict vs auto, re-entry, heads-up transition, untracked-hand recovery, completion, serialization v1/v2 |
| Ledger vs simulator differential (in the same file) | Linux + Windows CI | 40 tournaments, 657 hands (602 with eliminated seats, 342 heads-up, 29 short blinds, 6 short antes, 128 side pots, 280 eliminations, 5,152 actions): the ledger and the simulator agree on button, blind seats, participants and seat statuses, first to act, opening pot, amount to call, the legal actions and the pot after every action, showdown awards and the settlement of every hand; every tournament reaches one winner |
| Tracker vs simulator differential | Linux + Windows CI | 20 tournaments, 1,436 hands, 10,253 screens: 1 refusal (a hand run out by the forced bets, first seen finished — correctly untracked), 139 eliminations, 1,312 heads-up hands, 316 side-pot screens |
| Acceptance T1 "hands that start with eliminated players" (the Milestone 2 stall, M2 stacks) | Windows CI 45225443410 + Linux | pass |
| Acceptance T2 "a tournament is played to its end; the end is a normal stop" | Windows CI 45225443410 + Linux | pass |

## 5. Number of complete hands tested

* **Rules and tracking, Linux:** 657 hands (ledger differential) + 1,436 hands (tracker differential) = 2,093 hands in unit tests.
* **End to end, Linux (fake desktop host, real dealer, recognition, tracker, scheduler and adapter; Windows fixture size and deals):**
  repro 130 hands, three campaigns 498 hands (135 + 163 + 200; 19 tournaments played to the end), multi-table stability 257 hands,
  acceptance T1–T6 and lifecycle A–K besides.
* **End to end, real Windows (GitHub Actions runner, real windows, capture and input):** **206** complete hands in the final validation run 45225443410 (campaign 135, multi-table 58, T1 4, T2 9; the hands of T3–T6 and J are not counted) and **159** in run 45217637720 before it (campaign 136, multi-table 10, T1 4, T2 9).

## 6. Long-duration simulation

| Campaign | Where | Hands | Tournaments finished | Actions confirmed | Incorrect / invalid | Missed transitions | Untracked hands needing input | Eliminations |
|---|---|---|---|---|---|---|---|---|
| 5 players × 400 chips | Linux | 135 | 9 | 685 | 0 / 0 | 0 | 0 | 63 |
| 8 × 300 chips | Linux | 163 | 9 | 1,064 | 0 / 0 | 0 | 0 (2 hands nobody acted in) | 61 |
| 8 × 1,500 chips | Linux | 200 | 1 | 1,270 | 0 / 0 | 0 | 0 | 7 |
| 5 players × 400 chips | **Windows CI run 4** (45217637720) | 136 | 8 | 872 of 872 | 0 / 0 | 0 | 0 | 56 |
| 5 players × 400 chips, distinct deals | **Windows CI 45225443410** | 135 | 9 (10 started) | 685 of 685 | 0 / 0 | 0 | 0 | 63 |

The Linux 5 × 400 campaign deals exactly the hands the Windows runs deal (same 800-px table and dealer seeds), and the final Windows
campaign ended with the same totals as the Linux one: 135 hands, 9 finished tournaments, 685 confirmed actions, 63 eliminations.
Run 4's campaign replayed one tournament eight times (a reopened test table dealt with the seed of the table it replaced — fixed: every
generation now deals its own hands, and the later runs play distinct tournaments). Every campaign: each completed tournament's winner is
the dealer's winner, chips are conserved, no stall, no unexpected pause.

## 7. Multi-table stability

Each table count runs short-stack tournaments with eliminations; one window is closed and reopened (new handle, fresh registration),
all tables are emergency-stopped and resumed by the operator, finished tournaments are replaced. Checks: every table played, no
incorrect action (oracle), no confirmed action the table did not apply, no stall / unexpected pause / violation, faults exercised.

| Tables | Linux (60 s each) | Windows CI run 4 (60 s each) | Windows CI 45225443410 (180 s each) |
|---|---|---|---|
| 1 | pass — 56 hands, 351 actions | pass — 6 hands, 46 actions, 3 emergency stops | pass — 27 hands, 150 actions, 3 emergency stops |
| 2 | pass — 74 hands, 572 actions | pass — 1 hand (4 tournaments), 31 actions, closure + reopen | pass — 8 hands, 96 actions, 2 closures + reopenings |
| 5 | pass — 67 hands, 632 actions | pass — 3 hands, 66 actions | pass — 13 hands, 196 actions |
| 8 | pass — 60 hands, 658 actions | pass — 0 complete hands, 79 actions | pass — 10 hands, 201 actions |

On Windows one cursor serves every table and a mouse movement takes about a second, so eight tables complete few hands per minute;
the Windows runs show safety and progress under load, the long gameplay evidence is the campaign. **Ten tables are not claimed.**

## 8. Test-runner timeout repair

`tools/lifecycle-acceptance-0362m2.cjs` raced each scenario against a `setTimeout` it never cleared; every finished scenario left a
timer of up to 8 minutes, plus 10–40 s fixture waiters, so the process stayed alive long after writing its report (measured on the
Milestone 2 tree: **119,271 ms** from report to exit). Milestone 3 uses cancellable timeouts (`withTimeout`, `settleWithin`), a
per-scenario resource scope (tables, runs, fixtures, child processes, recorders) cleaned on success, failure and timeout, process
exits awaited (bounded) before a kill, and `process.exitCode` instead of `process.exit`. A genuine scenario timeout is still reported
as a failure. The same repair was applied to the stress, benchmark and repro tools and to four test files.
`tools/exit-audit-0362m3.cjs` runs the runner and measures report-to-exit time and the handles still alive at report time.

## 9. Fallback compilation repair

`windows/Start-Desktop.ps1` compiled the desktop host from `DesktopHost.cs` and `CaptureService.cs` only; since 0.35 the host also
needs `InputBroker.cs`, so the fallback compile (used when the prebuilt executable is missing or rejected) **could never succeed**, and
its cache key ignored the source list, so a stale executable could be reused. Now: the source list is the same three files as
`windows/Build-Executables.ps1` and `COMPONENT-VERSIONS.json`; the cache folder is named after a fingerprint of the cache format,
compiler options, references, runtime and every source hash; a cache manifest and the executable's recorded hash are checked before
reuse, and an invalid cache is rebuilt with the reason reported; a machine-readable status record is written for tests and support.

## 10. Windows CI results

Every run is on GitHub Actions `windows-latest` (Windows Server 2025 Datacenter, 1920×1080, 100 % scaling, Hyper-V display; real
windows, capture and input) — **not** the operator's PC. Raw results of every run are in `evidence/0.36.2-m3/windows-ci-<run id>/`
(read from the results branch `m3-results/<run id>`: the artifact store is not reachable from this development environment).

| Run | What | Result |
|---|---|---|
| 45163715758 | Milestone 2 runner, Milestone 2 package | **crashed** before any test (PowerShell 5.1 cannot serialise its records): Milestone 2 had never run on Windows; runner repaired |
| 45181140222 | Milestone 3 run 1 | runner defects (no status record, a host left running blocked every later phase, a 2-hour wait, TAP parsing) — cancelled, fixed |
| 45202807377 | run 2 | `-Phases` parameter overwritten by a case-insensitive variable — fixed |
| 45203097931 | run 3 | **37 passed, 10 failed** — the findings in §2 (recognition, escalation, driver, lock, runner names, cleanup) — fixed |
| 45216843075 | input-driver build | `EightMaxInput.exe` built with `windows\Build-Executables.ps1 -SkipWgc` (SHA-256 `2c4d7b73…c91c`) |
| 45217637720 | run 4 | **49 passed, 1 failed** (T2 counted one frame captured mid-repaint as a tracking refusal — check refined; the campaign replayed one deal — fixed) |
| 45224902027 | run 5 | cancelled after three minutes to include the lifecycle-tool cleanup fix |
| 45225443410 | run 6, final development tree | **51 of 51 checks passed — OVERALL PASS** |
| (next to the ZIP) | the final ZIP itself | the run of the exact ZIP is recorded outside it, in `EightMax-Test-Workbench-0.36.2-Milestone-3-verification.json` and on branch `milestone-3-0362` (a ZIP cannot contain its own run) |

Run 45225443410 in detail (Windows Server 2025 build 26100, AMD EPYC, 2 cores / 4 threads, 16 GiB, 1920×1080 at 100 %): all seven executables identified (`EightMaxInput.exe` = the Windows-built `2c4d7b73…`), every shipped file matched `SHA256SUMS.txt`, `mwcli.exe --build-id` printed `EightMaxBuild=7d08acc7eb4577ee`; complete suite 965 tests — 900 passed, 0 failed, 65 skipped (494 s); desktop-host start 7 of 7, each shut down cleanly with port 48713 free within 89–522 ms and the input driver gone; lifecycle A–K 11 of 11, the runner exiting 15 ms after its report with its own cleanup check passing; gameplay T1–T6 6 of 6; multi-table 1/2/5/8 tables 4 of 4 (180 s each); campaign 135 hands; no leftover process, port released. Raw results: `evidence/0.36.2-m3/windows-ci-45225443410/`. The run is recorded in `evidence/windows-ci-runs.json` for the five executables it exercised (desktop host, input driver, test table, `mwcli.exe` identity and build id, Node); `desktop/COMPONENT-VERSIONS.json` therefore marks the rebuilt input driver as validated in Windows CI. `EightMaxCapture.exe` and `EightMaxWgc.exe` were only identified, so their status is unchanged, and no executable is marked as tested on the target PC.

## 11. Regression tests: passed, failed, skipped

| Suite | Environment | Tests | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Milestone 2 baseline (unmodified) | Linux, Node 22.23.5 | 920 | 848 | 0 | 72 |
| Milestone 3 final | Linux, Node 22.23.5, Chromium, Mono 6.8 | 965 | 913 | 0 | 52 |
| Milestone 3, complete suite with the bundled Node | **Windows CI 45225443410** | 965 | 900 | 0 | 65 |

Skipped tests need tools that the environment does not have (on Linux: the Windows `mwcli.exe`, PowerShell, the .NET SDK; on the
Windows runner: Mono, the .NET 8 SDK for the WGC helper, Linux-only stubs) — the same categories as the Milestone 2 baseline.
Reruns: none were needed in the final runs. Failures during development were fixed and are listed in §2 and §10, not hidden.

## 12. Remaining defects and limitations

* **The operator's PC has not run the tests** (Windows 11 Home, i7-13700F, RTX 4060 Ti, 3840×2160 at 125 %). The CI runner is a
  virtual machine at 1920×1080 and 100 %. Display scaling, a physical GPU and the operator's real simulator remain untested.
* **Recognition at uncalibrated window widths:** cards are calibrated at 800, 960, 1280, 1440 and 1920 px. At other widths a few cards
  can read below the 0.9 threshold (at 1024 px: 13 of 1,820 card/position combinations); those frames are refused and the table waits —
  never guesses. Milestone 4 should calibrate the operator's actual table size.
* **A hand already under way, or one that nobody acts in and that is run out at once,** is untracked (no input) until the next hand's
  opening is verified. On the bundled tables, which only move when the player to act acts, an untracked hand that still needs decisions
  never ends unless the table has an action clock (`--action-timeout`) — by design: missed history is never invented.
* **A hand-ending action is confirmed only from its result screen.** If the next hand appears before the result could be read, the
  action cannot be confirmed and the table pauses ("Input confirmation failure"), never retrying blindly. With the fixture's 1.2-second
  result display this did not occur in the final runs.
* **Strict tournament continuity** (`tournamentRules: 'strict'`, used on the controlled fixture) refuses a table that was re-funded for
  a new tournament without a restart; `auto` notes it instead.
* **Windows multi-table depth:** with one cursor and about one second per movement, eight tables complete few hands per minute; the
  Windows multi-table runs show safety under load, not long gameplay. **Ten tables are not claimed.**
* **Decisions:** every gameplay test uses the labelled scripted practice policy on the controlled test table (no EightMax study is
  loaded). Strict EightMax mode still refuses to act without a compatible validated study, and nothing scripted is substituted
  (unchanged, tested). Decision quality is outside this milestone.
* **The Windows lock race** (strategy library) is intermittent (seen once in four Windows suite runs); the fix is covered by a test
  that injects the Windows errors and by the Windows suite passing, not by a deterministic reproduction on Windows.
* **The driver fix** is shown on Windows by the before/after of the two-table run (run 3 failed with a false manual override, later
  runs pass) and the lifecycle scenarios; there is no deterministic Windows test that aborts a movement and checks the next command.

## 13. Native solver

`native/mwcli.exe` is byte-identical (SHA-256 `b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72`); on the Windows runner
the binary itself printed `EightMaxBuild=7d08acc7eb4577ee`; all 93 files under `native/` and `vendor/` are unchanged since Milestone 2
(`release-0362-m3.json`, checked by `tests/release-0362m3.test.cjs`). No solver mathematics, interface or strategy coverage changed, and
no new algorithm was added.

## 14. Recommended priorities for Milestone 4

1. Run `RUN-0362-MILESTONE3-TESTS.cmd` on the operator's PC (125 % scaling, 3840×2160) and fix what it finds.
2. Recognition for the operator's real table sizes and DPI: calibrate the actual window size (or scale-normalise), and show a
   recognition self-check in the dashboard before automation starts.
3. Confirm a hand-ending action from the next hand's opening stacks when the result screen was missed (removes the remaining pause).
4. Longer multi-table soak on Windows (5–8 tables for an hour) and, separately, whether ten tables are realistic with one cursor.
5. Gameplay tests with a compatible EightMax study loaded (strict mode end to end), not only the scripted practice policy.
6. A deterministic Windows test of driver aborts (cancel mid-movement, then an immediate command), and deterministic C# builds
   (`/deterministic`) so a rebuild can be reproduced byte for byte.

## Package

`EightMax-Test-Workbench-0.36.2-Milestone-3.zip` contains every file listed in `SHA256SUMS.txt` plus the manifest, written
deterministically (manifest order, fixed timestamps) by `tools/package-0362m3.py`, which refuses any file whose bytes differ from the
manifest or that the manifest does not list. The ZIP's own SHA-256 is in `EightMax-Test-Workbench-0.36.2-Milestone-3.zip.sha256`;
after packaging the ZIP was extracted into an empty folder, every CRC and manifest entry re-checked, the executable identities
compared with `release-0362-m3.json` and the complete test suite run from the extracted copy — recorded next to the ZIP in
`EightMax-Test-Workbench-0.36.2-Milestone-3-verification.json` (a ZIP cannot contain its own checksum or verification).

Deliverables in the package root: `REPORT-0.36.2-Milestone-3.md` (this report), `HAND-TRACKING-VALIDATION-0362M3.json`,
`GAMEPLAY-STRESS-0362M3.json`, `WINDOWS-VALIDATION-0362M3.json`, `REGRESSION-0362M3.json` (all generated by
`tools/make-evidence-0362m3.py` from the raw files in `evidence/0.36.2-m3/`), `READ-ME-MILESTONE3-TESTS.txt`,
`RUN-0362-MILESTONE3-TESTS.cmd`, `release-0362-m3.json`, `SHA256SUMS.txt`; build evidence in `evidence/build-evidence.json` and
`desktop/COMPONENT-VERSIONS.json`; CI workflows in `.github/workflows/`.
