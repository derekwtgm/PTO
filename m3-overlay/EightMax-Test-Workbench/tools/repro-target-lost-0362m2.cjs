#!/usr/bin/env node
'use strict';
// 0.36.2 Milestone 2 Phase 1/2 reproduction with REALISTIC driver behaviour: after the window closes, the host's capture answers target-lost
// (CaptureService.CheckWindow: IsWindow false) AND the input driver's window-info answers window-gone (Driver.Identity),
// exactly as on Windows. Runs SimulatorTable.run(Infinity) with stopOnPause:false, idlePollMs:120 as the dashboard does.
//   node tools/repro-target-lost-0362m2.cjs <workbench-root> <observeMs> <closeAfterMs|before>
const path = require('path'), root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const F = require(path.join(root, 'tests/simulator-host-fixture.cjs'));
const W = Number(process.argv[3] || 10000), when = process.argv[4] || 'before';
const host = F.fakeHost(1); const hwnd = [...host.tables.keys()][0];
let closed = false; const after = { capture: 0, probes: 0, inputOps: 0, otherDriver: 0, captureClose: 0 };
const INPUT = new Set(['focus', 'move', 'move-click', 'click', 'double-click', 'mouse-down', 'mouse-up', 'key', 'type', 'clear-field', 'enter-text']);
const inner = host.fetch, j = (v) => ({ ok: true, status: 200, text: async () => JSON.stringify(v) });
host.fetch = async (url, init) => {
  const p = url.replace('http://127.0.0.1:48713', ''), body = init.body ? JSON.parse(init.body) : {};
  if (closed) {
    if (p === '/api/capture/frame') { after.capture++; return j({ ok: false, code: 'target-lost', reason: 'The window no longer exists.', minimized: false }); }
    if (p === '/api/capture/close') { after.captureClose++; return j({ ok: true, closedSessions: 0 }); }
    if (p === '/api/input/command' && body.hwnd === hwnd) {
      if (body.cmd === 'window-info' || body.cmd === 'exe-identity') { after.probes++; return j({ ok: false, code: 'window-gone', error: 'That window no longer exists.' }); }
      if (INPUT.has(body.cmd)) { after.inputOps++; return j({ ok: false, code: 'window-gone', error: 'The simulator window was closed.' }); }
      after.otherDriver++;
    }
  }
  return inner(url, init);
};
const b = F.build(host, { options: { stopOnPause: false, idlePollMs: 120 } }); const [t] = b.tables;
(async () => {
  if (when === 'before') closed = true;
  const run = t.run(Infinity); let finished = false; run.then(() => { finished = true; });
  if (when !== 'before') { await new Promise((r) => setTimeout(r, Number(when))); closed = true; }
  const confirmedBeforeClose = t.m.confirmed; await new Promise((r) => setTimeout(r, W));
  const ex = b.rec.export(), cap = ex.events.filter((e) => e.stage === 'capture');
  const out = { format: 'eightmax-m2-target-lost-repro', version: 1, closed: when === 'before' ? 'before automation started' : 'after ' + when + ' ms of play', observeMs: W,
    confirmedBeforeClose, afterClose: after, captureRequestsPerMinute: Math.round(after.capture / (W / 60000)),
    loopFinished: finished, lifecycle: t.lc ? t.lc.state : '(no lifecycle in this version)', lostReason: t.lost ? t.lost.reason : null,
    cancellation: t.cancellation || null, report: { frames: t.m.frames, rejectedFrames: t.m.rejectedFrames, attempted: t.m.attempted, confirmed: t.m.confirmed, uncertain: t.m.uncertain || 0 },
    diagnostics: { storedCaptureEvents: cap.length, totalCaptureRecords: ex.counts.capture || 0, suppressedDuplicates: ex.suppressedDuplicates === undefined ? '(no coalescing in this version)' : ex.suppressedDuplicates, failureTotals: ex.failureTotals || null } };
  console.log(JSON.stringify(out, null, 2)); t.stop(); { let tm; await Promise.race([run, new Promise((r) => { tm = setTimeout(r, 3000); })]); clearTimeout(tm); }
  if (t.dispose) t.dispose(); for (const x of host.tables.values()) if (x.dealer) { if (x.dealer.dispose) x.dealer.dispose(); else { clearTimeout(x.dealer.timer); clearTimeout(x.dealer.holdTimer); } }
  process.exitCode = 0;   // 0.36.2 M3: no forced exit - the process ends when nothing is left running
})();
