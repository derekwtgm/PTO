'use strict';
// 0.36.2 Milestone 2: SIMULATOR WINDOW LIFECYCLE regression tests A-J (plus state-machine unit tests).
// Runs the real SimulatorTable / InputScheduler / UiAutomationAdapter / WindowsUiDriver / DiagnosticsRecorder code against an
// IN-PROCESS fake desktop host whose capture and driver replies follow the REAL host and driver on Windows:
//   closed window      capture: target-lost (CaptureService.CheckWindow, IsWindow=false); window-info / input: window-gone (Driver.Identity)
//   minimised window   capture: target-minimized; window-info: minimized:true; input: window-minimized (Driver.Check)
//   handle reuse       capture: target-identity-changed (pid differs); window-info: other pid / process start; input: identity-changed
//   transient failure  capture: no-frame / capture-interrupted while the window exists
//   cancel-all         a running move-click ends "cancelled: Input was cancelled before button-down."
// The same scenarios run against real windows on Windows in tools/lifecycle-acceptance-0362m2.cjs (RUN-0362-MILESTONE2-TESTS.cmd).
const test = require('node:test'), assert = require('node:assert/strict');
const SC = require('../src/simulator-controls.js'), SP = require('../src/simulator-profiles.js'), SCH = require('../src/input-scheduler.js'), FD = require('../src/fixture-dealer.js'), XA = require('../src/execution-adapters.js'), G = require('../src/input-geometry.js');
const LC = require('../src/window-lifecycle.js'), LS = LC.STATES;
const { lifecycleHost, TOKEN, SHA } = require('./lifecycle-host-fixture.cjs'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(host, o = {}) {
  const api = new SC.HostApi({ token: TOKEN, fetch: host.fetch }), session = SC.hostSession(api), sched = new SCH.InputScheduler({ maxQueue: 8, onCancel: () => session.request('cancel-all') });
  const auth = SC.authorizations({ environment: 'lifecycle-test', approvedBy: 'unit test', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA }), profile = SP.fixtureProfile({ exeSha256: SHA });
  const rec = new XA.DiagnosticsRecorder({ max: 5000 });
  const make = (t, extra = {}) => new SC.SimulatorTable({ id: t.id, window: { hwnd: t.hwnd, pid: t.pid, title: 'EightMax Test Table ' + String(t.id).padStart(2, '0'), client: t.client },
    identity: LC.identityOf({ hwnd: t.hwnd, pid: t.pid, processStart: t.processStart, className: t.className, exe: t.exe, client: t.client, dpiScale: 1 }, { exeSha256: SHA }),
    profile, api, session, scheduler: sched, qaAuthorization: auth.qa, recorder: rec, allowScripted: true, seed: 3, timing: { postClickSettleMs: 0 },
    options: { decisionWindowMs: 10000, pollMs: 5, idlePollMs: 5, postActionTimeoutMs: o.ackMs || 800, stopOnPause: false, retryBaseMs: 40, retryMaxMs: 320, identityCheckMs: o.identityCheckMs || 5000, ...(o.options || {}) }, ...extra });
  const tables = [...host.tables.values()].map((t) => make(t));
  return { api, session, sched, tables, rec, auth, profile, make };
}
const capturesSince = (host, hwnd, t0) => host.log.filter((e) => e.kind === 'capture' && e.hwnd === hwnd && e.at >= t0).length;
const inputsSince = (host, hwnd, t0) => host.log.filter((e) => e.kind === 'input' && e.hwnd === hwnd && e.at >= t0).length;
/** 0.36.2 M3: p or `fallback` after ms; the timer is cleared as soon as p settles. */
async function settled(p, ms, fallback) { let tm; try { return await Promise.race([p, new Promise((r) => { tm = setTimeout(() => r(fallback), ms); })]); } finally { clearTimeout(tm); } }
async function until(pred, ms, step = 10) { const end = performance.now() + ms; while (performance.now() < end) { if (pred()) return true; await sleep(step); } return pred(); }

/* ---------------- state machine units ---------------- */
test('M2 unit: lifecycle transitions are explicit; TARGET_LOST is absorbing; operator-only exits; stale generations are ignored', () => {
  const lc = new LC.WindowLifecycle({ table: 1, identity: { hwnd: '0x10', pid: 1 } }); assert.equal(lc.state, LS.REGISTERED);
  assert.equal(lc.transition(LS.ACTIVE, { kind: 'first-reading' }).ok, true); const tok = lc.token(); assert.equal(lc.valid(tok), true);
  assert.equal(lc.transition(LS.TEMPORARILY_UNAVAILABLE, { kind: 'capture-timeout' }).ok, true); assert.equal(lc.valid(tok), false, 'a token from an earlier generation is invalid');
  assert.equal(lc.transition(LS.ACTIVE, {}).refused, 'illegal', 'TEMPORARILY_UNAVAILABLE never goes straight to ACTIVE');
  assert.equal(lc.transition(LS.RECOVERY_PENDING, {}).ok, true); const g = lc.generation;
  assert.equal(lc.transition(LS.SAFETY_PAUSED, { kind: 'emergency-stop' }).ok, true);
  assert.equal(lc.transition(LS.ACTIVE, {}, { ifGeneration: g }).refused, 'stale-generation', 'a late callback cannot revive the table');
  assert.equal(lc.transition(LS.RECOVERY_PENDING, { kind: 'auto' }).refused, 'operator-required');
  assert.equal(lc.transition(LS.RECOVERY_PENDING, { kind: 'operator-resume', operator: true }).ok, true);
  assert.equal(lc.transition(LS.TARGET_LOST, { kind: 'window-closed' }).ok, true);
  for (const s of Object.values(LS)) if (s !== LS.TARGET_LOST) assert.equal(lc.transition(s, { operator: true }).refused, 'terminal');
  assert.deepEqual(LC.TRANSITIONS.TARGET_LOST, []); assert.equal(lc.snapshot().reRegistrationRequired, true);
  assert.match(lc.message()[1], /no longer available.*register its window again/);
});
test('M2 unit: capture failures are classified; strategy-unavailable is never a capture failure', () => {
  assert.equal(LC.classifyCaptureFailure('target-lost').category, 'terminal-candidate'); assert.equal(LC.classifyCaptureFailure('target-identity-changed').kind, 'identity-changed');
  for (const [c, k] of [['target-minimized', 'minimized'], ['no-frame', 'capture-timeout'], ['capture-interrupted', 'capture-service-interrupted'], ['decode-failed', 'unreadable-image'], ['size-mismatch', 'invalid-image-dimensions'], ['invalid-frame', 'unreadable-image'], ['target-occluded', 'occluded']]) { const x = LC.classifyCaptureFailure(c); assert.equal(x.category, 'transient', c); assert.equal(x.kind, k, c); }
  assert.equal(LC.classifyCaptureFailure('backend-unavailable').category, 'configuration');
  assert.equal(LC.failureFamily('decision', null, 'No compatible EightMax preflop study is loaded'), 'strategy-unavailable');
  assert.equal(LC.failureFamily('capture', 'target-lost', ''), 'target-lost'); assert.equal(LC.failureFamily('capture', 'no-frame', ''), 'capture-failure');
  assert.equal(LC.failureFamily('execution', 'emergency-stop', ''), 'emergency-stop'); assert.equal(LC.failureFamily('execution', 'manual-override', ''), 'manual-override'); assert.equal(LC.failureFamily('execution', 'cancelled-before-input', ''), 'input-cancellation');
});
test('M2 unit: bounded backoff and identity comparison (handle alone is not identity; title is not identity)', () => {
  let now = 0; const r = new LC.RetryPolicy({ baseMs: 250, maxMs: 4000, maxAttempts: 8, maxUnavailableMs: 60000, clock: () => now });
  const d = []; for (let i = 0; i < 8; i++) { const x = r.next(); d.push(x.delayMs); now += x.delayMs; if (i < 7) assert.equal(x.exhausted, false); else assert.equal(x.exhausted, true); }
  assert.deepEqual(d, [250, 500, 1000, 2000, 4000, 4000, 4000, 4000]);
  const reg = LC.identityOf({ hwnd: '0x00001A2B', pid: 77, processStart: '133', className: 'C', exe: 'C:\\Sim.exe' });
  assert.equal(LC.compareIdentity(reg, { hwnd: '0x1a2b', pid: 77, processStart: '133', className: 'C', exe: 'c:\\sim.exe', title: 'new title' }).ok, true);
  assert.equal(LC.compareIdentity(reg, { hwnd: '0x1a2b', pid: 77, processStart: '999', className: 'C' }).ok, false, 'same handle + same pid but another process instance');
  assert.equal(LC.compareIdentity(reg, { hwnd: '0x1a2b', pid: 78, processStart: '133', className: 'C' }).ok, false);
});
test('M2 unit: identityOf keeps every identity field the driver reports (handle text verbatim)', () => {
  const id = LC.identityOf({ hwnd: '0x00A0B0', pid: 77, processStart: '133', className: 'C', exe: 'C:\\Sim\\Sim.exe', title: 'T', client: { x: 1, y: 2, w: 960, h: 600 }, dpiScale: 1.25 }, { exeSha256: 'AB'.repeat(32) });
  assert.deepEqual(id, { hwnd: '0x00A0B0', pid: 77, processStart: '133', className: 'C', exe: 'C:\\Sim\\Sim.exe', exeSha256: 'ab'.repeat(32), title: 'T', client: { x: 1, y: 2, w: 960, h: 600 }, dpiScale: 1.25 });
  assert.equal(LC.compareIdentity(id, { hwnd: '0xa0b0', pid: 77, processStart: '133', className: 'C', exe: 'c:\\sim\\sim.exe' }).ok, true);
});
test('M2 unit: repeated identical failures are coalesced; totals stay exact (801 target-lost events -> bounded)', () => {
  const r = new XA.DiagnosticsRecorder({ max: 5000 });
  for (let i = 0; i < 801; i++) r.record(1, 'capture', { ok: false, code: 'target-lost', reason: 'The window no longer exists.' });
  r.record(1, 'decision', { ok: false, category: 'strategy-unavailable', reason: 'No compatible EightMax preflop study is loaded' });
  r.record(1, 'decision', { ok: false, category: 'strategy-unavailable', reason: 'No compatible EightMax preflop study is loaded' });
  const open = r.export(); assert.equal(open.events.length, 2); assert.equal(open.openRepeats.length, 2); assert.equal(open.counts.capture, 801);
  r.flush(); const e = r.export();
  assert.ok(e.events.length <= 4, 'bounded: ' + e.events.length); assert.equal(e.counts.capture, 801); assert.equal(e.failureTotals[1]['capture:target-lost'], 801);
  assert.equal(e.failureTotals[1]['decision:strategy-unavailable'], 2, 'strategy-unavailable is its own family'); assert.equal(e.suppressedDuplicates, 801 - 1 + 1);
  const sum = e.events.find((x) => x.kind === 'repeat-summary' && x.stage === 'capture'); assert.equal(sum.repeated, 800);
  const legacy = new XA.DiagnosticsRecorder({ coalesce: false }); for (let i = 0; i < 5; i++) legacy.record(1, 'capture', { ok: false, code: 'x' }); assert.equal(legacy.export().events.length, 5, '0.35 behaviour on request');
});

/* ---------------- A: window closes during capture ---------------- */
test('M2 Test A: window closes during capture -> TARGET_LOST, capture stops, no retries, no input after the loss', async () => {
  let closeNext = false; const host = lifecycleHost(1, { onCapture: async (t) => { if (closeNext && t) { t.closed = true; t.dealer.onWindow({ type: 'closed' }); closeNext = false; } } }), b = rig(host); const [t] = b.tables, w = host.byId(1);
  const run = t.run(Infinity); await until(() => t.m.confirmed >= 3, 8000); closeNext = true;
  await until(() => t.lc.state === LS.TARGET_LOST, 3000); const t0 = performance.now(); const finished = await settled(run.then(() => true), 2000, false);
  assert.equal(t.lc.state, LS.TARGET_LOST); assert.equal(finished, true, 'run() returns: the loop does not continue against a nonexistent window');
  await sleep(1500); assert.equal(capturesSince(host, w.hwnd, t0), 0, 'no capture request after the loss'); assert.equal(inputsSince(host, w.hwnd, t0), 0, 'no input after the loss');
  assert.ok((host.stats.captureByHwnd[w.hwnd] || 0) - t.m.frames <= 200, 'bounded'); assert.ok(host.stats.unregister.includes(w.hwnd), 'driver authorisation revoked'); assert.ok(host.stats.captureClose.includes(w.hwnd), 'capture session closed');
  assert.equal((await t.capture.grab()).local, true, 'a later grab is refused locally, never sent to the host');
  assert.equal(t.lc.counts.byState.TARGET_LOST, 1); assert.equal(t.report().failureFamilies.targetLost, 1); assert.match(t.lc.snapshot().message, /Reopen the simulator and register its window again/);
  assert.equal((await t.step()).kind, 'lost');
});

/* ---------------- B: window closes during mouse movement ---------------- */
test('M2 Test B: window closes during mouse movement -> refused before the click, no other window touched, nothing replayed', async () => {
  let armed = false; const host = lifecycleHost(2, { duringMove: async (t) => { if (armed && t.id === 1) { armed = false; t.closed = true; t.dealer.onWindow({ type: 'closed' }); } } }), b = rig(host); const [t1, t2] = b.tables, w1 = host.byId(1), w2 = host.byId(2);
  await runUntil2(t1, () => t1.m.confirmed >= 2, 8000); armed = true; await runUntil2(t1, () => t1.lc.terminal, 6000);
  assert.equal(t1.lc.state, LS.TARGET_LOST); const last = t1.log[t1.log.length - 1];
  assert.equal(last.status, 'rejected'); assert.match(last.reason, /window-gone|closed/); const clicksOn1 = w1.dealer.counts.mouseDown;
  const before2 = host.stats.inputByHwnd[w2.hwnd] || 0; assert.equal(before2, 0, 'nothing was redirected to table 2');
  await runUntil2(t2, () => t2.m.confirmed >= 3, 8000); assert.ok(t2.m.confirmed >= 3, 'the healthy table keeps playing');
  assert.equal(w1.dealer.counts.mouseDown, clicksOn1, 'no replay against the lost window'); assert.equal(host.stats.violations.length, 0);
  const moveClicksAfter = host.log.filter((e) => e.kind === 'input' && e.hwnd === w1.hwnd).length; await sleep(300); assert.equal(host.log.filter((e) => e.kind === 'input' && e.hwnd === w1.hwnd).length, moveClicksAfter);
  // conf: table 2's confirmed actions match what table 2's dealer received (no action meant for 1 landed on 2)
  const acc = w2.dealer.accepted, conf = t2.log.filter((e) => e.status === 'confirmed'); for (let i = 0; i < conf.length; i++) { assert.equal(acc[i].hand, conf[i].hand); assert.equal(acc[i].type, conf[i].action.type); }
});
async function runUntil2(t, pred, ms) { const end = performance.now() + ms; while (!t.stopped && performance.now() < end && !pred()) { const r = await t.step(); if (r.kind === 'lost' || r.kind === 'paused') break; if (r.kind !== 'acted') await sleep(5); } }
test('M2 Test B2: window closes right AFTER the click -> the action is UNCERTAIN (review), never re-sent', async () => {
  let armed = false; const host = lifecycleHost(1, { afterClick: async (t) => { if (armed) { armed = false; t.closed = true; t.dealer.onWindow({ type: 'closed' }); } } }), b = rig(host); const [t] = b.tables, w = host.byId(1);
  await runUntil2(t, () => t.m.confirmed >= 2, 8000); armed = true; await runUntil2(t, () => t.lc.terminal, 6000);
  assert.equal(t.lc.state, LS.TARGET_LOST); const last = t.log[t.log.length - 1];
  assert.equal(last.status, 'uncertain'); assert.equal(last.reviewRequired, true); assert.match(last.reason, /lost after the input was sent|not repeated/);
  assert.equal(t.m.uncertain, 1); const n = w.dealer.counts.mouseDown; await sleep(300); assert.equal((await t.step()).kind, 'lost'); assert.equal(w.dealer.counts.mouseDown, n, 'not repeated');
});
test('M2 Test B3: loss signalled while the click is running -> scheduler cancels it, queued work of that table is dropped, lease revoked', async () => {
  let gate; const host = lifecycleHost(2, { moveMs: 60, duringMove: async (t) => { if (t.id === 1 && gate) { const g = gate; gate = null; g(); } } }), b = rig(host); const [t1] = b.tables, w1 = host.byId(1);
  await runUntil2(t1, () => t1.m.confirmed >= 1, 8000);
  const moving = new Promise((r) => { gate = r; }); const stepP = t1.step(); await moving;
  // while table 1's click is moving: another table's job is queued for the cursor, then table 1 is declared lost
  const queued = b.sched.submit({ table: 1, registrationId: t1.registrationId, kind: 'call', deadline: performance.now() + 5000, run: async () => { throw new Error('must never run'); } });
  const lost = t1.targetLost({ kind: 'window-closed', reason: 'test: lost while moving' }); assert.equal(lost.kind, 'lost');
  const r = await stepP, q = await queued;
  assert.equal(q.ok, false); assert.match(q.code, /target-lost|table-busy/); assert.ok(host.stats.cancelAll >= 1, 'driver cancel requested'); assert.equal(t1.cancellation.cancelledRunning, true);
  assert.equal(r.kind, 'lost'); const last = t1.log[t1.log.length - 1]; assert.equal(last.status, 'rejected'); assert.match(last.reason, /cancelled before button-down|cancel/i);
  const late = await b.sched.submit({ table: 1, registrationId: t1.registrationId, kind: 'fold', deadline: performance.now() + 5000, run: async () => 'ran' }); assert.equal(late.code, 'target-lost', 'later jobs of the lost registration are refused');
  const other = await b.sched.submit({ table: 1, registrationId: 'reg-replacement', kind: 'fold', deadline: performance.now() + 5000, run: async () => 'ran' }); assert.equal(other.ok, true, 'a NEW registration is not blocked by the old one');
  assert.equal(inputsSince(host, w1.hwnd, performance.now()), 0);
});

/* ---------------- C: restart with a different handle ---------------- */
test('M2 Test C: simulator restarts with a different handle -> old registration invalid, replacement only a candidate, no automatic input', async () => {
  const host = lifecycleHost(1), b = rig(host); const [t] = b.tables, w = host.byId(1);
  await runUntil2(t, () => t.m.confirmed >= 2, 8000); w.closed = true; w.dealer.onWindow({ type: 'closed' });
  await runUntil2(t, () => t.lc.terminal, 4000); assert.equal(t.lc.state, LS.TARGET_LOST);
  const nw = host.addWindow(1, { seedOffset: 50 }); const t0 = performance.now();
  const windows = (await b.session.call('list-windows')).windows, cands = LC.replacementCandidates(t.identity, windows, { registrationId: t.registrationId });
  assert.equal(cands.length, 1); assert.equal(cands[0].hwnd, nw.hwnd); assert.notEqual(cands[0].hwnd.toLowerCase(), w.hwnd.toLowerCase()); assert.equal(cands[0].calibrationRecheckRequired, false);
  const id = await b.session.call('exe-identity', { hwnd: nw.hwnd }); assert.equal(id.exeSha256, SHA, 'same program verified by SHA-256');
  // the old table object cannot be pointed at anything and never touches the new window
  for (let i = 0; i < 5; i++) assert.equal((await t.step()).kind, 'lost');
  await sleep(500); assert.equal(capturesSince(host, nw.hwnd, t0), 0, 'the candidate is not captured before confirmation'); assert.equal(inputsSince(host, nw.hwnd, t0), 0, 'no automatic input to the candidate');
  // reusing the lost lifecycle (inheriting the old authorisation) is impossible
  const inherit = b.make(nw, { lifecycle: t.lc }); assert.equal((await inherit.step()).kind, 'lost'); assert.equal(capturesSince(host, nw.hwnd, t0), 0);
  // explicit confirmation = a fresh registration: new authorisation, new lifecycle, REGISTERED until verified, then it plays
  const reg = await b.session.call('register-target', { hwnd: nw.hwnd, authorization: b.auth.simulator }); assert.equal(reg.ok, true);
  const t2 = b.make(nw, { lifecycle: new LC.WindowLifecycle({ table: 1, identity: LC.identityOf(reg.window, { exeSha256: SHA }), replaces: t.registrationId }) });
  assert.equal(t2.lc.state, LS.REGISTERED); assert.notEqual(t2.registrationId, t.registrationId);
  await runUntil2(t2, () => t2.m.confirmed >= 2, 8000); assert.equal(t2.lc.state, LS.ACTIVE); assert.ok(t2.m.confirmed >= 2);
});

/* ---------------- D: temporary capture failure ---------------- */
test('M2 Test D: temporary capture failures -> classified, bounded backoff, no stale action, recovery after fresh verified readings', async () => {
  const host = lifecycleHost(1), b = rig(host); const [t] = b.tables, w = host.byId(1);
  await runUntil2(t, () => t.m.confirmed >= 2, 8000); const genBefore = t.lc.generation, confirmedBefore = t.m.confirmed;
  w.transient = 5; w.transientCode = 'no-frame'; const t0 = performance.now(), n0 = t.log.length;
  await runUntil2(t, () => t.lc.state === LS.ACTIVE && t.lc.generation > genBefore + 1 && t.m.confirmed > confirmedBefore, 10000);
  const caps = host.log.filter((e) => e.kind === 'capture' && e.at >= t0).map((e) => e.at), gaps = caps.slice(1, 6).map((x, i) => x - caps[i]);
  assert.ok(gaps.slice(0, 4).every((g, i) => g >= 40 * Math.pow(2, i) * 0.9 - 5), 'exponential backoff between failed captures: ' + gaps.map(Math.round));
  const hist = t.lc.history.map((h) => h.to); assert.ok(hist.includes(LS.TEMPORARILY_UNAVAILABLE) && hist.includes(LS.RECOVERY_PENDING), hist.join(','));
  const tempEntry = t.lc.history.find((h) => h.to === LS.TEMPORARILY_UNAVAILABLE && h.code === 'no-frame'); assert.ok(tempEntry, 'classified with its code'); assert.equal(t.m.captureFailuresByCode['no-frame'], 5);
  const firstAfter = t.log[n0]; assert.ok(firstAfter.generation > genBefore + 2, 'the first action after the interruption comes from a decision made AFTER recovery');
  assert.equal(inputsSince(host, w.hwnd, t0) > 0, true); assert.equal(t.m.ambiguous + t.m.timedOut, 0); assert.equal(t.m.recoveries, 1); assert.ok(t.m.staleDiscarded >= 1);
  // bounded: a window that never captures again ends SAFETY_PAUSED after the retry budget, then capture stops
  const host2 = lifecycleHost(1), b2 = rig(host2, { options: { maxRetryAttempts: 6 } }); const [u] = b2.tables, w2 = host2.byId(1); w2.transient = 1e9;
  const run = u.run(performance.now() + 15000); await until(() => u.lc.state === LS.SAFETY_PAUSED, 8000); const n = host2.stats.captureByHwnd[w2.hwnd]; await sleep(800);
  assert.equal(u.lc.state, LS.SAFETY_PAUSED); assert.equal(u.lc.cause.kind, 'exhausted'); assert.equal(n, 6); assert.equal(host2.stats.captureByHwnd[w2.hwnd], n, 'no further captures once the budget is spent');
  u.stop(); await run;
});

/* ---------------- E: minimised window ---------------- */
test('M2 Test E: minimised window -> TEMPORARILY_UNAVAILABLE (minimised), no input; restored -> verified again, then play resumes', async () => {
  const host = lifecycleHost(1), b = rig(host); const [t] = b.tables, w = host.byId(1);
  await runUntil2(t, () => t.m.confirmed >= 2, 8000); w.minimized = true; const t0 = performance.now();
  for (let i = 0; i < 6; i++) { await t.step(); await sleep(60); }
  assert.equal(t.lc.state, LS.TEMPORARILY_UNAVAILABLE); assert.equal(t.lc.cause.kind, 'minimized'); assert.equal(inputsSince(host, w.hwnd, t0), 0, 'no input while minimised');
  assert.match(t.lc.snapshot().message, /minimised/); assert.ok(capturesSince(host, w.hwnd, t0) <= 4, 'backoff while minimised');
  w.minimized = false; const c0 = t.m.confirmed; await runUntil2(t, () => t.m.confirmed > c0, 8000);
  assert.equal(t.lc.state, LS.ACTIVE); assert.ok(t.m.confirmed > c0); const h = t.lc.history.map((x) => x.to); assert.ok(h.lastIndexOf(LS.RECOVERY_PENDING) > h.lastIndexOf(LS.TEMPORARILY_UNAVAILABLE));
});

/* ---------------- F: several windows, one closes ---------------- */
test('M2 Test F: three tables, one closes -> only that table stops; the others keep their registrations and play; no redirected input', async () => {
  const host = lifecycleHost(3), b = rig(host); const [t1, t2, t3] = b.tables, w2 = host.byId(2);
  const runs = b.tables.map((t) => t.run(performance.now() + 20000));
  await until(() => b.tables.every((t) => t.m.confirmed >= 2), 10000); w2.closed = true; w2.dealer.onWindow({ type: 'closed' }); const t0 = performance.now();
  await until(() => t2.lc.terminal, 5000); const c1 = t1.m.confirmed, c3 = t3.m.confirmed;
  await until(() => t1.m.confirmed >= c1 + 3 && t3.m.confirmed >= c3 + 3, 10000);
  assert.equal(t2.lc.state, LS.TARGET_LOST); assert.equal(t1.lc.state, LS.ACTIVE); assert.equal(t3.lc.state, LS.ACTIVE);
  assert.ok(t1.m.confirmed >= c1 + 3 && t3.m.confirmed >= c3 + 3, 'healthy tables continue'); assert.equal(inputsSince(host, w2.hwnd, t0 + 50), 0, 'nothing to the lost window');
  assert.equal(b.sched.status().unavailableTables.join(), '2'); assert.equal(host.stats.violations.length, 0);
  for (const [t, w] of [[t1, host.byId(1)], [t3, host.byId(3)]]) { const acc = w.dealer.accepted, conf = t.log.filter((e) => e.status === 'confirmed'); assert.equal(acc.length >= conf.length, true); for (let i = 0; i < conf.length; i++) { assert.equal(acc[i].hand, conf[i].hand); assert.equal(acc[i].seat, conf[i].seat); } }
  for (const t of b.tables) t.stop(); await Promise.all(runs);
});

/* ---------------- G: emergency stop during recovery ---------------- */
test('M2 Test G: emergency stop while a target is unavailable or being re-registered -> stop wins, nothing re-enables input', async () => {
  let estop = null; const host = lifecycleHost(1, { estop: () => estop }), b = rig(host); const [t] = b.tables, w = host.byId(1);
  await runUntil2(t, () => t.m.confirmed >= 2, 8000); w.minimized = true; for (let i = 0; i < 3; i++) { await t.step(); await sleep(60); } assert.equal(t.lc.state, LS.TEMPORARILY_UNAVAILABLE);
  // a capture is in flight when the stop arrives; its (successful) result must not move the table anywhere
  w.minimized = false; t.nextAttemptAt = 0; w.captureDelayMs = 80; const inflight = t.look(); await sleep(20);
  estop = 'dashboard'; b.sched.emergencyStop('dashboard'); t.safetyPause('emergency-stop', 'emergency stop (dashboard)'); t.stop(); const t0 = performance.now();
  await inflight; assert.equal(t.lc.state, LS.SAFETY_PAUSED, 'a late capture result cannot revive the table'); assert.equal(t.lc.cause.kind, 'emergency-stop');
  assert.equal(t.lc.transition(LS.RECOVERY_PENDING, { kind: 'auto-recovery' }).refused, 'operator-required');
  for (let i = 0; i < 4; i++) assert.notEqual((await t.step()).kind, 'acted'); await sleep(200); assert.equal(inputsSince(host, w.hwnd, t0), 0);
  // the scheduler refuses everything until an explicit reset
  const j = await b.sched.submit({ table: 1, registrationId: t.registrationId, kind: 'fold', deadline: performance.now() + 5000, run: async () => 'ran' }); assert.equal(j.code, 'emergency-stop');
  // re-registration during the stop: a replacement lifecycle starts REGISTERED and cannot act while the scheduler is stopped
  const fresh = b.make(w, { lifecycle: new LC.WindowLifecycle({ table: 1, identity: t.identity }) }); for (let i = 0; i < 12; i++) await fresh.step();
  assert.equal(inputsSince(host, w.hwnd, t0), 0, 'no input while the emergency stop is latched'); assert.ok(fresh.log.every((e) => e.status !== 'confirmed'));
  assert.ok(fresh.log.length === 0 || fresh.log.every((e) => /emergency/i.test(e.reason || '') || e.status === 'blocked'));
  // explicit reset + explicit operator action needed: resume() of the stopped table only re-verifies, run() was ended by stop()
  b.sched.reset(); estop = null; assert.equal(t.resume(), true); assert.equal(t.lc.state, LS.RECOVERY_PENDING); assert.equal(t.stopped, true, 'still stopped: a new explicit start is required');
});

/* ---------------- H: repeated target-loss signals ---------------- */
test('M2 Test H: repeated target-loss signals -> one transition per loss, bounded diagnostics, exact counts, no leaked retries', async () => {
  const host = lifecycleHost(1), b = rig(host); const [t] = b.tables, w = host.byId(1);
  await runUntil2(t, () => t.m.confirmed >= 1, 8000); w.closed = true; w.dealer.onWindow({ type: 'closed' });
  const results = await Promise.all(Array.from({ length: 200 }, (_, i) => (i % 2 ? t.look() : Promise.resolve(t.targetLost({ kind: 'window-closed', reason: 'signal ' + i })))));
  assert.equal(t.lc.counts.byState.TARGET_LOST, 1, 'exactly one transition'); assert.equal(t.lc.history.filter((h) => h.to === LS.TARGET_LOST).length, 1);
  assert.ok(t.lc.lossSignals >= 100, 'every signal counted: ' + t.lc.lossSignals); assert.ok(results.every((r) => r.kind === 'lost' || /target lost/.test(r.reject || '')));
  const ex = b.rec.export(); assert.equal(ex.events.filter((e) => e.stage === 'lifecycle' && e.kind === 'target-lost').length, 1, 'one lifecycle record');
  assert.ok(ex.events.filter((e) => e.stage === 'capture').length <= 3, 'capture failures coalesced'); assert.ok((host.stats.captureByHwnd[w.hwnd] || 0) <= t.m.frames, 'local refusals never reached the host');
  assert.equal(host.stats.unregister.filter((h) => h === w.hwnd).length, 1, 'cleanup ran once');
  // many loss episodes over successive re-registrations: each lifecycle has exactly one loss; scheduler records stay bounded
  for (let k = 0; k < 30; k++) { const lc = new LC.WindowLifecycle({ table: 1, identity: t.identity }); const x = b.make(w, { lifecycle: lc }); for (let i = 0; i < 5; i++) x.targetLost({ kind: 'window-closed', reason: 'episode ' + k }); assert.equal(lc.counts.byState.TARGET_LOST, 1); assert.equal(lc.lossSignals, 5); x.dispose(); }
  assert.ok(b.sched.cancellations.length <= 200); const runP = t.run(performance.now() + 5000); assert.equal(await settled(runP.then(() => 'done'), 500, 'hung'), 'done', 'run() of a lost table returns immediately');
});

/* ---------------- I: handle reuse / identity mismatch ---------------- */
test('M2 Test I: the old handle is reused by an unrelated process -> registration rejected, no input, no inherited permission', async () => {
  const host = lifecycleHost(1), b = rig(host, { identityCheckMs: 100 }); const [t] = b.tables, w = host.byId(1);
  await runUntil2(t, () => t.m.confirmed >= 2, 8000);
  // same handle number, other process; the impostor even keeps serving frames that look like the table
  w.reused = { pid: 9999, processStart: '77777', className: 'Notepad', exe: 'C:\\Windows\\notepad.exe' }; w.reusedServesFrames = true; const t0 = performance.now();
  await runUntil2(t, () => t.lc.terminal, 4000);
  assert.equal(t.lc.state, LS.TARGET_LOST); assert.equal(t.lc.cause.kind, 'identity-changed'); assert.match(t.lc.message()[1], /no longer matches the registered simulator/);
  assert.equal(host.log.filter((e) => e.kind === 'input' && e.cmd === 'move-click' && e.hwnd === w.hwnd && e.at >= t0).length, 0, 'no click into the impostor');
  // registering the reused handle with the old authorisation is refused by the driver's SHA-256 check
  const r = await b.session.request('register-target', { hwnd: w.hwnd, authorization: b.auth.simulator }); assert.equal(r.ok, false); assert.equal(r.code, 'authorization-refused');
  // and a replacement scan never offers it (different executable)
  const cands = LC.replacementCandidates(t.identity, (await b.session.call('list-windows')).windows); assert.equal(cands.length, 0);
  // the driver-side identity check in WindowsUiDriver refuses even if a stale table tried to click
  const d = new (require('../src/windows-input-driver.js').WindowsUiDriver)({ session: b.session, hwnd: w.hwnd, identity: () => t.identity });
  const x = await d.activate('fold', FD.CONTROLS.fold, {}); assert.equal(x.ok, false); assert.equal(x.code, 'identity-changed');
});

test('M2 Test I2: same handle AND same process id but another process instance (start time differs) -> TARGET_LOST, no input', async () => {
  const host = lifecycleHost(1), b = rig(host, { identityCheckMs: 100 }); const [t] = b.tables, w = host.byId(1);
  await runUntil2(t, () => t.m.confirmed >= 2, 8000); assert.equal(t.identity.processStart, w.processStart, 'the registered identity carries the process start time');
  w.processStart = String(Number(w.processStart) + 1); const t0 = performance.now();   // pid reused by a new process that also got the same handle
  await runUntil2(t, () => t.lc.terminal, 4000);
  assert.equal(t.lc.state, LS.TARGET_LOST); assert.equal(t.lc.cause.kind, 'identity-changed'); assert.match(t.lc.cause.reason, /process start time differs/);
  assert.equal(host.log.filter((e) => e.kind === 'input' && e.hwnd === w.hwnd && e.at >= t0 + 1).length, 0, 'no input to the other process instance');
});

/* ---------------- J: scripted gameplay preserved ---------------- */
test('M2 Test J: scripted practice on the controlled simulator still plays hand after hand with confirmed actions', async () => {
  const host = lifecycleHost(1), b = rig(host); const [t] = b.tables, w = host.byId(1);
  await runUntil2(t, () => t.m.confirmed >= 30 && w.dealer.hands >= 4, 30000);
  assert.ok(t.m.confirmed >= 30, 'confirmed ' + t.m.confirmed); assert.ok(w.dealer.hands >= 4, 'hands ' + w.dealer.hands); assert.equal(t.m.ambiguous + t.m.timedOut + t.m.uncertain, 0);
  assert.equal(t.lc.state, LS.ACTIVE); assert.equal(t.lc.counts.transitions, 1, 'REGISTERED -> ACTIVE once, nothing else'); assert.equal(host.stats.violations.length, 0);
  const acc = w.dealer.accepted, conf = t.log.filter((e) => e.status === 'confirmed'); for (let i = 0; i < conf.length; i++) { assert.equal(acc[i].seat, conf[i].seat); assert.equal(acc[i].hand, conf[i].hand); assert.equal(acc[i].type, conf[i].action.type); if (acc[i].type === 'raise') assert.equal(acc[i].amount, conf[i].action.amount); }
  assert.equal(w.dealer.counts.staleClicks, 0); assert.equal(t.report().failureFamilies.captureFailures, 0);
});
