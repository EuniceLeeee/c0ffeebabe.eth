import assert from "node:assert/strict";
import {test} from "node:test";
import {collectStartupActivity,collectIndexedStartupActivity,StartupActivityCollector} from "../blockscan-startup-catchup.js";
import {physicalRankingScope,readBlockTouchedStateKeys,type BlockTouchedStateKeyResolver} from "../blockscan-touched-state.js";
const hash=(n:number)=>"0x"+n.toString(16).padStart(64,"0");
const h=(n:number)=>({number:n,hash:hash(n),parentHash:hash(n-1),transactionHashes:[],passiveTouchedAddresses:[]});
const resolver=Object.assign((()=>[]) as BlockTouchedStateKeyResolver,{supportsPhysicalRankingScope:()=>true});
const provider={async getLogs(){return [];},async send(){throw Error("unexpected trace");}};
const manager="0x"+"1".repeat(40),base=h(100),target=h(103);
const readHeader=async(n:number)=>h(n);
function parts(){
 const spans:ReadonlySet<string>[]=[];
 const readRange=async(n:number,head:ReturnType<typeof h>,range:{previousSource:{number:number,hash:string}})=>{
   const keys=await readBlockTouchedStateKeys(provider,n,manager,head,{...range,readHeader},resolver,{mode:"logs"});
   spans.push(keys);return keys;
 };
 return {spans,readRange};
}
test("cold first catch-up preserves exactly the verified input used by the ordinary canonical reader",async()=>{
 const {readRange,spans}=parts(), keys=await collectStartupActivity({target,range:{previousSource:base},readHeader,readRange});
 assert.strictEqual(keys,spans[0]);assert(physicalRankingScope(keys,resolver,base,target));
 assert.equal(physicalRankingScope(new Set(keys),resolver,base,target),undefined);
 assert.equal(physicalRankingScope(keys,resolver,h(101),target),undefined);
});
test("a fresh sole checkpoint segment survives the final canonical check; resumed or stitched values are not re-issued",async()=>{
 const {readRange,spans}=parts(),c=new StartupActivityCollector({readHeader,readRange});
 const run=()=>c.collect({target,range:{previousSource:base}});
 const first=await run();assert.strictEqual(first,spans[0]);assert(physicalRankingScope(first,resolver,base,target));
 const replay=await run();assert.notStrictEqual(replay,first);assert.equal(physicalRankingScope(replay,resolver,base,target),undefined);
 const long=h(357), multi=await collectStartupActivity({target:long,range:{previousSource:base},readHeader,readRange});
 assert.equal(physicalRankingScope(multi,resolver,base,long),undefined);
});
test("normalizing an unissued source or adding an indexed prefix cannot confer ranking provenance",async()=>{
 const {readRange}=parts(),range={previousSource:base};
 const custom=new Set(["ExAmPle"]), canon=await collectStartupActivity({target,range,readHeader,readRange:async()=>custom});
 assert.deepEqual([...canon],["example"]);assert.equal(physicalRankingScope(canon,resolver,base,target),undefined);
 const indexed=await collectIndexedStartupActivity({target,range,readHeader,readRange,readCutoff:async()=>101,readIndexed:async()=>new Set(["Indexed"])});
 assert(indexed.has("indexed"));assert.equal(physicalRankingScope(indexed,resolver,base,target),undefined);
});
