'use strict';
// DOM logic test only. This does not replace real-browser or Windows GUI acceptance.
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const root=path.join(__dirname,'..');
function harness(storage){
 const elements=new Map();
 class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners={};this.dataset={};this.value='';this.textContent='';this.classList={toggle(){}};}
  set id(v){this._id=v;elements.set(v,this);}get id(){return this._id;}
  get childElementCount(){return this.children.length;}
  appendChild(e){this.children.push(e);if(this.tagName==='select'&&this.children.length===1)this.value=e.value;return e;}
  addEventListener(k,f){this.listeners[k]=f;}
  setAttribute(){}scrollIntoView(){}getContext(){return {};}
  click(){return this.listeners.click?this.listeners.click():this.onclick&&this.onclick();}
 }
 const get=id=>{if(!elements.has(id)){const e=new Element();e.id=id;}return elements.get(id);};
 const w={document:{getElementById:get,createElement:tag=>new Element(tag)},setInterval(){},setTimeout,clearTimeout,localStorage:{getItem(){return null;}},console,fetch:async(url,init)=>{
  let data;if(url.endsWith('/settings')){if(init.body){storage.saved=JSON.parse(init.body);data={ok:true};}else data=storage.saved||{format:'eightmax-input-settings',saved:false};}
  else if(url.endsWith('/status'))data={running:false};else data={ok:true,windows:[]};
  return {ok:true,text:async()=>JSON.stringify(data)};
 },WorkbenchDesktop:{fromPage:()=>({secret:'a'.repeat(64)})},WorkbenchSimulatorControls:require('../src/simulator-controls.js'),WorkbenchInputPresets:require('../src/input-presets.js'),WorkbenchActionTimeline:require('../src/action-timeline.js'),WorkbenchSimulatorProfiles:require('../src/simulator-profiles.js'),WorkbenchPlatformProfile:require('../src/platform-profile.js'),WorkbenchInputScheduler:require('../src/input-scheduler.js'),WorkbenchExecutionAdapters:require('../src/execution-adapters.js'),WorkbenchInputMotion:require('../src/input-motion.js'),WorkbenchMovementSettings:require('../src/movement-settings.js')};
 w.window=w;vm.createContext(w);vm.runInContext(fs.readFileSync(path.join(root,'src/simulator-controls-ui.js'),'utf8'),w);return {w,get,elements};
}
const settle=()=>new Promise(r=>setTimeout(r,20));
test('settings panel restores saved mouse speed, curve seed, keyboard timing and validates bounds',async()=>{
 const storage={},a=harness(storage);a.get('simc-nav').click();await settle();
 a.get('simc-set-maxSpeed').value='600';a.get('simc-set-pattern').value='random';a.get('simc-set-seed').value='421';a.get('simc-set-keyHoldMs').value='20';
 await a.get('simc-save-settings').click();assert.equal(storage.saved.motion.maxSpeed,600);assert.equal(storage.saved.movement.seed,421);
 const b=harness(storage);b.get('simc-nav').click();await settle();
 assert.equal(Number(b.get('simc-set-maxSpeed').value),600);assert.equal(b.get('simc-set-pattern').value,'random');assert.equal(Number(b.get('simc-set-seed').value),421);assert.equal(Number(b.get('simc-set-keyHoldMs').value),20);
 b.get('simc-set-maxSpeed').value='3000';assert.throws(()=>b.w.WorkbenchSimulatorControlsUi.settings(),/400/);
 b.get('simc-set-maxSpeed').value='1200';b.get('simc-set-queue').value='-1';assert.throws(()=>b.w.WorkbenchSimulatorControlsUi.settings(),/Queue/);
});
