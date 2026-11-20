import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "ethers";
import { buildEthSimulateV1ExecutionInput as build } from "../simulator/eth-simulate-v1.js";
const h = "0x"+"a".repeat(64);
const input = {source:{number:100,hash:h,generation:1},header:{number:100,hash:h,
  parentHash:"0x"+"b".repeat(64),timestamp:1800000000,baseFeePerGas:1000000000n,
  gasUsed:10000000n,gasLimit:30000000n,transactionHashes:[]},executor:"0x"+"2".repeat(40),
  owner:"0x"+"1".repeat(40),profitToken:"0x"+"3".repeat(40),scriptHex:"0x"};
test("an authenticated executor image reuses only immutable bytes; saved or caller-owned inputs authenticate separately",()=>{
  const provided = {code:"0x60FF",keccak256:keccak256("0x60ff")};
  const wrap=(x:typeof provided)=>build({...input,executorRuntimeCode:x});
  const first=wrap(provided), image=first.executorRuntimeCode!;
  const second=wrap(image);
  assert.notEqual(image,provided);
  assert(Object.isFrozen(image));
  assert.equal(image.code,"0x60ff");
  assert.equal(image,second.executorRuntimeCode);
  assert.deepEqual(first,second);
  assert.notEqual(wrap(Object.freeze({...image})).executorRuntimeCode,image);
  provided.code="0x60ee";
  assert.throws(()=>wrap(provided),/invalid final simulation executor code/);
  assert.throws(()=>wrap(Object.freeze({...image,code:"0x60ee"})),/invalid final simulation executor code/);
  const changedOwner = {...input,owner:"0x"+"4".repeat(40)};
  assert.notDeepEqual(build({...changedOwner,executorRuntimeCode:image}).simulateParams,second.simulateParams);
});
