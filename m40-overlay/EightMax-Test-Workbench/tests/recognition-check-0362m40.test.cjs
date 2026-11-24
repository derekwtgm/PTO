'use strict';
// 0.36.2 Milestone 4.0: COORDINATE SPACES (src/coordinate-spaces.js) and VERIFY TABLE RECOGNITION (src/recognition-check.js,
// SimulatorControls.verifyRecognition) on real frames of the bundled test table, rendered by the controlled renderer at the window sizes
// of 800 / 960 / 1024 / 1280 / 1440 / 1920 px tables at 100-200 % display scaling. The safety-critical failures (scaled capture,
// unknown scale, a control that does not fit, an unknown layout, a too-small window, the wrong table) are refused; a frame that is
// merely unreadable is reported, never guessed, and does not block input (the automation refuses such frames by itself).
const test = require('node:test'), assert = require('node:assert/strict');
const CS = require('../src/coordinate-spaces.js'), RC = require('../src/recognition-check.js'), SC = require('../src/simulator-controls.js');
const SP = require('../src/simulator-profiles.js'), FD = require('../src/fixture-dealer.js'), IC = require('../src/image-codec.js');

const SHA = 'a'.repeat(64), PROFILE = SP.fixtureProfile({ exeSha256: SHA });
/** A dealer whose window has the given client size; its first frame is rendered (and the strip drawn) by the bundled renderer. */
function tableFrame(w, h, o = {}) {
  const d = new FD.TableDealer({ table: o.table || 1, stacks: o.stacks || [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000], send: () => {} });
  d.onWindow({ type: 'ready', client: { x: 0, y: 0, w, h } }); const image = d.frame(); d.onWindow({ type: 'closed' }); return image;
}
const frameOf = (image, client, dpiScale, more = {}) => ({ image, bounds: { x: client.x, y: client.y, width: client.w, height: client.h }, dpiScale, frameId: 7, method: 'print-window', ...more });
const readerFor = (w) => SC.tableReader(1, 8, w);

test('coordinate spaces: physical <-> logical per monitor (also left of the primary), client, normalised, capture', () => {
  for (const scale of [1, 1.25, 1.5, 1.75, 2]) {
    const mon = { bounds: { x: -3840, y: 0, w: 3840, h: 2160 }, scale }, p = { x: -3840 + 1000, y: 500 };
    const l = CS.physicalToLogical(p, mon); assert.equal(l.ok, true); assert.ok(Math.abs(l.x - (-3840 + 1000 / scale)) < 1e-9 && Math.abs(l.y - 500 / scale) < 1e-9, 'logical is relative to the monitor origin at ' + scale);
    const back = CS.logicalToPhysical(l, mon); assert.deepEqual([back.x, back.y], [p.x, p.y], 'round trip at ' + scale);
  }
  assert.equal(CS.physicalToLogical({ x: 1, y: 1 }, { bounds: { x: 0, y: 0, w: 10, h: 10 } }).ok, false, 'an unknown scale is refused, never assumed');
  const client = { x: 100, y: 50, w: 1000, h: 625 };
  assert.deepEqual(CS.physicalToClient({ x: 600, y: 300 }, client), { x: 500, y: 250 }); assert.deepEqual(CS.clientToPhysical({ x: 500, y: 250 }, client), { x: 600, y: 300 });
  assert.deepEqual(CS.clientToNormalized({ x: 500, y: 250 }, client), { x: 0.5, y: 0.4 }); assert.deepEqual(CS.normalizedToClient({ x: 0.5, y: 0.4 }, client), { x: 500, y: 250 });
  assert.deepEqual(CS.normalizedToPhysical({ x: 0.5, y: 0.4 }, client).physical, { x: 600, y: 300 });
  const exact = CS.captureScale({ width: 1000, height: 625 }, client); assert.equal(exact.exact, true); assert.equal(exact.sx, 1);
  const scaled = CS.captureScale({ width: 800, height: 500 }, client); assert.equal(scaled.exact, false); assert.equal(scaled.sx, 0.8); assert.equal(scaled.uniform, true);
  const c = CS.captureToClient({ x: 400, y: 250 }, { width: 800, height: 500 }, client); assert.deepEqual([c.x, c.y, c.exact], [500, 312.5, false], 'a scaled capture is converted only with exact:false');
  assert.equal(CS.nearestStandardScale(1.24), 1.25); assert.equal(CS.nearestStandardScale(1.0), 1);
});

test('coordinate spaces: checkGeometry refuses a scaled capture and an unknown scale; a custom scale and a window across monitors are notes', () => {
  const client = { x: 0, y: 0, w: 1000, h: 625 };
  assert.equal(CS.checkGeometry({ client, image: { width: 1000, height: 625 }, dpiScale: 1.25 }).ok, true);
  const g = CS.checkGeometry({ client, image: { width: 1000, height: 625 }, dpiScale: 1.25 }); assert.deepEqual(g.logicalSize, { w: 800, h: 500 }); assert.equal(g.scalePercent, 125);
  const s = CS.checkGeometry({ client, image: { width: 800, height: 500 }, dpiScale: 1.25 }); assert.equal(s.ok, false); assert.match(s.critical[0], /scaled capture/);
  const u = CS.checkGeometry({ client, image: { width: 1000, height: 625 } }); assert.equal(u.ok, false); assert.match(u.critical[0], /display scale of the window is unknown/);
  const k = CS.checkGeometry({ client, image: { width: 1000, height: 625 }, dpiScale: 1.33 }); assert.equal(k.ok, true); assert.match(k.notes[0], /custom display scaling 133 %/);
  const m = CS.checkGeometry({ client: { x: 1800, y: 0, w: 1000, h: 625 }, image: { width: 1000, height: 625 }, dpiScale: 1, monitor: { bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scale: 1 } }); assert.equal(m.ok, true); assert.match(m.notes[0], /not entirely on one monitor/);
  assert.equal(CS.checkGeometry({ image: { width: 10, height: 10 }, dpiScale: 1 }).ok, false, 'no client rectangle');
});

test('Verify Table Recognition: PASS at every standard table size and display scale (client area in physical pixels)', () => {
  const cases = []; for (const logical of [800, 960, 1024, 1280, 1440, 1920]) for (const scale of [1, 1.25, 1.5, 1.75, 2]) { const w = Math.round(logical * scale); if (w <= 3840) cases.push({ logical, scale, w, h: Math.round(w / 1.6) }); }
  const seen = new Set();
  for (const c of cases) {
    if (seen.has(c.w)) continue; seen.add(c.w);   // the same physical size at two scales renders the same image; the scale is checked below
    const image = tableFrame(c.w, c.h), client = { x: 40, y: 30, w: c.w, h: c.h };
    const rep = RC.verify({ frame: frameOf(image, client, c.scale), reader: readerFor(c.w), profile: PROFILE, table: 1, hwnd: '0x1', title: 'EightMax Test Table 01' });
    assert.equal(rep.verdict, 'pass', c.logical + ' px at ' + c.scale + ': ' + JSON.stringify([rep.critical, rep.recognition.unreadable]));
    assert.equal(rep.inputAllowed, true); assert.equal(rep.window.scalePercent, Math.round(c.scale * 100)); assert.deepEqual(rep.window.logicalSize, { w: +(c.w / c.scale).toFixed(1), h: +(c.h / c.scale).toFixed(1) });
    assert.equal(rep.calibration.status, 'ok'); for (const k of ['fold', 'check', 'call', 'raise']) { const x = rep.calibration.controls[k]; assert.ok(x.ok && x.rect.x >= client.x && x.rect.x + x.rect.w <= client.x + client.w && x.point.y > client.y, k + ' inside the client area at ' + c.w); }
    assert.equal(rep.strip.ok, true); assert.equal(rep.strip.table, 1); assert.equal(rep.recognition.recognised.status, 'playing'); assert.ok(rep.recognition.recognised.heroCards && rep.recognition.recognised.heroCards.length === 2, 'hero cards read');
    assert.ok(rep.recognition.confidence.overall >= 0.9, 'confidence ' + rep.recognition.confidence.overall + ' at ' + c.w); assert.ok(rep.positions && rep.positions.hero.length === 2 && rep.positions.board.length === 5);
    assert.ok(rep.recognition.reads.length > 20, 'every field read is listed with its confidence'); assert.match(RC.summary(rep), /^PASS - /);
  }
  assert.ok(seen.size >= 20, 'distinct physical sizes checked: ' + seen.size);
});

test('Verify Table Recognition: a scaled (DPI-virtualised) capture, an unknown scale and another capture method are safety-critical', () => {
  const big = { x: 0, y: 0, w: 1200, h: 750 }, small = tableFrame(960, 600);
  const s = RC.verify({ frame: frameOf(small, big, 1.25), reader: readerFor(1200), profile: PROFILE, table: 1 });
  assert.equal(s.verdict, 'fail'); assert.equal(s.inputAllowed, false); assert.ok(s.critical.some((x) => /scaled capture/.test(x)), s.critical.join('; ')); assert.match(RC.summary(s), /^FAILED - automated input refused/);
  const img = tableFrame(1200, 750), client = { x: 0, y: 0, w: 1200, h: 750 };
  const u = RC.verify({ frame: frameOf(img, client, undefined), reader: readerFor(1200), profile: PROFILE, table: 1 }); assert.equal(u.verdict, 'fail'); assert.ok(u.critical.some((x) => /display scale of the window is unknown/.test(x)));
  const w = RC.verify({ frame: frameOf(img, client, 1.25, { method: 'windows-graphics-capture' }), reader: readerFor(1200), profile: PROFILE, table: 1 }); assert.equal(w.verdict, 'fail'); assert.ok(w.critical.some((x) => /whole window, not the client area/.test(x)));
});

test('Verify Table Recognition: a control that does not fit, an unknown layout, a too-small window and the wrong table are safety-critical', () => {
  const img = tableFrame(960, 600), client = { x: 0, y: 0, w: 960, h: 600 };
  const tiny = JSON.parse(JSON.stringify(PROFILE)); tiny.layout.controls.call = { x: 0.84, y: 0.93, w: 0.004, h: 0.004 };
  const t = RC.verify({ frame: frameOf(img, client, 1), reader: readerFor(960), profile: tiny, table: 1 }); assert.equal(t.verdict, 'fail'); assert.equal(t.calibration.status, 'failed'); assert.ok(t.critical.some((x) => /calibration: call: .*too small/.test(x)), t.critical.join('; '));
  const none = JSON.parse(JSON.stringify(PROFILE)); delete none.layout.controls.raise; const n = RC.verify({ frame: frameOf(img, client, 1), reader: readerFor(960), profile: none, table: 1 }); assert.ok(n.critical.includes('calibration: raise not calibrated'));
  const square = tableFrame(960, 960), sq = RC.verify({ frame: frameOf(square, { x: 0, y: 0, w: 960, h: 960 }, 1), reader: readerFor(960), profile: PROFILE, table: 1 });
  assert.equal(sq.verdict, 'fail'); assert.ok(sq.critical.some((x) => /recognition: unrecognized-layout/.test(x) || /status strip/.test(x)), sq.critical.join('; '));
  const low = tableFrame(640, 400), lo = RC.verify({ frame: frameOf(low, { x: 0, y: 0, w: 640, h: 400 }, 1), reader: readerFor(640), profile: PROFILE, table: 1 });
  assert.equal(lo.verdict, 'fail'); assert.ok(lo.critical.some((x) => /resolution-too-low/.test(x) || /too small/.test(x)), lo.critical.join('; '));
  const other = RC.verify({ frame: frameOf(img, client, 1), reader: readerFor(960), profile: PROFILE, table: 2 }); assert.equal(other.verdict, 'fail'); assert.ok(other.critical.some((x) => /shows table 1, registered as table 2/.test(x)));
});

test('Verify Table Recognition: a frame with an unreadable value is reported (never guessed) and does not block input', () => {
  const img = tableFrame(960, 600), client = { x: 0, y: 0, w: 960, h: 600 }, L = readerFor(960).profiles.select(img, 8).profile;
  // scribble over the hero's first card (a card in motion, a partly drawn frame): the value cannot be read in THIS frame
  const b = L.hero[0], x0 = Math.floor(b.x * 960), y0 = Math.floor(b.y * 600), x1 = Math.ceil((b.x + b.w) * 960), y1 = Math.ceil((b.y + b.h) * 600);
  const data = new Uint8ClampedArray(img.data); let seed = 7; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { seed = (seed * 1103515245 + 12345) >>> 0; const k = (y * 960 + x) * 4, v = seed & 255; data[k] = v; data[k + 1] = 255 - v; data[k + 2] = (v * 7) & 255; }
  const rep = RC.verify({ frame: frameOf({ width: 960, height: 600, data }, client, 1), reader: readerFor(960), profile: PROFILE, table: 1 });
  assert.equal(rep.verdict, 'pass-frame-unreadable', JSON.stringify(rep.critical)); assert.equal(rep.inputAllowed, true, 'the calibration fits: input is allowed (the automation refuses this frame by itself)');
  assert.ok(rep.recognition.unreadable.some((x) => /hero cards unreadable/.test(x)), rep.recognition.unreadable.join('; ')); assert.equal(rep.recognition.recognised, null, 'nothing is reported as recognised from a refused frame');
  assert.ok(rep.recognition.reads.some((r) => r.field === 'hero' && r.accepted === false), 'the unreadable field is listed'); assert.match(RC.summary(rep), /^PASS \(calibration\).*check again during a hand/);
});

test('SimulatorControls.verifyRecognition: one capture through the host API, read with the table reader; a capture refusal fails the check', async () => {
  const img = tableFrame(1000, 625), png = Buffer.from(IC.encodePng(img)).toString('base64'), calls = [];
  const api = { request: async (p, body) => { calls.push(p); if (p === '/api/capture/open') return { ok: true }; if (p === '/api/capture/frame') return { ok: true, method: 'print-window', width: 1000, height: 625, png, bounds: { x: 10, y: 20, width: 1000, height: 625 }, dpiScale: 1.25, title: 'EightMax Test Table 01 · hand 1', frameId: 3 }; return { ok: false }; } };
  const rep = await SC.verifyRecognition({ api, window: { hwnd: '0x1', pid: 9, title: 'EightMax Test Table 01' }, profile: PROFILE, table: 1 });
  assert.equal(rep.verdict, 'pass', JSON.stringify(rep.critical)); assert.deepEqual(calls, ['/api/capture/open', '/api/capture/frame'], 'one capture, no input command');
  assert.equal(rep.window.scalePercent, 125); assert.deepEqual(rep.window.logicalSize, { w: 800, h: 500 }); assert.equal(rep.capture.method, 'print-window'); assert.ok(rep.recognition.templates.includes(1000), 'exact-width templates for 1000 px');
  const gone = { request: async (p) => (p === '/api/capture/open' ? { ok: true } : { ok: false, code: 'target-lost', reason: 'The window no longer exists.' }) };
  const g = await SC.verifyRecognition({ api: gone, window: { hwnd: '0x1' }, profile: PROFILE, table: 1 }); assert.equal(g.verdict, 'fail'); assert.match(g.critical[0], /capture: target-lost/);
});

test('automated play refuses a print-window frame whose image is not the client area at physical size (no stretching)', async () => {
  const img = tableFrame(960, 600), png = Buffer.from(IC.encodePng(img)).toString('base64');
  const api = { request: async (p) => (p === '/api/capture/frame' ? { ok: true, method: 'print-window', width: 960, height: 600, png, bounds: { x: 0, y: 0, width: 1200, height: 750 }, dpiScale: 1.25, title: 'EightMax Test Table 01', frameId: 1 } : { ok: true }) };
  const auth = SC.authorizations({ environment: 'unit', approvedBy: 'unit test', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA }), SCH = require('../src/input-scheduler.js');
  const t = new SC.SimulatorTable({ id: 1, window: { hwnd: '0x1', pid: 9, title: 'EightMax Test Table 01', client: { x: 0, y: 0, w: 1200, h: 750 } }, profile: PROFILE, api, session: { request: async () => ({ ok: true }) }, scheduler: new SCH.InputScheduler(), qaAuthorization: auth.qa, allowScripted: true });
  try { const r = await t.look(); assert.equal(r.code, 'scaled-capture', JSON.stringify(r)); assert.match(r.reject, /captured image is 960x600 but the client area is 1200x750/); assert.equal(t.state, null, 'no state from that frame'); }
  finally { t.dispose && t.dispose(); }
});
