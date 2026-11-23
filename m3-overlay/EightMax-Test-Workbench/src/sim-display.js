/* EightMax Test Workbench 0.24: display of the OFFLINE CONTROLLED POKER CLIENT.
 *
 * Deterministic renderer that draws a simulator table the way a client window would show it (cards,
 * numerals, markers, action controls) so the screen-capture -> recognition path can be exercised end to
 * end without any third-party poker client. Nearest-neighbour scaling, optional pixel noise, resampling,
 * hero-seat rotation (each of the eight seats has its own view). This is a synthetic display: accuracy
 * measured on it is SYNTHETIC accuracy and says nothing about a real poker client.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vision.js'), require('./vision-ocr.js'), require('./hand-state.js'), require('./image-codec.js'));
  else root.WorkbenchSimDisplay = factory(root.WorkbenchVision, root.WorkbenchVisionOcr, root.WorkbenchHandState, root.WorkbenchImageCodec);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (V, O, HS, IC) {
  'use strict';

  const FONT = { 0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111', 3: '11110000010000101110000010000111110', 4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110', 6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110', 9: '01110100011000101111000010001001100' };
  const layoutCache = new Map(), layoutFor = (n, v2) => { const k = n + (v2 ? 'v2' : 'v1'); if (!layoutCache.has(k)) layoutCache.set(k, v2 ? O.defaultLayoutV2(n) : O.defaultLayout(n)); return layoutCache.get(k); };

  function makeImage(w, noise, seed, aspect = 1.6) {
    const h = Math.round(w / aspect), d = new Uint8ClampedArray(w * h * 4); let s = seed >>> 0 || 1;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    for (let i = 0; i < w * h; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 40; d[i * 4 + 3] = 255; }
    const px = (x, y, v) => { if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; };
    const rect = (b, v) => { for (let y = Math.floor(b.y * h); y < Math.ceil((b.y + b.h) * h); y++) for (let x = Math.floor(b.x * w); x < Math.ceil((b.x + b.w) * w); x++) px(x, y, v); };
    const text = (b, str) => {
      const bx = Math.floor(b.x * w), by = Math.floor(b.y * h), bw = Math.ceil(b.w * w), bh = Math.ceil(b.h * h), cw = Math.max(5, Math.floor(bw / 8)), ch = Math.max(7, Math.floor(bh * 0.9));
      for (let k = 0; k < str.length; k++) for (let y = 0; y < ch; y++) for (let x = 0; x < cw - 1; x++) { const fx = Math.floor(x * 5 / (cw - 1)), fy = Math.floor(y * 7 / ch); if (FONT[str[k]][fy * 5 + fx] === '1') px(bx + k * cw + x, by + y, 235); }
    };
    const card = (b, id) => {
      rect(b, 225); let bits = (BigInt(id + 1) * 0x9E3779B97F4A7C15n) & ((1n << 48n) - 1n);
      const bx = b.x * w, by = b.y * h, bw = b.w * w, bh = b.h * h;
      for (let gy = 0; gy < 8; gy++) for (let gx = 0; gx < 6; gx++) { if ((bits >> BigInt(gy * 6 + gx)) & 1n) { const x0 = Math.floor(bx + (gx + 0.5) * bw / 7), x1 = Math.floor(bx + (gx + 1.5) * bw / 7), y0 = Math.floor(by + (gy + 0.5) * bh / 9), y1 = Math.floor(by + (gy + 1.5) * bh / 9); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px(x, y, 20); } }
      rect({ x: b.x + b.w * 0.05, y: b.y + b.h * 0.02, w: b.w * 0.9, h: b.h * 0.03 }, 20);
    };
    const finish = () => { if (noise) for (let i = 0; i < w * h; i++) { const n = Math.round((rnd() - 0.5) * 2 * noise); for (let c = 0; c < 3; c++) d[i * 4 + c] = Math.max(0, Math.min(255, d[i * 4 + c] + n)); } return { width: w, height: h, data: d }; };
    return { rect, text, card, finish };
  }

  /**
   * Render a simulator table as seen from `opt.heroSeat` (default 0). Display position p shows table seat (p + heroSeat) % seats (2-8 seats since 0.27).
   * `opt.v2` selects the 0.24 layout (hand id, all-in markers, action controls, call / minimum-raise numerals, hand-over banner).
   */
  function renderTable(t, w = 960, opt = {}) {
    const nSeats = t.snapshot().players.length, L = opt.layout || layoutFor(nSeats, !!opt.v2), v2 = !!L.controls; // 0.25: opt.layout lets calibration tests draw a layout the profile has never seen
    // 0.29: opt.seatMap (one entry per LAYOUT position) places the engine's players on a larger table: a number is an engine player
    // index (increasing around the table), 'vacant' is an empty position, { sittingOut: chips } a player who is not dealt in.
    const map = opt.seatMap || null, Ls = L.seats.length;
    if (map) { if (map.length !== Ls) throw new Error('seatMap needs one entry per layout seat'); const idx = map.filter((x) => typeof x === 'number'); if (idx.length !== nSeats || idx.some((x, i) => x !== i)) throw new Error('seatMap must list engine players 0..' + (nSeats - 1) + ' in table order'); if (!L.seatStates) throw new Error('seatMap needs a seat-state layout'); }
    else if (Ls !== nSeats) throw new Error('layout has ' + Ls + ' seats, table has ' + nSeats);
    const hero = map ? map.indexOf(opt.heroSeat || 0) : (opt.heroSeat || 0);
    const baseW = opt.renderWidth || w, im = makeImage(baseW, opt.noise || 0, opt.seed || 7), snap = t.snapshot(), at = (p) => map ? map[(p + hero) % Ls] : (p + hero) % nSeats;
    im.text(L.pot, String(snap.pot));
    snap.board.forEach((c, i) => im.card(L.board[i], c));
    L.seats.forEach((s, p) => {
      const q = at(p);
      if (q === 'vacant') { im.rect(s.vacant, 255); return; }
      if (q && typeof q === 'object') { im.rect(s.sittingOut, 255); im.text(s.stack, String(q.sittingOut)); return; }
      const pl = snap.players[q]; im.text(s.stack, String(pl.stack)); if (pl.bet > 0) im.text(s.bet, String(pl.bet));
      if (pl.folded) im.rect(s.folded, 255); if (t.dealer === q) im.rect(s.button, 255); if (t.actor === q && t.status === 'playing') im.rect(s.active, 255);
      if (v2 && pl.stack === 0 && !pl.folded) im.rect(s.allin, 255);
    });
    if (!opt.hideHero && typeof at(0) === 'number') snap.players[at(0)].cards.forEach((c, i) => im.card(L.hero[i], c));
    if (v2) {
      im.text(L.handId, String(snap.hand));
      if (t.status === 'complete') im.rect(L.handOver, 255);
      const lg = t.legal && t.status === 'playing' && t.actor === (map ? map[hero] : hero) ? t.legal() : null;
      if (lg && !opt.hideControls) {
        const on = { fold: lg.toCall > 0, check: lg.canCheck, call: lg.toCall > 0, raise: lg.canRaise };
        for (const k of ['fold', 'check', 'call', 'raise']) im.rect(L.controls[k], on[k] ? 255 : 50);
        if (lg.toCall > 0) im.text(L.callAmount, String(lg.callAmount));
        if (lg.canRaise) im.text(L.minRaise, String(Math.min(lg.minRaiseTo, lg.maxRaiseTo)));
      } else for (const k of ['fold', 'check', 'call', 'raise']) im.rect(L.controls[k], 50);
    }
    let img = im.finish();
    if (opt.renderWidth && opt.renderWidth !== w) img = IC.resizeBilinear(img, w, Math.round(w / 1.6));
    return img;
  }

  /** Calibrate glyph and card templates from clean renders at each supported width. */
  function calibrate(widths = [800, 960, 1440, 1920], layout = layoutFor(8, false)) {
    const profiles = new O.ProfileSet().add(layout), cards = new O.CardTemplates(), glyphs = new O.GlyphTemplates();
    for (const w of widths) {
      // 0.36.2 M3: card templates from EVERY card slot (board and hero), not only the first board slot. The slots sit at different
      // sub-pixel offsets; at 800 px four cards drawn in the turn slot (5h, 6c, 8s, Td) correlated only 0.883-0.892 with the slot-0
      // template, under the 0.9 reading threshold, so a table showing one of them on the turn could not be read for the rest of the hand
      // (found on the Windows CI runner, run 45203097931: scenarios J, T2, M1, M5 paused). Each card is drawn once per width in all slots
      // (the slots do not overlap); a pattern identical to one already added for that card is skipped.
      const cardBoxes = layout.board.concat(layout.hero || []);
      for (let c = 0; c < 52; c++) {
        const m = makeImage(w, 0, 1); for (const box of cardBoxes) m.card(box, c); const img = m.finish(), seen = new Set();
        for (const box of cardBoxes) { const n = V.normalize(img, box), key = n.pixels.map((x) => Math.round(x * 1000)).join(','); if (seen.has(key)) continue; seen.add(key); cards.add(HS.cardToString(c), n); }
      }
      // Digit templates are taken from every kind of numeral box the layout uses (their pixel grids differ by a pixel or two).
      const boxes = [layout.pot, layout.seats[0].stack, layout.seats[0].bet, layout.seats[Math.min(3, layout.seats.length - 1)].bet]; if (layout.seats.length !== 8) for (const s of layout.seats) boxes.push(s.stack, s.bet);   // 0.27: other seat counts have other sub-pixel positions, so every numeral box contributes templates (8 seats: unchanged) if (layout.handId) boxes.push(layout.handId, layout.callAmount, layout.minRaise);
      for (const box of boxes) for (let dgt = 0; dgt < 10; dgt++) { const m = makeImage(w, 0, 1); m.text(box, String(dgt) + String((dgt + 1) % 10)); const img = m.finish(); const seg = O.segmentGlyphs(img, box); if (seg.glyphs.length < 2) continue; glyphs.add(String(dgt), O.glyphPixels(img, seg.glyphs[0], seg.inkIsDark)); glyphs.add(String((dgt + 1) % 10), O.glyphPixels(img, seg.glyphs[1], seg.inkIsDark)); }
    }
    return { profiles, cards, glyphs };
  }

  const seatStateLayoutFor = (n) => { const k = n + 'ss'; if (!layoutCache.has(k)) layoutCache.set(k, O.withSeatStates(O.defaultLayoutV2(n))); return layoutCache.get(k); };
  return { FONT, L: layoutFor(8, false), L2: layoutFor(8, true), layoutFor, seatStateLayoutFor, makeImage, renderTable, calibrate };
});
