/* EightMax Test Workbench 0.36.2 Milestone 4.0: VERIFY TABLE RECOGNITION - the dashboard's recognition self-check of one registered window.
 *
 * From ONE fresh capture of the window, read exactly as the automation reads it (same capture path, same reader and templates for this
 * width, same status-strip check), it reports: the window and its client rectangle (physical pixels), the display scale Windows reports
 * for it and the logical size, the calibrated action controls as physical rectangles and click points, the card and amount positions, the
 * recognised values with their confidences, every region that could not be read, the status strip, and the calibration status.
 *
 * SAFETY-CRITICAL failures - automated input for this table is refused until a new check passes (verdict 'fail', inputAllowed false):
 *   * the capture is not the client area at physical size (scaled / DPI-virtualised / cropped), or the display scale is unknown
 *   * a calibrated control or the wager field does not map to a clickable rectangle inside the client area (not calibrated, too small)
 *   * no calibrated layout matches the window (unknown aspect ratio, ambiguous layout, resolution too low for reliable digit reading)
 *   * the status strip is unreadable, or names another table than the one registered
 * FRAME-LEVEL refusals (verdict 'pass-frame-unreadable', input allowed): the calibration fits, but THIS frame has a value that cannot be
 * read (a card in motion, a hand ending). The automation refuses every such frame by itself; the check lists what was unreadable and asks
 * for another check during a hand. A region that is legitimately empty (no board card yet, no bet) is reported as empty, not as a failure.
 * Nothing here sends input, and nothing is guessed: an unreadable value is listed as unreadable, never filled in.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./coordinate-spaces.js'), require('./input-geometry.js'), require('./status-strip.js'));
  else root.WorkbenchRecognitionCheck = factory(root.WorkbenchCoordinateSpaces, root.WorkbenchInputGeometry, root.WorkbenchStatusStrip);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (CS, G, STRIP) {
  'use strict';
  const r3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? +v.toFixed(3) : null);
  const boxPx = (b, client) => (b ? { x: Math.floor(client.x + b.x * client.w), y: Math.floor(client.y + b.y * client.h), w: Math.round(b.w * client.w), h: Math.round(b.h * client.h) } : null);
  /** Methods whose image IS the client area at physical size (the host encodes exactly the client bitmap). */
  const EXACT_METHODS = Object.freeze(['print-window', 'screen-copy']);
  /** Observer refusals that mean the calibration does not fit the window (not a transient frame). */
  const LAYOUT_REFUSAL = /^(unrecognized-layout|ambiguous-layout|resolution-too-low|hero seat \d+ out of range)/;
  const CONTROLS = Object.freeze(['fold', 'check', 'call', 'raise', 'allin']);

  function compactReads(reads) {
    if (!reads) return null; const out = [];
    for (const c of reads.cards || []) out.push({ kind: 'card', field: c.field, accepted: !!c.accepted, value: c.label === undefined ? null : c.label, score: r3(c.score), margin: r3(c.margin) });
    for (const a of reads.amounts || []) out.push({ kind: 'amount', field: a.field, seat: a.seat === undefined ? null : a.seat, accepted: !!a.accepted, value: a.accepted ? a.value : null, confidence: r3(a.confidence), reason: a.accepted ? null : a.reason || null });
    for (const m of reads.markers || []) out.push({ kind: 'marker', field: m.field, seat: m.seat === undefined ? null : m.seat, present: !!m.present, confidence: r3(m.confidence) });
    return out;
  }

  /**
   * o: { frame: {image, bounds:{x,y,width,height}, dpiScale, frameId, method}, reader (ImageObserver, with .profiles and .seats),
   *      profile (platform profile: layout.controls / layout.statusStrip / layout.heroSeat, execution.controls / execution.amountField),
   *      table (registered table number), hwnd, title, heroSeat, monitor {bounds, scale} }
   */
  function verify(o) {
    const critical = [], notes = [], f = (o && o.frame) || {}, b = f.bounds || {}, client = { x: b.x, y: b.y, w: b.width, h: b.height };
    const method = f.method || null, exactMethod = method === null || EXACT_METHODS.includes(method);
    // 1. geometry: client rectangle, display scale (read from Windows), captured image = client area at physical size
    const geometry = CS.checkGeometry({ client, image: exactMethod ? f.image : null, dpiScale: f.dpiScale, monitor: o.monitor });
    for (const c of geometry.critical) critical.push('geometry: ' + c); for (const n of geometry.notes) notes.push('geometry: ' + n);
    if (!exactMethod) critical.push('geometry: capture method ' + method + ' returns the whole window, not the client area; the check (and recognition) needs print-window or screen-copy');
    if (!f.image) critical.push('capture: no image');
    // 2. calibration: every control the profile names must map to a clickable rectangle at THIS size (as the automation computes it)
    const prof = (o && o.profile) || {}, layout = prof.layout || {}, exe = prof.execution || {}, controls = { ...(layout.controls || {}), ...(exe.controls || {}) }, cal = {};
    for (const k of CONTROLS) {
      const box = controls[k]; if (!box) { if (k !== 'allin') { cal[k] = { ok: false, reason: 'not calibrated' }; critical.push('calibration: ' + k + ' not calibrated'); } continue; }
      const t = geometry.physical ? G.regionToScreen(box, client) : { ok: false, reason: 'client rectangle unknown' };
      cal[k] = t.ok ? { ok: true, normalized: { ...box }, rect: t.rect, point: t.point, full: t.full } : { ok: false, normalized: { ...box }, reason: t.reason };
      if (!t.ok) critical.push('calibration: ' + k + ': ' + t.reason);
    }
    if (exe.amountField) {
      const t = geometry.physical ? G.regionToScreen(exe.amountField, client) : { ok: false, reason: 'client rectangle unknown' };
      cal.wager = t.ok ? { ok: true, normalized: { ...exe.amountField }, rect: t.rect, point: t.point, full: t.full } : { ok: false, normalized: { ...exe.amountField }, reason: t.reason };
      if (!t.ok) critical.push('calibration: wager field: ' + t.reason);
    }
    // 3. status strip (the bundled test table draws one): which table and which seat this window shows - identity, safety-critical
    let strip = null, view = layout.heroSeat || 0;
    if (layout.statusStrip && f.image) {
      const s = STRIP.read(f.image); strip = s.ok ? { ok: true, table: s.table, viewSeat: s.viewSeat, revision: s.revision } : { ok: false, reason: s.reason };
      if (!s.ok) critical.push('status strip: ' + s.reason);
      else { view = s.viewSeat; if (o.table !== undefined && o.table !== null && s.table !== o.table) critical.push('status strip: the window shows table ' + s.table + ', registered as table ' + o.table); }
    }
    // 4. recognition of this frame, exactly as the automation reads it
    const reader = o && o.reader; let sel = null, rec = { ok: false, reasons: ['no image or no reader'], reads: null, ms: null, observation: null };
    if (f.image && reader) {
      sel = reader.profiles && reader.profiles.select ? reader.profiles.select(f.image, reader.seats) : null;
      const t0 = Date.now(), r = reader.observe(f.image, { heroSeat: o.heroSeat !== undefined ? o.heroSeat : view, capturedAt: Date.now() });
      rec = { ok: !!r.ok, reasons: r.reasons || [], ms: Date.now() - t0, observation: r.observation || null, reads: r.reads || null };
    }
    const layoutRefusals = rec.ok ? [] : rec.reasons.filter((x) => LAYOUT_REFUSAL.test(x));
    for (const x of layoutRefusals) critical.push('recognition: ' + x);
    if (!rec.ok && f.image && reader && !layoutRefusals.length) notes.push('recognition: this frame has ' + rec.reasons.length + ' unreadable value(s) - the automation refuses such a frame by itself; check again during a hand');
    if (!f.image || !reader) critical.push('recognition: not attempted (' + (!f.image ? 'no image' : 'no reader') + ')');
    const obs = rec.observation, L = sel && sel.profile ? sel.profile : null;
    const positions = L && geometry.physical ? {
      layout: L.id, board: (L.board || []).map((x) => boxPx(x, client)), hero: (L.hero || []).map((x) => boxPx(x, client)), pot: boxPx(L.pot, client), handId: boxPx(L.handId, client),
      seats: (L.seats || []).map((s) => ({ seat: s.seat, stack: boxPx(s.stack, client), bet: boxPx(s.bet, client) })), controls: L.controls ? Object.fromEntries(Object.entries(L.controls).map(([k, x]) => [k, boxPx(x, client)])) : null,
    } : null;
    const confidence = obs && obs.confidence ? { overall: r3(obs.confidence.overall), fields: Object.fromEntries(Object.entries(obs.confidence.fields || {}).map(([k, v]) => [k, r3(v)])) } : null;
    if (confidence) for (const [k, v] of Object.entries(confidence.fields)) if (v !== null && v < 0.9) notes.push('recognition: ' + k + ' confidence ' + v + ' (below 0.9)');
    const recognised = obs ? { layout: obs.layout, hand: obs.hand, street: obs.street, status: obs.status, board: obs.board, button: obs.button, actor: obs.actor, pot: obs.pot, heroSeat: obs.heroSeat, heroCards: (obs.seats[obs.heroSeat] || {}).cards || null,
      stacks: obs.seats.map((s) => s.stack), bets: obs.seats.map((s) => s.bet), folded: obs.seats.map((s) => s.folded), allIn: obs.seats.map((s) => s.allInMarker === undefined ? null : s.allInMarker), controls: obs.controls || null,
      callAmount: obs.callAmount === undefined ? null : obs.callAmount, minRaiseTo: obs.minRaiseTo === undefined ? null : obs.minRaiseTo, scale: r3(obs.scale) } : null;
    const reads = compactReads(rec.reads), unreadable = rec.ok ? [] : rec.reasons.slice(0, 12);
    const calibrationOk = Object.values(cal).every((c) => c.ok !== false), ok = critical.length === 0;
    const verdict = !ok ? 'fail' : rec.ok ? 'pass' : 'pass-frame-unreadable';
    return { format: 'eightmax-recognition-check', version: 1, at: new Date().toISOString(), verdict, ok, inputAllowed: ok,
      window: { table: o.table === undefined ? null : o.table, hwnd: o.hwnd || null, title: o.title || null, client: geometry.physical, scalePercent: geometry.scalePercent, logicalSize: geometry.logicalSize,
        captureMethod: method, frameId: f.frameId === undefined ? null : f.frameId, image: f.image ? { width: f.image.width, height: f.image.height } : null },
      calibration: { status: calibrationOk ? 'ok' : 'failed', controls: cal }, positions, strip,
      recognition: { ok: rec.ok, frameReadable: rec.ok, ms: rec.ms, layout: L ? L.id : null, templateScale: sel && sel.scale ? r3(sel.scale) : null, confidence, recognised, unreadable, reads,
        templates: reader && reader.calibratedWidths ? reader.calibratedWidths : null },
      critical, notes };
  }
  /** A report for a table whose window could not even be captured (the capture refusal is the critical failure). */
  function captureFailed({ table, hwnd, title, code, reason }) {
    return { format: 'eightmax-recognition-check', version: 1, at: new Date().toISOString(), verdict: 'fail', ok: false, inputAllowed: false,
      window: { table: table === undefined ? null : table, hwnd: hwnd || null, title: title || null, client: null, scalePercent: null, logicalSize: null, captureMethod: null, frameId: null, image: null },
      calibration: { status: 'not-checked', controls: {} }, positions: null, strip: null, recognition: { ok: false, frameReadable: false, ms: null, layout: null, templateScale: null, confidence: null, recognised: null, unreadable: [], reads: null, templates: null },
      critical: ['capture: ' + (code || 'capture-failed') + (reason ? ': ' + reason : '')], notes: [] };
  }
  /** One-line summary for the dashboard. */
  function summary(rep) {
    if (!rep) return 'not checked';
    const w = rep.window || {}, size = w.client ? w.client.w + 'x' + w.client.h + ' px at ' + w.scalePercent + ' %' : 'size unknown';
    if (rep.verdict === 'fail') return 'FAILED - automated input refused for this table until a check passes: ' + rep.critical.slice(0, 3).join('; ');
    const tail = (rep.notes.length ? '; ' + rep.notes.length + ' note(s)' : '');
    if (rep.verdict === 'pass-frame-unreadable') return 'PASS (calibration) - ' + size + '; controls fit; this frame was not fully readable (' + rep.recognition.unreadable.slice(0, 2).join('; ') + ') - check again during a hand' + tail;
    return 'PASS - ' + size + '; controls fit; read in ' + rep.recognition.ms + ' ms (lowest confidence ' + (rep.recognition.confidence ? rep.recognition.confidence.overall : '?') + ')' + tail;
  }
  return { verify, captureFailed, summary, EXACT_METHODS };
});
