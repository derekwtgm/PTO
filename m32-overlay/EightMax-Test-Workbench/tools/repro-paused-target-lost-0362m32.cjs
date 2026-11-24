#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 3.2: DETERMINISTIC REPRODUCTION of the operator's T5 failure (Windows 11, 2026-11-24 00:04:16 UTC):
 *   "table 2 TARGET_LOST after its window closed ("ACTIVE"); the scheduler blocks only table 2 ([])"
 *
 *   node tools/repro-paused-target-lost-0362m32.cjs [--root DIR] [--out FILE] [--wait-ms 4000]
 *
 * Two tables run exactly like the acceptance harness runs them (production SimulatorTable / InputScheduler / executor / driver client,
 * run(Infinity), stopOnPause:false) against the in-process fake desktop host (tests/lifecycle-host-fixture.cjs). Table 2's next click is
 * delivered but NOT applied by its dealer (the operator's evidence: the driver reported the Call click, the table showed no change for
 * the whole 4 000 ms confirmation window, the action was classified "rejected" and gameplay paused). Table 2's window is then closed.
 * The tool records, with timestamps: table 2's lifecycle state, whether it paused, every identity probe / capture / input request for
 * table 2's handle after the close, the scheduler's unavailable tables, and whether table 1 keeps playing.
 * --root selects the application tree, so the SAME script shows the defect on the Milestone 3.1 tree and the repair on Milestone 3.2.
 * It verifies scenario logic with a fake host only; it is not Windows evidence.
 */
const path = require('path'), fs = require('fs');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const ROOT = path.resolve(arg('root', path.join(__dirname, '..'))), OUT = arg('out', null), WAIT = Number(arg('wait-ms', '4000'));
const req = (m) => require(path.join(ROOT, m));
const SC = req('src/simulator-controls.js'), SP = req('src/simulator-profiles.js'), SCH = req('src/input-scheduler.js'), XA = req('src/execution-adapters.js'), LC = req('src/window-lifecycle.js'), EM = req('src/engine.js');
const { lifecycleHost, TOKEN, SHA } = req('tests/lifecycle-host-fixture.cjs');
const LS = LC.STATES, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), mono = () => performance.now();
async function until(pred, ms, step = 5) { const end = mono() + ms; while (mono() < end) { if (pred()) return true; await sleep(step); } return !!pred(); }

async function main() {
  const t0 = mono(), events = [], at = () => Math.round(mono() - t0), note = (kind, detail) => events.push({ ms: at(), kind, ...(detail || {}) });
  let dropT2 = false; const dropped = [];
  const host = lifecycleHost(2, { stacks: [120, 120, 400, 120, 120, 400, 120, 120], handGapMs: 40, width: 800 });
  // table 2's dealer ignores the next click it receives (delivered, never applied), like the operator's unconfirmed Call
  const t2w = host.byId(2), orig = t2w.dealer.onWindow.bind(t2w.dealer);
  t2w.dealer.onWindow = (m) => { if (dropT2 && m.type === 'action') { dropT2 = false; dropped.push({ ms: at(), control: m.control, rev: m.rev }); note('dealer-dropped-click', { table: 2, control: m.control }); return; } return orig(m); };
  const api = new SC.HostApi({ token: TOKEN, fetch: host.fetch }), session = SC.hostSession(api);
  const schedEvents = []; const sched = new SCH.InputScheduler({ maxQueue: 8, onCancel: () => session.request('cancel-all'), onEvent: (k, d) => { if (k === 'invalidated' || k === 'rejected') schedEvents.push({ ms: at(), kind: k, table: d.table, code: d.code, registrationId: d.registrationId }); } });
  const auth = SC.authorizations({ environment: 'repro-0362m32', approvedBy: 'Milestone 3.2 reproduction', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA }), profile = SP.fixtureProfile({ exeSha256: SHA });
  const rec = new XA.DiagnosticsRecorder({ max: 20000 });
  const tables = [...host.tables.values()].map((w) => new SC.SimulatorTable({ id: w.id, window: { hwnd: w.hwnd, pid: w.pid, title: 'EightMax Test Table ' + String(w.id).padStart(2, '0'), client: w.client },
    identity: LC.identityOf({ hwnd: w.hwnd, pid: w.pid, processStart: w.processStart, className: w.className, exe: w.exe, client: w.client, dpiScale: 1 }, { exeSha256: SHA }),
    profile, api, session, scheduler: sched, qaAuthorization: auth.qa, recorder: rec, allowScripted: true, seed: w.id, timing: { postClickSettleMs: 0 },
    // the acceptance harness's options (tools/lifecycle-acceptance-0362m2.cjs table()), with a shorter confirmation window so the run takes seconds
    options: { decisionWindowMs: 10000, postActionTimeoutMs: 400, pollMs: 5, idlePollMs: 5, stopOnPause: false, retryBaseMs: 40, retryMaxMs: 320, identityCheckMs: 5000 } }));
  const [t1, t2] = tables, w2 = t2w.hwnd;
  for (const t of tables) t.lc.on((ev) => note('lifecycle', { table: ev.table, from: ev.from, to: ev.to, cause: ev.cause && ev.cause.kind }));
  for (const t of tables) await t.capture.open();
  await session.request('arm');
  const runs = tables.map((t) => t.run(Infinity));
  const out = { format: 'eightmax-m32-repro-paused-target-lost', version: 1, app: EM.VERSION, root: ROOT, environment: 'fake host (logic reproduction, not Windows evidence)', at: new Date().toISOString() };
  try {
    await until(() => t1.m.confirmed >= 3 && t2.m.confirmed >= 3, 20000); note('both-tables-playing', { t1: t1.m.confirmed, t2: t2.m.confirmed });
    dropT2 = true;                                                                          // table 2's next click is not applied
    await until(() => !!t2.paused || t2.lc.is(LS.SAFETY_PAUSED), 15000);
    const last = t2.log[t2.log.length - 1] || {};
    note('table-2-paused', { paused: t2.paused, lifecycle: t2.lc.state, lastAction: last.status, reason: last.reason });
    out.beforeClose = { t2Lifecycle: t2.lc.state, t2Paused: t2.paused, t2LastAction: { status: last.status, reason: last.reason, intended: last.intended }, droppedClick: dropped[0] || null };
    const c1 = t1.m.confirmed, tc = mono(), probesAtClose = host.stats.probesByHwnd[w2] || 0; t2w.closed = true; t2w.dealer.onWindow({ type: 'closed' }); note('table-2-window-closed');
    await until(() => t2.lc.terminal, WAIT);
    const detectMs = t2.lc.terminal ? Math.round(mono() - tc) : null; note(t2.lc.terminal ? 'table-2-target-lost' : 'table-2-NOT-lost-within-wait', { waitedMs: Math.round(mono() - tc) });
    await until(() => t1.m.confirmed >= c1 + 3 || !!t1.completed, 15000);
    out.afterClose = {
      waitedMs: WAIT, t2Lifecycle: t2.lc.state, t2Terminal: t2.lc.terminal, detectMs, t2LostReason: t2.lost && t2.lost.reason, t2LostSource: t2.lost && t2.lost.source,
      schedulerUnavailableTables: sched.status().unavailableTables, schedulerInvalidations: schedEvents.filter((e) => e.kind === 'invalidated'),
      requestsForTable2AfterClose: { captures: host.log.filter((e) => e.kind === 'capture' && e.hwnd === w2 && e.at >= tc).length, identityProbes: (host.stats.probesByHwnd[w2] || 0) - probesAtClose }, inputsToTable2AfterClose: host.log.filter((e) => e.kind === 'input' && e.hwnd === w2 && e.at >= tc).length,
      table1: { lifecycle: t1.lc.state, confirmedAfterClose: t1.m.confirmed - c1, completed: !!t1.completed },
    };
    // the two checks of tools/gameplay-acceptance-0362m3.cjs T5 that failed on the operator's PC
    out.t5Checks = [
      { name: 'table 2 TARGET_LOST after its window closed', pass: t2.lc.terminal, detail: t2.lc.state },
      { name: 'the scheduler blocks only table 2', pass: sched.status().unavailableTables.join() === '2', detail: sched.status().unavailableTables },
      { name: 'no input to the closed window', pass: out.afterClose.inputsToTable2AfterClose === 0, detail: out.afterClose.inputsToTable2AfterClose },
      { name: 'table 1 keeps playing (or finished its tournament)', pass: out.afterClose.table1.confirmedAfterClose >= 3 || out.afterClose.table1.completed, detail: out.afterClose.table1 },
    ];
    out.reproduced = !out.t5Checks[0].pass && !out.t5Checks[1].pass;
    out.verdict = out.t5Checks.every((c) => c.pass) ? 'REPAIRED: the paused table detected the closed window and its scheduler registration was invalidated' : out.reproduced ? 'DEFECT REPRODUCED: the paused table never noticed its window closed (lifecycle ' + t2.lc.state + ', scheduler unavailable ' + JSON.stringify(sched.status().unavailableTables) + ')' : 'OTHER: see t5Checks';
  } finally {
    for (const t of tables) t.stop('repro end'); await Promise.race([Promise.allSettled(runs), sleep(5000)]); for (const t of tables) t.dispose(); host.dispose();
  }
  out.events = events; out.schedulerEvents = schedEvents.slice(-40);
  const text = JSON.stringify(out, null, 2); if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, text); }
  console.log(out.verdict); for (const c of out.t5Checks || []) console.log('  [' + (c.pass ? 'PASS' : 'FAIL') + '] ' + c.name + ' - ' + JSON.stringify(c.detail));
  process.exitCode = 0;
}
main().catch((e) => { console.error(e.stack); process.exitCode = 2; });
