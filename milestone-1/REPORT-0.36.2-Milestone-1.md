# EightMax Test Workbench 0.36.2 — Milestone 1 development report

**Scope: Windows compilation and executable verification only.** Passing Milestone 1 does **not** make the complete EightMax
application operational. Gameplay acceptance, strict-mode strategy execution, multi-table capacity, installation/rollback and
target-PC (3840×2160, 150 %) checks remain open, exactly as listed in REPORT-0.36.1.md.

Date: 22 November 2026. Application version `0.36.2-dev`; executable file/assembly version `0.36.2.0`.
Native solver: EightMax 5.1, build `7d08acc7eb4577ee`, unchanged.

## 1. Baseline verification

| Item | Result |
|---|---|
| `EightMax-Test-Workbench-0.36.1-Complete-Simulator.zip` | SHA-256 `2586ebf67103937bd6fadbfc2aa4d32a5787cf02693a8fb215876d4ea038e487`, 821 entries, ZIP CRC check passed (Linux and Windows) |
| Checksum manifest | all 820 entries of `SHA256SUMS.txt` matched (Linux `sha256sum -c` and Windows `Get-WorkbenchHashFailures`) |
| Development report | `REPORT-0.36.1.md` inside the ZIP was used. A separately named `EightMax-0.36.1-Development-Report.md` and `EightMax-Windows-Test-Results-20261121-171504.zip` were **not available** to this session; target-PC results from that archive were therefore not reviewed |
| Source versions | host, input driver, test table sources `0.36.1.0` / `0.36.1-dev`; capture tool and WGC helper sources `0.35.0` |
| Bundled executables (discrepancy) | `EightMaxWorkbench.exe`, `EightMaxInput.exe`, `EightMaxTestTable.exe` were the **0.35.0** binaries (FileVersion 0.35.0.0) — the 0.36.1 source changes were not in them, and the old driver lacked the `signedCurves`/`maxDeviationPx` capabilities the dashboard requires |
| EightMax 5.1 | `native/mwcli.exe` SHA-256 `b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72`; `--build-id` → `EightMaxBuild=7d08acc7eb4577ee` |
| Build script | `windows/Build-Executables.ps1` (.NET Framework 4.x `csc.exe`, `/platform:x64`); used unchanged with `-SkipWgc` |

## 2. What was changed (complete list)

Unified diff: `milestone-1/changes-0.36.1-to-0.36.2.diff` in the development branch; original files are in `source-0.36.1-original/` of this package.

1. **Version stamping** — `desktop/DesktopHost.cs`, `desktop/input/Driver.cs`, `desktop/testtable/EightMaxTestTable.cs`: assembly/file version `0.36.2.0`, informational/application version `0.36.2-dev`. Same application version in `src/engine.js`, `src/simulator-controls-ui.js` (diagnostics label), `windows/Common.ps1`, `tools/simulator-benchmark-035.cjs` (report label now read from `src/engine.js`), `READ-ME-FIRST.txt`, `docs/CHANGELOG.md`.
2. **Startup/shutdown defect repaired** — `desktop/DesktopHost.cs`: the host's listening socket and accepted connections are made non-inheritable (`SetHandleInformation`). Found by the Milestone 1 test: the window-mode host opens the dashboard with `chrome --app=…`, the browser inherited the listener and kept port 48713 bound after the host closed, so the next host start failed with *"Port 48713 on 127.0.0.1 is already in use"*. Verified fixed on Windows (port free ≈3 s after the host exits while the browser stays open; a new host starts).
3. **Test literals** — `tests/release-031/032/033.test.cjs`, `tests/windows-025.test.cjs`, `tests/pwsh/Common.Tests.ps1`: version literals updated; `release-033` now expects `0.36.2` only in the three rebuilt 0.36.x components and `0.35.0` in the unchanged capture/WGC tools. `Common.Tests.ps1` still pinned `0.35.0` (a pre-existing Windows-only failure).
4. **New tools** — `windows/Test-Milestone1-0362.ps1` (focused checks), `RUN-0362-MILESTONE1-TESTS.cmd`, `tools/release-manifest-0362.py` (LF manifest on every OS), `tools/record-windows-run-0362.py` (evidence record), `.github/workflows/windows-0362-m1.yml` and `windows-0362-m1-final.yml`.

**Not changed:** solver mathematics, CFR, EightMax 5.1 binary and vendor files, strategy coverage, simulator features, mouse-movement algorithms, `Build-Executables.ps1`. `EightMaxCapture.exe` is recompiled by the unchanged build script from its unchanged 0.35.0 source; `EightMaxWgc.exe` and `runtime/node/node.exe` are carried over byte-for-byte.

## 3. Windows build

GitHub Actions `windows-latest` (Microsoft Windows Server 2025 Datacenter 10.0.26100, interactive desktop set to 1920×1080 at 100 %), repository `derekwtgm/PTO`, branch `milestone-1-0362`, **run 45083913369**, source commit `5063e9616d08`. Compiler: Microsoft (R) Visual C# Compiler 4.8.9221.0 (.NET Framework 4.x). Result: all four `csc` targets compiled; one warning (CS0108 `TableForm.DeviceDpi()` hides an inherited member — present in earlier releases, harmless). Log: `evidence/0.36.2/windows/build-executables.log`; build record: `evidence/build-evidence.json` (output and source SHA-256s).

| Executable | Version | Architecture | SHA-256 |
|---|---|---|---|
| `desktop/bin/EightMaxWorkbench.exe` | 0.36.2.0 / 0.36.2-dev | AMD64 PE32+ GUI, .NET 4.x | `845578b9a6596009e68ce6f182d47ae20ddd511f58b9c37a3d4b12e1c7f32290` |
| `desktop/bin/EightMaxInput.exe` | 0.36.2.0 / 0.36.2-dev | AMD64 PE32+ console, .NET 4.x | `93867a03f43534d65d41853901b706bb892456894cb118f89b5d4a80bce71da1` |
| `desktop/bin/EightMaxTestTable.exe` | 0.36.2.0 / 0.36.2-dev | AMD64 PE32+ GUI, .NET 4.x | `3e5a76995a24d169336179e7e3805ddeb57271d951029226b43653c217464348` |
| `desktop/bin/EightMaxCapture.exe` | 0.35.0.0 (source unchanged) | AMD64 PE32+ console | `8180c32910bfd1d5053c42f8c9ccf484bb6146022dc1284e45dbbde622124da0` |
| `desktop/bin/EightMaxWgc.exe` | 0.35.0 (carried over) | x64 self-contained | `bc001504382306e180af0f76abf0836d561faa07e8c210317df73048e55cafc1` |
| `native/mwcli.exe` | EightMax 5.1, build 7d08acc7eb4577ee (unchanged) | x64 | `b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72` |
| `runtime/node/node.exe` | v22.23.5 (unchanged) | x64 | `247e9693d316da9857e44990e5e11709f596f18112251b8026ec6eed80bdf38a` |

## 4. Required Milestone 1 results (run 45083913369, actual Windows execution)

| Component | Evidence |
|---|---|
| Desktop host | 0.36.2.0, SHA-256 `845578b9…2290`; headless start ready in 169 ms; window start ready in 114 ms with its window shown and the dashboard opened in Chrome; health reports `0.36.2-dev`, build `7d08acc7eb4577ee`; session token enforced (HTTP 403 without it) — **PASS** |
| Input driver | 0.36.2.0, SHA-256 `93867a03…1da1`; started by the host's input broker, token hello accepted, reports `0.36.2-dev` on win32 SendInput; capabilities `signedCurves`, `maxDeviationPx`, 21 operations, click guard 540 ms, per-monitor-v2 DPI, UI Automation, Ctrl+Alt+F12 registered, raw-input override — **PASS**; self-test 11/11 |
| Test table | 0.36.2.0, SHA-256 `3e5a7699…4348`; window opened, `ready`/`describe`/`frame`/`close` over its dealer protocol; controls fold/check/call/raise/all-in/wager — **PASS** |
| EightMax 5.1 | binary byte-identical, `--build-id` = `EightMaxBuild=7d08acc7eb4577ee`, and the rebuilt host's own hash gate accepted it — **original build preserved** |
| Windows runtime | actual execution on Windows Server 2025 with an interactive desktop (screenshots in `evidence/0.36.2/windows/`) — **confirmed** |
| Basic communication | host→driver (status, cursor, monitors, window-info of the table); host capture of the test table (960×600, 45 sample pixels identical to the frame sent to the table); end-to-end smoke host capture → decision → broker → driver → table: 13 actions attempted, 13 confirmed, 13 matched to the table oracle, 0 incorrect clicks/wagers — **working** |
| Shutdown | test table exits 0 on `close`; headless host exits 88 ms after authenticated shutdown, its driver gone; window host exits 0 when its window is closed, its driver gone; port 48713 and the single-instance lock released (fresh host started and stopped); no leftover EightMax/mwcli processes — **clean** |

Test counts (same run):

- Focused Milestone 1 checks (`windows/Test-Milestone1-0362.ps1`): **50 passed, 0 failed**.
- Input driver self-test (`EightMaxInput.exe --selftest`): **11/11**.
- Existing input acceptance on the controlled tables (`tools/input-acceptance-035.cjs`, bundled Node): **29/29**.
- One-table communication smoke (`tools/simulator-benchmark-035.cjs --tables 1 --seconds 45`): reliable, 13/13 confirmed. This is a smoke test, not a capacity measurement.
- Existing regression suite (`node --test tests/*.test.cjs` with bundled Node and Playwright Chromium): **897 tests, 874 passed, 0 failed, 23 skipped**.
- Release-metadata recheck after recording the run: 52 tests, 48 passed, **1 failed**, 3 skipped. The failure is `0.31 defect fixed: worker threads opening a NEW strategy library at the same time never fail` — an intermittent concurrency test of the strategy library (it passed in the full suite of the same run and in two other runs, failed in one). It is unrelated to this milestone's changes and is listed as outstanding.

## 5. Development runs (honest history)

| Run | Outcome |
|---|---|
| 45075689702 | compiled; focused check step stalled after the self-test (pipe-based output capture) — cancelled; script made pipe-safe |
| 45078989461 | 44 checks passed; script cleanup error (`@()` around a generic List, also flagged by an existing regression test); restart found port busy; input acceptance 15/16 at the runner's default 1024×768 |
| 45080921328 | 48/50; port still held after window-host exit with its owner gone |
| 45082455145 | 48/50; diagnosis: the dashboard browser opened by the host held the inherited listening socket |
| **45083913369** | **50/50 after the host socket fix; all smoke and regression steps passed** (this package) |

## 6. Package

`EightMax-Test-Workbench-0.36.2-Milestone-1.zip` contains the complete application tree, rebuilt executables, unchanged EightMax 5.1 engine and runtimes, all sources (0.36.2 tree plus `source-0.36.1-original/` and the change diff), build and test scripts, the workflows, build/test logs and results under `evidence/0.36.2/windows/`, `desktop/COMPONENT-VERSIONS.json` regenerated from evidence, `release-0362.json`, this report and a regenerated `SHA256SUMS.txt`. Normal Windows operation uses only the bundled runtimes; Python is needed only to regenerate developer metadata. The final ZIP is packaged on Windows by `windows-0362-m1-final.yml`, which also extracts it into a fresh folder and reruns the focused checks with Python and Node removed from `PATH`; that re-verification is recorded outside the ZIP (it cannot contain its own hash).

## 7. Unresolved / not verified in Milestone 1

- Target PC (Windows 11, 3840×2160 at 150 %) — not tested; CI ran at 1920×1080, 100 %.
- Full dashboard-driven three-hand gameplay, strict-mode EightMax decisions, emergency stop / manual override during real movement, multi-table capacity, install/uninstall/rollback — out of scope, unverified.
- The capture tool `EightMaxCapture.exe` was recompiled and identity-checked but not executed (the host's built-in capture service was).
- Intermittent strategy-library concurrency test (see §4).
- The supplied target-PC results archive `EightMax-Windows-Test-Results-20261121-171504.zip` was not available and was not analysed.
