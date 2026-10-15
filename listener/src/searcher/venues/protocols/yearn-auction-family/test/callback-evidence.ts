import assert from "node:assert/strict";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeSettlementRequest } from "../../../../../adapters/runtime-amount-program.js";
import { buildExecuteCalldata } from "../../../../../shared/executor/botvm-executor.js";
import { observeBalance, assertNativeInventory, same, word, sha, json } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
const FUND = new ethers.Interface(["function fund(address,address,uint256,uint256,address) returns(uint256)"]);
const TOKEN = new ethers.Interface(["function transfer(address,uint256) returns(bool)","function transferFrom(address,address,uint256) returns(bool)","function approve(address,uint256) returns(bool)","function allowance(address,address) view returns(uint256)"]);
const AUCTION = new ethers.Interface(["function take(address,uint256,address,bytes) returns(uint256)","function auctionTakeCallback(address,address,uint256,uint256,bytes)"]);
export const FUNDER = "0x1000000000000000000000000000000000000051";
/** Capture each read id before awaiting; independent responses may complete out of order. */
export async function correlatedRpcResponse(nextId: () => number, send: (id: number) => Promise<any>) {
  const id = nextId(), body = await send(id);
  assert.equal(body.jsonrpc, "2.0"); assert.equal(body.id, id);
  return body;
}
export function assertStorageUnchanged(diff: any) {
  for (const account of new Set([...Object.keys(diff.pre ?? {}), ...Object.keys(diff.post ?? {})])) {
    const before = diff.pre?.[account]?.storage ?? {}, after = diff.post?.[account]?.storage ?? {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]))
      assert.equal(BigInt(after[key] ?? 0), BigInt(before[key] ?? 0), "reverted/out-of-scope call changed storage");
  }
}
export function assertInactiveCallback(trace: any, diff: any) {
  assert(!trace.calls?.length, "callback outside active scope executed a child call");
  assert(trace.error || (trace.output ?? "0x") === "0x", "out-of-scope callback returned unexpected data");
  assertStorageUnchanged(diff);
}
export async function acceptYearnCallback(c: {
  descriptor: any; executor: string; owner: string; receiver: string; runtimeCode: any; fixture: any;
  amountIn: bigint; amountOut: bigint; spent: bigint; header: any; source: any; pin: any; trial: any;
  rpc(method: string, params: any[]): Promise<any>;
  balance(token: string, actor: string, overrides?: any): Promise<bigint>;
  slotFor(token: string, protectedActor: string, actor?: string): Promise<string>;
  build(request: RuntimeSettlementRequest): any;
}) {
  const d = c.descriptor, tokens = [d.want, d.sold], actors = [c.executor, FUNDER, d.target, c.receiver];
  assert.equal(new Set([...actors,c.owner,d.want,d.sold].map(a=>a.toLowerCase())).size,7);
  assert.equal(await c.rpc("eth_getCode", [FUNDER,c.pin]),"0x");
  const keys = await Promise.all(tokens.map(t=>c.slotFor(t,d.target,c.executor)));
  const fundKeys = await Promise.all(tokens.map(t=>c.slotFor(t,d.target,FUNDER)));
  const targetKeys = await Promise.all(tokens.map(t=>c.slotFor(t,c.executor,d.target)));
  const receiverKeys = await Promise.all(tokens.map(t=>c.slotFor(t,d.target,c.receiver)));
  const targetBefore = await Promise.all(tokens.map(t=>c.balance(t,d.target)));
  const receiverBefore = await Promise.all(tokens.map(t=>c.balance(t,c.receiver)));
  c.trial.callbackExecutions=[];
  for (const inventory of [false,true]) for (const fault of ["none","no-funding","short-credit-false-return","excess-credit-false-return","spend-old-output","oversized-payment","post-revert"]) {
    const before=[inventory?101n:0n,inventory?10n**24n:0n], paymentAmount=fault==="oversized-payment"?c.amountOut+1n:1n;
    const consumed=paymentAmount+(fault==="spend-old-output"?1n:0n);
    const credit=c.amountIn+(fault==="short-credit-false-return"?-1n:fault==="excess-credit-false-return"?1n:0n);
    const p=new RuntimeAmountProgram().call(d.sold,TOKEN.encodeFunctionData("transfer",[FUNDER,consumed]))
      .call(FUNDER,FUND.encodeFunctionData("fund",[d.want,d.sold,consumed,credit,c.executor])).load(0,0);
    if(fault.includes("false-return")) p.constant(0,c.amountIn);
    const request:RuntimeSettlementRequest={kind:"deferred-input",paymentAmount,paymentProgram:ethers.hexlify(p.bytes())};
    const leg=c.build(request);assert(leg);assert.deepEqual(leg.settlementRequest,request);assert(same(leg.settlement.deferredInput,c.executor));
    const check=new RuntimeAmountProgram().call(d.want,TOKEN.encodeFunctionData("allowance",[c.executor,d.target]),{static:true}).load(1,0).constant(2,0n).equal(1,2);
    if(fault==="post-revert")check.constant(1,1n).equal(1,2);
    const script=ethers.concat([runtimeProgramScript(ethers.getBytes(leg.program),c.amountIn),runtimeProgramScript(check.bytes(),0n)]);
    const tx={from:c.owner,to:c.executor,data:buildExecuteCalldata(ethers.getBytes(script)),gas:"0x1000000",gasPrice:c.header.baseFeePerGas};
    const overrides:any={
      [c.owner]:{balance:ethers.toQuantity(100n*10n**18n)},[c.executor]:{code:c.runtimeCode.code,balance:"0x11"},[FUNDER]:{code:c.fixture.code,balance:"0x17"},
      [d.want]:{stateDiff:{[keys[0]!]:word(before[0]!),[fundKeys[0]!]:word(fault==="no-funding"?0n:credit)}},
      [d.sold]:{stateDiff:{[keys[1]!]:word(before[1]!),[fundKeys[1]!]:word(0n)}},
    };
    const row:any={inventory,fault,status:"failed",source:c.source,declaredBudget:c.amountIn,actualDebt:c.spent,legalRefund:c.amountIn-c.spent,
      initialWant:before[0],initialSold:before[1],paymentAmount,fixtureCredit:credit,scriptHash:ethers.keccak256(script),overridesHash:sha(json(overrides)),transaction:tx,
      fundingScope:"isolated fixture exchanges fixed one raw unit of actual auction output for declared cap; not a market return route or opportunity"};
    c.trial.callbackExecutions.push(row);
    for(let i=0;i<2;i++)assert.equal(await c.balance(tokens[i]!,c.executor,overrides),before[i]);
    row.trace=await c.rpc("debug_traceCall",[tx,c.pin,{tracer:"callTracer",timeout:"30s",stateOverrides:overrides}]);
    assert(row.trace.type==="CALL"&&same(row.trace.from,c.owner)&&same(row.trace.to,c.executor)&&same(row.trace.input,tx.data));
    row.diff=await c.rpc("debug_traceCall",[tx,c.pin,{tracer:"prestateTracer",tracerConfig:{diffMode:true},timeout:"30s",stateOverrides:overrides}]);
    const events:any[]=[];const walk=(t:any)=>{events.push(t);for(const child of t.calls??[])walk(child);};walk(row.trace);
    if(fault!=="none"){
      assert(row.trace.error,"negative used old inventory or accepted false callback credit");
      // Failed top-level eth_call must not commit any actor/protocol storage.
      assertStorageUnchanged(row.diff);assertNativeInventory(row.diff,c.executor,17n);assertNativeInventory(row.diff,FUNDER,23n);
      row.status="correctly-rejected";continue;
    }
    assert(!row.trace.error&&!row.trace.revertReason,"actual Yearn callback reverted");
    const take=events.filter(t=>same(t.to??"",d.target)&&t.input?.startsWith(AUCTION.getFunction("take")!.selector));assert.equal(take.length,1);
    const call=AUCTION.decodeFunctionData("take",take[0].input);assert(same(call[0],d.sold));assert.equal(call[1],c.amountOut);assert(same(call[2],c.executor));assert(call[3]!=="0x");
    assert.equal(AUCTION.decodeFunctionResult("take",take[0].output)[0],c.amountOut);
    const callbacks=events.filter(t=>same(t.from??"",d.target)&&same(t.to??"",c.executor)&&t.input?.startsWith(AUCTION.getFunction("auctionTakeCallback")!.selector));assert.equal(callbacks.length,1);
    const cb=AUCTION.decodeFunctionData("auctionTakeCallback",callbacks[0].input);assert(same(cb[0],d.sold));assert(same(cb[1],c.executor));assert.equal(cb[2],c.amountOut);assert.equal(cb[3],c.spent);assert.equal(cb[4],call[3]);
    const fund=events.filter(t=>same(t.to??"",FUNDER)&&t.input?.startsWith(FUND.getFunction("fund")!.selector));assert.equal(fund.length,1);
    const approvals=events.filter(t=>same(t.from??"",c.executor)&&same(t.to??"",d.want)&&t.input?.startsWith(TOKEN.getFunction("approve")!.selector))
      .filter(t=>same(TOKEN.decodeFunctionData("approve",t.input)[0],d.target));assert.equal(approvals.length,3);
    assert.deepEqual(approvals.map(t=>TOKEN.decodeFunctionData("approve",t.input)[1]),[0n,c.spent,0n]);
    const pulls=events.filter(t=>same(t.from??"",d.target)&&same(t.to??"",d.want)&&t.input?.startsWith(TOKEN.getFunction("transferFrom")!.selector));assert.equal(pulls.length,1);
    const debit=TOKEN.decodeFunctionData("transferFrom",pulls[0].input);assert(same(debit[0],c.executor)&&same(debit[1],c.receiver));assert.equal(debit[2],c.spent);
    const sold=events.filter(t=>same(t.from??"",d.target)&&same(t.to??"",d.sold)&&t.input?.startsWith(TOKEN.getFunction("transfer")!.selector));assert.equal(sold.length,1);
    const order=[sold[0],callbacks[0],fund[0],approvals[1],pulls[0],approvals[2]].map(t=>events.indexOf(t));assert(order.every((n,i)=>i===0||n>order[i-1]!));row.callOrder=order;
    row.executorBalances=tokens.map((t,i)=>observeBalance(row.diff,t,keys[i]!,before[i]!));
    row.funderBalances=tokens.map((t,i)=>observeBalance(row.diff,t,fundKeys[i]!,i===0?credit:0n));
    row.auctionBalances=tokens.map((t,i)=>observeBalance(row.diff,t,targetKeys[i]!,targetBefore[i]!));
    row.receiverBalances=tokens.map((t,i)=>observeBalance(row.diff,t,receiverKeys[i]!,receiverBefore[i]!));
    assert.deepEqual(row.executorBalances.map((v:any)=>v.delta),[c.amountIn-c.spent,c.amountOut-1n]);
    assert.deepEqual(row.funderBalances.map((v:any)=>v.delta),[-c.amountIn,1n]);
    assert.deepEqual(row.auctionBalances.map((v:any)=>v.delta),[0n,-c.amountOut]);
    assert.deepEqual(row.receiverBalances.map((v:any)=>v.delta),[c.spent,0n]);
    for(let i=0;i<2;i++)assert.equal([row.executorBalances,row.funderBalances,row.auctionBalances,row.receiverBalances].reduce((s,v)=>s+v[i].delta,0n),0n);
    row.executorNative=assertNativeInventory(row.diff,c.executor,17n);row.funderNative=assertNativeInventory(row.diff,FUNDER,23n);
    // Call the genuine callback bytes outside an authenticated VM continuation.
    row.unauthorizedCallback=await c.rpc("debug_traceCall",[{...tx,from:c.owner,data:callbacks[0].input},c.pin,{tracer:"callTracer",timeout:"30s",stateOverrides:overrides}]);
    row.unauthorizedDiff=await c.rpc("debug_traceCall",[{...tx,from:c.owner,data:callbacks[0].input},c.pin,{tracer:"prestateTracer",tracerConfig:{diffMode:true},timeout:"30s",stateOverrides:overrides}]);
    assertInactiveCallback(row.unauthorizedCallback,row.unauthorizedDiff);assertNativeInventory(row.unauthorizedDiff,c.executor,17n);assertNativeInventory(row.unauthorizedDiff,FUNDER,23n);
    row.unauthorizedScope="no pending callback: inert empty return or revert; active wrong-caller rejection is covered by existing local EVM matrix";
    row.status="pass";
  }
}
