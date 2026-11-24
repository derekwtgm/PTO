/* EightMax Test Workbench 0.36.2 Milestone 4.0: MOUSE-SPEED PRESETS and the INPUT PIPELINE choice of the Simulator controls settings.
 *
 * A preset sets the cursor's peak speed and its acceleration limit - nothing else: click timing (delay before click, button hold,
 * settle), curvature, pattern and every other setting stay as the operator saved them. Presets apply only when the operator picks one;
 * saved settings are always loaded unchanged, and a saved speed that matches no preset is shown as "Custom".
 *   Conservative   800 px/s  acceleration  6 000 px/s^2
 *   Normal        1200 px/s  acceleration  9 000 px/s^2   (the dashboard default since 0.36.1; the speed of every Milestone 3 / 4 CI run)
 *   Fast          2000 px/s  acceleration 15 000 px/s^2
 *   Custom        any speed 400 - 2800 px/s and acceleration 2 000 - 30 000 px/s^2 (the bounds the dashboard has enforced since 0.36.1;
 *                 Milestone 4.0 measures motion accuracy at 400, 800, 1200, 2000 and 2800 px/s on Windows CI)
 * Peak speed: the minimum-jerk movement reaches it in the middle of a move; its average speed is peak / 1.875 (input-motion.js).
 *
 * Input pipeline (simulator-controls.js / windows-input-driver.js PIPELINE profiles):
 *   optimized    Milestone 4.0 (default): the cursor lease holds only the work that needs the cursor - see the Milestone 4.0 report
 *   compat-3.2   exactly Milestone 3.2 (for comparison, or if a simulator needs it)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./input-motion.js'));
  else root.WorkbenchInputPresets = factory(root.WorkbenchInputMotion);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';
  const PRESETS = Object.freeze({
    conservative: Object.freeze({ id: 'conservative', label: 'Conservative', maxSpeed: 800, maxAccel: 6000, note: 'slow, easy to follow; for a first run or a busy desktop' }),
    normal: Object.freeze({ id: 'normal', label: 'Normal', maxSpeed: 1200, maxAccel: 9000, note: 'the default; the speed every Milestone 3 and 4 Windows CI run used' }),
    fast: Object.freeze({ id: 'fast', label: 'Fast', maxSpeed: 2000, maxAccel: 15000, note: 'shorter movements; still a visible, continuous path' }),
  });
  const ORDER = Object.freeze(['conservative', 'normal', 'fast', 'custom']);
  const LIMITS = Object.freeze({ maxSpeed: [400, 2800], maxAccel: [2000, 30000] });
  const PIPELINES = Object.freeze({
    'optimized': Object.freeze({ id: 'optimized', label: 'Optimized (Milestone 4.0)', note: 'the cursor is held only for the movement and the click; verified checks are not repeated; the settle runs after the target window confirmed it processed the click' }),
    'compat-3.2': Object.freeze({ id: 'compat-3.2', label: 'Milestone 3.2 compatibility', note: 'exactly the Milestone 3.2 input sequence (extra window check, global click spacing, settle inside the cursor lease)' }),
  });
  /** {ok, reason} for a speed / acceleration pair (numbers only, inside the verified bounds). */
  function validate(maxSpeed, maxAccel) {
    for (const [k, v] of [['maxSpeed', maxSpeed], ['maxAccel', maxAccel]]) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, reason: (k === 'maxSpeed' ? 'Mouse speed' : 'Acceleration') + ' must be a number' };
      const [lo, hi] = LIMITS[k]; if (v < lo || v > hi) return { ok: false, reason: (k === 'maxSpeed' ? 'Mouse speed must be ' + lo + '-' + hi + ' px/s' : 'Acceleration must be ' + lo + '-' + hi + ' px/s²') + ' (got ' + v + ')' };
    }
    return { ok: true };
  }
  /** The preset a motion profile matches exactly, or 'custom'. Never changes the profile. */
  function presetOf(motion) { if (!motion) return 'custom'; for (const p of Object.values(PRESETS)) if (Number(motion.maxSpeed) === p.maxSpeed && Number(motion.maxAccel) === p.maxAccel) return p.id; return 'custom'; }
  /** A NEW motion profile: the preset's speed and acceleration, every other field of `motion` kept. 'custom' returns a copy unchanged. */
  function applyPreset(motion, id) {
    if (id === 'custom') return { ...(motion || {}) }; const p = PRESETS[id]; if (!p) throw new Error('Unknown mouse-speed preset ' + id);
    return { ...(motion || {}), maxSpeed: p.maxSpeed, maxAccel: p.maxAccel };
  }
  /** Plain-language description of a motion profile: preset name, peak and average speed, the time of an 800 px movement. */
  function describe(motion) {
    const id = presetOf(motion), name = id === 'custom' ? 'Custom' : PRESETS[id].label, prof = M.profile({ maxSpeed: Number(motion.maxSpeed), maxAccel: Number(motion.maxAccel), ...(motion.minDurationMs !== undefined ? { minDurationMs: Number(motion.minDurationMs) } : {}) });
    const ms800 = Math.round(M.durationMs(800, prof)), avg = Math.round(prof.maxSpeed / 1.875);
    return { preset: id, name, maxSpeed: prof.maxSpeed, maxAccel: prof.maxAccel, averageSpeed: avg, move800Ms: ms800, text: name + ': peak ' + prof.maxSpeed + ' px/s (about ' + avg + ' px/s on average); an 800 px movement takes about ' + ms800 + ' ms' };
  }
  function pipelineOf(settings) { const p = settings && settings.pipeline; return PIPELINES[p] ? p : 'optimized'; }
  return { PRESETS, ORDER, LIMITS, PIPELINES, validate, presetOf, applyPreset, describe, pipelineOf };
});
