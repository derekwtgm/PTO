'use strict';
// Lookup only. Receives reconstructed public observations on stdin; never reads the simulator oracle.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const SS=require('../src/solver-service.js'),L=require('../src/strategy-library.js'),LS=require('../src/library-source.js');
const ROOT=path.join(__dirname,'..'),ENGINE={version:'5.1',build:'7d08acc7eb4577ee'},SHA='b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72';
function verifyEngine(){
 const exe=path.join(ROOT,'native','mwcli.exe');
 if(crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex')!==SHA)throw Error('Bundled EightMax 5.1 executable hash mismatch');
 const r=cp.spawnSync(exe,['--build-id'],{encoding:'utf8',timeout:3000,windowsHide:true,maxBuffer:65536});
 if(r.error||r.status!==0||r.stdout.trim()!=='EightMaxBuild='+ENGINE.build)throw Error('EightMax 5.1 startup/build identity not verified');
 return {...ENGINE,sha256:SHA,verifiedAt:new Date().toISOString()};
}
async function decide(req,options={}){
 if(req&&req.probe===true&&Object.keys(req).length===1)return {status:'ok',engineVerification:(options.verifyEngine||verifyEngine)()};
 SS.validateRequest(req);
 const engine=(options.verifyEngine||verifyEngine)();
 if(!SS.identifyEngine(engine).compatible)throw Error('Incompatible engine');
 if(req.street==='preflop')return {status:'unavailable',source:'none',reason:'Select a compatible loaded preflop study; stored lookup covers postflop street records.'};
 const dir=options.dir||process.env.EIGHTMAX_STRATEGY_LIBRARY||path.join(process.env.LOCALAPPDATA||'', 'EightMax-Test-Workbench','StrategyLibrary');
 const lib=new L.StrategyLibrary(dir,{engine:ENGINE,readOnly:true,create:false,cacheBytes:32*1048576});
 const source=new LS.LibraryDecisionSource({library:lib,mode:'decision',engine:ENGINE,qualityPolicy:'strict',qualityUse:'decision',qualityLedger:false,approximationPolicy:'exact'});
 let d=await source.decide(req);
 if(d.status!=='ok' && d.code==='library-miss'){
  const AT=require('../src/adaptive-training.js');
  const adaptive=new LS.LibraryDecisionSource({library:lib,mode:'decision',engine:ENGINE,qualityPolicy:'strict',qualityUse:'decision',qualityLedger:false,approximationPolicy:'exact',training:()=>AT.trainingPolicy({trainer:'eightmax-native',policy:'strict'})});
  d=await adaptive.decide(req);
 }
 if(d.status==='ok'&&(d.engine?.backend!=='native-cli-cpu'||d.convergence?.verdict!=='within-target'||d.quality?.status!=='validated'))return {status:'unavailable',source:'none',reason:'Stored native strategy must pass strict quality and within-target convergence checks.'};
 return {...d,engineVerification:engine,decisionProvenance:'stored-native-strategy'};
}
if(require.main===module){
 // Bound process lifetime even if the host dies while a lookup is in progress.
 const timer=setTimeout(()=>process.exit(3),10000);let raw='';process.stdin.setEncoding('utf8');
 process.stdin.on('data',x=>{raw+=x;if(raw.length>262144)process.exit(2);});
 process.stdin.on('end',async()=>{try{const d=await decide(JSON.parse(raw));process.stdout.write(JSON.stringify(d));}catch(e){process.stdout.write(JSON.stringify({status:'unavailable',source:'none',reason:e.message}));}finally{clearTimeout(timer);}});
}
module.exports={decide,verifyEngine};
