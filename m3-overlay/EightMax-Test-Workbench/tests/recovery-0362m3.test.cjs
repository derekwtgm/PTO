'use strict';
// 0.36.2 Milestone 3: end-to-end gameplay reliability through the PRODUCTION SimulatorTable pipeline (pixels -> recognition -> hand
// tracker -> decision -> scheduler -> adapter -> driver wrapper -> confirmation) against the in-process fake desktop host and the REAL
// fixture dealer of EightMaxTestTable.exe:
//   untracked hand -> waits without input -> the table's action clock ends the hand -> next opening verified -> recovered -> plays on
//   persistent reconstruction failure -> untracked (explicit) -> recovery at the next hand
//   eliminations -> tournament completion (strict tournament rules) -> run() ends normally, lifecycle STOPPED (tournament-complete)
//   Milestone 2 protections with eliminations in play: target loss, emergency stop, no automatic re-enable, no resend.
// Not Windows evidence (the Windows run is tools/gameplay-acceptance-0362m3.cjs via RUN-0362-MILESTONE3-TESTS.cmd / CI).
const test = require('node:test'), assert = require('node:assert/strict');
const SC = require('../src/simulator-controls.js'), SP = require('../src/simulator-profiles.js'), SCH = require('../src/input-scheduler.js'), XA = require('../src/execution-adapters.js'), M = require('../src/input-motion.js');
// the motion profile of the acceptance runners (the driver default is a slow human-like speed whose estimates exceed short decision windows)
const MOTION = M.profile({ maxSpeed: 1200, arc: 0.12, maxDeviationPx: 240 });
const LC = require('../src/window-lifecycle.js'), LS = LC.STATES;
const { lifecycleHost, TOKEN, SHA } = require('./lifecycle-host-fixture.cjs'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rig(host, o = {}) {
  const api = new SC.HostApi({ token: TOKEN, fetch: host.fetch }), session = SC.hostSession(api), sched = new SCH.InputScheduler({ maxQueue: 8, onCancel: () => session.request('cancel-all') });
  session.capabilities = { signedCurves: true, maxDeviationPx: true, singleClickGuardMaxMs: 540 };   // as the dashboard does: the driver's real click-guard time for deadline estimates
  const auth = SC.authorizations({ environment: 'recovery-test', approvedBy: 'unit test', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA }), profile = SP.fixtureProfile({ exeSha256: SHA });
  const rec = new XA.DiagnosticsRecorder({ max: 20000 });
  const make = (t, extra = {}) => new SC.SimulatorTable({ id: t.id, window: { hwnd: t.hwnd, pid: t.pid, title: 'EightMax Test Table ' + String(t.id).padStart(2, '0'), client: t.client },
    identity: LC.identityOf({ hwnd: t.hwnd, pid: t.pid, processStart: t.processStart, className: t.className, exe: t.exe, client: t.client, dpiScale: 1 }, { exeSha256: SHA }),
    profile, api, session, scheduler: sched, qaAuthorization: auth.qa, recorder: rec, allowScripted: true, seed: 3, timing: { postClickSettleMs: 0 }, motion: MOTION, movement: { pattern: 'straight', seed: 1 },
    options: { decisionWindowMs: 10000, pollMs: 5, idlePollMs: 5, postActionTimeoutMs: 800, stopOnPause: false, retryBaseMs: 40, retryMaxMs: 320, identityCheckMs: 5000, ...(o.options || {}) }, ...extra });
  return { api, session, sched, rec, make };
}
const inputsBetween = (host, hwnd, t0, t1) => host.log.filter((e) => e.kind === 'input' && e.hwnd === hwnd && e.at >= t0 && (t1 === undefined || e.at <= t1)).length;
async function until(pred, ms, step = 10) { const end = performance.now() + ms; while (performance.now() < end) { if (pred()) return true; await sleep(step); } return pred(); }
/** Always stop every table loop (bounded wait, timer cleared) and every dealer timer, also when an assertion failed. */
async function cleanup(host, tables, runs) {
  for (const t of tables) { try { t.stop('test cleanup'); } catch (e) { /* already stopped */ } }
  let timer; await Promise.race([Promise.allSettled(runs), new Promise((r) => { timer = setTimeout(r, 5000); })]); clearTimeout(timer);
  for (const t of tables) { try { t.dispose(); } catch (e) { /* ignore */ } }
  host.dispose();
}
const grade = (o) => { const c = o.counts; return { incorrect: c.downOutsideControls + c.downOnDisabled + c.doubleClicks + c.staleClicks + c.illegal, wagerRejected: c.wagerRejected, accepted: c.accepted }; };

test('M3 recovery A: a hand first seen after its opening is untracked (no input), the table clock ends it, the next verified opening resumes play', async () => {
  const hands = []; let host;
  host = lifecycleHost(1, { handGapMs: 120, actionTimeoutMs: 250, record: (id, ev) => { if (ev.kind === 'hand-start') { hands.push(ev.state.hand); if (ev.state.hand >= 2) host.byId(1).dealer.actionTimeout = 0; } } });
  const w = host.byId(1), R = rig(host), tables = [], runs = [];
  try {
    // somebody acted before automation started: the first reading shows a call that the tracker never saw
    w.dealer.onWindow({ type: 'action', control: 'call', wager: '', rev: w.dealer.rev }); assert.equal(w.dealer.counts.accepted, 1);
    const t = R.make(w), conds = []; let untrackedFrom = null, untrackedTo = null; tables.push(t);
    const run = t.run(Infinity, () => { const c = t.gameplay.code; if (conds[conds.length - 1] !== c) conds.push(c); const s = t.engine.trackingStatus().status; if (s === 'untracked-hand' && untrackedFrom === null) untrackedFrom = performance.now(); if (untrackedFrom !== null && untrackedTo === null && s !== 'untracked-hand') untrackedTo = performance.now(); }); runs.push(run);
    assert.ok(await until(() => t.m.handRecoveries === 1 && t.m.confirmed >= 6, 30000), JSON.stringify({ rec: t.m.handRecoveries, confirmed: t.m.confirmed, cond: t.gameplay.code, ts: t.engine.trackingStatus() }));
    t.stop(); await run;
    const ts = t.engine.trackingStatus();
    assert.equal(ts.recoveries, 1); assert.equal(ts.untrackedHands, 1); assert.equal(ts.lastRecovery.fromHand, 1); assert.equal(ts.lastRecovery.toHand, 2); assert.equal(ts.lastRecovery.cause, 'missed-hand-start');
    assert.ok(untrackedFrom !== null && untrackedTo !== null, 'the untracked period was observed and ended');
    assert.equal(inputsBetween(host, w.hwnd, untrackedFrom, untrackedTo), 0, 'no input while the hand was untracked');
    assert.ok(w.dealer.counts.timeoutActions > 0, 'the table clock (not the Workbench) finished the untracked hand');
    const at = (c) => conds.indexOf(c); assert.ok(at('waiting-next-hand') >= 0 && at('waiting-next-hand') < at('verifying') && at('verifying') < at('playing'), 'conditions in order waiting-next-hand > verifying > playing: ' + conds.join(' > '));
    assert.equal(t.m.verifyingSteps > 0, true, 'no decision was taken until fresh readings agreed');
    const g = grade(w.dealer.summary()); assert.equal(g.incorrect, 0, JSON.stringify(g)); assert.equal(g.wagerRejected, 0);
    assert.equal(t.m.uncertain + t.m.ambiguous + t.m.timedOut, 0);
    // bounded diagnostics: the condition changes are recorded once each, the repeated refusals are coalesced
    const ex = R.rec.export(), gp = ex.events.filter((e) => e.stage === 'gameplay' && e.kind === 'condition');
    assert.ok(gp.length <= 12, 'gameplay conditions recorded on change only: ' + gp.map((e) => e.to).join(','));
    assert.ok(ex.events.filter((e) => e.stage === 'state' && e.ok === false).length <= 6, 'refusals coalesced');
    assert.ok(ex.events.some((e) => e.stage === 'gameplay' && e.kind === 'hand-recovered' && e.fromHand === 1 && e.toHand === 2));
  } finally { await cleanup(host, tables, runs); }
});

test('M3 recovery B: a reconstruction failure that persists within a hand becomes an explicit untracked hand; the next hand recovers', async () => {
  // turnDelayMs: after each action the table "holds" (other players think, no controls) - a reading problem that starts there hits no
  // action of ours (one that hits the confirmation of an action pauses the table for review instead: tested in Milestone 2).
  let host; host = lifecycleHost(1, { handGapMs: 120, record: (id, ev) => { if (ev.kind !== 'hand-start' || !host) return; const d = host.byId(1).dealer; if (ev.state.hand === 2) d.turnDelay = 2500; if (ev.state.hand >= 3) { d.actionTimeout = 0; d.turnDelay = 0; } } });
  const w = host.byId(1), R = rig(host), t = R.make(w), tables = [t], runs = []; let corrupt = false, corrupted = 0, tc = null;
  const observe = t.reader.observe.bind(t.reader);
  t.reader.observe = (img, meta) => { const r = observe(img, meta); if (corrupt && r.ok && r.observation.hand === 2) { r.observation.pot += 5; corrupted++; } return r; };
  try {
    // corrupt every reading of hand 2 from the moment one of our actions there was CONFIRMED (the table is then holding)
    const run = t.run(Infinity, (r) => { if (!corrupt && r.kind === 'acted' && r.entry && r.entry.status === 'confirmed' && r.entry.hand === 2) { corrupt = true; tc = performance.now(); } }); runs.push(run);
    assert.ok(await until(() => corrupt, 60000), 'an action of hand 2 was confirmed');
    assert.ok(await until(() => t.engine.trackingStatus().status === 'untracked-hand', 20000), JSON.stringify(t.engine.trackingStatus()));
    const ts = t.engine.trackingStatus(), tu = performance.now(); assert.equal(ts.reasonCode, 'persistent-contradiction'); assert.match(ts.reason, /inconsistent-pot/); assert.equal(ts.observedHand, 2);
    assert.equal(t.lc.state, LS.ACTIVE, 'a reading problem is not a window problem'); assert.notEqual(t.lc.state, LS.SAFETY_PAUSED);
    w.dealer.actionTimeout = 250; w.dealer.armClock();   // the table's clock ends the untracked hand
    let tr = null; assert.ok(await until(() => { if (tr === null && t.m.handRecoveries === 1) tr = performance.now(); return t.m.handRecoveries === 1 && t.m.confirmed >= 8; }, 60000), JSON.stringify({ rec: t.m.handRecoveries, c: t.m.confirmed, ts: t.engine.trackingStatus(), cond: t.gameplay.code }));
    assert.equal(t.gameplay.episodes['waiting-next-hand'] >= 1, true, JSON.stringify(t.gameplay.episodes)); assert.ok(t.gameplay.episodes['chip-accounting'] >= 1, 'the refusals were classified as invalid chip accounting: ' + JSON.stringify(t.gameplay.episodes));
    t.stop(); await run;
    assert.equal(inputsBetween(host, w.hwnd, tc, tr), 0, 'no input from the first refused reading until the next verified hand'); assert.ok(tc < tu && tu < tr);
    assert.ok(corrupted >= 25, 'at least maxContradictionFrames corrupted readings: ' + corrupted);
    const g = grade(w.dealer.summary()); assert.equal(g.incorrect, 0, JSON.stringify(g)); assert.equal(t.m.uncertain + t.m.ambiguous + t.m.timedOut, 0);
  } finally { await cleanup(host, tables, runs); }
});

test('M3 eliminations: a short tournament is played to the end under strict tournament rules; the end is a normal stop, not a stall', async () => {
  // three short stacks among five seats that are already eliminated (the long 8-player tournaments run in tools/gameplay-campaign-0362m3.cjs)
  const host = lifecycleHost(1, { handGapMs: 400, stacks: [0, 250, 0, 0, 250, 0, 0, 250] }), w = host.byId(1), R = rig(host), t = R.make(w), tables = [t], runs = [];
  try {
    assert.equal(t.tournamentRules, 'strict', 'the bundled fixture runs with strict tournament rules');
    const t0 = performance.now(), run = t.run(performance.now() + 120000); runs.push(run); await run; const ms = performance.now() - t0;
    assert.ok(t.completed, 'the table recognised the end');
    assert.ok(await until(() => w.dealer.t.tournamentComplete, 3000), 'the dealer confirms the end (it sets its flag when the next hand would start)');
    assert.equal(t.completed.winner, w.dealer.t.players.findIndex((p) => p.stack > 0)); assert.equal(t.lc.state, LS.STOPPED); assert.equal(t.lc.cause.kind, 'tournament-complete');
    assert.deepEqual(t.lc.message(), ['Simulator completed', 'Tournament finished. Automated gameplay has stopped normally.']);
    assert.equal(t.gameplay.code, 'tournament-complete'); assert.ok(t.gameplay.episodes.elimination >= 1, JSON.stringify(t.gameplay.episodes));
    assert.equal(t.m.rejectedFrames, 0, 'no reading was refused'); assert.equal(t.engine.trackingStatus().untrackedHands, 0);
    const ts = t.engine.tournamentStatus(); assert.equal(ts.eliminated.length, 7); assert.equal(ts.complete.source, 'verified settlement');
    const g = grade(w.dealer.summary()); assert.equal(g.incorrect, 0); assert.equal(g.wagerRejected, 0); assert.equal(g.accepted, t.m.confirmed, 'every confirmed action reached the table and nothing else did');
    assert.equal(t.m.uncertain + t.m.ambiguous + t.m.timedOut + t.m.rejected, 0, JSON.stringify(t.report().counts));
    assert.equal(t.resume(), false, 'a finished tournament never resumes by itself or by Resume');
    const before = host.log.length; await sleep(200); assert.equal(host.log.filter((e, i) => i >= before && (e.kind === 'capture' || e.kind === 'input')).length, 0, 'no capture or input after the end');
    assert.ok(ms < 120000);
  } finally { await cleanup(host, tables, runs); }
});

test('M3 x M2 protections: with eliminations in play a closed window is still terminal, an emergency stop still wins, nothing is re-enabled or re-sent', async () => {
  // target loss after the first elimination
  {
    const host = lifecycleHost(1, { handGapMs: 400, stacks: [120, 120, 400, 120, 120, 400, 120, 120] }), w = host.byId(1), R = rig(host), t = R.make(w), runs = [];
    try {
      const run = t.run(Infinity); runs.push(run);
      assert.ok(await until(() => t.m.eliminationsSeen >= 1 && t.m.confirmed >= 3, 60000), 'an elimination was seen');
      w.closed = true; w.dealer.onWindow({ type: 'closed' }); const tc = performance.now();
      assert.ok(await until(() => t.lc.terminal, 5000)); await run; const tl = performance.now();
      assert.equal(t.gameplay.code, 'target-lost'); assert.equal(inputsBetween(host, w.hwnd, tl), 0);
      assert.ok(host.log.filter((e) => e.kind === 'capture' && e.hwnd === w.hwnd && e.at >= tl).length === 0, 'no capture after the loss');
      assert.equal(t.resume(), false); assert.ok(tl - tc < 5000);
    } finally { await cleanup(host, [t], runs); }
  }
  // emergency stop between hands right after an elimination: SAFETY_PAUSED, operator-only exit, no input while latched
  {
    const host = lifecycleHost(1, { handGapMs: 200, stacks: [120, 120, 400, 120, 120, 400, 120, 120] }), w = host.byId(1), R = rig(host), t = R.make(w), runs = [];
    try {
      const run = t.run(Infinity); runs.push(run);
      assert.ok(await until(() => t.m.eliminationsSeen >= 1, 60000));
      await R.api.request('/api/input/estop', {}); R.sched.emergencyStop('test'); t.safetyPause('emergency-stop', 'emergency stop (test)'); const te = performance.now();
      await sleep(400); assert.equal(t.lc.state, LS.SAFETY_PAUSED); assert.equal(t.gameplay.code, 'emergency-stop'); assert.equal(inputsBetween(host, w.hwnd, te), 0, 'no input while the stop is latched');
      assert.equal(t.lc.transition(LS.RECOVERY_PENDING, { kind: 'auto' }).refused, 'operator-required', 'recovery never re-enables an operator-stopped table by itself');
      t.stop(); await run;
    } finally { await cleanup(host, [t], runs); }
  }
});

test('M3 multi-table: two tables, one eliminates players while the other closes; no input crosses tables', async () => {
  // table 1 plays tiny stacks, so players are eliminated during the first hands; table 2 plays deep and is closed
  const host = lifecycleHost(2, { handGapMs: 400, stacks: (id) => (id === 1 ? [120, 120, 400, 120, 120, 400, 120, 120] : Array(8).fill(20000)) }), [w1, w2] = [host.byId(1), host.byId(2)], R = rig(host), t1 = R.make(w1), t2 = R.make(w2);
  const runs = [];
  try {
    runs.push(t1.run(Infinity), t2.run(Infinity));
    assert.ok(await until(() => t1.m.eliminationsSeen >= 1 && t2.m.confirmed >= 3, 60000));
    const before2 = { lc: t2.lc.state, paused: t2.paused, cond: t2.gameplay.code, confirmed: t2.m.confirmed, last: t2.log.slice(-1)[0] };
    w2.closed = true; w2.dealer.onWindow({ type: 'closed' }); assert.ok(await until(() => t2.lc.terminal, 5000), 'table 2 lost: ' + JSON.stringify({ before2, after: { lc: t2.lc.state, paused: t2.paused, cond: t2.gameplay.code } })); const tl = performance.now(), c1 = t1.m.confirmed;
    assert.ok(await until(() => t1.m.confirmed >= c1 + 5 || t1.completed, 60000)); t1.stop(); await Promise.all(runs);
    assert.equal(inputsBetween(host, w2.hwnd, tl), 0); const g1 = grade(w1.dealer.summary()); assert.equal(g1.incorrect, 0); assert.equal(g1.accepted, t1.m.confirmed);
    assert.equal(R.sched.status().unavailableTables.join(), '2');
  } finally { await cleanup(host, [t1, t2], runs); }
});
