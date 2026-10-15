import assert from "node:assert/strict";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeSettlementRequest } from "../../../../../adapters/runtime-amount-program.js";
import { buildExecuteCalldata } from "../../../../../shared/executor/botvm-executor.js";
import { observeBalance, assertNativeInventory, same, word, sha, json } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { ABI } from "../codec.js";
import type { Descriptor, Route } from "../types.js";
const FUND = new ethers.Interface(["function fund(address,address,uint256,uint256,address) returns(uint256)"]);
const TOKEN = new ethers.Interface(["function transfer(address,uint256) returns(bool)","function transferFrom(address,address,uint256) returns(bool)","function approve(address,uint256) returns(bool)","function allowance(address,address) view returns(uint256)","function balanceOf(address) view returns(uint256)"]);
const CALLBACK = new ethers.Interface(["function preTransferInCallback(address,address,address,address,uint256,uint256,bytes32,bytes)"]);
export const FUNDER = "0x1000000000000000000000000000000000000057";
export function assertStorageUnchanged(diff: any) {
  for (const account of new Set([...Object.keys(diff.pre ?? {}), ...Object.keys(diff.post ?? {})])) {
    const before=diff.pre?.[account]?.storage??{}, after=diff.post?.[account]?.storage??{};
    for(const key of new Set([...Object.keys(before),...Object.keys(after)]))assert.equal(BigInt(after[key]??0),BigInt(before[key]??0),"reverted call changed storage");
  }
}
export async function acceptAquaSettlement(c: {
  descriptor: Descriptor; route: Route; executor: string; owner: string; runtimeCode: any; fixture: any;
  amountIn: bigint; amountOut: bigint; header: any; source: any; pin: any; trial: any;
  rpc(method: string, params: any[]): Promise<any>;
  balance(token: string, actor: string, overrides?: any): Promise<bigint>;
  slotFor(token: string, protectedActor: string, actor?: string): Promise<string>;
  build(request: RuntimeSettlementRequest): any;
}) {
  const d=c.descriptor, r=c.route, tokens=[r.tokenIn,r.tokenOut], actors=[c.executor,FUNDER,d.order.maker,c.owner];
  assert.equal(new Set([...actors,d.router,d.aqua,...tokens].map(a=>a.toLowerCase())).size,8);
  assert.equal(await c.rpc("eth_getCode",[FUNDER,c.pin]),"0x");
  const keys=await Promise.all(actors.map(a=>Promise.all(tokens.map(t=>c.slotFor(t,same(a,d.order.maker)?c.executor:d.order.maker,a)))));
  const baseline=await Promise.all(actors.map(a=>Promise.all(tokens.map(t=>c.balance(t,a)))));
  c.trial.executions=[];
  const cases=[...([false,true].flatMap(inventory=>["none","no-funding","short-credit-false-return","excess-credit-false-return","spend-old-output","oversized-payment","post-revert"].map(fault=>({mode:"deferred" as const,inventory,fault})))),
    ...["insufficient-input","zero-input","minimum-plus-one","wrong-receiver-postcondition","post-revert"].map(fault=>({mode:"direct" as const,inventory:true,fault}))];
  for(const {mode,inventory,fault} of cases){
    const value=fault==="zero-input"?0n:c.amountIn, paymentAmount=fault==="oversized-payment"?c.amountOut+1n:1n;
    const consumed=paymentAmount+(fault==="spend-old-output"?1n:0n),credit=c.amountIn+(fault==="short-credit-false-return"?-1n:fault==="excess-credit-false-return"?1n:0n);
    const before=[mode==="direct"?(fault==="insufficient-input"?c.amountIn-1n:c.amountIn+101n):inventory?101n:0n,inventory?10n**24n:0n];
    const p=new RuntimeAmountProgram().call(r.tokenOut,TOKEN.encodeFunctionData("transfer",[FUNDER,consumed]))
      .call(FUNDER,FUND.encodeFunctionData("fund",[r.tokenIn,r.tokenOut,consumed,credit,c.executor])).load(0,0);
    if(fault.includes("false-return"))p.constant(0,c.amountIn);
    const request:RuntimeSettlementRequest=mode==="direct"?{kind:"direct-output",recipient:c.owner}:{kind:"deferred-input",paymentAmount,paymentProgram:ethers.hexlify(p.bytes())};
    const leg=c.build(request);assert(leg);assert.deepEqual(leg.settlementRequest,request);
    if(mode==="deferred")assert(same(leg.settlement?.deferredInput,c.executor));else assert.equal(leg.settlement?.directOutput,true);
    const check=new RuntimeAmountProgram().call(r.tokenIn,TOKEN.encodeFunctionData("allowance",[c.executor,d.router]),{static:true}).load(1,0).constant(2,0n).equal(1,2);
    if(fault==="minimum-plus-one"||fault==="wrong-receiver-postcondition"){
      const account=fault==="wrong-receiver-postcondition"?c.executor:c.owner,opening=fault==="wrong-receiver-postcondition"?before[1]!:baseline[3]![1]!;
      check.call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[account]),{static:true}).load(1,0).constant(2,opening).math("sub",1,1,2)
        .constant(2,c.amountOut+(fault==="minimum-plus-one"?1n:0n)).math("sub",1,1,2);
    }
    if(fault==="post-revert")check.constant(1,1n).constant(2,0n).equal(1,2);
    const script=ethers.concat([runtimeProgramScript(ethers.getBytes(leg.program),value),runtimeProgramScript(check.bytes(),0n)]);
    const tx={from:c.owner,to:c.executor,data:buildExecuteCalldata(ethers.getBytes(script)),gas:"0x1000000",gasPrice:c.header.baseFeePerGas};
    const overrides:any={ [c.owner]:{balance:ethers.toQuantity(100n*10n**18n)},[c.executor]:{code:c.runtimeCode.code,balance:"0x11"},[FUNDER]:{code:c.fixture.code,balance:"0x17"},
      [r.tokenIn]:{stateDiff:{[keys[0]![0]!]:word(before[0]!),[keys[1]![0]!]:word(mode==="deferred"&&fault!=="no-funding"?credit:0n)}},
      [r.tokenOut]:{stateDiff:{[keys[0]![1]!]:word(before[1]!),[keys[1]![1]!]:word(0n)}} };
    const row:any={mode,inventory,fault,status:"failed",source:c.source,input:value,expectedGrossOutput:c.amountOut,initialInput:before[0],initialOutput:before[1],paymentAmount,fixtureCredit:credit,
      transaction:tx,scriptHash:ethers.keccak256(script),overridesHash:sha(json(overrides)),fundingScope:"isolated fixed-one-raw-output funding fixture; not market return or opportunity"};c.trial.executions.push(row);
    for(let i=0;i<2;i++)assert.equal(await c.balance(tokens[i]!,c.executor,overrides),before[i]);
    row.trace=await c.rpc("debug_traceCall",[tx,c.pin,{tracer:"callTracer",timeout:"30s",stateOverrides:overrides}]);
    assert(row.trace.type==="CALL"&&same(row.trace.from,c.owner)&&same(row.trace.to,c.executor)&&same(row.trace.input,tx.data));
    row.diff=await c.rpc("debug_traceCall",[tx,c.pin,{tracer:"prestateTracer",tracerConfig:{diffMode:true},timeout:"30s",stateOverrides:overrides}]);
    const events:any[]=[];const walk=(t:any)=>{events.push(t);for(const child of t.calls??[])walk(child);};walk(row.trace);
    if(fault!=="none"){
      assert(row.trace.error,"negative accepted invalid amount/receiver/credit or old inventory");assertStorageUnchanged(row.diff);
      assertNativeInventory(row.diff,c.executor,17n);assertNativeInventory(row.diff,FUNDER,23n);row.status="correctly-rejected";continue;
    }
    assert(!row.trace.error&&!row.trace.revertReason,"actual Aqua callback reverted");
    const swaps=events.filter(t=>same(t.from??"",c.executor)&&same(t.to??"",d.router)&&t.input?.startsWith(ABI.getFunction("swap")!.selector));assert.equal(swaps.length,1);
    const swap=ABI.decodeFunctionData("swap",swaps[0].input);assert(same(swap[1],r.tokenIn)&&same(swap[2],r.tokenOut));assert.equal(swap[3],c.amountIn);
    assert.deepEqual([...ABI.decodeFunctionResult("swap",swaps[0].output)],[c.amountIn,c.amountOut,d.strategyHash]);
    const callbacks=events.filter(t=>same(t.from??"",d.router)&&same(t.to??"",c.executor)&&t.input?.startsWith(CALLBACK.getFunction("preTransferInCallback")!.selector));assert.equal(callbacks.length,1);
    const cb=CALLBACK.decodeFunctionData("preTransferInCallback",callbacks[0].input);
    assert.deepEqual([...cb].slice(0,4).map(String).map(v=>v.toLowerCase()),[d.order.maker,c.executor,r.tokenIn,r.tokenOut].map(v=>v.toLowerCase()));
    assert.equal(cb[4],c.amountIn);assert.equal(cb[5],c.amountOut);assert.equal(cb[6],d.strategyHash);assert(cb[7]!=="0x");
    const fund=events.filter(t=>same(t.to??"",FUNDER)&&t.input?.startsWith(FUND.getFunction("fund")!.selector));assert.equal(fund.length,1);
    const approvals=events.filter(t=>same(t.from??"",c.executor)&&same(t.to??"",r.tokenIn)&&t.input?.startsWith(TOKEN.getFunction("approve")!.selector))
      .filter(t=>same(TOKEN.decodeFunctionData("approve",t.input)[0],d.router));assert.deepEqual(approvals.map(t=>TOKEN.decodeFunctionData("approve",t.input)[1]),[0n,c.amountIn,0n]);
    const pulls=events.filter(t=>same(t.from??"",d.router)&&same(t.to??"",r.tokenIn)&&t.input?.startsWith(TOKEN.getFunction("transferFrom")!.selector))
      .filter(t=>same(TOKEN.decodeFunctionData("transferFrom",t.input)[0],c.executor));assert.equal(pulls.length,1);
    const debit=TOKEN.decodeFunctionData("transferFrom",pulls[0].input);assert(same(debit[1],d.router));assert.equal(debit[2],c.amountIn);
    const released=events.filter(t=>same(t.to??"",r.tokenOut)&&t.input?.startsWith(TOKEN.getFunction("transferFrom")!.selector))
      .filter(t=>{const v=TOKEN.decodeFunctionData("transferFrom",t.input);return same(v[0],d.order.maker)&&same(v[1],c.executor)&&v[2]===c.amountOut;});assert.equal(released.length,1);
    const order=[released[0],callbacks[0],fund[0],pulls[0],approvals[2]].map(t=>events.indexOf(t));assert(order.every((n,i)=>i===0||n>order[i-1]!));row.callOrder=order;
    const initial=[before,[credit,0n],baseline[2]!,baseline[3]!];
    row.balances=actors.map((a,j)=>({account:a,tokens:tokens.map((t,i)=>({token:t,...observeBalance(row.diff,t,keys[j]![i]!,initial[j]![i]!)}))}));
    assert.deepEqual(row.balances.map((b:any)=>b.tokens.map((t:any)=>t.delta)),[[0n,c.amountOut-1n],[-c.amountIn,1n],[c.amountIn,-c.amountOut],[0n,0n]]);
    for(let i=0;i<2;i++)assert.equal(row.balances.reduce((s:bigint,b:any)=>s+b.tokens[i].delta,0n),0n);
    row.executorNative=assertNativeInventory(row.diff,c.executor,17n);row.funderNative=assertNativeInventory(row.diff,FUNDER,23n);
    row.inactiveCallback=await c.rpc("debug_traceCall",[{...tx,data:callbacks[0].input},c.pin,{tracer:"callTracer",timeout:"30s",stateOverrides:overrides}]);
    row.inactiveDiff=await c.rpc("debug_traceCall",[{...tx,data:callbacks[0].input},c.pin,{tracer:"prestateTracer",tracerConfig:{diffMode:true},timeout:"30s",stateOverrides:overrides}]);
    assert(!row.inactiveCallback.calls?.length);assert(row.inactiveCallback.error||(row.inactiveCallback.output??"0x")==="0x");assertStorageUnchanged(row.inactiveDiff);
    assertNativeInventory(row.inactiveDiff,c.executor,17n);assertNativeInventory(row.inactiveDiff,FUNDER,23n);
    row.inactiveScope="no pending callback: inert empty return or revert; not an active wrong-caller test";row.status="pass";
  }
}
