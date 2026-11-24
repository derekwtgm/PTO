#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 4.0: the release evidence files, built ONLY from measured reports.
 *
 *   node tools/make-m40-evidence.cjs --results <dir> [--out <dir>] [--operator-baseline <json>]
 *
 * <dir> holds one folder per Windows CI results branch (git clone of m40-results/<run id>-<job>): run.json + results/*.json, as the
 * workflow .github/workflows/windows-0362-m40.yml pushes them. Every number in the output names the run id, the job and the file it
 * comes from. Outputs: SCHEDULER-PERFORMANCE-4.0.json, MOUSE-INPUT-PERFORMANCE-4.0.json, MULTITABLE-STRESS-4.0.json,
 * WINDOWS-VALIDATION-4.0.json, REGRESSION-4.0.json and a RECOGNITION-VALIDATION-4.0.json section of the real-window runs (the
 * deterministic dataset is added from tools/recognition-validation-040.cjs output with --dataset <json>).
 */
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const DIR = arg('results'), OUT = arg('out', '.'), r1 = (v, d = 0) => (Number.isFinite(v) ? +v.toFixed(d) : null);
if (!DIR) { console.error('--results <dir> is required'); process.exit(2); }
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
/** One entry per results branch folder: {dir, run, job, sha, zipSha256, outcome, files: [{name, doc}]}. */
function branches() {
  const out = [];
  for (const d of fs.readdirSync(DIR).sort()) {
    const p = path.join(DIR, d), run = readJson(path.join(p, 'run.json')); if (!run) continue;
    const files = []; const res = path.join(p, 'results');
    if (fs.existsSync(res)) for (const f of fs.readdirSync(res).filter((x) => x.endsWith('.json'))) { const doc = readJson(path.join(res, f)); if (doc) files.push({ name: f, doc }); }
    out.push({ dir: d, run: run.run, job: run.job, sha: run.sha, zipSha256: run.zipSha256 || null, outcome: run.outcome || null, order: run.order || null, display: readJson(path.join(p, 'display.json')), files, path: p });
  }
  return out;
}
const src = (b, f, id) => ({ run: b.run, job: b.job, file: f, ...(id ? { scenario: id } : {}) });
/** The comparable numbers of one gameplay-acceptance scenario. */
function row(s) {
  const m = s.metrics || {}, ms = m.measurements || {}, m40 = ms.m40 || {}, sc = m40.scheduler || {}, tl = (m40.timeline || {}).overall || {}, st = (x) => (x ? { mean: r1(x.mean), p50: r1(x.p50), p95: r1(x.p95), p99: r1(x.p99), max: r1(x.max), n: x.n } : null);
  return { id: s.id, status: s.status, tables: m.tables, seconds: m.seconds, actionsConfirmed: m.actionsConfirmed, actionsPerMinute: m.seconds ? r1(60 * m.actionsConfirmed / m.seconds, 1) : null, completedHands: m.completedHands,
    schedulingDelayMs: st(ms.schedulingDelayMs), actionLatencyMs: st(ms.actionLatencyMs), deadlineMisses: (ms.deadlineMisses || {}).byTables === undefined ? null : ms.deadlineMisses.byTables,
    incorrectActions: m.incorrectActions, wrongActions: m.wrongActions === undefined ? null : m.wrongActions, incorrectClickKinds: m.incorrectClickKinds || null, confirmedByTableClock: m.confirmedByTableClock === undefined ? null : m.confirmedByTableClock, invalidWagers: m.invalidWagers, confirmedButNotApplied: m.confirmedButNotApplied, uncertainOrUnconfirmed: m.uncertainOrUnconfirmed, uncertainByTestStop: m.uncertainByTestStop, inputStatus: ms.inputStatus || null,
    heroEliminations: m.heroEliminations === undefined ? null : m.heroEliminations, heroTimeouts: m.heroTimeouts === undefined ? null : m.heroTimeouts, heroTimeoutsInTrackedHands: m.heroTimeoutsInTrackedHands === undefined ? null : m.heroTimeoutsInTrackedHands, heroTimeoutsInUntrackedHands: m.heroTimeoutsInUntrackedHands === undefined ? null : m.heroTimeoutsInUntrackedHands,
    untrackedHands: m.untrackedHands, refusedReadings: m.refusedReadings === undefined ? null : m.refusedReadings, misdirectedPresses: m.misdirectedPresses === undefined ? null : m.misdirectedPresses, releasesWithoutAction: m.releasesWithoutAction === undefined ? null : m.releasesWithoutAction,
    leaseMs: st(sc.leaseMs || tl.leaseOccupancyMs), cursorUtilization: sc.cursorUtilization === undefined ? null : r1(sc.cursorUtilization, 4), fairness: (m40.fairness || {}).jainActionsPerTable === undefined ? null : r1(m40.fairness.jainActionsPerTable, 4), maxWaitMs: (m40.fairness || {}).maxWaitMs === undefined ? null : r1(m40.fairness.maxWaitMs),
    workload: m40.workload || null, resources: m40.resources ? { cpuPercent: m40.resources.cpuPercent || m40.resources.cpu || null, memoryMiB: m40.resources.memoryMiB || m40.resources.rssMiB || null, gpu: m40.resources.gpu || null } : null };
}
const lease = (s) => { const tl = ((((s.metrics || {}).measurements || {}).m40 || {}).timeline || {}).overall || {}; const k = (x) => (x ? { mean: r1(x.mean), p50: r1(x.p50), p95: r1(x.p95) } : null);
  return { leaseOccupancyMs: k(tl.leaseOccupancyMs), queueWaitMs: k(tl.queueWaitMs), revalidationMs: k(tl.revalidationMs), preMoveMs: k(tl.preMoveMs), moveMs: k(tl.moveMs), clickMs: k(tl.clickMs), ackMs: k(tl.ackMs), wagerMs: k(tl.wagerMs), settleOutsideMs: k(tl.settleOutsideMs), leaseTailMs: k(tl.leaseTailMs), confirmMs: k(tl.confirmMs), captureMs: k(tl.captureMs), recognitionMs: k(tl.recognitionMs),
    driver: tl.driver ? Object.fromEntries(Object.entries(tl.driver).map(([a, b]) => [a, k(b)])) : null }; };
function machine(doc) { const m = (doc && doc.machine) || {}; return { platform: m.platform, release: m.release, cpu: m.cpu, cpus: m.cpus, ramGiB: m.ramGiB, node: m.node }; }

function scheduler(B) {
  const out = { format: 'eightmax-scheduler-performance', version: 1, milestone: '0.36.2-milestone-4.0', generatedAt: new Date().toISOString(), generator: 'tools/make-m40-evidence.cjs',
    note: 'Every number is measured. A/B rows come from the SAME machine, the same workload (the Milestone 3.2 stability workload: 1/2/5/8 tables, 60 s each, a window closed and reopened and an emergency stop per table count, 800 px tables) and the same mouse speed (1 200 px/s); only the input pipeline differs. Rows with another speed or policy are listed apart.',
    sameMachineComparisons: [], milestone32ZipBaseline: [], policyComparison: [], fastPresetApart: [], leaseComposition: [], summary: null };
  for (const b of B.filter((x) => /^ab(-\d+)?$/.test(x.job))) {
    const get = (n) => (b.files.find((f) => f.name === 'stability-' + n + '.json') || {}).doc, comp = get('compat-3.2'), opt = get('optimized'); if (!comp || !opt) continue;
    const pairs = []; for (const s of comp.scenarios || []) { const t = (opt.scenarios || []).find((x) => x.id === s.id); if (!t) continue; const a = row(s), c = row(t);
      const ch = (x, y) => (x && y && x.mean ? r1(100 * (y.mean - x.mean) / x.mean, 1) : null);
      pairs.push({ tables: a.tables, milestone32Pipeline: a, milestone40Pipeline: c, change: { schedulingDelayMeanPercent: ch(a.schedulingDelayMs, c.schedulingDelayMs), schedulingDelayP95Ms: a.schedulingDelayMs && c.schedulingDelayMs ? r1(c.schedulingDelayMs.p95 - a.schedulingDelayMs.p95) : null, schedulingDelayP99Ms: a.schedulingDelayMs && c.schedulingDelayMs ? r1(c.schedulingDelayMs.p99 - a.schedulingDelayMs.p99) : null, actionLatencyMeanPercent: ch(a.actionLatencyMs, c.actionLatencyMs), confirmedActions: c.actionsConfirmed - a.actionsConfirmed, deadlineMisses: c.deadlineMisses - a.deadlineMisses } }); }
    out.sameMachineComparisons.push({ source: src(b, 'stability-compat-3.2.json + stability-optimized.json'), order: b.order || 'compat-3.2,optimized', machine: machine(comp), pairs });
    for (const extra of b.files.filter((f) => /^stability-optimized-./.test(f.name))) {
      const id = extra.name.replace('stability-', '').replace('.json', ''), rows = (extra.doc.scenarios || []).map(row);
      if (id === 'optimized-fast') out.fastPresetApart.push({ source: src(b, extra.name), mouse: '2 000 px/s, acceleration 15 000 px/s^2 (the Fast preset) - NOT comparable with the 1 200 px/s rows', rows });
      else out.policyComparison.push({ source: src(b, extra.name), policy: id.replace('optimized-', ''), pipeline: 'optimized', sameMachineAs: 'the A/B rows of ' + b.job, rows });
    }
  }
  for (const b of B.filter((x) => x.job === 'm32')) for (const f of b.files) out.milestone32ZipBaseline.push({ source: src(b, f.name), note: 'the Milestone 3.2 release ZIP itself, its own tools, a separate CI machine', rows: (f.doc.scenarios || []).map(row) });
  for (const b of B.filter((x) => x.job === 'policies')) for (const f of b.files.filter((x) => /^policy-/.test(x.name))) out.policyComparison.push({ source: src(b, f.name), policy: f.name.replace('policy-', '').replace('.json', ''), pipeline: 'optimized', seconds: (f.doc.scenarios || [])[0] && f.doc.scenarios[0].metrics && f.doc.scenarios[0].metrics.seconds, rows: (f.doc.scenarios || []).map(row) });
  for (const b of B.filter((x) => /^sustained-8-(optimized|compat-3\.2)$/.test(x.job))) for (const f of b.files) for (const s of f.doc.scenarios || []) out.leaseComposition.push({ source: src(b, f.name, s.id), pipeline: f.doc.pipeline, tables: (s.metrics || {}).tables, ...lease(s) });
  // summary: the 8-table (largest) rows of every same-machine comparison
  const big = out.sameMachineComparisons.map((c) => c.pairs.reduce((a, p) => (!a || p.tables > a.tables ? p : a), null)).filter(Boolean), five = out.sameMachineComparisons.map((c) => c.pairs.find((p) => p.tables === 5)).filter(Boolean);
  const avg = (xs) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length, 1) : null);
  out.summary = { machines: big.length, eightTables: { schedulingDelayChangePercent: big.map((p) => p.change.schedulingDelayMeanPercent), meanChangePercent: avg(big.map((p) => p.change.schedulingDelayMeanPercent)), latencyChangePercent: big.map((p) => p.change.actionLatencyMeanPercent), meanLatencyChangePercent: avg(big.map((p) => p.change.actionLatencyMeanPercent)), deadlineMissesM32: big.map((p) => p.milestone32Pipeline.deadlineMisses), deadlineMissesM40: big.map((p) => p.milestone40Pipeline.deadlineMisses), incorrectActionsM40: big.map((p) => p.milestone40Pipeline.incorrectActions) },
    fiveTables: { schedulingDelayChangePercent: five.map((p) => p.change.schedulingDelayMeanPercent), meanChangePercent: avg(five.map((p) => p.change.schedulingDelayMeanPercent)) } };
  return out;
}
function stress(B) {
  const out = { format: 'eightmax-multitable-stress', version: 1, milestone: '0.36.2-milestone-4.0', generatedAt: new Date().toISOString(), generator: 'tools/make-m40-evidence.cjs',
    note: 'Uninterrupted play on Windows CI (GitHub-hosted windows-latest, 2 cores / 4 threads, 16 GiB, 1920x1080 at 100 %). "all seats" = every seat played through the window (the Milestone 3 stress workload); "hero" = one seat per table played through the window, the other seats by the table itself after a think time, with the table\'s own action clock.', runs: [] };
  for (const b of B.filter((x) => /^sustained-/.test(x.job))) for (const f of b.files) for (const s of f.doc.scenarios || []) out.runs.push({ source: src(b, f.name, s.id), pipeline: f.doc.pipeline, policy: f.doc.policy, outcome: f.doc.overall, checks: (s.checks || []).map((c) => ({ name: c.name, pass: c.pass, warning: !!c.warning })), ...row(s), evidenceFiles: (s.metrics || {}).evidenceFiles || [], cleanupOk: f.doc.cleanup ? f.doc.cleanup.ok : null });
  return out;
}
/** The Windows test runner's own reports inside a results branch (Milestone3.1-*, Milestone3.2-T5-*, Milestone4.0-* run folders). */
function runnerReports(b) {
  const res = path.join(b.path, 'results'); if (!fs.existsSync(res)) return [];
  return fs.readdirSync(res).filter((d) => /^Milestone(3\.1|3\.2-T5|4\.0)-/.test(d)).map((d) => { const j = readJson(path.join(res, d, 'milestone3-results.json')); return j ? { file: d + '/milestone3-results.json', mode: j.mode, overall: j.overall, exitCode: j.exitCode, counts: j.counts, recovered: !!j.recovered } : { file: d, overall: null }; });
}
function windowsValidation(B) {
  return { format: 'eightmax-windows-validation', version: 1, milestone: '0.36.2-milestone-4.0', generatedAt: new Date().toISOString(), generator: 'tools/make-m40-evidence.cjs', repository: 'derekwtgm/PTO', workflow: '.github/workflows/windows-0362-m40.yml',
    jobs: B.map((b) => ({ run: b.run, job: b.job, sha: b.sha, zipSha256: b.zipSha256, outcome: b.outcome, display: b.display ? { requested: b.display.requested || null, after: b.display.after || null, achieved: b.display.achieved || null } : null,
      reports: b.files.map((f) => ({ file: f.name, overall: f.doc.overall || (f.doc.verdict ? JSON.stringify(f.doc.verdict) : null), summary: f.doc.summary || null })).concat(runnerReports(b)) })) };
}
function regression(B) {
  const out = { format: 'eightmax-regression', version: 1, milestone: '0.36.2-milestone-4.0', generatedAt: new Date().toISOString(), generator: 'tools/make-m40-evidence.cjs', operatorBaselineMilestone32: { passed: 142, failed: 0, warnings: 1, skipped: 5, source: 'the operator\'s Milestone 3.2 run (as reported in the Milestone 4.0 brief)' }, linux: [], windowsFullAcceptance: [], t5: [] };
  for (const b of B.filter((x) => x.job === 'linux')) { const v = readJson(path.join(b.path, 'results', 'linux-verdict.json')); out.linux.push({ run: b.run, sha: b.sha, outcome: b.outcome, verdict: v ? v.verdict : null, suite: v ? v.m40Suite : null, failingFilesRunAlone: v ? v.failingFilesRunAlone : null, milestone32SuiteSameRunner: v ? v.m32SuiteSameRunner : null }); }
  for (const b of B.filter((x) => x.job === 'full')) {
    const dirs = fs.existsSync(path.join(b.path, 'results')) ? fs.readdirSync(path.join(b.path, 'results')).filter((d) => /^Milestone3\.1-/.test(d)) : [], res = dirs.length ? readJson(path.join(b.path, 'results', dirs[0], 'milestone3-results.json')) : null;
    out.windowsFullAcceptance.push({ run: b.run, sha: b.sha, zipSha256: b.zipSha256, outcome: b.outcome, overall: res ? res.overall : null, counts: res ? res.counts : null, phases: res && res.phases ? Object.fromEntries(Object.entries(res.phases).map(([k, v]) => [k, { status: v.status, counts: v.counts }])) : null });
  }
  for (const b of B.filter((x) => /^t5-\d+$/.test(x.job))) {
    const dirs = fs.existsSync(path.join(b.path, 'results')) ? fs.readdirSync(path.join(b.path, 'results')).filter((d) => /^Milestone3\.2-T5-/.test(d)) : [], res = dirs.length ? readJson(path.join(b.path, 'results', dirs[0], 'milestone3-results.json')) : null;
    out.t5.push({ run: b.run, job: b.job, outcome: b.outcome, displayScaling: b.display && b.display.after ? b.display.after.scalePercent : null, overall: res ? res.overall : null, counts: res ? res.counts : null });
  }
  return out;
}
function mouse(B) {
  const out = { format: 'eightmax-mouse-input-performance', version: 1, milestone: '0.36.2-milestone-4.0', generatedAt: new Date().toISOString(), generator: 'tools/make-m40-evidence.cjs', presets: require(path.join(__dirname, '..', 'src', 'input-presets.js')).PRESETS, motionValidation: [], driverPhases: [], fastPresetApart: scheduler(B).fastPresetApart };
  for (const b of B.filter((x) => x.job === 'motion')) for (const f of b.files) out.motionValidation.push({ source: src(b, f.name), ok: f.doc.ok, driver: f.doc.driver, table: f.doc.table, speeds: (f.doc.speeds || []).map((s) => ({ speed: s.speed, maxAccel: s.maxAccel, move800Ms: s.move800Ms, summary: s.summary, ok: s.ok })) });
  for (const c of scheduler(B).leaseComposition) out.driverPhases.push({ source: c.source, pipeline: c.pipeline, tables: c.tables, moveMs: c.moveMs, clickMs: c.clickMs, driver: c.driver });
  return out;
}
function recognitionWindows(B) {
  const out = []; for (const b of B.filter((x) => /^recognition-\d+$/.test(x.job))) for (const f of b.files.filter((x) => /^recognition-windows/.test(x.name))) out.push({ source: src(b, f.name), scaleRequested: Number(b.job.split('-')[1]), display: b.display ? { after: b.display.after || null, achieved: b.display.achieved || null } : null, displayScale: f.doc.displayScale, desktop: f.doc.desktop, widthsTested: f.doc.widthsTested,
    tables: (f.doc.tables || []).map((t) => ({ width: t.width, client: t.client, checks: (t.verify || []).length, passed: (t.verify || []).filter((v) => v.verdict !== 'fail').length, fullyRead: (t.verify || []).filter((v) => v.verdict === 'pass').length, critical: [...new Set((t.verify || []).flatMap((v) => v.critical || []))].slice(0, 5), stripCropMatches: t.stripCropMatches, stripCropChecks: t.stripCropChecks, captureMs: t.capture })), features: f.doc.features });
  return out;
}
function main() {
  const B = branches(); fs.mkdirSync(OUT, { recursive: true }); const w = (n, d) => { fs.writeFileSync(path.join(OUT, n), JSON.stringify(d, null, 1) + '\n'); console.log('wrote ' + n); };
  w('SCHEDULER-PERFORMANCE-4.0.json', scheduler(B)); w('MULTITABLE-STRESS-4.0.json', stress(B)); w('WINDOWS-VALIDATION-4.0.json', windowsValidation(B)); w('REGRESSION-4.0.json', regression(B)); w('MOUSE-INPUT-PERFORMANCE-4.0.json', mouse(B));
  const ds = arg('dataset', ''), dataset = ds ? readJson(ds) : null, ciDataset = B.filter((x) => /^recognition-100$/.test(x.job)).flatMap((b) => b.files.filter((f) => f.name === 'recognition-dataset.json').map((f) => ({ source: src(b, f.name), doc: f.doc })));
  w('RECOGNITION-VALIDATION-4.0.json', { format: 'eightmax-recognition-validation-summary', version: 1, milestone: '0.36.2-milestone-4.0', generatedAt: new Date().toISOString(), generator: 'tools/make-m40-evidence.cjs',
    deterministicDataset: dataset ? { source: ds, verdict: dataset.verdict, frames: dataset.frames, features: dataset.features, perDegradation: dataset.perDegradation, geometry: dataset.geometry, perSize: dataset.perSize, dataset: dataset.dataset, platform: dataset.platform } : null,
    deterministicDatasetOnWindowsCI: ciDataset.map((x) => ({ source: x.source, verdict: x.doc.verdict, frames: x.doc.frames, geometry: x.doc.geometry })), realWindows: recognitionWindows(B) });
}
main();
