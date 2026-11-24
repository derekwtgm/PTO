# Ten-table feasibility — EightMax Test Workbench 0.36.2 Milestone 4.0

Release `EightMax-Test-Workbench-0.36.2-Milestone-4.0.zip` (SHA-256 `ab85ee9215daedd5ad72d9bb4e10f1924b82dd719d8e6caf76f8dcf5d6b22f0e`) · measurements: Windows CI run 45441870852 (the release ZIP) · 2026-11-24

## 1. Answer

* **Highest validated table count: 10** - with **one hero seat per table and a table action clock of 12 s or 15 s** (opponents taking about 1.5 s per decision): in a 30-minute run each, all ten tables played, no decision in a tracked hand was taken by the clock, no deadline was missed, the 99th percentile of the scheduling delay stayed far inside the decision window (5.5 s of 10.5 s; 6.6 s of 13.5 s), zero incorrect actions, every table served equally.
* **With an 8 s clock, 8 tables already fail**: the one cursor cannot always serve every table within 6.5 s; decisions are taken by the clock and some presses arrive after the table has moved on (they land on disabled controls and change nothing in the test table). Not sustainable, not a recommended operating point.
* **In the stress workload** (every seat of every table played through the window) the cursor saturates at about 80 actions per minute from 5 tables on; at 10 tables every table is still served (fairness 0.9999) and no queue grows without bound, but 5.7 % of decisions are refused before any input because their 12 s deadline cannot be met - counted, never late.
* **Ten-table operation is realistic only under those conditions**, on a machine like the CI runner (4 vCPUs, 1920 x 1080 at 100 %, 800 px tables). It is **not validated on your PC** and never claimed for anything but the bundled test tables.

## 2. How the question was answered

Ten-table operation is a question about **one shared resource - the single mouse cursor -** and about the **screen-observation path** that feeds it. It was answered three ways; only the first counts as validation.

1. **Measured on real Windows CI** (GitHub-hosted `windows-latest`: 4 vCPUs, 16 GiB, no GPU, 1920 x 1080 at 100 %; the release ZIP's own executables and the bundled test tables; cascade layout, 800 px tables). Uninterrupted **30-minute** runs, no injected faults, in two workloads:
   * **all seats** - every seat of every table is played through the window (the Milestone 3 stress workload): every table always has an action waiting, so the cursor is saturated from about 4-5 tables on and each table waits for the other N - 1. This measures the cursor's capacity.
   * **one hero seat per table** - the test table plays its other seven seats itself after a think time (800 ms, or 1 500 ms with the 12 s and 15 s clocks) and enforces its **own action clock** (8, 12 or 15 s; the Workbench's decision window is the clock minus a 1.5 s margin). This is the realistic multi-tabling workload. A decision the clock takes for the hero is a missed deadline - never an unsafe input.
2. **A closed queueing model** (exact mean-value analysis): N tables, one server (the measured lease time), a delay station (settle, confirmation, capture, recognition, decision) derived from the measured cycle; checked against every measured table count.
3. **A discrete-event simulation driving the real `InputScheduler`** (on a virtual clock, any policy) with the measured lease-time distribution and the measured time between a confirmed hero action and the hero's next turn, for 1-12 tables and decision windows of 6.5 s (the 8 s CI clock minus the margin), 12 s (the dashboard's default decision window) and 15 s. (The one-hero runs with 12 s and 15 s clocks have decision windows of 10.5 s and 13.5 s; compare them with the model's 12 s and 15 s rows accordingly.) It models the cursor only - not the observation path - which is why it is optimistic at high table counts.

**Criteria** (brief, section 12.4), applied to the 30-minute runs: (a) all ten tables participating; (b) measurable hand completion; (c) acceptable deadline performance - no decision in a *tracked* hand taken by the table's clock, the 99th percentile of the scheduling delay below the decision window; (d) no critical safety failure - zero incorrect actions, invalid wagers and cross-table inputs; (e) no unresolved queue growth or starvation - every table served (fairness), no growing queue. A table count is called **validated** only when a 30-minute real-Windows run at that count meets every criterion; the model never validates anything.

## 3. Measured (30 minutes each, real Windows CI, the release ZIP)

| Workload | Tables | Clock | Hands | Confirmed (per min) | Sched. delay mean / P95 / P99 | Clock took: tracked / untracked | Missed deadlines | Incorrect | Pauses for review | Fairness (Jain) |
|---|---:|---:|---:|---|---|---|---:|---:|---|---:|
| one hero seat | 8 | 15 s | 375 | 1288 (42.9) | 0.69 / 2.27 / 3.72 s | 0 / 7 | 0 | 0 | 1 | 0.9897 |
| one hero seat | 10 | 15 s | 413 | 1389 (46.2) | 2.10 / 4.92 / 6.55 s | 0 / 10 | 0 | 0 | 0 | 0.9919 |
| one hero seat | 10 | 12 s | 437 | 1501 (50.0) | 1.50 / 4.10 / 5.49 s | 0 / 7 | 0 | 0 | 0 | 0.9890 |
| one hero seat | 8 | 8 s | 529 | 1786 (59.5) | 1.56 / 3.53 / 4.21 s | 5 / 8 | 45 | 2 | 5 | 0.9978 |
| one hero seat | 10 | 8 s | 574 | 1824 (60.6) | 2.51 / 4.32 / 4.92 s | 52 / 15 | 160 | 21 | 23 | 0.9951 |
| every seat | 8 | none (12 s window) | 245 | 2375 (78.7) | 4.77 / 6.79 / 7.35 s | - | 41 | 0 | 9 | 0.9999 |
| every seat | 10 | none (12 s window) | 227 | 2437 (80.9) | 5.87 / 7.40 / 7.86 s | - | 140 | 0 | 1 | 0.9999 |

"Clock took" counts decisions the table's own clock made for the hero: in *tracked* hands they are missed deadlines; in the hands the Workbench did not see from their opening (each table's first hand after starting: the dealer's seats act before the Workbench has read the table) it never acts by design. "Pauses for review": "delivered, not applied", ambiguous confirmations and other unconfirmed inputs - each stops one table, is never repeated, and is recorded with evidence. One of the 8-table 15 s pauses was a host connection error (main report, section 16).

## 4. The criteria at ten tables

| Criterion (brief 12.4) | 12 s clock | 15 s clock | 8 s clock | every seat (stress) |
|---|---|---|---|---|
| all ten tables participating | yes (437 hands) | yes (413 hands) | yes | yes (227 hands) |
| measurable hand completion | yes | yes | yes | yes |
| acceptable deadline performance | **yes** - 0 missed, 0 tracked clock decisions, P99 5.49 s of 10.5 s | **yes** - 0 missed, 0 tracked clock decisions, P99 6.55 s of 13.5 s | **no** - 52 tracked clock decisions, 160 missed | **no** - 140 refused for their deadline (5.7 %) |
| no critical safety failure | **yes** - 0 incorrect, 0 invalid wagers, 0 cross-table | **yes** | **no** - 21 presses after the table moved on (the table applied nothing from them) | **yes** |
| no unresolved queue growth or starvation | yes (fairness 0.989, max wait 7.0 s) | yes (0.992, 7.3 s) | yes | yes (0.9999, 8.6 s) |

## 5. Model (predictions from the measurements above - not validation)

**Every seat through the window** (exact mean-value analysis): lease 739 ms, delay station 900 ms (fitted on the 10-table run) - saturation **81.2 actions/min** (measured: 78.7 at 8 tables, 80.9 at 10); the Milestone 3.2 sequence: 896 ms lease, 67/min (measured 66.7).

**One hero seat per table** (the real `InputScheduler` on a virtual clock, edf; lease time and the time between a hero's actions measured in the 8-table 15 s run):

| Tables | P99 response (wait + lease) | Late at 6.5 s | Late at 12 s | Late at 15 s | Cursor utilisation |
|---:|---:|---:|---:|---:|---:|
| 1 | 2.2 s | 0.00 % | 0.00 % | 0.00 % | 0.09 |
| 2 | 2.6 s | 0.00 % | 0.00 % | 0.00 % | 0.188 |
| 3 | 3.1 s | 0.00 % | 0.00 % | 0.00 % | 0.263 |
| 4 | 3.6 s | 0.00 % | 0.00 % | 0.00 % | 0.36 |
| 5 | 3.9 s | 0.00 % | 0.00 % | 0.00 % | 0.45 |
| 6 | 4.3 s | 0.00 % | 0.00 % | 0.00 % | 0.528 |
| 7 | 4.8 s | 0.00 % | 0.00 % | 0.00 % | 0.604 |
| 8 | 5.3 s | 0.08 % | 0.00 % | 0.00 % | 0.673 |
| 9 | 6.4 s | 0.96 % | 0.00 % | 0.00 % | 0.749 |
| 10 | 6.8 s | 1.37 % | 0.00 % | 0.00 % | 0.819 |
| 11 | 7.1 s | 1.73 % | 0.00 % | 0.00 % | 0.876 |
| 12 | 9.1 s | 5.46 % | 0.00 % | 0.00 % | 0.929 |

Highest count with P99 below the window and at most 0.1 % late: **8 tables at a 6.5 s window, 12 at 12 s and at 15 s** (fair-rr: 5 / 11 / 12). The model covers the cursor only; measured, the 8 s clock fails already at 8 tables - the observation path (captures, recognition, confirmation, the first hand of each table) adds delay the model does not see. It is used as a guide, never as evidence.

## 6. What limits more tables

1. **The cursor** - one lease at a time (756 ms on average, section 6 of the main report): N tables wait for N - 1 leases. Narrower leases (Milestone 4.0: -16 %) or the Fast preset (-10 % scheduling delay at 8 tables) move the limit, not remove it.
2. **The table's clock and the observation path** - a decision is due within the clock minus a safety margin, counted from the reading the decision came from; at 8-10 tables a turn can be read late, and a late reading followed by a long queue ends after the clock (the 8 s results). A deadline that knows the client's clock is Milestone 4.1 priority 4; a stricter blind rule was tried and withdrawn (main report, section 10.4).
3. **Fast opponents** - when opponents act within 0.8 s, a confirmation reading can show two new actions; the Workbench asks for review instead of guessing.
4. **"Delivered, not applied"** - about 1 in 1 800 optimized actions, independent of the table count (main report, section 10.2).

## 7. Not validated

Your PC (mode C of `RUN-M4-PERFORMANCE-TEST.cmd` runs 5 and 8 tables for 30 minutes each; ten tables can be run with `set EIGHTMAX_M4_ARGS=...` - see `READ-ME-MILESTONE4-TESTS.txt`), 3840 x 2160, 125 % with 1000 px tables, opponents faster than 0.8 s, more than 10 tables (modelled only), any real poker client (out of scope by design).
