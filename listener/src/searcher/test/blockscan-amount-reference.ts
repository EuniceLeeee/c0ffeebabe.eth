import assert from "node:assert/strict";
import { BlockScanAmountReference, gasReferenceInput, resolveExactProbe, tokenToWethReferences } from "../blockscan-amount-reference.js";
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
assert.deepEqual([undefined, null, 0n, 9n, 10n, 11n].map(resolveExactProbe), [10n, 10n, 10n, 10n, 10n, 11n]);
const rate = { num: 500_000_000n, den: 1n }; // raw USDC -> WETH wei, decimals already included.
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
const medians = pricing(2, [[forward, 1], [duplicate, 1], [edge(U, W, "c"), 2], [edge(U, W, "d"), 3]]);
const medianMark = tokenToWethReferences(medians, W).get(U)!;
assert.equal(medianMark.num / medianMark.den, 2n, "variants cannot multiply one instance's votes");
const directWins = tokenToWethReferences(pricing(2, [[forward, 2], [edge(U, "x", "u-x"), 100], [edge("x", W, "x-w"), 100]]), W).get(U)!;
assert.equal(directWins.num / directWins.den, 2n, "prefer direct to longer profitable cycles");

const ref = new BlockScanAmountReference(W);
const opp = opportunity();
const input = { source: source(2), pricing: pricing(2, [[forward, 5e8]]), enumerationSpreadBps: 200, opportunities: [opp] };
ref.observeHeader(header(1));
ref.observeHeader(header(2));
assert.equal(ref.prepare(input).size, 0, "no gas history means unknown");
ref.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 100_000n, success: false });
assert.equal(ref.prepare(input).size, 0, "reverted execution is not a gas reference");
ref.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 100_000n, success: true });
const frozen = ref.prepare(input);
assert.equal(frozen.get(opp), 10_000_001n);
assert.equal(ref.prepare({ ...input, enumerationSpreadBps: 500 }).get(opp), 4_000_001n, "G follows the enumeration threshold");
assert.equal(ref.prepare({ ...input, source: source(1) }).size, 0, "cannot borrow mismatched snapshot/header");
assert.equal(ref.prepare({ ...input, source: { ...source(2), generation: 99 } }).size, 0);
assert.equal(ref.prepare({ ...input, pricing: pricing(1, [[forward, 5e8]]) }).size, 0, "N-1 mid cannot masquerade as current-N input");
ref.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 200_000n, success: true });
assert.equal(frozen.get(opp), 10_000_001n, "later samples do not mutate a pass reference");
assert.equal(ref.prepare(input).get(opp), 20_000_001n);
ref.observeHeader({ ...header(2), hash: hash(99) });
assert.equal(ref.prepare(input).size, 0, "observed reorg clears the estimate");
assert.equal(new BlockScanAmountReference(W).prepare(input).size, 0, "restart does not inherit old execution context");
const gapRef = new BlockScanAmountReference(W);
gapRef.observeHeader(header(1));
gapRef.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 100_000n, success: true });
gapRef.observeHeader(header(3));
const gapInput = { ...input, source: source(3), pricing: pricing(3, [[forward, 5e8]]) };
assert.equal(gapRef.prepare(gapInput).size, 0, "skipped heights cannot conceal a reorg in gas provenance");
gapRef.observeHeader(header(2));
assert.equal(gapRef.prepare(gapInput).get(opp), 10_000_001n, "already observed connected ancestry permits reuse");
const reorgGap = new BlockScanAmountReference(W);
reorgGap.observeHeader(header(1));
reorgGap.recordSimulation({ opportunity: opp, source: source(1), gasUsed: 200_000n, success: true });
reorgGap.observeHeader({ ...header(3), parentHash: hash(98) });
assert.equal(reorgGap.prepare(gapInput).size, 0);
reorgGap.recordSimulation({ opportunity: opp, source: source(3), gasUsed: 100_000n, success: true });
reorgGap.observeHeader(header(4));
assert.equal(reorgGap.prepare({ ...input, source: source(4), pricing: pricing(4, [[forward, 5e8]]) }).get(opp), 10_000_001n,
  "old unlinked high-gas sample must not suppress a new chain's lower sample");

const refs = new Map<BlockScanOpportunity, bigint>();
const candidates = [opportunity(), opportunity(), opportunity(), opportunity()];
candidates[1]!.cycleId = "below-ten";
candidates[2]!.cycleId = "gas-sized";
candidates[3]!.cycleId = "over-cap";
refs.set(candidates[1]!, 5n);
refs.set(candidates[2]!, 1_000n);
refs.set(candidates[3]!, 100_000_001n);
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
  candidates, 4, Date.now() + 3000,
  new Map([[U, { maxBorrow: 1_000_000_000n }]]), d => diagnostics.push(d), 1,
  { gasMinimumByOpportunity: refs, executor: "executor", strictSession, admissionSpreadBps: 50 },
);
assert.deepEqual(quoted, [10n, 20n, 10n, 20n, 1_000n, 1_010n]);
assert.equal(result.attempted, 3);
assert.equal(result.failed, 0);
assert.equal(result.positive, 3);
assert.equal(result.deadlineHit, false);
assert.deepEqual(result.openFamilyIds, []);
assert.equal(result.opportunities.find(o => o.cycleId === "gas-sized")!.searchSeed.searchCenter, 1_000n);
assert.equal(result.opportunities.find(o => o.cycleId === "below-ten")!.searchSeed.searchCenter, 10n);
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
    { executor: "executor", strictSession: { async issueExact() { throw new Error("injected Family quote failure"); } } as unknown as StrictProductionRuntimeSession },
  );
  const overDiagnostic = observed.find(d => d.index === failures.length)!;
  assert.equal(overDiagnostic.failure?.reason, "amount_reference_over_cap", "cap policy must precede deadlines/circuits");
  assert.equal(rejected.opportunities.length, 0, "over-cap must not enter deadline fallback");
  assert.equal(rejected.failed, failures.length, "cap exclusions must not inflate quote failure counts");
}
console.log("blockscan-amount-reference PASS: units, fees, three hops, dynamic floor, source isolation, Exact amount handoff and cap attribution");
