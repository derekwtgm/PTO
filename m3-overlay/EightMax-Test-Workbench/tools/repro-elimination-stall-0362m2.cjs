#!/usr/bin/env node
'use strict';
/* 0.36.2 Milestone 2: reproduction of a PRE-EXISTING hand-tracker limitation found by the Milestone 2 stress tests (not caused by M2).
 *   node tools/repro-elimination-stall-0362m2.cjs [workbench-root] [--out FILE]
 * The bundled simulator (fixture dealer, tournament stacks since 0.36.1) shows eliminated (zero-stack) players as folded from the first
 * frame of the next hand. HandStateEngine._track treats any folded seat in a hand's first frame as a missed hand start
 * ("missed-hand-start", then "untracked-hand" for the whole hand), and the controlled table waits for the hero forever, so automation
 * stops acting - safely (no input), but it stalls. Runs one table with 2500-chip stacks until it stalls or 30 s pass. */
const path = require('path'), fs = require('fs');
const ROOT = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : path.join(__dirname, '..'));
const outI = process.argv.indexOf('--out'), OUT = outI > 0 ? process.argv[outI + 1] : null;
const SC = require(path.join(ROOT, 'src/simulator-controls.js')), SP = require(path.join(ROOT, 'src/simulator-profiles.js')), SCH = require(path.join(ROOT, 'src/input-scheduler.js')), XA = require(path.join(ROOT, 'src/execution-adapters.js'));
const { lifecycleHost, TOKEN, SHA } = require(path.join(__dirname, '..', 'tests', 'lifecycle-host-fixture.cjs'));
(async () => {
  const host = lifecycleHost(1, { handGapMs: 400 }), api = new SC.HostApi({ token: TOKEN, fetch: host.fetch }), session = SC.hostSession(api); session.capabilities = { singleClickGuardMaxMs: 540 };
  const auth = SC.authorizations({ environment: 'repro-env', approvedBy: 'repro operator', exeFileName: 'EightMaxTestTable.exe', exeSha256: SHA }), w = [...host.tables.values()][0];
  const t = new SC.SimulatorTable({ id: 1, window: { hwnd: w.hwnd, pid: w.pid, title: 'EightMax Test Table 01', client: w.client }, profile: SP.fixtureProfile({ exeSha256: SHA }), api, session, scheduler: new SCH.InputScheduler({ maxQueue: 8 }), qaAuthorization: auth.qa, recorder: new XA.DiagnosticsRecorder(), allowScripted: true, seed: 1, timing: { postClickSettleMs: 0 }, options: { decisionWindowMs: 10000, postActionTimeoutMs: 800, pollMs: 5, idlePollMs: 5, stopOnPause: false } });
  const kinds = {}; const run = t.run(Infinity, (r) => { const k = r.kind + (r.reason ? ': ' + String(r.reason).slice(0, 60) : ''); kinds[k] = (kinds[k] || 0) + 1; });
  const t0 = Date.now(); let last = -1, stillSince = Date.now(); while (Date.now() - t0 < 30000) { await new Promise((r) => setTimeout(r, 500)); if (t.m.confirmed !== last) { last = t.m.confirmed; stillSince = Date.now(); } else if (Date.now() - stillSince > 8000) break; }
  t.stop(); { let tm; await Promise.race([run, new Promise((r) => { tm = setTimeout(r, 3000); })]); clearTimeout(tm); } if (t.dispose) t.dispose(); if (host.dispose) host.dispose(); else for (const x of host.tables.values()) { clearTimeout(x.dealer.timer); clearTimeout(x.dealer.holdTimer); } const st = w.dealer.summary().state;
  const doc = { format: 'eightmax-repro-elimination-stall', version: 1, sourceTree: ROOT, at: new Date().toISOString(), confirmedActions: t.m.confirmed, stalledForMs: Date.now() - stillSince, dealerHand: st.hand, zeroStackSeats: st.stacks.map((s, i) => s === 0 ? i : -1).filter((i) => i >= 0), engine: { paused: t.engine.paused, reason: t.engine.pauseReason }, stepResults: kinds, input: 'none while stalled (safe)' };
  doc.stalled = doc.stalledForMs >= 8000 && /untracked-hand|missed-hand-start/.test(String(doc.engine.reason));
  console.log(JSON.stringify(doc, null, 2)); if (OUT) fs.writeFileSync(OUT, JSON.stringify(doc, null, 2)); process.exitCode = 0;   // 0.36.2 M3: no forced exit
})();
