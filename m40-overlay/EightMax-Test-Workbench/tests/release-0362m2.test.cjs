'use strict';
// 0.36.2 Milestone 2 release consistency: what the milestone promises about unchanged binaries, the rebuilt dashboard and the new
// Windows test runner is checked from the shipped files (not from the report text).
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.join(__dirname, '..'), read = (f) => fs.readFileSync(path.join(root, f), 'utf8'), sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
const m1 = JSON.parse(read('release-0362.json')), m2 = JSON.parse(read('release-0362-m2.json')), ev = JSON.parse(read('evidence/build-evidence.json'));
test('M2 release: EightMax 5.1 is byte-identical (build 7d08acc7eb4577ee)', () => {
  assert.equal(sha('native/mwcli.exe'), 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72'); assert.equal(m2.nativeEngine.build, '7d08acc7eb4577ee'); assert.equal(m2.nativeEngine.changed, false);
});
test('M2 release: every Windows executable is the Windows-built Milestone 1 binary and its C# sources are unchanged', () => {
  assert.equal(m2.windowsBinariesRebuilt, false);
  // 0.36.2 M3: an executable that a LATER milestone rebuilt on Windows (release-0362-m3.json rebuiltExecutables, with its CI build record)
  // is checked by that milestone's release test; every other executable must still be the Milestone 1 binary
  // 0.36.2 M4.0: rebuilds of a later milestone (release-chain.cjs) count as well; the Milestone 3 entry stays the one for the input driver
  const later = { ...require('./release-chain.cjs').laterRebuilds('release-0362-m32.json'), ...(fs.existsSync(path.join(root, 'release-0362-m3.json')) ? JSON.parse(read('release-0362-m3.json')).rebuiltExecutables || {} : {}) };
  for (const [f, v] of Object.entries(m1.executables)) { assert.equal(m2.executables[f].sha256, v.sha256); if (later[f]) { assert.equal(later[f].replaces, v.sha256, f + ': the later rebuild replaced the Milestone 1 binary'); continue; } assert.equal(sha(f), v.sha256, f + ' unchanged'); }
  for (const [exe, o] of Object.entries(ev.outputs)) { assert.equal(sha(exe), o.sha256, exe); for (const [s, h] of Object.entries(o.sourceHashes || {})) assert.equal(sha(s), h, s + ' is the source the Windows build compiled'); }
  const bc = JSON.parse(read('evidence/0.36.2-m2/build-check.json')); assert.equal(bc.ok, true); assert.equal(bc.shippedBinariesRebuilt, false);
});
test('M2 release: the dashboard loads the lifecycle module and START.html was rebuilt from the current sources', () => {
  const d = read('dashboard.html'); assert.ok(d.indexOf('src/window-lifecycle.js') > 0 && d.indexOf('src/window-lifecycle.js') < d.indexOf('src/simulator-controls.js'));
  const s = read('START.html'); for (const f of ['window-lifecycle.js', 'simulator-controls.js', 'simulator-controls-ui.js', 'input-scheduler.js', 'execution-adapters.js', 'windows-input-driver.js']) assert.ok(s.includes(read('src/' + f).replace(/<\/script/g, '<\\/script')), 'START.html embeds the current src/' + f);
  for (const id of ['simc-refresh-registrations', 'simc-review-replacement', 'simc-export-report', 'simc-recovery-list', 'simc-lifecycle-summary']) assert.match(s, new RegExp('id="' + id + '"'));
});
test('M2 release: the Windows test runner, its instructions and the acceptance tool are shipped and wired together', () => {
  assert.match(read('RUN-0362-MILESTONE2-TESTS.cmd'), /windows\\Test-Milestone2-0362\.ps1/); const ps = read('windows/Test-Milestone2-0362.ps1');
  assert.match(ps, /lifecycle-acceptance-0362m2\.cjs/); assert.match(ps, /runtime\\node\\node\.exe/); assert.match(ps, /milestone2-results\.json/); assert.match(ps, /Compress-Archive/);
  assert.ok(/^[\x00-\x7f]*$/.test(ps), 'ASCII only (Windows PowerShell 5.1 reads BOM-less scripts as ANSI)');
  const readme = read('READ-ME-MILESTONE2-TESTS.txt'); assert.match(readme, /test-results\\Milestone2-/); assert.match(readme, /RUN-0362-MILESTONE2-TESTS\.cmd/);
  assert.ok(fs.existsSync(path.join(root, 'tools/lifecycle-acceptance-0362m2.cjs'))); assert.ok(fs.existsSync(path.join(root, 'REPORT-0.36.2-Milestone-2.md')));
  assert.match(read('REPORT-0.36.2-Milestone-2.md'), /7d08acc7eb4577ee/);
});
