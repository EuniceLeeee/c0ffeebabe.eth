import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AbiCoder,FunctionFragment,Interface,JsonRpcProvider,id} from "ethers";
import {loadBotVmRuntimeCode} from "../../shared/executor/botvm-executor.js";
import {initializeSqlLiveProducer} from "../sql-live-intake.js";
import {sqlSelectorModules} from "../sql-edge-live-producer.js";
import {sealSqlLiveInput} from "../sql-live-input-cli.js";
import {loadLiveSqlTables} from "../sql-live-tables.js";
import {RethTransportScheduler} from "../reth-transport-scheduler.js";
import {selectorFundingInstanceKey} from "../venues/selector-native-funding-definition.js";
import {selectorAssetOfferKey} from "../venues/selector-execution-keys.js";
import {compileSqlExecutionParamPlan} from "../venues/selector-native-execution-param-plan.js";
import {isEnabledSqlExecutionLeg} from "../sql-execution-selectors.js";
import {sqlSelectorRepresentatives,assertSqlSourcePricePublication} from "../sql-selector-startup-check.js";
import {guardSqlSelectedAuthority} from "../sql-live-selected-authority.js";
import {createBlockScanPriceRuntime,resolveBlockScanCoreConfig} from "../main.js";
import {createBlockScanStartupExecutionPreflight} from "../blockscan-startup-execution-preflight.js";
import {effectiveHistoricalRankingHint} from "../blockscan-effective-mid.js";
import {BlockScanSimRejectCache} from "../blockscan-sim-reject-cache.js";
import {readBlockTouchedStateKeys} from "../blockscan-touched-state.js";
import type {StartupNodeSimulation,StartupNodeInvocation} from "../blockscan-startup-node-simulation.js";
import type {SqlPriceEdge} from "../sql-edge-price-index.js";

const addr=(n:string)=>"0x"+n.repeat(40), hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const identity={executor:addr("1"),transactionOrigin:addr("2")}, cutoff="0x"+"ab".repeat(32), head="0x"+"bc".repeat(32);
const weth="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",usdc="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",pool=addr("3");
const scheduler=()=>new RethTransportScheduler({capacity:4,producerReserved:1});
const args={currentHead:102,expectedHeadHash:head,rpcUrl:"http://127.0.0.1:1",executionIdentity:identity,signal:new AbortController().signal};
async function makeFiles(){
  const dir=await mkdtemp(join(tmpdir(),"sql-raw-input-"));
  const off=[...sqlSelectorModules.values()].find(m=>!m.activation.enabled && m.definition.domain==="swap")!;
  const m=sqlSelectorModules.get("0x128acb08")!;assert(isEnabledSqlExecutionLeg(m));
  const ev={consensus:"uniform",definitionSha256:hash(JSON.stringify(m.definition)),txHash:head,callPath:"",innerSwapPath:null,
    recipes:compileSqlExecutionParamPlan(m.definition).recipes.map(({index,requirements})=>({index,missing:[],observed:requirements.flatMap(r=>
      r.sources.some(s=>s.kind==="direction-asset")?[{key:r.key,kind:"direction-asset",value:r.key==="descriptor.token0"?usdc:weth}]:[])}))};
  const records=[["0x128acb08",weth,usdc],["0x128acb08",usdc,weth],["0x01020304",weth,usdc],
    [off.definition.selector,weth,usdc],["0x128acb08",weth,usdc,"31"],["0x91dd7346",weth,usdc]].map(([selector,tokenIn,tokenOut,id],i)=>{
    const poolAddress=i===1?addr("4"):pool;
    const coords=["1",selector,poolAddress,null,null,tokenIn,id??null,tokenOut,null];
    return {candidateInstanceKey:"candidate-edge:v1:"+hash(JSON.stringify(coords)),chainId:1,selector,poolAddress,poolId:null,poolNamespace:null,
      tokenIn,tokenOut,tokenInId:id??null,tokenOutId:null,...(i<2?{executionParamEvidence:ev}:{})};
  });
  const body=records.map(r=>JSON.stringify(r)).join("\n")+"\n";await writeFile(join(dir,"rows"),body);
  const manifest=join(dir,"m.json"),funding=join(dir,"f.json"),out=join(dir,"seal.json");
  const meta={format:"ready-fixed-edges/v1",edgeSha256:hash(body),cutoffHash:cutoff,fromBlock:100,toBlock:101,rows:records.length,edgeFile:"rows"};
  await writeFile(manifest,JSON.stringify(meta));
  const sig="function flashLoan(address,uint256,bytes)",abi=new Interface([sig]),sel=FunctionFragment.from(sig).selector;
  const input=abi.encodeFunctionData(sel,[weth,1,"0x"]), provider=addr("8");
  const row={offerKey:selectorAssetOfferKey(selectorFundingInstanceKey({chainId:1,provider,asset:weth,selector:sel,signature:sig}),{address:weth}),
    provider,selector:sel,asset:weth,input,callback:FunctionFragment.from("function onMorphoFlashLoan(uint256,bytes)").selector,block_number:101,
    block_hash:cutoff,tx_hash:head,transaction_index:0,trace_address:"",callback_path:"0",observations:1};
  const fund={format:"sql-live-funding/v1",chainId:1,window:{fromBlock:100,toBlock:101,headHash:cutoff},
    sourceCoverage:{firstBlock:"100",lastBlock:"101",head:cutoff,transactions:"2",distinctTx:"2",activeHashes:"2",missingTraces:"0"},rows:[row],failures:[]};
  await writeFile(funding,JSON.stringify(fund));
  const receipt=await sealSqlLiveInput({manifest,funding,out});
  return {dir,out,receipt,records,manifest,funding,fund,meta,env:{SEARCHER_DRY_RUN:"1",SEARCHER_SQL_LIVE_INPUT_PATH:out,SEARCHER_SQL_LIVE_INPUT_SHA256:receipt.sha256}};
}
function chain(headers:unknown[][],orphanHead=false){
  return {async send(method:string,params:unknown[]){
    if(method==="eth_chainId")return "0x1";
    assert.equal(method,"eth_getBlockByNumber");headers.push(params);const [tag,full]=params;assert.equal(full,false);
    return {number:tag,hash:tag==="0x65"?cutoff:(orphanHead&&headers.length>=4?cutoff:head)};
  }};
}
test("old Ready is not a source and cannot trigger RPC",async()=>{
  let reads=0;
  await assert.rejects(initializeSqlLiveProducer({...args,env:{SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH:"old-ready.json"},
    provider:{async send(){reads++;return null;}}}),/requires SEARCHER_SQL_LIVE_INPUT_PATH/);
  assert.equal(reads,0);
});
test("only a digest-bound pair of raw SQL inputs can be sealed; no price or paid-row fallback",async()=>{
  const {out,receipt,manifest,meta,funding,fund,dir}=await makeFiles();
  assert.equal((await loadLiveSqlTables(out,receipt.sha256)).edges.length,6);
  await assert.rejects(sealSqlLiveInput({out,manifest,funding}),/EEXIST/);
  const raw=JSON.parse(await readFile(out,"utf8"));
  for(const bad of [{...raw,format:"sql-live-input/v1"},{...raw,pricesDir:"prior"},{...raw,swaps:{...raw.swaps,pricesDir:"prior"}},
    {...raw,swaps:{...raw.swaps,edgeSha256:"f".repeat(64)}}]){
    const text=JSON.stringify(bad),p=join(dir,"reject.json");await writeFile(p,text);await assert.rejects(loadLiveSqlTables(p,hash(text)));
  }
  await writeFile(funding,JSON.stringify({...fund,window:{...fund.window,toBlock:100}}));
  await assert.rejects(loadLiveSqlTables(out,receipt.sha256),/content differs/);
  await assert.rejects(sealSqlLiveInput({out:join(dir,"mixed.json"),manifest,funding}),/windows differ/);
  await writeFile(manifest,JSON.stringify({...meta,edgeSha256:"e".repeat(64)}));
  await assert.rejects(loadLiveSqlTables(out,receipt.sha256),/content differs/);
});
test("SQL startup projects candidate topology with zero RPC, then binds reachable pools lazily via guardSqlSelectedAuthority",async t=>{
  const {env,records}=await makeFiles(), blob=loadBotVmRuntimeCode(identity.transactionOrigin).code;
  const sample=sqlSelectorRepresentatives(records as SqlPriceEdge[])[0]!,other=records.slice(0,2).find(e=>e.poolAddress!==sample.poolAddress)!;
  const abi=AbiCoder.defaultAbiCoder(),field=new Map([["token0()","address",usdc],["token1()","address",weth]]
    .map(([s,type,value])=>[id(String(s)).slice(0,10),abi.encode([String(type)],[value])]));
  const wires:any[][]=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const batch=JSON.parse(Buffer.concat(chunks).toString("utf8"));wires.push(batch);
    const rows=batch.map((q:any)=>{
      if(q.method==="eth_getCode")return {id:q.id,jsonrpc:"2.0",result:"0x6000"};
      assert.equal(q.method,"eth_call");assert(field.has(q.params[0].data));
      return {id:q.id,jsonrpc:"2.0",result:field.get(q.params[0].data)};
    });
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(rows));
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const where=server.address();assert(where&&typeof where==="object");const rpcUrl="http://127.0.0.1:"+where.port;
  const headers:unknown[][]=[];
  const input={...args,env,rpcUrl,scheduler:scheduler(),provider:chain(headers),configuredRuntimeCode:blob};
  const r=await initializeSqlLiveProducer(input);
  assert.deepEqual(headers.map(x=>x[0]),["0x65","0x66","0x65","0x66"]);
  assert.equal(r.lineage.cutoffNumber,102);assert.equal(r.lineage.appliedThroughHash,head);
  assert.equal(r.inputSummary.trialDirections,2);assert.equal(r.inputSummary.boundDirections,0);
  assert.equal(r.inputSummary.privateRecipes,0);assert.equal(r.sqlSelectorSamples.length,1);
  assert.equal(r.sqlSelectorSamples[0]!.edgeId,sample.candidateInstanceKey);assert.equal(wires.length,0);
  const invocations:StartupNodeInvocation[]=[],p=2000000000000000n;
  const simulate=Object.assign(async(q:StartupNodeInvocation)=>{
    invocations.push(q);assert.equal(q.amount,p);
    const receipts=[{hop:-1,amountIn:p,amountOut:p,amountSpent:p}];let n=p;
    for(const [hop,leg] of q.legs.entries()){assert.match(leg.program,/^0x01/);
      receipts.push({hop,amountIn:n,amountOut:n*2n,amountSpent:n});n*=2n;}
    return {kind:"success" as const,receipts,returnData:"0x",gasUsed:1n,targetBlock:q.source.number+1,scriptHash:head,
      inputFundingMode:"native-prefix" as const,simulationMs:1,nodeQueueMs:0};
  },{stats:()=>({requests:invocations.length,retries:0,simulations:invocations.length,headers:1,maxCuIn1000Ms:1})}) as StartupNodeSimulation;
  let publishedFlag=false;
  const {currentRuntimeCoordinator,strictSessionFor}=createBlockScanPriceRuntime({provider:new JsonRpcProvider(rpcUrl),rpcUrl,...identity,
    strictRuntimeRoot:r.runtimeRoot,blockScanRuntimeAbort:new AbortController(),blockScanCfg:resolveBlockScanCoreConfig({}),
    fixedEffectiveWethInput:p,sqlStartupTrials:r.trials,isPoolSimRejected:()=>false,recordPricing:()=>{publishedFlag=true;},
    selectedAuthority:guardSqlSelectedAuthority({published:()=>publishedFlag,issue:r.selectedAuthority}),
    checkStartupPrices:(snap,es)=>{if(!publishedFlag)assertSqlSourcePricePublication(snap,es);},
    startupExecutionPreflight:createBlockScanStartupExecutionPreflight({...identity,simRejects:new BlockScanSimRejectCache(),
      simulateStandalone:simulate,concurrency:2})});
  const state={number:102,hash:head,generation:102};
  await assert.rejects(async()=>strictSessionFor({source:state,purpose:"exact-execution",requiredEdgeIds:new Set([other.candidateInstanceKey]),fundingAssets:[]}),
    /SQL execution blocked until a complete usable price table is published/);
  const graph=r.graphViewCoordinator.build({id:"price-test",generation:103,sourceBlock:103,sourceBlockHash:cutoff,topologyKey:r.topologyKey,edges:r.graph});
  const published=await currentRuntimeCoordinator.prepareCoarsePricing({graph,deadlineAtMs:Date.now()+30000,
    pricingCallBackend:{call:async()=>assert.fail("unexpected coarse getter")}});
  for(const e of records.slice(0,2))assert.equal(published.snapshot?.effectiveMids?.rows.get(e.candidateInstanceKey)?.status,"quoted");
  assert.equal(wires.length,0,"0-RPC direct execution must make zero identity/getCode RPC calls");
  assert.deepEqual(invocations.map(q=>q.legs.length),[1,2]);
  assert.deepEqual(r.runtimeRoot.pricingIndex().perBlockRefreshStateKeys,[]);
  for(const edgeObj of r.graph){
    const row=published.snapshot!.effectiveMids!.rows.get(edgeObj.canonicalEdgeId!)!;
    assert.match(row.executionVerification?.variantId??"",/^sql-source-template:/);
    assert.equal(r.runtimeRoot.ownsSqlMarketVariant(edgeObj,row.executionVerification!.variantId!),true);
  }
  const b104="0x"+"cd".repeat(32),b105="0x"+"de".repeat(32),v4Mgr="0x000000000004444c5dc75cb358380d2e3de08a90";
  const touched104=await readBlockTouchedStateKeys({getLogs:async()=>[],send:async()=>{throw Error("offline");}},
    104,v4Mgr,{hash:b104,parentHash:cutoff,transactionHashes:[],passiveTouchedAddresses:[]},
    {previousSource:{number:103,hash:cutoff},readHeader:async()=>{throw Error("no header");}},r.runtimeRoot.resolveBlockTouchedStateKeys,{mode:"logs"});
  const graph104=r.graphViewCoordinator.build({id:"price-104",generation:104,sourceBlock:104,sourceBlockHash:b104,topologyKey:r.topologyKey,edges:r.graph});
  const pub104=await currentRuntimeCoordinator.prepareCoarsePricing({graph:graph104,deadlineAtMs:Date.now()+30000,
    pricingCallBackend:{call:async()=>assert.fail("unexpected coarse getter")},
    canonicalActivity:{source:{number:104,hash:b104,generation:104},parentHash:cutoff,previousSource:{number:103,hash:cutoff},touchedStateKeys:touched104,complete:true}});
  assert.equal(invocations.length,2,"untouched block must carry lazy source prices with zero simulations");
  for(const edgeObj of pub104.snapshot!.graph.edges)assert.ok(effectiveHistoricalRankingHint(pub104.snapshot!.effectiveMids!,edgeObj),"untouched lazy source direction retains historical ranking hint");
  const touched105=await readBlockTouchedStateKeys({getLogs:async()=>[{address:other.poolAddress,topics:[id("Swap(address,address,int256,int256,uint160,uint128,int24)")],data:"0x",blockHash:b105}],send:async()=>{throw Error("offline");}},
    105,v4Mgr,{hash:b105,parentHash:b104,transactionHashes:[],passiveTouchedAddresses:[]},
    {previousSource:{number:104,hash:b104},readHeader:async()=>{throw Error("no header");}},r.runtimeRoot.resolveBlockTouchedStateKeys,{mode:"logs"});
  const graph105=r.graphViewCoordinator.build({id:"price-105",generation:105,sourceBlock:105,sourceBlockHash:b105,topologyKey:r.topologyKey,edges:r.graph});
  const pub105=await currentRuntimeCoordinator.prepareCoarsePricing({graph:graph105,deadlineAtMs:Date.now()+30000,
    pricingCallBackend:{call:async()=>assert.fail("unexpected coarse getter")},
    canonicalActivity:{source:{number:105,hash:b105,generation:105},parentHash:b104,previousSource:{number:104,hash:b104},touchedStateKeys:touched105,complete:true}});
  assert.equal(invocations.length,3,"touching one pool refreshes only that pool, not untouched pools");
  assert.equal(pub105.snapshot?.effectiveMids?.rows.get(other.candidateInstanceKey)?.status,"quoted");
  const visible=[0,1].map(i=>records[i]!.candidateInstanceKey);
  assert.deepEqual(r.graph.map(e=>e.canonicalEdgeId),visible);
  assert.deepEqual(r.unavailable.map(e=>e.sqlEdgeKey),[2,3,4,5].map(i=>records[i]!.candidateInstanceKey));
  assert.equal(r.graphViewCoordinator.build({id:"head",generation:103,sourceBlock:103,sourceBlockHash:cutoff,topologyKey:r.topologyKey,edges:r.graph}).scannerEdgeCount,2);
  const selected=await strictSessionFor({source:state,purpose:"exact-execution",requiredEdgeIds:new Set([other.candidateInstanceKey]),fundingAssets:[]});
  const legEdge=r.graph.find(e=>e.canonicalEdgeId===other.candidateInstanceKey)!;
  const variantIds=selected.executionVariantIds(legEdge);
  assert.equal(variantIds.length,1);
  assert.match(selected.buildRuntimeAmountLeg({edge:legEdge,variantId:variantIds[0]!,executor:identity.executor,runtimeEvidence:[]})?.program??"",/^0x01/);
  await assert.rejects(initializeSqlLiveProducer({...input,env:{...env,SEARCHER_BLOCKSCAN_SUBMIT:"1"}}),/override is dry-run only/);
  await assert.rejects(initializeSqlLiveProducer({...input,provider:chain([],true)}),/source is not canonical/);
});
