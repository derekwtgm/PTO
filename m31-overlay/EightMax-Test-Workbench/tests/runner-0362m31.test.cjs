'use strict';
// 0.36.2 Milestone 3.1: the Windows test runner (windows/Test-Milestone31.ps1 + M31-Lib / M31-HostStart / M31-Integrity) and its launchers
// (RUN-0362-MILESTONE3.1-TESTS.cmd, RUN-M3-HOST-DIAGNOSTIC-3.1.cmd). Structural checks run everywhere. The live scenarios run the real
// runner with PowerShell 7 on Linux against tests/fixtures/m31 (a fake desktop host and a stand-in start-up script with failure modes);
// on Windows the same scenarios run under Windows PowerShell 5.1 with the real desktop host in tests/windows/M31-Scenarios.ps1 (CI).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const ROOT = path.join(__dirname, '..'), read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'), readBytes = (f) => fs.readFileSync(path.join(ROOT, f));
const LAUNCHERS = ['RUN-0362-MILESTONE3.1-TESTS.cmd', 'RUN-M3-HOST-DIAGNOSTIC-3.1.cmd', 'RUN-0362-MILESTONE3-TESTS.cmd'];
const SCRIPTS = ['windows/Test-Milestone31.ps1', 'windows/M31-Lib.ps1', 'windows/M31-HostStart.ps1', 'windows/M31-Integrity.ps1', 'windows/Test-Milestone3-0362.ps1', 'windows/Start-Desktop.ps1', 'tests/fixtures/m31/Start-FakeDesktop.ps1'];
const hasPwsh = (() => { try { return cp.spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8', timeout: 60000 }).status === 0; } catch (e) { return false; } })();
const LIVE = process.platform === 'win32' ? 'on Windows these scenarios run with Windows PowerShell 5.1 in tests/windows/M31-Scenarios.ps1' : !hasPwsh ? 'pwsh not installed' : false;

test('M3.1 launchers: CRLF line endings, ASCII, no BOM, quoted paths, %~dp0 based, no unconditional chained commands after IF', () => {
  for (const f of LAUNCHERS) {
    const b = readBytes(f), t = b.toString('latin1');
    assert.ok(!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf), f + ': no UTF-8 BOM (cmd.exe would run "\\ufeff@echo")');
    assert.ok(/^[\x00-\x7f]*$/.test(t), f + ': ASCII only');
    assert.equal((t.match(/\r\n/g) || []).length, (t.match(/\n/g) || []).length, f + ': every line ends with CRLF (LF-only batch files break labels and GOTO)');
    assert.match(t, /^@echo off\r\n/, f);
    for (const l of t.split('\r\n')) if (/^\s*if\b/i.test(l)) assert.doesNotMatch(l, /\)\s*&\s*\(/, f + ': ' + l);
  }
  for (const f of ['RUN-0362-MILESTONE3.1-TESTS.cmd', 'RUN-M3-HOST-DIAGNOSTIC-3.1.cmd']) {
    const t = read(f);
    assert.match(t, /setlocal EnableExtensions DisableDelayedExpansion/, f);
    assert.match(t, /set "EM_APP=%~dp0"/, f + ': works from any current directory');
    assert.match(t, /Sysnative\\WindowsPowerShell\\v1\.0\\powershell\.exe/, f + ': 64-bit PowerShell even from a 32-bit console');
    assert.match(t, /-Command "exit 7"/, f + ': PowerShell is proven to start before the test');
    assert.match(t, /2>>"%EM_ERR%"/, f + ': PowerShell error output is captured');
    assert.match(t, /:launcher_failure[\s\S]*launcher-failure-[\s\S]*type "%EM_ERR%"/, f + ': a diagnostic file with the PowerShell errors is written when the test cannot start');
    assert.match(t, /\.zip\\" >nul && set "EM_PROBLEM=This file was started from inside the ZIP/, f + ': started from inside the ZIP is recognised');
    assert.match(t, /EightMax-Test-Workbench\\TestResults/, f + ': results outside the application folder');
    assert.match(t, /explorer\.exe \/select,"%EM_ZIP%"/, f + ': File Explorer opens with the ZIP selected');
    assert.match(t, /endlocal & exit \/b %EM_RC%/, f + ': exit code passed on');
    assert.match(t, /if defined EM_INTERACTIVE pause/, f + ': never closes silently in a window (no pause in CI)');
    assert.match(t, /-LauncherToken %EM_TOKEN%/, f + ': finds its run folder without decoding a path from a file');
  }
  assert.match(read('RUN-M3-HOST-DIAGNOSTIC-3.1.cmd'), /-Mode %EM_MODE%[^\r\n]*/); assert.match(read('RUN-M3-HOST-DIAGNOSTIC-3.1.cmd'), /set "EM_MODE=Startup"/);
  const main = read('RUN-0362-MILESTONE3.1-TESTS.cmd');
  assert.match(main, /choice \/c ABCDLQ/); for (const m of ['Quick', 'Startup', 'Full', 'Package']) assert.match(main, new RegExp('set "EM_MODE=' + m + '"'));
  assert.match(read('RUN-0362-MILESTONE3-TESTS.cmd'), /call "%~dp0RUN-0362-MILESTONE3\.1-TESTS\.cmd" C/);
});

test('M3.1 runner scripts: ASCII (Windows PowerShell 5.1 reads BOM-less scripts as ANSI), no "#" inside a string, no PSCustomObject records', () => {
  for (const f of SCRIPTS) {
    const t = read(f);
    assert.ok(/^[\x00-\x7f]*$/.test(t), f + ': ASCII only');
    assert.ok(!/\[pscustomobject\]/i.test(t), f + ': no [pscustomobject]');
    const code = t.replace(/<#[\s\S]*?#>/g, '').split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
    for (const s of code.match(/'(?:[^']|'')*'/g) || []) assert.ok(!s.includes('#'), f + ": '#' inside a string confuses the repository's structural lint: " + s);
  }
});

test('M3.1 runner design: continuous files from the first second, atomic status writes, every check appended at once, one file per phase', () => {
  const lib = read('windows/M31-Lib.ps1');
  assert.match(lib, /foreach \(\$f in @\(\$script:M31\.Files\.Console, \$script:M31\.Files\.Errors, \$script:M31\.Files\.Checks, \$script:M31\.Files\.Operations\)\)/, 'console.log, errors.log, checks.jsonl, operations.jsonl exist from the start');
  assert.match(lib, /function Write-M31AtomicText[\s\S]*?\$fs\.Flush\(\$true\)[\s\S]*?\[IO\.File\]::Replace\(\$tmp, \$Path, \[NullString\]::Value\)/, 'temp file, flushed to disk, then replaced');
  assert.match(lib, /function Add-M31Check[\s\S]*?Add-M31Line \$m\.Files\.Checks/, 'a check is appended when it completes');
  assert.match(lib, /function Invoke-M31Operation[\s\S]*?event = 'start'[\s\S]*?& \$Body[\s\S]*?event = 'end'/, 'an operation is recorded before it runs');
  assert.match(lib, /function Complete-M31PhaseRecord[\s\S]*?Write-M31PhaseFile/, 'a phase file is written when the phase ends');
  for (const k of ['type', 'message', 'script', 'line', 'scriptStackTrace', 'phase', 'operation', 'lastSuccessfulCheck', 'currentChildProcess', 'lastExitCode', 'at']) assert.ok(new RegExp('\\b' + k + ' = ').test(lib.slice(lib.indexOf('function Get-M31ErrorDetail'), lib.indexOf('function Add-M31Exception'))), 'exception detail ' + k);
  for (const s of ['PASS', 'FAIL', 'WARNING', 'SKIPPED', 'NOT RUN', 'INTERRUPTED']) assert.ok(lib.includes("'" + s + "'"), 'status ' + s);
  for (const c of ['application', 'harness', 'environment', 'timeout']) assert.ok(lib.includes("'" + c + "'"), 'category ' + c);
  const runner = read('windows/Test-Milestone31.ps1');
  assert.match(runner, /\} finally \{[\s\S]*Complete-M31Run 'interrupted'[\s\S]*Complete-M31Run 'completed'/, 'a report is written after an exception and after Ctrl+C');
  assert.match(runner, /exit \$final\.exitCode/);
});

test('M3.1 runner design: every wait is bounded; only processes of this test session are ever stopped', () => {
  const lib = read('windows/M31-Lib.ps1'), hs = read('windows/M31-HostStart.ps1'), runner = read('windows/Test-Milestone31.ps1');
  assert.equal(((lib + hs + runner).match(/\.WaitForExit\(\)/g) || []).length, 1, 'one argument-less WaitForExit: only after the bounded loop has seen the exit');
  assert.match(lib, /while \(-not \$p\.WaitForExit\(500\)\)[\s\S]{0,1600}try \{ \$p\.WaitForExit\(\) \} catch \{\}/);
  assert.match(lib, /while \(-not \$p\.WaitForExit\(500\)\)[\s\S]*?if \(\$el -ge \$TimeoutSec\)/, 'process waits have a limit');
  for (const op of ['launch-desktop-host', 'wait-readiness', 'verify-health', 'verify-input-driver', 'authenticated-shutdown', 'verify-process-termination', 'verify-port-release']) assert.ok(hs.includes("'" + op + "'"), op);
  assert.equal((hs.match(/Invoke-M31Operation \$g \$Name '/g) || []).length, 12, 'twelve instrumented host-start operations');
  assert.match(lib, /function Stop-M31ProcessTree[\s\S]*?if \(-not \(\$owned -contains \$ProcessId\)\) \{[\s\S]*?does not belong to this test session/, 'a process of another program is never stopped');
  assert.match(lib, /JoinKillOnCloseJob[\s\S]*LimitFlags = 0x2000/, 'kill-on-close job: nothing outlives the runner');
  assert.doesNotMatch(runner + hs, /Stop-Process -Name|Get-Process -Name [^|]*\| *Stop-Process/, 'never stops processes by name');
  assert.match(hs, /Get-M31SecurityPromptFinding|securityPrompt/, 'a Windows security prompt that blocks a start is named');
  const start = read('windows/Start-Desktop.ps1');
  assert.match(start, /if\(\$Headless\)\{[\s\S]*?RedirectStandardOutput[\s\S]*?\} else \{ \$status\.launchMethod='ShellExecute' \}/, 'test launches use CreateProcess');
});

test('M3.1 results location: outside the application folder by default; inside it only test-results is accepted', () => {
  const lib = read('windows/M31-Lib.ps1');
  assert.match(lib, /Join-Path \$local 'EightMax-Test-Workbench\\TestResults'/);
  assert.match(lib, /refused ' \+ \$p \+ ': inside the application folder/);
  assert.match(lib, /'Milestone3\.1-' \+ \$started\.ToString\('yyyyMMdd-HHmmss'\)/);
  assert.match(lib, /while \(Test-Path -LiteralPath \$dir\) \{ \$dir = Join-Path \$outRootUsed \(\$base \+ '-' \+ \$n\); \$n\+\+ \}/, 'never overwrites an earlier run');
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// live scenarios (PowerShell 7 on Linux, fake desktop host)
// ---------------------------------------------------------------------------------------------------------------------------------------
const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'em-m31-runner-'));
function runner(outRoot, args, env = {}, app = ROOT) {
  const r = cp.spawnSync('pwsh', ['-NoProfile', '-File', path.join(app, 'windows', 'Test-Milestone31.ps1'), '-OutRoot', outRoot, '-NonInteractive', '-StartScript', path.join(app, 'tests', 'fixtures', 'm31', 'Start-FakeDesktop.ps1'), ...args],
    { encoding: 'utf8', timeout: 240000, env: { ...process.env, EIGHTMAX_NONINTERACTIVE: '1', ...env } });
  const dirs = fs.existsSync(outRoot) ? fs.readdirSync(outRoot).filter((d) => d.startsWith('Milestone3.1-')).map((d) => path.join(outRoot, d)) : [];
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const dir = dirs[0], res = dir && fs.existsSync(path.join(dir, 'milestone3-results.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'milestone3-results.json'), 'utf8')) : null;
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), dir, res, dirs };
}
const jsonl = (f) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l));
const phase = (res, n) => res.phases.find((p) => p.name === n);
function assertCompleteReport(r) {
  for (const f of ['run-status.json', 'console.log', 'errors.log', 'checks.jsonl', 'operations.jsonl', 'milestone3-results.json', 'milestone3-results.txt', 'milestone3-results.zip']) assert.ok(fs.existsSync(path.join(r.dir, f)), f + ' exists\n' + r.out.slice(-3000));
  const zl = cp.spawnSync('python3', ['-I', '-c', 'import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print("\\n".join(z.namelist()))', path.join(r.dir, 'milestone3-results.zip')], { encoding: 'utf8' });
  if (zl.status === 0) for (const f of ['run-status.json', 'checks.jsonl', 'console.log', 'errors.log', 'milestone3-results.txt']) assert.ok(zl.stdout.split('\n').includes(f), 'ZIP holds ' + f);
  assert.equal(jsonl(path.join(r.dir, 'checks.jsonl')).length, r.res.counts.total, 'checks.jsonl and the report agree');
  const ops = jsonl(path.join(r.dir, 'operations.jsonl')); assert.equal(ops.filter((o) => o.event === 'start').length, ops.filter((o) => o.event === 'end').length, 'every started operation ended');
}

test('M3.1 scenario D: the host starts -> a complete standalone report (12 operations, input driver, shutdown, port released)', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const r = runner(out, ['-Mode', 'Quick']);
    assert.equal(r.status, 0, r.out.slice(-3000)); assertCompleteReport(r);
    assert.ok(['PASS', 'WARNING'].includes(r.res.overall)); assert.equal(phase(r.res, 'host-start').status, 'PASS');
    const ops = jsonl(path.join(r.dir, 'operations.jsonl')).filter((o) => o.event === 'end');
    assert.deepEqual(ops.map((o) => o.operation), ['check-existing-processes', 'check-port', 'prepare-directories', 'launch-startup-script', 'launch-desktop-host', 'wait-readiness', 'read-session-file', 'verify-health', 'verify-input-driver', 'authenticated-shutdown', 'verify-process-termination', 'verify-port-release']);
    assert.ok(ops.every((o) => o.status === 'PASS'), JSON.stringify(ops.filter((o) => o.status !== 'PASS')));
    const red = JSON.parse(fs.readFileSync(path.join(r.dir, 'host-start', '01-prebuilt', 'session-redacted.json'), 'utf8'));
    assert.match(red.token, /^\(redacted, 64 characters\)$/, 'the session key never reaches the report');
    assert.doesNotMatch(fs.readFileSync(path.join(r.dir, 'checks.jsonl'), 'utf8'), /[0-9a-f]{64}"?,"processId/, 'no token in the checks');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1 scenario E: the host cannot start -> the failure names the step and the host error; report and ZIP exist', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const r = runner(out, ['-Mode', 'Quick'], { EIGHTMAX_FAKE_HOST_MODE: 'exit' });
    assert.equal(r.status, 1, r.out.slice(-2000)); assertCompleteReport(r);
    const f = r.res.failures; assert.equal(f.length, 1, JSON.stringify(f));
    assert.match(f[0].name, /6\/12 Wait for the host to report ready/); assert.equal(f[0].category, 'application');
    assert.match(f[0].detail, /host stderr: The desktop host could not start: simulated start-up failure/);
    assert.match(fs.readFileSync(path.join(r.dir, 'milestone3-results.txt'), 'utf8'), /RESULT: {3}FAIL[\s\S]*WHAT FAILED[\s\S]*6\/12/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1 scenario F: the start-up script stops responding -> time-out at the exact step, its processes stopped, report produced', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const t0 = Date.now(), r = runner(out, ['-Mode', 'Quick', '-HostLaunchTimeoutSec', '6'], { EIGHTMAX_FAKE_HOST_MODE: 'script-hang' });
    assert.equal(r.status, 1, r.out.slice(-2000)); assertCompleteReport(r);
    assert.ok(Date.now() - t0 < 120000, 'bounded');
    const f = r.res.failures; assert.equal(f.length, 1, JSON.stringify(f)); assert.equal(f[0].category, 'timeout');
    assert.match(f[0].detail, /did not finish within 6 s; its last recorded step: "launch-host" start/);
    const hang = JSON.parse(fs.readFileSync(path.join(r.dir, 'host-start', '01-prebuilt', 'hang-diagnostics.json'), 'utf8'));
    assert.ok(hang.processTree.processes.length >= 1, 'the process tree was recorded before stopping it');
    const alive = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)).filter((d) => { try { return fs.readFileSync('/proc/' + d + '/cmdline', 'utf8').includes(r.dir) && !/^\S+ Z /.test(fs.readFileSync('/proc/' + d + '/stat', 'utf8').replace(/^\d+ \(.*\) /, 'x ')); } catch (e) { return false; } });
    assert.deepEqual(alive, [], 'the hung start-up script and its children were stopped');
    assert.equal(phase(r.res, 'cleanup').status, 'PASS', 'later phases still ran');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1 scenario G: a PowerShell exception keeps type, message, script, line, stack and phase; dependent phases are SKIPPED, not passed', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const r = runner(out, ['-Mode', 'Quick', '-InjectFault', 'exception:integrity']);
    assert.equal(r.status, 2, r.out.slice(-2000)); assertCompleteReport(r);
    const err = fs.readFileSync(path.join(r.dir, 'errors.log'), 'utf8');
    assert.match(err, /EXCEPTION System\.InvalidOperationException: Injected test fault[^\r\n]*\r?\n {2}where: .*M31-Lib\.ps1 line \d+/);
    assert.match(err, /phase: integrity \| operation: {2}\| last successful check: port 48713 free/); assert.match(err, /PowerShell stack:\r?\n {4}at Invoke-M31Phase/);
    const j = JSON.parse(err.split(/\r?\n/).find((l) => l.startsWith('JSON ')).slice(5));
    for (const k of ['type', 'message', 'script', 'line', 'scriptStackTrace', 'phase', 'lastSuccessfulCheck', 'at']) assert.ok(j[k], k);
    assert.equal(phase(r.res, 'integrity').status, 'FAIL'); assert.equal(phase(r.res, 'host-start').status, 'SKIPPED');
    assert.match(phase(r.res, 'host-start').reason, /requirement "release-integrity" was not established/);
    assert.equal(phase(r.res, 'dependencies').status, 'PASS', 'an independent phase still ran');
    assert.equal(r.res.faultInjected, 'exception:integrity'); assert.match(fs.readFileSync(path.join(r.dir, 'milestone3-results.txt'), 'utf8'), /TEST MODE: a fault was injected/);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1 scenario H: a test fails midway -> completed checks stay saved, the failed check is identified, the run continues', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const r = runner(out, ['-Mode', 'Quick', '-InjectFault', 'check-fail:dependencies']);
    assert.equal(r.status, 1); assertCompleteReport(r);
    const checks = jsonl(path.join(r.dir, 'checks.jsonl')), i = checks.findIndex((c) => c.status === 'FAIL');
    assert.ok(i > 5, 'earlier checks were saved before the failure'); assert.equal(checks[i].phase, 'dependencies'); assert.match(checks[i].name, /injected failing check/);
    assert.equal(phase(r.res, 'host-start').status, 'PASS', 'the next independent phase ran'); assert.equal(r.res.failures.length, 1);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1 scenario I: the runner is killed -> its checkpoint survives; it is detected and packaged INTERRUPTED without inventing results', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const k = runner(out, ['-Mode', 'Quick', '-Label', 'killed', '-InjectFault', 'terminate:host-start']);
    assert.notEqual(k.status, 0); assert.ok(k.dir, 'run folder exists');
    const st = JSON.parse(fs.readFileSync(path.join(k.dir, 'run-status.json'), 'utf8'));
    assert.equal(st.state, 'running'); assert.equal(st.currentPhase, 'host-start'); assert.ok(st.lastSuccessfulCheck);
    assert.ok(jsonl(path.join(k.dir, 'checks.jsonl')).length >= 10, 'checks of the finished phases are on disk');
    const d = cp.spawnSync('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'windows', 'Test-Milestone31.ps1'), '-Mode', 'Detect', '-OutRoot', out], { encoding: 'utf8' });
    assert.match(d.stdout, /an earlier test run did not finish: Milestone3\.1-\d{8}-\d{6}-killed/);
    const p = cp.spawnSync('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'windows', 'Test-Milestone31.ps1'), '-Mode', 'Package', '-OutRoot', out, '-NonInteractive'], { encoding: 'utf8', env: { ...process.env, EIGHTMAX_NONINTERACTIVE: '1' } });
    assert.equal(p.status, 0, p.stdout + p.stderr); assert.match(p.stdout, /Results ZIP: .*milestone3-results\.zip/);
    const res = JSON.parse(fs.readFileSync(path.join(k.dir, 'milestone3-results.json'), 'utf8'));
    assert.equal(res.overall, 'INTERRUPTED'); assert.equal(res.exitCode, 4); assert.equal(res.recovered, true);
    assert.equal(phase(res, 'host-start').status, 'INTERRUPTED'); assert.equal(phase(res, 'cleanup').status, 'NOT RUN');
    assert.equal(res.interruptedAt.phase, 'host-start'); assert.ok(fs.existsSync(path.join(k.dir, 'milestone3-results.zip')));
    assert.ok(!res.checks.some((c) => c.phase === 'cleanup'), 'no result for a phase that never ran');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1 scenario J: a missing dependency gives a clear environment failure (exit 3) and a complete report', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const r = runner(out, ['-Mode', 'Quick', '-InjectFault', 'node-missing']);
    assert.equal(r.status, 3, r.out.slice(-2000)); assertCompleteReport(r);
    assert.equal(r.res.failures.length, 1); assert.equal(r.res.failures[0].category, 'environment'); assert.match(r.res.failures[0].detail, /^missing dependency: .*node-missing-by-fault-injection\.exe does not exist/);
    assert.equal(r.res.gates['node-runtime'].ok, false);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1 scenario L: repeated runs use separate folders and do not interfere', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const a = runner(out, ['-Mode', 'Quick']), b = runner(out, ['-Mode', 'Quick']);
    assert.equal(a.status, 0); assert.equal(b.status, 0); assert.equal(b.dirs.length, 2); assert.notEqual(a.dir, b.dir);
    assert.ok(fs.existsSync(path.join(a.dir, 'milestone3-results.zip')) && fs.existsSync(path.join(b.dir, 'milestone3-results.zip')), 'the first run was not overwritten');
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1 scenario M: application and results folders with spaces, parentheses and non-ASCII characters', { skip: LIVE }, () => {
  const base = tmpRoot(), app = path.join(base, 'Program Folder & Co (copy) \u00fc\u00e9'), out = path.join(base, 'R\u00e9sultats de test (2)');
  try {
    fs.cpSync(ROOT, app, { recursive: true, filter: (src) => !/^(\.git|test-results)([\\/]|$)/.test(path.relative(ROOT, src)) });
    const r = runner(out, ['-Mode', 'Quick'], {}, app);
    assert.equal(r.status, 0, r.out.slice(-3000)); assertCompleteReport(r);
    assert.ok(r.dir.startsWith(out), 'results in the requested folder');
    assert.equal(phase(r.res, 'integrity').status, 'PASS'); assert.equal(phase(r.res, 'host-start').status, 'PASS');
    const env = JSON.parse(fs.readFileSync(path.join(r.dir, 'environment.json'), 'utf8'));
    assert.equal(env.paths.appRoot.hasNonAscii, true); assert.equal(env.paths.appRoot.hasSpaces, true); assert.equal(env.paths.appRoot.hasAmpersand, true); assert.equal(env.paths.resultsFolder.hasNonAscii, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('M3.1 scenario N: the standalone start-up diagnostic runs by itself (no earlier phase or run needed) and reports every case', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const r = runner(out, ['-Mode', 'Startup', '-Label', 'host-diagnostic', '-HostCases', 'prebuilt,build-only']);
    assert.equal(r.status, 0, r.out.slice(-3000)); assertCompleteReport(r); assert.match(r.dir, /-host-diagnostic$/);
    assert.ok(fs.existsSync(path.join(r.dir, 'host-start', 'host-start-summary.json')));
    const sum = JSON.parse(fs.readFileSync(path.join(r.dir, 'host-start', 'host-start-summary.json'), 'utf8'));
    assert.deepEqual(sum.cases.map((c) => c.id), ['prebuilt', 'build-only']); assert.ok(sum.cases.every((c) => c.result === 'PASS'));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1 scenario O: the operator\'s incomplete Milestone 3 run is packaged without running a test; nothing found -> exit 6', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const empty = cp.spawnSync('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'windows', 'Test-Milestone31.ps1'), '-Mode', 'Package', '-OutRoot', path.join(out, 'none'), '-NonInteractive'], { encoding: 'utf8' });
    assert.equal(empty.status, 6, empty.stdout);
    const run = path.join(out, 'Milestone3-20261123-122544'); fs.mkdirSync(path.join(run, 'host-start'), { recursive: true }); fs.mkdirSync(path.join(run, 'state'));
    fs.writeFileSync(path.join(run, 'unit-tests.tap'), 'TAP version 13\nnot ok 82 - M3 release: SHA256SUMS.txt lists every shipped file except itself\n1..116\n# tests 116\n# pass 114\n# fail 1\n# skipped 1\n');
    fs.writeFileSync(path.join(run, 'mwcli-build-id.out.txt'), 'EightMaxBuild=7d08acc7eb4577ee\r\n'); fs.writeFileSync(path.join(run, 'host-prebuilt host launch.err.txt'), '');
    const holder = cp.spawn('sh', ['-c', 'exec 3>>"$0"; sleep 30', path.join(run, 'host-prebuilt host launch.out.txt')]);   // a log still open for writing
    try {
      const p = cp.spawnSync('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'windows', 'Test-Milestone31.ps1'), '-Mode', 'Package', '-OutRoot', out, '-NonInteractive', '-PackageRun', run], { encoding: 'utf8' });
      assert.equal(p.status, 0, p.stdout + p.stderr);
    } finally { holder.kill(); }
    const txt = fs.readFileSync(path.join(run, 'milestone3-recovery.txt'), 'utf8');
    assert.match(txt, /Unit tests: 114 passed, 1 failed, 1 skipped of 116; failed: M3 release: SHA256SUMS\.txt lists every shipped file except itself/);
    assert.match(txt, /Phase state files: none/);
    const zl = cp.spawnSync('python3', ['-I', '-c', 'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', path.join(run, 'milestone3-results.zip')], { encoding: 'utf8' });
    if (zl.status === 0) for (const f of ['unit-tests.tap', 'host-prebuilt host launch.out.txt', 'host-prebuilt host launch.err.txt', 'milestone3-recovery.txt']) assert.ok(zl.stdout.split('\n').includes(f), 'ZIP holds ' + f);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('M3.1: a results folder inside the application folder is refused (except test-results); the fallback is reported', { skip: LIVE }, () => {
  const out = tmpRoot();
  try {
    const r = cp.spawnSync('pwsh', ['-NoProfile', '-File', path.join(ROOT, 'windows', 'Test-Milestone31.ps1'), '-Mode', 'Quick', '-NonInteractive', '-OutRoot', path.join(ROOT, 'desktop'), '-Phases', 'host-start', '-StartScript', path.join(ROOT, 'tests', 'fixtures', 'm31', 'Start-FakeDesktop.ps1')],
      { encoding: 'utf8', timeout: 240000, env: { ...process.env, EIGHTMAX_NONINTERACTIVE: '1', LOCALAPPDATA: out } });
    assert.match(r.stdout, /refused .*desktop: inside the application folder/);
    assert.ok(!fs.readdirSync(path.join(ROOT, 'desktop')).some((d) => d.startsWith('Milestone3.1-')), 'nothing written into the application folder');
    const dir = fs.readdirSync(path.join(out, 'EightMax-Test-Workbench', 'TestResults')).find((d) => d.startsWith('Milestone3.1-'));
    const res = JSON.parse(fs.readFileSync(path.join(out, 'EightMax-Test-Workbench', 'TestResults', dir, 'milestone3-results.json'), 'utf8'));
    assert.ok(res.checks.some((c) => c.name === 'results folder' && c.status === 'WARNING' && /refused/.test(c.detail)));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
