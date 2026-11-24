'use strict';
// 0.36.2 Milestone 4.0: the controlled test table's dealer (the oracle side of the tests; the Workbench never reads it).
//  - the table's own action clock: the default action is applied, the REVISION ADVANCES (a new frame and status strip) and the oracle
//    records it - exactly as in Milestone 3.2 (a 4.0 edit had commented out the revision step and the record; found from the hero runs)
//  - the lost-click record: a press and release that reached an ENABLED button but raised no click is counted, never taken as an action
const test = require('node:test'), assert = require('node:assert/strict');
const FD = require('../src/fixture-dealer.js'), SS = require('../src/status-strip.js'), IC = require('../src/image-codec.js');

test('dealer clock timeout: action applied, revision advanced (new frame, new strip revision), oracle record and timeout list', () => {
  const frames = [], events = [], d = new FD.TableDealer({ table: 2, handGapMs: 0, send: (m) => frames.push(m), record: (e) => events.push(e) });
  try {
    d.onWindow({ type: 'ready', client: { x: 0, y: 0, w: 800, h: 500 } });
    const t = d.t, hand = t.hand, actor = t.actor, street = t.street, rev = d.rev, n = frames.length;
    assert.ok(actor >= 0 && t.status === 'playing', 'a player is to act');
    d.clockExpired(hand, t.revision, actor);
    assert.equal(d.counts.timeoutActions, 1);
    assert.equal(d.rev, rev + 1, 'the revision advanced with the action the clock took');
    const ev = events.filter((e) => e.kind === 'timeout-action');
    assert.equal(ev.length, 1, 'the oracle records the timeout'); assert.equal(ev[0].result, 'applied'); assert.equal(ev[0].rev, d.rev); assert.equal(ev[0].seat, actor); assert.ok(ev[0].after, 'with the state after it');
    assert.ok(frames.length > n, 'a new frame was pushed'); const last = frames[frames.length - 1]; assert.equal(last.rev, d.rev);
    const st = SS.read(IC.decodePng(Buffer.from(last.png, 'base64'))); assert.equal(st.ok, true); assert.equal(st.revision, d.rev & 0xffff, 'the status strip carries the new revision');
    assert.deepEqual(d.summary().timeouts, [{ hand, seat: actor, street, type: ev[0].type, rev: d.rev }]);
    assert.notEqual(d.t.actor, actor, 'the seat no longer has to act');
    // a click made on the frame before the timeout is a stale click: ignored, nothing applied
    const acc = d.counts.accepted; d.onWindow({ type: 'action', control: 'fold', wager: '', rev }); assert.equal(d.counts.staleClicks, 1); assert.equal(d.counts.accepted, acc);
  } finally { d.dispose(); }
});

test('dealer lost-click record: a release on an enabled button that is not followed by its action is counted - only then', () => {
  const events = [], d = new FD.TableDealer({ table: 3, handGapMs: 0, send: () => {}, record: (e) => events.push(e) });
  try {
    d.onWindow({ type: 'ready', client: { x: 0, y: 0, w: 800, h: 500 } });
    const ev = (type, control, enabled = true) => d.onWindow({ type, x: 600, y: 470, control, enabled, rev: d.rev, t: 1000 });
    const press = (control, enabled = true) => { ev('mouse-down', control, enabled); ev('mouse-up', control, enabled); };
    // an ordinary click: press, release, then that button's action
    const ctl = d.legal().call ? 'call' : 'check'; press(ctl); d.onWindow({ type: 'action', control: ctl, wager: '', rev: d.rev });
    assert.equal(d.counts.releasesWithoutAction, 0); assert.equal(d.counts.accepted, 1);
    // a lost click: the press and the release reached the window, the next message is not the action
    press('fold'); d.onWindow({ type: 'shown', rev: d.rev, t: 1001 });
    assert.equal(d.counts.releasesWithoutAction, 1);
    const rec = events.filter((e) => e.kind === 'release-without-action'); assert.equal(rec.length, 1); assert.equal(rec[0].control, 'fold'); assert.equal(rec[0].next, 'shown');
    // not lost clicks: a disabled button (already an incorrect click), the wager field, the felt, a double-click's second release
    press('check', false); d.onWindow({ type: 'shown', rev: d.rev });
    press('wager'); d.onWindow({ type: 'key', vk: 49, control: 'wager' });
    press('table'); d.onWindow({ type: 'shown', rev: d.rev });
    press('raise'); d.onWindow({ type: 'action', control: 'raise', wager: '', rev: d.rev }); ev('double-click', 'raise'); ev('mouse-up', 'raise'); d.onWindow({ type: 'shown', rev: d.rev });
    assert.equal(d.counts.releasesWithoutAction, 1, JSON.stringify(events.filter((e) => e.kind === 'release-without-action')));
    // a release whose next message is ANOTHER button's action is also lost (that action belongs to the next press)
    press('fold'); d.onWindow({ type: 'action', control: 'call', wager: '', rev: d.rev }); assert.equal(d.counts.releasesWithoutAction, 2);
    assert.equal(d.summary().counts.releasesWithoutAction, 2, 'reported in the dealer summary');
  } finally { d.dispose(); }
});
