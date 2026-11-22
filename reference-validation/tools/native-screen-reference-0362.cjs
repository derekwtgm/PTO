'use strict';
// Reach a reference using captured pixels, pause input for explicit native training, then execute one strict action.
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT=path.join(__dirname,'..'),arg=(k,d)=>{const i=process.argv.indexOf('--'+k);return i<0?d:process.argv[i+1];};
const OUT=path.resolve(arg('out','native-screen-reference.json')),WORK=path.resolve(arg('work','native-screen-reference-work'));
fs.mkdirSync(WORK,{recursive:true});process.env.EIGHTMAX_STRATEGY_LIBRARY=path.join(WORK,'library');
const B=require('./simulator-benchmark-035.cjs'),SC=require('../src/simulator-controls.js'),SP=require('../src/simulator-profiles.js'),SCH=require('../src/input-scheduler.js'),XA=require('../src/execution-adapters.js'),DS=require('../src/simulator-decision-source.js'),SS=require('../src/solver-service.js'),LS=require('../src/library-source.js'),AT=require('../src/adaptive-training.js'),L=require('../src/strategy-library.js'),SERVICE=require('./simulator-library-decision.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
async function main(){
 let host,fx,session,api,t;const recorder=new XA.DiagnosticsRecorder({max:30000});
 const report={format:'eightmax-native-screen-reference',version:1,startedAt:new Date().toISOString(),ok:false,screenInputDemonstrated:false};
 try{
  report.engine=SERVICE.verifyEngine();host=B.startHost();const info=await B.waitReady(host.ready);api=new SC.HostApi({token:info.token,fetch,maxConcurrent:6});session=SC.hostSession(api);
  const status=await session.request('status');session.capabilities=status.capabilities;
  fx=B.fixture(1,WORK);const ready=await fx.wait(m=>m.type==='ready'),w=ready.tables[0],exeSha=sha(path.join(ROOT,'desktop/bin/EightMaxTestTable.exe'));
  const auth=SC.authorizations({environment:'controlled-test-table',approvedBy:'Explicit native reference test in bundled fixture',exeFileName:'EightMaxTestTable.exe',exeSha256:exeSha,hours:1});
  await session.call('register-target',{hwnd:w.hwnd,authorization:auth.simulator,label:'native reference'});
  const practice=new DS.DecisionSource({mode:'practice',seed:1,getSource:()=>({decide:req=>api.request('/api/simulator/decision',req)})});
  t=new SC.SimulatorTable({id:1,window:{hwnd:w.hwnd,pid:w.pid,title:'EightMax Test Table 01',client:w.client},profile:SP.fixtureProfile({exeSha256:exeSha}),api,session,scheduler:new SCH.InputScheduler({maxQueue:4,onCancel:()=>session.request('cancel-all')}),qaAuthorization:auth.qa,recorder,allowScripted:true,decide:s=>practice.decide(s),movement:{pattern:'straight',seed:1},options:{decisionWindowMs:15000,stopOnPause:true}});
  const opened=await t.capture.open();if(!opened.ok)throw Error('Capture could not open: '+JSON.stringify(opened));await session.call('arm');
  const until=Date.now()+480000;let attempted=false;
  while(Date.now()<until&&!t.paused){
   const observed=await t.look();
   if(observed.state&&observed.state.status==='playing'&&observed.state.street==='river'){
    const req=SS.requestFromState(observed.state),ctx=LS.streetContext(req);
    if(!ctx.error&&ctx.live.length===2){
     attempted=true;report.observedRequest=req;report.frameId=observed.frame.frameId;
     await session.call('disarm');
     const options={engine:LS.ENGINE,range:'random',rangeModelName:'any-two-cards-v1',streets:LS.treeProfile030,iterations:20000,trainerName:'native-cli-cpu',training:()=>AT.trainingPolicy({trainer:'eightmax-native',policy:'strict'})};
     const built=LS.spotFor(req,ctx,options);
     const trained=await AT.trainAdaptive(built.spot,{trainer:'eightmax-native',policy:'strict',cli:path.join(ROOT,'native/mwcli.exe'),workDir:path.join(WORK,'training'),keepWork:true,maxTimeMs:240000,maxUpdates:10000000,stallChecks:4});
     report.identity=built.identity;report.quality=trained.quality;report.training=trained.training;
     L.StrategyLibrary.open(process.env.EIGHTMAX_STRATEGY_LIBRARY).put(built.identity,trained.body,{status:'complete',training:trained.training,quality:trained.quality});
     if(trained.quality.status!=='validated')throw Error('Native reference did not pass strict exact quality validation');
     const strict=new DS.DecisionSource({mode:'strict',getSource:()=>({decide:r=>api.request('/api/simulator/decision',r)})});t.allowScripted=false;t.decide=s=>strict.decide(s);
     await session.call('arm');report.step=await t.step();await session.call('disarm');
     const entry=t.log[t.log.length-1];report.decision=strict.last;report.execution=entry;
     const oracle=(await fx.cmd({cmd:'summary'})).tables[0];report.oracle=oracle;
     const applied=oracle.accepted[oracle.accepted.length-1];
     report.screenInputDemonstrated=!!(entry&&entry.status==='confirmed'&&entry.source==='eightmax-study'&&entry.engine&&entry.engine.backend==='native-cli-cpu'&&applied&&applied.hand===entry.hand&&applied.seat===entry.seat&&applied.type===entry.action.type&&(applied.type!=='raise'||applied.amount===entry.action.amount)&&oracle.counts.doubleClicks===0&&oracle.counts.downOutsideControls===0&&oracle.counts.wagerRejected===0);
     report.ok=report.screenInputDemonstrated;break;
    }
   }
   const step=await t.step();if(step.kind==='no-reading'||step.kind==='waiting')await sleep(100);
  }
  if(!attempted)throw Error('No eligible observed heads-up river reached: '+JSON.stringify(t.report()));
 }catch(e){report.error=e.stack;}
 finally{
  if(t){t.stop();report.table=t.report();try{await t.capture.close();}catch(_){}}
  if(session){try{await session.request('estop',{reason:'reference test cleanup'});}catch(_){}}
  if(fx)await fx.stop();if(api){try{await api.request('/api/desktop/shutdown',{});}catch(_){}}
  if(host)try{host.child.kill();}catch(_){}
  report.completedAt=new Date().toISOString();fs.writeFileSync(path.join(WORK,'diagnostics.json'),JSON.stringify(recorder.export()));fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,quality:report.quality&&report.quality.status,error:report.error}));process.exitCode=report.ok?0:1;
 }
}
main();
