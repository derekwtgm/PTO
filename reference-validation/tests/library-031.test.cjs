'use strict';
/* 0.31 decision path: quality gate on stored strategies, ledger-driven reproducible gate decisions, on-demand heads-up river
 * solving, exact matching still the default, the dedicated strategy service (v2 shared cache) under concurrency / corruption /
 * timeouts, and a ten-table simulated pipeline with the library + gate (no stale or duplicate actions). */
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { Worker } = require('node:worker_threads');
const L = require('../src/strategy-library.js'), LS = require('../src/library-source.js'), Q = require('../src/strategy-quality.js'), AT = require('../src/adaptive-training.js'), SID = require('../src/strategy-identity.js'), HS = require('../src/hand-state.js');
const SC = require('../src/shared-strategy-cache.js'), D = require('../src/strategy-directory.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'em031l-')), cards = (s) => s.match(/../g);
function riverRequest(over = {}) {
  const board = cards('AsKd7h4c2s').map(HS.cardFromString), sb = Array(8).fill(0); sb[1] = 1000; sb[2] = 1000;
  const live = Array(8).fill(false); live[1] = live[2] = true;
  const seatsState = Array.from({ length: 8 }, (_, i) => ({ stack: live[i] ? 1000 : 2400, bet: 0, total: 0, folded: !live[i] }));
  return { format: 'eightmax-decision-request', version: 1, table: 3, hand: 17, revision: 5, stateKey: 'k', street: 'river', actor: 1, button: 0, holeCards: [HS.cardFromString('Qh'), HS.cardFromString('Jh')], board, actions: [],
    stacks: Array(8).fill(2500), toCall: 0, priority: 1, deadlineMs: 2000, pot: 400, currentBet: 0, blinds: { sb: 50, bb: 100, ante: 10 }, seatsState, streetStart: { pot: 400, behind: sb, live },
    legal: { toCall: 0, callAmount: 0, canCheck: true, canCall: false, canFold: false, canRaise: true, minRaiseTo: 100, maxRaiseTo: 1000 }, ...over };
}
const adaptiveOpts = { training: ({ street, players }) => (street === 'river' && players === 2 ? AT.trainingPolicy({ trainer: 'vector-cfr-plus' }) : undefined), abstraction: ({ training }) => (training && training.trainer === 'vector-cfr-plus' ? SID.ABSTRACTION_FULL_WIDTH : undefined) };

test('quality-targeted Study Mode stores a VALIDATED heads-up river; decision use accepts it and reports its quality', async () => {
  const dir = tmp(), study = new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'study', ...adaptiveOpts });
  const d1 = await study.decide(riverRequest()); assert.equal(d1.status, 'ok', d1.reason); assert.equal(d1.quality.status, 'validated'); assert.equal(d1.strategyConfidence, 'validated');
  const dec = new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'decision', qualityUse: 'decision', ...adaptiveOpts });
  const d2 = await dec.decide(riverRequest()); assert.equal(d2.status, 'ok'); assert.equal(d2.strategySource, 'library-disk'); assert.equal(d2.convergence.verdict,'within-target'); assert.equal(d2.convergence.scope,'stored-game-only'); assert.deepEqual(d2.probabilities, d1.probabilities); assert.equal(d2.quality.source, 'record-header');
  assert.equal(d2.ranges.model, 'any-two-cards-v1'); assert.equal(dec.info().qualityByStatus.validated, 1);
});

test('the gate refuses a strategy that FAILED its quality check, for decisions and for simulation; policy "off" restores 0.30 behaviour', async () => {
  const dir = tmp(), lib = L.StrategyLibrary.open(dir);
  const study = new LS.LibraryDecisionSource({ library: lib, mode: 'study', iterations: 300, trainerName: 'javascript-reference-cpu', qualityPolicy: 'off' });
  const d0 = await study.decide(riverRequest()); assert.equal(d0.status, 'ok'); assert.equal(d0.quality.status, 'unverified');
  const fp = d0.libraryFingerprint, doc = Q.evaluateRecord(lib, fp, { policy: 'research' }); assert.equal(doc.status, 'failed-quality-check', 'a 300-update any-two-cards river is far from equilibrium');
  for (const use of ['decision', 'simulation-experiment']) { const src = new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'decision', iterations: 300, trainerName: 'javascript-reference-cpu', qualityUse: use }); const d = await src.decide(riverRequest()); assert.equal(d.status, 'unavailable', use); assert.equal(d.code, 'quality-gate'); assert.equal(d.quality.status, 'failed-quality-check'); assert.equal(d.probabilities, undefined); assert.equal(src.stats.qualityRejected, 1); }
  const off = new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'decision', iterations: 300, trainerName: 'javascript-reference-cpu', qualityPolicy: 'off', qualityUse: 'decision' });
  assert.equal((await off.decide(riverRequest())).status, 'ok');
  // reproducible: the same ledger + policy gives the same gate result in a fresh process-equivalent source
  const again = new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'decision', iterations: 300, trainerName: 'javascript-reference-cpu' }); assert.equal((await again.decide(riverRequest())).code, 'quality-gate');
});

test('an UNVERIFIED strategy is usable only in labelled simulation experiments, never silently promoted', async () => {
  const dir = tmp(); await new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'study', iterations: 300, trainerName: 'javascript-reference-cpu' }).decide(riverRequest());
  const sim = await new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'decision', iterations: 300, trainerName: 'javascript-reference-cpu' }).decide(riverRequest());
  assert.equal(sim.status, 'ok'); assert.equal(sim.quality.status, 'unverified'); assert.ok(sim.warnings.some((w) => /Unverified/.test(w)));
  const dec = await new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'decision', iterations: 300, trainerName: 'javascript-reference-cpu', qualityUse: 'decision' }).decide(riverRequest());
  assert.equal(dec.code, 'quality-gate'); assert.equal(L.StrategyLibrary.open(dir).status().byQuality.unverified, 1);
});

test('on-demand heads-up river: a miss in Decision Mode is solved exactly in the decision and labelled "solved-on-demand"', async () => {
  const src = new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(tmp()), mode: 'decision', inlineHeadsUpRiver: true, inlineRiverMaxMs: 5000, qualityUse: 'decision', ...adaptiveOpts });
  const d = await src.decide(riverRequest()); assert.equal(d.status, 'ok', d.reason); assert.equal(d.strategySource, 'solved-on-demand'); assert.equal(d.quality.status, 'validated'); assert.equal(src.stats.solvedOnDemand, 1);
  const turn = await src.decide(riverRequest({ street: 'turn', board: cards('AsKd7h4c').map(HS.cardFromString) })); assert.equal(turn.code, 'library-miss', 'only heads-up rivers are solved on demand');
});

test('exact matching remains the default: one chip of difference is a different study, never substituted', async () => {
  const dir = tmp(); await new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'study', ...adaptiveOpts }).decide(riverRequest());
  const r = riverRequest(); r.streetStart.behind[2] = 999; r.seatsState[2].stack = 999;
  const d = await new LS.LibraryDecisionSource({ library: L.StrategyLibrary.open(dir), mode: 'decision', ...adaptiveOpts }).decide(r); assert.equal(d.code, 'library-miss');
});

async function buildLib(n) {
  const dir = tmp(), lib = L.StrategyLibrary.open(dir), ids = [];
  for (let i = 0; i < n; i++) { const sp = LS.spotFromParams({ street: 'river', board: ['As', 'Kd', '7h', '4c', ['2s', '3s', '5s', '6s', '8s'][i]].map(SID.cardId), stacksBehind: [10, 10], pot: 4 }, { iterations: 200, trainerName: 'javascript-reference-cpu' }); const r = await LS.trainSpot(sp.spot, {}); lib.put(sp.identity, r.body, { status: 'complete', training: r.training }); ids.push(sp); }
  return { dir, ids };
}
test('strategy service (v2): exact identity served from shared memory; directory answers misses without a round trip', async () => {
  const { dir, ids } = await buildLib(2), svc = new SC.SharedStrategyService(dir); await svc.ready();
  const c = new SC.SharedStrategyClientV2(svc.port(), svc.descriptor());
  const hit = c.fetchSync(ids[0].fingerprint, ids[0].identity); assert.ok(hit && hit.game && hit.header.fingerprint === ids[0].fingerprint); assert.ok(hit.game.shared); assert.ok(hit.ms < 1000);
  const wrong = { ...ids[0].identity, potBB: 4.01 }; assert.equal(c.fetchSync(ids[0].fingerprint, wrong), null, 'identity mismatch is never served');
  assert.equal(c.fetchSync('0'.repeat(64), ids[0].identity), null); assert.equal(c.stats.directoryMisses, 1);
  const info = await svc.infoAsync(); assert.equal(info.directoryEntries, 2); assert.equal(info.requests, 2); await svc.close();
});

test('strategy service (v2): four threads fetch concurrently and all read the same bytes; memory is shared once', async () => {
  const { dir, ids } = await buildLib(3), svc = new SC.SharedStrategyService(dir); await svc.ready();
  const code = `const { workerData, parentPort } = require('node:worker_threads'); const SC = require(${JSON.stringify(path.join(__dirname, '../src/shared-strategy-cache.js'))});
    const c = SC.SharedStrategyClient.fromWorker(); let ok = 0, sum = 0; for (let i = 0; i < 150; i++) { const s = workerData.ids[i % workerData.ids.length]; const r = c.fetchSync(s.fp, s.id); if (r) { ok++; sum += r.game.probs[3] + r.game.meta.rows; } } parentPort.postMessage({ ok, sum, v2: c instanceof SC.SharedStrategyClientV2 });`;
  const res = await Promise.all([1, 2, 3, 4].map(() => new Promise((resolve, reject) => { const port = svc.port(); const w = new Worker(code, { eval: true, workerData: { libraryPort: port, libraryService: svc.descriptor(), ids: ids.map((x) => ({ fp: x.fingerprint, id: x.identity })) }, transferList: [port] }); w.on('message', resolve); w.on('error', reject); })));
  assert.ok(res.every((r) => r.v2 && r.ok === 150)); assert.equal(new Set(res.map((r) => r.sum)).size, 1);
  const info = await svc.infoAsync(); assert.equal(info.sharedRecords, 3); assert.equal(info.served, 600); await svc.close();
});

test('strategy service (v2): a corrupted record is refused (checksum) and never served; a silent service times out as a miss', async () => {
  const { dir, ids } = await buildLib(1), lib = L.StrategyLibrary.open(dir), f = lib.file(ids[0].fingerprint), b = fs.readFileSync(f); b[b.length - 9] ^= 0xff; fs.writeFileSync(f, b);
  const svc = new SC.SharedStrategyService(dir); await svc.ready(); const c = new SC.SharedStrategyClientV2(svc.port(), svc.descriptor());
  assert.equal(c.fetchSync(ids[0].fingerprint, ids[0].identity), null); const info = await svc.infoAsync(); assert.equal(info.refused + info.misses, 1); await svc.close();
  const { MessageChannel } = require('node:worker_threads'), ch = new MessageChannel(), dd = D.Directory.create(64); dd.add(ids[0].fingerprint);
  const silent = new SC.SharedStrategyClientV2(ch.port2, { directory: dd.sab }, { timeoutMs: 120 }); const t0 = Date.now();
  assert.equal(silent.fetchSync(ids[0].fingerprint, ids[0].identity), null); assert.equal(silent.stats.timeouts, 1); assert.ok(Date.now() - t0 < 2000); ch.port1.close(); ch.port2.close();
});

test('strategy directory: lock-free set semantics, no false negatives for stored keys, capacity guard', () => {
  const d = D.Directory.create(16), fps = Array.from({ length: 12 }, (_, i) => SID.sha256Hex('k' + i));
  for (const f of fps) assert.ok(d.add(f)); for (const f of fps) assert.ok(d.has(f)); assert.equal(d.has(SID.sha256Hex('other')), false); assert.equal(d.count(), 12);
  assert.ok(d.nearlyFull()); assert.equal(d.add(SID.sha256Hex('overflow')), false);
  const r = new D.Directory(d.sab); assert.ok(r.has(fps[5]));
});

test('ten simulated tables with the library, the quality gate and the v2 service: all hands complete, no stale or duplicate actions', async () => {
  const { dir } = await buildLib(1), svc = new SC.SharedStrategyService(dir); await svc.ready();
  const groups = [[1, 2, 3], [4, 5, 6], [7, 8], [9, 10]];
  const parts = await Promise.all(groups.map((g, gi) => new Promise((resolve, reject) => { const port = svc.port(); const w = new Worker(path.join(__dirname, '../tools/pipeline-worker.cjs'), { workerData: { job: { tables: g, hands: 2, seed: 77, workerId: gi + 1, collectActions: true, solver: { kind: 'postflop-only', library: { dir, mode: 'decision', shared: true, quality: { policy: 'research', use: 'decision' } } } }, libraryPort: port, libraryService: svc.descriptor() }, transferList: [port] }); w.on('message', (m) => (m.ok ? resolve(m.result) : reject(new Error(m.error)))); w.on('error', reject); })));
  const reps = parts.flatMap((p) => p.reports); await svc.close();
  assert.equal(reps.length, 10); assert.equal(reps.reduce((n, r) => n + r.completed, 0), 20);
  for (const r of reps) { assert.equal(r.totals.staleDecisions, 0); assert.equal(r.totals.ackMismatches, 0); }
  assert.ok(parts.every((p) => p.library && p.library.qualityPolicy === 'research'));
});
