import assert from "node:assert/strict";
import test from "node:test";
import { buildEffectiveMids, effectiveAmountReferences, effectiveEnumerationMids, effectiveRowExecutionVerified,
  effectiveHistoricalRankingHint, withEffectiveRowColumns,
  exportEffectiveMidReplayState, exportEffectiveMidReplayDelta, restoreEffectiveMidReplayState,
  type EffectiveMidSnapshot, type EffectivePricingInput } from "../blockscan-effective-mid.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { ADDR } from "../../shared/constants/addresses.js";
import { createBlockScanStartupExecutionPreflight } from "../blockscan-startup-execution-preflight.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import {publishedSolverVariant} from "../simulator/blockscan-sim-amount-selector.js";
import type { StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import type { StartupNodeInvocation, StartupNodeSimulation } from "../blockscan-startup-node-simulation.js";

const source = { number: 100, hash: `0x${"a".repeat(64)}`, generation: 1 };
const edge: TokenEdge = { tokenIn: ADDR.WETH.toLowerCase(), tokenOut: "asset", adapterId: "fixture", target: "pool",
  instanceKey: "pool", executionVariantKey: "variant", canonicalEdgeId: "edge" as TokenEdge["canonicalEdgeId"],
  slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
  executionVerification: "startup-simulation" };
const pricing: EffectivePricingInput = { sourceBlock: source.number, sourceBlockHash: source.hash,
  generation: source.generation, graph: { edges: [edge] }, mids: new Map(), coverage: { resolvedEdgeKeys: ["edge"] },
  pricingStateKeyByEdgeKey: new Map([["edge", "pool"]]) };

for (const pricingMethod of ["exact", "startup-simulation"] as const)
  test(`required execution cannot be supplied by ${pricingMethod} without a bound simulation receipt`, async () => {
    const effective = await buildEffectiveMids({ pricing, weth: ADDR.WETH, fixedWethInput: 100n,
      maxInputPathHops: 4, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1,
      quote: async request => ({ source, amountIn: request.amountIn, amountOut: 200n, amountSpent: 99n, pricingMethod }) });
    assert.equal(effective.rows.get("edge")!.status, "quote-failed");
    assert.equal(effective.rows.get("edge")!.amountOut, null);
  });

const second: TokenEdge = { ...edge, tokenIn: "asset", tokenOut: "asset-two", target: "pool-two", instanceKey: "pool-two",
  executionVariantKey: "variant-two", canonicalEdgeId: "second" as TokenEdge["canonicalEdgeId"] };
const edges = [edge, second];
const at = (n: number) => ({ number: n, hash: `0x${n.toString(16).padStart(64, "0")}`, generation: n - 99 });
const prices = (selected: readonly TokenEdge[], source = at(100)): EffectivePricingInput => ({
  ...pricing, sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
  graph: { edges: selected }, pricingStateKeyByEdgeKey: new Map(selected.map(e => [String(e.canonicalEdgeId), e.instanceKey!])),
});

// The real preflight and price producer, with a deterministic receipt transport.
// This checks authority/orchestration, not EVM execution or live profitability.
function harness(selected: readonly TokenEdge[] = edges,variantId?:string,better?:string) {
  let calls = 0, script = "b";
  const rejectNext=new Set<string>();
  const attempted:string[]=[];
  const simulateStandalone = Object.assign(async (input: StartupNodeInvocation) => {
    calls++;
    let amount = input.amount;
    const receipts = [{ hop: -1, amountIn: amount, amountSpent: amount, amountOut: amount }];
    for (const [hop,leg] of input.legs.entries()) {
      const out=amount*(leg.program==="0x02"?3n:2n);
      receipts.push({ hop, amountIn: amount, amountSpent: amount - 1n, amountOut: out });
      amount=out;
    }
    return { kind: "success" as const, receipts, returnData: "0x", gasUsed: 1n,
      targetBlock: input.source.number + 1, scriptHash: `0x${script.repeat(64)}`,
      inputFundingMode: "native-prefix" as const, simulationMs: 1, nodeQueueMs: 0 };
  }, { stats: () => ({ requests: calls, retries: 0, simulations: calls, headers: 1, maxCuIn1000Ms: 1 }) }) as StartupNodeSimulation;
  const preflight = createBlockScanStartupExecutionPreflight({ executor: `0x${"1".repeat(40)}`,
    transactionOrigin: `0x${"2".repeat(40)}`, simRejects: new BlockScanSimRejectCache(), concurrency: 1, simulateStandalone });
  const prepareQuote = async () => {}, sessionFor = () => ({
    ...(variantId?{executionVariantIds:()=>[variantId],confirmExecutionVariant(){}}:{}),
    buildRuntimeAmountLeg: (input:{edge:TokenEdge}) => ({ program: better!==undefined&&input.edge.canonicalEdgeId===better?"0x02":"0x00" }) }) as unknown as StrictProductionRuntimeSession;
  return { preflight, calls: () => calls, prepareQuote, sessionFor,rejectNext,attempted,
    changeScript: () => { script = "c"; preflight.reset(); },
    build: (source = at(100), previous?: EffectiveMidSnapshot, touchedStateKeys: ReadonlySet<string> | null = new Set<string>(),
      options: Partial<Pick<Parameters<typeof buildEffectiveMids>[0], "disabledEdgeIds" | "control" | "forcedRefresh" | "historicalRankingPolicy" | "cascadeAmountChanges">> = {}) => buildEffectiveMids({
      pricing: prices(selected, source), weth: ADDR.WETH, fixedWethInput: 100n, maxInputPathHops: 4,
      gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1, previous,
      ...(previous && touchedStateKeys !== null ? { touchedStateKeys } : {}), prepareQuote, ...options,
      quote: async request => {
        const id=String(request.edge.canonicalEdgeId);attempted.push(id);
        if(rejectNext.has(id))throw Error("this funded quote failed on the current source");
        const result = await preflight.quoteEffective({ ...request, control: {}, edges: selected, prepareQuote, sessionFor });
        assert(result); return result;
      },
    }),
  };
}

const rankedEdges=Object.freeze(edges.map(e=>Object.freeze({...e})));
const allowHistorical=(...pools:string[])=>({historicalRankingPolicy:{isCleanOnTouchReceipt:(e:TokenEdge,state:string,v:string)=>
  state===e.instanceKey && pools.includes(state)&&v==="bound"}});
test("dirty prefix with cascade off: one historical original sample for ranking only; no B quote, current receipt, prefix or replay",async()=>{
  const [a,b]=rankedEdges as readonly [TokenEdge,TokenEdge],h=harness(rankedEdges,"bound"),first=await h.build(),base=h.calls();
  const prior=first.rows.get("second")!,next=await h.build(at(101),first,new Set(["pool"]),allowHistorical("pool-two"));
  const hint=effectiveHistoricalRankingHint(next,b)!;assert(hint);
  assert.equal(h.calls()-base,1,"only A repriced");assert.equal(hint.edgeId,"second");
  assert.deepEqual([hint.amountIn,hint.amountOut,hint.effectiveMid,hint.variantId,hint.quotedAt,hint.receiptHash],
    [prior.amountIn,prior.amountOut,prior.effectiveMid,"bound",at(100),prior.executionVerification!.receiptHash]);
  assert.equal(next.rows.get("second")!.amountOut,null);assert.equal(next.rows.get("second")!.executionVerification,undefined);
  assert(!effectiveRowExecutionVerified(next,prior,b));assert(!effectiveAmountReferences(next)?.has("asset-two"));
  assert(!effectiveEnumerationMids({...prices(rankedEdges,at(101)),effectiveMids:next}).has("second"));
  assert.equal(effectiveHistoricalRankingHint(next,{...b}),undefined);
  const projected=withEffectiveRowColumns(next,new Map([["edge",{} as any]]));assert.notEqual(projected,next);
  assert.equal(effectiveHistoricalRankingHint(projected,b),hint);
  const again=await h.build(at(102),projected,new Set(["pool"]),allowHistorical("pool-two"));
  assert.equal(effectiveHistoricalRankingHint(again,b),hint);assert.equal(h.calls()-base,2);
  const restored=structuredClone(again);
  restoreEffectiveMidReplayState(restored,structuredClone(exportEffectiveMidReplayState(again)!),rankedEdges,ADDR.WETH);
  assert.equal(effectiveHistoricalRankingHint(restored,b),undefined);
  const resumed=await h.build(at(103),restored,new Set(["pool"]),allowHistorical("pool-two"));
  assert.equal(effectiveHistoricalRankingHint(resumed,b),undefined);assert.equal(resumed.rows.get("second")!.quotedAt?.number,103);
  assert(effectiveRowExecutionVerified(next,next.rows.get("edge")!,a));
});
test("no hints on target refresh, unclassified epochs, incomplete coverage or when cascading is enabled",async()=>{
  const b=rankedEdges[1]!,h=harness(rankedEdges,"bound"),first=await h.build();
  const prev=await h.build(at(101),first,new Set(["pool"]),allowHistorical("pool-two"));
  assert(effectiveHistoricalRankingHint(prev,b));
  for(const [touched,options] of [
    [new Set(["pool","pool-two"]),allowHistorical("pool")], // physical, oracle or every-block owner
    [new Set(["pool"]),{}], // caller cannot authorize reorg or unknown forward coverage
    [null,allowHistorical("pool-two")],
    [new Set(["pool"]),{...allowHistorical("pool-two"),cascadeAmountChanges:true}],
  ] as const){
    const n=await h.build(at(102),prev,touched,options);
    assert.equal(effectiveHistoricalRankingHint(n,b),undefined);assert.equal(n.rows.get("second")!.quotedAt?.number,102);
  }
  const disabled=await h.build(at(102),prev,new Set(["pool"]),{...allowHistorical("pool-two"),disabledEdgeIds:new Set(["second"])});
  assert.equal(disabled.rows.get("second")!.status,"disabled-for-run");assert.equal(effectiveHistoricalRankingHint(disabled,b),undefined);
});
test("a truly dirty C retains its necessary current B bridge; historical B cannot supply C's current WETH input",async()=>{
  const third=Object.freeze({...second,tokenIn:second.tokenOut,tokenOut:"asset-three",instanceKey:"pool-three",target:"pool-three",
    canonicalEdgeId:"third" as TokenEdge["canonicalEdgeId"]});
  const graph=Object.freeze([...rankedEdges,third]),h=harness(graph,"bound"),first=await h.build();
  let n=await h.build(at(101),first,new Set(["pool"]),allowHistorical("pool-two","pool-three"));
  assert(effectiveHistoricalRankingHint(n,rankedEdges[1]!));assert(effectiveHistoricalRankingHint(n,third));
  n=await h.build(at(102),n,new Set(["pool","pool-three"]),allowHistorical("pool-two"));
  for(const e of graph){const row=n.rows.get(String(e.canonicalEdgeId))!;
    assert.equal(row.quotedAt?.number,102);assert(effectiveRowExecutionVerified(n,row,e));assert.equal(effectiveHistoricalRankingHint(n,e),undefined);}
});
test("restored or unbound positive receipts, interrupted work and another graph cannot mint historical ranking",async()=>{
  const b=rankedEdges[1]!,h=harness(rankedEdges,"bound"),p=allowHistorical("pool-two"),first=await h.build();
  const cloned=structuredClone(first);restoreEffectiveMidReplayState(cloned,structuredClone(exportEffectiveMidReplayState(first)!),rankedEdges,ADDR.WETH);
  const clean=await h.build(at(101),cloned,new Set(),p);
  assert(clean.rows.get("second")!.executionVerification,"a restored positive is still not a locally issued ranking sample");
  const after=await h.build(at(102),clean,new Set(["pool"]),p);assert.equal(effectiveHistoricalRankingHint(after,b),undefined);
  assert.equal(after.rows.get("second")!.quotedAt?.number,102);
  const foreign=Object.freeze(rankedEdges.map(e=>Object.freeze({...e}))),other=harness(foreign,"bound");
  const different=await other.build(at(101),first,new Set(["pool"]),p);assert.equal(effectiveHistoricalRankingHint(different,foreign[1]!),undefined);
  const cancelled=await h.build(at(101),first,new Set(["pool"]),{...p,control:{signal:AbortSignal.abort()}});
  assert.equal(cancelled.complete,false);assert.equal(effectiveHistoricalRankingHint(cancelled,b),undefined);
  const plain=harness(rankedEdges),none=await plain.build(),n=await plain.build(at(101),none,new Set(["pool"]),p);
  assert.equal(effectiveHistoricalRankingHint(n,b),undefined);
});
test("a newly enabled dirty target with no previous source reference gets an actual current bridge, never an old input amount",async()=>{
  const third=Object.freeze({...second,tokenIn:second.tokenOut,tokenOut:"asset-three",instanceKey:"pool-three",target:"pool-three",
    canonicalEdgeId:"third" as TokenEdge["canonicalEdgeId"]});
  const graph=Object.freeze([...rankedEdges,third]),h=harness(graph,"bound"),disabledEdgeIds=new Set(["third"]);
  const first=await h.build(at(100),undefined,null,{disabledEdgeIds});
  const stale=await h.build(at(101),first,new Set(["pool"]),{...allowHistorical("pool-two"),disabledEdgeIds});
  assert(effectiveHistoricalRankingHint(stale,rankedEdges[1]!));assert(!effectiveAmountReferences(stale)?.has("asset-two"));
  const live=await h.build(at(102),stale,new Set(["pool","pool-three"]),allowHistorical("pool-two"));
  for(const e of graph){const row=live.rows.get(String(e.canonicalEdgeId))!;
    assert.equal(row.quotedAt?.number,102);assert(effectiveRowExecutionVerified(live,row,e));}
});
test("broad execution subscription on a WETH-input leg is ranking-only only with affirmative, clean market evidence",async()=>{
  const one=Object.freeze([rankedEdges[0]!]),e=one[0]!,h=harness(one,"bound"),first=await h.build(),before=h.calls();
  const next=await h.build(at(101),first,new Set(["pool"]),allowHistorical("pool")),row=first.rows.get("edge")!;
  const hint=effectiveHistoricalRankingHint(next,e)!;
  assert.equal(h.calls(),before);assert.equal(hint.amountIn,row.amountIn);assert.equal(hint.quotedAt.number,100);
  assert.equal(hint.receiptHash,row.executionVerification!.receiptHash);assert.equal(hint.variantId,"bound");
  assert(!effectiveRowExecutionVerified(next,row,e));assert(!effectiveAmountReferences(next)?.has("asset"));
  const unknown=await h.build(at(102),next,new Set(["pool"]),allowHistorical());
  assert.equal(effectiveHistoricalRankingHint(unknown,e),undefined);assert.equal(unknown.rows.get("edge")!.quotedAt?.number,102);
  assert.equal(h.calls()-before,1,"unknown or genuine target changes must request a new funded quote");
});
test("diagnostics separate prefix-only demotions, broad execution-only demotions, overlap and prior historical rows",async t=>{
  const old=process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
  const logs:string[]=[];t.mock.method(console,"log",(s:unknown)=>{logs.push(String(s));});
  process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS="1";
  try{
    const h=harness(rankedEdges,"bound"),first=await h.build();
    await h.build(at(101),first,new Set(["pool"]),allowHistorical("pool-two"));
    const overlapping=await h.build(at(101),first,new Set(["pool","pool-two"]),allowHistorical("pool","pool-two"));
    await h.build(at(102),overlapping,new Set(["pool","pool-two"]),allowHistorical("pool","pool-two"));
    const rows=logs.filter(s=>s.startsWith("[searcher/effective-phase-timing] ")).map(s=>JSON.parse(s.slice(s.indexOf("{"))).historicalRanking);
    assert.deepEqual(rows.slice(-3).map(r=>[r.only,r.prefixOnly,r.executionSubscriptionOnly,r.both,r.retainedHistorical]),[
      [1,1,0,0,0],[2,0,1,1,0],[2,0,0,0,2]]);
  }finally{if(old===undefined)delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS=old;}
});

const alternative=Object.freeze({...rankedEdges[0]!,canonicalEdgeId:"z-other" as TokenEdge["canonicalEdgeId"],
  instanceKey:"pool-alt",target:"pool-alt"});
const unrelated=Object.freeze({...rankedEdges[0]!,canonicalEdgeId:"unrelated" as TokenEdge["canonicalEdgeId"],
  tokenOut:"unrelated-token",instanceKey:"pool-unrelated",target:"pool-unrelated"});
for(const mode of ["disabled","fails","retained","all-fail"] as const)
  test(`dirty target finds an available same-depth bridge on this block (original winner ${mode})`,async()=>{
    const graph=Object.freeze([rankedEdges[0]!,alternative,rankedEdges[1]!,unrelated]), target=graph[2]!,h=harness(graph,"bound");
    let prior=await h.build();
    assert.equal(effectiveAmountReferences(prior)!.get("asset")!.path.at(-1)!.edgeId,"edge");
    if(mode==="retained"){
      prior=await h.build(at(101),prior,new Set(["pool","pool-alt","pool-unrelated"]),{
        ...allowHistorical("pool","pool-alt","pool-unrelated"),disabledEdgeIds:new Set(["second"])});
      assert(effectiveHistoricalRankingHint(prior,alternative));
    }
    const disabledEdgeIds=new Set(mode==="disabled"?["edge"]:[]);
    if(mode!=="disabled")h.rejectNext.add("edge");if(mode==="all-fail")h.rejectNext.add("z-other");
    h.attempted.length=0;
    const source=at(mode==="retained"?102:101);
    const n=await h.build(source,prior,new Set(["pool","pool-alt","pool-two","pool-unrelated"]),{
      ...allowHistorical("pool-alt","pool-unrelated"),disabledEdgeIds});
    assert(h.attempted.includes("z-other"));assert(!h.attempted.includes("unrelated"),"not a full frontier/table retry");
    assert(effectiveHistoricalRankingHint(n,unrelated));assert.equal(effectiveHistoricalRankingHint(n,alternative),undefined);
    const c=n.rows.get("second")!;
    if(mode==="all-fail"){
      assert.equal(c.status,"missing-valuation");assert.equal(c.executionVerification,undefined);assert(!h.attempted.includes("second"));
    }else{
      assert(h.attempted.includes("second"));assert.equal(c.quotedAt?.number,source.number);assert(effectiveRowExecutionVerified(n,c,target));
      assert.deepEqual(effectiveAmountReferences(n)!.get("asset")!.path.map(x=>[x.edgeId,x.quotedAt?.number]),[["z-other",source.number]]);
    }
  });
test("successful longer fallback uses real current upstream bridges, never its predecessor's recorded amount",async()=>{
  const hop1=Object.freeze({...alternative,canonicalEdgeId:"alt-1" as TokenEdge["canonicalEdgeId"],tokenOut:"middle"}),hop2=Object.freeze({
    ...alternative,canonicalEdgeId:"alt-2" as TokenEdge["canonicalEdgeId"],tokenIn:"middle",instanceKey:"hop2",target:"hop2"});
  const graph=Object.freeze([rankedEdges[0]!,hop1,hop2,rankedEdges[1]!,unrelated]),h=harness(graph,"bound"),first=await h.build();
  h.rejectNext.add("edge");h.attempted.length=0;
  const n=await h.build(at(101),first,new Set(["pool","pool-alt","hop2","pool-two","pool-unrelated"]),
    allowHistorical("pool-alt","hop2","pool-unrelated"));
  assert.deepEqual(effectiveAmountReferences(n)!.get("asset")!.path.map(r=>r.edgeId),["alt-1","alt-2"]);
  assert.equal(n.rows.get("second")!.amountIn,400n);assert(effectiveRowExecutionVerified(n,n.rows.get("second")!,rankedEdges[1]!));
  assert.deepEqual(new Set(h.attempted),new Set(["edge","alt-1","alt-2","second"]));
});

for(const bothDirectFail of [false,true])test("funding-only longer route after competing shorter routes, both fail="+bothDirectFail,async()=>{
  const middle=Object.freeze({...alternative,canonicalEdgeId:"middle" as TokenEdge["canonicalEdgeId"],tokenOut:"middle",instanceKey:"middle"}),
    longer=Object.freeze({...alternative,canonicalEdgeId:"longer" as TokenEdge["canonicalEdgeId"],tokenIn:"middle",instanceKey:"longer"}),
    cold=Object.freeze({...alternative,canonicalEdgeId:"cold" as TokenEdge["canonicalEdgeId"],tokenIn:"middle",tokenOut:"cold-out",instanceKey:"cold"});
  const graph=Object.freeze([rankedEdges[0]!,alternative,middle,longer,rankedEdges[1]!,cold]);
  const h=harness(graph,"bound","z-other");h.rejectNext.add("cold");
  const first=await h.build();assert.equal(first.rows.get("cold")!.status,"quote-failed");
  h.rejectNext.delete("cold");if(bothDirectFail){h.rejectNext.add("edge");h.rejectNext.add("z-other");}
  h.attempted.length=0;
  const n=await h.build(at(101),first,new Set(["pool","pool-alt","middle","longer","pool-two"]),
    allowHistorical("pool","pool-alt","middle","longer"));
  assert(h.attempted.includes("edge")&&h.attempted.includes("z-other"),"same-depth candidates must both try");
  assert(h.attempted.includes("cold"),"a non-ranking target without an old quote and without a touched key still runs");
  assert.equal(n.rows.get("cold")!.amountIn,200n);assert.equal(n.rows.get("cold")!.amountOut,400n);
  assert.deepEqual(effectiveAmountReferences(n)!.get("middle")!.path.map(x=>x.edgeId),["middle"]);
  assert(effectiveRowExecutionVerified(n,n.rows.get("cold")!,cold));
  assert.equal(h.attempted.includes("longer"),bothDirectFail);
  const target=n.rows.get("second")!;assert(effectiveRowExecutionVerified(n,target,rankedEdges[1]!));
  assert.deepEqual(effectiveAmountReferences(n)!.get("asset")!.path.map(r=>r.edgeId),bothDirectFail?["middle","longer"]:["z-other"]);
  assert.equal(target.amountIn,bothDirectFail?400n:300n);assert.equal(target.amountOut,bothDirectFail?800n:600n);
  if(!bothDirectFail){const skipped=n.rows.get("longer")!;assert.equal(skipped.amountIn,null);assert.equal(skipped.executionVerification,undefined);
    assert(effectiveHistoricalRankingHint(n,longer));}
});

test("only a verified on-touch winner can ignore its dormant sibling, and a funded prefix uses its own winner", async () => {
  const h = harness(edges, "bound"), first = await h.build();
  const merged = new Set(["pool", "pool-two"]);
  const refresh = (actual: string[], allowed: string[]) => ({forcedRefresh:{actualTouched:new Set(actual),
    isOnTouchVariant: (e: TokenEdge, _state: string, variant: string) => variant==="bound" && allowed.includes(e.instanceKey!)}});
  const clean = await h.build(at(101), first, merged, refresh([],["pool","pool-two"]));
  assert.strictEqual(clean.rows.get("edge"), first.rows.get("edge")); assert.strictEqual(clean.rows.get("second"), first.rows.get("second"));
  assert.equal(h.calls(), 2);
  const prefixDirty = await h.build(at(102), clean, merged, refresh([],["pool-two"]));
  assert.equal(h.calls(), 4); assert.equal(prefixDirty.rows.get("second")!.quotedAt!.number, 102);
  const physicalTouch = await h.build(at(103), prefixDirty, merged, refresh(["pool-two"],["pool","pool-two"]));
  assert.equal(h.calls(), 5); assert.strictEqual(physicalTouch.rows.get("edge"), prefixDirty.rows.get("edge"));
  const disabled = await h.build(at(104), physicalTouch, new Set(["pool-two"]),
    {...refresh([],["pool-two"]), disabledEdgeIds:new Set(["edge"])});
  assert.equal(disabled.rows.get("edge")!.status,"disabled-for-run");
  assert.equal(disabled.rows.get("second")!.status,"missing-valuation");
  const tombstone = await h.build(at(105), disabled, merged, refresh([],["pool","pool-two"]));
  assert.equal(tombstone.rows.get("second")!.quotedAt!.number,105);
  const unknown = harness(), unbound = await unknown.build();
  await unknown.build(at(101), unbound, merged, refresh([],["pool","pool-two"])); assert.equal(unknown.calls(), 4);
  const forged = await buildEffectiveMids({pricing:prices([{...edge,executionVerification:undefined}]),weth:ADDR.WETH,
    fixedWethInput:100n,maxInputPathHops:4,gasCostWei:null,enumerationSpreadBps:0,control:{},concurrency:1,
    quote:async q=>({source:q.source,amountIn:q.amountIn,amountSpent:q.amountIn,amountOut:q.amountIn*2n,
      pricingMethod:"startup-simulation",executionVerification:{kind:"startup-simulation",variantId:"bound",
        targetBlock:q.source.number+1,scriptHash:"0x"+"b".repeat(64),receiptHash:"0x"+"0".repeat(64)}})});
  const strict=harness([edge],"bound"), renewed=await strict.build(at(101),forged,merged,refresh([],["pool"]));
  assert.equal(strict.calls(),1,"a known on-touch variant string cannot replace authenticated prior evidence");
  assert.equal(renewed.rows.get("edge")!.quotedAt!.number,101);
});

test("optional carry diagnostics partition prior quoted rows using the actual gate decisions", async t => {
  const priorEnv = process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
  t.after(() => { if (priorEnv === undefined) delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
    else process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = priorEnv; });
  process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS = "1";
  const records: Record<string, number>[] = [];
  const prefix = "[searcher/effective-phase-timing] ";
  t.mock.method(console, "log", (line: unknown) => {
    if (typeof line === "string" && line.startsWith(prefix)) records.push(JSON.parse(line.slice(prefix.length)).carry);
  });
  const check = (expected: Record<string, number>) => {
    assert.equal(records.length, 1);
    const { priorQuoted, ...counts } = records.pop()!;
    assert.equal(Object.values(counts).reduce((a,b) => a+b, 0), priorQuoted);
    assert.deepEqual(Object.fromEntries(Object.entries(counts).filter(([,n]) => n !== 0)), expected);
  };
  const h = harness(edges, "sealed-winner"), first = await h.build(); check({});
  await h.build(at(101), first, new Set(["unrelated raw address"])); check({carried:2});
  await h.build(at(101), first, new Set(["pool"])); check({ownStateTouched:1, prefixOnlyTouched:1});
  await h.build(at(101), first, new Set(["pool","pool-two"])); check({ownStateTouched:2});
  await h.build(at(101), first, null); check({noCompatibleBase:2});
  await h.build(at(101), first, new Set(), {disabledEdgeIds:new Set(["second"])}); check({carried:1, disabled:1});
  await h.build(at(101), first, new Set(), {control:{signal:AbortSignal.abort()}}); check({cancelled:2});
  const legacy = await buildEffectiveMids({pricing:prices(edges.map(({executionVerification:_verification,...e})=>e)),
    weth:ADDR.WETH, fixedWethInput:100n, maxInputPathHops:4, gasCostWei:null, enumerationSpreadBps:0, control:{}, concurrency:1,
    quote:async q=>({source:q.source,amountIn:q.amountIn,amountOut:q.amountIn*2n,pricingMethod:"exact"})});
  check({});
  await h.build(at(101), legacy); check({failedVerification:2});
  delete process.env.SEARCHER_STATE_LATENCY_DIAGNOSTICS;
  const clean = await h.build(at(101), first); assert.equal(records.length, 0);
  assert.strictEqual(clean.rows.get("second"), first.rows.get("second"));
});

test("one funded quote exposes source/path-bound proof and its screening reuses the same execution", async () => {
  const h = harness(), snapshot = await h.build();
  assert.equal(h.calls(), 2);
  for (const e of edges) {
    const row = snapshot.rows.get(String(e.canonicalEdgeId))!;
    assert.equal(row.status, "quoted");
    assert(effectiveRowExecutionVerified(snapshot, row, e));
    assert.equal(row.executionVerification!.targetBlock, 101);
    assert.equal(row.executionVerification!.kind, "startup-simulation");
  }
  await h.preflight.run({ effective: snapshot, edges, control: {}, prepareQuote: h.prepareQuote, sessionFor: h.sessionFor });
  assert.equal(h.calls(), 2, "screening must reuse both issued price receipts");
  assert.equal(effectiveEnumerationMids({ ...prices(edges), effectiveMids: snapshot }).size, 2);
});

test("complete untouched activity carries original SIM observations without claiming a new simulation", async () => {
  const h = harness(), first = await h.build(), same = await h.build(at(100), first);
  assert.equal(h.calls(), 2);
  assert.strictEqual(same.rows.get("edge"), first.rows.get("edge"));
  const next = await h.build(at(101), same);
  assert.equal(h.calls(), 2, "canonical untouched carry performs zero new simulations");
  assert.strictEqual(next.rows.get("edge"), first.rows.get("edge"));
  assert.equal(next.rows.get("edge")!.quotedAt!.number, 100, "original SIM provenance is not rewritten");
  for (const e of edges) assert(effectiveRowExecutionVerified(next, next.rows.get(String(e.canonicalEdgeId))!, e));
  assert.equal(effectiveEnumerationMids({ ...prices(edges, at(101)), effectiveMids: { ...first, source: at(101) } }).size, 0,
    "moving a historical table to the new envelope cannot refresh its receipts");
});

for (const changed of ["target", "prefix", "continuity"] as const)
  test(`marked samples reexecute when ${changed} invalidates their existing carry authority`, async () => {
    const h = harness(), first = await h.build();
    const next = await h.build(at(101), first, changed === "continuity" ? null : new Set([changed === "target" ? "pool-two" : "pool"]));
    assert.equal(h.calls(), changed === "target" ? 3 : 4);
    assert.equal(next.rows.get("second")!.quotedAt!.number, 101);
    assert(effectiveRowExecutionVerified(next, next.rows.get("second")!, second));
  });

test("legacy method-only rows cannot restore, enumerate, carry, or seed a newly required execution edge", async () => {
  const oldEdges = edges.map(({ executionVerification: _old, ...plain }) => plain);
  const old = await buildEffectiveMids({ pricing: prices(oldEdges), weth: ADDR.WETH, fixedWethInput: 100n,
    maxInputPathHops: 4, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1,
    quote: async request => ({ source: request.source, amountIn: request.amountIn, amountOut: request.amountIn * 2n,
      pricingMethod: "startup-simulation" }) });
  assert.equal(old.rows.get("second")!.status, "quoted");
  assert.equal(effectiveEnumerationMids({ ...prices(edges), effectiveMids: old }).size, 0);
  const serialized = structuredClone({ snapshot: old, lineage: exportEffectiveMidReplayState(old) });
  assert.throws(() => restoreEffectiveMidReplayState(serialized.snapshot, serialized.lineage, edges, ADDR.WETH), /execution verification/);
  let attempts = 0;
  const rejected = await buildEffectiveMids({ pricing: prices(edges), weth: ADDR.WETH, fixedWethInput: 100n,
    maxInputPathHops: 4, gasCostWei: null, enumerationSpreadBps: 0, control: {}, concurrency: 1,
    previous: old, touchedStateKeys: new Set(), quote: async () => { attempts++; throw new Error("execution unavailable"); } });
  assert.equal(attempts, 1);
  assert.equal(rejected.rows.get("edge")!.status, "quote-failed");
  assert.equal(rejected.rows.get("second")!.status, "missing-valuation");
  assert.deepEqual([...effectiveAmountReferences(rejected)!.keys()], [ADDR.WETH.toLowerCase()]);
});

test("an unmarked carried target cannot retain a stale marked input path", async () => {
  const { executionVerification: _unused, ...plainSecond } = second;
  const h = harness([edge, plainSecond]), first = await h.build(), next = await h.build(at(101), first, new Set(["pool"]));
  assert.equal(h.calls(), 4, "both the required prefix and its dependent target refresh together");
  assert.equal(next.rows.get("second")!.quotedAt!.number, 101);
});

test("carried marked replay requires its actual publication source anchor and original receipt", async () => {
  const h = harness(), first = await h.build(), carried = await h.build(at(101), first);
  const saved = { snapshot: carried, lineage: exportEffectiveMidReplayState(carried) };
  const valid = structuredClone(saved);
  restoreEffectiveMidReplayState(valid.snapshot, valid.lineage, edges, ADDR.WETH);
  assert(effectiveRowExecutionVerified(valid.snapshot, valid.snapshot.rows.get("second")!, second));
  assert.equal(valid.snapshot.rows.get("second")!.quotedAt!.number, 100);
  const wrong = structuredClone(saved);
  assert.throws(() => restoreEffectiveMidReplayState({ ...wrong.snapshot, source: at(102) }, wrong.lineage, edges, ADDR.WETH), /source anchor/);
  const missing = structuredClone(saved);
  assert.throws(() => restoreEffectiveMidReplayState(missing.snapshot, { ...missing.lineage, source: undefined }, edges, ADDR.WETH), /execution verification/);
});

test("amount Solver takes the private ID from restored funded row, never a different fork or mutated hint",async()=>{
  const h=harness(edges,"private-winner"),first=await h.build(),next=await h.build(at(101),first);
  const checkpoint=structuredClone({snapshot:next,lineage:exportEffectiveMidReplayState(next)});
  restoreEffectiveMidReplayState(checkpoint.snapshot,checkpoint.lineage,edges,ADDR.WETH);
  assert.equal(publishedSolverVariant(checkpoint.snapshot,at(101),edge),"private-winner");
  assert.throws(()=>publishedSolverVariant(checkpoint.snapshot,{...at(101),hash:"0x"+"fe".repeat(32)},edge),/current published/);
  const forged=structuredClone(checkpoint);
  (forged.snapshot.rows.get("edge")!.executionVerification as {variantId:string}).variantId="stale-preferred";
  assert.throws(()=>restoreEffectiveMidReplayState(forged.snapshot,forged.lineage,edges,ADDR.WETH));
  assert.throws(()=>publishedSolverVariant(forged.snapshot,at(101),edge),/current published/);
});

for (const mutation of ["replace", "number", "hash", "generation"] as const)
  test(`restored private carry authority cannot follow an in-place source ${mutation} mutation`, async () => {
    const h = harness(), first = await h.build(), carried = await h.build(at(101), first);
    const saved = structuredClone({ snapshot: carried, lineage: exportEffectiveMidReplayState(carried) });
    restoreEffectiveMidReplayState(saved.snapshot, saved.lineage, edges, ADDR.WETH);
    assert(effectiveRowExecutionVerified(saved.snapshot, saved.snapshot.rows.get("second")!, second));
    const mutable = saved.snapshot as any;
    if (mutation === "replace") mutable.source = at(102);
    if (mutation === "number") mutable.source.number = 102;
    if (mutation === "hash") mutable.source.hash = `0x${"f".repeat(64)}`;
    if (mutation === "generation") mutable.source.generation = 3;
    assert.equal(effectiveRowExecutionVerified(saved.snapshot, saved.snapshot.rows.get("second")!, second), false);
    assert.equal(effectiveEnumerationMids({ ...prices(edges, saved.snapshot.source), effectiveMids: saved.snapshot }).size, 0);
    const reexported = structuredClone({ snapshot: saved.snapshot, lineage: exportEffectiveMidReplayState(saved.snapshot) });
    assert.deepEqual(reexported.lineage.source, at(101), "export retains its private authorization anchor");
    assert.throws(() => restoreEffectiveMidReplayState(reexported.snapshot, reexported.lineage, edges, ADDR.WETH), /source anchor/);
  });

test("same-source equal-amount receipt changes are retained in native continuation token deltas", async () => {
  const h = harness(), first = await h.build();
  h.changeScript();
  const next = await h.build(at(100), first, new Set(edges.map(e => e.instanceKey!)));
  assert.equal(next.rows.get("edge")!.amountOut, first.rows.get("edge")!.amountOut);
  assert.notEqual(next.rows.get("edge")!.executionVerification!.receiptHash,
    first.rows.get("edge")!.executionVerification!.receiptHash);
  const delta = exportEffectiveMidReplayDelta(next, first);
  assert(delta.tokenUpdates.some(([token]) => token === "asset"), "equal prices cannot drop changed execution bindings");
  const replay = structuredClone({ snapshot: next, lineage: exportEffectiveMidReplayState(next) });
  restoreEffectiveMidReplayState(replay.snapshot, replay.lineage, edges, ADDR.WETH);
  assert(effectiveRowExecutionVerified(replay.snapshot, replay.snapshot.rows.get("second")!, second));
});

for (const fault of ["missing", "source", "script", "receipt", "amount", "path"] as const)
  test(`restored simulation evidence rejects changed ${fault} while a complete bound replay survives`, async () => {
    const h = harness(), snapshot = await h.build();
    const valid = structuredClone({ snapshot, lineage: exportEffectiveMidReplayState(snapshot) });
    restoreEffectiveMidReplayState(valid.snapshot, valid.lineage, edges, ADDR.WETH);
    assert.equal(effectiveEnumerationMids({ ...prices(edges), effectiveMids: valid.snapshot }).size, 2);
    const bad = structuredClone({ snapshot, lineage: exportEffectiveMidReplayState(snapshot) });
    const row = bad.snapshot.rows.get("edge")! as any;
    if (fault === "missing") delete row.executionVerification;
    if (fault === "source") row.quotedAt = at(99);
    if (fault === "script") row.executionVerification.scriptHash = `0x${"c".repeat(64)}`;
    if (fault === "receipt") row.executionVerification.receiptHash = `0x${"c".repeat(64)}`;
    if (fault === "amount") row.amountSpent--;
    if (fault === "path") {
      const reference = bad.lineage.references.find(value => value.path.length > 0)!;
      (reference.path[0] as any).amountSpent--;
    }
    assert.throws(() => restoreEffectiveMidReplayState(bad.snapshot, bad.lineage, edges, ADDR.WETH), /execution verification/);
  });
