import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/few-wrapped.production.js";
import { ABI, MAX_UINT, guardRequests, decodeBinding, assertCurrentBinding } from "../codec.js";
import { exactProgram } from "../exact.js";
import { conversionRequest, decodeReceipt } from "../simulation.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { SOURCE, TARGET, ASSET, FACTORY, EXECUTOR, OTHER, answer, descriptor, inputFor, returned, receipt } from "./fixtures.js";
import type { ObservedEffects } from "../../../adapter-request-program.js";

test("only wrap and unwrap are projected; permissioned mint/burn are excluded", () => {
  assert.equal(plugin.manifest.domain, "protocol");
  assert.deepEqual(plugin.manifest.ownedActionAdapterIds, ["few-wrap", "few-unwrap"]);
  assert.equal(plugin.protocol.activeBehaviorProof, "required");
  const d = descriptor(), routes = plugin.routes.project({ descriptor: d });
  assert.deepEqual(routes.map(r => [r.tokenIn,r.tokenOut]), [[ASSET,TARGET],[TARGET,ASSET]]);
  assert(routes.every(r => !r.routeKey.includes("\\u001f")));
  for (const r of routes) assert.equal(plugin.routes.projectGraph({ descriptor: d, route: r }).executionTarget, TARGET);
});

test("all four observed calls nominate, and malformed or zero inputs cannot nominate", () => {
  for (const fn of ["wrap", "unwrap", "wrapTo", "unwrapTo"]) {
    const args = fn.endsWith("To") ? [123n,EXECUTOR] : [123n];
    const observation = { kind: "call" as const, source: SOURCE, target: TARGET, data: ABI.encodeFunctionData(fn,args) };
    assert(plugin.discovery.decodeCandidate({ observation, matchedPatternId: `few-${fn}-call` }));
    for (const data of [observation.data+"00", observation.data.slice(0,10), ABI.encodeFunctionData(fn, fn.endsWith("To") ? [0n,EXECUTOR] : [0n])])
      assert.equal(plugin.discovery.decodeCandidate({ observation: {...observation,data}, matchedPatternId: `few-${fn}-call` }),null);
  }
  for (const name of ["Wrap", "Unwrap"]) {
    const event = ABI.encodeEventLog(ABI.getEvent(name)!,[EXECUTOR,123n,EXECUTOR]);
    assert(plugin.discovery.decodeCandidate({ observation: {kind:"log",source:SOURCE,address:TARGET,...event}, matchedPatternId:`few-${name}-log` }));
  }
});

test("reverse factory registration is mandatory and another deployment needs no address allowlist", () => {
  const d = descriptor();
  assert.equal(d.factory,FACTORY);
  const alternate = ethers.getAddress("0x2000000000000000000000000000000000000001");
  const d2 = descriptor(r=>answer(r,SOURCE,alternate),alternate);
  assert.equal(d2.target,alternate); assert.notEqual(d.instanceKey,d2.instanceKey);
  const results = guardRequests(d).map(r=>answer(r));
  for (const [id,fn,value] of [["few-member","getWrappedToken",OTHER],["few-factory","factory",OTHER],["few-asset","token",OTHER]] as const)
    assert.throws(()=>decodeBinding(d,results.map(r=>r.id===id?returned(id,ABI.encodeFunctionResult(fn,[value])):r)),/binding/);
  for (const id of ["few-code","few-asset-code","few-factory-code"])
    assert.throws(()=>decodeBinding(d,results.map(r=>r.id===id?returned(id,"0x"):r)));
  assert.throws(()=>assertCurrentBinding(d,results.map(r=>r.id==="few-asset-code"?returned(r.id,"0x60016000"):r)),/changed/);
  assert.throws(()=>decodeBinding(d,results.map((r,i)=>i===0?{...r,source:{...SOURCE,number:SOURCE.number+1}}:r)),/source/);
});

test("strict requires positive backed capacity and rejects unsupported code without effects", () => {
  const candidate = {candidateKind:"few-wrapper" as const,target:TARGET}, variant=plugin.identity.variants[0]!;
  const first={candidate,step:0};
  const unsupported=variant.decode({step:first,results:[returned("few-code","0x6000")]});
  assert.equal(variant.decide({...first,evidence:unsupported}).status,"chain-proven-rejected");
  assert.throws(()=>descriptor(r=>r.id==="few-backing"?returned(r.id,ABI.encodeFunctionResult("balanceOf",[0n])):answer(r)),/retryable|verified/);
});

test("receipt validates actual debit, credit, supply, backing, caller, native and event", () => {
  const d=descriptor();
  for (const direction of ["wrap","unwrap"] as const) for (const value of [1n,4387060682263585n,2n*4387060682263585n]) {
    const good=receipt("probe",direction,value);assert(good.ok);
    assert.equal(decodeReceipt([good],"probe",d,direction,value,EXECUTOR).amountOut,value);
    assert.throws(()=>decodeReceipt([good],"probe",d,direction,value,OTHER),/actor/);
    const e=good.effects!;
    const bad:ObservedEffects[]=[...e.tokenDeltas!.map((_,i)=>({...e,tokenDeltas:e.tokenDeltas!.map((r,j)=>i===j?{...r,delta:r.delta+1n}:r)})),
      {...e,tokenDeltas:e.tokenDeltas!.slice(0,2)}, {...e,tokenDeltas:[...e.tokenDeltas!,e.tokenDeltas![0]!] },
      {...e,totalSupplyDeltas:[]},{...e,totalSupplyDeltas:[{token:TARGET,delta:0n}]},
      {...e,nativeDeltas:[]},{...e,nativeDeltas:[{account:EXECUTOR,delta:-1n}]}, {...e,logs:[]}];
    for(const effects of bad)assert.throws(()=>decodeReceipt([{...good,effects}],"probe",d,direction,value,EXECUTOR));
    assert.throws(()=>decodeReceipt([{...good,data:ABI.encodeFunctionResult(direction,[value-1n])}],"probe",d,direction,value,EXECUTOR));
  }
});

test("Exact preserves requested units and never substitutes the identity probe amount", () => {
  const d=descriptor();
  for (const route of plugin.routes.project({descriptor:d})) for (const value of [1n,4387060682263585n,8774121364527170n,MAX_UINT]) {
    const i=inputFor(d,route,value), requests=exactProgram.buildRequests(i), simulation=requests.find(r=>r.kind==="effect-delta-simulation")!;
    assert(simulation.kind==="effect-delta-simulation");assert.equal(ABI.decodeFunctionData(route.direction,simulation.call.data)[0],value);
    const q=exactProgram.decode({programInput:i,initialResults:requests.map(r=>answer(r)),dependentEvidence:[]});
    assert.equal(q.amountOut,value);assert.equal(q.evidence.amountIn,value);
    assert.equal(simulation.overrideIntent?.tokenBalances?.length,1);
    assert.equal(simulation.overrideIntent?.tokenBalances?.[0]?.token,route.tokenIn);
  }
  const zero=inputFor(d,undefined,0n);assert.deepEqual(exactProgram.buildRequests(zero),[]);
  assert.equal(exactProgram.decode({programInput:zero,initialResults:[],dependentEvidence:[]}).amountOut,0n);
  for(const n of [-1n,MAX_UINT+1n])assert.throws(()=>exactProgram.buildRequests(inputFor(d,undefined,n)),/uint256/);
});

test("quoted and runtime encodings use the actual amount and clean temporary wrap approvals", () => {
  const d=descriptor();
  for (const route of plugin.routes.project({descriptor:d})) for (const value of [1n,91n,4387060682263585n]) {
    const i=inputFor(d,route,value), q=exactProgram.decode({programInput:i,initialResults:exactProgram.buildRequests(i).map(r=>answer(r)),dependentEvidence:[]});
    const f=plugin.execution.buildFragment({...i,quotedAmountOut:q.amountOut,minAmountOut:q.amountOut,exactEvidence:q.evidence});
    assert(f.nodes && f.nodes.length===1);const n=f.nodes[0]!;
    const adapter=plugin.actionAdapters.find(a=>a.id===route.adapterId)!;
    assert(adapter.encode(n,EXECUTOR,new Uint8Array()).length>0);
    assert.throws(()=>adapter.encode({...n,amount:0n},EXECUTOR,new Uint8Array()),/uint256/);
    assert.throws(()=>plugin.execution.buildFragment({...i,quotedAmountOut:q.amountOut,minAmountOut:q.amountOut,exactEvidence:{...q.evidence,amountIn:value+1n}}),/evidence/);
    const leg=plugin.execution.buildRuntimeLeg!(i)!;assert(leg);
    const trace=inspectRuntime(leg.program,value+17n,{call:c=>c.data.startsWith(ABI.getFunction("allowance")!.selector)?ABI.encodeFunctionResult("allowance",[0n]):"0x"}), call=trace.calls.find(c=>c.target.toLowerCase()===TARGET.toLowerCase())!;
    assert.equal(ABI.decodeFunctionData(route.direction,call.data)[0],value+17n);
    const approvals=trace.calls.filter(c=>c.target.toLowerCase()===ASSET.toLowerCase()&&c.data.startsWith(ABI.getFunction("approve")!.selector));
    assert.deepEqual(approvals.map(c=>ABI.decodeFunctionData("approve",c.data)[1]),route.direction==="wrap"?[0n,value+17n,0n]:[]);
    assert.equal(trace.allowances.length,0);
    assert.throws(()=>plugin.execution.buildRuntimeLeg!({...i,route:{...route,tokenOut:OTHER}}),/binding/);
  }
});

test("quoted encoding enforces new output and exact input debit with old inventory", () => {
  const d=descriptor(),value=91n;
  for(const route of plugin.routes.project({descriptor:d})){
    const i=inputFor(d,route,value),q=exactProgram.decode({programInput:i,initialResults:exactProgram.buildRequests(i).map(r=>answer(r)),dependentEvidence:[]});
    const f=plugin.execution.buildFragment({...i,quotedAmountOut:q.amountOut,minAmountOut:value,exactEvidence:q.evidence});
    assert(f.nodes&&f.nodes.length===1);const n=f.nodes[0]!,a=plugin.actionAdapters.find(a=>a.id===route.adapterId)!;
    assert.equal(n.params.minAmountOut,value);
    const encoded=a.encode(n,EXECUTOR,new Uint8Array());assert.equal(encoded[0],0x0e);
    const run=(debit:bigint,credit:bigint)=>{
      let converted=false;
      return inspectRuntime(ethers.hexlify(encoded.slice(36)),value,{call:c=>{
        const parsed=ABI.parseTransaction({data:c.data})!;
        if(parsed.name==="balanceOf"){
          const isInput=c.target.toLowerCase()===route.tokenIn.toLowerCase();
          return ABI.encodeFunctionResult("balanceOf",[isInput?101n+value-(converted?debit:0n):103n+(converted?credit:0n)]);
        }
        if(parsed.name==="approve")return ABI.encodeFunctionResult("approve",[true]);
        if(parsed.name==="allowance")return ABI.encodeFunctionResult("allowance",[0n]);
        assert.equal(parsed.name,route.direction);assert.equal(parsed.args[0],value);converted=true;
        return ABI.encodeFunctionResult(route.direction,[value]);
      }});
    };
    run(value,value);
    for(const credit of [0n,value-1n])assert.throws(()=>run(value,credit),/checked uint256/);
    for(const debit of [0n,value-1n,value+1n])assert.throws(()=>run(debit,value));
    for(const minAmountOut of [-1n,MAX_UINT+1n,"91",undefined])
      assert.throws(()=>a.encode({...n,params:{minAmountOut} as never},EXECUTOR,new Uint8Array()),/uint256/);
  }
});

test("both wrap encodings reject an uncleared approval even if approve returns false", () => {
  const d=descriptor(),route=plugin.routes.project({descriptor:d}).find(r=>r.direction==="wrap")!,value=91n,i=inputFor(d,route,value);
  const q=exactProgram.decode({programInput:i,initialResults:exactProgram.buildRequests(i).map(r=>answer(r)),dependentEvidence:[]});
  const f=plugin.execution.buildFragment({...i,quotedAmountOut:value,minAmountOut:value,exactEvidence:q.evidence});
  assert(f.nodes&&f.nodes.length===1);
  const encoded=plugin.actionAdapters.find(a=>a.id===route.adapterId)!.encode(f.nodes[0]!,EXECUTOR,new Uint8Array());
  const programs=[plugin.execution.buildRuntimeLeg!(i)!.program,ethers.hexlify(encoded.slice(36))];
  for(const program of programs){
    const run=(residual:bigint)=>{
      let converted=false;
      return inspectRuntime(program,value,{call:c=>{
        const parsed=ABI.parseTransaction({data:c.data})!;
        if(parsed.name==="approve")return ABI.encodeFunctionResult("approve",[false]);
        if(parsed.name==="allowance")return ABI.encodeFunctionResult("allowance",[residual]);
        if(parsed.name==="balanceOf"){
          const input=c.target.toLowerCase()===ASSET.toLowerCase();
          return ABI.encodeFunctionResult("balanceOf",[input?101n+(converted?0n:value):103n+(converted?value:0n)]);
        }
        assert.equal(parsed.name,"wrap");converted=true;return ABI.encodeFunctionResult("wrap",[value]);
      }});
    };
    run(0n);
    assert.throws(()=>run(1n),/runtime amount mismatch/);
  }
});


test("direct receiver enforces positive exact 1:1 debit, reported return and new receipt", () => {
  const d=descriptor(),value=91n;
  for(const route of plugin.routes.project({descriptor:d}))for(const recipient of [OTHER,EXECUTOR]){
    const i=inputFor(d,route,value),request={kind:"direct-output" as const,recipient};
    const leg=plugin.execution.buildRuntimeLeg!({...i,settlement:request})!;assert(leg);assert.deepEqual(leg.settlementRequest,request);
    const run=(debit=value,credit=value,reported=value,oldSpent=0n,residual=0n,requested=value,nativeDelta=0n)=>{
      let converted=false;
      return inspectRuntime(leg.program,requested,{nativeBalance:()=>17n+(converted?nativeDelta:0n),call:c=>{
        const parsed=ABI.parseTransaction({data:c.data})!;
        if(parsed.name==="balanceOf"){
          const input=c.target.toLowerCase()===route.tokenIn.toLowerCase(),actor=parsed.args[0].toLowerCase()===EXECUTOR.toLowerCase();
          const opening=input?(actor?value+101n:107n):(actor?103n:109n);
          const delta=input?(actor?-debit:0n):((parsed.args[0].toLowerCase()===recipient.toLowerCase()?credit:0n)-(actor?oldSpent:0n));
          return ABI.encodeFunctionResult("balanceOf",[opening+(converted?delta:0n)]);
        }
        if(parsed.name==="approve")return ABI.encodeFunctionResult("approve",[true]);
        if(parsed.name==="allowance")return ABI.encodeFunctionResult("allowance",[residual]);
        assert.equal(parsed.name,`${route.direction}To`);assert.equal(parsed.args[0],requested);assert.equal(parsed.args[1].toLowerCase(),recipient.toLowerCase());converted=true;
        return ABI.encodeFunctionResult(parsed.name,[reported]);
      }});
    };
    run();
    for(const debit of [0n,value-1n,value+1n])assert.throws(()=>run(debit));
    for(const credit of [0n,value-1n,value+1n])assert.throws(()=>run(value,credit));
    for(const reported of [0n,value-1n,value+1n])assert.throws(()=>run(value,value,reported));
    assert.throws(()=>run(value,value,value,1n));assert.throws(()=>run(0n,0n,0n,0n,0n,0n));
    if(route.direction==="wrap")assert.throws(()=>run(value,value,value,0n,1n));
    for(const nativeDelta of [-1n,1n])assert.throws(()=>run(value,value,value,0n,0n,value,nativeDelta));
  }
});

import { recipientContinuation } from "./recipient-historical.js";
test("recipient CLI continuation is executable and preserves full input",()=>{
 const program=ethers.hexlify(recipientContinuation().bytes());
 for(const input of [0n,1n,91n]){const result=inspectRuntime(program,input);assert.equal(result.registers[0],input);assert.equal(result.calls.length,0);assert.equal(result.allowances.length,0);}
});
