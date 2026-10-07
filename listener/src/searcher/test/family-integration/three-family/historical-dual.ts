// Opt-in Family integration evidence using production Ready/Exact/encoders.
// N end-state + N environment is not the original transaction's call-prestate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { runtimeProgramScript } from "../../../../adapters/runtime-amount-program.js";
import { concatBytes } from "../../../../encoder.js";
import type { ResolvedPlanNode } from "../../../../types.js";
import { AnvilStateBackend } from "../../../../shared/state/state-backend.js";
import { buildExecuteCalldata, loadBotVmRuntimeCode } from "../../../../shared/executor/botvm-executor.js";
import { parseAtBlockJson } from "../../../blockscan-at-block-cli.js";
import { createAdapterFamilyExactQuoteCache } from "../../../adapter-family-exact-quote-cache.js";
import { createStrictCentralAdapterRuntime } from "../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../universe-rebuild-production.js";
import { balanceStorageKey, resolveErc20BalanceSlot } from "../../../solver/balance-slots.js";
import { planFragmentNodes } from "../../../solver/plan-fragment-requirements.js";
import type { CanonicalSource } from "../../../venues/adapter-request-program.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyExecutionFragment, buildFamilyRuntimeAmountLeg,
  executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../venues/adapter-family-runtime.js";
import { asPricedFamily } from "../../../venues/family-capability-catalog.js";
import { blockScanEdgeKey } from "../../../venues/blockscan-state-capability.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../venues/production-family-composition.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../../../venues/production-infra-actions.js";
import { lower, same, json, sha, word, observeBalance } from "../../../venues/protocols/set-redemption-family/test/historical-runtime-observations.js";
import { assertHistoricalDiscoveryReceipt, assertHistoricalPriceDirection } from "./historical-input-observations.js";

const ROOT = fileURLToPath(new URL("../../../../../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OWNER = "0x1000000000000000000000000000000000000001";
const EXECUTOR = "0x1000000000000000000000000000000000000002";
const VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const NMR = "0x1776e1f26f98b1a5df9cd347953a26dd3cb46671";
const GTC = "0xde30da39c46104798bb5aa3fe8b9e0e1f348163f";
const AURA = "0xc0c293ce456ff0ed870add98a0828dd4d2903dbf";
const SHARES = "0xba485b556399123261a5f9c95d413b4f93107407";
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
type Case = { family:string; instance:string; pool:string; tokenIn:string; tokenOut:string; amountIn:bigint; amountOut:bigint; directions:number };
const SAMPLES: Record<number, {tx:string; hash:string; cases:Case[]}> = {
  26138731: {tx:"0x6be8b298d56ac7993ee3a2e9faa389b73694d70d0d385b490b74f6bba78094a8", hash:"0x696b86358440cc2b7a0a5e80dc87c2542a2e1535cd21502b99b317fef1d4d266", cases:[
    {family:"balancer-v1",instance:"0x5a0d85166a20f9cd27be2cb293e4d10188f0c97d",pool:"0x5a0d85166a20f9cd27be2cb293e4d10188f0c97d",tokenIn:WETH,tokenOut:NMR,amountIn:8444695829171278n,amountOut:1313743479005274328n,directions:2}]},
  26138724: {tx:"0x9db5b6b8efe9dacc0931ee1b48c861b0284e8088f7c27c93455e95c374b50a4b",hash:"0xcad9e81827cbe1f29ff77fc163855dfe1647a17b8b4a44b209e900273ac4f70b",cases:[
    {family:"balancer-v2",instance:"0xff083f57a556bfb3bbe46ea1b4fa154b2b1fbe88000200000000000000000030",pool:"0xff083f57a556bfb3bbe46ea1b4fa154b2b1fbe88",tokenIn:WETH,tokenOut:GTC,amountIn:6917984563928420n,amountOut:95034526410411689937n,directions:2}]},
  26138511: {tx:"0x80334cda165c424da8ffc9bbb4ccd302b77b79a3bc1f4e25bbbcd643c1712e3d",hash:"0xffdbdda6829f743dc05ad148586e96dc671f31ee30968f07d91963b9de22e771",cases:[
    {family:"balancer-v2",instance:"0x0578292cb20a443ba1cde459c985ce14ca2bdee5000100000000000000000269",pool:"0x0578292cb20a443ba1cde459c985ce14ca2bdee5",tokenIn:WETH,tokenOut:SHARES,amountIn:1273805887338394n,amountOut:131502308044455713821n,directions:6},
    {family:"protocol:badger-sett-withdraw",instance:SHARES,pool:SHARES,tokenIn:SHARES,tokenOut:AURA,amountIn:131502308044455713821n,amountOut:141331862836870691964n,directions:1},
    {family:"balancer-v2",instance:"0xcfca23ca9ca720b6e98e3eb9b6aa0ffc4a5c08b9000200000000000000000274",pool:"0xcfca23ca9ca720b6e98e3eb9b6aa0ffc4a5c08b9",tokenIn:AURA,tokenOut:WETH,amountIn:141331862836870691964n,amountOut:1326301699728453n,directions:2}]},
};
type Overrides = Record<string,{code?:string;balance?:string;stateDiff?:Record<string,string>}>;
type Rpc = (method:string,params:unknown[])=>Promise<any>;
const git = (...args:string[]) => execFileSync("git",["-c","safe.directory="+ROOT.replace(/\/$/,""),...args],
  {cwd:ROOT,encoding:"utf8",timeout:15000,maxBuffer:8*1024*1024,stdio:["ignore","pipe","pipe"]});
function sourcePin() {
  const files:[string,string][]=[];
  const visit=(path:string)=>{for(const e of readdirSync(resolve(ROOT,"listener/src",path),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    if(e.name==="test"||e.name==="templates")continue;
    const p=path?path+"/"+e.name:e.name;if(e.isDirectory())visit(p);else{assert(e.isFile());files.push([p,sha(readFileSync(resolve(ROOT,"listener/src",p)))]);}
  }};visit("");
  const solidity=git("ls-files","--cached","--others","--exclude-standard","-z","--","src","lib").split("\0").filter(p=>p.endsWith(".sol")).sort();
  return {sourceTreeSha256:sha(JSON.stringify(files)),fileCount:files.length,
    soliditySha256:sha(json(solidity.map(p=>[p,sha(readFileSync(resolve(ROOT,p)))]))),
    packageSha256:sha(json(["listener/package.json","listener/package-lock.json","foundry.toml"].map(p=>[p,sha(readFileSync(resolve(ROOT,p)))]))),
    testSha256:sha(readFileSync(SELF)),helperSha256:sha(readFileSync(new URL("../../../venues/protocols/set-redemption-family/test/historical-runtime-observations.ts",import.meta.url))),
    inputObservationSha256:sha(readFileSync(new URL("./historical-input-observations.ts",import.meta.url))),
    artifactSha256:sha(readFileSync(resolve(ROOT,"out/BotVM.sol/BotVM.json")))};
}
function options(argv:string[]) {
  const names=["--ready","--prices","--rpc-file","--out","--port","--block"],v=new Map<string,string>();
  for(let i=0;i<argv.length;i+=2){assert(names.includes(argv[i])&&!v.has(argv[i]));assert(argv[i+1]&&!argv[i+1].startsWith("--"));v.set(argv[i],argv[i+1]);}
  assert.equal(v.size,names.length);assert.equal(v.get("--port"),"8593");
  const block=Number(v.get("--block"));assert(SAMPLES[block],"only supplied historical samples");
  const out=resolve(v.get("--out")!),parent=realpathSync(dirname(out)),logs=realpathSync(resolve(ROOT,"logs"));
  assert(parent===logs||parent.startsWith(logs+sep));assert.equal(git("check-ignore","--",out).trim(),out);
  return {ready:resolve(v.get("--ready")!),prices:resolve(v.get("--prices")!),rpcFile:resolve(v.get("--rpc-file")!),out,block};
}
function botvm() {
  const a=JSON.parse(readFileSync(resolve(ROOT,"out/BotVM.sol/BotVM.json"),"utf8"));
  const m=typeof a.metadata==="string"?JSON.parse(a.metadata):a.metadata;
  assert.equal(m?.settings?.compilationTarget?.["src/BotVM.sol"],"BotVM");assert(Object.keys(m.sources).length>0);
  for(const [name,entry]of Object.entries(m.sources)as[string,{keccak256:string}][]){const p=resolve(ROOT,name);assert(!relative(ROOT,p).startsWith(".."));assert.equal(ethers.keccak256(readFileSync(p)),entry.keccak256,"stale artifact "+name);}
  const groups=Object.values(a.deployedBytecode.immutableReferences)as{start:number;length:number}[][];
  assert.equal(groups.length,1);assert(groups[0].length>0&&groups[0].every(r=>r.length===32));return loadBotVmRuntimeCode(OWNER);
}
function receiptChecks(receipt:any,sample:typeof SAMPLES[number],block:number) {
  assert(same(receipt.transactionHash,sample.tx)&&same(receipt.blockHash,sample.hash));
  assert.equal(Number(BigInt(receipt.blockNumber)),block);assert.equal(BigInt(receipt.status),1n);
  const transfers=(receipt.logs as any[]).filter(l=>l.topics[0]===ERC20.getEvent("Transfer")!.topicHash)
    .map(l=>({token:lower(l.address),args:ERC20.parseLog(l)!.args,index:Number(BigInt(l.logIndex))}));
  const records=[];
  for(const c of sample.cases){
    if(c.family==="protocol:badger-sett-withdraw"){
      const burn=transfers.filter(t=>same(t.token,c.tokenIn)&&same(t.args.from,receipt.to)&&same(t.args.to,ethers.ZeroAddress)&&t.args.value===c.amountIn);
      const received=transfers.filter(t=>same(t.token,c.tokenOut)&&same(t.args.from,c.pool)&&same(t.args.to,receipt.to)&&t.args.value===c.amountOut);
      assert.equal(burn.length,1);assert.equal(received.length,1);assert(received[0].index>burn[0].index);
    }else{
      const abi=new ethers.Interface([c.family==="balancer-v1"?
        "event LOG_SWAP(address indexed caller,address indexed tokenIn,address indexed tokenOut,uint256 tokenAmountIn,uint256 tokenAmountOut)":
        "event Swap(bytes32 indexed poolId,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut)"]);
      const e=abi.fragments[0]as ethers.EventFragment;
      const matching=receipt.logs.filter((l:any)=>same(l.address,c.family==="balancer-v1"?c.pool:VAULT)&&l.topics[0]===abi.getEvent(e.name)!.topicHash)
        .map((l:any)=>abi.parseLog(l)!.args).filter((a:any)=>same(a.tokenIn,c.tokenIn)&&same(a.tokenOut,c.tokenOut)&&(c.family==="balancer-v1"||same(a.poolId,c.instance)));
      assert.equal(matching.length,1);const a=matching[0];assert.equal(BigInt(a.tokenAmountIn??a.amountIn),c.amountIn);assert.equal(BigInt(a.tokenAmountOut??a.amountOut),c.amountOut);
    }
    records.push({...c,originalPreCallParity:"unverified; executable comparisons use N end-state"});
  }
  return {tx:sample.tx,blockNumber:block,blockHash:sample.hash,receiptSha256:sha(json(receipt)),legs:records};
}
export async function main(argv=process.argv.slice(2)):Promise<void>{
  const args=options(argv),sample=SAMPLES[args.block],fd=openSync(args.out,"wx",0o600);
  const report:Record<string,any>={schemaVersion:1,result:"failed",block:args.block,samples:[],errors:[],
    claim:"Natural single-block integration and N end-state/N environment dual single-leg execution; not original-precall, full-route EV or formal merge acceptance",
    actor:{executor:EXECUTOR,owner:OWNER},safety:{signing:false,broadcast:false,minedBlocks:0,remoteSubmission:false,
      executionOverrides:"actor code/gas/balance slots only; no protocol liquidity, registry, totalSupply or eligibility overrides"}};
  let backend:AnvilStateBackend|undefined,secret="",stage="offline-inputs",calls=0,exactCalls=0,constructing=false,constructionAttempts=0;
  let checkPins:(()=>void)|undefined,checkFork:(()=>Promise<void>)|undefined;
  const abort=new AbortController(),deadline=Date.now()+480000,timer=setTimeout(()=>abort.abort(new Error("historical test deadline")),480000);
  const interrupt=()=>abort.abort(new Error("test interrupted"));process.once("SIGINT",interrupt);process.once("SIGTERM",interrupt);
  const redact=(v:unknown)=>String(v).split(secret||"\0").join("[REDACTED]").replace(/https?:\/\/[^\s"'<>]+/gi,"[REDACTED_URL]").slice(0,4000);
  const failure=(e:unknown)=>({stage,message:redact(e instanceof Error?e.message:e)});
  try{
    const initialPin=sourcePin();report.code={headAtStart:git("rev-parse","HEAD").trim(),...initialPin};
    const readyPath=realpathSync(args.ready),pricePath=realpathSync(args.prices),provenancePath=realpathSync(resolve(dirname(pricePath),"input.json"));
    const inputs=[readyPath,pricePath,provenancePath].map(path=>({path,bytes:readFileSync(path)}));
    report.inputHashes=inputs.map(i=>({path:i.path,sha256:sha(i.bytes)}));
    checkPins=()=>{report.codeAfter=sourcePin();report.inputHashesAfter=inputs.map(i=>({path:i.path,sha256:sha(readFileSync(i.path))}));
      assert.deepEqual(report.codeAfter,initialPin);assert.deepEqual(report.inputHashesAfter,report.inputHashes);};
    const saved=parseAtBlockJson(inputs[1].bytes.toString()),provenance=parseAtBlockJson(inputs[2].bytes.toString());
    for(const p of [saved,provenance]){assert.equal(p.readySha256,sha(inputs[0].bytes));assert.equal(realpathSync(p.readyPath),readyPath);}
    assert.equal(provenance.executionMode,"source-block");assert.equal(provenance.through,"prices");assert.equal(provenance.broadcast,false);
    assert.equal(provenance.implementation?.sourceTreeSha256,initialPin.sourceTreeSha256);assert(same(provenance.executor,EXECUTOR)&&same(provenance.owner,OWNER));
    assert.equal(BigInt(provenance.chainId),1n);
    const envelope=await new UniverseRebuildCheckpointStore({path:readyPath}).load();assert(envelope&&!envelope.inProgressRun);
    const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source:CanonicalSource=ready.cutoff,pin={blockHash:source.hash,requireCanonical:true};
    const sameBlock=(n:number,h:string)=>{assert.equal(n,args.block);assert(same(h,sample.hash));};sameBlock(source.number,source.hash);
    assert.equal(ready.universeRange.fromBlock,args.block);assert.equal(ready.universeRange.toBlock,args.block);
    for(const s of [provenance.topologySource,provenance.stateSource])sameBlock(s.number,s.hash);
    sameBlock(saved.runtime.sourceBlock,saved.runtime.sourceBlockHash);sameBlock(saved.runtime.pricing.sourceBlock,saved.runtime.pricing.sourceBlockHash);
    const header=provenance.sourceHeader;sameBlock(Number(BigInt(header.number)),header.hash);
    const loopback="http://127.0.0.1:8593",families=[...new Set(sample.cases.map(c=>c.family))];
    const wiring=createRebuildWiring({rpcUrl:loopback,familyIds:families,executionIdentity:{executor:EXECUTOR,transactionOrigin:OWNER}});
    const entries=sample.cases.map(c=>{
      const family=asPricedFamily(catalog.forStrictFamily(c.family as any));
      const memos=activeReadyMemos(envelope).filter(m=>m.familyId===c.family&&m.instanceKey===c.instance);assert.equal(memos.length,1);
      const memo=memos[0];assert([familyDefinitionHash(c.family),familyMemoDefinitionHash(c.family)].includes(memo.familyDefinitionHash));
      const candidate=memo.candidateSnapshot as any;sameBlock(candidate.blockNumber,candidate.blockHash);
      // An instance may have been discovered in an earlier real TX in the same block.
      assert(ethers.isHexString(candidate.transactionHash,32));
      const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source})as PreparedFamilyInstance;
      assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
      const edges=graph.filter(e=>e.instanceKey===instance.instanceKey);assert.equal(edges.length,c.directions);assert.equal(instance.routes.length,edges.length);
      const rows=edges.map(edge=>{const id=blockScanEdgeKey(edge),row=saved.runtime.pricing.effectiveMids.rows.get(id),raw=saved.runtime.pricing.mids.get(id);
        assert(saved.runtime.graph.edges.some((e:any)=>blockScanEdgeKey(e)===id));assert(raw&&Number.isFinite(raw.mid)&&raw.mid>0);
        assert(row?.status==="quoted"&&row.edgeId===id);assertHistoricalPriceDirection(edge,row,instance.instanceKey);
        assert(typeof row.amountIn==="bigint"&&row.amountIn>0n);assert(typeof row.amountOut==="bigint"&&row.amountOut>0n);
        sameBlock(row.quotedAt.number,row.quotedAt.hash);assert.equal(row.quotedAt.generation,saved.runtime.generation);
        const routes=instance.routes.filter(r=>same(r.tokenIn,row.tokenIn)&&same(r.tokenOut,row.tokenOut));assert.equal(routes.length,1);
        const handles=instance.routeHandles.filter(h=>h.routeKey===routes[0].routeKey);assert.equal(handles.length,1);return{row,raw,route:handles[0]};});
      assert.equal(new Set(rows.map(r=>r.route.routeKey)).size,rows.length,"duplicate direction coverage");
      assert.deepEqual(rows.map(r=>r.route.routeKey).sort(),instance.routes.map(r=>r.routeKey).sort(),"missing admitted direction");
      return{c,family,memo,instance,rows};
    });
    report.inputs={source,graphHash:ready.graphHash,priceGeneration:saved.runtime.generation,priceImplementation:provenance.implementation,
      environment:header,instances:entries.map(e=>({family:e.c.family,instance:e.c.instance,descriptor:e.instance.descriptor,
        memoFingerprint:e.memo.memoFingerprint,familyDefinitionHash:e.memo.familyDefinitionHash,candidate:e.memo.candidateSnapshot,validity:e.memo.validity,rows:e.rows.map(r=>({raw:r.raw,effective:r.row,route:r.route.routeKey}))}))};
    report.expectedSamples=entries.reduce((n,e)=>n+e.rows.length*2,0);
    const runtimeCode=botvm();report.runtimeCodeHash=runtimeCode.keccak256;
    const privateConfig=JSON.parse(readFileSync(args.rpcFile,"utf8"));assert(typeof privateConfig.MAINNET_RPC_URL==="string");secret=privateConfig.MAINNET_RPC_URL;
    const allowed=new Set(["web3_clientVersion","eth_chainId","eth_getBlockByNumber","eth_getTransactionReceipt","eth_call","eth_getCode","eth_getStorageAt","eth_createAccessList","debug_traceCall"]);
    const rpc:Rpc=async(method,params)=>{if(constructing){constructionAttempts++;throw new Error("RPC during runtime construction");}
      if(method==="anvil_setCoinbase"){assert(backend);assert.deepEqual(params,[header.miner]);}else assert(allowed.has(method));
      abort.signal.throwIfAborted();assert(Date.now()<deadline&&++calls<=1800,"read budget exceeded");
      const response=await fetch(loopback,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:calls,method,params}),signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30000)])});
      assert(response.ok,method+": HTTP "+response.status);const b=await response.json()as any;if(b.error)throw new Error(method+": "+b.error.code+" "+redact(b.error.message));assert(Object.hasOwn(b,"result"));return b.result;};
    const call=(to:string,data:string,overrides:Overrides={})=>rpc("eth_call",[{to,data,from:OWNER},pin,overrides]);
    const balance=async(token:string,holder:string,overrides:Overrides={})=>BigInt(await call(token,ERC20.encodeFunctionData("balanceOf",[holder]),overrides));
    const tokens=[...new Set(entries.flatMap(e=>e.rows.flatMap(r=>[lower(r.row.tokenIn),lower(r.row.tokenOut)])))];
    assert(!tokens.some(t=>same(t,OWNER)||same(t,EXECUTOR)));
    const cache=createAdapterFamilyExactQuoteCache();cache.advanceState(source);const queryReads:any[]=[];
    const runtime=createStrictCentralAdapterRuntime({executor:EXECUTOR,transactionOrigin:OWNER,exactQuoteCache:cache,
      generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},provider:{
        async call(tx,b){assert.equal(b,source.number);queryReads.push({kind:"call",to:tx.to,selector:tx.data.slice(0,10)});return rpc("eth_call",[tx,pin]);},
        async getCode(a,b){assert.equal(b,source.number);queryReads.push({kind:"code",to:a});return rpc("eth_getCode",[a,pin]);},
        async getStorage(a,k,b){assert.equal(b,source.number);queryReads.push({kind:"storage",to:a,key:k});return rpc("eth_getStorageAt",[a,k,pin]);}}});
    const guardedRuntime=new Proxy(runtime,{get(target,p,receiver){if(constructing&&!["callerAuthority","generationFence"].includes(String(p))){constructionAttempts++;throw new Error("quote/RPC service during runtime construction");}return Reflect.get(target,p,receiver);}});
    stage="runtime-construction";
    const cases=entries.flatMap(entry=>entry.rows.map(item=>{
      const input={family:entry.family,route:item.route,source,runtime:guardedRuntime,executor:EXECUTOR,runtimeEvidence:[],actionOwnership:catalog};
      for(const field of ["amountIn","quotedAmountOut","minAmountOut","exact","exactEvidence"])Object.defineProperty(input,field,{get(){constructionAttempts++;throw new Error("amount access during runtime construction");}});
      constructing=true;try{const leg=buildFamilyRuntimeAmountLeg(input);assert(leg,"runtime decline is not a pass");return{...item,entry,leg};}finally{constructing=false;}
    }));
    assert.equal(calls+exactCalls+constructionAttempts,0);report.runtimeConstruction={directions:cases.length,rpcCalls:calls,exactCalls,constructionAttempts,quotedFallback:false,programHashes:cases.map(c=>ethers.keccak256(c.leg.program))};
    stage="owned-fork-start";backend=new AnvilStateBackend(secret,loopback,8593);await backend.forkAt(source.number,{signal:abort.signal,deadlineAtMs:deadline});
    report.client=await rpc("web3_clientVersion",[]);assert(/anvil/i.test(report.client));assert.equal(BigInt(await rpc("eth_chainId",[])),1n);
    const headerCheck=async()=>{const h=await rpc("eth_getBlockByNumber",["latest",false]);for(const f of ["number","hash","parentHash","stateRoot","timestamp","baseFeePerGas","gasLimit","miner","mixHash","excessBlobGas"]){assert.equal(typeof h[f],typeof header[f]);assert.equal(String(h[f]).toLowerCase(),String(header[f]).toLowerCase(),"N environment "+f);}return h;};
    report.headerBefore=await headerCheck();checkFork=async()=>{report.headerAfter=await headerCheck();for(const t of tokens)assert.equal(await balance(t,EXECUTOR),0n);assert.equal(await rpc("eth_getCode",[EXECUTOR,pin]),"0x");};
    for(const actor of [OWNER,EXECUTOR])assert.equal(await rpc("eth_getCode",[actor,pin]),"0x");
    const expected=[BigInt(header.number),BigInt(header.timestamp),BigInt(header.baseFeePerGas),BigInt(header.miner),BigInt(header.gasLimit),BigInt(header.mixHash),1n];
    const readEnvironment=async()=>[...ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"),await call(EXECUTOR,"0x",{[EXECUTOR]:{code:"0x43600052426020524860405241606052456080524460a0524660c05260e06000f3"}}))]as bigint[];
    stage="N-environment-probe";report.environmentBefore=await readEnvironment();assert.deepEqual(report.environmentBefore.filter((_v:bigint,n:number)=>n!==3),expected.filter((_v,n)=>n!==3));
    if(report.environmentBefore[3]!==expected[3]){report.environmentAdjustment={field:"coinbase",before:report.environmentBefore[3],after:header.miner};await rpc("anvil_setCoinbase",[header.miner]);}
    report.observedEnvironment=await readEnvironment();assert.deepEqual(report.observedEnvironment,expected);
    stage="original-receipt";report.originalTransaction=receiptChecks(await rpc("eth_getTransactionReceipt",[sample.tx]),sample,args.block);
    stage="discovery-receipts";report.discoveryReceipts=[];
    for(const entry of entries){const candidate=entry.memo.candidateSnapshot as any;
      const receipt=await rpc("eth_getTransactionReceipt",[candidate.transactionHash]);
      assertHistoricalDiscoveryReceipt(receipt,candidate,source);
      report.discoveryReceipts.push({family:entry.c.family,instance:entry.c.instance,transactionHash:receipt.transactionHash,
        blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,status:receipt.status,receiptSha256:sha(json(receipt))});}
    stage="actor-balance-mapping";const slots=new Map<string,string>();report.balanceMappings=[];
    for(const token of tokens){assert.equal(await balance(token,EXECUTOR),0n);
      const holder=entries.some(e=>e.c.family==="balancer-v1")?entries[0].c.pool:VAULT,holderBalance=await balance(token,holder);
      const index=await resolveErc20BalanceSlot(token,holder,{balanceOf:balance,getStorage:async(t,k)=>BigInt(await rpc("eth_getStorageAt",[t,k,pin]))});
      const candidates:string[]=[];if(index!==null)candidates.push(balanceStorageKey(EXECUTOR,index).toLowerCase());else{
        const a=await rpc("eth_createAccessList",[{from:OWNER,to:token,data:ERC20.encodeFunctionData("balanceOf",[EXECUTOR]),gas:"0x100000"},ethers.toQuantity(source.number)]);
        assert(!a.error&&Array.isArray(a.accessList));candidates.push(...a.accessList.filter((v:any)=>same(v.address,token)).flatMap((v:any)=>v.storageKeys.map((k:string)=>word(k))));}
      assert(candidates.length>0&&candidates.length<=16);let slot="";
      for(const candidate of new Set(candidates)){let matches=true;for(const probe of [717171717171n,919191919193n]){
        const state={[token]:{stateDiff:{[candidate]:word(probe)}}};try{if(await balance(token,EXECUTOR,state)!==probe||await balance(token,holder,state)!==holderBalance)matches=false;}catch{matches=false;}if(!matches)break;}
        if(matches){assert.equal(slot,"");slot=candidate;}}
      assert(slot,"actor-only balance slot not proven");slots.set(token,slot);report.balanceMappings.push({token,holder,holderBalance,slotIndex:index,actorStorageKey:slot,probes:2});}
    for(const {entry,row,route,leg}of cases){const original=same(row.tokenIn,entry.c.tokenIn)&&same(row.tokenOut,entry.c.tokenOut);
      const trials:[string,bigint][]=[["production-P",row.amountIn],[original?"historical-amount-at-N":"half-production-P",original?entry.c.amountIn:row.amountIn/2n]];
      for(const[label,amountIn]of trials){const s:Record<string,any>={family:entry.c.family,instance:entry.c.instance,routeKey:route.routeKey,edgeId:row.edgeId,tokenIn:row.tokenIn,tokenOut:row.tokenOut,label,amountIn,productionP:row.amountIn,status:"failed",executions:[]};report.samples.push(s);
        try{stage="production-exact";const before=queryReads.length;exactCalls++;
          const quote=await executeFamilyExactQuote({family:entry.family,route,amountIn,source,generation:source.generation,executor:EXECUTOR,runtimeEvidence:[],runtime,control:{signal:abort.signal,deadlineAtMs:deadline}});
          assert.equal(quote.status,"resolved","production Exact unresolved");if(quote.status!=="resolved")throw new Error("production Exact unresolved");
          assert.equal(quote.amountIn,amountIn);assert.deepEqual(quote.source,source);assert(quote.amountOut>0n);
          s.quote={amountOut:quote.amountOut,reads:queryReads.slice(before),evidenceRefs:quote.evidenceRefs};if(label==="production-P")assert.equal(quote.amountOut,row.amountOut,"P differs from production price");
          s.originalTxComparison={originalAmountIn:original?entry.c.amountIn:null,originalAmountOut:original?entry.c.amountOut:null,signedDelta:original&&amountIn===entry.c.amountIn?quote.amountOut-entry.c.amountOut:null,preCallParity:"unverified; N end-state"};
          const fragment=buildFamilyExecutionFragment({family:entry.family,route,exact:quote,minAmountOut:quote.amountOut,executor:EXECUTOR,runtimeEvidence:[],actionOwnership:catalog});assert.equal(fragment.status,"resolved");if(fragment.status!=="resolved")throw new Error("fragment unresolved");
          s.requirements=fragment.fragment.requirements;const adapters=[...entry.family.plugin.actionAdapters,...PRODUCTION_INFRA_ACTION_ADAPTERS];
          const compile=(node:ResolvedPlanNode):Uint8Array=>{const a=adapters.find(a=>a.id===node.adapterId);assert(a);return a.encode(node,EXECUTOR,concatBytes(...node.children.map(compile)));};
          const scripts:[string,Uint8Array][]=[["quoted-fragment",concatBytes(...planFragmentNodes(fragment.fragment,row.tokenIn,amountIn).map(compile))],["runtime-program",runtimeProgramScript(ethers.getBytes(leg.program),amountIn)]];
          const pair=[lower(row.tokenIn),lower(row.tokenOut)],inventory=[101n,quote.amountOut+103n],initial=[amountIn+inventory[0],inventory[1]];
          assert(initial.every(v=>v<=ethers.MaxUint256));const overrides:Overrides={[OWNER]:{balance:ethers.toQuantity(100n*10n**18n)},[EXECUTOR]:{code:runtimeCode.code}};
          pair.forEach((t,n)=>{overrides[t]={stateDiff:{[slots.get(t)!]:word(initial[n])}};});s.actorInventory=inventory;s.overrideSha256=sha(json(overrides));
          for(const[encoding,script]of scripts){const result:Record<string,any>={encoding,status:"failed",scriptHash:ethers.keccak256(script)};s.executions.push(result);
            try{stage=encoding;assert.deepEqual(await Promise.all(pair.map(t=>balance(t,EXECUTOR,overrides))),initial);
              const tx={from:OWNER,to:EXECUTOR,data:buildExecuteCalldata(script),gas:"0x1000000",gasPrice:ethers.toQuantity(header.baseFeePerGas)};
              result.callTrace=await rpc("debug_traceCall",[tx,pin,{tracer:"callTracer",timeout:"30s",stateOverrides:overrides}]);assert(!result.callTrace.error,"BotVM execution reverted");
              result.stateDiff=await rpc("debug_traceCall",[tx,pin,{tracer:"prestateTracer",tracerConfig:{diffMode:true},timeout:"30s",stateOverrides:overrides}]);
              const measured=pair.map((t,n)=>observeBalance(result.stateDiff,t,slots.get(t)!,initial[n]));result.balances=pair.map((token,n)=>({token,...measured[n]}));result.quoteDelta=measured[1].delta-quote.amountOut;
              const observed:Overrides={};pair.forEach((t,n)=>{observed[t]={stateDiff:{[slots.get(t)!]:word(measured[n].after)}};});for(const[n,t]of pair.entries())assert.equal(await balance(t,EXECUTOR,observed),measured[n].after);
              assert.equal(measured[0].delta,-amountIn);assert.equal(measured[0].after,inventory[0]);assert.equal(measured[1].delta,quote.amountOut);assert.equal(measured[1].after,inventory[1]+quote.amountOut);
              result.oldInventoryConsumed=[0n,0n];result.status="pass";
            }catch(e){result.error=failure(e);}}
          assert(s.executions.every((e:any)=>e.status==="pass"),"one or both encoders failed");assert.deepEqual(s.executions[0].balances,s.executions[1].balances);s.status="pass";
        }catch(e){s.error=failure(e);}console.log(json({family:s.family,label:s.label,routeKey:s.routeKey,status:s.status}));abort.signal.throwIfAborted();}
    }
    report.exactCache=cache.snapshot();assert.equal(report.samples.length,report.expectedSamples);assert(report.samples.every((s:any)=>s.status==="pass"));report.result="pass";
  }catch(e){report.errors.push(failure(e));}
  finally{stage="final-pins";try{await checkFork?.();}catch(e){report.errors.push(failure(e));report.result="failed";}try{checkPins?.();}catch(e){report.errors.push(failure(e));report.result="failed";}
    stage="owned-fork-cleanup";try{if(backend)await backend.stopAndWait();report.forkStopped=!!backend;}catch(e){report.errors.push(failure(e));report.result="failed";}finally{backend?.provider.destroy();}
    clearTimeout(timer);process.removeListener("SIGINT",interrupt);process.removeListener("SIGTERM",interrupt);report.rpcCalls=calls;report.exactCalls=exactCalls;report.runtimeConstructionAttempts=constructionAttempts;
    const output=json(report).split(secret||"\0").join("[REDACTED]").replace(/https?:\/\/[^\s"<>]+/gi,"[REDACTED_URL]")+"\n";try{writeFileSync(fd,output);fsyncSync(fd);}finally{closeSync(fd);}}
  console.log(json({result:report.result,samples:report.samples.length,executionsPassed:report.samples.flatMap((s:any)=>s.executions).filter((e:any)=>e.status==="pass").length,out:args.out}));if(report.result!=="pass")process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error("historical dual test: invalid input/output; existing receipts untouched");process.exitCode=1;});
