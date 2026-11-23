/* EightMax Test Workbench 0.35.0: SIMULATOR CONTROLS - screen capture -> recognition -> state -> decision -> validation ->
 * visible input -> capture again -> confirmation, for windows of the operator's OWN simulator (or the bundled test table).
 *
 *   Capture       desktop host /api/capture/frame (PrintWindow or Windows Graphics Capture; the operator consented per window)
 *   Recognise     the calibrated table reader (vision-ocr ImageObserver) + the status strip when the profile has one
 *   Reconstruct   HandStateEngine (refuses inconsistent readings; pauses the table)
 *   Decide        SolverService (EightMax decisions) or, only where allowed, a labelled SCRIPTED policy
 *   Validate      TestExecutor (study/simulation/qa modes, freshness, legality, duplicates, authorisation)
 *   Input         UiAutomationAdapter -> WindowsUiDriver -> desktop host -> EightMaxInput.exe, inside ONE scheduler lease
 *   Confirm       new captures until the frame changes, then confirmAction(before, after): confirmed / rejected / ambiguous /
 *                 timed-out / cancelled. Anything but confirmed pauses the table; nothing is ever re-sent blindly.
 * No input is sent unless the reading is complete and fresh; uncertain recognition is a reason to wait, never to guess.
 *
 * 0.36.2 Milestone 2 - window lifecycle (src/window-lifecycle.js). ROOT CAUSE of the operator's 592 rejected frames / 801 target-lost
 * events: look() turned EVERY capture failure into "no reading yet" and run() (started with run(Infinity), stopOnPause:false) retried
 * every idlePollMs (120 ms) forever, without asking whether the window still existed. Now every failure is classified, a suspected loss
 * is confirmed with the input driver (window-info: same handle, process id, process start time, class), confirmed loss is TERMINAL
 * (capture revoked locally, queued/running input cancelled through the scheduler, driver authorisation revoked, run() returns),
 * temporary failures back off (250 ms .. 4 s) and are bounded, and the table returns to ACTIVE only after the identity is verified
 * again and fresh readings are reconstructed. Every decision carries a lifecycle token; a click is refused at the last moment if the
 * lifecycle moved on (lease revoked, guard fails, identity re-checked from window-info).
 *
 * 0.36.2 Milestone 3 - gameplay reliability. The hand tracker now follows hands that start with ELIMINATED players (hand-state.js);
 * for the bundled controlled fixture (a tournament: chips carry over) it runs with tournament rules 'strict', so every opening is
 * also checked against the previous settled hand (stacks, button movement, seating). Every step result is classified into ONE
 * gameplay condition (GAMEPLAY below: waiting for a valid hand, reconstruction failure, elimination, chip accounting, strategy
 * unavailable, capture unavailable, target lost, emergency stop, manual override, input confirmation failure, tournament finished),
 * shown separately on the dashboard and written to the diagnostics only when it CHANGES (counters keep the totals). After an untracked
 * hand or an interruption no decision is taken until the tracker has verified fresh readings ('verifying'); a finished tournament
 * ends run() normally (lifecycle STOPPED, cause tournament-complete), it is not a stall.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./hand-state.js'), require('./solver-service.js'), require('./test-executor.js'), require('./execution-adapters.js'), require('./vision-ocr.js'), require('./sim-display.js'), require('./image-codec.js'), require('./status-strip.js'), require('./windows-input-driver.js'), require('./input-scheduler.js'), require('./input-geometry.js'), require('./input-motion.js'), require('./full-hand.js'), require('./window-lifecycle.js'));
  else root.WorkbenchSimulatorControls = factory(root.EightMax, root.WorkbenchHandState, root.WorkbenchSolverService, root.WorkbenchExecutor, root.WorkbenchExecutionAdapters, root.WorkbenchVisionOcr, root.WorkbenchSimDisplay, root.WorkbenchImageCodec, root.WorkbenchStatusStrip, root.WorkbenchInputDriver, root.WorkbenchInputScheduler, root.WorkbenchInputGeometry, root.WorkbenchInputMotion, root.WorkbenchFullHand, root.WorkbenchWindowLifecycle);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (EM, HS, SS, EX, XA, OCR, SIM, IC, STRIP, DRV, SCH, G, M, FH, LC) {
  'use strict';
  const mono = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (v, m) => { if (!v) throw new Error(m); };
  const b64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'base64') : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

  /** Authenticated client of the local desktop host (same session token as the dashboard). Bounded concurrency. */
  class HostApi {
    constructor({ origin = 'http://127.0.0.1:48713', token, fetch: f, maxConcurrent = 6, timeoutMs = 30000 }) { ok(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'Desktop session token required'); this.origin = origin; this.token = token; this.f = f || fetch; this.slots = maxConcurrent; this.waiters = []; this.timeoutMs = timeoutMs; }
    async _slot() { if (this.slots > 0) { this.slots--; return; } await new Promise((r) => this.waiters.push(r)); }
    _free() { const w = this.waiters.shift(); if (w) w(); else this.slots++; }
    async request(path, body, timeoutMs) {
      ok(/^\/api\/(input\/(command|status|estop|restart|stop|settings)|capture\/(windows|monitors|open|frame|close)|desktop\/(health|launch))$/.test(path), 'Route not used by Simulator Controls: ' + path);
      await this._slot();
      try {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null, timer = ctl ? setTimeout(() => ctl.abort(), (timeoutMs || this.timeoutMs) + 5000) : null;
        try {
          const r = await this.f(this.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-EightMax-Session': this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl ? ctl.signal : undefined, cache: 'no-store' });
          const text = await r.text(); let v; try { v = JSON.parse(text); } catch (e) { throw new Error('Host returned invalid JSON for ' + path); }
          if (!r.ok) { const e = new Error(v && v.error || 'Host refused ' + path); e.code = v && v.code; e.status = r.status; throw e; }
          return v;
        } finally { if (timer) clearTimeout(timer); }
      } finally { this._free(); }
    }
  }
  /** A DriverSession whose commands travel through the host broker. */
  function hostSession(api) {
    const t = DRV.hostTransport((path, msg) => api.request(path, msg, msg.timeoutMs).catch((e) => ({ ok: false, code: e.code || 'host-error', error: e.message })));
    const s = new DRV.DriverSession(t); s.helloed = true; return s;
  }

  /** Window capture through the host: returns {ok, image, bounds, title, frameId, at} after decoding and size checks. */
  class HostWindowCapture {
    constructor(api, target, o = {}) { this.api = api; this.target = { kind: 'window', hwnd: target.hwnd, pid: target.pid, title: target.title, method: o.method || 'print-window' }; this.opened = false; this.frames = 0; this.failures = 0; this.decode = o.decode || (async (png) => IC.decodePng(b64(png))); }
    async open() { if (this.revoked) return { ok: false, code: 'target-lost', reason: this.revoked }; const r = await this.api.request('/api/capture/open', { target: this.target, consent: true }); this.opened = !!(r && r.ok); return r; }
    /** 0.36.2 M2: after a confirmed loss no request for this handle ever reaches the host again (the handle may be reused). */
    revoke(reason) { this.revoked = reason || 'target lost'; }
    async grab() {
      if (this.revoked) { this.refusedLocally = (this.refusedLocally || 0) + 1; return { ok: false, code: 'target-lost', reason: 'capture revoked: ' + this.revoked, local: true }; }
      if (this.inject) { const f = this.inject(); if (f) { this.failures++; return { ok: false, code: f.code || 'injected-transient', reason: f.reason || 'injected fault', minimized: !!f.minimized, injected: true }; } }
      const t0 = mono(); let r; try { r = await this.api.request('/api/capture/frame', { target: this.target }); } catch (e) { this.failures++; return { ok: false, code: e.code || 'capture-failed', reason: e.message }; }
      if (!r || r.ok !== true) { this.failures++; return { ok: false, code: r && r.code || 'capture-failed', reason: r && r.reason || 'no frame', minimized: r && r.minimized }; }
      let image; try { image = await this.decode(r.png); } catch (e) { this.failures++; return { ok: false, code: 'decode-failed', reason: e.message }; }
      if (image.width !== r.width || image.height !== r.height) { this.failures++; return { ok: false, code: 'size-mismatch', reason: 'decoded size differs' }; }
      this.frames++; return { ok: true, image, bounds: r.bounds, title: r.title || (r.target && r.target.title), frameId: r.frameId, method: r.method, dpiScale: r.dpiScale, at: mono(), captureMs: mono() - t0 };
    }
    async close() { try { await this.api.request('/api/capture/close', { target: this.target }); } catch (e) { /* host gone */ } }
  }

  /** The calibrated reader for one table (templates come from the controlled renderer; never from the oracle). */
  const readerCache = new Map();
  function tableReader(tableId, seats = 8) { const key = seats; let cal = readerCache.get(key); if (!cal) { cal = SIM.calibrate([800, 960, 1280, 1440, 1920], SIM.layoutFor(seats, true)); readerCache.set(key, cal); } return new OCR.ImageObserver({ table: tableId, profiles: cal.profiles, cards: cal.cards, glyphs: cal.glyphs, seats }); }

  const DEFAULTS = Object.freeze({ maxRefusalsInRow: 4, maxObservationAgeMs: 2500, postActionTimeoutMs: 4000, pollMs: 60, decisionWindowMs: 12000, idlePollMs: 120, maxConsecutiveRejects: 40, revalidate: 'capture',
    // 0.36.2 M2 lifecycle: bounded backoff for temporary capture failures, fresh readings needed after an interruption, periodic identity check
    retryBaseMs: 250, retryMaxMs: 4000, maxRetryAttempts: 120, maxUnavailableMs: 300000, recoveryReadings: 2, identityCheckMs: 5000 });
  const LS = LC.STATES;
  /** 0.36.2 M3: gameplay conditions (title, plain-language explanation). One condition per table at a time. */
  const GAMEPLAY = Object.freeze({
    'starting': ['Starting', 'Reading the table for the first time.'],
    'playing': ['Playing', 'Automated gameplay is running: every reading is verified and every action confirmed.'],
    'waiting-turn': ['Waiting', 'Another player is to act, or no action controls are shown. Nothing to do.'],
    'between-hands': ['Between hands', 'The hand is over; waiting for the next hand to be dealt.'],
    'verifying': ['Verifying fresh readings', 'The hand is recognised again; automated input waits until consecutive fresh readings agree.'],
    'waiting-next-hand': ['Waiting for a valid hand', 'The current hand could not be reconstructed. Automated input is paused until the next verified hand.'],
    'reconstruction-failure': ['Hand reconstruction failure', 'The latest reading contradicts the reconstructed hand. No action is sent; the table waits for a consistent reading or the next hand.'],
    'elimination': ['Player eliminated', 'Player elimination detected. Tournament seating and hand state updated.'],
    'chip-accounting': ['Invalid chip accounting', 'Pot, stacks or settlement do not add up. No action is sent until the chips are consistent.'],
    'strategy-unavailable': ['Strategy unavailable', 'No compatible EightMax strategy decision is available; no scripted decision is substituted. Automation for this table is paused.'],
    'capture-unavailable': ['Capture unavailable', 'The simulator window could not be captured. No action is sent until a fresh reading is verified.'],
    'recognition-failure': ['Table not recognised', 'The captured picture could not be read reliably. No action is sent.'],
    'target-lost': ['Target lost', 'The registered simulator window is gone. Automation for this table has stopped.'],
    'emergency-stop': ['Emergency stop', 'The emergency stop is latched. Nothing resumes by itself.'],
    'manual-override': ['Manual mouse override', 'Manual mouse or keyboard input took over. Automation for this table is paused for safety.'],
    'input-confirmation-failure': ['Input confirmation failure', 'An action could not be confirmed on the screen. It is not repeated; the table is paused for review.'],
    'paused': ['Paused', 'Automation for this table is paused.'],
    'stopped': ['Stopped', 'Automation for this table was stopped.'],
    'tournament-complete': ['Simulator completed', 'Tournament finished. Automated gameplay has stopped normally.'],
  });
  const CHIP_CODES = new Set(['inconsistent-pot', 'inconsistent-stacks', 'bad-settlement', 'inconsistent-start-pot', 'stack-continuity']);

  /**
   * One registered simulator window under automation.
   * o: id, window {hwnd,pid,title,client}, profile (platform profile), api, session, scheduler, authorization, recorder,
   *    decide(state) -> decision | null (EightMax), allowScripted, motion, timing, options,
   *    0.36.2 M2: identity (driver identity record: pid, processStart, className, exe, exeSha256), lifecycle (shared WindowLifecycle of
   *    the registration; created here when absent), registrationId, onLifecycle(ev)
   */
  class SimulatorTable {
    constructor(o) {
      this.id = o.id; this.win = o.window; this.profile = o.profile; this.api = o.api; this.s = o.session; this.sched = o.scheduler; this.rec = o.recorder || null; this.opt = { ...DEFAULTS, ...(o.options || {}) };
      this.capture = new HostWindowCapture(o.api, o.window, { method: o.captureMethod, decode: o.decode });
      // 0.36.2 M3: the bundled controlled fixture runs tournaments (chips carry over): strict tournament rules; other simulators 'auto'
      this.tournamentRules = o.tournamentRules || (o.profile && o.profile.execution && o.profile.execution.controlledFixture === true ? 'strict' : 'auto');
      this.reader = tableReader(o.id, 8); this.engine = this._freshEngine();
      this.strip = !!(o.profile.layout && o.profile.layout.statusStrip);
      this.lastFrame = null; this.state = null; this.paused = null; this.stopped = false; this.rng = new EM.RNG((o.seed || 1) * 7 + o.id);
      this.decide = o.decide || null; this.allowScripted = !!o.allowScripted;
      // ---- lifecycle ----
      this.identity = o.identity ? { ...o.identity } : LC.identityOf({ hwnd: o.window.hwnd, pid: o.window.pid, title: o.window.title, client: o.window.client });
      this.lc = o.lifecycle || new LC.WindowLifecycle({ identity: this.identity, table: o.id, registrationId: o.registrationId });
      this.registrationId = this.lc.registrationId; this.onLifecycle = o.onLifecycle || null;
      this._offLc = this.lc.on((ev) => { this._diag('lifecycle', { kind: 'transition', from: ev.from, to: ev.to, generation: ev.generation, cause: ev.cause && ev.cause.kind, code: ev.cause && ev.cause.code, reason: ev.cause && ev.cause.reason, operator: !!(ev.cause && ev.cause.operator) }); if (this.rec && this.rec.flush) this.rec.flush(this.id); if (this.onLifecycle) { try { this.onLifecycle(ev, this); } catch (e) { /* UI listener */ } } });
      this.retry = new LC.RetryPolicy({ baseMs: this.opt.retryBaseMs, maxMs: this.opt.retryMaxMs, maxAttempts: this.opt.maxRetryAttempts, maxUnavailableMs: this.opt.maxUnavailableMs });
      this.nextAttemptAt = 0; this.recoveryGood = 0; this.lastIdentityCheck = mono(); this._probing = null; this._activeToken = null; this.lost = null; this.cancellation = null;
      const e = o.profile.execution || {}, controls = { ...(o.profile.layout.controls || {}), ...(e.controls || {}) }; this.controls = controls; this.amountField = e.amountField || null;
      this.driver = new DRV.WindowsUiDriver({ session: o.session, hwnd: o.window.hwnd, motion: o.motion, movement: o.movement, timing: o.timing, focusPolicy: o.focusPolicy, expectClient: () => this.lastFrame && this.lastFrame.client, onTrace: (ev) => this._diag('execution', ev),
        identity: o.identity ? () => this.identity : null, guard: () => this._inputGuard(this._activeToken) });
      this.driver.estimateFor = (region, box, wager) => { const c = this.lastFrame && this.lastFrame.client; if (!c) return 0; let ms = this.driver.estimateMs(box, c); if (wager) ms += this.driver.estimateMs(e.amountField, c) + this.driver.estimateTypingMs(wager.text); return ms; };
      this.adapter = new XA.UiAutomationAdapter({ authorization: o.qaAuthorization, now: () => Date.now(), driver: this.driver, controls, amountField: e.amountField, amountConvention: e.amountConvention, chipUnit: e.chipUnit, scheduler: o.scheduler, deadlineMs: this.opt.decisionWindowMs, controlledFixture: o.profile.verification && o.profile.verification.status === 'controlled-renderer' && e.controlledFixture === true, table: o.id });
      this.executor = new EX.TestExecutor({ stateOf: () => ({ state: this.engine.state, paused: this.engine.paused || !!this.paused, pauseReason: this.engine.pauseReason || this.paused, revision: this.engine.revision }), now: () => Date.now(), maxActionAgeMs: this.opt.decisionWindowMs, hrnow: mono });
      this.executor.setMode('qa', { authorization: o.qaAuthorization }); this.executor.attach(o.id, this.adapter);
      this.m = { frames: 0, rejectedFrames: 0, decisions: 0, scripted: 0, solver: 0, unavailable: 0, attempted: 0, confirmed: 0, rejected: 0, ambiguous: 0, timedOut: 0, cancelled: 0, blocked: 0, deadline: 0, errors: 0, e2e: [], cursor: [], input: [], wait: [], confirmMs: [], focusErrors: 0, driverErrors: 0,
        captureFailuresByCode: {}, transientFailures: 0, lossSignals: 0, uncertain: 0, cancelledByLoss: 0, staleDiscarded: 0, recoveries: 0, backoffWaits: 0, probes: 0, manualOverrides: 0, emergencyStops: 0, strategyUnavailable: 0,
        verifyingSteps: 0, handRecoveries: 0, eliminationsSeen: 0 };
      this.log = [];
      // 0.36.2 M3: gameplay condition (one at a time), per-condition step counts and episode counts, last seating event, completion
      this.gameplay = { code: 'starting', since: Date.now(), detail: null, counts: {}, episodes: { starting: 1 }, lastEvent: null }; this.completed = null;
    }
    _freshEngine() { const e = new HS.HandStateEngine(this.id, { track: true, seats: 8, expectedLayout: 'eightmax-8max-v2', tournament: this.tournamentRules || 'auto' }); this._lastEventSeq = 0; this._recoveriesSeen = 0; return e; }
    /** 0.36.2 M3: set the table's gameplay condition; a CHANGE is written once to the diagnostics, repeats only increment counters. */
    _condition(code, detail) {
      const g = this.gameplay; g.counts[code] = (g.counts[code] || 0) + 1;
      if (g.code === code) { if (detail !== undefined && detail !== g.detail && code !== 'playing') g.detail = detail; return; }
      const from = g.code; g.code = code; g.since = Date.now(); g.detail = detail === undefined ? null : detail; g.episodes[code] = (g.episodes[code] || 0) + 1;
      const [title, message] = GAMEPLAY[code] || [code, '']; this._diag('gameplay', { kind: 'condition', from, to: code, title, message, detail: g.detail });
    }
    /** Title, message and facts of the current gameplay condition (dashboard). */
    gameplayStatus() {
      const g = this.gameplay, [title, message] = GAMEPLAY[g.code] || [g.code, ''];
      return { code: g.code, title, message, detail: g.detail, sinceMs: Date.now() - g.since, counts: { ...g.counts }, episodes: { ...g.episodes }, lastEvent: g.lastEvent, tracking: this.engine.trackingStatus(), tournament: this.engine.tournamentStatus(), completed: this.completed };
    }
    /** New verified seating events (eliminations, heads-up, ...) and hand recoveries from the tracker: written once each. */
    _noteTracker() {
      const T = this.engine.tour; let elim = null;
      if (T.eventSeq !== this._lastEventSeq) {   // seating events carry a sequence number (the engine keeps a bounded list)
        for (const e of T.events) {
          if (e.seq <= this._lastEventSeq) continue;
          this._lastEventSeq = e.seq;
          this._diag('gameplay', { kind: 'seating', event: e.kind, seat: e.seat === undefined ? null : e.seat, eventHand: e.hand, detail: e.detail });
          if (e.kind === 'eliminated') { this.m.eliminationsSeen++; elim = e; }
          this.gameplay.lastEvent = { kind: e.kind, hand: e.hand, seat: e.seat === undefined ? null : e.seat, detail: e.detail, at: Date.now() };
        }
        this._lastEventSeq = T.eventSeq;
      }
      const rc = this.engine.tr.recoveries; if (rc > this._recoveriesSeen) { this.m.handRecoveries += rc - this._recoveriesSeen; this._recoveriesSeen = rc; const lr = this.engine.tr.lastRecovery; this._diag('gameplay', { kind: 'hand-recovered', fromHand: lr && lr.fromHand, toHand: lr && lr.toHand, cause: lr && lr.cause }); }
      return elim;
    }
    /** A finished tournament is a normal end of automation for this table (not a stall, not a fault). */
    _finishTournament(end) {
      if (this.completed) return { kind: 'complete', reason: GAMEPLAY['tournament-complete'][1] };
      this.completed = { kind: 'tournament-complete', hand: end.hand, winner: end.winner, source: end.source, at: new Date().toISOString() };
      this._condition('tournament-complete', 'seat ' + end.winner + ' holds every chip after hand ' + end.hand);
      if (!this.lc.terminal && !this.lc.is(LS.STOPPED, LS.SAFETY_PAUSED)) this.lc.transition(LS.STOPPED, { kind: 'tournament-complete', reason: GAMEPLAY['tournament-complete'][1] });
      this.stopped = true; this._activeToken = null;
      return { kind: 'complete', reason: GAMEPLAY['tournament-complete'][1], hand: end.hand, winner: end.winner };
    }
    /** The gameplay condition that explains a step result. */
    _classify(r, v) {
      const k = r.kind, cause = this.lc.cause || {};
      if (k === 'complete') return;   // set by _finishTournament
      if (k === 'lost') return this._condition('target-lost', r.reason || null);
      if (k === 'paused' || k === 'stopped') {
        const why = String(r.reason || this.paused || '');
        if (this.lc.is(LS.SAFETY_PAUSED)) return this._condition(cause.kind === 'emergency-stop' ? 'emergency-stop' : cause.kind === 'manual-override' ? 'manual-override' : cause.kind === 'unconfirmed-input' ? 'input-confirmation-failure' : cause.kind === 'exhausted' || cause.kind === 'configuration' ? 'capture-unavailable' : 'paused', cause.reason || why);
        if (/^no EightMax decision/.test(why)) return this._condition('strategy-unavailable', why);
        return this._condition(k === 'stopped' ? 'stopped' : 'paused', why || null);
      }
      if (k === 'backoff' || (k === 'unavailable' && r.category !== 'strategy-unavailable')) return this._condition('capture-unavailable', r.reason || null);
      if (k === 'unavailable') return this._condition('strategy-unavailable', r.reason || null);
      if (k === 'no-reading') {
        if (v && v.issues && v.issues.length) {
          const ts = this.engine.trackingStatus(), code = v.issues[0].code;
          if (ts.status === 'untracked-hand') return this._condition('waiting-next-hand', 'hand ' + ts.observedHand + ': ' + ts.reasonCode + ' - ' + ts.reason);
          if (CHIP_CODES.has(code)) return this._condition('chip-accounting', code + ': ' + v.issues[0].detail);
          return this._condition('reconstruction-failure', code + ': ' + v.issues[0].detail);
        }
        // a frame discarded because the lifecycle moved on while it was captured (stop, loss, recovery) is not a recognition problem
        if (r.code === 'stale-frame') return this._condition(this.stopped ? 'stopped' : 'verifying', r.reason || null);
        return this._condition('recognition-failure', r.reason || null);
      }
      if (k === 'verifying') return this._condition('verifying', r.reason || null);
      if (k === 'recovering') return this._condition('verifying', r.reason || null);
      if (k === 'stale') return this._condition('verifying', r.reason || null);
      if (k === 'waiting') return this._condition(r.between ? (this.gameplay.code === 'elimination' ? 'elimination' : 'between-hands') : 'waiting-turn', r.between && this.gameplay.code === 'elimination' ? undefined : r.reason || null);
      if (k === 'acted') {
        const e = r.entry || {};
        if (e.status === 'confirmed') return this._condition('playing', null);
        if (this.lc.is(LS.SAFETY_PAUSED)) return this._classify({ kind: 'paused', reason: cause.reason }, v);
        return this._condition(e.status === 'uncertain' || e.status === 'unconfirmed' ? 'input-confirmation-failure' : 'playing', e.reason || null);
      }
      if (k === 'error') return this._condition('paused', r.reason || null);
    }
    _diag(stage, detail) { if (this.rec) { try { this.rec.record(this.id, stage, { hwnd: this.win.hwnd, hand: this.state && this.state.hand, revision: this.engine.revision, ...detail }); } catch (e) { /* bounded recorder */ } } }
    pause(reason) { this.paused = reason; this.executor.pauseTable(this.id, reason); if (this.sched) this.sched.pauseTable(this.id, reason); this._diag('system', { kind: 'pause', reason }); }
    /** Operator resume. A lost target never resumes; a safety-paused or stopped one goes through RECOVERY_PENDING (fresh readings first). */
    resume() {
      if (this.lc.terminal) return false;
      if (this.completed) return false;   // 0.36.2 M3: a finished tournament does not resume; start a new tournament (new table window)
      this.paused = null; this.executor.resumeTable(this.id); if (this.sched) this.sched.resumeTable(this.id); this.engine.resume();
      if (this.lc.is(LS.SAFETY_PAUSED, LS.STOPPED)) { const r = this.lc.transition(LS.RECOVERY_PENDING, { kind: 'operator-resume', reason: 'operator resumed the table', operator: true }); if (!r.ok) return false; this._discardStale('operator resume'); this.retry.reset(); this.nextAttemptAt = 0; }
      this._diag('system', { kind: 'resume' }); return true;
    }
    /** Emergency stop / manual override / unconfirmed input: SAFETY_PAUSED; leaving it needs an explicit operator action. */
    safetyPause(kind, reason, extra = {}) {
      if (kind === 'emergency-stop') this.m.emergencyStops++; if (kind === 'manual-override') this.m.manualOverrides++;
      if (!this.lc.terminal) this.lc.transition(LS.SAFETY_PAUSED, { kind, reason, ...extra });
      if (!this.paused) this.pause(reason); this._activeToken = null; return { kind: 'paused', reason };
    }
    /** Interruption: the last reading, frame and decision token are discarded. The hand tracker keeps its history (so a hand in
     *  progress can be followed again) but is paused: like a restored checkpoint it accepts nothing as current until consecutive
     *  fresh readings agree with the screen (HandStateEngine autoResumeAfter), and RECOVERY_PENDING needs opt.recoveryReadings more. */
    _discardStale(why, o = {}) {
      if (this.state || this.lastFrame) this.m.staleDiscarded++; this.state = null; this.lastFrame = null; this.recoveryGood = 0; this._activeToken = null;
      if (o.resetEngine) this.engine = this._freshEngine(); else { this.engine.last = null; this.engine.paused = true; this.engine.pauseReason = 'interrupted (' + why + '); waiting for consistent fresh readings'; this.engine.goodStreak = 0; }
      this._diag('lifecycle', { kind: 'stale-state-discarded', reason: why });
    }

    /* ---------------- lifecycle helpers ---------------- */
    /** One identity probe at a time (concurrent loss signals share it). */
    _probe() { if (!this._probing) { this.m.probes++; this._probing = LC.probeIdentity(this.s, this.identity).finally(() => { this._probing = null; }); } return this._probing; }
    _inputGuard(token) {
      if (this.stopped) return { ok: false, code: 'lifecycle-blocked', reason: 'table stopped' };
      if (!token || !this.lc.valid(token)) return { ok: false, code: this.lc.terminal ? 'target-lost' : 'lifecycle-blocked', reason: 'target is ' + this.lc.state + (this.lc.cause && this.lc.cause.reason ? ' (' + this.lc.cause.reason + ')' : '') + '; the decision belongs to an earlier lifecycle generation' };
      if (this.capture.revoked) return { ok: false, code: 'target-lost', reason: 'capture revoked' };
      return { ok: true };
    }
    /** Confirmed loss: terminal, idempotent. Cancels queued and running input of this registration only. */
    targetLost(cause) {
      this.lc.lossSignals++; this.m.lossSignals++;
      if (this.lc.terminal) return { kind: 'lost', reason: this.lost && this.lost.reason, repeated: true };
      const r = this.lc.transition(LS.TARGET_LOST, { kind: cause.kind || 'window-closed', code: cause.code || 'target-lost', reason: cause.reason || 'The window no longer exists.', source: cause.source || null });
      if (!r.ok) return { kind: 'lost', refused: r.refused };
      this.lost = { kind: cause.kind || 'window-closed', code: cause.code || 'target-lost', reason: cause.reason || 'The window no longer exists.', at: new Date().toISOString(), source: cause.source || null };
      this.capture.revoke(this.lost.reason);                                   // never capture the old handle again
      this._discardStale('target lost', { resetEngine: true });                 // no decision may use the old state
      this.cancellation = this.sched && this.sched.invalidateTable ? this.sched.invalidateTable(this.id, this.lost.reason, this.registrationId) : { dropped: 0, cancelledRunning: false };
      if (this.cancellation.dropped || this.cancellation.cancelledRunning) this.m.cancelledByLoss += this.cancellation.dropped + (this.cancellation.cancelledRunning ? 1 : 0);
      this.paused = 'target lost: ' + this.lost.reason; this.executor.pauseTable(this.id, this.paused); this.pendingAction = null;
      this._diag('lifecycle', { kind: 'target-lost', code: this.lost.code, reason: this.lost.reason, cancellation: this.cancellation, msSinceLastSuccessfulCapture: this.lc.lastSuccessAt === null ? null : Math.round(mono() - this.lc.lastSuccessAt), identity: this.identity });
      // the driver forgets the authorisation (a reused handle can never inherit it) and any capture session is closed; best effort
      this.cleanup = Promise.all([Promise.resolve().then(() => this.s.request('unregister-target', { hwnd: this.win.hwnd })).catch(() => null), this.capture.close().catch(() => null)]).then(() => true);
      return { kind: 'lost', reason: this.lost.reason };
    }
    /** A capture failed: classify, ask whether the ORIGINAL window still exists, then lost / temporary / configuration. */
    async _captureFailed(g) {
      const cls = LC.classifyCaptureFailure(g.code); this.lc.noteFailure(g.code, g.reason); this.m.captureFailuresByCode[g.code] = (this.m.captureFailuresByCode[g.code] || 0) + 1;
      if (this.lc.terminal) return { kind: 'lost' };
      if (cls.category === 'configuration') return this.safetyPause('configuration', 'capture method unavailable: ' + g.reason, { code: g.code });
      const p = await this._probe();
      if (this.lc.terminal) return { kind: 'lost' };
      if (p.exists === false) return this.targetLost({ kind: 'window-closed', code: 'target-lost', reason: 'The window no longer exists (capture: ' + g.code + '; driver: ' + p.code + ').', source: 'capture' });
      if (p.exists === true && !p.matches) return this.targetLost({ kind: 'identity-changed', code: 'identity-changed', reason: 'The window no longer matches the registered simulator: ' + p.problems.join('; '), source: 'capture' });
      const kind = p.exists === true && p.minimized ? 'minimized' : cls.category === 'terminal-candidate' ? (p.exists === true ? 'hidden-or-unreadable' : 'loss-unconfirmed') : cls.kind;
      return this._temporary({ kind, code: g.code, reason: g.reason + (p.exists === null ? ' (window state unknown: ' + p.code + ')' : ''), source: 'capture' });
    }
    /** During revalidation / confirmation: confirm a suspected LOSS only (rate-limited); never counts as a retry attempt. */
    async _checkLoss(g) {
      if (this.lc.terminal) return { kind: 'lost' };
      if (LC.classifyCaptureFailure(g.code).category !== 'terminal-candidate') return null;
      if (this._lastLossCheck !== undefined && mono() - this._lastLossCheck < 250) return null; this._lastLossCheck = mono();
      const p = await this._probe(); if (this.lc.terminal) return { kind: 'lost' };
      if (p.exists === false) return this.targetLost({ kind: 'window-closed', code: 'target-lost', reason: 'The window no longer exists (capture: ' + g.code + '; driver: ' + p.code + ').', source: 'confirmation' });
      if (p.exists === true && !p.matches) return this.targetLost({ kind: 'identity-changed', code: 'identity-changed', reason: 'The window no longer matches the registered simulator: ' + p.problems.join('; '), source: 'confirmation' });
      return null;
    }
    _temporary(cause) {
      this.m.transientFailures++;
      if (this.lc.is(LS.SAFETY_PAUSED, LS.STOPPED) || this.lc.terminal) return { kind: 'paused', reason: this.paused };
      const r = this.lc.transition(LS.TEMPORARILY_UNAVAILABLE, cause); if (r.ok && r.changed) this._discardStale('capture interrupted: ' + cause.kind);
      const n = this.retry.next(); this.nextAttemptAt = mono() + n.delayMs; this.m.backoffWaits++;
      if (n.exhausted) return this.safetyPause('exhausted', 'capture unavailable for ' + Math.round(n.unavailableMs / 1000) + ' s after ' + n.attempt + ' attempts (last: ' + cause.code + ')', { code: cause.code });
      return { kind: 'unavailable', reason: cause.kind + ': ' + cause.reason, waitMs: n.delayMs, attempt: n.attempt };
    }
    /** Capture works and a reading was accepted: move REGISTERED / RECOVERY_PENDING towards ACTIVE (identity verified first). */
    async _promote(gen, client, dpiScale) {
      if (this.lc.is(LS.ACTIVE) || this.lc.terminal) return;
      if (this.lc.is(LS.RECOVERY_PENDING)) { this.recoveryGood++; if (this.recoveryGood < this.opt.recoveryReadings) return; }
      else if (!this.lc.is(LS.REGISTERED)) return;
      const p = await this._probe(); if (this.lc.generation !== gen) return;
      if (p.exists === false) { this.targetLost({ kind: 'window-closed', code: 'target-lost', reason: 'The window no longer exists.', source: 'verification' }); return; }
      if (p.exists === true && !p.matches) { this.targetLost({ kind: 'identity-changed', code: 'identity-changed', reason: 'The window no longer matches the registered simulator: ' + p.problems.join('; '), source: 'verification' }); return; }
      if (p.exists !== true) return;                                             // unknown: stay unverified, read again
      const cal = this._calibrationOk(client); if (!cal.ok) { this.safetyPause('calibration', 'calibration no longer fits the window: ' + cal.reason); return; }
      const geometryChanged = !!(this.identity.client && client && (this.identity.client.w !== client.w || this.identity.client.h !== client.h)), scalingChanged = !!(dpiScale && this.identity.dpiScale && Math.abs(dpiScale - this.identity.dpiScale) > 0.001);
      const was = this.lc.state, r = this.lc.transition(LS.ACTIVE, { kind: was === LS.REGISTERED ? 'first-reading' : 'recovered', reason: 'identity verified and ' + (was === LS.REGISTERED ? 'first reading accepted' : this.recoveryGood + ' fresh readings accepted'), geometryChanged, scalingChanged }, { ifGeneration: gen });
      if (r.ok && r.changed) { if (was !== LS.REGISTERED) this.m.recoveries++; this.lastIdentityCheck = mono(); if (geometryChanged || scalingChanged) this._diag('lifecycle', { kind: 'calibration-rechecked', geometryChanged, scalingChanged, client, dpiScale }); }
    }
    _calibrationOk(client) {
      if (!client) return { ok: false, reason: 'no client rectangle' };
      for (const k of ['fold', 'check', 'call', 'raise']) { const b = this.controls[k]; if (!b) return { ok: false, reason: k + ' not calibrated' }; const t = G.regionToScreen(b, client); if (!t.ok) return { ok: false, reason: k + ': ' + t.reason }; }
      if (this.amountField) { const t = G.regionToScreen(this.amountField, client); if (!t.ok) return { ok: false, reason: 'wager field: ' + t.reason }; }
      return { ok: true };
    }

    /** Capture + read + reconstruct. {state, frame} | {reject}. */
    async look() {
      const gen = this.lc.generation;
      const g = await this.capture.grab(); this.m.frames++;
      if (this.lc.terminal) return { reject: 'target lost', code: 'target-lost', lifecycle: { kind: 'lost' } };   // a result that arrived after the loss is discarded
      if (!g.ok) { this.m.rejectedFrames++; this._diag('capture', { ok: false, code: g.code, reason: g.reason }); const f = await this._captureFailed(g); return { reject: 'capture ' + g.code + ': ' + g.reason, code: g.code, lifecycle: f }; }
      if (this.lc.generation !== gen) return { reject: 'the table lifecycle changed while capturing; frame discarded', code: 'stale-frame' };
      this.lc.noteSuccess(); if (this.rec && this.rec.success) this.rec.success(this.id, 'capture');
      if (this.lc.is(LS.TEMPORARILY_UNAVAILABLE)) { this.lc.transition(LS.RECOVERY_PENDING, { kind: 'capture-restored', reason: 'capture works again; verifying identity and reading a fresh state' }); this.retry.reset(); this._discardStale('capture restored'); }
      const client = { x: g.bounds.x, y: g.bounds.y, w: g.bounds.width, h: g.bounds.height }, frame = { client, at: g.at, frameId: g.frameId, title: g.title };
      if (this.win.title && !(g.title || '').startsWith(this.win.title)) return { reject: 'wrong window: the title no longer starts with ' + JSON.stringify(this.win.title) };
      let view = this.profile.layout.heroSeat || 0, rev;
      if (this.strip) { const st = STRIP.read(g.image); if (!st.ok) { this.m.rejectedFrames++; this._diag('recognition', { ok: false, reasons: ['status strip: ' + st.reason] }); return { reject: 'status strip: ' + st.reason }; } if (st.table !== this.id) return { reject: 'wrong table: the window shows table ' + st.table }; view = st.viewSeat; rev = st.revision; frame.strip = st; }
      const r = this.reader.observe(g.image, { heroSeat: view, capturedAt: Date.now() });
      if (!r.ok) { this.m.rejectedFrames++; this._diag('recognition', { ok: false, reasons: r.reasons.slice(0, 3) }); return { reject: 'recognition: ' + r.reasons.slice(0, 2).join('; ') }; }
      if (this.rec && this.rec.success) this.rec.success(this.id, 'recognition');
      if (rev !== undefined) r.observation.simRevision = rev;
      const x = this.engine.ingest(r.observation);
      if (!x.accepted) { this.m.rejectedFrames++; this._diag('state', { ok: false, issues: x.issues.slice(0, 3) }); return { reject: 'state: ' + x.issues.map((i) => i.code).join(', '), issues: x.issues }; }
      this.lastFrame = frame; this.state = x.state; this._diag('state', { ok: true, frameId: g.frameId, actor: x.state.actor, status: x.state.status, captureMs: g.captureMs });
      if (!this.lc.is(LS.ACTIVE)) await this._promote(this.lc.generation, client, g.dpiScale);
      return { state: x.state, frame, observation: r.observation, viewSeat: view };
    }
    /** Re-capture inside the lease: the screen must still show the observed frame (same revision, same hand, same actor, same layout). */
    async _revalidate(st, frame, token) {
      if (this.paused) return { ok: false, reason: 'table paused' };
      if (token && !this.lc.valid(token)) return { ok: false, reason: 'target is ' + this.lc.state + ' (lifecycle changed since the reading)' };
      if (mono() - frame.at > this.opt.maxObservationAgeMs) { if (this.opt.revalidate !== 'capture') return { ok: false, reason: 'observation older than ' + this.opt.maxObservationAgeMs + ' ms' }; }
      if (this.opt.revalidate !== 'capture') return { ok: true };
      const g = await this.capture.grab(); if (!g.ok) { await this._checkLoss(g); return { ok: false, reason: 'capture ' + g.code }; }
      if (token && !this.lc.valid(token)) return { ok: false, reason: 'target is ' + this.lc.state };
      const c = { x: g.bounds.x, y: g.bounds.y, w: g.bounds.width, h: g.bounds.height }, f = frame.client;
      if (c.x !== f.x || c.y !== f.y || c.w !== f.w || c.h !== f.h) return { ok: false, reason: 'window moved or resized since the reading' };
      if (this.strip) { const s2 = STRIP.read(g.image); if (!s2.ok || s2.revision !== frame.strip.revision || s2.table !== this.id) return { ok: false, reason: 'the table changed since the reading' }; }
      if (!this.strip) { const latest=await this._readImage(g); if(!latest.state || latest.state.key!==st.key || latest.state.actor!==st.actor) return {ok:false,reason:'fresh observation differs from the decision state'}; }
      return { ok: true };
    }
    /** After input: capture until the frame changes, then compare. A window lost after the click makes the action UNCERTAIN. */
    async _confirm(sent, before, beforeFrame, deadline) {
      const t0 = mono();
      while (mono() - t0 < this.opt.postActionTimeoutMs) {
        if (this.lc.terminal) return { confirmed: false, status: 'uncertain', reason: 'the window was lost after the input was sent; delivery cannot be confirmed', uncertain: true };
        if (this.stopped) return { confirmed: false, status: 'cancelled', reason: 'stopped' };
        await sleep(this.opt.pollMs);
        const g = await this.capture.grab();
        if (!g.ok) { const f = await this._checkLoss(g); if (f && f.kind === 'lost') return { confirmed: false, status: 'uncertain', reason: 'the window was lost after the input was sent (' + g.code + '); delivery cannot be confirmed', uncertain: true }; continue; }
        if (this.strip) { const st = STRIP.read(g.image); if (!st.ok || st.revision === beforeFrame.strip.revision) continue; }
        // a new frame: read it fully
        const v = await this._readImage(g); if (!v.state) continue;
        const c = XA.confirmAction(sent, before, v.state); this.m.confirmMs.push(mono() - t0);
        if (c.status === 'confirmed') return { confirmed: true, status: 'confirmed', observed: c.observed };
        return { confirmed: false, status: c.status, reason: c.reason, clean: c.status === 'rejected' };
      }
      if (this.lc.terminal) return { confirmed: false, status: 'uncertain', reason: 'the window was lost after the input was sent; delivery cannot be confirmed', uncertain: true };
      // the frame never changed: the simulator ignored the input (rejected) - but say so only if a fresh reading shows the same actor
      const v = await this.look(); if (v.state) { const c = XA.confirmAction(sent, before, v.state); if (c.status === 'confirmed') return { confirmed: true, status: 'confirmed', observed: c.observed }; if (c.status === 'rejected') return { confirmed: false, status: 'rejected', clean: true, reason: 'no change within ' + this.opt.postActionTimeoutMs + ' ms; same actor still to act' }; }
      if (this.lc.terminal) return { confirmed: false, status: 'uncertain', reason: 'the window was lost after the input was sent; delivery cannot be confirmed', uncertain: true };
      return { confirmed: false, status: 'timed-out', reason: 'no reliable reading within ' + this.opt.postActionTimeoutMs + ' ms' };
    }
    async _readImage(g) {
      const client = { x: g.bounds.x, y: g.bounds.y, w: g.bounds.width, h: g.bounds.height };
      // 0.36.2 M3: a reading refused while confirming an action is recorded like any other refused reading (it was silent, so a
      // confirmation that timed out could not be explained afterwards); repeats are coalesced by the diagnostics recorder
      let view = this.profile.layout.heroSeat || 0, rev; if (this.strip) { const st = STRIP.read(g.image); if (!st.ok) { this.m.rejectedFrames++; this._diag('recognition', { ok: false, reasons: ['status strip: ' + st.reason], during: 'confirmation' }); return {}; } view = st.viewSeat; rev = st.revision; }
      const r = this.reader.observe(g.image, { heroSeat: view, capturedAt: Date.now() }); if (!r.ok) { this.m.rejectedFrames++; this._diag('recognition', { ok: false, reasons: r.reasons.slice(0, 3), during: 'confirmation' }); return {}; }
      if (rev !== undefined) r.observation.simRevision = rev; const x = this.engine.ingest(r.observation); if (!x.accepted) { this.m.rejectedFrames++; this._diag('state', { ok: false, issues: x.issues.slice(0, 3), during: 'confirmation' }); return {}; }
      this.state = x.state; this.lastFrame = { client, at: g.at, frameId: g.frameId, strip: this.strip ? STRIP.read(g.image) : null }; return { state: x.state };
    }
    async _decision(st) {
      let d = null; if (this.decide) { try { let timer; try { d = await Promise.race([Promise.resolve().then(() => this.decide(st)), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Decision deadline exceeded')), Math.min(2000, this.opt.decisionWindowMs)); })]); } finally { clearTimeout(timer); } } catch (e) { d = {status: 'unavailable', reason: e.message}; } }
      if (d && d.status === 'ok' && d.source === 'eightmax-study') { this.m.solver++; return d; }
      this.lastDecisionReason = d && d.reason || 'No compatible decision';
      // 0.36.2 M2: "strategy unavailable" is its own diagnostic family - never a capture failure (coalesced when it repeats)
      this.m.unavailable++; this.m.strategyUnavailable++; this._diag('decision', { ok: false, category: 'strategy-unavailable', reason: this.lastDecisionReason, scriptedAllowed: this.allowScripted });
      if (!this.allowScripted) return null;
      if (d && d.status === 'ok' && d.source === 'scripted-fallback') { this.m.scripted++; return d; }
      this.m.scripted++; return FH.scriptedDecision(st, this.rng);
    }
    /** One cycle: read; if this table must act, decide, execute through the scheduler, confirm. 0.36.2 M3: every result is classified. */
    async step() {
      if (this.completed) return { kind: 'complete', reason: GAMEPLAY['tournament-complete'][1], hand: this.completed.hand, winner: this.completed.winner };
      const ctx = {}; let r;
      try { r = await this._step(ctx); } catch (e) { this._condition('paused', 'pipeline error: ' + e.message); throw e; }
      this._classify(r, ctx.v); return r;
    }
    async _step(ctx) {
      if (this.lc.terminal) return { kind: 'lost', reason: this.lost ? this.lost.reason : 'target lost' };
      if (this.stopped) return { kind: 'stopped' }; if (this.paused) return { kind: 'paused', reason: this.paused };
      if (this.lc.is(LS.SAFETY_PAUSED, LS.STOPPED)) return { kind: 'paused', reason: this.lc.state + ': ' + (this.lc.cause.reason || '') };
      if (this.lc.is(LS.TEMPORARILY_UNAVAILABLE) && mono() < this.nextAttemptAt) return { kind: 'backoff', waitMs: this.nextAttemptAt - mono() };
      // healthy tables also confirm their identity periodically (a reused handle never inherits the registration)
      if (this.lc.is(LS.ACTIVE) && mono() - this.lastIdentityCheck >= this.opt.identityCheckMs) {
        this.lastIdentityCheck = mono(); const gen = this.lc.generation, p = await this._probe();
        if (this.lc.generation === gen) { if (p.exists === false) return this.targetLost({ kind: 'window-closed', code: 'target-lost', reason: 'The window no longer exists.', source: 'identity-check' }); if (p.exists === true && !p.matches) return this.targetLost({ kind: 'identity-changed', code: 'identity-changed', reason: 'The window no longer matches the registered simulator: ' + p.problems.join('; '), source: 'identity-check' }); }
      }
      const v = await this.look(); ctx.v = v;
      if (!v.state) {
        const l = v.lifecycle; if (l) return { kind: l.kind === 'lost' ? 'lost' : l.kind === 'paused' ? 'paused' : 'unavailable', reason: l.reason || v.reject, waitMs: l.waitMs };
        // 0.36.2 M3: an untracked hand whose final screen shows one player holding every chip is the end of the tournament
        const ts = v.issues ? this.engine.trackingStatus() : null; if (ts && ts.status === 'tournament-complete') return this._finishTournament(this.engine.tournamentStatus().complete);
        return { kind: 'no-reading', reason: v.reject, issues: v.issues, code: v.code };
      }
      const elim = this._noteTracker();
      if (!this.lc.eligible) return { kind: 'recovering', reason: 'verifying the window before input (' + this.lc.state + ')' };
      const token = this.lc.token();
      const st = v.state, end = this.engine.tour.complete;
      if (end && st.status === 'complete') return this._finishTournament(end);
      // 0.36.2 M3: after an untracked hand, an interruption or a restored checkpoint the tracker needs consecutive fresh readings first
      if (this.engine.paused) { this.m.verifyingSteps++; return { kind: 'verifying', reason: this.engine.pauseReason || 'waiting for consistent fresh readings' }; }
      if (elim) this._condition('elimination', elim.detail);   // shown until the next hand is played (see _classify)
      if (st.status !== 'playing' || !(st.actor >= 0)) return { kind: 'waiting', between: st.status === 'complete', reason: st.status === 'complete' ? 'hand ' + st.hand + ' is over' : undefined };
      // Act only when the SCREEN offers this seat an action: the viewer must be the player to act and enabled controls must be visible.
      if (v.viewSeat !== st.actor) return { kind: 'waiting', reason: 'another player is to act' };
      const c = v.observation && v.observation.controls; if (!c || !(c.fold || c.check || c.call || c.raise)) return { kind: 'waiting', reason: 'no action controls on screen' };
      const decision = await this._decision(st);
      if (this.lc.terminal) return { kind: 'lost', reason: this.lost && this.lost.reason };
      if (this.stopped || this.paused) return {kind: 'paused', reason: this.paused || 'stopped'}; if (!decision) { this.pause('no EightMax decision: ' + this.lastDecisionReason); return { kind: 'unavailable', category: 'strategy-unavailable' }; }
      if (!this.lc.valid(token)) { this.m.staleDiscarded++; return { kind: 'stale', reason: 'the window lifecycle changed while deciding; decision discarded' }; }
      this.m.decisions++; const deadline = v.frame.at + this.opt.decisionWindowMs, before = st, frame = v.frame;
      this._diag('decision', { source: decision.source, recommended: decision.recommended, label: decision.label, frameId: frame.frameId });
      const sentRef = {}; this.m.attempted++;
      // Extend the adapter submission with the deadline and the in-lease revalidation (the executor passes `act` through).
      const origSubmit = this.adapter.submit.bind(this.adapter);
      this.adapter.submit = (act) => { sentRef.act = act; act.deadline = deadline; act.registrationId = this.registrationId; act.revalidate = () => this._revalidate(st, frame, token); act.guard = () => this._inputGuard(token); return origSubmit(act); };
      const tStart = mono(); let x; this._activeToken = token;
      try {
        x = await this.executor.execute(decision, { allowScripted: decision.source === 'scripted-fallback', verify: async ({ action }) => { const sent = { seat: st.actor, type: action.type === 'raise' ? 'raise' : action.type, amount: action.amount }; const c = await this._confirm(sent, before, frame, deadline); this._diag('ack', { status: c.status, reason: c.reason }); this._lastConfirm = c; return c; } });
      } finally { this.adapter.submit = origSubmit; this._activeToken = null; }
      // a driver refusal that names the window gone / changed is a loss signal, confirmed like any other
      if (x && (x.code === 'window-gone' || x.code === 'identity-changed' || /window-gone|identity-changed/.test(x.reason || '')) && !this.lc.terminal) { const p = await this._probe(); if (p.exists === false) this.targetLost({ kind: 'window-closed', code: 'target-lost', reason: 'The window was closed while an action was prepared.', source: 'driver' }); else if (p.exists === true && !p.matches) this.targetLost({ kind: 'identity-changed', code: 'identity-changed', reason: 'The window no longer matches the registered simulator: ' + p.problems.join('; '), source: 'driver' }); }
      const ms = mono() - tStart; const entry = { t: Date.now(), hand: st.hand, street: st.street, seat: st.actor, status: x.status, action: x.action || null, intended: decision.executable && decision.executable[decision.recommendedSlot], reason: x.reason || null, source: decision.source, decisionLabel: decision.label || null, fallbackReason: decision.fallbackReason || null, input: x.input || null, ms, lifecycle: this.lc.state, generation: token.generation };
      // An action that may have reached the window before it was lost / cancelled is UNCERTAIN: never re-sent, reviewed by the operator.
      const mayHaveHappened = x.status === 'unconfirmed' || (x.status === 'rejected' && x.inputMayHaveHappened);
      if (x.status !== 'confirmed' && mayHaveHappened && (this.lc.terminal || this.stopped || (this._lastConfirm && (this._lastConfirm.uncertain || this._lastConfirm.status === 'cancelled')) || /cancel|emergency|manual/.test(x.code || x.reason || ''))) { entry.status = 'uncertain'; entry.reviewRequired = true; entry.reason = (x.reason || (this._lastConfirm && this._lastConfirm.reason) || 'input may have been delivered') + ' - review the simulator; the action is not repeated'; this.m.uncertain++; }
      if (x.status === 'confirmed') { this.m.confirmed++; this.m.e2e.push(mono() - frame.at); if (x.input) { if (x.input.actualMs) this.m.cursor.push(x.input.actualMs); } this.m.input.push(ms); }
      else if (x.status === 'rejected') { if (/scheduler: Cannot finish by the deadline/.test(x.reason || '')) this.m.deadline++; if (/focus/.test(x.reason || '')) this.m.focusErrors++; if (/driver-exited|internal-error|timeout/.test(x.reason || '')) this.m.driverErrors++; if (/target-lost|lease-invalid|lifecycle-blocked/.test((x.code || '') + ' ' + (x.reason || ''))) this.m.cancelled++; this.m.rejected++; }
      else if (x.status === 'unconfirmed') { const c = this._lastConfirm || {}; if (c.status === 'timed-out') this.m.timedOut++; else if (c.status === 'cancelled' || c.status === 'uncertain') this.m.cancelled++; else this.m.ambiguous++; }
      else if (x.status === 'aborted') this.m.cancelled++; else this.m.blocked++;
      this._lastConfirm = null;
      this.log.push(entry); if (this.log.length > 3000) this.log.shift();
      if (this.lc.terminal) return { kind: 'lost', entry, reason: this.lost && this.lost.reason };
      if (x.status !== 'confirmed' && this.executor.pausedTables.has(this.id) && !this.paused) this.paused = this.executor.pausedTables.get(this.id);
      if (/manual-override|manual-mode/.test((x.code || '') + ' ' + (x.reason || ''))) this.safetyPause('manual-override', 'manual mouse/keyboard input took over: ' + (x.reason || ''));
      else if (/emergency-stop/.test((x.code || '') + ' ' + (x.reason || ''))) this.safetyPause('emergency-stop', 'emergency stop: ' + (x.reason || ''));
      else if (entry.status === 'uncertain' || mayHaveHappened) this.safetyPause('unconfirmed-input', 'action not confirmed: ' + (entry.reason || x.reason || 'unknown') + '; manual review required');
      // Clean refusals (nothing sent) may be retried from a fresh reading, but not forever.
      this.refusalsInRow = x.status === 'confirmed' ? 0 : (this.refusalsInRow || 0) + 1;
      if (!this.paused && this.refusalsInRow >= this.opt.maxRefusalsInRow) this.pause(this.refusalsInRow + ' actions in a row could not be executed (last: ' + (x.reason || x.status) + ')');
      return { kind: 'acted', entry };
    }
    async run(untilMs, onStep) {
      try {
        while (!this.stopped && !this.lc.terminal && mono() < untilMs) {
          let r; try { r = await this.step(); } catch (e) { this.m.errors++; this._diag('system', { ok: false, error: e.message }); this.safetyPause('pipeline-error', 'pipeline error: ' + e.message); r = { kind: 'error', reason: e.message }; }
          if (onStep) onStep(r);
          if (r.kind === 'lost') break;                                           // terminal: no further capture, no input
          if (r.kind === 'complete') break;                                       // 0.36.2 M3: tournament finished - a normal end
          if (r.kind === 'paused' || r.kind === 'stopped') { if (this.opt.stopOnPause !== false) break; await sleep(250); }   // local state only, no host requests
          else if (r.kind === 'backoff' || r.kind === 'unavailable') await sleep(Math.max(10, Math.min(this.opt.retryMaxMs, r.waitMs || (this.nextAttemptAt - mono()) || this.opt.idlePollMs, untilMs - mono())));
          else if (r.kind !== 'acted') await sleep(this.opt.idlePollMs);
        }
      } finally { if (this.rec && this.rec.flush) this.rec.flush(this.id); }
    }
    /** Operator stop (keeps TARGET_LOST / SAFETY_PAUSED, which say more). */
    stop(reason) { this.stopped = true; this._activeToken = null; if (!this.lc.terminal && !this.lc.is(LS.SAFETY_PAUSED, LS.STOPPED)) this.lc.transition(LS.STOPPED, { kind: 'stopped', reason: reason || 'operator stopped automation', operator: true }); }
    /** Detach from the shared lifecycle (a new run builds new SimulatorTable objects for the same registration). */
    dispose() { if (this._offLc) { this._offLc(); this._offLc = null; } }
    report() {
      const st = SCH.stats; return { table: this.id, hwnd: this.win.hwnd, paused: this.paused, counts: { frames: this.m.frames, rejectedFrames: this.m.rejectedFrames, decisions: this.m.decisions, solverDecisions: this.m.solver, scriptedDecisions: this.m.scripted, unavailable: this.m.unavailable, attempted: this.m.attempted, confirmed: this.m.confirmed, rejected: this.m.rejected, ambiguous: this.m.ambiguous, timedOut: this.m.timedOut, cancelled: this.m.cancelled, blocked: this.m.blocked, deadlineMisses: this.m.deadline, focusErrors: this.m.focusErrors, driverErrors: this.m.driverErrors, errors: this.m.errors, uncertain: this.m.uncertain },
        latencyMs: { endToEnd: st(this.m.e2e), cursorTravel: st(this.m.cursor), inputOperation: st(this.m.input), confirmation: st(this.m.confirmMs) }, executor: this.executor.counts, capture: { frames: this.capture.frames, failures: this.capture.failures, refusedLocallyAfterLoss: this.capture.refusedLocally || 0, failuresByCode: { ...this.m.captureFailuresByCode } },
        // 0.36.2 M2 (additive): lifecycle, loss, cancellation and the separated failure families
        registrationId: this.registrationId, lifecycle: this.lc.snapshot(), lost: this.lost, cancellation: this.cancellation,
        failureFamilies: { inputDriverErrors: this.m.driverErrors, captureFailures: this.capture.failures, recognitionFailures: Math.max(0, this.m.rejectedFrames - this.capture.failures), strategyUnavailable: this.m.strategyUnavailable, inputCancellations: this.m.cancelled, emergencyStops: this.m.emergencyStops, manualOverrides: this.m.manualOverrides, targetLost: this.lc.terminal ? 1 : 0, lossSignals: this.m.lossSignals, transientCaptureFailures: this.m.transientFailures },
        recovery: { recoveries: this.m.recoveries, backoffWaits: this.m.backoffWaits, identityProbes: this.m.probes, staleStatesDiscarded: this.m.staleDiscarded, cancelledByLoss: this.m.cancelledByLoss, uncertainActions: this.m.uncertain },
        // 0.36.2 M3 (additive): gameplay condition, hand tracking and tournament seating
        tournamentRules: this.tournamentRules, gameplay: this.gameplayStatus(), handRecoveries: this.m.handRecoveries, verifyingSteps: this.m.verifyingSteps, eliminationsSeen: this.m.eliminationsSeen, completed: this.completed };
    }
  }

  /** Authorisation records: the QA one (executor) and the simulator one (driver: executable name + SHA-256). Max 8 hours. */
  function authorizations({ environment, approvedBy, exeFileName, exeSha256, hours = 2 }) {
    const expires = Date.now() + Math.min(8, hours) * 3600e3 - 60e3;
    return {
      qa: { format: 'eightmax-qa-authorization', version: 1, environment, approvedBy, testEnvironmentOnly: true, noRealMoney: true, operatorOwnsTestClient: true, expiresAt: expires, endpoint: 'http://127.0.0.1:48713/api/input/command' },
      simulator: { format: 'eightmax-simulator-authorization', version: 1, operatorOwnsSimulator: true, testEnvironmentOnly: true, noRealMoney: true, expiresAtUnixMs: expires, executable: { fileName: exeFileName, sha256: exeSha256 } },
    };
  }
  return { HostApi, hostSession, HostWindowCapture, tableReader, SimulatorTable, authorizations, DEFAULTS, GAMEPLAY, Lifecycle: LC };
});
