import assert from "node:assert/strict";
import test from "node:test";
import { Interface, ZeroHash } from "ethers";
import { plugin } from "../venues/production-families/univ2-standard.production.js";
import { plugin as angstrom } from "../venues/production-families/angstrom-v4.production.js";

const pool="0xdcb004ed28d585d23d63f965e203d16a822eda33";
const source={number:26029368,hash:"0x9e1bb0fa8981ff45975e804044a1aea9334e683b5fa9d8e1a225b22234ef8923",generation:1};
const pair=new Interface(["function factory() view returns (address)","function token0() view returns (address)","function token1() view returns(address)"]);
const values:Record<string,string>={factory:"0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",token0:"0x21da6b81b3c4420efbf0adb3ddd5fc0d1f1d1c3b",token1:"0x582d872a1b094fc48f5de31d3b73f2d9be47def1"};

test("V2 reverse binding reads this pool on the selected block; missing reads and foreign owners are separate outcomes", async()=>{
  const reverse=plugin.discovery!.reverseBinding;
  assert.equal(reverse?.kind,"implementation");
  let reads=0;
  const provider={
    getCode:async()=> "0x6000",getStorage:async()=>ZeroHash,getLogs:async()=>[],getTransactionReceipt:async()=>null,
    call:async({to,data}:{to:string;data:string},block:number)=>{
      assert.equal(to.toLowerCase(),pool); assert.equal(block,source.number); reads++;
      const method=pair.getFunction(data.slice(0,10))!;
      return pair.encodeFunctionResult(method,[values[method.name]]);
    },
  };
  const seed={address:pool,opaque:{adapter:"univ2",factory:"0x"+"47".repeat(20)}};
  const result=await reverse.reverseBinding({source,provider,nominations:[seed,{address:pool,opaque:{adapter:"another-family"}}]});
  assert.deepEqual(result.map(row=>row.status),["verified","unsupported"]);
  assert.equal(reads,3);
  assert.equal(result[0]!.status,"verified");
  const obs=result[0]!.observation;
  assert.equal(obs.kind,"address-surface");
  const candidate=plugin.discovery!.decodeCandidate({observation:obs,matchedPatternId:"univ2-pair-surface"}) as any;
  assert.equal(candidate.pool.toLowerCase(),pool);
  assert.equal(candidate.hintedFactory.toLowerCase(),values.factory);
  assert.equal(candidate.hintedToken0.toLowerCase(),values.token0);
  const [failed]=await reverse.reverseBinding({source,provider:{...provider,call:async()=>"0x"},nominations:[seed]});
  assert.equal(failed?.status,"failed");
  assert.equal(angstrom.discovery!.reverseBinding?.kind,"explicitly-unsupported");
});
