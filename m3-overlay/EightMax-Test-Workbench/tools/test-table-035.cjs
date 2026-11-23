#!/usr/bin/env node
'use strict';
/* EightMax Test Workbench 0.35.0: run the CONTROLLED WINDOWS TEST TABLES (fixture) - one dealer process, N table windows.
 *
 *   node tools/test-table-035.cjs --tables 2 [--width 960] [--layout cascade|grid|stack] [--convention raise-to|raise-by]
 *        [--oracle-dir DIR] [--seed 7] [--hand-gap 600] [--turn-delay 0] [--exe desktop/bin/EightMaxTestTable.exe]
 *   --action-timeout MS (0.36.2 M3): the table's action clock; a player who does not act within MS is checked or folded by the table.
 *   --action-timeout-until-hand H, --stacks a,b,c,d,e,f,g,h (0 = eliminated seat) (0.36.2 M3); stdin {"cmd":"act","table":1,"control":"call"},
 *   {"cmd":"clock","table":1,"ms":400,"untilHand":1} (0.36.2 M3 test controls, recorded in the oracle).
 *   --turn-delay: after each action the table shows no controls for this long (the other players 'think'), so a table needs
 *   input only on its own turn - the realistic multi-table load. 0 = every frame needs an action (maximum load).
 *
 * Prints one JSON line {"type":"ready","tables":[{table,hwnd,pid,client,controls}]} when every window is up, then serves JSON
 * commands on stdin (one per line, replies on stdout):
 *   {"cmd":"move","table":1,"x":..,"y":..,"w":..}   {"cmd":"minimize"|"restore"|"activate"|"close"|"describe","table":1}
 *   {"cmd":"summary"}  -> oracle summaries of every table      {"cmd":"stop"} -> close all windows and exit
 *   0.36.2 M2: --keep-alive keeps this process running after every window closed; {"cmd":"reopen","table":1} -> starts a NEW window (new handle and process) for a closed table; replies
 *   {"type":"reopened","table":1,"hwnd":..,"pid":..,"client":..} once it is ready (a restarted simulator, for lifecycle tests)
 * The oracle (oracle-table-NN.jsonl) is written continuously to --oracle-dir. This process is the "simulator": the Workbench
 * never reads its state; acceptance tools read the oracle only after actions, to grade them.
 */
const path = require('path'), fs = require('fs'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const FD = require(path.join(ROOT, 'src', 'fixture-dealer.js'));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const N = Math.max(1, Math.min(10, Number(arg('tables', '1')))), W = Number(arg('width', '960')), layout = arg('layout', 'cascade'), convention = arg('convention', 'raise-to');
const oracleDir = arg('oracle-dir', null), seed = Number(arg('seed', '7')), gap = Number(arg('hand-gap', '600')), exe = arg('exe', path.join(ROOT, 'desktop', 'bin', 'EightMaxTestTable.exe'));
const screenW = Number(arg('screen-width', '1920')), screenH = Number(arg('screen-height', '1080')), turnDelay = Number(arg('turn-delay', '0'));
// 0.36.2 M3: --action-timeout MS = the table's own action clock (a player who does not act in time is checked / folded by the table); 0 = off
const actionTimeout = Number(arg('action-timeout', '0')); if (!Number.isSafeInteger(actionTimeout) || actionTimeout < 0 || actionTimeout > 600000) throw Error('Invalid --action-timeout');
const clockUntilHand = Number(arg('action-timeout-until-hand', 'Infinity'));   // 0.36.2 M3: the clock only runs up to this hand number
// 0.36.2 M3: --stacks a,b,...  one starting stack per seat (0 = a seat already eliminated in this tournament; at least two funded seats)
const seatStacks = arg('stacks', null) ? arg('stacks', null).split(',').map(Number) : null;
if (seatStacks && (seatStacks.length !== 8 || !seatStacks.every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 100000) || seatStacks.filter((n) => n > 0).length < 2)) throw Error('Invalid --stacks (8 whole numbers, at least two above 0)');
const stackChips=Number(arg('stack-chips','2500')), blinds={sb:Number(arg('sb-chips','50')),bb:Number(arg('bb-chips','100')),ante:Number(arg('ante-chips','10'))};
if(!Number.isSafeInteger(stackChips)||stackChips<1||stackChips>100000||!Object.values(blinds).every(n=>Number.isSafeInteger(n)&&n>=0&&n<=10000)||blinds.bb<1||blinds.sb>blinds.bb)throw Error('Invalid tournament chip configuration');
if (oracleDir) fs.mkdirSync(oracleDir, { recursive: true });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

function position(i) {
  const h = Math.round(W / 1.6);
  if (layout === 'grid') { const cols = Math.max(1, Math.floor(screenW / (W + 16))), rows = Math.max(1, Math.floor((screenH - 40) / (h + 40))); const k = i % (cols * rows); return { x: 8 + (k % cols) * (W + 16), y: 8 + Math.floor(k / cols) * (h + 40) }; }
  if (layout === 'stack') return { x: 40, y: 40 };
  return { x: 20 + i * 36, y: 10 + i * 28 };   // cascade: every title bar stays visible
}
const tables = [];
function spawnTable(i, generation, onReady) {
  const id = i + 1, pos = position(i), oracle = oracleDir ? fs.openSync(path.join(oracleDir, 'oracle-table-' + String(id).padStart(2, '0') + (generation ? '-g' + generation : '') + '.jsonl'), 'w') : null;
  const child = cp.spawn(exe, ['--table', String(id), '--x', String(pos.x), '--y', String(pos.y), '--width', String(W)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const rec = { id, child, ready: null, dealer: null, buf: '' };
  // 0.36.2 M3: a window that has already exited makes a later write to its stdin fail ASYNCHRONOUSLY (EPIPE); without a listener that
  // error crashed this fixture with exit code 1 at the end of the Windows CI run (run 45203097931). The window is gone either way.
  child.stdin.on('error', () => { /* window gone */ });
  // 0.36.2 M3: a reopened table (a new tournament in the campaign and stability runs) gets its own deal: seed + generation * 100003
  // (with one seed for every generation each replacement tournament replayed the first one hand for hand)
  rec.dealer = new FD.TableDealer({ table: id, seed: seed * 1000 + id + (generation || 0) * 100003, stacks:seatStacks ? seatStacks.slice() : Array(8).fill(stackChips),blinds, convention, handGapMs: gap, turnDelayMs: turnDelay, actionTimeoutMs: actionTimeout, actionTimeoutUntilHand: clockUntilHand, send: (m) => { try { child.stdin.write(JSON.stringify(m) + '\n'); } catch (e) { /* window gone */ } },
    record: (e) => { if (oracle !== null) fs.writeSync(oracle, JSON.stringify({ t: Date.now(), table: id, ...e }) + '\n'); } });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { rec.buf += d; let k; while ((k = rec.buf.indexOf('\n')) >= 0) { const line = rec.buf.slice(0, k); rec.buf = rec.buf.slice(k + 1); let m; try { m = JSON.parse(line); } catch (e) { continue; }
    if (m.type === 'ready') { rec.ready = m; if (rec.onReady) { const f = rec.onReady; rec.onReady = null; f(rec); } else checkReady(); } if (m.type === 'describe') out({ type: 'describe', table: id, ...m }); rec.dealer.onWindow(m); } });
  child.on('exit', (code) => { rec.exited = code; rec.dealer.closed = true; out({ type: 'exited', table: id, code, hwnd: rec.ready && rec.ready.hwnd }); if (!keepAlive && !reopening && tables.every((t) => t.exited !== undefined)) process.exit(0); });
  rec.onReady = onReady || null; return rec;
}
let reopening = 0; const keepAlive = process.argv.includes('--keep-alive');   // 0.36.2 M2: stay up after every window closed (reopen)
for (let i = 0; i < N; i++) tables.push(spawnTable(i, 0));
let announced = false;
function checkReady() { if (announced || !tables.every((t) => t.ready)) return; announced = true; out({ type: 'ready', exe, convention, tables: tables.map((t) => ({ table: t.id, hwnd: t.ready.hwnd, pid: t.ready.pid, client: t.ready.client, controls: t.ready.controls, dpi: t.ready.dpi })) }); }
setTimeout(() => { if (!announced) { out({ type: 'error', error: 'windows not ready within 30 s', ready: tables.filter((t) => t.ready).length }); } }, 30000);

let ibuf = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { ibuf += d; let k; while ((k = ibuf.indexOf('\n')) >= 0) { const line = ibuf.slice(0, k); ibuf = ibuf.slice(k + 1); let m; try { m = JSON.parse(line); } catch (e) { continue; } handle(m); } });
process.stdin.on('end', stop);
function handle(m) {
  if (m.cmd === 'summary') return out({ type: 'summary', id: m.id, tables: tables.map((t) => ({ ...t.dealer.summary(!!m.full), closed: t.exited !== undefined, hwnd: t.ready ? t.ready.hwnd : null })) });
  if (m.cmd === 'stop') return stop();
  if (m.cmd === 'reopen') {
    const k = tables.findIndex((x) => x.id === m.table); if (k < 0) return out({ type: 'error', id: m.id, error: 'no table ' + m.table });
    if (tables[k].exited === undefined) return out({ type: 'error', id: m.id, error: 'table ' + m.table + ' is still open; close it first' });
    reopening++; const gen = (tables[k].generation || 0) + 1;
    const rec = spawnTable(k, gen, (r) => { reopening--; out({ type: 'reopened', id: m.id, table: r.id, hwnd: r.ready.hwnd, pid: r.ready.pid, client: r.ready.client, generation: gen }); });
    rec.generation = gen; tables[k] = rec; return;
  }
  const t = tables.find((x) => x.id === m.table); if (!t) return out({ type: 'error', id: m.id, error: 'no table ' + m.table });
  if (['move', 'minimize', 'restore', 'activate', 'close', 'describe'].includes(m.cmd)) { t.dealer.send({ type: m.cmd, x: m.x, y: m.y, w: m.w }); return out({ type: 'done', id: m.id, cmd: m.cmd, table: m.table }); }
  // 0.36.2 M3 test controls: 'act' = an action by the player to act that the Workbench did not make (a human, before automation starts);
  // 'clock' = the table's own action clock (ms, 0 = off) for hands up to untilHand. Both are recorded in the oracle like any other event.
  if (m.cmd === 'act') { const before = t.dealer.counts.accepted; t.dealer.onWindow({ type: 'action', control: m.control, wager: m.wager || '', rev: t.dealer.rev }); return out({ type: 'done', id: m.id, cmd: 'act', table: m.table, accepted: t.dealer.counts.accepted > before, hand: t.dealer.t.hand }); }
  if (m.cmd === 'clock') { t.dealer.actionTimeout = Number(m.ms) || 0; t.dealer.actionTimeoutUntilHand = m.untilHand === undefined ? Infinity : Number(m.untilHand); t.dealer.armClock(); return out({ type: 'done', id: m.id, cmd: 'clock', table: m.table }); }
  out({ type: 'error', id: m.id, error: 'unknown command' });
}
function stop() { for (const t of tables) { try { t.dealer.send({ type: 'close' }); t.child.stdin.end(); } catch (e) { /* gone */ } } setTimeout(() => { for (const t of tables) { try { t.child.kill(); } catch (e) { /* gone */ } } process.exit(0); }, 3000).unref(); }
