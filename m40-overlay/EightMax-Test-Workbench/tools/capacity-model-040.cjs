#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 4.0: CAPACITY MODEL of the single-cursor input pipeline (ten-table feasibility).
 *
 *   node tools/capacity-model-040.cjs --runs <result.json>[,<result.json>...] [--tables 1-12] [--seed 40] [--minutes 30] [--out FILE]
 *
 * Inputs are MEASURED reports of tools/gameplay-acceptance-0362m3.cjs (stability / sustained suites, Windows CI or the operator's PC).
 * Nothing here is a measurement; every output is a prediction from measured inputs, and the model is first checked against the runs
 * it was given (predicted vs measured throughput and queue wait at the table counts that were run).
 *
 * 1. CLOSED QUEUEING MODEL (every seat played through the window - the stress workload): N tables, ONE server (the cursor lease) with
 *    the measured lease time S, and a delay station Z (settle, confirmation, next capture, recognition, decision) derived from the
 *    measured cycle per table: Z = C - W - S, C = N x 60 000 / (actions per minute). Exact mean-value analysis (MVA) for 1..N tables.
 * 2. DISCRETE-EVENT SIMULATION (one hero seat per table, the dealer plays the other seats - the realistic workload) that drives the REAL
 *    InputScheduler (src/input-scheduler.js, any policy, on a virtual clock) with service times drawn from the measured lease-time
 *    quantiles (piecewise-linear inverse CDF) and the measured time between a confirmed hero action and the hero's next turn. Output per
 *    table count: response time (wait + lease) mean / p95 / p99, the share of decisions that miss a decision window (6.5 s = the CI
 *    action clock minus the 1.5 s margin, 12 s, 15 s), cursor utilisation, and decisions refused by the scheduler's deadline check.
 * The highest SUSTAINABLE table count is the largest N with p99 response < window and at most 0.1 % of decisions late (per window). A count is
 * only called VALIDATED when a sustained real-Windows run at that count exists (the report lists which runs exist).
 */
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const SCH = require(path.join(ROOT, 'src/input-scheduler.js'));
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const r2 = (v, d = 1) => (Number.isFinite(v) ? +v.toFixed(d) : null);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const q = (xs, p) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]; };

/** Inverse CDF from reported quantiles {min?, p50, p90, p95, p99, max} (piecewise linear; the minimum defaults to 0.6 x the median). */
function sampler(st, r) {
  const pts = [[0, st.min !== undefined && st.min !== null ? st.min : 0.6 * st.p50], [0.5, st.p50], [0.9, st.p90 !== undefined ? st.p90 : st.p95], [0.95, st.p95], [0.99, st.p99 !== undefined ? st.p99 : st.max], [1, st.max]].filter((p) => Number.isFinite(p[1]));
  for (let i = 1; i < pts.length; i++) if (pts[i][1] < pts[i - 1][1]) pts[i][1] = pts[i - 1][1];
  return () => { const u = r(); for (let i = 1; i < pts.length; i++) if (u <= pts[i][0]) { const [a, va] = pts[i - 1], [b, vb] = pts[i]; return va + (vb - va) * (u - a) / (b - a); } return pts[pts.length - 1][1]; };
}
/** Measured inputs from one report: per scenario (table count) the lease, the queue wait, throughput and the workload. */
function measured(file) {
  const d = JSON.parse(fs.readFileSync(file, 'utf8')), out = [];
  for (const s of d.scenarios || []) {
    const m = s.metrics || {}, ms = m.measurements || {}, m40 = ms.m40 || {}, sc = m40.scheduler || {}, tl = m40.timeline || {}, iv = (tl.intervals || tl) || {};
    const lease = sc.leaseMs || (iv.leaseOccupancyMs || null), qw = sc.queueWaitMs || (iv.queueWaitMs || null);
    out.push({ file: path.basename(file), suite: d.suite, pipeline: d.pipeline || m40.pipeline, policy: d.policy || m40.policy, id: s.id, status: s.status, tables: m.tables, seconds: m.seconds, hero: !!(m40.workload && m40.workload.heroSeats),
      confirmed: m.actionsConfirmed, actionsPerMinute: m.seconds ? 60 * m.actionsConfirmed / m.seconds : null, lease, queueWait: qw, schedulingDelay: ms.schedulingDelayMs || null, latency: ms.actionLatencyMs || null,
      utilization: sc.cursorUtilization === undefined ? null : sc.cursorUtilization, misses: (ms.deadlineMisses || {}).byTables, heroTimeouts: m.heroTimeouts === undefined ? null : m.heroTimeouts, incorrect: m.incorrectActions });
  }
  return out;
}
/** Exact MVA for one queueing server (S) and a delay station (Z): throughput X(n) [per ms], response R(n), queue Q(n). */
function mva(S, Z, N) { const res = []; let Qn = 0; for (let n = 1; n <= N; n++) { const R = S * (1 + Qn), X = n / (R + Z); Qn = X * R; res.push({ tables: n, actionsPerMinute: X * 60000, responseMs: R, queueWaitMs: R - S, utilization: Math.min(1, X * S) }); } return res; }

/** A deterministic virtual clock (the scheduler tests use the same pattern). */
function vclock() {
  let t = 0; const timers = []; const tick = () => new Promise((r) => setImmediate(r));
  return { now: () => t, sleep: (ms) => new Promise((r) => timers.push({ at: t + Math.max(0, ms), r })),
    async run(until) { for (;;) { await tick(); timers.sort((a, b) => a.at - b.at); const n = timers[0]; if (!n || n.at > until) { t = until; return; } timers.shift(); t = n.at; n.r(); } } };
}
/** One simulated workload on the REAL InputScheduler. o: {tables, minutes, policy, lease (quantiles), gap (quantiles), windowMs, seed}. */
async function simulate(o) {
  const r = rng(o.seed), c = vclock(), sched = new SCH.InputScheduler({ now: c.now, policy: o.policy || 'edf', maxQueue: 16, dispatchEstimate: true });
  const lease = sampler(o.lease, r), gap = sampler(o.gap, r), leaseMean = o.lease.mean || o.lease.p50, end = o.minutes * 60000, resp = [], refusedByDeadline = { n: 0 }; let busy = 0, last = 0, decisions = 0;
  const table = async (id) => {
    await c.sleep(r() * 3000);
    while (c.now() < end) {
      await c.sleep(gap()); if (c.now() >= end) break;
      const t0 = c.now(), deadline = t0 + o.windowMs; decisions++;
      const res = await sched.submit({ table: id, kind: 'call', deadline, estimateMs: leaseMean, estimateFrom: () => leaseMean, target: { x: r() * 800, y: 0 },
        run: async () => { const s = lease(); if (busy === 0) last = c.now(); busy++; await c.sleep(s); busy--; o.busyMs = (o.busyMs || 0) + s; return { input: {} }; } });
      if (!res || !res.ok) { if (/deadline/i.test((res && res.reason) || '')) refusedByDeadline.n++; resp.push(Infinity); continue; }
      resp.push(c.now() - t0);
    }
  };
  const all = []; for (let i = 1; i <= o.tables; i++) all.push(table(i)); const done = Promise.all(all); await c.run(end + 60000); await Promise.race([done, Promise.resolve()]);
  void last; const finite = resp.filter(Number.isFinite), late = (w) => resp.filter((x) => !(x <= w)).length / Math.max(1, resp.length);
  return { tables: o.tables, policy: o.policy, decisions, responseMs: { mean: r2(finite.reduce((a, b) => a + b, 0) / Math.max(1, finite.length), 0), p50: r2(q(finite, 0.5), 0), p95: r2(q(finite, 0.95), 0), p99: r2(q(finite, 0.99), 0), max: r2(Math.max(0, ...finite), 0) },
    refusedByDeadline: refusedByDeadline.n, missRate: { w6500: r2(late(6500), 4), w12000: r2(late(12000), 4), w15000: r2(late(15000), 4) }, utilization: r2(Math.min(1, (o.busyMs || 0) / end), 3), actionsPerMinute: r2(finite.length / o.minutes, 1) };
}

async function main() {
  const files = (arg('runs', '') || '').split(',').filter(Boolean), N = Number(String(arg('tables', '1-12')).split('-').pop()), minutes = Number(arg('minutes', '30')), seed = Number(arg('seed', '40'));
  const OUT = arg('out', path.join(ROOT, 'reports', 'capacity-model-040.json'));
  const runs = files.flatMap((f) => measured(f)), out = { format: 'eightmax-capacity-model', version: 1, milestone: '0.36.2-milestone-4.0', tool: 'tools/capacity-model-040.cjs', at: new Date().toISOString(), note: 'predictions from measured inputs; not measurements', inputs: runs, closedModel: [], heroModel: [] };
  // 1. closed model per pipeline from the all-seats runs: S = mean lease at the largest table count, Z from the measured cycle
  for (const pipe of [...new Set(runs.filter((x) => !x.hero).map((x) => x.pipeline))]) {
    const all = runs.filter((x) => !x.hero && x.pipeline === pipe && x.lease && x.actionsPerMinute > 0).sort((a, b) => a.tables - b.tables); if (!all.length) continue;
    // fitted on uninterrupted (sustained) play when such a run exists: the stability workload's injected faults and replaced tournaments add pauses no queue model describes
    const rs = all.filter((x) => x.suite === 'sustained').length ? all.filter((x) => x.suite === 'sustained') : all, big = rs[rs.length - 1], S = big.lease.mean, C = big.tables * 60000 / big.actionsPerMinute, W = big.queueWait ? big.queueWait.mean : 0, Z = Math.max(0, C - W - S);
    const pred = mva(S, Z, N).map((p) => ({ ...p, actionsPerMinute: r2(p.actionsPerMinute), responseMs: r2(p.responseMs, 0), queueWaitMs: r2(p.queueWaitMs, 0), utilization: r2(p.utilization, 3) }));
    const check = all.map((m) => { const p = pred[m.tables - 1]; return { tables: m.tables, measuredActionsPerMinute: r2(m.actionsPerMinute), predictedActionsPerMinute: p && p.actionsPerMinute, measuredQueueWaitMs: m.queueWait ? r2(m.queueWait.mean, 0) : null, predictedQueueWaitMs: p && p.queueWaitMs, file: m.file, id: m.id }; });
    out.closedModel.push({ pipeline: pipe, serviceMs: r2(S, 0), delayMs: r2(Z, 0), fittedOn: big.file + ' ' + big.id, saturationActionsPerMinute: r2(60000 / S), prediction: pred, checkAgainstMeasured: check });
  }
  // 2. hero workload: lease quantiles from the measured runs; the time from a confirmed hero action to the hero's next turn from the hero
  //    runs if present (cycle - response), else the fixture's design (7 other seats x 0.8 s think + dealing): stated in the output
  for (const pipe of [...new Set(runs.map((x) => x.pipeline))]) {
    const hero = runs.filter((x) => x.pipeline === pipe && x.hero && x.actionsPerMinute > 0).sort((a, b) => a.tables - b.tables)[0];
    // the lease times of the hero workload itself when measured (more raises with typed wagers than the all-seats workload)
    const src = hero && hero.lease && hero.lease.p50 ? hero : runs.filter((x) => x.pipeline === pipe && x.lease && x.lease.p50).sort((a, b) => b.tables - a.tables)[0]; if (!src) continue;
    let gap, gapSource;
    if (hero) { const C = hero.tables * 60000 / hero.actionsPerMinute, R = (hero.queueWait ? hero.queueWait.mean : 0) + hero.lease.mean, g = Math.max(500, C - R); gap = { p50: g, p90: g * 1.5, p95: g * 1.8, p99: g * 2.5, max: g * 4, min: g * 0.35, mean: g }; gapSource = 'measured cycle of ' + hero.file + ' ' + hero.id + ' minus its response'; }
    else { gap = { min: 2400, p50: 5600, p90: 8200, p95: 9400, p99: 12000, max: 16000, mean: 5800 }; gapSource = 'fixture design (7 other seats x 0.8 s + dealing): NO hero run was given'; }
    const lease = { ...src.lease }; const rows = [];
    // each decision window is simulated with that window as the job deadline (the scheduler refuses an action that cannot finish by then)
    const WINDOWS = [6500, 12000, 15000];
    for (const policy of (arg('policies', 'edf,fair-rr')).split(',')) for (const windowMs of WINDOWS) for (let n = 1; n <= N; n++) rows.push({ windowMs, ...(await simulate({ tables: n, minutes, policy, lease, gap, windowMs, seed: seed + n })) });
    const sustainable = (w, pol) => { let best = 0; for (const x of rows.filter((y) => y.policy === pol && y.windowMs === w)) if (x.responseMs.p99 !== null && x.responseMs.p99 < w && x.missRate['w' + w] <= 0.001) best = Math.max(best, x.tables); else break; return best; };
    out.heroModel.push({ pipeline: pipe, leaseFrom: src.file + ' ' + src.id, leaseMs: lease, gapMs: { p50: r2(gap.p50, 0), mean: r2(gap.mean, 0) }, gapSource, minutes, rows,
      highestSustainable: Object.fromEntries((arg('policies', 'edf,fair-rr')).split(',').map((pol) => [pol, { w6500: sustainable(6500, pol), w12000: sustainable(12000, pol), w15000: sustainable(15000, pol) }])) });
  }
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  for (const m of out.closedModel) console.log('closed model ' + m.pipeline + ': S ' + m.serviceMs + ' ms, Z ' + m.delayMs + ' ms, saturation ' + m.saturationActionsPerMinute + '/min; check ' + m.checkAgainstMeasured.map((c) => c.tables + 't ' + c.measuredActionsPerMinute + ' vs ' + c.predictedActionsPerMinute).join(', '));
  for (const h of out.heroModel) console.log('hero model ' + h.pipeline + ' (' + h.gapSource + '): highest sustainable ' + JSON.stringify(h.highestSustainable));
  console.log('-> ' + OUT);
}
if (require.main === module) main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
module.exports = { mva, simulate, sampler, measured };
