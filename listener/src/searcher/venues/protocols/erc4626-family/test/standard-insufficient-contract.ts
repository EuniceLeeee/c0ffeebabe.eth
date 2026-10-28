import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { assertInsufficientRejection, restoreSavedEffects, accessedBalanceMappingKey } from "./standard-insufficient-evidence.js";
const token="0x0000000000000000000000000000000000000001",executor="0x0000000000000000000000000000000000000002",pool="0x0000000000000000000000000000000000000003",liquidity="0x0000000000000000000000000000000000000004";
const abi=new ethers.Interface(["function transferFrom(address,address,uint256) returns(bool)"]);
const c={token,executor,pool,liquidity,amount:10n};
const trace=()=>({type:"CALL",error:"execution reverted",calls:[{type:"CALL",from:pool,to:token,input:abi.encodeFunctionData("transferFrom",[executor,liquidity,10n]),error:"invalid opcode: INVALID"}]});
const diff=()=>({pre:{},post:{}});
test("real full-input token INVALID plus atomic rollback is independently classified",()=>assert.equal(assertInsufficientRejection(trace(),diff(),c).storageRollback,true));
test("missing/wrong payer/amount/token calls cannot prove no-input rejection",()=>{
 assert.throws(()=>assertInsufficientRejection({...trace(),calls:[]},diff(),c));
 for(const patch of [{from:liquidity},{to:liquidity},{input:abi.encodeFunctionData("transferFrom",[executor,liquidity,9n])},{input:abi.encodeFunctionData("transferFrom",[pool,liquidity,10n])}]){const t=trace();Object.assign(t.calls[0],patch);assert.throws(()=>assertInsufficientRejection(t,diff(),c));}
});
test("out of gas, success and duplicate failed attempts stay unverified",()=>{
 for(const e of ["out of gas","timeout","gas limit exceeded",""]){const t=trace();t.calls[0].error=e;assert.throws(()=>assertInsufficientRejection(t,diff(),c));}
 const t=trace();t.error="";assert.throws(()=>assertInsufficientRejection(t,diff(),c));const twice=trace();twice.calls.push({...twice.calls[0]});assert.throws(()=>assertInsufficientRejection(twice,diff(),c));
});
test("pre-only deleted storage and changed native cannot pass rollback",()=>{
 const changed={pre:{[token]:{storage:{"0x01":"0x01"}}},post:{}};assert.throws(()=>assertInsufficientRejection(trace(),changed,c));
 for(const n of [16,18])assert.throws(()=>assertInsufficientRejection(trace(),{pre:{[executor]:{balance:"0x11"}},post:{[executor]:{balance:ethers.toQuantity(n)}}},c));
});

// Exact delta-only shape from original failed report 5eeea642791547b5cfd84367b40d02a78ed58d4855717c214348deda8ecc16b2. Logs omitted.
test("saved positive delta-only evidence is restored without invented balance fields",()=>{
 const saved={"tokenDeltas":[{"token":"0xdac17f958d2ee523a2206206994597c13d831ec7","account":"0x1000000000000000000000000000000000000002","delta":"-1862544893"},{"token":"0xdac17f958d2ee523a2206206994597c13d831ec7","account":"0x1000000000000000000000000000000000000001","delta":"0"},{"token":"0x2bd3a43863c07b6a01581fada0e1614ca5df0e3d","account":"0x1000000000000000000000000000000000000002","delta":"1821122570379287662778"},{"token":"0x2bd3a43863c07b6a01581fada0e1614ca5df0e3d","account":"0x1000000000000000000000000000000000000001","delta":"0"}],"nativeDeltas":[{"account":"0x1000000000000000000000000000000000000002","delta":"0"}],"totalSupplyDeltas":[{"token":"0xdac17f958d2ee523a2206206994597c13d831ec7","delta":"0"},{"token":"0x2bd3a43863c07b6a01581fada0e1614ca5df0e3d","delta":"1821122570379287662778"}],"logs":[]};
 const snapshot=JSON.stringify(saved),restored=restoreSavedEffects(saved);
 assert.equal(restored.tokenDeltas[0].delta,-1862544893n);assert.equal(restored.tokenDeltas[2].delta,1821122570379287662778n);
 assert.equal(restored.nativeDeltas[0].delta,0n);assert.equal(restored.totalSupplyDeltas[1].delta,1821122570379287662778n);
 for(const rows of [restored.tokenDeltas,restored.nativeDeltas,restored.totalSupplyDeltas])for(const row of rows){assert(!("before" in row));assert(!("after" in row));}
 assert.equal(JSON.stringify(saved),snapshot);assert.throws(()=>restoreSavedEffects({...saved,tokenDeltas:[{}]}));
});

test("actual getter mapping selection ignores read-only flag keys, rejects absent or ambiguous mapping",()=>{
 const key=(index:number)=>ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address","uint256"],[executor,index]));
 const flag=ethers.zeroPadValue("0x06",32);
 assert.equal(accessedBalanceMappingKey([flag,key(2)],executor),key(2));
 assert.equal(accessedBalanceMappingKey([key(12),key(12)],executor),key(12));
 assert.throws(()=>accessedBalanceMappingKey([flag],executor));
 assert.throws(()=>accessedBalanceMappingKey([key(2),key(12)],executor));
 assert.throws(()=>accessedBalanceMappingKey([key(2)],pool));
});
