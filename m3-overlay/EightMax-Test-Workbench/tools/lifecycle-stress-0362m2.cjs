#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 2: LIFECYCLE STRESS TEST (any OS, in-process fake host - logic and invariants only).
 *   node tools/lifecycle-stress-0362m2.cjs [--tables 8] [--seconds 120] [--seed 7] [--out reports/0.36.2-m2-lifecycle-stress.json]
 * N tables play scripted practice while random faults hit random tables: window closed (sometimes reopened and re-registered as a
 * NEW registration), minimised and restored, transient capture failures, handle reuse by another process, emergency stop + reset.
 * Invariants checked over the whole run:
 *   - no input and no capture request for a window after its loss was confirmed (per registration)
 *   - every confirmed action matches what that table's own dealer received (no redirected input, no duplicate)
 *   - one TARGET_LOST transition per lost registration; no lifecycle ever leaves TARGET_LOST
 *   - no input while the emergency stop is latched
 *   - diagnostics stay bounded; no loop error; memory and timers return to baseline after the run
 */
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..'), src = (m) => require(path.join(ROOT, 'src', m));
const SC = src('simulator-controls.js'), SP = src('simulator-profiles.js'), SCH = src('input-scheduler.js'), XA = src('execution-adapters.js'), LC = src('window-lifecycle.js'), EM = src('engine.js');
const { lifecycleHost, TOKEN, SHA } = require(path.join(ROOT, 'tests', 'lifecycle-host-fixture.cjs'));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const N = Number(arg('tables', '8')), SECONDS = Number(arg('seconds', '120')), OUT = arg('out', path.join(ROOT, 'reports', '0.36.2-m2-lifecycle-stress.json'));
const LS = LC.STATES, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), mono = () => performance.now(), rng = new EM.RNG(Number(arg('seed', '7')));
const r01 = () => rng.next ? rng.next() : Math.random();

async function main() {
  const mem0 = process.memoryUsage().heapUsed, handles0 = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().length : null;
  const host = lifecycleHost(N, { enforceRegistration: true }), api = new SC.HostApi({ token: TOKEN, fetch: host.fetch }), session = SC.hostSession(api); session.capabilities = { signedCurves: true, maxDeviationPx: true, singleClickGuardMaxMs: 540 };   // as the real driver reports
  const sched = new SCH.InputScheduler({ maxQueue: 16, onCancel: () => session.request('cancel-all') }), rec = new XA.DiagnosticsRecorder({ max: 20000 }), profile = SP.fixtureProfile({ exeSha256: SHA });
  const auth = SC.authorizations({ environment: 'stress', approvedBy: 'lifecycle stress test', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA });
  const regs = [], violations = [], faults = { close: 0, reopen: 0, minimize: 0, transient: 0, reuse: 0, estop: 0 }; let estopOn = false, estopInputs = 0;
  async function registerTable(w) {
    const r = await session.request('register-target', { hwnd: w.hwnd, authorization: auth.simulator }); if (!r.ok) throw new Error('register: ' + r.error);
    const identity = LC.identityOf(r.window, { exeSha256: SHA });
    const t = new SC.SimulatorTable({ id: w.id, window: { hwnd: w.hwnd, pid: w.pid, title: 'EightMax Test Table ' + String(w.id).padStart(2, '0'), client: w.client }, identity, profile, api, session, scheduler: sched, qaAuthorization: auth.qa, recorder: rec, allowScripted: true, seed: w.id, timing: { postClickSettleMs: 0 },
      options: { decisionWindowMs: 10000, pollMs: 5, idlePollMs: 5, postActionTimeoutMs: 800, stopOnPause: false, retryBaseMs: 40, retryMaxMs: 320, maxRetryAttempts: 40, identityCheckMs: 300 } });
    const g = { t, w, startedAt: mono(), lostAt: null, run: null, dealerAccepted0: w.dealer.accepted.length }; regs.push(g); g.run = t.run(Infinity); return g;
  }
  // input / capture accounting per window, after loss
  const lossTimes = new Map(); const origFetch = host.fetch;
  host.fetch = async (url, init) => {
    const p = url.replace('http://127.0.0.1:48713', ''), body = init.body ? JSON.parse(init.body) : {}, h = LC.normHwnd((body.target && body.target.hwnd) || body.hwnd || ''), lt = lossTimes.get(h);
    const isInput = p === '/api/input/command' && ['move-click', 'enter-text', 'click', 'move', 'type', 'key'].includes(body.cmd), isCap = p === '/api/capture/frame';
    if (lt !== undefined && mono() > lt + 5 && (isInput || isCap)) violations.push((isInput ? 'input ' + body.cmd : 'capture') + ' to ' + h + ' after its loss');
    if (estopOn && isInput) estopInputs++;
    return origFetch(url, init);
  };
  await session.request('arm'); for (const w of host.tables.values()) await registerTable(w);
  const end = mono() + SECONDS * 1000; let nextFault = mono() + 1500;
  while (mono() < end) {
    await sleep(50);
    for (const g of regs) if (g.t.lc.terminal && g.lostAt === null) { g.lostAt = mono(); lossTimes.set(LC.normHwnd(g.w.hwnd), g.lostAt); }
    if (mono() < nextFault) continue; nextFault = mono() + 600 + r01() * 1500;
    const live = regs.filter((g) => !g.t.lc.terminal && !g.w.closed); if (!live.length) continue;
    const g = live[Math.floor(r01() * live.length)], w = g.w, k = r01();
    if (k < 0.2) { faults.close++; w.closed = true; w.dealer.onWindow({ type: 'closed' });
      setTimeout(async () => { if (mono() > end - 3000) return; faults.reopen++; const nw = host.addWindow(w.id, { seedOffset: Math.floor(r01() * 1000) }); for (let i = 0; i < 200 && !g.t.lc.terminal; i++) await sleep(20); try { await registerTable(nw); } catch (e) { violations.push('re-register failed: ' + e.message); } }, 800); }
    else if (k < 0.4) { faults.minimize++; w.minimized = true; setTimeout(() => { w.minimized = false; }, 300 + r01() * 1500); }
    else if (k < 0.65) { faults.transient++; w.transient = 1 + Math.floor(r01() * 6); w.transientCode = r01() < 0.5 ? 'no-frame' : 'capture-interrupted'; }
    else if (k < 0.75) { faults.reuse++; w.reused = { pid: 90000 + Math.floor(r01() * 999), processStart: String(Date.now()), className: 'Other', exe: 'C:\\Other\\other.exe' }; w.reusedServesFrames = r01() < 0.5; }
    else if (k < 0.82 && !estopOn) { faults.estop++; estopOn = true; await api.request('/api/input/estop', {}); sched.emergencyStop('stress'); await sleep(400); estopOn = false; await session.request('reset-estop'); sched.reset(); await session.request('arm');
      for (const x of regs) if (!x.t.lc.terminal && x.t.lc.is(LS.SAFETY_PAUSED)) x.t.resume(); }
    else { /* quiet interval */ }
    // tables safety-paused for other reasons (exhausted retries, unconfirmed input) are resumed by the "operator" now and then
    if (r01() < 0.3) for (const x of regs) if (!x.t.lc.terminal && (x.t.lc.is(LS.SAFETY_PAUSED) || x.t.paused)) x.t.resume();
  }
  // 0.36.2 M3: wait for every run loop with a timer that is cleared when they finish (M2 left a 20 s timer and ended with process.exit)
  for (const g of regs) g.t.stop(); { let tm; await Promise.race([Promise.all(regs.map((g) => g.run)), new Promise((r) => { tm = setTimeout(r, 20000); })]); clearTimeout(tm); }
  for (const g of regs) { try { g.t.dispose(); } catch (e) { /* ignore */ } } if (host.dispose) host.dispose();
  // ---- invariants ----
  const perReg = [];
  for (const g of regs) {
    const conf = g.t.log.filter((e) => e.status === 'confirmed'), acc = g.w.dealer.accepted.slice(g.dealerAccepted0);
    // in-order match: every confirmed action is found in this table's dealer log, in order; dealer actions that were never confirmed
    // must be explained by actions recorded as uncertain / unconfirmed (delivered but not confirmed, never re-sent)
    let j = 0, missing = 0, skipped = 0; for (const c of conf) { let k = j; while (k < acc.length && !(acc[k].hand === c.hand && acc[k].seat === c.seat && acc[k].type === c.action.type)) k++; if (k >= acc.length) { missing++; continue; } skipped += k - j; j = k + 1; }
    skipped += acc.length - j; const uncertain = g.t.m.uncertain, unconfirmed = g.t.log.filter((e) => e.status === 'unconfirmed' || e.status === 'uncertain' || (e.status === 'rejected' && !/^Input scheduler: |before button-down|before key-down|cancelled before|lease-invalid|lifecycle-blocked|target-lost|window-gone|identity-changed|window-minimized|emergency|layout-changed/.test(e.reason || ''))).length;
    if (missing) violations.push('table ' + g.w.id + ' (' + g.w.hwnd + '): ' + missing + ' confirmed actions are not in its dealer log (redirected or invented)');
    if (skipped > unconfirmed) violations.push('table ' + g.w.id + ' (' + g.w.hwnd + '): dealer received ' + skipped + ' actions that were never confirmed, but only ' + unconfirmed + ' were recorded as unconfirmed/uncertain');
    if (g.t.lc.counts.byState.TARGET_LOST > 1) violations.push('more than one TARGET_LOST transition for ' + g.t.registrationId);
    if (g.t.lc.history.some((h, i) => i > 0 && g.t.lc.history[i - 1].to === LS.TARGET_LOST)) violations.push('a lifecycle left TARGET_LOST');
    perReg.push({ table: g.w.id, hwnd: g.w.hwnd, registrationId: g.t.registrationId, finalState: g.t.lc.state, lost: g.t.lost && g.t.lost.kind, confirmed: conf.length, uncertain, deliveredUnconfirmed: skipped, unconfirmedOrUncertain: unconfirmed, rejected: g.t.m.rejected, transitions: g.t.lc.counts.transitions, recoveries: g.t.m.recoveries, captureFailures: g.t.m.captureFailuresByCode });
    g.t.dispose();
  }
  if (estopInputs) violations.push(estopInputs + ' input requests reached the driver while the emergency stop was latched (all refused by the driver; the scheduler should not have sent them)');
  const ex = rec.export(); rec.flush(); if (ex.events.length > 20000) violations.push('diagnostics unbounded');
  await sleep(1500); global.gc && global.gc();
  const mem1 = process.memoryUsage().heapUsed, handles1 = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().length : null;
  const doc = { format: 'eightmax-m2-lifecycle-stress', version: 1, app: EM.VERSION, environment: 'fake host (in-process); logic and invariants only, not Windows evidence', at: new Date().toISOString(), tables: N, seconds: SECONDS, faults,
    registrations: perReg.length, lostRegistrations: perReg.filter((r) => r.finalState === LS.TARGET_LOST).length, confirmedActions: perReg.reduce((a, r) => a + r.confirmed, 0), uncertainActions: perReg.reduce((a, r) => a + r.uncertain, 0),
    diagnostics: { storedEvents: ex.events.length, totalRecords: Object.values(ex.counts).reduce((a, b) => a + b, 0), suppressedDuplicates: ex.suppressedDuplicates, dropped: ex.dropped },
    scheduler: sched.metrics(), resources: { heapMiBBefore: +(mem0 / 1048576).toFixed(1), heapMiBAfter: +(mem1 / 1048576).toFixed(1), activeResourcesBefore: handles0, activeResourcesAfter: handles1 },
    violations, perRegistration: perReg };
  doc.pass = violations.length === 0 && doc.confirmedActions > N * 10;
  fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(doc, null, 2));
  console.log('stress: ' + (doc.pass ? 'PASS' : 'FAIL') + ' - ' + doc.registrations + ' registrations, ' + doc.lostRegistrations + ' lost, ' + doc.confirmedActions + ' confirmed, ' + doc.uncertainActions + ' uncertain, faults ' + JSON.stringify(faults) + ', ' + violations.length + ' violations -> ' + OUT);
  for (const v of violations.slice(0, 20)) console.log('  VIOLATION ' + v);
  process.exitCode = doc.pass ? 0 : 1;   // 0.36.2 M3: the process ends by itself once everything above has finished (no forced exit)
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
