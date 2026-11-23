'use strict';
// 0.36.2 Milestone 3: the dashboard (START.html, Playwright/Chromium) against a FAKE desktop host serving frames of the bundled test table
// in a tournament whose next hand starts with two ELIMINATED players. Strict EightMax mode (practice not selected, no study loaded):
// the opening must be reconstructed (not refused), the table must stop with "Strategy unavailable" (never a scripted substitute, never
// input), and the table row must show the gameplay condition, the hand-tracking status and the tournament seating as separate lines.
const test = require('node:test'), assert = require('node:assert/strict'), path = require('path'), fs = require('fs');
let chromium = null; try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }
const ROOT = path.join(__dirname, '..'), FD = require('../src/fixture-dealer.js');
const skip = chromium && fs.existsSync(path.join(ROOT, 'START.html')) ? false : 'needs Playwright and START.html';
const TOKEN = 'c'.repeat(64), SHA = 'a'.repeat(64);

test('M3 dashboard: a hand that starts with eliminated players is tracked; strict mode pauses as "Strategy unavailable" with no input; gameplay / tracking / tournament lines shown', { skip, timeout: 180000 }, async () => {
  const html = fs.readFileSync(path.join(ROOT, 'START.html'), 'utf8'); let frame = null;
  // seats 2 and 6 are eliminated (the situation that stalled Milestone 2); the dealer's first hand starts with six players
  const d = new FD.TableDealer({ table: 1, stacks: [2390, 2140, 0, 2490, 2490, 8000, 0, 2490], send: (m) => { if (m.type === 'frame') frame = m; } }); d.onWindow({ type: 'ready', client: { x: 100, y: 80, w: 960, h: 600 } });
  const client = { x: 100, y: 80, w: 960, h: 600 };
  const W = { hwnd: '0x5E6F', pid: 91, processStart: '355', className: 'WindowsForms10.Window.8.app.0.EightMaxTestTable', title: 'EightMax Test Table 01', exe: 'C:\\EightMax\\desktop\\bin\\EightMaxTestTable.exe', client, dpiScale: 1, minimized: false };
  const world = { windows: [W], estop: null }, commands = [], frames = [];
  const browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } }); const errors = [];
  page.on('pageerror', (e) => errors.push(e.message)); page.on('dialog', (dlg) => dlg.accept());
  await page.route('http://127.0.0.1:48713/**', async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname;
    if (p === '/' || p === '/START.html') return route.fulfill({ status: 200, contentType: 'text/html', body: html });
    if (req.headers()['x-eightmax-session'] !== TOKEN) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"session"}' });
    const body = req.postData() ? JSON.parse(req.postData()) : null, j = (v) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });
    const win = (h) => world.windows.find((w) => w.hwnd.toLowerCase() === String(h || '').toLowerCase());
    if (p === '/api/input/settings') return j(body ? { ok: true } : { format: 'eightmax-input-settings', saved: false });
    if (p === '/api/input/status') return j({ format: 'eightmax-input-status', version: 1, running: true, driver: { driver: '0.36.2-dev', armed: commands.includes('arm'), estop: world.estop, capabilities: { hotkey: 'Ctrl+Alt+F12', hotkeyRegistered: true, dpiAwareness: 'per-monitor-v2', uiAutomation: true, rawInputOverride: true } }, events: [] });
    if (p === '/api/input/estop') { world.estop = 'dashboard'; return j({ ok: true }); }
    if (p === '/api/capture/open') return win(body.target.hwnd) ? j({ ok: true }) : j({ ok: false, code: 'target-lost', reason: 'The window no longer exists.' });
    if (p === '/api/capture/close') return j({ ok: true, closedSessions: 0 });
    if (p === '/api/capture/frame') { frames.push(body.target.hwnd); return win(body.target.hwnd) ? j({ ok: true, width: frame.w, height: frame.h, png: frame.png, bounds: { x: client.x, y: client.y, width: client.w, height: client.h }, dpiScale: 1, title: 'EightMax Test Table 01' + frame.title, frameId: frame.rev }) : j({ ok: false, code: 'target-lost', reason: 'The window no longer exists.' }); }
    if (p === '/api/simulator/decision') return j({ status: 'unavailable', reason: 'No compatible EightMax preflop study is loaded' });
    if (p === '/api/input/command') {
      commands.push(body.cmd); const w = win(body.hwnd);
      switch (body.cmd) {
        case 'status': return j({ ok: true, estop: world.estop, capabilities: { signedCurves: true, maxDeviationPx: true, singleClickGuardMaxMs: 540 } });
        case 'arm': return world.estop ? j({ ok: false, code: 'emergency-stop', error: 'Reset the emergency stop first.' }) : j({ ok: true });
        case 'disarm': return j({ ok: true });
        case 'list-windows': return j({ ok: true, windows: world.windows });
        case 'exe-identity': return w ? j({ ok: true, exeSha256: SHA, window: w }) : j({ ok: false, code: 'window-gone', error: 'That window no longer exists.' });
        case 'register-target': return w ? j({ ok: true, window: w, exeSha256: SHA }) : j({ ok: false, code: 'window-gone', error: 'That window no longer exists.' });
        case 'unregister-target': return j({ ok: true });
        case 'window-info': return w ? j({ ok: true, window: w }) : j({ ok: false, code: 'window-gone', error: 'That window no longer exists.' });
        case 'monitors': return j({ ok: true, monitors: [{ id: 0, name: 'FAKE', dpiScale: 1, primary: true, bounds: { x: 0, y: 0, w: 1920, h: 1080 } }] });
        default: return j({ ok: true, plannedMs: 10, actualMs: 11, steps: 2, clickedAt: body.to || { x: 0, y: 0 } });
      }
    }
    return j({ ok: false, error: 'unhandled ' + p });
  });
  try {
    await page.goto('http://127.0.0.1:48713/#desktop-token=' + TOKEN); await page.click('#simc-nav'); await page.waitForTimeout(600);
    await page.selectOption('#simc-window', W.hwnd);
    for (const id of ['#simc-own', '#simc-test', '#simc-nomoney']) await page.check(id);
    await page.click('#simc-register'); await page.waitForTimeout(400); assert.match(await page.textContent('#simc-status'), /Registered EightMax Test Table 01/);
    assert.equal(await page.isChecked('#simc-scripted'), false, 'strict EightMax mode: practice is not selected');
    await page.click('#simc-start'); await page.waitForTimeout(3500);
    const row = await page.textContent('#simc-tables');
    assert.ok(frames.length > 0, 'the table was captured');
    assert.match(row, /hand 1 · preflop · actor \d · pot 210 · 6 dealt in/, 'the opening with two eliminated seats was reconstructed: ' + row.slice(0, 600));
    assert.match(row, /Gameplay: Strategy unavailable — No compatible EightMax strategy decision is available; no scripted decision is substituted/);
    assert.match(row, /Hand tracking: (tracking|verifying fresh readings) · last valid hand 1 · recovered 0 time\(s\)/);
    assert.match(row, /Tournament: 6 player\(s\) remain · eliminated: seat 2, seat 6/);
    for (const c of ['move-click', 'click', 'enter-text', 'type']) assert.ok(!commands.includes(c), 'no input in strict mode without a study (' + c + ')');
    // the exported diagnostics carry the gameplay condition, the tracking status and the seating (additive fields)
    const dl = page.waitForEvent('download'); await page.click('#simc-export-report'); const file = await dl, doc = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
    const tb = doc.tables[0]; assert.equal(tb.tournamentRules, 'strict'); assert.equal(tb.gameplay.code, 'strategy-unavailable'); assert.equal(tb.gameplay.tracking.lastValidHand, 1);
    assert.deepEqual(tb.gameplay.tournament.eliminated.map((x) => x.seat), [2, 6]); assert.ok(doc.diagnostics.events.some((e) => e.stage === 'gameplay' && e.kind === 'condition' && e.to === 'strategy-unavailable'));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); d.dispose(); }
});
