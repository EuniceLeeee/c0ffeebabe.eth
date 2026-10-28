import assert from 'node:assert/strict';
import {applyStartupTargetFilters} from '../blockscan-startup-table-cli.js';
import {BlockScanSimRejectCache} from '../blockscan-sim-reject-cache.js';
import {blockScanEdgeKey} from '../venues/blockscan-state-capability.js';
import {edgeInstanceKey} from '../venues/route-instance-identity.js';
import type {TokenEdge} from '../planner/token-graph.js';
const edge:TokenEdge={target:'0x'+'11'.repeat(20),tokenIn:'0x'+'22'.repeat(20),tokenOut:'0x'+'33'.repeat(20),
  adapterId:'test',instanceKey:'test-instance',slotKind:'swap',edgeKind:'swap',leavesStandingPosition:false};
const row={status:'revert',failureStage:'target',targetAttempted:true,edgeId:blockScanEdgeKey(edge),
  instanceKey:edgeInstanceKey(edge),failedEdgeId:blockScanEdgeKey(edge),failedHop:1,prefixEdges:['prefix'],
  expectedAmountIn:'100',gasUsed:'123',revertDataHash:'0x'+'ab'.repeat(32)};
const cache=new BlockScanSimRejectCache(), records:unknown[]=[];
const apply=(rows:Readonly<Record<string,unknown>>[],enabled=true)=>applyStartupTargetFilters({rows,enabled,
  edges:[edge],cache,record:r=>records.push(r)});
assert.equal(apply([row],false),0); assert(!cache.hasPool(edge));
for(const fields of [{status:'success'},{failureStage:'prefix'},{failureStage:'funding'},
  {failureStage:'unattributed'},{status:'infrastructure-or-cancelled'},{targetAttempted:false}]) {
  assert.equal(apply([{...row,...fields}]),0); assert(!cache.hasPool(edge));
}
assert.throws(()=>apply([{...row,failedEdgeId:'other'}])); assert(!cache.hasPool(edge));
assert.equal(apply([row]),1); assert.equal(apply([row]),0); assert.equal(records.length,1);
assert(cache.hasPool({...edge,tokenIn:edge.tokenOut,tokenOut:edge.tokenIn}));
assert(!cache.hasPool({...edge,instanceKey:'other'}));
assert(!new BlockScanSimRejectCache().hasPool(edge));
cache.clear(); assert(!cache.hasPool(edge));
assert.throws(()=>applyStartupTargetFilters({enabled:true,rows:[row],edges:[edge],cache,
  record:()=>{throw Error('evidence write failed');}})); assert(!cache.hasPool(edge));
console.log('startup-filter-wiring PASS: on/off, target-only, shared cache, evidence-first, run lifetime');
