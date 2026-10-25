import { createConnection, type Socket } from 'node:net';
import { constants, lstatSync, readFileSync, realpathSync, openSync, fstatSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { MethodCaseInputSchema } from '@meridian/world-schema';
import { canonical, sourceDigest, LIMITS, WorkbenchError, type Executor } from './contract.js';

const ROOT='/run/meridian-workbench', SOCKET=ROOT+'/executor.sock', MANIFEST=ROOT+'/active-release.json';
const CONFIG='sha256:6fdd8176608c7d7c61b5ca0070cfd4457e4a76e57f58b82854433bc357b94716';
const INDEX='sha256:ba2a379f74954e9227c561360ba3fb4c65645fdbe7fc65fb6f2956b1463d02fc';
const RUNNER='51f5dc378ab7197e8f3f9388e8edb7281b88ccf2c746e3d8d88ba88c34821600';
const FRAME=65536;
type Manifest={version:1;enabled:true;release:string;generation:string;runtimeImageId:string;runnerSha256:string;nativeProofSha256:string;brokerSha256:string;writerContainerId:string;writerImageId:string;writerCgroupPath:string};
export interface PrivateExecutorHealth {state:'ready'|'busy'|'host-intervention'|'closed';delivery:'none'|'confirmed'|'uncertain'}
type Identity={dev:number;ino:number};
let active:object|null=null,halted=false;
const unavailable=()=>new WorkbenchError('executor-unavailable');
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:unknown,fields:string[]):v is Record<string,unknown>=>object(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));
const same=(a:Identity,b:Identity)=>a.dev===b.dev&&a.ino===b.ino;

/** JSON.parse alone silently collapses duplicate keys. Scan bounded JSON first; never execute source. */
function closedJson(text:string):unknown {
 let at=0,nodes=0;
 const ws=()=>{while(/\s/.test(text[at]??'')&&at<text.length)at++;};
 const string=()=>{const begin=at++;for(;;){const c=text[at++];if(c===undefined)throw unavailable();if(c==='\\'){at++;continue;}if(c==='"')return JSON.parse(text.slice(begin,at)) as string;}};
 const value=(depth:number):void=>{
  if(depth>32||++nodes>8192)throw unavailable();ws();
  if(text[at]==='"'){string();return;}
  if(text[at]==='{'){
   at++;ws();const keys=new Set<string>();if(text[at]==='}'){at++;return;}
   for(;;){ws();if(text[at]!=='"')throw unavailable();const key=string();if(keys.has(key))throw unavailable();keys.add(key);ws();if(text[at++]!==':')throw unavailable();value(depth+1);ws();const c=text[at++];if(c==='}')return;if(c!==',')throw unavailable();}
  }
  if(text[at]==='['){at++;ws();if(text[at]===']'){at++;return;}for(;;){value(depth+1);ws();const c=text[at++];if(c===']')return;if(c!==',')throw unavailable();}}
  const m=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(at));if(!m)throw unavailable();at+=m[0].length;
  if(!['true','false','null'].includes(m[0])&&!Number.isFinite(Number(m[0])))throw unavailable();
 };
 value(0);ws();if(at!==text.length)throw unavailable();return JSON.parse(text);
}

function admission(release:string,generation:string):{manifest:Manifest;manifestHash:string;socket:Identity} {
 try{
  if(process.platform!=='linux'||!/^[a-f0-9]{40}$/.test(release)||!/^[a-zA-Z0-9_-]{1,80}$/.test(generation))throw unavailable();
  // The protected root socket path authenticates the server. Linux SO_PEERCRED on the broker authenticates the writer.
  // Node stdlib provides no server-peer credential API: do not claim a second peer-credential proof here.
  for(let path=ROOT;;path=dirname(path)){
   const p=lstatSync(path);if(!p.isDirectory()||p.isSymbolicLink()||p.uid!==0||(p.mode&0o022)!==0||realpathSync(path)!==path)throw unavailable();
   if(path===ROOT&&(p.mode&0o777)!==0o755)throw unavailable();if(path===dirname(path))break;
  }
  const before=lstatSync(MANIFEST);if(!before.isFile()||before.isSymbolicLink()||before.uid!==0||before.nlink!==1||(before.mode&0o777)!==0o444||before.size>4096)throw unavailable();
  const fd=openSync(MANIFEST,constants.O_RDONLY|constants.O_NOFOLLOW);let text:string;
  try{const opened=fstatSync(fd);if(!same(before,opened)||!opened.isFile()||opened.uid!==0||opened.nlink!==1||(opened.mode&0o777)!==0o444||opened.size>4096)throw unavailable();text=readFileSync(fd,'utf8');}
  finally{closeSync(fd);}
  if(Buffer.byteLength(text)>4096||!same(before,lstatSync(MANIFEST)))throw unavailable();
  const v=closedJson(text);
  if(!exact(v,['version','enabled','release','generation','runtimeImageId','runnerSha256','nativeProofSha256','brokerSha256','writerContainerId','writerImageId','writerCgroupPath'])||v.version!==1||v.enabled!==true
   ||v.release!==release||v.generation!==generation||![CONFIG,INDEX].includes(String(v.runtimeImageId))||v.runnerSha256!==RUNNER
   ||!['nativeProofSha256','brokerSha256','writerContainerId'].every(k=>typeof v[k]==='string'&&/^[a-f0-9]{64}$/.test(v[k] as string))
   ||typeof v.writerImageId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(v.writerImageId)
   ||typeof v.writerCgroupPath!=='string'||v.writerCgroupPath.length>512||!/^\/(?:[A-Za-z0-9_.:-]+\/)*[A-Za-z0-9_.:-]+$/.test(v.writerCgroupPath)
   ||v.writerCgroupPath.split('/').includes('..')||!(v.writerCgroupPath.endsWith('/docker-'+v.writerContainerId+'.scope')||v.writerCgroupPath.endsWith('/docker/'+v.writerContainerId)))throw unavailable();
  const socket=lstatSync(SOCKET);if(!socket.isSocket()||socket.isSymbolicLink()||socket.uid!==0||socket.gid!==1000||socket.nlink!==1||(socket.mode&0o777)!==0o660)throw unavailable();
  return {manifest:v as unknown as Manifest,manifestHash:sourceDigest(text),socket:{dev:socket.dev,ino:socket.ino}};
 }catch{throw unavailable();}
}

/** No caller-selected path, runtime, transport, environment or Docker authority. Missing root enablement refuses. */
export function createPrivateSocketExecutor(binding:{sourceRevision:string;generation:string}):PrivateSocketExecutor {
 return new PrivateSocketExecutor(binding.sourceRevision,binding.generation,admission(binding.sourceRevision,binding.generation));
}

class PrivateSocketExecutor implements Executor {
 readonly runtime:Readonly<{imageId:string;runnerHash:string}>;
 readonly #release:string;readonly #generation:string;readonly #admitted:ReturnType<typeof admission>;
 #closed=false;#delivery:PrivateExecutorHealth['delivery']='none';#cancel:(()=>void)|undefined;
 constructor(release:string,generation:string,admitted:ReturnType<typeof admission>){
  this.#release=release;this.#generation=generation;this.#admitted=admitted;
  this.runtime=Object.freeze({imageId:admitted.manifest.runtimeImageId,runnerHash:RUNNER});
 }
 health():PrivateExecutorHealth{return {state:halted?'host-intervention':this.#closed?'closed':active?'busy':'ready',delivery:this.#delivery};}
 assertHealthy():void{if(this.health().state!=='ready')throw unavailable();}
 close():void{this.#closed=true;this.#cancel?.();}
 /** deadlineUnixMs can only shorten the inclusive 3000ms lifecycle; signal can shorten it further. */
 async run(source:string,input:unknown,signal?:AbortSignal,deadlineUnixMs?:number):Promise<unknown>{
  const beganMono=performance.now(),began=Date.now(),deadline=Math.min(began+LIMITS.runMs,deadlineUnixMs??began+LIMITS.runMs),deadlineMono=beganMono+deadline-began;
  if(this.#closed||halted||active)throw unavailable();
  if(signal?.aborted)throw new WorkbenchError('aborted');
  let numeric:ReturnType<typeof MethodCaseInputSchema.parse>;
  try{numeric=MethodCaseInputSchema.parse(input);if(typeof source!=='string'||!source.isWellFormed()||Buffer.byteLength(source)<1||Buffer.byteLength(source)>8192||Buffer.byteLength(canonical(numeric))>8192)throw Error();}
  catch{throw new WorkbenchError('execution-input-budget');}
  if(!Number.isSafeInteger(deadline)||deadline<=Date.now()||performance.now()>=deadlineMono)throw new WorkbenchError('execution-deadline');
  const check=()=>{const a=admission(this.#release,this.#generation);if(a.manifestHash!==this.#admitted.manifestHash||!same(a.socket,this.#admitted.socket))throw unavailable();};
  try{check();}catch{halted=true;throw unavailable();}
  const request={version:1,type:'execute',operationId:randomUUID(),release:this.#release,generation:this.#generation,
   runtimeImageId:this.runtime.imageId,runnerSha256:RUNNER,source,sourceSha256:sourceDigest(source),input:numeric,inputSha256:sourceDigest(canonical(numeric)),deadlineUnixMs:deadline};
  const raw=JSON.stringify(request),frame=Buffer.from(raw+'\n');if(frame.length>FRAME)throw new WorkbenchError('execution-input-budget');
  if(signal?.aborted)throw new WorkbenchError('aborted');
  const token=Object.freeze({});active=token;this.#delivery='none';
  return new Promise<unknown>((resolve,reject)=>{
   let socket:Socket|undefined,dispatched=false,finished=false,reply:Record<string,unknown>|undefined,ackWritten=false;
   let received=Buffer.alloc(0),outputValue:unknown;
   const finish=(error?:WorkbenchError,value?:unknown)=>{
    if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.#cancel=undefined;
    socket?.removeAllListeners();socket?.on('error',()=>{});socket?.destroy();
    if(error&&dispatched){halted=true;this.#delivery='uncertain';}
    if(!halted&&active===token)active=null;
    if(error)reject(error);else resolve(value);
   };
   const abort=()=>finish(dispatched?unavailable():new WorkbenchError('aborted'));
   const timer=setTimeout(()=>finish(dispatched?unavailable():new WorkbenchError('execution-deadline')),Math.max(1,deadlineMono-performance.now()));
   this.#cancel=abort;signal?.addEventListener('abort',abort,{once:true});
   try{
    socket=createConnection({path:SOCKET,allowHalfOpen:true});
    socket.on('error',()=>finish(unavailable()));
    socket.on('connect',()=>{
     if(finished)return;
     try{check();if(Date.now()>=deadline||performance.now()>=deadlineMono)throw unavailable();dispatched=true;socket!.write(frame,error=>{if(error)finish(unavailable());});}catch{finish(unavailable());}
    });
    socket.on('data',(chunk:Buffer)=>{
     if(finished)return;
     try{
      if(reply)throw unavailable();received=Buffer.concat([received,chunk]);if(received.length>FRAME)throw unavailable();
      const at=received.indexOf(10);if(at<0)return;if(at!==received.length-1)throw unavailable();
      // Reject ill-formed UTF8 rather than replace bytes before validating the response binding.
      const text=new TextDecoder('utf8',{fatal:true}).decode(received.subarray(0,at)),v=closedJson(text);
      if(!exact(v,['version','type','operationId','requestSha256','release','generation','runtimeImageId','runnerSha256','sourceSha256','inputSha256','deadlineUnixMs','containerId','containerName','childExited','containerRemoved','temporaryFilesRemoved','result','cleanupReceiptSha256'])
       ||v.version!==1||v.type!=='result'||v.operationId!==request.operationId||v.requestSha256!==sourceDigest(raw)
       ||v.release!==request.release||v.generation!==request.generation||v.runtimeImageId!==request.runtimeImageId||v.runnerSha256!==RUNNER
       ||v.sourceSha256!==request.sourceSha256||v.inputSha256!==request.inputSha256||v.deadlineUnixMs!==deadline
       ||typeof v.containerId!=='string'||!/^[a-f0-9]{64}$/.test(v.containerId)||v.containerName!=='meridian-workbench-'+request.operationId
       ||v.childExited!==true||v.containerRemoved!==true||v.temporaryFilesRemoved!==true)throw unavailable();
      const {cleanupReceiptSha256,...body}=v;if(cleanupReceiptSha256!==sourceDigest(canonical(body)))throw unavailable();
      const result=v.result;if(exact(result,['kind','json'])&&result.kind==='output'&&typeof result.json==='string'&&result.json.isWellFormed()&&Buffer.byteLength(result.json)<=8192)outputValue=closedJson(result.json);
      else if(!(exact(result,['kind','code'])&&result.kind==='resident-error'&&['execution-failed','invalid-output'].includes(String(result.code))))throw unavailable();
      if(Date.now()>=deadline||performance.now()>=deadlineMono||signal?.aborted||this.#closed)throw unavailable();reply=v;
      socket!.write(JSON.stringify({version:1,type:'ack',operationId:request.operationId,cleanupReceiptSha256})+'\n',error=>{if(error)finish(unavailable());else ackWritten=true;});
     }catch{finish(unavailable());}
    });
    socket.on('end',()=>{
     if(finished)return;
     if(!reply||!ackWritten||Date.now()>=deadline||performance.now()>=deadlineMono||this.#closed||signal?.aborted){finish(unavailable());return;}
     this.#delivery='confirmed';const result=reply.result as {kind:string;value?:unknown;code?:string};
     // A resident failure is an acknowledged result, so it does not latch the host slot.
     if(result.kind==='resident-error'){
      finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.#cancel=undefined;socket!.destroy();if(active===token)active=null;reject(new WorkbenchError(result.code!));
     }else finish(undefined,outputValue);
    });
    socket.on('close',()=>{if(!finished)finish(unavailable());});
   }catch{finish(unavailable());}
  });
 }
}
