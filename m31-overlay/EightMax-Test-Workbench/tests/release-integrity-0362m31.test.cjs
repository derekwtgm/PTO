'use strict';
// 0.36.2 Milestone 3.1: release integrity separates the immutable payload from runtime output (tools/release-integrity.cjs,
// release-integrity-policy.json). Reproduces the operator-PC failure of Milestone 3 ("SHA256SUMS.txt lists every shipped file except
// itself" failed on test-results/Milestone3-20261123-122544/mwcli-build-id.err.txt and .../host-prebuilt host launch.err.txt) and proves
// that genuine tampering is still detected. Every scenario runs on its own temporary copy of a small release built by the test.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..'), RI = require('../tools/release-integrity.cjs');
const POLICY = fs.readFileSync(path.join(ROOT, 'release-integrity-policy.json'));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const PAYLOAD = {
  'START.html': '<!doctype html><title>EightMax</title>',
  'desktop/bin/EightMaxWorkbench.exe': Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(4096)]),
  'desktop/bin/EightMaxInput.exe': Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(2048)]),
  'native/mwcli.exe': Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(2048)]),
  'runtime/node/node.exe': Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(2048)]),
  'windows/Start-Desktop.ps1': "$ErrorActionPreference='Stop'\r\n",
  'src/hand-state.js': "'use strict';\n",
  'docs/CHANGELOG.md': '# changelog\n',
  'RUN-0362-MILESTONE3.1-TESTS.cmd': '@echo off\r\n',
};
function makeRelease(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-m31-integrity-')), root = path.join(dir, 'EightMax Test Workbench (copy)');
  const files = { ...PAYLOAD, 'release-integrity-policy.json': POLICY, ...extra };
  for (const [rel, data] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); }
  const lines = Object.keys(files).sort().map((rel) => sha(fs.readFileSync(path.join(root, rel))) + '  ' + rel);
  fs.writeFileSync(path.join(root, 'SHA256SUMS.txt'), lines.join('\n') + '\n');
  return { dir, root, put: (rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); } };
}
const scenario = (name, fn) => test(name, () => { const r = makeRelease(); try { fn(r); } finally { fs.rmSync(r.dir, { recursive: true, force: true }); } });
const codes = (res) => res.failures.map((f) => f.code).sort();

// The operator's partial results, file for file (Milestone3-20261123-122544.zip / -124637.zip), plus the run-1 file that was still open
// (locked) when the folder was zipped and that the second run's checksum test then reported.
function operatorResults(put, run) {
  for (const f of ['mwcli-build-id.err.txt', 'unit-tests.err.txt']) put('test-results/' + run + '/' + f, '');
  put('test-results/' + run + '/mwcli-build-id.out.txt', 'EightMaxBuild=7d08acc7eb4577ee\r\n');
  put('test-results/' + run + '/unit-tests.out.txt', 'TAP version 13\n# tests 116\n# pass 114\n# fail 1\n');
  put('test-results/' + run + '/unit-tests.tap', 'TAP version 13\n# tests 116\n# pass 114\n# fail 1\n');
  fs.mkdirSync(path.join(put.root, 'test-results', run, 'host-start'), { recursive: true }); fs.mkdirSync(path.join(put.root, 'test-results', run, 'state'), { recursive: true });
}

scenario('M3.1 integrity A: a clean extracted release passes; every listed file is verified', ({ root }) => {
  const r = RI.check(root);
  assert.equal(r.ok, true, RI.summary(r)); assert.deepEqual(r.failures, []); assert.deepEqual(r.warnings, []);
  assert.equal(r.verified, r.manifest.entries); assert.equal(r.manifest.entries, Object.keys(PAYLOAD).length + 1); assert.equal(r.runtimeOutput.files, 0);
});

scenario('M3.1 integrity B: one previous test-results folder (the operator run 1 files) does not fail the check', ({ root, put }) => {
  put.root = root; operatorResults(put, 'Milestone3-20261123-122544');
  put('test-results/Milestone3-20261123-122544/host-prebuilt host launch.out.txt', ''); put('test-results/Milestone3-20261123-122544/host-prebuilt host launch.err.txt', '');
  const r = RI.check(root);
  assert.equal(r.ok, true, RI.summary(r)); assert.deepEqual(r.warnings, []);
  assert.equal(r.runtimeOutput.files, 7); assert.deepEqual(r.runtimeOutput.folders, ['test-results/Milestone3-20261123-122544']);
});

scenario('M3.1 integrity B2: several previous result folders (Milestone 2, Milestone 3 run 1 and 2, Milestone 3.1) do not fail the check', ({ root, put }) => {
  put.root = root; operatorResults(put, 'Milestone3-20261123-122544'); operatorResults(put, 'Milestone3-20261123-124637');
  put('test-results/Milestone2-20261120-101010/milestone2-results.json', '{"overall":"FAIL"}');
  put('test-results/Milestone3.1-20261124-090000-full/checks.jsonl', '{"seq":1}\n');
  put('test-results/Milestone3.1-20261124-090000-full.zip', 'PK\x03\x04');
  const r = RI.check(root);
  assert.equal(r.ok, true, RI.summary(r)); assert.equal(r.runtimeOutput.folders.length, 5); assert.equal(r.runtimeOutput.files, 13);
});

scenario('M3.1 integrity: partial output, a previous FAILED run and temporary runtime files are runtime output, not release files', ({ root, put }) => {
  const run = 'test-results/Milestone3.1-20261124-100000-quick/';
  put(run + 'run-status.json', '{"state":"running","currentPhase":"host-start"');                  // cut off mid-write
  put(run + '.run-status.json.4242.tmp', '{"state":"runn');                                         // atomic-write temp file
  put(run + 'checks.jsonl', '{"seq":1,"status":"PASS"}\n{"seq":2,"stat');                         // partial last line
  put(run + 'errors.log', 'System.TimeoutException: host start exceeded 120 s\r\n');
  put(run + 'milestone3-results.json', '{"overall":"FAIL","exitCode":1}');
  put(run + 'host-start/01-prebuilt-host-launch/session.json.1234.tmp', '');
  put(run + 'host-start/01-prebuilt-host-launch/console~.log', 'x');
  put('desktop/bin/Thumbs.db', 'thumbnail cache'); put('desktop.ini', '[.ShellClassInfo]'); put('docs/.DS_Store', 'x');
  const r = RI.check(root);
  assert.equal(r.ok, true, RI.summary(r)); assert.deepEqual(r.warnings, []);
  assert.equal(r.runtimeOutput.files, 7); assert.deepEqual(r.ignored.osMetadata.sort(), ['desktop.ini', 'desktop/bin/Thumbs.db', 'docs/.DS_Store']);
});

scenario('M3.1 integrity: a host-start fallback cache in test-results is recognised only with its matching compiler-output.sha256', ({ root, put }) => {
  const exe = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(512)]), dir = 'test-results/Milestone3-20261123-122544/host-start/cache/' + 'a'.repeat(64) + '/';
  put(dir + 'EightMaxWorkbench.exe', exe); put(dir + 'compiler-output.sha256', sha(exe)); put(dir + 'cache-manifest.json', '{}');
  let r = RI.check(root);
  assert.equal(r.ok, true); assert.deepEqual(r.runtimeOutput.knownExecutables.map((k) => k.kind), ['desktop-host-test-cache']); assert.deepEqual(r.warnings, []);
  put(dir + 'compiler-output.sha256', '0'.repeat(64));                                              // the record no longer matches
  put('test-results/somewhere/tool.exe', 'MZ');
  r = RI.check(root);
  assert.equal(r.ok, true, 'never part of the release: reported, not failed');
  assert.deepEqual(r.runtimeOutput.unrecognisedExecutables.sort(), [dir + 'EightMaxWorkbench.exe', 'test-results/somewhere/tool.exe']);
  assert.deepEqual(r.warnings.map((w) => w.code), ['runtime-output-executable', 'runtime-output-executable']);
});

scenario('M3.1 integrity C: a modified application executable is detected', ({ root }) => {
  const f = path.join(root, 'desktop/bin/EightMaxWorkbench.exe'), b = fs.readFileSync(f); b[100] ^= 0xff; fs.writeFileSync(f, b);
  const r = RI.check(root);
  assert.equal(r.ok, false); assert.deepEqual(r.modified, ['desktop/bin/EightMaxWorkbench.exe']); assert.deepEqual(codes(r), ['modified']);
});

scenario('M3.1 integrity C: an executable with one byte appended (as the Milestone 3 invalid-cache test does) is detected', ({ root }) => {
  fs.appendFileSync(path.join(root, 'native/mwcli.exe'), 'x');
  assert.deepEqual(RI.check(root).modified, ['native/mwcli.exe']);
});

scenario('M3.1 integrity C: a missing manifest-listed file is detected', ({ root }) => {
  fs.rmSync(path.join(root, 'runtime/node/node.exe'));
  const r = RI.check(root);
  assert.equal(r.ok, false); assert.deepEqual(r.missing, ['runtime/node/node.exe']); assert.deepEqual(codes(r), ['missing']);
});

scenario('M3.1 integrity C: a malicious or unexpected executable inside the protected payload is detected (any case, any program type)', ({ root, put }) => {
  put('desktop/bin/evil.exe', 'MZ'); put('windows/Extra.PS1', 'Start-Process calc'); put('src/inject.js', 'require("child_process")');
  put('native/helper.DLL', 'MZ'); put('desktop/bin/EightMaxWorkbench.exe.bak.cmd', '@echo off'); put('test-results.exe', 'MZ');
  const r = RI.check(root);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unexpectedExecutables.sort(), ['desktop/bin/EightMaxWorkbench.exe.bak.cmd', 'desktop/bin/evil.exe', 'native/helper.DLL', 'src/inject.js', 'test-results.exe', 'windows/Extra.PS1']);
  assert.ok(codes(r).every((c) => c === 'unexpected-executable'));
});

scenario('M3.1 integrity: an unexpected NON-executable file inside the payload is reported as a warning, by name', ({ root, put }) => {
  put('docs/my-notes.txt', 'operator notes'); put('reports/0.36.2-m3-gameplay-acceptance.json', '{}');
  const r = RI.check(root);
  assert.equal(r.ok, true); assert.deepEqual(r.unexpectedOther.sort(), ['docs/my-notes.txt', 'reports/0.36.2-m3-gameplay-acceptance.json']);
  assert.deepEqual(r.warnings.map((w) => w.code), ['unexpected-file', 'unexpected-file']);
});

scenario('M3.1 integrity: a manifest that is malformed, names a path outside the release or lists a file twice fails', ({ root }) => {
  const f = path.join(root, 'SHA256SUMS.txt'), good = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, good + 'not a checksum line\n' + 'a'.repeat(64) + '  ../outside.txt\n' + good.split('\n')[0] + '\n');
  const r = RI.check(root);
  assert.deepEqual(codes(r), ['manifest-duplicate', 'manifest-malformed', 'manifest-unsafe-path']);
});

scenario('M3.1 integrity: the policy is used only when SHA256SUMS.txt verifies it (a widened runtime-output list is refused)', ({ root }) => {
  const p = path.join(root, 'release-integrity-policy.json'), j = JSON.parse(fs.readFileSync(p, 'utf8'));
  j.runtimeOutputFolders.push('desktop'); fs.writeFileSync(p, JSON.stringify(j));
  fs.writeFileSync(path.join(root, 'desktop/bin/evil.exe'), 'MZ');
  const r = RI.check(root);
  assert.equal(r.ok, false); assert.deepEqual(r.modified, ['release-integrity-policy.json']); assert.equal(r.policy, undefined, 'the modified policy was not applied');
});

scenario('M3.1 integrity: links inside the payload fail and are never followed; links in the runtime output are warnings', ({ root, dir }) => {
  if (process.platform === 'win32') return; // creating symlinks needs Developer Mode or elevation on Windows
  fs.mkdirSync(path.join(dir, 'elsewhere')); fs.writeFileSync(path.join(dir, 'elsewhere', 'x.exe'), 'MZ');
  fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(root, 'desktop', 'linked'));
  fs.mkdirSync(path.join(root, 'test-results', 'r'), { recursive: true }); fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(root, 'test-results', 'r', 'linked'));
  const r = RI.check(root);
  assert.deepEqual(r.payloadLinks, ['desktop/linked']); assert.deepEqual(r.runtimeOutput.links, ['test-results/r/linked']);
  assert.deepEqual(codes(r), ['payload-link']); assert.deepEqual(r.unexpectedExecutables, [], 'the link target was not scanned');
});

test('M3.1 integrity: this release passes, including when the operator\'s Milestone 3 result folders exist in test-results', (t) => {
  const r = RI.check(ROOT);
  for (const w of r.warnings) t.diagnostic('warning: ' + w.message);
  assert.deepEqual(r.failures, [], RI.summary(r)); assert.ok(r.manifest.entries > 1000); assert.equal(r.verified, r.manifest.entries);
  assert.deepEqual(RI.parseManifest(fs.readFileSync(path.join(ROOT, 'SHA256SUMS.txt'), 'utf8')).entries.filter((e) => /^test-results\//.test(e.path)), [], 'no runtime output is ever listed');
});

test('M3.1 integrity: the command-line tool exits 0 for a clean release and 1 for a tampered one, and writes its JSON', () => {
  const cp = require('node:child_process'), r = makeRelease();
  try {
    const out = path.join(r.dir, 'r.json');
    let p = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools/release-integrity.cjs'), '--root', r.root, '--json', out], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stdout + p.stderr); assert.match(p.stdout, /^PASS: /); assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).ok, true);
    r.put('desktop/bin/evil.exe', 'MZ');
    p = cp.spawnSync(process.execPath, [path.join(ROOT, 'tools/release-integrity.cjs'), '--root', r.root], { encoding: 'utf8' });
    assert.equal(p.status, 1); assert.match(p.stdout, /FAIL {4}executable or script not in the release manifest: desktop\/bin\/evil\.exe/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});
