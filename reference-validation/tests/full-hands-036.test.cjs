'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fakeHost,build,runUntil}=require('./simulator-host-fixture.cjs'),{DecisionSource}=require('../src/simulator-decision-source.js');
test('practice router completes successive hands through rendered pixels and confirmed input adapter', {timeout:120000},async()=>{
 const host=fakeHost(1,{seed:1000}),b=build(host),t=b.tables[0],dealer=host.tables.values().next().value.dealer;
 const source=new DecisionSource({mode:'practice',seed:3});t.decide=s=>source.decide(s);
 try{
 await runUntil([t],()=>dealer.t.completed>=3,110000);
 assert.ok(dealer.t.completed>=3,JSON.stringify(t.report()));assert.equal(t.m.ambiguous+t.m.timedOut+t.m.errors,0);assert.equal(host.stats.violations.length,0);
 const confirmed=t.log.filter(x=>x.status==='confirmed');assert.ok(confirmed.length>20);
 for(const street of ['preflop','flop','turn','river'])assert.ok(confirmed.some(x=>x.street===street),'coverage: '+street);
 for(let i=0;i<confirmed.length;i++){const x=confirmed[i],y=dealer.accepted[i];assert.equal(x.hand,y.hand);assert.equal(x.seat,y.seat);assert.equal(x.action.type,y.type);if(y.type==='raise')assert.equal(x.action.amount,y.amount);assert.match(x.decisionLabel,/non-GTO/);}
 assert.ok(b.rec.events.some(e=>e.stage==='ack'&&e.status==='confirmed'));
 }finally{t.stop();dealer.closed=true;clearTimeout(dealer.timer);clearTimeout(dealer.holdTimer);}
});
test('strict router without strategy never submits input',async()=>{
 const host=fakeHost(1),b=build(host),t=b.tables[0],d=host.tables.values().next().value.dealer;
 t.allowScripted=false;t.decide=s=>new DecisionSource().decide(s);
 try{assert.equal((await t.step()).kind,'unavailable');assert.equal(host.stats.clicks,0);assert.match(t.paused,/No compatible/);}finally{t.stop();d.closed=true;clearTimeout(d.timer);}
});
test('a stalled decision source times out without input',async()=>{
 const host=fakeHost(1),b=build(host,{window:30}),t=b.tables[0],d=host.tables.values().next().value.dealer;t.allowScripted=false;t.decide=()=>new Promise(()=>{});
 try{assert.equal((await t.step()).kind,'unavailable');assert.match(t.paused,/deadline/);assert.equal(host.stats.clicks,0);}finally{t.stop();d.closed=true;clearTimeout(d.timer);}
});
test('stop while awaiting a decision prevents any input',async()=>{
 const host=fakeHost(1),b=build(host),t=b.tables[0],d=host.tables.values().next().value.dealer;
 t.decide=async s=>{t.stop();return new DecisionSource({mode:'practice'}).decide(s);};
 try{assert.equal((await t.step()).kind,'paused');assert.equal(host.stats.clicks,0);}finally{t.stop();d.closed=true;clearTimeout(d.timer);}
});

test('recovery waits for consistent frames before requesting or submitting a decision',async()=>{
 const host=fakeHost(1),b=build(host),t=b.tables[0],d=host.tables.values().next().value.dealer;
 const look=t.look.bind(t); t.look=async()=>{const r=await look();t.engine.paused=true;t.engine.pauseReason='waiting for second consistent frame';return r;};
 t.decide=()=>{throw Error('Decision must not run during recovery');};
 try{const r=await t.step();assert.equal(r.kind,'waiting');assert.match(r.reason,/consistent/);assert.equal(t.m.attempted,0);assert.equal(host.stats.clicks,0);}finally{t.stop();d.closed=true;clearTimeout(d.timer);clearTimeout(d.holdTimer);}
});
