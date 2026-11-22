/* EightMax Test Workbench 0.35.0 - "Simulator controls" panel: connect the operator's own simulator window, calibrate its controls,
   preview and test the visible mouse/keyboard input, run automated play with confirmation, and stop everything at once.
   Talks only to the local desktop host (/api/input/*, /api/capture/*) with the dashboard's session token. Nothing here can reach a
   window the operator did not select, confirm and authorise; the driver additionally checks the program's SHA-256. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id), SC = window.WorkbenchSimulatorControls, SP = window.WorkbenchSimulatorProfiles, PP = window.WorkbenchPlatformProfile, SCH = window.WorkbenchInputScheduler, XA = window.WorkbenchExecutionAdapters, M = window.WorkbenchInputMotion;
if (!SC || !SP || !$('simc-panel')) return;
const st = { api: null, session: null, windows: [], registered: new Map(), profile: null, tables: [], scheduler: null, recorder: new XA.DiagnosticsRecorder({ max: 20000 }), running: false, cal: null, lastError: null, driver: null };
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const say = (t, bad) => { const s = $('simc-status'); if (s) { s.textContent = t; s.classList.toggle('bad', !!bad); } if (bad) { st.lastError = t; const le = $('simc-last-error'); if (le) le.textContent = t; } };
function token() { const d = window.WorkbenchDesktop && window.WorkbenchDesktop.fromPage && window.WorkbenchDesktop.fromPage(window); return d && d.secret ? d.secret : null; }
function connect() { if (st.api) return true; const t = token(); if (!t) { say('Open the dashboard from START-DESKTOP.cmd: simulator controls need the local desktop host.', true); return false; } st.api = new SC.HostApi({ token: t, fetch: window.fetch.bind(window) }); st.session = SC.hostSession(st.api); return true; }
async function call(cmd, args = {}, ms) { const r = await st.session.request(cmd, args, ms); if (!r || r.ok !== true) throw Object.assign(new Error((r && r.error) || cmd + ' refused'), { code: r && r.code }); return r; }
async function decodeBrowser(b64png) { const bin = atob(b64png), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); const bmp = await createImageBitmap(new Blob([u], { type: 'image/png' })); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0); const d = g.getImageData(0, 0, c.width, c.height); return { width: c.width, height: c.height, data: d.data }; }

/* Guided setup checks use live host/driver/capture responses. No step claims a Windows pass from markup. */
const setupNames=['Installation check','Input driver','Simulator selection','Screen capture','Calibration','Mouse settings','Decision mode','Dry run','Start'];
let setupStep=0;
function setupView(){const box=$('simc-setup-steps');if(!box)return;box.textContent='';setupNames.forEach((name,i)=>{const row=el('li',(i<setupStep?'Checked — ':i===setupStep?'Next — ':'')+name);box.appendChild(row);});}
async function setupCheck(){
 if(!connect())return;
 try{
  if(setupStep===0){const h=await st.api.request('/api/desktop/health');if(!h.nativeCPU||!h.inputDriver)throw Error('Required native engine/input components are unavailable.');const probe=await st.api.request('/api/simulator/decision',{probe:true});if(probe.status!=='ok')throw Error(probe.reason||'Native engine startup failed.');}
  else if(setupStep===1)await requireCurrentDriver();
  else if(setupStep===2){if(!st.registered.size)throw Error('Select, calibrate and register the bundled simulator using the controls below.');}
  else if(setupStep===3){const s=selected();if(!s)throw Error('Select a registered simulator.');const target={kind:'window',hwnd:s.hwnd,pid:s.r.pid,title:s.r.title,method:$('simc-capture').value};await st.api.request('/api/capture/open',{target,consent:true});const c=await st.api.request('/api/capture/frame',{target});if(!c.ok||!c.png)throw Error('No captured image returned. Use calibration to inspect capture diagnostics.');}
  else if(setupStep===4){const s=selected();if(!s)throw Error('Select a registered simulator.');const w=(await call('window-info',{hwnd:s.hwnd})).window;const report=SP.calibrationReport(s.r.profile,w.client);if(!report.ready)throw Error('Review calibrated controls before continuing.');}
  else if(setupStep===5){const cfg=settings();await st.api.request('/api/input/settings',cfg);}
  else if(setupStep===6){if(!$('simc-scripted').checked&&!(window.multitablePanel&&window.multitablePanel.source))throw Error('Load a quality-validated EightMax preflop study, or explicitly select Simulator Practice.');}
  else if(setupStep===7){await preview();if(!st.lastPreviewPassed)throw Error('Dry run has not completed.');}
  else if(setupStep===8){await start();if(!st.running)throw Error('Automation has not started. Review the status below.');}
  if(setupStep<setupNames.length)setupStep++;setupView();$('simc-setup-result').textContent=setupStep===9?'Session started. Ctrl+Alt+F12 stops input.':'Step checked. Continue when ready.';
 }catch(e){$('simc-setup-result').textContent='Stopped: '+e.message;}
}
/* ---------- settings ---------- */
const SETTINGS = [['maxSpeed', 'motion', 'Cursor speed (px/s)'], ['maxAccel', 'motion', 'Max acceleration (px/s²)'], ['intervalMs', 'motion', 'Update interval (ms)'], ['minDurationMs', 'motion', 'Minimum movement time (ms)'], ['arc', 'motion', 'Maximum curvature (0–0.25)'], ['maxDeviationPx', 'motion', 'Maximum sideways deviation (px)'],
  ['preClickMs', 'timing', 'Delay before click (ms)'], ['holdMs', 'timing', 'Button hold (ms)'], ['postClickSettleMs', 'timing', 'Settle after click (ms)'], ['keyIntervalMs', 'timing', 'Key interval (ms)'], ['keyHoldMs', 'timing', 'Key hold (ms)'], ['postActionTimeoutMs', 'timing', 'Confirmation timeout (ms)']];
function settings() {
  const motion = {}, timing = {}; for (const [k, grp] of SETTINGS) { const v = Number(($('simc-set-' + k) || {}).value); if (Number.isFinite(v)) (grp === 'motion' ? motion : timing)[k] = v; }
  if (motion.maxSpeed < 400 || motion.maxSpeed > 2800) throw Error('Mouse speed must be 400–2800 px/s');
  const movement = window.WorkbenchMovementSettings.validate({pattern: $('simc-set-pattern').value, variation: Number($('simc-set-variation').value), seed: Number($('simc-set-seed').value),direction:$('simc-set-direction').value,minCurvature:Number($('simc-set-minCurvature').value),maxCurvature:motion.arc});
  for (const [k,v] of Object.entries(timing)) { if (!Number.isFinite(v) || v < 0 || v > 10000 || (k==='holdMs' && (v<10 || v>1000))) throw Error('Invalid timing: '+k); }
  const maxQueue=Number($('simc-set-queue').value), decisionWindowMs=Number($('simc-set-window').value);
  if(!Number.isInteger(maxQueue)||maxQueue<1||maxQueue>64)throw Error('Queue size must be 1–64');
  if(!Number.isFinite(decisionWindowMs)||decisionWindowMs<1000||decisionWindowMs>60000)throw Error('Decision window must be 1000–60000 ms');
  if(timing.keyHoldMs>500||timing.keyIntervalMs>2000||timing.preClickMs>2000)throw Error('Keyboard/click timing exceeds driver limits');
  return { movement, format: 'eightmax-input-settings', version: 1, motion: M.profile(motion), timing: { ...M.DEFAULT_TIMING, ...timing }, focusPolicy: ($('simc-set-focus') || {}).value || 'bring-to-front', maxQueue, hotkey: ($('simc-set-hotkey') || {}).value || 'Ctrl+Alt+F12', decisionWindowMs };
}
function buildSettings() {
  setupView();if($('simc-setup-check'))$('simc-setup-check').onclick=setupCheck;
  const box = $('simc-settings'); if (!box || box.childElementCount) return; const def = { ...M.DEFAULT_PROFILE, maxSpeed: 1200, arc: 0.12, maxDeviationPx:240, ...M.DEFAULT_TIMING };
  for (const [k, , label] of SETTINGS) { const l = el('label', label + ' '); const i = el('input'); i.id = 'simc-set-' + k; i.type = 'number'; i.value = String(def[k]); i.step = k === 'arc' ? '0.01' : '1'; l.appendChild(i); box.appendChild(l); }
  const speed = $('simc-set-maxSpeed'); speed.min='400'; speed.max='2800';
  const slider=el('input'); slider.id='simc-set-speed-slider'; slider.type='range'; slider.min='400'; slider.max='2800'; slider.step='50'; slider.value=speed.value;
  slider.setAttribute('aria-label','Mouse speed'); slider.oninput=()=>{speed.value=slider.value;}; speed.oninput=()=>{slider.value=speed.value;}; box.appendChild(slider);
  for(const [name,v] of [['Slow',600],['Normal',1200],['Fast',2000]]) { const b=el('button',name+' ('+v+' px/s)','small'); b.onclick=()=>{speed.value=slider.value=String(v);};box.appendChild(b); }
  const label=el('label','Movement pattern '), pattern=el('select');pattern.id='simc-set-pattern';
  for(const [value,name] of [['straight','Straight'],['fixed','Fixed Curve'],['random','Randomized Curves']]){const o=el('option',name);o.value=value;pattern.appendChild(o);}label.appendChild(pattern);box.appendChild(label);
  const dl=el('label','Fixed curve direction '), ds=el('select');ds.id='simc-set-direction';for(const v of ['left','right']){const o=el('option',v);o.value=v;ds.appendChild(o);}dl.appendChild(ds);box.appendChild(dl);
  for(const [id,name,value,min,max,step] of [['minCurvature','Minimum curvature',0,0,.25,.01],['variation','Curvature variation (0–1)',1,0,1,0.05],['seed','Random seed',1,1,4294967295,1]]) {const l=el('label',name+' '),i=el('input');i.id='simc-set-'+id;i.type='number';i.value=value;i.min=min;i.max=max;i.step=step;l.appendChild(i);box.appendChild(l);}
  for(const [name,v] of [['Low',0.05],['Medium',0.12],['High',0.25]]) {const b=el('button',name+' curvature','small');b.onclick=()=>{$('simc-set-arc').value=v;};box.appendChild(b);}
  for(const [name,v] of [['Straight','straight'],['Fixed Curve','fixed'],['Random Curves','random']]){const b=el('button','Preview '+name,'small');b.onclick=()=>{pattern.value=v;preview();};box.appendChild(b);}
  const f = el('label', 'Window focus '); const s = el('select'); s.id = 'simc-set-focus'; for (const o of ['bring-to-front', 'refuse']) { const op = el('option', o); op.value = o; s.appendChild(op); } f.appendChild(s); box.appendChild(f);
  for (const [id, label, v] of [['queue', 'Max queued actions', '16'], ['window', 'Decision window (ms)', '12000']]) { const l = el('label', label + ' '); const i = el('input'); i.id = 'simc-set-' + id; i.type = 'number'; i.value = v; l.appendChild(i); box.appendChild(l); }
  const h = el('label', 'Emergency-stop hotkey '); const hi = el('input'); hi.id = 'simc-set-hotkey'; hi.value = 'Ctrl+Alt+F12'; h.appendChild(hi); box.appendChild(h);
}
function applySettings(v) {
 if(!v || v.saved===false || v.format!=='eightmax-input-settings')return;
 const motion=M.profile(v.motion||{}), movement=window.WorkbenchMovementSettings.validate(v.movement||{});
 for(const [k,group] of SETTINGS){const value=group==='motion'?motion[k]:(v.timing||{})[k];if(value!==undefined)$('simc-set-'+k).value=value;}
 $('simc-set-pattern').value=movement.pattern;$('simc-set-variation').value=movement.variation;$('simc-set-seed').value=movement.seed;$('simc-set-direction').value=movement.direction;$('simc-set-minCurvature').value=movement.minCurvature===null?Math.abs(Number($('simc-set-arc').value))*(1-movement.variation):movement.minCurvature;
 for(const [id,key] of [['focus','focusPolicy'],['queue','maxQueue'],['window','decisionWindowMs'],['hotkey','hotkey']])if(v[key]!==undefined)$('simc-set-'+id).value=v[key];
 $('simc-set-speed-slider').value=$('simc-set-maxSpeed').value;
 settings();
}
let settingsLoad=null;
function restoreSettings(){
 if(settingsLoad)return settingsLoad;
 settingsLoad=(async()=>{try{if(connect())applySettings(await st.api.request('/api/input/settings'));}catch(e){say('Saved settings could not be loaded: '+e.message,true);}})();
 return settingsLoad;
}
async function saveSettings() { if (!connect()) return; try { const s = settings(); const r = await st.api.request('/api/input/settings', s); say('Settings saved.' + (r.restartNeededForHotkey ? ' Restart the input driver to use the new hotkey.' : '')); } catch (e) { say('Settings refused: ' + e.message, true); } }

/* ---------- status ---------- */
async function refresh() {
  if (!connect()) return;
  try {
    const source=window.multitablePanel&&window.multitablePanel.source; $('simc-decision-status').textContent=($('simc-scripted').checked?'Practice enabled (non-GTO). ':'Strict EightMax. ')+(source?'Loaded study: '+source.id+'; quality: '+source.convergence.verdict+'. Unsupported or unvalidated states '+($('simc-scripted').checked?'use labelled practice.':'pause.'):'No study loaded. Strict mode will pause.');
    const s = await st.api.request('/api/input/status'); st.driver = s; const d = s.driver || {}, caps = d.capabilities || {};
    const mode = !s.running ? (s.crashed ? 'DRIVER STOPPED UNEXPECTEDLY - restart it' : 'driver not started') : d.estop ? 'EMERGENCY STOP latched (' + d.estop + ')' : d.yielded ? 'Yielded to you (' + d.yielded + ') - Resume when ready' : d.manual ? 'Manual control mode' : d.armed ? 'Automation ENABLED' : 'Automation disabled';
    $('simc-driver').textContent = (s.running ? 'Input driver ' + (d.driver || '?') + ' running' : 'Input driver stopped') + ' · ' + mode + ' · hotkey ' + (caps.hotkey || s.hotkey) + (caps.hotkeyRegistered === false ? ' (NOT registered: ' + caps.note + ')' : '') + ' · DPI ' + (caps.dpiAwareness || '?') + ' · UI Automation ' + (caps.uiAutomation ? 'yes' : 'no') + ' · manual-override detection ' + (caps.rawInputOverride ? 'Raw Input' : 'cursor checks');
    $('simc-queue').textContent = st.scheduler ? JSON.stringify(st.scheduler.status()) : 'no automation running';
    const ev = (s.events || []).slice(-6).map((e) => (e.event || '') + ': ' + (e.detail || '')).join(' | '); $('simc-events').textContent = ev || '—';
  } catch (e) { say('Desktop host: ' + e.message, true); }
  renderTables();
}
function renderTables() {
  const t = $('simc-tables'); if (!t) return; t.textContent = ''; const h = el('tr'); for (const c of ['Table', 'Window', 'Capture', 'Recognised state', 'Planned / last action', 'Input', 'Confirmation', '']) h.appendChild(el('th', c)); t.appendChild(h);
  for (const [hwnd, r] of st.registered) {
    const tab = st.tables.find((x) => x.win.hwnd === hwnd), s = tab && tab.state, last = tab && tab.log[tab.log.length - 1], tr = el('tr');
    tr.appendChild(el('td', String(r.table))); tr.appendChild(el('td', r.title + ' · ' + r.client.w + '×' + r.client.h + ' @ ' + (r.dpiScale * 100).toFixed(0) + '%'));
    tr.appendChild(el('td', tab ? tab.capture.frames + ' frames, ' + tab.capture.failures + ' failed' : 'consented'));
    tr.appendChild(el('td', s ? 'hand ' + s.hand + ' · ' + s.street + ' · actor ' + s.actor + ' · pot ' + s.pot : '—'));
    tr.appendChild(el('td', last ? (last.intended ? last.intended.type + (last.intended.amount ? ' ' + last.intended.amount : '') : '—') + ' (' + last.source + ')' : '—'));
    tr.appendChild(el('td', last && last.input ? 'cursor ' + Math.round(last.input.actualMs || 0) + ' ms' : (tab && tab.paused ? 'PAUSED: ' + tab.paused : '—')));
    tr.appendChild(el('td', last ? last.status + (last.reason ? ': ' + last.reason : '') : '—'));
    const td = el('td'), b = el('button', tab && tab.paused ? 'Resume' : 'Pause', 'small quiet'); b.addEventListener('click', () => { if (!tab) return; if (tab.paused) tab.resume(); else tab.pause('operator'); renderTables(); }); td.appendChild(b); tr.appendChild(td);
    t.appendChild(tr);
  }
}

/* ---------- connect a simulator window ---------- */
async function listWindows() {
  if (!connect()) return; try { const r = await call('list-windows'); st.windows = r.windows.filter((w) => !w.minimized && w.client.w >= 200); const sel = $('simc-window'); sel.textContent = ''; for (const w of st.windows) { const o = el('option', w.title + ' — ' + (w.exe.split('\\').pop()) + ' (pid ' + w.pid + ')' + (w.registered ? ' ✓' : '')); o.value = w.hwnd; sel.appendChild(o); } say(st.windows.length + ' windows. Choose YOUR simulator, tick the three confirmations and press Register.'); }
  catch (e) { say('Could not list windows: ' + e.message, true); }
}
async function registerWindow() {
  if (!connect()) return; const hwnd = $('simc-window').value, w = st.windows.find((x) => x.hwnd === hwnd); if (!w) return say('Choose a window first.', true);
  if (!['simc-own', 'simc-test', 'simc-nomoney'].every((id) => $(id).checked)) return say('Confirm that the simulator is yours, a test environment and involves no real money.', true);
  try {
    const id = await call('exe-identity', { hwnd }), exeName = w.exe.split('\\').pop();
    let prof = st.profile; if (/^EightMaxTestTable\.exe$/i.test(exeName)) prof = SP.fixtureProfile({ exeSha256: id.exeSha256 });
    if (!prof) return say('Calibrate the controls first (or load a profile) - the profile binds the simulator executable.', true);
    const sim = prof.execution.simulator; if (sim.exeFileName.toLowerCase() !== exeName.toLowerCase() || (sim.exeSha256 && sim.exeSha256 !== id.exeSha256)) return say('This window belongs to ' + exeName + ' (' + id.exeSha256.slice(0, 12) + '…), not the executable the profile was calibrated for.', true);
    if (!sim.exeSha256) { prof = JSON.parse(JSON.stringify(prof)); prof.execution.simulator.exeSha256 = id.exeSha256; st.profile = prof; try { localStorage.setItem('eightmax-sim-profile', PP.saveProfile(prof)); } catch (e) { /* private window */ } }
    const hours = Math.min(8, Math.max(0.25, Number($('simc-hours').value) || 2)), auth = SC.authorizations({ environment: 'operator-simulator', approvedBy: ($('simc-approver').value || 'operator').slice(0, 60), exeFileName: exeName, exeSha256: id.exeSha256, hours });
    await call('register-target', { hwnd, authorization: auth.simulator, label: w.title });
    const cap = await st.api.request('/api/capture/open', { target: { kind: 'window', hwnd, pid: w.pid, title: w.title, method: $('simc-capture').value }, consent: true }); if (!cap.ok) throw new Error(cap.reason || 'capture refused');
    const n = st.registered.size + 1; st.registered.set(hwnd, { table: Math.min(10, n), title: w.title, pid: w.pid, client: w.client, dpiScale: w.dpiScale, auth, profile: prof, exeSha256: id.exeSha256 });
    if (!st.profile) st.profile = prof; say('Registered ' + w.title + ' (' + exeName + ', SHA-256 ' + id.exeSha256.slice(0, 16) + '…) for ' + hours + ' h. Input goes ONLY to this window.'); renderTables();
  } catch (e) { say('Registration refused: ' + e.message, true); }
}

/* ---------- calibration wizard ---------- */
const STEPS = [['fold', 'Fold button'], ['check', 'Check button'], ['call', 'Call button'], ['raise', 'Bet / Raise button'], ['wager', 'Wager-entry field'], ['allin', 'All-in button (optional - Skip if none)']];
async function startCalibration() {
  const hwnd = $('simc-window').value, reg = st.registered.get(hwnd) || st.windows.find((x) => x.hwnd === hwnd); if (!reg) return say('Choose (and preferably register) the simulator window first.', true);
  if (!connect()) return; try {
    const w = st.windows.find((x) => x.hwnd === hwnd) || { pid: reg.pid, title: reg.title }; await st.api.request('/api/capture/open', { target: { kind: 'window', hwnd, pid: w.pid, title: w.title, method: $('simc-capture').value }, consent: true });
    const f = await st.api.request('/api/capture/frame', { target: { kind: 'window', hwnd, pid: w.pid, title: w.title, method: $('simc-capture').value } }); if (!f.ok) throw new Error(f.reason || 'no frame');
    const img = await decodeBrowser(f.png); st.cal = { hwnd, img, bounds: f.bounds, dpiScale: f.dpiScale || 1, regions: {}, step: 0, title: w.title, exe: w.exe };
    $('simc-cal').hidden = false; drawCal(); say('Drag a rectangle over the ' + STEPS[0][1] + '.');
  } catch (e) { say('Screenshot failed: ' + e.message, true); }
}
function drawCal() {
  const c = $('simc-canvas'), cal = st.cal; if (!c || !cal) return; const scale = Math.min(1, 900 / cal.img.width); c.width = Math.round(cal.img.width * scale); c.height = Math.round(cal.img.height * scale); cal.scale = scale;
  const g = c.getContext('2d'), tmp = document.createElement('canvas'); tmp.width = cal.img.width; tmp.height = cal.img.height; tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(cal.img.data), cal.img.width, cal.img.height), 0, 0); g.drawImage(tmp, 0, 0, c.width, c.height);
  const client = { x: cal.bounds.x, y: cal.bounds.y, w: cal.bounds.width, h: cal.bounds.height };
  for (const [k, b] of Object.entries(cal.regions)) { g.strokeStyle = k === 'wager' ? '#0bf' : '#fc0'; g.lineWidth = 2; g.strokeRect(b.x * c.width, b.y * c.height, b.w * c.width, b.h * c.height); g.fillStyle = '#fc0'; g.fillText(k, b.x * c.width + 3, b.y * c.height - 3);
    const t = window.WorkbenchInputGeometry.regionToScreen(b, client); if (t.ok) { const px = (t.point.x - client.x) / client.w * c.width, py = (t.point.y - client.y) / client.h * c.height; g.fillStyle = '#f33'; g.beginPath(); g.arc(px, py, 4, 0, 7); g.fill(); } }
  const step = STEPS[cal.step]; $('simc-cal-step').textContent = step ? 'Step ' + (cal.step + 1) + '/' + STEPS.length + ': drag over the ' + step[1] : 'All controls marked. Review the preview, then Save profile.';
  $('simc-cal-info').textContent = 'Window ' + client.w + '×' + client.h + ' physical px at ' + client.x + ',' + client.y + ' · display scaling ' + Math.round(cal.dpiScale * 100) + '%';
  if (cal.step >= 4) { try { const p = calProfile(); const r = SP.calibrationReport(p, client, { dpiScale: cal.dpiScale }); $('simc-cal-report').textContent = 'Confidence ' + r.confidence + (r.problems.length ? ' · problems: ' + r.problems.join('; ') : '') + (r.warnings.length ? ' · ' + r.warnings.join('; ') : ''); } catch (e) { $('simc-cal-report').textContent = e.message; } }
}
function calProfile() { const cal = st.cal; return SP.fromCalibration({ id: ($('simc-prof-id').value || 'my-simulator').toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 60), name: $('simc-prof-id').value || 'My simulator', regions: cal.regions, simulator: { exeFileName: (cal.exe || '').split('\\').pop() || 'simulator.exe', exeSha256: (st.registered.get(cal.hwnd) || {}).exeSha256 || null }, convention: $('simc-convention').value, chipUnit: Math.max(1, Number($('simc-chip').value) || 1), heroSeat: Math.max(0, Math.min(7, Number($('simc-hero').value) || 0)) }); }
function bindCanvas() {
  const c = $('simc-canvas'); if (!c || c.dataset.bound) return; c.dataset.bound = '1'; let a = null;
  c.addEventListener('mousedown', (e) => { const r = c.getBoundingClientRect(); a = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; });
  c.addEventListener('mouseup', (e) => { if (!a || !st.cal || st.cal.step >= STEPS.length) return; const r = c.getBoundingClientRect(), b = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
    const box = { x: Math.max(0, Math.min(a.x, b.x)), y: Math.max(0, Math.min(a.y, b.y)), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) }; a = null; if (box.w < 0.005 || box.h < 0.005) return say('That rectangle is too small; drag over the whole control.', true);
    st.cal.regions[STEPS[st.cal.step][0]] = box; st.cal.step++; drawCal(); });
}
async function suggestUia() { if (!st.cal) return; try { const r = await call('uia-controls', { hwnd: st.cal.hwnd }); const s = SP.suggestFromUia(r.controls, { x: st.cal.bounds.x, y: st.cal.bounds.y, w: st.cal.bounds.width, h: st.cal.bounds.height }); Object.assign(st.cal.regions, s); st.cal.step = STEPS.findIndex(([k]) => !st.cal.regions[k] && k !== 'allin'); if (st.cal.step < 0) st.cal.step = STEPS.length; drawCal(); say('Windows UI Automation suggested: ' + (Object.keys(s).join(', ') || 'nothing (the simulator may draw its own controls)') + '. Check every box in the preview.'); } catch (e) { say('UI Automation: ' + e.message, true); } }
function saveProfile() { try { const p = calProfile(); const text = PP.saveProfile(p); try { localStorage.setItem('eightmax-sim-profile', text); } catch (e) { /* private window */ } st.profile = p; download(p.id + '.profile.json', text); say('Profile ' + p.id + ' saved (SHA-256 integrity) and exported. It is bound to ' + p.execution.simulator.exeFileName + '.'); } catch (e) { say('Not saved: ' + e.message, true); } }
function loadProfile(text) { const r = PP.loadProfile(text); if (!r.ok) return say('Profile rejected: ' + r.problems.join('; '), true); if (!(r.profile.execution && r.profile.execution.interface === 'approved-ui-automation')) return say('That profile has no simulator controls.', true); st.profile = r.profile; say('Loaded profile ' + r.profile.id + ' (checksum verified), bound to ' + r.profile.execution.simulator.exeFileName + '.'); }
function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }

/* ---------- preview / test ---------- */
function selected() { const hwnd = $('simc-window').value, r = st.registered.get(hwnd); if (!r) { say('Register the window first.', true); return null; } return { hwnd, r }; }
async function requireCurrentDriver() {
 const status=await call('status'), caps=status.capabilities||{};
 if(!caps.signedCurves||!caps.maxDeviationPx)throw Error('These settings require the 0.36.2 input driver with signed-curve support. Run the installation check and repair the driver.');
 st.session.capabilities=caps;
}
async function preview() {
  st.lastPreviewPassed=false;
  if(st.running) return say('Stop automation before previewing movement.',true);
  const s = selected(); if (!s) return; try { await restoreSettings(); await requireCurrentDriver(); await call('arm'); const w = (await call('window-info', { hwnd: s.hwnd })).window, plan = SP.dryRunPlan(s.r.profile, w.client), cfg = settings(), curves = new window.WorkbenchMovementSettings.Sequence(cfg.movement);
    for (const p of plan) { await call('move', { hwnd: s.hwnd, to: p.point, region: p.rect, expectClient: w.client, motion: curves.next(cfg.motion).profile }, 20000); await new Promise((r) => setTimeout(r, 450)); }
    st.lastPreviewPassed=true; say('Dry run: the cursor visited ' + plan.map((p) => p.control).join(', ') + ' without clicking. Were those the right controls?'); } catch (e) { say('Dry run stopped: ' + e.message, true); }
}
async function testClick() {
  if(st.running)return say('Stop automation before a test click.',true);
  const s = selected(); if (!s) return; const k = $('simc-test-control').value; if (!window.confirm('This will CLICK "' + k + '" in ' + s.r.title + '. Continue?')) return;
  try { await requireCurrentDriver(); await call('arm'); const w = (await call('window-info', { hwnd: s.hwnd })).window, r = SP.calibrationReport(s.r.profile, w.client), c = r.controls[k]; if (!c || !c.point) throw new Error(k + ' is not calibrated');
    const cfg = settings(), x = await call('move-click', { hwnd: s.hwnd, to: c.point, region: c.clickRect, expectClient: w.client, motion: cfg.motion, focusPolicy: cfg.focusPolicy, preClickMs: cfg.timing.preClickMs, holdMs: cfg.timing.holdMs }, 20000);
    say('Clicked ' + k + ' at ' + x.clickedAt.x + ',' + x.clickedAt.y + ' after ' + Math.round(x.actualMs) + ' ms of movement (' + x.steps + ' steps).'); } catch (e) { say('Test click refused: ' + e.message, true); }
}
async function testBet() {
  if(st.running)return say('Stop automation before testing wager entry.',true);
  const s = selected(); if (!s) return; const amount = String(Math.floor(Number($('simc-test-amount').value) || 0)); if (!/^\d+$/.test(amount) || amount === '0') return say('Enter a whole amount.', true);
  try { await requireCurrentDriver(); await call('arm'); const w = (await call('window-info', { hwnd: s.hwnd })).window, f = SP.calibrationReport(s.r.profile, w.client).controls.wager; if (!f || !f.point) throw new Error('wager field not calibrated');
    const cfg = settings(), r = await call('enter-text', { hwnd: s.hwnd, to: f.point, region: f.clickRect, text: amount, expectClient: w.client, motion: cfg.motion, keyIntervalMs: cfg.timing.keyIntervalMs }, 30000);
    say('Typed ' + amount + ' and read back "' + r.read + '" (' + (r.verified ? 'verified' : 'MISMATCH') + '). Nothing was submitted.'); } catch (e) { say('Bet entry refused: ' + e.message, true); }
}

/* ---------- automation ---------- */
async function start() {
  if (!connect()) return; if (st.running) return say('Automation is already running.'); if (!st.registered.size) return say('Register at least one simulator window.', true);
  await restoreSettings();
  let cfg; try { cfg=settings(); } catch(e){return say(e.message,true);}
  const allowScripted = $('simc-scripted').checked; st.scheduler = new SCH.InputScheduler({ maxQueue: cfg.maxQueue, onCancel: () => st.session.request('cancel-all') });
  st.sources = new Map([...st.registered].map(([hwnd,r])=>[hwnd,new window.WorkbenchSimulatorDecisionSource.DecisionSource({mode:allowScripted && r.profile.execution.controlledFixture===true?'practice':'strict',seed:cfg.movement.seed+r.table,getSource:()=>({decide:async req=>{const loaded=window.multitablePanel&&window.multitablePanel.source;if(req.street==='preflop'){
 if(!loaded)return {status:'unavailable',reason:'No compatible EightMax preflop study is loaded'};
 const probe=await st.api.request('/api/simulator/decision',{probe:true});
 if(probe.status!=='ok')return {status:'unavailable',reason:probe.reason||'Native EightMax identity not verified'};
 const d=await loaded.decide(req);
 if(d.status==='ok'&&d.engine?.backend!=='native-cli-cpu')return {status:'unavailable',reason:'The loaded study does not identify native EightMax 5.1 training'};
 return {...d,engineVerification:probe.engineVerification};
 }return st.api.request('/api/simulator/decision',req);}})})]));
  st.tables = [...st.registered].map(([hwnd, r]) => new SC.SimulatorTable({ id: r.table, window: { hwnd, pid: r.pid, title: r.title, client: r.client }, profile: r.profile, api: st.api, session: st.session, scheduler: st.scheduler, qaAuthorization: r.auth.qa, recorder: st.recorder, decode: decodeBrowser,
    allowScripted: allowScripted && r.profile.execution.controlledFixture === true, decide: (state) => st.sources.get(hwnd).decide(state), motion: cfg.motion, movement: {...cfg.movement, seed: ((cfg.movement.seed + r.table - 1) >>> 0) || 1}, timing: cfg.timing, focusPolicy: cfg.focusPolicy, options: { decisionWindowMs: cfg.decisionWindowMs, postActionTimeoutMs: cfg.timing.postActionTimeoutMs, stopOnPause: false } }));
  try { await requireCurrentDriver(); await call('arm'); } catch (e) { return say('Cannot enable automation: ' + e.message, true); }
  const generation=st.generation=(st.generation||0)+1; st.running = true; say('Automated play started on ' + st.tables.length + ' window(s). Press ' + (cfg.hotkey) + ' or Emergency Stop at any time; touching the mouse makes the driver yield.');
  Promise.all(st.tables.map((t) => t.run(Infinity))).then(() => { if(st.generation===generation){st.running = false; refresh();} });
}
async function stopAll(reason) { for (const t of st.tables) t.stop(); if (st.scheduler) st.scheduler.pauseAll(reason); try { await call('disarm'); } catch (e) { /* host gone */ } st.running = false; say('Automation stopped (' + reason + '). Nothing resumes by itself.'); refresh(); }
async function estop() { if (!connect()) return; try { await st.api.request('/api/input/estop', {}); } catch (e) { /* still stop locally */ } if (st.scheduler) st.scheduler.emergencyStop('dashboard'); for (const t of st.tables) t.stop(); st.running = false; say('EMERGENCY STOP: movement cancelled, buttons and keys released, all input refused until Reset.', true); refresh(); }
async function resetEstop() { try { await call('reset-estop'); if (st.scheduler) st.scheduler.reset(); say('Emergency stop reset. Automation is still OFF; start it again explicitly.'); } catch (e) { say(e.message, true); } refresh(); }
function exportDiagnostics() { const doc = { format: 'eightmax-simulator-diagnostics', version: 1, app: '0.36.2-dev', at: new Date().toISOString(), settings: settings(), driver: st.driver && { running: st.driver.running, driver: st.driver.driver && { estop: st.driver.driver.estop, yielded: st.driver.driver.yielded, stats: st.driver.driver.stats, capabilities: st.driver.driver.capabilities }, events: st.driver.events }, scheduler: st.scheduler && st.scheduler.metrics(), tables: st.tables.map((t) => ({ ...t.report(), log: t.log.slice(-500) })), diagnostics: st.recorder.export(), lastError: st.lastError }; download('eightmax-simulator-diagnostics.json', JSON.stringify(doc, null, 2)); }
async function launch(tool) { if (!connect()) return; try { const r = await st.api.request('/api/desktop/launch', { tool }); say(r.message); } catch (e) { say(e.message, true); } }

/* ---------- wiring ---------- */
const on = (id, f) => { const e = $(id); if (e) e.addEventListener('click', f); };
on('simc-nav', () => { $('simc-panel').hidden = false; buildSettings(); restoreSettings(); bindCanvas(); try { const t = localStorage.getItem('eightmax-sim-profile'); if (t && !st.profile) { const r = PP.loadProfile(t); if (r.ok) st.profile = r.profile; } } catch (e) { /* none */ } $('simc-panel').scrollIntoView({ block: 'start' }); refresh(); listWindows(); });
on('simc-launch',()=>launch('test-tables'));
on('simc-studies',()=>{if(window.multitablePanel)window.multitablePanel.show(true);});
on('simc-reset-settings',()=>{if(st.running)return say('Stop automation before restoring defaults.',true);$('simc-settings').textContent='';buildSettings();say('Defaults restored in the panel. Save settings to keep them.');});
on('simc-close', () => { $('simc-panel').hidden = true; });
on('simc-refresh', refresh); on('simc-list', listWindows); on('simc-register', registerWindow); on('simc-calibrate', startCalibration); on('simc-uia', suggestUia);
on('simc-skip', () => { if (st.cal && st.cal.step < STEPS.length) { st.cal.step++; drawCal(); } }); on('simc-undo', () => { if (st.cal && st.cal.step > 0) { st.cal.step--; delete st.cal.regions[STEPS[st.cal.step][0]]; drawCal(); } });
on('simc-save-profile', saveProfile); on('simc-import', () => $('simc-import-file').click());
const fi = $('simc-import-file'); if (fi) fi.addEventListener('change', () => { const f = fi.files && fi.files[0]; if (f) f.text().then(loadProfile); });
on('simc-preview', preview); on('simc-test-click', testClick); on('simc-test-bet', testBet);
on('simc-start', async()=>{if(st.starting)return;st.starting=true;try{await start();}catch(e){say('Cannot start: '+e.message,true);}finally{st.starting=false;}}); on('simc-pause', () => { if (st.scheduler) st.scheduler.pauseAll('operator'); for (const t of st.tables) t.pause('operator'); say('All tables paused.'); renderTables(); });
on('simc-resume', () => { if (st.scheduler) st.scheduler.resumeAll(); for (const t of st.tables) if (t.paused === 'operator') t.resume(); say('Tables paused by you are eligible again (tables paused for a safety reason stay paused).'); renderTables(); });
on('simc-cancel', async () => { try { await call('cancel-all'); say('Current input cancelled.'); } catch (e) { say(e.message, true); } });
on('simc-stop', () => stopAll('operator')); on('simc-estop', estop); on('simc-reset-estop', resetEstop);
on('simc-manual', async () => { try { const now = !(st.driver && st.driver.driver && st.driver.driver.manual); await call('manual-mode', { on: now }); say(now ? 'Manual control mode: the driver refuses all input.' : 'Manual control mode off; automation still needs to be enabled.'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-resume-input', async () => { try { await call('resume'); say('Resumed after manual input. Automation continues only on tables that are not paused.'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-enable', async () => { try { await requireCurrentDriver(); await call('arm'); say('Automation enabled (input allowed into registered windows).'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-disable', async () => { try { await call('disarm'); say('Automation disabled.'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-restart', async () => { try { await st.api.request('/api/input/restart', {}); st.registered.clear(); say('Input driver restarted: registrations were cleared and automation is OFF.'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-selftest', () => launch('input-selftest')); on('simc-diag', exportDiagnostics); on('simc-save-settings', saveSettings);
setInterval(() => { if ($('simc-panel') && !$('simc-panel').hidden && st.api) refresh(); }, 2000);
window.WorkbenchSimulatorControlsUi = { state: st, refresh, settings, applySettings };
})();
