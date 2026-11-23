#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 3: PROCESS-EXIT AUDIT of a test runner (the Milestone 2 runner could stay alive for minutes after
 * writing its complete report because finished scenarios left their timeout timers running).
 *   node tools/exit-audit-0362m3.cjs [--runs 10] [--max-exit-ms 5000] [--out FILE] -- <runner.cjs> [runner args...]
 * Each run: the runner is started with a preload (exit-audit-preload-0362m3.cjs) that records, the moment the runner writes its
 * report (--out), every resource still keeping the event loop alive (process.getActiveResourcesInfo()) and, at process exit, what
 * is left. The audit then checks: the report exists and every scenario has a final status; the process exited by itself (never
 * killed by this tool unless it exceeded --hard-limit-ms); the time from report to exit; the exit code matches the report's verdict;
 * no child process of the runner survives. It never forces an exit to hide outstanding work: a runner that does not exit is reported.
 */
const path = require('path'), fs = require('fs'), cp = require('child_process'), os = require('os');
const argv = process.argv.slice(2), dd = argv.indexOf('--'), own = dd >= 0 ? argv.slice(0, dd) : argv, runner = dd >= 0 ? argv.slice(dd + 1) : [];
const opt = (k, d) => { const i = own.indexOf('--' + k); return i >= 0 ? own[i + 1] : d; };
const RUNS = Number(opt('runs', '10')), MAX_EXIT = Number(opt('max-exit-ms', '5000')), HARD = Number(opt('hard-limit-ms', '900000')), OUT = opt('out', null), WORK = opt('work', fs.mkdtempSync(path.join(os.tmpdir(), 'em-exit-audit-')));
if (!runner.length) { console.error('usage: exit-audit-0362m3.cjs [--runs N] -- runner.cjs [args]'); process.exit(2); }
const PRELOAD = path.join(__dirname, 'exit-audit-preload-0362m3.cjs');
const childrenOf = (pid) => { if (process.platform === 'win32') { try { return cp.execFileSync('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process -Filter "ParentProcessId=' + pid + '" | ForEach-Object { $_.ProcessId }'], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number); } catch (e) { return []; } } try { return cp.execFileSync('ps', ['-o', 'pid=', '--ppid', String(pid)], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number); } catch (e) { return []; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function once(i) {
  const report = path.join(WORK, 'run-' + i + '-report.json'), side = path.join(WORK, 'run-' + i + '-exit-audit.json'); for (const f of [report, side]) { try { fs.unlinkSync(f); } catch (e) { /* none */ } }
  const args = ['--require', PRELOAD, ...runner, '--out', report], t0 = Date.now();
  const child = cp.spawn(process.execPath, args, { env: { ...process.env, EM_EXIT_AUDIT_REPORT: report, EM_EXIT_AUDIT_SIDECAR: side }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '', grandchildren = new Set(); child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
  // child-process sampling: every second on Linux/macOS (ps); on Windows not sampled here (spawning PowerShell every second would disturb
  // real-window tests) - there the runner's own child-process audit (report.cleanup) and the Windows script's leftover check apply
  const sampler = process.platform === 'win32' ? null : setInterval(() => { for (const p of childrenOf(child.pid)) grandchildren.add(p); }, 1000);
  let hardKilled = false; const hard = setTimeout(() => { hardKilled = true; try { child.kill(); } catch (e) { /* gone */ } }, HARD);
  const [code, signal] = await new Promise((r) => child.on('exit', (c, s) => r([c, s]))); clearTimeout(hard); if (sampler) clearInterval(sampler); const tExit = Date.now();
  let side0 = null; try { side0 = JSON.parse(fs.readFileSync(side, 'utf8')); } catch (e) { /* none */ }
  let rep = null; try { rep = JSON.parse(fs.readFileSync(report, 'utf8')); } catch (e) { /* none */ }
  const tReport = side0 && side0.reportWrittenAt ? side0.reportWrittenAt : null, survivors = [...grandchildren].filter(alive);
  const scenarios = rep && Array.isArray(rep.scenarios) ? rep.scenarios : [], allFinal = scenarios.length > 0 && scenarios.every((s) => s.status === 'pass' || s.status === 'fail');
  const verdict = rep ? rep.overall : null, expectedCode = verdict === 'PASS' ? 0 : 1;
  const runnerCleanup = rep && rep.cleanup ? { ok: rep.cleanup.ok, unexpected: rep.cleanup.unexpected, childProcessesNotExited: (rep.cleanup.childProcesses || []).filter((c) => !c.exited).length } : null;
  const r = { run: i, exitCode: code, signal, hardKilled, wallMs: tExit - t0, reportWritten: !!rep, reportToExitMs: tReport ? tExit - tReport : null, verdict, scenarios: scenarios.length, everyScenarioFinal: allFinal, runnerCleanup, childSampling: process.platform === 'win32' ? 'not sampled on Windows (see runnerCleanup and the Windows leftover-process check)' : 'ps every 1 s',
    exitCodeMatchesVerdict: rep ? code === expectedCode : false, activeAtReport: side0 ? side0.activeAtReport : null, activeAtExit: side0 ? side0.activeAtExit : null, survivingChildProcesses: survivors, stderrTail: err.split('\n').slice(-4).join(' | ').slice(0, 400) };
  r.clean = !hardKilled && r.reportWritten && allFinal && r.exitCodeMatchesVerdict && r.reportToExitMs !== null && r.reportToExitMs <= MAX_EXIT && survivors.length === 0;
  return r;
}
(async () => {
  const runs = []; for (let i = 1; i <= RUNS; i++) { const r = await once(i); runs.push(r); console.log('run ' + i + ': ' + (r.clean ? 'CLEAN' : 'NOT CLEAN') + ' - ' + r.verdict + ', exit ' + r.exitCode + (r.signal ? ' (' + r.signal + ')' : '') + ', report->exit ' + r.reportToExitMs + ' ms, active at report: ' + JSON.stringify(r.activeAtReport && r.activeAtReport.counts)); }
  const doc = { format: 'eightmax-exit-audit', version: 1, tool: 'tools/exit-audit-0362m3.cjs', runner: runner.join(' '), at: new Date().toISOString(), platform: process.platform + ' ' + os.release(), node: process.version, maxExitMs: MAX_EXIT,
    runs, summary: { runs: runs.length, clean: runs.filter((r) => r.clean).length, maxReportToExitMs: Math.max(...runs.map((r) => (r.reportToExitMs === null ? Infinity : r.reportToExitMs))), allExitCodesMatch: runs.every((r) => r.exitCodeMatchesVerdict), hardKilled: runs.filter((r) => r.hardKilled).length } };
  doc.overall = doc.summary.clean === runs.length ? 'PASS' : 'FAIL';
  if (OUT) { fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(doc, null, 2)); }
  console.log('exit audit: ' + doc.overall + ' (' + doc.summary.clean + '/' + runs.length + ' clean, max report->exit ' + doc.summary.maxReportToExitMs + ' ms)');
  process.exitCode = doc.overall === 'PASS' ? 0 : 1;
})();
