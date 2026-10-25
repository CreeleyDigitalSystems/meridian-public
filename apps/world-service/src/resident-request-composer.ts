import { PublicResidentContextSchema, type PublicResidentContext } from '@meridian/world-schema';
import { digest, canonical, caseInputHash, sourceDigest, WorkbenchError, SafeWorkbenchInputSchema, type SafeWorkbenchInput } from './resident-workbench/contract.js';

export interface ComposedRequest {messages:{role:'system'|'user';content:string}[];fingerprint:string;binding:string;stage:string}
const STRUCTURE='Goal: advance your own current work using approved observations and evidence. Constraints: offered actions/tools only; availability is not observation, and evidence is not authority. Keep your resident identity and goals. Expected output: obey the supplied strict interface without prose. Success: host validation and actual measured work, never a self-awarded claim.';
function composed(stage:string, approved:unknown, reference:string, semantic:unknown):ComposedRequest {
 const messages:[{role:'system';content:string},{role:'user';content:string}]=[{role:'system',content:`${STRUCTURE}\n${reference}`},{role:'user',content:JSON.stringify({stage,approved,verification:stage==='revise'?'Use the recorded failure to revise the owned version; retest unchanged trusted cases.':stage==='test'?'Test the saved version before claiming benefit.':stage==='propose'?'Propose only a passing owned version and its exact receipt whose current:true case passed.':'Choose the next lawful step; use tests to resolve uncertainty.'})}];
 if(Buffer.byteLength(JSON.stringify(messages))>32768)throw new WorkbenchError('input-budget');
 return {messages,stage,fingerprint:digest({stage,reference,approved:semantic}),binding:digest(messages)};
}
/** Only a strict approved public context enters this path; private companion prompts remain separate. */
export function composePublicRequest(raw:PublicResidentContext,reference:string):ComposedRequest {
 const context=PublicResidentContextSchema.parse(raw);
 if(!context.choices.length)throw new RangeError('empty-choices');
 const {observedMinute,...semantic}=context;
 return composed('choose',context,reference,semantic);
}
export type { SafeWorkbenchInput };
/** Strict public numbers, owned lineage and closed measured feedback only. Case inputs must hash to their result and current marker. */
export function composeWorkbenchRequest(raw:SafeWorkbenchInput,reference:string):ComposedRequest {
 const parsed=SafeWorkbenchInputSchema.safeParse(raw);
 if(!parsed.success)throw new TypeError(parsed.error.issues.every(issue=>issue.path[0]==='saved')?'unapproved-evidence':'unapproved-context');
 // The checked input is serialised as supplied: byte-stable requests for frozen evaluations and their reconciliation bindings.
 const approved=raw,saved=approved.saved,current=caseInputHash(approved.context),materials=canonical(approved.context.materials);
 if(saved.tests.some(t=>!saved.versions.some(v=>v.hash===t.artifact)||t.passed!==t.results.every(r=>r.passed)||t.results.some(r=>r.inputHash!==caseInputHash(r.case)||canonical(r.case.materials)!==materials||r.current!==(r.inputHash===current)||r.quality!==null&&r.qualityMet!==r.quality>=r.case.envelope.precision))||saved.latest&&(!saved.versions.some(v=>v.hash===saved.latest!.hash&&v.revision===saved.latest!.revision&&v.parent===saved.latest!.parent)||sourceDigest(saved.latest.source)!==saved.latest.sourceHash))throw new TypeError('unapproved-evidence');
 const latest=saved.latest, tests=saved.tests.filter(x=>x.artifact===latest?.hash);
 // Only a passing CURRENT case can be proposed; a pass on other cases alone still needs a current test.
 const proposable=tests.some(t=>t.passed&&t.results.some(r=>r.current&&r.passed));
 const stage=!latest?'write':proposable?'propose':!tests.length||tests.at(-1)!.passed?'test':'revise';
 return composed(stage,approved,reference,approved);
}
