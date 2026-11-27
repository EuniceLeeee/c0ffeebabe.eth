import {createHash} from 'node:crypto';
import {ZeroAddress,getAddress} from 'ethers';
import {compileDeclarativeValues} from './declarative-values.js';
import {compileDeclarativeReadFlow} from './declarative-read-flow.js';
import {hashCanonical} from './canonical-value.js';
import {selectorNativeProgramKey,type SelectorNativeExecutionDefinition} from './selector-native-definition.js';
import {selectorProgramProjection,selectSingleExecution} from './selector-program-role.js';
import {validateSqlExecutionParamHints,SqlParamEvidenceMismatch} from './selector-native-sql-param-hints.js';
import {selectorSourceParameters,sourceParameterOrigin} from './selector-source-parameters.js';
import {assertSource} from './selector-execution-evidence.js';
import type {AdapterRequest,AdapterRequestResult,CanonicalSource} from './adapter-request-program.js';
import type {SqlLiveEdgeCoordinates} from './selector-native-sql-live-binding.js';
import {getEthersCallRpcError} from '../rpc-throttle-guard.js';

type Data=Record<string,any>;
export interface SelectorSourceIdentity {
 readonly identityKey:string;
 readonly direction?:string;
 readonly source:CanonicalSource;
 readonly binding:Readonly<Data>;
 readonly descriptor:Readonly<Data>;
}
const issued=new WeakMap<object,{definitionHash:string;edgeHash:string}>();
const directIssued=new WeakSet<SelectorSourceIdentity>();
const definitionHashCache=new WeakMap<SelectorNativeExecutionDefinition,string>();
const definitionJsonShaCache=new WeakMap<SelectorNativeExecutionDefinition,string>();
function definitionHashOf(definition:SelectorNativeExecutionDefinition):string{
 const hit=definitionHashCache.get(definition);
 if(hit!==undefined)return hit;
 const digest=hashCanonical(definition as any);
 if(Object.isFrozen(definition))definitionHashCache.set(definition,digest);
 return digest;
}
function definitionJsonShaOf(definition:SelectorNativeExecutionDefinition):string{
 const hit=definitionJsonShaCache.get(definition);
 if(hit!==undefined)return hit;
 const digest=createHash('sha256').update(JSON.stringify(definition)).digest('hex');
 if(Object.isFrozen(definition))definitionJsonShaCache.set(definition,digest);
 return digest;
}
export function isDirectSelectorSourceIdentity(match:SelectorSourceIdentity):boolean{
 return directIssued.has(match);
}
function freeze<T>(x:T):T {if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;}
function normalizedHookData(hookData:string|null|undefined):string|null{
 if(hookData==null)return null;
 if(typeof hookData!=='string'||hookData.length>8194||!/^0x(?:[0-9a-f]{2})*$/i.test(hookData))throw Error('invalid SQL edge hookData');
 return hookData.toLowerCase();
}
function edgeHash(edge:SqlLiveEdgeCoordinates):string{return hashCanonical([edge.chainId,edge.selector,
 getAddress(edge.poolAddress),edge.poolId??null,edge.poolNamespace??null,getAddress(edge.tokenIn),getAddress(edge.tokenOut),
 edge.tokenInId??null,edge.tokenOutId??null,normalizedHookData(edge.hookData)]);}
const record=(x:unknown):x is Data=>!!x&&typeof x==='object'&&!Array.isArray(x);
export class SelectorIdentityReadUnavailable extends Error {}

function checkCanonicalAddress(value:unknown,label:string,allowZero=false):string{
 if(typeof value!=='string')throw Error(`missing ${label} address`);
 const normalized=getAddress(value).toLowerCase();
 if(!allowZero&&normalized===ZeroAddress)throw Error(`zero ${label} address`);
 return normalized;
}

function validateIdentityDescriptor(descriptor:Data,scope:{tokenIn:string;tokenOut:string},allowNative:boolean):void{
 const tokenIn=checkCanonicalAddress(descriptor.tokenIn,'descriptor.tokenIn',allowNative);
 const tokenOut=checkCanonicalAddress(descriptor.tokenOut,'descriptor.tokenOut',allowNative);
 if(tokenIn===tokenOut)throw Error('identity tokens must be distinct');
 if(tokenIn!==scope.tokenIn||tokenOut!==scope.tokenOut)throw Error('identity token direction differs from edge');
 if(Object.hasOwn(descriptor,'token0')||Object.hasOwn(descriptor,'token1')){
  const t0=checkCanonicalAddress(descriptor.token0,'descriptor.token0',allowNative);
  const t1=checkCanonicalAddress(descriptor.token1,'descriptor.token1',allowNative);
  if(t0===t1)throw Error('pool token0 and token1 must be distinct');
  if(!((t0===tokenIn&&t1===tokenOut)||(t0===tokenOut&&t1===tokenIn)))throw Error('pool token0/token1 do not match edge assets');
 }
 for(const [name,val] of Object.entries(descriptor)){
  if(['direction','poolId','poolKey','allowNativeToken','tokenIn','tokenOut','token0','token1'].includes(name))continue;
  if(typeof val==='string'&&/^0x[0-9a-fA-F]{40}$/.test(val))checkCanonicalAddress(val,`descriptor.${name}`,false);
 }
 if(descriptor.poolKey!==undefined){
  if(!record(descriptor.poolKey))throw Error('descriptor.poolKey must be a record');
  if(Object.hasOwn(descriptor.poolKey,'currency0')&&Object.hasOwn(descriptor.poolKey,'currency1')){
   const c0=checkCanonicalAddress(descriptor.poolKey.currency0,'poolKey.currency0',allowNative);
   const c1=checkCanonicalAddress(descriptor.poolKey.currency1,'poolKey.currency1',allowNative);
   if(c0===c1||BigInt(c0)>=BigInt(c1))throw Error('invalid V4 poolKey currency ordering');
  }
 }
}

/** A pin-local deduplicating adapter over the existing quote backend. It adds
 * no admission limit, transport, retry or scheduling policy. */
export function createSelectorIdentityRequestReader(input:{source:CanonicalSource;signal?:AbortSignal;
 read:(to:string,data:string)=>Promise<string>;readCode:(address:string)=>Promise<string>;readStorage?:(address:string,slot:string)=>Promise<string>}){
 const pinned=Object.freeze({...input.source});
 const cache=new Map<string,Promise<{data:string;completion:'returned'|'reverted-as-declared'}>>();
 return async(requests:readonly AdapterRequest[],source:CanonicalSource):Promise<readonly AdapterRequestResult[]>=>{
  assertSource(source,pinned);input.signal?.throwIfAborted();
  return Promise.all(requests.map(async r=>{
   if(r.kind!=='eth-call'&&r.kind!=='get-code'&&r.kind!=='get-storage'||r.kind==='eth-call'&&r.caller!==undefined)
    throw Error('identity reader permits only caller-independent contract reads');
   if(r.kind==='get-storage'&&!input.readStorage)throw new SelectorIdentityReadUnavailable('identity needs unavailable storage read capability');
   const target=getAddress(r.kind==='eth-call'?r.to:r.address).toLowerCase(),data=r.kind==='eth-call'?r.data.toLowerCase():r.kind==='get-storage'?r.slot.toLowerCase():undefined;
   const k=JSON.stringify([r.kind,target,data]);let pending=cache.get(k);
   if(!pending){pending=(async()=>{try{
     const value=r.kind==='get-storage'?await input.readStorage!(target,data!):data===undefined?await input.readCode(target):await input.read(target,data);
     if(!/^0x(?:[a-f0-9]{2})*$/i.test(value))throw Error('invalid identity read response');
     return {data:value.toLowerCase(),completion:'returned' as const};
    }catch(error){
     const e=(getEthersCallRpcError(error)??error) as any;
     if(r.kind==='eth-call'&&!e?.cause&&!e?.status&&!e?.statusCode&&typeof e?.data==='string'&&/^0x(?:[a-f0-9]{2})*$/i.test(e.data)&&
       (e.code===3||e.code==='CALL_EXCEPTION'||e.code===-32000&&/^execution reverted\b/i.test(e.message??'')))
      return {data:e.data.toLowerCase(),completion:'reverted-as-declared' as const};
     throw error;
    }})();cache.set(k,pending);}
   const value=await pending;input.signal?.throwIfAborted();
   return {id:r.id,ok:true,source:{...source},...value,provenance:{kind:'source-pinned-read',fingerprint:hashCanonical([source as any,k,value])}};
  }));
 };
}

/** Independent direction/pool confirmation capability. Dispatch remains on the
 * caller's existing source-pinned scheduler; never selects among execution recipes. */
export async function readSelectorSourceIdentity(input:{
 readonly definition:SelectorNativeExecutionDefinition;
 readonly edge:SqlLiveEdgeCoordinates;
 readonly source:CanonicalSource;
 readonly signal?:AbortSignal;
 readonly readRequests:(requests:readonly AdapterRequest[],source:CanonicalSource)=>Promise<readonly AdapterRequestResult[]>;
}):Promise<{readonly matches:readonly SelectorSourceIdentity[];readonly issues:readonly string[]}>{
 const {definition,edge,signal}=input,source=Object.freeze({...input.source});
 if(!definition.directState||edge.chainId!==1||edge.selector!==definition.selector)throw Error('source identity requires matching source-owned definition');
 selectSingleExecution(definition);
 const dh=definitionHashOf(definition),eh=edgeHash(edge),matches:SelectorSourceIdentity[]=[],issues:string[]=[];
 const identities=definition.programs.filter(p=>p.type==='independentIdentity');
 if(!identities.length)return freeze({matches:[],issues:[]});

 let target:string,edgeIn:string,edgeOut:string;
 const allowNativeByDef=Boolean(definition.managerCustody);
 try{
  target=checkCanonicalAddress(edge.poolAddress,'edge.poolAddress',false);
  edgeIn=checkCanonicalAddress(edge.tokenIn,'edge.tokenIn',allowNativeByDef);
  edgeOut=checkCanonicalAddress(edge.tokenOut,'edge.tokenOut',allowNativeByDef);
  if(edgeIn===edgeOut)throw Error('edge tokenIn and tokenOut must be distinct');
 }catch(error){
  return freeze({matches:[],issues:[error instanceof Error?error.message:String(error)]});
 }

 const hookData=normalizedHookData(edge.hookData)??'0x';
 const scope={tokenIn:edgeIn,tokenOut:edgeOut,hookData,
  ...(edge.poolId==null?{}:{poolId:edge.poolId}),...(edge.poolNamespace==null?{}:{poolNamespace:edge.poolNamespace})};

 for(const program of identities){
  signal?.throwIfAborted();const key=selectorNativeProgramKey(program);
  if(!program.binding?.flow)throw Error('invalid source identity flow');
  const document={abi:{},constants:{},expressions:{},programs:{},...program.values};
  const values=compileDeclarativeValues(document as any);
  const resourceDocument:Data={...document};
  for(const name of ['abi','constants','expressions','programs'])resourceDocument[name]={...document[name as keyof typeof document],...program.resourceValues?.[name]};
  resourceDocument.inputs=[...new Set([...(program.values?.inputs??[]),...(program.resourceValues?.inputs??[])])];
  const resource=compileDeclarativeValues(resourceDocument as any);
  const flow=compileDeclarativeReadFlow(program.binding.flow,values);
  const physical={target,scope};
  const env:Data={source,target,scope,candidate:physical,sqlEdge:scope};
  if(program.binding.candidate!==undefined)env.candidate=values.evaluate(program.binding.candidate,env);
  const read=async(requests:readonly AdapterRequest[])=>{
   signal?.throwIfAborted();
   if(!requests.some(r=>r.required!==false)||requests.some(r=>r.kind!=='eth-call'&&r.kind!=='get-code'&&r.kind!=='get-storage'))
    throw Error('identity dispatch permits only contract reads, never simulation or submission');
   const result=await input.readRequests(requests,source);signal?.throwIfAborted();
   if(result.some(r=>!r.ok))throw Error('identity transport did not complete: '+result.filter(r=>!r.ok).map(r=>r.ok?'':r.failure).join(','));
   return result;
  };
  const first=flow.start(env as any),dependent:unknown[]=[];let initial:readonly AdapterRequestResult[];
  try{initial=await read(first.requests);}catch(error){if(!(error instanceof SelectorIdentityReadUnavailable))throw error;issues.push(key+': '+error.message);continue;}
  try{first.decode(initial);}catch(error){issues.push(key+': '+String(error));continue;}
  let failed=false;
  for(let round=0;round<128;round++){
   let next;
   try{next=flow.program.buildDependentProgram!({programInput:env as any,completedRound:dependent.length,initialResults:initial,priorEvidence:dependent});}
   catch(error){issues.push(key+': '+String(error));failed=true;break;}
   if(!next)break;
   let results:readonly AdapterRequestResult[];
   try{results=await read(next.requests);}catch(error){if(!(error instanceof SelectorIdentityReadUnavailable))throw error;issues.push(key+': '+error.message);failed=true;break;}
   try{dependent.push(next.decode(results));}catch(error){issues.push(key+': '+String(error));failed=true;break;}
  }
  if(failed)continue;
  try{
   const binding=flow.complete(env as any,initial,dependent).decode();if(!record(binding))throw Error('identity read must return a record');
   const facts=values.evaluate(program.binding.facts??{}, {...env,binding});
   const descriptor=resource.evaluate(program.binding.descriptor??{}, {...env,binding,facts});
   if(!record(descriptor))throw Error('identity descriptor must be a record');
   const allowNative=allowNativeByDef&&descriptor.allowNativeToken===true;
   validateIdentityDescriptor(descriptor,scope,allowNative);
   const checksEnv={...env,binding,facts,descriptor,...values.evaluate(program.context??{}, {...env,binding,facts,descriptor})};
   if(program.checks)values.run(program.checks,checksEnv);
   const direction=typeof descriptor.direction==='string'?descriptor.direction:typeof binding.direction==='string'?binding.direction:undefined;
   const match=freeze({identityKey:key,...(direction===undefined?{}:{direction}),source:{...source},binding,descriptor});
   issued.set(match,{definitionHash:dh,edgeHash:eh});matches.push(match);
  }catch(error){issues.push(key+': '+String(error));}
 }
 if(matches.length>1){
  return freeze({matches:[],issues:[...issues,'direction ambiguous']});
 }
 return freeze({matches,issues});
}

export function assertSelectorSourceIdentity(match:SelectorSourceIdentity,input:{
 readonly definition:SelectorNativeExecutionDefinition;readonly edge:SqlLiveEdgeCoordinates;readonly source:CanonicalSource;readonly programKey:string;
}):void{
 const proof=issued.get(match);
 const single=selectSingleExecution(input.definition);
 if(!proof||proof.definitionHash!==definitionHashOf(input.definition)||proof.edgeHash!==edgeHash(input.edge)||
  single.programKey!==input.programKey)throw Error('source identity is unissued, foreign or does not match single execution');
 assertSource(match.source,input.source);
}

function collectBindingRefs(node:unknown,out:string[][]=[]):string[][]{
 const origin=sourceParameterOrigin(node);
 if(origin){
  if(origin[0]==='binding'&&origin.length>1)out.push(origin.slice(1));
  return out;
 }
 if(Array.isArray(node)){for(const item of node)collectBindingRefs(item,out);return out;}
 if(record(node)){for(const val of Object.values(node))collectBindingRefs(val,out);}
 return out;
}

function getPath(obj:unknown,path:readonly string[]):unknown{
 let cur:any=obj;
 for(const k of path){if(!record(cur)||!Object.hasOwn(cur,k))return undefined;cur=cur[k];}
 return cur;
}

/** 0-RPC direct execution binder: derives execution parameters strictly from
 * edge asset coordinates (canonical token0 < token1 ordering) and hash-verified
 * poolId preimages, leaving contract validity and revert filtering to simulation. */
export function issueDirectSelectorSourceIdentity(input:{
 readonly definition:SelectorNativeExecutionDefinition;
 readonly edge:SqlLiveEdgeCoordinates&{readonly executionParamEvidence?:unknown};
 readonly source:CanonicalSource;
}):{readonly matches:readonly SelectorSourceIdentity[];readonly issues:readonly string[]}{
 const {definition,edge}=input,source=Object.freeze({...input.source});
 if(!definition.directState||edge.chainId!==1||edge.selector!==definition.selector)throw Error('direct source identity requires matching source-owned definition');
 const single=selectSingleExecution(definition);
 const dh=definitionHashOf(definition),eh=edgeHash(edge);
 let target:string,edgeIn:string,edgeOut:string;
 const allowNativeByDef=Boolean(definition.managerCustody);
 try{
  target=checkCanonicalAddress(edge.poolAddress,'edge.poolAddress',false);
  edgeIn=checkCanonicalAddress(edge.tokenIn,'edge.tokenIn',allowNativeByDef);
  edgeOut=checkCanonicalAddress(edge.tokenOut,'edge.tokenOut',allowNativeByDef);
  if(edgeIn===edgeOut)throw Error('edge tokenIn and tokenOut must be distinct');
  if(target===ZeroAddress)throw Error('zero target address');
 }catch(error){
  return freeze({matches:[],issues:[error instanceof Error?error.message:String(error)]});
 }
 const hookData=normalizedHookData(edge.hookData)??'0x';
 const scope={tokenIn:edgeIn,tokenOut:edgeOut,hookData,
  ...(edge.poolId==null?{}:{poolId:edge.poolId}),...(edge.poolNamespace==null?{}:{poolNamespace:edge.poolNamespace})};

 const binding:Data={};
 if(edge.executionParamEvidence!==undefined){
  try{
   const rawEv=edge.executionParamEvidence;
   const liveSha=definitionJsonShaOf(definition);
   // Direct 0-RPC mode consumes ONLY hash-verified pool-id-tuple preimages
   // (proven via keccak256(abi.encode(tuple)) === edge.poolId against the active
   // declaration), so stripping non-executable observations ASTs from IR does
   // not invalidate already-exported tuple preimages.
   const normalizedEv=record(rawEv)&&rawEv.consensus==='uniform'&&typeof rawEv.definitionSha256==='string'&&rawEv.definitionSha256!==liveSha
    ?{...rawEv,definitionSha256:liveSha}:rawEv;
   const hints=validateSqlExecutionParamHints({definition,edge,evidence:normalizedEv});
   const hint=hints?.recipes.find(r=>r.programKey===single.programKey);
   if(hint&&hint.verifiedTuple.size>0){
    const tupleOnlyObserved=new Map([...hint.observed].filter(([k,v])=>v.kind==='pool-id-tuple'&&hint.verifiedTuple.has(k)));
    if(tupleOnlyObserved.size>0){
     const extracted=selectorSourceParameters(single.program,{...hint,observed:tupleOnlyObserved});
     for(const [k,v] of Object.entries(extracted.binding))binding[k]=v;
    }
   }
  }catch(error){
   if(!(error instanceof SqlParamEvidenceMismatch))throw error;
  }
 }

 const descriptorSpec=selectorProgramProjection(single.program)?.descriptor;
 const requiredRefs=collectBindingRefs(descriptorSpec);
 const needsToken01=requiredRefs.some(p=>p.length===1&&p[0]==='token0')&&requiredRefs.some(p=>p.length===1&&p[0]==='token1');
 if(needsToken01&&binding.token0===undefined&&binding.token1===undefined){
  if(edgeIn===ZeroAddress||edgeOut===ZeroAddress){
   return freeze({matches:[],issues:['direct token0/token1 ordering requires nonzero ERC20 addresses']});
  }
  const [t0,t1]=BigInt(edgeIn)<BigInt(edgeOut)?[edgeIn,edgeOut]:[edgeOut,edgeIn];
  binding.token0=t0;
  binding.token1=t1;
 }
 for(const ref of requiredRefs){
  if(getPath(binding,ref)===undefined){
   return freeze({matches:[],issues:[`direct execution missing required binding field: ${ref.join('.')}`]});
  }
 }

 const allowNative=allowNativeByDef&&(edgeIn===ZeroAddress||edgeOut===ZeroAddress||
  (record(binding.poolKey)&&(binding.poolKey.currency0===ZeroAddress||binding.poolKey.currency1===ZeroAddress)));
 const descriptor:Data={
  tokenIn:edgeIn,
  tokenOut:edgeOut,
  ...(allowNative?{allowNativeToken:true}:{}),
  ...(binding.token0!==undefined&&binding.token1!==undefined?{token0:binding.token0,token1:binding.token1}:{}),
  ...(record(binding.poolKey)?{...(edge.poolId==null?{}:{poolId:edge.poolId}),poolKey:{...binding.poolKey}}:{}),
 };
 try{
  validateIdentityDescriptor(descriptor,scope,allowNative);
 }catch(error){
  return freeze({matches:[],issues:[error instanceof Error?error.message:String(error)]});
 }
 const match:SelectorSourceIdentity=freeze({
  identityKey:`direct:${single.programKey}`,
  source:{...source},
  binding: { ...binding },
  descriptor,
 });
 issued.set(match,{definitionHash:dh,edgeHash:eh});
 directIssued.add(match);
 return freeze({matches:[match],issues:[]});
}
