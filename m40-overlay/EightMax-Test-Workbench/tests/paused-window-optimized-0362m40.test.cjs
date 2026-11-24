'use strict';
// 0.36.2 Milestone 4.0: the Milestone 3.2 regression scenarios A-R (tests/paused-window-0362m32.test.cjs: paused-window monitoring, terminal
// loss, scheduler invalidation, input confirmation, cross-table isolation, emergency stop, re-registration) run again with the OPTIMIZED
// input pipeline - strip-only revalidation and confirmation polls, the Milestone 4.0 driver replies (input drain, per-process click guard)
// and the settle after the cursor lease - against the same fake desktop host. Every safety assertion of those scenarios applies unchanged.
// The last test checks that the optimized paths were really taken (otherwise this file would only repeat the Milestone 3.2 run).
process.env.EIGHTMAX_TEST_PIPELINE = 'optimized';
const test = require('node:test'), assert = require('node:assert/strict');
const PW = require('./paused-window-0362m32.test.cjs');
test('M4.0 optimized pipeline: scenarios A-R took the optimized paths (strip-only captures, drain-confirmed clicks, settle after the lease)', () => {
  assert.equal(PW.PIPE, 'optimized');
  const rigs = PW.RIGS; assert.ok(rigs.length >= 18, 'every scenario built its rig: ' + rigs.length);
  const regionCaptures = rigs.reduce((a, R) => a + (R.host.stats.regionCaptures || 0), 0), clicks = rigs.flatMap((R) => R.host.stats.m40Clicks || []);
  const deferred = rigs.reduce((a, R) => a + R.tables.reduce((b, t) => b + ((t.driver.stats && t.driver.stats.settleDeferred) || 0), 0), 0);
  const skipped = rigs.reduce((a, R) => a + R.tables.reduce((b, t) => b + ((t.driver.stats && t.driver.stats.preflightSkipped) || 0), 0), 0);
  assert.ok(regionCaptures > 50, 'strip-only captures: ' + regionCaptures);
  assert.ok(clicks.length > 20 && clicks.every((c) => c.drain === true && c.clickGuard === 'process'), 'every click asked for the drain and the per-process guard: ' + clicks.length);
  assert.ok(deferred > 20, 'settles that ran after the lease: ' + deferred); assert.ok(skipped > 20, 'window-info round trips replaced by the driver checks: ' + skipped);
});
