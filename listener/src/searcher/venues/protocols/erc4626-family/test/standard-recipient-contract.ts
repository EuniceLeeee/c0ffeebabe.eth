import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { standardRecipientProgram } from "../execution.js";
const addr=(n:number)=>ethers.toBeHex(n,20),executor=addr(20),external=addr(21),d={vault:addr(22),share:addr(22),asset:addr(23)};
const abi=new ethers.Interface(["function balanceOf(address) view returns(uint256)","function allowance(address,address) view returns(uint256)","function approve(address,uint256) returns(bool)","function deposit(uint256,address) returns(uint256)","function redeem(uint256,address,address) returns(uint256)"]);
function run(deposit:boolean,recipient:string,fault="none",amount=37n){
 const input=deposit?d.asset:d.share,output=deposit?d.share:d.asset,key=(t:string,a:string)=>`${t.toLowerCase()}:${a.toLowerCase()}`;
 const balances=new Map([[key(input,executor),1000n],[key(output,executor),2000n],[key(input,external),3000n],[key(output,external),4000n]]);let native=17n,allowance=0n,converted=false;
 const get=(t:string,a:string)=>balances.get(key(t,a))!,add=(t:string,a:string,n:bigint)=>balances.set(key(t,a),get(t,a)+n);
 const p=standardRecipientProgram(d,executor,deposit?"deposit":"redeem",recipient);
 inspectRuntime(ethers.hexlify(p.bytes()),amount,{nativeBalance:()=>native,call(c){const q=abi.parseTransaction({data:c.data})!;
  if(q.name==="balanceOf")return abi.encodeFunctionResult(q.fragment,[get(c.target,q.args[0])]);
  if(q.name==="allowance")return abi.encodeFunctionResult(q.fragment,[allowance]);
  if(q.name==="approve"){allowance=q.args[1];return abi.encodeFunctionResult(q.fragment,[true]);}
  assert.equal(q.name,deposit?"deposit":"redeem");assert.equal(q.args[0],amount);assert.equal(String(q.args[1]).toLowerCase(),recipient.toLowerCase());if(!deposit)assert.equal(String(q.args[2]).toLowerCase(),executor.toLowerCase());converted=true;
  add(input,executor,-(fault==="zero-debit"?0n:amount+(fault==="under-debit"?-1n:fault==="over-debit"?1n:0n)));
  add(output,fault==="wrong-recipient"?external:recipient,53n+(fault==="short-credit"?-1n:fault==="extra-credit"?1n:0n));
  if(fault.startsWith("actor-output"))add(output,executor,fault.endsWith("plus")?1n:-1n);
  if(fault.startsWith("receiver-input"))add(input,recipient,fault.endsWith("plus")?1n:-1n);
  if(fault.startsWith("native"))native+=fault.endsWith("plus")?1n:-1n;
  return abi.encodeFunctionResult(q.fragment,[53n+(fault==="return-plus"?1n:0n)]);
 }});
 if(fault!=="none")return;
 assert(converted);assert.equal(get(input,executor),1000n-amount);assert.equal(get(output,recipient),(recipient===executor?2000n:4000n)+53n);
}
for(const dep of [true,false])test(`${dep?"deposit":"redeem"} direct amount, receipt and unrelated inventories`,()=>{
 for(const recipient of [executor,external]){run(dep,recipient);for(const f of ["zero-debit","under-debit","over-debit","short-credit","extra-credit","return-plus","native-plus","native-minus"])assert.throws(()=>run(dep,recipient,f));assert.throws(()=>run(dep,recipient,"none",0n));}
 for(const f of ["actor-output-plus","actor-output-minus","receiver-input-plus","receiver-input-minus"])assert.throws(()=>run(dep,external,f));
 assert.throws(()=>run(dep,executor,"wrong-recipient"));
});
