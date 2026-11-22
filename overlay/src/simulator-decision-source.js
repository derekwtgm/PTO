/* Application-level decision routing. Only reconstructed public observations enter here. */
(function(root,factory){
 if(typeof module==='object'&&module.exports) module.exports=factory(require('./solver-service.js'),require('./full-hand.js'),require('./engine.js'));
 else root.WorkbenchSimulatorDecisionSource=factory(root.WorkbenchSolverService,root.WorkbenchFullHand,root.EightMax);
})(typeof globalThis!=='undefined'?globalThis:this,function(SS,FH,EM){
 'use strict';
 class DecisionSource {
  constructor(o={}) {
   if(!['strict','practice'].includes(o.mode||'strict')) throw Error('Unknown decision mode');
   this.mode=o.mode||'strict'; this.getSource=o.getSource||(()=>null); this.rng=new EM.RNG(o.seed||1); this.last=null;
  }
  async decide(state) {
   let reason='No compatible EightMax study is loaded', candidate=null;
   try {
    const source=this.getSource();
    if(source) {
     candidate=await source.decide(SS.requestFromState(state));
     if(candidate && candidate.status==='ok') {
      if(candidate.source!=='eightmax-study'||!SS.identifyEngine(candidate.engine).compatible) reason='Unsupported decision source or engine identity';
      else if(candidate.engine.backend!=='native-cli-cpu'||!SS.identifyEngine(candidate.engineVerification).compatible) reason='Native EightMax training and installed engine verification are required';
      else if(candidate.quality?.status!=='validated') reason='Strategy quality is not independently validated';
      else if(candidate.stateKey!==state.key || candidate.table!==state.table || candidate.revision!==state.revision) reason='Study returned a stale or mismatched state';
      else if(!candidate.convergence || candidate.convergence.verdict!=='within-target') reason='Study quality is not within its validation target';
      else return this.last={...candidate,actor:state.actor,issuedAt:Date.now(),decisionMode:this.mode};
     } else reason=candidate && candidate.reason || 'No strategy covers this state';
    }
   } catch(e) { reason='Decision source failed: '+e.message; }
   if(this.mode==='strict') return this.last={status:'unavailable',source:'none',reason,decisionMode:this.mode};
   return this.last={...FH.scriptedDecision(state,this.rng),label:'SCRIPTED SIMULATOR PRACTICE — non-GTO',decisionMode:this.mode,fallbackReason:reason};
  }
 }
 return {DecisionSource};
});
