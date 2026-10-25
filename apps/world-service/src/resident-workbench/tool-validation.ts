import { SubmitSchema, TestSchema, ProposeSchema, WorkbenchError, type ToolArgumentFailure } from './contract.js';
import type { ToolCall } from './transport.js';

export type ValidatedTool =
 | {name:'submit_module';args:ReturnType<typeof SubmitSchema.parse>}
 | {name:'test_module';args:ReturnType<typeof TestSchema.parse>}
 | {name:'propose_method';args:ReturnType<typeof ProposeSchema.parse>};
type Validation = {ok:true;call:ValidatedTool}|{ok:false;failure:ToolArgumentFailure};

/** Only issues returned by this exact schema boundary are repairable. Downstream exceptions never enter it. */
function validate(name:ValidatedTool['name'],schema:typeof SubmitSchema|typeof TestSchema|typeof ProposeSchema,raw:unknown):Validation {
 const parsed=schema.safeParse(raw);
 if(parsed.success)return {ok:true,call:{name,args:parsed.data} as ValidatedTool};
 const first=parsed.error.issues[0];
 const fields=name==='submit_module'?['source','revision','parent']:name==='test_module'?['artifact','fixtureSet']:['artifact','receipt'];
 const path=first?.path,field:ToolArgumentFailure['field']=path?.length===1&&typeof path[0]==='string'&&fields.includes(path[0])?path[0] as ToolArgumentFailure['field']:'arguments';
 let issue:ToolArgumentFailure['issue']='schema';
 if(first?.code==='unrecognized_keys')issue='extra';
 else if(first?.code==='invalid_type')issue=field!=='arguments'&&raw!==null&&typeof raw==='object'&&!Object.hasOwn(raw,field)?'missing':'type';
 else if(field==='source')issue='source';
 else if(first?.code==='invalid_format'&&['artifact','parent','receipt','fixtureSet'].includes(field))issue='reference';
 else if(first?.code==='too_small'||first?.code==='too_big')issue='range';
 // Reconstruct enum values only. Do not copy schema paths/messages/keys/inputs into feedback or metrics.
 return {ok:false,failure:{tool:name,field,issue}};
}

export function validateToolArguments(call:ToolCall):Validation {
 if(!['submit_module','test_module','propose_method'].includes(call.name))throw new WorkbenchError('unknown-tool');
 let raw:unknown;
 try{raw=JSON.parse(call.arguments);}catch{return {ok:false,failure:{tool:call.name as ValidatedTool['name'],field:'arguments',issue:'invalid-json'}};}
 switch(call.name){
  case 'submit_module':return validate(call.name,SubmitSchema,raw);
  case 'test_module':return validate(call.name,TestSchema,raw);
  case 'propose_method':return validate(call.name,ProposeSchema,raw);
  default:throw new WorkbenchError('unknown-tool');
 }
}
