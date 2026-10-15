import assert from "node:assert/strict";
import { ethers } from "ethers";
import { AnvilStateBackend } from "../../../../../shared/state/state-backend.js";
import { buildExecuteCalldata } from "../../../../../shared/executor/botvm-executor.js";
import { balanceStorageKey, resolveErc20BalanceSlot } from "../../../../solver/balance-slots.js";
import { word, sha, json, same, assertNativeInventory } from "../../../../test/family-integration/kyber-yb-compound/evidence.js";
const TOKEN = new ethers.Interface(["function balanceOf(address) view returns(uint256)","function totalSupply() view returns(uint256)","function transferFrom(address,address,uint256) returns(bool)"]);
const SUB = new ethers.Interface(["function execSubscript(bytes)"]);
export function assertUnfundedRejection(trace: any, diff: any, c: { token: string; executor: string; pool: string; liquidity: string; amount: bigint }) {
  assert(trace.error, "unfunded call succeeded");
  const flat: any[] = []; const walk=(t:any)=>{flat.push(t);for(const child of t.calls??[])walk(child);};walk(trace);
  // Retain actual INVALID rather than treating a gas/transport limit as proof.
  const pulls=flat.filter(t=>t.type==="CALL"&&same(t.to??"",c.token)&&t.input?.startsWith(TOKEN.getFunction("transferFrom")!.selector));
  const matching=pulls.filter(t=>{const a=TOKEN.decodeFunctionData("transferFrom",t.input);return same(a[0],c.executor)&&same(a[1],c.liquidity)&&a[2]===c.amount;});
  assert(matching.length>=1,"no actual full-input transfer attempt");
  const failed=matching.filter(t=>t.error); assert.equal(failed.length,1);
  assert(same(failed[0].from,c.pool),"unexpected payer pull authority");
  assert(/invalid|opcode/i.test(failed[0].error) && !/out.of.gas|timeout|limit/i.test(failed[0].error),"not a proven token INVALID rejection");
  for(const a of new Set([...Object.keys(diff.pre??{}),...Object.keys(diff.post??{})])){
    const pre=diff.pre?.[a]?.storage??{},post=diff.post?.[a]?.storage??{};
    for(const k of new Set([...Object.keys(pre),...Object.keys(post)])) assert.equal(BigInt(pre[k]??0),BigInt(post[k]??0),"rejection changed storage");
  }
  assertNativeInventory(diff,c.executor,17n);
  return { failedPull: failed[0], matchedAttempts: matching.length, storageRollback: true,
    classification: "actual token INVALID at full-input transferFrom with zero payer input; strict resource classification is not rewritten" };
}
export async function createUnfundedFork(c: {rpcUrl:string;port:number;source:any;header:any;owner:string;executor:string;signal:AbortSignal;deadlineAtMs:number;report:any}) {
  assert(Number.isInteger(c.port)&&c.port>=1024&&c.port<=65535);
  const url=`http://127.0.0.1:${c.port}`, backend=new AnvilStateBackend(c.rpcUrl,url,c.port), pin=ethers.toQuantity(c.source.number);
  let reads=0;const r=c.report.independentFork={port:c.port,queries:0,slotProofs:[],headerBefore:null,headerAfter:null,environment:null};
  const rpc=async(method:string,params:any[])=>{
    assert(["web3_clientVersion","eth_chainId","eth_getBlockByNumber","eth_getCode","eth_getStorageAt","eth_call","debug_traceCall","anvil_setCoinbase"].includes(method));
    if(method==="anvil_setCoinbase")assert.deepEqual(params,[c.header.miner]);
    c.signal.throwIfAborted();const id=++reads;r.queries=reads;assert(reads<=350&&Date.now()<c.deadlineAtMs);
    const res=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id,method,params}),signal:AbortSignal.any([c.signal,AbortSignal.timeout(30000)])});
    assert(res.ok,`HTTP ${res.status}`);const b:any=await res.json();assert.equal(b.id,id);assert.equal(b.jsonrpc,"2.0");assert(!b.error,`${method} failed: ${b.error?.code} ${b.error?.message}`);return b.result;
  };
  const call=(token:string,data:string,overrides:any={})=>rpc("eth_call",[{from:c.owner,to:token,data},pin,overrides]);
  const balance=async(token:string,account:string,overrides:any={})=>BigInt(await call(token,TOKEN.encodeFunctionData("balanceOf",[account]),overrides));
  const checkHeader=async()=>{const h=await rpc("eth_getBlockByNumber",["latest",false]);for(const f of ["number","hash","parentHash","stateRoot","timestamp","baseFeePerGas","gasLimit","miner","mixHash","excessBlobGas"])assert.equal(h[f],c.header[f],`fork header ${f}`);return h;};
  const slots=new Map<string,string>();
  const slot=async(token:string,protectedAccount:string)=>{
    if(slots.has(token))return slots.get(token)!;
    const protectedBefore=await balance(token,protectedAccount),supply=await call(token,TOKEN.encodeFunctionData("totalSupply"));
    const index=await resolveErc20BalanceSlot(token,protectedAccount,{balanceOf:balance,getStorage:async(t,k)=>BigInt(await rpc("eth_getStorageAt",[t,k,pin]))});assert(index!==null,"plain token balance mapping unresolved");
    const key=balanceStorageKey(c.executor,index);
    for(const v of [717171717171n,919191919193n]){const o={[token]:{stateDiff:{[key]:word(v)}}};assert.equal(await balance(token,c.executor,o),v);assert.equal(await balance(token,protectedAccount,o),protectedBefore);assert.equal(await call(token,TOKEN.encodeFunctionData("totalSupply"),o),supply);}
    r.slotProofs.push({token,protectedAccount,protectedBalance:protectedBefore,supply,index,key,probes:[717171717171n,919191919193n]});slots.set(token,key);return key;
  };
  try {
    await backend.forkAt(c.source.number,{signal:c.signal,deadlineAtMs:c.deadlineAtMs});assert(/anvil/i.test(await rpc("web3_clientVersion",[])));assert.equal(BigInt(await rpc("eth_chainId",[])),1n);r.headerBefore=await checkHeader();
    const env=async()=>[...ethers.AbiCoder.defaultAbiCoder().decode(Array(7).fill("uint256"),await call(c.executor,"0x",{[c.executor]:{code:"0x43600052426020524860405241606052456080524460a0524660c05260e06000f3"}}))];
    const expected=[BigInt(c.header.number),BigInt(c.header.timestamp),BigInt(c.header.baseFeePerGas),BigInt(c.header.miner),BigInt(c.header.gasLimit),BigInt(c.header.mixHash),1n];
    const before=await env();if(before[3]!==expected[3])await rpc("anvil_setCoinbase",[c.header.miner]);r.environment=await env();assert.deepEqual(r.environment,expected);
    assert.equal(await rpc("eth_getCode",[c.owner,pin]),"0x");
  }catch(e){await backend.stopAndWait();backend.provider.destroy();throw e;}
  return {
    async check(x:{script:Uint8Array;request:any;executorRuntimeCode:any;tokenIn:string;tokenOut:string;amountIn:bigint;outputInventory:bigint;pool:string;liquidity:string;recipient:string}){
      const code=await rpc("eth_getCode",[c.executor,pin]);assert(code==="0x"||same(code,x.executorRuntimeCode.code));
      assert.equal(SUB.decodeFunctionData("execSubscript",x.request.call.data)[0],ethers.hexlify(x.script));
      const inputKey=await slot(x.tokenIn,x.liquidity),outputKey=await slot(x.tokenOut,x.liquidity);
      const overrides:any={[c.owner]:{balance:ethers.toQuantity(100n*10n**18n)},[c.executor]:{code:x.executorRuntimeCode.code,balance:"0x11"},
        [x.tokenIn]:{stateDiff:{[inputKey]:word(0n)}},[x.tokenOut]:{stateDiff:{[outputKey]:word(x.outputInventory)}}};
      assert.equal(await balance(x.tokenIn,c.executor,overrides),0n);assert.equal(await balance(x.tokenOut,c.executor,overrides),x.outputInventory);
      const tx={from:c.owner,to:c.executor,data:buildExecuteCalldata(x.script),gas:"0x1000000",gasPrice:c.header.baseFeePerGas};
      const trace=await rpc("debug_traceCall",[tx,pin,{tracer:"callTracer",timeout:"30s",stateOverrides:overrides}]);
      assert(same(trace.from,c.owner)&&same(trace.to,c.executor)&&trace.input===tx.data);
      const diff=await rpc("debug_traceCall",[tx,pin,{tracer:"prestateTracer",tracerConfig:{diffMode:true},timeout:"30s",stateOverrides:overrides}]);
      const proof=assertUnfundedRejection(trace,diff,{token:x.tokenIn,executor:c.executor,pool:x.pool,liquidity:x.liquidity,amount:x.amountIn});
      for(const a of [x.pool,x.liquidity]){const pre=diff.pre?.[a.toLowerCase()]?.balance,post=diff.post?.[a.toLowerCase()]?.balance;if(pre!==undefined||post!==undefined)assert.equal(BigInt(pre??0),BigInt(post??0));}
      return {status:"correct-insufficient-input-rejection-with-rollback",transaction:tx,scriptHash:ethers.keccak256(x.script),overrides,overridesHash:sha(json(overrides)),trace,diff,proof,
        entryScope:"owner execute wrapper uses identical current issuer subscript; pool sender executor and tx.origin owner; independent Anvil call, not strict transport reclassification",
        gasNonceScope:"owner transaction fee/nonce may differ in prestate tracer; all contract storage and executor/protocol native protected"};
    },
    async close(){try{r.headerAfter=await checkHeader();}finally{await backend.stopAndWait();backend.provider.destroy();}}
  };
}
