import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/algebra-integral.production.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { ALGEBRA_POOL_INTERFACE as POOL_ABI } from "../abi.js";
import { descriptor, EXECUTOR, FOREIGN_POOL as FOREIGN, SOURCE } from "./fixtures.js";
const TOKEN=new ethers.Interface(["function balanceOf(address) view returns(uint256)"]);
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();

test("direct Algebra directions bind positive actual debit, both signed returns and actual receiver credit",()=>{
 const d=descriptor(),value=91n,output=73n;
 for(const route of plugin.routes.project({descriptor:d}))for(const recipient of [EXECUTOR,FOREIGN]){
  const request={kind:"direct-output" as const,recipient};
  const leg=plugin.execution.buildRuntimeLeg!({descriptor:d,route,executor:EXECUTOR,transactionOrigin:FOREIGN,source:SOURCE,runtimeEvidence:[],settlement:request})!;
  assert(leg);assert.deepEqual(leg.settlementRequest,request);
  const run=(o:{debit?:bigint;credit?:bigint;reportedDebit?:bigint;reportedOutput?:bigint;oldOutput?:bigint;otherInput?:bigint;native?:bigint;input?:bigint}={})=>{
   const debit=o.debit??value,credit=o.credit??output;let swapped=false;
   return inspectRuntime(leg.program,o.input??value,{nativeBalance:()=>17n+(swapped?(o.native??0n):0n),call:c=>{
    if(same(c.target,d.pool)){
     const v=POOL_ABI.decodeFunctionData("swap",c.data);assert(same(v[0],recipient));assert.equal(v[2],o.input??value);assert.equal(v[1],(route.direction==="zero-for-one"));assert(v[4]!=="0x");swapped=true;
     const pair=[o.reportedDebit??value,-(o.reportedOutput??output)];
     return POOL_ABI.encodeFunctionResult("swap",(route.direction==="zero-for-one")?pair:pair.reverse());
    }
    const v=TOKEN.decodeFunctionData("balanceOf",c.data),actor=same(v[0],EXECUTOR),input=same(c.target,route.tokenIn);
    const opening=input?(actor?value+101n:107n):(actor?103n:109n);
    const delta=input?(actor?-debit:(o.otherInput??0n)):((same(v[0],recipient)?credit:0n)-(actor?(o.oldOutput??0n):0n));
    return TOKEN.encodeFunctionResult("balanceOf",[opening+(swapped?delta:0n)]);
   }});
  };
  const good=run();assert.equal(good.registers[0],value);assert.equal(good.allowances.length,0);
  for(const debit of [0n,value-1n,value+1n])assert.throws(()=>run({debit}));
  for(const credit of [0n,output-1n,output+1n])assert.throws(()=>run({credit}));
  for(const reportedDebit of [0n,value-1n,value+1n])assert.throws(()=>run({reportedDebit}));
  for(const reportedOutput of [0n,output-1n,output+1n])assert.throws(()=>run({reportedOutput}));
  for(const native of [-1n,1n])assert.throws(()=>run({native}));
  assert.throws(()=>run({input:0n,debit:0n,credit:0n,reportedDebit:0n,reportedOutput:0n}));
  assert.throws(()=>run({input:1n<<255n}));
  if(!same(recipient,EXECUTOR)){
   for(const oldOutput of [-1n,1n])assert.throws(()=>run({oldOutput}));
   for(const otherInput of [-1n,1n])assert.throws(()=>run({otherInput}));
  }
 }
});
test("direct receiver aliases and unsupported quote-output fail closed",()=>{
 const d=descriptor();for(const route of plugin.routes.project({descriptor:d})){
  const input={descriptor:d,route,executor:EXECUTOR,transactionOrigin:FOREIGN,source:SOURCE,runtimeEvidence:[]};
  for(const recipient of [ethers.ZeroAddress,d.pool,route.tokenIn,route.tokenOut])assert.throws(()=>plugin.execution.buildRuntimeLeg!({...input,settlement:{kind:"direct-output",recipient}}));
  assert.equal(plugin.execution.buildRuntimeLeg!({...input,settlement:{kind:"quote-output",recipient:FOREIGN} as never}),null);
 }
});
