import assert from "node:assert/strict";import {test} from "node:test";
import {AbiCoder,Interface,ZeroAddress,id,keccak256} from "ethers";
import {buildSqlEdgeLiveProducer,sqlSelectorModules} from "../sql-edge-live-producer.js";
import {readBlockTouchedStateKeys} from "../blockscan-touched-state.js";
import {sqlDirectionId} from "../sql-edge-price-index.js";import {touchedPoolKey} from "../pool-leg-refresh.js";
import {issueSqlFamilyAlternatives} from "../venues/selector-native-sql-live-materializer.js";
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from "../venues/production-family-composition.js";
const a=(n:number)=>"0x"+n.toString(16).padStart(40,"0"),h=(n:number)=>"0x"+n.toString(16).padStart(64,"0");
const manager="0x000000000004444c5dc75cb358380d2e3de08a90",registry="0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",selector="0x48c89491";
const keyTypes=["address","address","uint24","int24","address"],abi=new Interface(["function poolKeys(bytes25) view returns(address,address,uint24,int24,address)",
 "event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)"]);
type Log={address:string,topics:readonly string[],data:string};
test("a shared registry used in 500 independently bound SQL recipes is an Exact dependency, not a price feed; a positive notification refreshes only its bound pool key",async()=>{
 const source={number:10,hash:h(10),generation:1},target={number:11,hash:h(11),generation:2},actor=a(2000);
 const count=500,rows=[],alternatives=[];const def=sqlSelectorModules.get(selector)!.definition;
 assert(def.domain==="swap","fixture must have execution recipes");
 for(let i=0;i<count;i++){
   const tokenIn=a(5),tokenOut=a(10000+i),values=[tokenIn,tokenOut,3000,60,ZeroAddress];
   const poolId=keccak256(AbiCoder.defaultAbiCoder().encode(keyTypes,values));
   const row={candidateInstanceKey:"",chainId:1 as const,selector,poolAddress:manager,poolNamespace:"contract-pool-id",poolId,tokenIn,tokenOut,tokenInId:null,tokenOutId:null};
   row.candidateInstanceKey=sqlDirectionId(row);
   const issued=await issueSqlFamilyAlternatives({catalog,definition:def,edge:row,source,executor:actor,transactionOrigin:a(2001),
     readCode:async()=> "0x6000",read:async(at,data)=>{
       assert.equal(at.toLowerCase(),registry);assert.equal(abi.decodeFunctionData("poolKeys",data)[0],poolId.slice(0,52));
       return abi.encodeFunctionResult("poolKeys",values);
     }});
   assert(issued.alternatives.length>0,JSON.stringify(issued.issues));rows.push(row);alternatives.push(...issued.alternatives.map(v=>({...v,sqlEdgeKey:row.candidateInstanceKey})));
 }
 const fund=catalog.listAll().find(f=>f.plugin.manifest.domain==="funding")!.plugin.manifest;
 const {runtimeRoot:root,graph}=buildSqlEdgeLiveProducer({edges:rows,source,currentHead:10,swapTableSha256:"a".repeat(64),fundingTableSha256:"b".repeat(64),
   fundingAssets:[{familyId:fund.familyId,asset:a(5000),binding:{chainId:1,provider:a(5001),asset:a(5000),selector:"0x12345678",signature:"offline()"}}],materialized:alternatives,unavailable:[]});
 const observe=async(logs:Log[])=>{const original=await readBlockTouchedStateKeys({getLogs:async()=>logs.map(l=>({...l,blockHash:target.hash})),send:async()=>{throw Error("no network");}},
  11,manager,{hash:target.hash,parentHash:source.hash,transactionHashes:[],passiveTouchedAddresses:[]},
  {previousSource:source,readHeader:async()=>{throw Error("unexpected read");}},root.resolveBlockTouchedStateKeys,{mode:"logs"});
  const plan=root.sqlPoolPriceRefreshPlan(original,source,target)!;assert(plan);
  return {exact:graph.filter(e=>original.has(e.canonicalEdgeId!)).length,prices:graph.filter(e=>plan.shouldRefresh(e)).map(e=>e.canonicalEdgeId!).sort()};};
 const changed:Log={address:registry,topics:[id("AuxiliaryConfigurationChanged()")],data:"0x"};
 assert.equal(root.blockTouchedDependencyAddresses().includes(registry),true);assert.deepEqual(root.sqlPoolTouches({kind:"log",...changed}).touchedPoolKeys,[]);
 const generic=await observe([changed]);assert.equal(generic.exact,count);assert.equal(generic.prices.length,0,"ordinary registry dependency is not a price subscription");
 const selected=rows[246]!,event:Log={address:manager,...abi.encodeEventLog("Swap",[selected.poolId,actor,-5,4,2,3,0,1])};
 assert.deepEqual(root.sqlPoolTouches({kind:"log",...event}).touchedPoolKeys,[touchedPoolKey(manager,selected.poolId)]);
 const positive=await observe([changed,event]);assert.equal(positive.exact,count);assert.deepEqual(positive.prices,[selected.candidateInstanceKey]);
});
