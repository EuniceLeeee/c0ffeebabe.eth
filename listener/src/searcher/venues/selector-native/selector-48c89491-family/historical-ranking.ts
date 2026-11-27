import {AbiCoder,keccak256,ZeroAddress} from "ethers";
import {selectorNativeProgramKey,type SelectorNativeProgram} from "../../selector-native-definition.js";
import {selectorObservedTargetCode} from "../../selector-native-discovery.js";
import type {SelectorPaidRankRole} from "../paid-ranking-contract.js";

type Data=Readonly<Record<string,any>>;
// Version seal on the reviewed V4 single execution template's executable semantics.
const programSeal="parameters:8defdf4b470b50849e9d70578b0a96b93e8678864897d7700023ebe9b243934e";
const bankRuntime="0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293";
const wrapped="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const sealCache=new WeakMap<SelectorNativeProgram,boolean>();
function immutable(x:unknown):boolean{return !x||typeof x!=="object"||Object.isFrozen(x)&&Object.values(x).every(immutable);}
function reviewed(p:SelectorNativeProgram){
  const cached=sealCache.get(p);if(cached!==undefined)return cached;
  const ok=selectorNativeProgramKey(p)===programSeal;if(immutable(p))sealCache.set(p,ok);return ok;
}
/** Optional ranking role only for hook-free pools (hooks == 0x0 and empty hookData). */
export function hookFreeManagedRank(p:SelectorNativeProgram,instance:Data,routes:readonly Data[],
 manager:string,poolId:string):readonly string[]|undefined{
  if(!reviewed(p)||instance.programKey!==programSeal||p.refreshPolicy!=="on-touch"||
    instance.candidate?.scope?.poolId!==poolId||instance.target?.toLowerCase()!==manager)return;
  const d=instance.bound?.descriptor,k=d?.poolKey;if(!k||d.poolId!==poolId||(d.hookData!==undefined&&d.hookData!=="0x")||
    d.managerBinding?.manager!==manager||k.hooks!==ZeroAddress||!Number.isSafeInteger(k.fee)||k.fee<0||k.fee>1000000||
    !Number.isSafeInteger(k.tickSpacing)||k.tickSpacing<=0||k.tickSpacing>32767)return;
  const currencies=[k.currency0,k.currency1];
  if(!Array.isArray(instance.bound.dependencies)||instance.bound.dependencies.some((a:unknown)=>
    typeof a!=="string"||currencies.includes(a.toLowerCase())))return;
  if(!currencies.every(c=>typeof c==="string"&&/^0x[0-9a-f]{40}$/.test(c)&&c!==manager)||
    k.currency0>=k.currency1||
    keccak256(AbiCoder.defaultAbiCoder().encode(["address","address","uint24","int24","address"],
      [...currencies,k.fee,k.tickSpacing,k.hooks]))!==poolId)return;
  if(k.currency0===ZeroAddress){
    const source=instance.proof?.source;if(!source||selectorObservedTargetCode(instance.candidate,source,manager)!==bankRuntime||
      d.chainId!==1||d.graphToken0?.toLowerCase()!==wrapped||d.graphToken1?.toLowerCase()!==k.currency1||k.currency1===wrapped||
      instance.bound.dependencies.some((a:string)=>a.toLowerCase()===wrapped)||!Array.isArray(instance.bound.innerRoutes)||
      routes.length!==1||instance.bound.innerRoutes.length!==1)return;
    const r=routes[0]!,leg=instance.bound.innerRoutes[0],asked=instance.candidate.requestedDirection,
      i=leg?.realTokenIn?.toLowerCase(),o=leg?.realTokenOut?.toLowerCase();
    if(r.programKey!==programSeal||r.observationTarget?.toLowerCase()!==manager||r.observationPoolId!==poolId||
      !asked||asked.tokenIn!==i||asked.tokenOut!==o||i===o||!currencies.includes(i)||!currencies.includes(o)||
      r.tokenIn?.toLowerCase()!==(i===ZeroAddress?wrapped:i)||r.tokenOut?.toLowerCase()!==(o===ZeroAddress?wrapped:o)||
      r.executionAssets?.input!==(i===ZeroAddress?"native":"erc20")||r.executionAssets?.output!==(o===ZeroAddress?"native":"erc20"))return;
    return [k.currency1,wrapped];
  }
  if(d.graphToken0?.toLowerCase()!==k.currency0||d.graphToken1?.toLowerCase()!==k.currency1)return;
  if(!routes.length||!routes.every(r=>r.programKey===programSeal&&r.observationTarget?.toLowerCase()===manager&&r.observationPoolId===poolId&&
    r.tokenIn!==r.tokenOut&&[r.tokenIn,r.tokenOut].every(v=>typeof v==="string"&&currencies.includes(v.toLowerCase()))&&
    r.executionAssets?.input==="erc20"&&r.executionAssets?.output==="erc20"))return;
  return currencies;
}

const paid:SelectorPaidRankRole=({program,instance,routes,dependencies,physical})=>{
  const pool=physical.logical;
  if(!pool||!pool.scopes.settlementBalanceOnly?.(pool.manager))return;
  const {manager,poolId}=pool,assets=hookFreeManagedRank(program,instance,routes,manager,poolId);
  const deps=new Set(dependencies);
  if(!assets||!deps.has(manager)||assets.some(a=>!deps.has(a)))return;
  return {managedPool:{manager,poolId},assets,economic:[...deps].filter(a=>a!==manager&&a!==ZeroAddress&&!assets.includes(a)),
    constantIdentifiers:deps.has(ZeroAddress)?[ZeroAddress]:[]};
};
export const paidRankRoles:readonly (readonly [string,SelectorPaidRankRole])[]=[[programSeal,paid]];
