#!/usr/bin/env node
'use strict';
/* 0.36.2 Milestone 3: detailed reproduction of the eliminated-player hand-tracking stall (and, against a repaired tree, proof that
 * play continues). Runs ONE controlled test table (the real fixture dealer of EightMaxTestTable.exe behind the in-process fake host
 * of tests/lifecycle-host-fixture.cjs) with 25 BB tournament stacks and records, without changing any source under test:
 *   starting stacks, every hand start (pre-hand stacks, funded seats, button, blinds), every elimination, the folded flags and stacks
 *   of each frame the hand tracker refused, the refusal messages (counted, so a message repeated every capture cycle shows as one
 *   line with its count), the last confirmed action, and the dealer's final state.
 *   node tools/repro-elimination-stall-0362m3.cjs [workbench-root] [--out FILE] [--seconds N] [--stall-ms N] [--seed N] [--hand-gap-ms N] [--stack-chips N]
 * Against Milestone 2 it reproduces the stall; against Milestone 3 it should play on to the end of the tournament.
 * NOT Windows evidence: fake host, real dealer, real recognition, real hand tracker, real input pipeline (driver simulated). */
const path = require('path'), fs = require('fs');
const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : path.join(__dirname, '..'));
const OUT = opt('--out', null), SECONDS = Number(opt('--seconds', 60)), STALL_MS = Number(opt('--stall-ms', 8000)), SEED = Number(opt('--seed', 1)), GAP = Number(opt('--hand-gap-ms', 400)), STACK = Number(opt('--stack-chips', 2500));
const EM = require(path.join(ROOT, 'src/engine.js')), HS = require(path.join(ROOT, 'src/hand-state.js'));
const FD = require(path.join(ROOT, 'src/fixture-dealer.js'));
const SC = require(path.join(ROOT, 'src/simulator-controls.js')), SP = require(path.join(ROOT, 'src/simulator-profiles.js')), SCH = require(path.join(ROOT, 'src/input-scheduler.js')), XA = require(path.join(ROOT, 'src/execution-adapters.js'));
const { lifecycleHost, TOKEN, SHA } = require(path.join(ROOT, 'tests', 'lifecycle-host-fixture.cjs'));
const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop/COMPONENT-VERSIONS.json'), 'utf8')); } catch (e) { return null; } })();

// ---- instrumentation (wraps prototypes; the code under test is not modified) ----
const hands = [], eliminations = [], rejections = [], refusalCounts = new Map(); let rejectedFrames = 0, acceptedFrames = 0, firstRefusal = null;
const origStart = EM.Table.prototype.startHand;
EM.Table.prototype.startHand = function () {
  const pre = this.players.map((p) => p.stack), r = origStart.apply(this, arguments);
  if (r === false) { hands.push({ hand: this.hand + 1, started: false, tournamentComplete: true, preStacks: pre }); return r; }
  hands.push({ hand: this.hand, started: true, preStacks: pre, fundedSeats: pre.map((s, i) => s > 0 ? i : -1).filter((i) => i >= 0), zeroStackSeats: pre.map((s, i) => s === 0 ? i : -1).filter((i) => i >= 0), button: this.dealer, sb: this.sb, bb: this.bb, openingPot: this.pot(), firstActor: this.actor, displayedFolded: this.players.map((p) => p.folded) });
  return r;
};
const origFinish = EM.Table.prototype.finish;
EM.Table.prototype.finish = function () {
  const before = this.players.map((p) => p.stack + p.total), r = origFinish.apply(this, arguments);
  this.players.forEach((p, i) => { if (p.stack === 0 && before[i] > 0) eliminations.push({ seat: i, eliminatedInHand: this.hand, remainingFunded: this.players.filter((q) => q.stack > 0).length }); });
  return r;
};
const origIngest = HS.HandStateEngine.prototype.ingest;
HS.HandStateEngine.prototype.ingest = function (obs) {
  const r = origIngest.call(this, obs);
  if (r.accepted) { acceptedFrames++; return r; }
  rejectedFrames++;
  const msg = r.issues.map((i) => i.code + ': ' + i.detail).join(' | ');
  refusalCounts.set(msg, (refusalCounts.get(msg) || 0) + 1);
  const rec = { seq: obs && obs.seq, observedHand: obs && obs.hand, street: obs && obs.street, codes: r.issues.map((i) => i.code), detail: r.issues[0] && r.issues[0].detail,
    seats: obs && Array.isArray(obs.seats) ? obs.seats.map((s) => ({ seat: s.seat, stack: s.stack, bet: s.bet, folded: !!s.folded })) : null, button: obs && obs.button, actor: obs && obs.actor, pot: obs && obs.pot };
  if (!firstRefusal) firstRefusal = rec;
  if (rejections.length < 40) rejections.push(rec);
  return r;
};

(async () => {
  const host = lifecycleHost(1, { handGapMs: GAP, ...(STACK !== 2500 ? { stackChips: STACK } : {}) }), api = new SC.HostApi({ token: TOKEN, fetch: host.fetch }), session = SC.hostSession(api); session.capabilities = { singleClickGuardMaxMs: 540 };
  const auth = SC.authorizations({ environment: 'repro-env', approvedBy: 'repro operator', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA }), w = [...host.tables.values()][0];
  // hand 1 was dealt when the fake window reported "ready" (before instrumentation could see it): record it from the dealer
  if (!hands.length && w.dealer.t.hand === 1) { const t = w.dealer.t; hands.push({ hand: 1, started: true, preStacks: t.players.map((p) => p.stack + p.total), fundedSeats: t.players.map((p, i) => i), zeroStackSeats: [], button: t.dealer, sb: t.sb, bb: t.bb, openingPot: t.pot(), firstActor: t.actor, displayedFolded: t.players.map((p) => p.folded), note: 'reconstructed from the dealer (dealt before instrumentation)' }); }
  const t = new SC.SimulatorTable({ id: 1, window: { hwnd: w.hwnd, pid: w.pid, title: 'EightMax Test Table 01', client: w.client }, profile: SP.fixtureProfile({ exeSha256: SHA }), api, session, scheduler: new SCH.InputScheduler({ maxQueue: 8 }), qaAuthorization: auth.qa, recorder: new XA.DiagnosticsRecorder(), allowScripted: true, seed: SEED, timing: { postClickSettleMs: 0 }, options: { decisionWindowMs: 10000, postActionTimeoutMs: 800, pollMs: 5, idlePollMs: 5, stopOnPause: false } });
  const kinds = {}; const run = t.run(Infinity, (r) => { const k = r.kind + (r.reason ? ': ' + String(r.reason).slice(0, 90) : ''); kinds[k] = (kinds[k] || 0) + 1; });
  const t0 = Date.now(); let last = -1, stillSince = Date.now(), ended = 'time budget';
  while (Date.now() - t0 < SECONDS * 1000) {
    await new Promise((r) => setTimeout(r, 250));
    if (w.dealer.t.tournamentComplete) { ended = 'tournament complete'; break; }
    if (t.m.confirmed !== last) { last = t.m.confirmed; stillSince = Date.now(); } else if (Date.now() - stillSince > STALL_MS) { ended = 'no confirmed action for ' + STALL_MS + ' ms'; break; }
  }
  const stalledForMs = Date.now() - stillSince;
  t.stop('repro finished'); let runTimer; await Promise.race([run, new Promise((r) => { runTimer = setTimeout(r, 3000); })]); clearTimeout(runTimer); t.dispose();
  const d = w.dealer.t, st = w.dealer.summary().state, conf = t.log.filter((e) => e.status === 'confirmed'), lastConf = conf[conf.length - 1] || null;
  const funded = d.players.filter((p) => p.stack + p.total > 0).length;
  const doc = {
    format: 'eightmax-repro-elimination-stall', version: 2, tool: 'tools/repro-elimination-stall-0362m3.cjs', sourceTree: ROOT, app: EM.VERSION, at: new Date().toISOString(),
    environment: 'Linux/Node ' + process.version + ', in-process fake host + real fixture dealer (NOT Windows evidence)',
    setup: { tables: 1, seed: SEED, handGapMs: GAP, stackChips: STACK, tournament: true, stakes: { sb: 50, bb: 100, ante: 10 }, startingStacks: hands[0] ? hands[0].preStacks : null },
    ended, wallMs: Date.now() - t0, stalledForMs,
    confirmedActions: t.m.confirmed, attemptedActions: t.m.attempted, frames: t.m.frames, acceptedFrames, rejectedFrames,
    lastConfirmedAction: lastConf ? { hand: lastConf.hand, street: lastConf.street, seat: lastConf.seat, action: lastConf.action } : null,
    handsStarted: hands.filter((h) => h.started).length, hands: hands.slice(0, 400), eliminations,
    dealerFinal: { hand: st.hand, status: st.status, street: st.street, actor: st.actor, stacks: st.stacks, folded: st.folded, fundedPlayers: funded, tournamentComplete: d.tournamentComplete, waitingForSeat: st.status === 'playing' ? st.actor : null },
    tracker: { paused: t.engine.paused, pauseReason: t.engine.pauseReason, untrackedHand: t.engine.tr ? t.engine.tr.untracked : undefined, status: typeof t.engine.trackingStatus === 'function' ? t.engine.trackingStatus() : undefined, tournament: typeof t.engine.tournamentStatus === 'function' ? t.engine.tournamentStatus() : undefined },
    gameplay: typeof t.gameplayStatus === 'function' ? (({ tracking, tournament, ...g }) => g)(t.gameplayStatus()) : undefined, lifecycle: t.lc.state, tournamentRules: t.tournamentRules,
    firstRefusal, refusals: rejections, refusalMessages: [...refusalCounts.entries()].map(([message, count]) => ({ message, count })).sort((a, b) => b.count - a.count),
    stepResults: kinds, input: 'only through the scheduler / driver pipeline; none is sent while the tracker refuses the state', diagnostics: t.rec && t.rec.summary ? t.rec.summary() : undefined,
  };
  doc.stalled = d.status === 'playing' && funded >= 2 && stalledForMs >= STALL_MS && !d.tournamentComplete;
  doc.verdict = doc.stalled ? 'STALL: active players remain, the dealer waits for seat ' + st.actor + ', the tracker refuses every frame' : d.tournamentComplete ? 'tournament completed' : 'no stall within the time budget';
  const text = JSON.stringify(doc, null, 2); if (OUT) fs.writeFileSync(OUT, text);
  console.log(JSON.stringify({ verdict: doc.verdict, ended, confirmed: doc.confirmedActions, handsStarted: doc.handsStarted, eliminations: eliminations.length, lastConfirmedAction: doc.lastConfirmedAction, tracker: doc.tracker, firstRefusal: firstRefusal && { observedHand: firstRefusal.observedHand, codes: firstRefusal.codes, detail: firstRefusal.detail }, topRefusals: doc.refusalMessages.slice(0, 4) }, null, 1));
  process.exitCode = 0;
})().catch((e) => { console.error(e.stack || e); process.exitCode = 2; });
