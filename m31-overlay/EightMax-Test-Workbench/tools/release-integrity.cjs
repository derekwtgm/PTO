#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 3.1 - RELEASE INTEGRITY with a defined immutable payload.
 *
 * Milestone 3 defect (operator PC, both runs): tests/release-0362m3.test.cjs walked the WHOLE application folder and required every file
 * to be listed in SHA256SUMS.txt, while windows\Test-Milestone3-0362.ps1 wrote its logs into test-results\ inside that same folder before
 * the unit tests ran. The test therefore always failed on the operator's PC ("listed in SHA256SUMS.txt: test-results/Milestone3-.../
 * mwcli-build-id.err.txt"); CI passed only because CI moved the results outside the folder with -OutDir.
 *
 * The rules (release-integrity-policy.json, itself verified against SHA256SUMS.txt before it is used):
 *   FAIL     a listed file is missing or its SHA-256 differs; the manifest is malformed or names a path outside the folder; an executable
 *            or script that SHA256SUMS.txt does not list lies inside the payload; a link (symlink / junction) lies inside the payload
 *   WARNING  another unlisted file inside the payload (reported by name); an unrecognised executable in the runtime output folder; a link
 *            in the runtime output folder
 *   IGNORED  runtime output (test-results\ - counted, never required in the manifest), operating-system metadata (Thumbs.db, desktop.ini,
 *            .DS_Store ...), development metadata (.git)
 * The runtime output folder is never part of the payload, so old test logs, partial output, failed runs and temporary files there can
 * never fail the check, while a changed, missing or added program file anywhere in the release still does.
 *
 *   node tools/release-integrity.cjs [--root DIR] [--json FILE]      exit 0: no failure (warnings allowed), 1: failures, 2: cannot check
 */
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const POLICY_FILE = 'release-integrity-policy.json';
const WIN = process.platform === 'win32';
const norm = (p) => (WIN ? p.toLowerCase() : p);

function sha256File(file) {
  const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.allocUnsafe(1 << 20);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(n === buf.length ? buf : buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

/** Parse SHA256SUMS.txt ("<64 hex>  <relative/posix/path>"); unsafe or malformed lines are reported, never followed. */
function parseManifest(text) {
  const entries = [], malformed = [], unsafe = [], duplicates = [], seen = new Set();
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) { malformed.push({ line: i + 1, text: line.slice(0, 200) }); return; }
    const rel = m[2];
    if (rel.includes('\\') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').some((s) => s === '..' || s === '.' || s === '') || /[\0-\x1f]/.test(rel)) { unsafe.push({ line: i + 1, path: rel }); return; }
    if (seen.has(norm(rel))) { duplicates.push(rel); return; }
    seen.add(norm(rel)); entries.push({ sha256: m[1], path: rel });
  });
  return { entries, malformed, unsafe, duplicates };
}

/** Every file below root as a relative POSIX path. Links are reported and never followed. */
function walk(root) {
  const files = [], links = [], unreadable = [];
  const visit = (rel) => {
    let list;
    try { list = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { unreadable.push({ path: rel || '.', error: e.code || e.message }); return; }
    for (const e of list) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) links.push(r);
      else if (e.isDirectory()) visit(r);
      else if (e.isFile()) files.push(r);
      else links.push(r); // sockets, devices ... (never in a release)
    }
  };
  visit('');
  return { files, links, unreadable };
}

function loadPolicy(root) { return JSON.parse(fs.readFileSync(path.join(root, POLICY_FILE), 'utf8')); }

/** Where a relative path belongs: 'development' | 'os-metadata' | 'runtime-output' | 'payload'. */
function classify(rel, policy) {
  const parts = rel.split('/'), top = norm(parts[0]), name = parts[parts.length - 1];
  if ((policy.developmentMetadataFolders || []).some((d) => norm(d) === top)) return 'development';   // .git folder, or a worktree's .git file
  if ((policy.operatingSystemMetadataFiles || []).some((f) => norm(f) === norm(name))) return 'os-metadata';
  if ((policy.runtimeOutputFolders || []).some((d) => norm(d) === top) && parts.length > 1) return 'runtime-output';
  return 'payload';
}

function isExecutable(rel, policy) {
  const ext = path.posix.extname(rel).toLowerCase();
  return !!ext && (policy.executableExtensions || []).includes(ext);
}

/** Known runtime executables (e.g. the host-start fallback cache) are recognised only when their own verification file matches. */
function knownRuntimeExecutable(root, rel, policy) {
  for (const k of policy.knownRuntimeExecutables || []) {
    if (!new RegExp(k.pattern, WIN ? 'i' : '').test(rel)) continue;
    try {
      const want = fs.readFileSync(path.join(root, path.posix.dirname(rel), k.verifiedBy), 'utf8').trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(want) && want === sha256File(path.join(root, rel))) return k.id;
    } catch (e) { /* not verifiable -> unrecognised */ }
  }
  return null;
}

/**
 * Check a release folder. Returns { ok, failures[], warnings[], ... } - ok means "no failure" (warnings allowed).
 * options.verifyHashes (default true): hash every listed file. options.policy: use this policy object (tests).
 */
function check(root, options = {}) {
  root = path.resolve(root);
  const res = {
    format: 'eightmax-release-integrity', version: 1, root, checkedAt: new Date().toISOString(), ok: false,
    manifest: { file: 'SHA256SUMS.txt', entries: 0, malformed: [], unsafe: [], duplicates: [] },
    verified: 0, missing: [], modified: [], unexpectedExecutables: [], unexpectedOther: [], payloadLinks: [],
    runtimeOutput: { folders: [], files: 0, knownExecutables: [], unrecognisedExecutables: [], links: [] },
    ignored: { osMetadata: [], development: 0 }, unreadable: [], failures: [], warnings: [],
  };
  const fail = (code, message) => res.failures.push({ code, message }), warn = (code, message) => res.warnings.push({ code, message });
  let text;
  try { text = fs.readFileSync(path.join(root, 'SHA256SUMS.txt'), 'utf8'); } catch (e) { fail('manifest-missing', 'SHA256SUMS.txt is missing or unreadable: extract the complete ZIP again'); return res; }
  const m = parseManifest(text);
  Object.assign(res.manifest, { entries: m.entries.length, malformed: m.malformed, unsafe: m.unsafe, duplicates: m.duplicates });
  if (!m.entries.length) fail('manifest-empty', 'SHA256SUMS.txt lists no release files');
  for (const x of m.malformed) fail('manifest-malformed', 'SHA256SUMS.txt line ' + x.line + ' is not "<sha256>  <path>"');
  for (const x of m.unsafe) fail('manifest-unsafe-path', 'SHA256SUMS.txt line ' + x.line + ' names a path outside the release: ' + x.path);
  for (const x of m.duplicates) fail('manifest-duplicate', 'SHA256SUMS.txt lists ' + x + ' twice');
  const listed = new Map(m.entries.map((e) => [norm(e.path), e]));

  // 1. every listed file exists and keeps its SHA-256 (the policy file itself is one of them)
  for (const e of m.entries) {
    const full = path.join(root, ...e.path.split('/'));
    let st; try { st = fs.lstatSync(full); } catch (err) { res.missing.push(e.path); fail('missing', e.path + ' is listed in SHA256SUMS.txt but missing'); continue; }
    if (!st.isFile()) { res.missing.push(e.path); fail('missing', e.path + ' is listed in SHA256SUMS.txt but is not a regular file'); continue; }
    if (options.verifyHashes === false) continue;
    let h; try { h = sha256File(full); } catch (err) { res.unreadable.push({ path: e.path, error: err.code || err.message }); fail('unreadable', e.path + ' cannot be read: ' + (err.code || err.message)); continue; }
    if (h !== e.sha256) { res.modified.push(e.path); fail('modified', e.path + ' differs from its release checksum'); } else res.verified++;
  }
  // 2. the policy is trusted only when SHA256SUMS.txt lists it and it is unmodified
  let policy = options.policy;
  if (!policy) {
    const pe = listed.get(norm(POLICY_FILE));
    if (!pe) { fail('policy-unlisted', POLICY_FILE + ' is not listed in SHA256SUMS.txt'); return finish(res); }
    if (res.missing.includes(pe.path) || res.modified.includes(pe.path)) return finish(res);
    try { policy = loadPolicy(root); } catch (e) { fail('policy-unreadable', POLICY_FILE + ' cannot be parsed: ' + e.message); return finish(res); }
  }
  res.policy = { file: POLICY_FILE, version: policy.version, runtimeOutputFolders: policy.runtimeOutputFolders };
  // 3. everything on disk is classified; unlisted payload files are found
  const w = walk(root); res.unreadable.push(...w.unreadable);
  for (const u of w.unreadable) fail('unreadable-folder', 'folder ' + u.path + ' cannot be listed: ' + u.error);
  const folders = new Set();
  for (const rel of w.files) {
    if (norm(rel) === norm('SHA256SUMS.txt')) continue;
    const c = classify(rel, policy);
    if (c === 'development') { res.ignored.development++; continue; }
    if (c === 'os-metadata') { res.ignored.osMetadata.push(rel); continue; }
    if (c === 'runtime-output') {
      res.runtimeOutput.files++; folders.add(rel.split('/').slice(0, 2).join('/'));
      if (isExecutable(rel, policy)) {
        const k = knownRuntimeExecutable(root, rel, policy);
        if (k) res.runtimeOutput.knownExecutables.push({ path: rel, kind: k });
        else { res.runtimeOutput.unrecognisedExecutables.push(rel); warn('runtime-output-executable', 'unrecognised executable in the runtime output folder (not part of the release, never run by it): ' + rel); }
      }
      continue;
    }
    if (listed.has(norm(rel))) continue;
    if (isExecutable(rel, policy)) { res.unexpectedExecutables.push(rel); fail('unexpected-executable', 'executable or script not in the release manifest: ' + rel); }
    else { res.unexpectedOther.push(rel); warn('unexpected-file', 'file not in the release manifest (not an executable): ' + rel); }
  }
  for (const rel of w.links) {
    const c = classify(rel, policy);
    if (c === 'development' || c === 'os-metadata') continue;
    if (c === 'runtime-output') { res.runtimeOutput.links.push(rel); warn('runtime-output-link', 'link in the runtime output folder (not followed): ' + rel); }
    else { res.payloadLinks.push(rel); fail('payload-link', 'link inside the release payload (not followed): ' + rel); }
  }
  res.runtimeOutput.folders = [...folders].sort();
  return finish(res);
}
function finish(res) { res.ok = res.failures.length === 0; return res; }

function summary(r) {
  return (r.ok ? 'PASS' : 'FAIL') + ': ' + r.verified + ' of ' + r.manifest.entries + ' listed files verified; missing ' + r.missing.length + ', modified ' + r.modified.length +
    ', unexpected executables ' + r.unexpectedExecutables.length + ', other unlisted files ' + r.unexpectedOther.length + '; runtime output ignored: ' + r.runtimeOutput.files +
    ' file(s) in ' + r.runtimeOutput.folders.length + ' folder(s); warnings ' + r.warnings.length;
}

module.exports = { POLICY_FILE, parseManifest, walk, classify, isExecutable, check, summary, sha256File, loadPolicy };

if (require.main === module) {
  const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
  const root = path.resolve(arg('root', path.join(__dirname, '..'))), out = arg('json', '');
  let r;
  try { r = check(root); } catch (e) { console.error('release integrity could not be checked: ' + e.message); process.exit(2); }
  console.log(summary(r));
  for (const f of r.failures.slice(0, 50)) console.log('  FAIL    ' + f.message);
  for (const x of r.warnings.slice(0, 50)) console.log('  WARNING ' + x.message);
  if (out) fs.writeFileSync(out, JSON.stringify(r, null, 1));
  process.exitCode = r.ok ? 0 : 1;
}
