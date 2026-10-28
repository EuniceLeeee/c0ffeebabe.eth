import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { custodianProgram } from "../custodian-execution.js";
import { CUSTODIAN_ABI, CUSTODIAN_TOKEN } from "../custodian.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
const addr=(n:number)=>ethers.getAddress(ethers.toBeHex(n,20));
const d={vault:addr(101),asset:addr(102),share:addr(103)},actor=addr(107),external=addr(109);
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
function run(direction:"deposit"|"redeem",recipient:string,amount:bigint,fault="none",direct=true){
  const deposit=direction==="deposit",input=deposit?d.asset:d.share,output=deposit?d.share:d.asset;
  const expected=deposit?amount*1000n:amount/1000n, balances=new Map<string,bigint>(),key=(t:string,a:string)=>t.toLowerCase()+":"+a.toLowerCase();
  for(const t of [input,output])for(const a of [actor,external])balances.set(key(t,a),same(a,actor)?1000000n+(same(t,input)?amount:0n):333n);
  const before=new Map(balances);let supply=10n**25n,allowance=13n,converted=false;const approvals:bigint[]=[];
  const get=(t:string,a:string)=>{const v=balances.get(key(t,a));assert(v!==undefined);return v;};
  const add=(t:string,a:string,n:bigint)=>balances.set(key(t,a),get(t,a)+n);
  const bytes=custodianProgram(d,actor,direction,1n,recipient,direct).bytes();
  const trace=inspectRuntime(ethers.hexlify(bytes),amount,{nativeBalance:()=>17n+(converted?(fault==="native-plus"?1n:fault==="native-minus"?-1n:0n):0n),call(c){
    assert.equal(c.value,0n);assert.equal(c.incoming,0);assert.equal(c.outgoing,0);
    const vault=same(c.target,d.vault),abi=vault?CUSTODIAN_ABI:CUSTODIAN_TOKEN,x=abi.parseTransaction({data:c.data})!;
    assert(vault||same(c.target,d.share)||same(c.target,d.asset));let values:unknown[]=[];
    if(!["approve","deposit","redeem"].includes(x.name))assert(c.static);
    switch(x.name){
      case "frxUSD":values=[d.share];break;
      case "asset":case "custodianTkn":values=[d.asset];break;
      case "minters":values=[true];break;
      case "isPaused":case "isFrozen":values=[false];break;
      case "balanceOf":values=[get(c.target,String(x.args[0]))];break;
      case "totalSupply":values=[supply];break;
      case "mdwrComboView":values=[10n**30n,10n**30n,10n**30n,10n**30n];break;
      case "previewDeposit":case "previewRedeem":assert.equal(x.args[0],amount);values=[expected];break;
      case "allowance":assert(same(String(x.args[0]),actor)&&same(String(x.args[1]),d.vault));values=[allowance];break;
      case "approve":assert(same(c.target,input));assert(same(String(x.args[0]),d.vault));allowance=BigInt(x.args[1]);approvals.push(allowance);if(converted&&fault==="dirty-allowance")allowance=1n;values=[true];break;
      case "deposit":case "redeem":{
        assert.equal(x.name,direction);assert.equal(x.args[0],amount);assert(same(String(x.args[1]),recipient));if(!deposit)assert(same(String(x.args[2]),actor));assert.equal(allowance,amount);converted=true;
        const debit=fault==="zero-debit"?0n:amount+(fault==="under-debit"?-1n:fault==="over-debit"?1n:0n);
        const credit=fault==="zero-credit"?0n:expected+(fault==="short-credit"?-1n:fault==="extra-credit"?1n:0n);
        add(input,actor,-debit);add(output,recipient,credit);supply+=deposit?expected:-amount;if(fault==="wrong-supply")supply++;
        if(fault==="old-output")add(output,actor,-1n);if(fault==="receiver-input")add(input,recipient,-1n);
        values=[expected+(fault==="return-plus"?1n:fault==="return-minus"?-1n:0n)];break;
      }
      default:assert.fail(x.name);
    }
    return abi.encodeFunctionResult(x.name,values);
  }});
  if(fault!=="none")return; // Negative verdict may only come from program execution.
  assert(converted);assert.equal(trace.registers[0],amount);assert.equal(allowance,0n);assert.deepEqual(approvals,[0n,amount,0n]);
  for(const t of [input,output])for(const a of [actor,external])assert.equal(get(t,a)-before.get(key(t,a))!,same(t,input)&&same(a,actor)?-amount:same(t,output)&&same(a,recipient)?expected:0n);
}
for(const direction of ["deposit","redeem"] as const)for(const recipient of [actor,external]){
  const amount=direction==="deposit"?12345n:12345678n;
  test(`${direction}/${recipient} full input and actual receiver credit`,()=>run(direction,recipient,amount));
  test(`${direction}/${recipient} zero input cannot consume old inventory`,()=>assert.throws(()=>run(direction,recipient,0n)));
  for(const fault of ["zero-debit","under-debit","over-debit","zero-credit","short-credit","extra-credit","return-plus","return-minus","wrong-supply","dirty-allowance","old-output","receiver-input","native-plus","native-minus"])
    test(`${direction}/${recipient} rejects ${fault}`,()=>assert.throws(()=>run(direction,recipient,amount,fault)));
}

const golden=JSON.parse(readFileSync(new URL("./custodian-recipient-default.json",import.meta.url),"utf8"));
for(const direction of ["deposit","redeem"] as const)test(`${direction} default bytes retain previous production program`,()=>assert.equal(ethers.hexlify(custodianProgram(d,actor,direction).bytes()),golden.programs[direction]));
