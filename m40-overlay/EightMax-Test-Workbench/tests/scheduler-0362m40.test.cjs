'use strict';
// 0.36.2 Milestone 4.0: the InputScheduler's scheduling POLICIES. A policy only chooses which queued job runs next; every safety rule of
// Milestone 3.2 holds under every policy (one lease at a time, emergency stop, pause, lost target, deadline at the configured speed,
// revalidation inside the lease, exactly one result per job), 'edf' is exactly the Milestone 3.2 order, and the reordering policies
// cannot starve a table (bounded bypass). Randomised with fixed seeds (deterministic).
const test = require('node:test'), assert = require('node:assert/strict');
const SCH = require('../src/input-scheduler.js'), TL = require('../src/action-timeline.js');
const POL = SCH.POLICIES, REORDER = ['lst', 'edf-aging', 'fair-rr', 'nearest-guarded'];
/** Await a scheduler promise while the virtual clock runs (the job's run() may sleep on it). */
async function settle(c, p, ms = 10000) { let done = false, v; p.then((x) => { done = true; v = x; }); for (let i = 0; i < 200 && !done; i++) await c.advance(ms / 200); return v; }
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
/** A virtual clock driven by the test (deterministic): sleep(ms) resolves when the clock passes it. */
const tick = () => new Promise((r) => setImmediate(r));   // lets every pending promise continuation run
function clock() { let t = 0; const timers = []; return { now: () => t, sleep: (ms) => new Promise((r) => timers.push({ at: t + ms, r })), async advance(ms) { const end = t + ms; await tick(); for (;;) { timers.sort((a, b) => a.at - b.at); const n = timers[0]; if (!n || n.at > end) break; timers.shift(); t = n.at; n.r(); await tick(); await tick(); } t = end; await tick(); } }; }

/** Drive a scheduler with random submissions from `tables` tables for `steps` virtual ms; returns the run log. */
async function drive(policy, seed, o = {}) {
  const r = rng(seed), c = clock(), sched = new SCH.InputScheduler({ now: c.now, policy, maxQueue: 16, maxBypass: o.maxBypass || 3, dispatchEstimate: true }), tables = o.tables || 6;
  let active = 0, maxActive = 0; const log = [], results = [], busy = new Set();
  const submitOne = (table) => {
    busy.add(table); const dist = o.far === table ? 2000 : r() * 400, est = 200 + dist / 2, deadline = c.now() + (o.window || 4000) + Math.floor(r() * 3) * 500;
    const job = { table, kind: 'call', deadline, estimateMs: est, estimateFrom: () => est, target: { x: dist, y: 0 }, timeline: new TL.ActionTimeline({ table }),
      revalidate: async () => { await c.sleep(10); return { ok: true }; },
      run: async () => { active++; maxActive = Math.max(maxActive, active); log.push({ table, at: c.now(), deadline }); await c.sleep(Math.round(est)); active--; return { input: { point: { x: dist, y: 0 } } }; } };
    sched.submit(job).then((res) => { results.push({ table, res, tl: job.timeline }); busy.delete(table); });
  };
  for (let step = 0; step < (o.steps || 400); step++) {
    for (let t = 1; t <= tables; t++) if (!busy.has(t) && r() < 0.5) submitOne(t);
    if (o.estopAt === step) sched.emergencyStop('test');
    if (o.resetAt === step) sched.reset();
    await c.advance(50);
  }
  await c.advance(20000);
  return { sched, log, results, maxActive };
}

test('M4.0 scheduler: edf is exactly the Milestone 3.2 order (deadline, then submission) for random job sets', async () => {
  for (let seed = 1; seed <= 20; seed++) {
    const c = clock(), s = new SCH.InputScheduler({ now: c.now, policy: 'edf', maxQueue: 16 }), r = rng(seed), order = [], jobs = [];
    // one long-running job holds the lease while the others queue; then the queue drains
    s.submit({ table: 0, deadline: 1e9, estimateMs: 0, run: () => c.sleep(100) });
    for (let t = 1; t <= 10; t++) { const d = 1000 + Math.floor(r() * 5) * 100; jobs.push({ t, d }); s.submit({ table: t, deadline: d, estimateMs: 0, run: async () => { order.push(t); } }); }
    await c.advance(1000);
    const expected = jobs.map((j, i) => ({ ...j, i })).sort((a, b) => a.d - b.d || a.i - b.i).map((j) => j.t);
    assert.deepEqual(order, expected, 'seed ' + seed);
  }
});

test('M4.0 scheduler: every policy keeps ONE lease at a time and gives every job exactly one result; timeline marks are ordered', async () => {
  for (const policy of POL) for (const seed of [3, 7, 11]) {
    const d = await drive(policy, seed);
    assert.equal(d.maxActive, 1, policy + ': never two leases at once');
    const m = d.sched.metrics(); assert.equal(m.submitted, d.results.length, policy + ': every submitted job resolved'); assert.equal(m.policy, policy);
    for (const { res, tl } of d.results) if (res.ok) { const a = tl.marks; assert.ok(a['enqueued'] <= a['lease-acquired'] && a['lease-acquired'] <= a['target-verified'] && a['target-verified'] <= a['lease-released'], policy + ': ordered marks ' + JSON.stringify(a)); }
    assert.ok(m.cursorUtilization > 0 && m.cursorUtilization <= 1.0001, policy + ' utilisation ' + m.cursorUtilization);
  }
});

test('M4.0 scheduler: the reordering policies cannot starve a table (bounded bypass), also a table whose target is always far away', async () => {
  for (const policy of REORDER) for (const seed of [5, 9]) {
    const d = await drive(policy, seed, { far: 3, tables: 6, maxBypass: 3 }), m = d.sched.metrics();
    assert.ok(m.fairness.maxBypass <= 3 + 6 - 1, policy + ': a job is passed over at most maxBypass + (tables - 1) times: ' + m.fairness.maxBypass);
    assert.ok((m.perTable[3] || {}).completed > 0, policy + ': the far table is served');
    const waits = Object.values(m.perTable).map((x) => x.maxWaitMs); assert.ok(Math.max(...waits) < 20000, policy + ': bounded waiting ' + Math.max(...waits));
  }
});

test('M4.0 scheduler: emergency stop under every policy rejects everything queued, cancels the running job, and nothing starts until reset', async () => {
  for (const policy of POL) {
    const c = clock(), cancelled = []; const s = new SCH.InputScheduler({ now: c.now, policy, maxQueue: 16, onCancel: (j) => cancelled.push(j.table) }); const started = [], res = [];
    for (let t = 1; t <= 5; t++) s.submit({ table: t, deadline: 1e9, estimateMs: 0, run: async () => { started.push(t); await c.sleep(100); } }).then((r) => res.push(r));
    await c.advance(10); s.emergencyStop('test'); await c.advance(200);   // the cancelled driver operation returns (here: its virtual 100 ms end)
    assert.equal(cancelled.length, 1, policy + ': the running job is cancelled'); assert.equal(res.filter((r) => r.code === 'emergency-stop').length, 4, policy + ': every queued job rejected');
    const after = await settle(c, s.submit({ table: 9, deadline: 1e9, estimateMs: 0, run: async () => started.push(9) })); assert.equal(after.code, 'emergency-stop', policy + ': refused until reset');
    s.reset(); const ok = await settle(c, s.submit({ table: 9, deadline: 1e9, estimateMs: 0, run: async () => { started.push(9); return 'ran'; } })); assert.equal(ok.ok, true); assert.deepEqual(started, [started[0], 9]);
  }
});

test('M4.0 scheduler: a job that cannot finish by its deadline at the configured speed is refused under every policy (never rushed)', async () => {
  for (const policy of POL) {
    const c = clock(), s = new SCH.InputScheduler({ now: c.now, policy, dispatchEstimate: true });
    const r = await s.submit({ table: 1, deadline: 500, estimateMs: 100, estimateFrom: () => 800, run: async () => 'ran' });
    assert.equal(r.code, 'deadline', policy + ': the dispatch-time estimate (800 ms) exceeds the 500 ms left');
    const r2 = await s.submit({ table: 2, deadline: 5000, estimateMs: 100, estimateFrom: () => 800, run: async () => 'ran' }); assert.equal(r2.ok, true);
  }
  const c = clock(), s = new SCH.InputScheduler({ now: c.now, policy: 'edf' });   // Milestone 3.2: the submission estimate
  const r = await s.submit({ table: 1, deadline: 500, estimateMs: 100, estimateFrom: () => 800, run: async () => 'ran' }); assert.equal(r.ok, true, 'without dispatchEstimate the submission estimate (100 ms) is used, as before');
});

test('M4.0 scheduler: a lost registration under every policy - its queued job is rejected, another table keeps its place, the running job of another table is not cancelled', async () => {
  for (const policy of POL) {
    const c = clock(), cancelled = [], s = new SCH.InputScheduler({ now: c.now, policy, onCancel: (j) => cancelled.push(j.table) }), res = {};
    s.registerTable(1, 'r1'); s.registerTable(2, 'r2'); s.registerTable(3, 'r3');
    for (const t of [1, 2, 3]) s.submit({ table: t, registrationId: 'r' + t, deadline: 1e9, estimateMs: 0, run: () => c.sleep(100) }).then((r) => { res[t] = r; });
    await c.advance(5); const running = s.status().running.table, lose = [1, 2, 3].find((t) => t !== running);
    const inv = s.invalidateTable(lose, 'closed', 'r' + lose); await c.advance(1000);
    assert.equal(inv.dropped, 1); assert.equal(inv.cancelledRunning, false); assert.deepEqual(cancelled, [], policy + ': the other table was not cancelled');
    assert.equal(res[lose].code, 'target-lost'); for (const t of [1, 2, 3]) if (t !== lose) assert.equal(res[t].ok, true, policy + ': table ' + t + ' completed');
    assert.equal((await settle(c, s.submit({ table: lose, registrationId: 'r' + lose, deadline: 1e9, run: async () => 1 }))).code, 'target-lost', 'the lost registration stays refused');
  }
});

test('M4.0 scheduler: nearest-guarded prefers the shortest input time but an urgent job (slack below urgentSlackMs) goes first', async () => {
  // slack when the cursor becomes free at t = 50 ms: deadline - 50 - estimate. Below urgentSlackMs (1000) -> urgent, served first.
  const run = async (urgentDeadline) => {
    const c = clock(), s = new SCH.InputScheduler({ now: c.now, policy: 'nearest-guarded', urgentSlackMs: 1000, dispatchEstimate: true }), order = [];
    s.submit({ table: 0, deadline: 1e9, estimateMs: 0, run: () => c.sleep(50) });
    s.submit({ table: 1, deadline: 100000, estimateMs: 900, estimateFrom: () => 900, run: async () => { order.push(1); await c.sleep(900); } });   // far, lots of time
    s.submit({ table: 2, deadline: 100000, estimateMs: 100, estimateFrom: () => 100, run: async () => { order.push(2); await c.sleep(100); } });   // near
    s.submit({ table: 3, deadline: urgentDeadline, estimateMs: 400, estimateFrom: () => 400, run: async () => { order.push(3); await c.sleep(400); } });
    await c.advance(5000); return { order, m: s.metrics() };
  };
  const a = await run(1300); assert.deepEqual(a.order, [3, 2, 1], 'slack 850 ms < 1000 ms: the urgent job first, then the nearest'); assert.ok(a.m.fairness.urgentPicks >= 1);
  const b = await run(1500); assert.deepEqual(b.order, [2, 3, 1], 'slack 1050 ms: not yet urgent - the nearest job first; 100 ms later the slack is 950 ms and it goes next');
});

test('M4.0 action timeline: intervals only from marks that exist; driver phases are placed between request and reply; aggregator statistics', () => {
  const t = new TL.ActionTimeline({ table: 1 }); t.mark('capture-queued', 0); t.mark('capture-begin', 2); t.mark('capture-end', 30); t.mark('capture-end', 99);
  assert.deepEqual(t.durations(), { captureQueueMs: 2, captureMs: 28 }, 'the first mark wins; no interval without both ends');
  assert.throws(() => t.mark('no-such-stage'), /Unknown timeline stage/);
  t.mark('enqueued', 40); t.mark('lease-acquired', 140); t.mark('target-verified', 150);
  const p = t.driverPhases(160, 560, { queueMs: 0, totalMs: 380, moveStartMs: 5, moveEndMs: 300, clickDoneMs: 370 }); assert.equal(p.transportMs, 20);
  assert.equal(t.at('move-begin'), 160 + 10 + 5); assert.equal(t.at('move-end'), 470); assert.equal(t.at('click-done'), 540);
  t.mark('driver-ack', 560); t.mark('lease-released', 561); t.mark('confirm-begin', 700); t.mark('state-confirmed', 850); t.mark('action-released', 851);
  const d = t.durations(); assert.equal(d.queueWaitMs, 100); assert.equal(d.revalidationMs, 10); assert.equal(d.moveMs, 295); assert.equal(d.leaseOccupancyMs, 421); assert.equal(d.settleOutsideMs, 139); assert.equal(d.schedulingDelayM32Ms, 110); assert.equal(d.actionLatencyMs, 820);
  const agg = new TL.TimelineAggregator(); agg.add(t, 'confirmed'); const s = agg.summary(); assert.equal(s.overall.actions, 1); assert.equal(s.overall.moveMs.p95, 295); assert.equal(s.perTable[1].leaseOccupancyMs.mean, 421); assert.equal(s.overall.driver.totalMs.mean, 380);
});
