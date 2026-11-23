'use strict';
/* EightMax 0.36.2 Milestone 3: preload of tools/exit-audit-0362m3.cjs. Records, when the runner writes its report (EM_EXIT_AUDIT_REPORT),
 * the resources that keep the event loop alive, and the same at process exit. Observes only; never changes the runner's behaviour. */
const fs = require('fs'), path = require('path');
const REPORT = process.env.EM_EXIT_AUDIT_REPORT ? path.resolve(process.env.EM_EXIT_AUDIT_REPORT) : null, SIDE = process.env.EM_EXIT_AUDIT_SIDECAR;
const audit = { reportWrittenAt: null, activeAtReport: null, activeAtExit: null };
const snap = () => { const list = typeof process.getActiveResourcesInfo === 'function' ? process.getActiveResourcesInfo() : []; const counts = {}; for (const k of list) counts[k] = (counts[k] || 0) + 1; return { counts, list }; };
const save = () => { if (!SIDE) return; try { fs.writeFileSync(SIDE, JSON.stringify(audit)); } catch (e) { /* ignore */ } };
const orig = fs.writeFileSync;
fs.writeFileSync = function (file, ...rest) {
  const r = orig.call(fs, file, ...rest);
  try { if (REPORT && typeof file === 'string' && path.resolve(file) === REPORT) { audit.reportWrittenAt = Date.now(); setImmediate(() => { audit.activeAtReport = snap(); save(); }); } } catch (e) { /* ignore */ }
  return r;
};
process.on('exit', () => { audit.activeAtExit = snap(); save(); });
