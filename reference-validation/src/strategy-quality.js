'use strict';
/* EightMax Test Workbench 0.31: strategy quality classification, configurable quality policies, the quality ledger and the
 * decision-time quality gate.
 *
 * Five classifications (never inferred from "training finished"):
 *   validated              an EXACT evaluation of the specific stored game meets the policy threshold
 *                          (heads-up: exploitability; three or more players: NashConv, which is a different measure)
 *   estimated              sampled / approximate measurements exist and are reported with their uncertainty
 *   restricted-evaluation  evaluated only against a limited response space or inside an abstraction
 *   unverified             not enough mathematical evidence (e.g. flop/turn street snapshots without a linked continuation record,
 *                          or a linked record whose continuation has unvisited information sets - 0.32)
 *   failed-quality-check   an evaluation shows the strategy does NOT meet the selected threshold
 *
 * Heads-up thresholds are never applied to multiway games: a policy has separate heads-up (exploitability) and multiway
 * (NashConv) limits, and a multiway "validated" means "NashConv below the multiway limit", which is NOT a safety guarantee.
 *
 * Records in the strategy library are immutable, so evaluations live in a sidecar LEDGER (<library>/quality/..), one file per
 * fingerprint, each entry bound to the record's raw payload SHA-256. An entry for different bytes is ignored (stale).
 * A record may also carry quality in its header (written by quality-aware training); the newest matching entry wins.
 */
const fs = require('node:fs'), path = require('node:path');

const STATUS = Object.freeze({ VALIDATED: 'validated', ESTIMATED: 'estimated', RESTRICTED: 'restricted-evaluation', UNVERIFIED: 'unverified', FAILED: 'failed-quality-check' });
const LABELS = Object.freeze({
  validated: 'Validated — passed an exact accuracy check for this specific game',
  estimated: 'Estimated — sampled accuracy measurement with stated uncertainty',
  'restricted-evaluation': 'Restricted evaluation — checked only against limited responses or an abstraction',
  unverified: 'Unverified — not enough evidence about its accuracy',
  'failed-quality-check': 'Failed quality check — measured accuracy is worse than the selected target',
});
const QUALITY_FORMAT = 'eightmax-strategy-quality', QUALITY_VERSION = 1;

/** Policy presets. Thresholds are in % of the starting pot of the evaluated street (and optionally absolute bb). */
const POLICIES = Object.freeze({
  strict: Object.freeze({ name: 'strict', headsUp: { maxExploitabilityPctPot: 0.5, maxExploitabilityBB: null }, multiway: { maxNashConvPctPot: 1.0 }, decisionStatuses: ['validated'], simulationStatuses: ['validated'] }),
  research: Object.freeze({ name: 'research', headsUp: { maxExploitabilityPctPot: 1.0, maxExploitabilityBB: null }, multiway: { maxNashConvPctPot: 2.5 }, decisionStatuses: ['validated'], simulationStatuses: ['validated', 'estimated', 'unverified'] }),
  exploratory: Object.freeze({ name: 'exploratory', headsUp: { maxExploitabilityPctPot: 5.0, maxExploitabilityBB: null }, multiway: { maxNashConvPctPot: 10.0 }, decisionStatuses: ['validated', 'estimated'], simulationStatuses: ['validated', 'estimated', 'restricted-evaluation', 'unverified'] }),
  // 0.30 behaviour: no gate at all (every completed record is used); kept so older workspaces behave as before when chosen explicitly.
  off: Object.freeze({ name: 'off', headsUp: { maxExploitabilityPctPot: Infinity, maxExploitabilityBB: null }, multiway: { maxNashConvPctPot: Infinity }, decisionStatuses: Object.values(STATUS), simulationStatuses: Object.values(STATUS) }),
});
const DEFAULT_POLICY = 'research';

function policyOf(p) {
  if (!p) return POLICIES[DEFAULT_POLICY];
  if (typeof p === 'string') { if (!POLICIES[p]) throw new Error('Unknown quality policy ' + p + ' (use ' + Object.keys(POLICIES).join(', ') + ')'); return POLICIES[p]; }
  const base = POLICIES[p.base || DEFAULT_POLICY];
  const out = { ...base, ...p, name: p.name || 'custom', headsUp: { ...base.headsUp, ...(p.headsUp || {}) }, multiway: { ...base.multiway, ...(p.multiway || {}) } };
  for (const v of [out.headsUp.maxExploitabilityPctPot, out.multiway.maxNashConvPctPot]) if (!(typeof v === 'number' && v > 0)) throw new Error('Quality thresholds must be positive numbers');
  if (out.headsUp.maxExploitabilityBB !== null && !(out.headsUp.maxExploitabilityBB > 0)) throw new Error('Absolute heads-up threshold must be positive or null');
  for (const list of [out.decisionStatuses, out.simulationStatuses]) if (!Array.isArray(list) || list.some((s) => !Object.values(STATUS).includes(s))) throw new Error('Unknown quality status in policy');
  return out;
}
const policySummary = (p) => ({ name: p.name, headsUp: { maxExploitabilityPctPot: finite(p.headsUp.maxExploitabilityPctPot), maxExploitabilityBB: p.headsUp.maxExploitabilityBB }, multiway: { maxNashConvPctPot: finite(p.multiway.maxNashConvPctPot) }, decisionStatuses: p.decisionStatuses.slice(), simulationStatuses: p.simulationStatuses.slice() });
const finite = (x) => (Number.isFinite(x) ? x : null);

/**
 * Classify an evaluation for a game under a policy.
 * evaluation: { type: 'exact'|'sampled'|'restricted'|'none', players, potBB, exploitabilityBB?, nashConvBB?, ci95?:[lo,hi] (same unit as the measure), reason? }
 */
function classify(evaluation, policy) {
  const p = policyOf(policy), e = evaluation || { type: 'none' };
  if (!e.type || e.type === 'none') return { status: STATUS.UNVERIFIED, reason: e.reason || 'No accuracy evaluation exists for this strategy' };
  if (e.type === 'restricted') return { status: STATUS.RESTRICTED, reason: e.reason || 'Evaluated only against a restricted response space' };
  const hu = e.players === 2, pot = e.potBB;
  if (!(pot > 0)) return { status: STATUS.UNVERIFIED, reason: 'Evaluation has no starting pot; thresholds in % of pot cannot be applied' };
  const measure = hu ? e.exploitabilityBB : e.nashConvBB, limitPct = hu ? p.headsUp.maxExploitabilityPctPot : p.multiway.maxNashConvPctPot;
  if (!(typeof measure === 'number' && Number.isFinite(measure))) return { status: STATUS.UNVERIFIED, reason: 'Evaluation lacks the ' + (hu ? 'exploitability' : 'NashConv') + ' value' };
  let limitBB = limitPct * pot / 100; if (hu && p.headsUp.maxExploitabilityBB !== null) limitBB = Math.min(limitBB, p.headsUp.maxExploitabilityBB);
  const what = hu ? 'exploitability' : 'NashConv (multiway; not a two-player exploitability)', pct = measure / pot * 100;
  const fmt = (x) => x.toFixed(4) + ' bb (' + (x / pot * 100).toFixed(2) + '% of pot)';
  if (e.type === 'exact' && e.continuation === 'linked' && e.missingRows > 0) return { status: STATUS.UNVERIFIED, partialEvaluation: true, reason: 'Exact ' + what + ' over the linked ' + (e.streets || []).join('+') + ' tree is ' + fmt(measure) + ', but ' + e.missingRows + ' continuation information sets were never visited by training (' + (100 * e.missingShare).toFixed(1) + '% of possible rows) and are filled with uniform play for the evaluation; an incomplete stored strategy is not validated', measure, measurePctPot: pct, limitBB, measureKind: hu ? 'exploitability' : 'nashconv' };
  if (e.type === 'exact') return measure <= limitBB + 1e-12
    ? { status: STATUS.VALIDATED, reason: 'Exact ' + what + ' ' + fmt(measure) + ' is within the ' + p.name + ' limit ' + fmt(limitBB), measure, measurePctPot: pct, limitBB, measureKind: hu ? 'exploitability' : 'nashconv' }
    : { status: STATUS.FAILED, reason: 'Exact ' + what + ' ' + fmt(measure) + ' exceeds the ' + p.name + ' limit ' + fmt(limitBB), measure, measurePctPot: pct, limitBB, measureKind: hu ? 'exploitability' : 'nashconv' };
  if (e.type === 'sampled') {
    const ci = e.ci95; if (!Array.isArray(ci)) return { status: STATUS.UNVERIFIED, reason: 'Sampled evaluation without a confidence interval is not accepted as evidence' };
    if (ci[0] > limitBB) return { status: STATUS.FAILED, reason: 'Sampled ' + what + ' 95% interval [' + ci.map((x) => x.toFixed(4)).join(', ') + '] bb lies above the limit ' + fmt(limitBB), measure, ci95: ci, limitBB };
    return { status: STATUS.ESTIMATED, reason: 'Sampled ' + what + ' ' + measure.toFixed(4) + ' bb, 95% interval [' + ci.map((x) => x.toFixed(4)).join(', ') + '] bb; limit ' + fmt(limitBB) + (ci[1] <= limitBB ? ' (interval entirely below the limit)' : ' (interval overlaps the limit: inconclusive)'), measure, ci95: ci, limitBB, conclusive: ci[1] <= limitBB };
  }
  return { status: STATUS.UNVERIFIED, reason: 'Unknown evaluation type ' + e.type };
}

/**
 * Gate used by the decision engine. context.use: 'decision' (execution in QA / simulation auto-play) or 'simulation-experiment'
 * (clearly labelled research simulation). Returns { allowed, status, label, reason }.
 */
function gate(quality, policy, context = {}) {
  const p = policyOf(policy), status = quality && quality.status ? quality.status : STATUS.UNVERIFIED;
  const allowedList = context.use === 'simulation-experiment' ? p.simulationStatuses : p.decisionStatuses;
  const allowed = allowedList.includes(status);
  return { allowed, status, label: LABELS[status], policy: p.name, use: context.use || 'decision',
    reason: allowed ? 'Quality status "' + status + '" is accepted by policy "' + p.name + '" for ' + (context.use || 'decision') + ' use'
      : 'Strategy refused by the quality gate: status "' + status + '" is not accepted by policy "' + p.name + '" for ' + (context.use || 'decision') + ' use' + (quality && quality.reason ? ' (' + quality.reason + ')' : '') };
}

/** Build the stored quality document. */
function qualityDocument(o) {
  const p = policyOf(o.policy), c = classify(o.evaluation, p), id = o.identity || {};
  return {
    format: QUALITY_FORMAT, version: QUALITY_VERSION, fingerprint: o.fingerprint, recordRawSha256: o.recordRawSha256 || null,
    solver: { engine: id.engine || null, trainer: id.training ? id.training.trainer : null, algorithm: o.algorithm || (id.abstraction ? id.abstraction.traversal + ', ' + id.abstraction.regretMatching + ' regret matching, ' + id.abstraction.weighting + ' weighting' : null) },
    trainingUpdates: o.trainingUpdates === undefined ? null : o.trainingUpdates,
    game: { street: id.street || null, players: id.players || null, board: id.board || null, potBB: id.potBB === undefined ? null : id.potBB, stacksBehindBB: id.stacksBehindBB || null, rangeModel: id.rangeModel || null, abstraction: id.abstraction || null },
    evaluation: { ...o.evaluation, evaluator: o.evaluator || 'src/fast-river.js + src/exploitability.js (independent of the EightMax engine)' },
    stability: o.stability || null, convergenceCurve: o.curve || null, seeds: o.seeds || null,
    evaluatedAt: o.evaluatedAt || new Date().toISOString(), policy: policySummary(p), status: c.status, statusLabel: LABELS[c.status], reason: c.reason,
    limitations: (o.limitations || []).concat(defaultLimitations(id, o.evaluation)),
  };
}
function defaultLimitations(id, e) {
  const out = ['Accuracy refers only to the stored street-start game (its board, pot, stacks, ranges and bet menu), not to the full tournament game.'];
  if (id.rangeModel) out.push('Opponent ranges are the model "' + id.rangeModel + '"; accuracy is relative to that assumption.');
  if (e && e.players > 2) out.push('Multiway: NashConv is the total unilateral gain; zero would be a Nash equilibrium, which with three or more players is neither unique nor safe against coalitions.');
  if (e && e.type === 'none') out.push(e.continuation === 'linked' ? 'No exact evaluation: ' + (e.reason || 'the linked record could not be evaluated') : 'No exact evaluation: street snapshots of the flop and turn do not contain later-street strategies, so their exploitability cannot be computed from the record alone (0.32: a linked continuation record makes this possible; see docs/LINKED-STUDIES.md).');
  if (e && e.continuation === 'linked') out.push('Evaluated over the complete linked game from the record\'s street to the river (every later card enumerated), using the stored continuation strategies; card abstraction: none (exact private hands).');
  return out;
}

/** Strategy stability: weighted mean L1 distance between two average-strategy accessors over the nodes/hands both define. */
function stabilityL1(fast, S1, S2) {
  let sum = 0, wsum = 0; const q = [fast.tree.tree];
  while (q.length) { const node = q.shift(); if (node.kind !== 'player') continue; const H = fast.hands[node.seat];
    for (let i = 0; i < H.length; i++) { const a = S1.get(node, node.seat, i), b = S2.get(node, node.seat, i); let d = 0; for (let k = 0; k < node.k; k++) d += Math.abs(a[k] - b[k]); sum += H[i].w * d; wsum += H[i].w; }
    for (const c of node.children) q.push(c); }
  return wsum ? sum / wsum : null;
}

/** Exact evaluation of a decoded snapshot (river only). Returns an evaluation object for classify(). */
function evaluateSnapshot(game, identity, o = {}) {
  const F = require('./fast-river.js'), X = require('./exploitability.js'), spec = game.prepared().spec;
  const players = spec.hands.length, potBB = identity && identity.potBB !== undefined ? identity.potBB : null;
  if (identity && identity.street && identity.street !== 'river') return { type: 'none', players, potBB, reason: 'The ' + identity.street + ' snapshot stores only this street; later-street strategies are not in the record, so exact exploitability cannot be computed' };
  const t0 = Date.now();
  try {
    if (players === 2) { const e = F.prepare(game, spec).exact(game); return { type: 'exact', method: e.method, players, potBB: potBB === null ? e.commonPot : potBB, exploitabilityBB: e.exploitability, nashConvBB: e.nashConv, values: e.values, missingRows: e.missingRows, ms: Date.now() - t0 }; }
    const e = X.exact(game, spec, { maxDeals: o.maxDeals || 3e6 }); return { type: 'exact', method: 'joint-deal enumeration (exploitability.js)', players, potBB: potBB === null ? e.commonPot : potBB, nashConvBB: e.nashConv, gains: e.gains, values: e.values, deals: e.deals, missingRows: e.missingRows, ms: Date.now() - t0 };
  } catch (err) { return { type: 'none', players, potBB, reason: 'Exact evaluation not feasible: ' + err.message }; }
}

/** 0.32: exact evaluation of a LINKED multi-street record (src/linked-study.js): the whole game from the record's street to the
 *  river with the stored continuation strategies. Heads-up only (independent vectorised evaluator, src/fast-multistreet.js);
 *  multiway linked records stay unverified (no independent multiway multi-street evaluator yet). o.maxMs bounds the attempt. */
function evaluateLinked(linked, identity, o = {}) {
  const spec = linked.prepared().spec, players = spec.hands.length, potBB = identity && identity.potBB !== undefined ? identity.potBB : linked.meta.commonPot;
  const base = { players, potBB, continuation: 'linked', streets: null };
  if (players !== 2) return evaluateLinkedMultiway(linked, base, o);
  const MS = require('./fast-multistreet.js'), t0 = Date.now();
  try {
    const F = MS.prepare(linked, spec, { deadline: o.maxMs ? Date.now() + o.maxMs : null }), e = F.exact(linked), c = linked.coverage();
    return { ...base, type: 'exact', method: e.method, streets: e.streets, exploitabilityBB: e.exploitability, nashConvBB: e.nashConv, values: e.values, missingRows: e.missingRows, missingShare: c.missingRows + c.storedRows ? e.missingRows / (c.missingRows + c.storedRows) : 0, ms: Date.now() - t0 };
  } catch (err) { return { ...base, type: 'none', reason: 'Exact linked evaluation not feasible within limits: ' + err.message, code: err.code || null }; }
}

/** 0.33: multiway (3-4 player) linked records, evaluated EXACTLY by src/independent-eval.js (own rules, pots, evaluator, best response).
 *  Needs the betting rules stored by 0.33 exports; the evaluator's own tree must reproduce the record's geometry node by node, otherwise
 *  the record is refused (type 'none'). Result: NashConv (sum of unilateral best-response gains) - NOT an exploitability. */
function evaluateLinkedMultiway(linked, base, o = {}) {
  const r = linked.meta.rules, players = base.players;
  if (players > 4) return { ...base, type: 'none', reason: 'The independent evaluator handles at most 4 players (' + players + ')' };
  if (!r) return { ...base, type: 'none', reason: 'This multiway record has no stored betting rules (exported before 0.33): no independent evaluation' };
  if ((r.prior || []).some((x) => x) || (r.folded || []).length) return { ...base, type: 'none', reason: 'Records with earlier contributions are not supported by the independent evaluator' };
  const KIND = { 0: () => 'a', 2: (v) => String(+(v * 100).toFixed(6)), 3: (v) => v + 'x' }, streets = {};
  for (const [len, name] of [[3, 'flop'], [4, 'turn'], [5, 'river']]) { const z = r.sizes && r.sizes[len]; if (!z) continue; const conv = (list) => list.map(([k, v]) => { if (!KIND[k]) throw new Error('size kind ' + k); return KIND[k](v); }).join(',');
    try { streets[name] = { bets: conv(z.bets), raises: conv(z.raises), maxBets: z.cap }; } catch (e) { return { ...base, type: 'none', reason: 'Geometric or absolute sizes are not supported by the independent evaluator' }; } }
  const IE = require('./independent-eval.js'), t0 = Date.now();
  try {
    const G = IE.holdem({ board: linked.meta.startBoard, common: r.pot0, stacks: r.stacks, hands: linked.meta.hands.map((l) => l.map((h) => [h[1], h[2], h[3]])), streets });
    const geo = IE.compareGeometry(G, (s) => linked.view(s)); if (geo.mismatches.length) return { ...base, type: 'none', reason: 'Independent rules do not reproduce the stored tree (' + geo.mismatches.length + ' differences); refused', geometry: geo };
    const H = linked.meta.hands, e = IE.evaluate(G, (seat, node, board, ti, type) => { const h = H[seat][type.src]; const s = linked.averageAt(node.path, board, seat, { id: h[0], a: h[1], b: h[2], w: h[3] }); return s ? Array.from(s) : null; }, { commonPot: base.potBB });
    return { ...base, type: 'exact', method: e.method, nashConvBB: e.nashConv, gainsBB: e.gains, values: e.values, missingRows: e.missingRows, streets: Object.keys(streets), ms: Date.now() - t0, evaluator: 'independent', note: e.note };
  } catch (err) { return { ...base, type: 'none', reason: 'Independent multiway evaluation failed: ' + err.message }; }
}

/* ---------- ledger ---------- */
function writeAtomic(file, text) { const tmp = file + '.tmp' + process.pid + '-' + Date.now(); const fd = fs.openSync(tmp, 'w'); try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } fs.renameSync(tmp, file); }
class QualityLedger {
  constructor(libraryDir) { this.dir = path.join(libraryDir, 'quality'); this.cache = new Map(); }
  file(fp) { return path.join(this.dir, fp.slice(0, 2), fp + '.json'); }
  /** Append an evaluation (keeps history; newest last). */
  add(doc) {
    if (!doc || doc.format !== QUALITY_FORMAT || !/^[0-9a-f]{64}$/.test(doc.fingerprint || '')) throw new Error('Not a quality document');
    if (!/^[0-9a-f]{64}$/.test(doc.recordRawSha256 || '')) throw new Error('A quality entry must name the exact record bytes it evaluated (recordRawSha256)');
    const f = this.file(doc.fingerprint); fs.mkdirSync(path.dirname(f), { recursive: true });
    let hist = []; try { hist = JSON.parse(fs.readFileSync(f, 'utf8')).entries || []; } catch (e) { hist = []; }
    hist.push(doc); if (hist.length > 32) hist = hist.slice(-32);
    writeAtomic(f, JSON.stringify({ format: QUALITY_FORMAT + '-ledger', version: 1, fingerprint: doc.fingerprint, entries: hist })); this.cache.delete(doc.fingerprint);
    return doc;
  }
  history(fp) { try { const d = JSON.parse(fs.readFileSync(this.file(fp), 'utf8')); return d.fingerprint === fp ? d.entries : []; } catch (e) { return []; } }
  /** Newest entry for exactly these record bytes, or null. Entries for other bytes (a replaced record) are ignored. */
  latest(fp, rawSha256) {
    const k = fp + '|' + rawSha256; if (this.cache.has(k)) return this.cache.get(k);
    const e = this.history(fp).filter((x) => x.recordRawSha256 === rawSha256 && x.fingerprint === fp).pop() || null; this.cache.set(k, e); return e;
  }
}

/** Quality for a library record header: ledger entry (newest, same bytes) or header.quality, re-classified under the given policy. */
function qualityOf(header, ledger, policy) {
  const raw = header.payload && header.payload.rawSha256, fromLedger = ledger && raw ? ledger.latest(header.fingerprint, raw) : null;
  const doc = fromLedger || header.quality || null;
  if (!doc) return { status: STATUS.UNVERIFIED, reason: 'No accuracy evaluation recorded for this strategy', source: 'none' };
  if (!raw || doc.recordRawSha256 !== raw || doc.fingerprint !== header.fingerprint) return {status: STATUS.UNVERIFIED, reason: 'Quality evidence does not match this strategy payload and identity', source: 'mismatched-evidence'};
  const c = classify(doc.evaluation, policy);   // re-classify: the user's selected policy may differ from the one used at evaluation time
  return { status: c.status, reason: c.reason, source: fromLedger ? 'ledger' : 'record-header', evaluation: doc.evaluation, evaluatedAt: doc.evaluatedAt, trainingUpdates: doc.trainingUpdates, stability: doc.stability, measurePctPot: c.measurePctPot === undefined ? null : c.measurePctPot };
}

/** Evaluate one stored record, classify it and add the result to the ledger. */
function evaluateRecord(lib, fingerprint, o = {}) {
  const L = require('./strategy-library.js'), SNAP = require('./strategy-snapshot.js');
  const rec = L.decodeRecord(fs.readFileSync(lib.file(fingerprint)), fingerprint), game = SNAP.decode(rec.body), id = rec.header.identity;
  let evaluation = evaluateSnapshot(game, id, o), evaluator;
  // 0.32: a flop/turn record with a linked continuation record is evaluated over the whole linked game
  if (evaluation.type === 'none' && lib.getLinked) { const lk = lib.getLinked(fingerprint); if (lk && lk.ok) { evaluation = evaluateLinked(lk.game, id, o); evaluator = 'src/fast-multistreet.js over the linked record (independent of the EightMax engine)'; } else if (lk && lk.code !== 'no-linked') evaluation = { ...evaluation, reason: evaluation.reason + '; linked record refused: ' + lk.reason }; }
  const doc = qualityDocument({ evaluator, fingerprint, recordRawSha256: rec.header.payload.rawSha256, identity: id, evaluation, policy: o.policy, trainingUpdates: rec.header.training ? rec.header.training.iterations : (id.training && id.training.iterations), limitations: o.limitations });
  if (o.ledger !== false) (o.ledger || new QualityLedger(lib.dir)).add(doc);
  return doc;
}

module.exports = { STATUS, LABELS, POLICIES, DEFAULT_POLICY, QUALITY_FORMAT, policyOf, policySummary, classify, gate, qualityDocument, stabilityL1, evaluateSnapshot, evaluateLinked, QualityLedger, qualityOf, evaluateRecord };
