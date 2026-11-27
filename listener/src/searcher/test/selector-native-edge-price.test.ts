import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AbiCoder, FunctionFragment, Interface, id, keccak256, ZeroAddress } from "ethers";
import { compileEdgePriceLegs } from "../venues/selector-native-edge-price.js";
import { normalizeSelectorNativeExecutionDefinition as normalize } from "../venues/selector-native-definition.js";
import { selectSingleExecution } from "../venues/selector-program-role.js";
import { issueSqlFamilyAlternatives, materializeSqlLivePriceRoute } from "../venues/selector-native-sql-live-materializer.js";
import { issueSelectorCurrentSourceRoutes } from "../venues/selector-source-issued-route.js";
import { buildSqlEdgeLiveProducer } from "../sql-edge-live-producer.js";
import { sqlDirectionId } from "../sql-edge-price-index.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";

const weth="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",usdc="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",pool="0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const source={number:26378389,hash:"0x62b23cae3b410e09f24910f072a94e2a65b68917a91168dda8648e0d5375c618",generation:26378389};
const abi=AbiCoder.defaultAbiCoder(),sign=(s:string)=>id(s).slice(0,10);
function raw(id:string){return JSON.parse(readFileSync(new URL("../venues/selector-native/selector-"+id+"-family/selector-"+id+".json",import.meta.url),"utf8"));}
function example(id="24b31a0c"){
  const reads:string[]=[],data=new Map([["token0()","address",usdc],["token1()","address",weth],["fee()","uint24",500],["tickSpacing()","int24",10]]
    .map(([fn,t,v])=>[sign(String(fn)),abi.encode([String(t)],[v])]));const definition=normalize(raw(id));
  const input={edge:{selector:definition.selector,poolAddress:pool,tokenIn:weth,tokenOut:usdc},definition,source,executor:"0x"+"1".repeat(40),transactionOrigin:"0x"+"2".repeat(40),
    read:async(to:string,call:string)=>{assert.equal(to,pool);reads.push(call);assert(data.has(call));return data.get(call)!;}};
  return {input,reads,data};
}

test("captured pool reads survive JSON; the formal lifecycle rebuilds the paid address-pair program byte for byte",async()=>{
  const { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD:load }=await import("../venues/production-family-composition.js");
  const { FamilyCapabilityCatalog }=await import("../venues/family-capability-catalog.js");
  const { generatedCapabilityManifestFromShadowArtifact }=await import("../venues/family-capability-shadow.js");
  const shadow=(await import("../generated/family-capability-shadow.generated.json")).default;
  const all=[...load.plugins,...load.disabledPlugins];
  const catalog=new FamilyCapabilityCatalog({requireCapture:true,modules:all,generatedManifest:generatedCapabilityManifestFromShadowArtifact({artifact:shadow,strictFamilyIds:all.map(m=>m.familyId)})});
  const {input}=example("24b31a0c");
  const compiled=await compileEdgePriceLegs({...input,captureBinding:true,readCode:async()=>"0x6000"});
  assert.ok(compiled.legs.length,compiled.issues.join("; "));
  const beforePrice=await issueSqlFamilyAlternatives({...input,catalog,edge:{...input.edge,chainId:1},readCode:async()=>"0x6000"});
  assert.deepEqual(beforePrice.alternatives.map(l=>[l.programKey,l.program]),compiled.legs.map(l=>[l.programKey,l.program]));
  for(const trial of compiled.legs){
    const receipt=JSON.parse(JSON.stringify(trial.bindingReceipt!));
    const config={catalog,definition:input.definition,edge:{...input.edge,chainId:1},source,executor:input.executor,
      transactionOrigin:input.transactionOrigin,programKey:trial.programKey,receipt,expectedProgramHash:keccak256(trial.program)};
    const {instance,routeKey}=await materializeSqlLivePriceRoute(config);
    assert.equal(instance.routes.length,1);assert.equal(instance.routes[0]!.routeKey,routeKey);
    await assert.rejects(materializeSqlLivePriceRoute({...config,source:{...source,hash:"0x"+"f".repeat(64)}}));
    await assert.rejects(materializeSqlLivePriceRoute({...config,receipt:{...receipt,calls:[]}}));
    await assert.rejects(materializeSqlLivePriceRoute({...config,expectedProgramHash:"0x"+"f".repeat(64),receipt:{...receipt,programHash:"0x"+"f".repeat(64)}}));
  }
});

test("V4 binds a full manager pool ID, optional native side, and only its actual direction via identity-options/v1",async()=>{
  const {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG:catalog}=await import("../venues/production-family-composition.js");
  const definition=normalize(raw("48c89491")),manager="0x000000000004444c5dc75cb358380d2e3de08a90",
    registry="0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",executor="0x"+"1".repeat(40),transactionOrigin="0x"+"2".repeat(40);
  const singleProgram=selectSingleExecution(definition).program;
  for(const [a,b] of [[usdc,weth],[ZeroAddress,usdc]] as const){
    const value=abi.encode(["address","address","uint24","int24","address"],[a,b,500,10,ZeroAddress]),poolId=keccak256(value);
    for(const [tokenIn,tokenOut] of [[a,b],[b,a]]){
      const edge={chainId:1 as const,selector:definition.selector,poolAddress:manager,poolId,poolNamespace:"contract-pool-id",tokenIn:tokenIn!,tokenOut:tokenOut!};
      const reads:string[]=[],read=async(at:string,data:string)=>{assert.equal(at,registry);assert.equal(data,sign("poolKeys(bytes25)")+abi.encode(["bytes25"],[poolId.slice(0,52)]).slice(2));
        reads.push(data);return value;},readCode=async(at:string)=>{assert.equal(at,manager);return "0x6000";};
      const args={catalog,definition,source,edge,executor,transactionOrigin,read,readCode};
      const {alternatives,issues}=await issueSelectorCurrentSourceRoutes(args);
      assert.equal(alternatives.length,1,issues.join(";"));assert.equal(reads.length,1);
      const [issued]=alternatives;const r=issued!.instance.routes[0]!;
      assert.equal(r.executionAssets?.input,tokenIn===ZeroAddress?"native":"erc20");
      assert.equal(r.executionAssets?.output,tokenOut===ZeroAddress?"native":"erc20");
      assert.equal(issued!.routeKey,r.routeKey);assert.match(issued!.program,/^0x01/);
      const wrong=poolId.slice(0,-2)+(poolId.endsWith("ff")?"ee":"ff");
      const group=issued!.instance.pricingInstances[0]!,mut=catalog.forFamily(issued!.instance.familyId).plugin.pricing.mutation!;
      const events=new Interface(singleProgram.observations!.events.map((e:{signature:string})=>e.signature));
      const affected=(id:string)=>mut.affectedStateKeys({descriptor:group.pricingDescriptor,routes:group.routes,
        observation:{kind:"log",address:manager,...events.encodeEventLog("Swap",[id,executor,-12n,15n,10,25,-1,5])} as never});
      assert.deepEqual(affected(wrong),[],"an actual issued V4 route must not refresh on another logical pool's swap");
      assert.deepEqual(affected(poolId),[group.stateKey]);
      assert.equal((await issueSelectorCurrentSourceRoutes({...args,edge:{...edge,poolId:wrong}})).alternatives.length,0);
      const outage=Object.assign(Error("offline mocked rate limit"),{code:429});
      await assert.rejects(issueSelectorCurrentSourceRoutes({...args,read:async()=>{throw outage;}}),e=>e===outage);
      assert.equal((await issueSelectorCurrentSourceRoutes({...args,edge:{...edge,tokenOut:"0x"+"8".repeat(40)}})).alternatives.length,0);
    }
  }
});

test("a shared entry issues only the SQL direction proven by its registered pool and assets",async()=>{
  const {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG:catalog}=await import("../venues/production-family-composition.js");
  const definition=normalize(raw("52bbbe29")), vault="0xba12222222228d8ba445958a75a0704d566bf2c8";
  const poolId=pool+"0001"+"0".repeat(19)+"1", tokens=[usdc,weth,"0x"+"3".repeat(40)];
  const vaultAbi=new Interface(["function getPool(bytes32) view returns(address,uint8)","function getPoolTokens(bytes32) view returns(address[],uint256[],uint256)"]);
  const read=async(at:string,data:string)=>{
    if(at===vault){
      const tx=vaultAbi.parseTransaction({data});assert.equal(tx!.args[0],poolId);
      return tx!.name==="getPool"?vaultAbi.encodeFunctionResult("getPool",[pool,1]):
        vaultAbi.encodeFunctionResult("getPoolTokens",[tokens,[1,2,3],source.number]);
    }
    assert.ok(tokens.includes(at));assert.equal(data,sign("decimals()"));return abi.encode(["uint8"],[18]);
  };
  const args={definition,catalog,source,executor:"0x"+"1".repeat(40),transactionOrigin:"0x"+"2".repeat(40),read,readCode:async()=> "0x6000"};
  const edge={chainId:1,selector:definition.selector,poolAddress:vault,poolId,poolNamespace:"contract-pool-id",tokenIn:tokens[2]!,tokenOut:weth};
  const {alternatives,issues}=await issueSqlFamilyAlternatives({...args,edge});
  assert.equal(alternatives.length,1,issues.join("; "));
  assert.deepEqual(alternatives[0]!.instance.routes.map(r=>[r.tokenIn.toLowerCase(),r.tokenOut.toLowerCase()]),[[tokens[2],weth]]);
  assert.match(alternatives[0]!.program,/^0x01/);
  assert.equal((await issueSqlFamilyAlternatives({...args,edge:{...edge,tokenIn:"0x"+"9".repeat(40)}})).alternatives.length,0);
  const wrongPool=async(at:string,data:string)=>at===vault&&data.startsWith(sign("getPool(bytes32)"))
    ?vaultAbi.encodeFunctionResult("getPool",[tokens[2],1]):read(at,data);
  assert.equal((await issueSqlFamilyAlternatives({...args,edge,read:wrongPool})).alternatives.length,0);
});

test("single on-touch execution template refreshes on-touch rather than per-block",async()=>{
  const {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG:catalog}=await import("../venues/production-family-composition.js");
  const {input}=example("022c0d9f");
  const {alternatives,issues}=await issueSelectorCurrentSourceRoutes({...input,catalog,edge:{...input.edge,chainId:1},readCode:async()=>"0x6000"});
  assert.equal(alternatives.length,1,issues.join("; "));
  const issued=alternatives[0]!;
  const pricing=catalog.forFamily(issued.instance.familyId).plugin.pricing;
  for(const group of issued.instance.pricingInstances){
    const policy:string|undefined=pricing.refreshPolicyForInstance?.({descriptor:group.pricingDescriptor,routes:group.routes})??pricing.refreshPolicy;
    assert.equal(policy,"on-touch");
  }
  const edge={...input.edge,chainId:1 as const,poolId:null,poolNamespace:null,tokenInId:null,tokenOutId:null,candidateInstanceKey:""};
  edge.candidateInstanceKey=sqlDirectionId(edge);
  const funding=catalog.listAll().find(f=>f.plugin.manifest.domain==="funding")!.plugin.manifest;
  const {runtimeRoot:root,graph:[leg]}=buildSqlEdgeLiveProducer({edges:[edge],source,currentHead:source.number,
    swapTableSha256:"a".repeat(64),fundingTableSha256:"b".repeat(64),unavailable:[],
    fundingAssets:[{familyId:funding.familyId,asset:weth,binding:{chainId:1,provider:pool,asset:weth,selector:"0x12345678",signature:"synthetic()"}}],
    materialized:alternatives.map(a=>({...a,sqlEdgeKey:edge.candidateInstanceKey}))});
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys,[]);
  const family=catalog.forFamily(issued.instance.familyId);
  const routes=buildFamilyRouteGraphView({routes:issued.instance.routes.map((route,i)=>({family,route,descriptor:issued.instance.descriptor,handle:issued.instance.routeHandles[i]!}))}).routes;
  const variant=routes.find(({handle})=>handle.routeKey===issued.routeKey)!.edge.canonicalEdgeId;
  assert.equal(root.isOnTouchReceiptVariant(leg!,edge.candidateInstanceKey,variant),false);
  assert.equal(root.isOnTouchReceiptVariant(leg!,"another-state-key",variant),false);
  assert.equal(root.isOnTouchReceiptVariant({...leg!,tokenOut:leg!.tokenIn},edge.candidateInstanceKey,variant),false);
  assert.equal(root.isOnTouchReceiptVariant(leg!,edge.candidateInstanceKey,"foreign-variant"),false);
});

test("alternate ABI 24b31a0c compiles in both directions via compileEdgePriceLegs; source-owned 128acb08 compiles via issueSelectorCurrentSourceRoutes",async()=>{
  const out24:string[][]=[];
  for(const reverse of [false,true]){
    const {input,reads}=example("24b31a0c");
    if(reverse)[input.edge.tokenIn,input.edge.tokenOut]=[input.edge.tokenOut,input.edge.tokenIn];
    const r=await compileEdgePriceLegs(input);assert.deepEqual(r.issues,[]);assert.equal(r.legs.length,1);assert.equal(reads.length,2);
    out24.push(r.legs.map(l=>l.program));
  }
  assert.notDeepEqual(out24[0],out24[1]);

  const {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG:catalog}=await import("../venues/production-family-composition.js");
  const out128:string[][]=[];
  for(const reverse of [false,true]){
    const {input,reads}=example("128acb08");
    if(reverse)[input.edge.tokenIn,input.edge.tokenOut]=[input.edge.tokenOut,input.edge.tokenIn];
    const r=await issueSelectorCurrentSourceRoutes({...input,catalog,edge:{...input.edge,chainId:1},readCode:async()=>"0x6000"});
    assert.equal(r.alternatives.length,1,r.issues.join("; "));assert.equal(reads.length,2);
    out128.push(r.alternatives.map(l=>l.program));
  }
  assert.notDeepEqual(out128[0],out128[1]);
});

test("pre-read declines wrong identity, signed, shared, native, NFT, and an irrelevant authority getter",async()=>{
  for(const mod of [{selector:"0x12345678"},{poolId:"0x01"},{poolNamespace:"logical"},{tokenOutId:"0"},{tokenIn:ZeroAddress},{poolAddress:usdc}]){
    const {input,reads}=example("24b31a0c");const r=await compileEdgePriceLegs({...input,edge:{...input.edge,...mod}});assert.equal(r.legs.length,0);assert(r.issues.length);assert.deepEqual(reads,[]);
  }
  for(const tweak of [
    (p:any)=>{p.runtimeEvidence={};},
    (p:any)=>{p.routes.venue.kind="manager-pool-id";},
    (p:any)=>{p.binding.stateBinding={authority:{version:1,steps:[{}],result:{}}};},
    (p:any)=>{p.binding.flow.steps[0].requests[0].to="0x"+"9".repeat(40);},
    (p:any)=>{p.execution.steps[0].frame.call.target="$route.tokenOut";},
    (p:any)=>{p.execution.steps[0].frame.call.signature="function nope(bytes)";},
    (p:any)=>{p.routes.directions[0].fields.executionAssets={input:"native",output:"erc20"};},
    (p:any)=>{p.routes.directions[1].tokenOut=p.routes.directions[1].tokenIn;},
    (p:any)=>{const step=p.binding.flow.steps[0],alias="extra";p.values.abi[alias]=["function factory() view returns(address)"];step.requests.push({id:alias,kind:"eth-call",to:"$target",data:{op:"encode",args:[alias,"factory()",[]]},completion:"return-data"});},
  ]){
    const {input,reads}=example("24b31a0c"),doc=structuredClone(input.definition);tweak(doc.programs[0]);
    const r=await compileEdgePriceLegs({...input,definition:doc});assert.deepEqual(r.legs,[]);assert(r.issues.length);assert.deepEqual(reads,[],String(tweak));
  }
});

test("direction is independently obtained, noncanonical or missing getter words and transport failures fail closed",async()=>{
  const {input}=example("24b31a0c");const original=input.read;
  const a=await compileEdgePriceLegs({...input,edge:{...input.edge,tokenOut:"0x"+"3".repeat(40)}});assert.deepEqual(a.legs,[]);assert.equal(a.issues.length,1);
  for(const s of ["0x","0x"+"00".repeat(33),"0x"+"ff".repeat(12)+usdc.slice(2)]){
    const r=await compileEdgePriceLegs({...input,read:async(t,k)=>k===sign("token0()")?s:original(t,k)});assert.deepEqual(r.legs,[]);assert.equal(r.issues.length,1);
  }
  for(const error of [new Error("timeout"),Object.assign(new Error("execution reverted"),{code:"CALL_EXCEPTION",info:{payload:{method:"eth_call"},error:{code:429,message:"rate-limit"}}}),new Error("missing historical state")])
    await assert.rejects(compileEdgePriceLegs({...input,read:async()=>{throw error;}}),e=>e===error);
  await assert.rejects(compileEdgePriceLegs({...input,read:async()=>"not-hex"}),/invalid hex/);
});

test("frozen plans compile once, but each edge and source re-read fields, including after a getter revert",async(t)=>{
  const {input,reads}=example("24b31a0c");
  const parse=t.mock.method(FunctionFragment,"from");
  const parses=()=>parse.mock.calls.filter(x=>x.arguments[0]==="function token0() view returns(address)").length;
  const failed=await compileEdgePriceLegs({...input,read:async()=>{throw Object.assign(new Error("reverted"),{code:3});}});
  assert.equal(failed.legs.length,0);const first=parses();assert(first>=1);
  const good=await compileEdgePriceLegs(input);assert.equal(good.legs.length,1);assert.equal(reads.length,2);assert.equal(parses(),first);
  const next=await compileEdgePriceLegs({...input,source:{...source,number:source.number+1,hash:"0x"+"55".repeat(32)},edge:{...input.edge,tokenIn:"0x"+"9".repeat(40)}});
  assert.equal(next.legs.length,0);assert.equal(reads.length,4);assert.equal(parses(),first);
});

test("a frozen outer fixture with mutable nested routes does not retain positive or negative results or fingerprint",async()=>{
  const {input}=example("24b31a0c"),fixture=Object.freeze(structuredClone(input.definition)),p=fixture.programs[0]!;
  Object.freeze(fixture.programs);Object.freeze(p);
  const call=()=>compileEdgePriceLegs({...input,definition:fixture});
  const first=await call();assert.equal(first.legs.length,1);
  const d=(p.routes!.directions as Record<string,any>[])[0]!;
  d.fields.executionAssets={input:"native",output:"erc20"};
  const invalid=await call();assert.deepEqual(invalid.legs,[]);assert(!invalid.issues[0]!.startsWith(first.legs[0]!.programKey+":"));
  delete d.fields.executionAssets;
  assert.deepEqual(await call(),first);
});
