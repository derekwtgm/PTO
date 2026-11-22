'use strict';
// A restricted heads-up river reference; training and independent evaluation precede any decision claim.
const fs=require('fs'),path=require('path');
const ROOT=path.join(__dirname,'..'),LS=require('../src/library-source.js'),AT=require('../src/adaptive-training.js'),L=require('../src/strategy-library.js'),HS=require('../src/hand-state.js'),SERVICE=require('./simulator-library-decision.cjs');
const dir=path.resolve(process.argv[2]||'native-reference-0362'),library=path.join(dir,'library');fs.mkdirSync(dir,{recursive:true});
async function main(){
 const startedAt=new Date().toISOString(),engine=SERVICE.verifyEngine(),board='AsKd7h4c2s'.match(/../g).map(HS.cardFromString);
 const behind=Array(8).fill(0);behind[1]=behind[2]=1000;const live=Array(8).fill(false);live[1]=live[2]=true;
 const req={format:'eightmax-decision-request',version:1,table:3,hand:17,revision:5,stateKey:'reference-0362-river',street:'river',actor:1,button:0,holeCards:['Qh','Jh'].map(HS.cardFromString),board,actions:[],stacks:Array(8).fill(2500),toCall:0,priority:1,deadlineMs:2000,pot:400,currentBet:0,blinds:{sb:50,bb:100,ante:10},seatsState:Array.from({length:8},(_,i)=>({stack:live[i]?1000:2400,bet:0,total:0,folded:!live[i]})),streetStart:{pot:400,behind,live},legal:{toCall:0,callAmount:0,canCheck:true,canCall:false,canFold:false,canRaise:true,minRaiseTo:100,maxRaiseTo:1000}};
 const opts={training:()=>AT.trainingPolicy({trainer:'eightmax-native',policy:'strict'})},ctx=LS.streetContext(req),built=LS.spotFor(req,ctx,{engine:LS.ENGINE,range:'random',rangeModelName:'any-two-cards-v1',streets:LS.treeProfile030,iterations:20000,trainerName:'native-cli-cpu',...opts});
 const trained=await AT.trainAdaptive(built.spot,{trainer:'eightmax-native',policy:'strict',cli:path.join(ROOT,'native/mwcli.exe'),workDir:path.join(dir,'training'),keepWork:true,maxTimeMs:240000,maxUpdates:10000000,stallChecks:4});
 const lib=L.StrategyLibrary.open(library);lib.put(built.identity,trained.body,{status:'complete',training:trained.training,quality:trained.quality});
 const decision=await SERVICE.decide(req,{dir:library});
 const report={format:'eightmax-native-reference',version:1,startedAt,completedAt:new Date().toISOString(),engine,request:req,identity:built.identity,fingerprint:built.fingerprint,training:trained.training,quality:trained.quality,decision,screenInputDemonstrated:false,ok:trained.quality.status==='validated'&&decision.status==='ok'&&decision.engine.backend==='native-cli-cpu'&&decision.convergence.verdict==='within-target'};
 fs.writeFileSync(path.join(dir,'native-reference.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,quality:report.quality.status,evaluation:report.quality.evaluation,decision:decision.status,reason:decision.reason}));process.exitCode=report.ok?0:1;
}
main().catch(e=>{fs.writeFileSync(path.join(dir,'native-reference-error.json'),JSON.stringify({error:e.stack}));console.error(e);process.exitCode=1;});
