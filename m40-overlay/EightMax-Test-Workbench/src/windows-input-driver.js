/* EightMax Test Workbench 0.35.0: client of the Windows INPUT DRIVER (desktop/bin/EightMaxInput.exe).
 *
 * Transports (same protocol, one JSON object per line, opened by an authenticated hello):
 *   spawnTransport  Node only: starts EightMaxInput.exe as a child process with a fresh random token (tools, CI, tests).
 *   hostTransport   browser or Node: the desktop host owns the driver process; requests go to /api/input/command with the
 *                   desktop session token. Only one process (the host) ever owns the physical cursor.
 * DriverSession adds request ids, timeouts, cancellation and event fan-out. WindowsUiDriver implements the
 * UiAutomationAdapter driver contract (activate(region, box, act), enterAmount(text, field, act)) on top of it: it refreshes
 * the window's client rectangle right before each action, converts the profile's normalised region to physical pixels, and
 * passes the expected rectangle so the driver refuses stale coordinates.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./input-geometry.js'), require('./input-motion.js'), require('./movement-settings.js'));
  else root.WorkbenchInputDriver = factory(root.WorkbenchInputGeometry, root.WorkbenchInputMotion, root.WorkbenchMovementSettings);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (G, M, MS) {
  'use strict';
  const ok = (v, m) => { if (!v) throw new Error(m); };
  const mono = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const COMMANDS = Object.freeze(['health', 'status', 'cancel', 'cancel-all', 'estop', 'reset-estop', 'arm', 'disarm', 'resume', 'manual-mode', 'release-all', 'monitor-start', 'monitor-stop',
    'cursor', 'monitors', 'list-windows', 'window-info', 'exe-identity', 'register-target', 'unregister-target', 'focus', 'move', 'move-click', 'click', 'double-click', 'mouse-down', 'mouse-up', 'key', 'type', 'clear-field', 'read-text', 'enter-text', 'uia-controls', 'wait',
    'virtual-user-move', 'virtual-hotkey', 'virtual-events']);
  class DriverError extends Error { constructor(code, message, reply) { super(message); this.code = code; this.reply = reply; } }

  /** Node: spawn the driver. options: exe, args[], env, spawn (child_process.spawn), randomHex(n) */
  function spawnTransport(o) {
    const cp = o.spawn || require('child_process').spawn, token = o.token || require('crypto').randomBytes(32).toString('hex');
    const args = [...(o.args || [])]; if (o.parentPid !== false) args.push('--parent-pid', String(o.parentPid || process.pid));
    const child = cp(o.exe, args, { env: { ...(o.env || process.env), EIGHTMAX_INPUT_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const listeners = new Set(), exitListeners = new Set(); let buf = '', err = '', exited = null;
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch (e) { continue; } for (const f of listeners) f(m); } });
    child.stderr.setEncoding('utf8'); child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('exit', (code, sig) => { exited = { code, signal: sig, stderr: err }; for (const f of exitListeners) f(exited); });
    child.on('error', (e) => { exited = { code: -1, error: e.message, stderr: err }; for (const f of exitListeners) f(exited); });
    return { kind: 'spawn', token, pid: child.pid, child, write: (obj) => { ok(!exited, 'Input driver is not running'); child.stdin.write(JSON.stringify(obj) + '\n'); }, onMessage: (f) => listeners.add(f), onExit: (f) => exitListeners.add(f), get exited() { return exited; }, close: () => { try { child.stdin.end(); } catch (e) { /* closed */ } } };
  }

  /** Browser/Node through the desktop host. request(path, body) -> parsed JSON (the host forwards one command, returns the driver's reply). */
  function hostTransport(request) {
    const listeners = new Set(); let closed = false;
    return { kind: 'host', async call(msg) { ok(!closed, 'closed'); return request('/api/input/command', msg); }, onMessage: (f) => listeners.add(f), emit: (m) => { for (const f of listeners) f(m); }, onExit: () => {}, close: () => { closed = true; }, get exited() { return null; } };
  }

  class DriverSession {
    constructor(transport, o = {}) {
      this.t = transport; this.seq = 0; this.pending = new Map(); this.events = []; this.eventListeners = new Set(); this.defaultTimeout = o.timeoutMs || 30000; this.helloed = false; this.capabilities = null; this.lastCursor = null;
      if (transport.write) {
        transport.onMessage((m) => {
          if (m && m.event) { this.events.push(m); if (this.events.length > 200) this.events.shift(); for (const f of this.eventListeners) { try { f(m); } catch (e) { /* listener errors never break the session */ } } return; }
          const p = m && this.pending.get(m.id); if (p) { this.pending.delete(m.id); clearTimeout(p.timer); p.resolve(m); }
        });
        transport.onExit((x) => { for (const [, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, code: 'driver-exited', error: 'The input driver exited (' + JSON.stringify(x) + ')' }); } this.pending.clear(); });
      }
    }
    onEvent(f) { this.eventListeners.add(f); return () => this.eventListeners.delete(f); }
    /** Raw request: resolves with the driver's reply object (ok true/false); never throws on a refusal. */
    request(cmd, args = {}, timeoutMs) {
      ok(COMMANDS.includes(cmd) || cmd === 'hello', 'Unknown driver command ' + cmd);
      if (this.t.call) return this.t.call({ cmd, ...args, timeoutMs: timeoutMs || this.defaultTimeout }).then((r) => { if (r && r.events) for (const e of r.events) { this.events.push(e); for (const f of this.eventListeners) f(e); } return r; });
      const id = ++this.seq, ms = timeoutMs || this.defaultTimeout;
      return new Promise((resolve) => { const timer = setTimeout(() => { this.pending.delete(id); resolve({ id, ok: false, code: 'timeout', error: 'No reply from the input driver within ' + ms + ' ms' }); }, ms); this.pending.set(id, { resolve, timer }); try { this.t.write({ id, cmd, ...args }); } catch (e) { clearTimeout(timer); this.pending.delete(id); resolve({ id, ok: false, code: 'driver-exited', error: e.message }); } });
    }
    /** Same, but throws DriverError on a refusal. */
    async call(cmd, args = {}, timeoutMs) { const r = await this.request(cmd, args, timeoutMs); if (!r || r.ok !== true) throw new DriverError(r && r.code || 'error', r && r.error || 'Input driver refused ' + cmd, r); if (r.to) this.lastCursor = r.to; else if (r.clickedAt) this.lastCursor = r.clickedAt; return r; }
    /** Start an operation and return {id, done}; cancel(id) interrupts it. Spawn transport only (the host transport has its own /api/input/cancel). */
    start(cmd, args = {}, timeoutMs) { ok(this.t.write, 'start() needs a direct driver connection'); const id = this.seq + 1; const done = this.request(cmd, args, timeoutMs); return { id, done }; }
    async hello() { if (this.helloed) return this.capabilities; const r = await this.request('hello', { token: this.t.token }, 10000); if (!r.ok) throw new DriverError(r.code, r.error, r); this.helloed = true; this.capabilities = r.capabilities; this.platform = r.platform; this.version = r.driver; return r.capabilities; }
    async close() { try { await this.request('shutdown', {}, 3000); } catch (e) { /* already gone */ } this.t.close(); }
  }

  /** Map a TestExecutor action to the profile control that performs it. */
  function controlFor(type, controls) {
    if (type === 'fold' || type === 'check' || type === 'call') return type;
    if (type === 'allin' && controls && controls.allin) return 'allin';
    return 'raise';
  }

  /**
   * The driver behind UiAutomationAdapter for one registered simulator window.
   * options: session (DriverSession), hwnd, motion (profile), timing, focusPolicy, expectClient(): the client rectangle the
   *   CURRENT observation was captured with (actions are refused when the window changed since), onTrace(event)
   */
  /**
   * 0.36.2 M4.0 input pipeline profiles (what the driver client does around one click; the motion and click timing settings are the
   * operator's and are never changed by a profile):
   *   compat-3.2   exactly Milestone 3.2: window-info round trip before every input, global double-click spacing, settle after the
   *                click inside the cursor lease
   *   optimized    the driver's own atomic checks at the start of move-click replace the extra window-info round trip (same checks:
   *                registered target, identity, minimised/hidden, unchanged client rectangle); double-click spacing per target process;
   *                the driver confirms the target window processed the click (input drain) before it replies, and only then the settle
   *                runs AFTER the lease (the next table may use the cursor; this table still waits the full settle before reading).
   *                A driver without these capabilities, or a click whose drain was not confirmed, keeps the Milestone 3.2 behaviour.
   */
  const PIPELINE_PROFILES = Object.freeze({
    'compat-3.2': Object.freeze({ preflight: 'window-info', clickGuard: 'global', drain: false, settle: 'inside-lease', raiseWait: null, pressGuard: false }),
    // pressGuard: a press that reached another window (its target closed or was covered at that instant) is released off that control
    'optimized': Object.freeze({ preflight: 'driver', clickGuard: 'process', drain: true, settle: 'after-drain', raiseWait: 'poll', pressGuard: true }),
  });
  class WindowsUiDriver {
    constructor(o) {
      ok(o && o.session && typeof o.hwnd === 'string', 'WindowsUiDriver needs a session and a window handle');
      this.movement = o.movement ? new MS.Sequence(o.movement) : null;
      this.s = o.session; this.hwnd = o.hwnd; this.motion = M.profile(o.motion || {}); this.timing = { ...M.DEFAULT_TIMING, ...(o.timing || {}) }; this.focusPolicy = o.focusPolicy || 'bring-to-front';
      this.expectClient = o.expectClient || null; this.trace = o.onTrace || (() => {}); this.mustFinishWithinMs = o.mustFinishWithinMs || null; this.dryRun = !!o.dryRun;
      // 0.36.2 M2: identity() -> the registered {pid, processStart, className} this window must still have; guard() -> {ok} from the
      // table's lifecycle (ACTIVE, same generation as the decision). Both are checked immediately before every click or wager.
      this.identity = o.identity || null; this.guard = o.guard || null;
      // 0.36.2 M4.0: the input pipeline profile (default compat-3.2: a caller that does not choose keeps the Milestone 3.2 behaviour)
      this.profileName = o.pipeline || 'compat-3.2'; ok(PIPELINE_PROFILES[this.profileName], 'Unknown input pipeline profile ' + this.profileName); this.pipeline = PIPELINE_PROFILES[this.profileName];
      this.stats = { preflightSkipped: 0, preflightWindowInfo: 0, drained: 0, notDrained: 0, settleInside: 0, settleDeferred: 0 };
    }
    /** 0.36.2 M4.0: does the running driver support the optimized profile's requests? (capabilities from hello/status) */
    _caps() { return (this.s && this.s.capabilities) || {}; }
    _optimizedDriver() { const c = this._caps(); return c.inputDrain === true && Array.isArray(c.clickGuardScopes) && c.clickGuardScopes.includes('process'); }
    async _guard() {
      if (typeof this.guard !== 'function') return;
      let g; try { g = await this.guard(); } catch (e) { g = { ok: false, reason: e.message }; }
      if (!g || g.ok !== true) throw new DriverError((g && g.code) || 'lifecycle-blocked', (g && g.reason) || 'The table is no longer eligible for input');
    }
    /** Map a driver cancellation the driver itself reports as happening before any button/key went down to a clean code. */
    static cleanCancel(e) { if (e && e.code === 'cancelled' && /before (button|key)-down|before it started/i.test(e.message || '')) { const x = new DriverError('cancelled-before-input', e.message, e.reply); return x; } return e; }
    async window() { const r = await this.s.call('window-info', { hwnd: this.hwnd }, 5000); return r.window; }
    /** Fresh client rectangle; refused when it differs from the one the observation saw. */
    async _client() {
      // 0.36.2 M4.0 optimized profile: the client rectangle the CURRENT observation was captured with is used directly and sent as
      // expectClient; the driver itself refuses the input atomically, at the start of the operation, when the window is not registered,
      // no longer the registered window (handle, process id, process start time, class), minimised, hidden or cloaked, or when its client
      // rectangle differs (layout-changed) - the same checks this round trip made a few milliseconds earlier. Without an observed
      // rectangle (or with the compat profile) the Milestone 3.2 window-info round trip runs.
      const want0 = this.expectClient ? this.expectClient() : null;
      if (this.pipeline.preflight === 'driver' && G.validClient(want0)) { this.stats.preflightSkipped++; return { x: want0.x, y: want0.y, w: want0.w, h: want0.h }; }
      this.stats.preflightWindowInfo++;
      const w = await this.window();
      const id = typeof this.identity === 'function' ? this.identity() : this.identity;
      if (id && (Number(w.pid) !== Number(id.pid) || (id.processStart != null && String(w.processStart) !== String(id.processStart)) || (id.className != null && w.className != null && w.className !== id.className))) throw new DriverError('identity-changed', 'The window handle now belongs to a different window or process than the one registered');
      if (w.minimized) throw new DriverError('window-minimized', 'The simulator window is minimised');
      const want = this.expectClient ? this.expectClient() : null;
      if (want && !(want.x === w.client.x && want.y === w.client.y && want.w === w.client.w && want.h === w.client.h)) throw new DriverError('layout-changed', 'The window moved or was resized after the screen was read');
      return w.client;
    }
    _common(client, target, deadlineMs) {
      const chosen = this.movement ? this.movement.next(this.motion) : { profile: this.motion, trace: null };
      if (chosen.trace) this.trace({ kind: 'motion-plan', ...chosen.trace, target: target.point, profile: chosen.profile });
      // 0.36.2 M4.0: clickGuard / drain / phases are additional request fields; a Milestone 3.2 driver ignores them (unknown fields are not read)
      return { hwnd: this.hwnd, expectClient: client, region: target.rect, to: target.point, motion: chosen.profile, focusPolicy: this.focusPolicy, preClickMs: this.timing.preClickMs, holdMs: this.timing.holdMs, ...(deadlineMs ? { mustFinishWithinMs: deadlineMs } : {}),
        clickGuard: this.pipeline.clickGuard, drain: this.pipeline.drain, phases: true, ...(this.pipeline.raiseWait ? { raiseWait: this.pipeline.raiseWait } : {}), ...(this.pipeline.pressGuard ? { pressGuard: true } : {}) };
    }
    /** 0.36.2 M4.0: run the settle inside the lease (Milestone 3.2) unless the driver confirmed that the target window processed the click. */
    async _settle(reply, detail) {
      const ms = this.timing.postClickSettleMs || 0; if (!ms) return;
      const deferred = this.pipeline.settle === 'after-drain' && this._optimizedDriver() && reply && reply.drained === true;
      if (deferred) { this.stats.settleDeferred++; detail.deferredSettleMs = ms; return; }
      this.stats.settleInside++; await new Promise((res) => setTimeout(res, ms));
    }
    /** Contract: one click on a normalised region. Resolves {ok, reason?, detail}. */
    async activate(regionName, box, act = {}) {
      try {
        const client = await this._client(), target = G.regionToScreen(box, client); if (!target.ok) return { ok: false, reason: target.reason };
        await this._guard();
        const args = this._common(client, target, act.mustFinishWithinMs || this.mustFinishWithinMs);
        if (this.dryRun) { const r = await this.s.call('move', args, 15000); this.trace({ kind: 'dry-run', region: regionName, target, move: r }); return { ok: true, dryRun: true, detail: r }; }
        const sentAt = mono(); const r = await this.s.call('move-click', args, 20000); const repliedAt = mono(); this.trace({ kind: 'click', region: regionName, target, reply: { ...r, samples: undefined, sampleCount: Array.isArray(r.samples) ? r.samples.length : 0 } });   // 0.36.2 M4.0: the per-step path stays in the driver reply, not in every diagnostics event
        if (r.drained === true) this.stats.drained++; else if (r.drained === false) this.stats.notDrained++;
        // 0.36.2 M3.2: also the window under the cursor at the press, the double-click guard wait, the travel and the cursor lag (evidence)
        const detail = { plannedMs: r.plannedMs, actualMs: r.actualMs, steps: r.steps, finalError: r.finalError, clickedAt: r.clickedAt, hitClass: r.hitClass, hit: r.hit, doubleClickGuardMs: r.doubleClickGuardMs, distance: r.distance, maxObservedLag: r.maxObservedLag, point: target.point, rect: target.rect,
          // 0.36.2 M4.0 (additive): request/reply times and the driver's phases (timeline), whether the target processed the click
          timing: { sentAt, repliedAt, phases: r.phases || null }, drained: r.drained === undefined ? null : r.drained, drainMs: r.drainMs === undefined ? null : r.drainMs, guardScope: r.guardScope || null, press: r.press || null, pipeline: this.profileName };
        await this._settle(r, detail);
        return { ok: true, detail };
      } catch (e0) { const e = WindowsUiDriver.cleanCancel(e0); this.trace({ kind: 'click-refused', region: regionName, code: e.code, error: e.message }); return { ok: false, reason: (e.code ? e.code + ': ' : '') + e.message, code: e.code }; }
    }
    /** Contract: type an exact amount into the calibrated wager field and read it back. Nothing is submitted. */
    async enterAmount(text, field, act = {}) {
      try {
        ok(/^\d{1,12}(\.\d{1,4})?$/.test(text), 'Wager text must be digits (optionally one decimal part)');
        const client = await this._client(), target = G.regionToScreen(field, client, { insetFraction: 0.2 }); if (!target.ok) return { ok: false, reason: target.reason };
        await this._guard();
        const r = await this.s.call('enter-text', { ...this._common(client, target), text, keyIntervalMs: this.timing.keyIntervalMs, keyHoldMs: this.timing.keyHoldMs, focusSettleMs: this.timing.focusSettleMs }, 30000);
        this.trace({ kind: 'wager', text, read: r.read, verified: r.verified, target });
        return r.verified === true && r.read === text ? { ok: true, read: r.read, detail: { field: r.field } } : { ok: false, reason: 'Field shows ' + JSON.stringify(r.read) + ' instead of ' + JSON.stringify(text) };
      } catch (e0) { const e = WindowsUiDriver.cleanCancel(e0); this.trace({ kind: 'wager-refused', code: e.code, error: e.message }); return { ok: false, reason: (e.code ? e.code + ': ' : '') + e.message, code: e.code }; }
    }
    /** Time a click on `box` will take from the last known cursor position (scheduler estimate). */
    estimateMs(box, client, from) {
      const t = G.regionToScreen(box, client); if (!t.ok) return Infinity; const start = from || this.s.lastCursor || { x: client.x, y: client.y };
      const p={...this.motion}; if(this.movement){const o=this.movement.options;p.arc=o.pattern==='straight'?0:(o.maxCurvature===null?Math.abs(p.arc):o.maxCurvature);}
      return M.durationMs(Math.hypot(t.point.x - start.x, t.point.y - start.y), p) + this.timing.preClickMs + this.timing.holdMs + this.timing.postClickSettleMs + ((this.s.capabilities && this.s.capabilities.singleClickGuardMaxMs) || 5040);
    }
    estimateTypingMs(text) { return (this.timing.keyIntervalMs + this.timing.keyHoldMs) * (text.length + 8) + this.timing.focusSettleMs + 400; }
  }

  return { COMMANDS, DriverError, spawnTransport, hostTransport, DriverSession, WindowsUiDriver, controlFor, PIPELINE_PROFILES };
});
