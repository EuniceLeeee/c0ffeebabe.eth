import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, hexlify, keccak256, toBeHex } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { RuntimeAmountProgram } from "../../adapters/runtime-amount-program.js";
import { buildEffectiveMids, effectiveRowAmountReference, exportEffectiveMidReplayState,
  restoreEffectiveMidReplayState } from "../blockscan-effective-mid.js";
import { resolveEffectiveInputPathHops } from "../effective-input-path-policy.js";
import { createBlockScanStartupExecutionPreflight } from "../blockscan-startup-execution-preflight.js";
import { BlockScanSimRejectCache } from "../blockscan-sim-reject-cache.js";
import type { StartupNodeInvocation, StartupNodeSimulation } from "../blockscan-startup-node-simulation.js";
import type { StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { compileStartupPrefix, startupPrefixReceipts, STARTUP_RECEIPT_TOPIC } from "../simulator/startup-prefix-program.js";

// Synthetic transport for orchestration checks only. The separate EVM test
// executes the actual compiled programs and token balances.
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const actor = toBeHex(400, 20), origin = toBeHex(401, 20);
const tokens = [ADDR.WETH.toLowerCase(), ...Array.from({ length: 9 }, (_, i) => toBeHex(500 + i, 20))];
const program = hexlify(new RuntimeAmountProgram().constant(0, 1n).bytes());
const edges: TokenEdge[] = Array.from({ length: 8 }, (_, i) => ({
  tokenIn: tokens[i]!, tokenOut: tokens[i + 1]!, adapterId: "test-swap", target: toBeHex(700 + i, 20),
  instanceKey: `pool-${i}`, executionVariantKey: `variant-${i}`, canonicalEdgeId: `edge-${i}` as TokenEdge["canonicalEdgeId"],
  slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
}));
const pricing = { sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
  graph: { edges }, pricingStateKeyByEdgeKey: new Map(edges.map(edge => [String(edge.canonicalEdgeId), edge.instanceKey!])),
  mids: new Map(), coverage: { resolvedEdgeKeys: edges.map(edge => String(edge.canonicalEdgeId)) } };
const legs = edges.map(edge => ({ tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, program }));

function harness(options: { failToken?: string; unavailable?: boolean } = {}) {
  const calls: StartupNodeInvocation[] = [], observations: Readonly<Record<string, unknown>>[] = [];
  const simRejects = new BlockScanSimRejectCache();
  const simulateStandalone = Object.assign(async (input: StartupNodeInvocation) => {
    calls.push(input);
    const compiled = compileStartupPrefix(input, actor);
    if (input.legs.at(-1)?.tokenOut === options.failToken) return {
      kind: "revert" as const, receipts: [], returnData: "0x1234", gasUsed: 50_000n,
      targetBlock: input.source.number + 1, scriptHash: keccak256(compiled.scriptHex), inputFundingMode: "native-prefix" as const,
      failure: { hop: input.legs.length - 1, callTarget: edges[input.legs.length - 1]!.target, reason: "0x1234" },
      simulationMs: 1, nodeQueueMs: 0,
    };
    let amount = input.amount;
    const receipts = [{ hop: -1, amountIn: amount, amountOut: amount, amountSpent: amount }];
    for (let i = 0; i < input.legs.length; i++) {
      receipts.push({ hop: i, amountIn: amount, amountOut: amount * 2n, amountSpent: amount - 1n });
      amount *= 2n;
    }
    return { kind: "success" as const, receipts, returnData: "0x", gasUsed: 50_000n,
      targetBlock: input.source.number + 1, scriptHash: keccak256(compiled.scriptHex), inputFundingMode: "native-prefix" as const,
      simulationMs: 1, nodeQueueMs: 0 };
  }, { stats: () => ({ requests: calls.length, retries: 0, simulations: calls.length, headers: 1, maxCuIn1000Ms: 40 }) }) as StartupNodeSimulation;
  const session = { buildRuntimeAmountLeg: () => options.unavailable ? undefined : { program } } as unknown as StrictProductionRuntimeSession;
  const prepareQuote = async () => {}, sessionFor = () => session;
  const preflight = createBlockScanStartupExecutionPreflight({ executor: actor, transactionOrigin: origin,
    concurrency: 2, simRejects, simulateStandalone, filterTargetReverts: true,
    onObservation: observation => observations.push(observation) });
  let fallbackQuotes = 0;
  return { preflight, calls, observations, simRejects, prepareQuote, sessionFor,
    fallbackQuotes: () => fallbackQuotes,
    build: (maxInputPathHops: number, extra: Partial<Parameters<typeof buildEffectiveMids>[0]> = {}) => buildEffectiveMids({
      pricing, weth: ADDR.WETH, gasCostWei: null, fixedWethInput: 100n, enumerationSpreadBps: 200,
      maxInputPathHops, control: {}, concurrency: 2, prepareQuote,
      quote: async request => await preflight.quoteEffective({ ...request, control: request.control ?? {}, edges, prepareQuote, sessionFor }) ??
        (fallbackQuotes++, { source: request.source, amountIn: request.amountIn, amountOut: request.amountIn * 2n }),
      ...extra,
    }),
  };
}

test("startup price configuration has one default and rejects invalid hop counts", () => {
  assert.equal(resolveEffectiveInputPathHops({}), 4);
  assert.equal(resolveEffectiveInputPathHops({ SEARCHER_EFFECTIVE_MAX_INPUT_PATH_HOPS: "6", SEARCHER_MAX_HOPS: "2" }), 6);
  for (const value of ["-1", "1.5", "06", "", "9007199254740992", "Infinity"])
    assert.throws(() => resolveEffectiveInputPathHops({ SEARCHER_EFFECTIVE_MAX_INPUT_PATH_HOPS: value }));
});

for (const hops of [4, 6]) test(`shared ${hops}-hop policy prices each target and preflight reuses that exact simulation`, async () => {
  const h = harness(), maxInputPathHops = resolveEffectiveInputPathHops({ SEARCHER_EFFECTIVE_MAX_INPUT_PATH_HOPS: String(hops) });
  const effective = await h.build(maxInputPathHops);
  assert.equal(effective.maxInputPathHops, hops);
  assert.equal(h.calls.length, hops + 1);
  assert.equal(h.fallbackQuotes(), 0);
  assert.deepEqual(h.calls.map(call => call.legs.length), Array.from({ length: hops + 1 }, (_, i) => i + 1));
  assert(h.calls.every(call => call.amount === 100n && call.maxInputPathHops === hops));
  const target = effective.rows.get(`edge-${hops}`)!;
  assert.equal(target.amountIn, 100n * 2n ** BigInt(hops));
  assert.equal(target.amountOut, target.amountIn! * 2n);
  assert.equal(target.amountSpent, target.amountIn! - 1n);
  assert.equal(target.effectiveMid, 2, "the denominator remains the available budget");
  assert.equal(target.pricingMethod, "startup-simulation");
  assert.equal(effectiveRowAmountReference(target)!.path.length, hops);
  assert.equal(effective.rows.get(`edge-${hops + 1}`)!.status, "missing-valuation");
  await h.preflight.run({ effective, edges, control: {}, prepareQuote: h.prepareQuote, sessionFor: h.sessionFor });
  assert.equal(h.calls.length, hops + 1, "preflight must not repeat the successful pricing simulations");
  assert.equal(h.observations.filter(value => value.reusePolicy === "same-startup-simulation-price").length, hops + 1);
});

test("changing the price policy from four to six invalidates price carry and completed preparation", async () => {
  const h = harness();
  const four = await h.build(4);
  await h.preflight.run({ effective: four, edges, control: {}, prepareQuote: h.prepareQuote, sessionFor: h.sessionFor });
  const six = await h.build(6, { previous: four, touchedStateKeys: new Set() });
  assert.equal(h.calls.length, 5 + 7, "six-hop startup receives fresh executions, including formerly missing rows");
  assert.notEqual(six.rows.get("edge-0"), four.rows.get("edge-0"));
  assert.equal(six.rows.get("edge-6")!.status, "quoted");
  await h.preflight.run({ effective: six, edges, control: {}, prepareQuote: h.prepareQuote, sessionFor: h.sessionFor });
  assert.equal(h.calls.length, 12);
  const lineage = exportEffectiveMidReplayState(six);
  assert.equal(lineage.maxInputPathHops, 6);
  restoreEffectiveMidReplayState(six, lineage, edges, ADDR.WETH);
  assert.throws(() => restoreEffectiveMidReplayState({ ...six, maxInputPathHops: 4 }, lineage, edges, ADDR.WETH), /policy/);
});

test("completed startup screening keeps simulation as the current-source price entry", async () => {
  const h = harness();
  const first = await h.build(4);
  await h.preflight.run({ effective: first, edges, control: {}, prepareQuote: h.prepareQuote, sessionFor: h.sessionFor });
  const next = { number: source.number + 1, hash: toBeHex(101, 32), generation: source.generation + 1 };
  const updated = await h.build(4, { previous: first,
    pricing: { ...pricing, sourceBlock: next.number, sourceBlockHash: next.hash, generation: next.generation },
    touchedStateKeys: new Set(pricing.pricingStateKeyByEdgeKey.values()) });
  assert.equal(h.calls.length, 10, "all touched prices execute after one-time screening completes");
  assert.equal(h.fallbackQuotes(), 0);
  assert.deepEqual(h.calls.slice(5).map(call => call.source), Array.from({ length: 5 }, () => next));
  assert.equal(updated.rows.get("edge-4")!.pricingMethod, "startup-simulation");
});

test("deferred resume screening does not defer simulation prices or repeat them at revalidation", async () => {
  const h = harness();
  h.preflight.defer(true);
  const effective = await h.build(4);
  assert.equal(h.calls.length, 5, "resume catch-up still derives the table from current-source simulation");
  assert.equal(h.fallbackQuotes(), 0);
  assert.equal(await h.preflight.run({ effective, edges, control: {}, prepareQuote: h.prepareQuote, sessionFor: h.sessionFor }), false);
  h.preflight.defer(false);
  await h.preflight.run({ effective, edges, control: {}, prepareQuote: h.prepareQuote, sessionFor: h.sessionFor });
  assert.equal(h.calls.length, 5, "resume revalidation consumes the same pricing receipts");
  assert.equal(h.observations.filter(value => value.reusePolicy === "same-startup-simulation-price").length, 5);
});

test("a shared target revert becomes the existing target filter and never falls back to an Exact quote", async () => {
  const h = harness({ failToken: tokens[3] });
  const effective = await h.build(4);
  assert.equal(effective.rows.get("edge-2")!.status, "quote-failed");
  assert.equal(effective.rows.get("edge-2")!.failureEvidence, "evm-revert-observed");
  assert.equal(h.calls.length, 3); assert.equal(h.fallbackQuotes(), 0);
  assert.equal(await h.preflight.run({ effective, edges, control: {}, prepareQuote: h.prepareQuote, sessionFor: h.sessionFor }), true);
  assert(h.simRejects.hasPool(edges[2]!));
  assert.equal(h.calls.length, 3, "neither successful targets nor the failed target get a second simulation");
});

test("only an unavailable runtime leg uses the original Exact price entry", async () => {
  const h = harness({ unavailable: true });
  const effective = await h.build(4);
  assert.equal(h.fallbackQuotes(), 5); assert.equal(h.calls.length, 0);
  assert.equal(effective.rows.get("edge-4")!.status, "quoted");
});

test("six prefix conversions preserve hop five as a real leg and separate budget from spent", () => {
  const abi = AbiCoder.defaultAbiCoder();
  const compiled = compileStartupPrefix({ amount: 100n, maxInputPathHops: 6, legs: legs.slice(0, 7) }, actor);
  assert.equal(compiled.fundingContext, 7);
  assert.throws(() => compileStartupPrefix({ amount: 100n, maxInputPathHops: 4, legs: legs.slice(0, 7) }, actor));
  const events = [7, 0, 1, 2, 3, 4, 5, 6].map((hop, index) => ({ address: compiled.recorder, topics: [STARTUP_RECEIPT_TOPIC],
    data: abi.encode(["uint256", "uint256", "uint256", "uint256"], [hop, 100n, 100n, index ? 93n : 100n]) }));
  const receipts = startupPrefixReceipts(events, compiled);
  assert.deepEqual(receipts.map(row => row.hop), [-1, 0, 1, 2, 3, 4, 5, 6]);
  assert.equal(receipts[6]!.amountIn, 100n); assert.equal(receipts[6]!.amountSpent, 93n);
  events[6]!.data = abi.encode(["uint256", "uint256", "uint256", "uint256"], [5, 100n, 100n, 101n]);
  assert.throws(() => startupPrefixReceipts(events, compiled), /continuity/);
});
