import { FunctionFragment, ZeroAddress, id } from "ethers";
import type { FamilyPricingPool, MutationPricingEntry, MutationSemantics } from "./adapter-family-plugin.js";
import type { SelectorNativeProgram } from "./selector-native-definition.js";
import { selectorProgramProjection } from "./selector-program-role.js";
import { selectorExecutionResourceKey } from "./selector-execution-keys.js";
import type { DeclarativeEventLog } from "./declarative-event-codec.js";
import type {SelectorPaidRankProfile} from "./selector-native/paid-ranking-contract.js";

type Data=Record<string,any>;
const NO_POOLS:readonly FamilyPricingPool[]=Object.freeze([]);
/** Called only after invocation() has checked the issued route and descriptor. A
 * resource defaulting to an execution target is not a declared physical venue. */
export function selectorNativePricingPools(p:SelectorNativeProgram,route:Data,inner:Data):readonly FamilyPricingPool[]{
  const complete=route.resources!==undefined;
  if(!p.routes)return NO_POOLS;
  if(!complete&&!p.routes.resource){
    const venue=inner.venue;
    if(!venue||(venue.kind==="address-pool"?venue.pool?.toLowerCase()!==route.resource.target||route.resource.poolId!==undefined:
      venue.kind==="manager-pool-id"?venue.manager?.toLowerCase()!==route.resource.target||venue.poolId!==route.resource.poolId:true))return NO_POOLS;
  }
  if(complete!==Boolean(p.routes.resources))throw Error("physical resource declaration differs from bound route");
  const resources:Data[]=complete?route.resources:[route.resource],keys:string[]=complete?route.resourceKeys:[route.resourceKey];
  if(!Array.isArray(resources)||!Array.isArray(keys)||resources.length!==keys.length)throw Error("incomplete bound physical resources");
  return Object.freeze(resources.map((r,i)=>{
    if(selectorExecutionResourceKey(r as Parameters<typeof selectorExecutionResourceKey>[0])!==keys[i])throw Error("bound physical resource key changed");
    return Object.freeze({poolAddress:r.target,resourceKey:keys[i]!,...(r.poolId===undefined?{}:{poolId:r.poolId}),
      ...(r.poolNamespace===undefined?{}:{poolNamespace:r.poolNamespace})});
  }));
}
const transfer=id("Transfer(address,address,uint256)");
function ordinaryTransfer(log:DeclarativeEventLog):string[]|undefined{
  if(log.topics.length!==3||log.topics[0]?.toLowerCase()!==transfer||!/^0x[\da-f]{64}$/i.test(log.data)||
    !log.topics.slice(1).every(t=>/^0x0{24}[\da-f]{40}$/i.test(t)))return;
  const [a,b]=log.topics.slice(1).map(t=>"0x"+t.slice(-40).toLowerCase());
  if(!a||!b||a===b||a===ZeroAddress||b===ZeroAddress)return;
  return [a,b];
}
function ref(x:any):string|undefined{
  if(typeof x==="string")return x;
  if(["lower","address"].includes(x?.op))return ref(x.args[0]);
  if(x?.op==="get"&&typeof x.args[1]==="string"){const a=ref(x.args[0]);return a&&a+"."+x.args[1];}
  return undefined;
}
function addresses(x:any,out:Set<string>):void{
  if(typeof x==="string"&&/^0x[\da-f]{40}$/i.test(x))out.add(x.toLowerCase());
  else if(x&&typeof x==="object")Object.values(x).forEach(v=>addresses(v,out));
}
function pairExecutionTargets(x:any,tokens:readonly string[],physical:string):boolean{
  if(!x||typeof x!=="object")return true;
  if(x.call){
    const target=ref(x.call.target);
    if(target===undefined)return false;
    if(tokens.includes(target)){
      try{if(FunctionFragment.from(x.call.signature).format("sighash")!=="transfer(address,uint256)")return false;}
      catch{return false;}
    }else if(target!==physical&&target!=="$target")return false;
  }
  return Object.values(x).every(v=>pairExecutionTargets(v,tokens,physical));
}
function independentlyMentions(value:any,address:string,skip:ReadonlySet<string>,prefix="$descriptor"):boolean{
  if(skip.has(prefix))return false;
  if(typeof value==="string")return value.toLowerCase()===address;
  return !!value&&typeof value==="object"&&Object.entries(value).some(([k,v])=>independentlyMentions(v,address,skip,prefix+"."+k));
}
function knownTuple(program:SelectorNativeProgram,desc:Data,assetSet:ReadonlySet<string>,guardPath:string,owner:string):boolean{
  return program.execution?.steps?.some((s:Data)=>ref(s.frame?.call?.target)===owner&&s.frame?.callback?.steps?.some((child:Data)=>{
    const call=child.call;if(!call||ref(call.target)!==owner)return false;
    try{return FunctionFragment.from(call.signature).inputs.some((abi,i)=>{
      if(abi.baseType!=="tuple"||!abi.components||typeof call.args?.[i]!=="object")return false;
      const ad=abi.components.filter(param=>param.type==="address");
      return ad.length===3&&ad.some(a=>ref(call.args[i][a.name])===guardPath)&&ad.every(a=>{
        const path=ref(call.args[i][a.name]);if(!path?.startsWith("$descriptor."))return false;
        const value=path.split(".").slice(1).reduce((v,k)=>v?.[k],desc as any);
        return typeof value==="string"&&(value===ZeroAddress||assetSet.has(value.toLowerCase()));
      });
    });}catch{return false;}
  }))??false;
}
export interface SelectorMutationRole {
  readonly currencyOnly:Set<string>;
  readonly holders:Set<string>;
  readonly logical?:{manager:string;poolId:string;scopes:MutationLogScopes};
}
type MutationLogScopes=((log:DeclarativeEventLog)=>readonly string[]|null)&{readonly settlementBalanceOnly?:(owner:string)=>boolean};
/** Lose optimization, not correctness, when provenance cannot distinguish an
 * asset from a hook, oracle, permission, extra read, or a second physical role. */
export function selectorNativeMutationRole(input:{program:SelectorNativeProgram;instance:Data;routes:readonly Data[];
  pools:readonly (readonly FamilyPricingPool[])[];scopes:MutationLogScopes}):SelectorMutationRole{
  const {program:p,instance,routes,pools}=input,currencyOnly=new Set<string>(),holders=new Set<string>(),base={currencyOnly,holders};
  if(pools.some(ps=>!ps.length)||!routes.length)return base;
  for(const pp of pools)for(const x of pp)holders.add(x.poolAddress.toLowerCase());
  // An alternate nomination that only renames these two physical coordinates
  // adds no state/address dependency. Do NOT infer this for an authority
  // read, a computed candidate, or another namespace; those stay broad.
  const proj=selectorProgramProjection(p);
  const sb=proj?.stateBinding,vars=sb?.candidate&&typeof sb.candidate==="object"&&!Array.isArray(sb.candidate)
    ?Object.values(sb.candidate):[];
  const coordinateOnly=!!sb?.poolNamespace&&sb.authority===undefined&&pools.every(ps=>ps.every(x=>x.poolId&&x.poolNamespace===sb.poolNamespace))&&
    vars.length===2&&vars.includes("$target")&&vars.includes("$scope.poolId");
  if(p.dependencies!==undefined||p.state||p.context||p.runtimeEvidence||p.ethCall||proj?.descriptorReads||sb&&!coordinateOnly||
    p.receiptChecks||proj?.subject||proj?.match||p.refreshPolicy!=="on-touch")return base;
  const bound=instance.bound,desc=bound.descriptor,steps=p.binding?.flow?.steps,sourceTemplate=p.type==="execution";
  if(!sourceTemplate&&(!Array.isArray(steps)||!steps.length||!steps.every((s:Data)=>Array.isArray(s.requests)&&s.requests.length&&!s.when)))return base;
  const ps=pools.flat(),pool=ps[0]!;
  if(!ps.every(x=>x.resourceKey===pool.resourceKey)&&pool.poolId!==undefined)return base;
  if(pool.poolId!==undefined){
    const expectedNs=sourceTemplate?sb?.poolNamespace:p.binding?.nomination?.poolNamespace;
    if(!ps.every(x=>x.poolId===pool.poolId&&x.poolAddress===pool.poolAddress&&x.poolNamespace===pool.poolNamespace)||
      !(p.routes?.venue as Data|undefined)?.manager||!expectedNs||pool.poolNamespace!==expectedNs||
      (!sourceTemplate&&!steps!.every((s:Data)=>s.requests.every((r:Data)=>
        r.kind==="eth-call"&&typeof ref(r.to)==="string"&&/^0x[\da-f]{40}$/i.test(ref(r.to)!)&&ref(r.to)!.toLowerCase()!==pool.poolAddress.toLowerCase()))))return base;
    const owner=ref((p.routes?.venue as Data).manager),assets=new Set(routes.flatMap(r=>[r.tokenIn.toLowerCase(),r.tokenOut.toLowerCase()]));
    if(!owner||independentlyMentions(desc,pool.poolAddress.toLowerCase(),new Set([owner,"$descriptor.target","$descriptor.instanceKey"])))return base;
    const staticKeyGuard=(p.routes?.checks as Data[]|undefined)?.some(c=>c.when===undefined&&c.assert?.op==="sameAddress"&&c.assert.args.includes(ZeroAddress)&&
      c.assert.args.some((x:any)=>{const path=ref(x);if(!path?.startsWith("$descriptor."))return false;
        const fields=path.split(".").slice(1);if(fields.length!==2||!knownTuple(p,desc,assets,path,owner))return false;
        return desc[fields[0]!]?.[fields[1]!]===ZeroAddress;}));
    const hookFreeTemplate=sourceTemplate&&desc.poolKey?.hooks===ZeroAddress&&(desc.hookData===undefined||desc.hookData==="0x")&&
      knownTuple(p,desc,assets,"$descriptor.poolKey.hooks",owner);
    return (staticKeyGuard||hookFreeTemplate)?{...base,logical:{manager:pool.poolAddress.toLowerCase(),poolId:pool.poolId,scopes:input.scopes}}:base;
  }
  if((p.routes?.venue as Data|undefined)?.kind!=="address-pool"||pool.poolAddress!==instance.target||
    !ps.every(x=>x.poolId===undefined&&x.poolAddress===pool.poolAddress)||
    (!sourceTemplate&&(steps!.length!==1||!steps![0].requests.every((r:Data)=>r.kind==="eth-call"&&ref(r.to)==="$target"))))return base;
  // Prove *directly bound* currencies. A derived graph alias (e.g. wrapped
  // native), a multi-resource route, a two-step token-code/fee model, or an
  // address appearing elsewhere in the descriptor is not mere currency.
  const ds=p.routes?.directions as Data[]|undefined;if(!Array.isArray(ds)||ds.length!==2)return base;
  const inField=ref(ds[0]?.tokenIn),outField=ref(ds[0]?.tokenOut);
  if(!inField||!outField||inField===outField||![inField,outField].every(s=>/^\$descriptor\.\w+$/.test(s))||
    ref(ds[1]?.tokenIn)!==outField||ref(ds[1]?.tokenOut)!==inField||ds.some(d=>d.executionAssets))return base;
  const venueField=ref((p.routes!.venue as Data).pool);
  if(!venueField||!p.execution||p.quoteOutput||p.payment||p.execution.approval||!pairExecutionTargets(p.execution,[inField,outField],venueField))return base;
  const others=new Set<string>();addresses(bound.dependencies,others);addresses(p.values?.constants,others);addresses(p.execution,others);
  for(const [name,value] of Object.entries(desc)){
    if([inField,outField].includes("$descriptor."+name))continue;
    if((name==="tokenIn"||name==="tokenOut")&&typeof value==="string"&&instance.candidate?.scope?.[name]?.toLowerCase()===value.toLowerCase())continue;
    addresses(value,others);
  }
  for(const field of [inField,outField]){const asset=desc[field.slice("$descriptor.".length)];
    if(typeof asset==="string"&&!others.has(asset.toLowerCase())&&routes.some(r=>[r.tokenIn.toLowerCase(),r.tokenOut.toLowerCase()].includes(asset.toLowerCase())))
      currencyOnly.add(asset.toLowerCase());}
  return base;
}
type Entry=MutationPricingEntry<Data,Data>;
/** Narrow only this Family's legacy learned-address catch-all; never filter
 * another Family's mutation output, passive writes, or each-block policy. */
export function scopeSelectorNativeMutation(base:MutationSemantics<Data,Data>,role:(e:Entry)=>SelectorMutationRole,
  dependencies:(e:{descriptor:Data;routes:readonly Data[]})=>readonly string[],
  paidProfile?:(entry:Entry,physical:SelectorMutationRole)=>{profile:SelectorPaidRankProfile|undefined}|undefined):MutationSemantics<Data,Data>{
  function keep(r:SelectorMutationRole,log:DeclarativeEventLog,endpoints:string[]|undefined,scopes:Map<Function,readonly string[]|null>){
    const a=log.address.toLowerCase(),logical=r.logical;
    if(logical?.manager===a){
      if(!scopes.has(logical.scopes))scopes.set(logical.scopes,logical.scopes(log));
      const ids=scopes.get(logical.scopes);if(ids)return ids.includes(logical.poolId);
    }
    if(logical&&a!==logical.manager&&endpoints?.includes(logical.manager)&&logical.scopes.settlementBalanceOnly?.(logical.manager))return false;
    return !(endpoints&&r.currencyOnly.has(a)&&!endpoints.some(v=>r.holders.has(v)));
  }
  return {
    historicalRankTriggers(entry){
      const r=role(entry);
      const selected=paidProfile?.(entry,r);
      if(selected)return selected.profile;
      // Only a positively bound, standalone, on-touch conversion whose
      // declared model distinguishes some pure asset identities. Hooked,
      // pooled-manager, explicit external, special and unknown shapes stay strict.
      if(!r.currencyOnly.size||!r.holders.size||r.logical)return;
      const deps=new Set(entry.dependencies.map(a=>a.toLowerCase()));
      const assets=[...r.currencyOnly].filter(a=>deps.has(a)&&a!==ZeroAddress);
      if(!assets.length||![...r.holders].every(a=>deps.has(a)))return;
      // For this proven two-ERC20 shape zero is a constant execution sentinel,
      // neither a native asset nor a named economic dependency (the latter
      // would already have declined the entire role). Never alias ETH to WETH.
      const economic=[...deps].filter(a=>a!==ZeroAddress&&!assets.includes(a));
      return {economic,assets,constantIdentifiers:deps.has(ZeroAddress)?[ZeroAddress]:[]};
    },
    compile({entries}){
      const compiled=base.compile!({entries}),byKey=new Map<string,SelectorMutationRole[]>();
      for(const e of entries){const rs=byKey.get(e.stateKey)??[];rs.push(role(e));byKey.set(e.stateKey,rs);}
      return {dependencies:compiled.dependencies,affectedStateKeys(input){
        const found=compiled.affectedStateKeys(input),log=input.observation;if(log.kind!=="log"||!found.length)return found;
        const ep=ordinaryTransfer(log),scopes=new Map<Function,readonly string[]|null>();
        return found.filter(k=>byKey.get(k)?.some(r=>keep(r,log,ep,scopes))??true);
      }};
    },
    affectedStateKeys(input){
      const found=base.affectedStateKeys(input),log=input.observation;if(log.kind!=="log"||!found.length)return found;
      const r=role({...input,dependencies:dependencies(input),stateKey:found[0]!});
      return keep(r,log,ordinaryTransfer(log),new Map())?found:[];
    }
  };
}
