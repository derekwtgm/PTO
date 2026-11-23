'use strict';
/* EightMax Test Workbench 0.30: persistent precomputed strategy library (Node.js: desktop tools, table workers, tests).
 *
 * Storage (one directory):
 *   LIBRARY.json                 format/version marker, engine the library was created for
 *   records/<fp[0:2]>/<fp>.emsl  one immutable record per exact strategy identity (content-addressed by fingerprint)
 *   index.json                   catalogue (rebuilt from the records if missing or damaged; never trusted for correctness)
 *   misses.jsonl                 situations that were asked for but not in the library (feeds the training queue)
 *   queue.json, work/            precompute queue and per-job checkpoints (src/precompute.js)
 *   write.lock                   held only while a record or the index is being replaced
 *
 * Record (.emsl): "EMSL" | u32 1 | u32 headerLen | header JSON | gzip(street snapshot body)
 *   header: fingerprint, full identity, payload sizes and SHA-256 (of the compressed and of the raw body), training and
 *   convergence metadata, status. A record is written to a temporary file, flushed, then renamed into place (atomic on
 *   NTFS and POSIX filesystems), so a reader sees either no record or a complete one. An interrupted write leaves a *.tmp
 *   file that open() deletes. Every load re-checks: magic, version, fingerprint = SHA-256(identity) = file name, the
 *   payload checksum, the decoded size, and that the stored identity equals the identity the caller computed from the live
 *   table (the whole identity, not just the hash). Any failure is a refusal with a reason code; nothing is "repaired" into use.
 *
 * Concurrency: records are immutable, so any number of readers (threads or processes) need no lock. Writers serialise on
 * write.lock (created exclusively; a lock left by a dead process is taken over after it is proven stale).
 */
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib'), crypto = require('node:crypto'), os = require('node:os');
const SID = require('./strategy-identity.js'), SNAP = require('./strategy-snapshot.js');

const LIBRARY_FORMAT = 'eightmax-strategy-library', LIBRARY_VERSION = 1, RECORD_VERSION = 1, MAGIC = Buffer.from('EMSL', 'latin1');
class LibraryError extends Error { constructor(code, message) { super(message); this.code = code; this.name = 'LibraryError'; } }
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

function writeFileAtomic(file, data) {
  const tmp = file + '.tmp' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (x) { /* temp cleanup */ } throw e; }
}
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
// 0.36.2 M3 (found by Windows CI run 45203097931): on Windows a lock file that another thread has just removed can still be 'delete
// pending' (or be held for a moment by a scanner); creating or removing it then fails with EPERM / EACCES / EBUSY instead of EEXIST.
// That is the lock being busy, not a failure: such errors are retried within the same time limit (and the last one is reported).
const lockBusy = (e, platform = process.platform) => !!e && (e.code === 'EEXIST' || (platform === 'win32' && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY')));
const spin = (ms) => { const until = Date.now() + ms; while (Date.now() < until) { /* short spin: writes hold the lock for milliseconds */ } };
function removeLock(lf) { for (let k = 0; k < 200; k++) { try { fs.rmSync(lf, { force: true }); return; } catch (e) { if (!lockBusy(e) || e.code === 'EEXIST') return; spin(5); } } }

/* ---------- record encoding ---------- */
function encodeRecord(header, body) {
  const payload = zlib.gzipSync(Buffer.from(body.buffer, body.byteOffset, body.byteLength), { level: 6 });
  const h = { ...header, format: 'eightmax-strategy-record', version: RECORD_VERSION, payload: { encoding: 'gzip', bytes: payload.length, sha256: sha256(payload), rawBytes: body.byteLength, rawSha256: sha256(body) } };
  const hb = Buffer.from(JSON.stringify(h), 'utf8'), top = Buffer.alloc(12); MAGIC.copy(top, 0); top.writeUInt32LE(RECORD_VERSION, 4); top.writeUInt32LE(hb.length, 8);
  return { bytes: Buffer.concat([top, hb, payload]), header: h };
}
/** Parse and verify a record buffer. Returns { header, body (Uint8Array, 8-byte aligned) }. Throws LibraryError with a code. */
function decodeRecord(buf, expectFp, shared) {
  if (buf.length < 12 || !buf.subarray(0, 4).equals(MAGIC)) throw new LibraryError('bad-magic', 'Not a strategy record');
  if (buf.readUInt32LE(4) !== RECORD_VERSION) throw new LibraryError('record-version', 'Record version ' + buf.readUInt32LE(4) + ' is not supported by this release');
  const hl = buf.readUInt32LE(8); if (12 + hl > buf.length) throw new LibraryError('truncated', 'Record header truncated');
  let header; try { header = JSON.parse(buf.toString('utf8', 12, 12 + hl)); } catch (e) { throw new LibraryError('bad-header', 'Record header is not valid JSON'); }
  if (!header.identity || SID.fingerprint(header.identity) !== header.fingerprint) throw new LibraryError('fingerprint-mismatch', 'Record fingerprint does not match its identity');
  if (expectFp && header.fingerprint !== expectFp) throw new LibraryError('fingerprint-mismatch', 'Record is stored under the wrong fingerprint');
  const payload = buf.subarray(12 + hl);
  if (!header.payload || payload.length !== header.payload.bytes) throw new LibraryError('truncated', 'Record payload length differs from its header (' + payload.length + ' vs ' + (header.payload && header.payload.bytes) + ')');
  if (sha256(payload) !== header.payload.sha256) throw new LibraryError('checksum', 'Record payload checksum mismatch (corrupted)');
  let raw; try { raw = zlib.gunzipSync(payload); } catch (e) { throw new LibraryError('checksum', 'Record payload does not decompress'); }
  if (raw.length !== header.payload.rawBytes) throw new LibraryError('checksum', 'Decompressed size mismatch');
  const body = new Uint8Array(shared ? new SharedArrayBuffer(raw.length) : new ArrayBuffer(raw.length)); body.set(raw);   // own, 8-aligned buffer (shared memory when requested)
  return { header, body };
}

/* ---------- resource planning ---------- */
/**
 * How much RAM the strategy cache and precomputation may use on this machine. Reads the real totals at run time; never assumes 16 GB.
 * reservations (MiB): windows (OS + other applications), host, vision (image workers), solverWorkers, training (per concurrent job).
 */
function planResources(o = {}) {
  const MiB = 1048576, total = Math.floor((o.totalRamBytes || os.totalmem()) / MiB), free = Math.floor((o.freeRamBytes === undefined ? os.freemem() : o.freeRamBytes) / MiB);
  const r = { windows: Math.max(3072, Math.round(total * 0.2)), host: 256, vision: 512, solverWorkers: 768, trainingPerJob: 512, ...(o.reservations || {}) };
  const fixed = r.windows + r.host + r.vision + r.solverWorkers, spare = Math.max(0, total - fixed);
  const cacheMiB = Math.max(32, Math.min(o.maxCacheMiB || 2048, Math.floor(spare * 0.25)));
  const usableForTraining = Math.max(0, Math.min(spare - cacheMiB, free - 1024));
  const trainingJobs = Math.max(0, Math.min(o.maxTrainingJobs || Math.max(1, os.cpus().length - 2), Math.floor(usableForTraining / r.trainingPerJob)));
  return { totalMiB: total, freeMiB: free, reservationsMiB: r, cacheMiB, trainingJobs, trainingMiBPerJob: r.trainingPerJob,
    note: trainingJobs === 0 ? 'Not enough free memory for background training; it stays paused until memory is available' : 'Training uses at most ' + trainingJobs + ' job(s) of ' + r.trainingPerJob + ' MiB beside a ' + cacheMiB + ' MiB strategy cache' };
}

/* ---------- the library ---------- */
class StrategyLibrary {
  /** options: cacheBytes (default 256 MiB), engine {version,build} (records for another engine are refused), create (default true), readOnly */
  static open(dir, options = {}) { const l = new StrategyLibrary(dir, options); l._open(); return l; }
  constructor(dir, o) {
    this.dir = path.resolve(dir); this.o = { cacheBytes: 256 * 1048576, create: true, readOnly: false, engine: { version: '5.1', build: '7d08acc7eb4577ee' }, ...o };
    this.cache = new Map(); this.cacheUsed = 0; this.missBuffer = []; this.indexMtime = 0; this.index = null;
    this.stats = { lookups: 0, memoryHits: 0, diskHits: 0, misses: 0, refused: 0, evictions: 0, writes: 0, duplicateWrites: 0, loadMs: 0, loadMsMax: 0, peakCacheBytes: 0, refusedByCode: {} };
  }
  file(fp) { return path.join(this.dir, 'records', fp.slice(0, 2), fp + '.emsl'); }
  _open() {
    const marker = path.join(this.dir, 'LIBRARY.json');
    if (!fs.existsSync(marker)) {
      if (!this.o.create || this.o.readOnly) throw new LibraryError('no-library', 'No strategy library at ' + this.dir);
      fs.mkdirSync(path.join(this.dir, 'records'), { recursive: true });
      // 0.32 fix: create the marker UNDER the write lock (and only if still missing). 0.31 wrote it outside the lock, so when several
      // worker threads opened a NEW library at once, another thread's recover() could delete this thread's temp file mid-write
      // (reproduced: ENOENT on rename in 3 of 5 four-worker deep-stack runs, tools/benchmark-032.cjs workload F).
      const release = this._lock();
      try { if (!fs.existsSync(marker)) writeFileAtomic(marker, JSON.stringify({ format: LIBRARY_FORMAT, version: LIBRARY_VERSION, engine: this.o.engine, createdAt: new Date().toISOString() }, null, 1)); }
      finally { release(); }
    }
    let m; try { m = JSON.parse(fs.readFileSync(marker, 'utf8')); } catch (e) { throw new LibraryError('bad-library', 'LIBRARY.json is damaged: ' + e.message); }
    if (m.format !== LIBRARY_FORMAT) throw new LibraryError('bad-library', 'Not a strategy library');
    if (m.version > LIBRARY_VERSION) throw new LibraryError('library-version', 'Library version ' + m.version + ' is newer than this release supports (' + LIBRARY_VERSION + ')');
    this.marker = m;
    if (!this.o.readOnly) this.recover();
    this._loadIndex();
  }

  /* ----- locking (writers only) ----- */
  _lock(timeoutMs = 10000) {
    const lf = path.join(this.dir, 'write.lock'), t0 = Date.now();
    for (;;) {
      try { const fd = fs.openSync(lf, 'wx'); fs.writeSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() })); fs.closeSync(fd); return () => removeLock(lf); }
      catch (e) { if (!lockBusy(e)) throw e; if (e.code !== 'EEXIST') { if (Date.now() - t0 > timeoutMs) throw e; spin(5); continue; } }
      try { const info = JSON.parse(fs.readFileSync(lf, 'utf8')); if (info.host === os.hostname() && !pidAlive(info.pid)) { fs.rmSync(lf, { force: true }); continue; } } catch (e) { if (Date.now() - t0 > 2000) { try { fs.rmSync(lf, { force: true }); } catch (x) { /* raced */ } continue; } }
      if (Date.now() - t0 > timeoutMs) throw new LibraryError('lock-timeout', 'Library is locked by another writer');
      spin(5);
    }
  }

  /** Remove leftovers of interrupted writes and reconcile the index with the records on disk. Returns what was done. */
  recover() {
    const done = { tempFilesRemoved: 0, indexRebuilt: false, recordsAdded: 0, entriesDropped: 0, quarantined: 0 };
    const release = this._lock();
    try {
      const walk = (d) => { let out = []; for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const p = path.join(d, e.name); if (e.isDirectory()) out = out.concat(walk(p)); else out.push(p); } return out; };
      for (const f of walk(path.join(this.dir, 'records')).concat(fs.readdirSync(this.dir).map((x) => path.join(this.dir, x)))) if (/\.tmp\d+-[a-z0-9]+$/.test(f)) { fs.rmSync(f, { force: true }); done.tempFilesRemoved++; }   // every library-folder temp write holds this lock (0.32: the marker too)
      let idx = null; try { idx = JSON.parse(fs.readFileSync(path.join(this.dir, 'index.json'), 'utf8')); if (!idx || idx.format !== LIBRARY_FORMAT + '-index' || typeof idx.records !== 'object') idx = null; } catch (e) { idx = null; }
      if (!idx) { idx = { format: LIBRARY_FORMAT + '-index', version: 1, generation: 0, records: {} }; done.indexRebuilt = true; }
      const onDisk = new Set();
      for (const f of walk(path.join(this.dir, 'records'))) {
        const m = /([0-9a-f]{64})\.emsl$/.exec(f); if (!m) continue; onDisk.add(m[1]);
        if (!idx.records[m[1]]) {
          try { const r = decodeRecord(fs.readFileSync(f), m[1]); idx.records[m[1]] = this._entryOf(r.header, fs.statSync(f).size); done.recordsAdded++; }
          catch (e) { const q = path.join(this.dir, 'quarantine'); fs.mkdirSync(q, { recursive: true }); fs.renameSync(f, path.join(q, path.basename(f) + '.' + e.code)); done.quarantined++; onDisk.delete(m[1]); }
        }
      }
      for (const fp of Object.keys(idx.records)) if (!onDisk.has(fp)) { delete idx.records[fp]; done.entriesDropped++; }
      if (done.indexRebuilt || done.recordsAdded || done.entriesDropped) { idx.generation++; writeFileAtomic(path.join(this.dir, 'index.json'), JSON.stringify(idx)); }
    } finally { release(); }
    this.lastRecovery = done; return done;
  }
  _entryOf(h, bytes) {
    const id = h.identity;
    return { kind: id.kind, street: id.street || 'preflop', players: id.players, board: id.board || '', potBB: id.potBB, effectiveStackBB: id.effectiveStackBB, stackCategory: id.effectiveStackBB !== undefined ? SID.stackCategory(id.effectiveStackBB) : null, describe: SID.describe(id), engineBuild: id.engine.build, status: h.status, convergence: h.convergence && h.convergence.verdict, iterations: h.training && h.training.iterations !== undefined ? h.training.iterations : id.training && id.training.iterations, quality: h.quality ? h.quality.status : 'unverified', qualityPctPot: h.quality && h.quality.evaluation && h.quality.evaluation.potBB ? +(((h.quality.evaluation.players === 2 ? h.quality.evaluation.exploitabilityBB : h.quality.evaluation.nashConvBB) || 0) / h.quality.evaluation.potBB * 100).toFixed(4) : null, rangeModel: id.rangeModel || null, rawSha256: h.payload.rawSha256, bytes, rawBytes: h.payload.rawBytes, createdAt: h.createdAt, nodes: h.snapshot && h.snapshot.playerNodes, rows: h.snapshot && h.snapshot.rows };
  }
  _loadIndex() {
    const f = path.join(this.dir, 'index.json');
    try { const st = fs.statSync(f); if (this.index && st.mtimeMs === this.indexMtime) return; this.index = JSON.parse(fs.readFileSync(f, 'utf8')); this.indexMtime = st.mtimeMs; }
    catch (e) { this.index = { format: LIBRARY_FORMAT + '-index', version: 1, generation: 0, records: {} }; }
  }

  /** Store a snapshot. Transactional: record file first (temp + fsync + rename), then the index under the lock. Idempotent per fingerprint. */
  put(identity, body, meta = {}) {
    if (this.o.readOnly) throw new LibraryError('read-only', 'Library opened read-only');
    const fp = SID.fingerprint(identity);
    if (identity.engine.build !== this.o.engine.build) throw new LibraryError('engine-mismatch', 'Refusing to store a strategy from engine build ' + identity.engine.build);
    if (meta.status !== 'complete') throw new LibraryError('not-complete', 'Only completed studies are stored (status ' + meta.status + ')');
    const snapMeta = SNAP.decode(body).meta;   // never store something that does not decode
    const { bytes, header } = encodeRecord({ fingerprint: fp, identity, status: 'complete', createdAt: new Date().toISOString(), producer: { app: meta.app || null, host: os.hostname(), pid: process.pid },
      training: meta.training || null, convergence: meta.convergence || { verdict: 'unproven', detail: 'Training completed; no exploitability measurement attached. Completed training is not proof of equilibrium.' },
      snapshot: { playerNodes: snapMeta.playerNodes, rows: snapMeta.rows, iterations: snapMeta.iterations }, quality: meta.quality || null }, body);
    const f = this.file(fp); fs.mkdirSync(path.dirname(f), { recursive: true });
    const release = this._lock();
    try {
      if (fs.existsSync(f) && !meta.replace) { this.stats.duplicateWrites++; return { fingerprint: fp, duplicate: true, file: f }; }
      // 0.31 continued refinement: a better record of the SAME identity replaces the old one; the old bytes are kept in superseded/.
      if (fs.existsSync(f) && meta.replace) { const sup = path.join(this.dir, 'superseded'); fs.mkdirSync(sup, { recursive: true }); fs.copyFileSync(f, path.join(sup, fp + '-' + Date.now() + '.emsl')); if (fs.existsSync(this.linkedFile(fp))) fs.renameSync(this.linkedFile(fp), path.join(sup, fp + '-' + Date.now() + '.emlk')); this.stats.replaced = (this.stats.replaced || 0) + 1; this.cache.delete(fp); }
      if (this.o.faultBeforeRename) { const tmp = f + '.tmp' + process.pid + '-crash1'; fs.writeFileSync(tmp, bytes.subarray(0, Math.floor(bytes.length / 2))); throw new LibraryError('simulated-crash', 'Simulated interruption during record write'); }
      writeFileAtomic(f, bytes);
      this._loadIndex(); this.index.records[fp] = this._entryOf(header, bytes.length); this.index.generation = (this.index.generation || 0) + 1;
      if (this.o.faultBeforeIndex) throw new LibraryError('simulated-crash', 'Simulated interruption before the index update');
      writeFileAtomic(path.join(this.dir, 'index.json'), JSON.stringify(this.index)); this.indexMtime = fs.statSync(path.join(this.dir, 'index.json')).mtimeMs;
      this.stats.writes++;
    } finally { release(); }
    return { fingerprint: fp, duplicate: false, file: f, bytes: bytes.length };
  }
  has(fp) { return this.cache.has(fp) || fs.existsSync(this.file(fp)); }

  /* ---------- 0.32 linked multi-street continuation records (src/linked-study.js) ---------- */
  linkedFile(fp) { return path.join(this.dir, 'records', fp.slice(0, 2), fp + '.emlk'); }
  /** Store the linked continuation of an existing street record. Verified (decodes, checksums, names this fingerprint) before writing. */
  putLinked(fp, bytes) {
    if (this.o.readOnly) throw new LibraryError('read-only', 'Library opened read-only');
    if (!fs.existsSync(this.file(fp))) throw new LibraryError('no-record', 'A linked record needs its street record first');
    const LK = require('./linked-study.js'), g = LK.open(bytes);
    if (g.meta.fingerprint !== fp) throw new LibraryError('identity-mismatch', 'Linked record names fingerprint ' + g.meta.fingerprint);
    const rec = decodeRecord(fs.readFileSync(this.file(fp)), fp), snap = SNAP.decode(rec.body);
    // continuity: the linked record's first street must answer exactly like the street record (same bytes from the same study)
    for (const n of snap.meta.nodes) if (n.kind === 'player') for (const r of snap.meta.hands[n.seat]) {
      const a = snap.averageAt(n.p, snap.meta.board, n.seat, { id: r[0], a: r[1], b: r[2] }), b = g.averageAt(n.p, g.meta.startBoard, n.seat, { id: r[0], a: r[1], b: r[2] });
      if (!a !== !b || (a && a.some((x, i) => x !== b[i]))) throw new LibraryError('continuity', 'Linked record does not reproduce the street record at ' + n.p + ' (different study)');
    }
    const f = this.linkedFile(fp), release = this._lock();
    try { writeFileAtomic(f, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)); this._loadIndex(); if (this.index.records[fp]) { this.index.records[fp].linked = { bytes: bytes.length, streets: g.meta.streets ? Object.keys(g.meta.streets).map((l) => (+l === 3 ? 'flop' : +l === 4 ? 'turn' : 'river')) : [], missingRows: g.meta.counts.missingRows, storedRows: g.meta.counts.storedRows }; writeFileAtomic(path.join(this.dir, 'index.json'), JSON.stringify(this.index)); this.indexMtime = fs.statSync(path.join(this.dir, 'index.json')).mtimeMs; } this.stats.linkedWrites = (this.stats.linkedWrites || 0) + 1; }
    finally { release(); }
    return { fingerprint: fp, file: f, bytes: bytes.length, counts: g.meta.counts };
  }
  /** Lazy linked game (sections inflated on demand) or { ok:false, code }. */
  getLinked(fp, o = {}) {
    let buf; try { buf = fs.readFileSync(this.linkedFile(fp)); } catch (e) { return { ok: false, code: 'no-linked', reason: 'No linked continuation record is stored for this strategy' }; }
    try { const g = require('./linked-study.js').open(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), o); if (g.meta.fingerprint !== fp) return { ok: false, code: 'identity-mismatch', reason: 'Linked record belongs to another strategy' }; return { ok: true, game: g }; }
    catch (e) { this.stats.refused++; return { ok: false, code: e.code || 'corrupt', reason: 'Linked record refused: ' + e.message }; }
  }
  hasLinked(fp) { return fs.existsSync(this.linkedFile(fp)); }

  /**
   * Exact lookup. identity is what the caller computed from the live state. Returns
   *   { ok:true, source:'memory'|'disk', game, entry, header, timings } or { ok:false, code, reason, timings }.
   */
  get(identity, fp) {
    fp = fp || SID.fingerprint(identity); this.stats.lookups++;
    const t0 = nowMs(), c = this.cache.get(fp);
    if (c) { this.cache.delete(fp); this.cache.set(fp, c); this.stats.memoryHits++; return { ok: true, source: 'memory', fingerprint: fp, game: c.game, header: c.header, slot: c, timings: { lookupMs: nowMs() - t0, diskMs: 0 } }; }
    if (this.o.diskReads === false) { this.stats.misses++; return { ok: false, code: 'library-miss', reason: 'Not in this thread\'s cache (records are loaded by the shared host)', fingerprint: fp, timings: { lookupMs: nowMs() - t0, diskMs: 0 } }; }
    let buf; try { buf = fs.readFileSync(this.file(fp)); } catch (e) { this.stats.misses++; return { ok: false, code: 'library-miss', reason: 'No trained strategy is stored for this exact situation', fingerprint: fp, timings: { lookupMs: nowMs() - t0, diskMs: 0 } }; }
    const tr = nowMs(); let rec;
    try { rec = decodeRecord(buf, fp, !!this.o.sharedMemory); } catch (e) { return this._refuse(e.code || 'corrupt', e.message, fp, t0); }
    const differs = SID.diff(rec.header.identity, identity);
    if (differs.length) return this._refuse('identity-mismatch', 'Stored strategy identity differs from the requested situation in: ' + differs.join(', '), fp, t0);
    if (rec.header.identity.engine.build !== this.o.engine.build) return this._refuse('engine-mismatch', 'Stored strategy was trained by engine build ' + rec.header.identity.engine.build, fp, t0);
    if (rec.header.status !== 'complete') return this._refuse('not-complete', 'Stored strategy is not a completed study', fp, t0);
    let game; try { game = SNAP.decode(rec.body); } catch (e) { return this._refuse('corrupt', 'Snapshot does not decode: ' + e.message, fp, t0); }
    const diskMs = nowMs() - tr; this.stats.diskHits++; this.stats.loadMs += diskMs; this.stats.loadMsMax = Math.max(this.stats.loadMsMax, diskMs);
    const slot = { game, header: rec.header, bytes: rec.body.byteLength + 4096, study: null, body: rec.body };
    this._admit(fp, slot);
    return { ok: true, source: 'disk', fingerprint: fp, game, header: rec.header, slot, timings: { lookupMs: nowMs() - t0, diskMs } };
  }
  _refuse(code, reason, fp, t0) { this.stats.refused++; this.stats.refusedByCode[code] = (this.stats.refusedByCode[code] || 0) + 1; return { ok: false, code, reason, fingerprint: fp, timings: { lookupMs: nowMs() - t0, diskMs: 0 } }; }
  /** Adopt an already-decoded snapshot (e.g. one shared from another thread) into the memory cache. */
  adopt(fp, game, header) { const slot = { game, header, bytes: 4096 + (game.bytes || 0), study: null, shared: !!game.shared }; this._admit(fp, slot); return slot; }
  _admit(fp, slot) {
    if (slot.bytes > this.o.cacheBytes) return;   // larger than the whole budget: used once, not cached
    this.cache.set(fp, slot); this.cacheUsed += slot.bytes;
    while (this.cacheUsed > this.o.cacheBytes && this.cache.size > 1) { const [k, v] = this.cache.entries().next().value; this.cache.delete(k); this.cacheUsed -= v.bytes; this.stats.evictions++; }
    this.stats.peakCacheBytes = Math.max(this.stats.peakCacheBytes, this.cacheUsed);
  }
  /** Shrink (or grow) the cache budget at run time, e.g. under memory pressure. Evicts least-recently-used entries immediately. */
  setCacheBudget(bytes) { this.o.cacheBytes = Math.max(0, bytes); while (this.cacheUsed > this.o.cacheBytes && this.cache.size) { const [k, v] = this.cache.entries().next().value; this.cache.delete(k); this.cacheUsed -= v.bytes; this.stats.evictions++; } }
  clearCache() { this.setCacheBudget(this.o.cacheBytes); const b = this.o.cacheBytes; this.setCacheBudget(0); this.o.cacheBytes = b; }

  /* ----- misses ----- */
  recordMiss(identity, fp, extra = {}) {
    this.missBuffer.push({ at: Date.now(), fingerprint: fp, identity, ...extra });
    if (this.missBuffer.length >= (this.o.missFlushEvery || 32)) this.flushMisses();
  }
  flushMisses() {
    if (!this.missBuffer.length || this.o.readOnly) { this.missBuffer.length = 0; return; }
    const lines = this.missBuffer.splice(0).map((m) => JSON.stringify(m)).join('\n') + '\n';
    fs.appendFileSync(path.join(this.dir, 'misses.jsonl'), lines);
  }
  /** Missing situations by frequency (most frequent first). Damaged lines are skipped and counted. */
  missSummary(limit = Infinity) {
    this.flushMisses(); const f = path.join(this.dir, 'misses.jsonl'), by = new Map(); let damaged = 0;
    if (fs.existsSync(f)) for (const line of fs.readFileSync(f, 'utf8').split('\n')) { if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch (e) { damaged++; continue; } if (!m.fingerprint || !m.identity) { damaged++; continue; } const e = by.get(m.fingerprint) || { fingerprint: m.fingerprint, identity: m.identity, count: 0, first: m.at, last: m.at, spot: m.spot || null }; e.count++; e.last = m.at; if (m.spot && !e.spot) e.spot = m.spot; by.set(m.fingerprint, e); }
    const list = [...by.values()].filter((e) => !this.has(e.fingerprint)).sort((a, b) => b.count - a.count || a.first - b.first);
    return { distinct: list.length, damagedLines: damaged, list: list.slice(0, limit) };
  }

  /* ----- catalogue, verification, import/export ----- */
  list() { this._loadIndex(); return Object.entries(this.index.records).map(([fp, e]) => ({ fingerprint: fp, ...e })); }
  /** Full verification of every record (checksum, fingerprint, decode, engine). Returns a report; damaged records are listed, never used. */
  verifyAll(o = {}) {
    const rep = { checked: 0, ok: 0, damaged: [], engineMismatch: [], duplicatesOfData: [], notIndexed: 0 }, seen = new Map();
    const dir = path.join(this.dir, 'records');
    for (const sub of fs.existsSync(dir) ? fs.readdirSync(dir) : []) for (const f of fs.readdirSync(path.join(dir, sub))) {
      const m = /^([0-9a-f]{64})\.emsl$/.exec(f); if (!m) continue; rep.checked++;
      try { const r = decodeRecord(fs.readFileSync(path.join(dir, sub, f)), m[1]); SNAP.decode(r.body); if (r.header.identity.engine.build !== this.o.engine.build) { rep.engineMismatch.push(m[1]); continue; } rep.ok++; const d = r.header.payload.rawSha256; if (seen.has(d)) rep.duplicatesOfData.push([seen.get(d), m[1]]); else seen.set(d, m[1]); if (!this.index.records[m[1]]) rep.notIndexed++; }
      catch (e) { rep.damaged.push({ fingerprint: m[1], code: e.code || 'corrupt', reason: e.message }); }
    }
    return rep;
  }
  /** Export selected records into one portable bundle file ("EMSLB"). */
  exportBundle(file, filter = () => true) {
    const parts = [], list = this.list().filter(filter);
    for (const e of list) { const b = fs.readFileSync(this.file(e.fingerprint)), len = Buffer.alloc(4); len.writeUInt32LE(b.length); parts.push(len, b); }
    const head = Buffer.from(JSON.stringify({ format: 'eightmax-strategy-bundle', version: 1, engine: this.o.engine, count: list.length, createdAt: new Date().toISOString() })), hl = Buffer.alloc(4); hl.writeUInt32LE(head.length);
    const body = Buffer.concat([Buffer.from('EMSLB\0\0\0', 'latin1'), hl, head, ...parts]); writeFileAtomic(file, Buffer.concat([body, Buffer.from(sha256(body), 'latin1')]));
    return { file, records: list.length, bytes: body.length + 64 };
  }
  /** Import a bundle: every record is verified before it is written; damaged or foreign-engine records are skipped and reported. */
  importBundle(file) {
    const all = fs.readFileSync(file); if (all.length < 76 || all.toString('latin1', 0, 8) !== 'EMSLB\0\0\0') throw new LibraryError('bad-bundle', 'Not a strategy bundle');
    const body = all.subarray(0, all.length - 64); if (sha256(body) !== all.toString('latin1', all.length - 64)) throw new LibraryError('checksum', 'Bundle checksum mismatch');
    const hl = body.readUInt32LE(8), head = JSON.parse(body.toString('utf8', 12, 12 + hl)); let o = 12 + hl; const rep = { imported: 0, alreadyPresent: 0, rejected: [] };
    while (o < body.length) {
      const n = body.readUInt32LE(o), rb = body.subarray(o + 4, o + 4 + n); o += 4 + n;
      try { const r = decodeRecord(rb); if (r.header.identity.engine.build !== this.o.engine.build) { rep.rejected.push({ fingerprint: r.header.fingerprint, code: 'engine-mismatch' }); continue; } SNAP.decode(r.body);
        const f = this.file(r.header.fingerprint); if (fs.existsSync(f)) { rep.alreadyPresent++; continue; } fs.mkdirSync(path.dirname(f), { recursive: true });
        const release = this._lock(); try { writeFileAtomic(f, rb); this._loadIndex(); this.index.records[r.header.fingerprint] = this._entryOf(r.header, rb.length); this.index.generation++; writeFileAtomic(path.join(this.dir, 'index.json'), JSON.stringify(this.index)); } finally { release(); }
        rep.imported++; } catch (e) { rep.rejected.push({ code: e.code || 'corrupt', reason: e.message }); }
    }
    rep.bundle = head; return rep;
  }
  /** Status for dashboards: counts by street, players and stack depth, storage size, cache use. */
  status() {
    const l = this.list(), by = (k) => l.reduce((m, e) => { const v = typeof k === 'function' ? k(e) : e[k]; m[v] = (m[v] || 0) + 1; return m; }, {});
    return { format: 'eightmax-strategy-library-status', version: 1, dir: this.dir, engine: this.o.engine, records: l.length, storageBytes: l.reduce((n, e) => n + (e.bytes || 0), 0), rawBytes: l.reduce((n, e) => n + (e.rawBytes || 0), 0),
      byStreet: by('street'), byPlayers: by((e) => (e.players === 2 ? 'heads-up' : 'multiway (' + e.players + ')')), byStackCategory: by('stackCategory'), byConvergence: by('convergence'), byQuality: by((e) => e.quality || 'unverified'), byRangeModel: by((e) => e.rangeModel || 'unknown'),
      cache: { entries: this.cache.size, bytes: this.cacheUsed, budgetBytes: this.o.cacheBytes }, stats: { ...this.stats }, pendingMisses: this.missSummary(0).distinct };
  }
  close() { this.flushMisses(); this.cache.clear(); this.cacheUsed = 0; }
}

module.exports = { LIBRARY_FORMAT, LIBRARY_VERSION, RECORD_VERSION, LibraryError, StrategyLibrary, encodeRecord, decodeRecord, planResources, writeFileAtomic, lockBusy };
