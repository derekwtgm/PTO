#!/usr/bin/env node
'use strict';
/* EightMax 0.36.2 Milestone 3.1 TEST FIXTURE - a stand-in for desktop\bin\EightMaxWorkbench.exe used only by the Milestone 3.1 runner
 * self-checks (tests/runner-0362m31.test.cjs on Linux, the fault scenarios of .github/workflows/windows-0362-m31.yml). It answers the
 * routes the host-start test uses, on 127.0.0.1:<port>. It never touches the mouse, the screen or another program.
 *   node fake-desktop-host.cjs --ready FILE [--mode ok|exit|noready|badsession|noshutdown] [--port 48713]
 *   ok          ready file, health, input-driver health/status, authenticated shutdown (then exits 0)
 *   exit        writes a start-up error to stderr and exits 3 before it is ready (the "host cannot start" case)
 *   noready     keeps running, never writes its ready file (the "host never becomes ready" case)
 *   badsession  writes a ready file that is not valid JSON
 *   noshutdown  accepts the shutdown request but keeps running (the test must stop it and report it) */
const http = require('http'), fs = require('fs'), crypto = require('crypto'), path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d; };
const READY = arg('ready', ''), MODE = arg('mode', 'ok'), PORT = Number(arg('port', process.env.EIGHTMAX_FAKE_HOST_PORT || '48713'));
const token = crypto.randomBytes(32).toString('hex');
if (MODE === 'exit') { process.stderr.write('The desktop host could not start: simulated start-up failure (test fixture, mode exit).\n'); process.exit(3); }
let driverRunning = false;
const send = (res, code, obj) => { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, Connection: 'close' }); res.end(b); };
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (d) => { body += d; }); req.on('end', () => {
    const authed = req.headers['x-eightmax-session'] === token;
    if (req.method === 'GET' && req.url === '/api/desktop/health') return send(res, 200, { format: 'eightmax-desktop-health', version: 1, appVersion: '0.36.2-dev', build: 'fixture', inputDriver: true, inputDriverRunning: driverRunning, fixture: true });
    if (!authed) return send(res, 401, { error: { code: 'session-required' } });
    if (req.method === 'POST' && req.url === '/api/input/command') { driverRunning = true; return send(res, 200, { ok: true, cmd: 'health', fixture: true }); }
    if (req.method === 'GET' && req.url === '/api/input/status') return send(res, 200, { format: 'eightmax-input-status', version: 1, installed: true, running: driverRunning, crashed: false, starts: driverRunning ? 1 : 0, hotkey: 'Ctrl+Alt+F12', driver: null, events: [] });
    if (req.method === 'POST' && req.url === '/api/desktop/shutdown') { send(res, 200, { ok: true }); if (MODE !== 'noshutdown') setTimeout(() => { server.close(); try { fs.unlinkSync(READY); } catch (e) { /* gone */ } process.exit(0); }, 100); return; }
    return send(res, 404, { error: { code: 'unknown-route' } });
  });
});
server.listen(PORT, '127.0.0.1', () => {
  if (MODE === 'noready') return;
  const doc = MODE === 'badsession' ? '{"format":"eightmax-desktop-session","token":' : JSON.stringify({ format: 'eightmax-desktop-session', version: 1, appVersion: '0.36.2-dev', origin: 'http://127.0.0.1:' + PORT, token, processId: process.pid, requestLog: null });
  const tmp = READY + '.' + process.pid + '.tmp'; fs.mkdirSync(path.dirname(READY), { recursive: true }); fs.writeFileSync(tmp, doc); fs.renameSync(tmp, READY);
});
server.on('error', (e) => { process.stderr.write('Port ' + PORT + ' on 127.0.0.1 is already in use by another program (' + e.code + ').\n'); process.exit(1); });
setTimeout(() => process.exit(4), 30 * 60 * 1000).unref();
