/* EightMax Test Workbench 0.36.2 Milestone 4.0: ACTION TIMELINE - where the time of one automated action goes.
 *
 * One ActionTimeline per decision records the monotonic time (performance.now(), milliseconds) of each pipeline stage:
 *   capture-queued, capture-begin, capture-end, recognition-begin, recognition-end, state-validated, decision-ready, submitted,
 *   enqueued, lease-acquired, target-verified, move-begin, move-end, click-done, driver-ack, lease-released, confirm-begin,
 *   state-confirmed, action-released
 * A stage is recorded once (the first mark wins); a stage that did not happen (an action refused before input, a confirmation that
 * never started) stays absent, so every interval below is computed only from the marks that exist - nothing is estimated.
 * The input driver reports its own phases (queue wait, checks, movement, pre-click wait, focus, double-click guard, hold, input
 * drain) relative to the start of its operation; they are placed on this clock between the request and the reply (driverPhases()).
 * Measurement only: nothing here changes what the pipeline does, and a timeline never authorises anything.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkbenchActionTimeline = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const mono = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const STAGES = Object.freeze([
    ['capture-queued', 'Capture request queued'], ['capture-begin', 'Capture begins'], ['capture-end', 'Capture completes'],
    ['recognition-begin', 'Screen recognition begins'], ['recognition-end', 'Recognition completes'], ['state-validated', 'Game state validated'],
    ['decision-ready', 'Strategy decision available'], ['submitted', 'Decision submitted to the scheduler'], ['enqueued', 'Decision enters the queue'],
    ['lease-acquired', 'Input lease acquired'], ['target-verified', 'Target window verified (fresh capture inside the lease)'], ['move-begin', 'Cursor movement begins'],
    ['move-end', 'Cursor reaches the destination'], ['click-done', 'Mouse button pressed and released'], ['driver-ack', 'Driver acknowledgement received'],
    ['lease-released', 'Input lease released'], ['confirm-begin', 'Action confirmation begins'], ['state-confirmed', 'Simulator state change confirmed'],
    ['action-released', 'Action state released']]);
  const STAGE_NAMES = Object.freeze(STAGES.map((s) => s[0]));
  /** Intervals reported for every action: [name, from stage, to stage, meaning]. */
  const INTERVALS = Object.freeze([
    ['captureQueueMs', 'capture-queued', 'capture-begin', 'waiting for a host request slot before the capture'],
    ['captureMs', 'capture-begin', 'capture-end', 'capture request, transfer and image decoding'],
    ['recognitionMs', 'recognition-begin', 'recognition-end', 'screen recognition of the frame'],
    ['validationMs', 'recognition-end', 'state-validated', 'hand-state reconstruction and validation'],
    ['decisionMs', 'state-validated', 'decision-ready', 'strategy decision'],
    ['submitMs', 'decision-ready', 'submitted', 'executor checks before submission'],
    ['enqueueMs', 'submitted', 'enqueued', 'submission to queue entry'],
    ['queueWaitMs', 'enqueued', 'lease-acquired', 'waiting for the single cursor (scheduler queue)'],
    ['revalidationMs', 'lease-acquired', 'target-verified', 'fresh capture inside the lease: same frame, same window rectangle'],
    ['preMoveMs', 'target-verified', 'move-begin', 'lifecycle guard, driver request, driver queue and identity checks'],
    ['moveMs', 'move-begin', 'move-end', 'cursor movement'],
    ['clickMs', 'move-end', 'click-done', 'pre-click wait, window raise, double-click guard, button hold'],
    ['ackMs', 'click-done', 'driver-ack', 'input drain and driver reply'],
    ['leaseTailMs', 'driver-ack', 'lease-released', 'work after the reply that still holds the lease (settle in the lease)'],
    ['settleOutsideMs', 'lease-released', 'confirm-begin', 'settle after the lease was released (cursor free for other tables)'],
    ['confirmMs', 'confirm-begin', 'state-confirmed', 'confirmation: captures until the simulator shows the action'],
    ['releaseMs', 'state-confirmed', 'action-released', 'bookkeeping after the confirmation'],
    // derived spans
    ['leaseOccupancyMs', 'lease-acquired', 'lease-released', 'exclusive cursor time used by this action'],
    ['inputServiceMs', 'lease-acquired', 'driver-ack', 'lease start to driver acknowledgement'],
    ['schedulingDelayM32Ms', 'enqueued', 'target-verified', 'Milestone 3.2 "scheduling delay" definition (queue wait + in-lease revalidation)'],
    ['actionLatencyMs', 'capture-end', 'state-confirmed', 'frame captured to action confirmed (Milestone 3.2 "action latency")'],
    ['endToEndMs', 'capture-queued', 'action-released', 'whole action from the capture request'],
  ]);
  const INTERVAL_NAMES = Object.freeze(INTERVALS.map((i) => i[0]));

  class ActionTimeline {
    constructor(o = {}) { this.table = o.table === undefined ? null : o.table; this.id = o.id === undefined ? null : o.id; this.now = o.now || mono; this.marks = Object.create(null); this.info = Object.create(null); this.closed = false; }
    /** Record a stage once; t defaults to now. Unknown stage names are refused (typos would silently lose measurements). */
    mark(stage, t) { if (!STAGE_NAMES.includes(stage)) throw new Error('Unknown timeline stage ' + stage); if (this.marks[stage] === undefined && Number.isFinite(t === undefined ? (t = this.now()) : t)) this.marks[stage] = t; return this; }
    has(stage) { return this.marks[stage] !== undefined; }
    at(stage) { return this.marks[stage] === undefined ? null : this.marks[stage]; }
    set(key, value) { this.info[key] = value; return this; }
    /**
     * Driver phases (milliseconds from the start of the driver's operation) placed between the request (sentAt) and the reply
     * (repliedAt): the transport time not spent in the driver is split evenly between the two directions. Marks move-begin,
     * move-end and click-done when the driver reported them; returns the placed phases (or null when the reply had none).
     */
    driverPhases(sentAt, repliedAt, phases) {
      if (!phases || !Number.isFinite(sentAt) || !Number.isFinite(repliedAt)) return null;
      const q = Number(phases.queueMs) || 0, total = Number(phases.totalMs) || 0, transport = Math.max(0, repliedAt - sentAt - q - total), opStart = sentAt + transport / 2 + q;
      const p = (k) => (Number.isFinite(Number(phases[k])) ? opStart + Number(phases[k]) : null);
      const mb = p('moveStartMs'), me = p('moveEndMs'), cd = p('clickDoneMs');
      if (mb !== null) this.mark('move-begin', mb); if (me !== null) this.mark('move-end', me); if (cd !== null) this.mark('click-done', cd);
      this.info.driver = { queueMs: q, totalMs: total, transportMs: +transport.toFixed(2), ...phases };
      return this.info.driver;
    }
    /** {interval: ms} for every interval whose two marks exist (and are ordered). */
    durations() {
      const out = {};
      for (const [name, a, b] of INTERVALS) { const x = this.marks[a], y = this.marks[b]; if (x !== undefined && y !== undefined && y >= x - 0.5) out[name] = +Math.max(0, y - x).toFixed(2); }
      return out;
    }
    toJSON() { const t0 = this.marks['capture-queued'] !== undefined ? this.marks['capture-queued'] : Math.min(...Object.values(this.marks)); const rel = {}; for (const s of STAGE_NAMES) if (this.marks[s] !== undefined) rel[s] = +(this.marks[s] - t0).toFixed(2); return { table: this.table, id: this.id, stages: rel, durations: this.durations(), info: this.info }; }
  }

  /** Percentile statistics (nearest rank), the same definition the Milestone 3.2 reports used. */
  function stats(a) {
    const v = (a || []).filter(Number.isFinite); if (!v.length) return { n: 0 };
    const s = v.slice().sort((x, y) => x - y), q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p / 100 * s.length) - 1))], mean = s.reduce((x, y) => x + y, 0) / s.length;
    return { n: s.length, mean: +mean.toFixed(2), p50: +q(50).toFixed(2), p90: +q(90).toFixed(2), p95: +q(95).toFixed(2), p99: +q(99).toFixed(2), max: +s[s.length - 1].toFixed(2), min: +s[0].toFixed(2) };
  }

  /** Collects finished timelines (bounded) and summarises every interval overall and per table. */
  class TimelineAggregator {
    constructor(o = {}) { this.max = o.max || 20000; this.items = []; this.dropped = 0; this.now = o.now || mono; this.startedAt = this.now(); }
    add(tl, outcome) { if (!tl || tl.closed) return; tl.closed = true; const rec = { table: tl.table, outcome: outcome || null, d: tl.durations(), driver: tl.info.driver || null, info: { guardMs: tl.info.driver ? tl.info.driver.guardMs : undefined } }; this.items.push(rec); if (this.items.length > this.max) { this.items.shift(); this.dropped++; } return rec; }
    summary(o = {}) {
      const filter = o.outcome ? (r) => r.outcome === o.outcome : () => true, items = this.items.filter(filter), byTable = new Map();
      for (const r of items) { if (!byTable.has(r.table)) byTable.set(r.table, []); byTable.get(r.table).push(r); }
      const sum = (list) => { const out = { actions: list.length }; for (const k of INTERVAL_NAMES) { const s = stats(list.map((r) => r.d[k])); if (s.n) out[k] = s; }
        const drv = list.map((r) => r.driver).filter(Boolean); if (drv.length) { out.driver = {}; for (const k of ['queueMs', 'checkMs', 'moveMs', 'postMoveMs', 'preClickMs', 'focusMs', 'guardMs', 'holdMs', 'drainMs', 'totalMs', 'transportMs']) { const s = stats(drv.map((x) => Number(x[k]))); if (s.n) out.driver[k] = s; } }
        return out; };
      const perTable = {}; for (const [t, list] of [...byTable.entries()].sort((a, b) => a[0] - b[0])) perTable[t] = sum(list);
      return { format: 'eightmax-action-timeline-summary', version: 1, stages: STAGES.map(([id, label]) => ({ id, label })), intervals: INTERVALS.map(([id, from, to, meaning]) => ({ id, from, to, meaning })), overall: sum(items), perTable, droppedOldest: this.dropped };
    }
  }
  return { STAGES, STAGE_NAMES, INTERVALS, INTERVAL_NAMES, ActionTimeline, TimelineAggregator, stats };
});
