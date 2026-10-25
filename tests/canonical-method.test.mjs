import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {advanceWorld,createCityLife2State,migrateCivicProjects,enableInvention,methodTask} from '../packages/world-kernel/src/index.ts';
import {appendLedger,GENESIS_HASH} from '../packages/world-ledger/src/index.ts';
import {WorldStore} from '../apps/world-service/src/store/world-store.ts';
import {bindConfiguredWorkbench,createDoubleWorkbenchConfiguration} from '../apps/world-service/src/resident-workbench/trusted-completion.ts';

// Explicit offline doubles: no source eval, provider request, native execution or production authority.
const weak={parts:[{n:0,k:'base',x:1,y:1,r:0,parent:null},{n:1,k:'tray',x:2,y:1,r:0,parent:0}],claim:{metric:'quality-points',relation:'at-least',value:75}};
const good={parts:[{n:0,k:'base',x:1,y:1,r:0,parent:null},{n:1,k:'clamp',x:2,y:1,r:0,parent:0},{n:2,k:'guide',x:1,y:2,r:0,parent:0}],claim:{metric:'quality-points',relation:'at-least',value:75}};
function initial(){
 let state=migrateCivicProjects(createCityLife2State('synthetic-method',12)).state;
 for(const p of Object.values(state.life.projects))p.progress=p.id==='public-map-boards'?0:100;
 for(const p of Object.values(state.life.residents))p.task={kind:'rest',label:'Synthetic rest',startedMinute:0,endsMinute:300,placeId:state.residents[p.residentId].homePlaceId};
 const actor=Object.keys(state.residents).sort()[0];
 Object.assign(state.life.residents[actor],{task:null});state.life.residents[actor].skills.building=100;state.life.residents[actor].needs.energy=100;state.residents[actor].placeId='founders-square';state=enableInvention(state).state;
 const command={action:'agenda',residentId:actor,requestId:'baseline',observedMinute:0,generation:'fixture',siteId:'invention:site:0',siteRevision:0,agendaId:null,agendaRevision:null,choice:'operate',designId:null,operation:'map-frame',purpose:'trial-only',artifactId:null,artifactRevision:null,comparisonTrialId:null};
 for(let n=1;n<=16;n++)state=advanceWorld(state,{type:'advance-clock',targetMinute:n,...(n===1?{inventionCommands:[command]}:{})},{generation:'fixture'}).state;
 const agenda=Object.values(state.life.invention.agendas)[0];
 const author={action:'author-method',residentId:actor,requestId:'author',observedMinute:16,generation:'fixture',siteId:agenda.siteId,siteRevision:state.life.invention.sites[agenda.siteId].revision,agendaId:agenda.id,agendaRevision:agenda.revision,sessionId:'00000000-0000-4000-8000-000000000001',task:methodTask(state.life.residents[actor].task),revisionBasisTrialId:null};
 state=advanceWorld(state,{type:'advance-clock',targetMinute:17,inventionCommands:[author]},{generation:'fixture'}).state;
 assert.equal(state.life.invention.agendas[agenda.id].authoring,'executable-v1');
 return {state,actor,agenda:state.life.invention.agendas[agenda.id]};
}
test('offline observed failure/repair admits only the owning closure, persists verified lineage and refuses copied authority',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'meridian-method-'));let store,binding;
 try{
  const f=initial(),path=join(directory,'world.sqlite');store=WorldStore.open(path);
  let current={snapshotVersion:1,state:f.state,ledgerBaseSequence:0,ledgerBaseHash:GENESIS_HASH};store.commitTransition(current,[]);
  let calls=0,runs=0;
  const configuration=createDoubleWorkbenchConfiguration({executor:{async run(source){runs++;return structuredClone(source.includes('weak')?weak:good)}},async next(input){
   calls++;const saved=JSON.parse(input[1].content).approved.saved,last=saved.latest,tests=saved.tests.filter(t=>t.artifact===last?.hash);
   const name=!last||tests.length&&!tests.at(-1).passed?'submit_module':!tests.length?'test_module':'propose_method';
   const args=name==='submit_module'?{source:`export function design(input){return ${JSON.stringify(last?good:weak)}} // ${last?'repaired':'weak'}`,revision:last?2:1,parent:last?.hash??null}:name==='test_module'?{artifact:last.hash,fixtureSet:'current'}:{artifact:last.hash,receipt:tests.at(-1).hash};
   const call={type:'function_call',call_id:`offline-${calls}`,name,arguments:JSON.stringify(args)};return {output:[call],call,usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
  }});
  binding=bindConfiguredWorkbench(configuration,store);assert.throws(()=>bindConfiguredWorkbench(configuration,{}),/unconfigured/);
  const args={actor:f.actor,agendaId:f.agenda.id,session:'offline-repair',journalPath:join(directory,'method.json'),fixtures:[{id:'current',cases:[{envelope:f.state.life.invention.trials[f.agenda.needTrialId].operation,skill:100,condition:100}]}]};
  await assert.rejects(binding.start(current,'fixture',{...args,actor:Object.keys(f.state.residents).find(x=>x!==f.actor)}),/invalid-method-origin/);
  const capability=await binding.start(current,'fixture',args);assert.ok(capability);assert.equal(runs,4);assert.equal(calls,5);
  assert.equal(binding.accept({...capability},'fixture',current.state),false);assert.equal(binding.accept(capability,'wrong-generation',current.state),false);assert.equal(binding.accept(capability,'fixture',current.state),true);assert.equal(binding.accept(capability,'fixture',current.state),false);
  const records=binding.intakes();assert.equal(records.length,2);assert.equal(records[0].tests[0].passed,false);assert.equal(records[1].tests[0].passed,true);assert.equal(records[1].parentArtifactHash,records[0].artifactHash);assert.equal(records[1].authority.kind,'configured-double');
  const transition=advanceWorld(current.state,{type:'advance-clock',targetMinute:18},{generation:'fixture',methods:records});let hash=current.ledgerBaseHash;
  const entries=transition.events.map((event,index)=>{const e=appendLedger(hash,current.ledgerBaseSequence+index+1,event);hash=e.hash;return e});
  const next={snapshotVersion:1,state:transition.state,ledgerBaseSequence:entries.at(-1).sequence,ledgerBaseHash:hash};
  // Imported passing evidence has no live issuer at a different store.
  const outsider=WorldStore.open(join(directory,'outsider.sqlite'));try{outsider.commitTransition(current,[]);assert.throws(()=>outsider.commitTransition(next,entries),/unavailable/)}finally{outsider.close()}
  store.commitTransition(next,entries);binding.committed(current,next,entries);assert.equal(binding.intakes().length,0);
  const methods=Object.values(next.state.life.invention.methods);assert.equal(methods.length,2);assert.equal(methods[1].parentVersionId,methods[0].id);
  binding.close();store.close();store=WorldStore.open(path);const reopened=store.loadVerifiedWorld();assert.deepEqual(reopened,next);assert.equal(calls,5);assert.equal(runs,4);
  assert.equal(binding.accept(capability,'fixture',reopened.state),false);
  // Restart use reads the frozen measured output; author/teacher/provider are absent.
  binding=bindConfiguredWorkbench(createDoubleWorkbenchConfiguration({executor:{async run(){throw Error('unexpected execution')}},async next(){throw Error('unexpected provider')}}),store);
  const agenda=reopened.state.life.invention.agendas[f.agenda.id],selected=Object.values(reopened.state.life.invention.methods).find(m=>m.revision===2);
  const command={action:'adopt-version',residentId:f.actor,requestId:'restart-adopt',observedMinute:18,generation:'restarted',siteId:agenda.siteId,siteRevision:reopened.state.life.invention.sites[agenda.siteId].revision,agendaId:agenda.id,agendaRevision:agenda.revision,methodVersionId:selected.id,task:methodTask(reopened.state.life.residents[f.actor].task),revisionBasisTrialId:null};
  const adopted=advanceWorld(reopened.state,{type:'advance-clock',targetMinute:19,inventionCommands:[command]},{generation:'restarted'});
  assert.equal(adopted.events.find(e=>e.type==='invention-command-resolved').outcome,'accepted');
  const design=Object.values(adopted.state.life.invention.designs)[0];assert.equal(design.methodApplication.methodVersionId,selected.id);assert.equal(design.status,'validated');
  assert.equal(calls,5);assert.equal(runs,4);
 }finally{binding?.close();store?.close();rmSync(directory,{recursive:true,force:true})}
});
