import assert from "node:assert/strict";import {test} from "node:test";
import {collectStartupActivity,collectIndexedStartupActivity,StartupActivityCollector,type ActivityRangeControl} from "../blockscan-startup-catchup.js";
import {readBlockTouchedStateKeys,physicalRankingScope,sqlPoolPriceActivityScope,sqlPoolPriceSpanUnion,
  type BlockTouchedStateKeyResolver,type BlockTouchedProvider} from "../blockscan-touched-state.js";
const H=(n:number)=>"0x"+n.toString(16).padStart(64,"0"),A=(n:number)=>"0x"+n.toString(16).padStart(40,"0");
const h=(n:number)=>({number:n,hash:H(n),parentHash:H(n-1),transactionHashes:[],passiveTouchedAddresses:[] as string[]|undefined});
const base=h(100),target=h(1104),manager=A(3),asset=A(4);
function resolver():BlockTouchedStateKeyResolver{return Object.assign(((o,b,_count,hit)=>{
  if(o.kind!=="log")return [];
  if(o.address===manager&&o.topics[0]===H(17)){hit?.(["leg:"+b.number],["pool:"+o.topics[1]]);return ["leg:"+b.number];}
  if(o.address===manager){hit?.(["ambiguous-manager"],[]);return ["ambiguous-manager"];}
  return [];
}) as BlockTouchedStateKeyResolver,{supportsSqlPoolPriceScope:()=>true,supportsPhysicalRankingScope:()=>true});}
function provider(){let reads=0;return {get reads(){return reads;},async getLogs(f:Parameters<BlockTouchedProvider["getLogs"]>[0]){
  assert("blockHash" in f);reads++;const n=Number(BigInt(f.blockHash));const log=(address:string,topics:string[])=>({address,topics,blockHash:f.blockHash,data:"0x"});
  return n===200||n===1104?[log(manager,[H(17),H(n)])]:n===612?[log(manager,[H(19),H(982)])]:n===800?[log(asset,[H(21)])]:[];
},async send(){throw Error("no external I/O");}};}
const rangeReader=(p:ReturnType<typeof provider>,r:BlockTouchedStateKeyResolver)=>(n:number,head:ReturnType<typeof h>,ctl:ActivityRangeControl)=>
  readBlockTouchedStateKeys(p,n,manager,head,{...ctl,readHeader:async i=>h(i)},r,{mode:"logs"});
const packet=(k:ReadonlySet<string>,r:BlockTouchedStateKeyResolver,end=target)=>sqlPoolPriceActivityScope(k,r,base,end);
test("1004 complete RPC transitions: only observed physical pools dirty, wide unknown is separate, raw Exact keys preserved; no rank or receipt issued",async()=>{
 const p=provider(),r=resolver(),spans:number[]=[];
 const keys=await collectStartupActivity({target,range:{previousSource:base},readHeader:async n=>h(n),readRange:(n,t,c)=>{spans.push(n);return rangeReader(p,r)(n,t,c);}});
 assert.deepEqual(spans,[356,612,868,1104]);assert.equal(p.reads,1004);
 const s=packet(keys,r)!;assert(s);assert(s.touchedPoolKey("pool:"+H(200))&&s.touchedPoolKey("pool:"+H(1104))&&!s.touchedPoolKey("pool:"+H(982)));
 assert(s.poolDirty("ambiguous-manager"));assert(keys.has(H(982))&&keys.has(asset)&&keys.has("ambiguous-manager"));
 assert(!physicalRankingScope(keys,r,base,target));assert(!packet(new Set(keys),r));assert(!packet(keys,resolver()));
 assert(!sqlPoolPriceActivityScope(keys,r,{...base,hash:H(99)},target));assert(!packet(keys,r,{...target,hash:H(5)}));
});
test("failure after 256 then restart from canonical cursor; same target replay and further extension keep earlier pool facts immutable",async()=>{
 const p=provider(),r=resolver(),chunks:number[]=[],checks:number[]=[];let abort=true;
 const collector=new StartupActivityCollector({readHeader:async n=>{checks.push(n);return h(n);},readRange:(n,t,c)=>{
   chunks.push(n);if(n===612&&abort){abort=false;throw Error("temporary range failure");}return rangeReader(p,r)(n,t,c);}});
 const at=(n:number)=>collector.collect({target:h(n),range:{previousSource:base}});
 await assert.rejects(at(868),/temporary/);assert.deepEqual(chunks,[356,612]);const k=await at(868),s=packet(k,r,h(868))!;
 assert(s.touchedPoolKey("pool:"+H(200)));assert(!s.touchedPoolKey("pool:"+H(1104)));assert.deepEqual(chunks,[356,612,612,868]);assert(checks.includes(100)&&checks.includes(356));
 const replay=await at(868);assert(packet(replay,r,h(868)));assert.equal(chunks.length,4);const ext=await at(1104);assert(packet(ext,r)!.touchedPoolKey("pool:"+H(1104)));
 assert(!s.touchedPoolKey("pool:"+H(1104)));assert(!physicalRankingScope(ext,r,base,target));assert.equal(p.reads,1004);
});
test("copied or mutated key set, missing passive coverage, different reader or resolver, not contiguously chained: leave unscoped",async()=>{
 for(const fault of ["copy","mutate","missing","provider","resolver"] as const){
   const p=provider(),r=resolver();const keys=await collectStartupActivity({target:h(357),range:{previousSource:base},readHeader:async n=>h(n),readRange:async(n,t,c)=>{
     const original=await rangeReader(n===357&&fault==="provider"?provider():p,n===357&&fault==="resolver"?resolver():r)(n,
       n===357&&fault==="missing"?{...t,passiveTouchedAddresses:undefined}:t,c);
     if(n===356&&fault==="mutate")(original as Set<string>).clear();
     return n===356&&fault==="copy"?new Set(original):original;}});
   assert(!packet(keys,r,h(357)),fault);
 }
 const p=provider(),r=resolver(),rr=rangeReader(p,r),a=await rr(356,h(356),{previousSource:base,captureSqlPoolSpan:true}),b=await rr(357,h(357),{previousSource:h(356),captureSqlPoolSpan:true});
 for(const f of [
   (x:ReturnType<typeof sqlPoolPriceSpanUnion>)=>{x.append(b,h(356),h(357));x.append(a,base,h(356));},
   (x:ReturnType<typeof sqlPoolPriceSpanUnion>)=>{x.append(a,base,h(356));x.append(b,{...h(356),hash:H(5000)},h(357));},
   (x:ReturnType<typeof sqlPoolPriceSpanUnion>)=>{x.append(a,base,h(356));x.append(a,base,h(356));},
 ]){const u=sqlPoolPriceSpanUnion(base);f(u);assert(!u.finish(h(357)));}
 const clean=sqlPoolPriceSpanUnion(base);clean.append(a,base,h(356));clean.append(b,h(356),h(357));const out=clean.finish(h(357))!;assert(packet(out,r,h(357)));
 await rangeReader(p,resolver())(358,h(358),{previousSource:h(357),captureSqlPoolSpan:true});assert(!clean.finish(h(357)));assert(!packet(out,r,h(357)));
});
test("checkpoint canonical check and indexed prefix cannot issue SQL pool facts",async()=>{
 const p=provider(),r=resolver();let swapped=false;
 const collector=new StartupActivityCollector({readHeader:async n=>swapped&&n===356?{...h(n),hash:H(9999)}:h(n),readRange:rangeReader(p,r)});
 const first=await collector.collect({target:h(356),range:{previousSource:base}});assert(packet(first,r,h(356)));swapped=true;
 await assert.rejects(collector.collect({target,range:{previousSource:base}}),/canonical anchor mismatch/);
 const indexed=await collectIndexedStartupActivity({target:h(615),range:{previousSource:base},readHeader:async n=>h(n),readRange:rangeReader(p,r),readCutoff:async()=>102,readIndexed:async()=>new Set(["index-only"])});
 assert(indexed.has("index-only"));assert(!packet(indexed,r,h(615)));
});
