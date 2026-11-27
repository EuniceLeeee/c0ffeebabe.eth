import {selectorExecutionPrograms,selectorProgramProjection,selectSingleExecution} from "./selector-program-role.js";
import { EventFragment, keccak256 } from "ethers";
import { instanceKey, lineageId } from "./adapter-family-identifiers.js";
import type { DiscoverySemantics, FamilyManifest, FamilyCandidate, LogPattern } from "./adapter-family-plugin.js";
import type { ReadySelectorCensusTransaction } from "../ready-selector-census.js";
import { hashCanonical, type CanonicalValue } from "./canonical-value.js";
import { selectorObservedCallResources, type SelectorObservedCallScope } from "./selector-execution-observation.js";
import { hasSqlPairBinding } from "./selector-native-edge-price.js";
import type { SelectorAbiValue, SelectorImmutableParameter } from "./selector-execution-keys.js";
import { assertVerifiedSelectorSourceCall, type VerifiedSelectorSourceCall } from "./selector-source-call-witness.js";
import type { CanonicalSource } from "./adapter-request-program.js";
import {assertSelectorSourceIdentity,isDirectSelectorSourceIdentity,type SelectorSourceIdentity} from './selector-source-identity.js';
import type {SqlLiveEdgeCoordinates} from './selector-native-sql-live-binding.js';
import { freezeSelectorNative, normalizeSelectorNativeExecutionDefinition, selectorNativeFamilyId, selectorNativeProgramKey,
  type SelectorNativeExecutionDefinition } from "./selector-native-definition.js";

export interface SelectorNativeCandidate extends FamilyCandidate {
  readonly candidateKind: "selector-native-execution";
  readonly target: string;
  readonly arguments: readonly SelectorAbiValue[];
  readonly scope: SelectorObservedCallScope;
  readonly immutableParameters: readonly SelectorImmutableParameter[];
  readonly observedAmountIn?: string;
  readonly programKeys: readonly string[];
  readonly programKey: string;
  readonly census: ReadySelectorCensusTransaction;
  readonly callId: string;
  readonly declarationFingerprint: string;
}

export interface SelectorNativeStateCandidate extends FamilyCandidate {
  readonly candidateKind: "selector-native-state";
  readonly target: string;
  readonly scope: SelectorObservedCallScope;
  readonly requestedDirection: { readonly tokenIn: string; readonly tokenOut: string };
  readonly immutableParameters: readonly [];
  readonly programKey: string;
  readonly declarationFingerprint: string;
}

export interface SelectorNativeSourceCandidate extends FamilyCandidate {
 readonly candidateKind:"selector-native-source"; readonly target:string;
 readonly scope:SelectorObservedCallScope;readonly immutableParameters:readonly [];
 readonly programKey:string;readonly declarationFingerprint:string;
 readonly witness:VerifiedSelectorSourceCall;readonly source:CanonicalSource;
}
export interface SelectorNativeSourceIdentityCandidate extends FamilyCandidate {
 readonly candidateKind:'selector-native-source-identity';readonly target:string;readonly scope:SelectorObservedCallScope;
 readonly immutableParameters:readonly [];readonly programKey:string;readonly declarationFingerprint:string;
 readonly identity:SelectorSourceIdentity|null;readonly edge:SqlLiveEdgeCoordinates;readonly source:CanonicalSource;
}
export type SelectorNativeBindingCandidate = SelectorNativeCandidate | SelectorNativeStateCandidate | SelectorNativeSourceCandidate | SelectorNativeSourceIdentityCandidate;
type ReadSource={readonly number:number;readonly hash:string;readonly generation:number};
type CapturedCode={readonly source:ReadSource;readonly target:string;readonly hash:string};
// Non-serialized hint. Only reverseBinding's existing canonical code read may
// mint it. The lifecycle's address-surface snapshot keeps the same opaque object.
const observedCode=new WeakMap<object,CapturedCode>(),candidateCode=new WeakMap<object,CapturedCode>();
const sameRead=(a:ReadSource,b:ReadSource)=>!!a&&!!b&&a.number===b.number&&a.hash===b.hash&&a.generation===b.generation;
export function selectorObservedTargetCode(candidate:object,source:ReadSource,target:string):string|undefined{
 const info=candidateCode.get(candidate);return info&&sameRead(info.source,source)&&info.target===target?info.hash:undefined;
}
const hash = (value: unknown): string => hashCanonical(value as CanonicalValue);
const defHashMemo = new WeakMap<SelectorNativeExecutionDefinition, string>();
function memoDefHash(definition: SelectorNativeExecutionDefinition): string {
 const hit = defHashMemo.get(definition);
 if (hit !== undefined) return hit;
 const digest = hash(definition);
 if (Object.isFrozen(definition)) defHashMemo.set(definition, digest);
 return digest;
}
const address = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{40}$/.test(value);
export function selectorNativeSourceIdentityCandidate(definition:SelectorNativeExecutionDefinition,identity:SelectorSourceIdentity|null,
 edge:SqlLiveEdgeCoordinates,source:CanonicalSource,programKey:string):SelectorNativeSourceIdentityCandidate{
 const single=selectSingleExecution(definition);
 if(single.programKey!==programKey)throw Error('unknown source execution program');
 if(identity!==null)assertSelectorSourceIdentity(identity,{definition,edge,source,programKey});
 else if(definition.programs.some(p=>p.type==='independentIdentity'))throw Error('source execution requires matching identity option');
 const state=definition.directState;if(!state)throw Error('unknown source execution identity');
 if((edge.poolId!=null)!==!!state.poolId||(edge.poolNamespace!=null&&edge.poolNamespace!==state.poolNamespace))throw Error('source identity physical pool scope differs');
 if(state.poolId&&(!/^0x[a-f0-9]{64}$/.test(edge.poolId!)||/^0x0{64}$/.test(edge.poolId!)))throw Error('source identity requires a full logical pool id');
 if(edge.hookData!=null&&(typeof edge.hookData!=='string'||edge.hookData.length>8194||!/^0x(?:[0-9a-f]{2})*$/i.test(edge.hookData)))
  throw Error('invalid source identity hookData');
 const target=edge.poolAddress.toLowerCase();
 const coordinates:SqlLiveEdgeCoordinates={chainId:edge.chainId,selector:edge.selector,poolAddress:target,tokenIn:edge.tokenIn,tokenOut:edge.tokenOut,
  ...(edge.poolId==null?{}:{poolId:edge.poolId}),...(edge.poolNamespace==null?{}:{poolNamespace:edge.poolNamespace}),
  ...(edge.tokenInId==null?{}:{tokenInId:edge.tokenInId}),...(edge.tokenOutId==null?{}:{tokenOutId:edge.tokenOutId}),
  ...(edge.hookData==null?{}:{hookData:edge.hookData.toLowerCase()})};
 return freezeSelectorNative({candidateKind:'selector-native-source-identity',target,
  scope:{chainId:1,target,tokenIn:edge.tokenIn.toLowerCase(),tokenOut:edge.tokenOut.toLowerCase(),
   ...(edge.poolId==null?{}:{poolId:edge.poolId,poolNamespace:state.poolNamespace})},
  immutableParameters:[],programKey,declarationFingerprint:memoDefHash(definition),identity,edge:coordinates,source:{...source}});
}
export function selectorNativeSourceCandidate(definition:SelectorNativeExecutionDefinition,witness:VerifiedSelectorSourceCall,
 source:CanonicalSource,programKey:string):SelectorNativeSourceCandidate {
 if(!definition.directState||witness.selector!==definition.selector||selectSingleExecution(definition).programKey!==programKey)
  throw Error("no declared source execution program");
 assertVerifiedSelectorSourceCall(witness,{edge:witness,source,discoveryRuleHash:definition.directState.discoveryRuleHash});
 if((witness.poolId!==null)!==!!definition.directState.poolId||witness.poolNamespace!==(definition.directState.poolNamespace??null))throw Error("source definition differs from physical pool scope");
 return freezeSelectorNative({candidateKind:"selector-native-source",target:witness.poolAddress,
  scope:{chainId:1,target:witness.poolAddress,tokenIn:witness.tokenIn,tokenOut:witness.tokenOut,
    ...(witness.poolId!==null?{poolId:witness.poolId,poolNamespace:witness.poolNamespace!}:{})},immutableParameters:[],
  programKey,declarationFingerprint:hash(definition),witness,source});
}
const stateDefinitions = new WeakMap<SelectorNativeExecutionDefinition, {
  readonly fingerprint: string;
  readonly byProgram: ReadonlyMap<string, NonNullable<NonNullable<SelectorNativeExecutionDefinition["programs"][number]["binding"]>["stateBinding"]>>;
}>();
function stateDefinition(definition: SelectorNativeExecutionDefinition) {
  const prior=stateDefinitions.get(definition);if(prior)return prior;
  const byProgram=new Map();
  for(const p of selectorExecutionPrograms(definition)){
    const stateBinding=selectorProgramProjection(p)?.stateBinding;
    if(stateBinding)byProgram.set(selectorNativeProgramKey(p),stateBinding);
    else if(hasSqlPairBinding(definition,p))byProgram.set(selectorNativeProgramKey(p),{});
  }
  const result={fingerprint:hash(definition),byProgram};
  // The production compiler deeply freezes normalized definitions.
  if(Object.isFrozen(definition))stateDefinitions.set(definition,result);
  return result;
}

/** Nomination only: no calldata, historical call, or verification claim.
 * The declared program must derive the pair from the physical coordinates. */
export function selectorNativeStateCandidate(
  definition: SelectorNativeExecutionDefinition,
  input: { chainId: unknown; target: unknown; poolId?: unknown; poolNamespace?: unknown; tokenIn: unknown; tokenOut: unknown },
  programKey: string,
): SelectorNativeStateCandidate | null {
  const compiled=stateDefinition(definition),state=compiled.byProgram.get(programKey);
  if(!state||input.chainId!==1||!address(input.target)||/^0x0{40}$/.test(input.target)||
     !address(input.tokenIn)||!address(input.tokenOut)||input.tokenIn===input.tokenOut)return null;
  const {poolNamespace}=state;
  const poolId=input.poolId??undefined;
  if(poolNamespace===undefined ? poolId!==undefined||input.poolNamespace!=null
    : typeof poolId!=="string"||!/^0x[0-9a-f]{64}$/.test(poolId)||/^0x0{64}$/.test(poolId)||
      input.poolNamespace!=null&&input.poolNamespace!==poolNamespace)return null;
  return freezeSelectorNative({candidateKind:"selector-native-state",target:input.target,
    scope:{chainId:1,target:input.target,...(poolNamespace===undefined?{}:{poolId:poolId as string,poolNamespace})},
    requestedDirection:{tokenIn:input.tokenIn,tokenOut:input.tokenOut},immutableParameters:[],
    programKey,declarationFingerprint:compiled.fingerprint});
}

/** Each call pattern selects one execution recipe. A caller must not silently
 * choose the first recipe when several share a selector or resource scope. */
export function selectorNativeCandidateFromCensus(
  definition: SelectorNativeExecutionDefinition,
  census: ReadySelectorCensusTransaction,
  callId: string,
  programKey?: string,
): SelectorNativeCandidate | null {
  try {
    const entries = selectorExecutionPrograms(definition).length
      ? selectorExecutionPrograms(definition).map(program => ({ program, key: selectorNativeProgramKey(program) }))
      : [{ program: undefined, key: "observed" }];
    const selected = programKey === undefined ? entries : entries.filter(entry => entry.key === programKey);
    if (selected.length !== 1) return null;
    const { program, key } = selected[0]!;
    const declared = program?.binding?.nomination ?? {};
    const rolePath = (role: string, explicit: readonly number[] | undefined): readonly number[] | undefined => {
      const paths = program?.parameters?.filter(parameter => parameter.role === role).map(parameter => parameter.path) ?? [];
      if (explicit && paths.length && !paths.some(path => JSON.stringify(path) === JSON.stringify(explicit)))
        throw new Error("selector nomination path disagrees with its parameter role");
      return explicit ?? (paths.length === 1 ? paths[0] : undefined);
    };
    const tokenInPath = rolePath("tokenIn", declared.tokenInPath);
    const tokenOutPath = rolePath("tokenOut", declared.tokenOutPath);
    const tokenInIdPath = rolePath("tokenInId", declared.tokenInIdPath);
    const tokenOutIdPath = rolePath("tokenOutId", declared.tokenOutIdPath);
    const poolIdPath = rolePath("poolId", declared.poolIdPath);
    const nomination = { ...declared,
      parameterPaths: [...(declared.parameterPaths ?? []), ...(program?.parameters?.filter(parameter =>
        ["bound", "poolId", "tokenInId", "tokenOutId"].includes(parameter.role)).map(parameter => parameter.path) ?? [])],
      ...(tokenInPath === undefined ? {} : { tokenInPath }), ...(tokenOutPath === undefined ? {} : { tokenOutPath }),
      ...(tokenInIdPath === undefined ? {} : { tokenInIdPath }), ...(tokenOutIdPath === undefined ? {} : { tokenOutIdPath }),
      ...(poolIdPath === undefined ? {} : { poolIdPath }) };
    const data = selectorObservedCallResources({ signature: definition.signature, selector: definition.selector,
      census, callId, nomination });
    if (!data) return null;
    return freezeSelectorNative({ candidateKind: "selector-native-execution", target: data.scope.target,
      arguments: data.arguments, scope: data.scope, immutableParameters: data.immutableParameters,
      ...(data.observedAmountIn === undefined ? {} : { observedAmountIn: data.observedAmountIn }),
      programKeys: [key], programKey: key, census: JSON.parse(JSON.stringify(census)), callId,
      declarationFingerprint: hash(definition) });
  } catch { return null; }
}

export function selectorNativeCandidateKey(candidate: SelectorNativeBindingCandidate, definition: SelectorNativeExecutionDefinition) {
  assertSelectorNativeCandidate(candidate, definition);
  if(candidate.candidateKind==="selector-native-state")return instanceKey(`selector-state-nomination:${hash(candidateOwnedState(candidate))}`);
  return instanceKey(`selector-nomination:${hash({ familyId: selectorNativeFamilyId(definition), scope: candidate.scope,
    immutableParameters: candidate.immutableParameters, programKey: candidate.programKey })}`);
}

function candidateOwnedState(candidate: SelectorNativeStateCandidate) {
  return {candidateKind:candidate.candidateKind,target:candidate.target,scope:candidate.scope,
    requestedDirection:candidate.requestedDirection,immutableParameters:candidate.immutableParameters,
    programKey:candidate.programKey,declarationFingerprint:candidate.declarationFingerprint};
}
export function assertSelectorNativeCandidate(candidate: SelectorNativeBindingCandidate, definition: SelectorNativeExecutionDefinition): void {
  if(candidate?.candidateKind==='selector-native-source-identity'){
   const rebuilt=selectorNativeSourceIdentityCandidate(definition,candidate.identity,candidate.edge,candidate.source,candidate.programKey);
   if(hash(rebuilt)!==hash(candidate))throw Error('source identity nomination changed');return;
  }
  if(candidate?.candidateKind==="selector-native-source"){
   const rebuilt=selectorNativeSourceCandidate(definition,candidate.witness,candidate.source,candidate.programKey);
   if(hash(rebuilt)!==hash(candidate))throw Error("source nomination changed");
   return;
  }
  if(candidate?.candidateKind==="selector-native-state"){
    const rebuilt=selectorNativeStateCandidate(definition,{...candidate.scope,...candidate.requestedDirection},candidate.programKey);
    if(!rebuilt||["census","callId","arguments","observedAmountIn","readyObservation","transactionHash"].some(key=>Object.hasOwn(candidate,key))||
       hash(rebuilt)!==hash(candidateOwnedState(candidate)))throw new Error("selector-native state nomination changed");
    return;
  }
  const rebuilt = selectorNativeCandidateFromCensus(definition, candidate?.census, candidate?.callId, candidate?.programKey);
  const owned = { candidateKind: candidate?.candidateKind, target: candidate?.target, arguments: candidate?.arguments, scope: candidate?.scope,
    immutableParameters: candidate?.immutableParameters,
    ...(candidate?.observedAmountIn === undefined ? {} : { observedAmountIn: candidate.observedAmountIn }),
    programKeys: candidate?.programKeys, programKey: candidate?.programKey, census: candidate?.census,
    callId: candidate?.callId, declarationFingerprint: candidate?.declarationFingerprint };
  if (!rebuilt || hash(rebuilt) !== hash(owned)) throw new Error("selector-native candidate binding changed");
}

/** SQL/Ready projection. It never executes a protocol adapter or requests state. */
export function compileSelectorNativeDiscovery(raw: unknown): { manifest: FamilyManifest<any>; discovery: DiscoverySemantics<SelectorNativeBindingCandidate> } {
  const definition = normalizeSelectorNativeExecutionDefinition(raw), id = selectorNativeFamilyId(definition), callId = `${id}:call`;
  const programKeys = selectorExecutionPrograms(definition).length ? selectorExecutionPrograms(definition).map(selectorNativeProgramKey) : ["observed"];
  const patternPrograms = new Map(programKeys.map(key => [`${callId}:${key}`, key]));
  const statePatterns = selectorExecutionPrograms(definition).filter(p=>stateDefinition(definition).byProgram.has(selectorNativeProgramKey(p))).map(program=>{
    const key=selectorNativeProgramKey(program);
    return {id:`${callId}:state:${key}`,kind:"interface" as const,fingerprint:`${id}:state:${key}`,key};
  });
  if(definition.directState)for(const program of selectorExecutionPrograms(definition).filter(p=>p.execution)){
   const key=selectorNativeProgramKey(program);
   statePatterns.push({id:`${callId}:source:${key}`,kind:"interface",fingerprint:`${id}:source:${key}`,key});
  }
  const stateByPattern=new Map(statePatterns.map(p=>[p.id,p]));
  const decodeState=(opaque:unknown,key:string,target:string)=>{
    try{
      const raw=(opaque as {selectorStateCandidate?:SelectorNativeBindingCandidate})?.selectorStateCandidate;
      if(raw?.candidateKind==="selector-native-source"){
       if(raw.programKey!==key||raw.target!==target)return null;
       assertSelectorNativeCandidate(raw,definition);
       return selectorNativeSourceCandidate(definition,raw.witness,raw.source,raw.programKey);
      }
      if(raw?.candidateKind==='selector-native-source-identity'){
       if(raw.programKey!==key||raw.target!==target)return null;
       assertSelectorNativeCandidate(raw,definition);
       return selectorNativeSourceIdentityCandidate(definition,raw.identity,raw.edge,raw.source,raw.programKey);
      }
      if(raw?.candidateKind!=="selector-native-state"||raw.programKey!==key||raw.target!==target)return null;
      assertSelectorNativeCandidate(raw,definition);
      return freezeSelectorNative(candidateOwnedState(raw));
    }catch{return null;}
  };
  const events = new Map<string, LogPattern>();
  for (const program of selectorExecutionPrograms(definition)) for (const row of program.observations?.events ?? []) {
    if (!row.signature && !row.topic) continue;
    const signatureTopic = row.signature === undefined ? undefined : EventFragment.from(row.signature).topicHash;
    const topic = String(row.topic ?? signatureTopic).toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(topic) || signatureTopic !== undefined && signatureTopic !== topic)
      throw new Error("selector-native observation topic differs from ABI");
    // Program-local event labels are annotations, and may repeat across recipes.
    if (!events.has(topic)) events.set(topic, { id: `${callId}:event:${topic}`, signature: row.signature ?? topic, topic: topic as `0x${string}` });
  }
  const allowedTaxonomy = definition.domain === "swap" ? [{ slotKind: "swap" }] : [{ slotKind: "protocol", protocolAction: "convert" },
    ...["wrap", "unwrap", "redeem"].map(protocolAction => ({ slotKind: "protocol", protocolAction }))];
  const manifest: FamilyManifest<any> = { familyId: id, domain: definition.domain,
    supportedLineages: programKeys.map(key => lineageId(`${id}:${key}`)),
    ownedActionAdapterIds: [callId], edgeAdapterIds: [callId], requiredInfraActionAdapterIds: [], allowedTaxonomy: allowedTaxonomy as any };
  const discovery: DiscoverySemantics<SelectorNativeBindingCandidate> = {
    sources: ["observed-call", ...(events.size ? ["landed-log" as const] : [])], candidateSources: ["observed-interaction"],
    evidenceChannel: statePatterns.length?"tx-evidence-or-reverse-binding":"tx-evidence",
    callPatterns: [...patternPrograms].map(([patternId]) => ({ id: patternId, selector: definition.selector as `0x${string}`,
      signature: definition.signature, candidateAddress: { from: "call-target" as const } })),
    ...(events.size ? { logPatterns: [...events.values()] } : {}),
    ...(statePatterns.length?{
      addressSurfaces:statePatterns.map(({key:_,...surface})=>surface),
      reverseBinding:{kind:"implementation" as const,async reverseBinding({nominations,source,provider}){
        return Promise.all(nominations.map(async({address,opaque})=>{
          const target=address.toLowerCase();
          const input={selectorStateCandidate:opaque};
          const sourceCandidate=['selector-native-source','selector-native-source-identity'].includes((opaque as unknown as SelectorNativeBindingCandidate)?.candidateKind);
          const pattern=statePatterns.find(row=>row.id.includes(":source:")===sourceCandidate&&decodeState(input,row.key,target)!==null);
          if(!pattern)return {status:"unsupported" as const,reason:"no declared state binding for nomination"};
          const candidate=decodeState(input,pattern.key,target)!;
          let codeHash:string;
          if(candidate.candidateKind==="selector-native-source-identity"&&candidate.identity!==null&&isDirectSelectorSourceIdentity(candidate.identity)){
            codeHash=keccak256(Buffer.from(`direct-source-execution:${source.number}:${source.hash.toLowerCase()}:${source.generation}:${target}`));
          }else{
            const code=await provider.getCode(target,source.number);
            if(!/^0x(?:[0-9a-f]{2})+$/i.test(code))return {status:"failed" as const,reason:"candidate has no deployed code"};
            // This is an address-surface observation, not an attestation. The
            // lifecycle issues the Family's declared identity reads at source.
            codeHash=keccak256(code);
          }
          const packet=Object.freeze({selectorStateCandidate:candidate});
          observedCode.set(packet,Object.freeze({source:Object.freeze({number:source.number,hash:source.hash,generation:source.generation}),target,hash:codeHash}));
          return {status:"verified" as const,observation:{kind:"address-surface" as const,
            source,address:target,codeHash,implementationWord:"0x"+"00".repeat(32),
            interfaceFingerprints:[pattern.fingerprint],opaque:packet as never}};
        }));
      }},
    }:{reverseBinding:{kind:"explicitly-unsupported" as const,reason:"selector census owns nomination; static binding and funded simulation own execution"}}),
    decodeCandidate({ observation, matchedPatternId }) {
      try {
        if(observation.kind==="address-surface"){
          const pattern=stateByPattern.get(matchedPatternId);
          if(!pattern||!observation.interfaceFingerprints?.includes(pattern.fingerprint))return null;
          const target=observation.address.toLowerCase(),candidate=decodeState(observation.opaque,pattern.key,target);
          const packet=observation.opaque,info=packet&&typeof packet==="object"?observedCode.get(packet):undefined;
          if(candidate&&info&&info.hash===observation.codeHash&&sameRead(info.source,observation.source)&&info.target===target)
            candidateCode.set(candidate,info);
          return candidate;
        }
        if (observation.kind !== "call") return null;
        const key = patternPrograms.get(matchedPatternId);
        if (key === undefined) return null;
        const data = observation.opaque as { selectorCensus?: ReadySelectorCensusTransaction; callId?: string } | undefined;
        if (!data?.selectorCensus || typeof data.callId !== "string") return null;
        const source = observation.evidenceSource ?? observation.source;
        if (!Number.isSafeInteger(source.number) || source.number < 0 || !Number.isSafeInteger(source.generation) || source.generation < 0 ||
            typeof source.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(source.hash) ||
            data.selectorCensus.blockNumber !== source.number || data.selectorCensus.blockHash?.toLowerCase() !== source.hash.toLowerCase()) return null;
        const candidate = selectorNativeCandidateFromCensus(definition, data.selectorCensus, data.callId, key);
        const call = candidate?.census.calls.find(row => row.id === candidate.callId);
        if (!candidate || !call || typeof observation.target !== "string" || typeof observation.data !== "string" ||
            typeof observation.transactionHash !== "string" || typeof observation.sender !== "string" ||
            call.target !== observation.target.toLowerCase() || call.calldata !== observation.data.toLowerCase() ||
            call.selector !== definition.selector || candidate.census.transactionHash !== observation.transactionHash.toLowerCase() ||
            call.sender !== observation.sender.toLowerCase()) return null;
        if (observation.traceAddress !== undefined && (!Array.isArray(observation.traceAddress) || call.traceAddress === null ||
            observation.traceAddress.length !== call.traceAddress.length || observation.traceAddress.some((step, index) =>
              !Number.isSafeInteger(step) || step < 0 || step !== call.traceAddress![index]))) return null;
        return candidate;
      } catch { return null; }
    },
    candidateKey(candidate) { return selectorNativeCandidateKey(candidate, definition); },
    instanceNominationKey(candidate) { return selectorNativeCandidateKey(candidate as SelectorNativeBindingCandidate, definition); },
    candidateCoverageKey(candidate) { return selectorNativeCandidateKey(candidate as SelectorNativeBindingCandidate, definition); },
  };
  return { manifest, discovery };
}
