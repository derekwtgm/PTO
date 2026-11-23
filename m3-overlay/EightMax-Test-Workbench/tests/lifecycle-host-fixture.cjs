'use strict';
// 0.36.2 Milestone 2: fake desktop host + input driver whose replies follow the REAL host and driver for window lifecycle faults
// (closed, minimised, handle reuse, transient capture failure, cancel-all, emergency stop). Shared by tests/lifecycle-0362m2.test.cjs
// and the Linux self-check of tools/lifecycle-acceptance-0362m2.cjs (--fake). Not a substitute for the Windows run.
const FD = require('../src/fixture-dealer.js');
const TOKEN = 'a'.repeat(64), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), SHA = 'c'.repeat(64);
const INPUT = new Set(['focus', 'move', 'move-click', 'click', 'double-click', 'mouse-down', 'mouse-up', 'key', 'type', 'clear-field', 'enter-text']);
/** Fake desktop host + driver with per-window lifecycle faults. */
function lifecycleHost(n, o = {}) {
  const world = { estop: null, registered: new Set() }, tables = new Map(), log = [], stats = { clicks: 0, violations: [], cancelAll: 0, unregister: [], captureClose: [], inputByHwnd: {}, captureByHwnd: {}, probesByHwnd: {} };
  let nextHwnd = 0x1000, nextPid = 4000;
  function addWindow(id, extra = {}) {
    // 0.36.2 M3: o.width / o.seed reproduce the Windows test-table fixture (tools/test-table-035.cjs: client o.width x round(o.width / 1.6),
    // dealer seed o.seed * 1000 + table, the same seed for a reopened window), so a Linux self-check deals the hands the Windows run dealt
    const cw = o.width || 960, hwnd = '0x' + (nextHwnd += 0x1000).toString(16).toUpperCase(), client = extra.client || { x: 30 + id * 40, y: 20 + id * 30, w: cw, h: Math.round(cw / 1.6) };
    const t = { id, hwnd, pid: ++nextPid, processStart: String(1000 + nextPid), className: 'WindowsForms10.Window.8.app.0.EightMaxTestTable', exe: 'C:\\EightMax\\desktop\\bin\\EightMaxTestTable.exe', exeSha256: SHA, client, frame: null, field: '', closed: false, minimized: false, transient: 0, transientCode: 'no-frame', reused: null, captureDelayMs: 2, moveMs: o.moveMs || 15 };
    t.dealer = new FD.TableDealer({ table: id, seed: o.seed !== undefined && extra.seedOffset === undefined ? o.seed * 1000 + id : 100 + id + (extra.seedOffset || 0), handGapMs: o.handGapMs || 50, ...(o.stackChips ? { stacks: Array(8).fill(o.stackChips) } : {}), ...(o.stacks ? { stacks: (typeof o.stacks === 'function' ? o.stacks(id) : o.stacks).slice() } : {}), ...(extra.stacks ? { stacks: extra.stacks } : {}), turnDelayMs: o.turnDelayMs || 0, actionTimeoutMs: o.actionTimeoutMs || 0, actionTimeoutUntilHand: o.actionTimeoutUntilHand, record: o.record ? (ev) => o.record(id, ev) : undefined, send: (m) => { if (m.type === 'frame') t.frame = m; } });
    t.dealer.onWindow({ type: 'ready', client, hwnd }); tables.set(hwnd, t); return t;
  }
  for (let i = 1; i <= n; i++) addWindow(i);
  const reply = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
  const describe = (t) => (t.reused ? { hwnd: t.hwnd, pid: t.reused.pid, processStart: t.reused.processStart, className: t.reused.className, exe: t.reused.exe, title: 'Some other program', client: t.client, minimized: false, visible: true, dpiScale: 1 }
    : { hwnd: t.hwnd, pid: t.pid, processStart: t.processStart, className: t.className, exe: t.exe, title: 'EightMax Test Table ' + String(t.id).padStart(2, '0'), client: t.client, minimized: t.minimized, visible: true, dpiScale: 1, registered: false });
  let inflight = null;
  async function fetch(url, init) {
    const path = url.replace('http://127.0.0.1:48713', ''), body = init.body ? JSON.parse(init.body) : {};
    if (init.headers['X-EightMax-Session'] !== TOKEN) return { ok: false, status: 403, text: async () => '{"error":"session"}' };
    if (path === '/api/capture/open') return reply({ ok: true });
    if (path === '/api/capture/close') { stats.captureClose.push(body.target && body.target.hwnd); return reply({ ok: true, closedSessions: 0 }); }
    if (path === '/api/capture/frame') {
      const t = tables.get(body.target.hwnd); stats.captureByHwnd[body.target.hwnd] = (stats.captureByHwnd[body.target.hwnd] || 0) + 1; log.push({ at: performance.now(), kind: 'capture', hwnd: body.target.hwnd });
      await sleep(t ? t.captureDelayMs : 1); if (o.onCapture) await o.onCapture(t);
      if (!t || t.closed) return reply({ ok: false, code: 'target-lost', reason: 'The window no longer exists.', minimized: false });
      if (t.reused && !t.reusedServesFrames) return reply({ ok: false, code: 'target-identity-changed', reason: 'The handle now belongs to process ' + t.reused.pid + ', not ' + t.pid + ' (handle reuse).', minimized: false });
      if (t.minimized) return reply({ ok: false, code: 'target-minimized', reason: 'The window is minimised; Windows provides no pixels for it.', minimized: true });
      if (t.transient > 0) { t.transient--; return reply({ ok: false, code: t.transientCode, reason: 'No frame from the capture session.', minimized: false }); }
      const f = t.frame; return reply({ ok: true, width: f.w, height: f.h, png: f.png, bounds: { x: t.client.x, y: t.client.y, width: t.client.w, height: t.client.h }, title: 'EightMax Test Table ' + String(t.id).padStart(2, '0') + f.title, frameId: f.rev, dpiScale: 1 });
    }
    const estopNow = () => (o.estop ? o.estop() : null) || world.estop;
    if (path === '/api/input/status') return reply({ running: true, driver: { estop: estopNow() } });
    if (path === '/api/input/estop') { world.estop = 'dashboard'; if (inflight) inflight.cancelled = 'emergency-stop'; return reply({ ok: true }); }
    if (path !== '/api/input/command') return reply({ ok: false, error: 'unknown' });
    const t = tables.get(body.hwnd);
    if (body.hwnd) { const k = INPUT.has(body.cmd) ? 'inputByHwnd' : body.cmd === 'window-info' ? 'probesByHwnd' : null; if (k) stats[k][body.hwnd] = (stats[k][body.hwnd] || 0) + 1; }
    if (INPUT.has(body.cmd)) log.push({ at: performance.now(), kind: 'input', cmd: body.cmd, hwnd: body.hwnd });
    switch (body.cmd) {
      case 'arm': if (estopNow()) return reply({ ok: false, code: 'emergency-stop', error: 'Reset the emergency stop first.' }); return reply({ ok: true, stats: {} });
      case 'reset-estop': world.estop = null; return reply({ ok: true });
      case 'monitors': return reply({ ok: true, monitors: [{ id: 0, name: 'FAKE', dpiScale: 1, primary: true, bounds: { x: 0, y: 0, w: 1920, h: 1080 } }] });
      case 'disarm': case 'status': return reply({ ok: true, stats: {}, estop: estopNow(), capabilities: { signedCurves: true, maxDeviationPx: true, singleClickGuardMaxMs: 540 } });
      case 'cancel-all': stats.cancelAll++; if (inflight) inflight.cancelled = true; return reply({ ok: true, dropped: 0 });
      case 'unregister-target': stats.unregister.push(body.hwnd); world.registered.delete(String(body.hwnd).toLowerCase()); return reply({ ok: true });
      case 'list-windows': return reply({ ok: true, windows: [...tables.values()].filter((x) => !x.closed).map(describe) });
      case 'exe-identity': if (!t || t.closed) return reply({ ok: false, code: 'window-gone', error: 'That window no longer exists.' }); return reply({ ok: true, window: describe(t), exeSha256: t.reused ? 'e'.repeat(64) : t.exeSha256 });
      case 'register-target': { if (!t || t.closed) return reply({ ok: false, code: 'window-gone', error: 'That window no longer exists.' }); const sha = t.reused ? 'e'.repeat(64) : t.exeSha256; if (body.authorization.executable.sha256 !== sha) return reply({ ok: false, code: 'authorization-refused', error: "The program's SHA-256 differs from the authorised executable." }); world.registered.add(String(body.hwnd).toLowerCase()); return reply({ ok: true, window: describe(t), exeSha256: sha }); }
      case 'window-info': if (!t || t.closed) return reply({ ok: false, code: 'window-gone', error: 'That window no longer exists.' }); if (o.onWindowInfo) o.onWindowInfo(t); return reply({ ok: true, window: describe(t) });
      case 'move-click': case 'enter-text': {
        if (estopNow()) return reply({ ok: false, code: 'emergency-stop', error: 'Emergency stop is latched (dashboard); reset it explicitly.' });
        if (o.enforceRegistration && !world.registered.has(String(body.hwnd).toLowerCase())) return reply({ ok: false, code: 'target-not-registered', error: 'Input goes only to a registered, authorised simulator window.' });
        if (!t || t.closed) return reply({ ok: false, code: 'window-gone', error: 'The simulator window was closed.' });
        if (t.reused) return reply({ ok: false, code: 'identity-changed', error: 'The window handle now belongs to a different window or process.' });
        if (t.minimized) return reply({ ok: false, code: 'window-minimized', error: 'The simulator window is minimised.' });
        if (body.expectClient && !(body.expectClient.x === t.client.x && body.expectClient.w === t.client.w && body.expectClient.y === t.client.y)) return reply({ ok: false, code: 'layout-changed', error: 'moved' });
        const op = inflight = { hwnd: body.hwnd, cancelled: false }; if (o.duringMove) await o.duringMove(t, body); await sleep(t.moveMs); inflight = null;
        if (op.cancelled === 'emergency-stop') return reply({ ok: false, code: 'emergency-stop', error: 'Operation emergency stop.' });
        if (op.cancelled) return reply({ ok: false, code: 'cancelled', error: 'Input was cancelled before button-down.' });
        if (t.closed) return reply({ ok: false, code: 'window-gone', error: 'The simulator window was closed.' });   // the driver re-checks identity while moving
        const nx = (body.to.x - t.client.x) / t.client.w, ny = (body.to.y - t.client.y) / t.client.h, hit = Object.entries({ ...FD.CONTROLS, wager: FD.WAGER_FIELD }).find(([, b]) => nx >= b.x && ny >= b.y && nx < b.x + b.w && ny < b.y + b.h);
        if (body.cmd === 'enter-text') { if (!hit || hit[0] !== 'wager') stats.violations.push('typed outside the wager field'); t.field = body.text; return reply({ ok: true, verified: true, read: body.text, plannedMs: 5, actualMs: 6 }); }
        stats.clicks++; if (!hit) { stats.violations.push('click outside every control'); return reply({ ok: true, plannedMs: 5, actualMs: 6, clickedAt: body.to }); }
        t.dealer.onWindow({ type: 'action', control: hit[0], wager: t.field, rev: t.dealer.rev });
        if (o.afterClick) await o.afterClick(t, body);
        return reply({ ok: true, plannedMs: 5, actualMs: 6, steps: 1, clickedAt: body.to });
      }
    }
    return reply({ ok: false, code: 'unknown-command', error: body.cmd });
  }
  // 0.36.2 M3: dispose() stops every dealer timer (hand gap, turn delay, action clock) so a finished test leaves no timer behind
  const dispose = () => { for (const t of tables.values()) { if (t.dealer.dispose) t.dealer.dispose(); else { clearTimeout(t.dealer.timer); clearTimeout(t.dealer.holdTimer); } } };
  return { tables, stats, log, fetch, addWindow, world, dispose, byId: (id) => [...tables.values()].filter((t) => t.id === id).pop() };
}
module.exports = { lifecycleHost, TOKEN, SHA, INPUT };
