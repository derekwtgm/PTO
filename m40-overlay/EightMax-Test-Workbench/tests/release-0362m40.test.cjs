'use strict';
// 0.36.2 Milestone 4.0: the operator launcher RUN-M4-PERFORMANCE-TEST.cmd (modes A-E), its runner modes, the plain-language summary, the
// Milestone 4.0 tools, the input-pipeline profiles (compat-3.2 = exactly Milestone 3.2), the mouse-speed presets, and the capacity model.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..'), read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'), ascii = (f) => /^[\x00-\x7f]*$/.test(fs.readFileSync(path.join(ROOT, f), 'latin1'));

test('M4.0 launcher RUN-M4-PERFORMANCE-TEST.cmd: CRLF, ASCII, no BOM, %~dp0 based, 64-bit Windows PowerShell 5.1, results outside the folder, a ZIP every run', () => {
  const b = fs.readFileSync(path.join(ROOT, 'RUN-M4-PERFORMANCE-TEST.cmd')), t = b.toString('latin1');
  assert.ok(!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), 'no UTF-8 BOM'); assert.ok(/^[\x00-\x7f]*$/.test(t), 'ASCII only');
  assert.equal((t.match(/\r\n/g) || []).length, (t.match(/\n/g) || []).length, 'every line ends with CRLF'); assert.match(t, /^@echo off\r\n/);
  for (const l of t.split('\r\n')) { if (/^\s*if\b/i.test(l)) assert.doesNotMatch(l, /\)\s*&\s*\(/, l); if (/^rem\b/i.test(l) && !/LOCALAPPDATA/.test(l)) assert.ok(!l.includes('%'), 'no percent sign in a comment line: ' + l); }
  for (const re of [/setlocal EnableExtensions DisableDelayedExpansion/, /set "EM_APP=%~dp0"/, /Sysnative\\WindowsPowerShell\\v1\.0\\powershell\.exe/, /-Command "exit 7"/, /2>>"%EM_ERR%"/,
    /:launcher_failure[\s\S]*launcher-failure-[\s\S]*type "%EM_ERR%"/, /\.zip\\" >nul && set "EM_PROBLEM=This file was started from inside the ZIP[^\r\n]*RUN-M4-PERFORMANCE-TEST\.cmd/, /EightMax-Test-Workbench\\TestResults/,
    /explorer\.exe \/select,"%EM_ZIP%"/, /endlocal & exit \/b %EM_RC%/, /if defined EM_INTERACTIVE pause/, /-LauncherToken %EM_TOKEN%/, /%EIGHTMAX_M4_ARGS%/, /M4-SUMMARY\.txt/]) assert.match(t, re, String(re));
  assert.match(t, /choice \/c ABCDELQ/);
  for (const [k, m] of [['A', 'M4Recognition'], ['B', 'M4Scheduler'], ['C', 'M4Extended'], ['D', 'M4Full'], ['E', 'Package']]) assert.match(t, new RegExp('if /i "%EM_KEY%"=="' + k + '" \\(set "EM_MODE=' + m + '"'), k + ' -> ' + m);
  for (const f of ['windows\\M40-Summary.ps1', 'tools\\recognition-validation-040.cjs', 'tools\\gameplay-acceptance-0362m3.cjs', 'desktop\\bin\\EightMaxTestTable.exe', 'runtime\\node\\node.exe']) assert.ok(t.includes('"' + f + '"'), 'checks ' + f + ' before starting');
});

test('M4.0 runner: modes A-D in windows\\Test-Milestone31.ps1 (Milestone4.0 result folders), every M3.x mode unchanged; ASCII; the summary module is dot-sourced', () => {
  const r = read('windows/Test-Milestone31.ps1'), lib = read('windows/M31-Lib.ps1'), sum = read('windows/M40-Summary.ps1');
  assert.match(r, /\[ValidateSet\('Quick', 'Startup', 'Full', 'T5', 'M4Recognition', 'M4Scheduler', 'M4Extended', 'M4Full', 'Package', 'Detect'\)\]/);
  assert.match(r, /'M4Recognition' \{ @\('environment', 'integrity', 'dependencies', 'host-start', 'recognition', 'recognition-windows', 'cleanup'\) \}/);
  assert.match(r, /'M4Scheduler' \{ @\('environment', 'integrity', 'dependencies', 'host-start', 'scheduler', 'cleanup'\) \}/);
  assert.match(r, /'M4Extended' \{ @\('environment', 'integrity', 'dependencies', 'host-start', 'sustained', 'faults', 'cleanup'\) \}/);
  assert.match(r, /'M4Full' \{ @\('environment', 'integrity', 'dependencies', 'unit', 'host-start', 'recognition', 'lifecycle', 'gameplay', 'multi-table', 'scheduler', 'sustained', 'cleanup'\) \}/);
  assert.match(r, /'Full' \{ @\('environment', 'integrity', 'dependencies', 'unit', 'host-start', 'lifecycle', 'gameplay', 'multi-table'\)/, 'mode C of Milestone 3.1 unchanged');
  assert.match(r, /\$script:M31RunPrefix = 'Milestone4\.0'/); assert.match(r, /\. \(Join-Path \$PSScriptRoot 'M40-Summary\.ps1'\)/); assert.match(lib, /Milestone4\\\.0-\|Milestone3\\\.2-T5-/, 'option E finds Milestone 4.0 runs');
  assert.match(r, /--pipeline ' \+ \$x\.pipe \+ ' --policy edf/, 'the scheduler benchmark keeps the Milestone 3.2 order (edf) for both pipelines');
  assert.match(r, /\$runsAB = @\(@\{ key = 'compat-3\.2'; pipe = 'compat-3\.2'; extra = '' \}, @\{ key = 'optimized'; pipe = 'optimized'; extra = '' \}\)/, 'same mouse speed in both rows');
  for (const f of ['Add-M40Comparison', 'Write-M40Summary', 'Get-M40Field', 'Format-M40Degradation']) assert.match(sum, new RegExp('function ' + f + '\\b'));
  assert.match(sum, /Milestone 4\.0 target: 20-30 % lower scheduling delay/); assert.match(sum, /'WARNING'/, 'a missed target is reported as a warning, with the measured value');
  for (const f of ['windows/Test-Milestone31.ps1', 'windows/M31-Lib.ps1', 'windows/M40-Summary.ps1']) {
    assert.ok(ascii(f), f + ' ASCII'); const t = read(f); assert.ok(!/\[pscustomobject\]/i.test(t), f);
    const code = t.replace(/<#[\s\S]*?#>/g, '').split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n'); for (const s of code.match(/'(?:[^']|'')*'/g) || []) assert.ok(!s.includes('#'), f + ': ' + s);
  }
});

test('M4.0 input pipeline: compat-3.2 is exactly the Milestone 3.2 sequence; optimized is the dashboard default; the presets never change saved settings', () => {
  const D = require('../src/windows-input-driver.js'), PR = require('../src/input-presets.js'), src = read('src/windows-input-driver.js');
  const P = (src.match(/'compat-3\.2': Object\.freeze\((\{[^}]*\})\)/) || [])[1]; assert.ok(P, 'compat profile present');
  assert.match(P, /preflight: 'window-info', clickGuard: 'global', drain: false, settle: 'inside-lease', raiseWait: null, pressGuard: false/);
  assert.match(src, /'optimized': Object\.freeze\(\{ preflight: 'driver', clickGuard: 'process', drain: true, settle: 'after-drain', raiseWait: 'poll', pressGuard: true \}\)/);
  assert.equal(PR.pipelineOf({}), 'optimized'); assert.equal(PR.pipelineOf({ pipeline: 'compat-3.2' }), 'compat-3.2'); void D;
  assert.deepEqual([PR.PRESETS.conservative.maxSpeed, PR.PRESETS.normal.maxSpeed, PR.PRESETS.fast.maxSpeed], [800, 1200, 2000]); assert.deepEqual(PR.LIMITS.maxSpeed, [400, 2800]);
  const saved = { maxSpeed: 1350, maxAccel: 9000, arc: 0.1 }; assert.equal(PR.presetOf(saved), 'custom', 'a saved speed that matches no preset is shown as Custom'); assert.deepEqual(saved, { maxSpeed: 1350, maxAccel: 9000, arc: 0.1 }, 'never changed');
  assert.match(read('src/simulator-controls-ui.js'), /non-GTO/, 'scripted practice decisions stay labelled non-GTO'); assert.match(read('dashboard.html'), /non-GTO/);
});

test('M4.0 tools load without running; the EightMax 5.1 engine is unchanged', () => {
  for (const t of ['tools/recognition-validation-040.cjs', 'tools/motion-validation-040.cjs', 'tools/capacity-model-040.cjs']) { assert.ok(fs.existsSync(path.join(ROOT, t)), t); assert.doesNotThrow(() => require('../' + t), t); }
  const mw = path.join(ROOT, 'native', 'mwcli.exe'); if (fs.existsSync(mw)) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(mw)).digest('hex'), 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72');
});

test('M4.0 capacity model: exact MVA matches the closed-form bounds; the simulation on the real scheduler is deterministic and conservative', async () => {
  const C = require('../tools/capacity-model-040.cjs');
  const m = C.mva(700, 2800, 12); assert.ok(Math.abs(m[0].actionsPerMinute - 60000 / 3500) < 1e-9, 'one table: X = 1 / (S + Z)');
  for (const x of m) { assert.ok(x.actionsPerMinute <= 60000 / 700 + 1e-9 && x.actionsPerMinute <= x.tables * 60000 / 3500 + 1e-9, 'X(n) below both asymptotic bounds'); assert.ok(x.utilization <= 1); }
  assert.ok(m[11].utilization > 0.99 && m[11].queueWaitMs > 4000, 'twelve tables saturate the cursor');
  const o = { tables: 4, minutes: 3, policy: 'edf', lease: { min: 450, p50: 600, p90: 1100, p95: 1400, p99: 1900, max: 2300, mean: 720 }, gap: { min: 2000, p50: 5000, p90: 7500, p95: 8500, p99: 10000, max: 14000, mean: 5200 }, windowMs: 6500, seed: 7 };
  const a = await C.simulate({ ...o }), b = await C.simulate({ ...o }); assert.deepEqual(a, b, 'deterministic'); assert.ok(a.decisions > 100 && a.responseMs.p50 >= 450, JSON.stringify(a));
  const big = await C.simulate({ ...o, tables: 14 }); assert.ok(big.utilization > a.utilization && big.responseMs.p95 > a.responseMs.p95, 'more tables: more cursor load and longer responses');
});
