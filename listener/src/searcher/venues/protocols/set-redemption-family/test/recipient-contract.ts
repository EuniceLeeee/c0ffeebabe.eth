import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { setDirectProgram } from "../direct.js";
import { execution, legacyRuntime } from "../execution.js";
import { legacyIssueRuntime } from "../issuance.js";
import { routes } from "../routes.js";
import { key } from "../instance.js";
import { FAMILY, LEGACY_LINEAGE } from "../manifest.js";
import { TOKEN } from "../codec.js";
const addr=(n:number)=>ethers.toBeHex(n,20), actor=addr(10),recipient=addr(11),input=addr(12),output=addr(13),target=addr(14);
function run(external:boolean,amount=17n,fault: {debit?:bigint;credit?:bigint;native?:bigint;actorOutput?:bigint;recipientInput?:bigint}={}) {
  let changed=false;const balances=new Map([[`${input}:${actor}`,1000n],[`${output}:${actor}`,2000n],[`${input}:${recipient}`,3000n],[`${output}:${recipient}`,4000n]]);
  const to=external?recipient:actor,raw=new RuntimeAmountProgram().call(target,"0x12345678")
    .call(output,TOKEN.encodeFunctionData("balanceOf",[to]),{static:true}).load(11,0).constant(12,(external?4000n:2000n)+23n).math("sub",12,11,12)
    .constant(14,999n).constant(0,0n); // child registers cannot overwrite outer full input/snapshots
  const p=setDirectProgram(raw,input,output,actor,to);
  const result=inspectRuntime(ethers.hexlify(p.bytes()),amount,{nativeBalance:()=>29n+(changed?(fault.native??0n):0n),call(c){
    if(c.target.toLowerCase()===target){assert(!changed);changed=true;balances.set(`${input}:${actor}`,1000n-(fault.debit??amount));balances.set(`${output}:${to}`,balances.get(`${output}:${to}`)!+(fault.credit??23n));if(external){balances.set(`${output}:${actor}`,2000n+(fault.actorOutput??0n));balances.set(`${input}:${recipient}`,3000n+(fault.recipientInput??0n));}return "0x";}
    const a=TOKEN.decodeFunctionData("balanceOf",c.data)[0].toLowerCase();return TOKEN.encodeFunctionResult("balanceOf",[balances.get(`${c.target.toLowerCase()}:${a}`)!]);
  }});
  assert(changed);assert.equal(result.registers[0],amount);return result;
}
test("unary direct uses full input, protects both old inventories and preserves native",()=>{
 for(const external of [false,true]){for(const a of [1n,17n,1000n])run(external,a);
  for(const debit of [0n,16n,18n,1001n])assert.throws(()=>run(external,17n,{debit}));
  assert.throws(()=>run(external,0n));assert.throws(()=>run(external,17n,{credit:0n}));assert.throws(()=>run(external,17n,{credit:22n}));run(external,17n,{credit:24n});for(const native of [-1n,1n])assert.throws(()=>run(external,17n,{native}));
 }for(const delta of [-1n,1n]){assert.throws(()=>run(true,17n,{actorOutput:delta}));assert.throws(()=>run(true,17n,{recipientInput:delta}));}
});
test("legacy default issue/redeem bytecode remains original; only explicit direct adds guards",()=>{
 for(const kind of ["set-token","rebalancing-v3"] as const){const d:any={familyId:FAMILY,lineageId:LEGACY_LINEAGE,set:output,module:target,controller:addr(15),controllerCodeHash:ethers.keccak256("0x6000"),components:[input],legacy:{kind,factory:addr(16),factoryCodeHash:ethers.keccak256("0x6000"),vault:addr(17),setCodeHash:ethers.keccak256("0x6000"),issuance:{transferProxy:addr(18),codeHash:ethers.keccak256("0x6000")}},provenance:[],runtimeRequirements:[]};d.instanceKey=key(d);
 for(const route of routes.project({descriptor:d})){const i:any={descriptor:d,route,executor:actor,runtimeEvidence:[]};const raw=route.issue?legacyIssueRuntime(d,actor):legacyRuntime(d,actor);assert.equal(execution.buildRuntimeLeg(i)!.program,ethers.hexlify(raw.bytes()));
  for(const to of [actor,recipient]){const direct=execution.buildRuntimeLeg({...i,settlement:{kind:"direct-output",recipient:to}});assert(direct);assert.notEqual(direct.program,ethers.hexlify(raw.bytes()));assert.equal(direct.settlement!.directOutput,true);}
  for(const kind of ["quote-output","deferred-input"])assert.equal(execution.buildRuntimeLeg({...i,settlement:{kind,recipient,paymentAmount:1n,paymentProgram:ethers.hexlify(new RuntimeAmountProgram().constant(1,0n).bytes())}}),null);
 }}
});
