/** Private, closed wire metadata. Never add provider strings, request values or arbitrary keys. */
export const CATEGORIES=['local-validation','http-status','redirect','missing-body','response-budget','malformed-json','response-shape','network-failure','request-deadline','session-deadline','aborted','ssh-process','ssh-io','ssh-output-budget','ssh-stderr-budget','ssh-envelope','ssh-deadline','secret-echo','unknown'] as const;
export type DiagnosticCategory=typeof CATEGORIES[number];
const VALIDATIONS=['envelope','payload','input','tools','generation','credential'] as const;
const INVENTORY=['items','messages','functionCalls','functionOutputs','reasoning','other','extraKeys','reasoningWithoutEncrypted','reasoningWithContent'] as const;
export interface FailureDiagnostic {version:1;category:DiagnosticCategory;status:number|null;validation:typeof VALIDATIONS[number]|null;input:Record<typeof INVENTORY[number],number>|null}
function exact(v:unknown,keys:readonly string[]):v is Record<string,unknown>{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
export function readDiagnostic(v:unknown):FailureDiagnostic|null {
 if(!exact(v,['version','category','status','validation','input'])||v.version!==1||!CATEGORIES.includes(v.category as DiagnosticCategory))return null;
 if(v.category==='http-status'?!(Number.isInteger(v.status)&&(v.status as number)>=100&&(v.status as number)<=599&&v.status!==200):v.status!==null)return null;
 if(v.category==='local-validation'?!VALIDATIONS.includes(v.validation as typeof VALIDATIONS[number]):v.validation!==null)return null;
 if(v.input!==null){
  if(v.category!=='local-validation'||!exact(v.input,INVENTORY)||!Object.values(v.input).every(n=>Number.isInteger(n)&&(n as number)>=0&&(n as number)<=32768))return null;
  const i=v.input as Record<typeof INVENTORY[number],number>;
  if(i.messages+i.functionCalls+i.functionOutputs+i.reasoning+i.other!==i.items||i.extraKeys>i.items||i.reasoningWithoutEncrypted>i.reasoning||i.reasoningWithContent>i.reasoning)return null;
 }
 // Rebuild the exact shape: callers never retain the supplied envelope or its object identity.
 return {version:1,category:v.category as DiagnosticCategory,status:v.status as number|null,validation:v.validation as FailureDiagnostic['validation'],input:v.input===null?null:{...v.input} as FailureDiagnostic['input']};
}
export function closedDiagnostic(category:DiagnosticCategory,status:number|null=null):FailureDiagnostic{return {version:1,category,status,validation:null,input:null};}
export function diagnosticFor(error:unknown,fallback:DiagnosticCategory='unknown'):FailureDiagnostic {
 return readDiagnostic(error&&typeof error==='object'&&'diagnostic' in error?error.diagnostic:null)??closedDiagnostic(fallback);
}
