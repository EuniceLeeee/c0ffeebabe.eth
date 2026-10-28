import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { buildRuntimeSettlementRoot } from "../simulator/runtime-settlement.js";
import { RuntimeAmountProgram, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { execution } from "../venues/protocols/psv-family/execution.js";
import { addr, actor, fixture, setup, reads, source } from "../venues/protocols/psv-family/test/fixtures.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

test("settlement preparation quotes the actual recipient, including receiver-sensitive fee exemption", () => {
  const receiver=addr(999), f=fixture(); f.exemptRecipients.add(receiver);
  const {d,rs}=setup(f), route=rs[0], amount=1_000_000n;
  const input={descriptor:d,route,source,executor:actor,runtimeEvidence:[]};
  const first=execution.buildRuntimeLeg(input)!;
  const dummy={actionAdapterId:"fixture-deferred",program:ethers.hexlify(new RuntimeAmountProgram().constant(1,1n).bytes()),
    settlement:{deferredInput:receiver}};
  let prepared: ReturnType<typeof execution.buildRuntimeLeg> = null;
  const requests:RuntimeSettlementRequest[]=[];
  assert(buildRuntimeSettlementRoot({amount,minimumProfit:1n,executor:actor,legs:[
    {...first,tokenIn:route.tokenIn,tokenOut:route.tokenOut},
    {...dummy,tokenIn:route.tokenOut,tokenOut:route.tokenIn}],
    build(i,request){
      if(i!==0)return dummy;
      requests.push(request);
      const leg=execution.buildRuntimeLeg({...input,settlement:request});
      if(request.kind==="quote-output")prepared=leg;
      return leg;
    }}));
  assert.deepEqual(requests.map(r=>[r.kind,"recipient" in r?r.recipient:null]),[
    ["quote-output",receiver],["direct-output",receiver]]);
  assert(prepared);
  const result=inspectRuntime((prepared as NonNullable<typeof prepared>).program,amount,{
    call(c){const r=reads(f,[{id:"read",kind:"eth-call",to:c.target,data:c.data,completion:"return-data"}])[0];
      assert(r.ok);return r.data;}},{output:true});
  assert.equal(result.registers[0],amount);
  const old=execution.buildRuntimeLeg({...input,settlement:{kind:"quote-output"}})!;
  const oldResult=inspectRuntime(old.program,amount,{call(c){
    const r=reads(f,[{id:"read",kind:"eth-call",to:c.target,data:c.data,completion:"return-data"}])[0];
    assert(r.ok);return r.data;}},{output:true});
  assert.equal(oldResult.registers[0],999_500n,"control: executor and actual receiver really differ");
});

test("longer prefixes quote executor custody until the last upstream leg", () => {
  const receiver=addr(999), tokens=[addr(10),addr(11),addr(12)],requests:Array<[number,RuntimeSettlementRequest]>=[];
  const program=ethers.hexlify(new RuntimeAmountProgram().constant(1,1n).bytes());
  const legs=tokens.map((tokenIn,i)=>({tokenIn,tokenOut:tokens[(i+1)%3],actionAdapterId:"fixture",program,
    settlement:i===2?{deferredInput:receiver}:{quoteOutput:true as const,directOutput:true as const}}));
  assert(buildRuntimeSettlementRoot({legs,amount:20n,minimumProfit:1n,executor:actor,
    build(i,r){requests.push([i,r]);return legs[i];}}));
  assert.deepEqual(requests.filter(([,r])=>r.kind==="quote-output").map(([i,r])=>[i,"recipient" in r?r.recipient:null]),
    [[0,actor],[1,receiver]]);
});
