#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 4.0: MOUSE MOTION VALIDATION at 400, 800, 1200, 2000 and 2800 px/s (Windows, real cursor).
 *
 *   node tools/motion-validation-040.cjs [--speeds 400,800,1200,2000,2800] [--moves 10] [--clicks 6] [--width 960] [--out FILE]
 *
 * For every speed, with the real input driver (desktop/bin/EightMaxInput.exe, SendInput) and one bundled test table:
 *   MOVES   between points across the table, each recorded by the driver's INDEPENDENT 1 ms cursor sampler (not the commanded steps):
 *           continuity (no jump larger than speed x update interval), end exactly on the target, planned vs actual time, peak speed and
 *           acceleration against the profile (with the quantisation allowance of input-motion.js), no button down while moving.
 *   CLICKS  on the control the table currently enables (Fold / Check / Call), through the same move-click the automation uses with the
 *           Milestone 4.0 pipeline fields (per-process guard, drain, press guard): the TABLE's own record says where each press landed,
 *           whether exactly one press arrived, and whether the table applied exactly one action.
 * The acceleration limit scales with the speed as in the presets (Conservative 800 / 6 000, Normal 1 200 / 9 000, Fast 2 000 / 15 000 px/s^2;
 * 400 -> 3 000, 2 800 -> 21 000). No other timing is changed. Mouse input only inside the test table; do not touch the mouse.
 */
const path = require('path'), fs = require('fs'), cp = require('child_process'), crypto = require('crypto'), os = require('os');
const ROOT = path.join(__dirname, '..');
const D = require(path.join(ROOT, 'src', 'windows-input-driver.js')), G = require(path.join(ROOT, 'src', 'input-geometry.js')), M = require(path.join(ROOT, 'src', 'input-motion.js')), FD = require(path.join(ROOT, 'src', 'fixture-dealer.js'));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const OUT = arg('out', path.join(ROOT, 'reports', 'motion-validation-040.json')), ORACLE = arg('oracle-dir', path.join(os.tmpdir(), 'em-motion-' + Date.now()));
const SPEEDS = arg('speeds', '400,800,1200,2000,2800').split(',').map(Number).filter((x) => x >= 400 && x <= 2800), MOVES = Number(arg('moves', '10')), CLICKS = Number(arg('clicks', '6')), WIDTH = Number(arg('width', '960'));
const ACCEL = { 400: 3000, 800: 6000, 1200: 9000, 2000: 15000, 2800: 21000 };
const BIN = path.join(ROOT, 'desktop', 'bin'), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const inside = (p, r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const stat = (xs) => { const v = xs.filter(Number.isFinite).sort((a, b) => a - b); if (!v.length) return null; const q = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)]; return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +v[v.length - 1].toFixed(2) }; };
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

class Fixture {
  constructor(o) {
    this.child = cp.spawn(process.execPath, [path.join(ROOT, 'tools', 'test-table-035.cjs'), '--tables', '1', '--width', String(o.width), '--layout', 'grid', '--oracle-dir', o.oracleDir, '--hand-gap', '900', '--stack-chips', '100000', '--keep-alive', '--exe', path.join(BIN, 'EightMaxTestTable.exe')], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.waiters = []; this.msgs = []; this.seq = 0; this.oracleDir = o.oracleDir;
    this.child.stdout.setEncoding('utf8'); this.child.stdout.on('data', (d) => { this.buf += d; let k; while ((k = this.buf.indexOf('\n')) >= 0) { const l = this.buf.slice(0, k); this.buf = this.buf.slice(k + 1); try { const m = JSON.parse(l); const w = this.waiters.find((x) => x.f(m)); if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.timer); w.r(m); } else this.msgs.push(m); } catch (e) { /* not JSON */ } } });
  }
  wait(f, ms = 30000) { const hit = this.msgs.find(f); if (hit) { this.msgs.splice(this.msgs.indexOf(hit), 1); return Promise.resolve(hit); } return new Promise((r, j) => { const w = { f, r }; w.timer = setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); j(new Error('fixture timeout')); }, ms); this.waiters.push(w); }); }
  async cmd(c) { const id = ++this.seq; this.child.stdin.write(JSON.stringify({ id, ...c }) + '\n'); return this.wait((m) => m.id === id); }
  async summary() { return (await this.cmd({ cmd: 'summary' })).tables; }
  oracle(table) { const f = path.join(this.oracleDir, 'oracle-table-' + String(table).padStart(2, '0') + '.jsonl'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; }
  async stop() { try { this.child.stdin.write(JSON.stringify({ cmd: 'stop' }) + '\n'); this.child.stdin.end(); } catch (e) { /* gone */ } await new Promise((r) => { const t = setTimeout(() => { try { this.child.kill(); } catch (e) { /* gone */ } r(); }, 8000); this.child.once('exit', () => { clearTimeout(t); r(); }); }); }
}

async function main() {
  const t0 = Date.now(), out = { format: 'eightmax-motion-validation', version: 1, milestone: '0.36.2-milestone-4.0', at: new Date().toISOString(), tool: 'tools/motion-validation-040.cjs', platform: process.platform, release: os.release(), cpus: os.cpus().length, cpu: os.cpus()[0] && os.cpus()[0].model, speeds: [] };
  if (process.platform !== 'win32') { out.error = 'motion validation needs a Windows desktop (the real cursor)'; return finish(out, 1); }
  const tr = D.spawnTransport({ exe: path.join(BIN, 'EightMaxInput.exe') }), s = new D.DriverSession(tr, { timeoutMs: 30000 });
  const caps = await s.hello(); out.driver = { version: s.version, build: caps.build, dpiAwareness: caps.dpiAwareness, pressGuard: !!caps.pressGuard, inputDrain: !!caps.inputDrain };
  const mon = await s.call('monitors'); out.monitors = mon.monitors;
  const fx = new Fixture({ width: WIDTH, oracleDir: ORACLE }); let ok = true;
  try {
    const ready = await fx.wait((m) => m.type === 'ready'), T = ready.tables[0]; out.table = { client: T.client, dpi: T.dpi };
    await s.call('arm'); await s.call('register-target', { hwnd: T.hwnd, authorization: { format: 'eightmax-simulator-authorization', version: 1, operatorOwnsSimulator: true, testEnvironmentOnly: true, noRealMoney: true, expiresAtUnixMs: Date.now() + 3600e3, executable: { fileName: 'EightMaxTestTable.exe', sha256: sha256File(path.join(BIN, 'EightMaxTestTable.exe')) } }, label: 'motion validation' });
    await s.call('focus', { hwnd: T.hwnd }); await sleep(300);
    const info = async () => (await s.call('window-info', { hwnd: T.hwnd })).window;
    for (const speed of SPEEDS) {
      const profile = M.profile({ maxSpeed: speed, maxAccel: ACCEL[speed] || Math.round(speed * 7.5), arc: 0, maxDeviationPx: 240 }), r0 = rng(speed), w = await info(), c = w.client;
      const rec = { speed, maxAccel: profile.maxAccel, move800Ms: Math.round(M.durationMs(800, profile)), moves: [], clicks: [] };
      // ---- moves: random points inside the client area (away from the edges), sampled independently ----
      for (let i = 0; i < MOVES; i++) {
        const to = { x: Math.round(c.x + 40 + r0() * (c.w - 80)), y: Math.round(c.y + 40 + r0() * (c.h - 120)) };
        await s.call('monitor-start', { intervalMs: 1 }); const r = await s.call('move', { hwnd: T.hwnd, to, expectClient: c, motion: profile }, 20000); await sleep(25); const mr = await s.call('monitor-stop');
        const an = M.analyse(M.fromMonitor(mr.samples), { profile, target: to, expectNoButton: true, dedupe: true, checkLimits: true });
        rec.moves.push({ distance: r.distance, plannedMs: r.plannedMs, actualMs: r.actualMs, ok: an.ok, problems: an.problems.slice(0, 3), targetError: an.targetError, peakSpeed: an.peakSpeed, peakAccel: an.peakAccel, maxStepPx: an.maxStepPx, stepLimitPx: an.stepLimitPx, intervalMedianMs: an.intervalMs && an.intervalMs.median, samples: an.samples });
      }
      // ---- clicks: the control the table enables now, through the Milestone 4.0 move-click; the table records every press ----
      for (let i = 0; i < CLICKS; i++) {
        const sum = (await fx.summary())[0], st = sum && sum.state; if (!st || st.status !== 'playing' || st.actor < 0) { await sleep(1000); continue; }
        // the control the table enables now (from the dealer's own state): Check when nothing is to call, otherwise Call or Fold
        const toCall = Math.max(0, (st.currentBet || 0) - ((st.bets || [])[st.actor] || 0)), choice = toCall === 0 ? 'check' : (i % 2 ? 'fold' : 'call');
        const before = fx.oracle(T.table).length, cw = await info(), t = G.regionToScreen(FD.CONTROLS[choice], cw.client); if (!t.ok) continue;
        const r = await s.request('move-click', { hwnd: T.hwnd, to: t.point, region: t.rect, expectClient: cw.client, motion: profile, clickGuard: 'process', drain: true, pressGuard: true, phases: true, raiseWait: 'poll' }, 20000);
        await sleep(700); const ev = fx.oracle(T.table).slice(before), downs = ev.filter((e) => e.kind === 'mouse-down'), acts = ev.filter((e) => e.kind === 'action');
        const local = downs.length ? { x: cw.client.x + downs[0].x, y: cw.client.y + downs[0].y } : null;
        rec.clicks.push({ control: choice, driverOk: r.ok === true, code: r.ok ? null : r.code, presses: downs.length, pressOn: downs.length ? downs[0].control : null, pressEnabled: downs.length ? downs[0].enabled !== false : null, insideRegion: local ? inside(local, t.rect) : null, actions: acts.length, applied: acts.length ? acts[0].result : null, drained: r.drained === undefined ? null : r.drained, actualMs: r.actualMs, plannedMs: r.plannedMs });
        await sleep(300);
      }
      const mv = rec.moves, ck = rec.clicks;
      rec.summary = { moves: mv.length, movesOk: mv.filter((m) => m.ok).length, targetErrorMaxPx: Math.max(0, ...mv.map((m) => m.targetError || 0)), plannedMs: stat(mv.map((m) => m.plannedMs)), actualMs: stat(mv.map((m) => m.actualMs)),
        timingRatio: stat(mv.map((m) => (m.plannedMs > 0 ? m.actualMs / m.plannedMs : NaN))), peakSpeedObserved: stat(mv.map((m) => m.peakSpeed)), maxStepPx: Math.max(0, ...mv.map((m) => m.maxStepPx || 0)),
        clicks: ck.length, clicksOnTarget: ck.filter((x) => x.presses === 1 && x.pressOn === x.control && x.insideRegion).length, clicksWithExtraPress: ck.filter((x) => x.presses > 1).length, pressesOutsideRegion: ck.filter((x) => x.insideRegion === false).length,
        disabledControlPresses: ck.filter((x) => x.pressEnabled === false).length, actionsApplied: ck.filter((x) => x.actions === 1 && x.applied === 'accepted').length, driverRefusals: ck.filter((x) => !x.driverOk).length };
      rec.ok = rec.summary.movesOk === rec.summary.moves && rec.summary.clicksWithExtraPress === 0 && rec.summary.pressesOutsideRegion === 0 && rec.summary.clicksOnTarget === ck.filter((x) => x.presses > 0).length;
      if (!rec.ok) ok = false; out.speeds.push(rec);
      console.log(speed + ' px/s: moves ' + rec.summary.movesOk + '/' + rec.summary.moves + ' ok (max end error ' + rec.summary.targetErrorMaxPx + ' px, actual/planned ' + (rec.summary.timingRatio && rec.summary.timingRatio.mean) + '), clicks on target ' + rec.summary.clicksOnTarget + '/' + rec.summary.clicks + ', actions applied ' + rec.summary.actionsApplied);
    }
    await s.call('disarm');
  } finally { await fx.stop(); await s.close(); }
  out.durationMs = Date.now() - t0; return finish(out, ok ? 0 : 1);
}
function finish(out, code) { out.ok = code === 0; fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(out, null, 1)); console.log('motion validation: ' + (out.ok ? 'PASS' : 'FAIL') + ' -> ' + OUT); process.exitCode = code; }
if (require.main === module) main().catch((e) => { console.error(e.stack); finish({ format: 'eightmax-motion-validation', version: 1, error: e.stack }, 1); });
