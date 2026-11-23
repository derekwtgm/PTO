'use strict';
// 0.36.2 Milestone 3 release consistency: what the milestone promises (unchanged native engine and Windows binaries, rebuilt dashboard,
// repaired launcher, the Windows runner and its instructions wired together, the deliverables present) is checked from the shipped files.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = path.join(__dirname, '..'), read = (f) => fs.readFileSync(path.join(root, f), 'utf8'), sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex');
const m1 = JSON.parse(read('release-0362.json')), m3 = JSON.parse(read('release-0362-m3.json')), ev = JSON.parse(read('evidence/build-evidence.json'));

test('M3 release: EightMax 5.1 is byte-identical (build 7d08acc7eb4577ee); strict mode keeps refusing without a compatible study', () => {
  assert.equal(sha('native/mwcli.exe'), 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72'); assert.equal(m3.nativeEngine.build, '7d08acc7eb4577ee'); assert.equal(m3.nativeEngine.changed, false);
  // every native/ and vendor/ file (solver, sources, EightMax 5.1 libraries) is byte-identical to Milestone 2
  const kept = Object.entries(m3.preservedFromMilestone2 || {}); assert.ok(kept.length > 20, 'preserved file list recorded');
  for (const [f, h] of kept) assert.equal(sha(f), h, f + ' unchanged since Milestone 2');
  assert.match(read('src/simulator-controls.js'), /if \(!this\.allowScripted\) return null;/, 'no scripted substitute unless explicitly allowed');
});
test('M3 release: every Windows executable is the Windows-built binary and its C# sources are the ones that build compiled (no C# changed)', () => {
  assert.equal(m3.windowsBinariesRebuilt, false);
  for (const [f, v] of Object.entries(m1.executables)) { assert.equal(sha(f), v.sha256, f + ' unchanged'); assert.equal(m3.executables[f].sha256, v.sha256); }
  for (const [exe, o] of Object.entries(ev.outputs)) { assert.equal(sha(exe), o.sha256, exe); for (const [s, h] of Object.entries(o.sourceHashes || {})) assert.equal(sha(s), h, s + ' is the source the Windows build compiled'); }
  if (fs.existsSync(path.join(root, 'evidence/0.36.2-m3/build-check.json'))) { const bc = JSON.parse(read('evidence/0.36.2-m3/build-check.json')); assert.equal(bc.ok, true); assert.equal(bc.shippedBinariesRebuilt, false); assert.equal(bc.fallbackCompile.ok, true); }
});
test('M3 release: START.html embeds the current tracker, ledger, controls and dashboard sources', () => {
  const s = read('START.html');
  for (const f of ['hand-ledger.js', 'hand-state.js', 'simulator-controls.js', 'simulator-controls-ui.js', 'window-lifecycle.js', 'execution-adapters.js', 'fixture-dealer.js']) assert.ok(s.includes(read('src/' + f).replace(/<\/script/g, '<\\/script')), 'START.html embeds the current src/' + f);
});
test('M3 release: the Windows runner, its instructions, the acceptance tools and the CI workflow are shipped and wired together', () => {
  assert.match(read('RUN-0362-MILESTONE3-TESTS.cmd'), /windows\\Test-Milestone3-0362\.ps1/);
  const ps = read('windows/Test-Milestone3-0362.ps1');
  for (const re of [/gameplay-acceptance-0362m3\.cjs/, /lifecycle-acceptance-0362m2\.cjs/, /exit-audit-0362m3\.cjs/, /Start-Desktop\.ps1/, /runtime\\node\\node\.exe/, /milestone3-results\.json/, /Compress-Archive/, /test-results\\Milestone3-/]) assert.match(ps, re);
  assert.ok(/^[\x00-\x7f]*$/.test(ps), 'ASCII only (Windows PowerShell 5.1 reads BOM-less scripts as ANSI)');
  assert.ok(!/\[pscustomobject\]/i.test(ps), 'no PSCustomObject records (JavaScriptSerializer cannot serialise them on PowerShell 5.1: the Milestone 2 runner crash)');
  const readme = read('READ-ME-MILESTONE3-TESTS.txt'); assert.match(readme, /test-results\\Milestone3-/); assert.match(readme, /RUN-0362-MILESTONE3-TESTS\.cmd/); assert.ok(/^[\x00-\x7f]*$/.test(readme));
  const wf = read('.github/workflows/windows-0362-m3.yml'); assert.match(wf, /windows-latest/); assert.match(wf, /Test-Milestone3-0362\.ps1/);
  for (const f of m3.deliverables || []) assert.ok(fs.existsSync(path.join(root, f)), 'deliverable present: ' + f);
});
test('M3 release: SHA256SUMS.txt lists every shipped file except itself', () => {
  const lines = read('SHA256SUMS.txt').trim().split('\n'), listed = new Set(lines.map((l) => l.replace(/^[0-9a-f]{64} {2}/, '')));
  const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.name === '.git' && !d ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name).split(path.sep).join('/')]));
  const files = walk('').filter((f) => f !== 'SHA256SUMS.txt');
  for (const f of files) assert.ok(listed.has(f), 'listed in SHA256SUMS.txt: ' + f);
  assert.ok(listed.has('release-0362-m3.json') && listed.has('windows/Test-Milestone3-0362.ps1'));
});
