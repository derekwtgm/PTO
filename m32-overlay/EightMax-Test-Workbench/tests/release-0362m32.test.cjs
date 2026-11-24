'use strict';
// 0.36.2 Milestone 3.2: release record, the standalone T5 launcher and runner mode, and the repaired window-loss handling (the reproduction
// of the operator's T5 failure, run on THIS tree). The executables and the EightMax 5.1 engine must be byte-identical to Milestone 3.1.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), crypto = require('crypto'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..'), read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'), sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex');
const LC = require('../src/window-lifecycle.js'), SCH = require('../src/input-scheduler.js');
const MWCLI = 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72';
const ascii = (f) => [...fs.readFileSync(path.join(ROOT, f))].every((c) => c < 128);

test('M3.2 release record: every executable byte-identical to Milestone 3.1; the EightMax 5.1 engine unchanged', () => {
  const r = JSON.parse(read('release-0362-m32.json')), r31 = JSON.parse(read('release-0362-m31.json'));
  assert.equal(r.windowsBinariesRebuilt, false); assert.equal(r.nativeEngine.sha256, MWCLI); assert.equal(r.nativeEngine.build, '7d08acc7eb4577ee'); assert.equal(r.nativeEngine.changed, false);
  assert.deepEqual(Object.keys(r.executables).sort(), Object.keys(r31.executables).sort());
  for (const [k, v] of Object.entries(r.executables)) { assert.equal(v.sha256, r31.executables[k].sha256, k + ' as in Milestone 3.1'); assert.equal(sha(k), v.sha256, k + ' on disk'); }
  assert.equal(sha('native/mwcli.exe'), MWCLI);
  for (const f of r.newFiles) if (!f.includes(' ')) assert.ok(fs.existsSync(path.join(ROOT, f)), 'new file present: ' + f);
});

test('M3.2 launcher RUN-M3.2-T5-TEST.cmd: CRLF, ASCII, no BOM; starts the runner in mode T5; checks its files first; always ends with a pause', () => {
  const b = fs.readFileSync(path.join(ROOT, 'RUN-M3.2-T5-TEST.cmd')), t = b.toString('latin1');
  assert.equal(t.slice(0, 9), '@echo off', 'no BOM before @echo off'); assert.ok(ascii('RUN-M3.2-T5-TEST.cmd'), 'ASCII only'); assert.ok(!/[^\r]\n/.test(t), 'CRLF line ends only');
  assert.match(t, /set "EM_MODE=T5"/); assert.match(t, /Test-Milestone31\.ps1" -Mode %EM_MODE% -T5Repeat %EM_REPEAT%/);
  for (const f of ['windows\\M32-T5.ps1', 'windows\\Test-Milestone31.ps1', 'tools\\gameplay-acceptance-0362m3.cjs', 'tools\\test-table-035.cjs', 'desktop\\bin\\EightMaxTestTable.exe', 'runtime\\node\\node.exe']) assert.ok(t.includes('"' + f + '"'), 'checks ' + f);
  assert.match(t, /:finish\r\necho\(\r\nif defined EM_INTERACTIVE pause\r\nendlocal & exit \/b %EM_RC%/, 'never closes without a pause');
  assert.match(t, /launcher-failure-/, 'a launcher failure leaves a file and a ZIP');
  const rr = fs.readFileSync(path.join(ROOT, 'READ-ME-MILESTONE3.2-TESTS.txt'), 'latin1'); assert.ok(!/[^\r]\n/.test(rr)); assert.ok(ascii('READ-ME-MILESTONE3.2-TESTS.txt'));
  for (const k of ['RUN-M3.2-T5-TEST.cmd', 'milestone3-results.zip', 'T5-SUMMARY.txt', 'EIGHTMAX_T5_REPEAT', 'Ctrl+Alt+F12']) assert.ok(rr.includes(k), k);
});

test('M3.2 runner: mode T5 = environment, integrity, dependencies, Milestone 3.2 tests, host, T5/T5P, cleanup; Milestone3.2-T5 result folders', () => {
  const r = read('windows/Test-Milestone31.ps1'), lib = read('windows/M31-Lib.ps1'), sum = read('windows/M32-T5.ps1');
  assert.match(r, /'T5' \{ @\('environment', 'integrity', 'dependencies', 'unit', 'host-start', 't5', 'cleanup'\) \}/);
  assert.match(r, /\$script:M31RunPrefix = 'Milestone3\.2-T5'/); assert.match(r, /--suite t5 --repeat ' \+ \$T5Repeat/); assert.match(r, /-PerCheck/);
  assert.match(r, /elseif \(\$Mode -eq 'Quick' -or \$Mode -eq 'T5'\) \{ \$only = @\('prebuilt'\) \}/, 'host start: prebuilt host + input driver + shutdown only');
  assert.match(r, /'tests\\paused-window-0362m32\.test\.cjs'/); assert.match(r, /'release-0362-m32\.json', 'release-0362-m31\.json'/);
  assert.match(lib, /Milestone3\\\.2-T5-\|Milestone3\\\.1-/, 'option D finds the T5 runs'); assert.match(lib, /\$base = \$script:M31RunPrefix \+ '-'/);
  assert.match(sum, /function Write-M32T5Summary/);
  for (const f of ['windows/Test-Milestone31.ps1', 'windows/M31-Lib.ps1', 'windows/M32-T5.ps1', 'tests/windows/M32-Display.ps1']) assert.ok(ascii(f), f + ' is ASCII (Windows PowerShell 5.1 reads a script without BOM in the ANSI code page)');
});

test('M3.2 repair: the reproduction of the operator T5 failure reports REPAIRED on this tree (paused table, closed window, scheduler)', () => {
  const out = path.join(os.tmpdir(), 'em-m32-repro-' + process.pid + '-' + Date.now() + '.json');
  const p = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools', 'repro-paused-target-lost-0362m32.cjs'), '--root', ROOT, '--out', out, '--wait-ms', '6000'], { encoding: 'utf8', timeout: 120000 });
  assert.equal(p.status, 0, p.stderr); const r = JSON.parse(fs.readFileSync(out, 'utf8')); try { fs.unlinkSync(out); } catch (e) { /* temp */ }
  assert.match(r.verdict, /^REPAIRED/, r.verdict); assert.ok(r.t5Checks.every((c) => c.pass), JSON.stringify(r.t5Checks));
  assert.equal(r.beforeClose.t2Lifecycle, 'SAFETY_PAUSED', 'the table was paused by the action its table did not apply'); assert.equal(r.afterClose.t2LostSource, 'health-monitor');
  assert.ok(r.afterClose.detectMs !== null && r.afterClose.detectMs < 3000, 'detected while paused within the probe interval: ' + r.afterClose.detectMs + ' ms');
  assert.equal(r.afterClose.inputsToTable2AfterClose, 0); assert.ok(r.afterClose.table1.confirmedAfterClose >= 3 || r.afterClose.table1.completed);
});

test('M3.2 modules: health monitor and registration-aware scheduler exported; the standalone dashboard page embeds the current sources', () => {
  assert.equal(typeof LC.WindowHealthMonitor, 'function'); const s = new SCH.InputScheduler(); assert.equal(typeof s.registerTable, 'function'); assert.ok('revokedRegistrations' in s.status());
  const html = read('START.html'); assert.ok(html.includes('class WindowHealthMonitor'), 'START.html embeds window-lifecycle.js of Milestone 3.2'); assert.ok(html.includes('registerTable(table, registrationId) {'), 'and input-scheduler.js');
  assert.ok(html.includes('_recordUnconfirmed('), 'and simulator-controls.js');
});
