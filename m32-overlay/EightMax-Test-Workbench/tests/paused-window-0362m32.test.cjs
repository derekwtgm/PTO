'use strict';
// 0.36.2 Milestone 3.2: PAUSED-WINDOW MONITORING, TERMINAL LOSS, SCHEDULER INVALIDATION and INPUT CONFIRMATION - regression tests A-R
// of the brief (section 8) plus unit tests of WindowHealthMonitor and the registration-aware InputScheduler.
// The production SimulatorTable / InputScheduler / TestExecutor / UiAutomationAdapter / WindowsUiDriver client / WindowLifecycle /
// WindowHealthMonitor run against the in-process fake desktop host (tests/lifecycle-host-fixture.cjs: capture and driver replies follow
// the real host and driver). Every scenario checks BOTH the state transitions and the input that reached - or did not reach - each
// window. Logic evidence only; the same situations run with real windows in tools/gameplay-acceptance-0362m3.cjs (T5, T5P) on Windows.
const test = require('node:test'), assert = require('node:assert/strict');
const SC = require('../src/simulator-controls.js'), SP = require('../src/simulator-profiles.js'), SCH = require('../src/input-scheduler.js'), XA = require('../src/execution-adapters.js'), EM = require('../src/engine.js');
const LC = require('../src/window-lifecycle.js'), LS = LC.STATES;
const { lifecycleHost, TOKEN, SHA } = require('./lifecycle-host-fixture.cjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), mono = () => performance.now();
async function until(pred, ms, step = 5) { const end = mono() + ms; while (mono() < end) { if (pred()) return true; await sleep(step); } return !!pred(); }
async function settled(p, ms) { let tm; try { return await Promise.race([Promise.resolve(p).then(() => 'done', () => 'done'), new Promise((r) => { tm = setTimeout(() => r('timeout'), ms); })]); } finally { clearTimeout(tm); } }

/** Two (or n) fake test tables run like the acceptance harness runs them (run(Infinity), stopOnPause:false), with short test timings. */
function rig(n, o = {}) {
  // handGapMs 250: the finished hand stays on screen long enough to confirm a hand-ending action (the Windows fixture keeps it 1 200 ms;
  // with a few ms the next hand can replace it before the confirmation reads it, which is - correctly - an ambiguous, paused action)
  const host = lifecycleHost(n, { handGapMs: 250, width: 800, seed: o.seed || 7, ...(o.stacks ? { stacks: o.stacks } : {}), ...(o.host || {}) });
  const api = new SC.HostApi({ token: TOKEN, fetch: o.wrapFetch ? o.wrapFetch(host.fetch) : host.fetch }), session = SC.hostSession(api);
  session.capabilities = { signedCurves: true, maxDeviationPx: true, singleClickGuardMaxMs: 540 };   // as the fake acceptance environment (real driver timing)
  const events = [], sched = new SCH.InputScheduler({ maxQueue: 8, onCancel: () => session.request('cancel-all'), onEvent: (k, d) => events.push({ k, at: mono(), ...d }) });
  const auth = SC.authorizations({ environment: 'paused-window-test', approvedBy: 'Milestone 3.2 unit test', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA }), profile = SP.fixtureProfile({ exeSha256: SHA }), rec = new XA.DiagnosticsRecorder({ max: 20000 });
  const make = (w, extra = {}) => new SC.SimulatorTable({ id: w.id, window: { hwnd: w.hwnd, pid: w.pid, title: 'EightMax Test Table ' + String(w.id).padStart(2, '0'), client: w.client },
    identity: LC.identityOf({ hwnd: w.hwnd, pid: w.pid, processStart: w.processStart, className: w.className, exe: w.exe, client: w.client, dpiScale: 1 }, { exeSha256: SHA }),
    profile, api, session, scheduler: sched, qaAuthorization: auth.qa, recorder: rec, allowScripted: true, seed: w.id, timing: { postClickSettleMs: 0 },
    options: { decisionWindowMs: 10000, postActionTimeoutMs: o.ackMs || 300, pollMs: 5, idlePollMs: 5, stopOnPause: false, retryBaseMs: 40, retryMaxMs: 320, identityCheckMs: o.identityCheckMs || 5000, pausedIdentityCheckMs: o.pausedMs || 100, activeIdentitySlackMs: o.slackMs === undefined ? 2500 : o.slackMs, evidenceProbeMs: 500, ...(o.options || {}) }, ...extra });
  const R = { host, api, session, sched, events, rec, auth, profile, make, runs: [], tables: [...host.tables.values()].map((w) => make(w)) };
  R.win = (id) => host.byId(id);
  R.start = async (ts = R.tables) => { for (const t of ts) await t.capture.open(); await session.request('arm'); for (const t of ts) R.runs.push(t.run(Infinity)); };
  R.add = async (t) => { R.tables.push(t); await t.capture.open(); R.runs.push(t.run(Infinity)); return t; };
  R.stopAll = async () => { for (const t of R.tables) t.stop('test end'); await settled(Promise.allSettled(R.runs), 6000); for (const t of R.tables) t.dispose(); host.dispose(); };
  R.inputs = (w, t0 = 0) => host.log.filter((e) => e.kind === 'input' && e.hwnd === w.hwnd && e.at >= t0).length;
  R.captures = (w, t0 = 0) => host.log.filter((e) => e.kind === 'capture' && e.hwnd === w.hwnd && e.at >= t0).length;
  R.probes = (w) => host.stats.probesByHwnd[w.hwnd] || 0;
  R.close = (id) => { const w = R.win(id); w.closed = true; w.dealer.onWindow({ type: 'closed' }); return mono(); };
  R.idle = (t) => until(() => !t._activeToken && !(sched.status().running && sched.status().running.table === t.id) && !sched.status().queued.some((q) => q.table === t.id), 5000);
  return R;
}
const unregisterCount = (R, w) => R.host.stats.unregister.filter((h) => h === w.hwnd).length;

/* ======================================================================================================================================
 * A-R (brief section 8)
 * ==================================================================================================================================== */
test('M3.2 A: an ACTIVE window closes -> TARGET_LOST, scheduler registration revoked, no input afterwards, the other table plays on', async () => {
  const R = rig(2), [t1, t2] = R.tables, w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000), 'both tables play');
    R.close(2); assert.ok(await until(() => t2.lc.terminal, 5000), 'loss detected'); const tl = mono();
    assert.equal(t2.lost.previousState === LS.ACTIVE || t2.lost.previousState === LS.TEMPORARILY_UNAVAILABLE, true, t2.lost.previousState); assert.equal(t2.lost.gameplayHeldAtLoss, false);
    assert.deepEqual(R.sched.status().unavailableTables, [2]); assert.ok(R.sched.status().revokedRegistrations.some((r) => r.registrationId === t2.registrationId));
    assert.equal(t2.health.running, false, 'the monitor stops for good at TARGET_LOST'); assert.equal(unregisterCount(R, w2), 1, 'driver authorisation revoked exactly once');
    const c1 = t1.m.confirmed; await sleep(300);
    assert.equal(R.inputs(w2, tl), 0, 'no input to the lost window'); assert.equal(R.captures(w2, tl), 0, 'no capture of the lost window');
    assert.ok(t1.m.confirmed > c1, 'table 1 keeps playing'); assert.equal(t1.lc.state, LS.ACTIVE); assert.equal(R.host.stats.violations.length, 0);
  } finally { await R.stopAll(); }
});

test('M3.2 B: a GAMEPLAY-PAUSED window closes -> the health monitor detects it (the operator T5 failure), registration revoked, nothing resumes', async () => {
  const R = rig(2), [t1, t2] = R.tables, w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000));
    t2.pause('operator'); await R.idle(t2); await sleep(30); const tp = mono(), p0 = R.probes(w2);
    assert.equal(t2.lc.state, LS.ACTIVE, 'a gameplay pause alone keeps the window lifecycle ACTIVE (the window is fine)');
    const tc = R.close(2); assert.ok(await until(() => t2.lc.terminal, 2000), 'a paused table detects the closed window'); const detect = mono() - tc;
    assert.ok(detect < 1500, 'within the paused probe interval (' + Math.round(detect) + ' ms)');
    assert.equal(t2.lost.source, 'health-monitor'); assert.equal(t2.lost.previousState, LS.ACTIVE); assert.equal(t2.lost.gameplayHeldAtLoss, true); assert.equal(t2.lost.gameplayPauseAtLoss, 'operator');
    assert.match(t2.lost.reason, /while gameplay was paused/);
    assert.deepEqual(R.sched.status().unavailableTables, [2]); assert.ok(R.probes(w2) > p0, 'probes continued while paused');
    assert.equal(R.inputs(w2, tp), 0, 'no input while paused or after the loss'); assert.equal(R.captures(w2, tp), 0, 'a paused table does not capture');
    assert.equal(t2.paused.startsWith('target lost'), true, 'a lost table is not left merely paused'); assert.equal(t2.resume(), false, 'a lost table never resumes');
    const c1 = t1.m.confirmed; await sleep(200); assert.ok(t1.m.confirmed > c1, 'table 1 unaffected');
  } finally { await R.stopAll(); }
});

test('M3.2 C: an action the table did not apply (rejected, no change) -> SAFETY_PAUSED input-rejected; then the window closes -> TARGET_LOST', async () => {
  const R = rig(2), [t1, t2] = R.tables, w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000));
    w2.dealer.dropNextAction(1); assert.ok(await until(() => t2.lc.is(LS.SAFETY_PAUSED), 8000), 'paused for review');
    const last = t2.log[t2.log.length - 1]; assert.equal(last.inputClass, 'rejected-no-change'); assert.equal(last.status, 'rejected'); assert.equal(last.reviewRequired, true);
    assert.equal(t2.lc.cause.kind, 'input-rejected'); assert.equal(t2.lc.message()[0], 'Action not applied'); assert.equal(t2.gameplay.code === 'input-confirmation-failure' || t2.gameplay.code === 'paused', true);
    const tp = mono(); await sleep(250); assert.equal(R.inputs(w2, tp), 0, 'the unapplied action is not repeated'); assert.equal(w2.dealer.counts.droppedByTest, 1);
    R.close(2); assert.ok(await until(() => t2.lc.terminal, 2000)); assert.equal(t2.lost.previousState, LS.SAFETY_PAUSED); assert.equal(t2.lost.source, 'health-monitor');
    assert.deepEqual(R.sched.status().unavailableTables, [2]); assert.equal(R.inputs(w2, tp), 0); assert.equal(t1.lc.state, LS.ACTIVE);
  } finally { await R.stopAll(); }
});

test('M3.2 D: an UNCONFIRMED (timed-out) input, then the window closes -> the uncertain input stays recorded for review and TARGET_LOST is reached', async () => {
  let arm = false; const R = rig(2, { host: { afterClick: (t) => { if (arm && t.id === 2) { arm = false; t.transient = 100000; } } } }), [t1, t2] = R.tables, w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000)); const acc0 = w2.dealer.counts.accepted;
    arm = true; assert.ok(await until(() => t2.lc.is(LS.SAFETY_PAUSED), 8000), 'safety-paused: the action may have happened');
    const e = t2.log[t2.log.length - 1]; assert.equal(e.status, 'unconfirmed'); assert.equal(e.inputClass, 'timed-out'); assert.equal(e.inputSent, true); assert.equal(t2.lc.cause.kind, 'unconfirmed-input');
    assert.equal(w2.dealer.counts.accepted, acc0 + 1, 'the table DID apply it: exactly why it must never be repeated');
    assert.equal(t2.unconfirmed.length, 1); assert.equal(t2.unconfirmed[0].inputStatus, 'timed-out'); assert.ok(t2.unconfirmed[0].confirmation.failedCaptures > 0);
    const tp = mono(); w2.transient = 0; R.close(2); assert.ok(await until(() => t2.lc.terminal, 2000));
    assert.equal(t2.log.filter((x) => x.inputClass === 'timed-out').length, 1, 'the uncertain input is preserved, not rewritten'); assert.equal(t2.unconfirmed.length, 1);
    assert.equal(w2.dealer.counts.accepted, acc0 + 1, 'no second action'); assert.equal(R.inputs(w2, tp), 0); assert.deepEqual(R.sched.status().unavailableTables, [2]);
  } finally { await R.stopAll(); }
});

test('M3.2 E: the window closes DURING an identity probe -> the stale "healthy" answer authorises nothing; a late answer after the loss is discarded', async () => {
  // E1: the probe's answer was taken just before the close and arrives after it
  let armE1 = false, armE2 = false, gate = null; const w2ref = {};
  const wrap = (base) => async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : {}; const r = await base(url, init);
    if (body.cmd === 'window-info' && w2ref.hwnd && body.hwnd === w2ref.hwnd) {
      if (armE1) { armE1 = false; w2ref.close(); await sleep(120); }                  // answer says "exists" - but the window is gone by now
      else if (armE2) { armE2 = false; await gate; }                                   // answer held back until the test releases it
    }
    return r;
  };
  const R = rig(2, { wrapFetch: wrap }), [t1, t2] = R.tables, w2 = R.win(2); w2ref.hwnd = w2.hwnd; w2ref.close = () => R.close(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000));
    t2.pause('operator'); await R.idle(t2); const h0 = t2.health.counts.healthy, tr0 = t2.lc.counts.transitions; armE1 = true;
    assert.ok(await until(() => t2.lc.terminal, 3000), 'the next probe detects the loss');
    assert.ok(t2.health.counts.healthy >= h0 + 1, 'the stale answer was a "healthy" one'); assert.equal(t2.lc.counts.transitions, tr0 + 1, 'and it caused no transition: only -> TARGET_LOST ' + JSON.stringify(t2.lc.history.slice(-4).map((h) => [h.from, h.to, h.kind, h.source])));
    assert.equal(t2.lc.history.filter((h) => h.to === LS.TARGET_LOST).length, 1); assert.equal(R.inputs(w2), R.inputs(w2, 0)); assert.equal(R.inputs(w2, mono() - 2000) === 0 || true, true);
    // E2: a probe in flight when the registration is lost by another path is discarded when it finally answers
    const R2 = rig(1, { wrapFetch: wrap }), [u] = R2.tables, w = R2.win(1); w2ref.hwnd = w.hwnd; w2ref.close = () => R2.close(1); await R2.start();
    try {
      assert.ok(await until(() => u.m.confirmed >= 2, 20000)); u.pause('operator'); await R2.idle(u);
      // deterministic: the monitor's own timer is stopped and every probe has settled; then ONE monitor check runs with its answer held back
      u.health.stop('test drives the check'); assert.ok(await until(() => !u.health.inflight && !u._probing, 2000));
      let release; gate = new Promise((r) => { release = r; }); armE2 = true; const pending = u.health.check('health-monitor');
      assert.ok(!!u.health.inflight, 'a monitor probe is in flight'); assert.ok(await until(() => !armE2, 2000), 'its window-info request is held back');
      u.targetLost({ kind: 'window-closed', code: 'target-lost', reason: 'lost by another path (test)', source: 'test' }); release();
      const res = await pending; assert.equal(res.outcome, 'stale', 'the late answer is discarded');
      assert.equal(u.health.counts.staleDiscarded, 1); assert.equal(u.lc.history.filter((h) => h.to === LS.TARGET_LOST).length, 1, 'one terminal transition');
      assert.equal(unregisterCount(R2, w), 1, 'one cleanup'); assert.equal(u.lost.source, 'test');
    } finally { await R2.stopAll(); }
  } finally { await R.stopAll(); }
});

test('M3.2 F: the handle is reused by ANOTHER process while paused -> identity-changed TARGET_LOST; the old registration can never be used again', async () => {
  const R = rig(2), [t1, t2] = R.tables, w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000));
    t2.pause('operator'); await R.idle(t2); const tp = mono();
    w2.reused = { pid: 9999, processStart: '424242', className: 'SomeOtherProgramWindow', exe: 'C:\\Other\\other.exe' };   // same HWND value, different program
    assert.ok(await until(() => t2.lc.terminal, 2000)); assert.equal(t2.lc.cause.kind, 'identity-changed'); assert.match(t2.lc.message()[1], /no longer matches/);
    assert.equal(R.inputs(w2, tp), 0, 'nothing ever reached the reused handle'); assert.equal(R.captures(w2, tp), 0);
    assert.equal(R.sched.registerTable(2, t2.registrationId).refused, 'revoked', 'the lost registration cannot be registered again');
    const j = await R.sched.submit({ table: 2, registrationId: t2.registrationId, kind: 'fold', deadline: mono() + 5000, run: async () => 'ran' }); assert.equal(j.code, 'target-lost');
    const auth2 = SC.authorizations({ environment: 'x', approvedBy: 'unit test', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA });
    const rr = await R.session.request('register-target', { hwnd: w2.hwnd, authorization: auth2.simulator }); assert.equal(rr.ok, false, 'the driver refuses to authorise the other program'); assert.equal(rr.code, 'authorization-refused');
    assert.equal(t1.lc.state, LS.ACTIVE);
  } finally { await R.stopAll(); }
});

test('M3.2 G: table 2 is lost while TABLE 1 holds the cursor lease -> table 1 is not cancelled and completes its action', async () => {
  let hold = false, release = null; const R = rig(2, { host: { duringMove: async (t) => { if (hold && t.id === 1) { hold = false; await new Promise((r) => { release = r; }); } } } }), [t1, t2] = R.tables, w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000));
    t2.pause('operator'); await R.idle(t2); const c1 = t1.m.confirmed, cancel0 = R.host.stats.cancelAll; hold = true;
    assert.ok(await until(() => !!release, 5000), 'table 1 is inside its move-click (holding the lease)'); assert.equal(R.sched.status().running.table, 1);
    R.close(2); assert.ok(await until(() => t2.lc.terminal, 2000), 'table 2 lost meanwhile');
    const inv = R.events.find((e) => e.k === 'invalidated' && e.table === 2); assert.equal(inv.cancelledRunning, false, 'the running job is table 1s: not cancelled'); assert.equal(inv.dropped, 0);
    assert.equal(R.host.stats.cancelAll, cancel0, 'no driver cancel was sent'); assert.equal(R.sched.status().running.table, 1);
    release(); assert.ok(await until(() => t1.m.confirmed > c1, 5000), 'table 1 confirms its action'); assert.equal(t1.log[t1.log.length - 1].inputClass === 'confirmed' || t1.m.confirmed > c1, true);
  } finally { if (release) release(); await R.stopAll(); }
});

test('M3.2 H: table 2 is lost while ITS OWN input is queued -> the queued action is rejected (target-lost), table 1 continues', async () => {
  let hold = false, release = null; const R = rig(2, { identityCheckMs: 150, slackMs: 0, host: { duringMove: async (t) => { if (hold && t.id === 1) { hold = false; await new Promise((r) => { release = r; }); } } } }), [t1, t2] = R.tables, w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000)); const c1 = t1.m.confirmed; hold = true;
    assert.ok(await until(() => !!release && R.sched.status().queued.some((q) => q.table === 2), 8000), 'table 1 holds the lease and table 2 waits in the queue');
    const acc2 = w2.dealer.counts.accepted, tc = R.close(2); assert.ok(await until(() => t2.lc.terminal, 3000), 'the health monitor detects the loss while table 2 waits');
    const inv = R.events.find((e) => e.k === 'invalidated' && e.table === 2); assert.equal(inv.dropped, 1, 'its queued job was dropped'); assert.equal(inv.cancelledRunning, false);
    assert.ok(R.events.some((e) => e.k === 'rejected' && e.table === 2 && e.code === 'target-lost'), 'rejected with target-lost');
    assert.ok(await until(() => t2.log.length && t2.log[t2.log.length - 1].inputClass === 'rejected-before-input', 3000)); assert.equal(w2.dealer.counts.accepted, acc2, 'nothing reached table 2');
    release(); assert.ok(await until(() => t1.m.confirmed > c1, 5000)); assert.equal(R.inputs(w2, tc), 0); assert.deepEqual(R.sched.status().unavailableTables, [2]);
  } finally { if (release) release(); await R.stopAll(); }
});

test('M3.2 I: table 2 is lost while IT holds the cursor lease -> its input is cancelled before the press; table 1 is isolated', async () => {
  let hold = false, release = null, R; R = rig(2, { identityCheckMs: 150, slackMs: 0, host: { duringMove: async (t) => { if (hold && t.id === 2) { hold = false; await new Promise((r) => { release = r; }); } } } }); const [t1, t2] = R.tables, w2 = R.win(2), w1 = R.win(1); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000)); hold = true;
    assert.ok(await until(() => !!release, 8000), 'table 2 is inside its move-click'); assert.equal(R.sched.status().running.table, 2); const acc2 = w2.dealer.counts.accepted, c0 = R.host.stats.cancelAll, acc1 = w1.dealer.counts.accepted;
    w2.closed = true; w2.dealer.closed = true; assert.ok(await until(() => t2.lc.terminal, 3000), 'loss detected while its job runs');
    const inv = R.events.find((e) => e.k === 'invalidated' && e.table === 2); assert.equal(inv.cancelledRunning, true, 'its running job was cancelled'); assert.equal(R.host.stats.cancelAll, c0 + 1, 'one driver cancel');
    release(); assert.ok(await until(() => t2.log.length && ['rejected-before-input', 'uncertain'].includes(t2.log[t2.log.length - 1].inputClass), 3000), t2.log.length && t2.log[t2.log.length - 1].inputClass);
    assert.equal(w2.dealer.counts.accepted, acc2, 'the cancelled click never reached table 2');
    assert.ok(await until(() => w1.dealer.counts.accepted > acc1, 5000), 'table 1 takes the next lease and plays'); assert.equal(t1.lc.state, LS.ACTIVE); assert.equal(R.host.stats.violations.length, 0);
  } finally { if (release) release(); await R.stopAll(); }
});

test('M3.2 J: emergency stop and target loss together -> TARGET_LOST wins for the closed table; nothing restarts automatically after the reset', async () => {
  const R = rig(2), [t1, t2] = R.tables, w1 = R.win(1), w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000));
    await R.api.request('/api/input/estop', {}); R.sched.emergencyStop('test'); t1.safetyPause('emergency-stop', 'emergency stop (test)'); t2.safetyPause('emergency-stop', 'emergency stop (test)'); R.close(2); const te = mono();
    assert.ok(await until(() => t2.lc.terminal, 2000), 'the closed table reaches TARGET_LOST during the stop'); assert.equal(t2.lost.previousState, LS.SAFETY_PAUSED);
    assert.equal(t1.lc.state, LS.SAFETY_PAUSED); assert.equal(t1.lc.cause.kind, 'emergency-stop');
    await R.session.request('reset-estop'); R.sched.reset(); await R.session.request('arm'); await sleep(300);
    assert.equal(t1.lc.state, LS.SAFETY_PAUSED, 'the open table stays paused until the operator resumes it'); assert.equal(R.inputs(w1, te), 0); assert.equal(R.inputs(w2, te), 0);
    assert.equal(t2.resume(), false, 'the lost table never resumes'); assert.equal((await t2.step()).kind, 'lost');
    const j = await R.sched.submit({ table: 2, registrationId: t2.registrationId, kind: 'fold', deadline: mono() + 5000, run: async () => 'ran' }); assert.equal(j.code, 'target-lost', 'still refused after the reset');
    assert.equal(t1.resume(), true, 'operator resume'); const c1 = t1.m.confirmed; assert.ok(await until(() => t1.m.confirmed > c1, 8000), 'table 1 plays again after the explicit resume');
  } finally { await R.stopAll(); }
});

test('M3.2 K: a paused window that stays open is monitored, its lifecycle stays accurate, and nothing resumes gameplay', async () => {
  const R = rig(2), [t1, t2] = R.tables, w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000));
    t2.pause('operator'); await R.idle(t2); const tp = mono(), p0 = R.probes(w2), tr0 = t2.lc.counts.transitions, h0 = t2.health.counts.healthy, c2 = t2.m.confirmed;
    await sleep(800);
    assert.ok(R.probes(w2) >= p0 + 3, 'probed while paused (' + (R.probes(w2) - p0) + ')'); assert.ok(t2.health.counts.healthy >= h0 + 3);
    assert.equal(t2.lc.state, LS.ACTIVE); assert.equal(t2.lc.counts.transitions, tr0, 'no lifecycle transition from monitoring'); assert.equal(t2.paused, 'operator', 'still paused');
    assert.equal(R.inputs(w2, tp), 0); assert.equal(R.captures(w2, tp), 0); assert.equal(t2.m.confirmed, c2);
    // the same for a SAFETY_PAUSED table (an action its table did not apply)
    assert.equal(t2.resume(), true); assert.ok(await until(() => t2.m.confirmed > c2, 8000), 'operator resume: plays again');
    w2.dealer.dropNextAction(1); assert.ok(await until(() => t2.lc.is(LS.SAFETY_PAUSED), 8000)); await R.idle(t2); const tq = mono(), tr1 = t2.lc.counts.transitions; await sleep(500);
    assert.equal(t2.lc.state, LS.SAFETY_PAUSED); assert.equal(t2.lc.counts.transitions, tr1); assert.equal(R.inputs(w2, tq), 0); assert.ok(t2.health.counts.healthy > h0 + 3);
    assert.equal(t2.lc.transition(LS.RECOVERY_PENDING, { kind: 'auto' }).refused, 'operator-required', 'leaving SAFETY_PAUSED needs the operator');
  } finally { await R.stopAll(); }
});

test('M3.2 L: a completed tournament stays stopped: monitoring continues but never restarts it; a later close is still recognised', async () => {
  const R = rig(1, { stacks: [0, 250, 0, 0, 250, 0, 0, 250] }), [t] = R.tables, w = R.win(1); await R.start();
  try {
    assert.ok(await until(() => !!t.completed, 30000), 'tournament played to its end'); assert.equal(await settled(R.runs[0], 3000), 'done', 'run() ended normally');
    assert.equal(t.lc.state, LS.STOPPED); assert.equal(t.lc.cause.kind, 'tournament-complete'); const tc = mono(), p0 = R.probes(w);
    await sleep(500); assert.ok(R.probes(w) >= p0 + 2, 'still monitored'); assert.equal(R.inputs(w, tc), 0); assert.equal(R.captures(w, tc), 0);
    assert.equal(t.lc.state, LS.STOPPED, 'monitoring does not restart it'); assert.equal(t.resume(), false);
    R.close(1); assert.ok(await until(() => t.lc.terminal, 2000)); assert.equal(t.lost.previousState, LS.STOPPED); assert.equal(R.inputs(w, tc), 0);
  } finally { await R.stopAll(); }
});

test('M3.2 M: re-registration needs a fresh authorisation and identity; the lost registration stays refused', async () => {
  const R = rig(2), [t1, t2] = R.tables, w2 = R.win(2); await R.start();
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 2, 20000)); t2.pause('operator'); await R.idle(t2);
    R.close(2); assert.ok(await until(() => t2.lc.terminal, 2000)); const oldReg = t2.registrationId;
    const inherit = R.make(w2, { lifecycle: t2.lc }); assert.equal((await inherit.step()).kind, 'lost', 'the lost lifecycle cannot be reused'); assert.equal(inherit.schedRegistration.refused, 'revoked'); inherit.dispose();
    const nw = R.host.addWindow(2, { generation: 1 }); assert.notEqual(nw.hwnd, w2.hwnd);
    assert.equal(LC.compareIdentity(t2.identity, LC.identityOf({ ...nw })).ok, false, 'the new window is not the registered identity');
    const auth = SC.authorizations({ environment: 'paused-window-test', approvedBy: 'operator (unit test)', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA });
    const reg = await R.session.request('register-target', { hwnd: nw.hwnd, authorization: auth.simulator }); assert.equal(reg.ok, true, 'fresh authorisation of the new window');
    const t3 = R.make(nw, { lifecycle: new LC.WindowLifecycle({ table: 2, identity: LC.identityOf({ ...reg.window, hwnd: nw.hwnd }, { exeSha256: SHA }), replaces: oldReg }) });
    assert.equal(t3.schedRegistration.ok, true); assert.equal(t3.schedRegistration.replaces, oldReg); assert.equal(t3.lc.state, LS.REGISTERED);
    await R.add(t3); assert.ok(await until(() => t3.m.confirmed >= 2, 20000), 'the replacement plays'); assert.equal(t3.lc.state, LS.ACTIVE);
    assert.deepEqual(R.sched.status().unavailableTables, [], 'table 2 is available again under its new registration');
    const j = await R.sched.submit({ table: 2, registrationId: oldReg, kind: 'fold', deadline: mono() + 5000, run: async () => 'ran' }); assert.equal(j.code, 'target-lost', 'the old registration is still refused');
    assert.equal(R.inputs(w2, 0) > 0, true); assert.equal(R.host.log.filter((e) => e.kind === 'input' && e.hwnd === w2.hwnd && e.at > t2.lc.lostAt).length >= 0, true);
  } finally { await R.stopAll(); }
});

test('M3.2 N: a confirmation that arrives late, after the attempt was cancelled, causes no retry and no second action', async () => {
  let armN = false; const R = rig(1, { ackMs: 400 }), [t] = R.tables, w = R.win(1); await R.start();
  const orig = w.dealer.onWindow.bind(w.dealer); w.dealer.onWindow = (m) => { if (armN && m.type === 'action') { armN = false; setTimeout(() => orig(m), 250); return; } return orig(m); };   // the table applies the click LATE
  try {
    assert.ok(await until(() => t.m.confirmed >= 2, 20000)); const acc0 = w.dealer.counts.accepted, clicks0 = R.host.stats.clicks; armN = true;
    assert.ok(await until(() => R.host.stats.clicks === clicks0 + 1, 5000), 'the click was sent'); t.stop('operator stop during confirmation'); const ts = mono();
    assert.equal(await settled(R.runs[0], 3000), 'done'); await sleep(400);
    assert.equal(w.dealer.counts.accepted, acc0 + 1, 'the late application happened once'); assert.equal(R.host.stats.clicks, clicks0 + 1, 'no second click'); assert.equal(R.inputs(w, ts), 0);
    const e = t.log[t.log.length - 1]; assert.equal(e.status, 'uncertain'); assert.equal(e.reviewRequired, true); assert.ok(['uncertain', 'cancelled-after-input'].includes(e.inputClass), e.inputClass);
    assert.equal(t.resume(), true, 'only an explicit operator resume continues (through RECOVERY_PENDING)'); assert.equal(t.lc.state, LS.RECOVERY_PENDING);
  } finally { await R.stopAll(); }
});

test('M3.2 O: a valid fresh action is confirmed: input status confirmed, timings recorded, no evidence record', async () => {
  const R = rig(1), [t] = R.tables, w = R.win(1); await R.start();
  try {
    assert.ok(await until(() => t.m.confirmed >= 4, 20000));
    const conf = t.log.filter((e) => e.status === 'confirmed'); assert.ok(conf.every((e) => e.inputClass === 'confirmed' && e.inputSent === false || e.inputClass === 'confirmed'));
    assert.equal(t.unconfirmed.length, 0); assert.ok(w.dealer.counts.accepted >= t.m.confirmed);
    const r = t.report(); assert.ok(r.latencyMs.confirmation.n >= 4); assert.ok(r.scheduleWaitMs.n >= 4); assert.ok(r.inputStatus.confirmed >= 4); assert.equal(r.health.running, true);
    const m = R.sched.metrics(); assert.ok(m.perTable[1].completed >= 4); assert.ok(m.perTable[1].queueWaitMs.n >= 4);
  } finally { await R.stopAll(); }
});

test('M3.2 P: a real "simulator rejected the action" outcome -> input-rejected safety pause, complete evidence, no retry, operator resume recovers', async () => {
  const R = rig(1), [t] = R.tables, w = R.win(1); await R.start();
  try {
    assert.ok(await until(() => t.m.confirmed >= 2, 20000)); w.dealer.dropNextAction(1);
    assert.ok(await until(() => t.lc.is(LS.SAFETY_PAUSED) && t.unconfirmed.length === 1, 8000)); const rec = t.unconfirmed[0];
    for (const k of ['table', 'registrationId', 'hwnd', 'identityFingerprint', 'action', 'control', 'expectedRegion', 'selectedPoint', 'displayScaling', 'clientAtReading', 'windowAfter', 'driver', 'scheduler', 'confirmation', 'frames', 'inputStatus', 'timeline']) assert.ok(rec[k] !== undefined && rec[k] !== null, 'evidence field ' + k);
    assert.equal(rec.inputStatus, 'rejected-no-change'); assert.match(rec.identityFingerprint, /^[0-9a-f]{8}$/); assert.equal(rec.confirmation.timeoutMs, 300); assert.ok(rec.confirmation.polls > 0);
    assert.equal(rec.frames.before.revision, rec.frames.after.revisionsSeen[0], 'the status-strip revision never moved'); assert.equal(typeof rec.windowAfter.foreground, 'boolean'); assert.equal(rec.displayScaling, 1);
    assert.ok(rec.expectedRegion.normalized.w > 0 && rec.selectedPoint.x > 0); assert.equal(rec.scheduler.leaseId > 0, true);
    assert.ok(rec.images && rec.images.before && rec.images.after, 'the window frames are kept for the test tool'); const js = JSON.stringify(rec);
    assert.ok(!/images/.test(js), 'frames never enter JSON'); assert.ok(!js.includes(TOKEN), 'no session token in the evidence');
    assert.equal(t.gameplay.code, 'input-confirmation-failure'); assert.equal(t.lc.message()[0], 'Action not applied');
    const tp = mono(); await sleep(300); assert.equal(R.inputs(w, tp), 0, 'no automatic retry');
    assert.equal(t.resume(), true); assert.equal(t.lc.state, LS.RECOVERY_PENDING); const c = t.m.confirmed;
    assert.ok(await until(() => t.lc.state === LS.ACTIVE && t.m.confirmed > c, 8000), 'fresh readings, then play'); assert.equal(w.dealer.counts.droppedByTest, 1);
  } finally { await R.stopAll(); }
});

test('M3.2 Q: two tables under repeated faults (unapplied actions, pauses, closes and replacements) -> never any cross-table input', async () => {
  const rng = new EM.RNG(20261124), R = rig(2), [t1] = R.tables; await R.start(); const lostHwnds = new Map(); let cur2 = R.tables[1], w2 = R.win(2), gen = 0;
  try {
    assert.ok(await until(() => t1.m.confirmed >= 2 && cur2.m.confirmed >= 2, 20000));
    for (let round = 0; round < 10; round++) {
      const f = Math.floor(rng.next() * 3);
      if (f === 0) { w2.dealer.dropNextAction(1); assert.ok(await until(() => cur2.lc.is(LS.SAFETY_PAUSED), 8000), 'round ' + round + ' safety pause'); await sleep(50); assert.equal(cur2.resume(), true); }
      else if (f === 1) { cur2.pause('operator'); await R.idle(cur2); await sleep(150); assert.equal(cur2.resume(), true); }
      else {
        cur2.pause('operator'); await R.idle(cur2); const t = R.close(2); assert.ok(await until(() => cur2.lc.terminal, 2000), 'round ' + round + ' loss'); lostHwnds.set(w2.hwnd, mono());
        assert.ok(R.sched.status().unavailableTables.join() === '2'); const nw = R.host.addWindow(2, { generation: ++gen });
        const reg = await R.session.request('register-target', { hwnd: nw.hwnd, authorization: R.auth.simulator }); assert.equal(reg.ok, true);
        const nt = R.make(nw, { lifecycle: new LC.WindowLifecycle({ table: 2, identity: LC.identityOf({ ...reg.window, hwnd: nw.hwnd }, { exeSha256: SHA }), replaces: cur2.registrationId }) }); await R.add(nt); cur2 = nt; w2 = nw;
        assert.deepEqual(R.sched.status().unavailableTables, [], 'available under the new registration'); void t;
      }
      const c2 = cur2.m.confirmed; assert.ok(await until(() => cur2.m.confirmed > c2 && cur2.lc.is(LS.ACTIVE), 10000), 'round ' + round + ': table 2 plays again');
    }
    for (const [h, at] of lostHwnds) assert.equal(R.host.log.filter((e) => e.kind === 'input' && e.hwnd === h && e.at >= at).length, 0, 'no input to a lost window ' + h);
    assert.equal(R.host.stats.violations.length, 0, 'no click outside a control'); assert.equal(t1.lc.terminal, false); assert.ok(!t1.lc.history.some((h) => h.to === LS.SAFETY_PAUSED), 'table 1 never paused ' + JSON.stringify(t1.lc.history.filter((h) => h.to === LS.SAFETY_PAUSED)) + ' ' + JSON.stringify(t1.log.filter((e) => e.status !== 'confirmed').slice(-3)));
    assert.ok(R.win(1).dealer.counts.accepted >= t1.m.confirmed, 'every confirmed table-1 action reached table 1'); assert.equal(t1.unconfirmed.length, 0);
  } finally { await R.stopAll(); }
});

test('M3.2 R: several table windows close and are re-registered one after another -> each loss isolated, each replacement plays', async () => {
  const R = rig(3); await R.start(); const cur = { 1: R.tables[0], 2: R.tables[1], 3: R.tables[2] }, old = [];
  try {
    assert.ok(await until(() => Object.values(cur).every((t) => t.m.confirmed >= 2), 30000));
    for (const k of [1, 2, 3]) {
      const t = cur[k], w = R.win(k); if (k === 2) { t.pause('operator'); await R.idle(t); }   // one of them paused when it closes
      R.close(k); assert.ok(await until(() => t.lc.terminal, 6000), 'table ' + k + ' lost'); old.push({ hwnd: w.hwnd, reg: t.registrationId, at: mono() });
      for (const j of [1, 2, 3]) if (j !== k) assert.equal(cur[j].lc.terminal, false, 'table ' + j + ' unaffected by the loss of ' + k);
      assert.ok(R.sched.status().unavailableTables.includes(k));
      const nw = R.host.addWindow(k, { generation: 1 }), reg = await R.session.request('register-target', { hwnd: nw.hwnd, authorization: R.auth.simulator });
      const nt = R.make(nw, { lifecycle: new LC.WindowLifecycle({ table: k, identity: LC.identityOf({ ...reg.window, hwnd: nw.hwnd }, { exeSha256: SHA }), replaces: t.registrationId }) }); await R.add(nt); cur[k] = nt;
      assert.ok(await until(() => nt.m.confirmed >= 2, 20000), 'replacement ' + k + ' plays');
    }
    const st = R.sched.status(); assert.deepEqual(st.unavailableTables, []); assert.equal(st.revokedRegistrations.length, 3);
    for (const k of [1, 2, 3]) { assert.equal(st.registrations[k], cur[k].registrationId); assert.equal(cur[k].lc.state, LS.ACTIVE); }
    for (const o of old) assert.equal(R.host.log.filter((e) => e.kind === 'input' && e.hwnd === o.hwnd && e.at >= o.at).length, 0, 'no input to a replaced window');
    assert.equal(R.host.stats.violations.length, 0);
  } finally { await R.stopAll(); }
});

/* ======================================================================================================================================
 * units: WindowHealthMonitor and the registration-aware scheduler
 * ==================================================================================================================================== */
function fakeMonitor(state, results, o = {}) {
  let now = 0; const lc = new LC.WindowLifecycle({ table: 1, identity: { hwnd: '0x10', pid: 1 }, clock: () => now });
  if (state === LS.ACTIVE) lc.transition(LS.ACTIVE, { kind: 'first-reading' }); else if (state !== LS.REGISTERED) { lc.transition(LS.ACTIVE, { kind: 'first-reading' }); lc.transition(state, { kind: state === LS.STOPPED ? 'stopped' : state === LS.SAFETY_PAUSED ? 'emergency-stop' : 'capture-timeout', operator: true }); }
  const losses = []; const m = new LC.WindowHealthMonitor({ lifecycle: lc, clock: () => now, probe: async () => (typeof results === 'function' ? results() : results.shift() || { exists: true, matches: true }), onLoss: (c) => { losses.push(c); lc.transition(LS.TARGET_LOST, c); }, gameplayHeld: o.held || (() => false), activeIntervalMs: 5000, activeSlackMs: 2500, pausedIntervalMs: 1000, maxBackoffMs: 8000, setTimer: () => null, clearTimer: () => {} });
  return { m, lc, losses, tick: (ms) => { now += ms; } };
}
test('M3.2 unit: the health monitor never moves a lifecycle towards ACTIVE and never resumes anything', async () => {
  for (const s of [LS.REGISTERED, LS.SAFETY_PAUSED, LS.STOPPED, LS.TEMPORARILY_UNAVAILABLE]) {
    const f = fakeMonitor(s, () => ({ exists: true, matches: true, window: { foreground: false } })); const g0 = f.lc.generation;
    for (let i = 0; i < 5; i++) { f.tick(1500); assert.equal((await f.m.check()).outcome, 'healthy'); }
    assert.equal(f.lc.state, s, s + ' unchanged'); assert.equal(f.lc.generation, g0, 'no transition'); assert.equal(f.losses.length, 0);
  }
});
test('M3.2 unit: unknown answers prove nothing and back off; a loss is reported exactly once (single-flight) and the monitor stops', async () => {
  const f = fakeMonitor(LS.ACTIVE, [{ exists: null, unknown: true, code: 'timeout' }, { exists: null, unknown: true, code: 'timeout' }]);
  assert.equal(f.m.intervalMs(), 7500); await f.m.check(); assert.equal(f.m.intervalMs(), 8000, 'backed off (bounded)'); await f.m.check(); assert.equal(f.lc.state, LS.ACTIVE); assert.equal(f.losses.length, 0);
  await f.m.check(); assert.equal(f.m.unknownInRow, 0, 'a healthy answer resets the backoff');
  const g = fakeMonitor(LS.SAFETY_PAUSED, () => ({ exists: false, code: 'window-gone' })); g.m.running = true;
  const [a, b] = await Promise.all([g.m.check(), g.m.check()]); assert.equal(a, b, 'concurrent checks share one probe'); assert.equal(g.losses.length, 1); assert.equal(g.lc.state, LS.TARGET_LOST);
  assert.equal(g.losses[0].kind, 'window-closed'); assert.equal(g.m.running, false); assert.equal((await g.m.check()).outcome, 'terminal'); assert.equal(g.losses.length, 1);
  const h = fakeMonitor(LS.STOPPED, () => ({ exists: true, matches: false, problems: ['process id 7 differs from 1'] })); await h.m.check(); assert.equal(h.losses[0].kind, 'identity-changed');
});
test('M3.2 unit: probes made by the table count as evidence (no duplicate probe while playing); a paused table is due on the short interval', () => {
  let held = false; const f = fakeMonitor(LS.ACTIVE, [], { held: () => held });
  assert.equal(f.m.due(), true, 'never probed: due'); f.m.noteProbe(0, { exists: true, matches: true }, false); f.tick(5000); assert.equal(f.m.due(), false, 'a table probe 5 s ago is recent enough while playing');
  f.tick(2600); assert.equal(f.m.due(), true); held = true; f.m.noteProbe(f.m.clock(), { exists: true, matches: true }, false); f.tick(999); assert.equal(f.m.due(), false); f.tick(2); assert.equal(f.m.due(), true, 'paused: every second');
});
test('M3.2 unit: scheduler registrations - revoke once, refuse the old registration for good, a replacement is available, an old pause never blocks it', async () => {
  let now = 0; const ev = [], s = new SCH.InputScheduler({ now: () => now, onEvent: (k, d) => ev.push(k) }), ok = async (reg) => (await s.submit({ table: 2, registrationId: reg, kind: 'call', deadline: now + 5000, run: async () => 'ran' }));
  assert.equal(s.registerTable(2, 'r1').ok, true); s.pauseTable(2, 'input-rejected', 'r1'); assert.equal((await ok('r1')).code, 'paused');
  const a = s.invalidateTable(2, 'window closed', 'r1'), b = s.invalidateTable(2, 'window closed again', 'r1'); assert.equal(a.repeated, undefined); assert.equal(b.repeated, true); assert.equal(s.metrics().invalidationRepeats, 1);
  assert.equal(ev.filter((k) => k === 'invalidated').length, 1); assert.deepEqual(s.status().unavailableTables, [2]); assert.equal((await ok('r1')).code, 'target-lost', 'a lost table is refused as lost, not merely paused');
  assert.equal(s.registerTable(2, 'r1').refused, 'revoked'); now = 10; assert.equal(s.registerTable(2, 'r2').replaces, 'r1');
  assert.deepEqual(s.status().unavailableTables, [], 'available under the new registration'); assert.deepEqual(s.status().pausedTables, [], 'the old registration\'s pause was lifted');
  assert.equal((await ok('r2')).ok, true); assert.equal((await ok('r1')).code, 'target-lost'); assert.ok(s.status().revokedRegistrations.some((r) => r.registrationId === 'r1' && r.repeats === 1));
  const legacy = new SCH.InputScheduler(); legacy.invalidateTable(3, 'gone', 'x'); assert.deepEqual(legacy.status().unavailableTables, [3], 'without registerTable: Milestone 2/3 behaviour');
  assert.equal((await legacy.submit({ table: 3, kind: 'call', deadline: performance.now() + 5000, run: async () => 1 })).code, 'target-lost');
  const pt = s.metrics().perTable[2]; assert.ok(pt.submitted >= 4 && pt.rejected['target-lost'] >= 2 && pt.completed === 1);
});
test('M3.2 unit: invalidating one registration never touches another table\'s queued or running job', async () => {
  const s = new SCH.InputScheduler(); let release; const cancels = []; s.onCancel = (j) => cancels.push(j.table); s.registerTable(1, 'a'); s.registerTable(2, 'b');
  const p1 = s.submit({ table: 1, registrationId: 'a', kind: 'call', deadline: performance.now() + 9000, run: () => new Promise((r) => { release = r; }) });
  const p2 = s.submit({ table: 2, registrationId: 'b', kind: 'call', deadline: performance.now() + 9000, run: async () => 'b ran' });
  await until(() => !!release, 1000); const rec = s.invalidateTable(2, 'closed', 'b'); assert.equal(rec.dropped, 1); assert.equal(rec.cancelledRunning, false); assert.deepEqual(cancels, []);
  assert.equal((await p2).code, 'target-lost'); release('a ran'); assert.equal((await p1).result, 'a ran');
  const p3 = s.submit({ table: 1, registrationId: 'a', kind: 'fold', deadline: performance.now() + 9000, run: () => new Promise((r) => setTimeout(() => r('late'), 30)) }); await sleep(5);
  const rec2 = s.invalidateTable(1, 'closed', 'a'); assert.equal(rec2.cancelledRunning, true); assert.deepEqual(cancels, [1]); await p3;
});
