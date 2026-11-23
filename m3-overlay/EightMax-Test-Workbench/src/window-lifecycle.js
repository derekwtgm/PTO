/* EightMax Test Workbench 0.36.2 (Milestone 2): SIMULATOR WINDOW LIFECYCLE - one explicit state machine per registered window.
 *
 * Why this exists: Milestone 1 treated every failed capture as "no reading yet" and retried every 120 ms for as long as automation
 * ran, so a closed simulator window produced an endless stream of target-lost captures (592 attempts, 801 diagnostic events in the
 * operator's report). Here every failure is CLASSIFIED, a suspected loss is CONFIRMED with the input driver (window-info: does the
 * handle still exist and is it still the same process/window?), confirmed loss is TERMINAL, temporary failures back off and are
 * bounded, and every return to ACTIVE needs a fresh, identity-checked reading.
 *
 *   REGISTERED --first verified reading--> ACTIVE <--fresh verified reading-- RECOVERY_PENDING <--capture works again-- TEMPORARILY_UNAVAILABLE
 *   any non-terminal state --confirmed loss / identity mismatch--> TARGET_LOST (absorbing: a replacement is a NEW registration)
 *   any non-terminal state --operator stop--> STOPPED ; --emergency stop / manual override / uncertain input--> SAFETY_PAUSED
 *   STOPPED / SAFETY_PAUSED --explicit operator action only--> RECOVERY_PENDING (never ACTIVE directly)
 *
 * Every transition increments `generation`. Work that started under one generation (a capture, a decision, a queued click) carries a
 * token and is refused when the generation moved on, so a late asynchronous callback can never revive a lost or paused target.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkbenchWindowLifecycle = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const mono = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const S = Object.freeze({ REGISTERED: 'REGISTERED', ACTIVE: 'ACTIVE', TEMPORARILY_UNAVAILABLE: 'TEMPORARILY_UNAVAILABLE', RECOVERY_PENDING: 'RECOVERY_PENDING', TARGET_LOST: 'TARGET_LOST', STOPPED: 'STOPPED', SAFETY_PAUSED: 'SAFETY_PAUSED' });
  /** Allowed transitions. `operator` marks targets that need cause.operator === true. TARGET_LOST has no exits. */
  const TRANSITIONS = Object.freeze({
    REGISTERED: [S.ACTIVE, S.TEMPORARILY_UNAVAILABLE, S.RECOVERY_PENDING, S.TARGET_LOST, S.STOPPED, S.SAFETY_PAUSED],
    ACTIVE: [S.TEMPORARILY_UNAVAILABLE, S.RECOVERY_PENDING, S.TARGET_LOST, S.STOPPED, S.SAFETY_PAUSED],
    TEMPORARILY_UNAVAILABLE: [S.RECOVERY_PENDING, S.TARGET_LOST, S.STOPPED, S.SAFETY_PAUSED],
    RECOVERY_PENDING: [S.ACTIVE, S.TEMPORARILY_UNAVAILABLE, S.TARGET_LOST, S.STOPPED, S.SAFETY_PAUSED],
    SAFETY_PAUSED: [S.RECOVERY_PENDING, S.TARGET_LOST, S.STOPPED],
    STOPPED: [S.RECOVERY_PENDING, S.TARGET_LOST, S.SAFETY_PAUSED],
    TARGET_LOST: [],
  });
  const OPERATOR_EXIT = new Set([S.SAFETY_PAUSED, S.STOPPED]);

  /** Plain-language dashboard messages (title + text) per state / cause kind. */
  const MESSAGES = Object.freeze({
    'window-closed': ['Simulator window closed', 'The registered simulator is no longer available. Automation for this table has stopped. Reopen the simulator and register its window again.'],
    'identity-changed': ['Window identity changed', 'The selected window no longer matches the registered simulator. Automation has been disabled.'],
    'temporary': ['Capture temporarily unavailable', 'The simulator is still open, but the latest frame could not be captured. No actions will be sent until the current state is verified.'],
    'minimized': ['Simulator minimised', 'The simulator is still open but minimised, so Windows provides no picture of it. No actions will be sent. Restore the window; automation continues only after a fresh reading is verified.'],
    'recovery': ['Verifying the simulator again', 'Capture works again. The window identity and a fresh table reading are being verified before any action is sent.'],
    'exhausted': ['Capture unavailable for too long', 'The simulator could not be captured for an extended time. Automation for this table is paused. Check the window, then press Resume to verify it again.'],
    'safety': ['Paused for safety', 'A safety condition (emergency stop, manual override or an unconfirmed action) stopped this table. Nothing resumes by itself.'],
    'stopped': ['Stopped', 'Automation for this table was stopped by the operator.'],
    'active': ['Active', 'Capture and table reading are working.'],
    'registered': ['Registered', 'The window is registered; capture has not started yet.'],
    'configuration': ['Capture method unavailable', 'The selected capture method cannot capture this window. Choose another capture method and register the window again.'],
    // 0.36.2 M3: a tournament that ended is a NORMAL stop (STOPPED, not a fault); leaving it still needs the operator
    'tournament-complete': ['Simulator completed', 'Tournament finished. Automated gameplay has stopped normally.'],
  });

  /* ---------------- failure classification ---------------- */
  // terminal-candidate: the HOST says the window is gone or is somebody else - confirmed with the driver before it becomes terminal.
  const TERMINAL_CANDIDATE = Object.freeze({ 'target-lost': 'window-closed', 'window-gone': 'window-closed', 'target-closed': 'window-closed', 'target-identity-changed': 'identity-changed', 'identity-changed': 'identity-changed', 'target-not-registered': 'registration-revoked' });
  const TRANSIENT = Object.freeze({ 'target-minimized': 'minimized', 'window-minimized': 'minimized', 'target-occluded': 'occluded', 'target-hidden': 'hidden', 'window-hidden': 'hidden',
    'no-frame': 'capture-timeout', 'capture-timeout': 'capture-timeout', 'timeout': 'capture-timeout', 'capture-interrupted': 'capture-service-interrupted', 'host-error': 'capture-service-interrupted',
    'capture-failed': 'capture-failed', 'decode-failed': 'unreadable-image', 'invalid-frame': 'unreadable-image', 'size-mismatch': 'invalid-image-dimensions', 'injected-transient': 'injected-transient' });
  const CONFIGURATION = Object.freeze({ 'backend-unavailable': 'capture-method-unavailable', 'backend-unsupported-target': 'capture-method-unavailable', 'region-offscreen': 'capture-method-unavailable' });
  function classifyCaptureFailure(code) {
    const c = String(code || 'capture-failed');
    if (TERMINAL_CANDIDATE[c]) return { category: 'terminal-candidate', kind: TERMINAL_CANDIDATE[c], code: c, needsConfirmation: true };
    if (CONFIGURATION[c]) return { category: 'configuration', kind: CONFIGURATION[c], code: c, needsConfirmation: false };
    return { category: 'transient', kind: TRANSIENT[c] || 'capture-failed', code: c, needsConfirmation: true };
  }
  /** Separate failure families kept apart in diagnostics (the operator's report mixed strategy-unavailable into capture problems). */
  function failureFamily(stage, code, reason) {
    const s = String(stage || ''), c = String(code || ''), r = String(reason || '');
    if (c === 'target-lost' || c === 'window-gone' || c === 'identity-changed' || c === 'target-identity-changed') return 'target-lost';
    if (c === 'emergency-stop' || /emergency stop/i.test(r)) return 'emergency-stop';
    if (c === 'manual-override' || c === 'manual-mode' || /manual (override|control)/i.test(r)) return 'manual-override';
    if (/^cancelled/.test(c) || /cancel/i.test(c)) return 'input-cancellation';
    if (s === 'decision' || /No compatible EightMax|no EightMax decision|strategy|study/i.test(r)) return 'strategy-unavailable';
    if (s === 'capture') return 'capture-failure';
    if (s === 'recognition' || s === 'state') return 'recognition-failure';
    if (s === 'execution' && /driver-exited|internal-error|timeout/.test(c + ' ' + r)) return 'input-driver-error';
    return 'other';
  }

  /* ---------------- identity ---------------- */
  const lower = (v) => String(v == null ? '' : v).toLowerCase();
  /** Canonical handle text: 0x00001A2B, 0x1a2b and 6699 are the same HWND. */
  function normHwnd(h) { const t = String(h == null ? '' : h).trim(); let m = /^0x([0-9a-f]+)$/i.exec(t); try { if (m) return '0x' + BigInt('0x' + m[1]).toString(16); if (/^\d+$/.test(t)) return '0x' + BigInt(t).toString(16); } catch (e) { /* fall through */ } return t.toLowerCase(); }
  /** Identity record of a registered window as the driver described it (register-target / window-info reply). */
  function identityOf(w, extra = {}) {
    if (!w) return null;
    // hwnd: the handle text exactly as the driver reported it (sent back verbatim); every comparison normalises it with normHwnd()
    return { hwnd: String(w.hwnd), pid: Number(w.pid), processStart: w.processStart == null ? null : String(w.processStart), className: w.className == null ? null : String(w.className), exe: w.exe == null ? null : String(w.exe),
      exeSha256: extra.exeSha256 ? lower(extra.exeSha256) : (w.exeSha256 ? lower(w.exeSha256) : null), title: w.title || '', client: w.client ? { ...w.client } : null, dpiScale: Number(w.dpiScale) || 1 };
  }
  /** Same window and same process instance? Title is NOT identity (it changes with the hand); a handle alone is not identity either. */
  function compareIdentity(registered, current) {
    const problems = [];
    if (!registered || !current) return { ok: false, problems: ['identity unknown'] };
    if (normHwnd(registered.hwnd) !== normHwnd(current.hwnd)) problems.push('window handle ' + current.hwnd + ' differs from ' + registered.hwnd);
    if (Number(registered.pid) !== Number(current.pid)) problems.push('process id ' + current.pid + ' differs from ' + registered.pid);
    if (registered.processStart != null && String(registered.processStart) !== String(current.processStart)) problems.push('process start time differs (handle or process id reused)');
    if (registered.className != null && current.className != null && registered.className !== current.className) problems.push('window class ' + current.className + ' differs from ' + registered.className);
    if (registered.exe && current.exe && lower(registered.exe) !== lower(current.exe)) problems.push('executable path differs');
    if (registered.exeSha256 && current.exeSha256 && registered.exeSha256 !== lower(current.exeSha256)) problems.push('executable SHA-256 differs');
    return { ok: problems.length === 0, problems };
  }
  /**
   * Ask the input driver whether the registered window still exists and is still the registered process instance.
   * session.request('window-info') -> {ok, window} | {ok:false, code:'window-gone'}. Returns
   *   {exists:true, matches:true|false, problems, window} | {exists:false, code} | {exists:null, unknown:true, code, reason}
   * "unknown" (driver busy/stopped/timeout) never confirms a loss and never confirms health either.
   */
  async function probeIdentity(session, registered, o = {}) {
    let r; try { r = await session.request('window-info', { hwnd: registered.hwnd }, o.timeoutMs || 5000); } catch (e) { return { exists: null, unknown: true, code: 'probe-failed', reason: e.message }; }
    if (r && r.ok === true && r.window && !Number.isFinite(Number(r.window.pid))) return { exists: null, unknown: true, code: 'probe-incomplete', reason: 'window-info did not report the process id' };
    if (r && r.ok === true && r.window) { const cur = identityOf(r.window), cmp = compareIdentity(registered, cur); return { exists: true, matches: cmp.ok, problems: cmp.problems, window: r.window, minimized: !!r.window.minimized, visible: r.window.visible !== false, cloaked: !!r.window.cloaked }; }
    if (r && (r.code === 'window-gone')) return { exists: false, code: 'window-gone', reason: r.error || 'The window no longer exists.' };
    return { exists: null, unknown: true, code: (r && r.code) || 'probe-failed', reason: (r && (r.error || r.reason)) || 'no reply' };
  }

  /* ---------------- bounded retry ---------------- */
  /** Exponential backoff for temporary capture failures, bounded by attempts AND by total unavailable time. */
  class RetryPolicy {
    constructor(o = {}) { this.baseMs = o.baseMs || 250; this.maxMs = o.maxMs || 4000; this.factor = o.factor || 2; this.maxAttempts = o.maxAttempts || 90; this.maxUnavailableMs = o.maxUnavailableMs || 300000; this.clock = o.clock || mono; this.reset(); }
    reset() { this.attempt = 0; this.since = null; }
    /** Call after each failed attempt. -> {delayMs, attempt, exhausted, unavailableMs} */
    next() { const now = this.clock(); if (this.since === null) this.since = now; this.attempt++; const delayMs = Math.min(this.maxMs, Math.round(this.baseMs * Math.pow(this.factor, Math.max(0, this.attempt - 1)))); const unavailableMs = now - this.since; return { delayMs, attempt: this.attempt, unavailableMs, exhausted: this.attempt >= this.maxAttempts || unavailableMs >= this.maxUnavailableMs }; }
  }

  /* ---------------- the state machine ---------------- */
  let regSeq = 0;
  class WindowLifecycle {
    /** o: identity (identityOf(...)), table, registrationId, clock, onTransition(ev), maxHistory, replaces */
    constructor(o = {}) {
      this.identity = o.identity || null; this.table = o.table || null; this.registrationId = o.registrationId || ('reg-' + Date.now().toString(36) + '-' + (++regSeq));
      this.replaces = o.replaces || null; this.clock = o.clock || mono; this.wall = o.wall || (() => Date.now()); this.onTransition = o.onTransition || null; this.maxHistory = o.maxHistory || 64;
      this.state = S.REGISTERED; this.generation = 1; this.since = this.clock(); this.cause = { kind: 'registered', reason: 'registered by the operator' };
      this.history = []; this.historyDropped = 0; this.counts = { transitions: 0, refused: 0, staleIgnored: 0, repeats: 0, byState: {} };
      this.lastSuccessAt = null; this.lastSuccessWall = null; this.lastFailure = null; this.lossSignals = 0; this.lostAt = null;
      this.listeners = new Set();
      this._push(null, S.REGISTERED, this.cause);
    }
    _push(from, to, cause) { this.history.push({ at: this.wall(), from, to, generation: this.generation, kind: cause.kind || null, code: cause.code || null, reason: cause.reason || null, operator: !!cause.operator, source: cause.source || null }); if (this.history.length > this.maxHistory) { this.history.shift(); this.historyDropped++; } }
    get terminal() { return this.state === S.TARGET_LOST; }
    get eligible() { return this.state === S.ACTIVE; }
    is(...states) { return states.includes(this.state); }
    can(to, cause = {}) { if (to === this.state) return true; if (!TRANSITIONS[this.state].includes(to)) return false; if (OPERATOR_EXIT.has(this.state) && to === S.RECOVERY_PENDING && cause.operator !== true) return false; return true; }
    /**
     * Move to `to`. opts.ifGeneration: only if nothing happened since that generation (late async results are dropped).
     * Same-state requests update the cause and count a repeat, without a new generation.
     * -> {ok, changed, from, to, generation} | {ok:false, refused:'illegal'|'operator-required'|'stale-generation'|'terminal'}
     */
    transition(to, cause = {}, opts = {}) {
      const from = this.state;
      if (!S[to]) throw new Error('Unknown lifecycle state ' + to);
      if (opts.ifGeneration !== undefined && opts.ifGeneration !== this.generation) { this.counts.staleIgnored++; return { ok: false, refused: 'stale-generation', from, to, generation: this.generation }; }
      if (from === to) { this.counts.repeats++; if (cause && cause.reason) this.cause = { ...this.cause, ...cause, repeats: (this.cause.repeats || 0) + 1 }; return { ok: true, changed: false, from, to, generation: this.generation }; }
      if (from === S.TARGET_LOST) { this.counts.refused++; return { ok: false, refused: 'terminal', from, to, generation: this.generation }; }
      if (!TRANSITIONS[from].includes(to)) { this.counts.refused++; return { ok: false, refused: 'illegal', from, to, generation: this.generation }; }
      if (OPERATOR_EXIT.has(from) && to === S.RECOVERY_PENDING && cause.operator !== true) { this.counts.refused++; return { ok: false, refused: 'operator-required', from, to, generation: this.generation }; }
      this.state = to; this.generation++; this.since = this.clock(); this.cause = { ...cause }; this.counts.transitions++; this.counts.byState[to] = (this.counts.byState[to] || 0) + 1;
      if (to === S.TARGET_LOST) this.lostAt = this.wall();
      this._push(from, to, cause);
      const ev = { table: this.table, registrationId: this.registrationId, from, to, generation: this.generation, cause: { ...cause } };
      for (const f of [this.onTransition, ...this.listeners]) { if (!f) continue; try { f(ev); } catch (e) { /* listeners never break the state machine */ } }
      return { ok: true, changed: true, from, to, generation: this.generation };
    }
    /** Subscribe to transitions; returns the unsubscribe function. */
    on(f) { this.listeners.add(f); return () => this.listeners.delete(f); }
    /** A token for work started now; valid only while the state is ACTIVE and no transition happened since. */
    token() { return { registrationId: this.registrationId, generation: this.generation, state: this.state }; }
    valid(token) { return !!token && token.registrationId === this.registrationId && token.generation === this.generation && this.state === S.ACTIVE; }
    noteSuccess() { this.lastSuccessAt = this.clock(); this.lastSuccessWall = this.wall(); }
    noteFailure(code, reason) { this.lastFailure = { code, reason, at: this.wall() }; }
    message() {
      const k = this.cause && this.cause.kind;
      if (this.state === S.TARGET_LOST) return MESSAGES[k === 'identity-changed' || k === 'registration-revoked' ? 'identity-changed' : 'window-closed'];
      if (this.state === S.TEMPORARILY_UNAVAILABLE) return MESSAGES[k === 'minimized' ? 'minimized' : 'temporary'];
      if (this.state === S.RECOVERY_PENDING) return MESSAGES.recovery;
      if (this.state === S.SAFETY_PAUSED) return k === 'exhausted' ? MESSAGES.exhausted : k === 'configuration' ? MESSAGES.configuration : MESSAGES.safety;
      if (this.state === S.STOPPED) return k === 'tournament-complete' ? MESSAGES['tournament-complete'] : MESSAGES.stopped;
      if (this.state === S.ACTIVE) return MESSAGES.active;
      return MESSAGES.registered;
    }
    snapshot() {
      const m = this.message(), now = this.clock();
      return { registrationId: this.registrationId, table: this.table, replaces: this.replaces, state: this.state, generation: this.generation, sinceMs: Math.round(now - this.since), cause: { ...this.cause },
        title: m[0], message: m[1], automationEligible: this.eligible, reRegistrationRequired: this.state === S.TARGET_LOST, operatorActionRequired: this.state === S.TARGET_LOST || OPERATOR_EXIT.has(this.state),
        lastSuccessfulCapture: this.lastSuccessWall ? new Date(this.lastSuccessWall).toISOString() : null, msSinceLastSuccessfulCapture: this.lastSuccessAt === null ? null : Math.round(now - this.lastSuccessAt),
        lastFailure: this.lastFailure, lossSignals: this.lossSignals, lostAt: this.lostAt ? new Date(this.lostAt).toISOString() : null,
        identity: this.identity && { hwnd: this.identity.hwnd, pid: this.identity.pid, processStart: this.identity.processStart, className: this.identity.className, exe: this.identity.exe, exeSha256: this.identity.exeSha256, client: this.identity.client, dpiScale: this.identity.dpiScale },
        counts: { ...this.counts, byState: { ...this.counts.byState } }, history: this.history.slice(), historyDropped: this.historyDropped };
    }
  }

  /* ---------------- replacement candidates ---------------- */
  /**
   * Windows that MAY replace a lost registration: same executable file name, not the old (handle, process instance), not registered,
   * not minimised. Ranked by title similarity. The SHA-256 is checked separately (exe-identity) before a candidate is offered, and
   * a candidate is only ever a suggestion: registering it needs the operator's explicit confirmation.
   */
  function replacementCandidates(lost, windows, o = {}) {
    if (!lost || !Array.isArray(windows)) return [];
    const exeName = lower(String(lost.exe || '').split(/[\\/]/).pop()), titleRoot = String(lost.title || '').replace(/\s*[·|-].*$/, '').trim(), taken = new Set((o.registeredHwnds || []).map(normHwnd));
    const out = [];
    for (const w of windows) {
      const name = lower(String(w.exe || '').split(/[\\/]/).pop());
      if (!name || name !== exeName) continue;
      if (taken.has(normHwnd(w.hwnd)) || w.registered === true) continue;
      const sameInstance = normHwnd(w.hwnd) === normHwnd(lost.hwnd) && Number(w.pid) === Number(lost.pid) && (w.processStart == null || lost.processStart == null || String(w.processStart) === String(lost.processStart));
      if (sameInstance) continue;   // that would be the lost window itself, which a candidate never is
      if (w.minimized) continue;
      const score = (titleRoot && String(w.title || '').startsWith(titleRoot) ? 2 : 0) + (w.client && lost.client && w.client.w === lost.client.w && w.client.h === lost.client.h ? 1 : 0);
      const geometryChanged = !(w.client && lost.client && w.client.w === lost.client.w && w.client.h === lost.client.h), scalingChanged = Math.abs((Number(w.dpiScale) || 1) - (Number(lost.dpiScale) || 1)) > 0.001;
      out.push({ hwnd: w.hwnd, pid: w.pid, processStart: w.processStart, title: w.title, exe: w.exe, className: w.className, client: w.client, dpiScale: w.dpiScale, score, geometryChanged, scalingChanged, calibrationRecheckRequired: geometryChanged || scalingChanged, sameHandleReused: normHwnd(w.hwnd) === normHwnd(lost.hwnd), replaces: o.registrationId || null });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  return { STATES: S, TRANSITIONS, MESSAGES, normHwnd, classifyCaptureFailure, failureFamily, identityOf, compareIdentity, probeIdentity, RetryPolicy, WindowLifecycle, replacementCandidates };
});
