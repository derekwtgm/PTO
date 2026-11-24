#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 3: GAMEPLAY RELIABILITY ACCEPTANCE - tournaments with eliminations, hand recovery, multi-table
 * stability and long campaigns, with REAL windows, REAL capture and REAL input on Windows (or the fake host with --fake: logic self-check,
 * never Windows evidence). Environments, registration and request accounting come from tools/lifecycle-acceptance-0362m2.cjs.
 *
 *   node tools/gameplay-acceptance-0362m3.cjs [--fake] [--suite acceptance|stability|campaign|t5] [--only T1,T2,...] [--out FILE]
 *        t5 (0.36.2 M3.2): [--repeat N]  T5 (active table closed) and T5P (table paused by an action its table did not apply, then closed)
 *        stability: [--tables 1,2,5,8] [--seconds 60]        campaign: [--tables 1] [--hands 120] [--max-minutes 30]
 *
 * acceptance  T1 hands that start with eliminated players (the Milestone 2 stall)   T2 a tournament played to its end (normal stop)
 *             T3 untracked hand at start -> recovery at the next verified hand        T4 think-time holds (one seat, consecutive streets)
 *             T5 two tables: eliminations on one, the other closes                  T6 emergency stop right after an elimination
 * stability   N tables (default 1, 2, 5 and 8) play short-stack tournaments; one table is closed and reopened (fresh registration), all
 *             tables are emergency-stopped and resumed by the operator; finished tournaments are replaced by new ones
 * campaign    tournaments played to the end one after another (fresh table, fresh registration each time) until --hands completed hands
 * Every confirmed action is matched, in order, against the dealer's own record (the oracle: what the table accepted). Counted: hands
 * completed, actions attempted / confirmed, incorrect clicks, invalid wagers, actions the table applied that the Workbench did not
 * confirm (missed transitions), refused readings by reason, reconstruction failures, unexpected pauses, recoveries, eliminations, final
 * player count. A finished tournament is a normal end, never a stall. The mouse moves by itself on Windows: do not touch it.
 */
const path = require('path'), fs = require('fs'), os = require('os');
const M2 = require('./lifecycle-acceptance-0362m2.cjs');
const { ROOT, FAKE, until, since, settleWithin, withTimeout, Scope } = M2;
const src = (m) => require(path.join(ROOT, 'src', m));
const SCH = src('input-scheduler.js'), XA = src('execution-adapters.js'), LC = src('window-lifecycle.js'), EM = src('engine.js');
const LS = LC.STATES, mono = () => performance.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const SUITE = arg('suite', 'acceptance'), ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const OUT = arg('out', path.join(ROOT, 'reports', '0.36.2-m3-gameplay-' + SUITE + (FAKE ? '-fake' : '') + '.json'));
const GAP = FAKE ? { handGapFake: 400 } : { handGap: 1200 };          // a realistic pause between hands (the hand result stays visible)
const SHORT3 = [0, 250, 0, 0, 250, 0, 0, 250], M2STALL = [2390, 2140, 0, 2490, 2490, 8000, 0, 2490], TINY = [120, 120, 400, 120, 120, 400, 120, 120];
const tableOpts = { identityCheckMs: 5000 };

/* ---------------- oracle cross-check ---------------- */
const norm = (h) => LC.normHwnd(h);
function oracleFor(list, w) { const m = list.filter((o) => o.hwnd && norm(o.hwnd) === norm(w.hwnd)); return m.length ? m[m.length - 1] : list.find((o) => o.table === w.table && !o.closed) || null; }
/** In-order match of the table's confirmed actions against what the dealer accepted (hand, seat, type, wager). */
function crossCheck(t, o) {
  const conf = t.log.filter((e) => e.status === 'confirmed'), acc = (o && o.accepted) || [], c = (o && o.counts) || {};
  let j = 0; const wrong = [], missing = [];
  for (const e of conf) {
    const k = acc.findIndex((a, i) => i >= j && a.hand === e.hand && a.seat === e.seat);
    if (k < 0) { missing.push({ hand: e.hand, seat: e.seat, action: e.action }); continue; }
    const a = acc[k], ty = e.action && e.action.type, want = ty === 'bet' ? 'raise' : ty === 'allin' ? a.type : ty;
    if (want !== a.type || ((a.type === 'raise') && e.action && e.action.amount !== undefined && e.action.amount !== a.amount && ty !== 'allin')) wrong.push({ hand: e.hand, seat: e.seat, workbench: e.action, dealer: { type: a.type, amount: a.amount, control: a.control } });
    for (let i = j; i < k; i++) missing.push({ hand: acc[i].hand, seat: acc[i].seat, dealerOnly: acc[i].type });
    j = k + 1;
  }
  const uncertain = t.log.filter((e) => e.status === 'uncertain' || e.status === 'unconfirmed').length;
  const unexplained = acc.length - j > uncertain ? acc.length - j - uncertain : 0;   // applied by the table, not confirmed and not flagged
  return { confirmed: conf.length, dealerAccepted: acc.length, matchedInOrder: conf.length - missing.filter((m) => !m.dealerOnly).length - wrong.length, wrongActions: wrong.length, wrong: wrong.slice(0, 5),
    confirmedNotApplied: missing.filter((m) => !m.dealerOnly).length, appliedNotConfirmed: missing.filter((m) => m.dealerOnly).length + unexplained, uncertainOrUnconfirmed: uncertain,
    incorrectClicks: (c.downOutsideControls || 0) + (c.downOnDisabled || 0) + (c.doubleClicks || 0) + (c.staleClicks || 0) + (c.illegal || 0), invalidWagers: c.wagerRejected || 0, timeoutActions: c.timeoutActions || 0 };
}
/** Per-hand facts from the tracker's ACCEPTED states (who was dealt in, heads-up, all-ins, side pots, eliminations at settlement). */
function observeHands(t, facts) {
  const e = t.engine, orig = e.ingest.bind(e);
  e.ingest = (obs) => {
    const r = orig(obs);
    if (r.accepted && r.state && r.state.hand !== null) {
      const s = r.state, f = facts.get(s.hand) || { hand: s.hand, dealtIn: null, headsUp: false, allIn: false, sidePots: 0, eliminatedAtSettlement: 0, settled: false };
      if (s.handStart && f.dealtIn === null) { f.dealtIn = s.participants; f.headsUp = !!s.headsUp; }
      if (s.seats.some((q) => q.status === 'all-in')) f.allIn = true; if (s.sidePots && s.sidePots.length > f.sidePots) f.sidePots = s.sidePots.length;
      if (s.status === 'complete' && s.settlement && s.settlement.ok && !f.settled) { f.settled = true; f.eliminatedAtSettlement = (s.settlement.eliminated || []).length; }
      facts.set(s.hand, f); if (facts.size > 5000) facts.delete(facts.keys().next().value);
    }
    return r;
  };
}
function handSummary(all) {
  const hs = all.filter((f) => f.dealtIn !== null);
  return { handsObserved: hs.length, allEightDealtIn: hs.filter((f) => f.dealtIn === 8).length, withEliminatedSeats: hs.filter((f) => f.dealtIn < 8).length, headsUp: hs.filter((f) => f.headsUp).length,
    allIn: hs.filter((f) => f.allIn).length, sidePots: hs.filter((f) => f.sidePots > 1).length, endingWithElimination: hs.filter((f) => f.eliminatedAtSettlement > 0).length, endingWithTwoOrMoreEliminations: hs.filter((f) => f.eliminatedAtSettlement > 1).length,
    dealtInHistogram: hs.reduce((a, f) => { a[f.dealtIn] = (a[f.dealtIn] || 0) + 1; return a; }, {}) };
}
// A hand in which NOBODY had to act (every remaining player all-in from the antes and blinds) is dealt, run out and settled at once, so
// its opening may never be on screen: the tracker refuses it as missed / untracked - correctly, it needed no input. With the dealer's
// oracle such refusals are told apart from a missed hand that DID need decisions (only those count as reconstruction failures).
function tableStats(t, orc) {
  const r = t.report(), gs = t.gameplayStatus(), rej = {}, acted = orc ? new Set((orc.accepted || []).map((a) => a.hand)) : null, noDecision = new Set();
  const handOf = (d) => { const m = /hand (\d+)/i.exec(d || ''); return m ? Number(m[1]) : null; };
  for (const x of t.engine.rejections) { const i = x.issues[0], k = i.code, h = handOf(i.detail); rej[k] = (rej[k] || 0) + 1; if (acted && ['missed-hand-start', 'untracked-hand'].includes(k) && h !== null && !acted.has(h)) noDecision.add(h); }
  const noDecisionRefusals = acted ? t.engine.rejections.filter((x) => { const i = x.issues[0], h = handOf(i.detail); return i.code === 'missed-hand-start' && h !== null && noDecision.has(h); }).length : 0;
  return { attempted: t.m.attempted, confirmed: t.m.confirmed, rejected: t.m.rejected, ambiguous: t.m.ambiguous, timedOut: t.m.timedOut, uncertain: t.m.uncertain, cancelled: t.m.cancelled, deadlineMisses: t.m.deadline,
    frames: t.m.frames, refusedReadings: t.m.rejectedFrames, refusalCodes: rej, reconstructionFailures: Object.entries(rej).filter(([k]) => !['untracked-hand', 'stale-observation'].includes(k)).reduce((a, [, v]) => a + v, 0) - noDecisionRefusals,
    untrackedHands: gs.tracking.untrackedHands, untrackedHandsWithoutDecision: noDecision.size, untrackedHandsNeedingInput: Math.max(0, gs.tracking.untrackedHands - noDecision.size), recoveries: gs.tracking.recoveries, eliminationsSeen: t.m.eliminationsSeen, verifyingSteps: t.m.verifyingSteps, gameplay: gs.code, gameplayEpisodes: gs.episodes,
    lifecycle: t.lc.state, completed: t.completed, tournamentRemaining: gs.tournament.remaining, latencyMs: r.latencyMs };
}

/* ---------------- scenarios ---------------- */
const ACCEPTANCE = {
  T1: ['Hands that start with eliminated players are tracked (the Milestone 2 stall)', async (env) => {
    const { checks, ck } = M2.checker(), s = await M2.setup(env, 1, { stacks: M2STALL, ...GAP, options: tableOpts }), [t] = s.tables;
    try {
      const hands = () => new Set(t.log.filter((e) => e.status === 'confirmed').map((e) => e.hand)).size;
      await until(() => hands() >= 4 || t.completed, FAKE ? 120000 : 300000);
      const o = oracleFor(await s.fx.oracle(true), s.ws[0]), x = crossCheck(t, o), st = tableStats(t, o);
      ck('play continued over 4+ hands (Milestone 2 stopped at the first hand after an elimination)', hands() >= 4 || !!t.completed, hands());
      ck('no hand refused as missed or untracked', st.untrackedHands === 0 && !st.refusalCodes['missed-hand-start'] && !st.refusalCodes['untracked-hand'], st.refusalCodes);
      ck('the eliminated seats 2 and 6 were recognised (not treated as folds)', t.engine.tournamentStatus().eliminated.map((e) => e.seat).filter((q) => q === 2 || q === 6).length === 2, t.engine.tournamentStatus().eliminated);
      ck('every confirmed action matches the dealer, in order', x.wrongActions === 0 && x.confirmedNotApplied === 0, x);
      ck('no incorrect click, no invalid wager', x.incorrectClicks === 0 && x.invalidWagers === 0, x);
      ck('no uncertain / ambiguous / timed-out action', st.uncertain + st.ambiguous + st.timedOut === 0, [st.uncertain, st.ambiguous, st.timedOut]);
      return { checks, metrics: { hands: hands(), crossCheck: x, table: st } };
    } finally { await s.done(); }
  }],
  T2: ['A tournament is played to its end; the end is a normal stop', async (env) => {
    const { checks, ck } = M2.checker(), s = await M2.setup(env, 1, { stacks: SHORT3, ...GAP, options: tableOpts }), [t] = s.tables;
    try {
      await settleWithin(s.runs[0], FAKE ? 240000 : 600000); const tEnd = mono();
      const o = oracleFor(await s.fx.oracle(true), s.ws[0]), x = crossCheck(t, o), st = tableStats(t, o), winner = o ? o.state.stacks.findIndex((v) => v > 0) : -1, funded = o ? o.state.stacks.filter((v) => v > 0).length : null;
      ck('the table recognised the end of the tournament', !!t.completed, t.completed); ck('the winner is the dealer\'s winner', !!t.completed && t.completed.winner === winner, [t.completed && t.completed.winner, winner]);
      ck('one player holds every chip (final player count 1)', funded === 1, o && o.state.stacks);
      ck('lifecycle STOPPED with cause tournament-complete; run() ended', t.lc.state === LS.STOPPED && t.lc.cause.kind === 'tournament-complete', t.lc.state + ' / ' + (t.lc.cause && t.lc.cause.kind));
      ck('dashboard message: "Tournament finished. Automated gameplay has stopped normally."', t.lc.message()[1] === 'Tournament finished. Automated gameplay has stopped normally.' && t.gameplay.code === 'tournament-complete');
      ck('eliminations during play were recognised', st.eliminationsSeen >= 2, st.eliminationsSeen);
      // A hand in which NOBODY had to act (every remaining player all-in from the blinds and antes) is dealt, run out and settled at once,
      // so its opening may never be on screen: such a hand is refused as missed / untracked - it needed no input - and nothing else may be.
      const acted = new Set(((o && o.accepted) || []).map((a) => a.hand)), handOf = (d) => { const m = /hand (\d+)/i.exec(d || ''); return m ? Number(m[1]) : null; }, noInput = new Set();
      const other = t.engine.rejections.filter((r) => { const i = r.issues[0], h = handOf(i.detail); if (['missed-hand-start', 'untracked-hand'].includes(i.code) && h !== null && !acted.has(h)) { noInput.add(h); return false; } return true; });
      // the TRACKER may refuse nothing else; a frame the reader could not read at all (on a real desktop: a capture taken while the window
      // repaints) is refused safely and only reported - unless such frames are not rare (more than 5 % of all readings)
      const unreadable = Math.max(0, st.refusedReadings - t.engine.rejections.length);
      ck('the tracker refused no reading (except the unseen opening of a hand that needed no decision)', other.length === 0, { refusalCodes: st.refusalCodes, handsWithoutDecisions: [...noInput], other: other.slice(0, 3).map((r) => r.issues[0].code + ': ' + r.issues[0].detail) });
      ck('frames the reader could not read are rare (at most 5 % of readings; each refused, never guessed)', unreadable <= Math.max(1, Math.floor(0.05 * st.frames)), { unreadableFrames: unreadable, readings: st.frames });
      ck('every confirmed action matches the dealer, in order; nothing applied unconfirmed', x.wrongActions === 0 && x.confirmedNotApplied === 0 && x.appliedNotConfirmed === 0, x);
      ck('no incorrect click, no invalid wager', x.incorrectClicks === 0 && x.invalidWagers === 0, x);
      await sleep(FAKE ? 300 : 2000); ck('no capture and no input after the end', since(env.log, 'input', s.ws[0].hwnd, tEnd) === 0 && since(env.log, 'capture', s.ws[0].hwnd, tEnd) === 0, [since(env.log, 'input', s.ws[0].hwnd, tEnd), since(env.log, 'capture', s.ws[0].hwnd, tEnd)]);
      ck('Resume does not restart a finished tournament', t.resume() === false);
      return { checks, metrics: { hands: o && o.hands, crossCheck: x, table: st } };
    } finally { await s.done(); }
  }],
  T3: ['A hand first seen after its opening: untracked, no input; recovery at the next verified hand', async (env) => {
    const { checks, ck } = M2.checker(); let acted = null;
    const s = await M2.setup(env, 1, { ...GAP, actionTimeout: FAKE ? 300 : 900, clockUntilHand: 1, options: tableOpts, beforeRun: async (fx) => { acted = await fx.act(1, 'call'); } }), [t] = s.tables, w = s.ws[0];
    try {
      let tU = null, tR = null; const conds = [];
      await until(() => { const c = t.gameplay.code; if (conds[conds.length - 1] !== c) conds.push(c); const ts = t.engine.trackingStatus(); if (tU === null && ts.status === 'untracked-hand') tU = mono(); if (tR === null && t.m.handRecoveries >= 1) tR = mono(); return tR !== null && t.m.confirmed >= 4; }, FAKE ? 60000 : 240000, 10);
      const ts = t.engine.trackingStatus(), o = oracleFor(await s.fx.oracle(true), w), x = crossCheck(t, o);
      ck('an action happened before automation started (call by the player to act)', !!(acted && acted.accepted), acted);
      ck('hand 1 was untracked (missed-hand-start), with its reason shown', ts.untrackedHands === 1 && tU !== null && (ts.lastRecovery ? ts.lastRecovery.cause === 'missed-hand-start' : false), ts);
      ck('no input while the hand was untracked', tU !== null && tR !== null && since(env.log, 'input', w.hwnd, tU) - since(env.log, 'input', w.hwnd, tR) === 0);
      ck('the table\'s own clock (not the Workbench) finished hand 1', x.timeoutActions > 0, x.timeoutActions);
      ck('recovered automatically at hand 2 (counted)', ts.recoveries === 1 && ts.lastRecovery && ts.lastRecovery.toHand === 2, ts.lastRecovery);
      const at = (c) => conds.indexOf(c); ck('conditions: waiting for a valid hand > verifying > playing', at('waiting-next-hand') >= 0 && at('waiting-next-hand') < at('verifying') && at('verifying') < at('playing'), conds.join(' > '));
      ck('play continues after the recovery (4+ confirmed actions)', t.m.confirmed >= 4, t.m.confirmed);
      ck('every confirmed action matches the dealer; no incorrect click', x.wrongActions === 0 && x.confirmedNotApplied === 0 && x.incorrectClicks === 0, x);
      return { checks, metrics: { conditions: conds, tracking: ts, crossCheck: x } };
    } finally { await s.done(); }
  }],
  T4: ['Think-time holds: one seat acting on consecutive streets with every control hidden (pre-existing defect fixed in M3)', async (env) => {
    const { checks, ck } = M2.checker(), s = await M2.setup(env, 1, { ...GAP, turnDelay: 1500, turnDelayFake: 500, options: tableOpts }), [t] = s.tables;
    try {
      await until(() => t.m.confirmed >= 15 || t.lc.is(LS.SAFETY_PAUSED), FAKE ? 120000 : 300000);
      const o = oracleFor(await s.fx.oracle(true), s.ws[0]), x = crossCheck(t, o), st = tableStats(t, o);
      ck('15 actions confirmed through the holds', t.m.confirmed >= 15, t.m.confirmed); ck('never safety-paused by an unconfirmable action', !t.lc.history.some((h) => h.to === LS.SAFETY_PAUSED), t.lc.history.map((h) => h.to).join(' > '));
      ck('no controls-disagree refusal', !st.refusalCodes['controls-disagree'], st.refusalCodes); ck('every confirmed action matches the dealer; no incorrect click', x.wrongActions === 0 && x.confirmedNotApplied === 0 && x.incorrectClicks === 0, x);
      return { checks, metrics: { crossCheck: x, table: st } };
    } finally { await s.done(); }
  }],
  // 0.36.2 M3.2: T5 strengthened (event timeline, numbered assertions 1-9, bounded event-based waits, input-confirmation evidence) and
  // T5P - the operator's failure reproduced on purpose: table 2 is PAUSED by an action its table received but did not apply, then closed
  T5: ['Two tables: eliminations on both, one window closes; no input crosses tables', (env) => t5Scenario(env, { pausedFirst: false })],
  T5P: ['Two tables: table 2 paused by an action its table did not apply, then its window closes (the operator failure, reproduced)', (env) => t5Scenario(env, { pausedFirst: true })],
  T6: ['Emergency stop right after an elimination: stop wins, no input, no automatic recovery', async (env) => {
    const { checks, ck } = M2.checker(), s = await M2.setup(env, 1, { stacks: TINY, ...GAP, options: tableOpts }), [t] = s.tables, w = s.ws[0];
    try {
      await until(() => t.m.eliminationsSeen >= 1, FAKE ? 90000 : 300000); ck('an elimination was recognised', t.m.eliminationsSeen >= 1, t.m.eliminationsSeen);
      await env.estop(); s.sched.emergencyStop('M3 acceptance'); t.safetyPause('emergency-stop', 'emergency stop (M3 acceptance)'); const te = mono();
      await sleep(FAKE ? 600 : 3000);
      ck('SAFETY_PAUSED by the emergency stop', t.lc.state === LS.SAFETY_PAUSED && t.lc.cause.kind === 'emergency-stop', t.lc.state); ck('gameplay condition: emergency stop', t.gameplay.code === 'emergency-stop', t.gameplay.code);
      ck('no input while the stop is latched', since(env.log, 'input', w.hwnd, te) === 0); ck('no automatic recovery', t.lc.transition(LS.RECOVERY_PENDING, { kind: 'auto' }).refused === 'operator-required');
      const arm = await env.session.request('arm'); ck('the driver refuses to arm while the stop is latched', arm.ok === false, arm.code);
      await env.resetEstop(); s.sched.reset();
      return { checks, metrics: { table: tableStats(t) } };
    } finally { await env.resetEstop().catch(() => null); await s.done(); }
  }],
};


/* ---------------- 0.36.2 M3.2: T5 - window loss with two tables, active or paused ---------------- */
const IC = src('image-codec.js');
/** Events in order (ms since the scenario started): lifecycle transitions, scheduler invalidations / rejections of table 2, the close, unconfirmed inputs. */
function t5Timeline() {
  const t0 = mono(), events = [], at = () => Math.round(mono() - t0);
  return { t0, events, at, add: (kind, d) => { events.push({ ms: at(), kind, ...(d || {}) }); if (events.length > 400) events.splice(1, 50); },
    sched: (k, d) => { if (k === 'invalidated' || k === 'invalidated-repeat' || k === 'registered' || (k === 'rejected' && d && d.code === 'target-lost')) events.push({ ms: at(), kind: 'scheduler-' + k, table: d && d.table, registrationId: d && d.registrationId, code: d && d.code, dropped: d && d.dropped, cancelledRunning: d && d.cancelledRunning }); } };
}
/** Oracle facts of one table around an unconfirmed input (graded by the TOOL only; the Workbench never reads the oracle). */
async function oracleAround(fx, table, atMs, spanMs = 8000) {
  const out = { table, summary: null, events: [] };
  try { const list = await fx.oracle(true), o = list.find((x) => x.table === table && !x.closed) || list.find((x) => x.table === table); if (o) out.summary = { hands: o.hands, rev: o.rev, accepted: (o.accepted || []).length, counts: o.counts, lastShown: o.lastShown || null, dropPending: o.dropPending || 0, state: o.state && { hand: o.state.hand, status: o.state.status, actor: o.state.actor, revision: o.state.revision } }; } catch (e) { out.summaryError = e.message; }
  const keep = (e) => e && Math.abs(Number(e.t) - atMs) <= spanMs && ['mouse-down', 'mouse-up', 'double-click', 'action', 'shown', 'hand-start', 'hand-complete', 'test-control', 'closed', 'closed-by-user', 'resize', 'moved', 'minimized'].includes(e.kind);
  const slim = (e) => { const { state, after, ...rest } = e; return rest; };
  try {
    if (fx.oracleEvents) out.events = fx.oracleEvents.filter((e) => e.table === table && keep(e)).map(slim);
    else if (fx.oracleDir) { const f = path.join(fx.oracleDir, 'oracle-table-' + String(table).padStart(2, '0') + '.jsonl'); if (fs.existsSync(f)) { const tail = fs.readFileSync(f, 'utf8').split('\n').slice(-3000); for (const l of tail) { if (!l.trim()) continue; try { const e = JSON.parse(l); if (keep(e)) out.events.push(slim(e)); } catch (x) { /* partial line */ } } } }
  } catch (e) { out.eventsError = e.message; }
  if (out.events.length > 120) out.events = out.events.slice(-120);
  return out;
}
/** Save the evidence of every unconfirmed input of a scenario (JSON + the window's own frames before / after as PNG). */
function saveUnconfirmed(id, list) {
  const files = [];
  for (const u of list) {
    const base = 'unconfirmed-' + id + '-table' + u.rec.table + '-' + u.rec.seq;
    try { fs.writeFileSync(path.join(M2.WORK, base + '.json'), JSON.stringify({ ...JSON.parse(JSON.stringify(u.rec)), oracle: u.oracle || null, scenarioMs: u.ms }, null, 1)); files.push(base + '.json'); } catch (e) { files.push(base + '.json not written: ' + e.message); }
    for (const k of ['before', 'after']) { const img = u.rec.images && u.rec.images[k]; if (!img) continue; try { fs.writeFileSync(path.join(M2.WORK, base + '-' + k + '.png'), Buffer.from(IC.encodePng(img))); files.push(base + '-' + k + '.png'); } catch (e) { /* evidence is best effort */ } }
  }
  return files;
}
async function t5Scenario(env, o) {
  const { checks, ck } = M2.checker(), tl = t5Timeline(), unconf = [], warn = (name, pass, detail) => { const r = ck(name, pass, detail); checks[checks.length - 1].warning = true; return r; };
  const s = await M2.setup(env, 2, { stacks: TINY, ...GAP, options: tableOpts, onSchedulerEvent: tl.sched }), [t1, t2] = s.tables, [w1, w2] = s.ws;
  for (const t of s.tables) { t.lc.on((ev) => tl.add('lifecycle', { table: ev.table, from: ev.from, to: ev.to, cause: ev.cause && ev.cause.kind, source: ev.cause && ev.cause.source })); t.onUnconfirmed = (rec) => { const u = { rec, ms: tl.at() }; unconf.push(u); tl.add('unconfirmed-input', { table: rec.table, inputStatus: rec.inputStatus, control: rec.control, reason: rec.reason }); u.pending = oracleAround(s.fx, rec.table, Date.now()).then((x) => { u.oracle = x; }); }; }
  const inputs = (w, from, to) => env.log.filter((e) => e.kind === 'input' && e.hwnd === LC.normHwnd(w.hwnd) && e.at >= from && (to === undefined || e.at < to)).length;
  const probes = (w, from) => env.log.filter((e) => e.kind === 'probe' && e.hwnd === LC.normHwnd(w.hwnd) && e.at >= from).length;
  const metrics = { variant: o.pausedFirst ? 'paused-then-closed' : 'active-close' };
  let cleaned = false;
  try {
    // 1-2. both tables start and act
    await until(() => t1.lc.history.some((h) => h.to === LS.ACTIVE) && t2.lc.history.some((h) => h.to === LS.ACTIVE), FAKE ? 30000 : 90000);
    ck('1. both tables started (REGISTERED -> ACTIVE: identity verified, first reading accepted)', t1.lc.history.some((h) => h.to === LS.ACTIVE) && t2.lc.history.some((h) => h.to === LS.ACTIVE), [t1.lc.state, t2.lc.state]);
    const t2Held = () => t2.lc.is(LS.SAFETY_PAUSED) || !!t2.paused;
    await until(() => (t1.m.confirmed >= 2 || !!t1.completed) && (t2.m.confirmed >= 2 || t2Held()), FAKE ? 90000 : 300000);
    ck('2. both tables performed confirmed actions', t1.m.confirmed >= 1 && t2.m.confirmed >= 1, [t1.m.confirmed, t2.m.confirmed]);
    if (o.pausedFirst) {
      // the operator's condition: table 2's next click is delivered but its table does not apply it -> no change for the whole
      // confirmation window -> "rejected" -> paused. Milestone 3.1 left this table ACTIVE behind a gameplay pause and never noticed the close.
      const d = await s.fx.dropNextAction(2, 1); tl.add('test-control', { table: 2, control: 'drop-next-action', reply: d && (d.pending !== undefined ? d.pending : d.ok) });
      await until(() => t2.lc.is(LS.SAFETY_PAUSED) || t2.lc.terminal, FAKE ? 30000 : 60000); const tp = mono(); tl.add('table-2-paused', { state: t2.lc.state, cause: t2.lc.cause && t2.lc.cause.kind });
      const last = t2.log[t2.log.length - 1] || {};
      ck('P1. table 2 paused by the action its table did not apply: SAFETY_PAUSED (input-rejected), classified rejected-no-change', t2.lc.is(LS.SAFETY_PAUSED) && t2.lc.cause.kind === 'input-rejected' && last.inputClass === 'rejected-no-change', { lifecycle: t2.lc.state, cause: t2.lc.cause && t2.lc.cause.kind, inputClass: last.inputClass, reason: last.reason });
      await sleep(FAKE ? 2600 : 3500);   // the paused interval is 1 s: at least two health probes are due in this window
      const iWhile = inputs(w2, tp), p2 = probes(w2, tp), cWhile = env.log.filter((e) => e.kind === 'capture' && e.hwnd === LC.normHwnd(w2.hwnd) && e.at >= tp).length, gpc = t2.gameplay.code, op = oracleFor(await s.fx.oracle(true), w2), dc = (op && op.counts) || {};
      ck('P2. the unapplied action was not repeated and nothing resumed by itself (no input while paused; the table received exactly the one dropped press)', iWhile === 0 && t2.lc.is(LS.SAFETY_PAUSED) && !!t2.paused && dc.droppedByTest === 1, { inputsWhilePaused: iWhile, lifecycle: t2.lc.state, droppedByTest: dc.droppedByTest, accepted: dc.accepted });
      ck('P3. while paused the window is still monitored (identity probes continue; no capture, no input)', p2 >= 2 && cWhile === 0, { probesWhilePaused: p2, capturesWhilePaused: cWhile, health: t2.health && t2.health.snapshot().counts });
      ck('P4. evidence of the unapplied input recorded (region, point, scaling, client, driver result, lease, confirmation trace, frames)', t2.unconfirmed.length >= 1 && ((r) => !!(r.control && r.selectedPoint && r.clientAtReading && r.driver && r.scheduler && r.confirmation && r.confirmation.timeoutMs && r.frames && r.windowAfter))(t2.unconfirmed[t2.unconfirmed.length - 1]), t2.unconfirmed.length ? { inputStatus: t2.unconfirmed[0].inputStatus, control: t2.unconfirmed[0].control, windowAfter: t2.unconfirmed[0].windowAfter, polls: t2.unconfirmed[0].confirmation.polls } : 'none');
      ck('P5. gameplay condition shown: input confirmation failure', gpc === 'input-confirmation-failure', gpc);
    } else {
      await until(() => (t1.m.eliminationsSeen >= 1 || !!t1.completed) && (t2.m.confirmed >= 3 || t2Held()), FAKE ? 90000 : 300000);
    }
    const before2 = { lifecycle: t2.lc.state, cause: t2.lc.cause && t2.lc.cause.kind, gameplayPaused: !!t2.paused, confirmed: t2.m.confirmed, unconfirmedSoFar: t2.unconfirmed.length }; metrics.beforeClose = before2;
    // 3. close table 2's window
    const c1 = t1.m.confirmed, iBefore = inputs(w2, 0), tc = mono(); tl.add('close-requested', { table: 2, table2: before2 });
    const ex = await s.fx.close(2); tl.add('window-closed', { table: 2, exited: !!ex });
    ck('3. table 2 window closed (the test-table process exited)', !!ex, ex ? { code: ex.code } : 'no exit message within 10 s');
    // 4. the ORIGINAL identity is no longer valid (window-info for the registered handle, process and start time)
    const pr = await LC.probeIdentity(env.session, t2.identity); tl.add('identity-probe-by-test', { exists: pr.exists, matches: pr.matches, code: pr.code });
    ck('4. the original window identity is no longer valid', pr.exists === false || (pr.exists === true && pr.matches === false), { exists: pr.exists, matches: pr.matches, code: pr.code, problems: pr.problems });
    // 5. TARGET_LOST (bounded, event-based)
    const lost = await until(() => t2.lc.terminal, 15000), tLost = mono(); const detectMs = lost ? Math.round(tLost - tc) : null; tl.add(lost ? 'target-lost-observed' : 'target-lost-NOT-observed', { detectMs });
    ck('5. table 2 TARGET_LOST after its window closed', lost, { state: t2.lc.state, detectMs, source: t2.lost && t2.lost.source, previousState: t2.lost && t2.lost.previousState, gameplayHeldAtLoss: t2.lost && t2.lost.gameplayHeldAtLoss, reason: t2.lost && t2.lost.reason });
    // 6. its scheduler registration is invalidated (and nothing else is)
    const st = s.sched.status(), inv = tl.events.filter((e) => e.kind === 'scheduler-invalidated' && e.table === 2);
    ck('6. the scheduler blocks only table 2 (its registration revoked; table 1 still registered)', st.unavailableTables.join() === '2' && st.revokedRegistrations.some((r) => r.registrationId === t2.registrationId) && !st.revokedRegistrations.some((r) => r.registrationId === t1.registrationId) && st.registrations[1] === t1.registrationId && inv.length === 1, { unavailableTables: st.unavailableTables, revoked: st.revokedRegistrations.map((r) => r.table + ':' + r.registrationId), invalidationEvents: inv.length, cancellation: t2.cancellation });
    const j = await s.sched.submit({ table: 2, registrationId: t2.registrationId, kind: 'fold', deadline: mono() + 5000, run: async () => 'ran' });
    ck('6b. a later job of the lost registration is refused (target-lost)', j.ok === false && j.code === 'target-lost', j.code || j.ok);
    // 7. no input reached the closed window
    await sleep(FAKE ? 300 : 2000); const iAfter = inputs(w2, lost ? tLost : tc);
    ck('7. no input reached the closed window after the loss', iAfter === 0, { afterLoss: iAfter, betweenCloseAndLoss: lost ? inputs(w2, tc, tLost) : null, beforeClose: iBefore });
    // 8. table 1 unaffected
    await until(() => t1.m.confirmed >= c1 + 5 || !!t1.completed, FAKE ? 90000 : 300000);
    const x1 = crossCheck(t1, oracleFor(await s.fx.oracle(true), w1));
    ck('8a. table 1 keeps playing (or finished its tournament)', t1.m.confirmed >= c1 + 5 || !!t1.completed, [t1.m.confirmed - c1, !!t1.completed]);
    ck('8b. table 1 not lost, not invalidated; its registration is current', !t1.lc.terminal && s.sched.status().registrations[1] === t1.registrationId && !s.sched.status().unavailableTables.includes(1), { lifecycle: t1.lc.state, registration: s.sched.status().registrations[1] === t1.registrationId });
    ck('8c. table 1: every confirmed action matches its own dealer; no incorrect click', x1.wrongActions === 0 && x1.confirmedNotApplied === 0 && x1.incorrectClicks === 0, x1);
    if (!o.pausedFirst) ck('eliminations recognised on table 1', t1.m.eliminationsSeen >= 1 || !!t1.completed, t1.m.eliminationsSeen);
    // 9. cleanup
    await Promise.all(unconf.map((u) => u.pending)); const evidence = saveUnconfirmed(o.pausedFirst ? 'T5P' : 'T5', unconf);
    const runsBefore = s.runs.length, cleanupAt = tl.at(); tl.add('cleanup-started'); await s.done(); cleaned = true;
    const settled = await Promise.all(s.runs.map((r) => settleWithin(r, 1000)));
    ck('9. cleanup completed: both run loops ended, health monitors stopped, no input job left', runsBefore === 2 && settled.every((x) => x === 'done') && !t1.health.running && !t2.health.running && !s.sched.status().running && s.sched.status().queued.length === 0, { runs: settled, monitors: [t1.health.running, t2.health.running], scheduler: { running: s.sched.status().running, queued: s.sched.status().queued.length } });
    // input confirmation, reported separately (a WARNING, with evidence): an action that was sent but not confirmed, other than the
    // fault T5P induces on purpose and an action interrupted by the close itself, is a confirmation problem to investigate
    const induced = (u) => o.pausedFirst && u.rec.table === 2 && u.rec.inputStatus === 'rejected-no-change' && !unconf.slice(0, unconf.indexOf(u)).some((v) => v.rec.table === 2 && v.rec.inputStatus === 'rejected-no-change');
    const byClose = (u) => u.rec.table === 2 && u.ms >= tc - tl.t0 && u.rec.inputStatus === 'uncertain';
    // an action in flight when the scenario's own cleanup stops the tables is (correctly) uncertain - caused by the test, not a confirmation problem
    const byCleanup = (u) => u.ms >= cleanupAt && (u.rec.inputStatus === 'uncertain' || u.rec.inputStatus === 'cancelled-after-input');
    const other = unconf.filter((u) => !induced(u) && !byClose(u) && !byCleanup(u));
    warn('input confirmation: every action sent on either table was confirmed (an unconfirmed input is reported here with its evidence)', other.length === 0, other.length ? other.map((u) => ({ table: u.rec.table, inputStatus: u.rec.inputStatus, control: u.rec.control, reason: u.rec.reason, clickedAt: u.rec.clickedAt, hitClass: u.rec.hitClass, foregroundAfter: u.rec.windowAfter && u.rec.windowAfter.foreground, dpiScale: u.rec.displayScaling, dealer: u.oracle && u.oracle.summary && u.oracle.summary.counts && { accepted: u.oracle.summary.counts.accepted, staleClicks: u.oracle.summary.counts.staleClicks, illegal: u.oracle.summary.counts.illegal, downOutsideControls: u.oracle.summary.counts.downOutsideControls, droppedByTest: u.oracle.summary.counts.droppedByTest } })) : 'none');
    Object.assign(metrics, { table1: tableStats(t1), table2: tableStats(t2), crossCheck1: x1, detectMs, lossSource: t2.lost && t2.lost.source, lostWhile: t2.lost && { previousState: t2.lost.previousState, gameplayHeld: t2.lost.gameplayHeldAtLoss }, health2: t2.health.snapshot(), unconfirmedInputs: unconf.map((u) => ({ ms: u.ms, table: u.rec.table, inputStatus: u.rec.inputStatus, control: u.rec.control, cause: induced(u) ? 'induced by T5P (drop-next-action)' : byClose(u) ? 'the window was closed by the test' : byCleanup(u) ? 'stopped by the test cleanup' : 'NOT EXPLAINED by the test', oracle: u.oracle ? { summary: u.oracle.summary, events: u.oracle.events.length } : null })), evidenceFiles: evidence, timeline: tl.events });
    return { checks, metrics };
  } finally { if (!cleaned) { await Promise.all(unconf.map((u) => u.pending).filter(Boolean)).catch(() => null); try { saveUnconfirmed((o.pausedFirst ? 'T5P' : 'T5') + '-partial', unconf); } catch (e) { /* best effort */ } await s.done(); } }
}

/* ---------------- stability (N tables) and campaign: tournaments one after another, with faults ---------------- */
async function playSlots(env, n, o) {
  const fx = env.fixture(n, { stacks: o.stacks, ...GAP, width: 800, layout: n > 4 ? 'cascade' : 'grid' });
  const sc = new Scope('slots'), outer = M2.currentScope(); sc.onCleanup(() => fx.stop()); const ws = await fx.ready(), rec = new XA.DiagnosticsRecorder({ max: 50000 }); if (outer) outer.recorder(rec); const sched = new SCH.InputScheduler({ maxQueue: 32, onCancel: () => env.session.request('cancel-all') });
  const arm = await env.session.request('arm'); if (!arm.ok) throw new Error('arm refused: ' + arm.error);
  const slots = ws.map((w) => ({ w, t: null, run: null, generation: 0, tournaments: [], estopInputs: 0, facts: [], samples: { cursor: [], input: [], confirm: [], e2e: [], scheduleWait: [] }, inputStatus: {}, lossResponseMs: [] })), faults = { closeReopen: 0, estop: 0 }, violations = [];
  // 0.36.2 M3.2: raw timing samples of every table generation (measurements only; the motion speed is unchanged)
  const collect = (sl, t) => { if (!t || t._collected) return; t._collected = true; const add = (k, a) => { for (const v of a || []) if (Number.isFinite(v)) sl.samples[k].push(v); }; add('cursor', t.m.cursor); add('input', t.m.input); add('confirm', t.m.confirmMs); add('e2e', t.m.e2e); add('scheduleWait', t.m.scheduleWait); for (const e of t.log) { const k = e.inputClass || e.status; sl.inputStatus[k] = (sl.inputStatus[k] || 0) + 1; } };
  let stopAll = false, completedHands = 0;
  const start = async (sl) => { const r = await M2.register(env, sl.w); const t = M2.table(env, sl.w, r, sched, rec, { options: tableOpts }); const op = await t.capture.open(); if (!op || op.ok !== true) throw new Error('capture refused'); const facts = new Map(); sl.facts.push(facts); observeHands(t, facts); sl.t = sc.table(t); if (outer) outer.watch(t); sl.run = sc.run(t.run(Infinity)); sl.startedAt = mono(); sl.lastConfirmed = 0; sl.lastProgress = mono(); };
  const finish = async (sl, why) => {   // record the tournament, retire the table window, open a fresh one (new tournament, new registration)
    const t = sl.t; t.stop(why); await settleWithin(sl.run, 15000); t.dispose(); collect(sl, t); const list = await fx.oracle(true), orc = oracleFor(list, sl.w), x = crossCheck(t, orc);
    const hands = orc ? orc.hands - (orc.state.status === 'playing' ? 1 : 0) : 0; completedHands += Math.max(0, hands);
    sl.tournaments.push({ table: sl.w.table, generation: sl.generation, why, hands, completed: !!t.completed, winnerOk: t.completed ? orc && orc.state.stacks.findIndex((v) => v > 0) === t.completed.winner : null, finalPlayers: orc ? orc.state.stacks.filter((v) => v > 0).length : null, eliminations: orc ? orc.state.stacks.filter((v) => v === 0).length : null, crossCheck: x, stats: tableStats(t, orc), seconds: Math.round((mono() - sl.startedAt) / 1000) });
    if (x.wrongActions || x.confirmedNotApplied || x.incorrectClicks || x.invalidWagers) violations.push('table ' + sl.w.table + ' generation ' + sl.generation + ': ' + JSON.stringify(x).slice(0, 300));
    try { await env.session.request('unregister-target', { hwnd: sl.w.hwnd }); } catch (e) { /* gone */ }
    if (stopAll) return;
    await fx.close(sl.w.table); sl.w = await fx.reopen(sl.w.table); sl.generation++; await start(sl);
  };
  try {
    for (const sl of slots) await start(sl);
    const t0 = mono(), endAt = t0 + o.seconds * 1000; let nextFault = t0 + (o.faultEveryMs || Infinity), faultNo = 0;
    while (mono() < endAt && !(o.targetHands && completedHands >= o.targetHands)) {
      await sleep(250);
      for (const sl of slots) {
        const t = sl.t; if (!t) continue;
        if (t.m.confirmed !== sl.lastConfirmed) { sl.lastConfirmed = t.m.confirmed; sl.lastProgress = mono(); }
        if (t.completed) { await finish(sl, 'tournament complete'); continue; }
        if (t.lc.terminal && !sl.closing) { violations.push('table ' + sl.w.table + ' lost unexpectedly: ' + (t.lost && t.lost.reason)); await finish(sl, 'target lost'); continue; }
        if (mono() - sl.lastProgress > (FAKE ? 45000 : 120000) && !t.lc.is(LS.SAFETY_PAUSED)) { violations.push('table ' + sl.w.table + ' generation ' + sl.generation + ': no confirmed action for ' + Math.round((mono() - sl.lastProgress) / 1000) + ' s (gameplay ' + t.gameplay.code + ': ' + (t.gameplay.detail || '') + ')'); await finish(sl, 'stalled'); continue; }
        if (t.lc.is(LS.SAFETY_PAUSED) && t.lc.cause.kind !== 'emergency-stop') { violations.push('table ' + sl.w.table + ' safety-paused: ' + t.lc.cause.kind + ' ' + (t.lc.cause.reason || '')); await finish(sl, 'safety-paused'); continue; }
      }
      if (mono() >= nextFault && o.faultEveryMs) {
        nextFault = mono() + o.faultEveryMs; faultNo++;
        if (faultNo % 2 === 1 && slots.length > 1) {   // close one table's window: terminal loss, then a fresh window and registration
          const sl = slots[faultNo % slots.length]; sl.closing = true; faults.closeReopen++; const tc = mono();
          await fx.close(sl.w.table); await until(() => sl.t.lc.terminal, 15000); const tl = mono(); if (!sl.t.lc.terminal) violations.push('table ' + sl.w.table + ': close not detected'); await sleep(FAKE ? 200 : 1500);
          if (since(env.log, 'input', sl.w.hwnd, tl) > 0) violations.push('table ' + sl.w.table + ': input after its window closed');
          sl.t.stop('closed'); await settleWithin(sl.run, 15000); const orc = oracleFor(await fx.oracle(true), sl.w), x = crossCheck(sl.t, orc); sl.tournaments.push({ table: sl.w.table, generation: sl.generation, why: 'window closed (fault)', hands: orc ? orc.hands - 1 : 0, completed: false, crossCheck: x, stats: tableStats(sl.t, orc), closeDetectMs: Math.round(tl - tc), lossSource: sl.t.lost && sl.t.lost.source }); completedHands += Math.max(0, orc ? orc.hands - 1 : 0); sl.lossResponseMs.push(Math.round(tl - tc)); sl.t.dispose(); collect(sl, sl.t);
          sl.w = await fx.reopen(sl.w.table); sl.generation++; sl.closing = false; await start(sl);
        } else {                                       // emergency stop on every table, then an explicit operator reset and resume
          faults.estop++; await env.estop(); sched.emergencyStop('stability test'); for (const sl of slots) sl.t.safetyPause('emergency-stop', 'emergency stop (stability test)'); const te = mono();
          await sleep(FAKE ? 500 : 2500); for (const sl of slots) { const n2 = since(env.log, 'input', sl.w.hwnd, te); sl.estopInputs += n2; if (n2) violations.push('table ' + sl.w.table + ': input during the emergency stop'); if (sl.t.lc.state !== LS.SAFETY_PAUSED && !sl.t.completed) violations.push('table ' + sl.w.table + ': not SAFETY_PAUSED during the stop (' + sl.t.lc.state + ')'); }
          await env.resetEstop(); sched.reset(); const arm2 = await env.session.request('arm'); if (!arm2.ok) violations.push('re-arm refused after reset: ' + arm2.error);
          for (const sl of slots) if (!sl.t.completed && !sl.t.lc.terminal) { if (!sl.t.resume()) violations.push('table ' + sl.w.table + ': operator resume refused'); sl.lastProgress = mono(); }
        }
      }
    }
    stopAll = true;
    for (const sl of slots) if (sl.t && !sl.t.lc.terminal) { const orc = oracleFor(await fx.oracle(true), sl.w); sl.t.stop('end of run'); await settleWithin(sl.run, 15000); collect(sl, sl.t); const x = crossCheck(sl.t, orc); sl.tournaments.push({ table: sl.w.table, generation: sl.generation, why: sl.t.completed ? 'tournament complete' : 'end of run', hands: orc ? orc.hands - (orc.state.status === 'playing' ? 1 : 0) : 0, completed: !!sl.t.completed, crossCheck: x, stats: tableStats(sl.t, orc) }); completedHands += Math.max(0, orc ? orc.hands - (orc.state.status === 'playing' ? 1 : 0) : 0); if (x.wrongActions || x.confirmedNotApplied || x.incorrectClicks || x.invalidWagers) violations.push('table ' + sl.w.table + ': ' + JSON.stringify(x).slice(0, 300)); }
    await env.session.request('disarm');
    return { slots, faults, violations, completedHands, seconds: Math.round((mono() - t0) / 1000), scheduler: sched.metrics() };
  } finally { stopAll = true; await sc.cleanup('end of run'); }
}
function summarise(res) {
  const tours = res.slots.flatMap((s) => s.tournaments), sum = (f) => tours.reduce((a, x) => a + (f(x) || 0), 0);
  return { tables: res.slots.length, seconds: res.seconds, completedHands: res.completedHands, tournamentsStarted: tours.length, tournamentsCompleted: tours.filter((x) => x.completed).length, winnersMatchDealer: tours.filter((x) => x.completed).every((x) => x.winnerOk),
    actionsAttempted: sum((x) => x.stats.attempted), actionsConfirmed: sum((x) => x.stats.confirmed), incorrectActions: sum((x) => x.crossCheck.wrongActions + x.crossCheck.incorrectClicks), invalidWagers: sum((x) => x.crossCheck.invalidWagers),
    missedStateTransitions: sum((x) => x.crossCheck.appliedNotConfirmed), confirmedButNotApplied: sum((x) => x.crossCheck.confirmedNotApplied), refusedReadings: sum((x) => x.stats.refusedReadings), reconstructionFailures: sum((x) => x.stats.reconstructionFailures),
    untrackedHands: sum((x) => x.stats.untrackedHands), untrackedHandsWithoutDecision: sum((x) => x.stats.untrackedHandsWithoutDecision), untrackedHandsNeedingInput: sum((x) => x.stats.untrackedHandsNeedingInput), recoveryEvents: sum((x) => x.stats.recoveries), lifecycleRecoveries: tours.reduce((a, x) => a + ((x.stats.gameplayEpisodes || {}).verifying || 0), 0), eliminationsSeen: sum((x) => x.stats.eliminationsSeen),
    uncertainOrUnconfirmed: sum((x) => x.crossCheck.uncertainOrUnconfirmed), deadlineMisses: sum((x) => x.stats.deadlineMisses), cleanRefusals: sum((x) => x.stats.rejected), unexpectedPauses: res.violations.filter((v) => /stalled|safety-paused|no confirmed action/.test(v)).length,
    finalPlayerCounts: tours.filter((x) => x.completed).map((x) => x.finalPlayers), hands: handSummary(res.slots.flatMap((s) => s.facts.flatMap((m) => [...m.values()]))), faults: res.faults, violations: res.violations,
    // 0.36.2 M3.2: multi-table measurements (brief section 9) - observation only, nothing was tuned or sped up to produce them
    measurements: measurements(res) };
}
/** 0.36.2 M3.2: scheduling delay, cursor travel, input operation, confirmation, per-table action latency (all tables pooled and per table),
 *  deadline misses, rejected / uncertain actions, input status per attempt, completed hands, window-loss response latency. */
function measurements(res) {
  const pool = (k) => res.slots.flatMap((sl) => sl.samples ? sl.samples[k] : []), S = SCH.stats, sum = (o, f) => res.slots.reduce((a, sl) => a + (f(sl) || 0), 0);
  const status = {}; for (const sl of res.slots) for (const [k, v] of Object.entries(sl.inputStatus || {})) status[k] = (status[k] || 0) + v;
  const sm = res.scheduler || {};
  return { tables: res.slots.length, seconds: res.seconds, completedHands: res.completedHands, motion: { maxSpeedPxPerS: M2.MOTION && M2.MOTION.maxSpeed, note: 'configured motion speed unchanged' },
    schedulingDelayMs: S(pool('scheduleWait')), cursorTravelMs: S(pool('cursor')), inputOperationMs: S(pool('input')), confirmationMs: S(pool('confirm')), actionLatencyMs: S(pool('e2e')),
    perTable: res.slots.map((sl) => ({ table: sl.w.table, confirmed: sl.tournaments.reduce((a, x) => a + x.stats.confirmed, 0), actionLatencyMs: S(sl.samples ? sl.samples.e2e : []), schedulingDelayMs: S(sl.samples ? sl.samples.scheduleWait : []), inputStatus: sl.inputStatus || {} })),
    deadlineMisses: { byTables: sum(res, (sl) => sl.tournaments.reduce((a, x) => a + (x.stats.deadlineMisses || 0), 0)), byScheduler: sm.deadlineMisses === undefined ? null : sm.deadlineMisses },
    rejectedActions: sum(res, (sl) => sl.tournaments.reduce((a, x) => a + (x.stats.rejected || 0), 0)), uncertainActions: sum(res, (sl) => sl.tournaments.reduce((a, x) => a + (x.stats.uncertain || 0), 0)), inputStatus: status,
    schedulerRejections: sm.rejected || null, peakQueue: sm.peakQueue === undefined ? null : sm.peakQueue, windowLossResponseMs: S(res.slots.flatMap((sl) => sl.lossResponseMs || [])) };
}
const STABILITY = {};
for (const n of (arg('tables', SUITE === 'campaign' ? '1' : '1,2,5,8')).split(',').map(Number)) STABILITY['M' + n] = [n + ' table(s): short-stack tournaments with eliminations, a window closed and reopened, emergency stops, finished tournaments replaced', async (env) => {
  const { checks, ck } = M2.checker(), secs = Number(arg('seconds', FAKE ? '45' : '90'));
  const res = await playSlots(env, n, { stacks: n === 1 ? TINY : [600, 600, 600, 600, 600, 600, 600, 600], seconds: secs, faultEveryMs: Math.round(secs * 1000 / 3.2) }), s = summarise(res);
  ck('every table played (confirmed actions on every table)', res.slots.every((sl) => sl.tournaments.some((x) => x.stats.confirmed > 0)), res.slots.map((sl) => sl.tournaments.reduce((a, x) => a + x.stats.confirmed, 0)));
  ck('no incorrect action, no invalid wager (oracle)', s.incorrectActions === 0 && s.invalidWagers === 0, [s.incorrectActions, s.invalidWagers]);
  ck('no confirmed action the table did not apply', s.confirmedButNotApplied === 0, s.confirmedButNotApplied);
  ck('no stall, no unexpected pause, no violation', res.violations.length === 0, res.violations.slice(0, 5));
  ck('faults exercised (closure + reopen' + (n > 1 ? '' : ' n/a') + ', emergency stop)', res.faults.estop >= 1 && (n === 1 || res.faults.closeReopen >= 1), res.faults);
  return { checks, metrics: s };
}];
const CAMPAIGN = { C: ['Long campaign: tournaments played to the end one after another until ' + arg('hands', '120') + ' hands are completed', async (env) => {
  const { checks, ck } = M2.checker(), target = Number(arg('hands', '120')), maxMin = Number(arg('max-minutes', FAKE ? '40' : '30')), n = Number(arg('tables', '1'));
  const res = await playSlots(env, n, { stacks: (arg('campaign-stacks', '0,400,400,0,400,400,0,400')).split(',').map(Number), seconds: maxMin * 60, targetHands: target }), s = summarise(res);
  ck('at least ' + target + ' hands completed', s.completedHands >= target, s.completedHands); ck('tournaments were played to the end (winner = dealer winner)', s.tournamentsCompleted >= 1 && s.winnersMatchDealer, [s.tournamentsCompleted, s.winnersMatchDealer]);
  ck('no incorrect action, no invalid wager (oracle)', s.incorrectActions === 0 && s.invalidWagers === 0, [s.incorrectActions, s.invalidWagers]);
  ck('no missed state transition (every action the table applied was confirmed or flagged)', s.missedStateTransitions === 0 && s.confirmedButNotApplied === 0, [s.missedStateTransitions, s.confirmedButNotApplied]);
  ck('no hand-reconstruction failure; no untracked hand that needed a decision (a hand nobody acted in may be first seen finished)', s.reconstructionFailures === 0 && s.untrackedHandsNeedingInput === 0, { reconstructionFailures: s.reconstructionFailures, untrackedHands: s.untrackedHands, withoutDecision: s.untrackedHandsWithoutDecision, needingInput: s.untrackedHandsNeedingInput });
  ck('no stall or unexpected pause', res.violations.length === 0, res.violations.slice(0, 5)); ck('eliminations recognised', s.eliminationsSeen > 0, s.eliminationsSeen);
  return { checks, metrics: s };
}] };

// 0.36.2 M3.2: the focused T5 suite (RUN-M3.2-T5-TEST.cmd): T5 and T5P, --repeat N times, each repetition reported separately
const REPEAT = Math.max(1, Math.min(50, Number(arg('repeat', '1')) || 1));
function t5Suite() { const out = {}; for (let i = 1; i <= REPEAT; i++) { const sfx = REPEAT > 1 ? '#' + i : ''; out['T5' + sfx] = ACCEPTANCE.T5; out['T5P' + sfx] = ACCEPTANCE.T5P; } return out; }
async function main() {
  const SCEN = SUITE === 'stability' ? STABILITY : SUITE === 'campaign' ? CAMPAIGN : SUITE === 't5' ? t5Suite() : ACCEPTANCE;
  const env = FAKE ? await M2.fakeEnv() : await M2.windowsEnv(), t0 = mono();
  const out = { format: 'eightmax-m3-gameplay-acceptance', version: 1, suite: SUITE, app: EM.VERSION, milestone: '0.36.2-milestone-3', environment: env.kind, at: new Date().toISOString(),
    machine: { platform: process.platform, release: os.release(), node: process.version, cpus: os.cpus().length, cpu: os.cpus()[0] && os.cpus()[0].model, ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1) }, host: env.facts, scenarios: [] };
  try {
    for (const [id, [name, fn]] of Object.entries(SCEN)) {
      if (ONLY.length && !ONLY.includes(id) && !ONLY.includes(id.split('#')[0])) continue; const ts = mono(); console.log('--- ' + id + ': ' + name);
      const scope = new Scope(id); M2.setScope(scope); const work = Promise.resolve().then(() => fn(env)); let r, timedOut = false;
      const limit = SUITE === 'campaign' ? (Number(arg('max-minutes', FAKE ? '40' : '30')) + 10) * 60000 : SUITE === 'stability' ? (Number(arg('seconds', '90')) + 600) * 1000 : (FAKE ? 300000 : 900000);
      try { r = await withTimeout(work, limit, 'scenario ' + id + ' time limit'); }
      catch (e) { timedOut = e.code === 'ETIMEOUT'; r = { checks: [{ name: timedOut ? 'scenario finished within its time limit' : 'scenario ran to completion', pass: false, detail: e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e) }] }; }
      if (timedOut) scope.aborted = true; await scope.cleanup(timedOut ? 'time limit' : 'finished'); if (timedOut) await settleWithin(work, 30000); M2.setScope(null);
      // 0.36.2 M3.2: a check marked warning (input confirmation in T5) never hides a failure: 'warning' only when every other check passed
      env.hooks.onRequest = null; const hard = r.checks.filter((c) => !c.warning), soft = r.checks.filter((c) => c.warning);
      const status = !r.checks.length || !hard.length || !hard.every((c) => c.pass) ? 'fail' : soft.every((c) => c.pass) ? 'pass' : 'warning';
      let diag = null; if (status !== 'pass') { try { diag = 'diag-' + SUITE + '-' + id + '.json'; fs.writeFileSync(path.join(M2.WORK, diag), JSON.stringify(M2.diagnosticsDump(scope), null, 1)); } catch (e) { diag = 'not written: ' + e.message; } }
      out.scenarios.push({ id, name, status, durationMs: Math.round(mono() - ts), timedOut, checks: r.checks, metrics: r.metrics || null, ...(diag ? { diagnostics: diag } : {}) });
      for (const c of r.checks) console.log('  [' + (c.pass ? 'PASS' : c.warning ? 'WARN' : 'FAIL') + '] ' + c.name + (c.detail !== null && c.detail !== undefined ? ' - ' + (typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)).slice(0, 200) : ''));
      console.log('  => ' + status.toUpperCase() + ' (' + Math.round((mono() - ts) / 1000) + ' s)');
    }
  } finally { await env.stop(); }
  for (const c of M2.CHILDREN) if (!c.done) await settleWithin(c.promise, 5000);
  // 0.36.2 M3: the handle of a child that has just exited is closed in a later phase of the event loop: sample again (bounded, 1 s)
  // before calling anything a leak (Windows CI run 45203097931 reported the desktop host's handle, sampled one turn after its exit)
  const ALLOWED = ['PipeWrap', 'TTYWrap', 'FSReqCallback', 'FileHandle', 'Immediate']; let counts = {}, unexpected = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, i ? 50 : 0)); counts = {}; for (const k of (process.getActiveResourcesInfo ? process.getActiveResourcesInfo() : [])) counts[k] = (counts[k] || 0) + 1;
    unexpected = Object.entries(counts).filter(([k]) => !ALLOWED.includes(k)).map(([k, v]) => k + ' x' + v); if (!unexpected.length) break;
  }
  out.cleanup = { childProcesses: M2.CHILDREN.map((c) => ({ ...c.info })), allChildrenExited: M2.CHILDREN.every((c) => c.done), activeResources: counts, unexpected, ok: M2.CHILDREN.every((c) => c.done) && unexpected.length === 0 };
  const failed = out.scenarios.filter((s) => s.status === 'fail'), warned = out.scenarios.filter((s) => s.status === 'warning');
  out.summary = { scenarios: out.scenarios.length, passed: out.scenarios.length - failed.length, failed: failed.length, withWarnings: warned.length, checks: out.scenarios.reduce((a, s) => a + s.checks.length, 0), failedChecks: out.scenarios.reduce((a, s) => a + s.checks.filter((c) => !c.pass && !c.warning).length, 0), warningChecks: out.scenarios.reduce((a, s) => a + s.checks.filter((c) => !c.pass && c.warning).length, 0), cleanupOk: out.cleanup.ok };
  out.overall = failed.length === 0 && out.scenarios.length > 0 && out.cleanup.ok ? 'PASS' : 'FAIL'; out.durationMs = Math.round(mono() - t0); out.exitCode = out.overall === 'PASS' ? 0 : 1;
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('Gameplay acceptance ' + SUITE + ' (' + env.kind + '): ' + out.overall + ' - ' + out.summary.passed + '/' + out.summary.scenarios + ' scenarios' + (warned.length ? ' (' + warned.length + ' with warnings)' : '') + ' -> ' + OUT);
  process.exitCode = out.exitCode;
}
main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
