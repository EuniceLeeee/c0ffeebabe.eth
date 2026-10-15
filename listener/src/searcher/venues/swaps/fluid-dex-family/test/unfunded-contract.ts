import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { assertUnfundedRejection } from "./unfunded-evidence.js";
const token="0x0000000000000000000000000000000000000001",executor="0x0000000000000000000000000000000000000002",pool="0x0000000000000000000000000000000000000003",liquidity="0x0000000000000000000000000000000000000004";
const abi=new ethers.Interface(["function transferFrom(address,address,uint256) returns(bool)"]);
const c={token,executor,pool,liquidity,amount:10n};
const trace=()=>({type:"CALL",error:"execution reverted",calls:[{type:"CALL",from:pool,to:token,input:abi.encodeFunctionData("transferFrom",[executor,liquidity,10n]),error:"invalid opcode: INVALID"}]});
const diff=()=>({pre:{},post:{}});
test("real full-input token INVALID plus atomic rollback is independently classified",()=>assert.equal(assertUnfundedRejection(trace(),diff(),c).storageRollback,true));
test("missing/wrong payer/amount/token calls cannot prove no-input rejection",()=>{
 assert.throws(()=>assertUnfundedRejection({...trace(),calls:[]},diff(),c));
 for(const patch of [{from:liquidity},{to:liquidity},{input:abi.encodeFunctionData("transferFrom",[executor,liquidity,9n])},{input:abi.encodeFunctionData("transferFrom",[pool,liquidity,10n])}]){const t=trace();Object.assign(t.calls[0],patch);assert.throws(()=>assertUnfundedRejection(t,diff(),c));}
});
test("out of gas, success and duplicate failed attempts stay unverified",()=>{
 for(const e of ["out of gas","timeout","gas limit exceeded",""]){const t=trace();t.calls[0].error=e;assert.throws(()=>assertUnfundedRejection(t,diff(),c));}
 const t=trace();t.error="";assert.throws(()=>assertUnfundedRejection(t,diff(),c));const twice=trace();twice.calls.push({...twice.calls[0]});assert.throws(()=>assertUnfundedRejection(twice,diff(),c));
});
test("pre-only deleted storage and changed native cannot pass rollback",()=>{
 const changed={pre:{[token]:{storage:{"0x01":"0x01"}}},post:{}};assert.throws(()=>assertUnfundedRejection(trace(),changed,c));
 for(const n of [16,18])assert.throws(()=>assertUnfundedRejection(trace(),{pre:{[executor]:{balance:"0x11"}},post:{[executor]:{balance:ethers.toQuantity(n)}}},c));
});
