'use strict';
// 0.36.2 Milestone 3: NEGATIVE end-to-end tests through the production SimulatorTable pipeline (fake host, real fixture dealer).
// Each case manipulates what the Workbench sees (or when it sees it) and asserts that it refuses: no input reaches the table while the
// reading is unsafe, the reason is stated, and play resumes once readings are consistent again. (Closed windows and emergency stops are
// covered by tests/lifecycle-0362m2.test.cjs, tests/recovery-0362m3.test.cjs and the acceptance tools.)
const test = require('node:test'), assert = require('node:assert/strict');
const SC = require('../src/simulator-controls.js'), SP = require('../src/simulator-profiles.js'), SCH = require('../src/input-scheduler.js'), XA = require('../src/execution-adapters.js'), M = require('../src/input-motion.js');
const LC = require('../src/window-lifecycle.js');
const { lifecycleHost, TOKEN, SHA } = require('./lifecycle-host-fixture.cjs'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOTION = M.profile({ maxSpeed: 1200, arc: 0.12, maxDeviationPx: 240 });

function rig(o = {}) {
  const host = lifecycleHost(1, { handGapMs: 400, ...(o.host || {}) }), w = host.byId(1);
  const api = new SC.HostApi({ token: TOKEN, fetch: host.fetch }), session = SC.hostSession(api), sched = new SCH.InputScheduler({ maxQueue: 8, onCancel: () => session.request('cancel-all') });
  session.capabilities = { signedCurves: true, maxDeviationPx: true, singleClickGuardMaxMs: 540 };
  const auth = SC.authorizations({ environment: 'negative-test', approvedBy: 'unit test', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA });
  const t = new SC.SimulatorTable({ id: 1, window: { hwnd: w.hwnd, pid: w.pid, title: 'EightMax Test Table 01', client: w.client }, identity: LC.identityOf({ hwnd: w.hwnd, pid: w.pid, processStart: w.processStart, className: w.className, exe: w.exe, client: w.client, dpiScale: 1 }, { exeSha256: SHA }),
    profile: SP.fixtureProfile({ exeSha256: SHA }), api, session, scheduler: sched, qaAuthorization: auth.qa, recorder: new XA.DiagnosticsRecorder({ max: 5000 }), allowScripted: true, seed: 5, timing: { postClickSettleMs: 0 }, motion: MOTION, movement: { pattern: 'straight', seed: 1 },
    options: { decisionWindowMs: 10000, pollMs: 5, idlePollMs: 5, postActionTimeoutMs: 800, stopOnPause: false, retryBaseMs: 40, retryMaxMs: 320 } });
  return { host, w, t };
}
const inputs = (host, hwnd) => host.log.filter((e) => e.kind === 'input' && e.hwnd === hwnd).length;
async function until(pred, ms) { const end = performance.now() + ms; while (performance.now() < end) { if (pred()) return true; await sleep(10); } return pred(); }
async function finish(R, run) { R.t.stop('test end'); let tm; await Promise.race([run, new Promise((r) => { tm = setTimeout(r, 5000); })]); clearTimeout(tm); R.t.dispose(); R.host.dispose(); }

/** Run a table, apply `corrupt` to readings while `active()`; assert: no input while active, a reason recorded, recovery after. */
async function refusal(name, corrupt, expectCode, o = {}) {
  const R = rig(o), { t, w, host } = R; let active = false, arm = false, corrupted = 0, n0 = 0, r0 = 0;
  const observe = t.reader.observe.bind(t.reader);
  t.reader.observe = (img, meta) => { const r = observe(img, meta); if (active && r.ok) { corrupt(r.observation, t); corrupted++; } return r; };
  // corruption starts synchronously after a CONFIRMED action (the step callback runs before the next step): no action of ours is in flight
  const run = t.run(Infinity, (r) => { if (arm && !active && r.kind === 'acted' && r.entry && r.entry.status === 'confirmed') { arm = false; active = true; n0 = inputs(host, w.hwnd); r0 = t.m.rejectedFrames; } });
  try {
    assert.ok(await until(() => t.m.confirmed >= 3, 30000), name + ': plays first');
    arm = true; assert.ok(await until(() => active, 15000), name + ': corruption started after a confirmed action');
    await until(() => corrupted >= 15, 15000); const during = inputs(host, w.hwnd) - n0;
    const codes = t.engine.rejections.slice(-10).map((x) => x.issues[0].code), reason = t.engine.pauseReason || '';
    active = false; const c1 = t.m.confirmed; await until(() => t.m.confirmed > c1 + 1 || t.lc.is(LC.STATES.SAFETY_PAUSED), 20000);
    return { during, refused: t.m.rejectedFrames - r0, codes, reason, resumed: t.m.confirmed > c1, gameplay: JSON.parse(JSON.stringify(t.gameplay)), lc: t.lc.state };   // a snapshot: cleanup stops the table
  } finally { await finish(R, run); }
}

test('M3 negative: contradictory stack amounts are refused with the reason; no input; play resumes when readings agree', async () => {
  const r = await refusal('stacks', (o) => { o.seats[(o.actor + 3) % 8].stack += 500; }, 'unexplained-change');
  assert.equal(r.during, 0, 'no input while stacks contradict the hand'); assert.ok(r.refused >= 10); assert.ok(r.codes.some((c) => /unexplained-change|inconsistent|seating|stack/.test(c)), r.codes.join(','));
  assert.ok(r.reason.length > 10, 'the reason is stated: ' + r.reason); assert.ok(r.resumed, 'play resumes'); assert.ok(['reconstruction-failure', 'chip-accounting', 'playing', 'waiting-turn', 'between-hands'].includes(r.gameplay.code));
  assert.ok((r.gameplay.episodes['reconstruction-failure'] || 0) + (r.gameplay.episodes['chip-accounting'] || 0) >= 1, JSON.stringify(r.gameplay.episodes));
});
test('M3 negative: duplicate cards are refused (invalid-card); no input', async () => {
  const r = await refusal('dupcards', (o) => { const h = o.seats.find((q) => q.cards); if (h) h.cards = [h.cards[0], h.cards[0]]; else if (o.board.length) o.board[o.board.length - 1] = o.board[0]; }, 'invalid-card');
  assert.equal(r.during, 0); assert.ok(r.codes.includes('invalid-card'), r.codes.join(',')); assert.ok(r.resumed);
});
test('M3 negative: a hand number that goes backwards is refused as a contradiction; no input', async () => {
  const r = await refusal('handno', (o) => { o.hand = Math.max(0, o.hand - 1); }, 'contradiction');
  assert.equal(r.during, 0); assert.ok(r.codes.some((c) => c === 'contradiction' || c === 'untracked-hand'), r.codes.join(',')); assert.match(r.reason + ' ' + r.codes.join(' '), /went backwards|contradiction|untracked/); assert.ok(r.resumed);
});
test('M3 negative: late capture frames (an older frame served again) never cause input', async () => {
  const R = rig(), { t, w, host } = R; let old = null, serveOld = false, arm = false, n0 = 0, r0 = 0;
  const run = t.run(Infinity, (r) => { if (arm && r.kind === 'acted' && r.entry && r.entry.status === 'confirmed') { arm = false; serveOld = true; n0 = inputs(host, w.hwnd); r0 = t.m.rejectedFrames; } });
  try {
    assert.ok(await until(() => t.m.confirmed >= 3, 30000)); old = { ...w.frame };   // remember a frame, then keep playing
    const c0 = t.m.confirmed; assert.ok(await until(() => t.m.confirmed >= c0 + 2, 20000));
    // late frames on the reading path (an action already in flight is confirmed from current frames, as in Milestone 2)
    const grab = t.capture.grab.bind(t.capture); t.capture.grab = async () => { if (serveOld && t._activeToken === null) { const keep = w.frame; w.frame = old; try { return await grab(); } finally { w.frame = keep; } } return grab(); };
    arm = true; assert.ok(await until(() => serveOld, 15000)); await sleep(600); serveOld = false;
    assert.equal(inputs(host, w.hwnd) - n0, 0, 'no input from a late frame'); assert.ok(t.m.rejectedFrames > r0, 'late frames refused');
    const c1 = t.m.confirmed; assert.ok(await until(() => t.m.confirmed > c1, 20000), 'play resumes with current frames');
  } finally { await finish(R, run); }
});
test('M3 negative: missing observations (no frame from capture) back off without input and recover', async () => {
  const R = rig(), { t, w, host } = R; let missing = 0, arm = false, on = false, n0 = 0;
  t.capture.inject = () => (on && missing < 5 && t._activeToken === null ? (missing++, { code: 'no-frame', reason: 'no frame (negative test)' }) : null);
  const run = t.run(Infinity, (r) => { if (arm && r.kind === 'acted' && r.entry && r.entry.status === 'confirmed') { arm = false; on = true; n0 = inputs(host, w.hwnd); } });
  try {
    assert.ok(await until(() => t.m.confirmed >= 2, 30000)); arm = true;
    assert.ok(await until(() => missing >= 5, 15000));
    assert.equal(inputs(host, w.hwnd) - n0, 0, 'no input without a reading'); assert.ok(t.gameplay.episodes['capture-unavailable'] >= 1, JSON.stringify(t.gameplay.episodes));
    const c1 = t.m.confirmed; assert.ok(await until(() => t.m.confirmed > c1, 20000), 'recovered'); assert.equal(t.lc.state, LC.STATES.ACTIVE);
  } finally { await finish(R, run); }
});
test('M3 negative: a stale action (the table changed between the decision and the click) is refused before any click', async () => {
  const R = rig(), { t, w, host } = R; let armed = false, injected = 0;
  const reval = t._revalidate.bind(t);
  t._revalidate = async (st, frame, token) => { if (armed && injected === 0) { injected++; w.dealer.onWindow({ type: 'action', control: w.dealer.legal().check ? 'check' : 'fold', wager: '', rev: w.dealer.rev }); } return reval(st, frame, token); };
  const run = t.run(Infinity);
  try {
    assert.ok(await until(() => t.m.confirmed >= 2, 30000)); const clicks0 = host.stats.clicks, log0 = t.log.length; armed = true;
    assert.ok(await until(() => injected === 1 && t.log.length > log0, 20000));
    const e = t.log[log0]; assert.notEqual(e.status, 'confirmed'); assert.match(e.reason || '', /fresh observation differs|changed|lease|revalid/i, 'reason: ' + e.reason);
    assert.equal(host.stats.clicks, clicks0, 'the stale decision never clicked'); assert.equal(w.dealer.counts.staleClicks, 0);
    const c1 = t.m.confirmed; assert.ok(await until(() => t.m.confirmed > c1, 20000), 'a fresh decision is made and confirmed');
  } finally { await finish(R, run); }
});
test('M3 negative: an invalid game state (acting seat shown folded / controls that contradict the rules) is refused', async () => {
  const r1 = await refusal('actorfolded', (o) => { o.seats[o.actor].folded = true; }, 'contradiction');
  assert.equal(r1.during, 0); assert.ok(r1.codes.length > 0); assert.ok(r1.resumed);
  const r2 = await refusal('controls', (o) => { if (o.controls) { o.controls.check = !o.controls.check; o.controls.call = !o.controls.call; } }, 'controls-disagree');
  assert.equal(r2.during, 0); assert.ok(r2.resumed);
});
