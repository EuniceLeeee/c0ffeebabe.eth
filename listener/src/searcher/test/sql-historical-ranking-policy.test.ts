import test from "node:test";
import assert from "node:assert/strict";
import {Interface,id as keccak} from "ethers";
import {GENERATED_PRODUCTION_FAMILY_ENTRIES as catalogEntries} from "../generated/production-family-entries.generated.js";
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from "../venues/production-family-composition.js";
import {issueSqlFamilyAlternatives} from "../venues/selector-native-sql-live-materializer.js";
import {buildSqlEdgeLiveProducer} from "../sql-edge-live-producer.js";
import {sqlDirectionId} from "../sql-edge-price-index.js";
import {createStrictCentralAdapterRuntime} from "../strict-central-adapter-runtime.js";
import {readBlockTouchedStateKeys} from "../blockscan-touched-state.js";
import {settlementAssetRankingActors} from "../venues/settlement-asset-ranking-activity.js";
import {ADDR} from "../../shared/constants/addresses.js";
const addr=(n:number)=>"0x"+n.toString(16).padStart(40,"0"),h=(n:number)=>"0x"+n.toString(16).padStart(64,"0");
for(const selector of ["0x128acb08","0x022c0d9f"])test(selector+" only the owning old variant can rank on a sealed continuous forward interval; actual pool, consensus write and unknown inputs veto",async()=>{
  const base={number:42,generation:42,hash:h(42)},target={number:44,hash:h(44)},executor=addr(3),transactionOrigin=addr(4);
  const edge={candidateInstanceKey:"",selector,poolAddress:addr(5),chainId:1 as const,poolId:null,
    poolNamespace:null,tokenIn:ADDR.WETH.toLowerCase(),tokenOut:addr(7),tokenInId:null,tokenOutId:null};edge.candidateInstanceKey=sqlDirectionId(edge);
  const abi=new Interface(["function token0() view returns(address)","function token1() view returns(address)",
    "function fee() view returns(uint24)","function tickSpacing() view returns(int24)"]);
  const values:Record<string,string|number>={token0:edge.tokenOut,token1:edge.tokenIn,fee:500,tickSpacing:10};
  const definition=catalogEntries.map(e=>e.module.selectorFamilyModule.definition).find(d=>d.selector===edge.selector)!;
  const alts=await issueSqlFamilyAlternatives({definition,catalog,edge,source:base,executor,transactionOrigin,
    read:async(target,data)=>{assert.equal(target,edge.poolAddress);const f=abi.parseTransaction({data})!.fragment;return abi.encodeFunctionResult(f,[values[f.name]]);},
    readCode:async()=>"0x6000"});
  const funding=catalog.listAll().find(f=>f.plugin.manifest.domain==="funding")!.plugin.manifest;
  const p=buildSqlEdgeLiveProducer({edges:[edge],source:base,currentHead:42,swapTableSha256:"a".repeat(64),
    fundingTableSha256:"b".repeat(64),fundingAssets:[{familyId:funding.familyId,asset:addr(9),binding:{chainId:1,provider:addr(10),
      asset:addr(9),selector:"0x12345678",signature:"synthetic()"}}],materialized:alts.alternatives.map(a=>({...a,sqlEdgeKey:edge.candidateInstanceKey})),unavailable:[]});
  const root=p.runtimeRoot,leg=p.graph[0]!,key=root.pricingIndex().stateKeyByEdgeKey.get(edge.candidateInstanceKey)!;
  const runtime=createStrictCentralAdapterRuntime({executor,transactionOrigin,generationFence:{assertCurrent(){}},provider:{
    async call(){throw Error("unexpected provider");},async getCode(){throw Error("unexpected provider");},async getStorage(){throw Error("unexpected provider");}}});
  const session=await root.createSession({source:base,kind:"exact",runtime,fundingAssets:[],requiredEdgeIds:new Set([edge.candidateInstanceKey])});
  const vs=session.executionVariantIds(leg);assert(vs.length>=2);
  const header=(n:number,passive?:string[])=>({hash:h(n),parentHash:h(n-1),transactionHashes:[],passiveTouchedAddresses:passive});
  const mock=(emitter:string,topics=[keccak("Approval(address,address,uint256)"),h(101),h(102)])=>({reads:0,async getLogs(f:{blockHash?:string}){this.reads++;return [{blockHash:f.blockHash,address:emitter,
    topics,data:h(1)}];},async send(){throw Error("no RPC");}});
  const read=(provider:ReturnType<typeof mock>,passive:string[]|undefined)=>readBlockTouchedStateKeys(provider,target.number,addr(100),header(44,passive),
    {previousSource:base,readHeader:async n=>header(n,passive)},root.resolveBlockTouchedStateKeys,{mode:"logs"});
  const prov=mock(edge.tokenIn), touched=await read(prov,[]);
  assert(touched.has(key),"original coarse execution dirty remains");const policy=root.historicalRankingPolicy(touched,base,target)!;assert(policy);
  const winner=vs.find(v=>policy.isCleanOnTouchReceipt({...leg},key,v));assert(winner);
  if(selector==="0x022c0d9f"){
    const eligible=vs.filter(v=>policy.isCleanOnTouchReceipt(leg,key,v));
    assert.equal(eligible.length,2,"only the two fixed-fee reserve quote recipes");
    assert(eligible.length<vs.length,"pool-owned and unknown fee/amount recipes are not exempt");
  }
  assert.equal(policy.isCleanOnTouchReceipt({...leg,tokenIn:leg.tokenOut},key,winner),false);
  assert.equal(policy.isCleanOnTouchReceipt(leg,"foreign",winner),false);
  assert.equal(policy.isCleanOnTouchReceipt(leg,key,edge.selector),false);
  assert.equal(root.historicalRankingPolicy(new Set(touched),base,target),undefined);
  assert.equal(root.historicalRankingPolicy(touched,{...base,hash:h(1)},target),undefined);
  assert.equal(root.historicalRankingPolicy(touched,base,{...target,hash:h(9)}),undefined);
  const again=await read(prov,[]);assert.equal(prov.reads,2);assert(root.historicalRankingPolicy(again,base,target)!.isCleanOnTouchReceipt(leg,key,winner));
  const dirty=await read(mock(edge.poolAddress),[]);(dirty as Set<string>).delete(edge.poolAddress);assert.equal(root.historicalRankingPolicy(dirty,base,target)!.isCleanOnTouchReceipt(leg,key,winner),false);
  const passive=await read(mock(edge.tokenIn),[edge.tokenIn]);assert.equal(root.historicalRankingPolicy(passive,base,target)!.isCleanOnTouchReceipt(leg,key,winner),false);
  const rebase=await read(mock(edge.tokenIn,[keccak("Rebase(uint256)")]),[]);
  assert.equal(root.historicalRankingPolicy(rebase,base,target)!.isCleanOnTouchReceipt(leg,key,winner),false);
  // No market/code proof for this synthetic token. Even a third-party
  // burn is a possible supply/rebase/rate change, not an ordinary transfer.
  const burn=await read(mock(edge.tokenIn,[keccak("Transfer(address,address,uint256)"),h(77),h(0)]),[]);
  assert.equal(root.historicalRankingPolicy(burn,base,target)!.isCleanOnTouchReceipt(leg,key,winner),false);
  const poolApproves=await read(mock(edge.tokenIn,[keccak("Approval(address,address,uint256)"),h(5),h(102)]),[]);
  assert.equal(root.historicalRankingPolicy(poolApproves,base,target)!.isCleanOnTouchReceipt(leg,key,winner),false);
  const own=await read(mock(edge.tokenIn,[keccak("Deposit(address,uint256)"),h(5)]),[]);
  assert.equal(root.historicalRankingPolicy(own,base,target)!.isCleanOnTouchReceipt(leg,key,winner),false);
  const unrelated=await read(mock(edge.tokenIn,[keccak("Withdrawal(address,uint256)"),h(77)]),[]);
  assert.equal(root.historicalRankingPolicy(unrelated,base,target)!.isCleanOnTouchReceipt(leg,key,winner),true);
  assert.equal(root.historicalRankingPolicy(await read(mock(edge.tokenIn),undefined),base,target),undefined);
});
test("mainnet WETH owner evidence is ranking-only, requires exact emitter and ABI, and unknown mutations cannot become hints",()=>{
 const d={address:ADDR.WETH,topics:[keccak("Deposit(address,uint256)"),h(8)],data:h(20)};
 assert.deepEqual(settlementAssetRankingActors(d),[addr(8)]);
 assert.equal(settlementAssetRankingActors({...d,address:addr(9)}),null);
 assert.equal(settlementAssetRankingActors({...d,data:"0x01"}),null);
 assert.equal(settlementAssetRankingActors({...d,topics:[keccak("FeeChanged(uint256)"),h(8)]}),null);
 const tr=keccak("Transfer(address,address,uint256)");
 assert.deepEqual(settlementAssetRankingActors({...d,topics:[tr,h(0),h(8)]}),{possibleSupplyHolder:addr(8)});
 assert.deepEqual(settlementAssetRankingActors({...d,topics:[tr,h(8),h(0)]}),{possibleSupplyHolder:addr(8)});
 assert.equal(settlementAssetRankingActors({...d,topics:[tr,h(0),h(0)]}),null);
 assert.equal(settlementAssetRankingActors({...d,topics:[tr,h(0),h(8)],data:"0xaa"}),null);
 assert.equal(settlementAssetRankingActors({...d,topics:[keccak("Approval(address,address,uint256)"),h(0),h(8)]}),null);
});
