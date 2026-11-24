'use strict';
// 0.36.2 Milestone 4.0 test helper: executables that a LATER milestone rebuilt on Windows (its release record lists them under
// rebuiltExecutables, each with the SHA-256 it replaces and the CI build run). A release test of an earlier milestone checks the chain - the
// later rebuild replaced exactly the binary that milestone shipped - and leaves the file on disk to the later milestone's own release test.
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
/** {exe: {replaces, sha256, ciRun, sources, milestone}} from the release records of milestones after `after` (only Milestone 4.0 so far). */
function laterRebuilds(after) {
  const order = ['release-0362-m3.json', 'release-0362-m31.json', 'release-0362-m32.json', 'release-0362-m40.json'], i = order.indexOf(after), out = {};
  for (const f of order.slice(i + 1)) {
    if (!fs.existsSync(path.join(ROOT, f))) continue; const r = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const [exe, v] of Object.entries(r.rebuiltExecutables || {})) if (!out[exe]) out[exe] = { ...v, milestone: f };
  }
  return out;
}
module.exports = { laterRebuilds };
