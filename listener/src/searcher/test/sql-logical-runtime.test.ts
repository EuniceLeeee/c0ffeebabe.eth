import assert from "node:assert/strict";
import test from "node:test";
import {Interface} from "ethers";
import {GENERATED_PRODUCTION_FAMILY_ENTRIES as catalogEntries} from "../generated/production-family-entries.generated.js";
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from "../venues/production-family-composition.js";
import {issueSqlFamilyAlternatives} from "../venues/selector-native-sql-live-materializer.js";
import {sqlTrialVariantId} from "../sql-trial-variant.js";
import {buildSqlEdgeLiveProducer} from "../sql-edge-live-producer.js";
import {sqlDirectionId} from "../sql-edge-price-index.js";
import {createStrictCentralAdapterRuntime} from "../strict-central-adapter-runtime.js";
import {observePoolLegRefresh,publishedPoolLegIndex} from "../pool-leg-refresh.js";

test("a SQL route owns several source-local encodings, not several prices; unbound and foreign routes cannot execute",async()=>{
  const addr=(d:string)=>"0x"+d.repeat(40);
  const source={number:42,generation:42,hash:"0x"+"01".repeat(32)},executor=addr("3"),transactionOrigin=addr("4");
  const edge={candidateInstanceKey:"candidate-edge:v1:"+"1".repeat(64),selector:"0x128acb08",poolAddress:addr("5"),
    chainId:1 as const,poolId:null,poolNamespace:null,tokenIn:addr("6"),tokenOut:addr("7"),tokenInId:null,tokenOutId:null};
  const unresolved={...edge,candidateInstanceKey:"candidate-edge:v1:"+"2".repeat(64),poolAddress:addr("8")};
  edge.candidateInstanceKey=sqlDirectionId(edge);unresolved.candidateInstanceKey=sqlDirectionId(unresolved);
  const sibling={...edge,tokenIn:edge.tokenOut,tokenOut:edge.tokenIn};
  sibling.candidateInstanceKey=sqlDirectionId(sibling);
  const abi=new Interface(["function token0() view returns(address)","function token1() view returns(address)",
    "function fee() view returns(uint24)","function tickSpacing() view returns(int24)"]);
  const values:Record<string,string|number>={token0:edge.tokenOut,token1:edge.tokenIn,fee:500,tickSpacing:10};
  const read=async(target:string,data:string)=>{assert.equal(target,edge.poolAddress);const f=abi.parseTransaction({data})!.fragment;
    return abi.encodeFunctionResult(f,[values[f.name]]);};
  const definition=catalogEntries.map(e=>e.module.selectorFamilyModule.definition).find(d=>d.selector===edge.selector)!;
  const alts=await issueSqlFamilyAlternatives({definition,catalog,edge,source,executor,transactionOrigin,read,readCode:async()=>"0x6000",matchPriceTrial:true});
  assert.equal(alts.alternatives.length,2,alts.issues.join("; "));
  const funding=catalog.listAll().find(f=>f.plugin.manifest.domain==="funding")!.plugin.manifest;
  const publisher=buildSqlEdgeLiveProducer({edges:[edge,unresolved,sibling],source,currentHead:42,swapTableSha256:"a".repeat(64),
    fundingTableSha256:"b".repeat(64),fundingAssets:[{familyId:funding.familyId,asset:addr("9"),binding:{
      chainId:1,provider:addr("a"),asset:addr("9"),selector:"0x12345678",signature:"synthetic()"}}],
    materialized:alts.alternatives.map(a=>({...a,sqlEdgeKey:edge.candidateInstanceKey})),
    unavailable:[unresolved,sibling].map(r=>({sqlEdgeKey:r.candidateInstanceKey,reason:"missing execution input"}))});
  const [leg,missing]=publisher.graph;assert(leg&&missing);
  const root=publisher.runtimeRoot,index=root.pricingIndex();
  assert.deepEqual(index.expectedEdgeKeys,[edge,unresolved,sibling].map(r=>r.candidateInstanceKey).sort());
  const changed=(target:string)=>root.resolveBlockTouchedStateKeys({kind:"call",target,data:"0xdeadbeef"},source);
  assert.deepEqual(new Set(changed(edge.poolAddress)),new Set([edge,sibling].map(r=>r.candidateInstanceKey)));
  assert.deepEqual(changed(unresolved.poolAddress),[unresolved.candidateInstanceKey]);
  for(const row of [edge,unresolved]){
    const hit=root.sqlPoolTouches({kind:"call",target:row.poolAddress,data:"0xdeadbeef"});
    assert.deepEqual(hit.directPools,[{poolAddress:row.poolAddress}]);
    const rows=row===edge?[edge,sibling]:[row];
    assert.deepEqual(new Set(hit.legIds),new Set(rows.map(r=>r.candidateInstanceKey)));
    assert.deepEqual(new Set(hit.poolKeys),new Set(rows.map(r=>publisher.graph.find(e=>e.canonicalEdgeId===r.candidateInstanceKey)!.stateResourceKey)));
  }
  assert.deepEqual(root.sqlPoolTouches({kind:"log",address:edge.tokenIn,topics:[],data:"0x"}).directPools,[]);
  const runtime=createStrictCentralAdapterRuntime({executor,transactionOrigin,
    generationFence:{assertCurrent(){}},provider:{async call(){throw Error("unexpected provider work in exact session");},
      async getCode(){throw Error("unexpected getCode");},async getStorage(){throw Error("unexpected getStorage");}}});
  const open=(s:typeof source)=>root.createSession({source:s,kind:"exact",runtime,fundingAssets:[],requiredEdgeIds:new Set(index.expectedEdgeKeys)});
  const session=await open(source);
  const args={edge:leg,executor,runtimeEvidence:[]};
  const ids=session.executionVariantIds(leg);assert.equal(ids.length,2);
  assert.equal(session.buildRuntimeAmountLeg(args),null,"unproven ambiguous route must not pick a recipe");
  const compiled=ids.map(variantId=>session.buildRuntimeAmountLeg({...args,variantId})!.program);assert.notEqual(compiled[0],compiled[1]);
  for(const a of alts.alternatives){
    const variantId=sqlTrialVariantId(a.programKey,a.program);
    assert.equal(session.buildRuntimeAmountLeg({...args,variantId})?.program,a.program);
    assert.throws(()=>session.buildRuntimeAmountLeg({...args,variantId:sqlTrialVariantId(a.programKey,"0x6001")}),/no bound private/);
    assert.throws(()=>session.buildRuntimeAmountLeg({...args,edge:missing,variantId}),/no bound private/);
  }
  assert.deepEqual(session.executionVariantIds(missing),[]);assert.equal(session.buildRuntimeAmountLeg({...args,edge:missing}),null);
  assert.equal(session.currentPricingForEdge(missing)?.status,"unresolved");
  assert.throws(()=>session.buildRuntimeAmountLeg({...args,edge:missing,variantId:ids[0]}),/no bound private/);
  assert.throws(()=>session.confirmExecutionVariant({...leg,tokenIn:leg.tokenOut},ids[0]!),/logical route shell/);
  session.confirmExecutionVariant(leg,ids[1]!);
  assert.equal(session.buildRuntimeAmountLeg(args),null,"a mutable preference is not the published amount-leg selection");
  const next=await open({...source,number:43,generation:43,hash:"0x"+"02".repeat(32)});
  assert.equal(next.executionVariantIds(leg)[0],ids[1]);
  assert.equal(next.buildRuntimeAmountLeg({...args,variantId:ids[0]} )!.program,compiled[0],"supplied receipt wins even if mutable order differs");
});

test("one observed manager/ID can span published resources without contaminating another pool or losing fallback work",()=>{
  const addr=(d:string)=>"0x"+d.repeat(40),m=addr("1"),n=addr("2"),token=addr("3");
  const rows=[
    {poolAddress:m,poolId:"A",stateKey:"issued-resource",legId:"bound-forward"},
    {poolAddress:m,poolId:"A",stateKey:"opaque-resource",legId:"unbound-back"},
    {poolAddress:m,poolId:"A",stateKey:"issued-resource",legId:"other-selector"},
    {poolAddress:m,poolId:"B",stateKey:"sibling",legId:"sibling-leg"},
    {poolAddress:n,poolId:"A",stateKey:"foreign",legId:"other-manager-leg"},
    {poolAddress:m,poolId:null,stateKey:"address-only",legId:"loose"}];
  const idx=publishedPoolLegIndex(rows),obs={kind:"log" as const,address:m,topics:[],data:"0x"};
  const hit=observePoolLegRefresh(idx,obs,()=>["A","A"]);
  assert.deepEqual(hit.directPools,[{poolAddress:m,poolId:"A"}]);
  assert.deepEqual(new Set(hit.directStateKeys),new Set(["issued-resource","opaque-resource"]));
  assert.deepEqual(new Set(hit.directLegIds),new Set(["bound-forward","unbound-back","other-selector"]));
  assert.deepEqual(hit.fallbackManagers,[]);
  assert.deepEqual(hit.fallbackLegIds,["loose"]);
  const unknown=observePoolLegRefresh(idx,obs,()=>null);
  assert.deepEqual(unknown.directPools,[]);assert.deepEqual(unknown.fallbackManagers,[m]);
  assert.deepEqual(new Set(unknown.legIds),new Set(rows.filter(r=>r.poolAddress===m).map(r=>r.legId)));
  assert.deepEqual(observePoolLegRefresh(idx,{...obs,address:token}).legIds,[]);
  assert.throws(()=>publishedPoolLegIndex([...rows,{...rows[0]!,poolAddress:n,legId:"bad"}]),/aliases distinct physical pools/);
});
