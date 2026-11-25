import assert from "node:assert/strict";
import test from "node:test";
import { buildSqlEdgeLiveProducer } from "../sql-edge-live-producer.js";
import { StrictReadyGraphViewCoordinator } from "../strict-ready-graph-view.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../venues/production-family-composition.js";
import type { CanonicalEdgeId } from "../venues/blockscan-state-capability.js";
import {createHash} from "node:crypto";
import { Interface } from "ethers";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { selectorFamilyIdentity } from "../venues/selector-execution-keys.js";

const swap = catalog.listAll().find(f => f.plugin.manifest.domain === "swap")!.plugin.manifest;
const funding = catalog.listAll().find(f => f.plugin.manifest.domain === "funding")!.plugin.manifest;
const addr = (v:string) => "0x"+v.repeat(40);
const source = { number: 42, generation: 42, hash: "0x"+"aa".repeat(32) };
const sqlId=(sel:string,pool:string,a:string,b:string)=>("candidate-edge:v1:"+createHash("sha256").update(JSON.stringify(["1",sel,pool,null,null,a,null,b,null])).digest("hex")) as CanonicalEdgeId;

// Minimal structural inputs exercise early refusal. They do not claim chain corroboration.
const fixture = () => ({
  source, edges: [{candidateInstanceKey:"candidate"}] as never,
  swapTableSha256:"a".repeat(64),unavailable:[],
  fundingAssets:[{familyId:funding.familyId,asset:addr("a"),binding:{
    chainId:1,provider:addr("b"),asset:addr("a"),selector:"0x01020304",signature:"synthetic()",
  }}],fundingTableSha256:"0".repeat(64),currentHead:42,
  materialized:[{sqlEdgeKey:"candidate",instance:Object.freeze({familyId:swap.familyId,instanceKey:"structural"}) as never,routeKey:"123",programKey:"parameters:"+"1".repeat(64)}],
});
test("an SQL row and matching phase/count can never mint an execution handle", () => {
  assert.throws(() => buildSqlEdgeLiveProducer(fixture()),/lifecycle-issued/);
  assert.throws(() => buildSqlEdgeLiveProducer({...fixture(),materialized:[]}),/missing a binding or disposition/);
  assert.throws(() => buildSqlEdgeLiveProducer({...fixture(),materialized:[],unavailable:[{sqlEdgeKey:"candidate",reason:"missing declared fields"}]}),/no enabled conversion direction/);
  const raw={candidateInstanceKey:"candidate-edge:v1:"+"0".repeat(64),chainId:1,selector:"0x128acb08",poolAddress:addr("4"),tokenIn:addr("5"),tokenOut:addr("6"),poolId:null,poolNamespace:null,tokenInId:null,tokenOutId:null} as const;
  assert.throws(()=>buildSqlEdgeLiveProducer({...fixture(),edges:[raw],materialized:[],unavailable:[{sqlEdgeKey:raw.candidateInstanceKey,reason:"no private evidence"}]}),/SQL leg ID differs/);
  assert.throws(() => buildSqlEdgeLiveProducer({...fixture(),unavailable:[{sqlEdgeKey:"candidate",reason:""}]}),/unexplained SQL exclusion/);
  const v = fixture();
  assert.throws(() => buildSqlEdgeLiveProducer({...v,materialized:[{...v.materialized[0]!,sqlEdgeKey:"foreign"}]}),/foreign or excluded/);
});
test("rejects non-current source and absent or substituted funding", () => {
  const v = fixture(), f = v.fundingAssets[0]!;
  assert.throws(() => buildSqlEdgeLiveProducer({...v,currentHead:41}),/ahead/);
  assert.throws(() => buildSqlEdgeLiveProducer({...v,fundingAssets:[]}),/no funding source/);
  assert.throws(() => buildSqlEdgeLiveProducer({...v,fundingTableSha256:"not a hash"}),/funding table/);
  assert.throws(() => buildSqlEdgeLiveProducer({...v,fundingAssets:[f,f]}),/duplicate SQL funding/);
  assert.throws(() => buildSqlEdgeLiveProducer({...v,fundingAssets:[{...f,asset:addr("c")}]}),/binding is required/);
  assert.throws(() => buildSqlEdgeLiveProducer({...v,fundingAssets:[{...f,familyId:swap.familyId}]}),/non-funding Family/);
});
test("SQL topology uses the same graph view verifier but cannot consume an old Ready topology key", () => {
  const adapterId = swap.ownedActionAdapterIds[0]!, metadata = {
    adapterId, target: addr("1"), tokenIn:addr("2"),tokenOut:addr("3"),
    slotKind:"swap" as const,edgeKind:"swap" as const,leavesStandingPosition:false,
  };
  const graph = [{...metadata, canonicalEdgeId:sqlId("0x128acb08",metadata.target,metadata.tokenIn,metadata.tokenOut)}];
  const c = new StrictReadyGraphViewCoordinator({catalog,publicationKind:"sql-edges",
    ready:{generation:42,graphHash:"g",catalogHash:catalog.catalogHash,sourceCoverage:[{familyId:swap.familyId,sourceId:"swap:observed"}]},edges:graph});
  const head = {id:"historical",generation:43,sourceBlock:43,sourceBlockHash:source.hash,edges:graph};
  assert.throws(() => c.build({...head,topologyKey:"strict-ready:42:g"}),/topology key mismatch/);
  const view = c.build({...head,topologyKey:"sql-edges:42:g"});
  assert.equal(view.scannerEdgeCount,1);
  assert.equal(view.perSourceCoverage[0]!.sourceId,"sql-edges:swap:observed");
});

test("genuine catalog-issued directions reach the production pricing index; crossing two SQL rows fails", async () => {
  const signature = "function swap(address,bool,int256,uint160,bytes)", abi = new Interface([signature]);
  const familyId = selectorFamilyIdentity(signature).familyId, selector = "0x128acb08", poolAddress=addr("3");
  const tokenIn=addr("4"), tokenOut=addr("5"), owner=addr("6"), executor=addr("7"), txHash="0x"+"01".repeat(32);
  const data=abi.encodeFunctionData(selector,[owner,true,123n,1n,"0x"]);
  const census = readySelectorCensusFromTransaction({ chainId:1,from:owner,to:poolAddress,input:data,status:1,
    blockNumber:source.number,blockHash:source.hash,transactionHash:txHash,transactionIndex:0,logs:[],traces:[] });
  const neverRead = async ():Promise<never> => { throw Error("fixture must stay offline"); };
  const getters = new Interface(["function token0() view returns(address)","function token1() view returns(address)",
    "function fee() view returns(uint24)","function tickSpacing() view returns(int24)"]);
  const answers: Record<string,string|number> = {token0:tokenIn,token1:tokenOut,fee:500,tickSpacing:10};
  const runtime = createStrictCentralAdapterRuntime({executor,transactionOrigin:owner,
    generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},
    provider:{async call(tx) {
      assert.equal(tx.to.toLowerCase(),poolAddress);
      const call=getters.parseTransaction({data:tx.data})!;
      return getters.encodeFunctionResult(call.fragment,[answers[call.name]]);
    },getCode:neverRead,getStorage:neverRead}});
  const published=await runStrictFamilyLifecycle({catalog,familyId,source,runtime,observations:[{kind:"call",source,target:poolAddress,
    sender:owner,data,transactionHash:txHash,traceAddress:[],opaque:{selectorCensus:census, callId:census.calls[0]!.id} as never}]});
  assert(published.instances.length,published.outcomes.map(x=>x.reasonCode).join(","));
  const instance=published.instances[0]!, edges=instance.routes.map(route=>({candidateInstanceKey:sqlId(selector,poolAddress,route.tokenIn.toLowerCase(),route.tokenOut.toLowerCase()),
    selector,chainId:1,poolAddress,tokenIn:route.tokenIn.toLowerCase(),tokenOut:route.tokenOut.toLowerCase(),
    poolNamespace:null,poolId:null,tokenInId:null,tokenOutId:null}));
  const materialized=instance.routes.map((route,i)=>{
    const identity=catalog.forFamily(familyId).plugin.routes.projectGraph({descriptor:instance.descriptor,route}).venueIdentity as { programKey:string };
    return {sqlEdgeKey:edges[i]!.candidateInstanceKey,instance,routeKey:route.routeKey,programKey:identity.programKey};
  });
  const args={...fixture(),edges:edges as never,materialized};
  const actual=buildSqlEdgeLiveProducer(args);
  assert.equal(actual.graph.length,edges.length);
  assert.deepEqual(actual.inputSummary,{rows:edges.length,enabledDirections:edges.length,boundDirections:edges.length,issuedLegs:edges.length,
    privateRecipes:edges.length,trialDirections:0,disabled:0,notConversion:0,unboundDirections:0,reasons:{}});
  const id=actual.graph[0]!.canonicalEdgeId!;
  assert.equal(id,edges[0]!.candidateInstanceKey);
  assert(actual.runtimeRoot.pricingIndex().stateKeyByEdgeKey.has(id));
  const session = await actual.runtimeRoot.createSession({kind:"exact",source,runtime,fundingAssets:[],requiredEdgeIds:new Set([id])});
  const leg = session.buildRuntimeAmountLeg({edge:actual.graph[0]!,executor,runtimeEvidence:[]});
  assert(leg && leg.program.startsWith("0x01"),"the production amount solver must be able to consume the live-issued leg");
  for (const changed of [{tokenOut:edges[0]!.tokenIn},{selector:"0xabcdef01"},{poolAddress:addr("9")},{tokenInId:"42"}]) {
    assert.throws(()=>buildSqlEdgeLiveProducer({...args,edges:[{...edges[0]!,...changed},...edges.slice(1)] as never}),/SQL live route binding/);
  }
});
