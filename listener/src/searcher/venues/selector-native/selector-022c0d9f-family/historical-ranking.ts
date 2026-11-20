import type { SelectorPaidRankRole } from "../paid-ranking-contract.js";
import { selectorNativeProgramKey, type SelectorNativeProgram } from "../../selector-native-definition.js";
import { selectorObservedTargetCode } from "../../selector-native-discovery.js";
import { getCreate2Address, solidityPackedKeccak256 } from "ethers";

// Full normalized recipe identity, not a pool/factory/selector allowlist.
// Both bind token0/token1 at the pool, then read just those currencies' code.
// quoteOutput reads getReserves at the pool and applies the fixed local model;
// execution also measures actual input credit at the pool. A changed getter,
// transfer/fee model, hook, call target or condition is a DIFFERENT program.
const feeByRecipe=new Map([
  ["parameters:f46ee4c72403e400bf9f7afe3cec1abef346256b78ebeac193038719c8cb4756","25"],
  ["parameters:a553f7b58dcfadb4ef459e37931bbc5df50a49c116d45668728158c222482186","30"],
]);
const knownKeys=new WeakMap<SelectorNativeProgram,string>();
function immutable(x:unknown):boolean{return !x||typeof x!=="object"||Object.isFrozen(x)&&Object.values(x).every(immutable);}
function keyOf(p:SelectorNativeProgram):string{
  // The normalizer deeply freezes the programs passed by the Family. Avoid
  // hashing a large read/quote/execution definition once per SQL direction.
  const old=knownKeys.get(p);if(old)return old;
  const key=selectorNativeProgramKey(p);if(immutable(p))knownKeys.set(p,key);return key;
}
const standardPair:SelectorPaidRankRole=({program,instance,routes,physical,dependencies})=>{
  const key=keyOf(program),fee=feeByRecipe.get(key);if(!fee||key!==instance.programKey)return;
  const d=instance.bound?.descriptor,pool=instance.target;
  if(!d||program.refreshPolicy!=="on-touch"||physical.logical||physical.holders.size!==1||!physical.holders.has(pool)||
    pool!==d.pool||d.feeRule?.kind!=="constant-bps"||String(d.feeRule.feeBps)!==fee||d.quoteModel?.kind!=="constant-product"||
    !Array.isArray(d.tokenTransfers)||d.tokenTransfers.length!==2||!routes.length)return;
  const assets=[d.token0,d.token1];
  if(!assets.every(t=>typeof t==="string"&&/^0x[0-9a-f]{40}$/.test(t)&&!/^0x0+$/.test(t)&&t!==pool)||assets[0]===assets[1]||
    !routes.every(r=>r.programKey===key&&r.target===pool&&r.observationTarget===pool&&!r.observationPoolId&&!r.resources&&
      r.resource?.target===pool&&!r.resource.poolId&&r.tokenIn.toLowerCase()!==r.tokenOut.toLowerCase()&&
      assets.includes(r.tokenIn.toLowerCase())&&assets.includes(r.tokenOut.toLowerCase())))return;
  // This is NOT a claim that an arbitrary token transfers at par. Known tax
  // models stay strict; unknown token events/code/passive writes also veto
  // ranking at the activity layer. Only old paid output is used for ordering.
  if(!assets.every((t,i)=>{const m=d.tokenTransfers[i];return m?.token?.toLowerCase()===t&&m.kind==="nominal-unverified"&&
    /^0x[0-9a-f]{64}$/.test(m.codeHash)&&String(m.taxNumerator)==="0"&&String(m.taxDenominator)==="10000";}))return;
  const expected=new Set([pool,...assets]),declared=new Set(dependencies.map(a=>a.toLowerCase()));
  if(declared.size!==3||[...expected].some(a=>!declared.has(a))||
    !Array.isArray(instance.bound.dependencies)||instance.bound.dependencies.some((a:string)=>!expected.has(a.toLowerCase())))return;
  // Reject both new external dependencies and a new *second* economic role
  // for an existing asset, which would otherwise disappear in address dedup.
  function hasAsset(x:unknown):boolean{
    if(typeof x==="string")return assets.includes(x.toLowerCase());
    return !!x&&typeof x==="object"&&Object.values(x).some(hasAsset);
  }
  if(Object.entries(d).some(([name,value])=>{
    if(name==="token0"||name==="token1")return false;
    if((name==="tokenIn"||name==="tokenOut")&&instance.candidate?.scope?.[name]===value)return false;
    if(name==="tokenTransfers")return d.tokenTransfers.some((m:Record<string,unknown>)=>Object.entries(m).some(([k,v])=>k!=="token"&&hasAsset(v)));
    return hasAsset(value);
  }))return;
  // Only the winning paid target's market at its original amount; this
  // certificate never carries a current quote, a prefix, or execution authority.
  // Exact, non-proxy runtime images (including metadata): UniswapV2Pair,
  // DSS/Dai 0.5.12 and WETH9. The pair swap uses reserves and its own token
  // balances; neither token's transfer/balanceOf reads DAI totalSupply, has
  // a configurable fee, nor calls external pricing code. A DAI burn may also
  // consume the burning account's allowance; this target uses no allowance
  // owned by a third party. A donation to this pool is still a physical veto.
  const pairCode="0x5b83bdbcc56b2e630f2807bbadd2b0c21619108066b92a58de081261089e9ce5";
  const daiCode="0x4e36f96ee1667a663dfaac57c4d185a0e369a3a217e0079d49620f34f85d1ac7";
  const wethCode="0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23";
  const source=instance.proof?.source, hashes=d.tokenTransfers.map((m:{codeHash:string})=>m.codeHash);
  const dai=hashes.indexOf(daiCode);
  if(key==="parameters:a553f7b58dcfadb4ef459e37931bbc5df50a49c116d45668728158c222482186"&&
    instance.candidate?.scope?.chainId===1&&source&&dai>=0&&hashes[1-dai]===wethCode&&
    assets[0]<assets[1]&&selectorObservedTargetCode(instance.candidate,source,pool)===pairCode&&
    pool===getCreate2Address("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
      solidityPackedKeccak256(["address","address"],assets),"0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f").toLowerCase())
    return {economic:[pool],assets,thirdPartySupplyIndependentAssets:[assets[dai]]};
  return {economic:[pool],assets};
};
export const paidRankRoles:readonly (readonly [string,SelectorPaidRankRole])[]=Object.freeze([...feeByRecipe.keys()].map(k=>[k,standardPair] as const));
