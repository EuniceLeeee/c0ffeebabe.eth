import assert from "node:assert/strict";
import { BlockScanAmountReference, gasReferenceInput, tokenToWethReferences } from "../blockscan-amount-reference.js";
import { DEFAULT_EFFECTIVE_WETH_INPUT, type EffectiveMidRow } from "../blockscan-effective-mid.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { refineBlockScanCandidates } from "../detector/blockscan-candidate-refinement.js";
import type { BlockScanProbeDiagnostic } from "../detector/blockscan-candidate-refinement.js";
import type { BlockScanOpportunity } from "../detector/detector.js";
import type { TokenEdge } from "../planner/token-graph.js";
import type { StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import type { StateBackend } from "../../shared/state/state-backend.js";

const W = "weth", U = "usdc";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const source = (n: number) => ({ number: n, hash: hash(n), generation: n });
const header = (n: number) => ({ ...source(n), parentHash: hash(n - 1), baseFeePerGas: 1_000_000_000n, gasUsed: 15_000_000n, gasLimit: 30_000_000n });
const edge = (a: string, b: string, id: string): TokenEdge => ({
  tokenIn: a, tokenOut: b, adapterId: "test-swap", target: id,
  instanceKey: id, executionVariantKey: "swap", canonicalEdgeId: id as TokenEdge["canonicalEdgeId"],
  slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
});
type Pricing = Parameters<typeof tokenToWethReferences>[0];
function pricing(n: number, rows: [TokenEdge, number, number?][]): Pricing {
  const keys = rows.map(([e]) => blockScanEdgeKey(e));
  return {
    sourceBlock: n, sourceBlockHash: hash(n), generation: n,
    graph: { edges: rows.map(([e]) => e) },
    coverage: { resolvedEdgeKeys: keys },
    mids: new Map(rows.map(([e, mid, feeBps = 0]) => [blockScanEdgeKey(e), {
      edges: [e], kind: "external-swap", pool: e.target, mid, feeBps, depthProxy: 1,
    }])),
  } as unknown as Pricing;
}
const forward = edge(U, W, "a"), back = edge(W, U, "b");
const opportunity = (): BlockScanOpportunity => ({
  kind: "block-scan-arb", sourceBlock: 2, stateBlock: 2,
  seedEdges: [forward, back], flashToken: U, cycleId: "test", cycleFingerprint: "test",
  searchSeed: { startToken: U, searchCenter: 100_000_000n, maxInput: 200_000_000n },
  leavesStandingPosition: false, coarseSpreadBps: 300,
});
const rate = { num: 500_000_000n, den: 1n }; // raw USDC -> WETH wei, decimals already included.
assert.equal(gasReferenceInput(100_000_000_000_000n, rate, 100), 20_000_001n,
  "1% enumeration floor sizes from 100bps, not a hardcoded prior threshold");
assert.equal(gasReferenceInput(100_000_000_000_000n, rate, 200), 10_000_001n);
assert.equal(gasReferenceInput(100_000_000_000_000n, rate, 500), 4_000_001n);
assert.equal(gasReferenceInput(100n, { num: 1n, den: 1n }, 0), null);
assert.equal(gasReferenceInput(100n, { num: 1n, den: 1n }, NaN), null);

const pathPrices = pricing(2, [
  [forward, 5e8], [edge("x", U, "x-u"), 2], [edge("y", "x", "y-x"), 3],
  [edge("z", "y", "z-y"), 4], [edge(W, "reverse-only", "reverse"), 1],
  [edge("fee", W, "fee"), 100, 100],
  [edge("tiny", W, "tiny"), 1e-300],
  [edge("tiny2", "tiny", "tiny2"), 1e-100],
]);
const marks = tokenToWethReferences(pathPrices, W);
const value = (token: string) => marks.get(token)!.num / marks.get(token)!.den;
assert.equal(value(U), 500_000_000n);
assert.equal(value("x"), 1_000_000_000n);
assert.equal(value("y"), 3_000_000_000n);
assert.equal(value("fee"), 99n);
assert.equal(marks.has("z"), false, "four hops are unavailable");
assert.equal(marks.has("reverse-only"), false, "never invent reverse prices");
assert(marks.get("tiny2")!.num > 0n, "no fixed-scale underflow across legs");
assert.deepEqual(marks.get(W), { num: 1n, den: 1n });
const duplicate = { ...forward, canonicalEdgeId: "a2" as TokenEdge["canonicalEdgeId"], executionVariantKey: "variant" };
const alternatives = pricing(2, [[forward, 1], [duplicate, 1], [edge(U, W, "c"), 2], [edge(U, W, "d"), 3]]);
const bestMark = tokenToWethReferences(alternatives, W).get(U)!;
assert.equal(bestMark.num / bestMark.den, 3n, "choose the best available instance, not the median");
const directWins = tokenToWethReferences(pricing(2, [[forward, 2], [edge(U, "x", "u-x"), 100], [edge("x", W, "x-w"), 100]]), W).get(U)!;
assert.equal(directWins.num / directWins.den, 2n, "prefer direct to longer profitable cycles");

const ref = new BlockScanAmountReference();
const opp = opportunity();
ref.observeHeader(header(1));
ref.observeHeader(header(2));
assert.equal(ref.estimateGasCost(source(2)), null, "no gas history means unknown");
ref.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 100_000n, success: false });
assert.equal(ref.estimateGasCost(source(2)), null, "reverted execution is not a gas reference");
ref.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 100_000n, success: true });
assert.equal(ref.estimateGasCost(source(2)), 100_000_000_000_000n);
const other = { ...opportunity(), seedEdges: [edge(U, W, "other-a"), edge(W, U, "other-b")], cycleId: "other", cycleFingerprint: "other" };
const higherFee = new BlockScanAmountReference();
higherFee.observeHeader(header(1));
higherFee.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 100_000n, success: true });
higherFee.observeHeader({ ...header(2), baseFeePerGas: 2_000_000_000n });
assert.equal(higherFee.estimateGasCost(source(2)), 200_000_000_000_000n, "use the current block's fee");
ref.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 200_000n, success: true });
assert.equal(ref.estimateGasCost(source(2)), 200_000_000_000_000n);
ref.recordSimulation({ opportunity: other, source: source(1), gasUsed: 50_000n, success: true });
assert.equal(ref.estimateGasCost(source(2)), 200_000_000_000_000n, "same-block maximum is shared");
ref.recordSimulation({ opportunity: other, source: source(2), gasUsed: 300_000n, success: true });
assert.equal(ref.estimateGasCost(source(2)), 200_000_000_000_000n, "same-source sim only informs later blocks");
ref.observeHeader(header(3));
assert.equal(ref.estimateGasCost(source(3)), 300_000_000_000_000n);
ref.observeHeader({ ...header(2), hash: hash(99) });
assert.equal(ref.estimateGasCost(source(2)), null, "observed reorg clears the estimate");
assert.equal(new BlockScanAmountReference().estimateGasCost(source(2)), null, "restart clears gas history");
const gapRef = new BlockScanAmountReference();
gapRef.observeHeader(header(1));
gapRef.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 100_000n, success: true });
gapRef.observeHeader(header(3));
assert.equal(gapRef.estimateGasCost(source(3)), null, "skipped heights cannot conceal a reorg");
gapRef.observeHeader(header(2));
assert.equal(gapRef.estimateGasCost(source(3)), 100_000_000_000_000n, "connected ancestry permits reuse");
const reorgGap = new BlockScanAmountReference();
reorgGap.observeHeader(header(1));
reorgGap.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 200_000n, success: true });
reorgGap.observeHeader({ ...header(3), parentHash: hash(98) });
assert.equal(reorgGap.estimateGasCost(source(3)), null);
reorgGap.recordSimulation({ opportunity: opp, source: source(3), gasUsed: 100_000n, success: true });
reorgGap.observeHeader(header(4));
assert.equal(reorgGap.estimateGasCost(source(4)), 100_000_000_000_000n, "ignore old unlinked high-gas sample");
const bounded = new BlockScanAmountReference(3);
bounded.observeHeader(header(1));
bounded.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 300_000n, success: true });
bounded.observeHeader(header(2));
bounded.recordSimulation({ opportunity: other, source: source(2), gasUsed: 100_000n, success: true });
bounded.observeHeader(header(3));
assert.equal(bounded.estimateGasCost(source(3)), 100_000_000_000_000n,
  "the previous block takes precedence even when an older block used more gas");
bounded.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 500_000n, success: true });
assert.equal(bounded.estimateGasCost(source(3)), 100_000_000_000_000n,
  "a late older-block result cannot displace the newest successful block");
bounded.observeHeader(header(4));
assert.equal(bounded.estimateGasCost(source(4)), 100_000_000_000_000n,
  "without a previous-block sim, use the nearest earlier successful block");
bounded.observeHeader({ ...header(4), baseFeePerGas: 500_000_000n });
assert.equal(bounded.estimateGasCost(source(4)), 50_000_000_000_000n,
  "a reused gas-unit sample is repriced when current network fees fall");
bounded.observeHeader(header(5));
assert.equal(bounded.estimateGasCost(source(5)), null,
  "expired provenance cannot be reused indefinitely");

// Exact sizing consumes the existing effective row, without gas history or a
// second token valuation. Two venues for one token may carry different inputs.
type AmountPricing = NonNullable<Parameters<BlockScanAmountReference["prepare"]>[0]["pricing"]>;
const effectiveRow = (e: TokenEdge, amountIn: bigint): EffectiveMidRow => ({
  edgeId: blockScanEdgeKey(e), instanceKey: e.instanceKey!, tokenIn: e.tokenIn, tokenOut: e.tokenOut,
  amountIn, amountOut: 123n, effectiveMid: 1, status: "quoted", quotedAt: source(1),
});
const wethOpp = { ...opportunity(), flashToken: W, seedEdges: [back, forward],
  searchSeed: { startToken: W, searchCenter: 10n ** 18n, maxInput: 10n ** 18n } };
const sizing: AmountPricing = {
  sourceBlock: 2, sourceBlockHash: hash(2), generation: 2,
  effectiveMids: { source: source(2), reference: "default", referenceWethInput: DEFAULT_EFFECTIVE_WETH_INPUT,
    complete: true, wallMs: 0, rows: new Map([
      [blockScanEdgeKey(forward), effectiveRow(forward, 2_000_000n)],
      [blockScanEdgeKey(back), effectiveRow(back, DEFAULT_EFFECTIVE_WETH_INPUT)],
      [blockScanEdgeKey(other.seedEdges[0]!), effectiveRow(other.seedEdges[0]!, 3_000_000n)],
    ]) },
};
const input = { pricing: sizing, opportunities: [opp, wethOpp, other] };
const cold = new BlockScanAmountReference();
cold.estimateGasCost = () => { throw new Error("Exact sizing must not independently recalculate gas"); };
const frozen = cold.prepare(input);
assert.equal(frozen.get(opp), 2_000_000n, "USDC input is already in raw units");
assert.equal(frozen.get(wethOpp), DEFAULT_EFFECTIVE_WETH_INPUT, "cold start reuses effective's shared 0.005 ETH input");
assert.equal(frozen.get(other), 3_000_000n, "select the exact first edge, not another pool for the token");
const nextBlockOpp = { ...opp, sourceBlock: 3, stateBlock: 3 };
assert.equal(cold.prepare({ ...input, opportunities: [nextBlockOpp] }).get(nextBlockOpp), 2_000_000n,
  "N-1 enumeration reuses its published input without relabeling the quote as current-N authority");
cold.observeHeader(header(1)); cold.observeHeader(header(2));
cold.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 999_999n, success: true });
assert.deepEqual(cold.prepare(input), frozen, "new gas samples must not independently resize Exact");
const repriced = { ...sizing, effectiveMids: { ...sizing.effectiveMids!, reference: "gas" as const,
  rows: new Map([[blockScanEdgeKey(forward), effectiveRow(forward, 7_000_000n)]]) } };
assert.equal(cold.prepare({ ...input, pricing: repriced }).get(opp), 7_000_000n);
assert.equal(frozen.get(opp), 2_000_000n, "published and carried amounts are not mutated");
assert.equal(cold.prepare({ ...input, pricing: { ...sizing, sourceBlock: 3 } }).size, 0);
assert.equal(cold.prepare({ ...input, pricing: { ...sizing, generation: 99 } }).size, 0);
assert.equal(cold.prepare({ ...input, pricing: { ...sizing, sourceBlockHash: hash(99) } }).size, 0);
assert.equal(cold.prepare({ ...input, pricing: { ...sizing, effectiveMids: undefined } }).size, 0);
assert.equal(cold.prepare({ ...input, pricing: null }).size, 0);
assert.equal(cold.prepare({ ...input, pricing: { ...sizing, effectiveMids: { ...sizing.effectiveMids!, complete: false } } }).size, 0);
for (const bad of [
  { amountIn: null }, { amountIn: 0n }, { amountIn: -1n }, { status: "no-output" as const },
  { edgeId: "wrong" }, { tokenIn: W }, { tokenOut: U },
]) {
  const row = { ...effectiveRow(forward, 2_000_000n), ...bad };
  assert.equal(cold.prepare({ ...input, pricing: { ...sizing,
    effectiveMids: { ...sizing.effectiveMids!, rows: new Map([[blockScanEdgeKey(forward), row]]) } } }).size, 0);
}

const refs = new Map<BlockScanOpportunity, bigint>();
const aboveOldCenter = { ...opportunity(), cycleId: "above-old-center" };
const candidates = [opportunity(), opportunity(), opportunity(), opportunity(), wethOpp, aboveOldCenter];
candidates[1]!.cycleId = "below-ten";
candidates[2]!.cycleId = "effective-sized";
candidates[3]!.cycleId = "over-cap";
refs.set(candidates[1]!, 5n);
refs.set(candidates[2]!, 1_000n);
refs.set(candidates[3]!, 200_000_001n);
refs.set(aboveOldCenter, 100_000_001n);
refs.set(wethOpp, frozen.get(wethOpp)!);
const quoted: bigint[] = [];
const diagnostics: BlockScanProbeDiagnostic[] = [];
const strictSession = {
  async issueExact({ amountIn }: { amountIn: bigint }) {
    quoted.push(amountIn);
    return { amountOut: amountIn + 10n };
  },
} as unknown as StrictProductionRuntimeSession;
const result = await refineBlockScanCandidates(
  { async call() { throw new Error("unexpected RPC"); } } as unknown as StateBackend,
  candidates, 6, Date.now() + 3000,
  new Map([[U, { maxBorrow: 1_000_000_000n }]]), d => diagnostics.push(d), 1,
  { probeAmountsByOpportunity: refs, executor: "executor", strictSession, admissionSpreadBps: 50 },
);
assert.deepEqual(quoted, [5n, 15n, 1_000n, 1_010n, DEFAULT_EFFECTIVE_WETH_INPUT, DEFAULT_EFFECTIVE_WETH_INPUT + 10n,
  100_000_001n, 100_000_011n]);
assert.equal(result.attempted, 4);
assert.equal(result.failed, 0);
assert.equal(result.positive, 4);
assert.equal(result.deadlineHit, false);
assert.deepEqual(result.openFamilyIds, []);
assert.equal(result.opportunities.find(o => o.cycleId === "effective-sized")!.searchSeed.searchCenter, 1_000n);
assert.equal(result.opportunities.find(o => o.cycleId === "below-ten")!.searchSeed.searchCenter, 5n);
assert.equal(result.opportunities.find(o => o.cycleId === "above-old-center")!.searchSeed.searchCenter, 100_000_001n,
  "old searchCenter cannot reject or resize the actual effective input");
assert.equal(result.opportunities.find(o => o.flashToken === W)!.searchSeed.searchCenter, DEFAULT_EFFECTIVE_WETH_INPUT);
assert.equal(diagnostics.find(d => d.index === 0)!.failure?.reason, "amount_reference_missing");
assert(!result.opportunities.some(o => o.cycleId === "over-cap"));
const excluded = diagnostics.find(d => d.index === 3)!;
assert.equal(excluded.attempted, false);
assert.equal(excluded.failure?.reason, "amount_reference_over_cap");
assert.equal(excluded.failure?.attributedFamilyId, null);
for (const expired of [false, true]) {
  const over = { ...opportunity(), searchSeed: { startToken: U, searchCenter: 9n, maxInput: 9n } };
  const observed: BlockScanProbeDiagnostic[] = [];
  const failures = expired ? [] : Array.from({ length: 3 }, opportunity);
  const rejected = await refineBlockScanCandidates(
    { async call() { throw new Error("unexpected RPC"); } } as unknown as StateBackend,
    [...failures, over], 10, Date.now() + (expired ? -1 : 3000), new Map(),
    d => observed.push(d), 1,
    { probeAmountsByOpportunity: new Map([...failures, over].map(o => [o, 10n])),
      executor: "executor", strictSession: { async issueExact() { throw new Error("injected Family quote failure"); } } as unknown as StrictProductionRuntimeSession },
  );
  const overDiagnostic = observed.find(d => d.index === failures.length)!;
  assert.equal(overDiagnostic.failure?.reason, "amount_reference_over_cap", "cap policy must precede deadlines/circuits");
  assert.equal(rejected.opportunities.length, 0, "over-cap must not enter deadline fallback");
  assert.equal(rejected.failed, failures.length, "cap exclusions must not inflate quote failure counts");
}
const deadlineCandidates = [opportunity(), opportunity(), opportunity()];
const deadlineInputs = new Map([[deadlineCandidates[0]!, 2_000_000n], [deadlineCandidates[2]!, 200_000_001n]]);
const deadlineResult = await refineBlockScanCandidates(
  {} as StateBackend, deadlineCandidates, 3, Date.now() - 1, new Map(), undefined, 1,
  { probeAmountsByOpportunity: deadlineInputs },
);
assert.equal(deadlineResult.opportunities.length, 1, "missing/over-cap amounts never become deadline fallbacks");
assert.equal(deadlineResult.opportunities[0]!.searchSeed.searchCenter, 2_000_000n,
  "an existing deadline fallback also hands the recorded reference to Solver");
console.log("blockscan-amount-reference PASS: gas provenance, effective first-edge amount reuse, units, carry, source binding, no dust fallback, Exact/Solver handoff and cap attribution");
