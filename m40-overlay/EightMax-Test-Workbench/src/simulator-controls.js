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
 *
 * 0.36.2 Milestone 3.2 - window loss while gameplay is paused (the operator's T5 failure, 2026-11-24). An action the simulator did not
 * apply paused the table's GAMEPLAY (executor pause; lifecycle still ACTIVE); every later step returned before the periodic identity
 * check and run() made no host request, so when the window was closed the registration stayed ACTIVE and the scheduler never invalidated
 * it. Now a WindowHealthMonitor (window-lifecycle.js) keeps verifying the registered identity on its own timer in every non-terminal
 * state - paused, safety-paused, stopped, recovering - and a confirmed loss takes the normal terminal path (TARGET_LOST, capture
 * revoked, scheduler registration invalidated, queued input rejected, running input cancelled, driver authorisation revoked) whether the
 * table was playing or paused. The monitor never resumes gameplay or authorises input. An action that was delivered but not applied
 * ("no state change") now SAFETY_PAUSES the table (cause input-rejected) instead of leaving a gameplay pause behind an ACTIVE lifecycle,
 * and every input that was sent but not confirmed leaves a complete evidence record (unconfirmedInputs; section 4.4 of the brief).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./hand-state.js'), require('./solver-service.js'), require('./test-executor.js'), require('./execution-adapters.js'), require('./vision-ocr.js'), require('./sim-display.js'), require('./image-codec.js'), require('./status-strip.js'), require('./windows-input-driver.js'), require('./input-scheduler.js'), require('./input-geometry.js'), require('./input-motion.js'), require('./full-hand.js'), require('./window-lifecycle.js'), require('./action-timeline.js'), require('./recognition-check.js'));
  else root.WorkbenchSimulatorControls = factory(root.EightMax, root.WorkbenchHandState, root.WorkbenchSolverService, root.WorkbenchExecutor, root.WorkbenchExecutionAdapters, root.WorkbenchVisionOcr, root.WorkbenchSimDisplay, root.WorkbenchImageCodec, root.WorkbenchStatusStrip, root.WorkbenchInputDriver, root.WorkbenchInputScheduler, root.WorkbenchInputGeometry, root.WorkbenchInputMotion, root.WorkbenchFullHand, root.WorkbenchWindowLifecycle, root.WorkbenchActionTimeline, root.WorkbenchRecognitionCheck);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (EM, HS, SS, EX, XA, OCR, SIM, IC, STRIP, DRV, SCH, G, M, FH, LC, TL, RC) {
  'use strict';
  const mono = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (v, m) => { if (!v) throw new Error(m); };
  const b64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'base64') : Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

  /**
   * Authenticated client of the local desktop host (same session token as the dashboard). Bounded concurrency.
   * 0.36.2 M4.0: one RESERVED slot (beyond maxConcurrent) for priority requests - the emergency stop, stop, cancellations and the input
   * commands and revalidation capture of the job holding the cursor lease - so they never wait behind other tables' captures.
   * Priority requests also take a free normal slot first and are served before normal waiters. slotWait statistics are measured.
   */
  const PRIORITY_ROUTES = new Set(['/api/input/estop', '/api/input/stop']);
  class HostApi {
    constructor({ origin = 'http://127.0.0.1:48713', token, fetch: f, maxConcurrent = 6, timeoutMs = 30000, reservedPriority = 1, priorityLane = true }) { ok(typeof token === 'string' && /^[a-f0-9]{64}$/.test(token), 'Desktop session token required'); this.origin = origin; this.token = token; this.f = f || fetch; this.slots = maxConcurrent; this.waiters = []; this.timeoutMs = timeoutMs; this.priorityLane = priorityLane !== false; this.reserved = this.priorityLane ? Math.max(0, reservedPriority | 0) : 0; this.pwaiters = []; this.waitMs = { normal: [], priority: [] }; this.counts = { normal: 0, priority: 0, reservedUsed: 0 }; }
    _slot(priority) {
      if (this.slots > 0) { this.slots--; return Promise.resolve('n'); }
      if (priority && this.reserved > 0) { this.reserved--; this.counts.reservedUsed++; return Promise.resolve('r'); }
      return new Promise((r) => (priority ? this.pwaiters : this.waiters).push(r));
    }
    _free(kind) {
      if (kind === 'x') return;   // the emergency stop used no slot
      if (kind === 'r') { const w = this.pwaiters.shift(); if (w) w('r'); else this.reserved++; return; }
      const w = this.pwaiters.shift() || this.waiters.shift(); if (w) w('n'); else this.slots++;
    }
    /** 0.36.2 M4.0: slot-wait statistics (milliseconds) of normal and priority requests. */
    slotStats() { const st = SCH.stats; return { normal: st(this.waitMs.normal.slice()), priority: st(this.waitMs.priority.slice()), counts: { ...this.counts } }; }
    async request(path, body, timeoutMs, o = {}) {
      ok(/^\/api\/(input\/(command|status|estop|restart|stop|settings)|capture\/(windows|monitors|open|frame|close)|desktop\/(health|launch))$/.test(path), 'Route not used by Simulator Controls: ' + path);
      // the emergency stop never waits for a slot (the host accepts 8 connections; this client uses at most maxConcurrent + 1 otherwise)
      // priorityLane:false = exactly Milestone 3.2 (one FIFO queue for every request; used by the compat-3.2 comparison runs)
      const priority = this.priorityLane && (o.priority === true || PRIORITY_ROUTES.has(path)), t0 = mono(); const kind = this.priorityLane && path === '/api/input/estop' ? 'x' : await this._slot(priority); const waited = mono() - t0;
      const wl = priority ? this.waitMs.priority : this.waitMs.normal; wl.push(waited); if (wl.length > 5000) wl.shift(); this.counts[priority ? 'priority' : 'normal']++;
      if (typeof o.onSlot === 'function') { try { o.onSlot(mono(), waited); } catch (e) { /* measurement only */ } }
      try {
        const ctl = typeof AbortController === 'function' ? new AbortController() : null, timer = ctl ? setTimeout(() => ctl.abort(), (timeoutMs || this.timeoutMs) + 5000) : null;
        try {
          const r = await this.f(this.origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-EightMax-Session': this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl ? ctl.signal : undefined, cache: 'no-store' });
          const text = await r.text(); let v; try { v = JSON.parse(text); } catch (e) { throw new Error('Host returned invalid JSON for ' + path); }
          if (!r.ok) { const e = new Error(v && v.error || 'Host refused ' + path); e.code = v && v.code; e.status = r.status; throw e; }
          return v;
        } finally { if (timer) clearTimeout(timer); }
      } finally { this._free(kind); }
    }
  }
  /** 0.36.2 M4.0: driver commands that use the priority slot (input of the lease holder, cancellations). Read-only queries do not. */
  const PRIORITY_COMMANDS = new Set(['move-click', 'click', 'double-click', 'move', 'enter-text', 'focus', 'key', 'type', 'clear-field', 'mouse-down', 'mouse-up', 'cancel', 'cancel-all', 'estop', 'release-all']);
  /** A DriverSession whose commands travel through the host broker. */
  function hostSession(api) {
    const t = DRV.hostTransport((path, msg) => api.request(path, msg, msg.timeoutMs, { priority: PRIORITY_COMMANDS.has(msg && msg.cmd) }).catch((e) => ({ ok: false, code: e.code || 'host-error', error: e.message })));
    const s = new DRV.DriverSession(t); s.helloed = true; return s;
  }

  /** Window capture through the host: returns {ok, image, bounds, title, frameId, at} after decoding and size checks. */
  class HostWindowCapture {
    constructor(api, target, o = {}) { this.api = api; this.target = { kind: 'window', hwnd: target.hwnd, pid: target.pid, title: target.title, method: o.method || 'print-window' }; this.opened = false; this.frames = 0; this.failures = 0; this.decode = o.decode || (async (png) => IC.decodePng(b64(png))); }
    async open() { if (this.revoked) return { ok: false, code: 'target-lost', reason: this.revoked }; const r = await this.api.request('/api/capture/open', { target: this.target, consent: true }); this.opened = !!(r && r.ok); return r; }
    /** 0.36.2 M2: after a confirmed loss no request for this handle ever reaches the host again (the handle may be reused). */
    revoke(reason) { this.revoked = reason || 'target lost'; }
    /**
     * o (0.36.2 M4.0, optional): region {x, y, width, height} in client pixels - a strip-only capture (the host captures the window as
     * always and returns only that part; a host without region support returns the whole frame, which is equally valid);
     * priority (the request uses the priority slot); timeline (marks capture-begin / capture-end).
     */
    async grab(o = {}) {
      if (this.revoked) { this.refusedLocally = (this.refusedLocally || 0) + 1; return { ok: false, code: 'target-lost', reason: 'capture revoked: ' + this.revoked, local: true }; }
      if (this.inject) { const f = this.inject(); if (f) { this.failures++; return { ok: false, code: f.code || 'injected-transient', reason: f.reason || 'injected fault', minimized: !!f.minimized, injected: true }; } }
      const t0 = mono(), tl = o.timeline || null; let slotAt = null, r;
      const body = o.region ? { target: this.target, region: o.region } : { target: this.target };
      try { r = await this.api.request('/api/capture/frame', body, undefined, { priority: o.priority === true, onSlot: (t) => { slotAt = t; if (tl) tl.mark('capture-begin', t); } }); } catch (e) { this.failures++; return { ok: false, code: e.code || 'capture-failed', reason: e.message, requestedAt: t0, failedAt: mono() }; }
      if (!r || r.ok !== true) { this.failures++; return { ok: false, code: r && r.code || 'capture-failed', reason: r && r.reason || 'no frame', minimized: r && r.minimized, requestedAt: t0, failedAt: mono() }; }   // 0.36.2 M3.2: when it was asked and when the failure was known
      const repliedAt = mono(); let image; try { image = await this.decode(r.png); } catch (e) { this.failures++; return { ok: false, code: 'decode-failed', reason: e.message }; }
      if (image.width !== r.width || image.height !== r.height) { this.failures++; return { ok: false, code: 'size-mismatch', reason: 'decoded size differs' }; }
      const crop = r.crop && Number.isInteger(r.crop.width) ? { x: r.crop.x, y: r.crop.y, width: r.crop.width, height: r.crop.height } : null;
      this.frames++; if (crop) this.crops = (this.crops || 0) + 1;   // frames: every successful capture (as before); crops: the strip-only ones among them
      const at = mono(); if (tl) tl.mark('capture-end', at);
      return { ok: true, image, crop, bounds: r.bounds, title: r.title || (r.target && r.target.title), frameId: r.frameId, method: r.method, dpiScale: r.dpiScale, at, captureMs: at - t0,
        timing: { requestedAt: t0, slotAt, repliedAt, decodedAt: at, slotWaitMs: slotAt === null ? null : slotAt - t0, hostMs: Number.isFinite(r.ageMs) ? r.ageMs : null, decodeMs: at - repliedAt } };
    }
    async close() { try { await this.api.request('/api/capture/close', { target: this.target }); } catch (e) { /* host gone */ } }
  }

  /** The calibrated reader for one table (templates come from the controlled renderer; never from the oracle). */
  const readerCache = new Map(), BASE_WIDTHS = Object.freeze([800, 960, 1280, 1440, 1920]);
  /**
   * 0.36.2 M4.0: templates for the window's EXACT client width as well. A width between the calibrated ones (1024, 1366, 1600 px ...)
   * was read correctly before, but only after a +/-2 px search for every card (2-3x the recognition time); with templates rendered at
   * that width by the same controlled renderer the first comparison matches. Only the extra width is rendered (about 0.2-0.4 s, once per
   * width); its templates are added to a copy of the base set, so the base widths keep exactly the Milestone 3.2 templates.
   */
  function calibrated(seats, width) {
    let base = readerCache.get(seats); if (!base) { base = SIM.calibrate(BASE_WIDTHS, SIM.layoutFor(seats, true)); readerCache.set(seats, base); }
    if (!Number.isInteger(width) || width < 800 || width > 4096 || BASE_WIDTHS.includes(width)) return base;
    const key = seats + '@' + width; let cal = readerCache.get(key);
    if (!cal) { const extra = SIM.calibrate([width], SIM.layoutFor(seats, true)), cards = new OCR.CardTemplates(), glyphs = new OCR.GlyphTemplates(); cards.t = base.cards.t.concat(extra.cards.t); glyphs.t = base.glyphs.t.concat(extra.glyphs.t); cal = { profiles: base.profiles, cards, glyphs, exactWidth: width }; readerCache.set(key, cal); }
    return cal;
  }
  function tableReader(tableId, seats = 8, width) { const cal = calibrated(seats, width); const r = new OCR.ImageObserver({ table: tableId, profiles: cal.profiles, cards: cal.cards, glyphs: cal.glyphs, seats }); r.calibratedWidths = cal.exactWidth ? BASE_WIDTHS.concat([cal.exactWidth]).sort((a, b) => a - b) : BASE_WIDTHS.slice(); return r; }

  const DEFAULTS = Object.freeze({ maxRefusalsInRow: 4, maxObservationAgeMs: 2500, postActionTimeoutMs: 4000, pollMs: 60, decisionWindowMs: 12000, idlePollMs: 120, maxConsecutiveRejects: 40, revalidate: 'capture',
    // 0.36.2 M2 lifecycle: bounded backoff for temporary capture failures, fresh readings needed after an interruption, periodic identity check
    retryBaseMs: 250, retryMaxMs: 4000, maxRetryAttempts: 120, maxUnavailableMs: 300000, recoveryReadings: 2, identityCheckMs: 5000,
    // 0.36.2 M3.2: window-health monitor - identity probe interval while gameplay is paused / stopped / not ACTIVE; evidence per unconfirmed input
    pausedIdentityCheckMs: 1000, stoppedIdentityCheckMs: 5000, activeIdentitySlackMs: 2500, maxUnconfirmedEvidence: 20, evidenceProbeMs: 2500,
    // 0.36.2 M4.0: input pipeline profile ('compat-3.2' = exactly Milestone 3.2; 'optimized' = see PIPELINE below) and recognition
    // templates for the window's exact width (base widths unchanged)
    pipeline: 'compat-3.2', exactWidthTemplates: true, stripPollMs: 30 });
  /**
   * 0.36.2 M4.0: what each input pipeline profile does on the table side (the driver side is DRV.PIPELINE_PROFILES):
   *   revalidate   'full'  - the in-lease revalidation captures the whole window (Milestone 3.2)
   *                'strip' - for a window with a status strip it captures only the strip (same checks: window rectangle unchanged, same
   *                          table, same frame revision); a window without a strip, or a host without region captures, gets 'full'
   *   confirmPoll  'full'  - every confirmation poll captures the whole window (Milestone 3.2)
   *                'strip' - polls capture only the strip until its revision changes; the new frame is then captured whole and read
   *                          completely before anything is confirmed (the same comparison as before)
   */
  // 0.36.2 M4.0 deadlineAnchor: 'frame' = the decision deadline counts from the capture the decision was read from (Milestone 3.2);
  // 'change' = from the request of the last capture that still showed the PREVIOUS status-strip revision - the turn began after it, so a
  // table clock that started with the turn cannot run out before the deadline (a later first reading no longer extends the deadline)
  const PIPELINE = Object.freeze({ 'compat-3.2': Object.freeze({ revalidate: 'full', confirmPoll: 'full', deadlineAnchor: 'frame' }), 'optimized': Object.freeze({ revalidate: 'strip', confirmPoll: 'strip', deadlineAnchor: 'change' }) });
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
      // 0.36.2 M4.0: input pipeline profile, action timelines (shared aggregator when the caller passes one), exact-width templates
      this.pipelineName = o.pipeline || this.opt.pipeline; ok(PIPELINE[this.pipelineName], 'Unknown input pipeline profile ' + this.pipelineName); this.pipe = PIPELINE[this.pipelineName];
      this.timelines = o.timelines || new TL.TimelineAggregator(); this._tl = null; this._tlSeq = 0;
      this.readerWidth = this.opt.exactWidthTemplates && o.window && o.window.client && Number.isInteger(o.window.client.w) ? o.window.client.w : undefined;
      this.reader = tableReader(o.id, 8, this.readerWidth); this.engine = this._freshEngine();
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
      // 0.36.2 M3.2: the window-health monitor verifies the REGISTERED identity in every non-terminal state, also while gameplay is paused;
      // it reports a confirmed loss to targetLost() and nothing else - it never resumes gameplay and never authorises input
      this.health = new LC.WindowHealthMonitor({ lifecycle: this.lc, probe: () => this._probe('health-monitor'), onLoss: (cause) => { this.targetLost(cause); },
        gameplayHeld: () => (this.stopped || this.completed ? 'stopped' : !!this.paused), activeIntervalMs: this.opt.identityCheckMs, activeSlackMs: this.opt.activeIdentitySlackMs, pausedIntervalMs: this.opt.pausedIdentityCheckMs, stoppedIntervalMs: this.opt.stoppedIdentityCheckMs,
        onEvent: (kind, d) => { if (kind !== 'unknown' || (this.health && this.health.unknownInRow === 1)) this._diag('lifecycle', { kind: 'health-' + kind, ...(d || {}) }); } });
      this.unconfirmed = []; this._lastImage = null; this.onUnconfirmed = o.onUnconfirmed || null;
      // 0.36.2 M3.2: the scheduler knows this table's CURRENT registration (a replacement window is a new registration; a lost one stays refused)
      this.schedRegistration = this.sched && typeof this.sched.registerTable === 'function' ? this.sched.registerTable(o.id, this.registrationId) : null;
      const e = o.profile.execution || {}, controls = { ...(o.profile.layout.controls || {}), ...(e.controls || {}) }; this.controls = controls; this.amountField = e.amountField || null;
      this.driver = new DRV.WindowsUiDriver({ session: o.session, hwnd: o.window.hwnd, motion: o.motion, movement: o.movement, timing: o.timing, focusPolicy: o.focusPolicy, expectClient: () => this.lastFrame && this.lastFrame.client, onTrace: (ev) => this._diag('execution', ev),
        identity: o.identity ? () => this.identity : null, guard: () => this._inputGuard(this._activeToken), pipeline: this.pipelineName });
      // 0.36.2 M4.0: `from` (optional) = the cursor point the estimate starts at (a distance-aware scheduling policy asks at dispatch time)
      this.driver.estimateFor = (region, box, wager, from) => { const c = this.lastFrame && this.lastFrame.client; if (!c) return 0; let ms = this.driver.estimateMs(box, c, from); if (wager) ms += this.driver.estimateMs(e.amountField, c) + this.driver.estimateTypingMs(wager.text); return ms; };
      this.adapter = new XA.UiAutomationAdapter({ authorization: o.qaAuthorization, now: () => Date.now(), driver: this.driver, controls, amountField: e.amountField, amountConvention: e.amountConvention, chipUnit: e.chipUnit, scheduler: o.scheduler, deadlineMs: this.opt.decisionWindowMs, controlledFixture: o.profile.verification && o.profile.verification.status === 'controlled-renderer' && e.controlledFixture === true, table: o.id });
      this.executor = new EX.TestExecutor({ stateOf: () => ({ state: this.engine.state, paused: this.engine.paused || !!this.paused, pauseReason: this.engine.pauseReason || this.paused, revision: this.engine.revision }), now: () => Date.now(), maxActionAgeMs: this.opt.decisionWindowMs, hrnow: mono });
      this.executor.setMode('qa', { authorization: o.qaAuthorization }); this.executor.attach(o.id, this.adapter);
      this.m = { frames: 0, rejectedFrames: 0, decisions: 0, scripted: 0, solver: 0, unavailable: 0, attempted: 0, confirmed: 0, rejected: 0, ambiguous: 0, timedOut: 0, cancelled: 0, blocked: 0, deadline: 0, errors: 0, e2e: [], cursor: [], input: [], wait: [], confirmMs: [], focusErrors: 0, driverErrors: 0,
        captureFailuresByCode: {}, transientFailures: 0, lossSignals: 0, uncertain: 0, cancelledByLoss: 0, staleDiscarded: 0, recoveries: 0, backoffWaits: 0, probes: 0, manualOverrides: 0, emergencyStops: 0, strategyUnavailable: 0,
        verifyingSteps: 0, handRecoveries: 0, eliminationsSeen: 0, inputRejectedNoChange: 0, scheduleWait: [], unconfirmedEvidence: 0, deadlineAnchorSlackMs: [] };
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
        if (this.lc.is(LS.SAFETY_PAUSED)) return this._condition(cause.kind === 'emergency-stop' ? 'emergency-stop' : cause.kind === 'manual-override' ? 'manual-override' : cause.kind === 'unconfirmed-input' || cause.kind === 'input-rejected' ? 'input-confirmation-failure' : cause.kind === 'exhausted' || cause.kind === 'configuration' ? 'capture-unavailable' : 'paused', cause.reason || why);
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
        return this._condition(e.status === 'uncertain' || e.status === 'unconfirmed' || e.inputClass === 'rejected-no-change' ? 'input-confirmation-failure' : 'playing', e.reason || null);
      }
      if (k === 'error') return this._condition('paused', r.reason || null);
    }
    _diag(stage, detail) { if (this.rec) { try { this.rec.record(this.id, stage, { hwnd: this.win.hwnd, hand: this.state && this.state.hand, revision: this.engine.revision, ...detail }); } catch (e) { /* bounded recorder */ } } }
    // 0.36.2 M3.2: the scheduler pause names this registration, so a replacement window (new registration) is never blocked by it
    pause(reason) { this.paused = reason; this.executor.pauseTable(this.id, reason); if (this.sched) this.sched.pauseTable(this.id, reason, this.registrationId); this._diag('system', { kind: 'pause', reason }); }
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
    _probe(by = 'table', o = {}) {
      // 0.36.2 M3.2: a probe that STARTED before the event it must judge (a capture failure that was already known) may have read the window
      // before it closed: wait for it, then ask again (a window closed during an identity probe must not be judged by that probe's answer)
      if (this._probing && o.freshAfter !== undefined && this._probingStartedAt < o.freshAfter) { const prev = this._probing; return prev.then(() => this._probe(by, o), () => this._probe(by, o)); }
      if (!this._probing) {
        this.m.probes++; const t0 = mono(); this._probingStartedAt = t0;
        // 0.36.2 M3.2: every probe is evidence for the health monitor (a table that is playing is not probed twice)
        const p = LC.probeIdentity(this.s, this.identity).then((r) => { if (by !== 'health-monitor' && this.health) this.health.noteProbe(t0, r, false); return r; });
        const q = p.finally(() => { if (this._probing === q) this._probing = null; }); this._probing = q;
      }
      return this._probing;
    }
    /** 0.36.2 M3.2: start the window-health monitor (run() does it; the dashboard may call it for a registered table that is not running). */
    startMonitoring() { if (this.lc.terminal || this._disposed) return false; return this.health.start(); }
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
      const before = { state: this.lc.state, generation: this.lc.generation, gameplayHeld: !!this.paused || this.stopped || !!this.completed, paused: this.paused || null };
      const r = this.lc.transition(LS.TARGET_LOST, { kind: cause.kind || 'window-closed', code: cause.code || 'target-lost', reason: cause.reason || 'The window no longer exists.', source: cause.source || null });
      if (!r.ok) return { kind: 'lost', refused: r.refused };
      // 0.36.2 M3.2: the state the loss interrupted (ACTIVE, a gameplay pause, SAFETY_PAUSED, STOPPED ...) is kept for the report
      this.lost = { kind: cause.kind || 'window-closed', code: cause.code || 'target-lost', reason: cause.reason || 'The window no longer exists.', at: new Date().toISOString(), source: cause.source || null, previousState: before.state, previousGeneration: before.generation, gameplayHeldAtLoss: before.gameplayHeld, gameplayPauseAtLoss: before.paused };
      if (this.health) this.health.stop('target lost'); this._activeToken = null;
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
      const p = await this._probe('capture', { freshAfter: g.failedAt });   // only a probe that started after the failure was known may judge it
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
      const p = await this._probe('confirmation', { freshAfter: g.failedAt }); if (this.lc.terminal) return { kind: 'lost' };
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
    /**
     * 0.36.2 M3.2: EVIDENCE of an input that was sent (or may have been) but was not confirmed - table, registration, window handle and
     * identity fingerprint, action, expected control region, selected screen point, display scaling, client rectangle, foreground state,
     * driver result, scheduler lease, confirmation timeout and what the confirmation saw (polls, status-strip revisions, new frames, the
     * final fresh reading), frame revisions before / after, and the input status. Read-only: it sends no input and resumes nothing; one
     * bounded window-info probe records the window right after the confirmation window (a window that is gone takes the normal terminal
     * path). No session token and no desktop content outside the registered window is kept; the two frames of the window itself are kept
     * in memory only (non-enumerable `images`, so they never enter a JSON log) for a test tool to save.
     */
    async _recordUnconfirmed({ entry, x, decision, st, frame, confirmation, tStart, beforeImage }) {
      const c = confirmation || {}, tr = c.trace || null, inp = x.input || {}, id = this.identity || {}, r1 = (v) => (Number.isFinite(v) ? Math.round(v) : null);
      let after = null;
      if (!this.lc.terminal) {
        let timer = null; const p = await Promise.race([this._probe('evidence'), new Promise((r) => { timer = setTimeout(() => r(null), this.opt.evidenceProbeMs); })]); clearTimeout(timer);
        if (!p) after = { exists: null, code: 'probe-timeout', reason: 'window-info did not answer within ' + this.opt.evidenceProbeMs + ' ms' };
        else if (p.exists === true) after = { exists: true, matches: !!p.matches, foreground: p.window ? p.window.foreground === true : null, minimized: !!p.minimized, visible: p.visible !== false, cloaked: !!p.cloaked, enabled: p.window ? p.window.enabled !== false : null, client: (p.window && p.window.client) || null, dpiScale: p.window ? Number(p.window.dpiScale) || null : null, monitor: p.window && p.window.monitor !== undefined ? p.window.monitor : null };
        else after = { exists: p.exists, code: p.code || null, reason: p.reason || null };
        if (p && p.exists === false) this.targetLost({ kind: 'window-closed', code: 'target-lost', reason: 'The window no longer exists (found while recording an unconfirmed input).', source: 'confirmation-evidence' });
        else if (p && p.exists === true && !p.matches) this.targetLost({ kind: 'identity-changed', code: 'identity-changed', reason: 'The window no longer matches the registered simulator: ' + p.problems.join('; '), source: 'confirmation-evidence' });
      } else after = { exists: false, code: 'target-lost', reason: this.lost && this.lost.reason };
      const fp = [LC.normHwnd(this.win.hwnd), id.pid, id.processStart, id.className, id.exeSha256].join('|'); let h = 0x811c9dc5; for (let i = 0; i < fp.length; i++) { h ^= fp.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      const sched = x.schedule || null, region = inp.region || null;
      const rec = {
        format: 'eightmax-unconfirmed-input', version: 1, seq: ++this.m.unconfirmedEvidence, at: new Date().toISOString(),
        table: this.id, registrationId: this.registrationId, hwnd: this.win.hwnd, identityFingerprint: ('0000000' + h.toString(16)).slice(-8),
        identity: { pid: id.pid, processStart: id.processStart, className: id.className, exe: id.exe ? String(id.exe).split(/[\\/]/).pop() : null, exeSha256Prefix: id.exeSha256 ? String(id.exeSha256).slice(0, 16) : null },
        hand: st.hand, street: st.street, seat: st.actor, action: entry.action || (entry.intended ? { type: entry.intended.type, amount: entry.intended.amount } : null), decisionSource: decision.source, decisionLabel: decision.label || null,
        inputStatus: entry.inputClass, status: entry.status, reason: entry.reason, code: x.code || null,
        control: region, expectedRegion: region && this.controls[region] ? { normalized: { ...this.controls[region] }, clickRect: inp.rect || null } : null, selectedPoint: inp.point || null, clickedAt: inp.clickedAt || null, hit: inp.hit || null, hitClass: inp.hitClass || null,
        displayScaling: (after && after.dpiScale) || frame.dpiScale || id.dpiScale || null, clientAtReading: frame.client || null, clientAfter: (after && after.client) || null, windowAfter: after,
        driver: { reported: x.inputSent === true ? 'input completed (driver reply ok)' : x.inputMayHaveHappened ? 'refused or failed after the press may have happened' : 'not sent', plannedMs: inp.plannedMs, actualMs: inp.actualMs, steps: inp.steps, finalError: inp.finalError, distance: inp.distance, doubleClickGuardMs: inp.doubleClickGuardMs, maxObservedLag: inp.maxObservedLag,
          // 0.36.2 M4.0 (evidence, additive): the click reply's pipeline fields - the press guard's view of the press (async state seen, the
          // window and control under the cursor, whether the control took the mouse capture), the capture barrier and the drain - and the
          // wall-clock time of the reply, so the press can be lined up with the simulator's own record
          pipeline: inp.pipeline || null, guardScope: inp.guardScope || null, press: inp.press || null, captureReleased: inp.captureReleased === undefined ? null : inp.captureReleased, captureReleaseMs: inp.captureReleaseMs === undefined ? null : inp.captureReleaseMs,
          drained: inp.drained === undefined ? null : inp.drained, drainMs: inp.drainMs === undefined ? null : inp.drainMs, repliedAtWallMs: inp.timing && Number.isFinite(inp.timing.repliedAt) ? Math.round(Date.now() - (mono() - inp.timing.repliedAt)) : null },
        scheduler: sched ? { leaseId: sched.leaseId == null ? null : sched.leaseId, waitedMs: r1(sched.waitedMs), runMs: r1(sched.runMs) } : null,
        confirmation: { status: c.status || null, reason: c.reason || null, timeoutMs: this.opt.postActionTimeoutMs, ...(tr || {}) },
        frames: { before: { frameId: frame.frameId === undefined ? null : frame.frameId, revision: frame.strip ? frame.strip.revision : null, ageAtSubmitMs: r1(tStart - frame.at) }, after: tr ? { lastFrameId: tr.lastFrameId, revisionsSeen: tr.revisionsSeen, finalReading: tr.finalReading } : null },
        timeline: { readToSubmitMs: r1(tStart - frame.at), queueWaitMs: sched ? r1(sched.waitedMs) : null, inputRunMs: sched ? r1(sched.runMs) : null, confirmMs: tr ? tr.durationMs : null, totalMs: r1(mono() - tStart) },
        lifecycleAfter: this.lc.state,   // (an acceptance tool grading the controlled fixture adds the fixture's own record to ITS copy)
      };
      Object.defineProperty(rec, 'images', { value: { before: beforeImage || null, after: this._confirmImage || this._lastImage || null }, enumerable: false, writable: true });
      this.unconfirmed.push(rec); while (this.unconfirmed.length > this.opt.maxUnconfirmedEvidence) this.unconfirmed.shift();
      for (let i = 0; i < this.unconfirmed.length - 4; i++) this.unconfirmed[i].images = null;   // frames only for the latest four records
      this._diag('ack', { kind: 'unconfirmed-input', ...JSON.parse(JSON.stringify(rec)) });
      if (this.onUnconfirmed) { try { this.onUnconfirmed(rec, this); } catch (e) { /* tool hook */ } }
      return rec;
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
      // 0.36.2 M4.0: a window that now has another width reads with templates for that width (the controlled renderer draws them)
      if (this.opt.exactWidthTemplates && client && Number.isInteger(client.w) && client.w !== this.readerWidth) { this.readerWidth = client.w; this.reader = tableReader(this.id, 8, client.w); }
    }
    _calibrationOk(client) {
      if (!client) return { ok: false, reason: 'no client rectangle' };
      for (const k of ['fold', 'check', 'call', 'raise']) { const b = this.controls[k]; if (!b) return { ok: false, reason: k + ' not calibrated' }; const t = G.regionToScreen(b, client); if (!t.ok) return { ok: false, reason: k + ': ' + t.reason }; }
      if (this.amountField) { const t = G.regionToScreen(this.amountField, client); if (!t.ok) return { ok: false, reason: 'wager field: ' + t.reason }; }
      return { ok: true };
    }

    /** Capture + read + reconstruct. {state, frame} | {reject}. */
    /** 0.36.2 M4.0: a status-strip revision seen in a capture requested at `requestedAt` (monotonic ms). When the revision changes, the change
     *  happened after the last capture that still showed the previous one; that capture's REQUEST time is a strict lower bound (its pixels
     *  were taken after it). */
    _noteRevision(rev, requestedAt) {
      if (!Number.isInteger(rev) || !Number.isFinite(requestedAt)) return; const r = this._rev;
      if (!r || r.value !== rev) this._rev = { value: rev, changedAfterAt: r ? r.lastAt : null, lastAt: requestedAt }; else if (requestedAt > r.lastAt) r.lastAt = requestedAt;
    }
    /** 0.36.2 M4.0: when the decision deadline starts (see PIPELINE deadlineAnchor); never later than the decision frame itself. */
    _deadlineAnchor(frame) {
      const mode = this.opt.deadlineAnchor || this.pipe.deadlineAnchor || 'frame', c = frame.changedAfterAt;
      return mode === 'change' && Number.isFinite(c) && c <= frame.at ? c : frame.at;
    }
    async look() {
      const gen = this.lc.generation;
      // 0.36.2 M4.0: every reading starts a timeline; it is kept only when this reading leads to an action (measurement only)
      const tl = new TL.ActionTimeline({ table: this.id, id: ++this._tlSeq }); tl.mark('capture-queued'); this._tl = tl;
      const g = await this.capture.grab({ timeline: tl }); this.m.frames++;
      if (this.lc.terminal) return { reject: 'target lost', code: 'target-lost', lifecycle: { kind: 'lost' } };   // a result that arrived after the loss is discarded
      if (!g.ok) { this.m.rejectedFrames++; this._diag('capture', { ok: false, code: g.code, reason: g.reason }); const f = await this._captureFailed(g); return { reject: 'capture ' + g.code + ': ' + g.reason, code: g.code, lifecycle: f }; }
      if (this.lc.generation !== gen) return { reject: 'the table lifecycle changed while capturing; frame discarded', code: 'stale-frame' };
      this.lc.noteSuccess(); if (this.rec && this.rec.success) this.rec.success(this.id, 'capture');
      if (this.lc.is(LS.TEMPORARILY_UNAVAILABLE)) { this.lc.transition(LS.RECOVERY_PENDING, { kind: 'capture-restored', reason: 'capture works again; verifying identity and reading a fresh state' }); this.retry.reset(); this._discardStale('capture restored'); }
      const client = { x: g.bounds.x, y: g.bounds.y, w: g.bounds.width, h: g.bounds.height }, frame = { client, at: g.at, frameId: g.frameId, title: g.title };
      // 0.36.2 M4.0: a print-window / screen-copy frame IS the client area at physical size; anything else (a DPI-virtualised, scaled or
      // cropped image) is refused, never stretched onto the client rectangle (the other methods return the whole window and are unchanged)
      if ((g.method === 'print-window' || g.method === 'screen-copy') && !g.crop && (g.image.width !== client.w || g.image.height !== client.h)) { this.m.rejectedFrames++; this._diag('capture', { ok: false, code: 'scaled-capture', image: [g.image.width, g.image.height], client: [client.w, client.h] }); return { reject: 'geometry: the captured image is ' + g.image.width + 'x' + g.image.height + ' but the client area is ' + client.w + 'x' + client.h + ' physical pixels', code: 'scaled-capture' }; }
      if (this.win.title && !(g.title || '').startsWith(this.win.title)) return { reject: 'wrong window: the title no longer starts with ' + JSON.stringify(this.win.title) };
      let view = this.profile.layout.heroSeat || 0, rev; tl.mark('recognition-begin');
      if (this.strip) { const st = STRIP.read(g.image); if (!st.ok) { this.m.rejectedFrames++; this._diag('recognition', { ok: false, reasons: ['status strip: ' + st.reason] }); return { reject: 'status strip: ' + st.reason }; } if (st.table !== this.id) return { reject: 'wrong table: the window shows table ' + st.table }; view = st.viewSeat; rev = st.revision; frame.strip = st; this._noteRevision(st.revision, g.timing ? g.timing.requestedAt : g.at); frame.changedAfterAt = this._rev ? this._rev.changedAfterAt : null; }
      const r = this.reader.observe(g.image, { heroSeat: view, capturedAt: Date.now() }); tl.mark('recognition-end');
      if (!r.ok) { this.m.rejectedFrames++; this._diag('recognition', { ok: false, reasons: r.reasons.slice(0, 3) }); return { reject: 'recognition: ' + r.reasons.slice(0, 2).join('; ') }; }
      if (this.rec && this.rec.success) this.rec.success(this.id, 'recognition');
      if (rev !== undefined) r.observation.simRevision = rev;
      const x = this.engine.ingest(r.observation);
      if (!x.accepted) { this.m.rejectedFrames++; this._diag('state', { ok: false, issues: x.issues.slice(0, 3) }); return { reject: 'state: ' + x.issues.map((i) => i.code).join(', '), issues: x.issues }; }
      tl.mark('state-validated'); if (g.timing) tl.set('capture', { slotWaitMs: g.timing.slotWaitMs, hostMs: g.timing.hostMs, decodeMs: +g.timing.decodeMs.toFixed(2) });
      this.lastFrame = frame; this.state = x.state; this._lastImage = g.image; frame.dpiScale = g.dpiScale; this._diag('state', { ok: true, frameId: g.frameId, actor: x.state.actor, status: x.state.status, captureMs: g.captureMs });
      if (!this.lc.is(LS.ACTIVE)) await this._promote(this.lc.generation, client, g.dpiScale);
      return { state: x.state, frame, observation: r.observation, viewSeat: view, timeline: tl };
    }
    /** Re-capture inside the lease: the screen must still show the observed frame (same revision, same hand, same actor, same layout). */
    async _revalidate(st, frame, token) {
      if (this.paused) return { ok: false, reason: 'table paused' };
      if (token && !this.lc.valid(token)) return { ok: false, reason: 'target is ' + this.lc.state + ' (lifecycle changed since the reading)' };
      if (mono() - frame.at > this.opt.maxObservationAgeMs) { if (this.opt.revalidate !== 'capture') return { ok: false, reason: 'observation older than ' + this.opt.maxObservationAgeMs + ' ms' }; }
      if (this.opt.revalidate !== 'capture') return { ok: true };
      // 0.36.2 M4.0 optimized profile: a window with a status strip is revalidated from a strip-only capture - the same three checks
      // (window rectangle unchanged, same table, same frame revision) on a fresh capture taken inside the lease, at a fraction of the cost
      const region = this.pipe.revalidate === 'strip' && this.strip && frame.strip && frame.client ? STRIP.regionPx(frame.client.w, frame.client.h) : null;
      const g = await this.capture.grab({ region, priority: this.pipelineName === 'optimized' }); if (!g.ok) { await this._checkLoss(g); return { ok: false, reason: 'capture ' + g.code }; }
      if (this._tl && g.timing) this._tl.set('revalidationCapture', { crop: !!g.crop, slotWaitMs: g.timing.slotWaitMs, hostMs: g.timing.hostMs, decodeMs: +g.timing.decodeMs.toFixed(2) });   // 0.36.2 M4.0 (measurement)
      if (token && !this.lc.valid(token)) return { ok: false, reason: 'target is ' + this.lc.state };
      const c = { x: g.bounds.x, y: g.bounds.y, w: g.bounds.width, h: g.bounds.height }, f = frame.client;
      if (c.x !== f.x || c.y !== f.y || c.w !== f.w || c.h !== f.h) return { ok: false, reason: 'window moved or resized since the reading' };
      if (this.strip) { const s2 = g.crop ? STRIP.readCrop(g.image, g.crop, { width: g.bounds.width, height: g.bounds.height }) : STRIP.read(g.image); if (!s2.ok || s2.revision !== frame.strip.revision || s2.table !== this.id) return { ok: false, reason: 'the table changed since the reading' }; }
      if (!this.strip) { const latest=await this._readImage(g); if(!latest.state || latest.state.key!==st.key || latest.state.actor!==st.actor) return {ok:false,reason:'fresh observation differs from the decision state'}; }
      return { ok: true, crop: !!g.crop };
    }
    /** After input: capture until the frame changes, then compare. A window lost after the click makes the action UNCERTAIN.
     *  0.36.2 M3.2: the same logic, plus a trace of what the confirmation saw (polls, failed captures, status-strip revisions, new frames,
     *  unreadable frames, the final reading) - the evidence of an unconfirmed input. A stale observation never confirms anything. */
    async _confirm(sent, before, beforeFrame, deadline, tl) {
      const t0 = mono(), startRev = beforeFrame && beforeFrame.strip ? beforeFrame.strip.revision : null; if (tl) tl.mark('confirm-begin', t0);
      const tr = { timeoutMs: this.opt.postActionTimeoutMs, pollMs: this.opt.pollMs, polls: 0, failedCaptures: 0, failureCodes: {}, newFrames: 0, unreadableNewFrames: 0, startRevision: startRev, revisionsSeen: [], firstPollMs: null, lastFrameId: null, finalReading: null, stripPolls: 0 };
      const done = (r) => { tr.durationMs = Math.round(mono() - t0); r.trace = tr; if (tl && r.confirmed === true) tl.mark('state-confirmed'); return r; };
      const lostAfterInput = (why) => done({ confirmed: false, status: 'uncertain', reason: 'the window was lost after the input was sent' + (why ? ' (' + why + ')' : '') + '; delivery cannot be confirmed', uncertain: true });
      // 0.36.2 M4.0 optimized profile: strip-only polls until the strip shows a new revision; that frame is then captured whole
      const stripRegion = this.pipe.confirmPoll === 'strip' && this.strip && startRev !== null && beforeFrame.client ? STRIP.regionPx(beforeFrame.client.w, beforeFrame.client.h) : null;
      // strip-only polls are cheap: they poll every stripPollMs (default 30 ms); full-frame polls keep pollMs (the timeout is unchanged)
      const pollMs = stripRegion ? Math.min(this.opt.pollMs, this.opt.stripPollMs) : this.opt.pollMs; tr.pollMs = pollMs;
      while (mono() - t0 < this.opt.postActionTimeoutMs) {
        if (this.lc.terminal) return lostAfterInput();
        if (this.stopped) return done({ confirmed: false, status: 'cancelled', reason: 'stopped' });
        await sleep(pollMs);
        let g = await this.capture.grab(stripRegion ? { region: stripRegion } : {}); tr.polls++; if (tr.firstPollMs === null) tr.firstPollMs = Math.round(mono() - t0);
        if (!g.ok) { tr.failedCaptures++; tr.failureCodes[g.code] = (tr.failureCodes[g.code] || 0) + 1; const f = await this._checkLoss(g); if (f && f.kind === 'lost') return lostAfterInput(g.code); continue; }
        if (g.crop) {
          tr.stripPolls++; const sc = STRIP.readCrop(g.image, g.crop, { width: g.bounds.width, height: g.bounds.height });
          if (sc.ok && tr.revisionsSeen[tr.revisionsSeen.length - 1] !== sc.revision && tr.revisionsSeen.length < 20) tr.revisionsSeen.push(sc.revision); if (sc.ok) this._noteRevision(sc.revision, g.timing ? g.timing.requestedAt : g.at);
          if (!sc.ok || sc.revision === startRev) continue;
          g = await this.capture.grab(); if (!g.ok) { tr.failedCaptures++; tr.failureCodes[g.code] = (tr.failureCodes[g.code] || 0) + 1; const f = await this._checkLoss(g); if (f && f.kind === 'lost') return lostAfterInput(g.code); continue; }
        }
        tr.lastFrameId = g.frameId; this._confirmImage = g.image;
        if (this.strip) { const st = STRIP.read(g.image); if (st.ok && tr.revisionsSeen[tr.revisionsSeen.length - 1] !== st.revision && tr.revisionsSeen.length < 20) tr.revisionsSeen.push(st.revision); if (st.ok) this._noteRevision(st.revision, g.timing ? g.timing.requestedAt : g.at); if (!st.ok || st.revision === beforeFrame.strip.revision) continue; }
        // a new frame: read it fully
        tr.newFrames++; const v = await this._readImage(g); if (!v.state) { tr.unreadableNewFrames++; continue; }
        const c = XA.confirmAction(sent, before, v.state); this.m.confirmMs.push(mono() - t0);
        tr.finalReading = { hand: v.state.hand, actor: v.state.actor, status: v.state.status, actions: v.state.actions.length, frameId: g.frameId };
        if (c.status === 'confirmed') return done({ confirmed: true, status: 'confirmed', observed: c.observed });
        return done({ confirmed: false, status: c.status, reason: c.reason, clean: c.status === 'rejected' });
      }
      if (this.lc.terminal) return lostAfterInput();
      // the frame never changed: the simulator ignored the input (rejected) - but say so only if a fresh reading shows the same actor
      const v = await this.look();
      if (v.state) {
        tr.finalReading = { hand: v.state.hand, actor: v.state.actor, status: v.state.status, actions: v.state.actions.length, frameId: v.frame && v.frame.frameId, revision: v.frame && v.frame.strip ? v.frame.strip.revision : null, freshLook: true };
        const c = XA.confirmAction(sent, before, v.state); if (c.status === 'confirmed') return done({ confirmed: true, status: 'confirmed', observed: c.observed });
        if (c.status === 'rejected') return done({ confirmed: false, status: 'rejected', clean: true, reason: 'no change within ' + this.opt.postActionTimeoutMs + ' ms; same actor still to act' });
      } else tr.finalReading = { freshLook: true, refused: v.reject || null, code: v.code || null };
      if (this.lc.terminal) return lostAfterInput();
      return done({ confirmed: false, status: 'timed-out', reason: 'no reliable reading within ' + this.opt.postActionTimeoutMs + ' ms' });
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
      const decision = await this._decision(st); const tl = v.timeline || null; if (tl) tl.mark('decision-ready');
      if (this.lc.terminal) return { kind: 'lost', reason: this.lost && this.lost.reason };
      if (this.stopped || this.paused) return {kind: 'paused', reason: this.paused || 'stopped'}; if (!decision) { this.pause('no EightMax decision: ' + this.lastDecisionReason); return { kind: 'unavailable', category: 'strategy-unavailable' }; }
      if (!this.lc.valid(token)) { this.m.staleDiscarded++; return { kind: 'stale', reason: 'the window lifecycle changed while deciding; decision discarded' }; }
      this.m.decisions++; const anchorAt = this._deadlineAnchor(v.frame), deadline = anchorAt + this.opt.decisionWindowMs, before = st, frame = v.frame;
      if (anchorAt < v.frame.at) { this.m.deadlineAnchorSlackMs.push(v.frame.at - anchorAt); if (this.m.deadlineAnchorSlackMs.length > 5000) this.m.deadlineAnchorSlackMs.shift(); }   // 0.36.2 M4.0 (measurement)
      this._diag('decision', { source: decision.source, recommended: decision.recommended, label: decision.label, frameId: frame.frameId });
      const sentRef = {}; this.m.attempted++;
      // Extend the adapter submission with the deadline and the in-lease revalidation (the executor passes `act` through).
      const origSubmit = this.adapter.submit.bind(this.adapter);
      this.adapter.submit = (act) => { sentRef.act = act; act.deadline = deadline; act.registrationId = this.registrationId; act.revalidate = () => this._revalidate(st, frame, token); act.guard = () => this._inputGuard(token); act.timeline = tl; return origSubmit(act); };
      const tStart = mono(); let x; this._activeToken = token; this._decisionImage = this._lastImage;
      try {
        x = await this.executor.execute(decision, { allowScripted: decision.source === 'scripted-fallback', verify: async ({ action }) => { const sent = { seat: st.actor, type: action.type === 'raise' ? 'raise' : action.type, amount: action.amount }; const c = await this._confirm(sent, before, frame, deadline, tl); this._diag('ack', { status: c.status, reason: c.reason }); this._lastConfirm = c; return c; } });
      } finally { this.adapter.submit = origSubmit; this._activeToken = null; }
      // a driver refusal that names the window gone / changed is a loss signal, confirmed like any other
      if (x && (x.code === 'window-gone' || x.code === 'identity-changed' || /window-gone|identity-changed/.test(x.reason || '')) && !this.lc.terminal) { const p = await this._probe(); if (p.exists === false) this.targetLost({ kind: 'window-closed', code: 'target-lost', reason: 'The window was closed while an action was prepared.', source: 'driver' }); else if (p.exists === true && !p.matches) this.targetLost({ kind: 'identity-changed', code: 'identity-changed', reason: 'The window no longer matches the registered simulator: ' + p.problems.join('; '), source: 'driver' }); }
      const ms = mono() - tStart; const entry = { t: Date.now(), hand: st.hand, street: st.street, seat: st.actor, status: x.status, action: x.action || null, intended: decision.executable && decision.executable[decision.recommendedSlot], reason: x.reason || null, source: decision.source, decisionLabel: decision.label || null, fallbackReason: decision.fallbackReason || null, input: x.input || null, ms, lifecycle: this.lc.state, generation: token.generation };
      // An action that may have reached the window before it was lost / cancelled is UNCERTAIN: never re-sent, reviewed by the operator.
      const mayHaveHappened = x.status === 'unconfirmed' || (x.status === 'rejected' && x.inputMayHaveHappened);
      // 0.36.2 M3.2: delivered by the driver, but the screen never changed and a fresh reading still shows the same decision point
      const noChange = x.status === 'rejected' && !x.inputMayHaveHappened && x.inputSent === true && !!(x.verification && x.verification.clean === true);
      if (x.status !== 'confirmed' && mayHaveHappened && (this.lc.terminal || this.stopped || (this._lastConfirm && (this._lastConfirm.uncertain || this._lastConfirm.status === 'cancelled')) || /cancel|emergency|manual/.test(x.code || x.reason || ''))) { entry.status = 'uncertain'; entry.reviewRequired = true; entry.reason = (x.reason || (this._lastConfirm && this._lastConfirm.reason) || 'input may have been delivered') + ' - review the simulator; the action is not repeated'; this.m.uncertain++; }
      // 0.36.2 M3.2: ONE input status per attempt (confirmed / rejected before input / rejected without a state change / uncertain / timed out / cancelled)
      const lc0 = this._lastConfirm || {};
      entry.inputClass = x.status === 'confirmed' ? 'confirmed' : entry.status === 'uncertain' ? 'uncertain' : noChange ? 'rejected-no-change'
        : x.status === 'unconfirmed' ? (lc0.status === 'timed-out' ? 'timed-out' : lc0.status === 'cancelled' ? 'cancelled-after-input' : lc0.status === 'ambiguous' ? 'ambiguous' : 'unconfirmed')
        : x.status === 'rejected' ? (x.noInputSent === true ? 'rejected-before-input' : mayHaveHappened ? 'uncertain' : 'rejected') : x.status === 'aborted' ? 'cancelled-before-input' : 'blocked-before-input';
      entry.inputSent = x.inputSent === true || mayHaveHappened || noChange;
      if (noChange) { entry.reviewRequired = true; entry.reason = (x.reason || 'no change after the input') + ' - the simulator did not apply the action; it is not repeated'; this.m.inputRejectedNoChange++; }
      if (x.status === 'confirmed') { this.m.confirmed++; this.m.e2e.push(mono() - frame.at); if (x.input) { if (x.input.actualMs) this.m.cursor.push(x.input.actualMs); } this.m.input.push(ms); }
      else if (x.status === 'rejected') { if (/scheduler: Cannot finish by the deadline/.test(x.reason || '')) this.m.deadline++; if (/focus/.test(x.reason || '')) this.m.focusErrors++; if (/driver-exited|internal-error|timeout/.test(x.reason || '')) this.m.driverErrors++; if (/target-lost|lease-invalid|lifecycle-blocked/.test((x.code || '') + ' ' + (x.reason || ''))) this.m.cancelled++; this.m.rejected++; }
      else if (x.status === 'unconfirmed') { const c = this._lastConfirm || {}; if (c.status === 'timed-out') this.m.timedOut++; else if (c.status === 'cancelled' || c.status === 'uncertain') this.m.cancelled++; else this.m.ambiguous++; }
      else if (x.status === 'aborted') this.m.cancelled++; else this.m.blocked++;
      if (x.schedule && Number.isFinite(x.schedule.waitedMs)) { this.m.scheduleWait.push(x.schedule.waitedMs); if (this.m.scheduleWait.length > 3000) this.m.scheduleWait.shift(); }
      const confirmation = this._lastConfirm; this._lastConfirm = null;
      // 0.36.2 M4.0: the action's timeline is complete (measurement only; it does not influence what happens next)
      if (tl) { tl.mark('action-released'); tl.set('inputClass', entry.inputClass); const tr = this.timelines.add(tl, entry.inputClass); if (tr) entry.timeline = tr.d; }
      this.log.push(entry); if (this.log.length > 3000) this.log.shift();
      // 0.36.2 M3.2: every input that was (or may have been) sent and was not confirmed leaves a complete evidence record
      if (entry.inputSent && x.status !== 'confirmed') await this._recordUnconfirmed({ entry, x, decision, st, frame, confirmation, tStart, beforeImage: this._decisionImage });
      if (this.lc.terminal) return { kind: 'lost', entry, reason: this.lost && this.lost.reason };
      if (x.status !== 'confirmed' && this.executor.pausedTables.has(this.id) && !this.paused) this.paused = this.executor.pausedTables.get(this.id);
      if (/manual-override|manual-mode/.test((x.code || '') + ' ' + (x.reason || ''))) this.safetyPause('manual-override', 'manual mouse/keyboard input took over: ' + (x.reason || ''));
      else if (/emergency-stop/.test((x.code || '') + ' ' + (x.reason || ''))) this.safetyPause('emergency-stop', 'emergency stop: ' + (x.reason || ''));
      else if (entry.status === 'uncertain' || mayHaveHappened) this.safetyPause('unconfirmed-input', 'action not confirmed: ' + (entry.reason || x.reason || 'unknown') + '; manual review required');
      // 0.36.2 M3.2: a delivered action the simulator did not apply is a safety pause too (operator review; the window stays monitored);
      // until Milestone 3.1 it left only a gameplay pause behind an ACTIVE lifecycle - the state in which the closed window went unnoticed
      else if (noChange) this.safetyPause('input-rejected', 'action not applied: the ' + ((x.input && x.input.region) || (entry.intended && entry.intended.type) || 'action') + ' input was delivered but the simulator showed no change (' + (x.reason || 'no change') + '); it is not repeated - review the table, then press Resume', { code: 'no-state-change' });
      // Clean refusals (nothing sent) may be retried from a fresh reading, but not forever.
      this.refusalsInRow = x.status === 'confirmed' ? 0 : (this.refusalsInRow || 0) + 1;
      if (!this.paused && this.refusalsInRow >= this.opt.maxRefusalsInRow) this.pause(this.refusalsInRow + ' actions in a row could not be executed (last: ' + (x.reason || x.status) + ')');
      return { kind: 'acted', entry };
    }
    async run(untilMs, onStep) {
      this.startMonitoring();   // 0.36.2 M3.2: window health is verified for the whole registration, also after run() ends on a pause
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
    dispose() { this._disposed = true; if (this.health) this.health.stop('disposed'); if (this._offLc) { this._offLc(); this._offLc = null; } }
    report() {
      const st = SCH.stats; return { table: this.id, hwnd: this.win.hwnd, paused: this.paused, counts: { frames: this.m.frames, rejectedFrames: this.m.rejectedFrames, decisions: this.m.decisions, solverDecisions: this.m.solver, scriptedDecisions: this.m.scripted, unavailable: this.m.unavailable, attempted: this.m.attempted, confirmed: this.m.confirmed, rejected: this.m.rejected, ambiguous: this.m.ambiguous, timedOut: this.m.timedOut, cancelled: this.m.cancelled, blocked: this.m.blocked, deadlineMisses: this.m.deadline, focusErrors: this.m.focusErrors, driverErrors: this.m.driverErrors, errors: this.m.errors, uncertain: this.m.uncertain },
        latencyMs: { endToEnd: st(this.m.e2e), cursorTravel: st(this.m.cursor), inputOperation: st(this.m.input), confirmation: st(this.m.confirmMs) }, executor: this.executor.counts, capture: { frames: this.capture.frames, failures: this.capture.failures, refusedLocallyAfterLoss: this.capture.refusedLocally || 0, failuresByCode: { ...this.m.captureFailuresByCode } },
        // 0.36.2 M2 (additive): lifecycle, loss, cancellation and the separated failure families
        registrationId: this.registrationId, lifecycle: this.lc.snapshot(), lost: this.lost, cancellation: this.cancellation,
        failureFamilies: { inputDriverErrors: this.m.driverErrors, captureFailures: this.capture.failures, recognitionFailures: Math.max(0, this.m.rejectedFrames - this.capture.failures), strategyUnavailable: this.m.strategyUnavailable, inputCancellations: this.m.cancelled, emergencyStops: this.m.emergencyStops, manualOverrides: this.m.manualOverrides, targetLost: this.lc.terminal ? 1 : 0, lossSignals: this.m.lossSignals, transientCaptureFailures: this.m.transientFailures },
        recovery: { recoveries: this.m.recoveries, backoffWaits: this.m.backoffWaits, identityProbes: this.m.probes, staleStatesDiscarded: this.m.staleDiscarded, cancelledByLoss: this.m.cancelledByLoss, uncertainActions: this.m.uncertain },
        // 0.36.2 M3 (additive): gameplay condition, hand tracking and tournament seating
        tournamentRules: this.tournamentRules, gameplay: this.gameplayStatus(), handRecoveries: this.m.handRecoveries, verifyingSteps: this.m.verifyingSteps, eliminationsSeen: this.m.eliminationsSeen, completed: this.completed,
        // 0.36.2 M3.2 (additive): window-health monitor, input status per attempt, evidence of every unconfirmed input, scheduling delay
        health: this.health ? this.health.snapshot() : null, inputStatus: this.log.reduce((a, e) => { const k = e.inputClass || e.status; a[k] = (a[k] || 0) + 1; return a; }, {}), inputRejectedNoChange: this.m.inputRejectedNoChange,
        unconfirmedInputs: this.unconfirmed.map((r) => JSON.parse(JSON.stringify(r))), scheduleWaitMs: st(this.m.scheduleWait), schedulerRegistration: this.schedRegistration,
        // 0.36.2 M4.0 (additive): pipeline profile, strip-only captures, driver-client counters, recognition templates
        pipeline: this.pipelineName, stripCaptures: this.capture.crops || 0, driverPipeline: this.driver.stats ? { ...this.driver.stats } : null, recognitionWidths: this.reader.calibratedWidths || null,
        // how much earlier the decision deadline started than the decision frame (deadlineAnchor 'change'): the longest a change was unobserved
        deadlineAnchor: this.opt.deadlineAnchor || this.pipe.deadlineAnchor || 'frame', deadlineAnchorSlackMs: st(this.m.deadlineAnchorSlackMs) };
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
  /**
   * 0.36.2 M4.0 VERIFY TABLE RECOGNITION (recognition-check.js): ONE fresh capture of a registered window through the same host capture
   * path the automation uses, read with the reader (and exact-width templates) the table would use and the same status-strip check. Sends
   * no input. o: { api, window: {hwnd, pid, title}, profile, table, decode, method, monitor, heroSeat }.
   */
  async function verifyRecognition(o) {
    const win = o.window || {}, cap = new HostWindowCapture(o.api, win, { decode: o.decode, method: o.method });
    let op; try { op = await cap.open(); } catch (e) { op = { ok: false, code: e.code || 'capture-failed', reason: e.message }; }
    if (!op || op.ok !== true) return RC.captureFailed({ table: o.table, hwnd: win.hwnd, title: win.title, code: op && op.code, reason: op && (op.reason || op.error) });
    const g = await cap.grab(); if (!g.ok) return RC.captureFailed({ table: o.table, hwnd: win.hwnd, title: win.title, code: g.code, reason: g.reason });
    const width = g.bounds && Number.isInteger(g.bounds.width) ? g.bounds.width : undefined, reader = tableReader(o.table, 8, width);
    const rep = RC.verify({ frame: { image: g.image, bounds: g.bounds, dpiScale: g.dpiScale, frameId: g.frameId, method: g.method }, reader, profile: o.profile, table: o.table, hwnd: win.hwnd, title: g.title || win.title, monitor: o.monitor, heroSeat: o.heroSeat });
    rep.capture = { method: g.method || null, captureMs: Math.round(g.captureMs), hostMs: g.timing ? g.timing.hostMs : null }; return rep;
  }

  return { HostApi, hostSession, HostWindowCapture, tableReader, SimulatorTable, authorizations, verifyRecognition, DEFAULTS, GAMEPLAY, Lifecycle: LC };
});
