#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 2: SIMULATOR WINDOW LIFECYCLE ACCEPTANCE with REAL windows, REAL capture and REAL input.
 *
 *   node tools/lifecycle-acceptance-0362m2.cjs [--out FILE] [--only A,B,...] [--speed 1200]          (Windows: real host, driver, test tables)
 *   node tools/lifecycle-acceptance-0362m2.cjs --fake [--out FILE]                                     (any OS: same scenarios, fake host - self-check only)
 *
 * Starts a private headless desktop host and the bundled controlled test tables (tools/test-table-035.cjs, EightMaxTestTable.exe),
 * registers them like the dashboard does, and runs the Milestone 2 scenarios with the production SimulatorTable / InputScheduler code:
 *   J scripted practice plays hand after hand     A window closes during capture        B window closes during mouse movement
 *   C simulator restarts with a different handle  D temporary capture failures          E minimised window
 *   F several tables, one closes                  G emergency stop during recovery       H repeated target-loss signals
 *   I identity mismatch / handle-reuse refusal    K window resized while playing (geometry / scaling re-check)
 * Every request to the host is counted per window handle, so "no capture / no input after the loss" is measured, not assumed.
 * The mouse moves visibly into the test tables: do not touch the mouse or keyboard while it runs (about 6-10 minutes).
 * Deep stacks (--stack-chips 100000): the hand tracker cannot yet follow a hand that starts with ELIMINATED players (pre-existing
 * since 0.36.1, see REPORT-0.36.2-Milestone-2.md), so the scenarios keep eliminations out of the hands they play.
 * --fake runs the identical scenario code against tests/lifecycle-host-fixture.cjs; it verifies the scenario logic only and is
 * reported as such ("environment":"fake"), never as Windows evidence.
 *
 * 0.36.2 Milestone 3 - resource cleanup. Milestone 2 raced every scenario against sleep(120 s / 480 s) and never cleared that timer, so
 * after the last scenario the process stayed alive up to 8 minutes with its complete report already written (23 live timers measured in
 * evidence/0.36.2-m3/baseline-M2-exit-audit.json); a scenario that hit its limit kept running in the background with its tables and
 * fixture processes; fixture command waiters and several cleanup races left timers behind. Now: every timeout is cancellable and is
 * cleared when the awaited work settles (success or failure); each scenario owns a resource scope (tables, run loops, fixtures, child
 * processes) that is cleaned up after success, failure AND timeout, and a timed-out scenario is aborted and awaited (bounded) before the
 * next one starts; child processes are awaited until they have exited; the report records a cleanup audit (live resources, child
 * processes) and a run that leaves unexpected work behind is reported as FAIL - nothing is hidden by forcing the process to exit.
 */
const path = require('path'), fs = require('fs'), cp = require('child_process'), crypto = require('crypto'), os = require('os');
const ROOT = path.join(__dirname, '..'), src = (m) => require(path.join(ROOT, 'src', m));
const SC = src('simulator-controls.js'), SP = src('simulator-profiles.js'), SCH = src('input-scheduler.js'), XA = src('execution-adapters.js'), LC = src('window-lifecycle.js'), M = src('input-motion.js'), EM = src('engine.js');
const LS = LC.STATES, arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; }, has = (k) => process.argv.includes('--' + k);
const FAKE = has('fake'), OUT = arg('out', path.join(ROOT, 'reports', '0.36.2-m2-lifecycle-acceptance' + (FAKE ? '-fake' : '') + '.json')), ONLY = (arg('only', '') || '').split(',').filter(Boolean);
const SPEED = Number(arg('speed', '1200')), MOTION = M.profile({ maxSpeed: SPEED, arc: 0.12, maxDeviationPx: 240 }), WORK = arg('work', path.join(os.tmpdir(), 'em0362m2-' + Date.now()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), mono = () => performance.now(), INPUT = new Set(['focus', 'move', 'move-click', 'click', 'double-click', 'mouse-down', 'mouse-up', 'key', 'type', 'clear-field', 'enter-text']);
/* ---------------- 0.36.2 M3: cancellable timeouts and scenario scopes ---------------- */
/** A timeout whose timer is always cleared: cancel() after the awaited work settled, whether it succeeded or failed. */
function timeout(ms, label) { let timer = null; const promise = new Promise((_, reject) => { timer = setTimeout(() => { timer = null; const e = new Error(label + ' exceeded ' + ms + ' ms'); e.code = 'ETIMEOUT'; reject(e); }, ms); }); return { promise, cancel: () => { if (timer) { clearTimeout(timer); timer = null; } } }; }
/** work or a genuine timeout failure; the timer never outlives the race. */
async function withTimeout(work, ms, label) { const t = timeout(ms, label); try { return await Promise.race([work, t.promise]); } finally { t.cancel(); } }
/** Wait at most ms for work to settle (either way): 'done' | 'timeout'. */
async function settleWithin(work, ms) { const t = timeout(ms, 'settle'); try { await Promise.race([Promise.resolve(work).then(() => 'done', () => 'done'), t.promise]); return 'done'; } catch (e) { return 'timeout'; } finally { t.cancel(); } }
/** Everything a scenario starts is registered here so it can be cleaned up after success, failure or timeout. */
class Scope {
  constructor(id) { this.id = id; this.tables = []; this.runs = []; this.cleanups = []; this.aborted = false; this.cleaned = false; this.recorders = []; this.watched = []; }
  table(t) { this.tables.push(t); return t; }
  recorder(rec) { this.recorders.push(rec); return rec; }   // 0.36.2 M3: kept for the failure dump (diagnosticsDump)
  watch(t) { this.watched.push(t); return t; }              // a table another scope owns, included in the failure dump
  run(p) { this.runs.push(p); return p; }
  onCleanup(fn) { this.cleanups.push(fn); }
  async cleanup(reason) {
    if (this.cleaned) return; this.cleaned = true;
    for (const t of this.tables) { try { t.stop(reason); } catch (e) { /* already stopped */ } }
    await settleWithin(Promise.allSettled(this.runs), 15000);
    for (const t of this.tables) { try { t.dispose(); } catch (e) { /* ignore */ } }
    for (const fn of this.cleanups.reverse()) { try { await settleWithin(Promise.resolve().then(fn), 20000); } catch (e) { /* best effort */ } }
  }
}
let SCOPE = null;   // the running scenario's scope (scenarios run one at a time)
/** 0.36.2 M3: what a FAILED scenario leaves for diagnosis (written next to the fixtures' oracle files, so it reaches the CI results branch):
 * each table's lifecycle / gameplay condition / tracking status and the last diagnostics events of every recorder it used. */
function diagnosticsDump(scope) {
  const tables = scope.tables.concat(scope.watched).filter((t, i, a) => a.indexOf(t) === i).map((t) => { const q = (f) => { try { return f(); } catch (e) { return 'unavailable: ' + e.message; } };
    return { table: t.id, hwnd: t.win && t.win.hwnd, lifecycle: q(() => t.lc.state), cause: q(() => t.lc.cause), gameplay: q(() => t.gameplay), tracking: q(() => t.engine.trackingStatus()), tournament: q(() => t.engine.tournamentStatus()),
      lastConfirm: t._lastConfirm || null, counts: q(() => Object.fromEntries(Object.entries(t.m).filter(([, v]) => typeof v === 'number'))), rejections: q(() => t.engine.rejections.slice(-20)) }; });
  return { scenario: scope.id, at: new Date().toISOString(), tables, recorders: scope.recorders.map((r) => ({ counts: r.counts, failureTotals: r.failureTotals, dropped: r.dropped, suppressed: r.suppressed, events: r.events.slice(-300) })) };
}
const T = FAKE ? { ack: 800, poll: 5, idle: 5, retryBase: 40, retryMax: 320, settle: 400, scale: 0.25 } : { ack: 4000, poll: 60, idle: 120, retryBase: 250, retryMax: 4000, settle: 3000, scale: 1 };
fs.mkdirSync(WORK, { recursive: true });

/* ---------------- 0.36.2 M3: child processes started by this run ---------------- */
const CHILDREN = [];
function track(child, name) {
  const info = { name, pid: child.pid, exited: false, code: null, signal: null }; let resolve; const promise = new Promise((r) => { resolve = r; });
  const rec = { info, promise, done: false }; child.once('exit', (code, signal) => { info.exited = true; info.code = code; info.signal = signal; rec.done = true; resolve(info); }); child.once('error', (e) => { info.error = e.message; if (!rec.done) { info.exited = true; rec.done = true; resolve(info); } });
  CHILDREN.push(rec); return rec;
}

/* ---------------- request accounting (both environments) ---------------- */
function counting(baseFetch, log, hooks) {
  return async (url, init) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, ''); let body = {}; try { body = init && init.body ? JSON.parse(init.body) : {}; } catch (e) { /* not json */ }
    const hwnd = (body.target && body.target.hwnd) || body.hwnd || null, kind = p === '/api/capture/frame' ? 'capture' : p === '/api/input/command' ? (INPUT.has(body.cmd) ? 'input' : body.cmd === 'window-info' ? 'probe' : 'driver') : 'other';
    const e = { at: mono(), kind, path: p, cmd: body.cmd || null, hwnd: hwnd ? LC.normHwnd(hwnd) : null }; log.push(e); if (log.length > 200000) log.splice(0, 50000);
    if (hooks.onRequest) { try { hooks.onRequest(e, body); } catch (x) { /* hook */ } }
    return baseFetch(url, init);
  };
}
const since = (log, kind, hwnd, t0, cmd) => log.filter((e) => e.kind === kind && e.hwnd === LC.normHwnd(hwnd) && e.at >= t0 && (!cmd || e.cmd === cmd)).length;

/* ---------------- environments ---------------- */
async function windowsEnv() {
  if (process.platform !== 'win32') throw new Error('Real-window acceptance needs Windows (use --fake for the logic self-check).');
  const BIN = path.join(ROOT, 'desktop', 'bin'), ready = path.join(WORK, 'host-ready.json');
  const host = cp.spawn(path.join(BIN, 'EightMaxWorkbench.exe'), ['--root', ROOT, '--ready', ready, '--headless'], { stdio: 'ignore' }), hostExit = track(host, 'desktop host');
  let info = null; const t0 = Date.now(); while (Date.now() - t0 < 60000) { try { info = JSON.parse(fs.readFileSync(ready, 'utf8')); if (info.token) break; } catch (e) { /* not yet */ } await sleep(250); }
  if (!info || !info.token) throw new Error('desktop host did not become ready');
  const log = [], hooks = {}, f = counting(fetch, log, hooks), api = new SC.HostApi({ token: info.token, fetch: f, maxConcurrent: 6 }), session = SC.hostSession(api);
  const exeSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(BIN, 'EightMaxTestTable.exe'))).digest('hex');
  let seq = 0;
  function fixture(n, o = {}) {
    const dir = path.join(WORK, 'fx-' + (++seq)); fs.mkdirSync(dir, { recursive: true });
    // 0.36.2 M3: o.stackChips / o.stacks (per seat, 0 = eliminated) / o.handGap / o.turnDelay / o.actionTimeout (+ o.clockUntilHand) / o.layout
    const extra = [...(o.stacks ? ['--stacks', o.stacks.join(',')] : []), ...(o.actionTimeout ? ['--action-timeout', String(o.actionTimeout)] : []), ...(o.clockUntilHand !== undefined ? ['--action-timeout-until-hand', String(o.clockUntilHand)] : [])];
    const child = cp.spawn(process.execPath, [path.join(ROOT, 'tools', 'test-table-035.cjs'), '--tables', String(n), '--width', String(o.width || 800), '--layout', o.layout || 'grid', '--oracle-dir', dir, '--hand-gap', String(o.handGap || 1200), '--turn-delay', String(o.turnDelay || 0), '--stack-chips', String(o.stackChips || 100000), '--seed', String(o.seed || seq), '--keep-alive', ...extra, '--exe', path.join(BIN, 'EightMaxTestTable.exe')], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = track(child, 'test-table fixture ' + seq);
    const msgs = [], waiters = []; let buf = '', id = 0;
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); try { const m = JSON.parse(l); const w = waiters.find((x) => x.f(m)); if (w) { waiters.splice(waiters.indexOf(w), 1); w.r(m); } else msgs.push(m); } catch (e) { /* skip */ } } });
    // 0.36.2 M3: the waiter's timer is cleared when the message arrives (Milestone 2 left a 10-40 s timer per command)
    const wait = (fn, ms = 40000) => { const hit = msgs.find(fn); if (hit) { msgs.splice(msgs.indexOf(hit), 1); return Promise.resolve(hit); } return new Promise((r, j) => { const w = { f: fn, r: (m) => { clearTimeout(w.timer); r(m); } }; waiters.push(w); w.timer = setTimeout(() => { if (waiters.includes(w)) { waiters.splice(waiters.indexOf(w), 1); j(new Error('fixture timeout')); } }, ms); }); };
    const cmd = async (c) => { const i = ++id; child.stdin.write(JSON.stringify({ id: i, ...c }) + '\n'); return wait((m) => m.id === i, c.cmd === 'reopen' ? 40000 : 10000); };
    return { ready: async () => (await wait((m) => m.type === 'ready')).tables, close: async (table) => { await cmd({ cmd: 'close', table }); await wait((m) => m.type === 'exited' && m.table === table, 10000).catch(() => null); },
      minimize: (table) => cmd({ cmd: 'minimize', table }), restore: (table) => cmd({ cmd: 'restore', table }), move: (table, x, y, w) => cmd({ cmd: 'move', table, x, y, w }),
      reopen: async (table) => { const m = await cmd({ cmd: 'reopen', table }); return { table: m.table, hwnd: m.hwnd, pid: m.pid, client: m.client }; },
      act: async (table, control) => cmd({ cmd: 'act', table, control }), clock: async (table, ms, untilHand) => cmd({ cmd: 'clock', table, ms, untilHand }),   // 0.36.2 M3 test controls
      oracle: async (full) => (await cmd({ cmd: 'summary', full: !!full })).tables,
      // 0.36.2 M3: ask the fixture to stop, wait until the process has EXITED (bounded), kill only if it did not, and wait again
      stop: async () => { if (exited.done) return exited.info; try { child.stdin.write('{"cmd":"stop"}\n'); child.stdin.end(); } catch (e) { /* gone */ } if (await settleWithin(exited.promise, 8000) === 'timeout') { try { child.kill(); } catch (e) { /* gone */ } await settleWithin(exited.promise, 5000); } for (const w of waiters.splice(0)) clearTimeout(w.timer); return exited.info; } };
  }
  const estop = async () => { await api.request('/api/input/estop', {}); }, resetEstop = async () => { for (let i = 0; i < 20; i++) { const r = await session.request('reset-estop'); if (r.ok) return; await sleep(250); } };
  // 0.36.2 M3: authenticated shutdown, then wait until the host process has EXITED (bounded); kill only if it did not
  const stop = async () => { try { await api.request('/api/input/stop', {}); } catch (e) { /* closing */ } try { await fetch('http://127.0.0.1:48713/api/desktop/shutdown', { method: 'POST', headers: { 'X-EightMax-Session': info.token } }); } catch (e) { /* closing */ } if (await settleWithin(hostExit.promise, 15000) === 'timeout') { try { host.kill(); } catch (e) { /* gone */ } await settleWithin(hostExit.promise, 5000); } };
  const health = await api.request('/api/desktop/health'), mon = await session.request('monitors'), st = await session.request('status');
  session.capabilities = st && st.capabilities;   // as the dashboard does: real click-guard timing for the scheduler's deadline estimate
  if (!st || !st.capabilities || !st.capabilities.signedCurves) throw new Error('The rebuilt 0.36.x input driver is required (signedCurves capability missing)');
  return { kind: 'windows', api, session, log, hooks, exeSha, fixture, estop, resetEstop, stop, facts: { appVersion: health.appVersion, build: health.build || health.eightmaxBuild || null, driver: st && st.capabilities && { dpiAwareness: st.capabilities.dpiAwareness, hotkeyRegistered: st.capabilities.hotkeyRegistered, signedCurves: st.capabilities.signedCurves }, monitors: mon && mon.monitors } };
}
let fakeSeq = 0;
async function fakeEnv() {
  const { lifecycleHost, TOKEN, SHA } = require(path.join(ROOT, 'tests', 'lifecycle-host-fixture.cjs'));
  const log = [], hooks = {}; let host = lifecycleHost(0); const f = counting((u, i) => host.fetch(u, i), log, hooks), api = new SC.HostApi({ token: TOKEN, fetch: f }), session = SC.hostSession(api); session.capabilities = { signedCurves: true, maxDeviationPx: true, singleClickGuardMaxMs: 540 };
  function fixture(n, o = {}) {
    fakeSeq++;   // 0.36.2 M3: the Windows fixture's size (o.width || 800) and dealer seeds ((o.seed || run order) * 1000 + table), so this self-check deals the Windows run's hands
    const gens = {};   // reopened windows per table (the Windows fixture's generation: each one deals its own hands)
    const h = host = lifecycleHost(n, { width: o.width || 800, seed: o.seed || fakeSeq, enforceRegistration: true, handGapMs: o.handGapFake || 400, stackChips: o.stackChips || 100000, stacks: o.stacks, turnDelayMs: o.turnDelayFake || 0, actionTimeoutMs: o.actionTimeout || 0, actionTimeoutUntilHand: o.clockUntilHand }); const w = (table) => h.byId(table);   // handGapMs: a realistic pause between hands (the Windows run uses --hand-gap 1200)
    return { ready: async () => [...host.tables.values()].map((t) => ({ table: t.id, hwnd: t.hwnd, pid: t.pid, client: t.client })), close: async (table) => { const t = w(table); t.closed = true; t.dealer.onWindow({ type: 'closed' }); },
      minimize: async (table) => { w(table).minimized = true; }, restore: async (table) => { w(table).minimized = false; }, move: async (table, x, y, width) => { const t = w(table); t.client = { x, y, w: width, h: Math.round(width / 1.6) }; },
      reopen: async (table) => { gens[table] = (gens[table] || 0) + 1; const t = h.addWindow(table, { generation: gens[table], ...(o.stacks ? { stacks: o.stacks.slice() } : {}) }); return { table, hwnd: t.hwnd, pid: t.pid, client: t.client }; },
      act: async (table, control) => { const d = w(table).dealer, before = d.counts.accepted; d.onWindow({ type: 'action', control, wager: '', rev: d.rev }); return { accepted: d.counts.accepted > before, hand: d.t.hand }; },
      clock: async (table, ms, untilHand) => { const d = w(table).dealer; d.actionTimeout = ms || 0; d.actionTimeoutUntilHand = untilHand === undefined ? Infinity : untilHand; d.armClock(); return { ok: true }; },
      oracle: async (full) => [...h.tables.values()].filter((t) => !t.closed).map((t) => ({ ...t.dealer.summary(full), hwnd: t.hwnd })).concat([...h.tables.values()].filter((t) => t.closed).map((t) => ({ ...t.dealer.summary(full), hwnd: t.hwnd, closed: true }))), stop: async () => { if (h.dispose) h.dispose(); } };   // 0.36.2 M3: dealer timers stop with the fixture
  }
  return { kind: 'fake', api, session, log, hooks, exeSha: SHA, fixture, estop: async () => { await api.request('/api/input/estop', {}); }, resetEstop: async () => { await session.request('reset-estop'); }, stop: async () => {}, facts: { note: 'fake host: scenario-logic self-check, NOT Windows evidence' } };
}

/* ---------------- shared helpers ---------------- */
async function register(env, w, o = {}) {
  const auth = SC.authorizations({ environment: 'controlled-test-table', approvedBy: 'Milestone 2 lifecycle acceptance (bundled fixture)', exeFileName: 'EightMaxTestTable.exe', exeSha256: env.exeSha, hours: 1 });
  const reg = await env.session.request('register-target', { hwnd: w.hwnd, authorization: auth.simulator, label: 'table ' + w.table }); if (!reg.ok) throw new Error('registration refused: ' + reg.error);
  return { auth, reg, identity: LC.identityOf({ ...(reg.window || {}), hwnd: w.hwnd, pid: (reg.window && reg.window.pid) || w.pid, client: (reg.window && reg.window.client) || w.client }, { exeSha256: env.exeSha }) };
}
function table(env, w, r, sched, rec, o = {}) {
  return new SC.SimulatorTable({ id: w.table, window: { hwnd: w.hwnd, pid: w.pid, title: 'EightMax Test Table ' + String(w.table).padStart(2, '0'), client: w.client }, identity: o.identity || r.identity, lifecycle: o.lifecycle,
    profile: SP.fixtureProfile({ exeSha256: env.exeSha }), api: env.api, session: env.session, scheduler: sched, qaAuthorization: r.auth.qa, recorder: rec, allowScripted: true, seed: w.table, motion: MOTION, movement: { pattern: 'straight', seed: 1 }, timing: FAKE ? { postClickSettleMs: 0 } : undefined,
    options: { decisionWindowMs: 10000, postActionTimeoutMs: T.ack, pollMs: T.poll, idlePollMs: T.idle, stopOnPause: false, retryBaseMs: T.retryBase, retryMaxMs: T.retryMax, identityCheckMs: o.identityCheckMs || 5000, ...(o.options || {}) } });
}
async function until(pred, ms, step = 25) { const end = mono() + ms; while (mono() < end) { if (SCOPE && SCOPE.aborted) return !!pred(); if (pred()) return true; await sleep(step); } return !!pred(); }
async function setup(env, n, o = {}) {
  const fx = env.fixture(n, o); if (SCOPE) SCOPE.onCleanup(() => fx.stop()); const ws = await fx.ready(), rec = SCOPE ? SCOPE.recorder(new XA.DiagnosticsRecorder({ max: 20000 })) : new XA.DiagnosticsRecorder({ max: 20000 }), sched = new SCH.InputScheduler({ maxQueue: 16, onCancel: () => env.session.request('cancel-all') });
  const regs = [], tables = []; for (const w of ws) { const r = await register(env, w); regs.push(r); const t = table(env, w, r, sched, rec, o); const op = await t.capture.open(); if (!op || op.ok !== true) throw new Error('capture refused: ' + JSON.stringify(op)); tables.push(t); }
  const arm = await env.session.request('arm'); if (!arm.ok) throw new Error('arm refused: ' + arm.error);
  if (o.beforeRun) await o.beforeRun(fx, ws, tables);   // 0.36.2 M3: e.g. an action made before automation starts reading
  const runs = tables.map((t) => t.run(Infinity)); const sc = SCOPE;
  if (sc) { tables.forEach((t) => sc.table(t)); runs.forEach((r) => sc.run(r)); }
  let doneOnce = null;
  const done = () => doneOnce || (doneOnce = (async () => { for (const t of tables) t.stop(); await settleWithin(Promise.allSettled(runs), 15000); for (const t of tables) t.dispose(); await env.session.request('disarm'); for (const w of ws) await env.session.request('unregister-target', { hwnd: w.hwnd }); await fx.stop(); })());
  if (sc) sc.onCleanup(done);
  return { fx, ws, rec, sched, regs, tables, runs, done };
}
function grade(o) { const c = o && o.counts ? o.counts : {}; return { incorrect: (c.downOutsideControls || 0) + (c.downOnDisabled || 0) + (c.doubleClicks || 0) + (c.staleClicks || 0) + (c.illegal || 0), wagerRejected: c.wagerRejected || 0, accepted: c.accepted || 0 }; }
function checker() { const checks = []; const ck = (name, pass, detail) => { checks.push({ name, pass: !!pass, detail: detail === undefined ? null : detail }); return !!pass; }; return { checks, ck }; }

/* ---------------- scenarios ---------------- */
const SCENARIOS = {
  J: ['Scripted practice plays hand after hand (no regression)', async (env) => {
    const { checks, ck } = checker(), s = await setup(env, 1), [t] = s.tables;
    try {
      const hands = () => new Set(t.log.filter((e) => e.status === 'confirmed').map((e) => e.hand)).size;
      await until(() => t.m.confirmed >= 12 && hands() >= 2, 150000);
      const o = (await s.fx.oracle())[0], g = grade(o);
      ck('at least 12 confirmed actions', t.m.confirmed >= 12, t.m.confirmed); ck('continued hand-to-hand play (2+ hands with confirmed actions)', hands() >= 2, hands()); ck('no ambiguous / timed-out / uncertain action', t.m.ambiguous + t.m.timedOut + t.m.uncertain === 0, [t.m.ambiguous, t.m.timedOut, t.m.uncertain]);
      ck('no incorrect click or wager (oracle)', g.incorrect === 0 && g.wagerRejected === 0, g); ck('every confirmed action reached the table', g.accepted >= t.m.confirmed, g.accepted + ' accepted / ' + t.m.confirmed + ' confirmed');
      ck('lifecycle ACTIVE, one transition (REGISTERED -> ACTIVE)', t.lc.state === LS.ACTIVE && t.lc.counts.transitions === 1, t.lc.history.map((h) => h.to).join(' > '));
      return { checks, metrics: t.report().latencyMs };
    } finally { await s.done(); }
  }],
  A: ['Window closes during capture', async (env) => {
    const { checks, ck } = checker(), s = await setup(env, 1), [t] = s.tables, w = s.ws[0];
    try {
      await until(() => t.m.confirmed >= 2, 60000); await s.fx.close(1); const tc = mono();
      const lost = await until(() => t.lc.terminal, 10000), tl = mono(), ended = (await settleWithin(s.runs[0], 5000)) === 'done';
      ck('TARGET_LOST detected', lost, t.lc.state); ck('detected within 10 s of the close', lost && tl - tc < 10000, Math.round(tl - tc) + ' ms'); ck('automation loop ended (no infinite retries)', ended);
      const c0 = since(env.log, 'capture', w.hwnd, tl), i0 = since(env.log, 'input', w.hwnd, tl); await sleep(T.settle);
      ck('no capture request after the loss', since(env.log, 'capture', w.hwnd, tl) === 0, c0); ck('no input after the loss', since(env.log, 'input', w.hwnd, tl) === 0, i0);
      ck('capture requests between close and loss are bounded', since(env.log, 'capture', w.hwnd, tc) <= 5, since(env.log, 'capture', w.hwnd, tc));
      ck('driver authorisation revoked', env.log.some((e) => e.cmd === 'unregister-target' && e.hwnd === LC.normHwnd(w.hwnd))); ck('reason recorded', !!(t.lost && t.lost.reason), t.lost && t.lost.reason);
      return { checks, metrics: { detectMs: Math.round(tl - tc), lifecycle: t.lc.snapshot() } };
    } finally { await s.done(); }
  }],
  B: ['Window closes during mouse movement', async (env) => {
    const { checks, ck } = checker(), s = await setup(env, 2), [t1, t2] = s.tables, [w1, w2] = s.ws; let armed = false, closedAt = null;
    env.hooks.onRequest = (e) => { if (armed && e.kind === 'input' && e.cmd === 'move-click' && e.hwnd === LC.normHwnd(w1.hwnd)) { armed = false; setTimeout(() => { closedAt = mono(); s.fx.close(1); }, FAKE ? 1 : 40); } };
    try {
      await until(() => t1.m.confirmed >= 2 && t2.m.confirmed >= 1, 90000); const o0 = await s.fx.oracle(); armed = true;
      const lost = await until(() => t1.lc.terminal, 30000); env.hooks.onRequest = null; const c2 = t2.m.confirmed;
      ck('TARGET_LOST after a close during movement', lost, t1.lc.state); ck('the close happened while the click was moving', closedAt !== null);
      const last = t1.log[t1.log.length - 1] || {}; ck('final action status recorded (refused before the click, or uncertain for review)', last.status === 'rejected' || last.status === 'uncertain', last.status + ': ' + last.reason);
      if (last.status === 'uncertain') ck('uncertain action flagged for review', last.reviewRequired === true);
      await sleep(T.settle); ck('no input to the lost window afterwards', since(env.log, 'input', w1.hwnd, closedAt + 3000) === 0);
      await until(() => t2.m.confirmed >= c2 + 3, 60000); ck('the other table keeps playing', t2.m.confirmed >= c2 + 3, t2.m.confirmed - c2);
      const o2 = (await s.fx.oracle()).find((x) => x.table === 2), g2 = grade(o2); ck('no input redirected to the other table (its oracle is clean)', g2.incorrect === 0 && g2.accepted >= t2.m.confirmed, g2);
      ck('table 2 still ACTIVE', t2.lc.state === LS.ACTIVE, t2.lc.state);
      return { checks, metrics: { t1: t1.report().recovery, cancellation: t1.cancellation } };
    } finally { env.hooks.onRequest = null; await s.done(); }
  }],
  C: ['Simulator restarts with a different handle', async (env) => {
    const { checks, ck } = checker(), s = await setup(env, 1), [t] = s.tables, w = s.ws[0];
    try {
      await until(() => t.m.confirmed >= 2, 60000); await s.fx.close(1); await until(() => t.lc.terminal, 10000); ck('old registration TARGET_LOST', t.lc.terminal, t.lc.state);
      const nw = await s.fx.reopen(1), tr = mono(); ck('the reopened window has a different handle', LC.normHwnd(nw.hwnd) !== LC.normHwnd(w.hwnd), nw.hwnd + ' vs ' + w.hwnd);
      const win = (await env.session.call('list-windows')).windows, cands = LC.replacementCandidates(t.identity, win, { registrationId: t.registrationId }), cand = cands.find((c) => LC.normHwnd(c.hwnd) === LC.normHwnd(nw.hwnd));
      ck('replacement detected as a candidate', !!cand, cands.length ? cands.map((c) => c.hwnd) : { lost: { hwnd: t.identity.hwnd, exe: t.identity.exe, pid: t.identity.pid }, windows: win.map((x) => ({ hwnd: x.hwnd, exe: x.exe, pid: x.pid, minimized: x.minimized, registered: x.registered })) }); const id = await env.session.call('exe-identity', { hwnd: nw.hwnd }); ck('candidate is the same program (SHA-256)', id.exeSha256 === env.exeSha);
      for (let i = 0; i < 3; i++) await t.step(); await sleep(T.settle);
      ck('no capture of the candidate before confirmation', since(env.log, 'capture', nw.hwnd, tr) === 0); ck('no automatic input to the candidate', since(env.log, 'input', nw.hwnd, tr) === 0);
      const inherit = table(env, nw, s.regs[0], s.sched, s.rec, { lifecycle: t.lc }); ck('the lost lifecycle cannot be reused for the new window', (await inherit.step()).kind === 'lost' && since(env.log, 'capture', nw.hwnd, tr) === 0);
      const r2 = await register(env, nw), t2 = table(env, nw, r2, s.sched, s.rec, { lifecycle: new LC.WindowLifecycle({ table: 1, identity: r2.identity, replaces: t.registrationId }) }); await t2.capture.open();
      ck('explicit re-registration starts REGISTERED', t2.lc.state === LS.REGISTERED); if (SCOPE) SCOPE.table(t2); const run2 = t2.run(Infinity); if (SCOPE) SCOPE.run(run2);
      await until(() => t2.m.confirmed >= 3, 90000); ck('after explicit confirmation the replacement plays', t2.m.confirmed >= 3, t2.m.confirmed); ck('replacement ACTIVE', t2.lc.state === LS.ACTIVE, t2.lc.state);
      t2.stop(); await settleWithin(run2, 10000); t2.dispose(); await env.session.request('unregister-target', { hwnd: nw.hwnd });
      return { checks, metrics: { candidate: cand || null } };
    } finally { await s.done(); }
  }],
  D: ['Temporary capture failures (injected while the window stays open)', async (env) => {
    const { checks, ck } = checker(), s = await setup(env, 1), [t] = s.tables;
    try {
      await until(() => t.m.confirmed >= 2, 60000); let left = 4, n0 = null, g0 = null; const ti = [];
      // faults hit the reading path only (not the confirmation of an action already in flight): _activeToken is null outside execution
      t.capture.inject = () => { if (left > 0 && t._activeToken === null) { if (n0 === null) { n0 = t.log.length; g0 = t.lc.generation; } left--; ti.push(mono()); return { code: 'no-frame', reason: 'injected by the Milestone 2 acceptance test' }; } return null; };
      await until(() => t.lc.state === LS.TEMPORARILY_UNAVAILABLE, 15000); ck('TEMPORARILY_UNAVAILABLE', t.lc.history.some((h) => h.to === LS.TEMPORARILY_UNAVAILABLE && h.code === 'no-frame'));
      const c0 = t.m.confirmed; await until(() => t.lc.state === LS.ACTIVE && t.m.confirmed >= c0 + 2, 90000); t.capture.inject = null;
      const gaps = ti.slice(1).map((x, i) => Math.round(x - ti[i])); ck('bounded backoff between retries', gaps.every((g, i) => g >= T.retryBase * Math.pow(2, i) * 0.8), gaps);
      ck('recovered via RECOVERY_PENDING to ACTIVE', t.lc.state === LS.ACTIVE && t.lc.history.some((h) => h.to === LS.RECOVERY_PENDING), t.lc.history.map((h) => h.to).join(' > '));
      const first = t.log[n0]; ck('no stale action: the next action was decided after recovery', !!first && first.generation > g0 + 2, first && first.generation + ' vs ' + g0);
      ck('play continues', t.m.confirmed >= c0 + 2, t.m.confirmed - c0); ck('classification recorded', t.m.captureFailuresByCode['no-frame'] === 4, t.m.captureFailuresByCode);
      return { checks, metrics: { gaps, recovery: t.report().recovery } };
    } finally { await s.done(); }
  }],
  E: ['Minimised window', async (env) => {
    const { checks, ck } = checker(), s = await setup(env, 1), [t] = s.tables, w = s.ws[0];
    try {
      await until(() => t.m.confirmed >= 2, 60000); await s.fx.minimize(1); const tm = mono();
      await until(() => t.lc.state === LS.TEMPORARILY_UNAVAILABLE, 15000); ck('TEMPORARILY_UNAVAILABLE (minimised)', t.lc.state === LS.TEMPORARILY_UNAVAILABLE && t.lc.cause.kind === 'minimized', t.lc.state + ' / ' + t.lc.cause.kind);
      const tu = mono(); await sleep(T.settle); ck('no input while minimised', since(env.log, 'input', w.hwnd, tu) === 0, since(env.log, 'input', w.hwnd, tu)); ck('captures back off while minimised', since(env.log, 'capture', w.hwnd, tu) <= Math.ceil(T.settle / T.retryBase), since(env.log, 'capture', w.hwnd, tu));
      await s.fx.restore(1); const c0 = t.m.confirmed; await until(() => t.lc.state === LS.ACTIVE && t.m.confirmed >= c0 + 2, 90000);
      ck('restored, verified again and playing', t.lc.state === LS.ACTIVE && t.m.confirmed >= c0 + 2, t.m.confirmed - c0); ck('never lost', !t.lc.history.some((h) => h.to === LS.TARGET_LOST));
      return { checks, metrics: { minimizedForMs: Math.round(mono() - tm) } };
    } finally { await s.done(); }
  }],
  F: ['Several tables, one closes', async (env) => {
    const { checks, ck } = checker(), s = await setup(env, 3), [t1, t2, t3] = s.tables, w2 = s.ws[1];
    try {
      await until(() => s.tables.every((t) => t.m.confirmed >= 2), 150000); await s.fx.close(2); await until(() => t2.lc.terminal, 15000); const tl = mono(), c1 = t1.m.confirmed, c3 = t3.m.confirmed;
      ck('only the closed table is lost', t2.lc.terminal && !t1.lc.terminal && !t3.lc.terminal, [t1.lc.state, t2.lc.state, t3.lc.state]);
      await until(() => t1.m.confirmed >= c1 + 3 && t3.m.confirmed >= c3 + 3, 150000); ck('the other tables keep playing', t1.m.confirmed >= c1 + 3 && t3.m.confirmed >= c3 + 3, [t1.m.confirmed - c1, t3.m.confirmed - c3]);
      ck('no input to the lost window', since(env.log, 'input', w2.hwnd, tl) === 0); ck('the scheduler blocks only table 2', s.sched.status().unavailableTables.join() === '2', s.sched.status().unavailableTables);
      const o = await s.fx.oracle(); for (const k of [1, 3]) { const g = grade(o.find((x) => x.table === k)), t = s.tables[k - 1]; ck('table ' + k + ' oracle clean (no redirected input)', g.incorrect === 0 && g.accepted >= t.m.confirmed, g); }
      return { checks, metrics: { states: s.tables.map((t) => t.lc.state) } };
    } finally { await s.done(); }
  }],
  G: ['Emergency stop during recovery', async (env) => {
    const { checks, ck } = checker(), s = await setup(env, 1), [t] = s.tables, w = s.ws[0];
    try {
      await until(() => t.m.confirmed >= 2, 60000); await s.fx.minimize(1); await until(() => t.lc.state === LS.TEMPORARILY_UNAVAILABLE, 15000);
      await env.estop(); s.sched.emergencyStop('acceptance'); t.safetyPause('emergency-stop', 'emergency stop (acceptance test)'); t.stop(); const te = mono();
      await s.fx.restore(1); await sleep(T.settle);
      ck('lifecycle SAFETY_PAUSED (emergency stop wins)', t.lc.state === LS.SAFETY_PAUSED && t.lc.cause.kind === 'emergency-stop', t.lc.state);
      ck('no input after the stop, even after the window came back', since(env.log, 'input', w.hwnd, te) === 0);
      ck('automatic recovery is refused without the operator', t.lc.transition(LS.RECOVERY_PENDING, { kind: 'auto' }).refused === 'operator-required');
      const arm = await env.session.request('arm'); ck('the driver refuses to arm while the stop is latched', arm.ok === false, arm.code);
      const j = await s.sched.submit({ table: 1, registrationId: t.registrationId, kind: 'fold', deadline: mono() + 5000, run: async () => 'ran' }); ck('the scheduler refuses input until reset', j.code === 'emergency-stop', j.code);
      await env.resetEstop(); s.sched.reset();
      return { checks, metrics: { lifecycle: t.lc.snapshot().history.map((h) => h.to) } };
    } finally { await env.resetEstop().catch(() => null); await s.done(); }
  }],
  H: ['Repeated target-loss signals', async (env) => {
    const ts = mono(), { checks, ck } = checker(), s = await setup(env, 1), [t] = s.tables, w = s.ws[0];
    try {
      await until(() => t.m.confirmed >= 1, 60000); await s.fx.close(1); await until(() => t.lc.terminal, 10000); const tl = mono();
      const rs = await Promise.all(Array.from({ length: 100 }, (_, i) => (i % 2 ? t.look() : Promise.resolve(t.targetLost({ kind: 'window-closed', reason: 'repeated signal ' + i })))));
      ck('exactly one TARGET_LOST transition', t.lc.counts.byState.TARGET_LOST === 1 && t.lc.history.filter((h) => h.to === LS.TARGET_LOST).length === 1);
      ck('every signal counted', t.lc.lossSignals >= 51, t.lc.lossSignals); ck('no host capture caused by the repeated signals', since(env.log, 'capture', w.hwnd, tl) === 0, since(env.log, 'capture', w.hwnd, tl));
      s.rec.flush(); const ex = s.rec.export(); ck('diagnostics bounded (coalesced)', ex.events.filter((e) => e.stage === 'capture').length <= 4 && ex.events.filter((e) => e.stage === 'lifecycle' && e.kind === 'target-lost').length === 1, ex.events.length);
      ck('one cleanup only', env.log.filter((e) => e.cmd === 'unregister-target' && e.hwnd === LC.normHwnd(w.hwnd) && e.at >= ts).length === 1); ck('all refusals local', rs.every((r) => r.kind === 'lost' || /target lost/.test(r.reject || '')));
      return { checks, metrics: { lossSignals: t.lc.lossSignals, suppressed: ex.suppressedDuplicates } };
    } finally { await s.done(); }
  }],
  I: ['Identity mismatch / handle reuse: no inherited permission', async (env) => {
    const { checks, ck } = checker(), fx = env.fixture(1); if (SCOPE) SCOPE.onCleanup(() => fx.stop()); const [w] = await fx.ready(), rec = new XA.DiagnosticsRecorder({ max: 5000 }), sched = new SCH.InputScheduler({ maxQueue: 8, onCancel: () => env.session.request('cancel-all') });
    try {
      const r = await register(env, w), fake = { ...r.identity, processStart: String(r.identity.processStart) + '0', className: r.identity.className };   // as if the handle now belonged to another process instance
      const t = table(env, w, r, sched, rec, { identity: fake }); if (SCOPE) SCOPE.table(t); await t.capture.open(); await env.session.request('arm'); const t0 = mono(); const run = t.run(Infinity); if (SCOPE) SCOPE.run(run);
      await until(() => t.lc.terminal, 15000); ck('identity mismatch -> TARGET_LOST (identity-changed)', t.lc.terminal && t.lc.cause.kind === 'identity-changed', t.lc.state + ' / ' + (t.lc.cause && t.lc.cause.kind));
      ck('no input was sent', since(env.log, 'input', w.hwnd, t0) === 0); ck('message explains the mismatch', /no longer matches the registered simulator/.test(t.lc.message()[1]));
      await settleWithin(run, 5000);
      const bad = SC.authorizations({ environment: 'x', approvedBy: 'acceptance', exeFileName: 'EightMaxTestTable.exe', exeSha256: 'e'.repeat(64), hours: 1 }), rr = await env.session.request('register-target', { hwnd: w.hwnd, authorization: bad.simulator });
      ck('registration with a different program identity is rejected by the driver', rr.ok === false && rr.code === 'authorization-refused', rr.code);
      await env.session.request('arm'); const mc = await env.session.request('move-click', { hwnd: w.hwnd, to: { x: w.client.x + 5, y: w.client.y + 5 }, expectClient: w.client, motion: MOTION }); ck('input to an unregistered handle is refused by the driver', mc.ok === false && /target-not-registered|identity|window-gone/.test(mc.code || ''), mc.code);
      return { checks, metrics: { lost: t.lost } };
    } finally { await env.session.request('disarm'); await env.session.request('unregister-target', { hwnd: w.hwnd }); await fx.stop(); }
  }],
  K: ['Window resized while playing (geometry / display-scaling re-check)', async (env) => {
    const { checks, ck } = checker(), s = await setup(env, 1, { width: 960 }), [t] = s.tables;
    try {
      await until(() => t.m.confirmed >= 2, 60000); const scale0 = t.identity.dpiScale; await s.fx.move(1, 40, 40, 800); const c0 = t.m.confirmed;
      await until(() => t.m.confirmed >= c0 + 3, 90000); const o = (await s.fx.oracle())[0], g = grade(o);
      ck('play continues after the resize', t.m.confirmed >= c0 + 3, t.m.confirmed - c0); ck('no incorrect click after the resize (oracle)', g.incorrect === 0, g); ck('table not lost by a resize', !t.lc.terminal, t.lc.state);
      return { checks, metrics: { dpiScale: scale0, lastClient: t.lastFrame && t.lastFrame.client, refusals: t.m.rejected } };
    } finally { await s.done(); }
  }],
};

const RUN_T0 = mono();
// per-scenario time limit; --scenario-limit-ms exists to TEST that a genuine timeout is still reported as a failure (exit code 1)
const LIMIT = Number(arg('scenario-limit-ms', FAKE ? '120000' : '480000'));
async function main() {
  const env = FAKE ? await fakeEnv() : await windowsEnv(), out = { format: 'eightmax-m2-lifecycle-acceptance', version: 1, app: EM.VERSION, milestone: '0.36.2-milestone-2', environment: env.kind, at: new Date().toISOString(),
    machine: { platform: process.platform, release: os.release(), node: process.version, cpus: os.cpus().length, cpu: os.cpus()[0] && os.cpus()[0].model, ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1) }, host: env.facts, motion: { maxSpeed: SPEED }, scenarios: [] };
  try {
    for (const [id, [name, fn]] of Object.entries(SCENARIOS)) {
      if (ONLY.length && !ONLY.includes(id)) continue; const t0 = mono(); console.log('--- ' + id + ': ' + name);
      // 0.36.2 M3: the time limit is a cancellable timeout (cleared as soon as the scenario settles); on a timeout the scenario is aborted,
      // its tables / fixtures / processes are cleaned up and the scenario promise is awaited (bounded) before the next scenario starts.
      const scope = SCOPE = new Scope(id), work = Promise.resolve().then(() => fn(env)); let r, timedOut = false;
      try { r = await withTimeout(work, LIMIT, 'scenario ' + id + ' time limit'); }
      catch (e) { timedOut = e.code === 'ETIMEOUT'; r = { checks: [{ name: timedOut ? 'scenario finished within its time limit' : 'scenario ran to completion', pass: false, detail: e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e) }] }; }
      if (timedOut) scope.aborted = true;
      await scope.cleanup(timedOut ? 'scenario time limit' : 'scenario finished');
      if (timedOut) { const s2 = await settleWithin(work, 30000); r.checks.push({ name: 'timed-out scenario stopped after cleanup', pass: s2 === 'done', detail: s2 }); }
      SCOPE = null;
      env.hooks.onRequest = null; const status = r.checks.length && r.checks.every((c) => c.pass) ? 'pass' : 'fail';
      let diag = null; if (status === 'fail') { try { diag = 'diag-' + id + '.json'; fs.writeFileSync(path.join(WORK, diag), JSON.stringify(diagnosticsDump(scope), null, 1)); } catch (e) { diag = 'not written: ' + e.message; } }
      out.scenarios.push({ id, name, status, durationMs: Math.round(mono() - t0), timedOut, checks: r.checks, metrics: r.metrics || null, ...(diag ? { diagnostics: diag } : {}) });
      for (const c of r.checks) console.log('  [' + (c.pass ? 'PASS' : 'FAIL') + '] ' + c.name + (c.detail !== null && c.detail !== undefined ? ' — ' + (typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail)).slice(0, 160) : ''));
      console.log('  => ' + status.toUpperCase() + ' (' + Math.round((mono() - t0) / 1000) + ' s)');
    }
  } finally { await env.stop(); }
  // 0.36.2 M3: cleanup audit - child processes exited, no timer or socket of this run still alive (stdio pipes are expected)
  for (const c of CHILDREN) if (!c.done) await settleWithin(c.promise, 5000);
  // the handle of a child that has just exited is closed in a later phase of the event loop: sample again (bounded, 1 s) before
  // calling anything a leak (Windows CI run 45217637720 reported the desktop host's handle, sampled one loop turn after its exit)
  const ALLOWED = ['PipeWrap', 'TTYWrap', 'FSReqCallback', 'FileHandle', 'Immediate']; let counts = {}, unexpected = [];
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, i ? 50 : 0)); counts = {}; for (const k of (typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : [])) counts[k] = (counts[k] || 0) + 1;
    unexpected = Object.entries(counts).filter(([k]) => !ALLOWED.includes(k)).map(([k, v]) => k + ' x' + v); if (!unexpected.length) break;
  }
  out.cleanup = { childProcesses: CHILDREN.map((c) => ({ ...c.info })), allChildrenExited: CHILDREN.every((c) => c.done), activeResources: counts, unexpected, ok: CHILDREN.every((c) => c.done) && unexpected.length === 0 };
  const failed = out.scenarios.filter((s) => s.status !== 'pass');
  out.summary = { scenarios: out.scenarios.length, passed: out.scenarios.length - failed.length, failed: failed.length, checks: out.scenarios.reduce((a, s) => a + s.checks.length, 0), failedChecks: out.scenarios.reduce((a, s) => a + s.checks.filter((c) => !c.pass).length, 0), skipped: Object.keys(SCENARIOS).length - out.scenarios.length, cleanupOk: out.cleanup.ok };
  out.overall = failed.length === 0 && out.scenarios.length > 0 && out.cleanup.ok ? 'PASS' : 'FAIL';
  if (!out.cleanup.ok) console.log('  cleanup audit FAILED: ' + JSON.stringify({ unexpected, children: out.cleanup.childProcesses.filter((c) => !c.exited) }));
  out.durationMs = Math.round(mono() - RUN_T0); out.exitCode = out.overall === 'PASS' ? 0 : 1;
  fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log('Lifecycle acceptance (' + env.kind + '): ' + out.overall + ' - ' + out.summary.passed + '/' + out.summary.scenarios + ' scenarios -> ' + OUT);
  process.exitCode = out.overall === 'PASS' ? 0 : 1;
}
// 0.36.2 M3: importable (tools/gameplay-acceptance-0362m3.cjs reuses the environments, registration and scenario helpers)
module.exports = { windowsEnv, fakeEnv, register, table, setup, grade, checker, until, since, withTimeout, settleWithin, Scope, setScope: (sc) => { SCOPE = sc; }, currentScope: () => SCOPE, diagnosticsDump, WORK, CHILDREN, T, MOTION, FAKE, ROOT, SCENARIOS };
if (require.main === module) main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
