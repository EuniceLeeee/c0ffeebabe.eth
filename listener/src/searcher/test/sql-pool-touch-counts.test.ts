import test from "node:test";
import assert from "node:assert/strict";
import {PoolTouchCounts,priceCarryOutcomes,reportOptionalEffectiveCounts,type PhysicalHit} from "../sql-pool-touch-counts.js";
import {readBlockTouchedStateKeys,type BlockTouchedStateKeyResolver} from "../blockscan-touched-state.js";
const h=(n:number)=>"0x"+n.toString(16).padStart(64,"0"),addr="0x"+"a".repeat(40);
const anchor=(n:number)=>({hash:h(n),parentHash:h(n-1),transactionHashes:[],passiveTouchedAddresses:[]});
test("aggregate physical identity, public legs, fallback overlap and distinguish partial, aborted, fork, missing passive",async()=>{
  const j=new PoolTouchCounts();let calls=0,breakAt=-1,failed=false;
  const hit={directPools:[{poolAddress:addr,poolId:"A"}],directLegIds:["a","b"],fallbackLegIds:["b","c"],fallbackManagers:[addr]};
  const resolver:BlockTouchedStateKeyResolver=Object.assign(((o,_,record)=>{if(o.kind!=="log")throw Error("not log");record?.(hit);return ["a","b","c"];}) as BlockTouchedStateKeyResolver,
    {poolTouchCounts:()=>j,passiveStateKeys:()=>[]});
  const provider={async getLogs(f:{blockHash?:string}){calls++;if(f.blockHash===h(breakAt)&&!failed){failed=true;throw Error("aborted");}
    return [0,1].map(()=>({blockHash:f.blockHash!,address:addr,topics:[],data:"0x"}));},async send(){throw Error("unexpected trace");}};
  const read=(n:number,base:number)=>readBlockTouchedStateKeys(provider as any,n,addr,anchor(n),{
    previousSource:{number:base,hash:h(base)},readHeader:async i=>anchor(i)},resolver,{mode:"logs"});
  const sum=(a:number,b:number,m="logs")=>j.summary({number:a,hash:h(a)},{number:b,hash:h(b)},m);
  breakAt=12;await assert.rejects(read(12,10),/aborted/);assert.equal(sum(10,12).coverage,"unavailable");
  const keys=await read(12,10);assert.deepEqual([...keys].sort(),["a","b","c",addr].sort());const oldCalls=calls;
  const expected={coverage:"complete_observed_input",observedBlocks:2,directPools:1,directPublicLegs:2,fallbackManagers:1,fallbackPublicLegs:2,directFallbackOverlapLegs:1};
  assert.deepEqual(sum(10,12),expected);
  assert.deepEqual(await read(12,10),keys);assert.equal(calls,oldCalls);assert.deepEqual(sum(10,12),expected);
  assert.equal(j.summary({number:10,hash:h(999)},{number:12,hash:h(12)},"logs").coverage,"unavailable");
  assert.equal(sum(10,12,"trace").coverage,"unavailable");
  await readBlockTouchedStateKeys(provider as any,13,addr,{...anchor(13),passiveTouchedAddresses:undefined},undefined,resolver,{mode:"logs"});
  assert.equal(sum(12,13).coverage,"unavailable");
  const fork=j.begin(11,h(211),h(10),"logs");fork.hit({...hit,directPools:[{poolAddress:addr,poolId:"B"}],directLegIds:["z"],fallbackLegIds:[]});fork.seal();
  assert.deepEqual(sum(10,12),expected,"side fork must not contaminate hash chain");
  assert.equal(sum(10,268).coverage,"unavailable");
});
test("partition prior quoted rows on surviving IDs without calling reverted/deleted prices carried",()=>{
  const make=(status:string,old=false)=>({status,old});
  const prior=new Map(["a","b","c","deleted"].map(k=>[k,make("quoted")] as const));
  const current=new Map([["a",make("quoted",true)],["b",make("quoted")],["c",make("reverted")],["d",make("quoted")]]);
  assert.deepEqual(priceCarryOutcomes(current,prior,r=>r.old),{carried:1,carryOutcomes:{
    priorBasePresent:true,priorQuotedInCurrentGraph:3,priorQuotedRetained:1,priorQuotedAtCurrentSource:1,priorQuotedNowUnpriced:1}});
  assert.equal(priceCarryOutcomes(current,undefined,r=>r.old).carryOutcomes.priorBasePresent,false);
});

for (const stage of ["begin", "hit", "seal"] as const) {
  test(`counter ${stage} failure loses only telemetry, never activity or its cache`, async () => {
    const completeHit = {directPools:[{poolAddress:addr}],directLegIds:["a"],fallbackLegIds:[],fallbackManagers:[]};
    let failedCalls=0, logCalls=0;
    const fault=():never=>{failedCalls++;throw Error("counter "+stage);};
    class FaultyCounts extends PoolTouchCounts {
      override begin(...args: Parameters<PoolTouchCounts["begin"]>) {
        const ticket=super.begin(...args);
        if(stage==="begin")fault();
        return {hit:(h:PhysicalHit)=>{ticket.hit(h);if(stage==="hit")fault();},
          seal:(complete=true)=>{ticket.seal(complete);if(stage==="seal")fault();}};
      }
    }
    const j=new FaultyCounts(), seed=PoolTouchCounts.prototype.begin.call(j,11,h(11),h(10),"logs");
    seed.hit(completeHit);seed.seal(); // a failed reread must not leave stale partial evidence
    const resolver:BlockTouchedStateKeyResolver=Object.assign(((_o,_b,hit)=>{hit?.(completeHit);return ["business"];}) as BlockTouchedStateKeyResolver,
      {poolTouchCounts:()=>j,passiveStateKeys:()=>["passive"]});
    const provider={async getLogs(){logCalls++;return [0,1].map(()=>({blockHash:h(11),address:addr,topics:[],data:"0x"}));}};
    const read=()=>readBlockTouchedStateKeys(provider as any,11,addr,anchor(11),{previousSource:{number:10,hash:h(10)},
      readHeader:async()=>{throw Error("unexpected header");}},resolver,{mode:"logs"});
    const expected=["business","passive",addr].sort();
    assert.deepEqual([...(await read())].sort(),expected);
    assert.deepEqual([...(await read())].sort(),expected);
    assert.equal(failedCalls,1);assert.equal(logCalls,1);
    assert.equal(j.summary({number:10,hash:h(10)},{number:11,hash:h(11)},"logs").coverage,"unavailable");
  });
}

test("actual Family resolver exceptions are not swallowed by optional instrumentation",async()=>{
  const j=new PoolTouchCounts(), real=Error("actual resolver failure");
  const resolver=Object.assign((()=>{throw real;}) as BlockTouchedStateKeyResolver,{poolTouchCounts:()=>j});
  const provider={async getLogs(){return [{blockHash:h(11),address:addr,topics:[],data:"0x"}];}};
  await assert.rejects(readBlockTouchedStateKeys(provider as any,11,addr,anchor(11),undefined,resolver,{mode:"logs"}),e=>e===real);
  assert.equal(j.summary({number:10,hash:h(10)},{number:11,hash:h(11)},"logs").coverage,"unavailable");
});

test("effective telemetry failure in field assembly, JSON encoding or output cannot fail publication",()=>{
  const lines:string[]=[],capture=(line:string)=>lines.push(line),fault=()=>{throw Error("observer")};
  const effective=Object.freeze({source:{number:11},row:"unchanged"});
  const publish=(build:()=>unknown,write:(line:string)=>void)=>{reportOptionalEffectiveCounts(build,write);return effective;};
  assert.equal(publish(()=>({source:11}),capture),effective);
  assert.equal(publish(fault,capture),effective);assert.equal(publish(()=>({bad:1n}),capture),effective);
  assert.equal(publish(()=>({source:11}),fault),effective);
  assert.deepEqual(lines,['[searcher/effective-mid] {"source":11}']);
});
