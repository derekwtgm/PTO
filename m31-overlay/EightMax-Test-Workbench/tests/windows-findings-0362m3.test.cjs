'use strict';
// 0.36.2 Milestone 3: defects found by the first real-Windows run of the Milestone 3 tests (GitHub Actions run 45203097931) and fixed here.
// Each test reproduces the failure deterministically on any platform (the Windows-only parts are checked statically).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const root = path.join(__dirname, '..'), read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const SIM = require('../src/sim-display.js'), OCR = require('../src/vision-ocr.js'), HS = require('../src/hand-state.js'), IC = require('../src/image-codec.js');
const FD = require('../src/fixture-dealer.js'), EM = require('../src/engine.js'), L = require('../src/strategy-library.js');
const WIDTHS = [800, 960, 1280, 1440, 1920];
let kit = null; const reader = () => { if (!kit) kit = SIM.calibrate(WIDTHS, SIM.layoutFor(8, true)); return new OCR.ImageObserver({ table: 1, profiles: kit.profiles, cards: kit.cards, glyphs: kit.glyphs, seats: 8 }); };

test('every card reads reliably in EVERY board and hero slot at every calibrated width (templates were taken from the first board slot only)', () => {
  const obs = reader(), L2 = SIM.layoutFor(8, true), slots = [...L2.board.map((b, i) => ['board ' + i, b]), ...L2.hero.map((b, i) => ['hero ' + i, b])];
  let worst = { score: 1 }, n = 0;
  for (const w of WIDTHS) for (const [name, box] of slots) for (let c = 0; c < 52; c++) {
    const m = SIM.makeImage(w, 0, 1); m.card(box, c); const r = obs._readCard(m.finish(), box, 2); n++;
    assert.ok(r.accepted && r.label === HS.cardToString(c), w + ' px ' + name + ' ' + HS.cardToString(c) + ' read as ' + r.label);
    if (r.score < worst.score) worst = { score: r.score, margin: r.margin, at: w + ' px ' + name + ' ' + HS.cardToString(c) };
  }
  // Milestone 2: 800 px, turn slot, 5h / 6c / 8s / Td scored 0.883-0.892, under the 0.9 reading threshold
  assert.equal(n, WIDTHS.length * 7 * 52); assert.ok(worst.score >= 0.95, JSON.stringify(worst));
});

test('the Windows CI frame that stopped scenario J (seed 1001, 800 px, turn 5h) reads with full confidence', () => {
  const frames = [], d = new FD.TableDealer({ table: 1, seed: 1001, stacks: Array(8).fill(100000), blinds: { sb: 50, bb: 100, ante: 10 }, handGapMs: 1200, send: (m) => { if (m.type === 'frame') frames.push(m); } });
  try {
    d.onWindow({ type: 'ready', client: { x: 16, y: 39, w: 800, h: 500 }, hwnd: '0x1' });
    // the 17 actions the Workbench made on the Windows runner (oracle-table-01.jsonl of run 45203097931), the last one the fold before the turn
    for (const [control, wager] of [['fold'], ['fold'], ['call'], ['call'], ['fold'], ['call'], ['raise', '350'], ['raise', '750'], ['call'], ['call'], ['fold'], ['fold'], ['raise', '1375'], ['raise', '3450'], ['raise', '7250'], ['call'], ['fold']]) {
      const before = d.counts.accepted; d.onWindow({ type: 'action', control, wager: wager || '', rev: d.rev }); assert.equal(d.counts.accepted, before + 1, control + ' ' + (wager || '') + ' accepted');
    }
    assert.equal(d.t.street, 'turn'); assert.equal(HS.cardToString(d.t.board[3]), '5h');
    const f = frames[frames.length - 1], img = IC.decodePng(Buffer.from(f.png, 'base64')), STRIP = require('../src/status-strip.js'), st = STRIP.read(img);
    const r = reader().observe(img, { heroSeat: st.viewSeat });
    assert.ok(r.ok, JSON.stringify(r.reasons)); assert.ok(r.observation.confidence.overall >= 0.9, 'overall confidence ' + r.observation.confidence.overall + ' (Milestone 2: 0.890, refused)');
  } finally { d.dispose(); }
});

test('unreadable (low-confidence) frames are refused but never turn the hand untracked; the hand continues once the screen reads again', () => {
  const t = new EM.Table(1, 21, 8, { persistentStacks: true }); t.startHand();
  const e = new HS.HandStateEngine(1, { track: true, expectedLayout: 'eightmax-8max-v2', maxContradictionFrames: 5 }); let seq = 1;
  // the screen as the Workbench reads it (same construction as tests/tournament-0362m3.test.cjs)
  const screen = () => { const snap = t.snapshot(), hero = t.actor >= 0 ? t.actor : 0, l = t.status === 'playing' ? t.legal() : null;
    const ob = { format: 'eightmax-observation', version: 1, table: t.id, seq: seq++, source: 'image', capturedAt: 0, layout: { id: 'eightmax-8max-v2', seats: 8 }, hand: t.hand, status: t.status === 'complete' ? 'complete' : 'playing', street: t.street,
      board: snap.board.slice(), button: t.dealer, actor: t.status === 'playing' ? t.actor : -1, pot: snap.pot, confidence: { overall: 1, fields: { board: 1, pot: 1, stacks: 1, button: 1, actor: 1, street: 1, hand: 1, bets: 1, controls: 1 } },
      seats: snap.players.map((p, i) => ({ seat: i, stack: p.stack, bet: p.bet, folded: p.folded, cards: i === hero && p.cards.length === 2 ? p.cards.slice() : null })), heroSeat: hero };
    if (l) { ob.controls = { fold: l.toCall > 0, check: l.canCheck, call: l.toCall > 0, raise: l.canRaise }; if (l.toCall > 0) ob.callAmount = l.callAmount; if (l.canRaise) ob.minRaiseTo = Math.min(l.minRaiseTo, l.maxRaiseTo); }
    return ob; };
  assert.ok(e.ingest(screen()).accepted);
  t.execute(t.request(t.legal().toCall > 0 ? 'call' : 'check', 0, 0), 0);
  for (let i = 0; i < 30; i++) { const o = screen(); o.confidence = { ...o.confidence, overall: 0.89, fields: { ...o.confidence.fields, board: 0.89 } }; const r = e.ingest(o); assert.equal(r.accepted, false); assert.equal(r.issues[0].code, 'low-confidence'); }
  const st = e.trackingStatus(); assert.notEqual(st.status, 'untracked-hand', 'Milestone 3 before the fix: persistent-contradiction after 25 unreadable frames'); assert.equal(st.untrackedHands, 0);
  const ok = e.ingest(screen()); assert.ok(ok.accepted, JSON.stringify(ok.issues)); assert.equal(ok.state.hand, 1); assert.equal(ok.state.actions.length >= 1, true);
  assert.deepEqual([...HS.UNREADABLE_CODES].sort(), ['ambiguous-seats', 'bad-sequence', 'invalid-card', 'low-confidence', 'malformed', 'missing-confidence', 'missing-field', 'unrecognized-layout']);
});

test('the test table shows every hand from a seat dealt in to it (a hand nobody acts in kept an eliminated seat\'s view: no hole cards, unreadable)', () => {
  // the previous hand was shown from seat 2, eliminated in it; the next hand needs no decision (both players left are all-in from the
  // ante and blinds, the board is run out at once). Milestone 3 before the fix: still shown from seat 2, which holds no cards, so no
  // frame of that hand - the last of the tournament - could be read (Linux self-check with the Windows run's hands, 800 px).
  const frames = [], d = new FD.TableDealer({ table: 1, seed: 9, stacks: [0, 0, 0, 0, 30, 0, 0, 30], handGapMs: 0, send: (m) => { if (m.type === 'frame') frames.push(m); } });
  try {
    d.view = 2; d.onWindow({ type: 'ready', client: { x: 0, y: 0, w: 800, h: 500 }, hwnd: '0x1' });
    assert.equal(d.t.hand, 1); assert.equal(d.t.status, 'complete', 'run out without a decision'); assert.ok(frames.length > 0);
    const img = IC.decodePng(Buffer.from(frames[frames.length - 1].png, 'base64')), st = require('../src/status-strip.js').read(img);
    assert.equal(d.t.players[st.viewSeat].cards.length, 2, 'shown from seat ' + st.viewSeat + ' holding ' + d.t.players[st.viewSeat].cards.length + ' cards');
    const r = reader().observe(img, { heroSeat: st.viewSeat }); assert.ok(r.ok, JSON.stringify(r.reasons));
  } finally { d.dispose(); }
});

test('Windows strategy-library lock: EPERM / EACCES / EBUSY from a lock file being deleted mean "busy", retried within the time limit', () => {
  assert.equal(L.lockBusy({ code: 'EEXIST' }, 'linux'), true); assert.equal(L.lockBusy({ code: 'EPERM' }, 'linux'), false, 'on Linux EPERM is a real error');
  for (const c of ['EPERM', 'EACCES', 'EBUSY', 'EEXIST']) assert.equal(L.lockBusy({ code: c }, 'win32'), true, c); assert.equal(L.lockBusy({ code: 'ENOENT' }, 'win32'), false);
  const desc = Object.getOwnPropertyDescriptor(process, 'platform'), realOpen = fs.openSync, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-m3-lock-')); let fails = 0;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    fs.openSync = function (p, flags, ...rest) { if (String(p).endsWith('write.lock') && flags === 'wx' && fails < 3) { fails++; const e = new Error("EPERM: operation not permitted, open '" + p + "'"); e.code = 'EPERM'; throw e; } return realOpen.call(fs, p, flags, ...rest); };
    const lib = L.StrategyLibrary.open(dir, { create: true }); assert.ok(lib); assert.equal(fails, 3, 'three transient EPERM failures were retried (the Windows CI failure: thrown at once)');
    assert.ok(fs.existsSync(path.join(dir, 'LIBRARY.json'))); assert.ok(!fs.existsSync(path.join(dir, 'write.lock')), 'lock released');
  } finally { fs.openSync = realOpen; Object.defineProperty(process, 'platform', desc); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('input driver: after an operation of its own that stopped part-way, the next operation is not reported as a manual override (static)', () => {
  const d = read('desktop/input/Driver.cs');
  assert.match(d, /int cmdX = int\.MinValue, cmdY = int\.MinValue;/);
  assert.match(d, /os\.MoveAbsolute\(nx, ny\); cmdX = nx; cmdY = ny;/, 'every movement step records the commanded point');
  assert.match(d, /os\.SetCursor\(tx, ty\); cmdX = tx; cmdY = ty;/, 'the final correction too');
  assert.match(d, /void ResyncAfterOwnAbort\(\) \{ if \(cmdX == int\.MinValue\) return; int x, y; os\.GetCursor\(out x, out y\); if \(Math\.Abs\(x - cmdX\) <= 2 && Math\.Abs\(y - cmdY\) <= 2\) \{ lastX = x; lastY = y; \} \}/, 'only when the cursor is still at the driver\'s own point');
  assert.match(d, /catch \(DriverError e\) \{[^\n]*if \(InputOp\(o\.Cmd\) && e\.Code != "manual-override" && e\.Code != "emergency-stop"\) ResyncAfterOwnAbort\(\); Fail\(o\.Id/, 'never after a manual override or an emergency stop');
});

test('Windows runner and fixtures: check names become safe file names; a window gone before the fixture stops cannot crash it (static)', () => {
  // 0.36.2 Milestone 3.1: windows/Test-Milestone3-0362.ps1 forwards to windows/Test-Milestone31.ps1. The same safe-name rule is kept
  // (M31-Lib.ps1); start cases use fixed, safe folder names (01-prebuilt ...) and fixed file names inside them; the start-up script gets
  // a bounded time limit (120 s, compile cases 300 s, with progress output) instead of Milestone 3's silent 900 s per case.
  const lib = read('windows/M31-Lib.ps1'), hs = read('windows/M31-HostStart.ps1'), ps = read('windows/Test-Milestone31.ps1');
  assert.match(lib, /function Get-M31SafeName\(\[string\]\$Name\) \{ return \(\$Name -replace '\[\^A-Za-z0-9 \._\(\)-\]', '-'\) \}/);
  assert.match(hs, /\$caseDir = Join-Path \$WorkDir \(\('\{0:00\}' -f \$n\) \+ '-' \+ \$case\.id\)/);
  for (const id of ['prebuilt', 'fallback-fresh', 'cache-reuse', 'invalid-exe', 'invalid-manifest', 'old-key', 'build-only']) assert.match(hs, new RegExp("id = '" + id + "'"), id + ' is a safe folder name');
  assert.match(hs, /ready = \(Join-Path \$CaseDir 'session\.json'\); status = \(Join-Path \$CaseDir 'start-status\.json'\)/);
  assert.match(ps, /-LaunchTimeoutSec \(Get-M31Limit \$HostLaunchTimeoutSec 120\) -CompileTimeoutSec \(Get-M31Limit \$HostCompileTimeoutSec 300\)/);
  assert.match(read('tools/test-table-035.cjs'), /child\.stdin\.on\('error', \(\) => \{ \/\* window gone \*\/ \}\);/);
  for (const f of ['tools/gameplay-acceptance-0362m3.cjs', 'tools/lifecycle-acceptance-0362m2.cjs']) assert.match(read(f), /for \(let i = 0; i < 20; i\+\+\) \{\n    await new Promise\(\(r\) => setTimeout\(r, i \? 50 : 0\)\);/, f + ': the cleanup audit re-samples before calling a closing handle a leak');
  assert.match(ps, /Add-M31Check 'runner cleanup' 'lifecycle-acceptance: process cleanup \(children exited, no live timers\)'/, 'the lifecycle tool\'s own cleanup verdict is a check of the Windows runner');
});
