import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AbiCoder, FunctionFragment, Interface, id, ZeroAddress } from "ethers";
import { compileEdgePriceLegs } from "../venues/selector-native-edge-price.js";
import { normalizeSelectorNativeExecutionDefinition as normalize, selectorNativeProgramKey } from "../venues/selector-native-definition.js";
import { issueSqlFamilyAlternatives,materializeSqlLivePriceRoute } from "../venues/selector-native-sql-live-materializer.js";
import { keccak256 } from "ethers";
import { buildSqlEdgeLiveProducer } from "../sql-edge-live-producer.js";
import { sqlDirectionId } from "../sql-edge-price-index.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";

test("captured pool reads survive JSON; the formal lifecycle rebuilds the paid address-pair program byte for byte",async()=>{
  const { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG:catalog }=await import("../venues/production-family-composition.js");
  for(const selector of ["128acb08","022c0d9f"]){
    const {input}=example(selector);
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
  }
});

const weth="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",usdc="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",pool="0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const source={number:26378389,hash:"0x62b23cae3b410e09f24910f072a94e2a65b68917a91168dda8648e0d5375c618",generation:26378389};
const abi=AbiCoder.defaultAbiCoder(),sign=(s:string)=>id(s).slice(0,10);
test("the Family binds a full manager pool ID, optional native side, and only its actual direction before any funded trial",async()=>{
  const {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG:catalog}=await import("../venues/production-family-composition.js");
  const definition=normalize(raw("48c89491")),manager="0x000000000004444c5dc75cb358380d2e3de08a90",
    registry="0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e",executor="0x"+"1".repeat(40),transactionOrigin="0x"+"2".repeat(40);
  for(const [a,b] of [[usdc,weth],[ZeroAddress,usdc]] as const){
    const value=abi.encode(["address","address","uint24","int24","address"],[a,b,500,10,ZeroAddress]),poolId=keccak256(value);
    for(const [tokenIn,tokenOut] of [[a,b],[b,a]]){
      const edge={chainId:1,selector:definition.selector,poolAddress:manager,poolId,poolNamespace:"contract-pool-id",tokenIn:tokenIn!,tokenOut:tokenOut!};
      const reads:string[]=[],read=async(at:string,data:string)=>{assert.equal(at,registry);assert.equal(data,sign("poolKeys(bytes25)")+abi.encode(["bytes25"],[poolId.slice(0,52)]).slice(2));
        reads.push(data);return value;},readCode=async(at:string)=>{assert.equal(at,manager);return "0x6000";};
      const args={catalog,definition,source,edge,executor,transactionOrigin,read,readCode};
      const {alternatives,issues}=await issueSqlFamilyAlternatives(args);
      assert.equal(alternatives.length,1,issues.join(";"));assert.equal(reads.length,1);assert.equal(issues.length,2);
      const [issued]=alternatives;const r=issued!.instance.routes[0]!;
      assert.equal(r.executionAssets?.input,tokenIn===ZeroAddress?"native":"erc20");
      assert.equal(r.executionAssets?.output,tokenOut===ZeroAddress?"native":"erc20");
      assert.equal(issued!.routeKey,r.routeKey);assert.match(issued!.program,/^0x01/);
      const wrong=poolId.slice(0,-2)+(poolId.endsWith("ff")?"ee":"ff"); // first 25 bytes still match
      const group=issued!.instance.pricingInstances[0]!,mut=catalog.forFamily(issued!.instance.familyId).plugin.pricing.mutation!;
      const events=new Interface(definition.programs[0]!.observations!.events.map((e:{signature:string})=>e.signature));
      const affected=(id:string)=>mut.affectedStateKeys({descriptor:group.pricingDescriptor,routes:group.routes,
        observation:{kind:"log",address:manager,...events.encodeEventLog("Swap",[id,executor,-12n,15n,10,25,-1,5])} as never});
      assert.deepEqual(affected(wrong),[],"an actual issued V4 route must not refresh on another logical pool's swap");
      assert.deepEqual(affected(poolId),[group.stateKey]);
      assert.equal((await issueSqlFamilyAlternatives({...args,edge:{...edge,poolId:wrong}})).alternatives.length,0);
      const outage=Object.assign(Error("offline mocked rate limit"),{code:429});
      await assert.rejects(issueSqlFamilyAlternatives({...args,read:async()=>{throw outage;}}),e=>e===outage);
      assert.equal((await issueSqlFamilyAlternatives({...args,edge:{...edge,tokenOut:"0x"+"8".repeat(40)}})).alternatives.length,0);
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
function raw(id:string){return JSON.parse(readFileSync(new URL("../venues/selector-native/selector-"+id+"-family/selector-"+id+".json",import.meta.url),"utf8"));}
function example(id="128acb08"){
  const reads:string[]=[],data=new Map([["token0()","address",usdc],["token1()","address",weth],["fee()","uint24",500],["tickSpacing()","int24",10]]
    .map(([fn,t,v])=>[sign(String(fn)),abi.encode([String(t)],[v])]));const definition=normalize(raw(id));
  const input={edge:{selector:definition.selector,poolAddress:pool,tokenIn:weth,tokenOut:usdc},definition,source,executor:"0x"+"1".repeat(40),transactionOrigin:"0x"+"2".repeat(40),
    read:async(to:string,call:string)=>{assert.equal(to,pool);reads.push(call);assert(data.has(call));return data.get(call)!;}};
  return {input,reads,data};
}
test("mixed selector refreshes only its actual each-block recipes; a mixed public leg stays conservative",async()=>{
  const {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG:catalog}=await import("../venues/production-family-composition.js");
  const {input}=example("022c0d9f");
  const {alternatives}=await issueSqlFamilyAlternatives({...input,catalog,edge:{...input.edge,chainId:1},readCode:async()=>"0x6000"});
  const policies=new Set<string>();
  const onTouch=new Set<string>();
  for(const a of alternatives){
    const recipe=input.definition.programs.find(p=>selectorNativeProgramKey(p)===a.programKey)!;
    const pricing=catalog.forFamily(a.instance.familyId).plugin.pricing;
    assert.equal(pricing.refreshPolicy,"each-block","selector-wide fallback");
    for(const group of a.instance.pricingInstances){
      const policy=pricing.refreshPolicyForInstance?.({descriptor:group.pricingDescriptor,routes:group.routes})??pricing.refreshPolicy;
      assert.equal(policy,recipe.refreshPolicy);
      policies.add(policy!);
      if(policy==="on-touch")onTouch.add(a.programKey);
    }
  }
  assert.deepEqual([...policies].sort(),["each-block","on-touch"]);
  const edge={...input.edge,chainId:1 as const,poolId:null,poolNamespace:null,tokenInId:null,tokenOutId:null,
    candidateInstanceKey:""};
  edge.candidateInstanceKey=sqlDirectionId(edge);
  const funding=catalog.listAll().find(f=>f.plugin.manifest.domain==="funding")!.plugin.manifest;
  const publish=(routes:typeof alternatives)=>buildSqlEdgeLiveProducer({edges:[edge],source,currentHead:source.number,
    swapTableSha256:"a".repeat(64),fundingTableSha256:"b".repeat(64),unavailable:[],
    fundingAssets:[{familyId:funding.familyId,asset:weth,binding:{chainId:1,provider:pool,asset:weth,selector:"0x12345678",signature:"synthetic()"}}],
    materialized:routes.map(a=>({...a,sqlEdgeKey:edge.candidateInstanceKey}))});
  const {runtimeRoot:root,graph:[leg]}=publish(alternatives);
  assert.deepEqual(root.pricingIndex().perBlockRefreshStateKeys,[edge.candidateInstanceKey]);
  assert.deepEqual(publish(alternatives.filter(a=>onTouch.has(a.programKey))).runtimeRoot.pricingIndex().perBlockRefreshStateKeys,[]);
  for(const {instance,programKey,routeKey} of alternatives){
    const family=catalog.forFamily(instance.familyId);
    const routes=buildFamilyRouteGraphView({routes:instance.routes.map((route,i)=>({family, route,descriptor:instance.descriptor,handle:instance.routeHandles[i]!}))}).routes;
    const variant=routes.find(({handle})=>handle.routeKey===routeKey)!.edge.canonicalEdgeId;
    assert.equal(root.isOnTouchReceiptVariant(leg!,edge.candidateInstanceKey,variant),onTouch.has(programKey));
    assert.equal(root.isOnTouchReceiptVariant(leg!,"another-state-key",variant),false);
    assert.equal(root.isOnTouchReceiptVariant({...leg!,tokenOut:leg!.tokenIn},edge.candidateInstanceKey,variant),false);
  }
  assert.equal(root.isOnTouchReceiptVariant(leg!,edge.candidateInstanceKey,"foreign-variant"),false);
});
test("both callback recipes of 128acb08 and alternate ABI 24b31a0c compile in both directions; no membership read",async()=>{
  for(const [id,recipes,count] of [["128acb08",2,4],["24b31a0c",1,2]] as const){
    const out:string[][]=[];
    for(const reverse of [false,true]){
      const {input,reads}=example(id);
      if(reverse)[input.edge.tokenIn,input.edge.tokenOut]=[input.edge.tokenOut,input.edge.tokenIn];
      const r=await compileEdgePriceLegs(input);assert.deepEqual(r.issues,[]);assert.equal(r.legs.length,recipes);assert.equal(reads.length,count);
      assert.equal(new Set(r.legs.map(l=>l.programKey)).size,recipes);assert.ok(r.legs.every(l=>/^0x(?:[0-9a-f]{2})+$/.test(l.program)));
      out.push(r.legs.map(l=>l.program));
    }
    assert.notDeepEqual(out[0],out[1]);
  }
});
test("pre-read declines wrong identity, signed, shared, native, NFT, and an irrelevant authority getter",async()=>{
  for(const mod of [{selector:"0x12345678"},{poolId:"0x01"},{poolNamespace:"logical"},{tokenOutId:"0"},{tokenIn:ZeroAddress},{poolAddress:usdc}]){
    const {input,reads}=example();const r=await compileEdgePriceLegs({...input,edge:{...input.edge,...mod}});assert.equal(r.legs.length,0);assert(r.issues.length);assert.deepEqual(reads,[]);
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
test("direction is independently obtained, noncanonical or missing getter words and distinct template reverts are not quotes",async()=>{
  const {input,data}=example();const original=input.read;
  const a=await compileEdgePriceLegs({...input,edge:{...input.edge,tokenOut:"0x"+"3".repeat(40)}});assert.deepEqual(a.legs,[]);assert.equal(a.issues.length,2);
  for(const s of ["0x","0x"+"00".repeat(33),"0x"+"ff".repeat(12)+usdc.slice(2)]){
    const r=await compileEdgePriceLegs({...input,read:async(t,k)=>k===sign("token0()")?s:original(t,k)});assert.deepEqual(r.legs,[]);assert.equal(r.issues.length,2);
  }
  const r=await compileEdgePriceLegs({...input,read:async(t,k)=>{
    if(k===sign("fee()"))throw Object.assign(Error("execution reverted"),{code:3,data:"0x"});return original(t,k);}});
  assert.equal(r.legs.length,1);assert.equal(r.issues.length,1);assert.match(r.issues[0]!,/getter reverted/);
  data.set(sign("tickSpacing()"),abi.encode(["int24"],[0]));
  const badSpacing=await compileEdgePriceLegs(input);assert.equal(badSpacing.legs.length,1);assert.equal(badSpacing.issues.length,1);
});
test("a timeout, throttled ethers wrapper, unknown transport or malformed provider response fails the whole operation",async()=>{
  const {input}=example();
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
test("declarative pair programs retain alternative fees and in-VM quotes, and read only the two observed tokens' runtime code",async()=>{
  for(const rev of [false,true]){
    const {input,reads}=example("022c0d9f"),codes:string[]=[];
    if(rev)[input.edge.tokenIn,input.edge.tokenOut]=[input.edge.tokenOut,input.edge.tokenIn];
    const r=await compileEdgePriceLegs({...input,readCode:async(t)=>{codes.push(t);return "0x6000";}});
    assert.equal(r.legs.length,4,r.issues.join("; "));
    assert.equal(new Set(r.legs.map(l=>l.programKey)).size,4);assert.equal(new Set(r.legs.map(l=>l.program)).size,4);
    assert.equal(r.issues.length,1);assert.deepEqual(reads.sort(),[sign("token0()"),sign("token1()")].sort());
    assert.deepEqual(codes.sort(),[usdc,weth].sort());
  }
});
test("code for a pool, authority, mismatching tokens, or transport failures are never treated as transfer semantics",async()=>{
  const {input,reads}=example("022c0d9f");
  const missing=await compileEdgePriceLegs(input);assert.equal(missing.legs.length,0);assert.equal(reads.length,0);
  const bad=await compileEdgePriceLegs({...input,edge:{...input.edge,tokenOut:"0x"+"8".repeat(40)},readCode:async()=>{throw Error("unexpected code read");}});
  assert.deepEqual(bad.legs,[]);
  const empty=await compileEdgePriceLegs({...input,readCode:async()=>"0x"});assert.deepEqual(empty.legs,[]);
  const failure=Error("socket offline");
  await assert.rejects(compileEdgePriceLegs({...input,readCode:async()=>{throw failure;}}),e=>e===failure);
  const doc=structuredClone(input.definition);for(const p of doc.programs.slice(1)){p.binding!.flow!.steps[1].requests[0].address="$target";}
  const badTarget=await compileEdgePriceLegs({...input,definition:doc,readCode:async()=>{throw Error("unexpected code read");}});
  assert.deepEqual(badTarget.legs,[]);assert(badTarget.issues.some(m=>m.includes("code target")));
});
