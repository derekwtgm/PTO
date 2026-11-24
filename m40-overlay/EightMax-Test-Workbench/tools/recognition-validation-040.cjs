#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 4.0: RECOGNITION VALIDATION - how the recognition behaves at every table size and display
 * scaling the Milestone asks for, measured, not assumed.
 *
 *   node tools/recognition-validation-040.cjs [--frames 10] [--seed 4000] [--quick] [--out reports/recognition-validation-040.json]
 *       DETERMINISTIC DATASET (any platform): the bundled test table is rendered by its controlled renderer (exactly what the window draws)
 *       at the physical client width of an 800 / 960 / 1024 / 1280 / 1440 / 1920 px table at 100 / 125 / 150 / 175 / 200 % display
 *       scaling (23 distinct widths, up to 3840 px), in seeded game states (every street, folds, all-ins, eliminated seats, the hero to act
 *       or not), clean and degraded. Every frame is read with the reader the automation uses for that width (exact-width templates) and
 *       scored against the renderer's own ground truth, per feature: accuracy, false readings (accepted with a wrong value = FALSE
 *       POSITIVE), refusals (FALSE NEGATIVE: the value was there but not accepted - safe), confidence distributions of right and wrong
 *       readings, recognition time per width. Frame level: a frame the automation would act on (accepted) must have NO wrong value.
 *       Geometry: a DPI-virtualised capture (the image smaller than the physical client area) must be refused by Verify Table Recognition.
 *   node tools/recognition-validation-040.cjs --windows [--widths 1000,1200] [--steps 8] [--out ...]
 *       REAL WINDOWS (Windows): the desktop host and EightMaxTestTable.exe windows at those physical widths on the current display scaling;
 *       every capture goes through the host (PrintWindow), is checked by Verify Table Recognition and compared with the table's own state
 *       (fixture oracle); the strip-only capture is compared with the strip of the full frame. The table's state is advanced with the
 *       fixture's test control ('act'), so every street is seen. No input is sent by the Workbench.
 * Degradations (synthetic): clean; noise (+/-10 per channel); 1 px shift (a window moved by a pixel); 3x3 blur; dimmed (x0.85);
 * dpi-stretched (a DPI-UNAWARE simulator rendered at the logical size and bitmap-stretched by Windows to the physical size);
 * occluded (a tooltip-like box over one card, stack or the pot: that value must be refused, never guessed).
 */
const path = require('path'), fs = require('fs'), os = require('os');
const ROOT = path.join(__dirname, '..');
const FD = require(path.join(ROOT, 'src/fixture-dealer.js')), SC = require(path.join(ROOT, 'src/simulator-controls.js')), SP = require(path.join(ROOT, 'src/simulator-profiles.js'));
const RC = require(path.join(ROOT, 'src/recognition-check.js')), IC = require(path.join(ROOT, 'src/image-codec.js')), HS = require(path.join(ROOT, 'src/hand-state.js')), STRIP = require(path.join(ROOT, 'src/status-strip.js'));
const EM = require(path.join(ROOT, 'src/engine.js'));
const args = process.argv.slice(2), has = (k) => args.includes('--' + k), arg = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const LOGICAL = [800, 960, 1024, 1280, 1440, 1920], SCALES = [1, 1.25, 1.5, 1.75, 2], MAX_W = 3840;
const PROFILE = SP.fixtureProfile({ exeSha256: 'f'.repeat(64) });
const mono = () => Number(process.hrtime.bigint()) / 1e6;
const q = (xs, p) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))].toFixed(4); };
const mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }

/* ---------------- ground truth: exactly what the renderer draws (sim-display.js renderTable + status-strip.js) ---------------- */
function truthOf(d) {
  const t = d.t, snap = t.snapshot(), view = d.view, playing = t.status === 'playing', lg = playing && t.actor === view ? t.legal() : null;
  return { board: snap.board.slice(), hero: ((snap.players[view] || {}).cards || []).slice(), pot: snap.pot, hand: snap.hand, status: playing ? 'playing' : 'complete', button: t.dealer, actor: playing ? t.actor : -1,
    seats: snap.players.map((p) => ({ stack: p.stack, bet: p.bet, folded: !!p.folded, allIn: p.stack === 0 && !p.folded })),
    controls: lg ? { fold: lg.toCall > 0, check: lg.canCheck, call: lg.toCall > 0, raise: lg.canRaise } : { fold: false, check: false, call: false, raise: false },
    callAmount: lg && lg.toCall > 0 ? lg.callAmount : null, minRaiseTo: lg && lg.canRaise ? Math.min(lg.minRaiseTo, lg.maxRaiseTo) : null, strip: { table: d.id, viewSeat: view } };
}
/** Seeded game states of one table: random legal actions (folds, calls, raises, all-ins), every street, hands ending, eliminations. */
function* gameStates(seed, count) {
  const r = rng(seed), stacks = Array.from({ length: 8 }, (_, i) => (r() < 0.12 && i > 1 ? 0 : 200 + Math.floor(r() * 9800)));
  const d = new FD.TableDealer({ table: 1 + (seed % 10), seed, stacks, send: () => {} }); let made = 0, guard = 0, now = 1000;
  d.t.startHand(); d.playingView = true;
  while (made < count && guard++ < count * 60) {
    const t = d.t;
    if (t.status !== 'playing') { if (t.startHand() === false) { d.t.tournamentComplete = false; return; } continue; }
    const lg = t.legal(); if (!lg) { t.startHand(); continue; }
    if (r() < 0.45) { made++; yield d; }
    const x = r(); let type = 'call', amount = 0;
    if (lg.canCheck && x < 0.55) type = 'check'; else if (lg.toCall > 0 && x < 0.22) type = 'fold'; else if (lg.canRaise && x > 0.8) { type = 'raise'; amount = x > 0.96 ? lg.maxRaiseTo : Math.min(lg.maxRaiseTo, lg.minRaiseTo + Math.floor(r() * 4) * 50); } else if (lg.canCheck) type = 'check';
    try { t.execute(t.request(type, amount, now), now); } catch (e) { try { t.execute(t.request(lg.canCheck ? 'check' : 'fold', 0, now), now); } catch (e2) { t.startHand(); } }
    now += 400;
    if (t.status === 'complete' && r() < 0.5) { made++; yield d; }
  }
}
/** The frame the window shows for this state at w x h (the dealer's own frame(): renderer + status strip; the view is the seat to act). */
function frameOf(d, w, h, renderWidth) {
  d.w = w; d.h = h; d.view = d.t.status === 'playing' && d.t.actor >= 0 ? d.t.actor : d.view;
  if (!renderWidth) return d.frame();
  // dpi-stretched: the simulator draws at its logical size and Windows stretches the bitmap to the physical client area
  d.w = renderWidth; d.h = Math.round(renderWidth / 1.6); const small = d.frame(); d.w = w; d.h = h; return IC.resizeBilinear(small, w, h);
}

/* ---------------- degradations ---------------- */
const copy = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });
function noise(img, amp, seed) { const o = copy(img), r = rng(seed); for (let i = 0; i < o.data.length; i += 4) { const n = Math.round((r() * 2 - 1) * amp); o.data[i] += n; o.data[i + 1] += n; o.data[i + 2] += n; } return o; }
function shift(img, dx, dy) { const o = copy(img), W = img.width, H = img.height; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const sx = Math.min(W - 1, Math.max(0, x - dx)), sy = Math.min(H - 1, Math.max(0, y - dy)), k = (y * W + x) * 4, s = (sy * W + sx) * 4; o.data[k] = img.data[s]; o.data[k + 1] = img.data[s + 1]; o.data[k + 2] = img.data[s + 2]; o.data[k + 3] = 255; } return o; }
function blur(img) { const o = copy(img), W = img.width, H = img.height, d = img.data; for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) for (let c = 0; c < 3; c++) { let s = 0; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) s += d[((y + j) * W + x + i) * 4 + c]; o.data[(y * W + x) * 4 + c] = Math.round(s / 9); } return o; }
function dim(img, f) { const o = copy(img); for (let i = 0; i < o.data.length; i += 4) { o.data[i] *= f; o.data[i + 1] *= f; o.data[i + 2] *= f; } return o; }
/** A light-grey box with dark text-like stripes over one region (box in 0..1 of the client area), as a tooltip or another window would be. */
function occlude(img, box, seed) {
  const o = copy(img), W = img.width, H = img.height, r = rng(seed), x0 = Math.max(0, Math.floor(box.x * W) - 2), y0 = Math.max(0, Math.floor(box.y * H) - 2), x1 = Math.min(W, Math.ceil((box.x + box.w) * W) + 2), y1 = Math.min(H, Math.ceil((box.y + box.h) * H) + 2);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = (y * W + x) * 4, stripe = ((y - y0) % 6) < 2 && r() < 0.7; const v = stripe ? 40 : 225; o.data[k] = v; o.data[k + 1] = v; o.data[k + 2] = v; }
  return o;
}

/* ---------------- scoring ---------------- */
const FEATURES = ['board', 'hero', 'pot', 'hand', 'stack', 'bet', 'folded', 'button', 'actor', 'allIn', 'controls', 'callAmount', 'minRaise', 'status', 'strip'];
function newScore() { const o = {}; for (const f of FEATURES) o[f] = { n: 0, correct: 0, wrong: 0, refused: 0, confRight: [], confWrong: [] }; return o; }
function note(s, f, verdict, conf) { const x = s[f]; x.n++; x[verdict]++; if (typeof conf === 'number' && Number.isFinite(conf)) (verdict === 'correct' ? x.confRight : verdict === 'wrong' ? x.confWrong : []).push(conf); }
const cardInt = (label) => { try { return HS.cardFromString(label); } catch (e) { return NaN; } };
/** Field-level scoring from the reader's per-field reads (also in frames the reader refused as a whole). */
function scoreReads(score, reads, truth, occludedField) {
  const out = { wrong: [], refusedTruth: 0 }; if (!reads) return out;
  let b = 0, h = 0;
  for (const c of reads.cards || []) {
    const f = c.field === 'board' ? 'board' : 'hero', want = f === 'board' ? truth.board[b++] : truth.hero[h++]; if (want === undefined) continue;
    if (!c.accepted) note(score, f, 'refused', c.score); else if (cardInt(c.label) === want) note(score, f, 'correct', c.score); else { note(score, f, 'wrong', c.score); out.wrong.push(f + ' ' + c.label); }
  }
  for (const a of reads.amounts || []) {
    let f = a.field, want;
    if (f === 'pot') want = truth.pot; else if (f === 'hand') want = truth.hand; else if (f === 'stack') want = truth.seats[a.seat] && truth.seats[a.seat].stack; else if (f === 'bet') want = truth.seats[a.seat] && truth.seats[a.seat].bet;
    else if (f === 'callAmount') want = truth.callAmount; else if (f === 'minRaise') want = truth.minRaiseTo; else continue;
    if (want === undefined || want === null) continue;
    if (!a.accepted) note(score, f, 'refused', a.confidence); else if (a.value === want) note(score, f, 'correct', a.confidence); else { note(score, f, 'wrong', a.confidence); out.wrong.push(f + (a.seat !== undefined ? ' seat ' + a.seat : '') + ' ' + a.value + ' (truth ' + want + ')'); }
  }
  for (const m of reads.markers || []) {
    if (m.field === 'folded') { const want = truth.seats[m.seat] && truth.seats[m.seat].folded; if (want === undefined) continue; note(score, 'folded', m.present === want ? 'correct' : 'wrong', m.confidence); if (m.present !== want) out.wrong.push('folded seat ' + m.seat); }
    else if (/^control-/.test(m.field)) { const k = m.field.slice(8), want = truth.controls[k]; note(score, 'controls', m.present === want ? 'correct' : 'wrong', m.confidence); if (m.present !== want) out.wrong.push(m.field); }
  }
  return out;
}
/** Frame-level comparison of an ACCEPTED observation with the truth: every value the automation would use. */
function compareObservation(score, obs, truth, strip) {
  const wrong = [], eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const chk = (f, ok, what) => { note(score, f, ok ? 'correct' : 'wrong'); if (!ok) wrong.push(what); };
  chk('status', obs.status === truth.status, 'status ' + obs.status); chk('button', obs.button === truth.button, 'button ' + obs.button); chk('actor', obs.actor === truth.actor, 'actor ' + obs.actor);
  chk('board', eq(obs.board, truth.board), 'board'); const hc = (obs.seats[obs.heroSeat] || {}).cards; if (truth.hero.length === 2) chk('hero', eq(hc, truth.hero), 'hero cards');
  chk('pot', obs.pot === truth.pot, 'pot ' + obs.pot); chk('hand', obs.hand === truth.hand, 'hand ' + obs.hand);
  obs.seats.forEach((s, i) => { const t = truth.seats[i]; chk('stack', s.stack === t.stack, 'stack ' + i); chk('bet', s.bet === t.bet, 'bet ' + i); chk('folded', s.folded === t.folded, 'folded ' + i); if (s.allInMarker !== undefined) chk('allIn', s.allInMarker === t.allIn, 'all-in ' + i); });
  if (truth.status === 'playing') { chk('controls', eq(obs.controls, truth.controls), 'controls'); if (truth.callAmount !== null) chk('callAmount', obs.callAmount === truth.callAmount, 'call ' + obs.callAmount); if (truth.minRaiseTo !== null) chk('minRaise', obs.minRaiseTo === truth.minRaiseTo, 'min raise ' + obs.minRaiseTo); }
  if (strip) chk('strip', strip.ok && strip.table === truth.strip.table && strip.viewSeat === truth.strip.viewSeat, 'strip');
  return wrong;
}
function summarise(score) {
  const out = {}; for (const [f, x] of Object.entries(score)) { if (!x.n) continue; const acc = x.correct + x.wrong;
    out[f] = { readings: x.n, correct: x.correct, falsePositives: x.wrong, falseNegatives: x.refused, accuracy: +(x.correct / x.n).toFixed(5), precision: acc ? +(x.correct / acc).toFixed(5) : null,
      confidenceCorrect: x.confRight.length ? { min: q(x.confRight, 0), p01: q(x.confRight, 0.01), p05: q(x.confRight, 0.05), p50: q(x.confRight, 0.5) } : null, confidenceWrongMax: x.confWrong.length ? Math.max(...x.confWrong) : null }; }
  return out;
}
function histogram(xs) { const bins = {}; for (const v of xs) { const b = v >= 1 ? '1.00' : (Math.floor(v * 20) / 20).toFixed(2); bins[b] = (bins[b] || 0) + 1; } return Object.fromEntries(Object.entries(bins).sort()); }

/* ---------------- synthetic dataset ---------------- */
function sizes(quick) {
  const map = new Map(); for (const L of LOGICAL) for (const s of SCALES) { const w = Math.round(L * s); if (w > MAX_W) continue; if (!map.has(w)) map.set(w, []); map.get(w).push({ logical: L, scale: s }); }
  let list = [...map.entries()].sort((a, b) => a[0] - b[0]).map(([w, combos]) => ({ w, h: Math.round(w / 1.6), combos }));
  if (quick) list = list.filter((x) => [800, 1000, 1200, 1920, 2400].includes(x.w)); return list;
}
function synthetic() {
  const frames = Number(arg('frames', has('quick') ? '4' : '10')), seed0 = Number(arg('seed', '4000')), t0 = mono();
  const all = newScore(), perDeg = {}, perSize = [], frameStats = { total: 0, accepted: 0, refused: 0, acceptedWithWrongValue: 0, refusalReasons: {}, examplesOfWrong: [] };
  const geometry = { dpiVirtualisedCaptures: 0, refusedAsCritical: 0, verifyCleanPass: 0, verifyClean: 0, verifyFails: [] }, confAll = { correct: [], wrong: [] };
  const DEG = ['clean', 'noise', 'shift-1px', 'blur', 'dim', 'occluded'];
  for (const sz of sizes(has('quick'))) {
    const tc = mono(), reader = SC.tableReader(1, 8, sz.w), calMs = mono() - tc, L = reader.profiles.select({ width: sz.w, height: sz.h }, 8).profile;
    const sc = { width: sz.w, height: sz.h, combos: sz.combos, templateMs: Math.round(calMs), frames: 0, accepted: 0, acceptedWithWrongValue: 0, recognitionMs: [], perDegradation: {} };
    let k = 0;
    for (const d of gameStates(seed0 + sz.w, frames)) {
      const truth0 = truthOf(d), clean = frameOf(d, sz.w, sz.h), truth = truthOf(d);
      void truth0;
      const variants = DEG.map((id) => ({ id, img: id === 'clean' ? clean : id === 'noise' ? noise(clean, 10, k + 1) : id === 'shift-1px' ? shift(clean, 1, 1) : id === 'blur' ? blur(clean) : id === 'dim' ? dim(clean, 0.85) : null }));
      // occluded: one sensitive field (a hero card, a board card, the pot or a stack) under a tooltip-like box - it must never be guessed
      const targets = [L.hero[0], L.hero[1], L.pot, L.seats[(k + 2) % 8].stack].concat(truth.board.length ? [L.board[0]] : []), target = targets[k % targets.length];
      variants[variants.length - 1].img = occlude(clean, target, k + 7); variants[variants.length - 1].target = target;
      // dpi-stretched: one variant per scaling > 100 % that gives this physical width (a DPI-unaware simulator, bitmap-stretched)
      for (const c of sz.combos) if (c.scale > 1) variants.push({ id: 'dpi-stretched', img: frameOf(d, sz.w, sz.h, c.logical), combo: c });
      for (const v of variants) {
        const r0 = mono(), r = reader.observe(v.img, { heroSeat: truth.strip.viewSeat, capturedAt: 1 }), ms = mono() - r0, strip = STRIP.read(v.img);
        const deg = perDeg[v.id] = perDeg[v.id] || { score: newScore(), frames: 0, accepted: 0, acceptedWithWrongValue: 0 }, sd = sc.perDegradation[v.id] = sc.perDegradation[v.id] || { frames: 0, accepted: 0, acceptedWithWrongValue: 0 };
        frameStats.total++; sc.frames++; deg.frames++; sd.frames++; if (v.id === 'clean') sc.recognitionMs.push(ms);
        const fieldWrong = scoreReads(all, r.reads, truth); scoreReads(deg.score, r.reads, truth);
        for (const c of (r.reads && r.reads.cards) || []) if (c.accepted) (fieldWrong.wrong.some((w) => w.includes(c.label)) ? confAll.wrong : confAll.correct).push(c.score);
        if (r.ok) {
          frameStats.accepted++; sc.accepted++; deg.accepted++; sd.accepted++;
          const wrong = compareObservation(newScore(), r.observation, truth, strip);
          if (wrong.length) { frameStats.acceptedWithWrongValue++; sc.acceptedWithWrongValue++; deg.acceptedWithWrongValue++; sd.acceptedWithWrongValue++; if (frameStats.examplesOfWrong.length < 20) frameStats.examplesOfWrong.push({ width: sz.w, degradation: v.id, wrong: wrong.slice(0, 5) }); }
        } else { frameStats.refused++; const why = (r.reasons[0] || 'refused').replace(/\d+(\.\d+)?/g, 'N'); frameStats.refusalReasons[why] = (frameStats.refusalReasons[why] || 0) + 1; }
      }
      // Verify Table Recognition on the clean frame at each scaling that gives this width; and a DPI-virtualised capture (image at the
      // logical size, client area physical) at each scaling > 100 %: it must be refused as safety-critical
      for (const c of sz.combos) {
        const client = { x: 0, y: 0, w: sz.w, h: sz.h };
        const rep = RC.verify({ frame: { image: clean, bounds: { x: 0, y: 0, width: sz.w, height: sz.h }, dpiScale: c.scale, method: 'print-window' }, reader, profile: PROFILE, table: truth.strip.table });
        geometry.verifyClean++; if (rep.verdict !== 'fail') geometry.verifyCleanPass++; else if (geometry.verifyFails.length < 10) geometry.verifyFails.push({ width: sz.w, scale: c.scale, critical: rep.critical.slice(0, 3) });
        if (c.scale > 1) {
          const lw = c.logical, lh = Math.round(lw / 1.6), small = IC.resizeBilinear(clean, lw, lh);
          const v = RC.verify({ frame: { image: small, bounds: { x: 0, y: 0, width: client.w, height: client.h }, dpiScale: c.scale, method: 'print-window' }, reader, profile: PROFILE, table: truth.strip.table });
          geometry.dpiVirtualisedCaptures++; if (v.verdict === 'fail' && v.critical.some((x) => /scaled capture/.test(x))) geometry.refusedAsCritical++;
        }
      }
      k++;
    }
    sc.recognitionMs = { n: sc.recognitionMs.length, mean: mean(sc.recognitionMs), p95: q(sc.recognitionMs, 0.95), max: sc.recognitionMs.length ? +Math.max(...sc.recognitionMs).toFixed(2) : null };
    perSize.push(sc); process.stdout.write('  ' + sz.w + 'x' + sz.h + ': ' + sc.frames + ' frames, ' + sc.accepted + ' accepted, wrong in accepted ' + sc.acceptedWithWrongValue + ', recognition ' + sc.recognitionMs.mean + ' ms (clean)\n');
  }
  const perDegradation = Object.fromEntries(Object.entries(perDeg).map(([id, x]) => [id, { frames: x.frames, accepted: x.accepted, acceptanceRate: +(x.accepted / x.frames).toFixed(4), acceptedWithWrongValue: x.acceptedWithWrongValue, features: summarise(x.score) }]));
  return { mode: 'synthetic', dataset: { seed: seed0, framesPerSize: frames, logicalWidths: LOGICAL, scales: SCALES, physicalWidths: perSize.map((x) => x.width), degradations: DEG.concat(['dpi-stretched']), renderer: 'src/sim-display.js renderTable (the bundled test table draws exactly this) + src/status-strip.js', reader: 'SimulatorControls.tableReader (exact-width templates), as in automated play' },
    frames: { ...frameStats, acceptanceRate: +(frameStats.accepted / frameStats.total).toFixed(4) }, features: summarise(all), perDegradation, perSize,
    confidence: { cardScoresCorrect: histogram(confAll.correct), cardScoresWrong: histogram(confAll.wrong) },
    geometry: { ...geometry, verifyCleanPassRate: geometry.verifyClean ? +(geometry.verifyCleanPass / geometry.verifyClean).toFixed(4) : null, dpiVirtualisedRefusalRate: geometry.dpiVirtualisedCaptures ? +(geometry.refusedAsCritical / geometry.dpiVirtualisedCaptures).toFixed(4) : null },
    durationMs: Math.round(mono() - t0) };
}

/* ---------------- real windows (Windows) ---------------- */
async function windows() {
  const M2 = require(path.join(ROOT, 'tools/lifecycle-acceptance-0362m2.cjs')), env = await M2.windowsEnv(), out = { mode: 'windows', machine: { release: os.release(), cpus: os.cpus().length, cpu: os.cpus()[0] && os.cpus()[0].model }, monitors: env.facts.monitors, tables: [] };
  const widths = (arg('widths', '') || '').split(',').filter(Boolean).map(Number), steps = Number(arg('steps', '8')), all = newScore();
  try {
    const mon = (env.facts.monitors || [])[0] || {}, scale = mon.dpiScale || 1, desk = mon.bounds || { w: 1920, h: 1080 };
    const list = widths.length ? widths : LOGICAL.map((L) => Math.round(L * scale)).filter((w) => w + 40 <= desk.w && Math.round(w / 1.6) + 80 <= desk.h);
    out.displayScale = scale; out.desktop = desk; out.widthsTested = list;
    for (const w of list) {
      const fx = env.fixture(1, { width: w, layout: 'grid', stackChips: 5000, seed: w }), tables = await fx.ready(), tb = tables[0];
      const rec = { width: w, requestedWidth: w, client: tb.client, steps: [], verify: [], stripCropMatches: 0, stripCropChecks: 0, capture: [] };
      try {
        const cap = new SC.HostWindowCapture(env.api, { hwnd: tb.hwnd, pid: tb.pid, title: 'EightMax Test Table' }, { method: 'print-window' }); await cap.open();
        const reader = SC.tableReader(tb.table, 8, tb.client.w);
        for (let i = 0; i < steps; i++) {
          await new Promise((r) => setTimeout(r, 350)); const g = await cap.grab(); if (!g.ok) { rec.steps.push({ ok: false, code: g.code }); continue; } rec.capture.push(g.captureMs);
          const rep = RC.verify({ frame: { image: g.image, bounds: g.bounds, dpiScale: g.dpiScale, frameId: g.frameId, method: g.method }, reader, profile: PROFILE, table: tb.table, hwnd: tb.hwnd, title: g.title });
          rec.verify.push({ verdict: rep.verdict, critical: rep.critical.slice(0, 3), scalePercent: rep.window.scalePercent, client: rep.window.client, image: rep.window.image, ms: rep.recognition.ms });
          const orc = (await fx.oracle(false)).find((o) => o.table === tb.table), s = orc && orc.state, strip = STRIP.read(g.image);
          if (rep.recognition.recognised && s && strip.ok && strip.revision === (orc.rev & 0xffff)) {   // the frame shows the dealer's current state
            const r = rep.recognition.recognised, chk = (f, ok) => note(all, f, ok ? 'correct' : 'wrong');
            chk('pot', r.pot === s.pot); chk('hand', r.hand === s.hand); chk('button', r.button === s.dealer); chk('actor', r.actor === (s.status === 'playing' ? s.actor : -1));
            r.stacks.forEach((v, k) => chk('stack', v === s.stacks[k])); r.bets.forEach((v, k) => chk('bet', v === s.bets[k])); r.folded.forEach((v, k) => chk('folded', v === s.folded[k])); chk('strip', strip.table === tb.table);
          }
          // the strip-only capture (Milestone 4.0 revalidation / confirmation polls) reads the same as the full frame
          const region = STRIP.regionPx(g.bounds.width, g.bounds.height), gc = await cap.grab({ region });
          if (gc.ok && gc.crop) { const sc2 = STRIP.readCrop(gc.image, gc.crop, { width: g.bounds.width, height: g.bounds.height }), sf = STRIP.read(g.image); rec.stripCropChecks++; if (sc2.ok && sf.ok && sc2.table === sf.table && sc2.viewSeat === sf.viewSeat) rec.stripCropMatches++; }
          rec.steps.push({ ok: true, verdict: rep.verdict, street: rep.recognition.recognised ? rep.recognition.recognised.street : null, compared: !!(rep.recognition.recognised && s && strip.ok && strip.revision === (orc.rev & 0xffff)), stripRevision: strip.ok ? strip.revision : null, dealerRevision: orc ? orc.rev : null });
          const lg = orc && orc.state && orc.state.status === 'playing' ? orc : null; if (lg) { const ctl = (rep.recognition.recognised && rep.recognition.recognised.controls) || {}; await fx.act(tb.table, ctl.check ? 'check' : 'call').catch(() => null); }
        }
      } finally { await fx.stop(); }
      rec.capture = { n: rec.capture.length, mean: mean(rec.capture), p95: q(rec.capture, 0.95) }; out.tables.push(rec);
      console.log('  ' + w + ' px: ' + rec.verify.filter((v) => v.verdict === 'pass').length + '/' + rec.verify.length + ' checks PASS, strip crop = full frame ' + rec.stripCropMatches + '/' + rec.stripCropChecks);
    }
  } finally { await env.stop(); }
  out.features = summarise(all); return out;
}

async function main() {
  const OUT = arg('out', path.join(ROOT, 'reports', 'recognition-validation-040' + (has('windows') ? '-windows' : '') + '.json'));
  console.log('EightMax 0.36.2 Milestone 4.0 recognition validation (' + (has('windows') ? 'real windows' : 'deterministic dataset') + ')');
  const res = has('windows') ? await windows() : synthetic();
  const doc = { format: 'eightmax-recognition-validation', version: 1, app: EM.VERSION, milestone: '0.36.2-milestone-4.0', at: new Date().toISOString(), tool: 'tools/recognition-validation-040.cjs', node: process.version, platform: process.platform, ...res };
  if (res.mode === 'synthetic') doc.verdict = { acceptedFramesWithAWrongValue: res.frames.acceptedWithWrongValue, neverGuessed: res.frames.acceptedWithWrongValue === 0, cleanFramesAllAccepted: res.perDegradation.clean ? res.perDegradation.clean.accepted === res.perDegradation.clean.frames : null, dpiVirtualisedCapturesAllRefused: res.geometry.refusedAsCritical === res.geometry.dpiVirtualisedCaptures, verifyCleanAllPass: res.geometry.verifyCleanPass === res.geometry.verifyClean };
  fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  if (doc.verdict) console.log('verdict: ' + JSON.stringify(doc.verdict));
  console.log('-> ' + OUT); const bad = doc.verdict && (!doc.verdict.neverGuessed || !doc.verdict.dpiVirtualisedCapturesAllRefused || !doc.verdict.verifyCleanAllPass || doc.verdict.cleanFramesAllAccepted === false);
  process.exitCode = bad ? 1 : 0;
}
if (require.main === module) main().catch((e) => { console.error(e.stack); process.exitCode = 1; });
module.exports = { truthOf, gameStates, frameOf, sizes };
