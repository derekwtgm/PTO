/* EightMax Test Workbench 0.36.2 Milestone 4.0: COORDINATE SPACES - the five spaces a click target and a reading pass through, kept apart.
 *
 *   physical    screen pixels of the virtual desktop (what the per-monitor-DPI-aware host, input driver and test table use; SendInput
 *               absolute coordinates are derived from it; negative values on monitors left of / above the primary are normal)
 *   logical     what a DPI-UNAWARE program sees: physical / monitor scale, relative to the monitor origin (Windows virtualises them)
 *   client      pixels of the window's client area, origin at its top-left corner (physical size)
 *   capture     pixels of a captured image of the client area (equal to client pixels when the capture is DPI aware and full size; a
 *               scaled image - e.g. a capture taken by a DPI-unaware process at 125 % - is detected, never silently stretched)
 *   normalized  0..1 fractions of the client area (calibration profiles and control regions; independent of size and scaling)
 * The display scale is READ from the system (GetDpiForWindow / GetDpiForMonitor, reported by the host and the driver); it is never
 * inferred from the screen resolution. A conversion that would need a guess (unknown scale, a capture whose size does not match the
 * client area) is refused with a reason.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WorkbenchCoordinateSpaces = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SPACES = Object.freeze(['physical', 'logical', 'client', 'capture', 'normalized']);
  const STANDARD_SCALES = Object.freeze([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3, 3.5]);
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const isRect = (r) => r && fin(r.x) && fin(r.y) && fin(r.w) && fin(r.h) && r.w > 0 && r.h > 0;
  /** Monitor in physical pixels: {bounds:{x,y,w,h}, scale}. Logical coordinates are relative to its own origin (per-monitor virtualisation). */
  function physicalToLogical(p, monitor) {
    if (!monitor || !isRect(monitor.bounds) || !(monitor.scale > 0)) return { ok: false, reason: 'monitor bounds or scale unknown' };
    return { ok: true, x: monitor.bounds.x + (p.x - monitor.bounds.x) / monitor.scale, y: monitor.bounds.y + (p.y - monitor.bounds.y) / monitor.scale };
  }
  function logicalToPhysical(l, monitor) {
    if (!monitor || !isRect(monitor.bounds) || !(monitor.scale > 0)) return { ok: false, reason: 'monitor bounds or scale unknown' };
    return { ok: true, x: Math.round(monitor.bounds.x + (l.x - monitor.bounds.x) * monitor.scale), y: Math.round(monitor.bounds.y + (l.y - monitor.bounds.y) * monitor.scale) };
  }
  const physicalToClient = (p, client) => ({ x: p.x - client.x, y: p.y - client.y });
  const clientToPhysical = (c, client) => ({ x: client.x + c.x, y: client.y + c.y });
  const clientToNormalized = (c, client) => ({ x: c.x / client.w, y: c.y / client.h });
  const normalizedToClient = (n, client) => ({ x: n.x * client.w, y: n.y * client.h });
  /** Scale between a captured image and the client area; exact = a DPI-aware, full-size capture (the only kind readings use). */
  function captureScale(image, client) {
    if (!image || !(image.width > 0 && image.height > 0) || !isRect(client)) return { ok: false, reason: 'image or client size unknown' };
    const sx = image.width / client.w, sy = image.height / client.h, exact = image.width === client.w && image.height === client.h;
    return { ok: true, sx, sy, exact, uniform: Math.abs(sx - sy) < 0.01 };
  }
  function captureToClient(p, image, client) { const s = captureScale(image, client); if (!s.ok) return s; return { ok: true, x: p.x / s.sx, y: p.y / s.sy, exact: s.exact }; }
  function clientToCapture(p, image, client) { const s = captureScale(image, client); if (!s.ok) return s; return { ok: true, x: p.x * s.sx, y: p.y * s.sy, exact: s.exact }; }
  /** Normalised point of a table -> physical screen point (the click path), with every intermediate space. */
  function normalizedToPhysical(n, client) { const c = normalizedToClient(n, client), p = clientToPhysical(c, client); return { client: c, physical: p }; }
  function nearestStandardScale(s) { let best = STANDARD_SCALES[0]; for (const k of STANDARD_SCALES) if (Math.abs(k - s) < Math.abs(best - s)) best = k; return best; }
  /**
   * Geometry check of one reading: client rectangle (physical), the captured image, the window's DPI scale and (optionally) the monitor.
   * critical issues (no input may use this reading): the capture is not the client area at physical size (scaled or cropped), the scale is
   * unknown, the client area lies outside its monitor. Notes: a non-standard scale (custom scaling) - reported, not refused.
   */
  function checkGeometry({ client, image, dpiScale, monitor } = {}) {
    const critical = [], notes = [];
    if (!isRect(client)) critical.push('the window client rectangle is unknown');
    if (!(fin(dpiScale) && dpiScale > 0)) critical.push('the display scale of the window is unknown (it is read from Windows, never guessed from the resolution)');
    else if (Math.abs(nearestStandardScale(dpiScale) - dpiScale) > 0.001) notes.push('custom display scaling ' + Math.round(dpiScale * 100) + ' % (not one of the standard steps)');
    if (image && isRect(client)) { const s = captureScale(image, client); if (!s.ok) critical.push(s.reason); else if (!s.exact) critical.push('the captured image is ' + image.width + 'x' + image.height + ' but the client area is ' + client.w + 'x' + client.h + ' physical pixels: a scaled capture (DPI virtualisation) - not used for input'); }
    if (monitor && isRect(monitor.bounds) && isRect(client)) { const b = monitor.bounds; if (client.x < b.x || client.y < b.y || client.x + client.w > b.x + b.w || client.y + client.h > b.y + b.h) notes.push('the client area is not entirely on one monitor'); }
    const logical = fin(dpiScale) && dpiScale > 0 && isRect(client) ? { w: +(client.w / dpiScale).toFixed(1), h: +(client.h / dpiScale).toFixed(1) } : null;
    return { ok: critical.length === 0, critical, notes, physical: isRect(client) ? { ...client } : null, logicalSize: logical, scalePercent: fin(dpiScale) ? Math.round(dpiScale * 100) : null };
  }
  return { SPACES, STANDARD_SCALES, physicalToLogical, logicalToPhysical, physicalToClient, clientToPhysical, clientToNormalized, normalizedToClient, captureScale, captureToClient, clientToCapture, normalizedToPhysical, nearestStandardScale, checkGeometry };
});
