'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DecisionSource}=require('../src/simulator-decision-source.js'),EM=require('../src/engine.js'),HS=require('../src/hand-state.js');
const state=()=>{const t=new EM.Table(1,51);t.startHand();const h=new HS.HandStateEngine(1);return h.ingest(HS.observeSimulator(t,t.actor,{actions:[]})).state;};
test('strict mode pauses without a source; practice is opt-in and explicitly labelled',async()=>{
 const s=state();assert.equal((await new DecisionSource().decide(s)).status,'unavailable');
 const d=await new DecisionSource({mode:'practice'}).decide(s);assert.equal(d.source,'scripted-fallback');assert.match(d.label,/non-GTO/);assert.match(d.fallbackReason,/No compatible/);
 assert.throws(()=>new DecisionSource({mode:'oops'}));
});
test('strict router enforces engine, state binding and quality; asynchronous sources are awaited',async()=>{
 const s=state(),base={status:'ok',source:'eightmax-study',table:s.table,revision:s.revision,stateKey:s.key,engine:{version:'5.1',build:'7d08acc7eb4577ee',backend:'native-cli-cpu'},engineVerification:{version:'5.1',build:'7d08acc7eb4577ee',sha256:'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72'},quality:{status:'validated'},convergence:{verdict:'within-target'},labels:['Call'],probabilities:[1],executable:[{type:'call'}],recommendedSlot:0};
 for(const patch of [{quality:null},{quality:{status:'unvalidated'}},{engineVerification:null},{engineVerification:{version:'5.1',build:'7d08acc7eb4577ee',sha256:'wrong'}},{engine:{version:'5.1',build:'7d08acc7eb4577ee',backend:'javascript'}},{engine:{version:'5.4',build:'1111111111111111'}},{convergence:{verdict:'unproven'}},{stateKey:'old'},{table:2},{revision:s.revision+1}]){
  assert.equal((await new DecisionSource({getSource:()=>({decide:async()=>({...base,...patch})})}).decide(s)).status,'unavailable');
 }
 const d=await new DecisionSource({getSource:()=>({decide:async()=>base})}).decide(s);assert.equal(d.source,'eightmax-study');assert.equal(d.actor,s.actor);assert.ok(d.issuedAt);
});
test('practice records source errors; seeded decisions reproduce and inputs are not mutated',async()=>{
 const s=state(),before=JSON.stringify(s),o={mode:'practice',seed:91,getSource:()=>({decide:()=>{throw Error('native failed');}})},a=new DecisionSource(o),b=new DecisionSource(o);
 for(let i=0;i<30;i++){const x=await a.decide(s),y=await b.decide(s);assert.deepEqual(x.executable,y.executable);assert.match(x.fallbackReason,/native failed/);}
 assert.equal(JSON.stringify(s),before);
});
