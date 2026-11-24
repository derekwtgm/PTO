/* EightMax Test Workbench 0.35.0: CENTRALISED INPUT SCHEDULER - one physical cursor, many tables.
 *
 * Windows has one shared cursor and one keyboard focus, so physical input from all table workers is serialised here:
 *   * a bounded queue ordered by deadline (earliest first), ties by submission order;
 *   * exactly one lease at a time ("cursor ownership"); a table worker never talks to the driver outside its lease;
 *   * before a job starts: drop it if its deadline cannot be met at the CONFIGURED speed (estimate from the motion model;
 *     movements are never sped up to make a deadline), and re-validate it (fresh observation, same hand, still legal);
 *   * pause per table, pause all, emergency stop (rejects everything queued and cancels the running job).
 * Metrics: queue wait, run time, deadline misses, rejections by reason, peak queue length.
 * 0.36.2 Milestone 2: invalidateTable(table, reason, registrationId) for a LOST window - rejects its queued jobs, voids the lease and
 *   asks the driver to cancel its running job (only when the running job is that table's), and refuses every later job of that
 *   registration. Other tables keep their queue positions. A replacement window is a new registration id and is not affected.
 * 0.36.2 Milestone 3.2: registrations are explicit. registerTable(table, registrationId) names a table's CURRENT registration (a
 *   SimulatorTable does it when it is built); invalidateTable() revokes that registration for good (idempotent: a repeated loss signal
 *   drops nothing twice and is counted as a repeat), so status().unavailableTables lists exactly the tables whose current registration
 *   is lost, while a table that was explicitly re-registered under a new id is available again and its old registration stays refused.
 *   A pause set for an older registration never blocks its replacement. Per-table metrics: scheduling delay (queue wait), run time,
 *   deadline misses, rejections by reason; window-loss cancellations record the time from loss to rejection of the queued jobs.
 * 0.36.2 Milestone 4.0: the job that runs next is chosen when the cursor becomes free (not when jobs are queued), by a named POLICY:
 *     edf              earliest deadline first, ties by submission order - exactly the Milestone 3.2 order (the default)
 *     fifo             submission order
 *     lst              least slack first (deadline - now - estimated input time)
 *     edf-aging        earliest deadline, minus agingWeight x time already waited
 *     fair-rr          round robin over tables (each table's earliest deadline), so no table waits behind repeat submissions
 *     nearest-guarded  shortest estimated input time from the cursor's last point (cursor-distance aware), but any job with less
 *                      than urgentSlackMs of slack goes first (least slack), and a job passed over maxBypass times goes first
 *   Every policy except edf/fifo also obeys the bounded-bypass rule (no job is passed over more than maxBypass times), so no healthy
 *   table can starve. A policy only ORDERS jobs: every job still passes the same checks before and inside its lease (emergency stop,
 *   lost target, pause, deadline at the configured speed, revalidation), and only one lease exists at a time.
 *   Measured per table and overall: true queue wait, lease occupancy (revalidation + input, the exclusive cursor time), maximum wait,
 *   bypasses, deadline misses, cursor utilisation, time-weighted queue depth and Jain's fairness index of the per-table service.
 *   A job may carry an ActionTimeline (action-timeline.js): enqueued, lease-acquired, target-verified and lease-released are marked.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkbenchInputScheduler = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const mono = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const stats = (a) => { if (!a.length) return { n: 0 }; const s = a.slice().sort((x, y) => x - y), q = (p) => s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; return { n: s.length, mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(2), p50: +q(50).toFixed(2), p95: +q(95).toFixed(2), p99: +q(99).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  /** 0.36.2 M4.0: the scheduling policies (see the header). */
  const POLICIES = Object.freeze(['edf', 'fifo', 'lst', 'edf-aging', 'fair-rr', 'nearest-guarded']);
  const mark = (j, stage, t) => { if (j && j.timeline && typeof j.timeline.mark === 'function') { try { j.timeline.mark(stage, t); } catch (e) { /* measurement only */ } } };
  /** Jain's fairness index of a list of non-negative shares: 1 = perfectly even, 1/n = one table gets everything. */
  const jain = (xs) => { const v = xs.filter((x) => Number.isFinite(x) && x >= 0); if (!v.length) return null; const s = v.reduce((a, b) => a + b, 0), s2 = v.reduce((a, b) => a + b * b, 0); return s2 > 0 ? +((s * s) / (v.length * s2)).toFixed(4) : 1; };

  class InputScheduler {
    /**
     * o: now(), maxQueue, onCancel(job) -> cancels the running driver operation, onEvent(kind, data)
     * 0.36.2 M4.0: policy (POLICIES, default 'edf'), agingWeight (edf-aging, default 1), maxBypass (default 3), urgentSlackMs
     *   (nearest-guarded, default 1500), dispatchEstimate (true: the deadline check uses the job's estimate from the cursor's
     *   CURRENT point, job.estimateFrom(point); false/absent: the estimate made at submission, as in Milestone 3.2)
     */
    constructor(o = {}) {
      this.now = o.now || mono; this.maxQueue = o.maxQueue || 16; this.onCancel = o.onCancel || (() => {}); this.onEvent = o.onEvent || (() => {});
      this.queue = []; this.running = null; this.seq = 0; this.paused = new Map(); this.allPaused = null; this.estop = null; this.invalidated = new Map(); this.cancellations = [];
      // 0.36.2 M3.2: explicit registrations - the current registration of each table, every revoked registration (never reinstated),
      // the registration that set a table's pause, and per-table timing metrics
      this.current = new Map(); this.registeredAt = new Map(); this.revoked = new Map(); this.pausedBy = new Map(); this.perTable = new Map();
      this.m = { submitted: 0, started: 0, completed: 0, failed: 0, rejected: {}, wait: [], run: [], peakQueue: 0, deadlineMisses: 0, slackAtStart: [], invalidationRepeats: 0 };
      // 0.36.2 M4.0
      this.policy = o.policy || 'edf'; if (!POLICIES.includes(this.policy)) throw new Error('Unknown scheduling policy ' + this.policy + ' (one of ' + POLICIES.join(', ') + ')');
      this.agingWeight = Number.isFinite(o.agingWeight) ? o.agingWeight : 1; this.maxBypass = Number.isInteger(o.maxBypass) && o.maxBypass >= 1 ? o.maxBypass : 3;
      this.urgentSlackMs = Number.isFinite(o.urgentSlackMs) ? o.urgentSlackMs : 1500; this.dispatchEstimate = o.dispatchEstimate === true;
      this.lastPoint = null; this.lastTable = null; this.createdAt = this.now();
      this.m4 = { leaseMs: [], queueWaitMs: [], leasedTotalMs: 0, depthArea: 0, depthSince: this.createdAt, bypassMax: 0, forcedPicks: 0, urgentPicks: 0, policyPicks: 0, firstSubmitAt: null, lastReleaseAt: null };
    }
    _tm(table) { let x = this.perTable.get(table); if (!x) { x = { submitted: 0, started: 0, completed: 0, failed: 0, deadlineMisses: 0, rejected: {}, wait: [], run: [], lease: [], maxWaitMs: 0, bypassed: 0, maxBypass: 0, leasedMs: 0 }; this.perTable.set(table, x); } return x; }
    _depth() { const t = this.now(); this.m4.depthArea += this.queue.length * Math.max(0, t - this.m4.depthSince); this.m4.depthSince = t; }
    _reject(job, code, reason) { this.m.rejected[code] = (this.m.rejected[code] || 0) + 1; const tm = this._tm(job.table); tm.rejected[code] = (tm.rejected[code] || 0) + 1; this.onEvent('rejected', { table: job.table, code, reason, registrationId: job.registrationId == null ? null : job.registrationId, jobId: job.id }); job.resolve({ ok: false, code, reason, table: job.table, waitedMs: this.now() - job.at }); }
    /**
     * job: { table, kind, deadline (absolute ms on this.now() clock), estimateMs, revalidate() -> {ok, reason}, run(lease) -> result }
     * 0.36.2 M4.0 (optional): target {x,y} (screen point of the click), estimateFrom(point) -> ms, timeline (ActionTimeline)
     * Resolves with {ok:true, result, waitedMs, runMs} or {ok:false, code, reason}.
     */
    submit(job) {
      return new Promise((resolve) => {
        const j = { ...job, id: ++this.seq, at: this.now(), resolve, bypassed: 0 }; this.m.submitted++; this._tm(j.table).submitted++; if (this.m4.firstSubmitAt === null) this.m4.firstSubmitAt = j.at;
        if (this.estop) return this._reject(j, 'emergency-stop', 'Emergency stop: ' + this.estop);
        if (this.allPaused) return this._reject(j, 'paused', 'All tables paused: ' + this.allPaused);
        if (this._invalid(j)) return this._reject(j, 'target-lost', 'Target unavailable: ' + this._invalid(j).reason);
        if (this.paused.has(j.table)) return this._reject(j, 'paused', 'Table paused: ' + this.paused.get(j.table));
        if (this.queue.some((q) => q.table === j.table) || (this.running && this.running.table === j.table)) return this._reject(j, 'table-busy', 'This table already has an input job queued or running');
        if (this.queue.length >= this.maxQueue) return this._reject(j, 'queue-full', 'Input queue is full (' + this.maxQueue + ')');
        if (!Number.isFinite(j.deadline)) return this._reject(j, 'no-deadline', 'Every input job needs a deadline');
        this._depth(); this.queue.push(j); this.queue.sort((a, b) => a.deadline - b.deadline || a.id - b.id); this.m.peakQueue = Math.max(this.m.peakQueue, this.queue.length); mark(j, 'enqueued', j.at);
        this._pump();
      });
    }
    /** Estimated input time of a queued job from the cursor's current point (dispatch time) or from its submission estimate. */
    _est(j) { if (this.dispatchEstimate && typeof j.estimateFrom === 'function') { try { const v = j.estimateFrom(this.lastPoint); if (Number.isFinite(v) && v >= 0) return v; } catch (e) { /* fall back */ } } return Math.max(0, j.estimateMs || 0); }
    /** 0.36.2 M4.0: the queued job that runs next under the policy (the queue stays sorted by deadline, then submission). */
    _pick() {
      const q = this.queue; if (!q.length) return -1; const t = this.now(), P = this.policy;
      if (P === 'edf') return 0;
      const minBy = (f) => { let best = -1, bv = Infinity; for (let i = 0; i < q.length; i++) { const v = f(q[i]); if (v < bv - 1e-9 || (Math.abs(v - bv) <= 1e-9 && best >= 0 && (q[i].deadline < q[best].deadline || (q[i].deadline === q[best].deadline && q[i].id < q[best].id)))) { bv = v; best = i; } } return best; };
      if (P === 'fifo') return minBy((j) => j.id);
      // bounded bypass: a job already passed over maxBypass times goes first (the oldest such job)
      let forced = -1; for (let i = 0; i < q.length; i++) if (q[i].bypassed >= this.maxBypass && (forced < 0 || q[i].id < q[forced].id)) forced = i;
      if (forced >= 0) { this.m4.forcedPicks++; return forced; }
      if (P === 'lst') return minBy((j) => j.deadline - t - this._est(j));
      if (P === 'edf-aging') return minBy((j) => j.deadline - this.agingWeight * (t - j.at));
      if (P === 'fair-rr') {
        const tables = [...new Set(q.map((j) => j.table))].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0)); if (tables.length === 1) return 0;
        const after = this.lastTable === null ? null : tables.find((x) => x > this.lastTable), next = after === undefined || after === null ? tables[0] : after;
        return q.findIndex((j) => j.table === next);   // q is deadline-sorted: the first job of that table is its earliest deadline
      }
      if (P === 'nearest-guarded') {
        const urgent = minBy((j) => { const s = j.deadline - t - this._est(j); return s < this.urgentSlackMs ? s : Infinity; });
        if (urgent >= 0 && q[urgent].deadline - t - this._est(q[urgent]) < this.urgentSlackMs) { this.m4.urgentPicks++; return urgent; }
        return minBy((j) => this._est(j));
      }
      return 0;
    }
    async _pump() {
      // One pump at a time: the lease is reserved BEFORE the (async) revalidation, so no second job can start meanwhile
      // (0.35 test found overlapping input when two submissions raced through an awaiting revalidation).
      if (this.running || this.pumping) return; this.pumping = true;
      try { await this._drain(); } finally { this.pumping = false; }
      if (this.queue.length && !this.running) this._pump();   // a job submitted while the drain loop was finishing
    }
    async _drain() {
      while (this.queue.length && !this.running) {
        const k = this._pick(); this._depth(); const j = this.queue.splice(k < 0 ? 0 : k, 1)[0], t = this.now(), est = this.dispatchEstimate ? this._est(j) : Math.max(0, j.estimateMs || 0), tm = this._tm(j.table);
        if (this.policy !== 'edf') this.m4.policyPicks++;
        if (this.estop) { this._reject(j, 'emergency-stop', 'Emergency stop: ' + this.estop); continue; }
        if (this._invalid(j)) { this._reject(j, 'target-lost', 'Target unavailable before its input started: ' + this._invalid(j).reason); continue; }
        if (this.allPaused || this.paused.has(j.table)) { this._reject(j, 'paused', 'Table paused before its input started'); continue; }
        if (t + est > j.deadline) { this.m.deadlineMisses++; tm.deadlineMisses++; this._reject(j, 'deadline', 'Cannot finish by the deadline at the configured speed (needs ' + Math.round(est) + ' ms, ' + Math.round(j.deadline - t) + ' ms left); not rushed'); continue; }
        // 0.36.2 M4.0: every job queued before this one was passed over once more (fairness evidence; bounded by maxBypass for reordering policies)
        for (const o of this.queue) if (o.id < j.id) { o.bypassed++; const ot = this._tm(o.table); ot.bypassed++; if (o.bypassed > ot.maxBypass) ot.maxBypass = o.bypassed; if (o.bypassed > this.m4.bypassMax) this.m4.bypassMax = o.bypassed; }
        this.running = j;   // lease reserved: revalidation already owns the cursor
        const leaseAt = t; mark(j, 'lease-acquired', leaseAt);
        let v = { ok: true }; if (typeof j.revalidate === 'function') { try { v = await j.revalidate(); } catch (e) { v = { ok: false, reason: e.message }; } }
        if (!v || v.ok !== true) { this.running = null; this._leaseEnd(j, tm, leaseAt); this._reject(j, 'stale', 'Revalidation failed: ' + (v && v.reason || 'unknown')); continue; }
        if (this.estop) { this.running = null; this._leaseEnd(j, tm, leaseAt); this._reject(j, 'emergency-stop', 'Emergency stop: ' + this.estop); continue; }
        if (this._invalid(j) || this.paused.has(j.table) || this.allPaused) { this.running = null; this._leaseEnd(j, tm, leaseAt); this._reject(j, this._invalid(j) ? 'target-lost' : 'paused', 'Target became unavailable during revalidation'); continue; }
        mark(j, 'target-verified');
        this.m.started++; tm.started++; this.m.wait.push(t - j.at); tm.wait.push(t - j.at); this.m.slackAtStart.push(j.deadline - t - est); if (this.m.wait.length > 5000) { this.m.wait.shift(); this.m.slackAtStart.shift(); } if (tm.wait.length > 2000) tm.wait.shift();
        if (t - j.at > tm.maxWaitMs) tm.maxWaitMs = t - j.at; this.m4.queueWaitMs.push(t - j.at); if (this.m4.queueWaitMs.length > 5000) this.m4.queueWaitMs.shift();
        const lease = { table: j.table, id: j.id, deadline: j.deadline, registrationId: j.registrationId, get valid() { return this._valid !== false; }, remainingMs: () => j.deadline - this.now() }; j.lease = lease;
        this.onEvent('lease', { table: j.table, id: j.id, waitedMs: t - j.at, registrationId: j.registrationId == null ? null : j.registrationId });
        const t1 = this.now(); let out;
        try { const r = await j.run(lease); out = { ok: true, result: r, waitedMs: t1 - j.at, runMs: this.now() - t1, leaseId: j.id }; this.m.completed++; tm.completed++; const pt = r && r.input && r.input.point; if (pt && Number.isFinite(pt.x) && Number.isFinite(pt.y)) this.lastPoint = { x: pt.x, y: pt.y }; }
        catch (e) { out = { ok: false, code: e.code || 'run-failed', reason: e.message, waitedMs: t1 - j.at, runMs: this.now() - t1, leaseId: j.id }; this.m.failed++; tm.failed++; }
        lease._valid = false; this.m.run.push(this.now() - t1); tm.run.push(this.now() - t1); if (this.m.run.length > 5000) this.m.run.shift(); if (tm.run.length > 2000) tm.run.shift();
        out.queueWaitMs = t - j.at; out.revalidationMs = t1 - t; out.leaseMs = this.now() - leaseAt;   // 0.36.2 M4.0 (additive)
        this.lastTable = j.table; this.running = null; this._leaseEnd(j, tm, leaseAt); this.onEvent('release', { table: j.table, id: j.id }); j.resolve(out);
      }
    }
    /** 0.36.2 M4.0: the exclusive cursor time of one lease (also a lease that ended in its revalidation). */
    _leaseEnd(j, tm, leaseAt) { const t = this.now(), ms = Math.max(0, t - leaseAt); mark(j, 'lease-released', t); this.m4.leasedTotalMs += ms; tm.leasedMs += ms; this.m4.leaseMs.push(ms); tm.lease.push(ms); if (this.m4.leaseMs.length > 5000) this.m4.leaseMs.shift(); if (tm.lease.length > 2000) tm.lease.shift(); this.m4.lastReleaseAt = t; }
    /** registrationId (0.36.2 M3.2, optional): the registration this pause belongs to - a replacement registration is not blocked by it. */
    pauseTable(table, reason = 'paused', registrationId = null) { this.paused.set(table, reason); this.pausedBy.set(table, registrationId == null ? null : registrationId); for (const j of this.queue.filter((q) => q.table === table)) { this._depth(); this.queue.splice(this.queue.indexOf(j), 1); this._reject(j, 'paused', 'Table paused: ' + reason); } }
    resumeTable(table) { this.paused.delete(table); this.pausedBy.delete(table); }
    pauseAll(reason = 'paused by operator') { this.allPaused = reason; this._depth(); for (const j of this.queue.splice(0)) this._reject(j, 'paused', 'All tables paused: ' + reason); }
    resumeAll() { this.allPaused = null; }
    /** Cancel the running job (driver cancel) and reject everything queued; nothing starts until reset(). */
    emergencyStop(reason = 'Emergency stop') { this.estop = reason; this._depth(); for (const j of this.queue.splice(0)) this._reject(j, 'emergency-stop', 'Emergency stop: ' + reason); if (this.running) { try { this.onCancel(this.running); } catch (e) { /* driver gone */ } } this.onEvent('estop', { reason }); }
    cancelCurrent(reason = 'cancelled by operator') { if (this.running) { try { this.onCancel(this.running, reason); } catch (e) { /* driver gone */ } return true; } return false; }
    reset() { this.estop = null; }
    /**
     * 0.36.2 M3.2: the CURRENT registration of a table (a SimulatorTable calls it when it is built). A revoked registration can never be
     * registered again. A new registration supersedes the table's earlier ones: the table is available again, its old registrations stay
     * refused, and a pause that an older registration set is lifted (it belonged to the old window). -> {ok, replaces} | {ok:false, refused}
     */
    registerTable(table, registrationId) {
      if (registrationId == null) return { ok: false, refused: 'no-registration', reason: 'A registration id is required' };
      if (this.revoked.has(registrationId)) return { ok: false, refused: 'revoked', reason: 'Registration ' + registrationId + ' was invalidated (' + this.revoked.get(registrationId).reason + '); a replacement window needs a new registration' };
      const prev = this.current.has(table) ? this.current.get(table) : null; this.current.set(table, registrationId); this.registeredAt.set(table, this.now());
      if (prev !== null && prev !== registrationId && this.paused.has(table) && this.pausedBy.get(table) === prev) { this.paused.delete(table); this.pausedBy.delete(table); }
      if (prev !== registrationId) this.onEvent('registered', { table, registrationId, replaces: prev });
      return { ok: true, replaces: prev };
    }
    /** Is the table's CURRENT registration unavailable? (Without registerTable(): any invalidation of the table, as in Milestone 2/3.) */
    _tableUnavailable(table) {
      const v = this.invalidated.get(table); if (!v) return false;
      if (!this.current.has(table)) return true;
      if (v.registrationId == null) { const ra = this.registeredAt.get(table); return !(ra !== undefined && ra > v.at); }
      return this.revoked.has(this.current.get(table));
    }
    _invalid(j) {
      if (j.registrationId != null && this.revoked.has(j.registrationId)) return this.revoked.get(j.registrationId);   // a lost registration, for good
      const v = this.invalidated.get(j.table); if (!v) return null;
      if (v.registrationId == null) { const ra = this.registeredAt.get(j.table); return ra !== undefined && ra > v.at && j.registrationId != null && j.registrationId === this.current.get(j.table) ? null : v; }
      if (j.registrationId == null) return this._tableUnavailable(j.table) ? v : null;
      return null;
    }
    /**
     * Lost window: drop its queued jobs, void its lease, cancel its running job (driver), refuse its later jobs. -> {dropped, cancelledRunning}
     * 0.36.2 M3.2: only jobs of that registration are touched (a replacement registration of the same table keeps its job), and a repeated
     * signal for a registration that is already revoked changes nothing (counted as a repeat; {repeated:true}).
     */
    invalidateTable(table, reason = 'target lost', registrationId = null) {
      const mine = (q) => q.table === table && (registrationId == null || q.registrationId == null || q.registrationId === registrationId);
      if (registrationId != null && this.revoked.has(registrationId)) {
        this.m.invalidationRepeats++; const prev = this.revoked.get(registrationId); prev.repeats = (prev.repeats || 0) + 1;
        let dropped = 0; for (const j of this.queue.filter(mine)) { this._depth(); this.queue.splice(this.queue.indexOf(j), 1); dropped++; this._reject(j, 'target-lost', 'Target unavailable: ' + reason); }
        this.onEvent('invalidated-repeat', { table, registrationId, reason, dropped });
        return { table, registrationId, reason: prev.reason, dropped, cancelledRunning: false, repeated: true, at: prev.at };
      }
      const at = this.now(); let dropped = 0, cancelledRunning = false;
      const rec0 = { reason, registrationId, at }; this.invalidated.set(table, rec0); if (registrationId != null) this.revoked.set(registrationId, { table, reason, registrationId, at });
      for (const j of this.queue.filter(mine)) { this._depth(); this.queue.splice(this.queue.indexOf(j), 1); dropped++; this._reject(j, 'target-lost', 'Target unavailable: ' + reason); }
      const r = this.running; if (r && mine(r)) { if (r.lease) r.lease._valid = false; cancelledRunning = true; try { this.onCancel(r, 'target lost: ' + reason); } catch (e) { /* driver gone */ } }
      const rec = { table, registrationId, reason, dropped, cancelledRunning, at, runningTable: r ? r.table : null }; this.cancellations.push(rec); if (this.cancellations.length > 200) this.cancellations.shift();
      this.onEvent('invalidated', rec); return rec;
    }
    /** Only for an explicitly re-registered window (new registration id) that the operator enabled again. A revoked registration stays revoked. */
    reinstateTable(table) { this.invalidated.delete(table); }
    status() {
      return { running: this.running ? { table: this.running.table, kind: this.running.kind, id: this.running.id, registrationId: this.running.registrationId == null ? null : this.running.registrationId } : null, queued: this.queue.map((j) => ({ table: j.table, kind: j.kind, msToDeadline: Math.round(j.deadline - this.now()), registrationId: j.registrationId == null ? null : j.registrationId })), estop: this.estop, allPaused: this.allPaused, pausedTables: [...this.paused.keys()],
        unavailableTables: [...this.invalidated.keys()].filter((t) => this._tableUnavailable(t)), registrations: Object.fromEntries([...this.current.entries()].map(([t, r]) => [t, r])), revokedRegistrations: [...this.revoked.values()].map((v) => ({ table: v.table, registrationId: v.registrationId, reason: v.reason, repeats: v.repeats || 0 })), policy: this.policy };
    }
    metrics() {
      const perTable = {}; for (const [t, x] of this.perTable) perTable[t] = { submitted: x.submitted, started: x.started, completed: x.completed, failed: x.failed, deadlineMisses: x.deadlineMisses, rejected: { ...x.rejected }, queueWaitMs: stats(x.wait), runMs: stats(x.run), leaseMs: stats(x.lease), maxWaitMs: +x.maxWaitMs.toFixed(2), bypassed: x.bypassed, maxBypass: x.maxBypass, leasedMs: +x.leasedMs.toFixed(1) };
      this._depth(); const span = Math.max(1, (this.m4.lastReleaseAt !== null ? Math.max(this.m4.lastReleaseAt, this.now()) : this.now()) - (this.m4.firstSubmitAt !== null ? this.m4.firstSubmitAt : this.createdAt));
      const served = [...this.perTable.values()].filter((x) => x.submitted > 0).map((x) => x.completed);
      return { submitted: this.m.submitted, started: this.m.started, completed: this.m.completed, failed: this.m.failed, rejected: { ...this.m.rejected }, deadlineMisses: this.m.deadlineMisses, peakQueue: this.m.peakQueue, queueWaitMs: stats(this.m.wait), runMs: stats(this.m.run), slackAtStartMs: stats(this.m.slackAtStart), invalidations: this.cancellations.slice(-50), invalidationRepeats: this.m.invalidationRepeats, perTable,
        // 0.36.2 M4.0 (additive)
        policy: this.policy, leaseMs: stats(this.m4.leaseMs), cursorUtilization: +(this.m4.leasedTotalMs / span).toFixed(4), meanQueueDepth: +(this.m4.depthArea / Math.max(1, this.now() - this.createdAt)).toFixed(3), spanMs: Math.round(span),
        fairness: { jainCompleted: jain(served), maxBypass: this.m4.bypassMax, forcedPicks: this.m4.forcedPicks, urgentPicks: this.m4.urgentPicks, maxWaitMs: Math.max(0, ...[...this.perTable.values()].map((x) => x.maxWaitMs)) } };
    }
  }
  return { InputScheduler, stats, POLICIES, jain };
});
