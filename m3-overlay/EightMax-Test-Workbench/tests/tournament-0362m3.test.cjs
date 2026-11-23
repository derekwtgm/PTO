'use strict';
// 0.36.2 Milestone 3: tournament participation - eliminated players, forced bets of the players dealt in, opening reconstruction,
// tournament seating, untracked-hand recovery and the versioned ledger / checkpoint formats. Deterministic (seeded simulator tables).
const test = require('node:test'), assert = require('node:assert/strict');
const EM = require('../src/engine.js'), HS = require('../src/hand-state.js'), LG = require('../src/hand-ledger.js');
const { HandLedger } = LG;

/** What an image reading provides: no totals, no history; the view is the player to act (the fixture rotates it). */
function screen(t, seq, o = {}) {
  const snap = t.snapshot(), hero = o.heroSeat !== undefined ? o.heroSeat : t.actor >= 0 ? t.actor : (o.lastView || 0), l = t.status === 'playing' ? t.legal() : null;
  const ob = { format: 'eightmax-observation', version: 1, table: t.id, seq, source: 'image', capturedAt: 0, layout: { id: 'eightmax-8max-v2', seats: 8 }, hand: t.hand, status: t.status === 'complete' ? 'complete' : 'playing', street: t.street === 'ready' ? 'preflop' : t.street,
    board: snap.board.slice(), button: t.dealer, actor: t.status === 'playing' ? t.actor : -1, pot: snap.pot, confidence: { overall: 1, fields: { board: 1, pot: 1, stacks: 1, button: 1, actor: 1, street: 1, hand: 1, bets: 1, controls: 1 } },
    seats: snap.players.map((p, i) => ({ seat: i, stack: p.stack, bet: p.bet, folded: p.folded, cards: i === hero && p.cards.length === 2 ? p.cards.slice() : null })), heroSeat: hero };
  if (l && t.actor === hero) { ob.controls = { fold: l.toCall > 0, check: l.canCheck, call: l.toCall > 0, raise: l.canRaise }; if (l.toCall > 0) ob.callAmount = l.callAmount; if (l.canRaise) ob.minRaiseTo = Math.min(l.minRaiseTo, l.maxRaiseTo); }
  return ob;
}
const engine = (o = {}) => new HS.HandStateEngine(1, { track: true, expectedLayout: 'eightmax-8max-v2', ...o });
/** Oracle seat status from the simulator's own state (cards are dealt only to players dealt in). */
function oracleStatus(t, i) { const p = t.players[i]; if (p.cards.length === 0 && p.folded && p.total === 0) return 'eliminated'; if (p.folded) return 'folded'; return p.stack === 0 ? 'all-in' : 'active'; }
/** A tournament table whose next hand starts from `stacks` (0 = eliminated) with the button moving from `prevButton`. */
function tableAt(stacks, prevButton, seed = 7) { const t = new EM.Table(1, seed, 8, { persistentStacks: true }); t.setNextStacks(stacks); t.dealer = prevButton; t.startHand(); return t; }

test('ledger = simulator over whole tournaments: forced bets of the players dealt in, blinds skip eliminated seats, heads-up, short stacks, side pots, settlement (40 tournaments to the end)', (ctx) => {
  const tally = { tournaments: 0, hands: 0, handsWithEliminated: 0, headsUp: 0, shortAnte: 0, shortBlind: 0, forcedRunout: 0, sidePots: 0, eliminations: 0, actions: 0 };
  for (let seed = 1; seed <= 40; seed++) {
    const t = new EM.Table(1, seed * 104729, 8, { persistentStacks: true }), r = new EM.RNG(seed), depth = [300, 600, 1000, 1500, 2500][seed % 5];
    const start = Array.from({ length: 8 }, (_, i) => (seed % 3 === 0 && i === seed % 8 ? 25 : depth)); t.setNextStacks(start);
    for (let h = 0; h < 2000; h++) {
      const pre = t.hand === 0 ? start.slice() : t.players.map((p) => p.stack), prevDealer = t.dealer;
      if (t.startHand() === false) break;
      const led = new HandLedger({ stacks: pre, button: t.dealer }); tally.hands++;
      assert.equal(led.button, t.dealer); assert.equal(led.sbSeat, t.sb, 'small blind seat'); assert.equal(led.bbSeat, t.bb, 'big blind seat');
      assert.deepEqual(led.participants, pre.map((s, i) => (s > 0 ? i : -1)).filter((i) => i >= 0));
      if (prevDealer >= 0) assert.equal(t.dealer, [1, 2, 3, 4, 5, 6, 7, 8].map((k) => (prevDealer + k) % 8).find((i) => pre[i] > 0), 'button moved to the next seat with chips (computed from the stacks, not by the simulator)');
      if (led.participants.length < 8) tally.handsWithEliminated++; if (led.headsUp) tally.headsUp++;
      if (pre.some((s) => s > 0 && s < 10)) tally.shortAnte++; if (led.p[led.sbSeat].bet < 50 || led.p[led.bbSeat].bet < 100) tally.shortBlind++;
      for (let i = 0; i < 8; i++) assert.equal(led.seatStatus(i) === 'eliminated', pre[i] === 0);
      const hole = {}; t.players.forEach((p, i) => { hole[i] = p.cards.slice(); });
      if (t.status === 'playing') { assert.equal(led.status, 'betting'); assert.equal(led.actor, t.actor, 'first to act'); assert.equal(led.pot, t.pot(), 'opening pot'); assert.equal(led.currentBet, t.currentBet, 'amount to call (full big blind)'); t.players.forEach((p, i) => { assert.equal(led.p[i].stack, p.stack); assert.equal(led.p[i].bet, p.bet); assert.equal(led.p[i].total, p.total); }); }
      else tally.forcedRunout++;
      for (let g = 0; t.status === 'playing' && g < 300; g++) {
        const lg = t.legal(), ll = led.legal();
        assert.equal(led.actor, t.actor); assert.equal(ll.toCall, lg.toCall); assert.equal(ll.canCheck, lg.canCheck); assert.equal(ll.canRaise, lg.canRaise); assert.equal(ll.maxRaiseTo, lg.maxRaiseTo);
        if (lg.canRaise) assert.equal(Math.min(ll.maxRaiseTo, ll.fullMinRaiseTo), Math.min(lg.maxRaiseTo, lg.minRaiseTo));
        const u = r.next(); let type, amount = 0;
        if (ll.toCall > 0 && u < 0.3) type = 'fold'; else if (ll.canRaise && u > 0.8) { type = 'raise'; const lo = Math.min(ll.maxRaiseTo, ll.fullMinRaiseTo); amount = r.next() < 0.15 ? ll.maxRaiseTo : lo + Math.floor(r.next() * Math.min(ll.maxRaiseTo - lo + 1, 4 * ll.raiseSize)); } else type = ll.canCheck ? 'check' : 'call';
        t.execute(t.request(type, amount, 0), 0); led.apply({ seat: led.actor, type, amount }); tally.actions++;
        if (led.needsRunout) led.dealBoard(t.board.slice(led.board.length));
        if (t.status === 'playing') { assert.equal(led.status, 'betting'); assert.equal(led.pot, t.pot()); }
      }
      assert.equal(t.status, 'complete'); if (led.needsRunout && t.board.length > led.board.length) led.dealBoard(t.board.slice(led.board.length));
      if (led.pots().pots.length > 1) tally.sidePots++;
      if (led.live.length > 1) { const aw = led.showdown(hole, { perLevelOddChips: true }); assert.deepEqual(aw.map((a, i) => a + led.p[i].stack), t.players.map((p) => p.stack), 'awards'); }
      const cs = led.checkSettlement(t.players.map((p) => p.stack)); assert.ok(cs.ok, cs.reasons.join('; '));
      tally.eliminations += cs.eliminated.length;
    }
    assert.equal(t.tournamentComplete, true, 'tournament ' + seed + ' reached a winner'); assert.equal(t.players.filter((p) => p.stack > 0).length, 1); tally.tournaments++;
  }
  ctx.diagnostic('ledger-vs-simulator ' + JSON.stringify(tally));
  assert.equal(tally.tournaments, 40); assert.equal(tally.eliminations, 40 * 7, 'seven eliminations per tournament');
  assert.ok(tally.handsWithEliminated > 300 && tally.headsUp > 100 && tally.sidePots > 50 && tally.shortBlind > 10 && tally.forcedRunout > 0, JSON.stringify(tally));
});

test('M2 defect regression: the hand after two eliminations (seats 2 and 6 shown folded with no chips) is reconstructed, not refused', () => {
  // the exact situation of evidence/0.36.2-m3/baseline-M2-elimination-stall.json (hand 2): stacks before the hand, button moving from seat 0
  const t = tableAt([2390, 2140, 0, 2490, 2490, 8000, 0, 2490], 0), e = engine({ tournament: 'strict' });
  assert.deepEqual([t.dealer, t.sb, t.bb, t.pot(), t.actor], [1, 3, 4, 210, 5]);
  const r = e.ingest(screen(t, 1)); assert.ok(r.accepted, JSON.stringify(r.issues));
  const s = r.state; assert.equal(s.participants, 6); assert.deepEqual(s.dealtIn, [0, 1, 3, 4, 5, 7]); assert.equal(s.sbSeat, 3); assert.equal(s.bbSeat, 4); assert.equal(s.pot, 210); assert.equal(s.actor, 5);
  assert.deepEqual(s.seats.map((q) => q.status), ['active', 'active', 'eliminated', 'active', 'active', 'active', 'eliminated', 'active']);
  assert.equal(s.seats[2].inHand, false); assert.equal(s.seats[2].folded, true, 'folded keeps meaning "not contesting this hand"'); assert.equal(s.legal.toCall, 100);
  assert.deepEqual(s.openingCheck.eliminated, [2, 6]); assert.equal(e.trackingStatus().status, 'tracking');
  const ts = e.tournamentStatus(); assert.deepEqual(ts.eliminated.map((x) => x.seat), [2, 6]); assert.equal(ts.remaining, 6);
});

test('the tracker follows whole tournaments from screen readings (strict and auto): every seat status, eliminations, heads-up and the winner match the simulator', (ctx) => {
  const sum = { tournaments: 0, hands: 0, frames: 0, refused: 0, forcedRunoutHands: 0, refusedThenContinued: 0, recoveries: 0, eliminations: 0, headsUpHands: 0, sidePotFrames: 0 };
  for (const mode of ['strict', 'auto']) for (let seed = 1; seed <= 10; seed++) {
    const t = new EM.Table(1, seed * 7907 + (mode === 'auto' ? 3 : 0), 8, { persistentStacks: true }), e = engine({ tournament: mode }); t.setNextStacks(Array(8).fill([400, 800, 1200][seed % 3])); let seq = 0, view = 0;
    let pendingRecovery = false;
    for (let h = 0; h < 3000 && t.startHand() !== false; h++) {
      sum.hands++; if (t.status === 'complete') sum.forcedRunoutHands++; else if (pendingRecovery) { sum.refusedThenContinued++; pendingRecovery = false; }
      for (let g = 0; g < 400; g++) {
        const ob = screen(t, seq++, { lastView: view }); if (t.actor >= 0) view = t.actor; const r = e.ingest(ob); sum.frames++;
        if (!r.accepted) {
          sum.refused++;
          // the only refusal: a hand that the forced bets ran out before any reading (its first frame already shows the end)
          assert.equal(t.status, 'complete'); assert.ok(['missed-hand-start', 'untracked-hand'].includes(r.issues[0].code), JSON.stringify(r.issues)); pendingRecovery = true;
          break;
        }
        const s = r.state;
        assert.equal(s.actor, t.status === 'playing' ? t.actor : -1); assert.equal(s.hand, t.hand);
        for (let i = 0; i < 8; i++) assert.equal(s.seats[i].status, oracleStatus(t, i), 'hand ' + t.hand + ' seat ' + i);
        if (s.sidePots && s.sidePots.length > 1) sum.sidePotFrames++; if (s.headsUp && s.handStart) sum.headsUpHands++;
        if (t.status !== 'playing') { assert.equal(s.settlement.ok, true); break; }
        const a = EM.policy(t); t.execute(t.request(a.type, a.amount, 0), 0);
      }
    }
    const ts = e.tournamentStatus(), winner = t.players.findIndex((p) => p.stack > 0);
    assert.equal(t.tournamentComplete, true);
    if (ts.complete) { assert.equal(ts.complete.winner, winner); assert.equal(e.trackingStatus().status, 'tournament-complete'); }
    else assert.equal(e.trackingStatus().status, 'untracked-hand', 'only possible when the final hand ran out on the forced bets');
    assert.deepEqual(ts.eliminated.map((x) => x.seat).sort(), [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => i !== winner).filter((i) => ts.complete || ts.seats[i] === 'eliminated'));
    sum.recoveries += e.trackingStatus().recoveries; sum.eliminations += ts.eliminations.length; sum.tournaments++;
  }
  ctx.diagnostic('tracker-vs-simulator ' + JSON.stringify(sum));
  assert.equal(sum.tournaments, 20); assert.ok(sum.hands > 400 && sum.eliminations >= 120 && sum.headsUpHands > 20 && sum.sidePotFrames > 20, JSON.stringify(sum));
  assert.equal(sum.refused, sum.forcedRunoutHands, 'nothing else is refused'); assert.equal(sum.recoveries, sum.refusedThenContinued, 'every untracked hand that was followed by another hand was recovered: ' + JSON.stringify(sum));
});

test('a real missed action is still refused: a seat shown folded WITH chips in the first reading of a hand', () => {
  const t = new EM.Table(1, 9, 8, { persistentStacks: true }); t.startHand(); t.execute(t.request('fold', 0, 0), 0); // UTG folded before the first reading
  const e = engine(), r = e.ingest(screen(t, 1)); assert.equal(r.accepted, false); assert.equal(r.issues[0].code, 'missed-hand-start'); assert.match(r.issues[0].detail, /seat 3 is shown folded with chips \(2490\)/);
  assert.match(r.issues[0].detail, /eliminated players and are not a reason to refuse/);
  const st = e.trackingStatus(); assert.equal(st.status, 'untracked-hand'); assert.equal(st.reasonCode, 'missed-hand-start'); assert.equal(st.observedHand, 1); assert.equal(st.lastValidHand, null); assert.match(st.expectedRecovery, /hand 2/);
  assert.equal(e.ingest(screen(t, 2)).issues[0].code, 'untracked-hand'); assert.equal(e.trackingStatus().refusedFrames, 2);
});

test('opening positions are checked element by element with the reason named: blinds, button, antes, pot, first actor', () => {
  const base = () => tableAt([2500, 2500, 0, 2500, 2500, 2500, 0, 2500], 0);
  const reject = (mut, code, re) => { const t = base(), ob = screen(t, 1); mut(ob); const r = engine().ingest(ob); assert.equal(r.accepted, false, 'expected ' + code); assert.equal(r.issues[0].code, code, r.issues[0].detail); if (re) assert.match(r.issues[0].detail, re); };
  // the M2 ledger's blind positions (fixed offsets: SB at eliminated seat 2) are refused with an explanation
  reject((o) => { o.seats[3].bet = 0; o.seats[3].stack += 50; o.seats[2].bet = 50; o.seats[2].folded = false; }, 'hand-start-mismatch');
  reject((o) => { o.seats[3].bet = 100; o.seats[3].stack -= 50; o.seats[4].bet = 50; o.seats[4].stack += 50; }, 'hand-start-mismatch', /small blind\) shows a bet of 100; the small blind is 50 \(first seat dealt in after the button at seat 1; eliminated seats 2, 6 skipped\)/);
  reject((o) => { o.button = 2; }, 'hand-start-mismatch', /button is shown at seat 2, which is not dealt in \(eliminated\)/);
  reject((o) => { o.pot = 230; }, 'inconsistent-start-pot', /Opening pot 230 != 210 \(6 players dealt in: antes 60 \+ small blind 50 at seat 3 \+ big blind 100 at seat 4\)/);
  reject((o) => { o.actor = 7; }, 'hand-start-mismatch', /first player to act is seat 5/);
  reject((o) => { o.seats[0].stack -= 10; o.pot += 10; }, 'inconsistent-start-pot', /Opening pot 220 != 210/);
  reject((o) => { o.seats[5].bet = 300; o.seats[5].stack -= 300; o.pot += 300; o.actor = 7; }, 'missed-hand-start', /already put 300/);
  reject((o) => { o.street = 'flop'; o.board = [0, 1, 2]; }, 'missed-hand-start', /on the flop/);
  // a seat shown with no chips but NOT folded at the start: all-in for the ante (exact amount from the pot when it is the only one)
  // seat 2 (7 chips) is also the small blind once the button moves to seat 1: all-in on its ante, it posts nothing for the blind
  const t = tableAt([2500, 2500, 7, 2500, 2500, 2500, 0, 2500], 0), r = engine().ingest(screen(t, 1)); assert.ok(r.accepted, JSON.stringify(r.issues)); assert.equal(t.sb, 2); assert.equal(r.state.sbSeat, 2);
  assert.equal(r.state.seats[2].status, 'all-in'); assert.equal(r.state.pot, 6 * 10 + 7 + 0 + 100); assert.equal(r.state.pot, t.pot()); assert.equal(r.state.legal.toCall, 100);
  const t2 = tableAt([2500, 2500, 7, 2500, 2500, 2500, 4, 2500], 0), r2 = engine().ingest(screen(t2, 1)); assert.equal(r2.accepted, false); assert.equal(r2.issues[0].code, 'ambiguous-start', 'two seats all-in for less than the ante, no settled hand: not guessed');
});

test('short stacks follow the simulator: ante-only all-in, short small blind, short big blind (the full big blind is still the amount to call)', () => {
  // seat 2 is the big blind with 60 chips: 10 ante + 50 all-in; seat 1 small blind with 30 chips: 10 ante + 20 all-in
  const t = tableAt([2500, 30, 60, 2500, 2500, 2500, 2500, 2500], 7), e = engine();
  assert.deepEqual([t.dealer, t.sb, t.bb, t.currentBet], [0, 1, 2, 100]);
  const r = e.ingest(screen(t, 1)); assert.ok(r.accepted, JSON.stringify(r.issues)); assert.equal(r.state.currentBet, 100); assert.equal(r.state.legal.toCall, 100);
  assert.equal(r.state.seats[1].status, 'all-in'); assert.equal(r.state.seats[2].status, 'all-in'); assert.equal(r.state.pot, 80 + 20 + 50);
  let seq = 2; while (t.status === 'playing') { const a = EM.policy(t); t.execute(t.request(a.type, a.amount, 0), 0); const q = e.ingest(screen(t, seq++)); assert.ok(q.accepted, JSON.stringify(q.issues)); }
  assert.equal(e.state.settlement.ok, true);
});

test('tournament continuity: strict refuses stacks, buttons or seating that contradict the previous settled hand; auto reports a re-funded table', () => {
  const play = (t, e, seq) => { while (t.status === 'playing') { const a = EM.policy(t); t.execute(t.request(a.type, a.amount, 0), 0); assert.ok(e.ingest(screen(t, seq++)).accepted); } return seq; };
  for (const mode of ['strict', 'auto']) {
    const t = new EM.Table(1, 33, 8, { persistentStacks: true }), e = engine({ tournament: mode }); t.startHand(); let seq = 1; assert.ok(e.ingest(screen(t, seq++)).accepted); seq = play(t, e, seq);
    assert.equal(e.tournamentStatus().lastSettledHand, 1);
    t.startHand(); const ok = screen(t, seq++);
    // stacks that do not continue from the settled hand (as if chips appeared between hands)
    const bad = JSON.parse(JSON.stringify(ok)); bad.seats[t.actor].stack += 100; bad.pot = ok.pot; bad.seq = ok.seq;
    const r = e.ingest(bad);
    if (mode === 'strict') { assert.equal(r.accepted, false); assert.equal(r.issues[0].code, 'stack-continuity'); assert.match(r.issues[0].detail, /do not continue from hand 1/); }
    else { assert.ok(r.accepted, JSON.stringify(r.issues)); assert.equal(e.tournamentStatus().continuity, 'reset'); assert.ok(e.tournamentStatus().events.some((x) => x.kind === 'stack-reset')); }
  }
  // the button must move to the next seat dealt in (strict)
  {
    const t = new EM.Table(1, 34, 8, { persistentStacks: true }), e = engine({ tournament: 'strict' }); t.startHand(); let seq = 1; e.ingest(screen(t, seq++)); seq = play(t, e, seq); t.startHand();
    const ob = screen(t, seq++); const moved = JSON.parse(JSON.stringify(ob)); moved.button = (ob.button + 1) % 8; // same stacks/bets, wrong button
    const r = e.ingest(moved); assert.equal(r.accepted, false); assert.ok(['button-movement', 'hand-start-mismatch'].includes(r.issues[0].code), r.issues[0].code + ': ' + r.issues[0].detail);
  }
  // a seat that still had chips after the settled hand cannot be shown eliminated (strict and auto)
  for (const mode of ['strict', 'auto']) {
    const t = new EM.Table(1, 35, 8, { persistentStacks: true }), e = engine({ tournament: mode }); t.startHand(); let seq = 1; e.ingest(screen(t, seq++)); seq = play(t, e, seq); t.startHand();
    const ob = screen(t, seq++), victim = [0, 1, 2, 3, 4, 5, 6, 7].find((i) => i !== ob.button && i !== t.sb && i !== t.bb && i !== t.actor && t.players[i].stack > 0);
    ob.pot -= ob.seats[victim].bet + 10; ob.seats[victim] = { seat: victim, stack: 0, bet: 0, folded: true, cards: null };
    const r = e.ingest(ob); assert.equal(r.accepted, false); assert.equal(r.issues[0].code, 'seating-contradiction'); assert.match(r.issues[0].detail, /still had chips/);
  }
});

test('an eliminated player who is dealt in again: refused under strict tournament rules, reported as a re-funded table under auto', () => {
  for (const mode of ['strict', 'auto']) {
    const t = tableAt([2500, 2500, 0, 2500, 2500, 2500, 2500, 2500], 0, 41), e = engine({ tournament: mode }); let seq = 1; assert.ok(e.ingest(screen(t, seq++)).accepted);
    while (t.status === 'playing') { const a = EM.policy(t); t.execute(t.request(a.type, a.amount, 0), 0); assert.ok(e.ingest(screen(t, seq++)).accepted); }
    const t2 = tableAt(Array(8).fill(2500), t.dealer, 42); t2.hand = t.hand + 1; // seat 2 has chips again; next hand number
    const r = e.ingest(screen(t2, seq++));
    if (mode === 'strict') { assert.equal(r.accepted, false); assert.equal(r.issues[0].code, 'seating-contradiction'); assert.match(r.issues[0].detail, /eliminated .* dealt in again/); }
    else { assert.ok(r.accepted, JSON.stringify(r.issues)); assert.ok(e.tournamentStatus().events.some((x) => x.kind === 'seat-rejoined' && x.seat === 2)); }
  }
});

test('heads-up transition: the button posts the small blind and acts first preflop; the seating model reports it once', () => {
  const t = tableAt([0, 0, 1500, 0, 0, 900, 0, 0], 2), e = engine(); assert.deepEqual([t.dealer, t.sb, t.bb, t.actor], [5, 5, 2, 5]);
  const r = e.ingest(screen(t, 1)); assert.ok(r.accepted, JSON.stringify(r.issues)); assert.equal(r.state.headsUp, true); assert.equal(r.state.sbSeat, 5); assert.equal(r.state.pot, 20 + 150);
  const ts = e.tournamentStatus(); assert.equal(ts.headsUp, true); assert.equal(ts.events.filter((x) => x.kind === 'heads-up').length, 1); assert.equal(ts.eliminated.length, 6);
});

test('untracked hand -> automatic recovery at the next verified opening: status, reason, counters; fresh readings before the state is used', () => {
  const t = new EM.Table(1, 12, 8, { persistentStacks: true }), e = engine({ tournament: 'strict' }); t.startHand(); t.execute(t.request('call', 0, 0), 0); let seq = 1;
  let r = e.ingest(screen(t, seq++)); assert.equal(r.accepted, false);
  let st = e.trackingStatus(); assert.deepEqual([st.status, st.reasonCode, st.observedHand, st.untrackedHands, st.recoveries], ['untracked-hand', 'missed-hand-start', 1, 1, 0]); assert.match(st.reason, /seat 3 .*already put 100/i);
  while (t.status === 'playing') { const a = EM.policy(t); t.execute(t.request(a.type, a.amount, 0), 0); assert.equal(e.ingest(screen(t, seq++)).issues[0].code, 'untracked-hand'); }
  t.startHand(); r = e.ingest(screen(t, seq++)); assert.ok(r.accepted, JSON.stringify(r.issues)); assert.equal(r.paused, true, 'one fresh reading is not enough');
  st = e.trackingStatus(); assert.deepEqual([st.status, st.recoveries, st.lastValidHand], ['verifying', 1, 2]); assert.deepEqual(e.tr.lastRecovery, { fromHand: 1, toHand: 2, cause: 'missed-hand-start', at: seq - 1 });
  r = e.ingest(screen(t, seq++)); assert.equal(r.paused, false, 'a second consistent reading resumes'); assert.equal(e.trackingStatus().status, 'tracking');
  assert.equal(e.tournamentStatus().continuity, 'not-applicable', 'continuity is only checked against a SETTLED previous hand');
});

test('a contradiction that persists within a hand makes the hand untracked (explicitly), not a silent endless refusal', () => {
  const t = new EM.Table(1, 13, 8, { persistentStacks: true }), e = engine({ maxContradictionFrames: 5 }); t.startHand(); let seq = 1; assert.ok(e.ingest(screen(t, seq++)).accepted);
  t.execute(t.request('call', 0, 0), 0);
  for (let i = 0; i < 5; i++) { const ob = screen(t, seq++); ob.pot += 25; const r = e.ingest(ob); assert.equal(r.accepted, false); }
  const st = e.trackingStatus(); assert.equal(st.status, 'untracked-hand'); assert.equal(st.reasonCode, 'persistent-contradiction'); assert.match(st.reason, /5 consecutive readings contradicted/);
  assert.equal(e.ingest(screen(t, seq++)).issues[0].code, 'untracked-hand', 'even a correct reading of that hand is no longer used');
});

test('tournament completion is recognised from the verified settlement (and, without input, from the final screen of an untracked hand)', () => {
  const t = tableAt([0, 0, 600, 0, 0, 500, 0, 0], 2, 51), e = engine({ tournament: 'strict' }); let seq = 1;
  for (let h = 0; h < 500; h++) {
    for (let g = 0; g < 200; g++) { const r = e.ingest(screen(t, seq++)); if (!r.accepted || t.status !== 'playing') break; const a = EM.policy(t); t.execute(t.request(a.type, a.amount, 0), 0); }
    if (t.startHand() === false) break;
  }
  assert.equal(t.tournamentComplete, true); const end = e.tournamentStatus().complete, winner = t.players.findIndex((p) => p.stack > 0);
  assert.ok(end, 'completion recognised'); assert.equal(end.winner, winner); assert.equal(e.trackingStatus().status, 'tournament-complete');
  // final screen of an untracked hand
  const t2 = tableAt([0, 0, 600, 0, 0, 500, 0, 0], 2, 52), e2 = engine(); t2.execute(t2.request('raise', t2.legal().maxRaiseTo, 0), 0); if (t2.status === 'playing') t2.execute(t2.request('call', 0, 0), 0);
  assert.equal(t2.status, 'complete'); const fin = screen(t2, 1); fin.hand = t2.hand; const r2 = e2.ingest(fin); assert.equal(r2.accepted, false);
  if (t2.players.filter((p) => p.stack > 0).length === 1) { assert.equal(e2.ingest(screen(t2, 2)).accepted, false); assert.equal(e2.trackingStatus().status, 'tournament-complete'); assert.match(e2.trackingStatus().reason, /settlement not verified/); }
});

test('ledger serialization: version 1 unchanged when every seat is dealt in, version 2 with eliminated seats, old version-1 data still restores, tampering refused', () => {
  const full = new HandLedger({ stacks: Array(8).fill(2500), button: 0 }); full.apply({ seat: 3, type: 'raise', amount: 300 });
  const j1 = JSON.parse(JSON.stringify(full.toJSON())); assert.equal(j1.version, 1);
  // a ledger checkpoint exactly as Milestone 2 wrote it (no inHand / outReason / antePaid fields)
  const m2 = JSON.parse(JSON.stringify(j1)); m2.p.forEach((q) => { delete q.inHand; delete q.outReason; delete q.antePaid; });
  const r1 = HandLedger.fromJSON(m2); assert.deepEqual(r1.project(), full.project()); assert.equal(r1.legal().minRaiseTo, full.legal().minRaiseTo);
  const elim = new HandLedger({ stacks: [2500, 0, 2500, 2500, 0, 2500, 2500, 2500], button: 0 }); const j2 = JSON.parse(JSON.stringify(elim.toJSON())); assert.equal(j2.version, 2);
  const r2 = HandLedger.fromJSON(j2); assert.deepEqual(r2.project(), elim.project()); assert.equal(r2.p[1].inHand, false); assert.equal(r2.sbSeat, 2);
  const v1zero = JSON.parse(JSON.stringify(j2)); v1zero.version = 1; assert.throws(() => HandLedger.fromJSON(v1zero), /positive stack for every seat/);
  const steal = JSON.parse(JSON.stringify(j2)); steal.p[1].total = 10; steal.p[0].total -= 10; assert.throws(() => HandLedger.fromJSON(steal), /not dealt in has chips in the pot/);
  const leak = JSON.parse(JSON.stringify(j2)); leak.p[0].stack += 1; assert.throws(() => HandLedger.fromJSON(leak), /conserve/);
});

test('hand-state checkpoints: version 2 carries the seating model; a Milestone 2 (version 1) checkpoint still restores and never resumes without fresh readings', () => {
  const t = tableAt([2390, 2140, 0, 2490, 2490, 8000, 0, 2490], 0), e = engine({ tournament: 'strict' }); assert.ok(e.ingest(screen(t, 1)).accepted);
  const cp = JSON.parse(JSON.stringify(e.exportCheckpoint())); assert.equal(cp.version, 2); assert.equal(cp.tr.led.version, 2);
  const e2 = engine({ tournament: 'strict' }); e2.restoreCheckpoint(cp); assert.equal(e2.paused, true); assert.deepEqual(e2.tournamentStatus().eliminated.map((x) => x.seat), [2, 6]);
  t.execute(t.request('call', 0, 0), 0); assert.ok(e2.ingest(screen(t, 2)).accepted, 'the restored ledger continues the hand');
  // Milestone 2 format: version 1, no tour, ledger version 1
  const tf = new EM.Table(1, 61, 8, { persistentStacks: true }); tf.startHand(); const ef = engine(); ef.ingest(screen(tf, 1));
  const v1 = JSON.parse(JSON.stringify(ef.exportCheckpoint())); v1.version = 1; delete v1.tour; delete v1.tr.lastValidHand; delete v1.tr.recoveries; delete v1.tr.untrackedHands; v1.tr.led.p.forEach((q) => { delete q.inHand; delete q.outReason; delete q.antePaid; });
  const e3 = engine(); e3.restoreCheckpoint(v1); assert.equal(e3.paused, true); assert.equal(e3.trackingStatus().lastValidHand, 1);
  tf.execute(tf.request('call', 0, 0), 0); assert.ok(e3.ingest(screen(tf, 2)).accepted);
  assert.throws(() => engine().restoreCheckpoint({ ...v1, version: 3 }), /not for this table/);
});

test('negative readings are refused with a reason: duplicate cards, contradictory stacks, wrong / backwards hand numbers, late frames, stale sequence', () => {
  const t = tableAt([2390, 2140, 0, 2490, 2490, 8000, 0, 2490], 0), e = engine({ tournament: 'strict' }); t.hand = 7; let seq = 1; assert.ok(e.ingest(screen(t, seq++)).accepted);
  const old = screen(t, 0); t.execute(t.request('call', 0, 0), 0); assert.ok(e.ingest(screen(t, seq++)).accepted);
  const dup = screen(t, seq++); dup.seats[t.actor].cards = [dup.seats[t.actor].cards[0], dup.seats[t.actor].cards[0]]; let r = e.ingest(dup); assert.equal(r.issues[0].code, 'invalid-card');
  const chips = screen(t, seq++); chips.seats[0].stack += 500; r = e.ingest(chips); assert.equal(r.accepted, false); assert.match(r.issues[0].code, /unexplained-change|inconsistent/);
  const back = screen(t, seq++); back.hand = 6; r = e.ingest(back); assert.equal(r.accepted, false); assert.equal(r.issues[0].code, 'contradiction'); assert.match(r.issues[0].detail, /went backwards/);
  const late = old; late.seq = seq++; r = e.ingest(late); assert.equal(r.accepted, false, 'a late frame of an earlier state is not accepted');
  const stale = screen(t, 1); r = e.ingest(stale); assert.equal(r.issues[0].code, 'stale-observation');
  // a skipped hand number is not a contradiction (hands can pass unobserved) but continuity is then not assumed
  const fresh = screen(t, seq++); assert.ok(e.ingest(fresh).accepted, 'a correct reading of the current hand is accepted again');
});

test('pre-existing defect fixed in M3: a reading that shows NO controls while the viewer is to act is used (the table waits); shown controls are still checked', () => {
  // the big blind checks its option and is first to act on the flop: the fixture's think-time hold shows that seat's view with every control hidden
  const t = new EM.Table(1, 21, 8, { persistentStacks: true }); t.startHand(); const e = engine(); let seq = 1; assert.ok(e.ingest(screen(t, seq++)).accepted);
  for (const s of [3, 4, 5, 6, 7, 0]) { t.execute(t.request('fold', 0, 0), 0); assert.ok(e.ingest(screen(t, seq++)).accepted); }
  t.execute(t.request('call', 0, 0), 0); assert.ok(e.ingest(screen(t, seq++)).accepted); t.execute(t.request('check', 0, 0), 0); // BB checks: flop, seat 1 acts first
  const hold = screen(t, seq++, { heroSeat: t.actor }); hold.controls = { fold: false, check: false, call: false, raise: false }; delete hold.callAmount; delete hold.minRaiseTo;
  const r = e.ingest(hold); assert.ok(r.accepted, JSON.stringify(r.issues)); assert.equal(r.state.street, 'flop');
  const wrong = screen(t, seq++, { heroSeat: t.actor }); wrong.controls = { fold: true, check: false, call: true, raise: true }; wrong.callAmount = 100; wrong.minRaiseTo = 200;
  const q = e.ingest(wrong); assert.equal(q.accepted, false); assert.equal(q.issues[0].code, 'controls-disagree', 'controls that ARE shown must still match the rules');
});
