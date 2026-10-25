import { createHash } from 'node:crypto';
export * from '@meridian/world-schema/resident-workbench';
export const LIMITS = Object.freeze({ requests:12, outputTokens:2048, responseBytes:65536, sourceBytes:8192, versions:8, receipts:64, inputBytes:32768, requestMs:14000, sessionMs:180000, runMs:3000, stdoutBytes:8192, stderrBytes:2048 });
export function canonical(value:unknown):string { if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if(value!==null&&typeof value==='object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`; return JSON.stringify(value); }
export const sourceDigest=(source:string)=>createHash('sha256').update(source,'utf8').digest('hex');
export const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
/** The one trusted case-input identity: receipts, current-case selection, feedback markers and prompt validation all use it. */
export const caseInputHash=(c:{envelope:unknown;skill:number;condition:number;materials:unknown})=>digest({envelope:c.envelope,skill:c.skill,condition:c.condition,materials:c.materials});
export class WorkbenchError extends Error { readonly code:string; constructor(code:string){super(code);this.code=code;} }
export interface Executor { run(source:string,input:unknown,signal?:AbortSignal):Promise<unknown> }
export const TOOLS = [
 {type:'function',name:'submit_module',description:'Save an immutable ESM design(input) module revision. Parent is previous artifact hash, null for first.',strict:true,parameters:{type:'object',properties:{source:{type:'string',minLength:1,maxLength:8192},revision:{type:'integer',minimum:1,maximum:8},parent:{type:['string','null']}},required:['source','revision','parent'],additionalProperties:false}},
 {type:'function',name:'test_module',description:'Run an owned artifact against an approved fixture set; trusted host evaluates.',strict:true,parameters:{type:'object',properties:{artifact:{type:'string'},fixtureSet:{type:'string'}},required:['artifact','fixtureSet'],additionalProperties:false}},
 {type:'function',name:'propose_method',description:'Freeze a passing artifact/test pair as an inert proposal. No world effects.',strict:true,parameters:{type:'object',properties:{artifact:{type:'string'},receipt:{type:'string'}},required:['artifact','receipt'],additionalProperties:false}}
] as const;
