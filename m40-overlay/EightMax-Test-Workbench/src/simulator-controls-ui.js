/* EightMax Test Workbench 0.35.0 - "Simulator controls" panel: connect the operator's own simulator window, calibrate its controls,
   preview and test the visible mouse/keyboard input, run automated play with confirmation, and stop everything at once.
   Talks only to the local desktop host (/api/input/*, /api/capture/*) with the dashboard's session token. Nothing here can reach a
   window the operator did not select, confirm and authorise; the driver additionally checks the program's SHA-256.
   0.36.2 Milestone 2: every registration owns a WindowLifecycle (src/window-lifecycle.js) and the driver identity of the window
   (handle, process id, process start time, class, executable + SHA-256). Lost windows are shown as lost, never retried; a window that
   may replace one is only SUGGESTED (same executable SHA-256) and needs the operator's explicit confirmation, a fresh authorisation,
   a calibration check and an explicit "enable" before any input. Emergency stop wins over every recovery step. */
(function () {
'use strict';
const $ = (id) => document.getElementById(id), SC = window.WorkbenchSimulatorControls, LCM = window.WorkbenchWindowLifecycle || (SC && SC.Lifecycle), SP = window.WorkbenchSimulatorProfiles, PP = window.WorkbenchPlatformProfile, SCH = window.WorkbenchInputScheduler, XA = window.WorkbenchExecutionAdapters, M = window.WorkbenchInputMotion, PR = window.WorkbenchInputPresets, RC = window.WorkbenchRecognitionCheck;   // PR, RC: 0.36.2 M4.0
if (!SC || !SP || !LCM || !$('simc-panel')) return;
const st = { api: null, session: null, windows: [], registered: new Map(), profile: null, tables: [], scheduler: null, recorder: new XA.DiagnosticsRecorder({ max: 20000 }), running: false, cal: null, lastError: null, driver: null,
  retired: [], candidates: new Map(), lastCandidateScan: 0, probing: false, lifecycleEvents: [] };
const LS = LCM.STATES;
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
  { const v = PR.validate(motion.maxSpeed, motion.maxAccel === undefined ? 9000 : motion.maxAccel); if (!v.ok) throw Error(v.reason); }   // 0.36.2 M4.0: acceleration bounded too
  const movement = window.WorkbenchMovementSettings.validate({pattern: $('simc-set-pattern').value, variation: Number($('simc-set-variation').value), seed: Number($('simc-set-seed').value),direction:$('simc-set-direction').value,minCurvature:Number($('simc-set-minCurvature').value),maxCurvature:motion.arc});
  for (const [k,v] of Object.entries(timing)) { if (!Number.isFinite(v) || v < 0 || v > 10000 || (k==='holdMs' && (v<10 || v>1000))) throw Error('Invalid timing: '+k); }
  const maxQueue=Number($('simc-set-queue').value), decisionWindowMs=Number($('simc-set-window').value);
  if(!Number.isInteger(maxQueue)||maxQueue<1||maxQueue>64)throw Error('Queue size must be 1–64');
  if(!Number.isFinite(decisionWindowMs)||decisionWindowMs<1000||decisionWindowMs>60000)throw Error('Decision window must be 1000–60000 ms');
  if(timing.keyHoldMs>500||timing.keyIntervalMs>2000||timing.preClickMs>2000)throw Error('Keyboard/click timing exceeds driver limits');
  // 0.36.2 M4.0: the input pipeline and the scheduling policy (validated); the preset name is derived from the values, never stored as a value source
  const pipeline = ($('simc-set-pipeline') || {}).value || 'optimized', policy = ($('simc-set-policy') || {}).value || 'edf';
  if (!PR.PIPELINES[pipeline]) throw Error('Unknown input pipeline ' + pipeline); if (!SCH.POLICIES.includes(policy)) throw Error('Unknown scheduling policy ' + policy);
  const prof = M.profile(motion);
  return { movement, format: 'eightmax-input-settings', version: 1, motion: prof, timing: { ...M.DEFAULT_TIMING, ...timing }, focusPolicy: ($('simc-set-focus') || {}).value || 'bring-to-front', maxQueue, hotkey: ($('simc-set-hotkey') || {}).value || 'Ctrl+Alt+F12', decisionWindowMs,
    pipeline, policy, speedPreset: PR.presetOf(prof) };
}
/** 0.36.2 M4.0: show which preset (or Custom) the CURRENT field values are, and what that speed means; never changes a value. */
function showSpeed() {
  const sp = $('simc-set-maxSpeed'), ac = $('simc-set-maxAccel'), sel = $('simc-set-preset'), out = $('simc-set-speed-status'); if (!sp || !ac) return;
  const motion = { maxSpeed: Number(sp.value), maxAccel: Number(ac.value), minDurationMs: Number(($('simc-set-minDurationMs') || {}).value) || undefined }, v = PR.validate(motion.maxSpeed, motion.maxAccel);
  if (sel) sel.value = PR.presetOf(motion);
  if (out) out.textContent = v.ok ? 'Current mouse speed - ' + PR.describe(motion).text + '.' : 'Not a valid speed: ' + v.reason;
}
function buildSettings() {
  setupView();if($('simc-setup-check'))$('simc-setup-check').onclick=setupCheck;
  const box = $('simc-settings'); if (!box || box.childElementCount) return; const def = { ...M.DEFAULT_PROFILE, maxSpeed: 1200, arc: 0.12, maxDeviationPx:240, ...M.DEFAULT_TIMING };
  for (const [k, , label] of SETTINGS) { const l = el('label', label + ' '); const i = el('input'); i.id = 'simc-set-' + k; i.type = 'number'; i.value = String(def[k]); i.step = k === 'arc' ? '0.01' : '1'; l.appendChild(i); box.appendChild(l); }
  const speed = $('simc-set-maxSpeed'); speed.min='400'; speed.max='2800';
  const slider=el('input'); slider.id='simc-set-speed-slider'; slider.type='range'; slider.min='400'; slider.max='2800'; slider.step='50'; slider.value=speed.value;
  slider.setAttribute('aria-label','Mouse speed'); slider.oninput=()=>{speed.value=slider.value;showSpeed();}; speed.oninput=()=>{slider.value=speed.value;showSpeed();}; box.appendChild(slider);
  // 0.36.2 M4.0: mouse-speed presets (speed and acceleration only; Custom = the values typed above). Choosing one changes the two fields;
  // loading saved settings never does - the selector then just shows which preset (or Custom) they are.
  const pl=el('label','Mouse speed preset '), ps=el('select'); ps.id='simc-set-preset'; ps.setAttribute('aria-label','Mouse speed preset');
  for(const id of PR.ORDER){const o=el('option',id==='custom'?'Custom (the values above)':PR.PRESETS[id].label+' ('+PR.PRESETS[id].maxSpeed+' px/s)');o.value=id;ps.appendChild(o);}
  ps.onchange=()=>{ if(ps.value!=='custom'){ const m=PR.applyPreset({maxSpeed:Number(speed.value),maxAccel:Number($('simc-set-maxAccel').value)},ps.value); speed.value=slider.value=String(m.maxSpeed); $('simc-set-maxAccel').value=String(m.maxAccel); } showSpeed(); };
  pl.appendChild(ps); box.appendChild(pl); const accel=$('simc-set-maxAccel'); if(accel) accel.oninput=showSpeed;
  const status=el('p','','muted'); status.id='simc-set-speed-status'; status.setAttribute('role','status'); box.appendChild(status);
  const label=el('label','Movement pattern '), pattern=el('select');pattern.id='simc-set-pattern';
  for(const [value,name] of [['straight','Straight'],['fixed','Fixed Curve'],['random','Randomized Curves']]){const o=el('option',name);o.value=value;pattern.appendChild(o);}label.appendChild(pattern);box.appendChild(label);
  const dl=el('label','Fixed curve direction '), ds=el('select');ds.id='simc-set-direction';for(const v of ['left','right']){const o=el('option',v);o.value=v;ds.appendChild(o);}dl.appendChild(ds);box.appendChild(dl);
  for(const [id,name,value,min,max,step] of [['minCurvature','Minimum curvature',0,0,.25,.01],['variation','Curvature variation (0–1)',1,0,1,0.05],['seed','Random seed',1,1,4294967295,1]]) {const l=el('label',name+' '),i=el('input');i.id='simc-set-'+id;i.type='number';i.value=value;i.min=min;i.max=max;i.step=step;l.appendChild(i);box.appendChild(l);}
  for(const [name,v] of [['Low',0.05],['Medium',0.12],['High',0.25]]) {const b=el('button',name+' curvature','small');b.onclick=()=>{$('simc-set-arc').value=v;};box.appendChild(b);}
  for(const [name,v] of [['Straight','straight'],['Fixed Curve','fixed'],['Random Curves','random']]){const b=el('button','Preview '+name,'small');b.onclick=()=>{pattern.value=v;preview();};box.appendChild(b);}
  const f = el('label', 'Window focus '); const s = el('select'); s.id = 'simc-set-focus'; for (const o of ['bring-to-front', 'refuse']) { const op = el('option', o); op.value = o; s.appendChild(op); } f.appendChild(s); box.appendChild(f);
  for (const [id, label, v] of [['queue', 'Max queued actions', '16'], ['window', 'Decision window (ms)', '12000']]) { const l = el('label', label + ' '); const i = el('input'); i.id = 'simc-set-' + id; i.type = 'number'; i.value = v; l.appendChild(i); box.appendChild(l); }
  const h = el('label', 'Emergency-stop hotkey '); const hi = el('input'); hi.id = 'simc-set-hotkey'; hi.value = 'Ctrl+Alt+F12'; h.appendChild(hi); box.appendChild(h);
  // 0.36.2 M4.0: input pipeline and scheduling policy
  const pp=el('label','Input pipeline '), pps=el('select'); pps.id='simc-set-pipeline'; for(const p of Object.values(PR.PIPELINES)){const o=el('option',p.label);o.value=p.id;o.title=p.note;pps.appendChild(o);} pp.appendChild(pps); box.appendChild(pp);
  const sp2=el('label','Scheduling policy '), sps=el('select'); sps.id='simc-set-policy'; for(const [id,name] of [['edf','Earliest deadline first (default)'],['fifo','First in, first out'],['lst','Least slack first'],['edf-aging','Earliest deadline with aging'],['fair-rr','Round robin over tables'],['nearest-guarded','Nearest target, deadline-guarded']]){const o=el('option',name);o.value=id;sps.appendChild(o);} sp2.appendChild(sps); box.appendChild(sp2);
  showSpeed();
}
function applySettings(v) {
 if(!v || v.saved===false || v.format!=='eightmax-input-settings')return;
 const motion=M.profile(v.motion||{}), movement=window.WorkbenchMovementSettings.validate(v.movement||{});
 for(const [k,group] of SETTINGS){const value=group==='motion'?motion[k]:(v.timing||{})[k];if(value!==undefined)$('simc-set-'+k).value=value;}
 $('simc-set-pattern').value=movement.pattern;$('simc-set-variation').value=movement.variation;$('simc-set-seed').value=movement.seed;$('simc-set-direction').value=movement.direction;$('simc-set-minCurvature').value=movement.minCurvature===null?Math.abs(Number($('simc-set-arc').value))*(1-movement.variation):movement.minCurvature;
 for(const [id,key] of [['focus','focusPolicy'],['queue','maxQueue'],['window','decisionWindowMs'],['hotkey','hotkey']])if(v[key]!==undefined)$('simc-set-'+id).value=v[key];
 $('simc-set-speed-slider').value=$('simc-set-maxSpeed').value;
 if($('simc-set-pipeline'))$('simc-set-pipeline').value=PR.pipelineOf(v); if($('simc-set-policy'))$('simc-set-policy').value=SCH.POLICIES.includes(v.policy)?v.policy:'edf';
 showSpeed();   // 0.36.2 M4.0: shows the preset (or Custom) of the SAVED values; changes nothing
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
  try { await probeRegistrations(); await scanCandidates(false); } catch (e) { /* driver unavailable: probes report unknown */ }
  renderTables(); renderRecovery();
}
function ago(ms) { return ms === null || ms === undefined ? 'never' : ms < 1500 ? 'just now' : ms < 120000 ? Math.round(ms / 1000) + ' s ago' : Math.round(ms / 60000) + ' min ago'; }
function renderTables() {
  const t = $('simc-tables'); if (!t) return; t.textContent = ''; const h = el('tr'); for (const c of ['Table', 'Window', 'Lifecycle', 'Capture', 'Recognised state', 'Planned / last action', 'Input', 'Confirmation', '']) h.appendChild(el('th', c)); t.appendChild(h);
  const counts = {};
  for (const [hwnd, r] of st.registered) {
    const tab = tableFor(hwnd), s = tab && tab.lc === r.lifecycle ? tab.state : null, last = tab && tab.lc === r.lifecycle && tab.log[tab.log.length - 1], tr = el('tr'), snap = r.lifecycle ? r.lifecycle.snapshot() : null;
    if (snap) counts[snap.state] = (counts[snap.state] || 0) + 1;
    tr.appendChild(el('td', String(r.table))); tr.appendChild(el('td', r.title + ' · ' + r.client.w + '×' + r.client.h + ' @ ' + (r.dpiScale * 100).toFixed(0) + '%'));
    const lc = el('td'); if (snap) { tr.dataset.lifecycle = snap.state; lc.appendChild(el('b', snap.title + ' ', snap.state === LS.ACTIVE ? '' : 'bad')); lc.appendChild(el('small', '[' + snap.state + '] ' + snap.message));
      const facts = ['Last successful capture: ' + ago(snap.msSinceLastSuccessfulCapture)];
      if (snap.lastFailure) facts.push('Capture failure: ' + snap.lastFailure.code + ' — ' + snap.lastFailure.reason);
      const ex = snap.state === LS.TARGET_LOST ? 'no' : r.lastProbe ? (r.lastProbe.exists === true ? 'yes' : r.lastProbe.exists === false ? 'no' : 'unknown (' + (r.lastProbe.code || 'driver busy') + ')') : 'not checked yet';
      facts.push('Original window exists: ' + ex);
      facts.push('Automation: ' + (snap.state === LS.TARGET_LOST ? 'stopped for this table' : tab && tab.lc === r.lifecycle && !tab.stopped ? (tab.paused ? 'PAUSED — ' + tab.paused : snap.automationEligible ? 'running' : 'waiting for verification') : 'off'));
      const canc = tab && tab.lc === r.lifecycle && tab.cancellation; if (canc) facts.push('Queued action cancelled: ' + (canc.dropped || canc.cancelledRunning ? 'yes (' + canc.dropped + ' queued' + (canc.cancelledRunning ? ', 1 running' : '') + ')' : 'none was pending'));
      if (tab && tab.lc === r.lifecycle && tab.m.uncertain) facts.push('Uncertain actions needing review: ' + tab.m.uncertain);
      if (snap.state === LS.TARGET_LOST) { const n = (st.candidates.get(r.registrationId) || []).length; facts.push('Recovery: ' + (n ? n + ' replacement window(s) available — review below' : 'reopen the simulator, then Refresh registered windows')); facts.push('Re-registration required: yes'); }
      if (r.needsDryRun) facts.push('Dry run required before automation (calibration re-check)');
      // 0.36.2 M3: gameplay condition, hand tracking and tournament seating, each as its own line
      if (tab && tab.lc === r.lifecycle && tab.gameplayStatus) {
        const gs = tab.gameplayStatus(), tk = gs.tracking, tu = gs.tournament;
        facts.push('Gameplay: ' + gs.title + ' — ' + gs.message + (gs.detail ? ' (' + String(gs.detail).slice(0, 160) + ')' : ''));
        facts.push('Hand tracking: ' + (tk.status === 'untracked-hand' ? 'hand ' + tk.observedHand + ' not tracked (' + tk.reasonCode + '); waiting for ' + tk.expectedRecovery : tk.status === 'verifying' ? 'verifying fresh readings' : tk.status === 'refusing' ? 'refusing readings (' + tk.reasonCode + ': ' + String(tk.reason).slice(0, 120) + ')' : tk.status) + ' · last valid hand ' + (tk.lastValidHand === null ? '—' : tk.lastValidHand) + ' · recovered ' + tk.recoveries + ' time(s)');
        if (tu.handsOpened) facts.push('Tournament: ' + (tu.complete ? 'finished, seat ' + tu.complete.winner + ' holds every chip' : (tu.remaining === null ? '?' : tu.remaining) + ' player(s) remain' + (tu.headsUp ? ' (heads-up)' : '')) + (tu.eliminated.length ? ' · eliminated: ' + tu.eliminated.map((x) => 'seat ' + x.seat + (x.afterHand ? ' after hand ' + x.afterHand : '')).join(', ') : ''));
        if (gs.lastEvent) facts.push('Last seating event: ' + gs.lastEvent.detail);
      }
      if (r.replaces) facts.push('Replaces registration ' + r.replaces);
      for (const f of facts) lc.appendChild(el('div', f, 'muted')); }
    tr.appendChild(lc);
    tr.appendChild(el('td', tab && tab.lc === r.lifecycle ? tab.capture.frames + ' frames, ' + tab.capture.failures + ' failed' + (tab.capture.refusedLocally ? ', ' + tab.capture.refusedLocally + ' refused after loss' : '') : 'consented'));
    tr.appendChild(el('td', s ? 'hand ' + s.hand + ' · ' + s.street + ' · actor ' + s.actor + ' · pot ' + s.pot + (s.participants !== undefined && s.participants < 8 ? ' · ' + s.participants + ' dealt in' : '') : '—'));
    tr.appendChild(el('td', last ? (last.intended ? last.intended.type + (last.intended.amount ? ' ' + last.intended.amount : '') : '—') + ' (' + last.source + ')' : '—'));
    tr.appendChild(el('td', last && last.input ? 'cursor ' + Math.round(last.input.actualMs || 0) + ' ms' : (tab && tab.paused ? 'PAUSED: ' + tab.paused : '—')));
    tr.appendChild(el('td', last ? last.status + (last.reviewRequired ? ' (REVIEW)' : '') + (last.reason ? ': ' + last.reason : '') : '—'));
    const td = el('td');
    if (snap && snap.state === LS.TARGET_LOST) {
      const rv = el('button', 'Review replacement', 'small quiet'); rv.addEventListener('click', () => scanCandidates(true).then(() => { const b = $('simc-recovery'); if (b && !b.hidden) b.scrollIntoView({ block: 'start' }); })); td.appendChild(rv);
      const rm = el('button', 'Remove lost registration', 'small quiet'); rm.addEventListener('click', () => removeRegistration(hwnd)); td.appendChild(rm);
    } else {
      const b = el('button', tab && tab.paused ? 'Resume' : 'Pause', 'small quiet'); b.addEventListener('click', () => { if (!tab) return; if (tab.paused || tab.lc.is(LS.SAFETY_PAUSED)) { if (!tab.resume()) say('This table cannot resume: ' + tab.lc.message()[1], true); } else tab.pause('operator'); renderTables(); }); td.appendChild(b);
      if (st.running && !running(hwnd)) { const en = el('button', 'Enable automation for this table', 'small'); en.addEventListener('click', () => enableTable(hwnd)); td.appendChild(en); }
    }
    tr.appendChild(td); t.appendChild(tr);
  }
  const sum = $('simc-lifecycle-summary'); if (sum) sum.textContent = 'Window lifecycle: ' + (Object.entries(counts).map(([k, v]) => v + ' ' + k).join(', ') || 'no registrations');
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
    const old = st.registered.get(hwnd); if (old && old.lifecycle && !old.lifecycle.terminal && running(hwnd)) return say('This window is already registered and under automation.', true);
    const reg = await call('register-target', { hwnd, authorization: auth.simulator, label: w.title });
    const cap = await st.api.request('/api/capture/open', { target: { kind: 'window', hwnd, pid: w.pid, title: w.title, method: $('simc-capture').value }, consent: true }); if (!cap.ok) throw new Error(cap.reason || 'capture refused');
    if (old) retire(hwnd, old, 'registered again by the operator');
    const n = old ? old.table : nextTableNumber(); if (!n) throw new Error('At most 10 simulator windows can be registered. Remove a lost registration first.');
    st.registered.set(hwnd, newEntry({ table: n, w, reg, auth, prof, exeSha256: id.exeSha256, replaces: old && old.registrationId }));
    if (!st.profile) st.profile = prof; say('Registered ' + w.title + ' (' + exeName + ', SHA-256 ' + id.exeSha256.slice(0, 16) + '…) for ' + hours + ' h. Input goes ONLY to this window.'); renderTables();
  } catch (e) { say('Registration refused: ' + e.message, true); }
}

/* ---------- 0.36.2 M2: registration lifecycle ---------- */
function running(hwnd) { return st.running && st.tables.some((t) => t.win.hwnd === hwnd && !t.stopped && !t.lc.terminal); }
function tableFor(hwnd) { for (let i = st.tables.length - 1; i >= 0; i--) if (st.tables[i].win.hwnd === hwnd) return st.tables[i]; return null; }
function nextTableNumber() { const used = new Set([...st.registered.values()].map((r) => r.table)); for (let i = 1; i <= 10; i++) if (!used.has(i)) return i; return 0; }
function newEntry({ table, w, reg, auth, prof, exeSha256, replaces, needsDryRun }) {
  const win = (reg && reg.window) || w, identity = LCM.identityOf({ ...w, ...win, client: win.client || w.client, dpiScale: win.dpiScale || w.dpiScale }, { exeSha256 });
  const e = { table, title: w.title, pid: w.pid, client: w.client, dpiScale: w.dpiScale, auth, profile: prof, exeSha256, identity, replaces: replaces || null, needsDryRun: !!needsDryRun, lastProbe: null, registeredAt: new Date().toISOString() };
  e.lifecycle = new LCM.WindowLifecycle({ identity, table, replaces: e.replaces, onTransition: (ev) => lifecycleEvent(e, ev) }); e.registrationId = e.lifecycle.registrationId;
  st.recorder.record(table, 'lifecycle', { kind: 'registered', registrationId: e.registrationId, replaces: e.replaces, hwnd: identity.hwnd, pid: identity.pid, processStart: identity.processStart, exeSha256 });
  return e;
}
function lifecycleEvent(e, ev) {
  st.lifecycleEvents.push({ at: new Date().toISOString(), table: e.table, registrationId: e.registrationId, from: ev.from, to: ev.to, cause: ev.cause && ev.cause.kind, reason: ev.cause && ev.cause.reason }); if (st.lifecycleEvents.length > 200) st.lifecycleEvents.shift();
  if (ev.to === LS.TARGET_LOST) { const m = e.lifecycle.message(); say(m[0] + ' (table ' + e.table + '): ' + m[1], true); st.lastCandidateScan = 0; }
  try { renderTables(); } catch (x) { /* panel closed */ }
}
/** A window that is gone for good: lifecycle TARGET_LOST, driver authorisation and capture released. Idempotent. */
function lose(e, kind, reason, source) {
  if (!e.lifecycle || e.lifecycle.terminal) return;
  const t = tableFor(e.identity.hwnd); if (t && t.lc === e.lifecycle) { t.targetLost({ kind, code: kind === 'identity-changed' ? 'identity-changed' : 'target-lost', reason, source }); return; }
  e.lifecycle.lossSignals++; e.lifecycle.transition(LS.TARGET_LOST, { kind, code: kind === 'identity-changed' ? 'identity-changed' : 'target-lost', reason, source });
  st.recorder.record(e.table, 'lifecycle', { kind: 'target-lost', registrationId: e.registrationId, reason, source });
  call('unregister-target', { hwnd: e.identity.hwnd }).catch(() => null); st.api.request('/api/capture/close', { target: { kind: 'window', hwnd: e.identity.hwnd, pid: e.pid } }).catch(() => null);
}
function retire(hwnd, e, why) { st.retired.push({ table: e.table, title: e.title, registrationId: e.registrationId, replaces: e.replaces, retiredAt: new Date().toISOString(), why, lifecycle: e.lifecycle ? e.lifecycle.snapshot() : null }); if (st.retired.length > 50) st.retired.shift(); st.candidates.delete(e.registrationId); st.registered.delete(hwnd); }
/** Ask the driver whether each registration still exists and is still the same window (tables under automation check themselves). */
async function probeRegistrations() {
  if (!st.session || st.probing) return; st.probing = true;
  try {
    for (const [hwnd, e] of [...st.registered]) {
      if (!e.lifecycle || e.lifecycle.terminal) continue; if (running(hwnd)) { const t = tableFor(hwnd); e.lastProbe = { exists: true, at: Date.now(), via: 'automation' }; if (t && t.lc.terminal) e.lastProbe.exists = false; continue; }
      const p = await LCM.probeIdentity(st.session, e.identity); e.lastProbe = { exists: p.exists, matches: p.matches, at: Date.now(), code: p.code, minimized: p.minimized };
      if (p.exists === false) lose(e, 'window-closed', 'The window no longer exists.', 'refresh');
      else if (p.exists === true && !p.matches) lose(e, 'identity-changed', 'The window no longer matches the registered simulator: ' + p.problems.join('; '), 'refresh');
    }
  } finally { st.probing = false; }
}
/** For every lost registration: windows of the SAME executable (SHA-256 checked by the driver) that could replace it. Suggestions only. */
async function scanCandidates(force) {
  const lost = [...st.registered.values()].filter((e) => e.lifecycle && e.lifecycle.terminal); if (!lost.length) { st.candidates.clear(); return; }
  if (!force && Date.now() - st.lastCandidateScan < 5000) return; st.lastCandidateScan = Date.now();
  let windows; try { windows = (await call('list-windows')).windows; } catch (e) { return; }
  const active = [...st.registered.entries()].filter(([, e]) => e.lifecycle && !e.lifecycle.terminal).map(([h]) => h);
  for (const e of lost) {
    const found = LCM.replacementCandidates(e.identity, windows, { registeredHwnds: active, registrationId: e.registrationId }).slice(0, 3), ok = [];
    for (const c of found) { try { const id = await call('exe-identity', { hwnd: c.hwnd }); c.exeSha256 = id.exeSha256; c.shaMatches = !!e.identity.exeSha256 && id.exeSha256 === e.identity.exeSha256; } catch (x) { c.shaMatches = false; c.error = x.message; } if (c.shaMatches) ok.push(c); }
    st.candidates.set(e.registrationId, ok);
  }
  renderRecovery();
}
function lostEntryById(regId) { for (const [hwnd, e] of st.registered) if (e.registrationId === regId) return [hwnd, e]; return [null, null]; }
let recoverySig = null;
function renderRecovery() {
  const box = $('simc-recovery'), list = $('simc-recovery-list'); if (!box || !list) return;
  // rebuilt only when the lost registrations or their candidates change, so an operator's ticked confirmations are never reset
  const sig = JSON.stringify([...st.registered.values()].filter((e) => e.lifecycle && e.lifecycle.terminal).map((e) => [e.registrationId, (st.candidates.get(e.registrationId) || []).map((c) => c.hwnd + ':' + c.pid + ':' + c.shaMatches)]));
  if (sig === recoverySig) return; recoverySig = sig; list.textContent = ''; let any = false;
  for (const e of st.registered.values()) {
    if (!e.lifecycle || !e.lifecycle.terminal) continue; const cands = st.candidates.get(e.registrationId) || [];
    const card = el('div', undefined, 'simc-recovery-card'); card.style.border = '1px solid currentColor'; card.style.padding = '8px'; card.style.margin = '8px 0'; card.appendChild(el('h4', 'Table ' + e.table + ': ' + e.lifecycle.message()[0]));
    card.appendChild(el('p', e.lifecycle.message()[1] + ' Lost registration: ' + e.title + ' (pid ' + e.identity.pid + ', handle ' + e.identity.hwnd + ').'));
    if (!cands.length) card.appendChild(el('p', 'No replacement window found yet. Reopen the simulator, then press "Refresh registered windows".', 'muted'));
    for (const c of cands) {
      any = true; const tbl = el('table', undefined, 'sl-table'), row = (k, a, b) => { const tr = el('tr'); tr.appendChild(el('th', k)); tr.appendChild(el('td', a)); tr.appendChild(el('td', b)); tbl.appendChild(tr); };
      row('', 'Lost window', 'Candidate'); row('Title', e.title, c.title); row('Handle', e.identity.hwnd, c.hwnd + (c.sameHandleReused ? ' (same handle number reused - verified as a different process)' : '')); row('Process', 'pid ' + e.identity.pid, 'pid ' + c.pid);
      row('Executable', String(e.identity.exe || '').split('\\').pop(), String(c.exe || '').split('\\').pop()); row('SHA-256', (e.identity.exeSha256 || '?').slice(0, 16) + '…', (c.exeSha256 || '?').slice(0, 16) + '… ' + (c.shaMatches ? '✓ same program' : '✗ different program'));
      row('Client size', e.identity.client ? e.identity.client.w + '×' + e.identity.client.h : '?', c.client ? c.client.w + '×' + c.client.h : '?'); row('Display scaling', Math.round((e.identity.dpiScale || 1) * 100) + '%', Math.round((c.dpiScale || 1) * 100) + '%');
      card.appendChild(tbl); if (c.calibrationRecheckRequired) card.appendChild(el('p', 'The window size or display scaling changed: the calibration is checked again and a dry run (Preview mouse movement) is required before automation.', 'bad'));
      const conf = el('div', undefined, 'study-controls'), boxes = ['This is my own simulator', 'Test environment only', 'No real money'].map((label) => { const l = el('label'), i = el('input'); i.type = 'checkbox'; l.appendChild(i); l.appendChild(document.createTextNode(' ' + label)); conf.appendChild(l); return i; });
      const b = el('button', 'Register this window as the replacement', 'small'); b.dataset.candidate = c.hwnd; b.addEventListener('click', () => registerReplacement(e.registrationId, c, boxes)); conf.appendChild(b); card.appendChild(conf);
    }
    const rm = el('button', 'Remove lost registration', 'small quiet'); rm.addEventListener('click', () => removeRegistration(e.identity.hwnd)); card.appendChild(rm); list.appendChild(card);
  }
  box.hidden = !list.childElementCount; if (any) say('A window that may replace a lost simulator was found. Review it under "Replacement window review"; nothing is controlled until you confirm.');
}
async function registerReplacement(regId, c, boxes) {
  if (!connect()) return; const [oldHwnd, old] = lostEntryById(regId); if (!old) return say('That lost registration no longer exists.', true);
  if (!boxes.every((b) => b.checked)) return say('Confirm that the replacement is your own simulator, a test environment and involves no real money.', true);
  try {
    const s = await st.api.request('/api/input/status'); if (s && s.driver && s.driver.estop) return say('Emergency stop is latched. Reset it before registering a replacement window.', true);
    if (!window.confirm('Register "' + c.title + '" (pid ' + c.pid + ') as the replacement for table ' + old.table + '? It will NOT be controlled until you enable automation for it.')) return;
    const id = await call('exe-identity', { hwnd: c.hwnd }), w = { ...c, ...(id.window || {}), hwnd: c.hwnd, title: c.title, exe: (id.window && id.window.exe) || c.exe };
    if (!old.identity.exeSha256 || id.exeSha256 !== old.identity.exeSha256) return say('Replacement refused: the window belongs to a different program (SHA-256 ' + String(id.exeSha256).slice(0, 12) + '…).', true);
    const prof = old.profile, sim = prof.execution.simulator, exeName = String(w.exe || '').split('\\').pop(); if (sim.exeFileName.toLowerCase() !== exeName.toLowerCase() || (sim.exeSha256 && sim.exeSha256 !== id.exeSha256)) return say('Replacement refused: the profile is bound to a different executable.', true);
    const hours = Math.min(8, Math.max(0.25, Number($('simc-hours').value) || 2)), auth = SC.authorizations({ environment: 'operator-simulator', approvedBy: ($('simc-approver').value || 'operator').slice(0, 60), exeFileName: exeName, exeSha256: id.exeSha256, hours });
    const reg = await call('register-target', { hwnd: c.hwnd, authorization: auth.simulator, label: c.title });
    const info = (await call('window-info', { hwnd: c.hwnd })).window, report = SP.calibrationReport(prof, info.client, { dpiScale: info.dpiScale });
    if (!report.ready) { call('unregister-target', { hwnd: c.hwnd }).catch(() => null); return say('Replacement refused: the calibration does not fit the new window (' + (report.problems || []).join('; ') + '). Calibrate again.', true); }
    const cap = await st.api.request('/api/capture/open', { target: { kind: 'window', hwnd: c.hwnd, pid: c.pid, title: c.title, method: $('simc-capture').value }, consent: true }); if (!cap.ok) throw new Error(cap.reason || 'capture refused');
    retire(oldHwnd, old, 'replaced by ' + c.hwnd);
    const e = newEntry({ table: old.table, w: { ...w, client: info.client, dpiScale: info.dpiScale }, reg, auth, prof, exeSha256: id.exeSha256, replaces: regId, needsDryRun: c.calibrationRecheckRequired });
    st.registered.set(c.hwnd, e); st.candidates.delete(regId); $('simc-window').value = c.hwnd;
    say('Replacement registered for table ' + e.table + ' (' + c.title + '). It inherits nothing: automation for it is OFF. ' + (e.needsDryRun ? 'Run "Preview mouse movement" first (the window size or scaling changed), then ' : '') + (st.running ? 'press "Enable automation for this table".' : 'start automation explicitly.'));
    renderRecovery(); renderTables();
  } catch (x) { say('Replacement registration refused: ' + x.message, true); }
}
function removeRegistration(hwnd) { const e = st.registered.get(hwnd); if (!e) return; if (running(hwnd)) return say('Stop automation for this table first.', true); if (e.lifecycle && !e.lifecycle.terminal) { call('unregister-target', { hwnd }).catch(() => null); st.api.request('/api/capture/close', { target: { kind: 'window', hwnd, pid: e.pid } }).catch(() => null); } retire(hwnd, e, 'removed by the operator'); say('Registration for table ' + e.table + ' removed.'); renderRecovery(); renderTables(); }
async function refreshRegistrations() { if (!connect()) return; try { await probeRegistrations(); await scanCandidates(true); const lost = [...st.registered.values()].filter((e) => e.lifecycle && e.lifecycle.terminal).length; say('Registered windows checked: ' + (st.registered.size - lost) + ' available, ' + lost + ' lost.' + (lost ? ' Lost tables need a new registration.' : '')); } catch (x) { say('Refresh failed: ' + x.message, true); } renderTables(); renderRecovery(); }

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
 if(!caps.signedCurves||!caps.maxDeviationPx)throw Error('This development package requires a rebuilt 0.36.1 input driver. The bundled baseline executable cannot apply these settings. See REPORT-0.36.1.md.');
 st.session.capabilities=caps;
}
async function preview() {
  st.lastPreviewPassed=false;
  if(st.running) return say('Stop automation before previewing movement.',true);
  const s = selected(); if (!s) return; try { await restoreSettings(); await requireCurrentDriver(); await call('arm'); const w = (await call('window-info', { hwnd: s.hwnd })).window, plan = SP.dryRunPlan(s.r.profile, w.client), cfg = settings(), curves = new window.WorkbenchMovementSettings.Sequence(cfg.movement);
    for (const p of plan) { await call('move', { hwnd: s.hwnd, to: p.point, region: p.rect, expectClient: w.client, motion: curves.next(cfg.motion).profile }, 20000); await new Promise((r) => setTimeout(r, 450)); }
    st.lastPreviewPassed=true; s.r.needsDryRun=false; say('Dry run: the cursor visited ' + plan.map((p) => p.control).join(', ') + ' without clicking. Were those the right controls?'); } catch (e) { say('Dry run stopped: ' + e.message, true); }
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


/* ---------- 0.36.2 M4.0: Verify Table Recognition (recognition-check.js) ---------- */
async function monitorOf(client) {
  try { const m = await call('monitors'); const cx = client.x + client.w / 2, cy = client.y + client.h / 2;
    const hit = (m.monitors || []).find((x) => x.bounds && cx >= x.bounds.x && cy >= x.bounds.y && cx < x.bounds.x + x.bounds.w && cy < x.bounds.y + x.bounds.h);
    return hit ? { bounds: hit.bounds, scale: hit.dpiScale, name: hit.name } : null; } catch (e) { return null; }
}
/** One fresh capture of a registered window, read as the automation reads it; the result is kept with the registration. No input. */
async function verifyOne(hwnd, r) {
  let rep; try {
    rep = await SC.verifyRecognition({ api: st.api, window: { hwnd, pid: r.pid, title: r.title }, profile: r.profile, table: r.table, decode: decodeBrowser, method: $('simc-capture').value });
    if (rep.window && rep.window.client) { const mon = await monitorOf(rep.window.client); if (mon) { rep.window.monitor = mon; if (mon.scale && rep.window.scalePercent && Math.round(mon.scale * 100) !== rep.window.scalePercent) rep.notes.push('geometry: the window reports ' + rep.window.scalePercent + ' %, its monitor ' + Math.round(mon.scale * 100) + ' %'); } }
  } catch (e) { rep = RC.captureFailed({ table: r.table, hwnd, title: r.title, code: e.code, reason: e.message }); }
  r.recognition = rep; st.recorder.record(r.table, 'system', { kind: 'recognition-check', verdict: rep.verdict, critical: rep.critical.slice(0, 5), notes: rep.notes.slice(0, 5), client: rep.window.client, scalePercent: rep.window.scalePercent });
  return rep;
}
async function verifyRecognition() {
  if (!connect()) return; const regs = [...st.registered].filter(([, r]) => r.lifecycle && !r.lifecycle.terminal);
  if (!regs.length) return say('Register at least one simulator window first.', true);
  say('Verify Table Recognition: one fresh capture of ' + regs.length + ' window(s), read exactly as automated play reads it. No input is sent.');
  const out = []; for (const [hwnd, r] of regs) out.push(await verifyOne(hwnd, r));
  renderRecognition(); renderTables();
  const failed = out.filter((x) => x.verdict === 'fail').length, partial = out.filter((x) => x.verdict === 'pass-frame-unreadable').length;
  say('Verify Table Recognition: ' + (out.length - failed) + ' of ' + out.length + ' window(s) passed' + (partial ? ' (' + partial + ' with a frame that was not fully readable - check again during a hand)' : '') + (failed ? '. ' + failed + ' FAILED: automated input stays off for ' + (failed > 1 ? 'those tables' : 'that table') + ' until a check passes.' : '.'), failed > 0);
}
function renderRecognition() {
  const box = $('simc-recognition'); if (!box) return; box.textContent = '';
  const fmtBox = (b) => (b ? b.x + ',' + b.y + ' ' + b.w + 'x' + b.h : '—'), fmtPt = (p) => (p ? p.x + ',' + p.y : '—');
  for (const [, r] of st.registered) {
    const rep = r.recognition; if (!rep) continue; const d = el('details'); d.className = 'simc-rc simc-rc-' + rep.verdict; if (rep.verdict === 'fail') d.open = true;
    d.appendChild(el('summary', 'Table ' + r.table + ' — ' + RC.summary(rep)));
    const w = rep.window || {}, lines = [];
    lines.push('Window: ' + (w.title || '—') + ' (' + (w.hwnd || '—') + '); client area ' + fmtBox(w.client) + ' physical px; display scale ' + (w.scalePercent === null ? 'unknown' : w.scalePercent + ' %') + (w.logicalSize ? ' (logical ' + w.logicalSize.w + 'x' + w.logicalSize.h + ')' : '') + (w.monitor ? '; monitor ' + (w.monitor.name || '') + ' ' + fmtBox(w.monitor.bounds) : '') + '; capture ' + (w.captureMethod || '—') + (w.image ? ' ' + w.image.width + 'x' + w.image.height : ''));
    if (rep.strip) lines.push('Status strip: ' + (rep.strip.ok ? 'table ' + rep.strip.table + ', seat shown at the bottom ' + rep.strip.viewSeat : 'unreadable: ' + rep.strip.reason));
    for (const t of lines) d.appendChild(el('p', t));
    const tb = el('table'); tb.className = 'sl-table'; const hr = el('tr'); for (const c of ['Control', 'Calibrated (0-1)', 'Click rectangle (physical px)', 'Click point', 'Status']) hr.appendChild(el('th', c)); tb.appendChild(hr);
    for (const [k, c] of Object.entries((rep.calibration && rep.calibration.controls) || {})) { const tr = el('tr'); const n = c.normalized; for (const v of [k, n ? [n.x, n.y, n.w, n.h].map((x) => (+x).toFixed(3)).join(', ') : '—', fmtBox(c.rect), fmtPt(c.point), c.ok ? 'ok' : 'FAILED: ' + c.reason]) tr.appendChild(el('td', String(v))); tb.appendChild(tr); }
    d.appendChild(tb);
    const rc = rep.recognition || {}, g = rc.recognised;
    if (g) d.appendChild(el('p', 'Recognised (' + rc.ms + ' ms, layout ' + rc.layout + '): hand ' + g.hand + ', ' + g.street + ', ' + g.status + '; board ' + (g.board.length ? g.board.join(' ') : 'none') + '; hero cards ' + (g.heroCards ? g.heroCards.join(' ') : 'not shown') + '; pot ' + g.pot + '; button seat ' + g.button + '; to act ' + g.actor + '; stacks ' + g.stacks.join(' / ') + '; bets ' + g.bets.join(' / ') + (g.controls ? '; enabled controls ' + Object.keys(g.controls).filter((k) => g.controls[k]).join(', ') : '') + (g.callAmount !== null ? '; call ' + g.callAmount : '') + (g.minRaiseTo !== null ? '; minimum raise to ' + g.minRaiseTo : '')));
    if (rc.confidence) d.appendChild(el('p', 'Confidence: lowest ' + rc.confidence.overall + ' — ' + Object.entries(rc.confidence.fields).map(([k, v]) => k + ' ' + v).join(', ')));
    if (rep.positions) d.appendChild(el('p', 'Positions (physical px): board ' + rep.positions.board.map(fmtBox).join(' | ') + '; hero cards ' + rep.positions.hero.map(fmtBox).join(' | ') + '; pot ' + fmtBox(rep.positions.pot) + (rep.positions.handId ? '; hand number ' + fmtBox(rep.positions.handId) : '')));
    if (rc.unreadable && rc.unreadable.length) d.appendChild(el('p', 'Not readable in this frame (never guessed): ' + rc.unreadable.join('; ')));
    if (rep.critical.length) d.appendChild(el('p', 'Safety-critical: ' + rep.critical.join('; ')));
    if (rep.notes.length) d.appendChild(el('p', 'Notes: ' + rep.notes.join('; ')));
    box.appendChild(d);
  }
}
function exportRecognition() {
  const reps = [...st.registered.values()].filter((r) => r.recognition).map((r) => r.recognition); if (!reps.length) return say('Run Verify Table Recognition first.', true);
  download('eightmax-recognition-check-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json', JSON.stringify({ format: 'eightmax-recognition-checks', version: 1, app: '0.36.2-dev', milestone: '0.36.2-milestone-4.0', at: new Date().toISOString(), captureMethod: $('simc-capture').value, reports: reps }, null, 1));
}

/* ---------- automation ---------- */
function decisionSource(hwnd, r, cfg, allowScripted) {
  return new window.WorkbenchSimulatorDecisionSource.DecisionSource({mode:allowScripted && r.profile.execution.controlledFixture===true?'practice':'strict',seed:cfg.movement.seed+r.table,getSource:()=>({decide:async req=>{const loaded=window.multitablePanel&&window.multitablePanel.source;if(req.street==='preflop'){
 if(!loaded)return {status:'unavailable',reason:'No compatible EightMax preflop study is loaded'};
 const probe=await st.api.request('/api/simulator/decision',{probe:true});
 if(probe.status!=='ok')return {status:'unavailable',reason:probe.reason||'Native EightMax identity not verified'};
 const d=await loaded.decide(req);
 if(d.status==='ok'&&d.engine?.backend!=='native-cli-cpu')return {status:'unavailable',reason:'The loaded study does not identify native EightMax 5.1 training'};
 return {...d,engineVerification:probe.engineVerification};
 }return st.api.request('/api/simulator/decision',req);}})});
}
function makeTable(hwnd, r, cfg, allowScripted) {
  st.sources.set(hwnd, decisionSource(hwnd, r, cfg, allowScripted));
  return new SC.SimulatorTable({ id: r.table, window: { hwnd, pid: r.pid, title: r.title, client: r.client }, profile: r.profile, api: st.api, session: st.session, scheduler: st.scheduler, qaAuthorization: r.auth.qa, recorder: st.recorder, decode: decodeBrowser,
    identity: r.identity, lifecycle: r.lifecycle, registrationId: r.registrationId, captureMethod: $('simc-capture').value,
    allowScripted: allowScripted && r.profile.execution.controlledFixture === true, decide: (state) => st.sources.get(hwnd).decide(state), motion: cfg.motion, movement: {...cfg.movement, seed: ((cfg.movement.seed + r.table - 1) >>> 0) || 1}, timing: cfg.timing, focusPolicy: cfg.focusPolicy, options: { decisionWindowMs: cfg.decisionWindowMs, postActionTimeoutMs: cfg.timing.postActionTimeoutMs, stopOnPause: false },
    pipeline: cfg.pipeline || 'optimized', timelines: st.timelines || undefined });
}
/** Before automation: every registration is checked against the driver; lost ones are marked and skipped (never captured). */
async function preflight() {
  const usable = [], lost = [], skipped = [];
  for (const [hwnd, r] of [...st.registered]) {
    if (!r.lifecycle || r.lifecycle.terminal) { lost.push(r); continue; }
    const p = await LCM.probeIdentity(st.session, r.identity); r.lastProbe = { exists: p.exists, matches: p.matches, at: Date.now(), code: p.code };
    if (p.exists === false) { lose(r, 'window-closed', 'The window no longer exists.', 'start'); lost.push(r); continue; }
    if (p.exists === true && !p.matches) { lose(r, 'identity-changed', 'The window no longer matches the registered simulator: ' + p.problems.join('; '), 'start'); lost.push(r); continue; }
    if (p.exists !== true) { skipped.push(r.table + ' (window state unknown: ' + p.code + ')'); continue; }
    if (r.needsDryRun) { skipped.push(r.table + ' (dry run required)'); continue; }
    // 0.36.2 M4.0: Verify Table Recognition runs on every window before automation starts; a safety-critical failure keeps its input off
    const rep = await verifyOne(hwnd, r); if (rep.verdict === 'fail') { skipped.push(r.table + ' (recognition check failed: ' + rep.critical.slice(0, 2).join('; ') + ')'); continue; }
    usable.push([hwnd, r]);
  }
  return { usable, lost, skipped };
}
async function start() {
  if (!connect()) return; if (st.running) return say('Automation is already running.'); if (!st.registered.size) return say('Register at least one simulator window.', true);
  await restoreSettings();
  let cfg; try { cfg=settings(); } catch(e){return say(e.message,true);}
  const pre = await preflight(); renderTables(); renderRecognition();
  if (!pre.usable.length) return say('No registered simulator window can be automated. ' + (pre.lost.length ? pre.lost.length + ' registration(s) lost: reopen the simulator and register its window again. ' : '') + (pre.skipped.length ? 'Not ready: table ' + pre.skipped.join(', table ') + '.' : ''), true);
  const allowScripted = $('simc-scripted').checked; st.scheduler = new SCH.InputScheduler({ maxQueue: cfg.maxQueue, onCancel: () => st.session.request('cancel-all'), policy: cfg.policy, dispatchEstimate: cfg.pipeline === 'optimized' }); st.cfg = cfg; st.allowScripted = allowScripted;
  st.api.priorityLane = cfg.pipeline === 'optimized'; st.timelines = new (window.WorkbenchActionTimeline.TimelineAggregator)({ max: 20000 });   // 0.36.2 M4.0
  st.sources = new Map();
  try { await requireCurrentDriver(); await call('arm'); } catch (e) { return say('Cannot enable automation: ' + e.message, true); }
  // explicit operator start: stopped / safety-paused registrations are verified again from scratch (never straight to ACTIVE)
  for (const [, r] of pre.usable) if (r.lifecycle.is(LS.STOPPED, LS.SAFETY_PAUSED)) r.lifecycle.transition(LS.RECOVERY_PENDING, { kind: 'operator-start', reason: 'operator started automation', operator: true });
  for (const t of st.tables) t.dispose();
  st.tables = pre.usable.map(([hwnd, r]) => makeTable(hwnd, r, cfg, allowScripted));
  const generation=st.generation=(st.generation||0)+1; st.running = true; say('Automated play started on ' + st.tables.length + ' window(s)' + (pre.lost.length ? ' (' + pre.lost.length + ' lost registration(s) skipped)' : '') + (pre.skipped.length ? ' (not ready: table ' + pre.skipped.join(', table ') + ')' : '') + '. Press ' + (cfg.hotkey) + ' or Emergency Stop at any time; touching the mouse makes the driver yield.');
  runTables(st.tables, generation);
}
function runTables(tables, generation) { Promise.all(tables.map((t) => t.run(Infinity))).then(() => { if(st.generation===generation && st.tables.every((t) => t.stopped || t.lc.terminal)){st.running = false; refresh();} }); }
/** A replacement (or a table skipped at start) joins a running session only on this explicit operator action. */
async function enableTable(hwnd) {
  const r = st.registered.get(hwnd); if (!r || !st.running || !st.scheduler) return say('Start automation first.', true);
  if (running(hwnd)) return say('This table is already under automation.');
  if (r.lifecycle.terminal) return say('This registration is lost; register the window again.', true);
  if (r.needsDryRun) return say('Run "Preview mouse movement" for this table first (calibration re-check).', true);
  try {
    const s = await st.api.request('/api/input/status'); if (s && s.driver && s.driver.estop) return say('Emergency stop is latched. Reset it first.', true);
    const p = await LCM.probeIdentity(st.session, r.identity); if (p.exists !== true || !p.matches) { if (p.exists === false) lose(r, 'window-closed', 'The window no longer exists.', 'enable'); else if (p.exists === true) lose(r, 'identity-changed', p.problems.join('; '), 'enable'); return say('Table ' + r.table + ' cannot be enabled: the window is not available.', true); }
    await requireCurrentDriver(); await call('arm');
    if (r.lifecycle.is(LS.STOPPED, LS.SAFETY_PAUSED)) r.lifecycle.transition(LS.RECOVERY_PENDING, { kind: 'operator-enable', reason: 'operator enabled this table', operator: true });
    const old = tableFor(hwnd); if (old) old.dispose();
    const t = makeTable(hwnd, r, st.cfg, st.allowScripted); st.tables.push(t); runTables([t], st.generation);
    say('Automation enabled for table ' + r.table + '. It acts only after its identity and a fresh reading are verified.'); renderTables();
  } catch (e) { say('Cannot enable table ' + r.table + ': ' + e.message, true); }
}
async function stopAll(reason) { for (const t of st.tables) t.stop(reason); if (st.scheduler) st.scheduler.pauseAll(reason); try { await call('disarm'); } catch (e) { /* host gone */ } st.running = false; say('Automation stopped (' + reason + '). Nothing resumes by itself.'); refresh(); }
async function estop() { if (!connect()) return; try { await st.api.request('/api/input/estop', {}); } catch (e) { /* still stop locally */ } if (st.scheduler) st.scheduler.emergencyStop('dashboard'); for (const t of st.tables) { t.safetyPause('emergency-stop', 'emergency stop (dashboard)'); t.stop(); }
  for (const r of st.registered.values()) if (r.lifecycle && !r.lifecycle.terminal) r.lifecycle.transition(LS.SAFETY_PAUSED, { kind: 'emergency-stop', reason: 'emergency stop (dashboard)' });   // no recovery step may re-enable input
  st.running = false; say('EMERGENCY STOP: movement cancelled, buttons and keys released, all input refused until Reset.', true); refresh(); }
async function resetEstop() { try { await call('reset-estop'); if (st.scheduler) st.scheduler.reset(); say('Emergency stop reset. Automation is still OFF and every table stays paused; start it again explicitly (each window is verified again first).'); } catch (e) { say(e.message, true); } refresh(); }
function failureSummary() {
  const sum = { inputDriverErrors: 0, captureFailures: 0, recognitionFailures: 0, strategyUnavailable: 0, inputCancellations: 0, emergencyStops: 0, manualOverrides: 0, targetLost: 0, lossSignals: 0, transientCaptureFailures: 0, uncertainActions: 0 };
  for (const t of st.tables) { const r = t.report(); for (const k of Object.keys(sum)) sum[k] += (r.failureFamilies && r.failureFamilies[k]) || (k === 'uncertainActions' ? r.recovery.uncertainActions : 0); }
  sum.targetLost = [...st.registered.values()].filter((e) => e.lifecycle && e.lifecycle.terminal).length + st.retired.filter((x) => x.lifecycle && x.lifecycle.state === LS.TARGET_LOST).length;
  return sum;
}
function exportDiagnostics() { const doc = { format: 'eightmax-simulator-diagnostics', version: 1, app: '0.36.2-dev', milestone: '0.36.2-milestone-2', extensions: ['window-lifecycle-v1', 'coalesced-diagnostics-v1'], at: new Date().toISOString(), settings: settings(), driver: st.driver && { running: st.driver.running, driver: st.driver.driver && { estop: st.driver.driver.estop, yielded: st.driver.driver.yielded, stats: st.driver.driver.stats, capabilities: st.driver.driver.capabilities }, events: st.driver.events }, scheduler: st.scheduler && st.scheduler.metrics(), tables: st.tables.map((t) => ({ ...t.report(), log: t.log.slice(-500) })), diagnostics: st.recorder.export(), lastError: st.lastError,
  registrations: [...st.registered.values()].map((e) => ({ table: e.table, title: e.title, registrationId: e.registrationId, replaces: e.replaces, registeredAt: e.registeredAt, needsDryRun: e.needsDryRun, lastProbe: e.lastProbe, lifecycle: e.lifecycle && e.lifecycle.snapshot(), replacementCandidates: (st.candidates.get(e.registrationId) || []).map((c) => ({ hwnd: c.hwnd, pid: c.pid, title: c.title, shaMatches: c.shaMatches, calibrationRecheckRequired: c.calibrationRecheckRequired })) })),
  retiredRegistrations: st.retired.slice(), lifecycleEvents: st.lifecycleEvents.slice(), failureSummary: failureSummary() }; download('eightmax-simulator-diagnostics.json', JSON.stringify(doc, null, 2)); return doc; }
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
on('simc-preview', preview); on('simc-test-click', testClick); on('simc-test-bet', testBet); on('simc-verify-recognition', verifyRecognition); on('simc-export-recognition', exportRecognition);
on('simc-start', async()=>{if(st.starting)return;st.starting=true;try{await start();}catch(e){say('Cannot start: '+e.message,true);}finally{st.starting=false;}}); on('simc-pause', () => { if (st.scheduler) st.scheduler.pauseAll('operator'); for (const t of st.tables) t.pause('operator'); say('All tables paused.'); renderTables(); });
on('simc-resume', () => { if (st.scheduler) st.scheduler.resumeAll(); for (const t of st.tables) if (t.paused === 'operator') t.resume(); say('Tables paused by you are eligible again (tables paused for a safety reason stay paused).'); renderTables(); });
on('simc-cancel', async () => { try { await call('cancel-all'); say('Current input cancelled.'); } catch (e) { say(e.message, true); } });
on('simc-stop', () => stopAll('operator')); on('simc-estop', estop); on('simc-reset-estop', resetEstop);
on('simc-manual', async () => { try { const now = !(st.driver && st.driver.driver && st.driver.driver.manual); await call('manual-mode', { on: now }); say(now ? 'Manual control mode: the driver refuses all input.' : 'Manual control mode off; automation still needs to be enabled.'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-resume-input', async () => { try { await call('resume'); say('Resumed after manual input. Automation continues only on tables that are not paused.'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-enable', async () => { try { await requireCurrentDriver(); await call('arm'); say('Automation enabled (input allowed into registered windows).'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-disable', async () => { try { await call('disarm'); say('Automation disabled.'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-restart', async () => { try { await st.api.request('/api/input/restart', {}); for (const [h, e] of [...st.registered]) { if (e.lifecycle && !e.lifecycle.terminal) e.lifecycle.transition(LS.STOPPED, { kind: 'driver-restarted', reason: 'input driver restarted: registration cleared', operator: true }); retire(h, e, 'input driver restarted'); } say('Input driver restarted: registrations were cleared and automation is OFF.'); refresh(); } catch (e) { say(e.message, true); } });
on('simc-selftest', () => launch('input-selftest')); on('simc-diag', exportDiagnostics); on('simc-export-report', exportDiagnostics);
on('simc-refresh-registrations', refreshRegistrations); on('simc-review-replacement', async () => { if (!connect()) return; await scanCandidates(true); const b = $('simc-recovery'); if (b && !b.hidden) b.scrollIntoView({ block: 'start' }); else say('No lost registration has a replacement window yet. Reopen the simulator, then press Refresh registered windows.'); }); on('simc-save-settings', saveSettings);
setInterval(() => { if ($('simc-panel') && !$('simc-panel').hidden && st.api) refresh(); }, 2000);
window.WorkbenchSimulatorControlsUi = { state: st, refresh, settings, applySettings, refreshRegistrations, scanCandidates, registerReplacement, enableTable, exportDiagnostics };
})();
