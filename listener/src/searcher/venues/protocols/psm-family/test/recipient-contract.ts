import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { plugin } from "../../../production-families/psm.production.js";
import { PSM_INTERFACE,PSM_WAD,psmBuyCost,psmBuyQuote,psmSellQuote } from "../codec.js";
import { PSM_FAMILY_ID,PSM_LINEAGE_ID } from "../manifest.js";
import type { PsmIdentity } from "../types.js";
const executor="0x1000000000000000000000000000000000000002",other="0x1000000000000000000000000000000000000003";
const identity:PsmIdentity={familyId:PSM_FAMILY_ID,lineageId:PSM_LINEAGE_ID,subject:"0x2000000000000000000000000000000000000001",provenance:[],gem:"0x2000000000000000000000000000000000000002",dai:"0x2000000000000000000000000000000000000003"};
const descriptor=plugin.instance.finalizeDescriptor({identity,draft:plugin.instance.compileDraft(identity),sharedBindings:[]});
const routes=plugin.routes.project({descriptor}),source={number:26029876,hash:"0xd33e839d78988e851e3e85515084208a7229f53feb0d446d9b63d8d1bd9b937a",generation:1};
const TOKEN=new ethers.Interface(["function balanceOf(address) view returns(uint256)","function allowance(address,address) view returns(uint256)","function approve(address,uint256) returns(bool)"]);
function build(route:typeof routes[number],recipient:string){return plugin.execution.buildRuntimeLeg!({descriptor,route,source,executor,runtimeEvidence:[],settlement:{kind:"direct-output",recipient}})!;}
for(const route of routes)for(const recipient of [executor,other])test(`PSM ${route.direction} direct ${recipient===executor?"self":"external"} enforces cost/receipt and refunds`,()=>{
  const sell=route.direction==="sell-gem",leg=build(route,recipient);assert(leg);assert.equal(leg.inputMode,sell?undefined:"maximum");
  for(const fee of [0n,1n,PSM_WAD/1000n])for(const budget of sell?[1n,5494762n,10989524n]:[descriptor.decimalScale*2n+17n,5674124933591466214n]){
    const output=sell?psmSellQuote(budget,fee,descriptor.decimalScale):psmBuyQuote(budget,fee,descriptor.decimalScale),cost=sell?budget:psmBuyCost(output,fee,descriptor.decimalScale);assert(output>0n&&cost>0n&&cost<=budget);
    const run=(fault="none")=>{
      let done=false;
      const debit=cost+(fault==="debit-short"?-1n:fault==="debit-excess"?1n:0n),credit=output+(fault==="credit-short"?-1n:fault==="credit-excess"?1n:0n);
      const result=inspectRuntime(leg.program,fault==="zero"?0n:budget,{nativeBalance:()=>17n+(done?(fault==="native-short"?-1n:fault==="native-excess"?1n:0n):0n),call:c=>{
        if(c.target.toLowerCase()===descriptor.target.toLowerCase()){
          const p=PSM_INTERFACE.parseTransaction({data:c.data})!;
          if(p.name==="tin"||p.name==="tout")return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"],[fee]);
          assert.equal(p.name,sell?"sellGem":"buyGem");assert.equal(p.args[0].toLowerCase(),recipient.toLowerCase());assert.equal(p.args[1],sell?budget:output);done=true;
          return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"],[(sell?output:cost)+(fault==="return-short"?-1n:fault==="return-excess"?1n:0n)]);
        }
        const p=TOKEN.parseTransaction({data:c.data})!;
        if(p.name==="approve")return TOKEN.encodeFunctionResult("approve",[true]);
        if(p.name==="allowance")return TOKEN.encodeFunctionResult("allowance",[fault==="residual-allowance"?1n:0n]);
        assert.equal(p.name,"balanceOf");const input=c.target.toLowerCase()===route.tokenIn.toLowerCase(),actor=p.args[0].toLowerCase()===executor.toLowerCase(),receiver=p.args[0].toLowerCase()===recipient.toLowerCase();
        const initial=input?(actor?budget+101n:107n):(actor?103n:109n);
        const change=input?(actor?-(fault==="zero-debit"?0n:debit):(fault==="recipient-input"?-1n:0n)):((receiver?credit:0n)-(fault==="old-output"&&actor?1n:0n));
        return TOKEN.encodeFunctionResult("balanceOf",[initial+(done?change:0n)]);
      }});
      assert.equal(result.registers[0],budget);return result;
    };
    const good=run();assert.deepEqual(good.calls.filter(c=>c.data.startsWith(TOKEN.getFunction("approve")!.selector)).map(c=>TOKEN.decodeFunctionData("approve",c.data)[1]),[0n,cost,0n]);
    for(const fault of ["zero","zero-debit","debit-short","debit-excess","credit-short","credit-excess","return-short","return-excess","old-output","residual-allowance","native-short","native-excess"])assert.throws(()=>run(fault),fault);
    if(recipient!==executor)assert.throws(()=>run("recipient-input"));
    if(!sell)assert.equal(budget-cost,budget-psmBuyCost(output,fee,descriptor.decimalScale));
  }
});
test("PSM unsupported callback remains null and invalid direct recipients reject",()=>{
 for(const route of routes){const input={descriptor,route,source,executor,runtimeEvidence:[]};
  assert.equal(plugin.execution.buildRuntimeLeg!({...input,settlement:{kind:"deferred-input",paymentAmount:1n,paymentProgram:ethers.hexlify(new RuntimeAmountProgram().constant(1,0n).bytes())}}),null);
  assert.equal(plugin.execution.buildRuntimeLeg!({...input,settlement:{kind:"quote-output",recipient:other}}),null);
  for(const bad of [ethers.ZeroAddress,descriptor.target,route.tokenIn,route.tokenOut])assert.throws(()=>build(route,bad));
 }
});
test("PSM zero-output and halted fee are rejected before approving or swapping",()=>{
 for(const route of routes){const sell=route.direction==="sell-gem",leg=build(route,other);
  for(const [budget,fee] of sell?[[1n,PSM_WAD],[1n,ethers.MaxUint256]]:[[1n,0n],[descriptor.decimalScale,ethers.MaxUint256]]){
   let swaps=0;assert.throws(()=>inspectRuntime(leg.program,budget,{nativeBalance:()=>17n,call:c=>{
    if(c.target.toLowerCase()===descriptor.target.toLowerCase()){const p=PSM_INTERFACE.parseTransaction({data:c.data})!;if(!["tin","tout"].includes(p.name))swaps++;return ethers.AbiCoder.defaultAbiCoder().encode(["uint256"],[fee]);}
    const p=TOKEN.parseTransaction({data:c.data})!;assert.equal(p.name,"balanceOf");return TOKEN.encodeFunctionResult("balanceOf",[10n**30n]);
   }}));assert.equal(swaps,0);
  }
 }
});
