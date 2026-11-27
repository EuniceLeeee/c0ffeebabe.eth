import {selectorExecutionPrograms,selectorProgramProjection,selectSingleExecution} from "./selector-program-role.js";
import { keccak256 } from 'ethers';
import { runStrictFamilyLifecycle } from '../strict-family-lifecycle-runner.js';
import { createStrictCentralAdapterRuntime } from '../strict-central-adapter-runtime.js';
import { buildFamilyRuntimeAmountLeg, reissuePreparedInstanceRouteHandles, type PreparedFamilyInstance } from './adapter-family-runtime.js';
import type { CanonicalSource } from './adapter-request-program.js';
import type { FamilyCapabilityCatalog } from './family-capability-catalog.js';
import type { CanonicalValue } from './canonical-value.js';
import { selectorNativeStateCandidate, selectorNativeSourceCandidate,selectorNativeSourceIdentityCandidate } from './selector-native-discovery.js';
import {assertSelectorSourceIdentity,type SelectorSourceIdentity} from './selector-source-identity.js';
import {assertVerifiedSelectorSourceCall, type VerifiedSelectorSourceCall} from './selector-source-call-witness.js';
import { selectorNativeFamilyId, selectorNativeProgramKey, type SelectorNativeExecutionDefinition, type SelectorNativeProgram } from './selector-native-definition.js';
import {hasSqlPairBinding, type SqlLiveBindingReceipt} from './selector-native-edge-price.js';
import { assertSqlLiveRouteBinding, MissingSqlPricingPoolOwner, type SqlLiveEdgeCoordinates } from './selector-native-sql-live-binding.js';
import { getEthersCallRpcError } from '../rpc-throttle-guard.js';
import type { SqlPriceEdge } from '../sql-edge-price-index.js';
import { validateSqlExecutionParamHints, SqlParamEvidenceMismatch, type SqlExecutionParamHints } from './selector-native-sql-param-hints.js';
import { contradictedCommittedRoute } from './selector-native-sql-param-guard.js';
import { rememberMatchedGetter } from './declarative-verified-getter-decode.js';
import { sqlSourceTemplateVariantId, sqlTrialVariantId } from '../sql-trial-variant.js';
import { sqlHistoricalCallObservation,type SqlCallWitnessReader } from './selector-sql-call-witness.js';
import type { UnifiedObservation } from './adapter-family-plugin.js';

// Only live issuer output can register this binding. In particular a trial
// compiler, SQL row or deserialized receipt cannot register a price alias.
const issuedTrialIds=new WeakMap<object,{routeKey:string;programKey:string;alias:string}>();
export function issuedSqlTrialVariant(instance:object,routeKey:string,programKey:string):string|undefined {
  const v=issuedTrialIds.get(instance);
  return v?.routeKey===routeKey&&v.programKey===programKey?v.alias:undefined;
}

/** Re-issues a deterministic 0-RPC direct-execution template instance at a new
 * canonical source without re-compiling the selector AST lifecycle. */
export function reissueSqlDirectMaterializedInstance(input: {
  readonly catalog: FamilyCapabilityCatalog;
  readonly templateInstance: PreparedFamilyInstance;
  readonly source: CanonicalSource;
}): PreparedFamilyInstance {
  const family = input.catalog.forFamily(input.templateInstance.familyId);
  const reissued = reissuePreparedInstanceRouteHandles({
    family,
    instance: input.templateInstance,
    source: input.source,
    generation: input.source.generation,
  });
  const priorTrial = issuedTrialIds.get(input.templateInstance);
  if (priorTrial) issuedTrialIds.set(reissued, priorTrial);
  return reissued;
}

function need(ok:unknown,message:string):asserts ok { if(!ok)throw Error('SQL live binding receipt: '+message); }
const sameSource=(a:CanonicalSource,b:CanonicalSource)=>!!a && a.hash===b.hash && a.number===b.number && a.generation===b.generation;
const nonemptyCode=(s:string)=>typeof s==='string' && s.length<=2+2*24576 && /^0x(?:[0-9a-f]{2})+$/.test(s);
const address=/^0x[0-9a-f]{40}$/,calldata=/^0x[0-9a-f]{8}(?:[0-9a-f]{2})*$/;
const validReturn=(s:string)=>typeof s==="string"&&s.length<=65538&&/^0x(?:[0-9a-f]{2})*$/.test(s);
const noTransport=async():Promise<never>=>{throw Error("no declared SQL binding transport for this read");};
type Base={readonly catalog:FamilyCapabilityCatalog;readonly definition:SelectorNativeExecutionDefinition;readonly edge:SqlLiveEdgeCoordinates;
  readonly source:CanonicalSource;readonly executor:string;readonly transactionOrigin:string;readonly signal?:AbortSignal};
type SourceReads={readonly read:(to:string,data:string)=>Promise<string>;readonly readCode:(at:string)=>Promise<string>};
function providerFor(source:CanonicalSource,{read,readCode}:SourceReads){
  return {getCode:(a:string,tag?:number)=>{need(tag===source.number,'unpinned code read');return readCode(a.toLowerCase());},
    call:(tx:{to:string;data:string;from?:string;blockTag?:number},tag?:number)=>{
      need(tag===source.number&&(tx.blockTag===undefined||tx.blockTag===tag)&&tx.from===undefined,'unpinned or caller-dependent binding read');
      return read(tx.to.toLowerCase(),tx.data.toLowerCase());},getStorage:noTransport,getLogs:noTransport,getTransactionReceipt:noTransport};
}
const keyCache=new WeakMap<SelectorNativeProgram,string>();
function programKeyOf(p:SelectorNativeProgram){
  if(!Object.isFrozen(p))return selectorNativeProgramKey(p);
  let k=keyCache.get(p);if(k===undefined){k=selectorNativeProgramKey(p);keyCache.set(p,k);}return k;
}
// A SQL direction exists independently of a particular encoding recipe.
// Describe the missing encoding input; don't call it a reverted swap, infer
// the call target from custody, or pretend poolId is reversible calldata.
function missingRecipeInput(def:SelectorNativeExecutionDefinition,p:SelectorNativeProgram,edge:SqlLiveEdgeCoordinates):string {
  const binding=selectorProgramProjection(p)?.stateBinding;
  if(binding || hasSqlPairBinding(def,p)){
    const ns=binding?.poolNamespace;
    if(ns===undefined && (edge.poolId!=null || edge.poolNamespace!=null))return "recipe needs an address-scoped pool; SQL identifies a logical pool";
    if(ns!==undefined && (edge.poolId==null || !/^0x[0-9a-f]{64}$/.test(edge.poolId) || /^0x0{64}$/.test(edge.poolId)))
      return "recipe needs a nonzero bytes32 poolId";
    if(ns!==undefined && edge.poolNamespace!=null && edge.poolNamespace!==ns)return "recipe and SQL use different pool namespaces";
    return "recipe cannot bind the supplied chain, address or asset coordinates";
  }
  const paths:unknown=selectorProgramProjection(p)?.nomination?.parameterPaths;
  const indices=Array.isArray(paths)?paths.filter((v):v is number[]=>Array.isArray(v)&&v.length>0&&v.every(i=>Number.isSafeInteger(i)&&i>=0)).map(v=>"args["+v.join("][")+"]"):[];
  return indices.length ? "recipe needs original call inputs "+indices.join(", ")+"; SQL contains asset and pool coordinates only"
    :"recipe declares no way to derive its execution inputs from SQL asset and pool coordinates";
}
async function issue(input:Base,programKey:string,reads:SourceReads,historical?:()=>Promise<UnifiedObservation>,
  reportUnowned?:(hash:string)=>void,sourceWitness?:VerifiedSelectorSourceCall,sourceIdentity?:SelectorSourceIdentity,directSourceEdge?:boolean) {
  const {catalog,definition,edge,source,executor,transactionOrigin,signal}=input;
  signal?.throwIfAborted();
  const familyId=selectorNativeFamilyId(definition),family=catalog.forFamily(familyId);
  const candidate=directSourceEdge?selectorNativeSourceIdentityCandidate(definition,null,edge,source,programKey):sourceIdentity?selectorNativeSourceIdentityCandidate(definition,sourceIdentity,edge,source,programKey):sourceWitness?selectorNativeSourceCandidate(definition,sourceWitness,source,programKey):selectorNativeStateCandidate(definition,{chainId:edge.chainId,target:edge.poolAddress.toLowerCase(),poolId:edge.poolId,
    poolNamespace:edge.poolNamespace,tokenIn:edge.tokenIn.toLowerCase(),tokenOut:edge.tokenOut.toLowerCase()},programKey);
  const capture=family.plugin.discovery.reverseBinding;
  if(!candidate&&!historical){
    const p=selectorExecutionPrograms(definition).find(p=>programKeyOf(p)===programKey);
    throw Error("quote-unavailable: "+(p?missingRecipeInput(definition,p,edge):"unknown encoding recipe"));
  }
  const provider=providerFor(source,reads);
  let observation:UnifiedObservation,matchedPatternId:string|undefined;
  if(candidate){
    need(capture?.kind==='implementation','quote-unavailable: recipe has no source-pinned execution binding');
    const channel=await capture.reverseBinding({source,provider,nominations:[{address:candidate.target,opaque:candidate as unknown as CanonicalValue}]});
    need(channel.length===1,'Family must return a single resource binding');
    const bound=channel[0]!;
    if(bound.status!=='verified')throw Error("quote-unavailable: "+bound.reason);
    observation=bound.observation;
  }else{
    observation=await historical!();
    const matches=catalog.matches(observation).filter(m=>m.familyId===familyId&&
      (family.plugin.discovery.decodeCandidate({observation,matchedPatternId:m.patternId}) as {programKey?:string}|null)?.programKey===programKey);
    need(matches.length===1,'no unique Family match for the observed program');matchedPatternId=matches[0]!.patternId;
    // Discovery returned an actual mined call, not a current deployment
    // attestation. Check current code and run the original pinned lifecycle.
    need(nonemptyCode(await provider.getCode(edge.poolAddress,source.number)),'observed call target no longer deployed');
  }
  const runtime=createStrictCentralAdapterRuntime({executor,transactionOrigin,provider,generationFence:{
    assertCurrent(g,s){signal?.throwIfAborted();need(g===source.generation&&sameSource(s,source),'read escaped source');}
  }});
  const publication=await runStrictFamilyLifecycle({catalog,familyId,source,runtime,observations:[observation],matchedPatternId});
  need(publication.instances.length===1,'Family did not issue exactly one instance: '+publication.outcomes.filter(v=>
    ['failed','unresolved','rejected'].includes(v.status)).map(v=>v.reasonCode).join('; '));const instance=publication.instances[0]!;
  need(instance.routes.length===1,'ambiguous issued directions');const routeKey=instance.routes[0]!.routeKey;
  let route;
  try{route=assertSqlLiveRouteBinding({family,instance,routeKey,edge,programKey,source});}
  catch(e){
    // A hash from the authentic issued program diagnoses a missing ownership
    // declaration; never publish/register the rejected route or its handle.
    if(!candidate&&reportUnowned&&e instanceof MissingSqlPricingPoolOwner){
      const issued=instance.routeHandles.find(v=>v.routeKey===routeKey);
      if(issued){const leg=buildFamilyRuntimeAmountLeg({family,route:issued,source,runtime,executor,runtimeEvidence:[],actionOwnership:catalog});
        if(leg?.program)reportUnowned(keccak256(leg.program));}
    }throw e;
  }
  const leg=buildFamilyRuntimeAmountLeg({family,route,source,runtime,executor,runtimeEvidence:[],actionOwnership:catalog});
  need(leg?.program,'formal runtime declined the selected execution leg');signal?.throwIfAborted();
  return {instance,routeKey,program:leg.program,programKey};
}
function isContractRevert(err:unknown) {
  const e=(getEthersCallRpcError(err)??err) as {code?:number|string;message?:string;data?:string;status?:number;statusCode?:number;cause?:unknown};
  if(!e||typeof e!=='object'||e.cause||Number(e.status)>=400||Number(e.statusCode)>=400)return false;
  return e.code===3||typeof e.data==="string"&&/^0x(?:[0-9a-f]{2})*$/i.test(e.data)&&
    (e.code==="CALL_EXCEPTION"||e.code===-32000&&/^execution reverted\b/i.test(e.message??""));
}
/** Physical SQL coordinates nominate a direction, never a winning recipe.
 * The actual production issuer owns reads, decoding, pool identity and leg
 * generation. No amounts, guessed witnesses, price simulation, or RPC retries. */
export async function issueSqlFamilyAlternatives(input:Base&SourceReads&{edge:SqlLiveEdgeCoordinates&Pick<SqlPriceEdge,'executionParamEvidence'>; matchPriceTrial?:boolean;
  readCallWitness?:SqlCallWitnessReader;historicalProgramKeys?:readonly string[];sourceWitness?:VerifiedSelectorSourceCall;sourceIdentity?:SelectorSourceIdentity;directSourceEdge?:boolean}) {
  const {definition,edge}=input;
  const singleSourceKey=(input.sourceIdentity||input.directSourceEdge||input.sourceWitness)?selectSingleExecution(definition).programKey:undefined;
  if(input.sourceIdentity||input.directSourceEdge){
    need(!input.sourceWitness&&!(input.sourceIdentity&&input.directSourceEdge),'multiple source identity authorities');
    if(input.sourceIdentity)assertSelectorSourceIdentity(input.sourceIdentity,{definition,edge,source:input.source,programKey:singleSourceKey!});
    else need(!definition.programs.some(p=>p.type==='independentIdentity'),'direct source edge requires zero identity options');
  }
  if(input.sourceWitness){
    need(definition.directState,'source execution is not declared');
    assertVerifiedSelectorSourceCall(input.sourceWitness,{edge,source:input.source,discoveryRuleHash:definition.directState.discoveryRuleHash});
    const locator=edge.executionParamEvidence;
    need(locator?.consensus==='uniform'&&locator.txHash===input.sourceWitness.txHash&&locator.callPath===input.sourceWitness.callPath,
      'source execution locator differs from independently verified action');
  }
  const alternatives:Awaited<ReturnType<typeof issue>>[]=[],issues:string[]=[],ownershipRejected:{programKey:string;programHash:string}[]=[];
  const usage={recipesPruned:0,matchedGetterResults:0,mismatchedGetterResults:0,ignoredEvidenceRows:0};
  need(edge.chainId===1&&definition.selector===edge.selector,'wrong chain or selector');
  if(edge.tokenInId!=null||edge.tokenOutId!=null)return {alternatives,ownershipRejected,issues:["state nomination for token-id settlement has no token-id balance witness"],usage};
  input.signal?.throwIfAborted();
  let hints:SqlExecutionParamHints|undefined;
  if(edge.executionParamEvidence&&!input.sourceIdentity&&!input.directSourceEdge){
    try{hints=validateSqlExecutionParamHints({definition,edge,evidence:edge.executionParamEvidence});}
    catch(error){
      // The table digest, logical edge ID and record schema were already
      // checked by the loader. An obsolete optional historical annotation
      // must not change whether a sound current binding can be issued.
      if(!(error instanceof SqlParamEvidenceMismatch))throw error;
      usage.ignoredEvidenceRows++;
    }
  }
  const cache=new Map<string,Promise<string>>();let transportFailure:{value:unknown}|undefined;
  let mined:Promise<UnifiedObservation>|undefined;
  const ev=edge.executionParamEvidence;
  const locate=input.readCallWitness&&ev?.consensus==='uniform'&&ev.callPath===''?async()=>{
    if(!mined){const ref={txHash:ev.txHash,callPath:ev.callPath,signal:input.signal};
      mined=input.readCallWitness!(ref).then(census=>sqlHistoricalCallObservation(census,ref,edge,input.source));
    }
    return mined;
  }:undefined;
  for(const [index,p] of selectorExecutionPrograms(definition).entries()){
    input.signal?.throwIfAborted();const key=programKeyOf(p);
    if(singleSourceKey!==undefined&&key!==singleSourceKey)continue;
    if(input.sourceWitness&&input.historicalProgramKeys!==undefined&&!input.historicalProgramKeys.includes(key))continue;
    const hint=hints?.recipes[index];
    const reviewed=hint?.index===index&&hint.programKey===key?hint:undefined;
    if(reviewed&&contradictedCommittedRoute(p,reviewed.verifiedTuple)){
      usage.recipesPruned++;issues.push(key+": quote-unavailable: committed pool identity contradicts a required route check");continue;
    }
    const checked=new Set<string>();
    async function read(at:string,data?:string) {
      input.signal?.throwIfAborted();need(address.test(at)&&(data===undefined||calldata.test(data)&&data.length<=65538),'invalid required read');
      const k=data===undefined?at:at+":"+data;let out=cache.get(k);
      if(!out){out=(async()=>{try{
        const result=data===undefined?await input.readCode(at):await input.read(at,data);
        if(!validReturn(result))throw Error("invalid source-pinned read response");
        return result.toLowerCase();
      } catch(error){if(!isContractRevert(error))transportFailure={value:error};throw error;}})();cache.set(k,out);}
      const raw=await out;if(data===undefined)need(nonemptyCode(raw),'no deployed bytecode for this nomination');
      // Only the formal issuer asks for a read. This is an observation of a
      // successful real read at this source, never a prefetch/substitution.
      if(data!==undefined&&reviewed&&!checked.has(k)){
        checked.add(k);
        for(const g of reviewed.currentGetterChecks)if(g.target===at&&g.calldata===data){
          if(raw===g.expectedReturn){usage.matchedGetterResults++;rememberMatchedGetter(g.abi,raw);}
          else usage.mismatchedGetterResults++;
        }
      }
      return raw;
    }
    try {
      const result=await issue(input,key,{read:(a,b)=>read(a,b),readCode:a=>read(a)},reviewed&&input.historicalProgramKeys?.includes(key)?locate:undefined,
        programHash=>ownershipRejected.push({programKey:key,programHash}),input.sourceWitness,input.sourceIdentity,input.directSourceEdge);
      if(transportFailure)throw transportFailure.value;
      if(input.matchPriceTrial)issuedTrialIds.set(result.instance,{routeKey:result.routeKey,programKey:key,alias:sqlTrialVariantId(key,result.program)});
      else if(singleSourceKey!==undefined)issuedTrialIds.set(result.instance,{routeKey:result.routeKey,programKey:key,alias:sqlSourceTemplateVariantId(key)});
      alternatives.push(result);
    }catch(e){input.signal?.throwIfAborted();if(transportFailure)throw transportFailure.value;
      issues.push(key+": "+(e instanceof Error?e.message:"Family did not issue the nominated direction"));}
  }
  if(!selectorExecutionPrograms(definition).length)issues.push(definition.unsupportedReason??"no registered execution recipe");
  return {alternatives,issues,usage,ownershipRejected};
}

function resultMap(rows:readonly (readonly [string,string])[],max:number,key:RegExp,valid:(s:string)=>boolean){
  need(Array.isArray(rows)&&rows.length>0&&rows.length<=max,'invalid pinned result count');
  const result=new Map<string,string>();
  for(const tuple of rows){
    need(Array.isArray(tuple)&&tuple.length===2&&typeof tuple[0]==='string'&&key.test(tuple[0])&&valid(tuple[1])&&!result.has(tuple[0]),'invalid or duplicate pinned result');
    result.set(tuple[0],tuple[1]);
  }
  return result;
}

/** Only for a priced winner in a digest-verified, trusted startup price publication.
 * The caller binds the receipt to that publication; a self-asserted file hash or a
 * raw SQL row is not a trust root. Never reads RPC. Missing evidence is terminal. */
export async function materializeSqlLivePriceRoute(input:{
  readonly catalog:FamilyCapabilityCatalog; readonly definition:SelectorNativeExecutionDefinition;
  readonly edge:SqlLiveEdgeCoordinates; readonly source:CanonicalSource; readonly programKey:string;
  readonly executor:string; readonly transactionOrigin:string; readonly receipt:SqlLiveBindingReceipt;
  readonly expectedProgramHash:string;
}){
  const {catalog,definition,source,edge,receipt,programKey,executor,transactionOrigin,expectedProgramHash}=input;
  need(receipt?.format==='sql-edge-pinned-reads/v1' && sameSource(receipt.source,source) &&
    receipt.executor===executor.toLowerCase() && receipt.transactionOrigin===transactionOrigin.toLowerCase() &&
    receipt.programHash===expectedProgramHash && /^0x[0-9a-f]{64}$/.test(expectedProgramHash) && receipt.programKey===programKey &&
    receipt.selector===edge.selector && receipt.selector===definition.selector && receipt.poolAddress===edge.poolAddress.toLowerCase() &&
    receipt.tokenIn===edge.tokenIn.toLowerCase() && receipt.tokenOut===edge.tokenOut.toLowerCase() &&
    [edge.poolId,edge.poolNamespace,edge.tokenInId,edge.tokenOutId].every(k=>k==null),
    'source, program, actor or edge mismatch');
  const calls=resultMap(receipt.calls,32,/^0x[0-9a-f]{8}$/,v=>typeof v==='string'&&/^0x[0-9a-f]{64}$/.test(v));
  const code=resultMap(receipt.code,3,address,nonemptyCode);
  const usedCalls=new Set<string>(),usedCode=new Set<string>();
  const {instance,routeKey,program}=await issue(input,programKey,{
    readCode:async a=>{need(code.has(a),'missing pinned bytecode');usedCode.add(a);return code.get(a)!;},
    read:async(a,data)=>{need(a===receipt.poolAddress&&calls.has(data),'missing pinned getter');usedCalls.add(data);return calls.get(data)!;}});
  need(usedCalls.size===calls.size&&usedCode.size===code.size,'unconsumed binding witness');
  need(keccak256(program)===expectedProgramHash,'formal runtime generated a different program than the paid simulation');
  return Object.freeze({instance,routeKey});
}
