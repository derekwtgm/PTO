/* EightMax Test Workbench 0.24: hand ledger — an independent Texas Hold'em betting-rules engine.
 *
 * Replays a hand action by action from its starting stacks and answers: who acts, what is legal, how much
 * is in the pot, which side pots exist, what must be refunded, and whether a final set of stacks is a
 * feasible settlement. It is written separately from the simulator in engine.js and is differentially
 * tested against it, so each can catch the other's mistakes. Units are chips (100 chips = 1 BB by default).
 * Nothing here guesses: an action that is not legal throws, and a state that cannot be explained is
 * reported as such by the caller (hand-state.js).
 *
 * 0.36.2 Milestone 3 - tournament participation. A seat is either DEALT IN (it takes part in this hand) or NOT DEALT IN
 * (an ELIMINATED tournament player with no chips, or a player SITTING OUT with chips). Every rule below follows the bundled
 * simulator (engine.js Table.startHand) exactly:
 *   - only dealt-in seats post antes; a stack shorter than the ante posts all it has;
 *   - the button moves to the next dealt-in seat (moving button: it never rests on an empty or eliminated seat);
 *   - with three or more players dealt in, the small blind is the first dealt-in seat after the button and the big blind the
 *     next dealt-in seat after the small blind (eliminated seats are skipped); heads-up, the button posts the small blind;
 *   - a blind shorter than its amount posts all the player has (all-in); the amount to call preflop is still the full big
 *     blind (a short big blind does not lower it) and the minimum raise is one big blind;
 *   - a player put all-in by the forced bets does not act; when nobody can still act the board runs out.
 * Until 0.36.2 Milestone 2 every seat had to have a positive stack and paid an ante, and the blinds sat at fixed offsets from
 * the button, so a hand that began with eliminated players could not be represented at all (see REPORT-0.36.2-Milestone-3.md).
 * Seat state is explicit: `inHand` (dealt in) and `folded` (folded in THIS hand) are separate facts; `outReason` says why a
 * seat is not dealt in. Serialization: version 1 is unchanged for hands in which every seat is dealt in; a hand with a seat
 * that is not dealt in is written as version 2. fromJSON reads both.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.WorkbenchLedger = factory(root.EightMax);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (EM) {
  'use strict';

  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const ok = (x, m) => { if (!x) throw new Error(m); };
  const isInt = Number.isSafeInteger;
  /** Why a seat is not dealt in. */
  const OUT = Object.freeze({ ELIMINATED: 'eliminated', SITTING_OUT: 'sitting-out' });

  /**
   * The forced bets of a hand, computed from the stacks BEFORE antes and blinds (0 = eliminated) without building a ledger.
   * Returns { participants, button, sbSeat, bbSeat, headsUp, antes[], blinds[], contributions[], openingPot, currentBet, firstToAct }
   * or throws with the reason the configuration cannot start a hand. Used by hand-state.js to explain an opening position.
   */
  function forcedBets(cfg) {
    const l = new HandLedger(cfg);
    return { participants: l.participants.slice(), button: l.button, sbSeat: l.sbSeat, bbSeat: l.bbSeat, headsUp: l.participants.length === 2,
      antes: l.p.map((q) => q.antePaid), blinds: l.p.map((q) => q.bet), contributions: l.p.map((q) => q.total), openingPot: l.pot, currentBet: l.currentBet, firstToAct: l.actor, status: l.status };
  }

  class HandLedger {
    /**
     * cfg: {seats (2..8), button, stacks (chips behind BEFORE antes/blinds; 0 = eliminated, not dealt in), sb, bb, ante,
     *       sittingOut (optional seat numbers that have chips but are not dealt in)}
     */
    constructor(cfg) {
      const n = cfg.seats === undefined ? 8 : cfg.seats;
      ok(isInt(n) && n >= 2 && n <= 8, 'Seats must be 2 to 8');
      ok(isInt(cfg.button) && cfg.button >= 0 && cfg.button < n, 'Button out of range');
      ok(Array.isArray(cfg.stacks) && cfg.stacks.length === n && cfg.stacks.every((s) => isInt(s) && s >= 0), 'Every seat needs a starting stack of zero or more whole chips');
      const sitting = new Set(Array.isArray(cfg.sittingOut) ? cfg.sittingOut : []);
      ok([...sitting].every((s) => isInt(s) && s >= 0 && s < n), 'Sitting-out seat out of range');
      this.n = n; this.button = cfg.button; this.sb = cfg.sb === undefined ? 50 : cfg.sb; this.bb = cfg.bb === undefined ? 100 : cfg.bb; this.ante = cfg.ante === undefined ? 10 : cfg.ante;
      ok(isInt(this.sb) && isInt(this.bb) && isInt(this.ante) && this.sb > 0 && this.bb >= this.sb && this.ante >= 0, 'Blind structure invalid');
      this.start = cfg.stacks.slice();
      this.p = cfg.stacks.map((s, i) => {
        const inHand = s > 0 && !sitting.has(i);
        return { stack: s, bet: 0, total: 0, folded: false, facing: null, needs: false, inHand, outReason: inHand ? null : (s > 0 ? OUT.SITTING_OUT : OUT.ELIMINATED), antePaid: 0 };
      });
      this.participants = this.p.map((q, i) => (q.inHand ? i : -1)).filter((i) => i >= 0);
      ok(this.participants.length >= 2, 'At least two seats must be dealt in (seats with chips that are not sitting out); found ' + this.participants.length);
      ok(this.p[this.button].inHand, 'The dealer button is on seat ' + this.button + ', which is not dealt in (' + this.p[this.button].outReason + '); the button only rests on a seat that is dealt in');
      this.board = []; this.street = 0; this.history = []; this.status = 'betting'; this.currentBet = this.bb; this.raiseSize = this.bb; this.awards = null;
      for (const i of this.participants) this.p[i].antePaid = this._pay(i, this.ante, false);
      const dealt = (q) => q.inHand;
      this.sbSeat = this.participants.length === 2 ? this.button : this._next(this.button, dealt); this.bbSeat = this._next(this.sbSeat, dealt);
      this._pay(this.sbSeat, this.sb, true); this._pay(this.bbSeat, this.bb, true);
      // The amount to call preflop is the full big blind even when the big blind is short (engine.js sets currentBet = bb).
      this.currentBet = Math.max(this.bb, ...this.p.map((q) => q.bet));
      this.p.forEach((q) => { q.needs = q.inHand; });
      this.actor = this._next(this.bbSeat, (q) => q.needs);
      this._settleTurnOrder(this.bbSeat);
    }
    clone() { const c = Object.create(HandLedger.prototype); Object.assign(c, this); c.p = this.p.map((q) => ({ ...q })); c.board = this.board.slice(); c.history = this.history.map((h) => ({ ...h })); c.start = this.start.slice(); c.participants = this.participants.slice(); c.awards = this.awards ? this.awards.slice() : null; return c; }

    _pay(i, amount, street) { const q = this.p[i], v = Math.min(amount, q.stack); q.stack -= v; q.total += v; if (street) q.bet += v; return v; }
    _next(from, pred) { for (let k = 1; k <= this.n; k++) { const i = (from + k) % this.n; if (pred(this.p[i], i)) return i; } return -1; }
    /** Dealt in and not folded: still contesting the pot. (`inHand !== false` keeps version-1 data, which has no inHand field, dealt in.) */
    _contesting(q) { return q.inHand !== false && !q.folded; }
    get pot() { return this.p.reduce((a, q) => a + q.total, 0); }
    get live() { return this.p.map((q, i) => i).filter((i) => this._contesting(this.p[i])); }
    get streetName() { return STREETS[this.street]; }
    get headsUp() { return this.participants.length === 2; }
    _able() { return this.live.filter((i) => this.p[i].stack > 0); }
    /** Seat status in this hand: active | folded | all-in | eliminated | sitting-out. */
    seatStatus(i) { const q = this.p[i]; if (q.inHand === false) return q.outReason || OUT.ELIMINATED; if (q.folded) return 'folded'; return q.stack === 0 ? 'all-in' : 'active'; }
    /** How the bundled simulator DISPLAYS a seat: a seat that is not dealt in shows the folded marker (engine.js sets folded = stack === 0). */
    displayFolded(i) { const q = this.p[i]; return q.inHand === false || q.folded; }

    /** Legal actions for `seat` (default: the player to act) or null when nobody may act. */
    legal(seat = this.actor) {
      if (this.status !== 'betting' || seat !== this.actor || seat < 0) return null;
      const q = this.p[seat], toCall = Math.max(0, this.currentBet - q.bet), max = q.bet + q.stack;
      const reopen = q.facing === null || this.currentBet - q.facing >= this.raiseSize;
      const respond = this.p.some((o, i) => i !== seat && this._contesting(o) && o.stack > 0);
      const canRaise = reopen && respond && max > this.currentBet;
      return { seat, toCall, callAmount: Math.min(toCall, q.stack), canCheck: toCall === 0, canFold: toCall > 0, canCall: toCall > 0, canRaise, minRaiseTo: Math.min(max, this.currentBet + this.raiseSize), fullMinRaiseTo: this.currentBet + this.raiseSize, maxRaiseTo: max, raiseSize: this.raiseSize, reopened: reopen };
    }

    /** Apply one action. type: fold | check | call | raise (amount = total wager TO, i.e. the new bet for the street). Throws on any illegal action. */
    apply(act) {
      ok(this.status === 'betting', 'No betting is open (' + this.status + ')');
      ok(act && act.seat === this.actor, 'Seat ' + (act && act.seat) + ' is not the player to act (' + this.actor + ')');
      const l = this.legal(), q = this.p[act.seat], seat = act.seat;
      let entry;
      switch (act.type) {
        case 'fold': ok(l.canFold, 'Folding is not offered when there is nothing to call'); q.folded = true; entry = { seat, type: 'fold', amount: 0, to: q.bet }; break;
        case 'check': ok(l.canCheck, 'Cannot check facing a wager'); entry = { seat, type: 'check', amount: 0, to: q.bet }; break;
        case 'call': { ok(l.canCall, 'Nothing to call'); const paid = this._pay(seat, l.callAmount, true); entry = { seat, type: 'call', amount: paid, to: q.bet, allIn: q.stack === 0 }; break; }
        case 'raise': {
          ok(l.canRaise, 'Raise is not available (not reopened, no chips, or nobody can respond)');
          const to = act.amount; ok(isInt(to) && to > this.currentBet && to <= l.maxRaiseTo, 'Raise to ' + to + ' is outside (' + this.currentBet + ', ' + l.maxRaiseTo + ']');
          ok(to >= l.fullMinRaiseTo || to === l.maxRaiseTo, 'Raise to ' + to + ' is below the minimum ' + l.fullMinRaiseTo + ' and is not all-in');
          const old = this.currentBet, add = this._pay(seat, to - q.bet, true); this.currentBet = to;
          const full = to - old >= this.raiseSize;
          if (full) { this.raiseSize = to - old; this.p.forEach((o, i) => { if (i !== seat && this._contesting(o) && o.stack > 0) o.needs = true; }); }
          else this.p.forEach((o, i) => { if (i !== seat && this._contesting(o) && o.stack > 0 && o.bet < this.currentBet) o.needs = true; });
          entry = { seat, type: 'raise', amount: add, to, allIn: q.stack === 0, full };
          break;
        }
        default: throw new Error('Unknown action type ' + act.type);
      }
      q.needs = false; q.facing = this.currentBet;
      entry.street = this.streetName; this.history.push(entry);
      this._settleTurnOrder(seat);
      return entry;
    }

    /** After an action (or the deal): decide whether betting continues, a board card is needed, or the hand ended. */
    _settleTurnOrder(after) {
      if (this.live.length === 1) { this.status = 'complete'; this.actor = -1; this.awards = null; this.outcome = 'fold'; return; }
      this.p.forEach((q) => { if (!this._contesting(q) || q.stack === 0) q.needs = false; });
      const able = this._able();
      if (able.length <= 1 && able.every((i) => this.p[i].bet >= this.currentBet)) this.p.forEach((q) => { q.needs = false; });
      const nxt = this._next(after, (q) => q.needs);
      if (nxt >= 0) { this.actor = nxt; this.status = 'betting'; return; }
      this.actor = -1;
      this.status = this.street === 3 ? 'showdown' : 'awaiting-board';
    }

    /** Provide board cards. Allowed only when a street's betting has closed. Several streets may be supplied at once ONLY if no betting is possible between them (all-in runout). */
    dealBoard(cards) {
      const backup = this.clone(); // all-or-nothing: a rejected deal must leave the ledger untouched
      try { return this._dealBoard(cards); } catch (e) { Object.assign(this, backup); throw e; }
    }
    _dealBoard(cards) {
      ok(Array.isArray(cards) && cards.every((c) => isInt(c) && c >= 0 && c < 52), 'Invalid board cards');
      ok(this.status === 'awaiting-board', 'Board cannot be dealt now (' + this.status + ')');
      const seen = new Set(this.board); let i = 0;
      while (i < cards.length) {
        ok(this.status === 'awaiting-board', 'Cards were dealt past a street that still has betting');
        const need = this.street === 0 ? 3 : 1; ok(cards.length - i >= need, 'Partial street dealt');
        for (let k = 0; k < need; k++) { const c = cards[i + k]; ok(!seen.has(c), 'Duplicate board card'); seen.add(c); this.board.push(c); }
        i += need; this.street++;
        this.p.forEach((q) => { q.bet = 0; q.facing = null; }); this.currentBet = 0; this.raiseSize = this.bb;
        const able = this._able(); this.p.forEach((q) => { q.needs = this._contesting(q) && q.stack > 0; });
        if (able.length <= 1) { this.p.forEach((q) => { q.needs = false; }); this.status = this.street === 3 ? 'showdown' : 'awaiting-board'; this.actor = -1; }
        else { this.actor = this._next(this.button, (q) => q.needs); this.status = 'betting'; }
      }
      ok(this.street <= 3, 'Too many board cards');
      return this.status;
    }
    /** True when the board must still be dealt before showdown, with no betting possible (everyone left is all-in or only one can act). */
    get needsRunout() { return this.status === 'awaiting-board' || (this.status === 'showdown' && this.board.length < 5); }

    /** Side pots from total contributions (antes included). The topmost level with one contributor is an uncalled amount and is refunded, not contested. */
    pots(opt = {}) {
      const merge = opt.merge !== false;
      const totals = this.p.map((q) => q.total), levels = [...new Set(totals.filter((t) => t > 0))].sort((a, b) => a - b);
      const pots = [], refunds = []; let prev = 0;
      for (const lv of levels) {
        const contrib = totals.map((t, i) => i).filter((i) => totals[i] >= lv), amount = (lv - prev) * contrib.length, eligible = contrib.filter((i) => this._contesting(this.p[i]));
        if (contrib.length === 1) { refunds.push({ seat: contrib[0], amount }); prev = lv; continue; }
        if (!eligible.length) { // a level contributed only by folded players cannot occur in a legal hand; merge into the previous pot to stay chip-conserving
          if (pots.length) pots[pots.length - 1].amount += amount; else throw new Error('Dead money with no eligible player'); prev = lv; continue; }
        const last = pots[pots.length - 1];
        if (merge && last && last.eligible.join() === eligible.join()) last.amount += amount; else pots.push({ amount, eligible, contributors: contrib, level: lv });
        prev = lv;
      }
      return { pots, refunds };
    }

    /** Award every pot to the best hand among its eligible players. hole: {seat: [c,c]}. Odd chips go to the first winner(s) clockwise from the button, per pot. `perLevelOddChips` mirrors the simulator, which splits odd chips per contribution level rather than per merged pot (differs only in rare odd-chip cases). */
    showdown(hole, opt = {}) {
      ok(this.status === 'showdown' && this.board.length === 5 || this.live.length === 1, 'Showdown needs a complete board');
      const aw = new Array(this.n).fill(0), { pots, refunds } = this.pots({ merge: !opt.perLevelOddChips });
      for (const r of refunds) aw[r.seat] += r.amount;
      for (const pot of pots) {
        let winners = pot.eligible;
        if (winners.length > 1) { ok(winners.every((i) => hole[i] && hole[i].length === 2), 'Hole cards missing for a showdown player'); const ranks = winners.map((i) => EM.evaluate(hole[i].concat(this.board))), best = Math.max(...ranks); winners = winners.filter((_, j) => ranks[j] === best); }
        winners = winners.slice().sort((a, b) => ((a - this.button - 1 + this.n) % this.n) - ((b - this.button - 1 + this.n) % this.n));
        const share = Math.floor(pot.amount / winners.length), odd = pot.amount % winners.length;
        winners.forEach((w, j) => { aw[w] += share + (j < odd ? 1 : 0); });
      }
      if (this.live.length === 1) { aw.fill(0); aw[this.live[0]] = this.pot; }
      this.awards = aw; this.status = 'complete'; this.outcome = 'showdown';
      return aw;
    }

    /**
     * Without hole cards (the usual case when reconstructing from a screen): is `finalStacks` a feasible settlement?
     * Necessary conditions: chips conserved, folded players win nothing, nobody wins more than the pots they are eligible for
     * (plus their own refund), the sole survivor of a fold-out takes everything, and each pot's winners are consistent.
     * 0.36.2 M3: a seat that was not dealt in neither pays nor wins anything; its stack must be unchanged.
     */
    checkSettlement(finalStacks) {
      const reasons = [];
      if (!Array.isArray(finalStacks) || finalStacks.length !== this.n || !finalStacks.every((s) => isInt(s) && s >= 0)) return { ok: false, reasons: ['Final stacks missing or invalid'] };
      const startTotal = this.p.reduce((a, q) => a + q.stack + q.total, 0), endTotal = finalStacks.reduce((a, b) => a + b, 0);
      if (startTotal !== endTotal) reasons.push('Chips not conserved: ' + startTotal + ' before, ' + endTotal + ' after');
      const gain = finalStacks.map((s, i) => s - this.p[i].stack); // award received this hand
      if (gain.some((g) => g < 0)) reasons.push('A stack decreased during settlement');
      this.p.forEach((q, i) => { if (q.inHand === false && gain[i] !== 0) reasons.push('Seat ' + i + ' was not dealt in (' + q.outReason + ') but its stack changed by ' + gain[i]); });
      if (this.live.length === 1) {
        const w = this.live[0], exp = this.pot;
        if (gain[w] !== exp) reasons.push('Sole survivor seat ' + w + ' should receive ' + exp + ', received ' + gain[w]);
        gain.forEach((g, i) => { if (i !== w && g !== 0 && this.p[i].inHand !== false) reasons.push('Seat ' + i + ' folded but received ' + g); });
      } else {
        const { pots, refunds } = this.pots(), cap = new Array(this.n).fill(0);
        for (const r of refunds) cap[r.seat] += r.amount;
        for (const pot of pots) for (const i of pot.eligible) cap[i] += pot.amount;
        gain.forEach((g, i) => { if (this.p[i].inHand === false) return; if (this.p[i].folded && g > 0) reasons.push('Folded seat ' + i + ' received ' + g); else if (g > cap[i]) reasons.push('Seat ' + i + ' received ' + g + ' but is eligible for at most ' + cap[i]); });
        for (const r of refunds) if (gain[r.seat] < r.amount) reasons.push('Uncalled amount ' + r.amount + ' was not returned to seat ' + r.seat);
        // every contested pot must be fully paid out to eligible players: total awards equal the pot (already implied by conservation)
      }
      // 0.36.2 M3: who has chips after this hand (tournament seating for the next hand)
      const funded = finalStacks.map((s, i) => (s > 0 ? i : -1)).filter((i) => i >= 0);
      return { ok: reasons.length === 0, reasons, awards: gain, funded, eliminated: this.participants.filter((i) => finalStacks[i] === 0) };
    }

    /** Plain-JSON form (checkpoint / restart) and its validated inverse. Version 1 when every seat is dealt in (unchanged format), version 2 otherwise. */
    toJSON() {
      const out = this.p.some((q) => q.inHand === false);
      const j = { format: 'eightmax-hand-ledger', version: out ? 2 : 1, n: this.n, button: this.button, sb: this.sb, bb: this.bb, ante: this.ante, start: this.start.slice(), p: this.p.map((q) => ({ ...q })), board: this.board.slice(), street: this.street, history: this.history.map((h) => ({ ...h })), status: this.status, currentBet: this.currentBet, raiseSize: this.raiseSize, actor: this.actor, sbSeat: this.sbSeat, bbSeat: this.bbSeat, outcome: this.outcome || null };
      if (out) j.sittingOut = this.p.map((q, i) => (q.inHand === false && q.outReason === OUT.SITTING_OUT ? i : -1)).filter((i) => i >= 0);
      return j;
    }
    static fromJSON(j) {
      ok(j && j.format === 'eightmax-hand-ledger' && (j.version === 1 || j.version === 2), 'Not a hand-ledger checkpoint');
      if (j.version === 1) ok(Array.isArray(j.start) && j.start.every((s) => isInt(s) && s > 0), 'Version-1 ledger checkpoints have a positive stack for every seat');
      const l = new HandLedger({ seats: j.n, button: j.button, stacks: j.start, sb: j.sb, bb: j.bb, ante: j.ante, sittingOut: j.version === 2 ? j.sittingOut : undefined });
      ok(Array.isArray(j.p) && j.p.length === l.n, 'Ledger checkpoint seat list invalid');
      const derived = l.p.map((q) => ({ inHand: q.inHand, outReason: q.outReason, antePaid: q.antePaid }));
      l.p = j.p.map((q, i) => ({ ...q, inHand: derived[i].inHand, outReason: derived[i].outReason, antePaid: q.antePaid === undefined ? derived[i].antePaid : q.antePaid }));
      l.board = j.board.slice(); l.street = j.street; l.history = j.history.map((h) => ({ ...h })); l.status = j.status; l.currentBet = j.currentBet; l.raiseSize = j.raiseSize; l.actor = j.actor; l.outcome = j.outcome || undefined;
      const total = l.p.reduce((a, q) => a + q.stack + q.total, 0); ok(total === j.start.reduce((a, b) => a + b, 0), 'Ledger checkpoint does not conserve chips');
      ok(l.p.every((q, i) => q.inHand || (q.total === 0 && q.stack === j.start[i] && !q.needs)), 'Ledger checkpoint: a seat that is not dealt in has chips in the pot or is waiting to act');
      return l;
    }
    /** Observable projection used to compare with a screen reading. */
    project() { return { street: this.streetName, board: this.board.slice(), actor: this.actor, status: this.status, pot: this.pot, currentBet: this.currentBet, seats: this.p.map((q, i) => ({ stack: q.stack, bet: q.bet, total: q.total, folded: q.folded, inHand: q.inHand !== false, status: this.seatStatus(i) })) }; }
  }

  return { HandLedger, STREETS, OUT, forcedBets };
});
