/* EightMax Test Workbench 0.35.0: the DEALER of the controlled Windows test table (desktop/bin/EightMaxTestTable.exe).
 *
 * Runs in its own process (tools/test-table-035.cjs). It owns the game - an EightMax engine table - renders each frame with the
 * controlled-renderer pixels (src/sim-display.js) plus the status strip, tells the window which buttons are enabled, and
 * applies the actions the window reports. It also keeps the ORACLE: every mouse press/release, key, button press, accepted and
 * refused action, with the engine state after each. The oracle is read by the acceptance tools only AFTER actions, to grade
 * recognition and input; the Workbench's decision path never reads it.
 * The view rotates to the seat that must act (each seat's cards are visible only in its own view), so every state change on the
 * table is caused by one input from the Workbench - exactly what action confirmation expects.
 * 0.36.2 M3: optional ACTION CLOCK (actionTimeoutMs, default 0 = off, as before): like a real client's time bank, a player who does not
 * act in time is checked (or folded when facing a bet) by the table itself. Recorded in the oracle as 'timeout-action' and counted apart
 * from the Workbench's actions; used to test recovery from an untracked hand, which on a table without a clock would never end.
 * 0.36.2 M3.2: the oracle also records every frame the WINDOW reports as shown ('shown', with the window's own frame revision) and the
 * window's own clock (wt, Environment.TickCount) on presses, releases, keys and actions, so an input that was not confirmed can be traced
 * end to end (did the window get the press? on which frame? did its button fire? did the dealer accept it? when was the next frame shown?).
 * Test control dropNextAction(n): the next n button actions the window reports are recorded ('dropped-by-test') but NOT applied - a
 * simulator that ignores a click, which is how the T5 acceptance reproduces the operator's unconfirmed Call deterministically.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./sim-display.js'), require('./image-codec.js'), require('./status-strip.js'));
  else root.WorkbenchFixtureDealer = factory(root.EightMax, root.WorkbenchSimDisplay, root.WorkbenchImageCodec, root.WorkbenchStatusStrip);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (EM, SIM, IC, SS) {
  'use strict';
  const CONTROLS = Object.freeze({ fold: { x: 0.6, y: 0.93, w: 0.1, h: 0.05 }, check: { x: 0.72, y: 0.93, w: 0.1, h: 0.05 }, call: { x: 0.84, y: 0.93, w: 0.07, h: 0.05 }, raise: { x: 0.92, y: 0.93, w: 0.07, h: 0.05 }, allin: { x: 0.6, y: 0.87, w: 0.1, h: 0.05 } });
  const WAGER_FIELD = Object.freeze({ x: 0.42, y: 0.93, w: 0.15, h: 0.05 });
  const CONVENTIONS = Object.freeze(['raise-to', 'raise-by']);

  class TableDealer {
    /** o: table (1..10), seed, convention, handGapMs, maxHands, now(), send(msg) -> to the window, record(event) -> oracle sink */
    constructor(o) {
      this.id = o.table; this.t = new EM.Table(o.table, o.seed || o.table * 7919, 8, {persistentStacks:o.tournament!==false,blinds:o.blinds}); this.convention = o.convention || 'raise-to'; if (!CONVENTIONS.includes(this.convention)) throw new Error('Unknown wager convention');
      this.gap = o.handGapMs === undefined ? 600 : o.handGapMs; this.turnDelay = o.turnDelayMs || 0; this.holdUntil = 0; this.holdTimer = null; this.actionTimeout = o.actionTimeoutMs || 0; this.actionTimeoutUntilHand = o.actionTimeoutUntilHand === undefined ? Infinity : o.actionTimeoutUntilHand; this.actTimer = null; this.maxHands = o.maxHands || Infinity; this.now = o.now || Date.now; this.send = o.send; this.record = o.record || (() => {});
      this.rev = 0; this.view = 0; this.w = 0; this.h = 0; this.timer = null; this.closed = false; this.hands = 0;
      this.counts = { mouseDown: 0, mouseUp: 0, downOutsideControls: 0, downOnDisabled: 0, doubleClicks: 0, rightClicks: 0, keys: 0, actions: 0, accepted: 0, staleClicks: 0, illegal: 0, wagerRejected: 0, byType: {}, timeoutActions: 0 };
      this.accepted = []; if(o.stacks)this.t.setNextStacks(o.stacks);
      this.counts.droppedByTest = 0; this.dropNext = 0; this.lastShown = null;   // 0.36.2 M3.2
      // 0.36.2 M4.0 test fixture: heroSeats = the seats played through the window; every other seat is played by the dealer itself after
      // botThinkMs (a deterministic scripted policy, seeded per table) - the realistic one-player-per-table workload for capacity tests.
      // Without heroSeats every seat is played through the window (the Milestone 3 stress workload, unchanged).
      this.heroSeats = Array.isArray(o.heroSeats) && o.heroSeats.length ? o.heroSeats.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < 8) : null;
      this.botThinkMs = Number.isFinite(o.botThinkMs) && o.botThinkMs >= 50 ? o.botThinkMs : 800; this.botTimer = null; this.botRng = new EM.RNG(((o.seed || o.table * 7919) * 2654435761) >>> 0 || 1); this.counts.botActions = 0;
    }
    get playing() { return this.t.status === 'playing'; }
    get holding() { return this.turnDelay > 0 && this.now() < this.holdUntil; }
    /** 0.36.2 M4.0: is this seat played through the window? (every seat without heroSeats) */
    isHero(seat) { return !this.heroSeats || this.heroSeats.includes(seat); }
    legal() {
      const l = this.playing && !this.holding && this.isHero(this.t.actor) ? this.t.legal() : null; if (!l) return { fold: false, check: false, call: false, raise: false, allin: false };
      return { fold: l.toCall > 0, check: l.canCheck, call: l.toCall > 0, raise: l.canRaise, allin: l.canRaise || l.toCall > 0 };
    }
    /** The image the window shows (RGBA), at the window's current client size. */
    frame() {
      // While the other players "think" (turn delay) the table shows no action controls and the view stays put.
      if (this.heroSeats) { const dealtHero = this.heroSeats.find((i) => this.t.players[i] && this.t.players[i].cards && this.t.players[i].cards.length === 2); this.view = dealtHero !== undefined ? dealtHero : this.heroSeats[0]; }   // 0.36.2 M4.0
      else if (this.playing && this.t.actor >= 0 && !this.holding) this.view = this.t.actor;
      // 0.36.2 M3: the window always shows the table from a seat DEALT IN to the current hand. A hand in which nobody has to act (every
      // remaining player all-in from the blinds and antes) kept the previous view - possibly a seat eliminated in the hand before, which
      // holds no cards, so no frame of that hand could be read and the end of the tournament was never seen (found when the Linux
      // self-check dealt the Windows run's hands at 800 px). The next dealt-in seat clockwise is shown instead.
      const dealt = (i) => !!(this.t.players[i] && this.t.players[i].cards && this.t.players[i].cards.length === 2), n = this.t.players.length;
      if (this.t.hand > 0 && !dealt(this.view)) for (let k = 1; k < n; k++) { const i = (this.view + k) % n; if (dealt(i)) { this.view = i; break; } }
      const img = SIM.renderTable(this.t, this.w, { v2: true, heroSeat: this.view, hideControls: this.holding || this.t.actor !== this.view });
      if (img.height !== this.h) { /* the window keeps 1.6:1; a 1 px rounding difference is padded/cropped */ const out = { width: this.w, height: this.h, data: new Uint8ClampedArray(this.w * this.h * 4) }; for (let y = 0; y < this.h; y++) { const sy = Math.min(img.height - 1, y); out.data.set(img.data.subarray(sy * this.w * 4, (sy + 1) * this.w * 4), y * this.w * 4); } SS.draw(out, { table: this.id, viewSeat: this.view, playing: this.playing, revision: this.rev }); return out; }
      return SS.draw(img, { table: this.id, viewSeat: this.view, playing: this.playing, revision: this.rev });
    }
    push(extra = {}) {
      if (this.closed || !this.w) return; const img = this.frame(), png = IC.encodePng(img);
      this.send({ type: 'frame', rev: this.rev, w: img.width, h: img.height, png: Buffer.from(png).toString('base64'), legal: this.legal(), title: ' · hand ' + this.t.hand, ...extra });
    }
    snapshot() { const t = this.t; return { dealer:t.dealer, sb:t.sb, bb:t.bb, tournamentComplete:t.tournamentComplete, eliminated:t.players.map((p,i)=>p.stack===0&&t.status==='complete'?i:null).filter(i=>i!==null), awards:t.awards, bankroll:t.bankroll, hand: t.hand, status: t.status, street: t.street, actor: t.actor, revision: t.revision, currentBet: t.currentBet, pot: t.pot(), stacks: t.players.map((p) => p.stack), bets: t.players.map((p) => p.bet), folded: t.players.map((p) => p.folded) }; }
    start() { if (this.t.status !== 'playing') { if(this.t.startHand()===false){this.record({kind:'tournament-complete',state:this.snapshot()});return false;} this.hands++; this.rev++; this.record({ kind: 'hand-start', rev: this.rev, state: this.snapshot() }); this.scheduleNextHand(); this.armClock(); this.armBot(); } }
    /** 0.36.2 M4.0: a seat the dealer plays acts after botThinkMs (only if nothing changed in between). */
    armBot() {
      clearTimeout(this.botTimer); this.botTimer = null; const t = this.t; if (!this.heroSeats || this.closed || t.status !== 'playing' || !(t.actor >= 0) || this.isHero(t.actor)) return;
      const hand = t.hand, revision = t.revision, actor = t.actor; this.botTimer = setTimeout(() => this.botAct(hand, revision, actor), this.botThinkMs);
    }
    botAct(hand, revision, actor) {
      const t = this.t; this.botTimer = null; if (this.closed || t.status !== 'playing' || t.hand !== hand || t.revision !== revision || t.actor !== actor) return;
      const lg = t.legal(); if (!lg) return; const x = this.botRng.next(); let type = 'fold', amount = 0;
      if (lg.canCheck) { type = x < 0.85 || !lg.canRaise ? 'check' : 'raise'; } else { type = x < 0.6 ? 'call' : x < 0.95 || !lg.canRaise ? 'fold' : 'raise'; }
      if (type === 'raise') amount = Math.min(lg.maxRaiseTo, lg.minRaiseTo);
      try { t.execute(t.request(type, amount, this.now()), this.now()); } catch (e) { this.record({ kind: 'bot-action', hand, seat: actor, type, result: 'engine-refused', reason: e.message }); return; }
      this.counts.botActions++; this.rev++; this.record({ kind: 'bot-action', hand, seat: actor, type, amount: type === 'call' ? lg.callAmount : amount, result: 'applied', rev: this.rev, after: this.snapshot() });
      this.push(); this.scheduleNextHand(); this.armClock(); this.armBot();
    }
    /** 0.36.2 M3 action clock: (re)start the timer of the player to act; it only fires if nobody acted in between. */
    armClock() {
      clearTimeout(this.actTimer); this.actTimer = null; if (!this.actionTimeout || this.closed || this.t.status !== 'playing' || this.t.actor < 0 || this.t.hand > this.actionTimeoutUntilHand) return;
      const hand = this.t.hand, revision = this.t.revision, actor = this.t.actor;
      this.actTimer = setTimeout(() => this.clockExpired(hand, revision, actor), this.actionTimeout + (this.holding ? this.turnDelay : 0));
    }
    clockExpired(hand, revision, actor) {
      const t = this.t; this.actTimer = null;
      if (this.closed || t.status !== 'playing' || t.hand !== hand || t.revision !== revision || t.actor !== actor) return;
      const lg = t.legal(); if (!lg) return; const type = lg.canCheck ? 'check' : 'fold';
      try { t.execute(t.request(type, 0, this.now()), this.now()); } catch (e) { this.record({ kind: 'timeout-action', hand, seat: actor, type, result: 'engine-refused', reason: e.message }); return; }
      this.counts.timeoutActions++; this.rev++; this.record({ kind: 'timeout-action', hand, seat: actor, type, result: 'applied', rev: this.rev, after: this.snapshot() });
      this.push(); this.scheduleNextHand(); this.armClock(); this.armBot();
    }
    /** Messages from the window. */
    onWindow(m) {
      switch (m.type) {
        case 'ready': this.w = m.client.w; this.h = m.client.h; this.record({ kind: 'ready', hwnd: m.hwnd, client: m.client, dpi: m.dpi }); this.start(); this.push(); return;
        case 'resize': if (m.w !== this.w || m.h !== this.h) { this.w = m.w; this.h = m.h; this.rev++; this.record({ kind: 'resize', w: m.w, h: m.h, rev: this.rev }); this.push(); } return;
        case 'moved': this.record({ kind: 'moved', x: m.x, y: m.y }); return;
        case 'minimized': this.record({ kind: 'minimized' }); return;
        case 'shown': this.lastShown = { rev: m.rev, wt: m.t === undefined ? null : m.t }; this.record({ kind: 'shown', rev: m.rev, wt: m.t === undefined ? null : m.t, dealerRev: this.rev }); return;   // 0.36.2 M3.2
        case 'closed': case 'closed-by-user': this.closed = true; clearTimeout(this.timer); clearTimeout(this.holdTimer); clearTimeout(this.actTimer); clearTimeout(this.botTimer); this.record({ kind: m.type }); return;
        case 'key': this.counts.keys++; this.record({ kind: 'key', vk: m.vk, control: m.control, wt: m.t === undefined ? null : m.t }); return;
        case 'mouse-down': case 'mouse-up': case 'double-click': case 'right-down': {
          const down = m.type === 'mouse-down'; if (down) this.counts.mouseDown++; else if (m.type === 'mouse-up') this.counts.mouseUp++; else if (m.type === 'double-click') this.counts.doubleClicks++; else this.counts.rightClicks++;
          const onControl = m.control in CONTROLS || m.control === 'wager'; if (down && !onControl) this.counts.downOutsideControls++; if (down && onControl && m.enabled === false) this.counts.downOnDisabled++;
          this.record({ kind: m.type, x: m.x, y: m.y, control: m.control, enabled: m.enabled, rev: m.rev, wt: m.t === undefined ? null : m.t, dealerRev: this.rev }); return;
        }
        case 'action': return this.onAction(m);
      }
    }
    onAction(m) {
      this.counts.actions++; const t = this.t, ev = { kind: 'action', control: m.control, wager: m.wager, rev: m.rev, wt: m.t === undefined ? null : m.t, dealerRev: this.rev, state: this.snapshot() };
      // 0.36.2 M3.2 test control: received, recorded, NOT applied (the table shows no change, exactly like a simulator that ignored the click)
      if (this.dropNext > 0) { this.dropNext--; this.counts.droppedByTest++; ev.result = 'dropped-by-test'; this.record(ev); return; }
      if (m.rev !== this.rev) { this.counts.staleClicks++; ev.result = 'stale-click'; this.record(ev); return; }   // pressed on an old frame: a duplicate or late click, ignored
      const l = this.legal(); if (!this.playing || !l[m.control]) { this.counts.illegal++; ev.result = 'not-available'; this.record(ev); return; }
      const lg = t.legal(); let type = m.control, amount = 0;
      if (m.control === 'raise') {
        const text = String(m.wager || '').trim();
        if (!/^\d{1,9}$/.test(text)) { this.counts.wagerRejected++; ev.result = 'wager-rejected'; ev.reason = 'not a whole number of chips'; this.record(ev); this.push({ status: 'Invalid wager' }); return; }
        const n = Number(text); amount = this.convention === 'raise-by' ? t.currentBet + n : n;
        if (!(amount > t.currentBet && amount <= lg.maxRaiseTo && (amount >= lg.minRaiseTo || amount === lg.maxRaiseTo))) { this.counts.wagerRejected++; ev.result = 'wager-rejected'; ev.reason = 'outside ' + lg.minRaiseTo + '..' + lg.maxRaiseTo; ev.amount = amount; this.record(ev); this.push({ status: 'Wager outside limits' }); return; }
      } else if (m.control === 'allin') { if (lg.canRaise) { type = 'raise'; amount = lg.maxRaiseTo; } else { type = 'call'; } }
      const actor = t.actor;
      try { t.execute(t.request(type, amount, this.now()), this.now()); } catch (e) { this.counts.illegal++; ev.result = 'engine-refused'; ev.reason = e.message; this.record(ev); return; }
      this.counts.accepted++; this.counts.byType[m.control] = (this.counts.byType[m.control] || 0) + 1; this.rev++;
      const rec = { hand: t.hand, seat: actor, control: m.control, type, amount: type === 'call' ? lg.callAmount : amount, rev: this.rev }; this.accepted.push(rec); if (this.accepted.length > 5000) this.accepted.shift();
      ev.result = 'accepted'; ev.applied = rec; ev.after = this.snapshot(); this.record(ev);
      if (this.turnDelay > 0 && t.status === 'playing') { this.holdUntil = this.now() + this.turnDelay; clearTimeout(this.holdTimer); this.holdTimer = setTimeout(() => { if (this.closed) return; this.rev++; this.push(); }, this.turnDelay + 5); }
      this.push({ clearWager: m.control === 'raise' });
      this.scheduleNextHand(); this.armClock(); this.armBot();
    }
    scheduleNextHand() {
      if(this.t.status!=='complete'||this.t.tournamentComplete)return;
      this.record({kind:'hand-complete',hand:this.t.hand,state:this.snapshot()});
      if(this.hands<this.maxHands){clearTimeout(this.timer);this.timer=setTimeout(()=>{if(this.closed)return;this.start();this.push();},this.gap);}
    }
    summary(full) { return { table: this.id, hands: this.hands, rev: this.rev, convention: this.convention, tournament:this.t.persistentStacks, actionTimeoutMs: this.actionTimeout, state:this.snapshot(), counts: JSON.parse(JSON.stringify(this.counts)), accepted: full ? this.accepted.slice() : this.accepted.slice(-200), lastShown: this.lastShown, dropPending: this.dropNext }; }
    /** 0.36.2 M3.2 test control: the next n button actions are recorded but not applied. */
    dropNextAction(n = 1) { this.dropNext = Math.max(0, Math.min(10, Number(n) || 0)); this.record({ kind: 'test-control', control: 'drop-next-action', count: this.dropNext }); return { ok: true, pending: this.dropNext }; }
    /** 0.36.2 M3: stop every timer of this dealer (test harnesses call it when they finish, so no timer outlives the run). */
    dispose() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.holdTimer); clearTimeout(this.actTimer); clearTimeout(this.botTimer); this.timer = this.holdTimer = this.actTimer = this.botTimer = null; }
  }
  return { CONTROLS, WAGER_FIELD, CONVENTIONS, TableDealer };
});
