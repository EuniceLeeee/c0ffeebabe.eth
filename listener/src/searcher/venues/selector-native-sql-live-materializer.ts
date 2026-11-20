import { keccak256 } from 'ethers';
import { runStrictFamilyLifecycle } from '../strict-family-lifecycle-runner.js';
import { createStrictCentralAdapterRuntime } from '../strict-central-adapter-runtime.js';
import { buildFamilyRuntimeAmountLeg } from './adapter-family-runtime.js';
import type { CanonicalSource } from './adapter-request-program.js';
import type { FamilyCapabilityCatalog } from './family-capability-catalog.js';
import type { CanonicalValue } from './canonical-value.js';
import { selectorNativeStateCandidate } from './selector-native-discovery.js';
import { selectorNativeFamilyId, selectorNativeProgramKey, type SelectorNativeExecutionDefinition, type SelectorNativeProgram } from './selector-native-definition.js';
import {hasSqlPairBinding, type SqlLiveBindingReceipt} from './selector-native-edge-price.js';
import { assertSqlLiveRouteBinding, type SqlLiveEdgeCoordinates } from './selector-native-sql-live-binding.js';
import { getEthersCallRpcError } from '../rpc-throttle-guard.js';

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
  const binding=p.binding?.stateBinding;
  if(binding || hasSqlPairBinding(def,p)){
    const ns=binding?.poolNamespace;
    if(ns===undefined && (edge.poolId!=null || edge.poolNamespace!=null))return "recipe needs an address-scoped pool; SQL identifies a logical pool";
    if(ns!==undefined && (edge.poolId==null || !/^0x[0-9a-f]{64}$/.test(edge.poolId) || /^0x0{64}$/.test(edge.poolId)))
      return "recipe needs a nonzero bytes32 poolId";
    if(ns!==undefined && edge.poolNamespace!=null && edge.poolNamespace!==ns)return "recipe and SQL use different pool namespaces";
    return "recipe cannot bind the supplied chain, address or asset coordinates";
  }
  const paths:unknown=p.binding?.nomination?.parameterPaths;
  const indices=Array.isArray(paths)?paths.filter((v):v is number[]=>Array.isArray(v)&&v.length>0&&v.every(i=>Number.isSafeInteger(i)&&i>=0)).map(v=>"args["+v.join("][")+"]"):[];
  return indices.length ? "recipe needs original call inputs "+indices.join(", ")+"; SQL contains asset and pool coordinates only"
    :"recipe declares no way to derive its execution inputs from SQL asset and pool coordinates";
}
async function issue(input:Base,programKey:string,reads:SourceReads) {
  const {catalog,definition,edge,source,executor,transactionOrigin,signal}=input;
  signal?.throwIfAborted();
  const familyId=selectorNativeFamilyId(definition),family=catalog.forFamily(familyId);
  const candidate=selectorNativeStateCandidate(definition,{chainId:edge.chainId,target:edge.poolAddress.toLowerCase(),poolId:edge.poolId,
    poolNamespace:edge.poolNamespace,tokenIn:edge.tokenIn.toLowerCase(),tokenOut:edge.tokenOut.toLowerCase()},programKey);
  const capture=family.plugin.discovery.reverseBinding;
  if(!candidate){
    const p=definition.programs.find(p=>programKeyOf(p)===programKey);
    throw Error("quote-unavailable: "+(p?missingRecipeInput(definition,p,edge):"unknown encoding recipe"));
  }
  need(capture?.kind==='implementation','quote-unavailable: recipe has no source-pinned execution binding');
  const provider=providerFor(source,reads);
  const channel=await capture.reverseBinding({source,provider,nominations:[{address:candidate.target,opaque:candidate as unknown as CanonicalValue}]});
  need(channel.length===1,'Family must return a single resource binding');
  const bound=channel[0]!;
  if(bound.status!=='verified')throw Error("quote-unavailable: "+bound.reason);
  const runtime=createStrictCentralAdapterRuntime({executor,transactionOrigin,provider,generationFence:{
    assertCurrent(g,s){signal?.throwIfAborted();need(g===source.generation&&sameSource(s,source),'read escaped source');}
  }});
  const publication=await runStrictFamilyLifecycle({catalog,familyId,source,runtime,observations:[bound.observation]});
  need(publication.instances.length===1,'Family did not issue exactly one instance: '+publication.outcomes.filter(v=>
    ['failed','unresolved','rejected'].includes(v.status)).map(v=>v.reasonCode).join('; '));const instance=publication.instances[0]!;
  need(instance.routes.length===1,'ambiguous issued directions');const routeKey=instance.routes[0]!.routeKey;
  const route=assertSqlLiveRouteBinding({family,instance,routeKey,edge,programKey,source});
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
export async function issueSqlFamilyAlternatives(input:Base&SourceReads) {
  const {definition,edge}=input;
  const alternatives:Awaited<ReturnType<typeof issue>>[]=[],issues:string[]=[];
  need(edge.chainId===1&&definition.selector===edge.selector,'wrong chain or selector');
  if(edge.tokenInId!=null||edge.tokenOutId!=null)return {alternatives,issues:["state nomination for token-id settlement has no token-id balance witness"]};
  const cache=new Map<string,Promise<string>>();let transportFailure:{value:unknown}|undefined;
  for(const p of definition.programs){
    input.signal?.throwIfAborted();const key=programKeyOf(p);
    async function read(at:string,data?:string) {
      input.signal?.throwIfAborted();need(address.test(at)&&(data===undefined||calldata.test(data)&&data.length<=65538),'invalid required read');
      const k=data===undefined?at:at+":"+data;let out=cache.get(k);
      if(!out){out=(async()=>{try{
        const result=data===undefined?await input.readCode(at):await input.read(at,data);
        if(!validReturn(result))throw Error("invalid source-pinned read response");
        return result.toLowerCase();
      } catch(error){if(!isContractRevert(error))transportFailure={value:error};throw error;}})();cache.set(k,out);}
      const raw=await out;if(data===undefined)need(nonemptyCode(raw),'no deployed bytecode for this nomination');return raw;
    }
    try {
      const result=await issue(input,key,{read:(a,b)=>read(a,b),readCode:a=>read(a)});
      if(transportFailure)throw transportFailure.value;
      alternatives.push(result);
    }catch(e){input.signal?.throwIfAborted();if(transportFailure)throw transportFailure.value;
      issues.push(key+": "+(e instanceof Error?e.message:"Family did not issue the nominated direction"));}
  }
  if(!definition.programs.length)issues.push(definition.unsupportedReason??"no registered execution recipe");
  return {alternatives,issues};
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
