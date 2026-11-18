import assert from "node:assert/strict";
import { AbiCoder, FunctionFragment, Interface, toBeHex, zeroPadValue } from "ethers";
import test from "node:test";
import { readySelectorCensusFromTransaction } from "../ready-selector-census.js";
import { selectorObservedCallResources } from "../venues/selector-execution-observation.js";
import { selectorExecutionInstanceKey, selectorExecutionRouteKey, selectorExecutionResourceKey,
  selectorFamilyIdentity } from "../venues/selector-execution-keys.js";

const sender = "0x" + "11".repeat(20), target = "0x" + "22".repeat(20), token = "0x" + "33".repeat(20), other = "0x" + "44".repeat(20);
const single = "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62";
const transfer = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const hash = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const signature = "exchange(string,address,address,uint256,uint256,uint256)", fn = FunctionFragment.from(signature), abi = new Interface([fn]);
const nomination = { poolIdPath: [0], poolNamespace: "PoolDomain", tokenInPath: [1], tokenOutPath: [2], tokenInIdPath: [3], tokenOutIdPath: [4], parameterPaths: [[0]] };
function singleLog(from: string, to: string, id: bigint, amount: bigint, index: number) {
  return { address: token, logIndex: index, topics: [single, zeroPadValue(sender,32), zeroPadValue(from,32), zeroPadValue(to,32)],
    data: AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [id, amount]) };
}
function census(args: readonly unknown[], logs: readonly unknown[], block = 50) {
  return readySelectorCensusFromTransaction({ chainId: 1, transactionHash: hash(block + 100), blockNumber: block, blockHash: hash(block),
    transactionIndex: 0, status: 1, from: sender, to: target, input: abi.encodeFunctionData(fn,args), logs, traces: [] });
}

test("SQL-style transaction census preserves ERC1155 token IDs into selector route identity", () => {
  const tx = census(["Pool/A", token, token, 42n, 43n, 9n], [singleLog(sender,target,42n,9n,0), singleLog(target,sender,43n,17n,1)]);
  const bound = selectorObservedCallResources({ signature, census: tx, callId: tx.calls[0]!.id, nomination });
  assert(bound);
  assert.equal(bound.scope.poolId,"Pool/A");
  assert.equal(bound.scope.tokenIn,token); assert.equal(bound.scope.tokenOut,token);
  assert.equal(bound.scope.tokenInId,"42"); assert.equal(bound.scope.tokenOutId,"43");
  assert.equal(bound.observedAmountIn,"9"); assert.equal(bound.flowAttribution,"address-correlation-only");
  const instance = selectorExecutionInstanceKey({ ...bound.scope, familyId: selectorFamilyIdentity(signature).familyId,
    immutableParameters: bound.immutableParameters });
  const forward = selectorExecutionRouteKey(instance,{tokenIn:{address:token,id:bound.scope.tokenInId},tokenOut:{address:token,id:bound.scope.tokenOutId}});
  const reverse = selectorExecutionRouteKey(instance,{tokenIn:{address:token,id:bound.scope.tokenOutId},tokenOut:{address:token,id:bound.scope.tokenInId}});
  assert.notEqual(forward,reverse);
  const later = census(["Pool/A", token, token, 42n, 43n, 999n], [], 51);
  const rebound = selectorObservedCallResources({signature,census:later,callId:later.calls[0]!.id,nomination}); assert(rebound);
  assert.equal(instance,selectorExecutionInstanceKey({...rebound.scope,familyId:selectorFamilyIdentity(signature).familyId,immutableParameters:rebound.immutableParameters}));
});

test("one contract has distinct selector instances while touched uses its common physical pool", () => {
  const base = census(["Pool/A",token,token,42n,43n,9n],[]);
  const secondSignature = "exchangeOther(string,address,address,uint256,uint256,uint256)", otherAbi = new Interface([FunctionFragment.from(secondSignature)]);
  const tx = readySelectorCensusFromTransaction({ chainId:1,transactionHash:hash(101),blockNumber:50,blockHash:hash(50),transactionIndex:0,status:1,
    from:sender,to:target,input:base.calls[0]!.calldata,logs:[],traces:[
      {trace_address:[],from_address:sender,to_address:target,input:base.calls[0]!.calldata,call_type:"call",status:1},
      {trace_address:[0],from_address:target,to_address:target,
      input:otherAbi.encodeFunctionData("exchangeOther",["Pool/A",token,token,42n,43n,9n]),call_type:"call",status:1}] });
  const first = selectorObservedCallResources({signature,census:tx,callId:tx.calls.find(call=>call.kind==="transaction")!.id,nomination});
  const second = selectorObservedCallResources({signature:secondSignature,census:tx,callId:tx.calls.find(call=>call.traceAddress?.length===1)!.id,nomination});
  assert(first);assert(second);
  const keys = [first,second].map((bound,i)=>selectorExecutionInstanceKey({...bound.scope,
    familyId:selectorFamilyIdentity(i===0?signature:secondSignature).familyId,immutableParameters:bound.immutableParameters}));
  assert.equal(new Map(keys.map((key,i)=>[key,[first,second][i]])).size,2);
  assert.equal(selectorExecutionResourceKey(first.scope),selectorExecutionResourceKey(second.scope));
});

test("ERC721 event hints retain contract plus uint256 tokenId without a guessed token permutation", () => {
  const largeId = 2n**200n+7n;
  const logs = [{address:token,logIndex:0,topics:[transfer,zeroPadValue(sender,32),zeroPadValue(target,32),zeroPadValue(toBeHex(largeId),32)],data:"0x"},
    {address:other,logIndex:1,topics:[transfer,zeroPadValue(target,32),zeroPadValue(sender,32)],data:zeroPadValue("0x0f",32)}];
  const tx = census(["Pool/A",token,other,largeId,0n,1n],logs);
  const bound = selectorObservedCallResources({signature,census:tx,callId:tx.calls[0]!.id,nomination:{poolIdPath:[0],poolNamespace:"PoolDomain"}});
  assert(bound);assert.equal(bound.scope.tokenIn,token);assert.equal(bound.scope.tokenInId,largeId.toString());
  assert.equal(bound.scope.tokenOut,other);assert.equal(bound.scope.tokenOutId,undefined);
  const ambiguous = census(["Pool/A",token,other,largeId,0n,1n],[...logs,{...logs[0],logIndex:2,
    topics:[transfer,zeroPadValue(sender,32),zeroPadValue(target,32),zeroPadValue("0x08",32)]}]);
  const uncertain = selectorObservedCallResources({signature,census:ambiguous,callId:ambiguous.calls[0]!.id});
  assert(uncertain);assert.equal(uncertain.scope.tokenIn,undefined);assert.equal(uncertain.scope.tokenInId,undefined);
});

test("ambiguous transfer amounts remain hints and declared tokenId narrows only its own resource", () => {
  const tx = census(["Pool/A",token,token,42n,43n,9n],[singleLog(sender,target,42n,9n,0),singleLog(sender,target,42n,2n,1),singleLog(target,sender,43n,17n,2)]);
  const bound = selectorObservedCallResources({signature,census:tx,callId:tx.calls[0]!.id,nomination});
  assert(bound);assert.equal(bound.scope.tokenInId,"42");assert.equal(bound.observedAmountIn,undefined);
  const changed = census(["pool/a",token,token,42n,43n,9n],[]);
  const otherPool = selectorObservedCallResources({signature,census:changed,callId:changed.calls[0]!.id,nomination});assert(otherPool);
  assert.notEqual(selectorExecutionResourceKey(bound.scope),selectorExecutionResourceKey(otherPool.scope));
});

test("a declared tokenId retains nomination while its contract awaits current binding", () => {
  const tx = census(["Pool/A",token,token,42n,43n,9n],[]);
  const bound = selectorObservedCallResources({signature,census:tx,callId:tx.calls[0]!.id,
    nomination:{tokenInIdPath:[3],tokenOutIdPath:[4],parameterPaths:[[3],[4]]}});
  assert(bound); assert.equal(bound.scope.tokenIn,undefined); assert.equal(bound.scope.tokenOut,undefined);
  assert.equal(bound.scope.tokenInId,"42"); assert.equal(bound.scope.tokenOutId,"43");
  assert.deepEqual(bound.immutableParameters.map(item=>item.value),["42","43"]);
  assert.equal(bound.observedAmountIn,undefined,"missing event evidence cannot create a measured input");
});

test("malformed calls and unsupported ABI resource paths cannot manufacture selector candidates", () => {
  const tx = census(["Pool/A",token,token,42n,43n,9n],[]), callId=tx.calls[0]!.id;
  assert.equal(selectorObservedCallResources({signature,census:tx,callId,selector:"0x00000000"}),null);
  assert.equal(selectorObservedCallResources({signature,census:tx,callId,nomination:{tokenInPath:[0]}}),null);
  assert.equal(selectorObservedCallResources({signature,census:tx,callId,nomination:{tokenInIdPath:[0]}}),null);
  assert.equal(selectorObservedCallResources({signature,census:{...tx,receiptStatus:0},callId}),null);
  assert.equal(selectorObservedCallResources({signature,census:{...tx,calls:[...tx.calls,tx.calls[0]!]},callId}),null);
  assert.equal(selectorObservedCallResources({signature,census:{...tx,calls:[{...tx.calls[0]!,calldata:tx.calls[0]!.calldata+"00"}]},callId}),null);
  const unfrozen = JSON.parse(JSON.stringify(tx));
  assert(selectorObservedCallResources({signature,census:unfrozen,callId,nomination}));
  assert.equal(Object.isFrozen(unfrozen.calls[0]),false,"projection must not freeze its caller's observations");
});
