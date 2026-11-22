'use strict';
// 0.35.0: the screen -> recognition -> state -> decision -> scheduler -> input -> confirmation loop (src/simulator-controls.js)
// against an IN-PROCESS fake desktop host: capture returns the fixture dealer's real rendered frames, input commands are mapped
// onto the dealer's controls. This tests the controller's logic (gating, confirmation, pausing, cursor ownership, deadlines),
// not Windows input - that is tools/input-acceptance-035.cjs and tools/simulator-benchmark-035.cjs on Windows.
const test = require('node:test'), assert = require('node:assert/strict');
const SC = require('../src/simulator-controls.js'), SP = require('../src/simulator-profiles.js'), SCH = require('../src/input-scheduler.js'), FD = require('../src/fixture-dealer.js'), XA = require('../src/execution-adapters.js'), G = require('../src/input-geometry.js');
const TOKEN = 'a'.repeat(64), sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeHost(n, o = {}) {
  const tables = new Map(), stats = { inputConcurrent: 0, maxConcurrent: 0, clicks: 0, typed: 0, violations: [] };
  for (let i = 1; i <= n; i++) {
    const client = { x: 30 + i * 40, y: 20 + i * 30, w: 960, h: 600 }, t = { client, frame: null, field: '', hwnd: '0x' + (0x1000 * i).toString(16).toUpperCase() };
    t.dealer = new FD.TableDealer({ table: i, seed: (o.seed || 100) + i, handGapMs: 50, turnDelayMs: o.turnDelayMs || 0, send: (m) => { if (m.type === 'frame') t.frame = m; } });
    t.dealer.onWindow({ type: 'ready', client, hwnd: t.hwnd }); tables.set(t.hwnd, t);
  }
  const reply = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
  async function fetch(url, init) {
    const path = url.replace('http://127.0.0.1:48713', ''), body = init.body ? JSON.parse(init.body) : {};
    if (init.headers['X-EightMax-Session'] !== TOKEN) return { ok: false, status: 403, text: async () => '{"error":"session"}' };
    if (path === '/api/capture/open') return reply({ ok: true });
    if (path === '/api/capture/close') return reply({ ok: true });
    if (path === '/api/capture/frame') { const t = tables.get(body.target.hwnd); await sleep(2); const f = t.frame; return reply({ ok: true, width: f.w, height: f.h, png: f.png, bounds: { x: t.client.x, y: t.client.y, width: t.client.w, height: t.client.h }, title: 'EightMax Test Table ' + String(t.dealer.id).padStart(2, '0') + f.title, frameId: f.rev }); }
    if (path !== '/api/input/command') return reply({ ok: false, error: 'unknown' });
    const t = tables.get(body.hwnd);
    switch (body.cmd) {
      case 'arm': case 'disarm': case 'cancel-all': case 'status': return reply({ ok: true, stats: {} });
      case 'window-info': if (o.onWindowInfo) o.onWindowInfo(t); return reply({ ok: true, window: { hwnd: t.hwnd, client: t.client, minimized: false } });
      case 'move-click': case 'enter-text': {
        if (body.expectClient && !(body.expectClient.x === t.client.x && body.expectClient.w === t.client.w && body.expectClient.y === t.client.y)) return reply({ ok: false, code: 'layout-changed', error: 'moved' });
        stats.inputConcurrent++; stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.inputConcurrent); await sleep(15); stats.inputConcurrent--;
        if (!G.validClient(t.client)) return reply({ ok: false, code: 'outside-window' });
        const nx = (body.to.x - t.client.x) / t.client.w, ny = (body.to.y - t.client.y) / t.client.h, hit = Object.entries({ ...FD.CONTROLS, wager: FD.WAGER_FIELD }).find(([, b]) => nx >= b.x && ny >= b.y && nx < b.x + b.w && ny < b.y + b.h);
        if (body.cmd === 'enter-text') { if (!hit || hit[0] !== 'wager') stats.violations.push('typed outside the wager field'); t.field = body.text; stats.typed++; return reply({ ok: true, verified: true, read: body.text, plannedMs: 5, actualMs: 6 }); }
        stats.clicks++; if (!hit) { stats.violations.push('click outside every control'); return reply({ ok: true, plannedMs: 5, actualMs: 6, clickedAt: body.to }); }
        if (!o.ignoreClicks) { let control = hit[0]; if (o.wrongControl && control === 'call') control = 'fold'; t.dealer.onWindow({ type: 'action', control, wager: t.field, rev: t.dealer.rev }); }
        return reply({ ok: true, plannedMs: 5, actualMs: 6, steps: 1, clickedAt: body.to });
      }
    }
    return reply({ ok: false, code: 'unknown-command', error: body.cmd });
  }
  return { tables, stats, fetch };
}
function build(host, o = {}) {
  const api = new SC.HostApi({ token: TOKEN, fetch: host.fetch }), session = SC.hostSession(api), sched = new SCH.InputScheduler({ maxQueue: 8 });
  const auth = SC.authorizations({ environment: 'fake-host-test', approvedBy: 'unit test', exeFileName: 'EightMaxTestTable.exe', exeSha256: 'c'.repeat(64) }), profile = SP.fixtureProfile({ exeSha256: 'c'.repeat(64) });
  const rec = new XA.DiagnosticsRecorder({ max: 5000 });
  const tables = [...host.tables.values()].map((t) => new SC.SimulatorTable({ id: t.dealer.id, window: { hwnd: t.hwnd, pid: 1, title: 'EightMax Test Table ' + String(t.dealer.id).padStart(2, '0'), client: t.client }, profile, api, session, scheduler: sched, qaAuthorization: auth.qa, recorder: rec, allowScripted: true, seed: 3, timing: { postClickSettleMs: 0 }, options: { decisionWindowMs: o.window || 10000, pollMs: 5, idlePollMs: 5, postActionTimeoutMs: o.ackMs || 800, ...(o.options || {}) } }));
  return { api, session, sched, tables, rec };
}
async function runUntil(tables, pred, ms) { const end = performance.now() + ms; await Promise.all(tables.map(async (t) => { while (!t.stopped && performance.now() < end && !pred(t)) { const r = await t.step(); if (r.kind === 'paused') break; if (r.kind !== 'acted') await sleep(5); } })); }


module.exports={fakeHost,build,runUntil};
