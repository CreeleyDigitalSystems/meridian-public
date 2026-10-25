/** Public core has no production root attestation authority. Normal uncached verification is unchanged. */
export interface PrefixProvenance {sourceRevision:string;imageConfigId:string}
export interface PrefixProofOptions extends PrefixProvenance {receiptPath:string;onProgress?:(event:PrefixVerification)=>void}
export interface PrefixRuntime {sourceDigest:string;dependencyDigest:string;node:string;sqlite:string;zlib:string}
export interface RawPrefix {count:number;sequence:number;hash:string;digest:string;bytes:number}
export interface PrefixVerification {path:'full'|'root-prefix';prefixRawRows:number;prefixRawBytes:number;prefixSchemaRows:number;suffixSchemaRows:number;suffixReplayRows:number;headSequence:number;complete:boolean}
export interface PrefixProofReceipt {format:1;policy:'private-prefix-v1';provenance:PrefixProvenance;runtime:PrefixRuntime;anchor:RawPrefix&{snapshotDigest:string;minute:number};genesisDigest:string;clockDigest:string;epoch:number|null;verification:PrefixVerification}
export interface RawLedgerRow {sequence:unknown;previous_hash:unknown;hash:unknown;event_json:unknown}
const unavailable=():never=>{throw new Error('production-prefix-attestation-unavailable-in-public-core')};
export function assertPrefixProvenance(_value:PrefixProvenance):void {unavailable()}
export function loadRootPrefixReceipt(_options:PrefixProofOptions):PrefixProofReceipt {return unavailable()}
export function prefixRuntime():PrefixRuntime {return unavailable()}
export function publishRootPrefixReceipt(_path:string,_receipt:PrefixProofReceipt):string {return unavailable()}
export function requireRootPublisher(_path:string):void {unavailable()}
export function typedRowsDigest(_rows:Iterable<Record<string,unknown>>):string {return unavailable()}
export class PrefixRawHasher {constructor(){unavailable()} add(_row:RawLedgerRow):void {unavailable()} finish():RawPrefix {return unavailable()}}
