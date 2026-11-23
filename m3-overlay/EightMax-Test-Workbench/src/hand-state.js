/* EightMax Test Workbench 0.20: hand-state reconstruction from observations.
 *
 * Input is an "eightmax-observation" (from a structured simulator feed, a replayed recording or
 * recognised screenshots). Output is either an accepted, internally consistent table state or an
 * explicit rejection. Nothing is guessed: missing cards, bets and actions stay missing, and a
 * table whose state cannot be reconstructed is paused until consistent frames return.
 * Units follow the simulator: 100 chips = 1 BB (SB 50, BB 100, ante 10, eight-handed start pot 230).
 *
 * 0.24: stakes are configurable (options sb / bb / ante), and `track: true` turns on frame-to-frame
 * reconstruction through an independent rules ledger (hand-ledger.js): action history, per-seat
 * contributions, side pots, minimum raises and settlement are DERIVED from consecutive screen readings
 * and every reading is cross-checked against them. Gaps that cannot be explained uniquely are rejected.
 *
 * 0.36.2 Milestone 3 - tournament participation and hand recovery.
 *   ROOT CAUSE of the elimination stall: the bundled simulator shows an eliminated (zero-chip) tournament player with the folded
 *   marker from the first frame of every later hand. _track treated ANY folded seat in a hand's first frame as proof that the
 *   opening was missed ("missed-hand-start", then "untracked-hand" for the whole hand), its ledger charged every seat an ante and
 *   put the blinds at fixed offsets from the button, and _build expected the eight-handed opening pot. So every hand after the
 *   first elimination was refused and the controlled table, which only moves on when its player to act acts, waited forever.
 *   Now every seat has an explicit status - active, folded (in this hand), all-in, eliminated, sitting-out - and "unknown" is used
 *   for seats without a verified reading. A seat shown folded with NO chips, NO bet and nothing committed in a hand's first frame
 *   is a player who is not dealt in (eliminated); a seat shown folded WITH chips is still proof of a missed fold and is refused.
 *   The opening position is rebuilt with the simulator's own rules (hand-ledger.js: antes only from players dealt in, moving button,
 *   blinds skip eliminated seats, heads-up button = small blind, short blinds all-in, full big blind to call) and every element is
 *   checked separately with a specific reason: hand number, participation, button, blind positions, antes, stacks, opening pot,
 *   first actor, board. A tournament seating model carries the verified facts from hand to hand (settled stacks, who was
 *   eliminated after which hand, previous button) and is used to cross-check the next opening ("tournament" option, below).
 *   A hand that still cannot be reconstructed is UNTRACKED with an explicit reason; the next hand whose opening verifies
 *   recovers automatically (counted), and like a restored checkpoint the table stays paused until `autoResumeAfter` consecutive
 *   readings agree. Missed actions are never invented.
 *   Options: tournament 'auto' (default: continuity with the previous settled hand is used when it holds, a re-funded table is
 *   accepted as a stack reset, an eliminated seat that is dealt in again is accepted and reported), 'strict' (chips carry over
 *   between hands: a stack, button or seating that contradicts the previous settled hand refuses the new hand) or 'off'.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./hand-ledger.js'));
  else root.WorkbenchHandState = factory(root.WorkbenchLedger);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (LG) {
  'use strict';

  const SEATS = 8, SB = 50, BB = 100, ANTE = 10, START_POT = SEATS * ANTE + SB + BB;
  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const BOARD_LEN = { preflop: 0, flop: 3, turn: 4, river: 5 };
  const RANKS = '23456789TJQKA', SUITS = 'cdhs';
  /** 0.36.2 M3: explicit per-seat state (never a single folded flag for different situations). */
  const SEAT_STATUS = Object.freeze({ ACTIVE: 'active', FOLDED: 'folded', ALL_IN: 'all-in', ELIMINATED: 'eliminated', SITTING_OUT: 'sitting-out', UNKNOWN: 'unknown' });
  /** Rejection codes that leave a whole hand untracked (the engine then waits for the next verified opening). */
  const UNTRACKED_CODES = Object.freeze(['missed-hand-start', 'hand-start-mismatch', 'inconsistent-start-pot', 'seating-contradiction', 'stack-continuity', 'button-movement', 'ambiguous-start', 'persistent-contradiction']);
  // 0.36.2 M3: refusals that mean 'this frame could not be read reliably' (recognition), as opposed to a reliable reading that contradicts the hand
  const UNREADABLE_CODES = Object.freeze(['low-confidence', 'missing-confidence', 'missing-field', 'unrecognized-layout', 'bad-sequence', 'malformed', 'invalid-card', 'ambiguous-seats']);
  const DEFAULTS = Object.freeze({
    minOverallConfidence: 0.9, minFieldConfidence: 0.85, autoResumeAfter: 2,
    expectedLayout: 'eightmax-8max-v1', expectedBankroll: null, maxSeqGap: 1000,
    sb: SB, bb: BB, ante: ANTE, track: false, maxGapActions: 8, requireControlsMatch: true,
    tournament: 'auto', maxContradictionFrames: 25, maxSeatingEvents: 200,
  });

  const isInt = (x) => Number.isSafeInteger(x);
  const isCard = (c) => isInt(c) && c >= 0 && c < 52;
  function cardToString(c) { return RANKS[Math.floor(c / 4)] + SUITS[c % 4]; }
  function cardFromString(s) {
    if (typeof s !== 'string' || !/^[2-9TJQKA][cdhs]$/.test(s)) return null;
    return RANKS.indexOf(s[0]) * 4 + SUITS.indexOf(s[1]);
  }
  const seatList = (a) => (a.length === 1 ? 'seat ' + a[0] : 'seats ' + a.join(', '));

  /** Stable content key: any change of board, bets, stacks, actor or folds produces a new key. */
  function stateKey(s) {
    return [s.table, s.hand, s.street, s.board.join('.'), s.actor, s.pot, s.currentBet,
      s.seats.map((p) => [p.stack, p.bet, p.total, p.folded ? 1 : 0].join(':')).join('|')].join('/');
  }

  function legalFrom(s) {
    if (s.actor < 0 || s.status !== 'playing') return null;
    const p = s.seats[s.actor], toCall = Math.max(0, s.currentBet - p.bet), max = p.bet + p.stack;
    const exact = Number.isFinite(s.lastRaise);
    const minRaiseTo = exact ? s.currentBet + s.lastRaise : null;
    const others = s.seats.some((q, i) => i !== s.actor && !q.folded && q.stack > 0);
    return {
      exact, toCall, callAmount: Math.min(toCall, p.stack), canCheck: toCall === 0,
      canCall: toCall > 0, canFold: toCall > 0, // folding is never offered for free; the simulator permits it, a client would not need it
      canRaise: others && max > s.currentBet && (!exact || s.canReopen !== false),
      minRaiseTo, maxRaiseTo: max, allInAmount: max,
    };
  }

  /**
   * 0.36.2 M3: what a seat record of a screen reading shows, before any history is known.
   *   eliminated  - folded marker, no chips behind, no bet, nothing committed (the simulator's display of a player who is not dealt in)
   *   sitting-out - an explicit sitting-out marker (seat-state readers)
   *   folded      - folded marker with chips (or a bet): a real fold
   *   all-in      - no chips behind, not folded
   *   active      - chips behind, not folded
   */
  function screenSeatStatus(r) {
    if (r.sittingOut === true) return SEAT_STATUS.SITTING_OUT;
    const committed = isInt(r.total) ? r.total : 0;
    if (r.folded) return r.stack === 0 && r.bet === 0 && committed === 0 ? SEAT_STATUS.ELIMINATED : SEAT_STATUS.FOLDED;
    return r.stack === 0 ? SEAT_STATUS.ALL_IN : SEAT_STATUS.ACTIVE;
  }

  class HandStateEngine {
    constructor(table, options = {}) {
      if (!isInt(table) || table < 1 || table > 10) throw new Error('Table id must be 1 to 10');
      this.table = table; this.opt = { ...DEFAULTS, ...options };
      if (!['auto', 'strict', 'off'].includes(this.opt.tournament)) throw new Error('tournament must be auto, strict or off');
      // 0.27: seat count is configurable from 2 to 8 (default 8). With a seat count and no explicit layout list, the engine accepts exactly the
      // layouts of that seat count; an observation for any other seat count is rejected as an unrecognized layout, never adapted.
      const sc = options.seats === undefined ? 8 : options.seats; if (!Number.isInteger(sc) || sc < 2 || sc > 8) throw new Error('Seat count must be 2 to 8');
      this.seats = sc; if (options.seats !== undefined && options.expectedLayout === undefined) this.opt.expectedLayout = ['eightmax-' + sc + 'max-v1', 'eightmax-' + sc + 'max-v2'];
      this.reset();
    }
    reset() {
      this.last = null; this.revision = this.revision || 0; this.paused = false; this.pauseReason = null;
      this.goodStreak = 0; this.accepted = 0; this.rejected = 0; this.lastSeq = -1;
      this.rejections = []; this.bankroll = this.opt.expectedBankroll;
      this.tr = { led: null, hand: null, untracked: null, lastValidHand: null, recoveries: 0, untrackedHands: 0, lastRecovery: null, contradiction: null };
      // Full-table opening pot (8-handed: 2.3 BB). Kept for compatibility; openings are validated against the players actually dealt in.
      this.startPot = this.seats * this.opt.ante + this.opt.sb + this.opt.bb;
      this.tour = this._freshTour();
    }
    _freshTour() {
      return { mode: this.opt.tournament, seats: Array.from({ length: this.seats }, () => ({ status: SEAT_STATUS.UNKNOWN, eliminatedAfterHand: null, lastStack: null })),
        lastOpening: null, lastSettled: null, eliminations: [], events: [], eventSeq: 0, complete: null, observedEnd: null, handsOpened: 0, handsSettled: 0, headsUpSince: null, stackResets: 0 };
    }
    get state() { return this.last; }
    /** Restart support: everything needed to continue a hand after the process stops. Nothing here is trusted blindly: restore() re-validates chips.
     *  0.36.2 M3: version 2 adds the tournament seating model; version-1 checkpoints (Milestone 2 and earlier) are still restored. */
    exportCheckpoint() { return { format: 'eightmax-handstate-checkpoint', version: 2, table: this.table, revision: this.revision, lastSeq: this.lastSeq, bankroll: this.bankroll, tr: { hand: this.tr.hand, led: this.tr.led ? this.tr.led.toJSON() : null, lastValidHand: this.tr.lastValidHand, recoveries: this.tr.recoveries, untrackedHands: this.tr.untrackedHands }, tour: JSON.parse(JSON.stringify(this.tour)), last: this.last ? JSON.parse(JSON.stringify(this.last)) : null }; }
    restoreCheckpoint(c) {
      if (!c || c.format !== 'eightmax-handstate-checkpoint' || (c.version !== 1 && c.version !== 2) || c.table !== this.table) throw new Error('Checkpoint is not for this table');
      const led = c.tr && c.tr.led ? LG.HandLedger.fromJSON(c.tr.led) : null;
      this.reset(); this.revision = c.revision; this.lastSeq = -1; this.bankroll = c.bankroll;
      this.tr = { ...this.tr, hand: c.tr.hand, led, untracked: null, lastValidHand: c.version === 2 ? (c.tr.lastValidHand === undefined ? null : c.tr.lastValidHand) : c.tr.hand, recoveries: c.version === 2 ? c.tr.recoveries || 0 : 0, untrackedHands: c.version === 2 ? c.tr.untrackedHands || 0 : 0 };
      if (c.version === 2 && c.tour && Array.isArray(c.tour.seats) && c.tour.seats.length === this.seats) this.tour = { ...this._freshTour(), ...JSON.parse(JSON.stringify(c.tour)), mode: this.opt.tournament };
      this.last = c.last;
      this.paused = true; this.pauseReason = 'Restored from checkpoint; waiting for consistent readings'; this.goodStreak = 0; // never resumes without fresh agreement with the screen
    }

    /** Operator or supervisor resume. Never resumes a table whose last frame was rejected for contradiction. */
    resume() { this.paused = false; this.pauseReason = null; this.goodStreak = 0; }

    ingest(obs) {
      const issues = [];
      let state = null, trk = null;
      try {
        if (this.opt.track) { trk = this._track(obs, issues); if (trk) obs = trk.obs; }
        if (!issues.length) state = this._build(obs, issues);
      } catch (e) { issues.push({ code: 'malformed', detail: e.message }); }
      if (state && !issues.length) this._continuity(state, issues);
      if (state && trk && !issues.length) this._decorate(state, trk);
      if (issues.length) {
        this.rejected++; this.goodStreak = 0;
        this.paused = true; this.pauseReason = issues[0].code + ': ' + issues[0].detail;
        this.rejections.push({ seq: obs && obs.seq, issues });
        if (this.rejections.length > 100) this.rejections.shift();
        if (this.opt.track) this._noteContradiction(obs, issues);
        return { accepted: false, paused: true, issues, state: null, revision: this.revision };
      }
      const changed = !this.last || stateKey(this.last) !== stateKey(state);
      if (changed) this.revision++;
      if (this.bankroll === null && this._pendingBankroll !== undefined) this.bankroll = this._pendingBankroll;
      state.revision = this.revision; state.key = stateKey(state);
      this.last = state; this.accepted++; this.lastSeq = obs.seq;
      if (trk) {
        if (trk.opening && this.tr.untracked && this.tr.untracked.hand < trk.hand) { this.tr.recoveries++; this.tr.lastRecovery = { fromHand: this.tr.untracked.hand, toHand: trk.hand, cause: this.tr.untracked.code, at: obs.seq }; }
        this.tr.led = trk.led; this.tr.hand = trk.hand; this.tr.untracked = null; this.tr.contradiction = null; this.tr.lastValidHand = trk.hand;
        if (trk.bankroll !== undefined) this.bankroll = trk.bankroll;
        this._applySeating(trk, state);
      }
      if (this.paused) {
        this.goodStreak++;
        if (this.goodStreak >= this.opt.autoResumeAfter) this.resume();
      }
      return { accepted: true, paused: this.paused, issues: [], state, revision: this.revision, changed };
    }

    _build(obs, issues) {
      const o = this.opt, bad = (code, detail) => issues.push({ code, detail });
      if (!obs || obs.format !== 'eightmax-observation' || obs.version !== 1) { bad('unsupported-format', 'Not an eightmax-observation v1'); return null; }
      if (obs.table !== this.table) { bad('wrong-table', 'Observation is for table ' + obs.table + ', engine is table ' + this.table); return null; }
      const okLayouts = Array.isArray(o.expectedLayout) ? o.expectedLayout : [o.expectedLayout];
      if (!obs.layout || !okLayouts.includes(obs.layout.id) || (obs.layout.inHand !== undefined ? obs.layout.inHand : obs.layout.seats) !== this.seats /* 0.29: seat-state layouts: players in the hand, not positions */) { bad('unrecognized-layout', 'Layout ' + JSON.stringify(obs.layout && obs.layout.id) + ' is not ' + okLayouts.join(' or ')); return null; }
      if (!isInt(obs.seq) || obs.seq < 0) { bad('bad-sequence', 'Missing or invalid observation sequence'); return null; }
      if (obs.seq <= this.lastSeq) { bad('stale-observation', 'Sequence ' + obs.seq + ' is not newer than ' + this.lastSeq); return null; }
      const conf = obs.confidence;
      if (!conf || !Number.isFinite(conf.overall) || !conf.fields) { bad('missing-confidence', 'Observation has no confidence scores'); return null; }
      if (conf.overall < o.minOverallConfidence) bad('low-confidence', 'Overall confidence ' + conf.overall.toFixed(3) + ' below ' + o.minOverallConfidence);
      for (const f of ['board', 'pot', 'stacks', 'button', 'actor', 'street']) {
        if (!Number.isFinite(conf.fields[f])) bad('missing-field', 'No confidence for ' + f);
        else if (conf.fields[f] < o.minFieldConfidence) bad('low-confidence', f + ' confidence ' + conf.fields[f].toFixed(3) + ' below ' + o.minFieldConfidence);
      }
      if (issues.length) return null;
      if (!STREETS.includes(obs.street)) { bad('missing-field', 'Street not recognised'); return null; }
      if (!Array.isArray(obs.board) || !obs.board.every(isCard)) { bad('invalid-card', 'Board contains an invalid card'); return null; }
      if (obs.board.length !== BOARD_LEN[obs.street]) { bad('contradiction', obs.board.length + ' board cards on ' + obs.street); return null; }
      if (!Array.isArray(obs.seats) || obs.seats.length !== this.seats) { bad('ambiguous-seats', 'Expected exactly ' + this.seats + ' seat records'); return null; }
      const seen = new Set(obs.board);
      if (seen.size !== obs.board.length) { bad('invalid-card', 'Duplicate board card'); return null; }
      const seats = [];
      for (let i = 0; i < this.seats; i++) {
        const r = obs.seats[i];
        if (!r || r.seat !== i) { bad('ambiguous-seats', 'Seat record ' + i + ' is out of order or missing'); return null; }
        for (const k of ['stack', 'bet']) if (!isInt(r[k]) || r[k] < 0) { bad('missing-field', 'Seat ' + i + ' has no valid ' + k); return null; }
        if (r.total !== undefined && (!isInt(r.total) || r.total < r.bet)) { bad('contradiction', 'Seat ' + i + ' total below street bet'); return null; }
        let cards = null;
        if (r.cards !== null && r.cards !== undefined) {
          if (!Array.isArray(r.cards) || r.cards.length !== 2 || !r.cards.every(isCard) || r.cards[0] === r.cards[1]) { bad('invalid-card', 'Seat ' + i + ' hole cards invalid'); return null; }
          cards = r.cards.slice();
          for (const c of cards) { if (seen.has(c)) { bad('invalid-card', 'Card ' + cardToString(c) + ' appears twice'); return null; } seen.add(c); }
        }
        // 0.36.2 M3: explicit seat status. The tracker annotates every seat from its ledger; without tracking it is read from the record.
        // `folded` keeps its 0.20 meaning "not contesting this hand" (an eliminated seat is shown folded and contests nothing); `status`
        // and `inHand` say WHY.
        const status = typeof r.status === 'string' && Object.values(SEAT_STATUS).includes(r.status) ? r.status : screenSeatStatus(r);
        const inHand = r.inHand !== undefined ? r.inHand !== false : !(status === SEAT_STATUS.ELIMINATED || status === SEAT_STATUS.SITTING_OUT);
        seats.push({ seat: i, stack: r.stack, bet: r.bet, total: r.total === undefined ? null : r.total, folded: !!r.folded || !inHand, allIn: r.stack === 0 && !r.folded && inHand, cards, status, inHand });
      }
      if (!isInt(obs.button) || obs.button < 0 || obs.button >= this.seats) { bad('ambiguous-seats', 'Dealer button not identified'); return null; }
      if (!isInt(obs.pot) || obs.pot < 0) { bad('missing-field', 'Pot not recognised'); return null; }
      const live = seats.filter((p) => !p.folded);
      if (live.length < 1) { bad('contradiction', 'No live players'); return null; }
      const status = obs.status === 'complete' ? 'complete' : 'playing';
      let actor = obs.actor;
      if (status === 'playing') {
        if (!isInt(actor) || actor < 0 || actor >= this.seats) { bad('ambiguous-seats', 'Acting seat not identified'); return null; }
        if (seats[actor].folded || seats[actor].stack === 0) { bad('contradiction', 'Acting seat ' + actor + ' is ' + (seats[actor].inHand ? 'folded or all-in' : 'not dealt in (' + seats[actor].status + ')')); return null; }
      } else actor = -1;
      // Accounting. Pot must equal everything committed; totals are required for an exact check.
      const sumBets = seats.reduce((n, p) => n + p.bet, 0);
      const haveTotals = seats.every((p) => p.total !== null);
      if (haveTotals) {
        const sumTotal = seats.reduce((n, p) => n + p.total, 0);
        if (status === 'playing' && sumTotal !== obs.pot) { bad('inconsistent-pot', 'Pot ' + obs.pot + ' != committed chips ' + sumTotal); return null; }
        const bankroll = seats.reduce((n, p) => n + p.stack + p.total, 0), ref = obs._tb !== undefined ? obs._tb : this.bankroll;
        if (ref !== null && status === 'playing' && bankroll !== ref) { bad('inconsistent-stacks', 'Chips in play ' + bankroll + ' != established ' + ref); return null; }
      } else if (this.bankroll !== null && status === 'playing' && obs.pot + seats.reduce((n, p) => n + p.stack, 0) !== this.bankroll) {
        bad('inconsistent-pot', 'Pot ' + obs.pot + ' + stacks ' + seats.reduce((n, p) => n + p.stack, 0) + ' != chips in play ' + this.bankroll); return null;
      } else if (obs.pot < sumBets) { bad('inconsistent-pot', 'Pot ' + obs.pot + ' below current street bets ' + sumBets); return null; }
      // 0.36.2 M3: preflop the amount to match is at least the full big blind, also when the big blind is all-in for less (engine.js rule)
      const currentBet = Math.max(obs.street === 'preflop' && status === 'playing' ? this.opt.bb : 0, ...seats.map((p) => p.bet));
      if (status === 'playing' && obs.currentBet !== undefined && obs.currentBet !== currentBet) { bad('contradiction', 'Reported bet to match ' + obs.currentBet + ' != largest wager ' + currentBet); return null; }
      const history = obs.actions === undefined ? null : obs.actions;
      if (history !== null) {
        if (!Array.isArray(history) || !history.every((a) => a && isInt(a.seat) && a.seat >= 0 && a.seat < this.seats && ['fold', 'check', 'call', 'raise', 'bet', 'allin'].includes(a.type))) { bad('incomplete-history', 'Action history malformed'); return null; }
      }
      const handStart = obs.street === 'preflop' && history !== null && history.length === 0;
      if (handStart && haveTotals) {
        // 0.36.2 M3: the opening pot follows the players DEALT IN (the eight-handed 2.3 BB only when all eight are), computed with the ledger's rules
        const why = this._openingPotProblem(obs, seats);
        if (why) { bad('inconsistent-start-pot', why); return null; }
      }
      if (haveTotals && this.bankroll === null) this._pendingBankroll = seats.reduce((n, p) => n + p.stack + p.total, 0);
      return {
        table: this.table, hand: isInt(obs.hand) ? obs.hand : null, status, street: obs.street, board: obs.board.slice(),
        button: obs.button, actor, pot: obs.pot, currentBet, lastRaise: Number.isFinite(obs.lastRaise) ? obs.lastRaise : null,
        canReopen: obs.canReopen, stakes: { sb: this.opt.sb, bb: this.opt.bb, ante: this.opt.ante }, seats, actions: history, handStart, source: obs.source || 'unknown',
        confidence: conf.overall, seq: obs.seq, simRevision: isInt(obs.simRevision) ? obs.simRevision : null,
        participants: seats.filter((p) => p.inHand).length,
        legal: null,
      };
    }
    /** Opening position with per-seat totals: do the totals equal the forced bets of the players dealt in? null when they do. */
    _openingPotProblem(obs, seats) {
      const o = this.opt, sittingOut = seats.filter((p) => p.status === SEAT_STATUS.SITTING_OUT).map((p) => p.seat);
      for (const p of seats) if (p.inHand && p.stack + p.total === 0) return 'Seat ' + p.seat + ' has no chips and posted nothing but is not shown as out of the hand';
      const pre = seats.map((p) => (p.status === SEAT_STATUS.SITTING_OUT ? p.stack : p.inHand ? p.stack + p.total : 0));
      let fb; try { fb = LG.forcedBets({ seats: this.seats, button: obs.button, stacks: pre, sittingOut, sb: o.sb, bb: o.bb, ante: o.ante }); } catch (e) { return 'The opening position cannot start a hand: ' + e.message; }
      if (obs.pot !== fb.openingPot) return 'Opening pot ' + obs.pot + ' != ' + fb.openingPot + ' (' + this._describeForced(fb) + ')';
      for (const p of seats) if (p.total !== fb.contributions[p.seat]) return 'Seat ' + p.seat + ' has posted ' + p.total + '; its forced bets are ' + fb.contributions[p.seat] + (p.inHand ? '' : ' (not dealt in)');
      return null;
    }
    _describeForced(fb) {
      const o = this.opt, n = fb.participants.length, antes = fb.antes.reduce((a, b) => a + b, 0), sbPaid = fb.blinds[fb.sbSeat], bbPaid = fb.blinds[fb.bbSeat];
      return n + ' player' + (n === 1 ? '' : 's') + ' dealt in: antes ' + antes + (antes !== n * o.ante ? ' (a short stack posted less than the ante)' : '') + ' + small blind ' + sbPaid + (sbPaid < o.sb ? ' (all-in)' : '') + ' at seat ' + fb.sbSeat + ' + big blind ' + bbPaid + (bbPaid < o.bb ? ' (all-in)' : '') + ' at seat ' + fb.bbSeat + (fb.headsUp ? ', heads-up: the button posts the small blind' : '');
    }

    /* ---------- 0.24 tracking: derive history, contributions and legality from consecutive readings ---------- */
    _track(obs, issues) {
      const bad = (code, detail) => { issues.push({ code, detail }); return null; }, o = this.opt;
      if (!obs || obs.format !== 'eightmax-observation' || obs.version !== 1) return null; // _build reports the format error
      if (obs.table !== this.table || !Array.isArray(obs.seats) || obs.seats.length !== this.seats || !Array.isArray(obs.board)) return null; // ditto
      if (!isInt(obs.hand)) return bad('missing-hand-id', 'Tracking needs the hand number to tell hands apart');
      for (const r of obs.seats) if (!r || !isInt(r.stack) || !isInt(r.bet) || r.stack < 0 || r.bet < 0) return null; // _build reports it
      const sIdx = STREETS.indexOf(obs.street); if (sIdx < 0 || !isInt(obs.button) || obs.button < 0 || obs.button >= this.seats) return null;
      const complete = obs.status === 'complete';
      let led, newHand = false, opening = null;
      const ut = this.tr.untracked;
      if (ut && ut.hand === obs.hand) {
        ut.frames++;
        // 0.36.2 M3: a finished tournament can be RECOGNISED on an untracked hand's final screen (one seat holds every chip). This is
        // only a reading for the status display (automation stops); it never becomes an accepted state and never leads to input.
        if (complete) { const funded = obs.seats.filter((r) => r.stack > 0); if (funded.length === 1 && obs.seats.every((r) => r.bet === 0)) this.tour.observedEnd = { hand: obs.hand, winner: funded[0].seat, source: 'final screen of an untracked hand (settlement not verified)' }; }
        return bad('untracked-hand', 'Hand ' + obs.hand + ' is not tracked (' + ut.code + ': ' + ut.reason + '). Automated input is paused until the opening of a later hand is verified.');
      }
      if (!this.tr.led || this.tr.hand !== obs.hand) {
        newHand = true;
        if (this.tr.hand !== null && obs.hand < this.tr.hand) return bad('contradiction', 'Hand number went backwards (' + obs.hand + ' after ' + this.tr.hand + ')');
        if (ut && obs.hand < ut.hand) return bad('contradiction', 'Hand number went backwards (' + obs.hand + ' after untracked hand ' + ut.hand + ')');
        opening = this._openHand(obs, complete);
        if (opening.refuse) { this._markUntracked(obs.hand, opening.refuse.code, opening.refuse.detail, obs.seq); return bad(opening.refuse.code, opening.refuse.detail); }
        led = opening.led;
      } else led = this.tr.led.clone();
      const actions = [];
      if (!newHand) {
        const seen = new Set(); let guard = 0;
        for (;;) {
          if (this._matches(led, obs)) break;
          if (++guard > o.maxGapActions + 4) return bad('ambiguous-gap', 'More than ' + o.maxGapActions + ' steps separate consecutive readings');
          if (led.status === 'awaiting-board' || (led.status === 'showdown' && led.board.length < 5)) {
            const have = led.board.length;
            if (obs.board.length > have && led.board.every((c, i) => obs.board[i] === c)) { try { led.dealBoard(obs.board.slice(have)); } catch (e) { return bad('contradiction', 'Board advanced illegally: ' + e.message); } continue; }
            return bad('missing-board', 'Betting closed but the next street is not shown');
          }
          if (led.status !== 'betting') break;
          const A = led.actor; if (seen.has(A)) return bad('ambiguous-gap', 'Seat ' + A + ' would have to act twice between readings; the intermediate raise sizes are unknowable');
          seen.add(A);
          const act = this._deriveAction(led, obs, A, complete, seen.size);
          if (act.error) return bad(act.code || 'unexplained-change', act.error);
          try { const e = led.apply(act); actions.push(e); } catch (e) { return bad('illegal-action', 'Inferred ' + act.type + ' by seat ' + A + ' is illegal: ' + e.message); }
        }
        // Several unseen actions are accepted only when they are unambiguous. A raise followed (in the same gap) by another player's call or check
        // could equally have been "smaller raise, re-raise, call": the screen cannot tell, and the history decides which solver node applies.
        for (let i = 0; i < actions.length; i++) if (actions[i].type === 'raise') for (let j = i + 1; j < actions.length; j++) if ((actions[j].type === 'call' || actions[j].type === 'check') && actions[j].seat !== actions[i].seat) return bad('ambiguous-gap', 'A raise and a later call/check by another seat fall between two readings; hidden re-raises cannot be excluded, so the history is not reconstructed');
        if (!this._matches(led, obs)) return bad('unexplained-change', 'No sequence of legal actions explains the new reading: ' + (this._mismatch(led, obs, complete) || 'state differs'));
      }
      let settlement = null;
      if (complete) {
        const cs = led.checkSettlement(obs.seats.map((r) => r.stack)); if (!cs.ok) return bad('bad-settlement', cs.reasons.join('; '));
        if (led.live.length > 1 && led.board.length !== 5) return bad('missing-board', 'Showdown without a full board');
        settlement = cs;
      } else if (led.status !== 'betting') return bad('contradiction', 'Ledger says no player is to act (' + led.status + ') but the reading is mid-hand');
      // The screen's own pot and controls are checked against what the rules say.
      if (!complete && obs.pot !== led.pot) return bad(newHand ? 'inconsistent-start-pot' : 'inconsistent-pot', (newHand ? 'Opening pot read ' + obs.pot + ' but the forced bets come to ' + led.pot + ' (' + this._describeForced(LG.forcedBets({ seats: this.seats, button: led.button, stacks: led.start, sittingOut: opening && opening.sittingOut, sb: o.sb, bb: o.bb, ante: o.ante })) + ')' : 'Pot read ' + obs.pot + ' but the hand history accounts for ' + led.pot));
      const lg = !complete ? led.legal() : null;
      // 0.35: the controls on screen belong to the player whose view is shown. While ANOTHER player is to act a normal client shows
      // none (the controlled renderer always showed the actor's view, so this case never arose before); any shown control is refused.
      const viewerActs = !Number.isInteger(obs.heroSeat) || obs.heroSeat === led.actor;
      if (lg && o.requireControlsMatch && obs.controls && !viewerActs && (obs.controls.fold || obs.controls.check || obs.controls.call || obs.controls.raise)) return bad('controls-disagree', 'Action controls are shown although seat ' + led.actor + ' (not the viewer, seat ' + obs.heroSeat + ') is to act');
      // 0.36.2 M3: NO control shown at all while the viewer is to act is "controls not offered yet" (a client animating the deal, the
      // fixture's think-time hold when one seat acts on two streets in a row): it says nothing about legality and nothing can be clicked,
      // so the reading is used and the table simply waits. Until M2 it was refused as controls-disagree, which left our own just-sent
      // action unconfirmable (pre-existing since 0.35; found by the Milestone 3 turn-delay tests). Shown controls are still checked.
      const shown = !!(obs.controls && (obs.controls.fold || obs.controls.check || obs.controls.call || obs.controls.raise));
      if (lg && o.requireControlsMatch && obs.controls && viewerActs && shown) {
        const c = obs.controls, mism = [];
        if (c.fold !== lg.canFold) mism.push('fold ' + c.fold + ' vs ' + lg.canFold); if (c.check !== lg.canCheck) mism.push('check ' + c.check + ' vs ' + lg.canCheck);
        if (c.call !== lg.canCall) mism.push('call ' + c.call + ' vs ' + lg.canCall); if (c.raise !== lg.canRaise) mism.push('raise ' + c.raise + ' vs ' + lg.canRaise);
        if (c.call && obs.callAmount !== lg.callAmount) mism.push('call amount ' + obs.callAmount + ' vs ' + lg.callAmount);
        if (c.raise && obs.minRaiseTo !== lg.minRaiseTo) mism.push('minimum raise ' + obs.minRaiseTo + ' vs ' + lg.minRaiseTo);
        if (mism.length) return bad('controls-disagree', 'Action controls on screen disagree with the rules: ' + mism.join('; '));
      }
      for (let i = 0; i < this.seats; i++) { const r = obs.seats[i]; if (r.allInMarker !== undefined && r.allInMarker !== (r.stack === 0 && !r.folded)) return bad('contradiction', 'Seat ' + i + ' all-in marker disagrees with its stack'); }
      const out = JSON.parse(JSON.stringify(obs)); out.seats.forEach((r, i) => { r.total = led.p[i].total; r.inHand = led.p[i].inHand !== false; r.status = led.seatStatus(i); delete r.allInMarker; }); out._tb = led.start.reduce((a, b) => a + b, 0);
      out.actions = led.history.map((h) => ({ seat: h.seat, type: h.type === 'raise' ? (h.allIn ? 'allin' : (h.street && led.history.filter((x) => x.street === h.street).indexOf(h) >= 0 && this._opening(led, h) ? 'bet' : 'raise')) : h.type, amount: h.to, street: h.street }));
      out.lastRaise = led.raiseSize; out.currentBet = complete ? undefined : led.currentBet; out.canReopen = lg ? lg.reopened : undefined;
      return { obs: out, led, hand: obs.hand, bankroll: led.start.reduce((a, b) => a + b, 0), opening, settlement };
    }

    /**
     * 0.36.2 M3: reconstruct the OPENING position of a new hand from its first reading. Returns {led, notes, sittingOut, plan} or
     * {refuse: {code, detail}}. Every check names the element that failed. Players who are not dealt in are recognised; a missed
     * action is never assumed away.
     */
    _openHand(obs, complete) {
      const o = this.opt, n = this.seats, hand = obs.hand, refuse = (code, detail) => ({ refuse: { code, detail } });
      if (complete) return refuse('missed-hand-start', 'The first reading of hand ' + hand + ' already shows the finished hand; its forced bets and actions were not observed, so the hand cannot be reconstructed');
      if (obs.street !== 'preflop' || obs.board.length) return refuse('missed-hand-start', 'The first reading of hand ' + hand + ' is on the ' + obs.street + ' (' + obs.board.length + ' board cards): the betting before it was not observed');
      const st = obs.seats.map(screenSeatStatus);
      const foldedWithChips = st.map((s, i) => (s === SEAT_STATUS.FOLDED ? i : -1)).filter((i) => i >= 0);
      if (foldedWithChips.length) return refuse('missed-hand-start', 'In the first reading of hand ' + hand + ' ' + seatList(foldedWithChips) + (foldedWithChips.length === 1 ? ' is' : ' are') + ' shown folded with chips (' + foldedWithChips.map((i) => obs.seats[i].stack + obs.seats[i].bet).join(', ') + '): a fold happened before observation started. (Seats shown folded with no chips are eliminated players and are not a reason to refuse.)');
      const eliminated = st.map((s, i) => (s === SEAT_STATUS.ELIMINATED ? i : -1)).filter((i) => i >= 0), sittingOut = st.map((s, i) => (s === SEAT_STATUS.SITTING_OUT ? i : -1)).filter((i) => i >= 0);
      const participants = st.map((s, i) => (s === SEAT_STATUS.ACTIVE || s === SEAT_STATUS.ALL_IN ? i : -1)).filter((i) => i >= 0);
      if (participants.length < 2) return refuse('hand-start-mismatch', 'Hand ' + hand + ' shows ' + participants.length + ' player(s) dealt in; a hand needs at least two');
      const mode = this.tour.mode, notes = [], prev = this.tour.lastSettled, consecutive = !!(prev && prev.hand === hand - 1);
      // --- seating cross-checks against the previous settled hand (any mode except off) ---
      if (mode !== 'off' && consecutive) {
        // chips never vanish between consecutive hands: neither a tournament nor a re-funded table shows a funded player with nothing
        const busted = eliminated.filter((i) => prev.stacks[i] > 0);
        if (busted.length) return refuse('seating-contradiction', 'Hand ' + hand + ' shows ' + seatList(busted) + ' eliminated, but ' + (busted.length === 1 ? 'it' : 'they') + ' still had chips (' + busted.map((i) => prev.stacks[i]).join(', ') + ') when hand ' + prev.hand + ' was settled');
      }
      const rejoined = participants.filter((i) => this.tour.seats[i].status === SEAT_STATUS.ELIMINATED);
      if (rejoined.length && mode === 'strict') return refuse('seating-contradiction', seatList(rejoined) + (rejoined.length === 1 ? ' was' : ' were') + ' eliminated (after hand ' + rejoined.map((i) => this.tour.seats[i].eliminatedAfterHand).join(', ') + ') but ' + (rejoined.length === 1 ? 'is' : 'are') + ' dealt in again in hand ' + hand + '; an eliminated player cannot return to this tournament');
      for (const i of rejoined) notes.push({ kind: 'seat-rejoined', seat: i, detail: 'seat ' + i + ' was eliminated and is dealt in again (re-funded table or new tournament)' });
      // --- stacks before the forced bets: from the screen; exact from the previous settlement when chips carry over ---
      const pre = new Array(n).fill(0), unknown = [];
      for (const i of participants) {
        const r = obs.seats[i];
        if (isInt(r.total)) pre[i] = r.stack + r.total;                         // a structured feed shows what was committed: exact
        else if (r.stack > 0) pre[i] = r.stack + r.bet + o.ante;                // chips left: the full ante and blind were posted
        else if (r.bet > 0) pre[i] = r.bet + o.ante;                            // all-in posting a blind: the ante was paid in full first
        else if (o.ante > 0) unknown.push(i);                                   // all-in for the ante or less: the exact amount is not visible
        else return refuse('hand-start-mismatch', 'Seat ' + i + ' shows no chips, no bet and no folded marker in the first reading of hand ' + hand);
      }
      for (const i of sittingOut) pre[i] = obs.seats[i].stack;
      let continuity = consecutive ? 'checked' : 'not-applicable';
      if (consecutive && mode !== 'off') {
        const diff = [];
        for (let i = 0; i < n; i++) {
          const carried = prev.stacks[i];
          if (participants.includes(i)) { if (unknown.includes(i) ? !(carried >= 1 && carried <= o.ante) : pre[i] !== carried) diff.push(i); }
          else if (eliminated.includes(i) && carried !== 0) diff.push(i);
        }
        if (diff.length && mode === 'strict') return refuse('stack-continuity', 'Stacks at the start of hand ' + hand + ' do not continue from hand ' + prev.hand + ': ' + diff.map((i) => 'seat ' + i + ' ' + (unknown.includes(i) ? '1-' + o.ante : pre[i]) + ' vs ' + prev.stacks[i]).join(', ') + ' (stacks before the forced bets vs settled stacks)');
        if (diff.length) { continuity = 'reset'; notes.push({ kind: 'stack-reset', detail: 'stacks differ from the settled hand ' + prev.hand + ' at ' + seatList(diff) + ' (the table was re-funded)' }); }
        else { continuity = 'carried'; for (const i of unknown) pre[i] = prev.stacks[i]; unknown.length = 0; }
      }
      if (unknown.length === 1) {
        const u = unknown[0], others = participants.filter((i) => i !== u).reduce((a, i) => a + o.ante + obs.seats[i].bet, 0), x = obs.pot - others;
        if (!(x >= 1 && x <= o.ante)) return refuse('inconsistent-start-pot', 'Opening pot ' + obs.pot + ' leaves ' + x + ' for seat ' + u + ', which is all-in for its ante (1 to ' + o.ante + ' chips)');
        pre[u] = x; notes.push({ kind: 'short-ante', seat: u, detail: 'seat ' + u + ' posted all of its ' + x + ' chips as the ante (from the pot)' });
      } else if (unknown.length > 1) return refuse('ambiguous-start', seatList(unknown) + ' are all-in for less than the ante; their exact contributions are not visible and no settled previous hand gives them');
      // --- button ---
      if (!participants.includes(obs.button)) return refuse('hand-start-mismatch', 'The dealer button is shown at seat ' + obs.button + ', which is not dealt in (' + st[obs.button] + '); the button moves only among players who are dealt in');
      const lo = this.tour.lastOpening;
      if (mode !== 'off' && lo && lo.hand === hand - 1) {
        let expected = -1; for (let k = 1; k <= n; k++) { const s = (lo.button + k) % n; if (participants.includes(s)) { expected = s; break; } }
        if (expected !== obs.button) {
          if (mode === 'strict') return refuse('button-movement', 'The button should move from seat ' + lo.button + ' (hand ' + lo.hand + ') to seat ' + expected + ', the next seat dealt in; the first reading of hand ' + hand + ' shows it at seat ' + obs.button);
          notes.push({ kind: 'button-unexpected', detail: 'button at seat ' + obs.button + ', expected seat ' + expected });
        }
      }
      // --- forced bets by the simulator's rules, then every element compared with the reading ---
      let led; try { led = new LG.HandLedger({ seats: n, button: obs.button, stacks: pre, sittingOut, sb: o.sb, bb: o.bb, ante: o.ante }); } catch (e) { return refuse('hand-start-mismatch', 'The opening position of hand ' + hand + ' cannot be a legal start: ' + e.message); }
      for (let i = 0; i < n; i++) {
        const q = led.p[i], r = obs.seats[i], role = i === led.sbSeat ? 'small blind' : i === led.bbSeat ? 'big blind' : null;
        // more than the forced bet already in front of a seat: somebody acted before the first reading (a missed call or raise)
        // (a blind showing the other blind's amount is a position mismatch, explained below; a blind above the big blind is a raise)
        if (r.bet > q.bet && q.stack > 0 && (role === null || r.bet > led.currentBet)) return refuse('missed-hand-start', 'Seat ' + i + (role ? ' (' + role + ', ' + q.bet + ')' : '') + ' has already put ' + r.bet + ' in front of it in the first reading of hand ' + hand + ': an action happened before observation started');
        if (q.bet !== r.bet) return refuse('hand-start-mismatch', 'Seat ' + i + (role ? ' (' + role + ')' : '') + ' shows a bet of ' + r.bet + '; ' + (role ? 'the ' + role + ' is ' + q.bet + ' (' + (role === 'small blind' ? (led.headsUp ? 'heads-up the button posts it' : 'first seat dealt in after the button at seat ' + led.button) : 'next seat dealt in after the small blind at seat ' + led.sbSeat) + (eliminated.length ? '; eliminated ' + seatList(eliminated) + ' skipped' : '') + ')' : 'nobody has acted yet, so it should be ' + q.bet));
        if (q.stack !== r.stack) return refuse('hand-start-mismatch', 'Seat ' + i + ' shows ' + r.stack + ' chips behind; after its forced bets it should have ' + q.stack);
      }
      if (obs.pot !== led.pot) return refuse('inconsistent-start-pot', 'Opening pot ' + obs.pot + ' != ' + led.pot + ' (' + this._describeForced(LG.forcedBets({ seats: n, button: obs.button, stacks: pre, sittingOut, sb: o.sb, bb: o.bb, ante: o.ante })) + ')');
      if (led.status !== 'betting') return refuse('hand-start-mismatch', 'The forced bets of hand ' + hand + ' leave nobody able to act (' + led.status + ') but the reading shows a player to act');
      if (obs.actor !== led.actor) return refuse('hand-start-mismatch', 'Seat ' + obs.actor + ' is shown to act first; the first player to act is seat ' + led.actor + ' (first seat with chips after the big blind at seat ' + led.bbSeat + ')');
      const why = this._mismatch(led, obs, false); if (why) return refuse('hand-start-mismatch', 'Opening position disagrees with blinds and antes: ' + why);
      return { led, notes, sittingOut, plan: { hand, participants, eliminated, sittingOut, button: led.button, sbSeat: led.sbSeat, bbSeat: led.bbSeat, headsUp: led.headsUp, continuity, preStacks: pre.slice() } };
    }
    _markUntracked(hand, code, reason, seq) {
      if (!this.tr.untracked || this.tr.untracked.hand !== hand) this.tr.untrackedHands++;
      this.tr.untracked = { hand, code, reason, frames: 1, sinceSeq: seq, lastValidHand: this.tr.lastValidHand };
    }
    /** A contradiction that persists frame after frame within one hand makes that hand untracked: the table then waits for the next verified opening. */
    _noteContradiction(obs, issues) {
      const code = issues[0].code; if (code === 'untracked-hand' || UNTRACKED_CODES.includes(code) || !obs || !isInt(obs.hand)) { this.tr.contradiction = null; return; }
      if (code === 'stale-observation' || code === 'wrong-table' || code === 'unsupported-format') return;
      // An UNREADABLE frame (low confidence, missing or impossible fields) says nothing against the reconstructed hand: it is refused,
      // input stays blocked, but it never turns the hand untracked - the hand resumes as soon as the screen reads reliably again
      // (Windows CI run 45203097931: 25 low-confidence readings of one turn card had escalated to 'persistent-contradiction').
      if (UNREADABLE_CODES.includes(code)) return;
      const c = this.tr.contradiction;
      if (c && c.hand === obs.hand && c.code === code) c.frames++; else this.tr.contradiction = { hand: obs.hand, code, detail: issues[0].detail, frames: 1 };
      if (this.tr.contradiction.frames >= this.opt.maxContradictionFrames && (this.tr.hand === null || obs.hand >= this.tr.hand)) {
        const k = this.tr.contradiction; this._markUntracked(obs.hand, 'persistent-contradiction', k.frames + ' consecutive readings contradicted the reconstructed hand (' + k.code + ': ' + k.detail + ')', obs.seq); this.tr.contradiction = null;
      }
    }
    /** Seating facts from an ACCEPTED reading (never from a refused one). */
    _applySeating(trk, state) {
      const T = this.tour, ev = (e) => { e.seq = ++T.eventSeq; T.events.push(e); if (T.events.length > this.opt.maxSeatingEvents) T.events.shift(); };
      if (trk.opening) {
        const p = trk.opening.plan, prevCount = T.lastOpening ? T.lastOpening.participants.length : null; T.handsOpened++;
        // a verified hand after a finished tournament: the table was re-funded (auto/off mode; strict mode refuses the returning players)
        const ended = T.complete || T.observedEnd; if (ended && p.hand > ended.hand) { ev({ kind: 'new-tournament', hand: p.hand, detail: 'hand ' + p.hand + ' verified after the tournament ended at hand ' + ended.hand }); T.complete = null; T.observedEnd = null; }
        for (const nt of trk.opening.notes) { if (nt.kind === 'stack-reset') T.stackResets++; ev({ kind: nt.kind, hand: p.hand, seat: nt.seat, detail: nt.detail }); }
        for (let i = 0; i < this.seats; i++) {
          const s = T.seats[i];
          if (p.participants.includes(i)) { s.status = 'in-play'; s.eliminatedAfterHand = null; }
          else if (p.sittingOut.includes(i)) s.status = SEAT_STATUS.SITTING_OUT;
          else if (s.status !== SEAT_STATUS.ELIMINATED) {
            const after = T.lastSettled && T.lastSettled.hand === p.hand - 1 ? T.lastSettled.hand : null;
            s.status = SEAT_STATUS.ELIMINATED; s.eliminatedAfterHand = after; s.lastStack = 0;
            const rec = { seat: i, afterHand: after, detectedBy: 'hand-start', hand: p.hand, remaining: p.participants.length };
            T.eliminations.push(rec); if (T.eliminations.length > 64) T.eliminations.shift(); ev({ kind: 'eliminated', hand: p.hand, seat: i, detail: 'seat ' + i + ' is not dealt in from hand ' + p.hand + ' (no chips)' });
          }
        }
        if (p.headsUp && (prevCount === null || prevCount > 2)) { T.headsUpSince = p.hand; ev({ kind: 'heads-up', hand: p.hand, detail: 'two players remain: the button (seat ' + p.button + ') posts the small blind' }); }
        if (!p.headsUp) T.headsUpSince = null;
        T.lastOpening = { hand: p.hand, button: p.button, sbSeat: p.sbSeat, bbSeat: p.bbSeat, participants: p.participants.slice(), continuity: p.continuity };
        state.openingCheck = { hand: p.hand, participants: p.participants.slice(), eliminated: p.eliminated.slice(), sittingOut: p.sittingOut.slice(), button: p.button, sbSeat: p.sbSeat, bbSeat: p.bbSeat, headsUp: p.headsUp, continuity: p.continuity, notes: trk.opening.notes.map((x) => x.kind) };
      }
      if (trk.settlement && (!T.lastSettled || T.lastSettled.hand !== trk.hand)) {
        const stacks = state.seats.map((q) => q.stack); T.lastSettled = { hand: trk.hand, stacks }; T.handsSettled++;
        for (const i of trk.settlement.eliminated) {
          const s = T.seats[i]; if (s.status === SEAT_STATUS.ELIMINATED) continue;
          s.status = SEAT_STATUS.ELIMINATED; s.eliminatedAfterHand = trk.hand; s.lastStack = 0;
          const rec = { seat: i, afterHand: trk.hand, detectedBy: 'settlement', remaining: trk.settlement.funded.length };
          T.eliminations.push(rec); if (T.eliminations.length > 64) T.eliminations.shift(); ev({ kind: 'eliminated', hand: trk.hand, seat: i, detail: 'seat ' + i + ' lost its last chips in hand ' + trk.hand + '; ' + trk.settlement.funded.length + ' player(s) remain' });
        }
        stacks.forEach((v, i) => { if (v > 0) T.seats[i].lastStack = v; });
        if (trk.settlement.funded.length === 1 && !T.complete) { T.complete = { hand: trk.hand, winner: trk.settlement.funded[0], source: 'verified settlement' }; ev({ kind: 'tournament-complete', hand: trk.hand, seat: trk.settlement.funded[0], detail: 'seat ' + trk.settlement.funded[0] + ' holds every chip after hand ' + trk.hand }); }
      }
    }
    /** An opening postflop wager is a "bet"; preflop (blinds are the first wager) and any later one is a "raise". */
    _opening(led, h) { if (h.street === 'preflop') return false; const prior = led.history.filter((x) => x.street === h.street); for (const x of prior) { if (x === h) return true; if (x.type === 'raise') return false; } return false; }
    _matches(led, obs) {
      const why = this._mismatch(led, obs, obs.status === 'complete'); return why === null;
    }
    /** null when the ledger's state equals what the screen shows; otherwise the first difference. */
    _mismatch(led, obs, complete) {
      if (obs.board.length !== led.board.length || obs.board.some((c, i) => c !== led.board[i])) return 'board';
      for (let i = 0; i < this.seats; i++) {
        const q = led.p[i], r = obs.seats[i];
        // the simulator shows a seat that is not dealt in with the folded marker; an explicit sitting-out seat carries its own marker
        if (q.outReason !== 'sitting-out' && led.displayFolded(i) !== !!r.folded) return 'seat ' + i + ' fold flag' + (q.inHand === false ? ' (seat is not dealt in)' : '');
        if (!complete) { if (q.stack !== r.stack) return 'seat ' + i + ' stack ' + r.stack + ' vs ' + q.stack; if (q.bet !== r.bet) return 'seat ' + i + ' bet ' + r.bet + ' vs ' + q.bet; }
      }
      if (complete) return led.status === 'complete' || led.status === 'showdown' ? null : 'hand not finished (' + led.status + ')';
      if (STREETS.indexOf(obs.street) !== led.street) return 'street';
      if (led.status !== 'betting') return 'betting closed';
      if (obs.actor !== led.actor) return 'actor ' + obs.actor + ' vs ' + led.actor;
      return null;
    }
    /** What must seat A have done for the screen to look the way it does? Never a guess: only the unique consistent action. */
    _deriveAction(led, obs, A, complete, stepNo) {
      const q = led.p[A], r = obs.seats[A], l = led.legal(A), toCall = l.toCall;
      if (r.folded) return { seat: A, type: 'fold' };
      if (complete) {
        // The closing action of a finished hand is forced: only a fold (visible) or a non-raising call/check can end it.
        if (stepNo > 1) return { error: 'More than one unobserved action precedes the end of the hand', code: 'ambiguous-gap' };
        return toCall > 0 ? { seat: A, type: 'call' } : { seat: A, type: 'check' };
      }
      const sameStreet = led.street === STREETS.indexOf(obs.street);
      let to;
      if (sameStreet) to = r.bet;
      else { const startA = led.start[A], totalNow = startA - r.stack, newStreetBet = r.bet; to = totalNow - newStreetBet - (q.total - q.bet); }
      if (!isInt(to) || to < q.bet) return { error: 'Seat ' + A + ' wager moved backwards or is not an integer', code: 'contradiction' };
      if (to === q.bet) return toCall > 0 ? { error: 'Seat ' + A + ' is facing a wager but shows no change; the reading is not an outcome of any legal action', code: 'unexplained-change' } : { seat: A, type: 'check' };
      if (to <= led.currentBet) return { seat: A, type: 'call' };
      return { seat: A, type: 'raise', amount: to };
    }
    _decorate(state, trk) {
      const led = trk.led, anyAllIn = led.live.some((i) => led.p[i].stack === 0), pk = led.pots();
      // Mid-hand with nobody all-in there is one pot; levels of unmatched wagers are not side pots until a player is all-in or the hand ends.
      if (state.status === 'playing' && !anyAllIn) { state.sidePots = [{ amount: led.pot, eligible: led.live.slice() }]; state.refunds = []; }
      else { state.sidePots = pk.pots.map((p) => ({ amount: p.amount, eligible: p.eligible.slice() })); state.refunds = pk.refunds.map((r) => ({ ...r })); }
      state.startStacks = led.start.slice(); state.tracked = true; state.ledgerStatus = led.status;
      // 0.36.2 M3: participation from the ledger (authoritative): who is dealt in, the blind seats, and per-seat status
      state.participants = led.participants.length; state.dealtIn = led.participants.slice(); state.sbSeat = led.sbSeat; state.bbSeat = led.bbSeat; state.headsUp = led.headsUp;
      state.seats.forEach((p, i) => { const q = led.p[i]; p.inHand = q.inHand !== false; p.status = !p.inHand ? led.seatStatus(i) : q.folded ? SEAT_STATUS.FOLDED : p.stack === 0 ? SEAT_STATUS.ALL_IN : SEAT_STATUS.ACTIVE; });   // p.stack: the reading (final stacks on a finished hand)
      const lg = state.status === 'playing' ? led.legal() : null;
      if (lg) state.legal = { exact: true, toCall: lg.toCall, callAmount: lg.callAmount, canCheck: lg.canCheck, canCall: lg.canCall, canFold: lg.canFold, canRaise: lg.canRaise, minRaiseTo: lg.minRaiseTo, fullMinRaiseTo: lg.fullMinRaiseTo, maxRaiseTo: lg.maxRaiseTo, allInAmount: lg.maxRaiseTo, reopened: lg.reopened };
      state.settlement = state.status === 'complete' ? led.checkSettlement(state.seats.map((p) => p.stack)) : null;
    }

    _continuity(s, issues) {
      const p = this.last, bad = (code, detail) => issues.push({ code, detail });
      if (p && p.hand !== null && s.hand !== null && s.hand < p.hand) bad('contradiction', 'Hand number went backwards');
      const sameHand = p && (p.hand === s.hand || (p.hand === null && s.hand === null && STREETS.indexOf(s.street) >= STREETS.indexOf(p.street) && p.status === 'playing'));
      if (sameHand && p.hand !== null) {
        if (STREETS.indexOf(s.street) < STREETS.indexOf(p.street)) bad('contradiction', 'Street regressed ' + p.street + ' -> ' + s.street);
        if (p.board.some((c, i) => s.board[i] !== c)) bad('contradiction', 'Board cards changed within a hand');
        if (p.button !== s.button) bad('contradiction', 'Dealer button moved within a hand');
        for (let i = 0; i < this.seats; i++) {
          const a = p.seats[i], b = s.seats[i];
          if (a.folded && !b.folded) bad('contradiction', 'Seat ' + i + ' unfolded');
          if (a.inHand === false && b.inHand !== false) bad('contradiction', 'Seat ' + i + ' was not dealt in but takes part within the same hand');
          if (a.total !== null && b.total !== null && s.status === 'playing') {
            if (b.total < a.total) bad('contradiction', 'Seat ' + i + ' committed chips decreased');
            if (p.status === 'playing' && a.stack + a.total !== b.stack + b.total && s.status === 'playing') bad('inconsistent-stacks', 'Seat ' + i + ' chips changed outside betting');
          }
          if (a.cards && b.cards && (a.cards[0] !== b.cards[0] || a.cards[1] !== b.cards[1])) bad('contradiction', 'Seat ' + i + ' hole cards changed');
        }
        if (p.actions && s.actions) {
          if (s.actions.length < p.actions.length) bad('incomplete-history', 'Action history shortened');
          else for (let i = 0; i < p.actions.length; i++) {
            if (p.actions[i].seat !== s.actions[i].seat || p.actions[i].type !== s.actions[i].type) { bad('incomplete-history', 'Action history rewritten at step ' + i); break; }
          }
        }
      }
      if (!issues.length) s.legal = legalFrom(s);
    }

    /**
     * 0.36.2 M3: why the tracker is (not) following the table, for the dashboard and diagnostics.
     *   status: tracking | verifying | untracked-hand | refusing | waiting-for-first-reading | tournament-complete
     */
    trackingStatus() {
      const ut = this.tr.untracked, T = this.tour, end = T.complete || T.observedEnd, lastRej = this.rejections[this.rejections.length - 1];
      const base = { lastValidHand: this.tr.lastValidHand, recoveries: this.tr.recoveries, untrackedHands: this.tr.untrackedHands, lastRecovery: this.tr.lastRecovery, accepted: this.accepted, rejected: this.rejected, paused: this.paused };
      if (end) return { ...base, status: 'tournament-complete', reasonCode: 'tournament-complete', reason: 'Seat ' + end.winner + ' holds every chip after hand ' + end.hand + ' (' + end.source + ').', observedHand: end.hand, expectedRecovery: null };
      if (ut) return { ...base, status: 'untracked-hand', reasonCode: ut.code, reason: ut.reason, observedHand: ut.hand, refusedFrames: ut.frames, expectedRecovery: 'the opening reading of hand ' + (ut.hand + 1) + ' or a later hand (preflop, no board, nobody has acted, blinds and antes posted by the players dealt in) - then ' + this.opt.autoResumeAfter + ' consistent readings' };
      if (this.paused && this.goodStreak > 0) return { ...base, status: 'verifying', reasonCode: 'verifying', reason: 'Waiting for ' + (this.opt.autoResumeAfter - this.goodStreak) + ' more consistent reading(s) before the state is used' + (this.tr.lastRecovery && this.tr.lastRecovery.toHand === this.tr.hand ? ' (recovered at hand ' + this.tr.hand + ')' : ''), observedHand: this.tr.hand, expectedRecovery: (this.opt.autoResumeAfter - this.goodStreak) + ' more consistent reading(s)' };
      if (this.paused && lastRej) { const i = lastRej.issues[0]; return { ...base, status: 'refusing', reasonCode: i.code, reason: i.detail, observedHand: this.tr.hand, contradictionFrames: this.tr.contradiction ? this.tr.contradiction.frames : 0, expectedRecovery: 'a reading consistent with the reconstructed hand (after ' + this.opt.maxContradictionFrames + ' contradicting readings the hand is treated as untracked)' }; }
      if (this.paused) return { ...base, status: 'verifying', reasonCode: 'verifying', reason: this.pauseReason || 'paused', observedHand: this.tr.hand, expectedRecovery: this.opt.autoResumeAfter + ' consistent readings' };
      if (!this.last) return { ...base, status: 'waiting-for-first-reading', reasonCode: null, reason: 'No reading accepted yet', observedHand: null, expectedRecovery: null };
      return { ...base, status: 'tracking', reasonCode: null, reason: null, observedHand: this.tr.hand !== null ? this.tr.hand : this.last.hand, expectedRecovery: null };
    }
    /** 0.36.2 M3: the tournament seating model (what the tracker has VERIFIED about who is still in the tournament). */
    tournamentStatus() {
      const T = this.tour, lo = T.lastOpening;
      const remaining = lo ? lo.participants.length : null, funded = T.lastSettled ? T.lastSettled.stacks.filter((s) => s > 0).length : null;
      return { mode: T.mode, handsOpened: T.handsOpened, handsSettled: T.handsSettled, remaining: funded !== null && (!lo || T.lastSettled.hand >= lo.hand) ? funded : remaining,
        dealtInLastHand: lo ? lo.participants.slice() : null, eliminated: T.seats.map((s, i) => (s.status === SEAT_STATUS.ELIMINATED ? { seat: i, afterHand: s.eliminatedAfterHand } : null)).filter(Boolean),
        seats: T.seats.map((s) => s.status), headsUp: T.headsUpSince !== null, headsUpSince: T.headsUpSince, complete: T.complete || T.observedEnd || null, lastSettledHand: T.lastSettled ? T.lastSettled.hand : null,
        lastButton: lo ? lo.button : null, continuity: lo ? lo.continuity : null, stackResets: T.stackResets, events: T.events.slice(-20), eliminations: T.eliminations.slice() };
    }
  }

  /** Reference structured feed: simulator table -> observation. Optional corruption hooks for tests. */
  function observeSimulator(table, seq, options = {}) {
    const t = table, snap = t.snapshot();
    const fields = { board: 1, pot: 1, stacks: 1, button: 1, actor: 1, street: 1 };
    const obs = {
      format: 'eightmax-observation', version: 1, table: t.id, seq, source: options.source || 'structured-feed',
      capturedAt: options.now === undefined ? 0 : options.now, layout: { id: 'eightmax-' + t.seats + 'max-v1', seats: t.seats },
      hand: t.hand, simRevision: t.revision, status: t.status === 'complete' ? 'complete' : 'playing', street: t.street,
      board: snap.board.slice(), button: t.dealer, actor: t.actor, pot: snap.pot, currentBet: t.currentBet, lastRaise: t.lastRaise,
      seats: snap.players.map((p, i) => ({
        seat: i, stack: p.stack, bet: p.bet, total: p.total, folded: p.folded,
        cards: options.revealCards === false ? null : p.cards.slice(),
      })),
      actions: options.actions === undefined ? undefined : options.actions,
      confidence: { overall: 1, fields },
    };
    return obs;
  }

  return { SEATS, SB, BB, ANTE, START_POT, STREETS, BOARD_LEN, DEFAULTS, SEAT_STATUS, UNTRACKED_CODES, UNREADABLE_CODES, HandStateEngine, observeSimulator, stateKey, legalFrom, cardToString, cardFromString, screenSeatStatus };
});
