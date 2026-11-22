'use strict';
/* EightMax Test Workbench 0.30: decision source backed by the persistent strategy library, and the one training routine
 * used by both the background precompute queue and (only when a policy explicitly allows it) the decision path.
 *
 * Decision sequence (lookup first; training is never started implicitly):
 *   1 request received  2 observation validated (validateRequest upstream + street-start chips here)  3 legal actions present
 *   4 exact identity + fingerprint  5 in-memory cache  6 persistent record  7 identity / engine / integrity re-checked
 *   8 tree walk of this street's betting history with exact pot / stacks / live-player / legality checks (TreeStudy)
 *   9 freshness is checked by the caller (SolverService revision + decision stamps)  10 decision returned with its source.
 * A miss returns status 'unavailable', code 'library-miss', the missing configuration, and is logged for training.
 *
 * Modes:
 *   'decision'  (default) lookup only. Misses are unavailable; optionally queued for background training (onMiss).
 *   'deadline'  lookup; on a miss, train inline ONLY if the measured training-time estimate for that player count fits the
 *               request's remaining deadline (with a safety factor) and fewer than maxInlineTraining runs are active.
 *   'study'     lookup; on a miss, train inline (no deadline) and store. This is the 0.29 behaviour plus persistence.
 */
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const SID = require('./strategy-identity.js'), SNAP = require('./strategy-snapshot.js'), ST = require('./solver-tree.js'), HS = require('./hand-state.js'), Q = require('./strategy-quality.js'), AL = require('./approximate-lookup.js');

const ENGINE = Object.freeze({ version: '5.1', build: '7d08acc7eb4577ee' });
const DEFAULT_BLINDS = Object.freeze({ sb: 50, bb: 100, ante: 10 });
/** 0.30 tree profile by player count. Heads-up and three-way pots keep the 0.29 menus; larger pots use fewer sizes because the
 * number of decision nodes (and the time to train and snapshot them) grows steeply with players: measured on a 5-way flop,
 * the 0.29 menus give 1,305 nodes (snapshot export 9.7 s), one size with two bets 655 nodes (4.4 s), one size with one bet 80 nodes (1.1 s). */
const COMPACT2 = Object.freeze({ flop: { bets: '50', raises: 'a', maxBets: 2 }, turn: { bets: '50', raises: 'a', maxBets: 2 }, river: { bets: '50', raises: 'a', maxBets: 2 } });
const COMPACT1 = Object.freeze({ flop: { bets: '50', raises: 'a', maxBets: 1 }, turn: { bets: '50', raises: 'a', maxBets: 1 }, river: { bets: '50', raises: 'a', maxBets: 1 } });
function treeProfile030(players) { return players <= 3 ? ST.DEFAULT_STREETS : players === 4 ? COMPACT2 : COMPACT1; }
/** 0.30 library range model. 0.29 added the hero's own hand to a fixed range for every decision, which made every study unique to
 * one hand and therefore never reusable. A reusable study needs a range that does not depend on the hero's cards. Measured in the
 * simulator (seed 4127, 60 hands): with the 0.29 range 29 of 42 postflop decisions were "hand not in range", because hands that
 * reach the flop at 25 bb are much wider. The library therefore models every live player with ALL hands ("random"). This is a
 * deliberately uninformative MODEL ASSUMPTION, not an observed or equilibrium range; deriving ranges from the preflop study is a
 * listed 1.0 item. Callers can pass range / rangeModel / rangeModelName; the identity records whichever is used. */
const LIBRARY_RANGE = 'random', LIBRARY_RANGE_MODEL = 'any-two-cards-v1';
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
const num2 = (chips) => +(chips / 100).toFixed(2);

/** Situation of a street start, from a decision request. Same rules as 0.29's PostflopStudySource.context, without anything hand-specific. */
function streetContext(req, o = {}) {
  const ss = req.streetStart; if (!ss || !Array.isArray(ss.behind) || ss.behind.length !== 8) return { error: 'Request lacks the street-start chip counts', code: 'invalid-observation' };
  if (req.street === 'preflop' || req.board.length < 3) return { error: 'Not a postflop state', code: 'street-not-covered' };
  if (!req.legal) return { error: 'Request lacks the legal-action description', code: 'invalid-observation' };
  const live = []; for (let k = 1; k <= 8; k++) { const s = (req.button + k) % 8; if (ss.live[s]) live.push(s); }
  if (live.length < 2) return { error: 'Fewer than two live players at the start of the street', code: 'unsupported-state' };
  const maxP = o.maxPlayers || 6;
  if (live.length > maxP) return { error: 'Postflop studies support at most ' + maxP + ' live players (' + live.length + ' are live)', code: 'player-count-unsupported' };
  if (live.some((s) => ss.behind[s] <= 0)) return { error: 'A live player was already all-in at the start of the street; side-pot trees are not mapped', code: 'unsupported-state' };
  const behind = live.map((s) => num2(ss.behind[s]));
  if (behind.some((b) => b < 2 || b > 250)) return { error: 'Stacks behind outside the 2-250 bb the study builder supports (' + behind.join('/') + ' bb)', code: 'stakes-or-stack-mismatch' };
  if (req.seatsState && req.seatsState.some((p, i) => p.stack === 0 && !p.folded && !live.includes(i))) return { error: 'Unmapped all-in player', code: 'unsupported-state' };
  if (req.actions.some((a) => a.street === undefined)) return { error: 'Postflop mapping needs each action tagged with its street', code: 'invalid-observation' };
  return { live, behind, pot: num2(ss.pot) };
}

/** Everything needed to train (and to identify) the study for this street start. */
function spotFor(req, ctx, o) {
  // 0.31: o.rangeOverride = { texts, name } from the derived range model (src/range-model.js)
  const ranges = o.rangeOverride ? o.rangeOverride.texts.slice() : ctx.live.map((s, i) => (o.rangeModel ? o.rangeModel({ seat: s, order: i, players: ctx.live.length, req }) : o.range));
  return spotFromParams({ street: req.street, board: req.board, stacksBehind: ctx.behind, pot: ctx.pot, blinds: req.blinds || DEFAULT_BLINDS, ranges, rangeModelName: o.rangeOverride ? o.rangeOverride.name : undefined }, o);
}
/** Spot from explicit parameters (used by the catalogue generator and tests). o: engine, range|ranges, rangeModelName, streets, iterations, trainerName */
function spotFromParams(p, o) {
  o = { engine: ENGINE, range: LIBRARY_RANGE, rangeModelName: LIBRARY_RANGE_MODEL, streets: treeProfile030, iterations: 20000, trainerName: 'native-cli-cpu', ...o };
  const n = p.stacksBehind.length, ranges = p.ranges || Array(n).fill(o.range);
  const streets = typeof o.streets === 'function' ? o.streets(n) : o.streets;
  // 0.31: o.training (quality-target policy) replaces the fixed update count in the identity; o.abstraction names a full-width trainer.
  const training = typeof o.training === 'function' ? o.training({ street: p.street, players: n }) : o.training;
  const abstraction = typeof o.abstraction === 'function' ? o.abstraction({ street: p.street, players: n, training }) : o.abstraction;
  const built = SID.postflopIdentity({ engine: o.engine, blinds: p.blinds || DEFAULT_BLINDS, street: p.street, board: p.board, stacksBehind: p.stacksBehind, pot: p.pot, ranges, rangeModel: p.rangeModelName || (p.ranges && o.rangeModel ? 'custom' : o.rangeModelName), streets, iterations: o.iterations, threads: 1, trainer: o.trainerName, training, abstraction });
  const config = { board: built.identity.board, common: built.identity.potBB, stacks: built.identity.stacksBehindBB, ranges, streets: JSON.parse(JSON.stringify(streets)), privateSeed: SID.seedOf(built.identity) };
  return { ...built, spot: { fingerprint: built.fingerprint, identity: built.identity, config, iterations: training ? null : o.iterations, training: training || null, street: p.street, players: n } };
}

/**
 * Train one spot and return a validated snapshot body. Native engine when `cli` is given (chunked, checkpointed, resumable),
 * otherwise the JavaScript reference engine. Never returns a partial study: anything short of the full update count throws
 * with a code ('memory-limited', 'cancelled', 'timeout', 'native-failed', ...).
 * o: EM, adapter, cli, threads, memoryMiB, workDir (checkpoints), chunkUpdates, signal, onProgress(done,total), timeoutMs
 */
async function trainSpot(spot, o) {
  const A = o.adapter || require('./study-adapter.js'), EM = o.EM || require('../tests/load-solver.cjs');
  const t0 = Date.now(), prepared = A.prepare(EM, { config: spot.config, iterations: spot.iterations, timeMs: 600000 });
  const chunk = Math.max(1, o.chunkUpdates || spot.iterations), fail = (code, msg) => { const e = new Error(msg); e.code = code; throw e; };
  let backend, chunks = 0, resumedFrom = 0, peakRss = null;
  if (o.cli) {
    const NT = require('../tools/native-training.cjs');
    const dir = o.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'em-lib-')); fs.mkdirSync(dir, { recursive: true });
    const specFile = path.join(dir, 'spec.json'), ckpt = path.join(dir, 'checkpoint.state'), progressFile = path.join(dir, 'progress.json');
    fs.writeFileSync(specFile, JSON.stringify(A.nativeJob(prepared, spot.fingerprint.slice(0, 12)).spec));
    let done = 0;
    if (fs.existsSync(ckpt)) { try { done = NT.headerOf(ckpt).iterations; resumedFrom = done; } catch (e) { fs.rmSync(ckpt, { force: true }); done = 0; } }
    while (done < spot.iterations) {
      if (o.signal && o.signal.aborted) fail('cancelled', 'Training cancelled');
      const target = Math.min(spot.iterations, done + chunk);
      let r; try { r = await NT.trainNative({ cli: o.cli, specFile, updates: target, budgetMiB: o.memoryMiB || 512, threads: o.threads || 1, outFile: ckpt, resumeFrom: done > 0 ? ckpt : null, timeoutMs: o.timeoutMs || 600000, signal: o.signal }); }
      catch (e) { fail(e.code || 'native-failed', e.message); }
      if (r.run.status !== 'complete') fail(r.run.status, r.run.reason || 'Native training incomplete');
      done = r.run.updatesDone; chunks++; peakRss = Math.max(peakRss || 0, r.run.processPeakRssMiB || 0);
      fs.writeFileSync(progressFile, JSON.stringify({ fingerprint: spot.fingerprint, done, total: spot.iterations, at: Date.now() }));
      if (o.onProgress) o.onProgress(done, spot.iterations);
      if (o.faultAfterChunk && chunks >= o.faultAfterChunk) fail('simulated-interruption', 'Simulated interruption after chunk ' + chunks);
    }
    prepared.game.importNative(fs.readFileSync(ckpt)); backend = 'native-cli-cpu';
    if (!o.keepWork) fs.rmSync(dir, { recursive: true, force: true });
  } else {
    while (prepared.game.iterations < spot.iterations) {
      if (o.signal && o.signal.aborted) fail('cancelled', 'Training cancelled');
      prepared.game.iterate(Math.min(chunk, spot.iterations - prepared.game.iterations)); chunks++;
      if (prepared.game.limitReached) fail('memory-limited', 'JavaScript strategy budget filled after ' + prepared.game.iterations + ' updates');
      if (o.onProgress) o.onProgress(prepared.game.iterations, spot.iterations);
      await new Promise((r) => setImmediate(r));
    }
    backend = 'javascript-reference-cpu';
  }
  if (prepared.game.iterations !== spot.iterations) fail('invalid', 'Study has ' + prepared.game.iterations + ' of ' + spot.iterations + ' updates');
  const te = Date.now(), snap = SNAP.exportStreet(prepared, { EM }), body = SNAP.encode(snap);
  if (snap.meta.playerNodes < 1) fail('invalid', 'Exported study has no decision node');
  SNAP.decode(body);   // round-trip check before anything is stored
  // 0.32: o.linked exports the continuation strategies of every later street (src/linked-study.js) next to the street snapshot
  let linked = null, linkedError = null; if (o.linked && spot.street !== 'river') { try { linked = require('./linked-study.js').exportLinked(prepared, { EM, fingerprint: spot.fingerprint, identity: spot.identity, maxBytes: o.linkedMaxBytes || (256 << 20) }); } catch (e) { linkedError = e.message; } }
  return { body, meta: snap.meta, linked, training: { backend, iterations: spot.iterations, chunks, resumedFrom, trainMs: te - t0, exportMs: Date.now() - te, processPeakRssMiB: peakRss, threads: o.threads || 1, ...(o.linked ? { linkedBytes: linked ? linked.length : 0, linkedError } : {}) } };
}

/** Running estimate of training time per player count (median of the last 32 measurements), used by the deadline policy. */
class TrainingEstimator {
  constructor(seed = {}) { this.samples = new Map(Object.entries(seed).map(([k, v]) => [+k, [v]])); }
  add(players, ms) { const a = this.samples.get(players) || []; a.push(ms); if (a.length > 32) a.shift(); this.samples.set(players, a); }
  estimate(players) { const a = this.samples.get(players); if (!a || !a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
}

class LibraryDecisionSource {
  /**
   * options: library (StrategyLibrary), mode ('decision'|'deadline'|'study'), iterations (default 8000), range, rangeModel, streets,
   *   EM, adapter, cli, threads, memoryMiB, onMiss(spot, req) (e.g. enqueue for background training), estimator, maxInlineTraining,
   *   deadlineSafety (default 0.5: use at most half of the remaining deadline), sharedClient (cross-thread cache), maxPlayers
   */
  constructor(o) {
    if (!o || !o.library) throw new Error('A strategy library is required');
    this.o = { mode: 'decision', iterations: 20000, range: LIBRARY_RANGE, rangeModelName: LIBRARY_RANGE_MODEL, streets: treeProfile030, engine: ENGINE, threads: 1, maxInlineTraining: 1, deadlineSafety: 0.5, trainerName: 'native-cli-cpu', ...o };
    if (!['decision', 'deadline', 'study'].includes(this.o.mode)) throw new Error('Unknown library mode ' + this.o.mode);
    this.lib = o.library; this.estimator = o.estimator || new TrainingEstimator(); this.inflight = new Map(); this.inlineActive = 0;
    // 0.31 quality gate: policy (strategy-quality.js presets or custom) and use ('simulation-experiment' for the simulator,
    // 'decision' for Authorized QA execution). 'off' restores the 0.30 behaviour (no gate).
    this.qualityPolicy = Q.policyOf(this.o.qualityPolicy || Q.DEFAULT_POLICY); this.qualityUse = this.o.qualityUse || 'simulation-experiment';
    this.ledger = this.o.qualityLedger === false ? null : (this.o.qualityLedger || (this.lib.dir ? new Q.QualityLedger(this.lib.dir) : null));
    this.rangeModel = this.o.rangeModelEngine || null;
    // 0.32: approximation policy - 'exact' (default: none), 'chip-scale', 'validated-approximations', or an explicit list of VALIDATED mappings
    const ap = this.o.approximationPolicy || 'exact'; this.approximations = Array.isArray(ap) ? ap.slice() : (AL.POLICIES[ap] || (() => { throw new Error('Unknown approximation policy ' + ap); })()).slice();
    for (const m of this.approximations) if (!AL.VALIDATED[m]) throw new Error('Mapping ' + m + ' is not validated and cannot be enabled');   // src/range-model.js LibraryRangeModel (derived ranges), or null for the fixed model
    this.stats = { asked: 0, ok: 0, unavailable: 0, memoryHits: 0, diskHits: 0, sharedHits: 0, misses: 0, refused: 0, qualityRejected: 0, qualityByStatus: {}, rangeUnavailable: 0, rangeFallbacks: 0, trainedInline: 0, inlineRefusedByDeadline: 0, coalesced: 0, queuedForTraining: 0, byCategory: {}, timings: { fingerprintMs: [], cacheMs: [], diskMs: [], sharedMs: [], decideMs: [], trainMs: [] } };
  }
  _cat(req, ctx, outcome) {
    const k = req.street + '|' + (ctx && ctx.live ? (ctx.live.length === 2 ? 'heads-up' : 'multiway') : 'n/a') + '|' + (ctx && ctx.behind ? SID.stackCategory(ctx.behind.slice().sort((a, b) => b - a)[1]) : 'n/a');
    const c = this.stats.byCategory[k] || (this.stats.byCategory[k] = { ok: 0, unavailable: 0 }); c[outcome]++;
  }
  _t(name, ms) { const a = this.stats.timings[name]; a.push(ms); if (a.length > 20000) a.splice(0, a.length - 20000); }
  _un(req, code, reason, extra = {}) {
    this.stats.unavailable++;
    return { format: 'eightmax-decision', version: 1, table: req.table, hand: req.hand, revision: req.revision, stateKey: req.stateKey, source: 'eightmax-library', studyKind: 'postflop', certification: 'none', status: 'unavailable', code, reason, warnings: [], assumptions: [], ...extra };
  }
  async _lookup(built) {
    let got = this.lib.get(built.identity, built.fingerprint);
    if (!got.ok && got.code === 'library-miss' && this.o.sharedClient) { const s = await this.o.sharedClient.fetch(built.fingerprint, built.identity); if (s) { got = { ok: true, source: 'shared', game: s.game, header: s.header, slot: this.lib.adopt(built.fingerprint, s.game, s.header), timings: { lookupMs: s.ms, diskMs: s.diskMs || 0 } }; } }
    return got;
  }
  async _trainAndStore(built) {
    const fp = built.fingerprint;
    if (this.inflight.has(fp)) { this.stats.coalesced++; return this.inflight.get(fp); }
    const p = (async () => {
      this.inlineActive++; const t0 = nowMs();
      try {
        const workDir = this.o.workDir ? path.join(this.o.workDir, fp.slice(0, 16) + '-' + process.pid + '-' + require('node:worker_threads').threadId) : undefined;
        if (built.spot.training) {   // 0.31 quality-targeted study: train to the target (or limits) and store with its quality document
          const r = await require('./adaptive-training.js').trainAdaptive(built.spot, { EM: this.o.EM, adapter: this.o.adapter, cli: this.o.cli, threads: this.o.threads, memoryMiB: this.o.memoryMiB, workDir, policy: this.qualityPolicy, trainer: built.spot.training.trainer, maxTimeMs: built.spot.training.trainer === 'vector-cfr-plus' && built.spot.street === 'turn' && this.o.inlineTurnMaxMs ? this.o.inlineTurnMaxMs : built.spot.training.trainer === 'vector-cfr-plus' && this.o.inlineRiverMaxMs ? this.o.inlineRiverMaxMs : this.o.adaptiveMaxTimeMs, turnMaxBytes: this.o.turnMaxBytes, maxUpdates: this.o.adaptiveMaxUpdates });
          this.lib.put(built.identity, r.body, { status: 'complete', training: r.training, quality: r.quality });
          if (r.linked) { try { this.lib.putLinked(fp, r.linked); this.stats.linkedStored = (this.stats.linkedStored || 0) + 1; } catch (e) { this.stats.linkedFailed = (this.stats.linkedFailed || 0) + 1; } }
        } else {
          const r = await trainSpot(built.spot, { EM: this.o.EM, adapter: this.o.adapter, cli: this.o.cli, threads: this.o.threads, memoryMiB: this.o.memoryMiB, workDir, linked: !!this.o.storeLinked });
          this.lib.put(built.identity, r.body, { status: 'complete', training: r.training });
          if (r.linked) { try { this.lib.putLinked(fp, r.linked); this.stats.linkedStored = (this.stats.linkedStored || 0) + 1; } catch (e) { this.stats.linkedFailed = (this.stats.linkedFailed || 0) + 1; } }
        }
        if (this.o.sharedClient && this.o.sharedClient.noteStored) this.o.sharedClient.noteStored(fp);
        const ms = nowMs() - t0; this.estimator.add(built.spot.players, ms); this._t('trainMs', ms); this.stats.trainedInline++;
        return { ok: true };
      } catch (e) { return { ok: false, code: e.code === 'memory-limited' ? 'training-memory-limited' : 'training-failed', reason: 'Training failed: ' + e.message }; }
      finally { this.inlineActive--; this.inflight.delete(fp); }
    })();
    this.inflight.set(fp, p); return p;
  }
  async decide(req) {
    this.stats.asked++; const tStart = nowMs();
    const ctx = streetContext(req, this.o); if (ctx.error) { this._cat(req, null, 'unavailable'); return this._un(req, ctx.code, ctx.error); }
    let ranges = null;
    if (this.rangeModel) {
      try { ranges = this.rangeModel.rangesFor(req, ctx); } catch (e) { ranges = { unavailable: true, code: 'range-error', reason: 'Range model failed: ' + e.message }; }
      if (ranges.unavailable) { this.stats.rangeUnavailable++; this._cat(req, ctx, 'unavailable'); return this._un(req, ranges.code, ranges.reason, { ranges: { perSeat: ranges.perSeat || null } }); }
      if (ranges.fallback) this.stats.rangeFallbacks++;
    }
    const tf = nowMs(); let built; try { built = spotFor(req, ctx, ranges ? { ...this.o, rangeOverride: ranges } : this.o); } catch (e) { this._cat(req, ctx, 'unavailable'); return this._un(req, 'unsupported-state', 'Study identity could not be built: ' + e.message); }
    this._t('fingerprintMs', nowMs() - tf);
    let got = await this._lookup(built); let trainedNow = false;
    if (!got.ok && got.code === 'library-miss') {
      let allow = this.o.mode === 'study';
      // 0.31: a missing HEADS-UP RIVER may be solved on demand by the exact vectorised CFR+ (sub-second; evaluated exactly before use)
      // when inlineHeadsUpRiver is enabled, in any mode. Reported separately ('solved-on-demand'), never as a library hit.
      // 0.32: heads-up TURNS likewise with inlineHeadsUpTurn (exact turn+river CFR+, src/fast-multistreet.js; bounded by inlineTurnMaxMs and turnMaxBytes)
      const vcp = built.spot.training && built.spot.training.trainer === 'vector-cfr-plus';
      const onDemand = !allow && vcp && ((built.spot.street === 'river' && this.o.inlineHeadsUpRiver) || (built.spot.street === 'turn' && this.o.inlineHeadsUpTurn));
      if (onDemand) { allow = true; this.stats.solvedOnDemand = (this.stats.solvedOnDemand || 0) + 1; const k = 'solvedOnDemand_' + built.spot.street; this.stats[k] = (this.stats[k] || 0) + 1; }
      if (this.o.mode === 'deadline') {
        const est = this.estimator.estimate(built.spot.players), left = req.deadlineMs - (nowMs() - tStart);
        allow = est !== null && est <= left * this.o.deadlineSafety && (this.inlineActive < this.o.maxInlineTraining || this.inflight.has(built.fingerprint));
        if (!allow) this.stats.inlineRefusedByDeadline++;
      }
      if (allow) { const r = await this._trainAndStore(built); if (!r.ok) { this._cat(req, ctx, 'unavailable'); return this._un(req, r.code, r.reason); } got = await this._lookup(built); if (!got.ok && this.lib.has(built.fingerprint)) got = this.lib.get(built.identity, built.fingerprint); trainedNow = onDemand ? 'solved-on-demand' : true; }
    }
    // 0.32: validated approximate mappings (src/approximate-lookup.js), only with an explicit approximation policy (default: none)
    let approx = null;
    if (!got.ok && got.code === 'library-miss' && this.approximations.length) {
      const a = this._approximateLookup(req, ctx, built, ranges); if (a) { approx = a; got = a.got; this.stats.approximateHits = (this.stats.approximateHits || 0) + 1; const k = 'approximate_' + a.mapping; this.stats[k] = (this.stats[k] || 0) + 1; }
    }
    if (!got.ok) {
      if (got.code === 'library-miss') {
        this.stats.misses++; this.lib.recordMiss(built.identity, built.fingerprint, { spot: built.spot, table: req.table, street: req.street });
        if (this.o.onMiss) { try { if (this.o.onMiss(built.spot, req) !== false) this.stats.queuedForTraining++; } catch (e) { /* queue full or closed: still a miss */ } }
      } else this.stats.refused++;
      this._cat(req, ctx, 'unavailable');
      return this._un(req, got.code, got.code === 'library-miss' ? 'No trained strategy is available for this situation. It has been added to the list of situations to train.' : got.reason,
        { missingStrategy: { fingerprint: built.fingerprint, summary: SID.describe(built.identity) }, libraryTimings: got.timings });
    }
    // 0.31 quality gate (before the strategy is used for anything)
    const quality = Q.qualityOf(got.header, this.ledger, this.qualityPolicy), qg = Q.gate(quality, this.qualityPolicy, { use: this.qualityUse });
    this.stats.qualityByStatus[quality.status] = (this.stats.qualityByStatus[quality.status] || 0) + 1;
    if (!qg.allowed) { this.stats.qualityRejected++; this._cat(req, ctx, 'unavailable'); return this._un(req, 'quality-gate', qg.reason, { quality: { status: quality.status, label: qg.label, reason: quality.reason, policy: qg.policy, use: qg.use }, libraryFingerprint: built.fingerprint }); }
    if (got.source === 'memory') this.stats.memoryHits++; else if (got.source === 'disk') this.stats.diskHits++; else this.stats.sharedHits++;
    this._t(got.source === 'memory' ? 'cacheMs' : got.source === 'shared' ? 'sharedMs' : 'diskMs', got.timings.lookupMs);
    const td = nowMs(), slot = got.slot || { study: null };
    if (!slot.study) slot.study = new ST.TreeStudy(this.o.EM || require('../tests/load-solver.cjs'), got.game.prepared(built.spot.config), { id: 'library-' + built.fingerprint.slice(0, 16), kind: 'postflop', seatOrder: ctx.live, builtAt: Date.parse(got.header.createdAt) || 0, backend: got.header.training ? got.header.training.backend : 'unknown', convergence: got.header.convergence,
      assumptions: [ranges && !ranges.fallback ? 'Opponent ranges derived from the betting (' + built.identity.rangeModel + '; provenance ' + ranges.provenance + '): they assume every player follows the stored strategies, they are not observed hidden cards' : 'Opponent ranges are an assumed range model (' + built.identity.rangeModel + '), not observed ranges', 'Tree sizes: flop ' + built.identity.tree.flop.bets + ', turn ' + built.identity.tree.turn.bets + ', river ' + built.identity.tree.river.bets + ' (max ' + built.identity.tree.flop.maxBets + ' bets per street)', 'Study covers this street from its start: ' + ctx.live.length + ' live players, pot ' + ctx.pot + ' bb', 'Precomputed strategy from the library (exact identity match' + (built.isomorphismApplied ? ', suit-isomorphic board: an exact relabelling of suits' : '') + ')'] });
    slot.study.seatOrder = ctx.live;
    const perm = built.suitPermutation; let mreq = built.isomorphismApplied ? { ...req, holeCards: req.holeCards.map((c) => SID.applyPerm(c, perm)), board: req.board.map((c) => SID.applyPerm(c, perm)) } : req;
    if (approx) { mreq = AL.scaleRequest(mreq, approx.factor); if (approx.potOverrideChips !== undefined) { mreq = { ...mreq, pot: approx.potOverrideChips, streetStart: { ...mreq.streetStart, pot: approx.potOverrideChips } }; } }
    let d = slot.study.decide(mreq); this._t('decideMs', nowMs() - td);
    if (approx && d.status === 'ok') d = AL.mapBack(d, approx.factor, req, approx.mapping, { sourceFingerprint: approx.fingerprint, sourceSummary: SID.describe(approx.identity) });
    else if (approx) d = { ...d, reason: 'Approximation ' + approx.mapping + ' could not be applied: ' + d.reason };
    if (this.rangeModel && d.status === 'ok') this.rangeModel.noteStudy(req, { game: got.game, spec: got.game.prepared ? got.game.prepared().spec : slot.study.prepared.spec, seatOrder: ctx.live.slice(), perm: built.suitPermutation, isomorphismApplied: built.isomorphismApplied, validated: quality.status === 'validated', fingerprint: built.fingerprint });
    const qInfo = { status: quality.status, label: Q.LABELS[quality.status], reason: quality.reason, measurePctPot: quality.measurePctPot, source: quality.source, policy: this.qualityPolicy.name, use: this.qualityUse };
    if (ranges && ranges.warnings && ranges.warnings.length) d.warnings = (d.warnings || []).concat(ranges.warnings);
    if (quality.status !== 'validated' && d.warnings) d.warnings.push('Strategy quality: ' + Q.LABELS[quality.status]);
    const convergence = quality.status === 'validated' && !approx ? {verdict:'within-target', source:'exact-quality-evaluation', policy:this.qualityPolicy.name, measurePctPot:quality.measurePctPot, scope:'stored-game-only', evaluatedAt:quality.evaluatedAt} : d.convergence;
    const out = { ...d, convergence, quality: qInfo, strategyConfidence: quality.status, ranges: ranges ? { model: built.identity.rangeModel, provenance: ranges.provenance, fallback: !!ranges.fallback, perSeat: ranges.perSeat } : { model: built.identity.rangeModel, provenance: 'assumed-any-two-cards', fallback: false, perSeat: null }, strategySource: approx ? 'library-approximate' : trainedNow === 'solved-on-demand' ? 'solved-on-demand' : trainedNow ? 'trained-now' : 'library-' + got.source, cache: got.source === 'memory' ? 'hit' : 'miss', libraryFingerprint: built.fingerprint, isomorphism: built.isomorphismApplied ? { suitPermutation: perm, note: 'Hole cards and board were relabelled by this suit permutation to match the stored canonical board; exact, not approximate' } : null,
      timings: { totalMs: nowMs() - tStart, lookupMs: got.timings.lookupMs, diskMs: got.timings.diskMs, decideMs: nowMs() - td } };
    if (d.status === 'ok') { this.stats.ok++; this._cat(req, ctx, 'ok'); } else { this.stats.unavailable++; this._cat(req, ctx, 'unavailable'); }
    return out;
  }
  /** 0.32 approximate lookup: returns { got, mapping, factor, fingerprint, identity[, potOverrideChips] } or null. */
  _approximateLookup(req, ctx, built, ranges) {
    for (const mapping of this.approximations) {
      const ap = AL.applicable(mapping, built, req); if (!ap.ok) continue;
      if (mapping === 'chip-scale') {
        if (!this._scaleIndex) this._scaleIndex = new AL.ScaleIndex(this.lib);
        for (const c of this._scaleIndex.candidates(built.identity)) {
          if (c.fingerprint === built.fingerprint) continue;
          const f = c.identity.potBB / built.identity.potBB; if (!(f > 0) || Math.abs(f - 1) < 1e-9) continue;
          if (!built.identity.stacksBehindBB.every((x, i) => Math.abs(x * f - c.identity.stacksBehindBB[i]) <= 0.005 + 1e-9)) continue;   // proportional to half a chip
          const g = this.lib.get(c.identity, c.fingerprint); if (g.ok) return { got: g, mapping, factor: f, fingerprint: c.fingerprint, identity: c.identity };
        }
      } else if (mapping === 'pot-bucket-10pct') {
        const grid = AL.potGrid(ctx.pot); if (Math.abs(grid - ctx.pot) < 0.005) continue;
        let b2; try { b2 = spotFor(req, { ...ctx, pot: grid }, ranges ? { ...this.o, rangeOverride: ranges } : this.o); } catch (e) { continue; }
        const g = this.lib.get(b2.identity, b2.fingerprint); if (g.ok) return { got: g, mapping, factor: 1, fingerprint: b2.fingerprint, identity: b2.identity, potOverrideChips: Math.round(grid * 100) };
      }
    }
    return null;
  }
  info() { const pct = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)].toFixed(3); }; const t = {}; for (const [k, a] of Object.entries(this.stats.timings)) t[k] = { n: a.length, p50: pct(a, 50), p95: pct(a, 95), p99: pct(a, 99), max: a.length ? +Math.max(...a).toFixed(3) : null }; return { ...this.stats, timings: t, rawTimings: this.stats.timings, library: this.lib.stats, qualityPolicy: this.qualityPolicy.name, qualityUse: this.qualityUse, rangeModel: this.rangeModel ? this.rangeModel.info() : null }; }
}

module.exports = { spotFromParams, LIBRARY_RANGE, LIBRARY_RANGE_MODEL, treeProfile030, COMPACT1, COMPACT2, ENGINE, DEFAULT_BLINDS, streetContext, spotFor, trainSpot, TrainingEstimator, LibraryDecisionSource };
