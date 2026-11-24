'use strict';
// 0.36.2 Milestone 4.0: where a decision deadline starts (src/simulator-controls.js option deadlineAnchor).
//  'frame' (the default for every pipeline = Milestone 3.2): from the capture the decision was read from.
//  'change' (only for a table with its own action clock - the one-hero test workload): from the REQUEST of the last capture that still
//  showed the previous status-strip revision. The change (a turn that began) happened after that capture, so the deadline can never start
//  after the change - a late first reading of a turn no longer gets a deadline beyond a table clock that started with the turn. Not the
//  default: on a table WITHOUT a clock a decision refused for its deadline would be refused on every reading of the unchanged revision.
// Either way every decision records how long before its reading the table had changed (changeAgeMs).
// In-process fake desktop host (as tests/simulator-controls-035.test.cjs): the captures return the fixture dealer's rendered frames.
const test = require('node:test'), assert = require('node:assert/strict');
const SC = require('../src/simulator-controls.js'), SP = require('../src/simulator-profiles.js'), SCH = require('../src/input-scheduler.js'), FD = require('../src/fixture-dealer.js'), XA = require('../src/execution-adapters.js'), G = require('../src/input-geometry.js');
const TOKEN = 'a'.repeat(64), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), mono = () => performance.now();

function fakeHost(o = {}) {
  const client = { x: 70, y: 50, w: 960, h: 600 }, t = { client, frame: null, field: '', hwnd: '0x1000', revAt: new Map() };
  t.dealer = new FD.TableDealer({ table: 1, seed: 101, handGapMs: 50, send: (m) => { if (m.type === 'frame') { t.frame = m; if (!t.revAt.has(m.rev)) t.revAt.set(m.rev, mono()); } } });
  t.dealer.onWindow({ type: 'ready', client, hwnd: t.hwnd });
  const reply = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
  async function fetch(url, init) {
    const path = url.replace('http://127.0.0.1:48713', ''), body = init.body ? JSON.parse(init.body) : {};
    if (init.headers['X-EightMax-Session'] !== TOKEN) return { ok: false, status: 403, text: async () => '{"error":"session"}' };
    if (path === '/api/capture/open' || path === '/api/capture/close') return reply({ ok: true });
    if (path === '/api/capture/frame') { await sleep(o.captureMs || 2); const f = t.frame; return reply({ ok: true, width: f.w, height: f.h, png: f.png, bounds: { x: client.x, y: client.y, width: client.w, height: client.h }, title: 'EightMax Test Table 01' + f.title, frameId: f.rev }); }
    if (path !== '/api/input/command') return reply({ ok: false, error: 'unknown' });
    switch (body.cmd) {
      case 'arm': case 'disarm': case 'cancel-all': case 'status': return reply({ ok: true, stats: {} });
      case 'window-info': return reply({ ok: true, window: { hwnd: t.hwnd, pid: 1, processStart: '1', className: 'WindowsForms10.Window.8.app.0.EightMaxTestTable', client, minimized: false } });
      case 'move-click': case 'enter-text': {
        await sleep(5); const nx = (body.to.x - client.x) / client.w, ny = (body.to.y - client.y) / client.h, hit = Object.entries({ ...FD.CONTROLS, wager: FD.WAGER_FIELD }).find(([, b]) => nx >= b.x && ny >= b.y && nx < b.x + b.w && ny < b.y + b.h);
        if (body.cmd === 'enter-text') { t.field = body.text; return reply({ ok: true, verified: true, read: body.text, plannedMs: 5, actualMs: 6 }); }
        if (hit) t.dealer.onWindow({ type: 'action', control: hit[0], wager: t.field, rev: t.dealer.rev });
        return reply({ ok: true, plannedMs: 5, actualMs: 6, steps: 1, clickedAt: body.to, drained: true });
      }
    }
    return reply({ ok: false, code: 'unknown-command', error: body.cmd });
  }
  return { t, fetch };
}
async function play(pipeline, o = {}) {   // o.anchor: deadlineAnchor option (undefined = the default)
  const host = fakeHost(o), api = new SC.HostApi({ token: TOKEN, fetch: host.fetch }), session = SC.hostSession(api), sched = new SCH.InputScheduler({ maxQueue: 8 });
  const auth = SC.authorizations({ environment: 'fake-host-test', approvedBy: 'unit test', exeFileName: 'EightMaxTestTable.exe', exeSha256: 'c'.repeat(64) }), profile = SP.fixtureProfile({ exeSha256: 'c'.repeat(64) });
  const W = 10000, t = new SC.SimulatorTable({ id: 1, window: { hwnd: host.t.hwnd, pid: 1, title: 'EightMax Test Table 01', client: host.t.client }, profile, api, session, scheduler: sched, qaAuthorization: auth.qa, recorder: new XA.DiagnosticsRecorder({ max: 5000 }), allowScripted: true, seed: 3, timing: { postClickSettleMs: 0 }, pipeline,
    options: { decisionWindowMs: W, pollMs: 5, idlePollMs: 5, postActionTimeoutMs: 800, ...(o.anchor ? { deadlineAnchor: o.anchor } : {}) } });
  const decisions = [], deadlines = [], anchor = t._deadlineAnchor.bind(t), submit = sched.submit.bind(sched);
  t._deadlineAnchor = (f) => { const a = anchor(f); decisions.push({ at: f.at, changedAfterAt: f.changedAfterAt, revision: f.strip ? f.strip.revision : null, anchor: a }); return a; };
  sched.submit = (job) => { deadlines.push(job.deadline); return submit(job); };
  await t.capture.open();
  const end = mono() + 20000; while (!t.stopped && t.m.confirmed < (o.actions || 8) && mono() < end) { const r = await t.step(); if (r.kind === 'paused') break; if (r.kind !== 'acted') await sleep(o.idleMs || 5); }
  t.stop('test end'); t.dispose(); host.t.dealer.dispose();
  return { t, host, decisions, deadlines, W };
}

test('deadlineAnchor change: every decision deadline starts at the last capture that still showed the previous revision - before the change itself', async () => {
  const r = await play('optimized', { captureMs: 25, anchor: 'change' });
  assert.ok(r.t.m.confirmed >= 8, 'confirmed ' + r.t.m.confirmed); assert.equal(r.decisions.length, r.deadlines.length, 'one submission per decision');
  const later = r.decisions.slice(1); assert.ok(later.length >= 7);
  for (const [i, d] of r.decisions.entries()) {
    assert.equal(r.deadlines[i], d.anchor + r.W, 'the deadline is the anchor plus the decision window');
    if (i === 0) continue;   // the very first reading has no earlier revision to bound it
    assert.ok(Number.isFinite(d.changedAfterAt), 'decision ' + i + ': the previous revision was seen'); assert.equal(d.anchor, d.changedAfterAt);
    assert.ok(d.anchor < d.at, 'the anchor is earlier than the decision frame');
    const changed = r.host.t.revAt.get(d.revision); assert.ok(Number.isFinite(changed), 'the dealer showed revision ' + d.revision);
    assert.ok(d.anchor <= changed, 'decision ' + i + ': the deadline started ' + (d.anchor - changed).toFixed(1) + ' ms after the table changed');
  }
  const rep = r.t.report(); assert.equal(rep.deadlineAnchor, 'change'); assert.ok(rep.deadlineAnchorSlackMs && rep.deadlineAnchorSlackMs.n >= 7, JSON.stringify(rep.deadlineAnchorSlackMs)); assert.ok(rep.changeAgeMs.n >= 7);
});

for (const pipeline of ['compat-3.2', 'optimized']) test(pipeline + ' default: exactly Milestone 3.2 - the deadline starts at the decision frame; the change age is still measured', async () => {
  const r = await play(pipeline, { captureMs: 25 });
  assert.ok(r.t.m.confirmed >= 8, 'confirmed ' + r.t.m.confirmed);
  let after = 0;
  for (const [i, d] of r.decisions.entries()) { assert.equal(d.anchor, d.at, 'anchor = decision frame'); assert.equal(r.deadlines[i], d.at + r.W); const changed = r.host.t.revAt.get(d.revision); if (Number.isFinite(changed) && d.anchor > changed) after++; }
  assert.ok(after >= r.decisions.length - 1, 'the Milestone 3.2 deadline starts after the change it is for: ' + after + '/' + r.decisions.length);
  const rep = r.t.report(); assert.equal(rep.deadlineAnchor, 'frame'); assert.equal(rep.deadlineAnchorSlackMs.n || 0, 0); assert.ok(rep.changeAgeMs.n >= r.decisions.length - 1, JSON.stringify(rep.changeAgeMs));
});

test('deadlineAnchor change: a late first reading of a change does not move the deadline later (the table clock started with the change)', async () => {
  // every reading takes 120 ms: the change is first seen long after it happened; the deadline must still start before the change
  const r = await play('optimized', { captureMs: 120, actions: 5, anchor: 'change' });
  assert.ok(r.t.m.confirmed >= 5, 'confirmed ' + r.t.m.confirmed);
  for (const d of r.decisions.slice(1)) { const changed = r.host.t.revAt.get(d.revision); assert.ok(d.anchor <= changed, (d.anchor - changed).toFixed(1) + ' ms after the change'); assert.ok(d.at - changed > 100, 'the reading came late (the test condition)'); }
});
