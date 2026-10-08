// Fixed original-amount test only. Production Exact and quoted encoder run unchanged.
// Native Forge supplies real reads after the preceding production runtime legs.
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,realpathSync,openSync,closeSync,fsyncSync,mkdtempSync} from "node:fs";
import {resolve,dirname,sep} from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
import {ethers} from "ethers";
import {SAMPLES,sourcePin} from "./historical-dual.js";
import {POOL,FACTORY} from "../../../venues/swaps/balancer-v1-family/codec.js";
import {runtimeProgramScript} from "../../../../adapters/runtime-amount-program.js";
import {concatBytes} from "../../../../encoder.js";
import type {ResolvedPlanNode} from "../../../../types.js";
import {buildExecuteCalldata} from "../../../../shared/executor/botvm-executor.js";
import {createStrictCentralAdapterRuntime} from "../../../strict-central-adapter-runtime.js";
import {resolveStrictReadyRuntime} from "../../../strict-ready-runtime.js";
import {UniverseRebuildCheckpointStore,activeReadyMemos} from "../../../universe-rebuild-checkpoint.js";
import {createRebuildWiring,familyDefinitionHash,familyMemoDefinitionHash} from "../../../universe-rebuild-production.js";
import {assertIssuedPreparedFamilyInstance,executeFamilyExactQuote,buildFamilyExecutionFragment,type PreparedFamilyInstance} from "../../../venues/adapter-family-runtime.js";
import {asPricedFamily} from "../../../venues/family-capability-catalog.js";
import {PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog} from "../../../venues/production-family-composition.js";
import {PRODUCTION_INFRA_ACTION_ADAPTERS} from "../../../venues/production-infra-actions.js";
import {planFragmentNodes} from "../../../solver/plan-fragment-requirements.js";
import {same,json,sha} from "../../../venues/protocols/set-redemption-family/test/historical-runtime-observations.js";

const ROOT=fileURLToPath(new URL("../../../../../../",import.meta.url));
const [fixtureArg,outArg]=process.argv.slice(2);assert(fixtureArg&&outArg);
const fixturePath=realpathSync(fixtureArg),fixtureBytes=readFileSync(fixturePath),fixture=JSON.parse(fixtureBytes.toString());
const executionPayload=JSON.stringify(fixture);
const outParent=realpathSync(outArg),logs=realpathSync(resolve(ROOT,"logs"));
assert(outParent.startsWith(logs+sep),"existing ignored evidence directory required");
const out=mkdtempSync(resolve(outParent,fixture.block+"."));
const secret=process.env.MAINNET_RPC_URL;assert(secret,"RPC injected through environment only");
const sample=SAMPLES[fixture.block];assert(sample&&same(sample.tx,fixture.tx));
const pin=sourcePin();assert.deepEqual(pin,fixture.sourcePin);
const readyBytes=readFileSync(fixture.ready.path),captureBytes=readFileSync(fixture.capture.path);
assert.equal(sha(readyBytes),fixture.ready.sha256);assert.equal(sha(captureBytes),fixture.capture.sha256);
const captured=JSON.parse(captureBytes.toString());
const canonical=JSON.stringify({tx:captured.tx,block:{number:captured.block.number,timestamp:captured.block.timestamp,
  baseFeePerGas:captured.block.baseFeePerGas,gasLimit:captured.block.gasLimit,miner:captured.block.miner,mixHash:captured.block.mixHash},prestate:captured.prestate});
assert.equal("0x"+sha(Buffer.from(canonical)),fixture.canonicalPayloadSha256);
const write=(path:string,value:unknown)=>writeFileSync(path,json(value)+"\n",{flag:"wx",mode:0o600});
const testPin=()=>Object.fromEntries(["original-exact.ts","original-reads.t.sol","original-runtime.t.sol","original-prestate.t.sol"].map(p=>[p,sha(readFileSync(new URL(p,import.meta.url)))]));
const testedCode=testPin();
const report:any={testPin:testedCode,schemaVersion:1,status:"failed",block:fixture.block,tx:fixture.tx,fixture:fixturePath,fixtureSha256:sha(fixtureBytes),
  sourcePin:pin,transportPayloadSha256:sha(Buffer.from(executionPayload)),reads:[],quotes:[],scope:"Fixed five original-amount legs: production Exact and quoted execution; not EV or live latency."};
const reportPath=resolve(out,fixture.block+".exact-report.json");const reportFd=openSync(reportPath,"wx",0o600);
const testConfigPath=resolve(out,"foundry.toml");
const testConfig=readFileSync(resolve(ROOT,"foundry.toml"),"utf8").replace("[profile.default]",
  "[profile.default]\nfs_permissions = [{ access = \"read-write\", path = "+JSON.stringify(out)+" }]");
writeFileSync(testConfigPath,testConfig,{flag:"wx",mode:0o600});
report.testConfig={path:testConfigPath,sha256:sha(testConfig)};
const deadline=Date.now()+600000;let runCount=0,reads=0;
const redact=(v:unknown)=>String(v).split(secret).join("[REDACTED]").replace(/https?:\/\/[^\s"'<>]+/gi,"[REDACTED_URL]");
async function forge(kind:"reads"|"execute",execution:string,extra:Record<string,string>={}){
  assert(++runCount<=16&&Date.now()<deadline,"bounded native proof run");
  const log=resolve(out,fixture.block+"."+runCount+"."+kind+".log"),fd=openSync(log,"wx",0o600),start=Date.now();
  const env:Record<string,string>={...process.env as Record<string,string>,MAINNET_RPC_URL:secret!,SEARCHER_DRY_RUN:"1",SEARCHER_BLOCKSCAN_SUBMIT:"0",
    FOUNDRY_TEST:resolve(ROOT,"listener/src/searcher/test/family-integration/three-family"),
    FOUNDRY_SRC:resolve(ROOT,"logs/family-three-prestate.IIERDy/forge-source"),FOUNDRY_SCRIPT:resolve(ROOT,"logs/family-three-prestate.IIERDy/forge-source"),
    FOUNDRY_OUT:resolve(out,"forge-out"),FOUNDRY_CACHE_PATH:resolve(out,"forge-cache"),
    ...extra};
  for(const[prefix,data]of [["FAMILY_PRESTATE_JSON_",canonical],["FAMILY_EXECUTION_JSON_",execution]]){
    assert(data.length<=480000);for(let i=0;i<4;i++)env[prefix+"ABCD"[i]]=data.slice(i*120000,(i+1)*120000);
  }
  const child=spawn(resolve(ROOT,"logs/family-three-prestate.IIERDy/foundry-v1.8.5/forge"),
    ["test","--root",ROOT,"--config-path",testConfigPath,"--use","0.8.31","--evm-version","osaka","--match-contract",kind==="reads"?"OriginalStateReadProof":"OriginalRuntimeOutputProof",
      "--match-test",kind==="reads"?"testOriginalStateReads":"testOriginalRuntimeOutputs","-vv"],{cwd:ROOT,env,stdio:["ignore","pipe","pipe"]});
  let text="",expired=false;
  for(const stream of [child.stdout,child.stderr])stream.on("data",b=>{const s=redact(b.toString());text+=s;writeFileSync(fd,s);});
  const timer=setTimeout(()=>{expired=true;child.kill("SIGTERM");},Math.min(180000,deadline-Date.now()));
  const result=await new Promise<{code:number|null;signal:string|null;error?:string}>(resolve=>{
    child.once("error",e=>resolve({code:null,signal:null,error:redact(e.message)}));child.once("close",(code,signal)=>resolve({code,signal}));});
  clearTimeout(timer);fsyncSync(fd);closeSync(fd);
  const method=kind==="reads"?"testOriginalStateReads":"testOriginalRuntimeOutputs";
  const contract=kind==="reads"?"OriginalStateReadProof":"OriginalRuntimeOutputProof";
  const clean=text.replace(/\x1b\[[0-9;]*m/g,"");
  const tests=clean.split("\n").filter(l=>/^\[(?:PASS|FAIL[^\]]*|SKIP)\]/.test(l));
  const targetPassed=tests.length===1&&tests[0].startsWith("[PASS] "+method+"() ")&&
    clean.includes("Suite result: ok. 1 passed; 0 failed; 0 skipped;")&&
    new RegExp("^Ran 1 test for .+:"+contract+"$","m").test(clean);
  const receipt={kind,targetTest:method+"()",targetPassed,...result,timedOut:expired,elapsedMs:Date.now()-start,log,logSha256:sha(readFileSync(log))};
  write(log+".json",receipt);console.log(json({block:fixture.block,...receipt}));
  assert(result.code===0&&!expired&&!result.error&&targetPassed,"native proof failed or target not passed; see "+log+" "+text.slice(-1200));
  return receipt;
}
type Read={kind:number;to:string;from?:string;data?:string;slot?:string};
try{
  const envelope=await new UniverseRebuildCheckpointStore({path:fixture.ready.path}).load();assert(envelope&&!envelope.inProgressRun);
  const {ready,graph}=resolveStrictReadyRuntime(envelope.readyGeneration),source=ready.cutoff;
  assert.equal(source.number,fixture.block);assert(same(source.hash,sample.hash));
  const wiring=createRebuildWiring({rpcUrl:"http://127.0.0.1:8593",familyIds:[...new Set(sample.cases.map(c=>c.family))],
    executionIdentity:{executor:fixture.executor,transactionOrigin:fixture.owner}});
  const scripts:Uint8Array[]=[];
  for(let leg=0;leg<sample.cases.length;leg++){
    const c=sample.cases[leg],family=asPricedFamily(catalog.forStrictFamily(c.family as any));
    const memos:ReturnType<typeof activeReadyMemos>=activeReadyMemos(envelope).filter(m=>m.familyId===c.family&&m.instanceKey===c.instance);assert.equal(memos.length,1);
    const memo=memos[0];assert([familyDefinitionHash(c.family),familyMemoDefinitionHash(c.family)].includes(memo.familyDefinitionHash));
    const instance=wiring.rehydrateVerifiedInstance({memo,cutoff:source}) as PreparedFamilyInstance;
    assertIssuedPreparedFamilyInstance({family,instance,source,generation:source.generation});
    assert.equal(graph.filter(e=>e.instanceKey===instance.instanceKey).length,c.directions);
    const routes=instance.routes.filter(r=>same(r.tokenIn,c.tokenIn)&&same(r.tokenOut,c.tokenOut));assert.equal(routes.length,1);
    const handles=instance.routeHandles.filter(h=>h.routeKey===routes[0].routeKey);assert.equal(handles.length,1);
    type Pending={request:Read;resolve:(s:string)=>void;reject:(e:unknown)=>void};
    let pending:Pending[]=[],scheduled=false;let tail=Promise.resolve();
    const run=async(batch:Pending[])=>{
      try{
        reads+=batch.length;assert(reads<=96,"native read cap");
        const request={fixtureSha256:"0x"+sha(Buffer.from(executionPayload)),tx:fixture.tx,block:fixture.block,leg,prefixCount:leg,
          prefixCalls:fixture.programs.slice(0,leg).map((p:any)=>buildExecuteCalldata(runtimeProgramScript(ethers.getBytes(p.program),BigInt(p.amountIn)))),
          count:batch.length,requests:batch.map(p=>p.request)};
        const payload=json(request),n=report.reads.length;
        const requestPath=resolve(out,fixture.block+".read"+n+".request.json"),replyPath=resolve(out,fixture.block+".read"+n+".reply.json");
        writeFileSync(requestPath,payload,{flag:"wx",mode:0o600});
        const receipt=await forge("reads",executionPayload,{FAMILY_READ_JSON:payload,FAMILY_READ_OUTPUT:replyPath});
        const replyBytes=readFileSync(replyPath),reply=JSON.parse(replyBytes.toString());
        assert.equal(reply.requestSha256,"0x"+sha(Buffer.from(payload)));assert.equal(reply.count,batch.length);assert.equal(reply.results.length,batch.length);
        report.reads.push({leg,requestPath,requestSha256:sha(Buffer.from(payload)),replyPath,replySha256:sha(replyBytes),receipt});
        batch.forEach((p,i)=>{const r=reply.results[i];assert(typeof r.ok==="boolean"&&ethers.isHexString(r.data));
          if(r.ok)p.resolve(r.data);else p.reject(Object.assign(new Error("Native eth_call revert"),{code:"CALL_EXCEPTION",data:r.data}));});
      }catch(e){batch.forEach(p=>p.reject(e));}
    };
    const read=(request:Read,block?:number)=>{assert.equal(block,source.number);return new Promise<string>((resolve,reject)=>{
      pending.push({request,resolve,reject});if(!scheduled){scheduled=true;setTimeout(()=>{scheduled=false;const batch=pending;pending=[];tail=tail.then(()=>run(batch));},0);}
    });};
    if(c.family==="balancer-v1"){
      const d=instance.descriptor as any;
      const functions=[["isFinalized",[]],["isPublicSwap",[]],["getFinalTokens",[]],["getSwapFee",[]],
        ...d.tokens.map((t:string)=>["getDenormalizedWeight",[t]])] as [string,unknown[]][];
      const results=await Promise.all([
        ...functions.map(([name,args])=>read({kind:0,to:d.pool,from:ethers.ZeroAddress,data:POOL.encodeFunctionData(name,args)},source.number)),
        read({kind:1,to:d.pool},source.number),read({kind:1,to:d.factory},source.number),
        read({kind:0,to:d.factory,from:ethers.ZeroAddress,data:FACTORY.encodeFunctionData("isBPool",[d.pool])},source.number)]);
      const values=functions.map(([name],i)=>POOL.decodeFunctionResult(name,results[i])[0]);
      assert.equal(values[0],true);assert.equal(values[1],true);
      assert.deepEqual([...values[2]].map(t=>String(t).toLowerCase()),d.tokens.map((t:string)=>t.toLowerCase()));
      assert.equal(values[3],d.swapFee);assert.deepEqual(values.slice(4),d.weights);
      assert.equal(ethers.keccak256(results[functions.length]),d.poolCodeHash);
      assert.equal(ethers.keccak256(results[functions.length+1]),d.factoryCodeHash);
      assert.equal(FACTORY.decodeFunctionResult("isBPool",results.at(-1)!)[0],true);
      report.originalV1BindingChecked=true;
    }
    const runtime=createStrictCentralAdapterRuntime({executor:fixture.executor,transactionOrigin:fixture.owner,
      generationFence:{assertCurrent(g,s){assert.equal(g,source.generation);assert.deepEqual(s,source);}},
      provider:{call:(t,b)=>read({kind:0,to:t.to,from:t.from??ethers.ZeroAddress,data:t.data},b),
        getCode:(to,b)=>read({kind:1,to},b),getStorage:(to,slot,b)=>read({kind:2,to,slot},b)}});
    const quote=await executeFamilyExactQuote({family,route:handles[0],amountIn:c.amountIn,source,generation:source.generation,
      executor:fixture.executor,runtimeEvidence:[],runtime,control:{signal:AbortSignal.timeout(Math.max(1,deadline-Date.now())),deadlineAtMs:deadline}});
    await tail;assert.equal(quote.status,"resolved",json(quote));if(quote.status!=="resolved")throw Error("quote unresolved");
    assert.equal(quote.amountIn,c.amountIn);assert.deepEqual(quote.source,source);assert.equal(quote.amountOut,c.amountOut,"original raw output parity");
    const fragment=buildFamilyExecutionFragment({family,route:handles[0],exact:quote,minAmountOut:quote.amountOut,
      executor:fixture.executor,runtimeEvidence:[],actionOwnership:catalog});
    assert.equal(fragment.status,"resolved");if(fragment.status!=="resolved")throw Error("quoted encoder unresolved");
    const adapters=[...family.plugin.actionAdapters,...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const encode=(n:ResolvedPlanNode):Uint8Array=>{const a=adapters.find(a=>a.id===n.adapterId);assert(a);return a.encode(n,fixture.executor,concatBytes(...n.children.map(encode)));};
    const script=concatBytes(...planFragmentNodes(fragment.fragment,c.tokenIn,c.amountIn).map(encode));scripts.push(script);
    report.quotes.push({leg,family:c.family,instance:c.instance,tokenIn:c.tokenIn,tokenOut:c.tokenOut,amountIn:c.amountIn,
      originalAmountOut:c.amountOut,quoteAmountOut:quote.amountOut,signedDelta:quote.amountOut-c.amountOut,quotedScriptHash:ethers.keccak256(script),prefixLegs:leg});
    console.log(json({block:fixture.block,leg,family:c.family,quoteAmountOut:quote.amountOut,originalAmountOut:c.amountOut}));
  }
  const script=concatBytes(...scripts),quoted={...fixture,claim:"Original-amount production Exact and quoted-fragment parity",
    calldata:buildExecuteCalldata(script),scriptHash:ethers.keccak256(script),quoteProof:{quotes:report.quotes,reads:report.reads}};
  const quotedPath=resolve(out,fixture.block+".quoted-fixture.json");write(quotedPath,quoted);
  report.quotedFixture={path:quotedPath,sha256:sha(readFileSync(quotedPath))};
  report.execution=await forge("execute",JSON.stringify(JSON.parse(readFileSync(quotedPath,"utf8"))));
  report.status="pass";
}catch(e){report.error=redact(e instanceof Error?e.stack:e);process.exitCode=1;console.error(report.error);
}finally{
  try{assert.deepEqual(testPin(),testedCode);assert.deepEqual(sourcePin(),pin);assert.equal(sha(readFileSync(fixture.ready.path)),sha(readyBytes));assert.equal(sha(readFileSync(fixture.capture.path)),sha(captureBytes));report.inputsUnchanged=true;}
  catch(e){report.inputsUnchanged=false;report.status="failed";report.error=redact(e);process.exitCode=1;}
  report.runCount=runCount;report.readCount=reads;report.timingScope="Setup/proof only, no live latency claim";
  writeFileSync(reportFd,json(report)+"\n");fsyncSync(reportFd);closeSync(reportFd);
  console.log(json({status:report.status,report:reportPath,quotes:report.quotes.length,nativeRuns:runCount,reads}));
}
