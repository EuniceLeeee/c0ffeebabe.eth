import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/vault-spot.production.js";
import { ABI, CODE_HASH, rootRequests, decodeRoot, reverseRequests, assertReverse, pair } from "../codec.js";
import { exactProgram } from "../exact.js";
import { decodeReceipt, simulationRequest } from "../simulation.js";
import { decodeSwapLog, LOG, CALL } from "../discovery.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { V,A,B,E,OTHER,FEED,SOURCE,answer,returned,descriptor,inputFor,receipt } from "./fixtures.js";

test("runtime profile and reverse USDG/router/utils registration, with no instance address allowlist",()=>{
  const d=descriptor();assert.equal(d.codeHash,CODE_HASH);assert.equal(d.tokens.length,2);
  const other=descriptor(OTHER);assert.equal(other.vault,OTHER);assert.notEqual(d.instanceKey,other.instanceKey);
  for(const [id,fn,v] of [["router-vault","vault",OTHER],["router-usdg","usdg",OTHER],["utils-vault","vault",OTHER],["usdg-member","vaults",false]] as const)
    assert.throws(()=>descriptor(V,r=>r.id===id?returned(id,ABI.encodeFunctionResult(fn,[v])):r),/reverse/);
  assert.throws(()=>descriptor(V,r=>r.id==="listed:0"?returned(r.id,ABI.encodeFunctionResult("whitelistedTokens",[false])):r),/retryable/);
  assert.throws(()=>descriptor(V,r=>r.id==="erc20-decimals:0"?returned(r.id,ABI.encodeFunctionResult("decimals",[6n])):r),/decimals/);
  assert.throws(()=>descriptor(V,r=>r.id==="router-vault"?{...r,source:{...SOURCE,number:SOURCE.number+1}}:r),/source/);
});
test("unsupported runtime is a proved mismatch while transport failure is never admission",()=>{
  const p=pair(V,[A,B]),candidate={candidateKind:"vault-spot-pair" as const,vault:V,tokens:p.tokens},v=plugin.identity.variants[0],i={candidate,step:0};
  const evidence=v.decode({step:i,results:[returned("vault-code","0x6000")]});
  assert.equal(v.decide({...i,evidence}).status,"chain-proven-rejected");
  assert.throws(()=>v.decode({step:i,results:[{id:"vault-code",ok:false,source:SOURCE,failure:"rpc"}]}));
});
test("real Swap ABI discovers a pair, canonical calldata only; two directions keep one shared Vault identity",()=>{
  const log=ABI.encodeEventLog(ABI.getEvent("Swap")!,[E,A,B,71854376210288490340n,4444267399301724n,4430934597103818n,30n]);
  assert.equal(decodeSwapLog(log)!.amountOut,4430934597103818n);
  assert.equal(decodeSwapLog({...log,data:log.data+"00"}),null);
  const c=plugin.discovery.decodeCandidate({observation:{kind:"log",source:SOURCE,address:V,...log},matchedPatternId:LOG});assert(c);
  const data=ABI.encodeFunctionData("swap",[A,B,E]);
  const call={kind:"call" as const,source:SOURCE,target:V,data};
  assert.deepEqual(plugin.discovery.decodeCandidate({observation:call,matchedPatternId:CALL}),c);
  assert.equal(plugin.discovery.decodeCandidate({observation:{...call,data:data+"00"},matchedPatternId:CALL}),null);
  const d=descriptor(),rs=plugin.routes.project({descriptor:d});assert.equal(rs.length,2);
  for(const r of rs) assert.deepEqual(plugin.routes.projectGraph({descriptor:d,route:r}).venueIdentity,{kind:"address-pool",pool:V});
});
test("current pricing uses swap-mode prices and gross pool depth, resolving changed oracle helpers anew",()=>{
  const d=descriptor(),routes=plugin.routes.project({descriptor:d}),initial=plugin.pricing.current.buildRequests({descriptor:d,routes,source:SOURCE}).map(r=>answer(r));
  const input={descriptor:d,routes,source:SOURCE};
  const round=plugin.pricing.current.buildDependentProgram!({current:input,completedRound:0,initialResults:initial,priorEvidence:[]})!;
  for(const r of round.requests.filter(r=>r.id.startsWith("min:")||r.id.startsWith("max:"))) {
    assert(r.kind==="eth-call");assert.equal(ABI.decodeFunctionData("getPrice",r.data)[3],true);
  }
  const evidence=round.decode(round.requests.map(r=>answer(r)));
  const s=plugin.pricing.current.decodeSnapshot({descriptor:d,initialResults:initial,dependentEvidence:[evidence]});
  assert.deepEqual(s.available,[999500n,999500n]);
  assert.equal(plugin.pricing.refreshPolicy,"each-block");
  assert.equal(plugin.pricing.current.deriveMids({descriptor:d,routes,snapshot:s}).size,2);
  const changed=initial.map(r=>r.id==="priceFeed"?returned(r.id,ABI.encodeFunctionResult("priceFeed",[OTHER])):r);
  const round2=plugin.pricing.current.buildDependentProgram!({current:input,completedRound:0,initialResults:changed,priorEvidence:[]})!;
  const price=round2.requests.find(r=>r.id==="min:0")!;assert(price.kind==="eth-call");assert.equal(price.to.toLowerCase(),OTHER);
  assert.notEqual(price.to.toLowerCase(),FEED);
  assert.equal(plugin.pricing.current.deriveMids({descriptor:d,routes,snapshot:{...s,active:false}}).size,0);
});
test("Exact preserves every specified raw input and requires the four balance, two supply, native and event effects",()=>{
  const d=descriptor();
  for(const route of plugin.routes.project({descriptor:d})) for(const value of [1n,91n,71854376210288490340n,143708752420576980680n]) {
    const i=inputFor(d,route,value),initial=exactProgram.buildRequests(i).map(r=>answer(r));
    const round=exactProgram.buildDependentProgram!({programInput:i,completedRound:0,initialResults:initial,priorEvidence:[]})!;
    const sim=round.requests.find(r=>r.id==="spot-exact")!;assert(sim.kind==="effect-delta-simulation");
    assert.equal(sim.overrideIntent.tokenBalances![0].amount,value);
    assert.equal(sim.call.executionMode,"executor-program");assert.equal(sim.call.to,E);
    const raw=ethers.getBytes(ABI.decodeFunctionData("execSubscript",sim.call.data)[0]);
    assert.equal(BigInt(ethers.hexlify(raw.slice(1,33))),value);
    const good=receipt(d,route,value);assert(good.ok);
    const results=round.requests.map(r=>r.id==="spot-exact"?good:answer(r));
    const q=exactProgram.decode({programInput:i,initialResults:initial,dependentEvidence:[round.decode(results)]});
    assert.equal(q.amountOut,97n);assert.equal(q.evidence.amountIn,value);
    for(let k=0;k<4;k++) assert.throws(()=>decodeReceipt([{...good,effects:{...good.effects,tokenDeltas:good.effects!.tokenDeltas!.map((x,j)=>j===k?{...x,delta:x.delta+1n}:x)}}],d,route,value,E));
    assert.throws(()=>decodeReceipt([{...good,effects:{...good.effects,logs:[]}}],d,route,value,E));
    assert.throws(()=>decodeReceipt([{...good,effects:{...good.effects,nativeDeltas:[{account:E,delta:1n}]}}],d,route,value,E));
  }
  assert.deepEqual(exactProgram.buildRequests(inputFor(d,undefined,0n)),[]);
  assert.throws(()=>exactProgram.buildRequests(inputFor(d,undefined,-1n)));
});
test("quoted/runtime enforce fresh full debit, Vault receipt and output minimum while isolating old inventory",()=>{
  const d=descriptor();
  for(const r of plugin.routes.project({descriptor:d})) for(const value of [1n,91n,71854376210288490340n]) {
    const i=inputFor(d,r,value),exactEvidence={kind:"vault-spot-execution" as const,source:SOURCE,executor:E,binding:r.bindingRef.fingerprint,routeKey:r.routeKey,amountIn:value,amountOut:97n};
    const f=plugin.execution.buildFragment({...i,quotedAmountOut:97n,minAmountOut:97n,exactEvidence});assert(f.nodes&&f.nodes.length===1);
    const encoded=plugin.actionAdapters[0].encode(f.nodes[0],E,new Uint8Array());
    const quoted=ethers.hexlify(encoded.slice(36)),runtime=plugin.execution.buildRuntimeLeg!(i)!.program;
    function run(program:string,trial:bigint,options:{debit?:bigint;credit?:bigint;vaultReceipt?:bigint;pending?:bigint;reported?:bigint;ledger?:boolean;native?:bigint}={}) {
      let transferred=false,swapped=false;const credit=options.credit??97n,debit=options.debit??trial,pending=options.pending??0n;
      const result=inspectRuntime(program,trial,{nativeBalance:()=>17n+(swapped?(options.native??0n):0n),call:c=>{
        const parsed=ABI.parseTransaction({data:c.data})!,account=parsed.args[0]?.toString().toLowerCase();
        if(parsed.name==="balanceOf") {
          const incoming=c.target.toLowerCase()===r.tokenIn;
          const balance=account===E ? incoming?101n+trial-(swapped?debit:0n):103n+(swapped?credit:0n) :
            1000n+pending+(transferred?(options.vaultReceipt??trial):0n);
          return ABI.encodeFunctionResult("balanceOf",[balance]);
        }
        if(parsed.name==="tokenBalances")return ABI.encodeFunctionResult("tokenBalances",[1000n+(swapped&&options.ledger!==false?trial:0n)]);
        if(parsed.name==="transfer") { assert.equal(parsed.args[0].toLowerCase(),V);assert.equal(parsed.args[1],trial);transferred=true;return ABI.encodeFunctionResult("transfer",[true]); }
        assert.equal(parsed.name,"swap");assert.deepEqual([...parsed.args].map(x=>x.toLowerCase()),[r.tokenIn,r.tokenOut,E]);swapped=true;
        return ABI.encodeFunctionResult("swap",[options.reported??credit]);
      }});
      assert.equal(result.registers[0],trial);assert.equal(result.allowances.length,0);return result;
    }
    run(quoted,value);run(runtime,value+17n);
    for(const program of [quoted,runtime]) {
      assert.throws(()=>run(program,0n));
      for(const debit of [0n,value-1n,value+1n])assert.throws(()=>run(program,value,{debit}));
      assert.throws(()=>run(program,value,{credit:0n}));
      assert.throws(()=>run(program,value,{vaultReceipt:value-1n}));
      assert.throws(()=>run(program,value,{pending:1n}));
      assert.throws(()=>run(program,value,{reported:98n}));
      assert.throws(()=>run(program,value,{ledger:false}));
      assert.throws(()=>run(program,value,{native:1n}));
    }
    assert.throws(()=>run(quoted,value,{credit:96n}));
    assert.throws(()=>plugin.execution.buildFragment({...i,quotedAmountOut:97n,minAmountOut:97n,exactEvidence:{...exactEvidence,amountIn:value+1n}}),/evidence/);
  }
});

test("strict startup nomination reads opaque transaction coordinates and binds the exact Vault market",async()=>{
  const tx="0x"+"a".repeat(64), otherToken="0x1000000000000000000000000000000000000004";
  const event=(vault:string,inToken=A)=>({address:vault,...ABI.encodeEventLog(ABI.getEvent("Swap")!,[E,inToken,B,91n,97n,97n,0n])});
  const receipt={blockNumber:SOURCE.number,logs:[event(OTHER),event(V,otherToken),event(V)]};let reads=0;
  const provider={async getTransactionReceipt(hash:string){assert.equal(hash,tx);reads++;return receipt;}} as never;
  const nominations=[{address:V,opaque:{adapter:"vault-spot",vault:V,tokens:[A,B],transactionHash:tx,blockNumber:SOURCE.number}}];
  const result=await plugin.discovery.nominate!.nominate({nominations,source:SOURCE,provider});
  assert.equal(reads,1);assert.equal(result.length,1);assert.equal(result[0].kind,"log");
  if(result[0].kind==="log")assert.deepEqual(decodeSwapLog(result[0])!.tokenIn,A);
  assert.equal((await plugin.discovery.nominate!.nominate({nominations:[{...nominations[0],opaque:{...nominations[0].opaque,blockNumber:SOURCE.number-1}}],source:SOURCE,provider})).length,0);
  assert.equal((await plugin.discovery.nominate!.nominate({nominations:[{address:V,opaque:{tokens:[A,B]}}],source:SOURCE,provider})).length,0);
});
