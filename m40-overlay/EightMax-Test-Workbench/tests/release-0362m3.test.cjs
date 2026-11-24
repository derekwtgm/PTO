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
test('M3 release: every Windows executable is a Windows build of the shipped C# sources; only the input driver was rebuilt (Driver.cs changed)', () => {
  // Milestone 3 changes one C# source, desktop/input/Driver.cs; EightMaxInput.exe was rebuilt ON WINDOWS by the CI build job and its
  // record names that run, the compiler and the exact sources. Every other executable is the unchanged Windows-built Milestone 1 binary.
  const EXE = 'desktop/bin/EightMaxInput.exe', rb = m3.rebuiltExecutables || {};
  assert.equal(m3.windowsBinariesRebuilt, true); assert.deepEqual(Object.keys(rb), [EXE]);
  const L = require('./release-chain.cjs').laterRebuilds('release-0362-m32.json');   // 0.36.2 M4.0: rebuilt after Milestone 3.2
  for (const [f, v] of Object.entries(m1.executables)) {
    // a later milestone that rebuilt this executable must have replaced exactly the binary Milestone 3 shipped; that milestone checks the file
    if (L[f]) { assert.equal(L[f].replaces, f === EXE ? rb[f].sha256 : v.sha256, f + ': the later rebuild (' + L[f].milestone + ') replaced the Milestone 3 binary'); assert.equal(m3.executables[f].sha256, L[f].replaces); continue; }
    assert.equal(m3.executables[f].sha256, sha(f), f + ' recorded in release-0362-m3.json');
    if (f !== EXE) { assert.equal(sha(f), v.sha256, f + ' unchanged since Milestone 1'); continue; }
    assert.notEqual(sha(f), v.sha256, 'the input driver is the rebuilt one'); assert.equal(rb[f].replaces, v.sha256); assert.equal(rb[f].sha256, sha(f));
    const e = ev.outputs[f]; assert.equal(e.sha256, sha(f)); assert.equal(e.crossCompiled, false); assert.match(e.compiler, /Visual C# Compiler version 4\.8/); assert.match(e.compiler, /\/define:UIA/);
    assert.equal(e.rebuiltIn.milestone, '0.36.2-milestone-3'); assert.match(String(e.rebuiltIn.ci.runId), /^\d+$/); assert.equal(Number(e.rebuiltIn.ci.runId), rb[f].ciRun); assert.match(e.rebuiltIn.buildHost, /^Windows/);
    assert.deepEqual(Object.keys(e.sourceHashes).sort(), fs.readdirSync(path.join(root, 'desktop/input')).filter((x) => x.endsWith('.cs')).map((x) => 'desktop/input/' + x).sort(), 'built from every input-driver source');
    const raw = JSON.parse(read('evidence/0.36.2-m3/driver-build/driver-build.json')); assert.equal(raw.sha256, sha(f)); assert.equal(String(raw.ci.runId), String(rb[f].ciRun));
  }
  for (const [exe, o] of Object.entries(ev.outputs)) { assert.equal(sha(exe), o.sha256, exe); for (const [s, h] of Object.entries(o.sourceHashes || {})) assert.equal(sha(s), h, s + ' is the source the Windows build compiled'); }
  if (fs.existsSync(path.join(root, 'evidence/0.36.2-m3/build-check.json'))) { const bc = JSON.parse(read('evidence/0.36.2-m3/build-check.json')); assert.equal(bc.ok, true); assert.deepEqual(bc.shippedBinariesRebuilt, [EXE]); assert.equal(bc.fallbackCompile.ok, true); }
});
test('M3 release: START.html embeds the current tracker, ledger, controls and dashboard sources', () => {
  const s = read('START.html');
  for (const f of ['hand-ledger.js', 'hand-state.js', 'simulator-controls.js', 'simulator-controls-ui.js', 'window-lifecycle.js', 'execution-adapters.js', 'fixture-dealer.js']) assert.ok(s.includes(read('src/' + f).replace(/<\/script/g, '<\\/script')), 'START.html embeds the current src/' + f);
});
test('M3 release: the Windows runner, its instructions, the acceptance tools and the CI workflow are shipped and wired together', () => {
  // 0.36.2 Milestone 3.1: the Milestone 3 launcher and runner script are kept for compatibility and forward to the Milestone 3.1 runner
  // (windows/Test-Milestone31.ps1 with the M31-*.ps1 library), which keeps every Milestone 3 phase. Its results no longer go to
  // test-results\Milestone3-<date> inside the application folder (the operator-PC checksum failure) but to %LOCALAPPDATA%.
  assert.match(read('RUN-0362-MILESTONE3-TESTS.cmd'), /RUN-0362-MILESTONE3\.1-TESTS\.cmd" C/);
  assert.match(read('RUN-0362-MILESTONE3.1-TESTS.cmd'), /windows\\Test-Milestone31\.ps1/);
  assert.match(read('windows/Test-Milestone3-0362.ps1'), /Test-Milestone31\.ps1/); assert.match(read('windows/Test-Milestone3-0362.ps1'), /Mode = 'Full'/);
  const ps = ['windows/Test-Milestone31.ps1', 'windows/M31-Lib.ps1', 'windows/M31-HostStart.ps1', 'windows/M31-Integrity.ps1', 'windows/Test-Milestone3-0362.ps1'].map(read);
  const all = ps.join('\n');
  for (const re of [/gameplay-acceptance-0362m3\.cjs/, /lifecycle-acceptance-0362m2\.cjs/, /exit-audit-0362m3\.cjs/, /Start-Desktop\.ps1/, /runtime\\node\\node\.exe/, /milestone3-results\.json/, /milestone3-results\.zip/, /Compress-Archive/, /EightMax-Test-Workbench\\TestResults/]) assert.match(all, re);
  assert.doesNotMatch(all, /Join-Path \$root \('test-results\\Milestone3-/, 'results are never written into the application folder by default');
  for (const t of ps) { assert.ok(/^[\x00-\x7f]*$/.test(t), 'ASCII only (Windows PowerShell 5.1 reads BOM-less scripts as ANSI)'); assert.ok(!/\[pscustomobject\]/i.test(t), 'no PSCustomObject records'); }
  const readme = read('READ-ME-MILESTONE3-TESTS.txt'); assert.match(readme, /READ-ME-MILESTONE-3\.1\.txt/); assert.match(readme, /RUN-0362-MILESTONE3-TESTS\.cmd/); assert.ok(/^[\x00-\x7f]*$/.test(readme));
  const wf = read('.github/workflows/windows-0362-m3.yml'); assert.match(wf, /windows-latest/); assert.match(wf, /Test-Milestone3-0362\.ps1/);
  for (const f of m3.deliverables || []) assert.ok(fs.existsSync(path.join(root, f)), 'deliverable present: ' + f);
});
test('M3 release: SHA256SUMS.txt lists every shipped file except itself', (t) => {
  // 0.36.2 Milestone 3.1: this test walked the WHOLE folder, and the Milestone 3 runner wrote its logs into test-results\ inside it before
  // the unit tests ran, so it failed on the operator's PC on the runner's own output (test-results/Milestone3-20261123-122544/
  // mwcli-build-id.err.txt; on the second run .../host-prebuilt host launch.err.txt). The immutable payload is now defined by
  // release-integrity-policy.json: runtime output (test-results\) is never part of it; every listed file must exist and keep its SHA-256;
  // an unlisted executable or script anywhere in the payload still fails; other unlisted files are reported by name.
  const RI = require('../tools/release-integrity.cjs'), r = RI.check(root);
  for (const w of r.warnings) t.diagnostic('warning: ' + w.message);
  assert.deepEqual(r.failures.map((f) => f.message), [], RI.summary(r));
  assert.equal(r.verified, r.manifest.entries, 'every listed file verified');
  const listed = new Set(RI.parseManifest(read('SHA256SUMS.txt')).entries.map((e) => e.path));
  assert.ok(listed.has('release-0362-m3.json') && listed.has('windows/Test-Milestone3-0362.ps1') && listed.has('release-integrity-policy.json'));
});
