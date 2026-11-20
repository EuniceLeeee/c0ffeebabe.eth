import { FunctionFragment, Interface, ParamType, getAddress } from "ethers";
import { familyId, lineageId } from "./adapter-family-identifiers.js";
import type { DiscoverySemantics, FamilyManifest, FundingExecutionBinding, FundingTokenCandidate, UnifiedObservation } from "./adapter-family-plugin.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";
import { decodeSelectorAbiArguments, selectorFamilyIdentity, selectorExecutionInstanceKey, selectorImmutableParameters, selectorAbiParameterAt } from "./selector-execution-keys.js";

type Value = string | boolean | readonly Value[];
export interface SelectorFundingRead {
  readonly target: Value;
  readonly signature: string;
  readonly args: readonly Value[];
  readonly result: number;
}
export interface SelectorNativeFundingDefinition {
  readonly format: "selector-family/v2";
  readonly selector: string;
  readonly signature: string;
  readonly domain: "funding";
  readonly activation?: { readonly enabled: boolean; readonly envKey: string };
  readonly parameters: readonly { readonly path: readonly number[]; readonly role: "tokenIn" | "amountIn" | "executor" | "recipient" | "children" | "bound" }[];
  readonly execution: {
    readonly callback: { readonly signature: string; readonly dataArgument: number; readonly args: readonly Value[] };
    readonly repayment: { readonly mode: "transfer" | "approve-pull" };
  };
  readonly funding: {
    readonly liquidity: SelectorFundingRead;
    readonly fee: { readonly kind: "constant"; readonly amount: string } | {
      readonly kind: "rate"; readonly reads: readonly SelectorFundingRead[]; readonly scale: string; readonly rounding: "ceil" };
    readonly priority?: { readonly planning: number; readonly liquidity: number };
    readonly scope?: { readonly poolIdPath?: readonly number[]; readonly poolNamespace?: string };
  };
}
export interface SelectorNativeFundingCandidate extends FundingTokenCandidate {
  readonly candidateKind: "selector-funding";
  readonly target: string;
  readonly provider: string;
  readonly scope: { readonly chainId: number; readonly target: string; readonly poolId?: string; readonly poolNamespace?: string };
  readonly assets: readonly string[];
  readonly fundingBindings: readonly FundingExecutionBinding[];
  readonly declarationFingerprint: string;
  readonly census: any;
  readonly callId: string;
}
const canonical = (v: unknown) => v as CanonicalValue;
function fail(message: string): never { throw new Error(`selector funding: ${message}`); }
export function freezeFundingData<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freezeFundingData); Object.freeze(value); }
  return value;
}
function record(value: unknown, required: readonly string[], optional: readonly string[], label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(k => !Object.hasOwn(value,k)) ||
      Object.keys(value).some(k => !required.includes(k) && !optional.includes(k))) fail(`${label} fields`);
}
function json(value: unknown, depth=0): void {
  if (depth>32 || value===undefined || typeof value==="function" || typeof value==="bigint" || typeof value==="symbol" ||
      typeof value==="number" && !Number.isSafeInteger(value)) fail("lossless bounded JSON required");
  if (value && typeof value==="object") for (const key of Reflect.ownKeys(value)) {
    const item=Object.getOwnPropertyDescriptor(value,key)!;
    if(typeof key!=="string" || ["__proto__","constructor","prototype"].includes(key) || !("value" in item)) fail("unsafe JSON");
    json(item.value,depth+1);
  }
}
export function fundingUint(value: unknown, label="amount"): bigint {
  if (typeof value!=="bigint" && (typeof value!=="string" || !/^(0|[1-9][0-9]*)$/.test(value))) fail(`${label} uint256`);
  const n=BigInt(value as string|bigint); if(n<0n || n>=(1n<<256n)) fail(`${label} uint256`); return n;
}
function value(v: unknown): void {
  if (Array.isArray(v)) { if(v.length>128) fail("argument array budget"); v.forEach(value); return; }
  if (typeof v!=="string" && typeof v!=="boolean") fail("argument value");
  if(typeof v==="string" && v.startsWith("$") && !/^\$(provider|tokenIn|executor|recipient|amountIn|fee|children|previous(?:\.[0-9]+)*|args(?:\.[0-9]+)+)$/.test(v)) fail("unbound argument reference");
}
function read(v: unknown): void {
  record(v,["target","signature","args","result"],[],"read"); const fn=FunctionFragment.from(v.signature);
  if(!["view","pure"].includes(fn.stateMutability) || !Array.isArray(v.args) || v.args.length!==fn.inputs.length ||
     !Number.isSafeInteger(v.result) || v.result<0 || v.result>=fn.outputs.length) fail("read ABI");
  value(v.target); v.args.forEach(value);
}
function abiPath(p: unknown): asserts p is readonly number[] {
  if(!Array.isArray(p) || !p.length || p.length>16 || p.some(i=>!Number.isSafeInteger(i)||i<0)) fail("ABI path");
}
function parameterType(signature: string, path: readonly number[]): ParamType {
  let type: ParamType | undefined = FunctionFragment.from(signature).inputs[path[0]!];
  for (const index of path.slice(1)) {
    if (type?.baseType === "tuple") type = type.components?.[index];
    else if (type?.baseType === "array" && (type.arrayLength === -1 || index < type.arrayLength!)) type = type.arrayChildren ?? undefined;
    else type = undefined;
  }
  return type ?? fail("parameter path exceeds ABI");
}
function validateDefinition(raw: unknown): asserts raw is SelectorNativeFundingDefinition {
  record(raw,["format","selector","signature","domain","parameters","execution","funding"],["activation"],"definition");
  if(raw.format!=="selector-family/v2" || raw.domain!=="funding") fail("v2 format/domain required");
  selectorFamilyIdentity(raw.signature,raw.selector);
  const fn=FunctionFragment.from(raw.signature);
  if(!Array.isArray(raw.parameters) || !raw.parameters.length || raw.parameters.length>256)fail("parameter roles required");
  const paths: readonly (readonly number[])[] = raw.parameters.map((parameter:any)=>{
    record(parameter,["path","role"],[],"parameter");abiPath(parameter.path);
    if(!["tokenIn","amountIn","executor","recipient","children","bound"].includes(parameter.role))fail("parameter role");
    const type=parameterType(raw.signature,parameter.path),scalar=type.baseType==="array"?type.arrayChildren!:type;
    if(type.baseType==="array" && parameter.role!=="bound" && ![-1,1].includes(type.arrayLength!))fail("funding roles require scalar or one-element dynamic array");
    if(parameter.role==="tokenIn" && scalar.type!=="address" || parameter.role==="amountIn" && !/^uint[0-9]+$/.test(scalar.type) ||
       ["executor","recipient"].includes(parameter.role) && type.type!=="address")fail("parameter role differs from ABI");
    if(parameter.role==="children" && (type.type!=="bytes" || parameter.path.length!==1 || parameter.path[0]!==fn.inputs.length-1))fail("one direct final children bytes parameter required");
    return parameter.path;
  });
  const prefix=(a:readonly number[],b:readonly number[])=>a.length<=b.length && a.every((index,i)=>index===b[i]);
  if(paths.some((a,i)=>paths.some((b,j)=>i<j && (prefix(a,b)||prefix(b,a)))))fail("parameter paths overlap");
  function covered(type:ParamType,path:readonly number[]):boolean {
    if(paths.some(p=>prefix(p,path)))return true;
    if(type.baseType==="tuple")return type.components!.every((child,index)=>covered(child,[...path,index]));
    if(type.baseType==="array" && type.arrayLength!==-1 && type.arrayLength!<=256)return Array.from({length:type.arrayLength!},(_,index)=>covered(type.arrayChildren!,[...path,index])).every(Boolean);
    return false;
  }
  if(!fn.inputs.every((type,index)=>covered(type,[index])))fail("every ABI parameter requires a mutable or bound role");
  for(const role of ["tokenIn","amountIn","children"])if(raw.parameters.filter((p:any)=>p.role===role).length!==1)fail(`one ${role} role required`);
  const asset=raw.parameters.find((p:any)=>p.role==="tokenIn")!,amount=raw.parameters.find((p:any)=>p.role==="amountIn")!;
  if((parameterType(raw.signature,asset.path).baseType==="array")!==(parameterType(raw.signature,amount.path).baseType==="array"))fail("asset/amount multiplicity differs");
  record(raw.execution,["callback","repayment"],[],"execution");
  const cb=raw.execution.callback;
  record(cb,["signature","dataArgument","args"],[],"callback"); const callback=FunctionFragment.from(cb.signature);
  if(!Number.isSafeInteger(cb.dataArgument) || cb.dataArgument!==callback.inputs.length-1 || callback.inputs[cb.dataArgument]?.type!=="bytes" ||
      !Array.isArray(cb.args) || cb.args.length!==callback.inputs.length ||
      cb.args[cb.dataArgument]!=="$children" || cb.args.filter((v:unknown)=>v==="$children").length!==1) fail("callback ABI/payload");
  cb.args.forEach(value);
  record(raw.execution.repayment,["mode"],[],"repayment");if(!["transfer","approve-pull"].includes(raw.execution.repayment.mode))fail("repayment mode");
  record(raw.funding,["liquidity","fee"],["priority","scope"],"funding");read(raw.funding.liquidity);
  const fee=raw.funding.fee;
  record(fee,["kind"],fee?.kind==="constant"?["amount"]:["reads","scale","rounding"],"fee");
  if(fee.kind==="constant") fundingUint(fee.amount,"fee");
  else if(fee.kind==="rate") {if(fee.rounding!=="ceil" || fundingUint(fee.scale,"fee scale")===0n || !Array.isArray(fee.reads) || !fee.reads.length || fee.reads.length>4) fail("fee read program");fee.reads.forEach(read);}
  else fail("fee kind");
  if(raw.activation!==undefined) {record(raw.activation,["enabled","envKey"],[],"activation");if(typeof raw.activation.enabled!=="boolean" || !/^SEARCHER_FAMILY_[A-Z0-9_]+_ENABLED$/.test(raw.activation.envKey)) fail("activation");}
  if(raw.funding.priority!==undefined) {record(raw.funding.priority,["planning","liquidity"],[],"priority");if(!Number.isSafeInteger(raw.funding.priority.planning)||!Number.isSafeInteger(raw.funding.priority.liquidity)) fail("priority");}
  if(raw.funding.scope!==undefined){const scope=raw.funding.scope;record(scope,[],["poolIdPath","poolNamespace"],"scope");if(scope.poolIdPath)abiPath(scope.poolIdPath);
    if(scope.poolNamespace!==undefined && (typeof scope.poolNamespace!=="string" || !scope.poolNamespace || !scope.poolIdPath))fail("pool namespace");}
}
export function normalizeSelectorNativeFundingDefinition(raw: unknown): SelectorNativeFundingDefinition {
  json(raw);record(raw,["selector","signature","domain","parameters","execution","funding"],["format","activation","meta"],"definition");
  if(raw.format!==undefined && raw.format!=="selector-family/v2")fail("retired format; selector-family/v2 required");
  if(raw.meta!==undefined && (!raw.meta || typeof raw.meta!=="object" || Array.isArray(raw.meta)))fail("meta must be a data record");
  const {meta:_meta,...semantic}=raw;
  const definition={...JSON.parse(JSON.stringify(semantic)),format:"selector-family/v2"};
  validateDefinition(definition);
  return freezeFundingData({...definition,selector:definition.selector.toLowerCase(),signature:FunctionFragment.from(definition.signature).format("full")});
}
export function validateSelectorNativeFundingDefinition(raw:unknown):void {normalizeSelectorNativeFundingDefinition(raw);}
export function selectorNativeFundingFamilyId(raw: Pick<SelectorNativeFundingDefinition,"selector"|"signature">) {
  return selectorFamilyIdentity(raw.signature,raw.selector).familyId;
}
export function selectorFundingValue(v: Value, environment: Readonly<Record<string,unknown>>): any {
  if(Array.isArray(v)) return v.map(x=>selectorFundingValue(x,environment));
  if(typeof v!=="string" || !v.startsWith("$")) return v;
  const path=v.slice(1).split("."); let out:any=environment;
  for(const key of path) {if(!out || !Object.hasOwn(out,key)) fail(`unbound ${v}`);out=out[key];}
  return out;
}
export function selectorFundingParameterProjection(definition:SelectorNativeFundingDefinition) {
  const asset=definition.parameters.find(p=>p.role==="tokenIn")!,amount=definition.parameters.find(p=>p.role==="amountIn")!;
  return {assetsPath:asset.path,amountsPath:amount.path,multiple:parameterType(definition.signature,asset.path).baseType==="array",
    childrenIndex:definition.parameters.find(p=>p.role==="children")!.path[0]!};
}
/** The shared role map selects current amount/actor/asset. Only bound paths
 * retain historical arguments; array funding always executes one chosen asset. */
export function selectorFundingCallArguments(definition:SelectorNativeFundingDefinition,environment:Readonly<Record<string,unknown>>):readonly unknown[] {
  const fn=FunctionFragment.from(definition.signature);
  const args:any[]=JSON.parse(JSON.stringify(environment.args??fn.inputs.map(()=>null)));
  for(const parameter of definition.parameters){
    if(parameter.role==="bound")continue;
    const reference=parameter.role==="recipient"?"$executor":`$${parameter.role}`;
    const raw=selectorFundingValue(reference,environment),type=parameterType(definition.signature,parameter.path),replacement=type.baseType==="array"?[raw]:raw;
    let parent=args;for(const index of parameter.path.slice(0,-1)){if(!Array.isArray(parent[index]))fail("bound tuple/array argument missing");parent=parent[index];}
    parent[parameter.path.at(-1)!]=replacement;
  }
  // Round-trip now, so malformed retained bound arguments never reach the VM.
  const abi=new Interface([definition.signature]),encoded=abi.encodeFunctionData(fn,args);
  return abi.decodeFunctionData(fn,encoded).toArray(true);
}
export function selectorFundingReadCall(read: SelectorFundingRead, environment: Readonly<Record<string,unknown>>) {
  const abi=new Interface([read.signature]);
  return {to:getAddress(selectorFundingValue(read.target,environment)),data:abi.encodeFunctionData(FunctionFragment.from(read.signature),read.args.map(x=>selectorFundingValue(x,environment)))};
}
export function decodeSelectorFundingRead(read: SelectorFundingRead, data: string): readonly unknown[] {
  const abi=new Interface([read.signature]), fn=FunctionFragment.from(read.signature), result=abi.decodeFunctionResult(fn,data);
  if(abi.encodeFunctionResult(fn,result).toLowerCase()!==data.toLowerCase()) fail("noncanonical read return");return [...result];
}
export function selectorFundingInstanceKey(binding: FundingExecutionBinding) {
  return selectorExecutionInstanceKey({chainId:binding.chainId,familyId:selectorFamilyIdentity(binding.signature,binding.selector).familyId,
    target:binding.provider,...(binding.poolId===undefined?{}:{poolId:binding.poolId}),...(binding.poolNamespace===undefined?{}:{poolNamespace:binding.poolNamespace}),
    ...(binding.immutableParameters===undefined?{}:{immutableParameters:binding.immutableParameters as any})});
}
/** Values copied from the observed ABI remain bound, even when the author did
 * not repeat their paths separately. New loan amounts use $amountIn. */
export function selectorFundingImmutableParameters(definition:SelectorNativeFundingDefinition,args:readonly unknown[]) {
  const paths=definition.parameters.filter(p=>p.role==="bound").map(p=>p.path);
  const collect=(value:unknown):void=>{
    if(Array.isArray(value))value.forEach(collect);
    else if(typeof value==="string"&&value.startsWith("$args."))paths.push(value.slice(6).split(".").map(Number));
  };
  collect(definition.execution.callback.args);
  for(const read of [definition.funding.liquidity,...(definition.funding.fee.kind==="rate"?definition.funding.fee.reads:[])]) {collect(read.target);collect(read.args);}
  return selectorImmutableParameters(definition.signature,args,paths);
}
/** Solidity permits callers to omit the final ABI word's zero padding.
 * For a trailing opaque Funding callback, accept only that spelling:
 * every declared payload byte must still be present, and the padded form
 * must pass the same exact canonical round trip as ordinary calldata. */
export function decodeSelectorFundingCalldata(definition:SelectorNativeFundingDefinition, calldata:string) {
  if(!/^0x(?:[0-9a-f]{2}){4,}$/i.test(calldata))fail("invalid funding calldata");
  const body=calldata.slice(10), size=body.length/2;
  if(size%32===0)return decodeSelectorAbiArguments(definition.signature,calldata);
  const fn=FunctionFragment.from(definition.signature);
  const path=definition.parameters.find(p=>p.role==="children")?.path;
  const index=fn.inputs.length-1;
  // In this narrow form, each preceding ABI argument uses one head word.
  if(path?.length!==1||path[0]!==index||fn.inputs[index]?.type!=="bytes"||
     fn.inputs.slice(0,index).some(p=>p.baseType==="tuple"||p.baseType==="array"&&p.arrayLength!==-1))
    fail("noncanonical funding callback ABI");
  const word=(at:bigint):bigint=>{
    if(at<0n||at+32n>BigInt(size))fail("truncated funding callback head");
    return BigInt("0x"+body.slice(Number(at)*2,Number(at+32n)*2));
  };
  const offset=word(BigInt(index)*32n);
  if(offset%32n!==0n||offset<BigInt(fn.inputs.length)*32n)fail("invalid funding callback offset");
  const payloadSize=word(offset);
  if(offset+32n+payloadSize>BigInt(size))fail("truncated funding callback bytes");
  return decodeSelectorAbiArguments(definition.signature,calldata+"00".repeat(32-size%32));
}
/** Shared ABI projection. The caller owns evidence for the successful call frame;
 * calldata alone is neither a completed loan nor current liquidity. */
export function fundingBindingsFromCall(definition:SelectorNativeFundingDefinition, chainId:number,
  call:{target:string;calldata:string;poolId?:string;poolNamespace?:string}):readonly FundingExecutionBinding[] {
    if(!Number.isSafeInteger(chainId)||chainId<=0)fail("invalid funding chain");
    const family=selectorFamilyIdentity(definition.signature,definition.selector),projection=selectorFundingParameterProjection(definition);
    const args=decodeSelectorFundingCalldata(definition,call.calldata);
    const at=(path:readonly number[])=>path.reduce<unknown>((item,index)=>Array.isArray(item)?item[index]:undefined,args);
    const observedAssets=at(projection.assetsPath), observedAmounts=at(projection.amountsPath);
    const assets=projection.multiple?observedAssets:[observedAssets], amounts=projection.multiple?observedAmounts:[observedAmounts];
    if(!Array.isArray(assets)||!assets.length||assets.length>128||!Array.isArray(amounts)||amounts.length!==assets.length||amounts.some(n=>fundingUint(n)===0n))fail("invalid funded assets or amounts");
    const provider=getAddress(call.target).toLowerCase(), normalized=assets.map((a:unknown)=>{
      if(typeof a!=="string")fail("invalid funding asset");return getAddress(a).toLowerCase();
    });
    if(BigInt(provider)===0n||new Set(normalized).size!==normalized.length || normalized.some(a=>BigInt(a)===0n))fail("invalid provider or duplicate/zero asset");
    const immutableParameters=selectorFundingImmutableParameters(definition,args);
    const typedPool=definition.funding.scope?.poolIdPath?selectorAbiParameterAt(definition.signature,args,definition.funding.scope.poolIdPath).value:call.poolId;
    if(typedPool!==undefined && (typeof typedPool!=="string" || !typedPool))fail("invalid funding pool identifier");
    const pool=typedPool;
    const common={chainId,provider,selector:family.selector,signature:family.signature,arguments:args,
      ...(pool===undefined?{}:{poolId:pool,poolNamespace:definition.funding.scope?.poolNamespace??call.poolNamespace??"contract-pool-id"}),immutableParameters};
    return freezeFundingData(normalized.map(asset=>({...common,asset})));
}
export function selectorNativeFundingCandidateFromCensus(raw: SelectorNativeFundingDefinition, census: any, callId: string): SelectorNativeFundingCandidate|null {
  try {
    const definition=normalizeSelectorNativeFundingDefinition(raw),family=selectorFamilyIdentity(definition.signature,definition.selector);
    if(census?.format!=="ready-selector-census/v1" || census.receiptStatus!==1 || !Number.isSafeInteger(census.chainId)||census.chainId<=0 ||
       !/^0x[0-9a-f]{64}$/i.test(census.blockHash??"") || !/^0x[0-9a-f]{64}$/i.test(census.transactionHash??"")) return null;
    const calls=census.calls.filter((c:any)=>c.id===callId);if(calls.length!==1)return null;const call=calls[0];
    if(call.executionStatus!=="success" || !call.target || !call.calldata || call.selector?.toLowerCase()!==family.selector || call.callType!==null && !["call","transaction"].includes(call.callType))return null;
    const fundingBindings=fundingBindingsFromCall(definition,census.chainId,call),common=fundingBindings[0]!;
    const provider=common.provider,normalized=fundingBindings.map(b=>b.asset);
    return freezeFundingData({candidateKind:"selector-funding",target:provider,provider,scope:{chainId:census.chainId,target:provider,...(common.poolId===undefined?{}:{poolId:common.poolId,poolNamespace:common.poolNamespace})},asset:normalized[0]!,assets:normalized,
      fundingBindings,declarationFingerprint:hashCanonical(canonical(definition)),census:JSON.parse(JSON.stringify(census)),callId});
  } catch {return null;}
}
export function assertSelectorNativeFundingCandidate(candidate: SelectorNativeFundingCandidate, definition: SelectorNativeFundingDefinition): void {
  const rebuilt=selectorNativeFundingCandidateFromCensus(definition,candidate?.census,candidate?.callId);
  const fields=candidate&&{candidateKind:candidate.candidateKind,target:candidate.target,provider:candidate.provider,scope:candidate.scope,asset:candidate.asset,assets:candidate.assets,
    fundingBindings:candidate.fundingBindings,declarationFingerprint:candidate.declarationFingerprint,census:candidate.census,callId:candidate.callId};
  if(!rebuilt||hashCanonical(canonical(rebuilt))!==hashCanonical(canonical(fields))) fail("candidate binding differs");
}
export function compileSelectorNativeFundingDiscovery(raw: unknown): {manifest:FamilyManifest<"funding">;discovery:DiscoverySemantics<SelectorNativeFundingCandidate>} {
  const definition=normalizeSelectorNativeFundingDefinition(raw), id=selectorNativeFundingFamilyId(definition), action=`${id}:call`;
  return {manifest:{familyId:id,domain:"funding",ownedActionAdapterIds:[action],requiredInfraActionAdapterIds:["assert-balance",definition.execution.repayment.mode==="transfer"?"erc20-transfer":"erc20-approve"],
    allowedTaxonomy:[{slotKind:"flash"}],supportedLineages:[lineageId(id)],fundingPriority:{planningPriority:definition.funding.priority?.planning??0,liquidityPriority:definition.funding.priority?.liquidity??0}},
    discovery:{sources:["observed-call"],evidenceChannel:"tx-evidence",callPatterns:[{id:`${id}:call`,selector:definition.selector as `0x${string}`,signature:definition.signature,candidateAddress:{from:"call-target"}}],
      decodeCandidate({observation,matchedPatternId}) {
        try {
        if(observation.kind!=="call" || matchedPatternId!==`${id}:call`) return null;
        const opaque=observation.opaque as {selectorCensus?:any;callId?:string}|undefined;
        if(!opaque?.selectorCensus||typeof opaque.callId!=="string")return null;
        const evidence=observation.evidenceSource??observation.source;
        if(!Number.isSafeInteger(evidence.number)||evidence.number<0||!Number.isSafeInteger(evidence.generation)||evidence.generation<0||
           typeof evidence.hash!=="string"||!/^0x[0-9a-f]{64}$/i.test(evidence.hash)||
           typeof observation.transactionHash!=="string"||typeof observation.sender!=="string"||
           opaque.selectorCensus.blockNumber!==evidence.number || opaque.selectorCensus.blockHash?.toLowerCase()!==evidence.hash.toLowerCase() ||
           observation.transactionHash.toLowerCase()!==opaque.selectorCensus.transactionHash?.toLowerCase())return null;
        const candidate=selectorNativeFundingCandidateFromCensus(definition,opaque.selectorCensus,opaque.callId);
        const call=opaque.selectorCensus.calls.find((c:any)=>c.id===opaque.callId);
        const trace=observation.traceAddress;
        if(!candidate||typeof observation.target!=="string"||typeof observation.data!=="string"||
           candidate.target!==observation.target.toLowerCase()||call?.calldata?.toLowerCase()!==observation.data.toLowerCase() ||
           observation.sender.toLowerCase()!==call.sender?.toLowerCase() ||
           trace!==undefined && (!Array.isArray(trace)||trace.some(step=>!Number.isSafeInteger(step)||step<0)||JSON.stringify(trace)!==JSON.stringify(call.traceAddress)))return null;
        return candidate;
        } catch { return null; }
      },
      candidateKey(candidate) {assertSelectorNativeFundingCandidate(candidate,definition);return `funding-nomination:${hashCanonical({instance:selectorFundingInstanceKey(candidate.fundingBindings[0]!),assets:[...candidate.assets].sort()})}`;},
    }};
}
