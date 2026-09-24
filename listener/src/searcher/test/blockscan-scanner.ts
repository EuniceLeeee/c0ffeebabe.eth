/** Explicit synthetic effective amounts; calls the LIVE scanner kernel.
 * No protocol math, warm-mid fallback, RPC or alternate search implementation. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { ADDR } from "../../shared/constants/addresses.js";
import { cycleFingerprint } from "../detector/cycle-fingerprint.js";
import { scanBlockStateFromResolvedMids as scan, diagnoseResolvedRingScore,
  estimateResolvedRingSpreadBps, type BlockScanCoreConfig, type ResolvedBlockScanMid,
} from "../detector/blockscan-scanner-core.js";
import { buildBlockScanUsdView } from "../blockscan-usd-view.js";
import { type TokenEdge, v4PoolId } from "../planner/token-graph.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
const WETH=ADDR.WETH.toLowerCase(),USDC=ADDR.USDC.toLowerCase(),P=10n**18n,BLOCK=100;
const address=(n:number)=>"0x"+n.toString(16).padStart(40,"0");
type Input=Parameters<typeof scan>[0];
function edge(from:string,to:string,id:number,kind:"swap"|"protocol"|"lend"="swap"):TokenEdge {
  return {adapterId:"fixture-"+kind,target:address(id),tokenIn:from,tokenOut:to,slotKind:kind,
    ...(kind==="protocol"?{protocolAction:"convert" as const}:{}),
    ...deriveEdgeTaxonomy(kind,kind==="protocol"?"convert":undefined)};
}
function quote(e:TokenEdge,n=100n,d=100n):ResolvedBlockScanMid {
  return {kind:"fixture",pool:e.target,edges:[e],mid:Number(n)/Number(d),feeBps:0,
    quoteAmountIn:d*P/100n,quoteAmountOut:n*P/100n,depthProxy:0};
}
function input(edges:TokenEdge[],amounts:readonly bigint[]=[],overrides:Partial<BlockScanCoreConfig>={}):Input {
  return {edges,sourceBlock:BLOCK,swapTouched:null,captureCoarseEnumeration:true,
    mids:new Map(edges.map((e,i)=>[blockScanEdgeKey(e),quote(e,amounts[i]??100n)])),
    cfg:{maxHops:Math.min(6,edges.length),minSpreadBps:10,maxCandidates:100,budgetMs:10_000,
      // Legacy coverage fixtures keep all pools; Top-N is tested independently below.
      hopQuotesPerPair:0,pricedTokens:new Map([[WETH,{maxBorrow:1000n*P}]]),...overrides}};
}
const ring=(tokens:string[],id=100)=>tokens.slice(0,-1).map((t,i)=>edge(t,tokens[i+1]!,id+i));
const anchor=()=>input(ring([WETH,USDC,WETH]),[100n,110n]);
const hasRoute=(result:ReturnType<typeof scan>,route:TokenEdge[])=>result.opportunities.some(o=>
  o.seedEdges.length===route.length&&o.seedEdges.every((e,i)=>blockScanEdgeKey(e)===blockScanEdgeKey(route[i]!)));

test("live scanner applies independent per-direction Top-N to seed and intermediate pools",()=>{
  const token=address(901);
  const edges=[edge(WETH,token,301),edge(WETH,token,302),edge(token,USDC,303),
    edge(token,USDC,304),edge(USDC,WETH,305),edge(USDC,WETH,306)];
  const data=input(edges,[120n,110n,120n,110n,120n,110n],{
    maxHops:3,minSpreadBps:0,usdSignalPairsPerToken:100,prefixPruningEnabled:false,
    allowRepeatedPools:false,maxCandidates:1000,
  });
  const best=[edges[0]!,edges[2]!,edges[4]!];
  for(const enumerationMethod of ["joint-dfs","dfs","layered"] as const) {
    const run=(hopQuotesPerPair:number|undefined)=>scan({...data,
      cfg:{...data.cfg,enumerationMethod,hopQuotesPerPair}});
    const one=run(1),two=run(2),all=run(0);
    assert.equal(one.outcome,"ran");
    assert.equal(one.selection.enumeratedCount,1);
    assert(hasRoute(one,best));
    assert.equal(one.enumeration?.hopQuotesSelected,3);
    assert.equal(one.enumeration?.hopQuotesPruned,3);
    assert.equal(two.selection.enumeratedCount,8);
    assert.deepEqual(two.opportunities,all.opportunities);
    assert.deepEqual(run(undefined).opportunities,one.opportunities,"default N=1");
    // A prebuilt full USD view must not bypass the cap or restore a removed seed.
    const view=buildBlockScanUsdView(edges,data.mids,100,false);
    const prebuilt=scan({...data,usdView:view,cfg:{...data.cfg,enumerationMethod,hopQuotesPerPair:1}});
    assert.deepEqual(prebuilt.opportunities,one.opportunities);
    assert.equal(one.opportunities[0]!.searchSeed.searchCenter,P);
    assert(Math.abs(one.opportunities[0]!.coarseSpreadBps!-7280)<1e-8,
      "each edge's effective rate participates in the full compounded return");
  }
});

test("Rust production dispatch stays disabled even for explicit scanner configs",()=>{
  for(const enumerationMethod of ["joint-dfs","dfs","layered"] as const)
    assert.throws(()=>scan({...anchor(),cfg:{...anchor().cfg,enumerationMethod,enumerationBackend:"rust"}}),
      /Rust enumeration is disabled/);
});

test("configured hop caps (4/6/8), with directed USD references",()=>{
  const rings=[2,3,4,5,6,7,8].map(h=>ring([WETH,...Array.from({length:h-1},(_,i)=>address(1000+h*10+i)),WETH],h*100));
  const spokes=rings.flatMap((r,h)=>r.slice(1,-1).map((e,i)=>edge(e.tokenIn,WETH,9000+h*10+i)));
  const data=input([...rings.flat(),...spokes],rings.flatMap(r=>r.map((_,i)=>i===r.length-1?102n:100n)));
  for(const maxHops of [4,6,8]) {
    const result=scan({...data,cfg:{...data.cfg,maxHops,maxCandidates:100_000,usdSignalPairsPerToken:100}});
    assert.equal(result.outcome,"ran");
    for(const r of rings) assert.equal(hasRoute(result,r),r.length<=maxHops,"cap "+maxHops+", ring "+r.length);
    assert(result.opportunities.every(o=>o.seedEdges.length<=maxHops));
  }
});
test("paired signal and whole-cycle floors independently apply; legacy toggle cannot bypass",()=>{
  const data=anchor(),view=buildBlockScanUsdView(data.edges,data.mids);
  assert(view.signals.length>0);
  const run=(signalBps:number,cycleBps:number,requireDislocatedPair=true)=>{
    const mids=new Map(data.mids),last=data.edges[1]!;
    mids.set(blockScanEdgeKey(last),quote(last,BigInt(10_000+cycleBps),10_000n));
    const current=buildBlockScanUsdView(data.edges,mids);
    return scan({...data,mids,cfg:{...data.cfg,minSpreadBps:500,requireDislocatedPair},
      usdView:{...current,signals:current.signals.map(s=>({...s,num:BigInt(10_000+signalBps),den:10_000n}))}});
  };
  assert.equal(run(490,1000).opportunities.length,0);
  assert.equal(run(510,490).opportunities.length,0);
  assert.equal(run(510,510).opportunities.length,1);
  assert.equal(run(490,1000,false).opportunities.length,0);
  assert.equal(scan({...data,usdView:{...view,signals:[]}}).opportunities.length,0);
});
test("effective P/spread ignore stale depth; fees already included in amountOut",()=>{
  const data=anchor(),baseline=scan(data);
  assert.equal(baseline.opportunities.length,1);
  const mids=new Map([...data.mids].map(([k,v])=>[k,{...v,reserveA:1n,reserveB:0n,liquidity:0n,depthProxy:0}]));
  assert.deepEqual(scan({...data,mids}).opportunities,baseline.opportunities);
  assert.equal(baseline.opportunities[0]!.searchSeed.searchCenter,P);
  assert.equal(baseline.opportunities[0]!.searchSeed.maxInput,1000n*P);
  const fees=new Map([...mids].map(([k,v])=>[k,{...v,feeBps:3000}]));
  assert.equal(scan({...data,mids:fees}).opportunities[0]!.coarseSpreadBps,baseline.opportunities[0]!.coarseSpreadBps);
});
test("missing, nonpositive and over-funding P fail closed",()=>{
  for(const p of [undefined,0n,-1n,1001n*P]) {
    const data=anchor(),mids=new Map(data.mids),key=blockScanEdgeKey(data.edges[0]!);
    mids.set(key,{...mids.get(key)!,quoteAmountIn:p,...(p!==undefined&&p>0n?{quoteAmountOut:p}:{})});
    const result=scan({...data,mids});assert.equal(result.opportunities.length,0);
    if(p===1001n*P) assert.equal(result.debug?.capitalRejected,1);
  }
});
test("V4 logical pool IDs remain distinct behind one manager",()=>{
  const a=address(40),keys=[500,3000].map(fee=>({currency0:a,currency1:WETH,fee,tickSpacing:10,hooks:address(0)}));
  const edges=ring([WETH,a,WETH]).map((e,i)=>({...e,target:ADDR.UNISWAP_V4_POOL_MANAGER,
    poolId:v4PoolId(keys[i]!),instanceKey:v4PoolId(keys[i]!),v4PoolKey:keys[i]}));
  const result=scan(input(edges,[100n,110n]));assert.equal(result.opportunities.length,1);
  assert.deepEqual(new Set(result.opportunities[0]!.affectedPools),new Set(keys.map(v4PoolId)));
  assert(!result.opportunities[0]!.affectedPools?.includes(ADDR.UNISWAP_V4_POOL_MANAGER.toLowerCase()));
});
test("nonpositive loops, disabled pool reuse, missing quotes and missing USD valuation reject",()=>{
  for(const output of [100n,99n]) assert.equal(scan(input(anchor().edges,[100n,output])).opportunities.length,0);
  const data=anchor();
  assert.equal(scan(input([data.edges[0]!,{...data.edges[1]!,target:data.edges[0]!.target}],[100n,110n],{allowRepeatedPools:false})).opportunities.length,0);
  const missing=new Map(data.mids);missing.delete(blockScanEdgeKey(data.edges[1]!));
  assert.equal(scan({...data,mids:missing}).opportunities.length,0);
  const isolated=ring([address(71),address(72),address(71)]);
  assert.equal(scan(input(isolated,[100n,110n],{pricedTokens:new Map([[address(71),{maxBorrow:100n*P}]])})).opportunities.length,0);
});
test("touched is telemetry, not a gate on effective USD enumeration",()=>{
  const data=anchor(),baseline=scan(data);
  for(const swapTouched of [new Set([address(999)]),new Set([data.edges[0]!.target])]) {
    const result=scan({...data,swapTouched});assert.deepEqual(result.opportunities,baseline.opportunities);
    assert.equal(result.swapTouchedPools,1);
  }
});
test("pool reuse and rotation dedup are independent, including supplied USD views",()=>{
  const data=anchor(),edges=[data.edges[0]!,{...data.edges[1]!,target:data.edges[0]!.target}];
  for(const enumerationMethod of ["dfs","layered"] as const) {
    for(const allowRepeatedPools of [false,true]) for(const deduplicateRotations of [false,true]) {
      const current=input(edges,[100n,110n],{enumerationMethod,allowRepeatedPools,deduplicateRotations,
        pricedTokens:new Map([[WETH,{maxBorrow:1000n*P}],[USDC,{maxBorrow:1000n*P}]])});
      const result=scan(current);
      assert.equal(result.opportunities.length,allowRepeatedPools?(deduplicateRotations?1:2):0);
      assert.equal(result.enumeration?.allowRepeatedPools,allowRepeatedPools);
      const stale=buildBlockScanUsdView(edges,current.mids,20,!allowRepeatedPools);
      assert.deepEqual(scan({...current,usdView:stale}).opportunities,result.opportunities,
        "a view built with the opposite policy cannot silently override the top-level switch");
    }
    assert.equal(scan(input(edges,[100n,110n],{enumerationMethod})).opportunities.length,1,"default permits reuse");
  }
});
test("funding start, rank, cap, fingerprints and deadline",()=>{
  const data=anchor();
  assert.equal(scan({...data,cfg:{...data.cfg,pricedTokens:new Map()}}).opportunities.length,0);
  const rings=Array.from({length:5},(_,i)=>ring([WETH,address(300+i),WETH],400+i*2));
  const result=scan(input(rings.flat(),rings.flatMap((_,i)=>[100n,104n+BigInt(i)]),{maxCandidates:3,maxHops:2}));
  assert.equal(result.selection.enumeratedCount,5);assert.equal(result.opportunities.length,3);
  assert.deepEqual(result.opportunities.map(o=>o.seedEdges[0]!.tokenOut),[address(304),address(303),address(302)]);
  assert.equal(scan(data).opportunities[0]!.cycleFingerprint,cycleFingerprint(BLOCK,[WETH,USDC]));
  assert.equal(scan({...data,cfg:{...data.cfg,budgetMs:0}}).outcome,"budget_exceeded");
});
test("three-hop positive/negative controls",()=>{
  const edges=ring([WETH,address(500),address(501),WETH]);
  assert(hasRoute(scan(input(edges,[100n,100n,103n])),edges));
  assert(!hasRoute(scan(input(edges,[100n,100n,99n])),edges));
});
test("six-hop low activity route survives dead-end flood",()=>{
  const target=ring([WETH,...[601,602,603,604,605].map(address),WETH],610);
  const decoys=Array.from({length:3000},(_,i)=>({...edge(WETH,address(10_000+i),20_000+i),score:10000}));
  const spokes=target.slice(1,-1).map((e,i)=>edge(e.tokenIn,WETH,700+i));
  const data=input([...decoys,...target,...spokes],[...decoys.map(()=>100n),100n,100n,100n,100n,100n,102n]);
  const result=scan(data);assert.equal(result.outcome,"ran");assert(hasRoute(result,target));
});
test("repeated tokens are admitted with or without protocols and funded intermediates",()=>{
  const a=address(801),b=address(802),c=address(803);
  const repeated=ring([WETH,a,b,a,WETH],810);repeated[1]=edge(a,b,811,"protocol");
  for(const protocol of [true,false]) {
    const route=repeated.map(e=>protocol?e:{...e,slotKind:"swap" as const,protocolAction:undefined,edgeKind:"swap" as const});
    const result=scan(input(route,[102n,102n,102n,102n],{
      pricedTokens:new Map([[WETH,{maxBorrow:1000n*P}],[a,{maxBorrow:1000n*P}]])}));
    assert(hasRoute(result,route));
    assert(result.opportunities.every(o=>o.seedEdges.length<=4));
  }
  const simple=ring([WETH,a,b,c,WETH],820);simple[1]=edge(a,b,821,"protocol");
  assert(hasRoute(scan(input(simple,[102n,102n,102n,102n])),simple));
});
test("identical routes deduplicate; execution-start rotations obey switch",()=>{
  const data=anchor();
  for(const deduplicateRotations of [undefined,false,true]) {
    const result=scan({...data,edges:[...data.edges,...data.edges],cfg:{...data.cfg,deduplicateRotations,
      pricedTokens:new Map([[WETH,{maxBorrow:1000n*P}],[USDC,{maxBorrow:1000n*P}]])}});
    assert.equal(result.opportunities.length,deduplicateRotations?1:2);
    assert.equal(new Set(result.opportunities.map(o=>o.seedEdges.map(blockScanEdgeKey).join(";"))).size,result.opportunities.length);
  }
});
test("Exact admission is independent telemetry, not enumeration erasure",()=>{
  const edges=[...ring([WETH,address(901),WETH],910),...ring([WETH,address(902),WETH],920)];
  const data=input(edges,[],{maxHops:2});
  data.mids=new Map(edges.map((e,i)=>[blockScanEdgeKey(e),quote(e,[10_000n,10_030n,10_000n,10_100n][i]!,10_000n)]));
  const baseline=scan(data),gated=scan({...data,cfg:{...data.cfg,exactAdmissionSpreadBps:50}});
  assert.equal(baseline.selection.enumeratedCount,2);assert.equal(baseline.selection.admittedCount,2);
  assert.equal(gated.selection.admittedCount,1);assert.deepEqual(gated.opportunities,baseline.opportunities);
});
test("legacy minimum-capital setting cannot override effective P",()=>{
  const data=anchor(),a=scan({...data,cfg:{...data.cfg,minCapitalFraction:0}});
  const b=scan({...data,cfg:{...data.cfg,minCapitalFraction:1}});
  assert.deepEqual(a.opportunities,b.opportunities);assert.equal(b.debug?.capitalRejected,0);
});
test("protocol quotes join search; missing quotes cannot be replaced by NAV",()=>{
  const a=address(950),b=address(951),edges=ring([WETH,a,b,WETH],960);
  edges[1]=edge(a,b,961,"protocol");
  const data=input(edges,[100n,105n,100n]);assert(hasRoute(scan(data),edges));
  const mids=new Map(data.mids);mids.delete(blockScanEdgeKey(edges[1]!));
  assert(!hasRoute(scan({...data,mids}),edges));assert(!hasRoute(scan(input(edges,[100n,100n,100n])),edges));
});
test("Credit amount quote required; standing-position label preserved",()=>{
  const a=address(970),data=input([edge(WETH,a,971,"lend"),edge(a,WETH,972)],[110n,100n]);
  const result=scan(data);assert.equal(result.opportunities.length,1);assert.equal(result.opportunities[0]!.leavesStandingPosition,true);
  const mids=new Map(data.mids),key=blockScanEdgeKey(data.edges[0]!);
  mids.set(key,{...mids.get(key)!,quoteAmountIn:undefined,quoteAmountOut:undefined});
  assert.equal(scan({...data,mids}).opportunities.length,0);
});
test("legacy depth diagnostic is not the effective scanner's admission rule",()=>{
  const data=anchor(),mids=new Map([...data.mids].map(([k,v])=>[k,{...v,reserveA:1000n*P,reserveB:1000n*P}]));
  const diagnosis=diagnoseResolvedRingScore(data.edges,mids);
  assert.equal(diagnosis.status,"accepted");assert.equal(diagnosis.estSpreadBps,estimateResolvedRingSpreadBps(data.edges,mids));
  const missing=new Map(mids);missing.delete(blockScanEdgeKey(data.edges[1]!));
  const missingMid=diagnoseResolvedRingScore(data.edges,missing);
  const missingDepth=diagnoseResolvedRingScore(data.edges,data.mids);
  assert(missingMid.status==="rejected");
  assert(missingDepth.status==="rejected");
  assert.equal(missingMid.reason,"missing_mid");
  assert.equal(missingDepth.reason,"missing_or_nonpositive_input_depth");
  assert.equal(scan(data).opportunities.length,1);
});

test("real frozen effective table: simple routes retained alongside repeated-token walks",()=>{
  const saved=JSON.parse(readFileSync(new URL("./fixtures/blockscan-effective-26029875.json",import.meta.url),"utf8")) as {
    sourceBlock:number; rows:{edge:TokenEdge;quote:{amountIn:string;amountOut:string;mid:number}|null}[];
  };
  const edges=saved.rows.map(row=>row.edge),mids=new Map<string,ResolvedBlockScanMid>();
  for(const {edge:e,quote:q} of saved.rows) if(q) mids.set(blockScanEdgeKey(e),{
    kind:"historical-effective",pool:e.target,edges:[e],mid:q.mid,feeBps:0,depthProxy:0,
    quoteAmountIn:BigInt(q.amountIn),quoteAmountOut:BigInt(q.amountOut)});
  const caps=new Map([[WETH,{maxBorrow:2000n*P}],[USDC,{maxBorrow:5_000_000n*10n**6n}],
    [ADDR.USDT.toLowerCase(),{maxBorrow:5_000_000n*10n**6n}],[ADDR.DAI.toLowerCase(),{maxBorrow:5_000_000n*P}]]);
  const targetPools=["0x5f06cfafaa77f98acf24f25b7a6d24af7896e165e2e78045855e432e5245d136",
    "0xedeaae143f233a3a5d4fabd3166afa0e2108fe7741489237274b939ca17fcff8",
    "0x9e4c98a6e67f2ad1ea41e37536e86a22bb445b4a","0xf6e72db5454dd049d0788e411b06cfaf16853042"];
  for(const deduplicateRotations of [true,false]) {
    const result=scan({edges,mids,sourceBlock:saved.sourceBlock,swapTouched:null,
      cfg:{maxHops:6,minSpreadBps:50,exactAdmissionSpreadBps:50,usdSignalPairsPerToken:50,hopQuotesPerPair:0,
        enumerationMethod:"dfs",deduplicateRotations,pricedTokens:caps,maxCandidates:100_000,budgetMs:10_000}});
    assert.equal(result.outcome,"ran");assert.equal(result.selection.forcedSelectionCount,0);
    const simple=result.opportunities.filter(o=>new Set(o.seedEdges.map(e=>e.tokenIn.toLowerCase())).size===o.seedEdges.length);
    assert.equal(simple.length,deduplicateRotations?29:60);
    assert(result.opportunities.length>simple.length,"new walks must not suppress old simple routes before top-K");
    const rank=simple.findIndex(o=>o.flashToken===USDC&&o.seedEdges.length===4&&
      o.seedEdges.every((e,i)=>e.instanceKey===targetPools[i]))+1;
    assert.equal(rank,deduplicateRotations?0:5);
    if(rank>0) assert.equal(simple[rank-1]!.searchSeed.searchCenter,5_492_842n);
  }
});
