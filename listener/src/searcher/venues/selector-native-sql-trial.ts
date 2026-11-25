import {getAddress, ZeroAddress} from 'ethers';
import type {RuntimeAmountLeg} from '../../adapters/runtime-amount-program.js';
import {assertExecutionRounding,MAX_EXECUTION_ROUNDING_RAW_UNITS} from '../../shared/executor/amount-rounding.js';
import {applyRuntimeAssetBoundary} from '../execution-asset-boundary.js';
import {assertDeclarativeExecutionSource} from './declarative-execution.js';
import type {CanonicalSource} from './adapter-request-program.js';
import {selectorNativeFamilyId,type SelectorNativeExecutionDefinition,type SelectorNativeProgram} from './selector-native-definition.js';
import {createSelectorNativeRuntime,type SelectorNativeRuntime} from './selector-native-runtime.js';
import type {SqlLiveEdgeCoordinates} from './selector-native-sql-live-binding.js';
import {validateSqlExecutionParamHints,type SqlRecipeParamHints} from './selector-native-sql-param-hints.js';
import {contradictedCommittedRoute} from './selector-native-sql-param-guard.js';
import type {AllowedTaxonomy} from './route-leg-adapter.js';

type Data=Record<string,any>;
type Edge=SqlLiveEdgeCoordinates & {readonly executionParamEvidence?:unknown};
type Input={readonly definition:SelectorNativeExecutionDefinition;readonly edge:Edge;readonly source:CanonicalSource;
  readonly executor:string;readonly transactionOrigin:string;readonly executionRoundingRawUnits?:bigint};
export type SqlQuoteTrialLeg=Readonly<{kind:'sql-quote-trial';programKey:string;leg:RuntimeAmountLeg;
  tokenIn:string;tokenOut:string;poolNamespace:string|null;direction:string;taxonomy:Readonly<AllowedTaxonomy>}>;
export type SqlQuoteTrialResult={legs:readonly SqlQuoteTrialLeg[];issues:readonly string[];complete:boolean};
const addr=(v:string)=>getAddress(v).toLowerCase();
const own=(v:any,k:string)=>v!=null&&Object.hasOwn(v,k);
const dic=(v:any):v is Data=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const forbidden=new Set(['__proto__','constructor','prototype']);
class Missing extends Error {constructor(key:string){super('missing SQL execution parameter: '+key);}}
function need(ok:unknown,why:string):asserts ok{if(!ok)throw Error(why);}

// Accept ONLY the inverse of an authored, scalar lossless projection. Neither
// historical calldata nor historical getter output may be replayed as a read.
function origin(x:any):string[]|undefined{
  if(typeof x==='string'&&x.startsWith('$'))return x.slice(1).split('.');
  if(['address','lower','number','uint'].includes(x?.op)&&x.args?.length===1)return origin(x.args[0]);
  if((x?.op==='get'||x?.op==='at')&&x.args?.length===2&&/^[A-Za-z_0-9]+$/.test(String(x.args[1]))){
    const p=origin(x.args[0]);if(p)return [...p,String(x.args[1])];
  }
}
function members(x:any):Data|undefined {
  if(!dic(x))return;
  if(!own(x,'op'))return x;
  if(x.op==='merge'&&Array.isArray(x.args)&&x.args.every((a:any)=>dic(a)&&!own(a,'op')))return Object.assign(Object.create(null),...x.args);
}
function member(x:any,path:readonly string[]):any {
  for(const k of path){const m=members(x);if(!m||!own(m,k))return;x=m[k];}return x;
}
// A binding flow may explicitly allow an observed edge asset after one or
// more optional getter results. This supplies a *trial candidate*, not a
// claim about those getters. Never invert a token-normalizing conditional,
// treat an arbitrary missing read as a revert, or override a fixed value.
function optionalGetter(x:any,ids:Set<string>):boolean {
  if(x?.op==='if'&&x.args?.length===3&&x.args[2]===null)return optionalGetter(x.args[1],ids);
  if(['address','lower'].includes(x?.op)&&x.args?.length===1)return optionalGetter(x.args[0],ids);
  const data=x?.args?.[2],raw=data?.args?.[0];
  return x?.op==='decodeCanonical'&&data?.op==='get'&&data.args[1]==='data'&&raw?.op==='returned'&&ids.has(raw.args[0]);
}
function edgeAssetTerms(p:SelectorNativeProgram):ReadonlyMap<string,'tokenIn'|'tokenOut'>{
  const flow=p.binding?.flow as Data|undefined,ref=origin(flow?.result);
  const result=new Map<string,'tokenIn'|'tokenOut'>();
  if(ref?.length!==2||ref[0]!=='steps')return result;
  const step=flow?.steps?.find((s:Data)=>s.id===ref[1]),fields=members(step?.result);
  if(!fields||!Array.isArray(step.requests))return result;
  const ids=new Set<string>(step.requests.filter((r:Data)=>r.kind==='eth-call'&&r.required===false).map((r:Data)=>r.id));
  for(const [k,expr] of Object.entries(fields)){
    let x:any=expr;
    while(x?.op==='coalesce'&&x.args?.length===2){
      if(x.args[0]==='$scope.tokenIn'||x.args[0]==='$scope.tokenOut'){x=x.args[0];break;}
      if(!optionalGetter(x.args[0],ids))break;
      x=x.args[1];
    }
    if(x==='$scope.tokenIn'||x==='$scope.tokenOut')result.set(k,x==='$scope.tokenIn'?'tokenIn':'tokenOut');
  }
  return result;
}
const termCache=new WeakMap<SelectorNativeProgram,ReturnType<typeof edgeAssetTerms>>();
function candidateAssets(p:SelectorNativeProgram){
  if(!Object.isFrozen(p))return edgeAssetTerms(p);
  let terms=termCache.get(p);if(!terms){terms=edgeAssetTerms(p);termCache.set(p,terms);}return terms;
}
function store(root:Data,path:readonly string[],value:unknown){
  need(path.length>0&&path.every(k=>/^[A-Za-z0-9_]+$/.test(k)&&!forbidden.has(k)),'invalid binding path');
  for(const k of path.slice(0,-1)){if(!own(root,k))root[k]=Object.create(null);need(dic(root[k]),'conflicting binding shape');root=root[k];}
  const k=path.at(-1)!;need(!own(root,k)||root[k]===value,'conflicting historical binding values');root[k]=value;
}
// The declaration language treats absent paths as undefined. For a simulation
// candidate, unknown reads MUST NOT silently select the false/default arm.
function strictBinding(obj:Data,path:string):Data{
  const result=Object.create(null);for(const [k,v] of Object.entries(obj))result[k]=dic(v)?strictBinding(v,path+'.'+k):v;
  const check=(k:PropertyKey)=>{if(typeof k==='string'&&!own(result,k))throw new Missing(path+'.'+k);};
  return new Proxy(result,{get(t,k){check(k);return Reflect.get(t,k);},getOwnPropertyDescriptor(t,k){check(k);return Reflect.getOwnPropertyDescriptor(t,k);}});
}
function lazyFields(x:any,evalLeaf:(x:any)=>any):any{
  // A declared array exists even when its individual elements use reads. A
  // defined()/length check doesn't consume those values. Accessing an actual
  // element still evaluates the original expression (and can be unavailable).
  const m=Array.isArray(x)?x:members(x);if(!m)return evalLeaf(x);
  const fields=Array.isArray(x)?new Array(x.length):Object.create(null);for(const [k,ast] of Object.entries(m)){
    need(!forbidden.has(k),'invalid declaration field');
    let done=false,value:any;Object.defineProperty(fields,k,{enumerable:true,get(){if(!done){value=lazyFields(ast,evalLeaf);done=true;}return value;}});
  }return fields;
}
const runtimes=new WeakMap<SelectorNativeExecutionDefinition,WeakMap<SelectorNativeProgram,SelectorNativeRuntime>>();
function runtime(d:SelectorNativeExecutionDefinition,p:SelectorNativeProgram){
  // Production definitions are recursively frozen by the canonical loader.
  if(!Object.isFrozen(d)||!Object.isFrozen(p))return createSelectorNativeRuntime(d,p);
  let rs=runtimes.get(d);if(!rs){rs=new WeakMap();runtimes.set(d,rs);}
  let r=rs.get(p);if(!r){r=createSelectorNativeRuntime(d,p);rs.set(p,r);}return r;
}
function build(input:Input,p:SelectorNativeProgram,h:SqlRecipeParamHints):SqlQuoteTrialLeg {
  const {definition,edge,source}=input,r=runtime(definition,p),ex=addr(input.executor),target=addr(edge.poolAddress);
  need(p.execution&&p.binding&&!p.runtimeEvidence&&!p.binding.descriptorReads&&!p.routes?.resources?.length,
    'recipe requires additional execution inputs or composite resource');
  need(h.programKey===r.key,'recipe fingerprint differs');
  const shape=members(p.binding.descriptor);
  need(shape,'descriptor is not a statically addressable projection');
  const binding:Data=Object.create(null),argFields:Data=Object.create(null);
  for(const [key,o] of h.observed){
    if(!key.startsWith('descriptor.'))continue;
    const path=origin(member(shape,key.split('.').slice(1)));
    if(path?.[0]==='binding'&&path.length>1)store(binding,path.slice(1),o.value);
    if(o.kind==='argument'&&(path?.[0]==='args'||path?.[0]==='arguments')&&
      p.parameters?.some(v=>v.role==='bound'&&v.path.join('.')===path.slice(1).join('.')))store(argFields,path.slice(1),o.value);
  }
  for(const [key,side] of candidateAssets(p))if(!own(binding,key)&&edge[side]!==ZeroAddress)store(binding,[key],edge[side]);
  const scope={chainId:edge.chainId,target,tokenIn:edge.tokenIn,tokenOut:edge.tokenOut,...(edge.poolId!=null?{poolId:edge.poolId}:{}),...(edge.poolNamespace!=null?{poolNamespace:edge.poolNamespace}:{})};
  const args=strictBinding(argFields,'args');
  const seed={scope,target,args,arguments:args,source,executor:ex,transactionOrigin:addr(input.transactionOrigin),
    executionPolicy:{executionRoundingRawUnits:input.executionRoundingRawUnits??MAX_EXECUTION_ROUNDING_RAW_UNITS},binding:strictBinding(binding,'binding')};
  const candidateAst=p.binding.stateBinding?.candidate;
  const candidate=candidateAst?r.values.evaluate(candidateAst,seed):{target,scope};
  const ctx={...seed,candidate};
  const descriptor=lazyFields(shape,x=>r.resources.evaluate(x,ctx));
  // The ordinary Family completed descriptor inherits the call target from
  // the nomination scope unless its own declaration projects a target.
  if(!own(descriptor,'target'))descriptor.target=target;
  for(const [k,v] of Object.entries({executionPolicy:seed.executionPolicy,instanceKey:target,familyId:selectorNativeFamilyId(definition),lineageId:r.lineage})){
    need(!own(descriptor,k),'descriptor overrides a reserved runtime coordinate');descriptor[k]=v;
  }
  const env=r.environment({...ctx,descriptor}),value=(x:any)=>r.resources.evaluate(x,env);
  need(addr(env.target)===target&&target!==ZeroAddress&&ex!==target,'execution target differs from SQL resource');
  need(!definition.managerCustody||addr(definition.managerCustody.manager)===target,'manager differs from declaration');
  // Route-admission checks are not EVM instructions. Reject known conflicts.
  // Only a standalone assertion depending on an unobserved binding input may
  // be left for the real issuer; execution checks below have no such fallback.
  for(const c of p.routes?.checks??[]){
    need(dic(c)&&Object.keys(c).every(k=>k==='assert'||k==='error')&&own(c,'assert'),'stateful route checks require issued binding');
    try{r.resources.run([c],env);}catch(e){if(!(e instanceof Missing))throw e;}
  }
  need(Array.isArray(p.routes?.directions),'recipe has no static direction declaration');
  const matches=p.routes.directions.flatMap(d=>{
    if(p.routes?.allowedDirections&&!p.routes.allowedDirections.includes(d.id)||d.enabled!==undefined&&value(d.enabled)!==true)return [];
    const tokenIn=addr(value(d.tokenIn)),tokenOut=addr(value(d.tokenOut)),assets=d.executionAssets===undefined?undefined:value(d.executionAssets);
    const a=assets?.input==='native'?ZeroAddress:tokenIn,b=assets?.output==='native'?ZeroAddress:tokenOut;
    if(a!==edge.tokenIn||b!==edge.tokenOut||a===b)return [];
    return [{d,tokenIn,tokenOut,assets}];
  });
  need(matches.length===1,'missing or ambiguous SQL direction');
  const {d,tokenIn,tokenOut,assets}=matches[0]!,route=lazyFields(d.fields??{},value);
  // Reserved fields are filled by the Family projection, not historical data.
  for(const [k,v] of Object.entries({familyId:selectorNativeFamilyId(definition),lineageId:r.lineage,instanceKey:target,
    routeKey:d.id,direction:d.id,target,adapterId:r.actionId,tokenIn,tokenOut,taxonomy:d.taxonomy,
    ...(assets?{executionAssets:assets}:{})})){
    need(!own(route,k),'direction overrides reserved route field');route[k]=v;
  }
  const full=r.environment({...ctx,descriptor,route,runtimeEvidence:[]});
  r.resources.run(p.routes?.assertions??[],full);r.values.run(p.checks??[],full);
  const resource=p.routes?.resource?r.resources.evaluate(p.routes.resource,full):{target};
  need(addr(resource.target)===target&&(resource.poolId??null)===(edge.poolId??null),'projected pool differs from SQL edge');
  const ns=resource.poolNamespace??null;
  need(edge.poolNamespace==null||edge.poolNamespace===ns,'projected pool namespace differs');
  if(edge.poolId!=null)need(h.verifiedTuple.size>0&&typeof ns==='string'&&ns===p.binding.stateBinding?.poolNamespace,
    'missing committed execution tuple for logical pool');
  else need(ns===null,'unexpected logical resource namespace');
  r.assertExecutionEntry(full,r.execution(),target);
  const raw=r.buildRuntimeLeg({...ctx,descriptor,route,runtimeEvidence:[]});
  need(raw&&raw.actionAdapterId===r.actionId&&!raw.settlementRequest&&/^0x01(?:[a-f0-9]{2})+$/i.test(raw.program)&&raw.program.length<=131074,'unsupported trial runtime program');
  const leg=applyRuntimeAssetBoundary({route:{tokenIn,tokenOut,...(assets?{executionAssets:assets}:{})},executor:ex,leg:raw});
  return Object.freeze({kind:'sql-quote-trial',programKey:r.key,leg,tokenIn,tokenOut,poolNamespace:ns,direction:d.id,taxonomy:d.taxonomy});
}

/** Candidate simulation ONLY: no transport, identity receipt, prepared instance
 * or transaction authority. Amount comes from the existing effective prefix. */
export function compileSqlTrialLegs(input:Input):SqlQuoteTrialResult{
  const {edge,definition:d}=input;const legs:SqlQuoteTrialLeg[]=[],issues:string[]=[];let complete=true;
  try{
    assertDeclarativeExecutionSource(input.source);
    assertExecutionRounding(input.executionRoundingRawUnits??MAX_EXECUTION_ROUNDING_RAW_UNITS);
    need(addr(input.executor)!==ZeroAddress&&addr(input.transactionOrigin)!==ZeroAddress,'invalid trial actors');
    need(edge.chainId===1&&edge.selector===d.selector&&(!edge.familyIds||edge.familyIds.includes(selectorNativeFamilyId(d)))&&
      edge.tokenInId==null&&edge.tokenOutId==null&&!d.unsupportedReason,'unsupported SQL trial coordinates');
    const h=validateSqlExecutionParamHints({definition:d,edge,evidence:edge.executionParamEvidence});need(h,'no uniform SQL parameter evidence');
    for(const [i,p] of d.programs.entries()){
      const hr=h.recipes[i]!;if(contradictedCommittedRoute(p,hr.verifiedTuple))continue;
      try{legs.push(build(input,p,hr));}catch(e){complete=false;issues.push(hr.programKey+': '+(e instanceof Error?e.message:'unavailable'));}
    }
  }catch(e){return {legs:[],issues:[e instanceof Error?e.message:'invalid SQL trial parameters'],complete:false};}
  return {legs,issues,complete};
}
