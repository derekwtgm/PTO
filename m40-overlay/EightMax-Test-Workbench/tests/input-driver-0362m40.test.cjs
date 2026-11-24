'use strict';
// 0.36.2 Milestone 4.0: the REAL input driver code (desktop/input/*.cs) on the in-memory virtual desktop - the new, explicitly requested
// behaviours and the unchanged defaults:
//   * clickGuard "process": the double-click spacing applies between clicks into the SAME target process only; the default (no field) and
//     "global" keep the Milestone 3.2 spacing between ANY two clicks;
//   * drain: after the release the driver confirms that the target window's GUI thread processed its messages (drained:true); a drain that
//     is not confirmed (drained:false) makes the next click into ANY process keep the global spacing;
//   * phases: a click reply carries ordered phase times;
//   * window-info / cursor / monitors are answered immediately, also while another operation moves the cursor (queued:true = old behaviour).
// Logic evidence on the virtual desktop (Mono on Linux, the same executable's virtual backend on Windows); real windows are tested by the
// Windows acceptance.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('path'), os = require('os'), fs = require('fs');
const U = require('./input-util-035.cjs'), D = require('../src/windows-input-driver.js');
let cmd; try { cmd = U.driverCommand(); } catch (e) { cmd = null; }
const skip = cmd ? false : 'needs desktop/bin/EightMaxInput.exe (Windows) or Mono mcs+mono (Linux)';

async function open(o = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-vd40-')), file = path.join(dir, 'desk.json'), desk = U.virtualDesktop(file, o);
  if (Object.keys(extra).length) fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra }));
  const t = D.spawnTransport({ exe: cmd.exe, args: [...cmd.pre, '--backend', 'virtual', '--virtual-desktop', file] }), s = new D.DriverSession(t, { timeoutMs: 20000 });
  await s.hello(); await s.call('arm');
  for (const w of desk.windows) await s.call('register-target', { hwnd: hex(w), authorization: U.authorization({ executable: { fileName: 'EightMaxTestTable.exe', sha256: U.virtualSha(w.pid) } }) });
  return { s, t, desk, close: () => s.close() };
}
const hex = (w) => '0x' + w.hwnd.toString(16).toUpperCase();
const at = (w, name) => { const c = w.controls.find((k) => k.text === name); return { x: c.box.x + (c.box.w >> 1), y: c.box.y + (c.box.h >> 1), region: c.box }; };
const FAST = { maxSpeed: 20000, maxAccel: 400000, minDurationMs: 0, intervalMs: 4 };
const click = (x, w, name, more = {}) => { const p = at(w, name); return x.s.call('move-click', { hwnd: hex(w), to: { x: p.x, y: p.y }, region: p.region, expectClient: w.client, motion: FAST, preClickMs: 0, holdMs: 10, ...more }); };

test('M4.0 driver: capabilities name the per-process guard, the input drain, phase timings and the inline queries', { skip }, async () => {
  const x = await open(); try {
    const c = x.s.capabilities; assert.deepEqual(c.clickGuardScopes, ['global', 'process']); assert.equal(c.inputDrain, true); assert.equal(c.phaseTimings, true);
    assert.deepEqual(c.inlineQueries, ['window-info', 'cursor', 'monitors']); assert.deepEqual(c.raiseWaitModes, ['fixed-30', 'poll']); assert.equal(c.pressGuard, true); assert.equal(c.captureBarrier, true); assert.equal(c.build, '0.36.2-m40'); assert.equal(c.singleClickGuardMaxMs, 540, 'the double-click guard still uses the system double-click time + 40 ms');
  } finally { await x.close(); }
});

test('M4.0 driver: clickGuard "process" spaces clicks into the same process only; default and "global" space any two clicks (Milestone 3.2)', { skip }, async () => {
  const x = await open({ tables: 2, dx: 1000, dy: 0, clientW: 800 }); try {
    const [w1, w2] = x.desk.windows;
    // Milestone 3.2 default: no clickGuard field -> global spacing between two different processes
    const a = await click(x, w1, 'fold'), b = await click(x, w2, 'fold');
    assert.equal(a.guardScope, 'global'); assert.equal(b.guardScope, 'global'); assert.ok(b.doubleClickGuardMs > 0, 'the default keeps the global spacing (another process, < 540 ms later)');
    await new Promise((r) => setTimeout(r, 600));
    // per process: a click into ANOTHER process right after a click does not wait ...
    const c1 = await click(x, w1, 'check', { clickGuard: 'process' }), c2 = await click(x, w2, 'check', { clickGuard: 'process' });
    assert.equal(c2.guardScope, 'process'); assert.equal(c2.doubleClickGuardMs, undefined, 'no wait between two different processes');
    // ... but a second click into the SAME process within the double-click time still waits. Measured back to back (one round trip
    // apart): Windows CI run 45395967209 showed that a click into another process in between can itself take longer than the 540 ms
    // window on a loaded 2-core runner, and the driver then rightly does not wait. The reply says how long ago the last click in scope
    // was (guardSinceMs) and the limit (guardLimitMs): the wait must be exactly the remainder, whatever the machine's speed.
    const consistent = (r, what) => { assert.equal(r.guardLimitMs, 540, what + ': limit = double-click time + 40 ms'); assert.ok(r.guardSinceMs >= 0, what + ': time since the last click in scope reported');
      if (r.guardSinceMs < r.guardLimitMs) assert.ok(r.doubleClickGuardMs > 0 && r.doubleClickGuardMs <= r.guardLimitMs - r.guardSinceMs + 1, what + ' waits the remainder: ' + JSON.stringify([r.guardSinceMs, r.doubleClickGuardMs]));
      else assert.equal(r.doubleClickGuardMs, undefined, what + ': the last click was long enough ago'); return r.guardSinceMs < r.guardLimitMs; };
    const c3 = await click(x, w1, 'call', { clickGuard: 'process' }), c4 = await click(x, w1, 'raise', { clickGuard: 'process' });
    assert.equal(c4.guardScope, 'process'); const waited = consistent(c4, 'the same process, back to back');
    if (!waited) console.log('# note: this machine took ' + c4.guardSinceMs + ' ms for one click round trip; the wait itself was not exercised');
    consistent(c3, 'the same process after a click into another one');
    // "global" requested explicitly behaves like the default
    const g = await click(x, w2, 'call', { clickGuard: 'global' }); assert.equal(g.guardScope, 'global'); consistent(g, 'global, back to back');
    const ev = (await x.s.call('virtual-events')).events.filter((e) => e.startsWith('click ')); assert.equal(ev.length, 7, 'every requested click happened exactly once: ' + ev.join(', '));
    void c1;
  } finally { await x.close(); }
});

test('M4.0 driver: drain confirms the target processed the click; phases are ordered; an unconfirmed drain keeps the global spacing for the next click', { skip }, async () => {
  const x = await open({ tables: 2, dx: 1000, dy: 0, clientW: 800 }); try {
    const [w1] = x.desk.windows; const r = await click(x, w1, 'fold', { drain: true, clickGuard: 'process' });
    assert.equal(r.drained, true); assert.ok(r.drainMs >= 0 && r.drainMs < 250, 'drain ms ' + r.drainMs);
    const p = r.phases; assert.ok(p, 'phases reported');
    for (const k of ['checkMs', 'moveStartMs', 'moveEndMs', 'clickStartMs', 'preClickEndMs', 'pressMs', 'clickDoneMs', 'totalMs', 'queueMs', 'guardMs', 'focusMs', 'drainMs']) assert.equal(typeof p[k], 'number', k);
    const order = ['checkMs', 'moveStartMs', 'moveEndMs', 'clickStartMs', 'preClickEndMs', 'pressMs', 'clickDoneMs', 'totalMs']; for (let i = 1; i < order.length; i++) assert.ok(p[order[i]] >= p[order[i - 1]], order[i] + ' after ' + order[i - 1] + ': ' + JSON.stringify(p));
    const plain = await click(x, w1, 'check'); assert.equal(plain.drained, undefined, 'no drain unless asked (Milestone 3.2 reply)');
  } finally { await x.close(); }
  // a slow target window: the drain waits for it
  const y = await open({ tables: 1 }, { drainDelayMs: 120 }); try { const r = await click(y, y.desk.windows[0], 'fold', { drain: true }); assert.equal(r.drained, true); assert.ok(r.drainMs >= 110, 'waited for the slow window: ' + r.drainMs); } finally { await y.close(); }
  // an unresponsive target window: drained:false, and the next click into ANOTHER process waits the full global spacing
  const z = await open({ tables: 2, dx: 1000, dy: 0, clientW: 800 }, { drainFails: true }); try {
    const [w1, w2] = z.desk.windows; const r1 = await click(z, w1, 'fold', { drain: true, clickGuard: 'process' }); assert.equal(r1.drained, false);
    const r2 = await click(z, w2, 'fold', { drain: true, clickGuard: 'process' }); assert.ok(r2.doubleClickGuardMs > 0, 'an unconfirmed click keeps the global spacing for the next click');
    const ev = (await z.s.call('status')); void ev;
  } finally { await z.close(); }
});

test('M4.0 driver: window-info is answered while another operation moves the cursor; queued:true waits behind it (Milestone 3.2)', { skip }, async () => {
  const x = await open({ tables: 2, dx: 1000, dy: 0, clientW: 800 }); try {
    const [w1, w2] = x.desk.windows, p = at(w1, 'raise'), slow = { maxSpeed: 20000, maxAccel: 400000, minDurationMs: 1500, intervalMs: 16 };   // a movement that takes 1.5 s
    const t0 = Date.now(); const move = x.s.request('move', { hwnd: hex(w1), to: { x: p.x, y: p.y }, region: p.region, expectClient: w1.client, motion: slow }).then((r) => ({ r, at: Date.now() - t0 }));
    await new Promise((r) => setTimeout(r, 150));
    const q0 = Date.now(), info = await x.s.call('window-info', { hwnd: hex(w2) }), infoMs = Date.now() - q0;
    const queued = x.s.request('window-info', { hwnd: hex(w2), queued: true }).then((r) => ({ r, at: Date.now() - t0 }));
    const [m, qd] = await Promise.all([move, queued]);
    assert.equal(info.inline, true); assert.ok(infoMs < 400, 'inline answer while the cursor moves: ' + infoMs + ' ms'); assert.equal(m.r.ok, true, JSON.stringify(m.r).slice(0, 200));
    assert.ok(m.at >= 1400, 'the movement took its planned time: ' + m.at); assert.ok(qd.at >= m.at - 5, 'queued:true still waits behind the movement'); assert.equal(qd.r.inline, undefined);
  } finally { await x.close(); }
});

test('M4.0 driver: raiseWait "poll" raises a covered target window and clicks as soon as it is on top (the default keeps the fixed 30 ms wait)', { skip }, async () => {
  const x = await open({ tables: 2, dx: 30, dy: 20, clientW: 800 }); try {   // overlapping windows: table 2 (registered last) covers table 1
    const [w1, w2] = x.desk.windows;
    const polled = await click(x, w1, 'fold', { focusPolicy: 'bring-to-front', raiseWait: 'poll', clickGuard: 'process' });
    assert.ok(polled.phases.focusMs >= 4 && polled.phases.focusMs < 30, 'raised and on top after the polled wait: ' + polled.phases.focusMs + ' ms');
    const fixed = await click(x, w2, 'fold', { focusPolicy: 'bring-to-front', clickGuard: 'process' });
    assert.ok(fixed.phases.focusMs >= 29, 'the default waits the fixed 30 ms: ' + fixed.phases.focusMs);
    const ev = (await x.s.call('virtual-events')).events.filter((e) => e.startsWith('click ')); assert.deepEqual(ev, ['click fold', 'click fold'], 'each click landed on the raised window');
  } finally { await x.close(); }
});

test('M4.0 driver: pressGuard - a target window that closes at the instant of the press: the press reaches the window beneath, is released OFF its control (no click there) and is reported press-misdirected; the Milestone 3.2 sequence clicks the other table', { skip }, async () => {
  // two tables exactly on top of each other: table 1's Call button is at the same screen point as table 2's (Windows CI run 45401450070:
  // a window closed by the test 12 ms before the click meant for it, and the press reached the table beneath)
  const run = async (guard) => {
    const x = await open({ tables: 2, dx: 0, dy: 0, clientW: 800 }, { closeOnPress: 0x10000 }); try {
      const [w1] = x.desk.windows; let reply = null, err = null;
      try { reply = await click(x, w1, 'call', guard ? { pressGuard: true } : {}); } catch (e) { err = e; }
      const ev = (await x.s.call('virtual-events')).events.filter((e) => /^(closed|press|click|released-off|down|up) /.test(e));
      return { reply, err, ev, stats: (await x.s.call('status')).stats };
    } finally { await x.close(); }
  };
  const g = await run(true);
  assert.ok(g.err, 'the guarded click is refused'); assert.equal(g.err.code, 'press-misdirected', String(g.err && g.err.message));
  assert.match(g.err.message, /no click was completed there; the action is not repeated/);
  assert.ok(g.ev.includes('closed 65536'), 'table 1 closed at the press: ' + g.ev.join(', '));
  assert.ok(g.ev.some((e) => e === 'press call ' + (0x20000 + 3)), 'the press reached table 2\'s Call button: ' + g.ev.join(', '));
  assert.ok(g.ev.includes('released-off call'), 'released off that control'); assert.ok(!g.ev.some((e) => e.startsWith('click ')), 'NO click anywhere: ' + g.ev.join(', '));
  assert.equal(g.stats.misdirectedPresses, 1);
  const m = await run(false);
  assert.equal(m.err, null, 'the Milestone 3.2 sequence does not notice'); assert.ok(m.reply && m.reply.ok, 'it reports the click as done');
  assert.ok(m.ev.includes('click call'), 'and table 2\'s Call button WAS clicked (the cross-table click the guard prevents): ' + m.ev.join(', '));
});

test('M4.0 driver: pressGuard on an ordinary click changes nothing but the reply (press seen, target under the cursor)', { skip }, async () => {
  const x = await open({ tables: 2, dx: 1000, dy: 0, clientW: 800 }); try {
    const [w1] = x.desk.windows, r = await click(x, w1, 'fold', { pressGuard: true });
    assert.equal(r.ok, true); assert.equal(r.press.seen, true); assert.equal(r.press.root, hex(w1)); assert.equal(r.press.misdirected, undefined);
    assert.ok(r.phases.pressCheckMs >= 0 && r.phases.pressCheckMs < 30, 'press check ' + r.phases.pressCheckMs + ' ms');
    const ev = (await x.s.call('virtual-events')).events.filter((e) => e.startsWith('click ')); assert.deepEqual(ev, ['click fold']);
  } finally { await x.close(); }
});

test('M4.0 driver: capture barrier - the reply waits until the clicked control released the mouse capture (its thread processed the release; a busy table), bounded at 600 ms', { skip }, async () => {
  for (const [lag, expectReleased] of [[0, true], [200, true], [900, false]]) {
    const x = await open({ tables: 1, clientW: 800 }, lag ? { releaseLagMs: lag } : {}); try {
      const [w1] = x.desk.windows, r = await click(x, w1, 'fold', { drain: true, pressGuard: true, clickGuard: 'process' });
      assert.equal(r.ok, true); assert.equal(r.press.capturedByControl, true, 'the control captured the mouse when it processed the press (lag ' + lag + ')');
      assert.equal(r.captureBarrier, true); assert.equal(r.captureReleased, expectReleased, 'lag ' + lag + ': ' + JSON.stringify([r.captureReleaseMs, r.drained]));
      if (lag === 0) assert.ok(r.captureReleaseMs === undefined || r.captureReleaseMs < 40, 'a responsive table: no wait (' + r.captureReleaseMs + ' ms)');
      if (lag === 200) assert.ok(r.captureReleaseMs >= 150 && r.captureReleaseMs < 600, 'waited for the busy table: ' + r.captureReleaseMs + ' ms');
      if (lag === 900) { assert.ok(r.captureReleaseMs >= 590, 'bounded at 600 ms: ' + r.captureReleaseMs); assert.equal(r.drained, false, 'not drained: the next click keeps the global spacing'); }
      else assert.equal(r.drained, true);
      const ev = (await x.s.call('virtual-events')).events.filter((e) => e.startsWith('click ')); assert.deepEqual(ev, ['click fold'], 'exactly one click, never repeated');
    } finally { await x.close(); }
  }
  // the Milestone 3.2 sequence (no drain field) is unchanged: no barrier, no extra reply fields
  const y = await open({ tables: 1, clientW: 800 }); try { const r = await click(y, y.desk.windows[0], 'check'); assert.equal(r.captureBarrier, undefined); assert.equal(r.press, undefined); } finally { await y.close(); }
});
