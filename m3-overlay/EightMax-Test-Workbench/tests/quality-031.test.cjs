'use strict';
/* 0.31 mathematical accuracy and strategy quality: vectorised exact evaluation vs the independent per-deal evaluator, NashConv,
 * confidence intervals, quality classification (heads-up vs multiway never mixed), the quality ledger, the decision-time gate,
 * quality-targeted (adaptive) training, continued refinement, cancellation and native checkpoint continuation. */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const EM = require('./load-solver.cjs'), A = require('../src/study-adapter.js'), X = require('../src/exploitability.js'), FR = require('../src/fast-river.js');
const Q = require('../src/strategy-quality.js'), AT = require('../src/adaptive-training.js'), L = require('../src/strategy-library.js'), LS = require('../src/library-source.js'), SID = require('../src/strategy-identity.js'), SNAP = require('../src/strategy-snapshot.js');
const cli = process.env.EIGHTMAX_TEST_CLI && fs.existsSync(process.env.EIGHTMAX_TEST_CLI) ? process.env.EIGHTMAX_TEST_CLI : null;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'em031q-'));
const NARROW = { board: 'Kh9s5c3d2h', common: 10, stacks: [20, 20], ranges: Array(2).fill('TT+,AJs+,KTs+,QJs,AQo+,KQo'), streets: { river: { bets: '50,a', raises: 'a', maxBets: 2 } } };
const UNEVEN = { board: 'AsKs7d7c2h', common: 6, stacks: [9, 30], ranges: ['22+,A2s+,KTo+:0.5,QJs', 'TT+,ATs+,KQo'], streets: { river: { bets: '33,100', raises: 'a', maxBets: 3 } } };

test('exact exploitability: vectorised evaluator equals the independent per-deal evaluator (two games, 1e-9)', () => {
  for (const cfg of [NARROW, UNEVEN]) {
    const p = A.prepare(EM, { config: cfg, iterations: 10 }); p.game.iterate(800);
    const a = X.exact(p.game, p.spec), b = FR.exact(p.game, p.spec);
    for (let i = 0; i < 2; i++) { assert.ok(Math.abs(a.values[i] - b.values[i]) < 1e-9); assert.ok(Math.abs(a.bestResponses[i] - b.bestResponses[i]) < 1e-9); }
    assert.ok(Math.abs(a.exploitability - b.exploitability) < 1e-9); assert.ok(b.exploitability > 0);
  }
});

test('reference CFR+: vectorised and per-deal implementations follow the same trajectory and converge', () => {
  const p = A.prepare(EM, { config: NARROW, iterations: 1 }), s = X.cfrPlus(p.game, p.spec, 60), f = FR.prepare(p.game, p.spec).cfrPlus(60);
  assert.ok(Math.abs(s.exploitability - f.exploitability) < 1e-9); assert.ok(Math.abs(s.values[0] - f.values[0]) < 1e-9);
  const long = FR.prepare(p.game, p.spec).cfrPlus(400, { every: 100 }); assert.ok(long.exploitability < 0.01); assert.ok(long.curve[3].exploitability <= long.curve[0].exploitability);
});

test('NashConv for a three-player river is exact and is never reported as a two-player exploitability', () => {
  const cfg = { board: 'Qd8c5h4s2c', common: 9, stacks: [20, 20, 20], ranges: ['TT+,AQs+', '99+,AJs+,KQs', '88+,ATs+'], streets: { river: { bets: '50', raises: 'a', maxBets: 1 } } };
  const p = A.prepare(EM, { config: cfg, iterations: 10 }); p.game.iterate(500);
  const e = X.exact(p.game, p.spec); assert.equal(e.exploitability, null); assert.ok(e.nashConv >= -1e-9); assert.ok(Math.abs(e.gains.reduce((a, b) => a + b, 0) - e.nashConv) < 1e-9);
  const g = SNAP.decode(SNAP.encode(SNAP.exportStreet(p, { EM }))), ev = Q.evaluateSnapshot(g, { street: 'river', potBB: 9 });
  assert.equal(ev.type, 'exact'); assert.equal(ev.players, 3); assert.equal(ev.exploitabilityBB, undefined); assert.ok(Math.abs(ev.nashConvBB - e.nashConv) < 1e-9);
  const c = Q.classify(ev, 'research'); assert.equal(c.measureKind, 'nashconv'); assert.match(c.reason, /NashConv/);
});

test('quality classification: heads-up exploitability and multiway NashConv use separate thresholds', () => {
  const hu = (x) => ({ type: 'exact', players: 2, potBB: 10, exploitabilityBB: x }), mw = (x) => ({ type: 'exact', players: 3, potBB: 10, nashConvBB: x });
  assert.equal(Q.classify(hu(0.09), 'research').status, 'validated'); assert.equal(Q.classify(hu(0.11), 'research').status, 'failed-quality-check');
  assert.equal(Q.classify(hu(0.06), 'strict').status, 'failed-quality-check');
  assert.equal(Q.classify(mw(0.2), 'research').status, 'validated');             // 2% of pot NashConv: within the multiway 2.5% limit
  assert.equal(Q.classify({ type: 'exact', players: 3, potBB: 10, exploitabilityBB: 0.01 }, 'research').status, 'unverified');   // no NashConv -> not validated
  assert.equal(Q.classify({ type: 'none' }).status, 'unverified'); assert.equal(Q.classify({ type: 'restricted' }).status, 'restricted-evaluation');
  assert.equal(Q.classify({ type: 'sampled', players: 2, potBB: 10, exploitabilityBB: 0.05, ci95: [0.03, 0.07] }, 'research').status, 'estimated');
  assert.equal(Q.classify({ type: 'sampled', players: 2, potBB: 10, exploitabilityBB: 0.5, ci95: [0.4, 0.6] }, 'research').status, 'failed-quality-check');
  assert.equal(Q.classify({ type: 'sampled', players: 2, potBB: 10, exploitabilityBB: 0.05 }, 'research').status, 'unverified');   // no interval
  const bb = Q.policyOf({ base: 'research', headsUp: { maxExploitabilityBB: 0.05 } }); assert.equal(Q.classify(hu(0.07), bb).status, 'failed-quality-check');
  assert.throws(() => Q.policyOf({ headsUp: { maxExploitabilityPctPot: -1 } })); assert.throws(() => Q.policyOf('nonsense'));
});

test('quality gate: decision use accepts only the policy\'s statuses; simulation experiments may use labelled unverified strategies', () => {
  for (const [st, dec, sim] of [['validated', true, true], ['unverified', false, true], ['failed-quality-check', false, false], ['estimated', false, true]]) {
    assert.equal(Q.gate({ status: st }, 'research', { use: 'decision' }).allowed, dec, st); assert.equal(Q.gate({ status: st }, 'research', { use: 'simulation-experiment' }).allowed, sim, st);
  }
  assert.equal(Q.gate({ status: 'failed-quality-check' }, 'off', { use: 'decision' }).allowed, true);
  assert.match(Q.gate({ status: 'unverified', reason: 'x' }, 'strict', { use: 'decision' }).reason, /refused by the quality gate/);
});

test('quality ledger: entries are bound to the exact record bytes; stale and damaged entries are ignored; decisions are reproducible', () => {
  const dir = tmp(), led = new Q.QualityLedger(dir), fp = 'a'.repeat(64), sha1 = 'b'.repeat(64), sha2 = 'c'.repeat(64);
  const doc = Q.qualityDocument({ fingerprint: fp, recordRawSha256: sha1, identity: { street: 'river', players: 2, potBB: 10 }, evaluation: { type: 'exact', players: 2, potBB: 10, exploitabilityBB: 0.08 }, policy: 'research' });
  led.add(doc); assert.equal(led.latest(fp, sha1).status, 'validated'); assert.equal(led.latest(fp, sha2), null);
  assert.throws(() => led.add({ ...doc, recordRawSha256: null }), /exact record bytes/);
  const header = { fingerprint: fp, payload: { rawSha256: sha1 } }, q1 = Q.qualityOf(header, led, 'research'), q2 = Q.qualityOf(header, led, 'strict');
  assert.equal(q1.status, 'validated'); assert.equal(q2.status, 'failed-quality-check'); assert.deepEqual(Q.qualityOf(header, new Q.QualityLedger(dir), 'research').status, q1.status);
  fs.writeFileSync(led.file(fp), '{damaged'); assert.deepEqual(new Q.QualityLedger(dir).history(fp), []); assert.equal(Q.qualityOf(header, new Q.QualityLedger(dir), 'research').status, 'unverified');
});

test('statistical summaries: t-based 95% interval over seeds', () => {
  const T = require('../tools/math-validation-031.cjs'), s = T.stat([1, 2, 3, 4, 5]);
  assert.equal(s.mean, 3); assert.ok(Math.abs(s.sd - Math.sqrt(2.5)) < 1e-6); assert.ok(Math.abs(s.ci95[1] - (3 + 2.776 * Math.sqrt(2.5) / Math.sqrt(5))) < 1e-5);
});

test('adaptive training (heads-up river, full-width CFR+): stops at the target, is validated from the stored bytes, and stores its quality', () => {
  const sp = LS.spotFromParams({ street: 'river', board: ['Kh', '9s', '5c', '3d', '2h'].map(SID.cardId), stacksBehind: [20, 20], pot: 10, ranges: NARROW.ranges }, { ranges: NARROW.ranges, training: AT.trainingPolicy({ policy: 'research', trainer: 'vector-cfr-plus' }), abstraction: SID.ABSTRACTION_FULL_WIDTH });
  return AT.trainAdaptive(sp.spot, { policy: 'research' }).then((r) => {
    assert.equal(r.training.stoppedBecause, 'quality-target-met'); assert.equal(r.quality.status, 'validated'); assert.ok(r.quality.evaluation.exploitabilityBB <= 0.1 * 0.8 + 1e-12);
    const dir = tmp(), lib = L.StrategyLibrary.open(dir); lib.put(sp.identity, r.body, { status: 'complete', training: r.training, quality: r.quality });
    const got = lib.get(sp.identity, sp.fingerprint); assert.ok(got.ok); assert.equal(got.header.quality.status, 'validated'); assert.equal(got.header.quality.recordRawSha256, got.header.payload.rawSha256);
    const re = Q.evaluateRecord(lib, sp.fingerprint, { policy: 'research' }); assert.equal(re.status, 'validated'); assert.ok(Math.abs(re.evaluation.exploitabilityBB - r.quality.evaluation.exploitabilityBB) < 1e-12);
    assert.equal(lib.status().byQuality.validated, 1); assert.notEqual(sp.identity.training.iterations, 20000); assert.equal(sp.identity.training.mode, 'quality-target-v1');
  });
});

test('adaptive training (EightMax JavaScript engine): measures after each doubling block and reports why it stopped', async () => {
  const sp = LS.spotFromParams({ street: 'river', board: ['Kh', '9s', '5c', '3d', '2h'].map(SID.cardId), stacksBehind: [20, 20], pot: 10, ranges: NARROW.ranges }, { ranges: NARROW.ranges, training: AT.trainingPolicy({ policy: 'strict', trainer: 'eightmax-js' }) });
  const r = await AT.trainAdaptive(sp.spot, { trainer: 'eightmax-js', policy: 'strict', initialUpdates: 500, maxUpdates: 4000, maxTimeMs: 60000 });
  assert.ok(r.training.curve.length >= 2); assert.ok(r.training.curve.every((c) => c.measureBB !== null)); assert.ok(['quality-target-met', 'update-limit', 'improvement-stalled', 'time-limit'].includes(r.training.stoppedBecause));
  if (r.training.stoppedBecause !== 'quality-target-met') assert.notEqual(r.quality.status, 'validated');
  assert.ok(r.training.curve[1].stabilityL1 !== null); assert.equal(r.training.curve[0].updates * 2, r.training.curve[1].updates);
});

test('a completed training job is not automatically validated: a flop study stays unverified', async () => {
  const sp = LS.spotFromParams({ street: 'flop', board: ['Kh', '9s', '5c'].map(SID.cardId), stacksBehind: [10, 10], pot: 4, ranges: ['QQ+,AKs', 'JJ+,AQs+'] }, { ranges: ['QQ+,AKs', 'JJ+,AQs+'], training: AT.trainingPolicy({ trainer: 'eightmax-js' }), streets: { flop: { bets: '50', raises: 'a', maxBets: 1 }, turn: { bets: '50', raises: 'a', maxBets: 1 }, river: { bets: '50', raises: 'a', maxBets: 1 } } });
  const r = await AT.trainAdaptive(sp.spot, { trainer: 'eightmax-js', initialUpdates: 300, maxUpdates: 1200, maxTimeMs: 60000 });
  assert.equal(r.quality.status, 'unverified'); assert.equal(r.quality.evaluation.type, 'none'); assert.ok(r.quality.limitations.some((l) => /later-street/.test(l) || /flop/.test(l)));
});

test('training cancellation: an aborted signal stops adaptive training with code cancelled and nothing is returned for storage', async () => {
  const sp = LS.spotFromParams({ street: 'river', board: ['Kh', '9s', '5c', '3d', '2h'].map(SID.cardId), stacksBehind: [20, 20], pot: 10, ranges: NARROW.ranges }, { ranges: NARROW.ranges, training: AT.trainingPolicy({ trainer: 'eightmax-js' }) });
  const ac = new AbortController(); ac.abort();
  await assert.rejects(AT.trainAdaptive(sp.spot, { trainer: 'eightmax-js', signal: ac.signal, initialUpdates: 200 }), (e) => e.code === 'cancelled');
});

test('continued refinement replaces a record only with a better one and keeps the old bytes in superseded/', async () => {
  const dir = tmp(), lib = L.StrategyLibrary.open(dir);
  const sp = LS.spotFromParams({ street: 'river', board: ['Kh', '9s', '5c', '3d', '2h'].map(SID.cardId), stacksBehind: [20, 20], pot: 10, ranges: NARROW.ranges }, { ranges: NARROW.ranges, training: AT.trainingPolicy({ trainer: 'eightmax-js' }) });
  const a = await AT.trainAdaptive(sp.spot, { trainer: 'eightmax-js', initialUpdates: 300, maxUpdates: 300 }); lib.put(sp.identity, a.body, { status: 'complete', training: a.training, quality: a.quality });
  const b = await AT.trainAdaptive(sp.spot, { trainer: 'eightmax-js', initialUpdates: 300, maxUpdates: 2400 });
  assert.ok(b.quality.evaluation.exploitabilityBB < a.quality.evaluation.exploitabilityBB);
  lib.put(sp.identity, b.body, { status: 'complete', training: b.training, quality: b.quality, replace: true });
  const got = lib.get(sp.identity, sp.fingerprint); assert.ok(got.ok); assert.equal(got.header.training.iterations, b.training.iterations);
  assert.equal(fs.readdirSync(path.join(dir, 'superseded')).length, 1); assert.equal(lib.put(sp.identity, b.body, { status: 'complete' }).duplicate, true);
});

test('precompute queue: quality-targeted jobs store quality; Continue Training refines from the stored identity', { skip: !cli && 'native engine (EIGHTMAX_TEST_CLI) required' }, async () => {
  const { PrecomputeQueue } = require('../src/precompute.js'), dir = tmp(), lib = L.StrategyLibrary.open(dir);
  const sp = LS.spotFromParams({ street: 'river', board: ['Qd', '8c', '5h', '4s', '2c'].map(SID.cardId), stacksBehind: [20, 20, 20], pot: 9, ranges: ['TT+,AQs+', '99+,AJs+,KQs', '88+,ATs+'] }, { ranges: ['TT+,AQs+', '99+,AJs+,KQs', '88+,ATs+'], training: AT.trainingPolicy({ trainer: 'eightmax-native' }) });
  const q = new PrecomputeQueue({ library: lib, cli, concurrency: 1, workerThreads: true, adaptiveMaxUpdates: 40000, adaptiveMaxTimeMs: 30000, keepCheckpoints: true, qualityPolicy: 'strict' });
  q.enqueue(sp.spot, { reason: 'test' }); q.start(); await q.drain();
  const st = lib.get(sp.identity, sp.fingerprint); assert.ok(st.ok); assert.ok(['validated', 'failed-quality-check'].includes(st.header.quality.status)); assert.equal(st.header.quality.evaluation.players, 3);
  const job = q.enqueueRefinement(sp.fingerprint, { maxUpdates: 160000 }); assert.equal(job.refine, true); q.start(); await q.drain(); q.close();
  const after = L.StrategyLibrary.open(dir).get(sp.identity, sp.fingerprint); assert.ok(after.ok);
  assert.ok(after.header.quality.evaluation.nashConvBB <= st.header.quality.evaluation.nashConvBB + 1e-12);
  assert.throws(() => new PrecomputeQueue({ library: lib }).enqueueRefinement('f'.repeat(64)), (e) => e.code === 'not-stored');
});

test('native checkpoint continuation: adaptive training resumes from a kept checkpoint instead of starting again', { skip: !cli && 'native engine (EIGHTMAX_TEST_CLI) required' }, async () => {
  const work = tmp(), sp = LS.spotFromParams({ street: 'river', board: ['Kh', '9s', '5c', '3d', '2h'].map(SID.cardId), stacksBehind: [20, 20], pot: 10, ranges: NARROW.ranges }, { ranges: NARROW.ranges, training: AT.trainingPolicy({ trainer: 'eightmax-native' }) });
  const a = await AT.trainAdaptive(sp.spot, { cli, trainer: 'eightmax-native', workDir: work, keepWork: true, initialUpdates: 5000, maxUpdates: 10000, policy: 'strict' });
  assert.equal(a.training.iterations, 10000); assert.ok(fs.existsSync(path.join(work, 'checkpoint.state')));
  const b = await AT.trainAdaptive(sp.spot, { cli, trainer: 'eightmax-native', workDir: work, keepWork: true, initialUpdates: 5000, maxUpdates: 40000, policy: 'strict' });
  assert.equal(b.training.resumedFrom, 10000); assert.ok(b.training.iterations >= 20000); assert.ok(b.quality.evaluation.exploitabilityBB < a.quality.evaluation.exploitabilityBB);
});

test('precompute queue: pausing while jobs are still queued lets drain() resolve (time budgets, Ctrl+C)', async () => {
  const { PrecomputeQueue } = require('../src/precompute.js'), lib = L.StrategyLibrary.open(tmp()), q = new PrecomputeQueue({ library: lib, concurrency: 1, persist: false });
  for (const b of ['2s', '3s', '4s']) { const sp = LS.spotFromParams({ street: 'river', board: ['As', 'Kd', '7h', '5c', b].map(SID.cardId), stacksBehind: [10, 10], pot: 4 }, { iterations: 200, trainerName: 'javascript-reference-cpu' }); q.enqueue(sp.spot, { reason: 'test' }); }
  let done = 0; q.on((ev) => { if (ev.type === 'complete') { done++; q.pause(); } }); q.start();
  let tm; const r = await Promise.race([q.drain().then(() => 'drained'), new Promise((res) => { tm = setTimeout(() => res('hung'), 60000); })]); clearTimeout(tm);   // 0.36.2 M3: timer cleared (it kept this test file alive 60 s)
  assert.equal(r, 'drained'); assert.equal(done, 1); assert.equal(q.status().counts.queued, 2); q.close();
});
