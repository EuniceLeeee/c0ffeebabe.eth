import assert from "node:assert/strict";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeSettlementRequest } from "../../../../../adapters/runtime-amount-program.js";
import { buildExecuteCalldata } from "../../../../../shared/executor/botvm-executor.js";
import { observeBalance, assertNativeInventory, same, word, sha, json } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
import { KYSWAP_POOL_INTERFACE as ABI, KYSWAP_CALLBACK_INTERFACE as CALLBACK } from "../abi.js";
import { buildRuntimeSettlementRoot } from "../../../../simulator/runtime-settlement.js";
import type { KyberSwapDescriptor as Descriptor, KyberSwapRoute as Route } from "../types.js";
const FUND = new ethers.Interface(["function fund(address,address,uint256,uint256,address) returns(uint256)"]);
const TOKEN = new ethers.Interface(["function transfer(address,uint256) returns(bool)","function transferFrom(address,address,uint256) returns(bool)","function approve(address,uint256) returns(bool)","function allowance(address,address) view returns(uint256)","function balanceOf(address) view returns(uint256)","function totalSupply() view returns(uint256)"]);
export const FUNDER = "0x1000000000000000000000000000000000000067";
export function assertStorageUnchanged(diff: any) {
  for (const account of new Set([...Object.keys(diff.pre ?? {}), ...Object.keys(diff.post ?? {})])) {
    const before=diff.pre?.[account]?.storage??{}, after=diff.post?.[account]?.storage??{};
    for(const key of new Set([...Object.keys(before),...Object.keys(after)]))assert.equal(BigInt(after[key]??0),BigInt(before[key]??0),"reverted call changed storage");
  }
}
export async function acceptKyberSettlement(c: {
  descriptor: Descriptor; route: Route; executor: string; owner: string; runtimeCode: any; fixture: any;
  amountIn: bigint; amountOut: bigint; header: any; source: any; pin: any; trial: any;
  rpc(method: string, params: any[]): Promise<any>;
  balance(token: string, actor: string, overrides?: any): Promise<bigint>;
  slotFor(token: string, protectedActor: string, actor?: string): Promise<string>;
  build(request: RuntimeSettlementRequest): any;
}) {
  const d=c.descriptor, r=c.route, tokens=[r.tokenIn,r.tokenOut], actors=[c.executor,FUNDER,d.pool,c.owner];
  assert.equal(new Set([...actors,...tokens].map(a=>a.toLowerCase())).size,6);
  assert.equal(await c.rpc("eth_getCode",[FUNDER,c.pin]),"0x");
  const keys=await Promise.all(actors.map(a=>Promise.all(tokens.map(t=>c.slotFor(t,same(a,d.pool)?c.executor:d.pool,a)))));
  const baseline=await Promise.all(actors.map(a=>Promise.all(tokens.map(t=>c.balance(t,a)))));
  const supplies=await Promise.all(tokens.map(t=>c.rpc("eth_call",[{from:c.owner,to:t,data:TOKEN.encodeFunctionData("totalSupply")},c.pin])));
  c.trial.executions=[];
  const cases=[...([false,true].flatMap(inventory=>["none","no-funding","short-credit-false-return","excess-credit-false-return","spend-old-output","oversized-payment","post-revert"].map(fault=>({mode:"deferred" as const,inventory,fault})))),
    ...(["direct-self","direct-external"] as const).flatMap(mode=>["none","insufficient-input","zero-input","minimum-plus-one","post-revert"].map(fault=>({mode,inventory:true,fault})))];
  for(const {mode,inventory,fault} of cases){
    const direct=mode!=="deferred",recipient=mode==="direct-external"?c.owner:c.executor;
    const value=fault==="zero-input"?0n:c.amountIn, paymentAmount=fault==="oversized-payment"?c.amountOut+1n:1n;
    const consumed=paymentAmount+(fault==="spend-old-output"?1n:0n),credit=c.amountIn+(fault==="short-credit-false-return"?-1n:fault==="excess-credit-false-return"?1n:0n);
    const before=[direct?(fault==="insufficient-input"?c.amountIn-1n:c.amountIn+101n):inventory?101n:0n,inventory?10n**24n:0n];
    // The fixture is the only artificial leg. Current production composition
    // measures its actual debit and pool receipt; the fixture return is not trusted.
    const payment=new RuntimeAmountProgram().call(r.tokenOut,TOKEN.encodeFunctionData("transfer",[FUNDER,consumed]))
      .call(FUNDER,FUND.encodeFunctionData("fund",[r.tokenIn,r.tokenOut,consumed,credit,d.pool])).load(0,0);
    if(fault.includes("false-return"))payment.constant(0,c.amountIn);
    let script:string,leg:any;
    if(direct){
      const request={kind:"direct-output" as const,recipient};leg=c.build(request);assert(leg);assert.deepEqual(leg.settlementRequest,request);assert.equal(leg.settlement.directOutput,true);
      script=ethers.hexlify(runtimeProgramScript(ethers.getBytes(leg.program),value));
    }else{
      const fixtureLeg={actionAdapterId:"test-only-fixed-funding",tokenIn:r.tokenOut,tokenOut:r.tokenIn,program:ethers.hexlify(payment.bytes()),settlement:{quoteOutput:true as const,directOutput:true as const}};
      const emptyLeg={actionAdapterId:"kyber-placeholder",tokenIn:r.tokenIn,tokenOut:r.tokenOut,program:ethers.hexlify(new RuntimeAmountProgram().constant(1,0n).bytes()) ,settlement:{deferredInput:d.pool,directOutput:true as const}};
      const root=buildRuntimeSettlementRoot({legs:[fixtureLeg,emptyLeg],amount:paymentAmount,minimumProfit:1n,executor:c.executor,build:(index,request)=>{
        if(index===1){leg=c.build(request);assert(leg);assert.deepEqual(leg.settlementRequest,request);assert(same(leg.settlement.deferredInput,d.pool));return leg;}
        assert(request.kind==="quote-output"||request.kind==="direct-output");assert(same(request.recipient,d.pool));
        return {...fixtureLeg,settlementRequest:request,program:request.kind==="quote-output"?ethers.hexlify(new RuntimeAmountProgram().constant(0,c.amountIn).bytes()):fixtureLeg.program};
      }});assert(root&&typeof root.params.settlementProgram==="string");
      script=ethers.hexlify(runtimeProgramScript(ethers.getBytes(root.params.settlementProgram),paymentAmount));
    }
    const check=new RuntimeAmountProgram().constant(1,0n);
    if(fault==="minimum-plus-one"){
      const opening=same(recipient,c.executor)?before[1]!:baseline[3]![1]!;
      check.call(r.tokenOut,TOKEN.encodeFunctionData("balanceOf",[recipient]),{static:true}).load(1,0).constant(2,opening).math("sub",1,1,2)
        .constant(2,c.amountOut+1n).math("sub",1,1,2);
    }
    if(fault==="post-revert")check.constant(1,1n).constant(2,0n).equal(1,2);
    script=ethers.concat([script,runtimeProgramScript(check.bytes(),0n)]);
    const tx={from:c.owner,to:c.executor,data:buildExecuteCalldata(ethers.getBytes(script)),gas:"0x1000000",gasPrice:c.header.baseFeePerGas};
    const overrides:any={ [c.owner]:{balance:ethers.toQuantity(100n*10n**18n)},[c.executor]:{code:c.runtimeCode.code,balance:"0x11"},[FUNDER]:{code:c.fixture.code,balance:"0x17"},
      [r.tokenIn]:{stateDiff:{[keys[0]![0]!]:word(before[0]!),[keys[1]![0]!]:word(!direct&&fault!=="no-funding"?credit:0n)}},
      [r.tokenOut]:{stateDiff:{[keys[0]![1]!]:word(before[1]!),[keys[1]![1]!]:word(0n)}} };
    const row:any={mode,inventory,fault,status:"failed",source:c.source,input:value,expectedGrossOutput:c.amountOut,initialInput:before[0],initialOutput:before[1],paymentAmount,fixtureCredit:credit,
      transaction:tx,scriptHash:ethers.keccak256(script),overridesHash:sha(json(overrides)),recipient,productionComposer:!direct,fundingScope:"isolated fixed-one-raw-output funding fixture; not market return or opportunity"};c.trial.executions.push(row);
    for(let i=0;i<2;i++)assert.equal(await c.balance(tokens[i]!,c.executor,overrides),before[i]);
    row.trace=await c.rpc("debug_traceCall",[tx,c.pin,{tracer:"callTracer",timeout:"30s",stateOverrides:overrides}]);
    assert(row.trace.type==="CALL"&&same(row.trace.from,c.owner)&&same(row.trace.to,c.executor)&&same(row.trace.input,tx.data));
    row.diff=await c.rpc("debug_traceCall",[tx,c.pin,{tracer:"prestateTracer",tracerConfig:{diffMode:true},timeout:"30s",stateOverrides:overrides}]);
    const events:any[]=[];const walk=(t:any)=>{events.push(t);for(const child of t.calls??[])walk(child);};walk(row.trace);
    if(fault!=="none"){
      assert(row.trace.error,"negative accepted invalid amount/receiver/credit or old inventory");assertStorageUnchanged(row.diff);
      assertNativeInventory(row.diff,c.executor,17n);assertNativeInventory(row.diff,FUNDER,23n);
      if(fault==="post-revert"||fault==="minimum-plus-one"){
        const completed=events.filter(t=>same(t.from??"",c.executor)&&same(t.to??"",d.pool)&&t.input?.startsWith(ABI.getFunction("swap")!.selector));assert.equal(completed.length,1);assert(!completed[0].error,"postcondition must reject after real successful pool swap");
      }
      row.status="correctly-rejected";continue;
    }
    assert(!row.trace.error&&!row.trace.revertReason,"actual Kyber callback reverted");
    const swaps=events.filter(t=>same(t.from??"",c.executor)&&same(t.to??"",d.pool)&&t.input?.startsWith(ABI.getFunction("swap")!.selector));assert.equal(swaps.length,1);
    const swap=ABI.decodeFunctionData("swap",swaps[0].input);assert(same(swap[0],recipient));assert.equal(swap[1],c.amountIn);assert.equal(swap[2],r.isToken0);
    const deltas=[c.amountIn,-c.amountOut];assert.deepEqual([...ABI.decodeFunctionResult("swap",swaps[0].output)],r.isToken0?deltas:[...deltas].reverse());
    const callbacks=events.filter(t=>same(t.from??"",d.pool)&&same(t.to??"",c.executor)&&t.input?.startsWith(CALLBACK.getFunction("swapCallback")!.selector));assert.equal(callbacks.length,1);
    const cb=CALLBACK.decodeFunctionData("swapCallback",callbacks[0].input);assert.deepEqual([...cb].slice(0,2),r.isToken0?deltas:[...deltas].reverse());assert(cb[2]!=="0x");
    const transfer=(t:any,token:string,from:string,to:string,value:bigint)=>same(t.from??"",from)&&same(t.to??"",token)&&t.input?.startsWith(TOKEN.getFunction("transfer")!.selector)&&(()=>{const a=TOKEN.decodeFunctionData("transfer",t.input);return same(a[0],to)&&a[1]===value;})();
    const released=events.filter(t=>transfer(t,r.tokenOut,d.pool,recipient,c.amountOut));assert.equal(released.length,1);
    const paid=events.filter(t=>transfer(t,r.tokenIn,direct?c.executor:FUNDER,d.pool,c.amountIn));assert.equal(paid.length,1);
    const fund=events.filter(t=>same(t.to??"",FUNDER)&&t.input?.startsWith(FUND.getFunction("fund")!.selector));assert.equal(fund.length,direct?0:1);
    const order=[released[0],callbacks[0],...(!direct?[fund[0]]:[]),paid[0]].map(t=>events.indexOf(t));assert(order.every((n,i)=>i===0||n>order[i-1]!));row.callOrder=order;
    const initial=[before,[direct?0n:credit,0n],baseline[2]!,baseline[3]!];
    row.balances=actors.map((a,j)=>({account:a,tokens:tokens.map((t,i)=>({token:t,...observeBalance(row.diff,t,keys[j]![i]!,initial[j]![i]!)}))}));
    const expected=direct?[[-c.amountIn,same(recipient,c.executor)?c.amountOut:0n],[0n,0n],[c.amountIn,-c.amountOut],[0n,same(recipient,c.owner)?c.amountOut:0n]]:[[0n,c.amountOut-1n],[-c.amountIn,1n],[c.amountIn,-c.amountOut],[0n,0n]];
    assert.deepEqual(row.balances.map((b:any)=>b.tokens.map((t:any)=>t.delta)),expected);
    for(let i=0;i<2;i++)assert.equal(row.balances.reduce((s:bigint,b:any)=>s+b.tokens[i].delta,0n),0n);
    assert.equal(events.filter(t=>same(t.from??"",c.executor)&&tokens.some(token=>same(t.to??"",token))&&t.input?.startsWith(TOKEN.getFunction("approve")!.selector)).length,0);
    row.supplies=[];
    for(const [i,t] of tokens.entries()){
      const pre=row.diff.pre?.[t.toLowerCase()]?.storage??{},post=row.diff.post?.[t.toLowerCase()]?.storage??{};
      const observed={[t]:{stateDiff:Object.fromEntries([...new Set([...Object.keys(pre),...Object.keys(post)])].map(k=>[k,post[k]??word(0n)]))}};
      const after=await c.rpc("eth_call",[{from:c.owner,to:t,data:TOKEN.encodeFunctionData("totalSupply")},c.pin,observed]);assert.equal(after,supplies[i]);row.supplies.push({token:t,before:supplies[i],after});
    }
    row.executorNative=assertNativeInventory(row.diff,c.executor,17n);row.funderNative=assertNativeInventory(row.diff,FUNDER,23n);
    row.inactiveCallback=await c.rpc("debug_traceCall",[{...tx,data:callbacks[0].input},c.pin,{tracer:"callTracer",timeout:"30s",stateOverrides:overrides}]);
    row.inactiveDiff=await c.rpc("debug_traceCall",[{...tx,data:callbacks[0].input},c.pin,{tracer:"prestateTracer",tracerConfig:{diffMode:true},timeout:"30s",stateOverrides:overrides}]);
    assert(!row.inactiveCallback.calls?.length);assert(row.inactiveCallback.error||(row.inactiveCallback.output??"0x")==="0x");assertStorageUnchanged(row.inactiveDiff);
    assertNativeInventory(row.inactiveDiff,c.executor,17n);assertNativeInventory(row.inactiveDiff,FUNDER,23n);
    row.inactiveScope="no pending callback: inert empty return or revert; not an active wrong-caller test";row.status="pass";
  }
}
