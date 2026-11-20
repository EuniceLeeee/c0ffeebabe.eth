import assert from "node:assert/strict";
import test from "node:test";
import {Interface,id} from "ethers";
import {buildSqlEdgeLiveProducer,sqlSelectorModules} from "../sql-edge-live-producer.js";
import {readBlockTouchedStateKeys} from "../blockscan-touched-state.js";
import {sqlDirectionId} from "../sql-edge-price-index.js";
import {PoolLegRefreshIndex,observePoolLegRefresh,publishedPoolLegIndex,touchedPoolKey} from "../pool-leg-refresh.js";
import {issueSqlFamilyAlternatives} from "../venues/selector-native-sql-live-materializer.js";
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from "../venues/production-family-composition.js";
import {createStrictCentralAdapterRuntime} from "../strict-central-adapter-runtime.js";

const a=(n:number)=>"0x"+n.toString(16).padStart(40,"0"),h=(n:number)=>"0x"+n.toString(16).padStart(64,"0"),base={number:10,generation:10,hash:h(10)},target={number:12,hash:h(12)};
const manager="0x000000000004444c5dc75cb358380d2e3de08a90",first=a(5),other=a(6),asset=a(17),second=a(18),actor=a(101);
const sql=(selector:string,poolAddress:string,ti:string,to:string,poolId:string|null=null)=>{
  const row={candidateInstanceKey:"",chainId:1 as const,selector,poolAddress,poolId,poolNamespace:poolId?"contract-pool-id":null,tokenIn:ti,tokenOut:to,tokenInId:null,tokenOutId:null};
  row.candidateInstanceKey=sqlDirectionId(row);return row;
};
const direct=sql("0x022c0d9f",first,asset,second),back=sql("0x022c0d9f",first,second,asset),another=sql("0x022c0d9f",other,asset,second),
  ma=sql("0x48c89491",manager,asset,second,h(100)),mb=sql("0x48c89491",manager,asset,second,h(200)),ma2=sql("0x48c89491",manager,second,asset,h(100)),loose=sql("0x48c89491",manager,asset,second);
const rows=[direct,back,another,ma,mb,ma2,loose],abi=new Interface(["function token0() view returns(address)","function token1() view returns(address)"]);
async function fixture(){
  const alts=await issueSqlFamilyAlternatives({catalog,definition:sqlSelectorModules.get(direct.selector)!.definition,
    edge:direct,source:base,executor:actor,transactionOrigin:a(102),readCode:async()=>"0x6000",read:async(t,d)=>{
      assert.equal(t,first);const f=abi.parseTransaction({data:d})!.fragment;return abi.encodeFunctionResult(f,[f.name==="token0"?asset:second]);}});
  assert(alts.alternatives.length>1,JSON.stringify(alts.issues));
  const funds=catalog.listAll().find(f=>f.plugin.manifest.domain==="funding")!.plugin.manifest;
  const {runtimeRoot:root,graph}=buildSqlEdgeLiveProducer({edges:rows,source:base,currentHead:10,swapTableSha256:"a".repeat(64),fundingTableSha256:"b".repeat(64),
    fundingAssets:[{familyId:funds.familyId,asset:a(88),binding:{chainId:1,provider:a(89),asset:a(88),selector:"0x12345678",signature:"offline()"}}],
    materialized:alts.alternatives.map(z=>({...z,sqlEdgeKey:direct.candidateInstanceKey})),
    unavailable:rows.slice(1).map(r=>({sqlEdgeKey:r.candidateInstanceKey,reason:"offline synthetic shell"}))});
  const legs=rows.map(r=>graph.find(e=>e.canonicalEdgeId===r.candidateInstanceKey)!);
  const no=async()=>{throw Error("forbidden external read");};
  const ses=await root.createSession({source:base,kind:"exact",requiredEdgeIds:new Set([direct.candidateInstanceKey]),fundingAssets:[],
    runtime:createStrictCentralAdapterRuntime({executor:actor,transactionOrigin:a(102),generationFence:{assertCurrent(){}},provider:{getCode:no,getStorage:no,call:no}})});
  return {root,legs,variants:ses.executionVariantIds(legs[0]!)};
}
type Log={address:string;topics:readonly string[];data:string};
const convert=new Interface(["event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)"]);
const transfer=(from:string,to:string,token=asset):Log=>({address:token,topics:[id("Transfer(address,address,uint256)"),h(Number(BigInt(from))),h(Number(BigInt(to)))],data:h(1)});
function sourceLogs(entries:readonly Log[],late:readonly Log[]=[]){return {reads:0,async getLogs(f:{blockHash?:string}){
  this.reads++;return (f.blockHash===h(11)?entries:late).map(e=>({...e,blockHash:f.blockHash}));},async send(){throw Error("no network");}};}
test("bytes32 is raw bytes for both insert and lookup, but opaque pool IDs and namespaces remain case-sensitive",()=>{
  const low="0x"+"ab".repeat(32),upper="0x"+"AB".repeat(32),row=(id:string,legId:string,ns?:string)=>({poolAddress:manager,poolId:id,poolNamespace:ns,legId,stateKey:"res:"+legId});
  const idx=new PoolLegRefreshIndex([row(upper,"one","ABC"),row(low,"two","abc"),row("Opaque","upper"),row("opaque","lower")]);
  assert.deepEqual(new Set(idx.forPool(manager,low).legIds),new Set(["one","two"]));assert.deepEqual(idx.forPool(manager,upper,"ABC").legIds,["one"]);
  assert.deepEqual(idx.forPool(manager,low,"abc").legIds,["two"]);assert.deepEqual(idx.forPool(manager,upper,"Abc").legIds,[]);
  assert.deepEqual(idx.forPool(manager,"Opaque").legIds,["upper"]);assert.deepEqual(idx.forPool(manager,"opaque").legIds,["lower"]);
  const pub=publishedPoolLegIndex([row(upper,"one"),{...row(low,"two"),stateKey:"res:one"}]);
  for(const response of [low,upper]){
    const h=observePoolLegRefresh(pub,{kind:"log",address:manager,data:"0x",topics:[]},()=>[response]);
    assert.deepEqual(new Set(h.legIds),new Set(["one","two"]));assert.deepEqual(h.directPools,[{poolAddress:manager,poolId:low}]);
    assert.deepEqual(h.touchedPoolKeys,[touchedPoolKey(manager,upper)]);assert.equal(touchedPoolKey(manager,low),touchedPoolKey(manager,upper));
  }
});
const header=(n:number,passive:readonly string[]|undefined)=>({hash:h(n),parentHash:h(n-1),transactionHashes:[],passiveTouchedAddresses:passive});
type Root=Awaited<ReturnType<typeof fixture>>["root"];
const read=(provider:ReturnType<typeof sourceLogs>,root:Root,passive:readonly string[]|undefined)=>readBlockTouchedStateKeys(provider,target.number,manager,header(12,passive),
  {previousSource:base,readHeader:async number=>header(number,passive)},root.resolveBlockTouchedStateKeys,{mode:"logs"});
test("same physical SQL key schedules all legs, never other markets using the same currency; private every-block policy belongs to the real winner",async()=>{
  const {root,legs,variants}=await fixture(),[f,b,m]=legs;
  const users=sourceLogs([transfer(a(41),a(42)),{address:asset,topics:[id("UnknownAssetOperation(uint256)")],data:h(10)}]);
  const touched=await read(users,root,[]),plan=root.sqlPoolPriceRefreshPlan(touched,base,target)!;assert(plan);
  assert(!plan.shouldRefresh(f!));assert(!plan.shouldRefresh(b!));assert(!plan.shouldRefresh(m!));
  assert(variants.some(v=>plan.reasonFor(f!,v)==="per-block"));assert(variants.some(v=>!plan.shouldRefresh(f!,v)));
  assert.equal(plan.reasonFor(b!,variants[0]),"unverified");assert.equal(plan.reasonFor({...f!,tokenIn:a(99)}),"unverified");
  const donation=sourceLogs([transfer(a(41),first)]),fresh=await read(donation,root,[]),d=root.sqlPoolPriceRefreshPlan(fresh,base,target)!;
  const hit=root.sqlPoolTouches({kind:"log",...transfer(a(41),first)});
  assert.deepEqual(hit.touchedPoolKeys,[touchedPoolKey(first)]);assert(d.shouldRefresh(f!)&&d.shouldRefresh(b!));assert(!d.shouldRefresh(m!));
  assert(donation.reads===2);const cached=await read(donation,root,[]);assert(root.sqlPoolPriceRefreshPlan(cached,base,target)!.shouldRefresh(f!));assert(donation.reads===2);
  (fresh as Set<string>).clear();assert(d.shouldRefresh(f!));assert.equal(root.sqlPoolPriceRefreshPlan(new Set(fresh),base,target),undefined);
  assert.equal(root.sqlPoolPriceRefreshPlan(fresh,base,{...target,hash:h(9)}),undefined);
  assert.equal((await fixture()).root.sqlPoolPriceRefreshPlan(fresh,base,target),undefined);
  assert.equal(root.sqlPoolPriceRefreshPlan(await read(sourceLogs([]),root,undefined),base,target),undefined);
  const passive=root.sqlPoolPriceRefreshPlan(await read(sourceLogs([]),root,[first]),base,target)!;assert(passive.shouldRefresh(f!)&&passive.shouldRefresh(b!)&&!passive.shouldRefresh(m!));
});
test("manager A does not dirty B or its address-only shell; unknown manager is uncertainty, never a fabricated pool identity",async()=>{
  const {root,legs}=await fixture(),[,,,A,B,A2,M]=legs;
  const swap={address:manager,...convert.encodeEventLog("Swap",[h(100),a(3),-5,4,2,3,0,1])};
  const known=root.sqlPoolTouches({kind:"log",...swap});assert.deepEqual(known.touchedPoolKeys,[touchedPoolKey(manager,h(100))]);assert.deepEqual(known.fallbackLegIds,[M!.canonicalEdgeId]);
  const plan=root.sqlPoolPriceRefreshPlan(await read(sourceLogs([], [swap]),root,[]),base,target)!;
  assert(plan.shouldRefresh(A!)&&plan.shouldRefresh(A2!));assert(!plan.shouldRefresh(B!)&&!plan.shouldRefresh(M!));assert(plan.hasUnscopedPoolEvidence(M!));
  const unknown={address:manager,topics:[id("Unrecognized(bytes32)"),h(100)],data:"0x"},legacy=await read(sourceLogs([unknown]),root,[]),uncertain=root.sqlPoolPriceRefreshPlan(legacy,base,target)!;
  for(const row of [A!,A2!,B!,M!]){assert(legacy.has(row.canonicalEdgeId!));assert(!uncertain.shouldRefresh(row));assert(uncertain.hasUnscopedPoolEvidence(row));}
  assert.deepEqual(root.sqlPoolTouches({kind:"log",...unknown}).touchedPoolKeys,[]);
});
