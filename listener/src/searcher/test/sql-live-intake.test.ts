import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {AbiCoder,FunctionFragment,Interface,id} from "ethers";
import {loadBotVmRuntimeCode} from "../../shared/executor/botvm-executor.js";
import {initializeSqlLiveProducer} from "../sql-live-intake.js";
import {sqlSelectorModules} from "../sql-edge-live-producer.js";
import {sealSqlLiveInput} from "../sql-live-input-cli.js";
import {loadLiveSqlTables} from "../sql-live-tables.js";
import {RethTransportScheduler} from "../reth-transport-scheduler.js";
import {selectorFundingInstanceKey} from "../venues/selector-native-funding-definition.js";
import {selectorAssetOfferKey} from "../venues/selector-execution-keys.js";

const addr=(n:string)=>"0x"+n.repeat(40), hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const identity={executor:addr("1"),transactionOrigin:addr("2")}, cutoff="0x"+"ab".repeat(32), head="0x"+"bc".repeat(32);
const weth="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",usdc="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",pool=addr("3");
const scheduler=()=>new RethTransportScheduler({capacity:4,producerReserved:1});
const args={currentHead:102,expectedHeadHash:head,rpcUrl:"http://127.0.0.1:1",executionIdentity:identity,signal:new AbortController().signal};
async function makeFiles(){
  const dir=await mkdtemp(join(tmpdir(),"sql-raw-input-"));
  const off=[...sqlSelectorModules.values()].find(m=>!m.activation.enabled && m.definition.domain==="swap")!;
  const records=[["0x128acb08",weth,usdc],["0x128acb08",usdc,weth],["0x01020304",weth,usdc],
    [off.definition.selector,weth,usdc],["0x128acb08",weth,usdc,"31"],["0x91dd7346",weth,usdc]].map(([selector,tokenIn,tokenOut,id])=>{
    const coords=["1",selector,pool,null,null,tokenIn,id??null,tokenOut,null];
    return {candidateInstanceKey:"candidate-edge:v1:"+hash(JSON.stringify(coords)),chainId:1,selector,poolAddress:pool,poolId:null,poolNamespace:null,
      tokenIn,tokenOut,tokenInId:id??null,tokenOutId:null};
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
test("raw edges reach the real issuer using canonical batched getters/code, not simulated or pre-priced rows",async t=>{
  const {env,records}=await makeFiles(), blob=loadBotVmRuntimeCode(identity.transactionOrigin).code;
  const abi=AbiCoder.defaultAbiCoder(),field=new Map([["token0()","address",usdc],["token1()","address",weth],["fee()","uint24",500],["tickSpacing()","int24",10]]
    .map(([s,type,value])=>[id(String(s)).slice(0,10),abi.encode([String(type)],[value])]));
  let broken=false; const wires:any[][]=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const batch=JSON.parse(Buffer.concat(chunks).toString("utf8"));wires.push(batch);
    const rows=batch.map((q:any)=>{
      assert.deepEqual(q.params[1],{blockHash:head,requireCanonical:true});
      if(q.method==="eth_getCode")return {id:q.id,jsonrpc:"2.0",result:"0x6000"};
      assert.equal(q.method,"eth_call");assert.equal(q.params[0].to,pool);assert(field.has(q.params[0].data));
      return broken?{id:q.id,jsonrpc:"2.0",error:{code:-32999,message:"provider outage"}}:{id:q.id,jsonrpc:"2.0",result:field.get(q.params[0].data)};
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
  assert.deepEqual(r.inputSummary,{rows:6,enabledDirections:3,boundDirections:2,issuedLegs:3,privateRecipes:4,disabled:1,notConversion:2,unboundDirections:1,
    reasons:{"unregistered conversion selector":1,"selector is disabled":1,"selector has no independent conversion program":1,"state nomination for token-id settlement has no token-id balance witness":1}});
  const visible=[0,1,4].map(i=>records[i]!.candidateInstanceKey);
  assert.deepEqual(r.graph.map(e=>e.canonicalEdgeId),visible,"only public SQL keys enter graph incl. unbound, not recipe ids");
  assert.deepEqual(r.unavailable.map(e=>e.sqlEdgeKey),[2,3,4,5].map(i=>records[i]!.candidateInstanceKey));
  assert.equal(r.graphViewCoordinator.build({id:"head",generation:103,sourceBlock:103,sourceBlockHash:cutoff,topologyKey:r.topologyKey,edges:r.graph}).scannerEdgeCount,3);
  const calls=wires.flat().filter(q=>q.method==="eth_call");
  assert.equal(calls.length,4);assert(wires.some(batch=>batch.length>1));assert.equal(new Set(calls.map(x=>x.params[0].data)).size,4);
  const codes=wires.flat().filter(q=>q.method==="eth_getCode");assert(codes.length>0);assert.equal(codes.length,new Set(codes.map(q=>q.params[0])).size);
  await assert.rejects(initializeSqlLiveProducer({...input,env:{...env,SEARCHER_BLOCKSCAN_SUBMIT:"1"}}),/override is dry-run only/);
  await assert.rejects(initializeSqlLiveProducer({...input,provider:chain([],true)}),/source is not canonical/);
  broken=true;await assert.rejects(initializeSqlLiveProducer(input),/provider outage/);
});
