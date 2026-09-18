import assert from "node:assert/strict";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildBlockScanUsdView, type BlockScanUsdView } from "../blockscan-usd-view.js";
import { scanBlockStateFromResolvedMids, type ResolvedBlockScanMid } from "../detector/blockscan-scanner-core.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "../venues/route-instance-identity.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { TokenEdge } from "../planner/token-graph.js";
const weth=ADDR.WETH.toLowerCase(),usdc=ADDR.USDC.toLowerCase(),unit=10n**18n;
const address=(n:number)=>"0x"+n.toString(16).padStart(40,"0");
const tokens=[weth,usdc,...[101,102,103,104].map(address),weth];
const edges:TokenEdge[]=tokens.slice(0,-1).map((tokenIn,i)=>({
  adapterId:"test-swap",target:address(201+i),tokenIn,tokenOut:tokens[i+1]!,
  slotKind:"swap",...deriveEdgeTaxonomy("swap"),
}));
const mids=new Map<string,ResolvedBlockScanMid>(edges.map((edge,i)=>[blockScanEdgeKey(edge),{
  kind:"test",pool:edge.target,edges:[edge],mid:i===5?1.2:1.01,feeBps:0,
  quoteAmountIn:1000n,quoteAmountOut:i===5?1200n:1010n,
  reserveA:1000000n*unit,reserveB:1000000n*unit,depthProxy:1e24,
}]));
const quotes=edges.map((e,i)=>({id:blockScanEdgeKey(e),instance:edgeInstanceKey(e),
  tokenIn:e.tokenIn,tokenOut:e.tokenOut,num:i===5?1200n:1010n,den:1000n,
  value:{num:i===5?1200n:1010n,den:1000n}}));
const view:BlockScanUsdView={quotes,signals:[{token:weth,buy:quotes[5]!.id,sell:quotes[0]!.id,num:120n,den:100n}],
  signalPairsPerToken:1,referenceUsdPerRaw:new Map(),comparableTokens:1,missingBuyReference:0,missingSellReference:0};
const scan=(enumerationMethod:"dfs"|"layered",maxHops=6,usdView=view,budgetMs=5000)=>
  scanBlockStateFromResolvedMids({edges,sourceBlock:10,swapTouched:new Set(),mids,usdView,
    captureCoarseEnumeration:true,cfg:{enumerationMethod,maxHops,minSpreadBps:50,budgetMs,
      maxCandidates:100,pricedTokens:new Map([[weth,{maxBorrow:1000n*unit}]])}});
const a=scan("dfs"),b=scan("layered");
const zeroPrefixView={...view,quotes:quotes.map((q,i)=>i<2?{...q,value:{num:1000n,den:1000n}}:q)};
assert.equal(scan("dfs",6,zeroPrefixView,5000).opportunities.length,0,
  "scanner passes strict cumulative gate through; zero-profit second prefix is rejected");
const recoveryView={...view,quotes:quotes.map((q,i)=>({...q,
  value:{num:[90n,120n,99n,99n,120n,90n][i]!,den:100n}}))};
const recovered=scan("dfs",6,recoveryView,5000);
assert.equal(recovered.opportunities.length,1);
assert.equal(recovered.enumeration?.gateRule,"cumulative-positive-after-first");
assert.deepEqual(recovered.opportunities,scan("layered",6,recoveryView,5000).opportunities);
assert.equal(a.outcome,"ran");assert.equal(a.enumeration?.algorithm,"paired-dfs");
assert.equal(b.enumeration?.algorithm,"paired-layered");
assert.equal(a.opportunities.length,1);assert.equal(a.opportunities[0]!.seedEdges.length,6);
assert.deepEqual(a.opportunities,b.opportunities);assert.deepEqual(a.selection,b.selection);
assert.equal(a.opportunities[0]!.searchSeed.searchCenter,1000n);
assert.equal(a.opportunities[0]!.searchSeed.maxInput,1000n*unit);
const originalMids=new Map(mids);
for(const [key,mid] of mids) mids.set(key,{...mid,reserveA:1n,reserveB:0n,liquidity:0n,depthProxy:0});
assert.deepEqual(scan("dfs").opportunities,a.opportunities,"stale/tiny depth proxies cannot reject effective P");
for(const [key,mid] of mids) mids.set(key,{...mid,reserveA:undefined,reserveB:undefined,liquidity:undefined});
assert.deepEqual(scan("layered").opportunities,a.opportunities,"missing legacy depth cannot reject effective P");
const firstKey=blockScanEdgeKey(edges[0]!);
for(const amount of [undefined,0n,-1n,1000n*unit+1n]) {
  mids.set(firstKey,{...originalMids.get(firstKey)!,quoteAmountIn:amount});
  assert.equal(scan("dfs").opportunities.length,0,"missing/invalid/over-funding P must fail closed");
}
for(const [key,mid] of originalMids) mids.set(key,mid);
assert.equal(scan("dfs",4).opportunities.length,0);
assert.equal(scan("layered",4).opportunities.length,0);
assert.equal(scan("dfs",6,{...view,quotes:quotes.map((q,i)=>i===2?{...q,value:null}:q)}).opportunities.length,0);
assert.equal(scan("dfs",6,view,0).outcome,"budget_exceeded");
// Verify value multipliers come from the published USD marks, not raw token ratios.
const e0=edges[0]!,e1={...edges[1]!,tokenIn:usdc,tokenOut:weth};
const priced=new Map<string,ResolvedBlockScanMid>([
  [blockScanEdgeKey(e0),{kind:"test",pool:e0.target,edges:[e0],mid:2e-9,feeBps:0,depthProxy:1e20,
    quoteAmountIn:unit,quoteAmountOut:2_000_000_000n}],
  [blockScanEdgeKey(e1),{kind:"test",pool:e1.target,edges:[e1],mid:5.1e8,feeBps:0,depthProxy:1e20,
    quoteAmountIn:2_000_000_000n,quoteAmountOut:102n*unit/100n}],
]);
const usd=buildBlockScanUsdView([e0,e1],priced);
assert.equal(usd.quotes.length,2);
for(const q of usd.quotes){
  const a=usd.referenceUsdPerRaw.get(q.tokenIn)!,b=usd.referenceUsdPerRaw.get(q.tokenOut)!;
  assert(a&&b&&q.value);
  assert.equal(q.value.num*q.den*b.den*a.num,q.value.den*q.num*b.num*a.den);
}
// Credit keeps its standing-position label but joins the identical amount-
// quoted USD/DFS flow. Its oracle limit alone must never become a quote.
const credit: TokenEdge = { ...e0, adapterId: "test-credit", target: address(999),
  slotKind: "lend", ...deriveEdgeTaxonomy("lend") };
const cashMids = new Map(priced);
cashMids.set(blockScanEdgeKey(credit), { kind: "protocol", pool: credit.target, edges: [credit],
  mid: 2.2e-9, feeBps: 0, depthProxy: 0, quoteAmountIn: unit, quoteAmountOut: 2_200_000_000n });
const cashEdges = [e0, e1, credit];
for (const enumerationMethod of ["dfs", "layered"] as const) {
  const result = scanBlockStateFromResolvedMids({ edges: cashEdges, sourceBlock: 10, swapTouched: null,
    mids: cashMids, cfg: { enumerationMethod, maxHops: 6, minSpreadBps: 0, budgetMs: 5000,
      maxCandidates: 100, pricedTokens: new Map([[weth, { maxBorrow: 100n * unit }]]) } });
  const candidate = result.opportunities.find(opp => opp.seedEdges.some(e => e.slotKind === "lend"));
  assert(candidate, "a real Credit amount quote naturally joins the same funded ring search");
  assert.equal(candidate.leavesStandingPosition, true);
  assert.equal(candidate.searchSeed.searchCenter, unit);
}
const limitOnly = new Map(cashMids);
limitOnly.set(blockScanEdgeKey(credit), { ...limitOnly.get(blockScanEdgeKey(credit))!,
  quoteAmountIn: undefined, quoteAmountOut: undefined });
assert(!buildBlockScanUsdView(cashEdges, limitOnly).quotes.some(q => q.id === blockScanEdgeKey(credit)),
  "Credit requires actual amount output, not a linear oracle-limit fallback");
console.log("paired integration: PASS (actual scanner DFS/layered switch, six hops, cap, missing reference, deadline, frozen USD value ratios)");
