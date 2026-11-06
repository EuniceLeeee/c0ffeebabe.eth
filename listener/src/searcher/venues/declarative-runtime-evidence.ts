import { AbiCoder, Interface, getAddress, isHexString, keccak256, verifyTypedData, type TypedDataDomain, type TypedDataField } from "ethers";
import type { RuntimeEvidence, UnifiedObservation } from "./adapter-family-plugin.js";
import type { CanonicalSource } from "./adapter-request-program.js";
import { instanceKey, type FamilyId } from "./adapter-family-identifiers.js";
import { hashCanonical } from "./canonical-value.js";
import { compileDeclarativeNominationReadFlow } from "./declarative-nomination.js";
import { validateDeclarativeReadFlow, type DeclarativeReadFlow, type ReadFlowValues } from "./declarative-read-flow.js";
import { validateDeclarativeValue } from "./declarative-values.js";
import { PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND } from "../runtime-evidence.js";

export interface SignedBlockEvidence {
  readonly version: 1;
  readonly kind: string;
  readonly observedId: string;
  readonly pendingId: string;
  readonly intakeTargets: readonly string[];
  readonly call: { readonly target: string; readonly signature: string; readonly where: unknown; readonly pendingWhere: unknown; readonly items: unknown; readonly instance: unknown };
  readonly proof: { readonly domain: TypedDataDomain; readonly types: Record<string, TypedDataField[]>;
    readonly message: unknown; readonly block: unknown; readonly payload: unknown; readonly signer: unknown; readonly signature: unknown; readonly tupleType: string };
  readonly authority: DeclarativeReadFlow;
}

function shape(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(k => !Object.hasOwn(value,k))) throw new Error("invalid signed evidence "+label);
}
export function validateSignedBlockEvidence(value: unknown): asserts value is SignedBlockEvidence {
  shape(value, ["version","kind","observedId","pendingId","intakeTargets","call","proof","authority"], "module");
  if (value.version!==1 || [value.kind,value.observedId,value.pendingId].some(v=>typeof v!=="string"||!v.trim()))
    throw new Error("invalid signed evidence identifiers");
  if (!Array.isArray(value.intakeTargets)||!value.intakeTargets.length||value.intakeTargets.length>32)
    throw new Error("invalid signed evidence intake targets");
  value.intakeTargets.forEach(a=>getAddress(a));
  shape(value.call, ["target","signature","where","pendingWhere","items","instance"], "call");
  getAddress(value.call.target);
  if (typeof value.call.signature!=="string" || new Interface([value.call.signature]).fragments.length!==1)
    throw new Error("invalid signed evidence ABI");
  shape(value.proof, ["domain","types","message","block","payload","signer","signature","tupleType"], "proof");
  if (typeof value.proof.tupleType!=="string" || !value.proof.tupleType.startsWith("tuple(") ||
      !value.proof.tupleType.endsWith(")[]")) throw new Error("signed evidence requires a tuple array");
  // Signatures bind a declared deployment on a declared chain. No observed transaction controls this domain.
  const domain=value.proof.domain;
  if (!domain || typeof domain.name!=="string" || !domain.name || typeof domain.version!=="string" ||
      !Number.isSafeInteger(domain.chainId) || domain.chainId<=0) throw new Error("invalid typed-data domain");
  getAddress(domain.verifyingContract);
  for (const node of [value.call.where,value.call.pendingWhere,value.call.items,value.call.instance,value.proof.message,value.proof.block,value.proof.payload,value.proof.signer,value.proof.signature]) validateDeclarativeValue(node);
  validateDeclarativeReadFlow(value.authority);
}

type Call = Extract<UnifiedObservation,{kind:"call"}>;
type Witness={raw: any; block:bigint; payload:string; signer:string; id:string; valid:boolean};
const MAX_ITEMS = 64;
const MAX_OCCURRENCES = 8;

function calldataFrames(data:string,target:string,selector:string,pending:boolean): readonly string[] {
  if (!isHexString(data,true)) return [];
  const hex=data.toLowerCase(), needle=target.toLowerCase().slice(2), sel=selector.slice(2);
  const frames=new Set<string>();
  if (hex.startsWith(selector)) frames.add(hex);
  if (!pending) return [...frames];
  let offset=2;
  for(let hits=0;hits<MAX_OCCURRENCES;hits++) {
    const at=hex.indexOf(needle,offset);if(at<0) break;offset=at+2;
    if(at%2!==0) continue;
    const start=at+needle.length;
    if(hex.startsWith(sel,start)) frames.add("0x"+hex.slice(start));
    const payloadStart=start+6;
    if(!hex.startsWith(sel,payloadStart)) continue;
    const length=Number.parseInt(hex.slice(start,payloadStart),16);
    if(length>=4 && payloadStart+length*2<=hex.length) frames.add("0x"+hex.slice(payloadStart,payloadStart+length*2));
  }
  return [...frames];
}
function sameSource(a:CanonicalSource,b:CanonicalSource):boolean {
  return Number.isSafeInteger(a?.number)&&a.number>=0&&a.number===b?.number&&Number.isSafeInteger(a.generation)&&
    a.generation>=0&&a.generation===b.generation&&isHexString(a.hash,32)&&a.hash.toLowerCase()===b.hash.toLowerCase();
}
export function compileSignedBlockEvidence(familyId:FamilyId, raw:unknown, values:ReadFlowValues) {
  validateSignedBlockEvidence(raw);
  const definition=raw;
  const ABI = AbiCoder.defaultAbiCoder();
  const call=definition.call,iface=new Interface([call.signature]);
  const method=iface.getFunction(call.signature.replace(/^function\s+/,"").split("(")[0]!)!;
  const authority=compileDeclarativeNominationReadFlow(definition.authority,values);
  const target=getAddress(call.target).toLowerCase();
  function witness(item:any):Witness {
    const env={item};
    const block=values.evaluate(definition.proof.block,env), payload=values.evaluate(definition.proof.payload,env);
    const signer=getAddress(values.evaluate(definition.proof.signer,env)).toLowerCase();
    if (typeof block!=="bigint" || block<0n || block>0xffffffffffffffffn || !isHexString(payload,true)) throw new Error("invalid signed block tuple");
    const sig=values.evaluate(definition.proof.signature,env), message=values.evaluate(definition.proof.message,env);
    let valid=false;
    try {valid=verifyTypedData(definition.proof.domain,definition.proof.types,message,sig).toLowerCase()===signer;} catch { /* Invalid and contract signatures carry no EOA authority. */ }
    return {raw:item,block,payload,signer,id:keccak256(payload),valid};
  }
  function encoded(rows:readonly Witness[]):string {
    if (!rows.length || rows.length>MAX_ITEMS) throw new Error("invalid signed block witness count");
    const byBlock=new Map<bigint,Witness>();
    for(const row of rows){const current=byBlock.get(row.block);if(!current||row.id<current.id)byBlock.set(row.block,row);}
    const sorted=[...byBlock.values()].sort((a,b)=>a.block<b.block?-1:a.block>b.block?1:0);
    return ABI.encode([definition.proof.tupleType],[sorted.map(row=>row.raw)]);
  }
  function sealed(id:string,source:CanonicalSource,tx:string,rows:readonly Witness[],key?:string):RuntimeEvidence {
    const payload=encoded(rows),lower=tx.toLowerCase();
    const evidenceHash="0x"+hashCanonical({familyId,txHash:lower,source:{number:source.number,hash:source.hash.toLowerCase(),generation:source.generation},payloadHash:keccak256(payload)});
    return Object.freeze({evidenceId:id,familyId,...(key!==undefined&&{instanceKey:instanceKey(key)}),kind:definition.kind,
      scope:"transaction",source,txHash:lower,evidenceHash,sealedPayloadRef:payload});
  }
  function supported(input:{observation:UnifiedObservation;source:CanonicalSource}):input is {observation:Call & {transactionHash:string};source:CanonicalSource} {
    const v=input.observation;
    return v.kind==="call" && v.target.toLowerCase()===target && isHexString(v.transactionHash,32)&&sameSource(v.source,input.source);
  }
  function* decoded(observation:Call,source:CanonicalSource,pending:boolean) {
    for(const data of calldataFrames(observation.data,target,method.selector,pending)) {
      try {
        const args=iface.decodeFunctionData(method,data).toArray(true);
        if(pending && iface.encodeFunctionData(method,args).toLowerCase()!==data) continue;
        const env={observation,source,args};
        if(values.evaluate(pending?call.pendingWhere:call.where,env)!==true)continue;
        const items=values.evaluate(call.items,env);
        if(!Array.isArray(items)||items.length>MAX_ITEMS)continue;
        yield {items,env};
      } catch { /* A malformed frame does not authenticate later frames. */ }
    }
  }
  const cannotRead=async():Promise<never>=>{throw new Error("signed pending authority only accepts pinned eth_call");};
  const discovery={
    canonicalIntakeTargets:Object.freeze(definition.intakeTargets.map(a=>getAddress(a).toLowerCase())),
    runtimeEvidenceRouteActivation:{mode:"current-head-block-scan",scope:"family"} as const,
    runtimeEvidenceFromObservation(input:{observation:UnifiedObservation;source:CanonicalSource}):readonly RuntimeEvidence[] {
      if(!supported(input))return [];
      for(const {items,env} of decoded(input.observation,input.source,false)) for(const item of items) {
        try {
          const row=witness(item);
          if(row.valid && row.block===BigInt(input.source.number)) {
            const key=values.evaluate(call.instance,env);
            if(typeof key!=="string"||!key.length)throw new Error("missing signed observation instance");
            return [sealed(definition.observedId,input.source,input.observation.transactionHash,[row],key)];
          }
        }catch { /* Each observed signature stands on its own. */ }
      }
      return [];
    },
    async pendingRuntimeEvidenceFromObservation(input:{observation:UnifiedObservation;source:CanonicalSource;call(read:{to:string;data:string}):Promise<string>}):Promise<readonly RuntimeEvidence[]> {
      if(!supported(input))return [];
      const unique=new Map<string,Witness>();
      for(const {items} of decoded(input.observation,input.source,true)) {
        let rows:Witness[];
        try { rows=items.map(witness); } catch { continue; }
        for(const row of rows)unique.set(row.id,row);
        if(unique.size>MAX_ITEMS)throw new Error("too many distinct signed witnesses");
      }
      const selected=[...unique.values()].filter(row=>row.valid && row.block===BigInt(input.source.number));
      if(!selected.length)return [];
      const signers=[...new Set(selected.map(row=>row.signer))];
      const proof=await authority({nomination:{address:target,opaque:{signers}},source:input.source,
        provider:{call:input.call,getCode:cannotRead,getStorage:cannotRead,getLogs:cannotRead,getTransactionReceipt:cannotRead}});
      if(!proof || typeof proof!=="object" || Array.isArray(proof) || !("allowed" in proof) || !Array.isArray(proof.allowed))
        throw new Error("invalid pending authority result");
      const allowed=new Set(proof.allowed.map(x=>getAddress(String(x)).toLowerCase()));
      if([...allowed].some(a=>!signers.includes(a)))throw new Error("pending authority returned an unrequested signer");
      const authorized=selected.filter(row=>allowed.has(row.signer));
      return authorized.length?[sealed(definition.pendingId,input.source,input.observation.transactionHash,authorized)]:[];
    },
  };
  function authenticate(input:{runtimeEvidence:readonly RuntimeEvidence[];source:CanonicalSource;descriptor:{instanceKey:string}}) {
    if(!Array.isArray(input.runtimeEvidence))throw new Error("signed runtime evidence must be an array");
    if(!input.runtimeEvidence.length)return null;
    const matching = input.runtimeEvidence.filter(row => row.familyId === familyId &&
      [definition.kind, PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND].includes(row.kind));
    if (matching.length !== 1) throw new Error("expected one matching signed runtime evidence");
    const evidence=matching[0]!;
    if(evidence.familyId!==familyId || evidence.scope!=="transaction" || !isHexString(evidence.txHash,32) ||
      ![definition.kind,PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND].includes(evidence.kind) || !sameSource(evidence.source,input.source) ||
      (evidence.instanceKey!==undefined && evidence.instanceKey!==input.descriptor.instanceKey)) throw new Error("foreign or stale signed runtime evidence");
    const payload=evidence.sealedPayloadRef;
    if(!isHexString(payload,true))throw new Error("malformed signed payload");
    const payloadHash=keccak256(payload), source=input.source,tx=evidence.txHash!.toLowerCase();
    const expected=evidence.kind===PENDING_EXECUTION_RUNTIME_EVIDENCE_KIND
      ?keccak256(ABI.encode(["string","bytes32","uint256","bytes32","bytes32"],[familyId,tx,source.number,source.hash,payloadHash]))
      :"0x"+hashCanonical({familyId, txHash:tx,source:{number:source.number,hash:source.hash.toLowerCase(),generation:source.generation},payloadHash});
    if(expected!==evidence.evidenceHash.toLowerCase())throw new Error("signed runtime evidence hash mismatch");
    const decoded=ABI.decode([definition.proof.tupleType],payload)[0];
    if(!decoded.length||decoded.length>MAX_ITEMS)throw new Error("invalid signed payload count");
    const rows:Witness[]=Array.from(decoded,(row:any)=>witness(row.toArray(true)));
    if(rows.some(row=>!row.valid)||!rows.some(row=>row.block===BigInt(source.number))||encoded(rows).toLowerCase()!==payload.toLowerCase())
      throw new Error("noncanonical or unauthenticated signed payload");
    return Object.freeze({payload,payloadHash,evidenceHash:evidence.evidenceHash,txHash:tx,items:rows.map(row=>row.raw),ids:rows.map(row=>row.id)});
  }
  return {discovery,authenticate};
}
