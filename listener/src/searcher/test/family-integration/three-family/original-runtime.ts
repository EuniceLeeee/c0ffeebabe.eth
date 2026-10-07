// Fixed-sample compiler only. No prices, RPC, synthetic admission, or Exact quotes.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, realpathSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { SAMPLES, sourcePin, botvm, receiptChecks } from "./historical-dual.js";
import { runtimeProgramScript, runtimeAmountFlowAdapter } from "../../../../adapters/runtime-amount-program.js";
import { buildExecuteCalldata } from "../../../../shared/executor/botvm-executor.js";
import { createStrictCentralAdapterRuntime } from "../../../strict-central-adapter-runtime.js";
import { resolveStrictReadyRuntime } from "../../../strict-ready-runtime.js";
import { UniverseRebuildCheckpointStore, activeReadyMemos } from "../../../universe-rebuild-checkpoint.js";
import { createRebuildWiring, familyDefinitionHash, familyMemoDefinitionHash } from "../../../universe-rebuild-production.js";
import { assertIssuedPreparedFamilyInstance, buildFamilyRuntimeAmountLeg, type PreparedFamilyInstance } from "../../../venues/adapter-family-runtime.js";
import { asPricedFamily } from "../../../venues/family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../venues/production-family-composition.js";
import { lower, same, json, sha } from "../../../venues/protocols/set-redemption-family/test/historical-runtime-observations.js";

const ROOT=fileURLToPath(new URL("../../../../../../",import.meta.url));
const OWNER=ethers.getAddress("0x"+ethers.id("family-three-original-owner-20261008").slice(-40));
const EXECUTOR=ethers.getAddress("0x"+ethers.id("family-three-original-executor-20261008").slice(-40));
const VAULT="0xba12222222228d8ba445958a75a0704d566bf2c8";
const WETH="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const TRANSFER=new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
const [blockArg,readyArg,captureArg,outArg]=process.argv.slice(2);
const block=Number(blockArg),sample=SAMPLES[block];assert(sample && readyArg && captureArg && outArg);
const readyPath=realpathSync(readyArg),capturePath=realpathSync(captureArg),out=resolve(outArg);
const logs=realpathSync(resolve(ROOT,"logs")),parent=realpathSync(dirname(out));
assert(parent.startsWith(logs+sep),"write only to existing ignored evidence directory");
const readyBytes=readFileSync(readyPath),captureBytes=readFileSync(capturePath);
const captured=JSON.parse(captureBytes.toString());assert.equal(captured.tx,sample.tx);
assert(same(captured.block.hash,sample.hash));assert.equal(Number(BigInt(captured.block.number)),block);
const checkedReceipt=receiptChecks(captured.receipt,sample,block),pin=sourcePin();
const original={...checkedReceipt,legs:checkedReceipt.legs.map(leg=>({...leg,
  originalPreCallParity:"unverified at compilation; pending native transaction-prestate runtime proof; Exact unverified"}))};
const canonicalPayload=JSON.stringify({tx:captured.tx,block:{number:captured.block.number,timestamp:captured.block.timestamp,
  baseFeePerGas:captured.block.baseFeePerGas,gasLimit:captured.block.gasLimit,miner:captured.block.miner,mixHash:captured.block.mixHash},prestate:captured.prestate});
const envelope=await new UniverseRebuildCheckpointStore({path:readyPath}).load();
assert(envelope && !envelope.inProgressRun);
const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source=ready.cutoff;
assert.equal(source.number,block);assert(same(source.hash,sample.hash));
assert.equal(ready.universeRange.fromBlock,block);assert.equal(ready.universeRange.toBlock,block);
let forbiddenReads=0;
const deny=()=>{forbiddenReads++;throw new Error("RPC/Exact during runtime construction");};
const runtime=createStrictCentralAdapterRuntime({executor:EXECUTOR,transactionOrigin:OWNER,
  generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},
  provider:{call:deny,getCode:deny,getStorage:deny}});
const guarded=new Proxy(runtime,{get(target,p,receiver){if(!["callerAuthority","generationFence"].includes(String(p)))return deny();return Reflect.get(target,p,receiver);}});
const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:8593",familyIds:[...new Set(sample.cases.map(c=>c.family))],
  executionIdentity:{executor:EXECUTOR,transactionOrigin:OWNER}});
const programs=sample.cases.map(c=>{
  const family=asPricedFamily(catalog.forStrictFamily(c.family as any));
  const memos=activeReadyMemos(envelope).filter(m=>m.familyId===c.family&&m.instanceKey===c.instance);
  assert.equal(memos.length,1);const memo=memos[0];
  assert([familyDefinitionHash(c.family),familyMemoDefinitionHash(c.family)].includes(memo.familyDefinitionHash));
  const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;
  assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
  const edges=graph.filter(e=>e.instanceKey===instance.instanceKey);assert.equal(edges.length,c.directions);
  const routes=instance.routes.filter(r=>same(r.tokenIn,c.tokenIn)&&same(r.tokenOut,c.tokenOut));assert.equal(routes.length,1);
  const handles=instance.routeHandles.filter(h=>h.routeKey===routes[0].routeKey);assert.equal(handles.length,1);
  const input={family,route:handles[0],source,runtime:guarded,executor:EXECUTOR,runtimeEvidence:[],actionOwnership:catalog};
  for(const field of ["amountIn","quotedAmountOut","minAmountOut","exact","exactEvidence"])
    Object.defineProperty(input,field,{get:deny});
  const leg=buildFamilyRuntimeAmountLeg(input);assert(leg,"no quoted fallback");
  return {...c,program:leg.program,programHash:ethers.keccak256(leg.program),memoFingerprint:memo.memoFingerprint,
    familyDefinitionHash:memo.familyDefinitionHash,routeKey:routes[0].routeKey};
});
assert.equal(forbiddenReads,0);
assert(same(programs[0].tokenIn,WETH));
for(let i=1;i<programs.length;i++)assert(same(programs[i-1].tokenOut,programs[i].tokenIn));
const root=programs[0].amountIn,closed=programs.length>1;
assert(!closed || (programs.length===3&&same(programs.at(-1)!.tokenOut,WETH)));
const script=closed?runtimeAmountFlowAdapter.encode({adapterId:"runtime-amount-flow",target:EXECUTOR,
  tokenIn:WETH,tokenOut:WETH,amount:root,children:[],params:{minimumReturn:root,legs:JSON.stringify(programs.map(p=>({tokenIn:p.tokenIn,tokenOut:p.tokenOut,program:p.program})))}
},EXECUTOR,new Uint8Array()):runtimeProgramScript(ethers.getBytes(programs[0].program),root);
const actorTopic=ethers.zeroPadValue(EXECUTOR,32).toLowerCase();
const events=programs.map(c=>{
  const abi=c.family==="protocol:badger-sett-withdraw"?TRANSFER:new ethers.Interface([c.family==="balancer-v1"
    ?"event LOG_SWAP(address indexed caller,address indexed tokenIn,address indexed tokenOut,uint256 tokenAmountIn,uint256 tokenAmountOut)"
    :"event Swap(bytes32 indexed poolId,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut)"]);
  const event=abi.fragments[0] as ethers.EventFragment,payer=c.family==="balancer-v2"?VAULT:c.pool;
  const candidates=captured.receipt.logs.filter((l:any)=>same(l.address,c.family==="protocol:badger-sett-withdraw"?c.tokenOut:payer)&&l.topics[0]===abi.getEvent(event.name)!.topicHash)
    .filter((l:any)=>{const a=abi.parseLog(l)!.args;return c.family==="protocol:badger-sett-withdraw"
      ?same(a.from,payer)&&same(a.to,captured.receipt.to)&&a.value===c.amountOut
      :same(a.tokenIn,c.tokenIn)&&same(a.tokenOut,c.tokenOut)&&(c.family==="balancer-v1"||same(a.poolId,c.instance));});
  assert.equal(candidates.length,1);const log=candidates[0],topics=[...log.topics];
  if(c.family==="balancer-v1")topics[1]=actorTopic;
  if(c.family==="protocol:badger-sett-withdraw")topics[2]=actorTopic;
  const receipts=captured.receipt.logs.filter((l:any)=>same(l.address,c.tokenOut)&&l.topics[0]===TRANSFER.getEvent("Transfer")!.topicHash)
    .filter((l:any)=>{const a=TRANSFER.parseLog(l)!.args;return same(a.from,payer)&&same(a.to,captured.receipt.to)&&a.value===c.amountOut;});
  assert.equal(receipts.length,1,"original output transfer must be unique");
  return {emitter:lower(log.address),data:log.data,topics,topicCount:topics.length,tokenOut:lower(c.tokenOut),payer,amountOut:c.amountOut,originalLogIndex:Number(BigInt(log.logIndex))};
});
assert(events.every((e,i)=>i===0||e.originalLogIndex>events[i-1].originalLogIndex));
const runtimeCode=botvm(OWNER);
const fixture={schemaVersion:1,claim:"Original-amount production runtime output parity only; not Exact quote parity or full original transaction replay",
  tx:sample.tx,block,canonicalPayloadSha256:"0x"+sha(Buffer.from(canonicalPayload)),owner:OWNER,executor:EXECUTOR,weth:WETH,rootAmount:root,closed,
  finalToken:programs.at(-1)!.tokenOut,finalAmount:programs.at(-1)!.amountOut,
  tokens:[...new Set(programs.flatMap(p=>[lower(p.tokenIn),lower(p.tokenOut)]))],
  approvals:programs.filter(p=>p.family!=="protocol:badger-sett-withdraw").map(p=>({token:p.tokenIn,spender:p.family==="balancer-v1"?p.pool:VAULT})),
  approvalCount:programs.filter(p=>p.family!=="protocol:badger-sett-withdraw").length,
  calldata:buildExecuteCalldata(script),scriptHash:ethers.keccak256(script),runtimeCode:runtimeCode.code,runtimeCodeHash:runtimeCode.keccak256,
  eventCount:events.length,events,programs,sourcePin:pin,compilerSha256:sha(readFileSync(fileURLToPath(import.meta.url))),
  ready:{path:readyPath,sha256:sha(readyBytes),source,graphHash:ready.graphHash,scope:"Admission/immutable route construction only; NOT pre-call price provenance"},
  capture:{path:capturePath,sha256:sha(captureBytes)},original,forbiddenReads,
  actorSetup:"After canonical prestate assertions: fresh OWNER gas/input ETH, BotVM code only at fresh EXECUTOR, legitimate WETH deposit and transfer. No historical sender, pool liquidity, token supply storage or admission overrides."};
assert.deepEqual(sourcePin(),pin);assert.equal(sha(readFileSync(readyPath)),sha(readyBytes));assert.equal(sha(readFileSync(capturePath)),sha(captureBytes));
const fd=openSync(out,"wx",0o600);try{writeFileSync(fd,json(fixture)+"\n");fsyncSync(fd);}finally{closeSync(fd);}
console.log(json({block,programs:programs.length,forbiddenReads,scriptHash:fixture.scriptHash,out}));
