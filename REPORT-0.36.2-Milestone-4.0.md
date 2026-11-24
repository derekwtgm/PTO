# EightMax Test Workbench 0.36.2 — Milestone 4.0 development report

**Multi-table input performance, mouse speed control, recognition at display scaling, input-confirmation reliability, extended tests and ten-table feasibility** · 2026-11-24 · release `EightMax-Test-Workbench-0.36.2-Milestone-4.0.zip` (SHA-256 `ab85ee9215daedd5ad72d9bb4e10f1924b82dd719d8e6caf76f8dcf5d6b22f0e`) · validated on Windows CI run 45441870852 (and 45451149720 for the repeated 5-table run)

## 1. Summary

Milestone 4.0 narrows what the single mouse cursor's lease has to hold, adds scheduling policies and measurement throughout, exposes the mouse speed in the dashboard, makes recognition explicit about display scaling (with a Verify Table Recognition check that keeps a table's input off when it fails), adds two input-safety guards, and measures all of it on real Windows against your Milestone 3.2 baseline. Every change is per setting or per command: the input pipeline "Milestone 3.2 compatibility" sends exactly the Milestone 3.2 sequence.

| Question | Answer |
|---|---|
| 8-table scheduling delay, same machine, same speed | **-20.4 / -22.0 / -21.4 %** on three machines (target 20-30 %: met); action latency -16.5 %; 0 incorrect actions (section 5) |
| 30 minutes at 8 tables | scheduling delay 5.72 → 4.77 s, actions/min 66.7 → 78.7, missed deadlines 96 → 41, 0 incorrect (section 11) |
| Ten tables | **validated** with one hero seat per table and a table clock of 12 s or 15 s (30 minutes each, every criterion met); **not** with an 8 s clock (section 12) |
| Recognition | 0 wrong values accepted in 1 620 dataset frames (800-3 840 px, 100-200 %); real windows at 100-175 %: 3 016 / 3 016 correct. **3840 x 2160 not validated** (CI refused the mode) (section 9) |
| Mouse speed | Conservative / Normal / Fast / Custom in the dashboard; your saved setting is not changed; motion validated at 400-2 800 px/s (section 8) |
| Safety | T5 / T5P pass on 5 machines; every safety requirement of the brief met in every run except the 8 s-clock overload runs (section 13) |
| Open issue | about 1 in 1 400 optimized actions (0 to 0.4 % per 30-minute run) is "delivered, not applied" - never with the Milestone 3.2 sequence on CI: detected, never repeated, cause not established (section 10.2) |
| Your PC | **nothing measured there yet** - run `RUN-M4-PERFORMANCE-TEST.cmd` A and B first (section 18) |
| Native solver | unchanged: `native/mwcli.exe` `b3e675bf…2f72`, EightMax 5.1 build `7d08acc7eb4577ee` |

## 2. How the numbers were obtained

Kinds of evidence are kept apart throughout the report:

| Kind | What it is | What it can and cannot show |
|---|---|---|
| **Development environment** | Linux, Node 22.23.5, Mono for the C# input driver and host (virtual desktop backend) | logic, regression, deterministic data sets - never Windows timing |
| **Simulation** | production code against the in-process fake desktop host (`--fake`) | the Workbench's decisions, scheduling, confirmation and safety logic; no real windows or mouse |
| **Real Windows CI** | GitHub-hosted `windows-latest` (Windows Server 2025, build 26100), 4 vCPUs, 16 GiB, no GPU, 1920 x 1080 desktop; the release ZIP's own executables; real windows, real `PrintWindow` capture, real `SendInput` mouse input | real input, capture and timing on a server-class VM; **not your PC** |
| **Your hardware** | your Windows 11 PC (i7-13700F, RTX 4060 Ti, 3840 x 2160 at 125 %) | **nothing in this report** - Milestone 4.0 has not run there yet (section 18) |

**The release ZIP itself was validated.** The final run, **45441870852**, used `EightMax-Test-Workbench-0.36.2-Milestone-4.0.zip` exactly as delivered (SHA-256 `ab85ee9215daedd5ad72d9bb4e10f1924b82dd719d8e6caf76f8dcf5d6b22f0e`, checked by the workflow before every job): Linux suite from the extracted ZIP, full Windows acceptance, T5/T5P on four further machines, the same-machine A/B comparison on three machines, nine 30-minute runs, recognition at four display scalings, mouse motion at five speeds and the operator launcher. Development runs on earlier code are cited by run number where they add evidence (section 10); none of their numbers is presented as the release's.

| CI run | Code | Used for |
|---|---|---|
| 45395967209, 45401450070 | development (runs 1-2) | the Milestone 3.2 ZIP itself on CI (baseline, section 4); first A/B; first 30-minute and ten-table runs |
| 45409782425 | development (run 3): press guard | 30-minute runs; first unconfirmed-input evidence |
| 45414444138 | development (run 4): capture barrier; **Windows build of the three changed executables** | the executables in the release ZIP (C# sources unchanged since; source hashes checked at assembly) |
| 45432528536 | release candidate 1 | found and repaired: a stricter deadline (withdrawn), two test-fixture defects, a motion-test rounding mismatch (section 10) |
| **45441870852** | **the release ZIP** | **every number in sections 5-9 and 11-13 unless stated otherwise** |
| 45451149720 | the release ZIP | the 30-minute 5-table run, repeated (section 11) |

Every number in the evidence files names the run, the job and the result file it comes from (`tools/make-m40-evidence.cjs`). The raw results of every job are on the repository branches `m40-results/<run id>-<job>`.

## 3. What was changed

Every change is **requested per command or per setting**: with the Milestone 3.2 settings (`pipeline: compat-3.2`, policy `edf`) the
Workbench sends exactly the Milestone 3.2 input sequence, which is how the before/after comparisons were run on the same machines.

### 3.1 Profiling (new)
* `src/action-timeline.js`: every reading that leads to an action carries a timeline of up to 21 monotonic-clock stages
  (capture queued / begin / end, recognition begin / end, state validated, decision ready, submitted, enqueued, lease acquired, target
  re-verified, wager typed, move begin / end, click done, driver acknowledged, lease released, confirmation begin, state confirmed,
  action released). 23 intervals are derived from them (queue wait, revalidation, movement, click, settle, confirmation, action latency,
  end-to-end, the Milestone 3.2 definition of scheduling delay, ...). The driver reports its own phase times inside the click (queue,
  check, move, pre-click, focus/raise, double-click guard, hold, drain), placed on the same clock.
* `TimelineAggregator`: mean / median / P90 / P95 / P99 / max per interval, per table and overall, per input status.
* `tools/resource-sampler-040.cjs`: CPU and working set of every EightMax process, machine CPU and memory, GPU 3D-engine utilisation
  (Windows performance counters), one sample every 5 s; missing samples are recorded as missing.

### 3.2 The input pipeline `optimized` (dashboard default; `compat-3.2` = exactly Milestone 3.2)
What the single cursor lease holds was narrowed to the work that needs the cursor. Per change, from the measured lease composition:

| Change | Milestone 3.2 | Milestone 4.0 `optimized` | Safety argument |
|---|---|---|---|
| Settle after the click (150 ms) | inside the lease | after the lease, **only** when the driver confirmed the clicked control processed the release (capture barrier, below) | the same table is not read before the settle; other tables do not share its window |
| Pre-input window check | extra `window-info` round trip per action | the driver's own identity + client-rectangle check (it already ran it) | same check, one place; refuses on any difference (identity, client rectangle) |
| Raise of a covered window | fixed 30 ms wait, one look | poll every 2 ms until the window is on top (5-100 ms) | the press still requires the target on top at the point; else `target-covered` |
| Double-click spacing | 540 ms between ANY two clicks | per target process, plus the global spacing after any click whose processing was not confirmed | a double-click needs two presses in the same window |
| Revalidation inside the lease | a fresh full-frame capture | a fresh capture of the status-strip region only; the same three checks (window rectangle unchanged, same table, same frame revision); a simulator without a strip is still re-read in full | any difference refuses the action |
| Confirmation polls | full frames every 60 ms | strip-only polls every 30 ms, full frame when the strip changes | the full frame is still read and validated before "confirmed" |
| Host requests | one FIFO queue | a reserved slot for input-critical requests (emergency stop has its own path) | an emergency stop is never queued behind captures |
| Dispatch estimate | fixed | the scheduler's deadline check uses the planned movement time from the actual cursor position | refuses an action that cannot finish before its deadline at the configured speed |
| Start of the decision deadline | the capture the decision was read from | **unchanged** (an experimental option `deadlineAnchor: 'change'` exists, off everywhere; measured and withdrawn - section 10) | - |

### 3.3 Scheduler (`src/input-scheduler.js`)
Six policies, all under the same safety rules (one lease at a time, revalidation inside the lease, emergency stop, pause, lost target,
deadline refusal at the configured speed, exactly one result per job): `edf` (the Milestone 3.2 order, the default), `fifo`, `lst`
(least slack), `edf-aging`, `fair-rr` (round robin over tables) and `nearest-guarded` (the nearest target first unless a job's slack is
below a guard; cursor-distance aware). Every reordering policy has a **bounded bypass** (a job passed over `maxBypass` times goes first),
so no table can starve. New metrics: lease time, cursor utilisation, mean queue depth, Jain fairness of actions per table, maximum wait,
bypass counts, forced and urgent picks.

### 3.4 Input driver (`desktop/input/Driver.cs`, `Platform.cs`; rebuilt on Windows)
* **Capture barrier** (new): a WinForms button raises Click only if, when its window PROCESSES the release, the button is still the
  window under the cursor (`Control.WmMouseUp`); the control that took the press holds the mouse capture until the end of that
  processing. The click reply - and with it the cursor lease - waits until that capture is released (`GetGUIThreadInfo`, at most
  600 ms). A capture that never appears (a busy thread that has not processed the press yet) keeps the settle inside the lease and the
  next click under the global spacing - the Milestone 3.2 behaviour. Two `WM_NULL` round trips (the first drain design) do not prove the
  release was processed: Windows dispatches sent messages before queued mouse input. `BM_GETSTATE` (the second design) cannot show it
  either: WinForms buttons are owner-drawn and keep their pressed state outside the native control.
* **Press guard** (new): after the press, the target must still be the window under the cursor. If its window closed (or was covered)
  at that instant, Windows delivers the press to the window beneath (Windows CI run 45401450070, Milestone 3.2 pipeline: a click meant
  for table 2 reached table 5 when the fault injector closed table 2 twelve milliseconds earlier). The driver moves the pointer off the
  control that received the press before releasing - a button clicks only when released over itself - and reports `press-misdirected`;
  the action is never repeated.
* Read-only queries (`window-info`, `cursor`, `monitors`) are answered while another operation moves the cursor; ordered phase times.

### 3.5 Mouse speed (dashboard, Simulator controls settings)
Presets **Conservative** 800 px/s, **Normal** 1 200 px/s (the default and the speed of every comparison), **Fast** 2 000 px/s and
**Custom** 400-2 800 px/s (acceleration 2 000-30 000 px/s²). The current speed is shown in plain language ("Normal: peak 1200 px/s
(about 640 px/s on average); an 800 px movement takes about 1250 ms"). A preset changes speed and acceleration only, and only when the
operator picks one; saved settings are loaded unchanged and a saved speed that matches no preset is shown as Custom.

### 3.6 Recognition at display scaling
* `src/coordinate-spaces.js`: physical, logical, client, capture and normalised coordinates kept apart; the display scale is read from
  Windows (never guessed from the resolution); a capture that is not the client area at physical size is refused.
* Exact-width templates: a window whose width is not one of the calibrated widths gets templates rendered at its exact width by the
  same controlled renderer (one-time cost per width), instead of a ±2 px search on every card.
* **Verify Table Recognition** (dashboard button and an automatic check before automation starts, `src/recognition-check.js`): one fresh
  capture per registered window, read exactly as automated play reads it; reports the client rectangle, display scale and logical size,
  every calibrated control as a physical rectangle and click point, card and amount positions, every recognised value with its
  confidence, every unreadable region and the status strip. Safety-critical failures (scaled capture, unknown scale, a control that does
  not fit, unknown layout or too small a window, the wrong table) keep that table's input off until a check passes.
* Automated play refuses a print-window / screen-copy frame whose image is not the client area at physical size.

### 3.7 Test infrastructure
`RUN-M4-PERFORMANCE-TEST.cmd` (A recognition verification, B scheduler benchmark, C extended simulator test, D full acceptance, E package
an interrupted run) on the Milestone 3.1 runner (results outside the application folder, a report and a ZIP after every run, plain-
language `M4-SUMMARY.txt`); `tools/recognition-validation-040.cjs`, `tools/motion-validation-040.cjs`, `tools/capacity-model-040.cjs`,
`tools/make-m40-evidence.cjs`; one-hero-per-table workload in the fixture (`--hero-seats`, `--bot-think-ms`, action clock; hero
timeouts reported apart for hands the Workbench tracked and hands it never saw from their opening, where it never acts by design); every
unconfirmed input of a multi-table run keeps its evidence: the table's record (now with the click reply's press-guard, capture and drain
fields and the wall-clock time of the reply), the window's own events from 10 s before to 3 s after, every OTHER window's presses,
releases and actions within 1.5 s of the reply, and the frames before and after. The fixture's oracle records a press and release on an
enabled button that raised no click (`release-without-action`) - a lost click is visible in the simulator's own record.

### 3.8 Defects found during Milestone 4.0 (all repaired)

Two in the Workbench's input path (a press that reached another window when its target closed at that instant - observed, repaired by the press guard; and, found by analysis, a click a busy table could lose when the lease ended too early - prevented by the capture barrier), two in the 4.0 test fixture (the table clock's revision step commented out; a seat the fixture plays itself shown with action controls after the hero's elimination), one in a test tool (the motion plan's rounding), one in the new lost-click record, and one design that was measured and withdrawn (a stricter decision deadline). Details and evidence: section 10.3-10.4.

## 4. Baseline: your Milestone 3.2 numbers, reproduced

Your PC, Milestone 3.2 full acceptance (142 passed, 0 failed, 1 warning, 5 skipped, 11 min 46 s), multi-table stability workload:

| Tables | Actions | Hands | Action latency | Scheduling delay | Missed deadlines |
|---:|---:|---:|---:|---:|---:|
| 1 | 47 | 5 | 0.95 s | 0.03 s | 0 |
| 2 | 30 | 1 | 2.77 s | 0.92 s | 0 |
| 5 | 65 | 3 | 3.79 s | 2.80 s | 0 |
| 8 | 77 | 0 | 5.43 s | 4.40 s | 2 |

As you wrote, these are **short stability scenarios with deliberate interruptions** (a window closed and reopened, an emergency stop, 60-90 s per table count) - not a sustained-throughput benchmark. They are used here exactly as that: the *same* workload, re-run under controlled conditions.

**The Milestone 3.2 release ZIP itself on Windows CI** (unchanged executables and tools, a fresh machine each time; runs 45395967209 and 45401450070):

| Tables | Scheduling delay | Action latency | Confirmed | Missed deadlines |
|---:|---|---|---|---|
| 1 | 0.06 s / 0.05 s | 1.03 s / 0.98 s | 41 / 47 | 0 / 0 |
| 2 | 0.87 s / 0.89 s | 2.78 s / 2.78 s | 31 / 29 | 0 / 0 |
| 5 | 2.72 s / 2.64 s | 3.79 s / 3.63 s | 67 / 66 | 0 / 0 |
| 8 | 4.46 s / 4.39 s | 5.55 s / 5.42 s | 78 / 74 | 2 / 2 |

The CI machines reproduce your PC's 8-table numbers closely (4.40 s scheduling delay, 5.43 s latency, 77 actions, 2 misses). The cause is structural, not hardware: with one cursor and every table always waiting for an action, the scheduling delay is close to (N - 1) x the cursor lease (section 6).

**The comparison method.** Milestone 4.0 keeps the complete Milestone 3.2 input sequence as the pipeline **`compat-3.2`** (dashboard: "Milestone 3.2 compatibility"). Every before/after number below runs `compat-3.2` and `optimized` **on the same machine, in the same job, with the same workload and the same mouse speed (Normal, 1 200 px/s) and policy (edf)**, the order alternating between machines. On CI, `compat-3.2` measured close to the Milestone 3.2 ZIP itself (8 tables: 4.63-4.77 s in the final run on AMD EPYC machines, against 4.39-4.46 s for the Milestone 3.2 ZIP on Intel Xeon machines in runs 1-2), so it is a faithful stand-in; every percentage below compares the two pipelines on the same machine, never across machines. Faster mouse settings were never used for a before/after number; the Fast preset is reported apart.

## 5. Before and after: the Milestone 3.2 workload on the same machines

The Milestone 3.2 multi-table stability workload (1, 2, 5 and 8 tables, 60 s each, a window closed and reopened and an emergency stop per table count, 800 px tables), played with the Milestone 3.2 input sequence (`compat-3.2`) and with the Milestone 4.0 pipeline (`optimized`) **on the same machine in the same job**, the order alternating; Normal speed (1 200 px/s), policy edf. Final run, three machines (each scenario passed, 0 incorrect actions, 0 invalid wagers, 0 "delivered, not applied", 0 lost clicks on every machine):

**Run 45441870852, ab-1** (order compat-3.2,optimized; AMD EPYC 7763 64-Core Processor                )

| Tables | Scheduling delay M3.2 -> M4.0 | change | P95 | P99 | Action latency M3.2 -> M4.0 | change | Confirmed | Hands | Deadline misses | Incorrect |
|---:|---|---:|---|---|---|---:|---|---|---|---|
| 1 | 0.06 s -> 0.04 s | -36.5 % | 0.08 s -> 0.06 s | 0.09 s -> 0.06 s | 0.96 s -> 0.95 s | -1.8 % | 46 -> 47 | 4 -> 4 | 0 -> 0 | 0 -> 0 |
| 2 | 1.36 s -> 1.13 s | -16.8 % | 3.01 s -> 2.67 s | 3.11 s -> 2.79 s | 3.22 s -> 3.08 s | -4.4 % | 31 -> 33 | 1 -> 1 | 0 -> 0 | 0 -> 0 |
| 5 | 2.93 s -> 2.19 s | -25.2 % | 4.99 s -> 4.18 s | 5.26 s -> 4.32 s | 4.07 s -> 3.17 s | -22.0 % | 65 -> 81 | 2 -> 4 | 0 -> 0 | 0 -> 0 |
| 8 | 4.66 s -> 3.71 s | -20.4 % | 6.38 s -> 6.06 s | 7.25 s -> 6.79 s | 5.74 s -> 4.84 s | -15.7 % | 79 -> 85 | 0 -> 0 | 1 -> 1 | 0 -> 0 |

**Run 45441870852, ab-2** (order optimized,compat-3.2; AMD EPYC 7763 64-Core Processor                )

| Tables | Scheduling delay M3.2 -> M4.0 | change | P95 | P99 | Action latency M3.2 -> M4.0 | change | Confirmed | Hands | Deadline misses | Incorrect |
|---:|---|---:|---|---|---|---:|---|---|---|---|
| 1 | 0.06 s -> 0.04 s | -37.3 % | 0.07 s -> 0.06 s | 0.08 s -> 0.06 s | 0.96 s -> 0.94 s | -1.9 % | 47 -> 47 | 4 -> 4 | 0 -> 0 | 0 -> 0 |
| 2 | 1.36 s -> 1.06 s | -22.1 % | 2.98 s -> 2.72 s | 3.03 s -> 2.81 s | 3.21 s -> 2.88 s | -10.5 % | 31 -> 34 | 1 -> 1 | 0 -> 0 | 0 -> 0 |
| 5 | 3.06 s -> 2.20 s | -28.1 % | 5.11 s -> 4.00 s | 5.42 s -> 5.68 s | 4.09 s -> 3.17 s | -22.6 % | 64 -> 79 | 2 -> 4 | 0 -> 0 | 0 -> 0 |
| 8 | 4.63 s -> 3.61 s | -22.0 % | 7.11 s -> 6.39 s | 8.35 s -> 7.07 s | 5.69 s -> 4.70 s | -17.4 % | 72 -> 95 | 0 -> 1 | 2 -> 2 | 0 -> 0 |

**Run 45441870852, ab-3** (order compat-3.2,optimized; AMD EPYC 9V74 80-Core Processor                )

| Tables | Scheduling delay M3.2 -> M4.0 | change | P95 | P99 | Action latency M3.2 -> M4.0 | change | Confirmed | Hands | Deadline misses | Incorrect |
|---:|---|---:|---|---|---|---:|---|---|---|---|
| 1 | 0.06 s -> 0.04 s | -31.0 % | 0.07 s -> 0.05 s | 0.08 s -> 0.06 s | 0.95 s -> 0.96 s | 0.5 % | 47 -> 47 | 4 -> 4 | 0 -> 0 | 0 -> 0 |
| 2 | 1.36 s -> 1.04 s | -23.2 % | 3.02 s -> 2.67 s | 3.08 s -> 2.81 s | 3.22 s -> 2.85 s | -11.4 % | 31 -> 34 | 1 -> 1 | 0 -> 0 | 0 -> 0 |
| 5 | 3.00 s -> 2.19 s | -27.1 % | 5.07 s -> 3.95 s | 5.31 s -> 5.08 s | 4.02 s -> 3.20 s | -20.5 % | 66 -> 80 | 3 -> 4 | 0 -> 0 | 0 -> 0 |
| 8 | 4.77 s -> 3.75 s | -21.4 % | 6.68 s -> 6.39 s | 7.46 s -> 6.84 s | 5.77 s -> 4.82 s | -16.5 % | 70 -> 92 | 0 -> 1 | 2 -> 1 | 0 -> 0 |

### 5.1 Eight tables, summary

| | Machine 1 | Machine 2 | Machine 3 | Mean |
|---|---:|---:|---:|---:|
| Scheduling delay, mean | -20.4 % | -22.0 % | -21.4 % | **-21.3 %** |
| Scheduling delay, P95 | -0.32 s | -0.72 s | -0.29 s | -0.44 s |
| Scheduling delay, P99 | -0.46 s | -1.28 s | -0.62 s | -0.79 s |
| Action latency, mean | -15.7 % | -17.4 % | -16.5 % | -16.5 % |
| Confirmed actions in the same 60 s | 79 → 85 | 72 → 95 | 70 → 92 | +23 % |
| Missed deadlines | 1 → 1 | 2 → 2 | 2 → 1 | 5 → 4 |

**The Milestone 4.0 target (20-30 % lower 8-table scheduling delay under comparable conditions) is met on all three machines** - at the same mouse speed, the same policy and the same workload. At 5 tables: -25.2 / -28.1 / -27.1 %. These are short scenarios with deliberate interruptions (as your own baseline); the 30-minute runs of section 11 are the sustained measurement.

### 5.2 Thirty minutes, eight tables, same machine type (final run)

| 8 tables, 30 minutes, every seat played | Milestone 3.2 sequence | Milestone 4.0 pipeline | Change |
|---|---:|---:|---:|
| Confirmed actions | 2 010 | 2 375 | +18.2 % |
| Actions per minute | 66.7 | 78.7 | +18.0 % |
| Hands completed | 244 | 245 | - |
| Scheduling delay mean / P95 / P99 | 5.72 / 7.42 / 7.79 s | 4.77 / 6.79 / 7.36 s | -16.6 % / -0.64 s / -0.44 s |
| Action latency mean | 6.66 s | 5.75 s | -13.6 % |
| Missed deadlines | 96 | 41 | -57 % |
| Incorrect actions / invalid wagers | 0 / 0 | 0 / 0 | - |
| "Delivered, not applied" (table paused for review) | 0 | 9 | section 10.2 |

Two machines of the same type (separate jobs, so the comparison is less tight than the same-machine rows above); the workload differs from the short scenario (1 500-chip stacks, no injected faults, tournaments replaced as they finish). The sustained reduction of the scheduling delay (-16.6 %) is smaller than in the short scenario (-21 %); the lease itself shrank by 16 % (section 6).

### 5.3 The Fast preset (2 000 px/s), reported apart

Not part of any comparison above (the mouse is faster); same three machines, same workload:

| Run, job | Tables | Sched. delay mean / p95 | Latency mean | Confirmed | Misses | Incorrect |
|---|---:|---|---|---:|---:|---:|
| 45441870852, ab-1 | 1 | 0.04 s / 0.06 s | 0.88 s | 48 | 0 | 0 |
| 45441870852, ab-1 | 2 | 0.71 s / 1.80 s | 2.10 s | 48 | 0 | 0 |
| 45441870852, ab-1 | 5 | 1.94 s / 3.48 s | 2.90 s | 90 | 0 | 0 |
| 45441870852, ab-1 | 8 | 3.32 s / 5.86 s | 4.26 s | 103 | 0 | 0 |
| 45441870852, ab-2 | 1 | 0.04 s / 0.06 s | 0.89 s | 49 | 0 | 0 |
| 45441870852, ab-2 | 2 | 0.70 s / 1.81 s | 2.06 s | 50 | 0 | 0 |
| 45441870852, ab-2 | 5 | 1.95 s / 3.48 s | 2.85 s | 88 | 0 | 0 |
| 45441870852, ab-2 | 8 | 3.33 s / 5.55 s | 4.32 s | 100 | 0 | 0 |
| 45441870852, ab-3 | 1 | 0.04 s / 0.05 s | 0.87 s | 49 | 0 | 0 |
| 45441870852, ab-3 | 2 | 0.69 s / 1.81 s | 2.07 s | 48 | 0 | 0 |
| 45441870852, ab-3 | 5 | 1.94 s / 3.35 s | 2.90 s | 89 | 0 | 0 |
| 45441870852, ab-3 | 8 | 3.30 s / 5.61 s | 4.27 s | 100 | 0 | 0 |


At 8 tables the Fast preset shortens the scheduling delay by a further ~10 % (3.30-3.33 s against 3.61-3.75 s at Normal) - it shortens the movement, nothing else.

## 6. Where the time goes: the cursor lease

With one cursor and N tables that all want it, each table waits for about the other N - 1 leases - the scheduling delay is dominated by the lease time, which is what Milestone 4.0 narrowed. Thirty-minute 8-table runs, final run (mean per lease):

| Stage | compat-3.2 (8 tables, sustained-8-compat-3.2) | optimized (8 tables, sustained-8-optimized) |
|---|---:|---:|
| lease occupancy (whole lease) | 896 | 756 |
| queue wait (scheduling delay) | 5601 | 4689 |
| revalidation inside the lease | 48 | 41 |
| before the movement | 151 | 173 |
| movement | 359 | 377 |
| click (pre-click, raise, guard, hold, barrier) | 188 | 162 |
| driver acknowledgement | 2 | 4 |
| wager typing (raises only) | 970 | 973 |
| settle outside the lease | 0 | 150 |
| settle inside the lease (tail) | 151 | 1 |
| confirmation (after the lease) | 131 | 135 |
| capture | 56 | 56 |
| recognition | 14 | 15 |
| driver: focus / raise | 32 | 12 |
| driver: double-click guard wait | 8 | 0 |
| driver: drain / capture barrier | n/a | 3 |

The 150 ms settle (the table repaints after a click) now runs **after** the lease - but only when the driver has confirmed the clicked control processed the release (capture barrier, 3 ms on average). The raise of a covered window takes 12 instead of 32 ms (polled instead of a fixed 30 ms wait), the global double-click spacing no longer applies between different tables, and the revalidation reads only the status strip. The movement itself is unchanged at the same speed (359 / 377 ms: the same minimum-jerk path, random targets). Lease: **896 → 756 ms (-16 %)**.

**What caused the largest delays in Milestone 3.2:** the single cursor's queue - at 8 tables each table waits for 7 leases of ~0.9 s (cursor utilisation 0.9999) - and inside the lease the settle (151 ms), the movement (359 ms), the click sequence (188 ms) and, for raises, typing the amount (~970 ms on about one action in five).

## 7. Scheduling policies

All six policies run under the same safety rules (one lease at a time, revalidation inside the lease, emergency stop, pause, lost target, deadline refusal at the configured speed, bounded bypass so no table can starve). On the same three machines (optimized pipeline, Normal speed):

| Run, job | Policy | Tables | Sched. delay mean / p95 / p99 | Latency mean | Confirmed | Misses | Incorrect |
|---|---|---:|---|---|---:|---:|---:|
| 45441870852, ab-1 | edf (default) | 5 | 2.19 s / 4.18 s / 4.32 s | 3.17 s | 81 | 0 | 0 |
| 45441870852, ab-1 | fair-rr | 5 | 2.18 s / 4.39 s / 5.52 s | 3.16 s | 79 | 0 | 0 |
| 45441870852, ab-1 | nearest-guarded | 5 | 2.12 s / 5.45 s / 6.57 s | 2.93 s | 87 | 1 | 0 |
| 45441870852, ab-1 | edf (default) | 8 | 3.71 s / 6.06 s / 6.79 s | 4.84 s | 85 | 1 | 0 |
| 45441870852, ab-1 | fair-rr | 8 | 3.79 s / 6.67 s / 6.83 s | 4.90 s | 85 | 0 | 0 |
| 45441870852, ab-1 | nearest-guarded | 8 | 3.49 s / 7.63 s / 8.09 s | 4.46 s | 100 | 3 | 0 |
| 45441870852, ab-2 | edf (default) | 5 | 2.20 s / 4.00 s / 5.68 s | 3.17 s | 79 | 0 | 0 |
| 45441870852, ab-2 | fair-rr | 5 | 2.19 s / 4.06 s / 4.83 s | 3.15 s | 81 | 0 | 0 |
| 45441870852, ab-2 | nearest-guarded | 5 | 2.20 s / 5.73 s / 7.07 s | 3.20 s | 79 | 0 | 0 |
| 45441870852, ab-2 | edf (default) | 8 | 3.61 s / 6.39 s / 7.07 s | 4.70 s | 95 | 2 | 0 |
| 45441870852, ab-2 | fair-rr | 8 | 3.66 s / 6.65 s / 7.13 s | 4.80 s | 86 | 1 | 0 |
| 45441870852, ab-2 | nearest-guarded | 8 | 3.29 s / 6.68 s / 7.60 s | 4.13 s | 104 | 5 | 0 |
| 45441870852, ab-3 | edf (default) | 5 | 2.19 s / 3.95 s / 5.08 s | 3.20 s | 80 | 0 | 0 |
| 45441870852, ab-3 | fair-rr | 5 | 2.18 s / 4.02 s / 4.85 s | 3.15 s | 81 | 0 | 0 |
| 45441870852, ab-3 | nearest-guarded | 5 | 2.12 s / 5.57 s / 8.94 s | 3.04 s | 83 | 1 | 0 |
| 45441870852, ab-3 | edf (default) | 8 | 3.75 s / 6.39 s / 6.84 s | 4.82 s | 92 | 1 | 0 |
| 45441870852, ab-3 | fair-rr | 8 | 3.69 s / 6.62 s / 7.69 s | 4.75 s | 89 | 2 | 0 |
| 45441870852, ab-3 | nearest-guarded | 8 | 3.22 s / 7.27 s / 8.78 s | 3.97 s | 105 | 5 | 0 |


**edf** (earliest deadline first - the Milestone 3.2 order) remains the default. `nearest-guarded` (nearest target first unless a job's slack is short) has the lowest mean at 8 tables (-6 to -14 %) and confirms the most actions (100-105 against 85-95 in 60 s) because the cursor travels less - but its tails are longer (P99 +0.5 to +1.9 s) and it misses more deadlines (3-5 against 1-2): it trades the slowest table's wait for throughput, the wrong trade when a table has a clock. `fair-rr` (round robin over tables) is within noise of edf (mean -2 to +2 %, tails equal or slightly longer). Fairness at 8 tables (Jain index of actions per table) is 0.9999 with edf in the 30-minute runs - no table is starved. `fifo`, `lst` and `edf-aging` were compared in simulation only.

## 8. Mouse input: speed control and motion

### 8.1 Speed in the dashboard

Simulator controls → Settings → **Mouse speed**: **Conservative** 800 px/s, **Normal** 1 200 px/s (the default and the speed of every before/after comparison), **Fast** 2 000 px/s, **Custom** 400-2 800 px/s with acceleration 2 000-30 000 px/s² (validated: numbers only, inside those bounds; anything else is refused with a message). The current speed is always shown in plain language, e.g. "Normal: peak 1200 px/s (about 640 px/s on average); an 800 px movement takes about 1250 ms". A preset changes only speed and acceleration, and only when you pick one; **saved settings load unchanged** - a saved speed that matches no preset is shown as Custom, never replaced. Covered by the dashboard tests (Linux, Playwright) and the settings tests.

### 8.2 Motion on real Windows (final run, `tools/motion-validation-040.cjs`)

Real cursor, real `SendInput`, one 960 x 600 test table at 96 DPI. For each speed: 12 movements between random points, sampled by the driver's independent 1 ms cursor sampler (continuity, end point, button state) with the speed and acceleration limits checked on the driver's commanded path; then 8 clicks through the Milestone 4.0 move-click, each verified by the test table's own record.

| Peak speed | Movements OK | End error | Actual / planned time | Overhead per movement | Average speed | Longest movement allowed | Clicks on target / applied | 800 px movement |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 400 px/s | 12 / 12 | 0 px | 1.02 | 28 ms | 210 px/s | 830 px (longer: refused) | 8 / 8 of 8 | 3750 ms |
| 800 px/s | 12 / 12 | 0 px | 1.02 | 17 ms | 410 px/s | 1660 px (longer: refused) | 8 / 8 of 8 | 1875 ms |
| 1200 px/s | 12 / 12 | 0 px | 1.02 | 11 ms | 612 px/s | 2490 px (longer: refused) | 8 / 8 of 8 | 1250 ms |
| 2000 px/s | 12 / 12 | 0 px | 1.02 | 8 ms | 878 px/s | > 4 000 px | 8 / 8 of 8 | 750 ms |
| 2800 px/s | 12 / 12 | 0 px | 1.03 | 7 ms | 1036 px/s | > 4 000 px | 8 / 8 of 8 | 536 ms |

The movement itself is the same minimum-jerk path as in Milestone 3.2 at the same speed - **Milestone 4.0 did not make the cursor move faster at the same setting**; what was optimised is everything *around* the movement (section 6). A movement that cannot finish within the driver's 4 s movement limit at the configured speed is refused, never sped up (at 400 px/s: longer than 830 px). Motion profiling fields reported per movement: distance, path length (path/distance 1.00-1.01), steps, planned vs actual time, overhead, average and peak speed, end error, cursor lag.

### 8.3 Speed versus scheduling delay

The Fast preset (2 000 px/s) was run on the same three machines as the comparison and is reported **apart** (section 5.3): it shortens the movement part of the lease; it is not part of any before/after percentage.

## 9. Recognition at display scaling

**Coordinate spaces.** `src/coordinate-spaces.js` keeps physical, logical, client, capture and normalised coordinates apart; the display scale comes from Windows (`GetDpiForWindow`, per-monitor-v2), never from a guess based on the resolution; a capture that is not the client area at physical size (a DPI-virtualised or scaled image) is **refused as safety-critical**, never stretched. A window whose width is not a calibrated width gets templates rendered at its exact width.

### 9.1 Deterministic dataset (final run, generated on Windows CI from the release ZIP)

The bundled test table drawn by its own renderer at every combination of the logical widths 800 / 960 / 1024 / 1280 / 1440 / 1920 and the scalings 100 / 125 / 150 / 175 / 200 % (23 physical widths, 800-3 840 px), each clean and with six degradations, 1 620 frames; every recognised value compared with what was drawn (the same result on Linux, bit for bit apart from timings).

**Accepted frames holding a wrong value: 0 of 1 144. False positives: 0 in every feature. Clean frames read: 230 of 230 at every size.** Recognition never guessed: everything it was not sure of was refused (a false negative), which keeps the table's input off for that frame.

| Degradation | Frames | Read (accepted) | Accepted with a wrong value |
|---|---:|---:|---:|
| clean | 230 | 230 (100.0 %) | 0 |
| noise | 230 | 230 (100.0 %) | 0 |
| shifted by 1 px | 230 | 230 (100.0 %) | 0 |
| blurred | 230 | 0 (0.0 %) | 0 |
| dimmed | 230 | 230 (100.0 %) | 0 |
| a card covered | 230 | 0 (0.0 %) | 0 |
| stretched (DPI-unaware window) | 240 | 224 (93.3 %) | 0 |

| Feature | Readings | Correct | False positives | Refused (false negatives) | Lowest confidence of a correct reading |
|---|---:|---:|---:|---:|---:|
| board | 2148 | 2122 | 0 | 26 | 0.9098 |
| hero | 3182 | 3069 | 0 | 113 | 0.9164 |
| pot | 1620 | 1364 | 0 | 256 | 0.8025 |
| hand | 1620 | 1620 | 0 | 0 | 0.8213 |
| stack | 12960 | 11503 | 0 | 1457 | 0.75 |
| bet | 5326 | 4594 | 0 | 732 | 0.7554 |
| folded | 12960 | 12960 | 0 | 0 | 1 |
| controls | 6372 | 6372 | 0 | 0 | 0.9541 |
| callAmount | 1147 | 987 | 0 | 160 | 0.7724 |
| minRaise | 1485 | 1276 | 0 | 209 | 0.7798 |

DPI-virtualised (scaled) captures refused as safety-critical: 240 of 240; Verify Table Recognition on clean frames: 300 of 300 pass.

Per size (clean frames, recognition time per frame on the CI runner):

| Physical width | Logical width x scaling | Frames | Clean frames read | Wrong values accepted | Recognition (clean, mean / p95) |
|---:|---|---:|---:|---:|---|
| 800 px | 800 x 100 % | 60 | 10 / 10 | 0 | 14 / 24 ms |
| 960 px | 960 x 100 % | 60 | 10 / 10 | 0 | 10 / 14 ms |
| 1000 px | 800 x 125 % | 70 | 10 / 10 | 0 | 14 / 23 ms |
| 1024 px | 1024 x 100 % | 60 | 10 / 10 | 0 | 15 / 21 ms |
| 1200 px | 800 x 150 %, 960 x 125 % | 80 | 10 / 10 | 0 | 18 / 22 ms |
| 1280 px | 1024 x 125 %, 1280 x 100 % | 70 | 10 / 10 | 0 | 14 / 17 ms |
| 1400 px | 800 x 175 % | 70 | 10 / 10 | 0 | 19 / 20 ms |
| 1440 px | 960 x 150 %, 1440 x 100 % | 70 | 10 / 10 | 0 | 14 / 16 ms |
| 1536 px | 1024 x 150 % | 70 | 10 / 10 | 0 | 17 / 18 ms |
| 1600 px | 800 x 200 %, 1280 x 125 % | 80 | 10 / 10 | 0 | 18 / 22 ms |
| 1680 px | 960 x 175 % | 70 | 10 / 10 | 0 | 16 / 20 ms |
| 1792 px | 1024 x 175 % | 70 | 10 / 10 | 0 | 18 / 20 ms |
| 1800 px | 1440 x 125 % | 70 | 10 / 10 | 0 | 17 / 20 ms |
| 1920 px | 960 x 200 %, 1280 x 150 %, 1920 x 100 % | 80 | 10 / 10 | 0 | 15 / 22 ms |
| 2048 px | 1024 x 200 % | 70 | 10 / 10 | 0 | 15 / 19 ms |
| 2160 px | 1440 x 150 % | 70 | 10 / 10 | 0 | 16 / 19 ms |
| 2240 px | 1280 x 175 % | 70 | 10 / 10 | 0 | 17 / 20 ms |
| 2400 px | 1920 x 125 % | 70 | 10 / 10 | 0 | 18 / 22 ms |
| 2520 px | 1440 x 175 % | 70 | 10 / 10 | 0 | 17 / 21 ms |
| 2560 px | 1280 x 200 % | 70 | 10 / 10 | 0 | 18 / 24 ms |
| 2880 px | 1440 x 200 %, 1920 x 150 % | 80 | 10 / 10 | 0 | 25 / 27 ms |
| 3360 px | 1920 x 175 % | 70 | 10 / 10 | 0 | 24 / 29 ms |
| 3840 px | 1920 x 200 % | 70 | 10 / 10 | 0 | 29 / 33 ms |

### 9.2 Real windows on Windows CI (final run)

Real test-table windows on a real desktop (1920 x 1080) whose display scaling was set by the job and verified (DPI read back); each window checked by **Verify Table Recognition** (the dashboard check) and every recognised value compared with the table's own state, eight readings per window:

| Display scaling | Desktop | Table widths (physical px) | Verify Table Recognition | Values correct | False positives | Refused |
|---|---|---|---:|---:|---:|---:|
| 100 % (96 DPI) | 1920 x 1080 | 800, 960, 1024, 1280, 1440 | 40 / 40 | 1160 / 1160 | 0 | 0 |
| 125 % (120 DPI) | 1920 x 1080 | 1000, 1200, 1280, 1600 | 32 / 32 | 928 / 928 | 0 | 0 |
| 150 % (144 DPI) | 1920 x 1080 | 1200, 1440, 1536 | 24 / 24 | 696 / 696 | 0 | 0 |
| 175 % (168 DPI) | 1920 x 1080 | 1400 | 8 / 8 | 232 / 232 | 0 | 0 |

**Not validated on CI:** a **3840 x 2160 desktop** - every recognition job of the final run asked for it first and Windows answered `DISP_CHANGE_BADMODE` ("the virtual display does not offer this mode", job logs), so the jobs ran at 1920 x 1080; the dataset covers images up to 3 840 px - and **200 %** (requested in run 45409782425: Windows did not grant 200 % on the 1080p CI display; dataset only). Your configuration - 3840 x 2160 at 125 % - is mode A on your PC (section 18).

## 10. Input-confirmation reliability

Every action the Workbench sends is confirmed from the screen (status-strip revision, then a full validated reading); an action that is not confirmed is **never repeated** and leaves an evidence record. Milestone 4.0 adds to that record the driver's own view of the press (`press.seen` - Windows' button state, `press.root/child` - the window and control under the cursor, `capturedByControl` - whether the control took the mouse capture, i.e. its thread processed the press), the capture barrier and drain result, and - from the controlled test table's own record - the target window's presses, releases and actions from 10 s before to 3 s after, plus **every other window's** presses and actions within 1.5 s of the click (a press Windows routed elsewhere shows up there).

### 10.1 What an unconfirmed input was, in the final run

Every multi-table run of the final run (3 A/B machines - stability workload incl. the Fast and policy rows -, the 30-minute and one-hero runs; the repeated 5-table run is added in section 11):

| Input status | Milestone 3.2 sequence (`compat-3.2`) | `optimized` | What it means |
|---|---:|---:|---|
| confirmed | 2 659 | 15 755 | read back from the screen and matched |
| refused before any input | 191 | 772 | the scheduler or the driver refused before a button or key went down: the deadline could not be met at the configured speed, the window was covered, moved, closed or lost, an emergency stop |
| refused after its window closed | 3 | 19 | the fault injection closed the window during the action - clean refusal |
| uncertain (an emergency stop or the test's own stop during the action) | 12 | 107 | interrupted on purpose; never repeated; the table's record shows the action was applied once or not at all |
| delivered, not applied (section 10.2) | **0** | **15** | the table safety-paused; never repeated |
| ambiguous: two new actions seen after one submission | 0 | 22 (8 s clock only) | the Workbench asks for review instead of guessing |
| timed out | 0 | 1 (8 s clock) | no reading within the confirmation window |

The optimized rows contain about three times as many A/B scenarios (the Fast and the two policy rows run with the optimized pipeline), hence the larger counts of refusals and uncertain inputs.

### 10.2 "Delivered, but the table did not apply it"

This is the condition behind your Milestone 3.1/3.2 T5 report ("the Call click was delivered but its table showed no change"). It was rare and unexplained in Milestone 3.2. Milestone 4.0 measured it on every CI run:

| | Confirmed actions | "Delivered, not applied" | Rate |
|---|---:|---:|---:|
| `optimized` pipeline, runs 1-5 | 44 616 | 25 | 0.056 % |
| `compat-3.2` (= Milestone 3.2 sequence), runs 1-5 | 9 906 | 0 | 0 |
| the Milestone 3.2 ZIP on CI | 433 | 0 | 0 |
| **final run, `optimized`** | 15 755 | 15 | 0.095 % |
| **final run, `compat-3.2`** | 2 659 | 0 | 0 |
| repeated 5-table run (45451149720, release ZIP), `optimized` | 2 452 | 6 | 0.24 % |

**What the evidence shows** (every case since the evidence fields exist, 14 cases in run 45432528536 and the 15 of the final run): Windows registered the press at once (`press.seen` within 1 ms); the window under the cursor was the target table and the control under the cursor was the intended button (`press.root` = the table, `press.child` = the button) - so nothing covered it and the press guard correctly saw no misdirection; **the button never took the mouse capture** (`capturedByControl: false`), so the capture barrier waited its 300 ms and reported the click as *not processed* (`drained: false`); the table's own message filter - which logs every press before the control sees it - recorded **no press at all**, and **no other test table** recorded one either; the table's thread was alive afterwards (it processed a later close command). In the deliberate T5P case, by contrast, the press is recorded and the capture is taken (`capturedByControl: true`) - the evidence separates the two cases cleanly.

**What it is not.** Not a misdirected press (no other window saw it; the press guard confirms the target was under the cursor), not a cross-table input (zero presses on another table at that moment), not a double-click (none recorded), not a stale or late click (the table recorded nothing), not a repeated action (never repeated). **No incorrect action resulted**: the table safety-paused with "Action not applied", exactly as designed.

**What it correlates with.** All 46 cases (runs 1-7: 62 823 confirmed `optimized` actions, 0.073 %; between 0 and 0.4 % in individual 30-minute runs) happened with the `optimized` pipeline; at that rate about 9 would have been expected among the 12 565 `compat-3.2` actions (plus 433 with the Milestone 3.2 ZIP itself) and none occurred (p < 0.001). The first hypothesis - presses that follow another table's click closely (the per-process double-click spacing lets 53-66 % of `optimized` presses come within 540 ms of a release on another table; `compat-3.2`'s global spacing never does) - **was tested and rejected**: 11 of the 27 cases with a measurable gap (runs 45432528536 and the final run) came 556-1 107 ms after the previous release, beyond any spacing. The other differences at the moment of a press (strip-only capture polls every 30 ms instead of full frames every 60 ms - each capture asks the table window to paint itself; the settle after the lease; the polled raise) are untested candidates. **The cause is not established**, and no timeout or spacing was changed on a guess.

**Impact.** About one safety pause per 1 400 actions with `optimized` on average (0.073 %), but it varies between runs from none to 9 in one 30-minute 8-table run (0.4 %) - in continuous play at 5-8 tables, from none to a few per half hour; the table pauses, the action is never repeated, the operator reviews and presses Resume. If that is not acceptable, the dashboard's input pipeline setting offers "Milestone 3.2 compatibility" (zero such cases on CI, at the cost of the speed-up in section 5). Milestone 4.1 priority 1 (section 17).

### 10.3 Repaired during Milestone 4.0 (found by the CI evidence)

| Found | What | Repair |
|---|---|---|
| run 45401450070 (M3.2 pipeline, fault injection) | a press reached another table's window when the target window closed at that instant | **press guard**: the press is released off the control it reached, so no click happens there; reported `press-misdirected`, never repeated |
| analysis of runs 1-3 | the cursor lease could end before a busy table had processed its click; WinForms raises Click only if the button is still under the cursor when it *processes* the release, so another table raised over that spot could swallow the click | **capture barrier**: the lease is held until the clicked control releases the mouse capture (two `WM_NULL` round trips and `BM_GETSTATE`, tried first, cannot prove this). With it the lost-click record shows **0** lost clicks in the final run; the "delivered, not applied" cases turned out to be a different condition (10.2) - this mechanism was never observed directly |
| run 45432528536 | the motion test's reference plan rounded a step that lands exactly on .5 up, the driver to the even pixel | the plan rounds like the driver (the driver was right and is unchanged) |
| one-hero runs (test fixture only) | a 4.0 edit had turned the table clock's revision step and oracle record into a comment | restored to Milestone 3.2, regression test |
| one-hero runs, 8 s clock (test fixture only) | once the hero seat was eliminated, the fixture showed a seat it plays itself **with** action controls drawn but disabled - the Workbench, correctly following the screen, pressed a disabled control (2 incorrect presses and the ambiguous confirmations in run 45432528536; very probably also the 7-34 incorrect presses of the 8 s runs in run 45401450070, which predate the click-kind breakdown, so that link is not verified) | the fixture never draws controls for a seat it plays; a hero out of chips ends that table's test tournament |
| run 45432528536 | the new lost-click record counted the repeated release of an emergency stop's release-all | only the first release after a press counts |

### 10.4 A stricter deadline, measured and withdrawn

A decision's deadline counts from the capture it was read from (Milestone 3.2). If that first reading of a turn comes late, the deadline can extend past a table clock that started with the turn. Release candidate 1 counted the deadline instead from the last capture that still showed the previous status-strip revision (strictly earlier). Measured in run 45432528536, this **did not work**: in the all-seats workload decisions are often read 2-3 s after the change (the Workbench's own confirmation, emergency stops), so deadline refusals rose from 2 to 25-29 per 8-table test, and on a table without a clock a refused decision was refused again on every reading of the unchanged table - tables stopped (four refusals in a row pause gameplay). With an 8 s table clock it paused tables as well. The deadline is the Milestone 3.2 rule again; the stricter rule remains an experimental option, off everywhere; the age of each decision's change is still measured (`changeAgeMs`).

### 10.5 Lost clicks

The controlled table's oracle now records a press and release on an *enabled* button that raised no click (`release-without-action`). In the final run: **0** in every run (the 15 "delivered, not applied" cases are not lost clicks in this sense: the table never received the press at all).

## 11. Extended tests: 30 minutes of uninterrupted play

Thirty minutes per run, no injected faults, one machine per run, the release ZIP (final run; the 5-table run was repeated in run 45451149720 on the same ZIP - see the note below the table). "Hero clock took" counts the decisions the table's own clock made for the hero seat: in *tracked* hands they are missed deadlines; in hands the Workbench never saw from their opening (each table's first hand, section 16) it never acts by design.

| Run | Workload | Tables | Pipeline | Result | Confirmed | per min | Hands | Sched. delay mean / p95 / p99 | Latency mean | Misses | Hero clock took: tracked / untracked hands | Incorrect (kinds) | Unconfirmed (by stop) | No-change | Lost clicks |
|---|---|---:|---|---|---:|---:|---:|---|---|---:|---|---|---|---:|---:|
| 45441870852 | all seats | 10 | optimized | fail | 2437 | 80.9 | 227 | 5.88 s / 7.40 s / 7.86 s | 6.83 s | 140 | 0 / 0 | 0 | 2 (2) | 1 | 0 |
| 45441870852 | hero, clock 12 s, bots 1500 ms | 10 | optimized | pass | 1501 | 50 | 437 | 1.50 s / 4.10 s / 5.49 s | 2.84 s | 0 | 0 / 7 | 0 | 1 (1) | 0 | 0 |
| 45441870852 | hero, clock 15 s, bots 1500 ms | 10 | optimized | pass | 1389 | 46.2 | 413 | 2.10 s / 4.92 s / 6.55 s | 3.74 s | 0 | 0 / 10 | 0 | 3 (3) | 0 | 0 |
| 45441870852 | hero, clock 8 s, bots 800 ms | 10 | optimized | fail | 1824 | 60.6 | 574 | 2.52 s / 4.32 s / 4.92 s | 3.73 s | 160 | 52 / 15 | 21 (outsideControls 19, lateOnOldFrame 1), wrong 1 | 24 (3) | 2 | 0 |
| 45441870852 | all seats | 8 | compat-3.2 | pass | 2010 | 66.7 | 244 | 5.72 s / 7.42 s / 7.79 s | 6.66 s | 96 | 0 / 0 | 0 | 0 (0) | 0 | 0 |
| 45441870852 | all seats | 8 | optimized | fail | 2375 | 78.7 | 245 | 4.77 s / 6.79 s / 7.36 s | 5.75 s | 41 | 0 / 0 | 0 | 2 (2) | 9 | 0 |
| 45441870852 | hero, clock 15 s, bots 1500 ms | 8 | optimized | fail | 1288 | 42.9 | 375 | 0.69 s / 2.27 s / 3.72 s | 1.92 s | 0 | 0 / 7 | 0 | 0 (0) | 0 | 0 |
| 45441870852 | hero, clock 8 s, bots 800 ms | 8 | optimized | fail | 1786 | 59.5 | 529 | 1.56 s / 3.52 s / 4.21 s | 2.80 s | 45 | 5 / 8 | 2 (outsideControls 2) | 2 (0) | 3 | 0 |
| 45451149720 | all seats | 5 | optimized | fail (6 tables paused for review) | 2452 | 81.6 | 307 | 2.46 s / 4.29 s / 5.47 s | 3.46 s | 0 | 0 / 0 | 0 | 3 (3) | 6 | 0 |

Note: in the final run's own 5-table job the test harness aborted the scenario after 26 minutes, when the registration of a replacement table failed with a host connection error ("fetch failed" - section 16); the row above comes from the repeat.

**Hands and actions** (the questions of the brief): 5 tables 307 hands, 81.6 confirmed actions per minute; **8 tables 245 hands (78.7 actions/min) with the Milestone 4.0 pipeline against 244 hands (66.7 actions/min) with the Milestone 3.2 sequence on the same machine type**; 10 tables 227 hands (80.9 actions/min). In the all-seats workload the cursor is saturated (utilisation 0.9999): about **79-82 confirmed actions per minute is the cursor's capacity** with the optimized pipeline at Normal speed (67 with the Milestone 3.2 sequence), whatever the table count. With one hero seat per table the Workbench makes far fewer decisions per hand and plays 413-437 hands in 30 minutes at 10 tables.

**Safety in the 30-minute runs:** zero incorrect actions, invalid wagers and cross-table inputs in every run **except the two overload runs with an 8 s table clock** (8 and 10 tables): there the Workbench, unable to serve every table within 8 s, sometimes completed a press after the table's clock had already acted - the press landed on a control the table had disabled and changed nothing (23 such presses - the table applied nothing from them -, plus 22 ambiguous confirmations, and one check the table's clock made that the Workbench confirmed as its own, which the cross-check reports as one wrong and one unmatched record). That configuration is not sustainable (section 12) and is not a recommended operating point.

**Interruptions and pauses:** every "delivered, not applied" pause (section 10.2) stopped one table for review and was never repeated; the table was replaced by a new tournament in the test. Fault injection (a window closed and reopened, an emergency stop per table count) ran in every A/B scenario on three machines and in the full acceptance; it passed everywhere (no input during the stop, no input to a closed window, nothing resumed by itself).

## 12. Ten tables (details: `TEN-TABLE-FEASIBILITY-4.0.md`)

| Workload (30 minutes, real Windows CI, release ZIP) | Tables | Result against the criteria |
|---|---:|---|
| One hero seat per table, **15 s** table clock, opponents 1.5 s | **10** | **all criteria met**: every table played (413 hands), 0 missed deadlines, 0 decisions taken by the clock in tracked hands, scheduling delay P99 6.55 s (decision window 13.5 s), 0 incorrect actions, Jain fairness 0.992 |
| One hero seat per table, **12 s** table clock, opponents 1.5 s | **10** | **all criteria met**: 437 hands, 0 missed deadlines, 0 clock decisions in tracked hands, P99 5.49 s (window 10.5 s), 0 incorrect actions, fairness 0.989 |
| One hero seat per table, 15 s clock | 8 | met, except one table paused by a host connection error (section 16): 375 hands, 0 incorrect, 0 tracked clock decisions |
| One hero seat per table, **8 s** clock, opponents 0.8 s | 8 and 10 | **not met**: 5 / 52 decisions taken by the clock in tracked hands, late presses on controls the table had already disabled (2 / 21), ambiguous confirmations |
| Every seat played through the window (stress) | 10 | the cursor saturated (80.9 actions/min, utilisation 0.9998); every table served (fairness 0.9999), no starvation; 5.7 % of decisions refused before input by their 12 s deadline (each counted, none late) |

**Highest validated count: 10 tables** - in the one-hero workload with a table clock of 12 s or more (30 minutes each, every criterion met), on a 4-vCPU CI machine at 1920 x 1080. **Ten-table operation is realistic under those conditions, not in general**: with an 8 s clock even 8 tables fail (the Workbench cannot always act within 6.5 s when up to 9 other tables queue for the one cursor), and the cursor-only model predicts 8 tables at 6.5 s, 12 at 12-15 s - optimistic, because the observation path (captures, recognition, confirmation) also slows at high table counts. **Not validated on your PC** (different CPU, a GPU, 3840 x 2160 at 125 %, 1000 px tables), and never claimed for real poker clients - all input is restricted to the bundled test tables.

## 13. Safety requirements (brief 12.3), final run

| Requirement | Result | Evidence |
|---|---|---|
| Zero incorrect actions per oracle | **0** in every run except the two **8 s-clock overload** runs: there 23 presses arrived after the table's own clock had acted and landed on controls the table had disabled (nothing applied), and one action record could not be paired with the table's (section 11) | every multi-table run's in-order cross-check of each confirmed action against the controlled table's own record (hand, seat, street, type, amount), plus every press the table recorded (outside a control, on a disabled control, double-click, on an old frame, not available) |
| Zero invalid wagers accepted | **0** in every run | the table's own wager validation, counted in every run |
| Zero cross-table input violations | **0** - 0 misdirected presses (the press guard checked the window under the cursor at every press), no press recorded by a non-target table in any evidence record | presses recorded by a table other than the target (the cross-window evidence of every unconfirmed input; the misdirected-press counter); lifecycle scenarios with windows moving, closing and covering each other |
| Zero duplicate execution of an uncertain action | **0** - 0 retries in every run | no action is ever retried automatically; every uncertain/unconfirmed input is followed by a pause and recorded; the oracle shows one applied action per confirmation |
| Zero unauthorised input to a lost window | **0** | T5 / T5P (full acceptance + 4 standalone machines, 100 / 125 %), the window closed and reopened in every A/B scenario, lifecycle A-K: no input after a loss; registrations revoked |
| No regression of the emergency stop or registration safety | **none** - every A/B scenario (3 machines x 4 table counts x 4 pipeline / policy rows) passed its stop checks; the lifecycle and regression suites passed on Windows and Linux | an emergency stop in every A/B scenario ("no input during the emergency stop" checked per table), lifecycle and paused-window regression suites (Linux and Windows) |
| Any failure investigated and documented | yes | sections 10 and 16; every unconfirmed input has an evidence file in the results branches |

Preserved without change in behaviour (Milestone 3.2 safety systems): the window-health monitor in every state, the terminal path from any state, the scheduler's explicit registrations and invalidation, the one-input-status-per-attempt model, never repeating an unconfirmed action, the emergency stop (Ctrl+Alt+F12 and the dashboard), the manual-override detection, the executable-bound authorisation, the input restriction to registered EightMax test windows. EightMax 5.1 (`native/mwcli.exe`, SHA-256 `b3e675bf…2f72`, build `7d08acc7eb4577ee`) is byte-identical and verified in every run; no strategy, GTO or decision-policy code changed; scripted practice decisions remain labelled "SCRIPTED FALLBACK — not a solver decision".

## 14. The twenty questions

**1. What caused the largest delays in Milestone 3.2?**
The single cursor's queue. With N tables that all want the cursor, each waits for about N - 1 leases; at 8 tables a Milestone 3.2 lease takes 896 ms on average (30-minute run), so a table waits ~5.7 s (cursor utilisation 0.9999). Inside the lease: the 150 ms settle (held inside the lease), the movement (359 ms - unchanged physics), the click sequence (188 ms: a fixed 30 ms raise wait, the global double-click spacing), a full-frame revalidation (48 ms) and, for raises, typing the amount (~970 ms on about one action in five). Your 8-table 4.40 s is reproduced on CI by the Milestone 3.2 ZIP itself (4.39-4.46 s) - section 4, 6.

**2. What was changed in the scheduler?**
Six policies under the same safety rules (edf - the default and the Milestone 3.2 order -, fifo, lst, edf-aging, fair-rr, nearest-guarded), a bounded bypass so no table can starve, fairness / utilisation / queue metrics, and a deadline check at dispatch from the actual cursor position at the configured speed. Above all the lease was narrowed (the `optimized` pipeline, section 3.2): the settle runs after the lease once the driver confirmed the click was processed (capture barrier), no duplicate window check, a polled raise, double-click spacing per table process, status-strip-only revalidation and confirmation polls, a reserved host slot. Every check is kept; `compat-3.2` is exactly Milestone 3.2.

**3. Which scheduling algorithm performed best?**
**edf** (the default). `nearest-guarded` has the lowest mean and the most actions at 8 tables (-6 to -14 %) but longer tails (P99 +0.5 to +1.9 s) and more missed deadlines (3-5 against 1-2) - the wrong trade when tables have clocks; `fair-rr` is within noise of edf. Section 7.

**4. How much did mean and P95/P99 latency improve?**
Eight tables, same machines, same speed (final run, 3 machines): scheduling delay **mean -20.4 / -22.0 / -21.4 % (-21.3 %)**, P95 -0.29 to -0.72 s, P99 -0.46 to -1.28 s; action latency mean -15.7 / -17.4 / -16.5 %. Five tables: -25.2 / -28.1 / -27.1 %. Thirty minutes at 8 tables: scheduling delay 5.72 → 4.77 s (-16.6 %), P95 7.42 → 6.79 s, P99 7.79 → 7.36 s; action latency 6.66 → 5.75 s (-13.6 %). The 20-30 % target for 8 tables is met in the comparable short workload on every machine; sustained, -16.6 %. Sections 5, 11.

**5. Did the number of missed deadlines decrease?**
In the short 8-table workload they were already few and stayed so (1/2/2 → 1/2/1). In 30 minutes at 8 tables: **96 → 41**. With one hero seat per table at 10 tables and a 12 s or 15 s clock: **0**. With an 8 s clock: 45 (8 tables) and 160 (10 tables) - not sustainable.

**6. Was cursor movement optimised?**
The movement itself was deliberately **not** made faster at the same setting (the same minimum-jerk path; 359 / 377 ms per movement). What was optimised is around it: raise 32 → 12 ms, double-click spacing 8 → 0 ms on average, the settle out of the lease (151 → 1 ms in the lease) - lease -16 %. Motion was validated on real Windows at 400-2 800 px/s: 0 px end error, actual/planned time 1.02-1.03, every click on target. Faster movement is a setting (Fast / Custom), reported apart. Section 8.

**7. Can mouse speed be adjusted in the dashboard?**
Yes: Conservative 800, Normal 1 200, Fast 2 000 px/s and Custom 400-2 800 px/s (acceleration 2 000-30 000 px/s²), the current speed shown in plain language; a preset changes only speed and acceleration and only when picked; saved settings load unchanged.

**8. How accurate is recognition at different window sizes?**
Deterministic dataset, 23 physical widths 800-3 840 px (logical 800-1 920 at 100-200 %), 1 620 frames: **0 accepted frames with a wrong value, 0 false positives**, clean frames read 100 % at every size; noise, 1 px shift and dimming 100 %, a stretched (DPI-unaware) window 93 %, blur and a covered card refused (never guessed); every scaled capture refused as safety-critical. Real windows on CI at 100 / 125 / 150 / 175 %: Verify Table Recognition 104 / 104, 3 016 / 3 016 values correct. Section 9.

**9. Were 4K resolution and 125 % scaling actually validated?**
**125 %: yes, on real Windows CI** (a 1920 x 1080 desktop at 125 %, tables 1 000-1 600 px; also through the launcher, mode A) - not on your PC. **4K (3840 x 2160): no** - the CI virtual display refused the mode (`DISP_CHANGE_BADMODE`); only the dataset covers 3 840 px images. Your 3840 x 2160 at 125 % is untested: mode A on your PC.

**10. How many hands completed during extended five-table testing?**
**307** hands in 30 minutes, every seat played through the window (2 452 confirmed actions, 81.6 per minute, 0 incorrect actions, 0 missed deadlines; 6 tables paused for review by "delivered, not applied" - section 10.2). This 5-table run was repeated on the same ZIP (run 45451149720) because the test harness had aborted the final run's own 5-table job after 26 minutes (section 16).

**11. How many hands completed during extended eight-table testing?**
**245** in 30 minutes with the Milestone 4.0 pipeline and **244** with the Milestone 3.2 sequence on the same machine type (every seat played through the window: eight decisions per table per hand); with one hero seat per table: 375 (15 s clock).

**12. What were the sustained actions per minute?**
Every seat played (cursor-bound): **78.7 at 8 tables and 80.9 at 10** (81.6 at 5) with the optimized pipeline; **66.7** at 8 tables with the Milestone 3.2 sequence (+18 %). One hero seat per table: 42.9 (8 tables, 15 s), 46.2-50.0 (10 tables, 15 / 12 s).

**13. Were there any incorrect or unconfirmed actions?**
**Incorrect: 0** in every A/B scenario (3 machines), the full acceptance, T5 / T5P (4 machines), every 30-minute run with every seat played, and every one-hero run with a 12 s or 15 s clock. In the two **overload** runs with an 8 s clock, 23 presses arrived after the table's clock had already acted and landed on controls the table had disabled (nothing applied), and one action record could not be paired with the table's (most likely a check the clock made that the Workbench confirmed as its own) - that configuration is not sustainable and not an operating point. **Unconfirmed:** 15 "delivered, not applied" in the final run plus 6 in the repeated 5-table run (optimized pipeline; 0 with the Milestone 3.2 sequence) - each paused its table, none repeated (section 10.2); ambiguous confirmations only with the 8 s clock; uncertain inputs only where the test itself stopped the action (emergency stop, end of run).

**14. Did T5 and T5P remain stable?**
Yes: T5 and T5P passed in the final run's full acceptance and on 4 further machines (2 at 125 %), 78 / 78 checks each, and in every development run.

**15. Are all safety protections preserved?**
Yes - section 13: the window-health monitor, the terminal path from any state, registrations and their revocation, never repeating an unconfirmed action, the emergency stop, manual-override detection, executable-bound authorisation, input only to registered test windows. Two protections were added (press guard, capture barrier); none was weakened - a stricter deadline that caused tables to stop was withdrawn instead of being tuned (section 10.4).

**16. What is the maximum independently validated table count?**
**10 tables**, one hero seat per table, with a table clock of 12 s or 15 s: 30 minutes each on real Windows CI with every criterion of the brief met (section 12). With an 8 s clock: fewer than 8. With every seat played (stress) 10 tables run with every table served but 5.7 % of decisions refused for their deadline.

**17. Is ten-table operation realistic?**
**Yes, under those conditions** - a clock of 12 s or more and opponents taking about 1.5 s - on CI hardware. No with an 8 s clock. Not validated on your PC. Section 12 and `TEN-TABLE-FEASIBILITY-4.0.md`.

**18. What remains untested on my personal PC?**
Everything in this report: the speed-up, recognition at 3840 x 2160 and 125 % with your table sizes, your GPU, the 30-minute runs, T5 / T5P with Milestone 4.0, the launcher modes A-D. Section 18 lists what to run (start with A and B).

**19. Was the native solver preserved byte-for-byte?**
Yes: `native/mwcli.exe` SHA-256 `b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72` (EightMax 5.1, build `7d08acc7eb4577ee`), verified in the release record, by the ZIP verification and in every CI job's integrity check; no strategy, GTO or decision-policy code changed.

**20. What should be prioritised in Milestone 4.1?**
1. The root cause of "delivered, not applied" (targeted instrumentation, then one optimized difference at a time). 2. Your PC (modes A-D). 3. The observation path at 8-10 tables. 4. Deadlines that know the table's clock. 5. Preventing a misdirected press at the source. Section 17.

## 15. Validation status by category

Legend: **Implemented** = in the release ZIP; **Simulation** = Linux suite / fake desktop (in-process host, virtual input platform);
**Windows CI** = GitHub-hosted `windows-latest` with a real desktop, the release ZIP's own executables (final run 45441870852 unless a row says otherwise); **Your personal hardware** = your PC (Windows 11, i7-13700F, RTX 4060 Ti, 3840 x 2160 at 125 %).

| Area | Implemented | Tested in simulation | Tested on real Windows CI | Tested on your personal hardware | Not verified |
|---|---|---|---|---|---|
| Action timeline profiling (21 stages, per table and overall) | yes | yes | yes (every multi-table run) | no | - |
| Resource sampling (CPU, RAM, GPU 3D engine) | yes | partly (sampler logic) | CPU and RAM yes; GPU: the CI runner has no GPU, samples recorded as missing | no | GPU utilisation on a real GPU |
| Scheduler policies edf / fifo / lst / edf-aging / fair-rr / nearest-guarded, bounded bypass | yes | yes | edf, fair-rr, nearest-guarded on the same machines | no | fifo, lst, edf-aging on Windows (simulation only) |
| Optimized input pipeline (narrowed lease) | yes | yes | yes (A/B on 3 machines, 30-minute runs) | no | - |
| Capture barrier (click reply waits until the clicked control processed the release) | yes | yes (virtual platform) | yes | no | - |
| Unconfirmed-input evidence (press guard / capture fields, every window's presses), lost-click oracle record | yes | yes | yes | no | - |
| Press guard (press that reached another window is released off it) | yes | yes | yes (fault injection) | no | - |
| Stricter deadline ("count from the change") | experimental option, **off** | yes | measured as a default in run 45432528536 and withdrawn (section 10.4) | no | - |
| Mouse speed presets and Custom, current speed shown, saved settings unchanged | yes | yes (dashboard tests) | motion and clicks at 400-2 800 px/s | no | the dashboard on your PC |
| Coordinate spaces, exact-width templates | yes | yes | 100 / 125 / 150 / 175 % | no | - |
| Verify Table Recognition (dashboard, before automation) | yes | yes | yes (launcher mode A, recognition jobs) | no | - |
| 3840 x 2160 desktop | dataset images up to 3 840 px | yes (dataset) | **no** - the CI virtual display refused 3840 x 2160 | no | **4K on a real display** |
| 200 % display scaling | dataset | yes (dataset) | **no** - Windows refused 200 % on the 1080p CI display | no | **200 % on a real display** |
| 30-minute uninterrupted play at 5 / 8 / 10 tables | - | short fake-desktop runs | yes (5 tables: repeat run 45451149720) | no | your PC |
| One hero seat per table, table action clock | yes (test fixture) | yes | 8 and 10 tables, 8 / 12 / 15 s clocks | no | - |
| Fault injection (window closed + reopened, emergency stop) | yes | yes | yes (stability workload, every A/B machine) | no | - |
| T5 / T5P | unchanged from 3.2 | yes | yes (full acceptance + 4 standalone machines, 100 / 125 %) | no (3.2 only) | - |
| `RUN-M4-PERFORMANCE-TEST.cmd` | modes A-E | - | A, B (short) and E through the launcher; the tools behind C and D ran in the sustained and full jobs | no | C and D through the launcher |
| Ten-table operation | - | capacity model | 30-minute runs (see the feasibility report) | no | your PC |

**Not implemented** in Milestone 4.0 (left for 4.1, section 17): preventing a misdirected press before it is delivered (the press guard prevents only the click it would cause); a decision deadline that knows the table's clock; a second observation path (Windows Graphics Capture) for 8-10 tables; the root-cause fix of "delivered, not applied". **Deliberately not done:** accepting a confirmation that shows two new actions (kept as "manual review" - weakening that check is not allowed), any change to the native engine, strategy or decision policy, any stealth or input-evasion function.

## 16. Known issues

1. **"Delivered, not applied"** with the `optimized` pipeline, about 1 in 1 400 actions on CI on average, 0 to 0.4 % per 30-minute run (section 10.2): handled safely (safety pause, never repeated, full evidence), cause not established. Workaround: the input pipeline "Milestone 3.2 compatibility".
2. **Each table's first hand after starting is not tracked** in the one-hero workload: the dealer's own seats act before the Workbench has read the table, so the hand is refused as "not seen from its opening" (the Milestone 3 rule - correct) and the table's clock takes the hero's decision there. Reported separately as timeouts in *untracked* hands; never counted as missed capacity.
3. **Ambiguous confirmations with fast opponents**: when the other players act within about 0.8 s of the Workbench, a confirmation reading can show two new actions; the Workbench then asks for manual review instead of guessing (22 in the final run, all with the 8 s clock and 0.8 s opponents). Keeping that check is deliberate.
4. **Not validated on CI**: a 3840 x 2160 desktop (the CI virtual display refused it - only the dataset covers 3 840 px images), 200 % scaling (refused by Windows at 1080p), GPU utilisation (no GPU on CI), your PC (section 18).
5. The **ten-table** result depends on the table's action clock (section 12).
6. **Host connection errors**: twice in the final run - and never in the earlier runs with the same host executable - a request to the local desktop host failed at the connection level ("fetch failed"). Once it was a click: treated as possibly delivered, its table paused, nothing repeated. Once it was the registration of a replacement table in the 5-table 30-minute test, which made the test harness abort that scenario after 26 minutes (repeated on the same ZIP in run 45451149720). Cause not established; the harness should report such a failure and continue (4.1).

## 17. What Milestone 4.1 should prioritise

1. **Root cause of "delivered, not applied"** before any further speed work: after a press whose capture never appears, probe the target thread (`SendMessageTimeout`) to separate "thread busy" from "press never queued"; a UI-thread heartbeat and a paint counter in the test table; then switch one `optimized` difference off at a time (strip-only polls, settle after the lease, polled raise, per-process spacing) with at least 20 000 clicks per arm.
2. **Your PC**: modes A-D (section 18) - 4K at 125 %, your GPU, your timing - before tuning anything else.
3. **The observation path at 8-10 tables**, which limits capacity before the cursor does (section 12): fewer capture requests per decision, earlier detection of a hand's opening at start-up, a principled rule for a confirmation that shows the Workbench's action followed by an opponent's.
4. **Deadlines that know the table's clock**: read the remaining time from the client where it is shown, instead of a fixed decision window (the stricter anchor of section 10.4 showed why a blind rule fails).
5. **A misdirected press prevented at the source** (today the press guard prevents only the click it would cause): a safety interlock in the driver's own input path. Not stealth and not evasion - a refusal to deliver.

## 18. What to run on your PC

Nothing in this report was measured on your hardware. Extract the ZIP into a new, empty folder and double-click **`RUN-M4-PERFORMANCE-TEST.cmd`** (instructions: `READ-ME-MILESTONE4-TESTS.txt`). In the order that answers the open questions fastest:

| Mode | Time | Mouse | Answers |
|---|---|---|---|
| **A** Recognition verification | 5-15 min | does not move | recognition on YOUR 3840 x 2160 display at 125 % (never available on CI), the deterministic dataset on your PC |
| **B** Scheduler benchmark | 15-25 min | moves | your before/after numbers: the Milestone 3.2 workload with the Milestone 3.2 and the 4.0 pipeline, same speed, side by side |
| **C** Extended simulator test | 70-80 min | moves | 30 minutes at 5 and at 8 tables on your PC, then injected faults; any "delivered, not applied" pause with its full evidence |
| **D** Full acceptance | 2-2.5 h | moves | everything, including T5 / T5P and the regression suite |

Each run ends with `milestone3-results.zip` in `%LOCALAPPDATA%\EightMax-Test-Workbench\TestResults\Milestone4.0-<date>-<time>-<mode>\` (File Explorer opens with it selected) - please send that ZIP back. `M4-SUMMARY.txt` in the same folder is the plain-language summary. Do not touch the mouse during B, C and D; Ctrl+Alt+F12 stops all input at once.

Your saved dashboard settings, the mouse speed included, are not changed by the tests or by the update. In the dashboard, **Verify Table Recognition** (Simulator controls) checks every registered table window before automation starts; the **input pipeline** setting offers "Optimized (Milestone 4.0)" and "Milestone 3.2 compatibility".

## 19. Files

| File | Contents |
|---|---|
| `EightMax-Test-Workbench-0.36.2-Milestone-4.0.zip` | the release (1 487 entries, 81.3 MB); SHA-256 `ab85ee9215daedd5ad72d9bb4e10f1924b82dd719d8e6caf76f8dcf5d6b22f0e` in `EightMax-Test-Workbench-0.36.2-Milestone-4.0.zip.sha256`. `EightMaxInput.exe`, `EightMaxWorkbench.exe` and `EightMaxCapture.exe` were rebuilt on Windows (CI run 45414444138; their C# sources are unchanged since, checked by hash at assembly); every other executable, the test table and `native/mwcli.exe` are byte-identical to Milestone 3.2 (`release-0362-m40.json`, `SHA256SUMS.txt`) |
| `REPORT-0.36.2-Milestone-4.0.md` | this report |
| `SCHEDULER-PERFORMANCE-4.0.json` | the same-machine comparisons, the policy rows, the Fast preset rows (apart) and the lease composition, each number with its run, job and file |
| `MOUSE-INPUT-PERFORMANCE-4.0.json` | the speed presets, motion validation at 400-2 800 px/s, driver phase times |
| `RECOGNITION-VALIDATION-4.0.json` | the deterministic dataset (per size, degradation and feature; confidence distributions; false positives and negatives) and the real-window results at 100-175 % |
| `MULTITABLE-STRESS-4.0.json` | every 30-minute and one-hero run: throughput, hands, delays, deadlines, input statuses, fairness, resources |
| `TEN-TABLE-FEASIBILITY-4.0.md` | the ten-table question: method, measurements, criteria, model, limits |
| `WINDOWS-VALIDATION-4.0.json` | every Windows CI job of the final run with its outcome, display and reports |
| `REGRESSION-4.0.json` | the Linux suite (both attempts), the full Windows acceptance, T5 / T5P |
| `READ-ME-MILESTONE4-TESTS.txt` | how to run the Milestone 4.0 tests on your PC (also inside the ZIP) |
| `m40-overlay/EightMax-Test-Workbench/` | every file Milestone 4.0 adds or changes relative to the Milestone 3.2 ZIP (the three rebuilt executables excepted) |
| `.github/workflows/windows-0362-m40.yml`, `ci-request-m40.json` | the Windows CI used for every number; results of every job on the branches `m40-results/<run id>-<job>` |

