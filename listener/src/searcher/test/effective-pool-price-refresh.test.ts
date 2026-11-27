import assert from 'node:assert/strict';import test from 'node:test';
import {ADDR} from '../../shared/constants/addresses.js';
import {buildEffectiveMids,effectiveAmountReferences,effectiveHistoricalRankingHint,effectiveRowAmountReference,effectiveRowExecutionVerified,
 bindVerifiedSqlNativePoolRestore,withEffectiveRowColumns,exportEffectiveMidReplayState,restoreEffectiveMidReplayState,type EffectiveMidSnapshot,type EffectivePricingInput} from '../blockscan-effective-mid.js';
import {createBlockScanStartupExecutionPreflight} from '../blockscan-startup-execution-preflight.js';
import {BlockScanSimRejectCache} from '../blockscan-sim-reject-cache.js';import type {TokenEdge} from '../planner/token-graph.js';
import {assertSqlSelectorSamplePrices} from '../sql-selector-startup-check.js';
import type {StrictProductionRuntimeSession} from '../strict-production-runtime-session.js';import type {StartupNodeInvocation,StartupNodeSimulation} from '../blockscan-startup-node-simulation.js';
const w=ADDR.WETH.toLowerCase(),edge=(id:string,tokenIn:string,tokenOut:string):TokenEdge=>Object.freeze({canonicalEdgeId:id as TokenEdge['canonicalEdgeId'],instanceKey:id,
  tokenIn,tokenOut,target:id,adapterId:'fixture',slotKind:'swap',edgeKind:'swap',leavesStandingPosition:false,executionVerification:'startup-simulation'});
const h1=edge('fund-A',w,'x'),h2=edge('fund-B',w,'x'),t=edge('market','x','y'),remote=edge('orphan','no-source','suffix');
const graph=Object.freeze([h1,h2,t,remote]),ids=(e:TokenEdge)=>String(e.canonicalEdgeId);
function harness(fault?:(programs:string[],number:number)=>number|undefined,codes?:ReadonlyMap<string,string>){const calls:string[]=[],ss:string[][]=[];let omit=false;
 const sim=Object.assign(async(q:StartupNodeInvocation)=>{const programs=q.legs.map(z=>z.program);ss.push(programs);let amt=q.amount;
   const hop=q.source.number>100?fault?.(programs,q.source.number):undefined;
   if(hop!==undefined)return {kind:'revert' as const,failure:{hop,reason:'0x'},receipts:[],returnData:'0x',gasUsed:1n,targetBlock:q.source.number+1,
     scriptHash:`0x${'4'.repeat(64)}`,inputFundingMode:'native-prefix' as const,simulationMs:1,nodeQueueMs:0};
   const receipts=[{hop:-1,amountIn:amt,amountSpent:amt,amountOut:amt}];
   q.legs.forEach((leg,i)=>{const n=amt*(leg.program==='0x01'?(q.source.number===100?3n:5n):2n);receipts.push({hop:i,amountIn:amt,amountSpent:amt,amountOut:n});amt=n;});
   return {kind:'success' as const,receipts,returnData:'0x',gasUsed:1n,targetBlock:q.source.number+1,scriptHash:`0x${'4'.repeat(64)}`,inputFundingMode:'native-prefix' as const,simulationMs:1,nodeQueueMs:0};
 },{stats:()=>({requests:ss.length,retries:0,simulations:ss.length,headers:1,maxCuIn1000Ms:1})}) as StartupNodeSimulation;
 const pre=createBlockScanStartupExecutionPreflight({executor:`0x${'1'.repeat(40)}`,transactionOrigin:`0x${'2'.repeat(40)}`,simRejects:new BlockScanSimRejectCache(),concurrency:1,simulateStandalone:sim});
 const sessionFor=()=>({executionVariantIds:(e:TokenEdge)=>['v'+ids(e)],confirmExecutionVariant(){},buildRuntimeAmountLeg:({edge:e}:{edge:TokenEdge})=>({program:codes?.get(ids(e))??(e===h1?'0x01':e===h2?'0x02':'0x03')})}) as unknown as StrictProductionRuntimeSession;
 const opt=(n:number,prev?:EffectiveMidSnapshot,choose?:string[],disabled:string[]=[],cascade=false,edges:readonly TokenEdge[]=graph,
   requireFreshEdgeIds?:ReadonlySet<string>,touchedStateKeys:ReadonlySet<string>=new Set(edges.map(ids)))=>{
 const at={number:n,hash:`0x${n.toString(16).padStart(64,'0')}`,generation:n-99},pricing:EffectivePricingInput={sourceBlock:n,sourceBlockHash:at.hash,generation:at.generation,
  graph:{edges},mids:new Map(),coverage:{resolvedEdgeKeys:[]},pricingStateKeyByEdgeKey:new Map(edges.map(e=>[ids(e),ids(e)]))};
 return buildEffectiveMids({pricing,previous:prev,touchedStateKeys:prev?touchedStateKeys:undefined,cascadeAmountChanges:cascade,requireFreshEdgeIds,
 ...(choose?{poolPriceRefreshPlan:{shouldRefresh:(e,variant)=>{if(n===101&&e!==remote)assert.equal(variant,'v'+ids(e));return choose.includes(ids(e));}}}:{}),
 weth:w,fixedWethInput:100n,maxInputPathHops:4,gasCostWei:null,enumerationSpreadBps:0,concurrency:1,control:{},disabledEdgeIds:new Set(disabled),
 quote:async q=>{calls.push(ids(q.edge));const r=await pre.quoteEffective({...q,edges,prepareQuote:async()=>{},sessionFor});assert(r);return omit?{...r,inputReference:undefined}:r;}});};
 return {calls,ss,build:opt,omit:()=>{omit=true;}};}
test('one pool decision: broad touched keys cannot dispatch clean legs, paid hints retain their original identity over multiple blocks',async()=>{
 const h=harness(),a=await h.build(100);h.calls.length=0;const b=await h.build(101,a,[]),c=await h.build(102,b,[]);
 assert.deepEqual(h.calls,[]);for(const e of [h1,h2,t]){const hint=effectiveHistoricalRankingHint(c,e)!;assert.equal(hint,effectiveHistoricalRankingHint(b,e));assert.equal(hint.quotedAt.number,100);
 assert.equal(hint.receiptHash,a.rows.get(ids(e))!.executionVerification!.receiptHash);assert.equal(c.rows.get(ids(e))!.amountOut,null);assert(!effectiveRowExecutionVerified(c,a.rows.get(ids(e))!,e));}
 assert.equal(effectiveHistoricalRankingHint(c,remote),undefined);assert(!effectiveAmountReferences(c)?.has('x'));
 const d=await h.build(103,c,['market','orphan']);assert.deepEqual(h.calls,['market']);assert.equal(d.rows.get('orphan')!.status,'missing-valuation');
 const r=d.rows.get('market')!,ref=effectiveRowAmountReference(r)!;assert.equal(r.amountIn,500n);assert.equal(r.amountOut,1000n);assert.equal(ref.path[0]!.quotedAt!.number,103);assert(effectiveRowExecutionVerified(d,r,t));
 assert.deepEqual(h.ss.at(-1),['0x01','0x03']);assert.equal(d.rows.get('fund-A')!.status,'missing-valuation');
});
test('disabled original prefix uses another genuinely paid route; missing refreshed prefix receipts cannot mint price',async()=>{
 const h=harness(),a=await h.build(100);h.calls.length=0;const b=await h.build(101,a,['market'],['fund-A']);assert.deepEqual(h.calls,['market']);assert.deepEqual(h.ss.at(-1),['0x02','0x03']);
 assert.equal(b.rows.get('market')!.amountIn,200n);assert.equal(b.rows.get('fund-A')!.status,'disabled-for-run');
 h.omit();const c=await h.build(102,b,['market'],['fund-A']);assert.equal(c.rows.get('market')!.status,'quote-failed');assert(!effectiveRowExecutionVerified(c,c.rows.get('market')!,t));
});
test('cold, raw restore, foreign graph and cascade retain generic behavior; newly enabled funding can be found by normal forward pass',async()=>{
 const h=harness(),a=await h.build(100,undefined,[],['fund-A','fund-B']);assert.equal(a.rows.get('market')!.status,'missing-valuation');h.calls.length=0;
 const b=await h.build(102,a,['fund-A','market']);assert.deepEqual(h.calls,['fund-A','market']);assert(effectiveRowExecutionVerified(b,b.rows.get('market')!,t));
 const f=await h.build(104),clone=structuredClone(f);restoreEffectiveMidReplayState(clone,structuredClone(exportEffectiveMidReplayState(f)!),graph,w);
 for(const [prev,cascade,edges]of [[clone,false,graph],[f,true,graph],[f,false,Object.freeze(graph.map(e=>Object.freeze({...e})))]] as const){h.calls.length=0;
 const n=await h.build(105,prev,[],[],cascade,edges);assert(h.calls.includes('market'));assert(!effectiveHistoricalRankingHint(n,edges[2]!));}
});

const owns=(e:TokenEdge,v:string)=>v==='v'+ids(e);
test('first resumed sample replay: only the chosen untouched leg and its embedded prefix, then normal reuse',async()=>{
 for(const plan of [true,false]){
  const h=harness(),prior=await h.build(100),disk=structuredClone(prior);
  restoreEffectiveMidReplayState(disk,structuredClone(exportEffectiveMidReplayState(prior)),graph,w);
  if(plan)assert.equal(bindVerifiedSqlNativePoolRestore(disk,graph,disk.source,owns),3);
  h.calls.length=0;h.ss.length=0;
  const sample={selector:'0x12345678',edgeId:ids(t),poolAddress:t.target,poolId:null,tokenIn:t.tokenIn,tokenOut:t.tokenOut,variantIds:['v'+ids(t)]};
  const now=await h.build(101,disk,plan?[]:undefined,[],false,graph,new Set([ids(t)]),new Set());
  assert.deepEqual(h.calls,[ids(t)]);assert.deepEqual(h.ss,[['0x01','0x03']]);
  assert.equal(now.rows.get(ids(t))!.amountIn,500n);assertSqlSelectorSamplePrices([sample],now,graph);
  h.calls.length=0;await h.build(102,now,plan?[]:undefined,[],false,graph,undefined,new Set());
  assert.deepEqual(h.calls,[]);
 }
});
test('verified A-prefix failure tries an existing B-prefix for the same touched target, never A/B as standalone quotes',async()=>{
 const h=harness(programs=>programs[0]==='0x01'?0:undefined),p=await h.build(100);h.calls.length=0;h.ss.length=0;
 const n=await h.build(101,p,['market']);assert.deepEqual(h.calls,['market','market']);assert.deepEqual(h.ss,[['0x01','0x03'],['0x02','0x03']]);
 const r=n.rows.get('market')!;assert.equal(r.amountIn,200n);assert.equal(effectiveRowAmountReference(r)!.path[0]!.edgeId,ids(h2));
 assert(effectiveRowExecutionVerified(n,r,t));assert(effectiveHistoricalRankingHint(n,h1));assert(effectiveHistoricalRankingHint(n,h2));
});
test('target revert never tries B; exhausted proven prefix failures have no target budget/revert exclusion',async()=>{
 const target=harness(p=>p.length-1),a=await target.build(100);target.ss.length=0;const b=await target.build(101,a,['market']);
 assert.deepEqual(target.ss,[['0x01','0x03']]);assert.equal(b.rows.get('market')!.status,'quote-failed');assert.equal(b.rows.get('market')!.failureEvidence,'evm-revert-observed');
 const none=harness(()=>0),c=await none.build(100);none.ss.length=0;const d=await none.build(101,c,['market']);
 assert.deepEqual(none.ss,[['0x01','0x03'],['0x02','0x03']]);const r=d.rows.get('market')!;
 assert.equal(r.status,'missing-valuation');assert.equal(r.amountIn,null);assert.equal(r.failureEvidence,undefined);assert.equal(effectiveRowAmountReference(r),undefined);
});
test('a generic error with copied prefix labels is not a source-owned failure and cannot authorize trying B',async()=>{
 const h=harness(()=>{throw Object.assign(new Error('fixture unavailable'),{code:'STARTUP_EXECUTION_REVERT',failureStage:'prefix',failedHop:0,targetAttempted:false,failedEdgeId:ids(h1)});});
 const p=await h.build(100);h.ss.length=0;const n=await h.build(101,p,['market']);assert.deepEqual(h.ss,[['0x01','0x03']]);assert.equal(n.rows.get('market')!.status,'quote-failed');
});
test('skip sibling paid plans sharing exactly the failed first hop; do not search or re-quote unrelated pools',async()=>{
 const c=edge('C',w,'y'),p1=edge('P1','x','z'),p2=edge('P2','x','z'),q=edge('Q','y','z'),target=edge('T','z','end');
 const es=Object.freeze([h1,c,p1,p2,q,target]),codes=new Map([[ids(c),'0x02'],['P1','0x11'],['P2','0x12'],['Q','0x13'],['T','0x14']]);
 const h=harness(p=>p[0]==='0x01'?0:undefined,codes),a=await h.build(100,undefined,undefined,[],false,es);h.ss.length=0;
 const n=await h.build(101,a,['T'],[],false,es);assert.equal(h.ss.length,2);assert.equal(h.ss[0]![0],'0x01');assert.deepEqual(h.ss[1],['0x02','0x13','0x14']);
 assert(effectiveRowExecutionVerified(n,n.rows.get('T')!,target));
});
test('a failure at E reached through A is not evidence against E reached through B with different actual funds',async()=>{
 const e=edge('E','x','z'),target=edge('T','z','end'),es=Object.freeze([h1,h2,e,target]),codes=new Map([['E','0x11'],['T','0x14']]);
 const h=harness((p,n)=>p[0]==='0x01'?(n===101?0:1):undefined,codes);
 const a=await h.build(100,undefined,undefined,[],false,es),b=await h.build(101,a,['E'],[],false,es);
 assert.deepEqual(effectiveRowAmountReference(b.rows.get('E')!)?.path.map(s=>s.edgeId),[ids(h2)]);h.ss.length=0;
 const n=await h.build(102,b,['T'],[],false,es);assert.deepEqual(h.ss,[['0x01','0x11','0x14'],['0x02','0x11','0x14']]);
 assert.equal(n.rows.get('T')!.amountIn,400n);assert(effectiveRowExecutionVerified(n,n.rows.get('T')!,target));
});
test('only explicit post-anchor SQL native read supplies first pool plan; old private path is simulated again with actual changed input',async()=>{
 const h=harness(),live=await h.build(100),state=structuredClone(exportEffectiveMidReplayState(live)),disk=structuredClone(live);
 assert.throws(()=>bindVerifiedSqlNativePoolRestore(disk,graph,live.source,owns));
 restoreEffectiveMidReplayState(disk,state,graph,w);
 assert.throws(()=>bindVerifiedSqlNativePoolRestore(disk,graph,{...disk.source,hash:'0x'+'f'.repeat(64)},owns));
 assert.throws(()=>bindVerifiedSqlNativePoolRestore(disk,Object.freeze([...graph]),disk.source,owns));
 assert.equal(bindVerifiedSqlNativePoolRestore(disk,graph,disk.source,owns),3);
 assert.throws(()=>bindVerifiedSqlNativePoolRestore(disk,graph,disk.source,owns));
 assert.equal(effectiveHistoricalRankingHint(disk,h1),undefined,'do not manufacture prior ranking entries at restore');
 const prior=withEffectiveRowColumns(disk,new Map([['fund-A',{} as never]]));assert.notEqual(prior,disk);
 h.calls.length=0;const now=await h.build(101,prior,['market']);assert.deepEqual(h.calls,['market']);
 const r=now.rows.get('market')!;assert.equal(prior.rows.get('market')!.amountIn,300n);assert.equal(r.amountIn,500n);assert.equal(r.amountOut,1000n);
 assert.equal(effectiveRowAmountReference(r)?.path[0]?.quotedAt?.number,101);
 assert.equal(effectiveRowExecutionVerified(now,r,t),true);assert.equal(effectiveRowExecutionVerified(now,prior.rows.get('fund-A')!,h1),false);
 const hA=effectiveHistoricalRankingHint(now,h1)!;assert.equal(hA.receiptHash,disk.rows.get('fund-A')!.executionVerification!.receiptHash);
 assert.equal(hA.quotedAt.number,100);assert.equal(effectiveHistoricalRankingHint(now,remote),undefined);
});
test('unowned variant in target OR prefix is not promoted; generic restore, reorg-ish graph replacement, and unanchored replay do not acquire native privilege',async()=>{
 const h=harness(),p=await h.build(100),archive=structuredClone(exportEffectiveMidReplayState(p)),s=structuredClone(p);
 restoreEffectiveMidReplayState(s,archive,graph,w);
 assert.equal(bindVerifiedSqlNativePoolRestore(s,graph,s.source,(e,v)=>e!==h1&&owns(e,v)),1);
 h.calls.length=0;const n=await h.build(102,s,[]);assert.deepEqual(h.calls,[]);
 assert(effectiveHistoricalRankingHint(n,h2));assert(!effectiveHistoricalRankingHint(n,h1));assert(!effectiveHistoricalRankingHint(n,t));assert(!effectiveHistoricalRankingHint(n,remote));
 restoreEffectiveMidReplayState(s,archive,graph,w);h.calls.length=0;const raw=await h.build(103,s,[]);assert(h.calls.includes('market'));assert(!effectiveHistoricalRankingHint(raw,h2));
 const unanchored=structuredClone(p),{source:_source,...legacy}=archive;
 restoreEffectiveMidReplayState(unanchored,legacy,graph,w);assert.throws(()=>bindVerifiedSqlNativePoolRestore(unanchored,graph,p.source,owns));
});
test('multi-block pool-plan demotions retain verified poolOrigins across export/restore while dropping dirtyUnfunded origins',async()=>{
 const h=harness(),b100=await h.build(100),b101=await h.build(101,b100,[]),b102=await h.build(102,b101,['market','orphan']);
 assert.equal(b102.rows.get('fund-A')!.status,'missing-valuation');assert.equal(b102.rows.get('fund-B')!.status,'missing-valuation');assert.equal(b102.rows.get('market')!.status,'quoted');
 const state=structuredClone(exportEffectiveMidReplayState(b102)),disk=structuredClone(b102);
 assert.equal(state.poolOrigins?.length,2);
 restoreEffectiveMidReplayState(disk,state,graph,w);
 assert.equal(bindVerifiedSqlNativePoolRestore(disk,graph,disk.source,owns),3);
 h.calls.length=0;const b103=await h.build(103,disk,[]);assert.deepEqual(h.calls,[]);
 assert.equal(effectiveHistoricalRankingHint(b103,h1)?.quotedAt.number,100);
 assert.equal(effectiveHistoricalRankingHint(b103,h2)?.quotedAt.number,100);
 assert.equal(effectiveHistoricalRankingHint(b103,t)?.quotedAt.number,102);
 h.calls.length=0;const b104=await h.build(104,b103,['market']);assert.deepEqual(h.calls,['market']);
 assert.equal(b104.rows.get('market')!.amountIn,500n);
});
