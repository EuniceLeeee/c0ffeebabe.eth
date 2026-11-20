import assert from "node:assert/strict";
import test from "node:test";
import { ADDR } from "../../shared/constants/addresses.js";
import { createBlockScanStartupExecutionPreflight } from "../blockscan-startup-execution-preflight.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import { buildEffectiveMids, effectiveHistoricalRankingHint, effectiveEnumerationMids, withEffectiveRowColumns, type EffectiveMidSnapshot } from "../blockscan-effective-mid.js";
import { scanBlockStateFromResolvedMids } from "../detector/blockscan-scanner-core.js";
import { createBlockScanHistoricalScreen } from "../detector/blockscan-scanner-production.js";
import { createBlockScanSimAmountSelector, matchesHistoricalAmountTrial, publishedSolverVariant } from "../simulator/blockscan-sim-amount-selector.js";
import type { StartupNodeInvocation, StartupNodeSimulation } from "../blockscan-startup-node-simulation.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";

const address=(digit:string)=>"0x"+digit.repeat(40), weth=ADDR.WETH.toLowerCase(), executor=address("1");
const a=address("a"), b=address("b");
const leg=(id:string,i:string,o:string):TokenEdge=>Object.freeze({tokenIn:i,tokenOut:o,target:id,instanceKey:id,
  adapterId:"fixture",canonicalEdgeId:id as TokenEdge["canonicalEdgeId"],executionVariantKey:"recipe-set",
  slotKind:"swap",edgeKind:"swap",leavesStandingPosition:false,executionVerification:"startup-simulation"});
const first=leg("one",weth,a), second=leg("two",a,b), last=leg("three",b,weth), graph=Object.freeze([first,second]);
const at=(n:number)=>({number:n,hash:"0x"+n.toString(16).padStart(64,"0"),generation:n-99});
const priced=(n:number)=>({sourceBlock:n,sourceBlockHash:at(n).hash,generation:at(n).generation,graph:{edges:graph},
  mids:new Map(),coverage:{resolvedEdgeKeys:["one","two"]},pricingStateKeyByEdgeKey:new Map([["one","one"],["two","two"]])});

// Genuine producer receipt+lineage; deterministic simulation transport; no chain calls.
async function changedPrefix(){
  const simulateStandalone=Object.assign(async(x:StartupNodeInvocation)=>{
    let amount=x.amount;
    const receipts=[{hop:-1,amountIn:amount,amountSpent:amount,amountOut:amount}];
    for(const [hop] of x.legs.entries()){const out=x.source.number===100?2n*amount:amount/2n;
      receipts.push({hop,amountIn:amount,amountSpent:amount,amountOut:out});amount=out;}
    return {kind:"success",receipts,returnData:"0x",gasUsed:1n,targetBlock:x.source.number+1,scriptHash:"0x"+"a".repeat(64),
      inputFundingMode:"native-prefix",simulationMs:1,nodeQueueMs:0};
  },{stats:()=>({requests:1,retries:0,simulations:1,headers:1,maxCuIn1000Ms:1})}) as StartupNodeSimulation;
  const pf=createBlockScanStartupExecutionPreflight({executor,transactionOrigin:address("2"),simRejects:new BlockScanSimRejectCache(),
    concurrency:1,simulateStandalone});
  const prepareQuote=async()=>{},sessionFor=()=>({executionVariantIds:()=>["bound"],confirmExecutionVariant(){},
    buildRuntimeAmountLeg:()=>({program:"0x00"})}) as unknown as StrictProductionRuntimeSession;
  const build=(n:number,previous?:EffectiveMidSnapshot)=>buildEffectiveMids({pricing:priced(n),weth,fixedWethInput:100n,
    maxInputPathHops:4,gasCostWei:null,enumerationSpreadBps:0,control:{},concurrency:1,previous,prepareQuote,
    ...(previous?{touchedStateKeys:new Set(["one"]),historicalRankingPolicy:{
      isCleanOnTouchReceipt:(e:TokenEdge,k:string,v:string)=>e===second&&k==="two"&&v==="bound"}}:{}),
    quote:async r=>{const response=await pf.quoteEffective({...r,control:{},edges:graph,prepareQuote,sessionFor});assert(response);return response;}});
  return build(101,await build(100));
}

test("rank-only price enters only a copy used by the scanner; not a current recipe, quote, or imported proof",async()=>{
  const s=await changedPrefix();
  assert(effectiveHistoricalRankingHint(s,second));
  const mids=effectiveEnumerationMids({...priced(101),effectiveMids:s});
  assert(!mids.has("two"));assert.throws(()=>publishedSolverVariant(s,at(101),second));
  const rank=createBlockScanHistoricalScreen(s,graph,mids);
  assert.deepEqual([...rank!.hinted],["two"]);
  assert.equal(rank!.mids.get("two")!.quoteAmountOut,effectiveHistoricalRankingHint(s,second)!.amountOut);
  assert.equal(rank!.startAmounts.get("two"),50n,"newly sourced current A output, not B's historical sample input (200)");
  assert.equal(effectiveHistoricalRankingHint(s,second)!.amountIn,200n);
  assert(!mids.has("two"));assert.equal(s.rows.get("two")!.executionVerification,undefined);
  assert.equal(createBlockScanHistoricalScreen(structuredClone(s),graph,mids),undefined);
  assert.equal(createBlockScanHistoricalScreen(s,[{...second}],mids),undefined);
  const derived=withEffectiveRowColumns(s,new Map([["one",{} as any]]));
  assert.notEqual(derived,s);assert.equal(createBlockScanHistoricalScreen(derived,graph,mids)!.startAmounts.get("two"),50n);
  assert.equal(createBlockScanHistoricalScreen(s,graph,new Map())!.startAmounts.get("two"),undefined);
});

test("first screened leg uses the live funding-token reference before checking the borrow cap",async()=>{
  const effective=await changedPrefix(),current=effectiveEnumerationMids({...priced(101),effectiveMids:effective});
  const rank=createBlockScanHistoricalScreen(effective,graph,current)!;
  const mids=new Map(rank.mids).set("three",{kind:"fixture",pool:last.target,edges:[last],mid:1.2,
    feeBps:0,depthProxy:0,quoteAmountIn:100n,quoteAmountOut:120n});
  const input={edges:[first,second,last],sourceBlock:101,swapTouched:null,mids,
    cfg:{maxHops:3,budgetMs:1000,maxCandidates:10,minSpreadBps:0,prefixPruningEnabled:false,
      pricedTokens:new Map([[a,{maxBorrow:80n}]])}};
  assert.equal(scanBlockStateFromResolvedMids(input).opportunities.length,0,"historical 200 > cap 80");
  const scan=(fresh?:bigint)=>scanBlockStateFromResolvedMids({...input,firstEdgeTrialAmount:(e,den)=>
    rank.hinted.has(String(e.canonicalEdgeId))?(fresh??null):den});
  assert.equal(scan().opportunities.length,0);
  const funded=scan(rank.startAmounts.get("two")).opportunities;
  assert.equal(funded.length,1);assert.equal(funded[0]!.seedEdges[0],second);
  assert.equal(funded[0]!.searchSeed.searchCenter,50n);assert.equal(funded[0]!.searchSeed.maxInput,80n);
});

for(const mode of ["positive","stale","unbound","unfunded","revert","nonpositive","no-bytes","wrong-token"] as const)
test("historical screen to current funded amount trial: "+mode,async()=>{
  const effective=await changedPrefix(),source=mode==="stale"?at(102):at(101);
  const built:string[]=[],trialSources:number[]=[],scripts:string[]=[];
  const session:any={source,needsPublishedExecutionVariant:(edge:TokenEdge)=>edge===first||edge===second,
    buildRuntimeAmountLeg:({edge,variantId}:{edge:TokenEdge;variantId?:string})=>{
      if(edge!==last){assert.equal(variantId,"bound");built.push(String(edge.canonicalEdgeId));}
      if(mode==="unbound"&&edge===second)return null;
      return {actionAdapterId:"current-fixture",program:"0x010001"};
    },
    issueExact:()=>assert.fail("historical screening cannot fallback to quoted propagation"),
    fundingChoices:()=>mode==="unfunded"?[]:[{actionAdapterId:"current-funding",fundingId:"provider"}],
    buildFundingRoot:(x:any)=>({adapterId:"current-funding",target:executor,tokenIn:weth,tokenOut:weth,amount:x.amount,
      params:{provider:x.fundingId},children:x.children})};
  const plan:any={opportunity:{kind:"block-scan-arb",flashToken:weth,profitToken:weth,searchSeed:{searchCenter:10n}},
    tokenPath:{edges:[first,second,last]},maxFlashAmount:10n,templateName:"fixture"};
  const selector=createBlockScanSimAmountSelector({source,executor,effectiveMids:effective,async simulate(p){
    trialSources.push(source.number);assert.equal(p.root.params.provider,"provider");assert.equal(p.netProfit,0n);
    const hex="0x"+p.flashAmount.toString(16).padStart(2,"0");scripts.push(hex);
    return {success:mode!=="revert",netProfit:mode==="revert"||mode==="nonpositive"?0n:7n,grossProfit:7n,gasUsed:12n,
      profitToken:mode==="wrong-token"?a:weth,calldata:"0x",scriptHex:mode==="no-bytes"?undefined:hex,
      ...(mode==="revert"?{failure:{kind:"revert" as const,code:"TRANSACTION_REVERTED",cause:new Error("fixture")}}:{})};
  }});
  let finalists=0;
  const call=()=>selector.solve(plan,{call:()=>assert.fail("fixture state read")} as never,{executor} as never,{strictSession:session,deferPhase2Sim:true,
    deadlineAtMs:Date.now()+5000,gssMaxTries:0,onDeferredCandidates:r=>{finalists+=r.length;}});
  if(mode==="positive"){
    const best=await call();assert.equal(finalists,1);assert.deepEqual(built,["one","two"]);assert.deepEqual(trialSources,[101]);
    assert(matchesHistoricalAmountTrial(best,source,scripts[0]!));
    for(const bad of [at(100),{...source,hash:at(102).hash},{...source,generation:33}])assert(!matchesHistoricalAmountTrial(best,bad,scripts[0]!));
    assert(!matchesHistoricalAmountTrial(best,source,"0xff"));assert(!matchesHistoricalAmountTrial({...best},source,scripts[0]!));
    const mutable=best as {netProfit:bigint};mutable.netProfit=8n;assert(!matchesHistoricalAmountTrial(best,source,scripts[0]!));
  }else {
    await assert.rejects(call,mode==="stale"?/published/:mode==="unbound"?/current runtime amount legs/:mode==="unfunded"?/verified funding/:
      mode==="no-bytes"?/simulated bytes/:mode==="wrong-token"?/profit token mismatch/:/no positive executable amount/);
    assert.equal(finalists,0);assert.equal(trialSources.length,["stale","unbound","unfunded"].includes(mode)?0:1);
  }
});
