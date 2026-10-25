import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkbenchSession} from '../apps/world-service/src/resident-workbench/session.ts';
import {WorkbenchStore} from '../apps/world-service/src/resident-workbench/artifact-store.ts';
import {ResponsesWorkbenchTransport} from '../apps/world-service/src/resident-workbench/transport.ts';
import {createOpenAIResponsesTransport,OpenAIResidentProvider} from '../apps/world-service/src/openai-resident-provider.ts';
import {WorldStore} from '../apps/world-service/src/store/world-store.ts';
const context={actor:'resident-01',session:'synthetic-session',generation:'synthetic-generation',minute:10,need:'synthetic-need',site:'synthetic-site',siteRevision:1,envelope:{pieces:4,load:2,precision:75,axis:0,nominalMinutes:6},skill:70,condition:100,materials:{stone:6,timber:6},evidence:[]};
const fixtures=[{id:'synthetic-cases',cases:[{envelope:context.envelope,skill:70,condition:100},{envelope:{...context.envelope,axis:1},skill:70,condition:100}]}];
const weak="export function design(input){return {parts:[{n:0,k:'base',x:1,y:1,r:0,parent:null},{n:1,k:'tray',x:2,y:1,r:0,parent:0}],claim:{metric:'quality-points',relation:'at-least',value:75}}}";
const better="export function design(input){return {parts:[{n:0,k:'base',x:1,y:1,r:0,parent:null},{n:1,k:'clamp',x:2,y:1,r:input.envelope.axis,parent:0},{n:2,k:'guide',x:1,y:2,r:input.envelope.axis,parent:0}],claim:{metric:'quality-points',relation:'at-least',value:75}}}";
// This explicit executor double never evals source. Actual trusted evaluator/store/session are used.
const executor={async run(source,input){return {parts:source===weak?[{n:0,k:'base',x:1,y:1,r:0,parent:null},{n:1,k:'tray',x:2,y:1,r:0,parent:0}]:[{n:0,k:'base',x:1,y:1,r:0,parent:null},{n:1,k:'clamp',x:2,y:1,r:input.envelope.axis,parent:0},{n:2,k:'guide',x:1,y:2,r:input.envelope.axis,parent:0}],claim:{metric:'quality-points',relation:'at-least',value:75}}}};

test('generic provider requires explicit configuration and tool transport emits the real fixed request with no implicit network',async()=>{
 assert.throws(()=>new OpenAIResidentProvider({apiKey:'',model:''}));
 let calls=0;
 const provider=new OpenAIResidentProvider({apiKey:'synthetic-test-only',model:'explicit-test-model'},async()=>{calls++;throw Error('unexpected')});
 assert.ok(provider);assert.equal(calls,0);
 const signal=AbortSignal.timeout(2000);
 const native=createOpenAIResponsesTransport({apiKey:'synthetic-test-only',model:'explicit-test-model'},async(_url,init)=>{assert.equal(init.signal,signal);return Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'{}'}]}]})});
 await native('ignored',{body:JSON.stringify({messages:[],format:{}}),signal});
 const transport=new ResponsesWorkbenchTransport({apiKey:'synthetic-test-only',model:'explicit-test-model'},async(url,init)=>{
  calls++;assert.equal(String(url),'https://api.openai.com/v1/responses');assert.equal(init.redirect,'error');
  const p=JSON.parse(init.body);assert.equal(p.model,'explicit-test-model');assert.equal(p.store,false);assert.equal(p.parallel_tool_calls,false);assert.equal(p.tools.length,3);assert.equal(p.max_output_tokens,2048);
  return Response.json({status:'completed',output:[{type:'function_call',call_id:'synthetic-call',name:'submit_module',arguments:JSON.stringify({source:weak,revision:1,parent:null})}],usage:{input_tokens:20,output_tokens:10,total_tokens:30}});
 });
 const reply=await transport.next([{role:'user',content:'synthetic fixture only'}],AbortSignal.timeout(2000));assert.equal(reply.call.name,'submit_module');assert.equal(calls,1);
});

test('real tool session persists a measured failed version, child revision and passing inert proposal across reopen',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'meridian-public-ai-'));try{
  const path=join(dir,'synthetic.workbench.json'),store=WorkbenchStore.open(path,context),session=new WorkbenchSession(store,fixtures,executor);
  const a=session.submit({source:weak,revision:1,parent:null});const bad=await session.test({artifact:a.hash,fixtureSet:'synthetic-cases'});
  assert.equal(bad.passed,false);assert.equal(bad.results[0].quality,64);assert.throws(()=>session.propose({artifact:a.hash,receipt:bad.hash}));
  const b=session.submit({source:better,revision:2,parent:a.hash});const good=await session.test({artifact:b.hash,fixtureSet:'synthetic-cases'});assert.equal(good.passed,true);assert.deepEqual(good.results.map(r=>r.quality),[76,76]);
  const reopened=WorkbenchStore.open(path,context);const proposal=new WorkbenchSession(reopened,fixtures,executor).propose({artifact:b.hash,receipt:good.hash});
  assert.equal(proposal.kind,'workbench-method');assert.equal(reopened.snapshot().artifacts[1].parent,a.hash);assert.equal(reopened.snapshot().receipts[0].passed,false);
  assert.throws(()=>WorkbenchStore.open(join(dir,'private.workbench.json'),{...context,continuity:'excluded input'}));
  assert.equal(readFileSync(path,'utf8').includes('apiKey'),false);
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('private production prefix authority refuses before opening or creating a database',()=>{
 const dir=mkdtempSync(join(tmpdir(),'meridian-public-prefix-'));try{
  const path=join(dir,'must-not-exist.sqlite');
  assert.throws(()=>WorldStore.open(path,{prefixProof:{receiptPath:join(dir,'receipt.json'),sourceRevision:'a'.repeat(40),imageConfigId:'sha256:'+'b'.repeat(64)}}),/production-prefix-attestation-unavailable/);
  assert.equal(existsSync(path),false);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
