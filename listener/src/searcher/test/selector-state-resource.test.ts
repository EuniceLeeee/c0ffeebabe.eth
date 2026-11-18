import assert from "node:assert/strict";
import test from "node:test";
import { toBeHex } from "ethers";
import type { StateBackend } from "../../shared/state/state-backend.js";
import type { Opportunity } from "../detector/detector.js";
import { TemplatePlanner } from "../planner/planner.js";
import type { TokenEdge, TokenPath } from "../planner/token-graph.js";
import { propagateAmountsWithRawOutputs } from "../solver/amount-propagation.js";
import { SequentialQuoteUnsupportedError, type StrictProductionExactHandle,
  type StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import type { PathTemplate } from "../templates/path-template.js";

// Actual planner/amount-propagation policy, with synthetic Graph rows and an
// explicitly synthetic Exact-session recorder. This is not issuer or EVM proof.
const a = (n: number) => toBeHex(n, 20), h = (n: number) => toBeHex(n, 32);
const A = a(1), B = a(2), C = a(3), TARGET = a(101), OTHER = a(102), EXECUTOR = a(201);
type ResourceEdge = TokenEdge & { stateResourceKey?: string };
function edge(tokenIn: string, tokenOut: string, resource?: string, overrides: Partial<ResourceEdge> = {}): ResourceEdge {
  return { adapterId: "execution:0x11223344:static-words-3:call", target: TARGET, tokenIn, tokenOut,
    instanceKey: `instance:${tokenIn}:${tokenOut}`, executionVariantKey: `variant:${tokenIn}:${tokenOut}`,
    slotKind: "protocol", protocolAction: "convert", edgeKind: "protocol", leavesStandingPosition: false,
    ...(resource === undefined ? {} : { stateResourceKey: resource }), ...overrides };
}
function opportunity(): Opportunity {
  return { kind: "backrun-arb", victimTxHash: h(900), blockNumber: 1, affectedPools: [TARGET], affectedTokens: [A, B],
    startToken: A, profitToken: A, victimAmountIn: 100n, hints: {},
    victimEffect: { kind: "swap", impact: { pool: TARGET, tokenIn: A, tokenOut: B, amountIn: 100n,
      matchedAdapterId: "execution:0x11223344:static-words-3:call" } } };
}
async function plan(edges: ResourceEdge[]) {
  const planner = new TemplatePlanner(); planner.setGraph(edges); planner.setMaxHops(2);
  const template: PathTemplate = { name: "resource-regression", slots: [
    { id: "flash", kind: "flash", adapters: ["fixture-flash"] },
    { id: "trade", kind: "swap", adapters: [...new Set(edges.map(row => row.adapterId))], min: 1, max: 2 },
  ], constraints: [{ type: "token-continuity" }, { type: "final-token-equals-start-token" }] };
  return { plans: await planner.plan(opportunity(), [template]), diagnostic: planner.lastNoCandidateDiagnostic() };
}
const noState = new Proxy({} as StateBackend, { get() { throw new Error("policy test must not perform state IO"); } });
type IssueInput = Parameters<StrictProductionRuntimeSession["issueExact"]>[0];
function session(rejectPrefix = false) {
  const inputs: IssueInput[] = [], handles: StrictProductionExactHandle[] = [];
  const synthetic = {
    blocksPrefixInversion: () => false,
    async issueExact(input: IssueInput) {
      inputs.push(input);
      if (rejectPrefix && input.priorQuotes?.length) throw new SequentialQuoteUnsupportedError();
      const handle = { amountIn: input.amountIn, amountOut: input.amountIn + 7n } as StrictProductionExactHandle;
      handles.push(handle); return handle;
    },
  } as unknown as StrictProductionRuntimeSession;
  return { inputs, handles, synthetic };
}
async function propagate(edges: ResourceEdge[], recorder = session()) {
  const path: TokenPath = { edges };
  const result = await propagateAmountsWithRawOutputs(path, 100n, noState,
    { executor: EXECUTOR, strictSession: recorder.synthetic, toleranceRawUnits: 0n });
  return { ...recorder, result };
}

test("planner retains opposite directions through distinct resources at the same manager address", async () => {
  const result = await plan([edge(A, B, "resource:pool-one"), edge(B, A, "resource:pool-two")]);
  assert.equal(result.plans.length, 1, JSON.stringify(result.diagnostic));
  assert.equal(result.diagnostic, null);
});

test("planner still prunes immediate reversal of one explicit resource across selector families", async () => {
  const result = await plan([edge(A, B, "resource:shared"), edge(B, A, "resource:shared", {
    adapterId: "execution:0xaabbccdd:static-words-4:call", instanceKey: "another-selector-instance", executionVariantKey: "another-selector-variant",
  })]);
  assert.equal(result.plans.length, 0); assert.equal(result.diagnostic?.classification, "only_immediate_same_pool_reverse");
});

test("planner keeps different issued execution variants even when target resource and token pair are the same", async () => {
  const first = edge(A, B, "resource:shared", { instanceKey: "first-parameter-instance", executionVariantKey: "first-parameter-binding" });
  const second = edge(A, B, "resource:shared", { instanceKey: "second-parameter-instance", executionVariantKey: "second-parameter-binding" });
  const result = await plan([first, second, edge(B, A, "resource:return", { target: OTHER })]);
  assert.equal(result.plans.length, 2, "tokenPathKey must not collapse distinct issued parameter bindings");
  assert.deepEqual(new Set(result.plans.map(item => item.tokenPath.edges[0]!.instanceKey)),
    new Set([first.instanceKey, second.instanceKey]));
});

test("planner preserves old target and pool-id reversal rules when resource keys are absent", async () => {
  const legacySame = await plan([edge(A, B), edge(B, A)]); assert.equal(legacySame.plans.length, 0);
  const legacyDistinct = await plan([edge(A, B, undefined, { poolId: h(1) }), edge(B, A, undefined, { poolId: h(2) })]);
  assert.equal(legacyDistinct.plans.length, 1);
  const legacySamePool = await plan([edge(A, B, undefined, { poolId: h(1) }), edge(B, A, undefined, { poolId: h(1) })]);
  assert.equal(legacySamePool.plans.length, 0);
});

test("a composite route intersects a single pool while disjoint paths can share an execution router", async () => {
  const composite = edge(A, B, "router-summary", { stateResourceKeys: ["physical:curve", "physical:vault"] });
  const shared = await plan([composite, edge(B, A, "physical:curve", { target: OTHER })]);
  assert.equal(shared.plans.length, 0);
  assert.equal(shared.diagnostic?.pruned_immediate_same_pool_reverse, 1);
  const separate = await plan([composite, edge(B, A, "router-summary", {
    stateResourceKeys: ["physical:other-curve", "physical:other-vault"] })]);
  assert.equal(separate.plans.length, 1, "plural physical resources are complete; a shared router summary is not liquidity");
});

test("amount propagation requires the full prefix when different selector instances share one explicit resource", async () => {
  const f = await propagate([edge(A, B, "resource:shared", { instanceKey: "selector-one" }),
    edge(B, C, "resource:other", { target: OTHER, instanceKey: "independent-middle" }),
    edge(C, A, "resource:shared", { adapterId: "execution:0xaabbccdd:static-words-4:call", instanceKey: "selector-two" })]);
  assert.deepEqual(f.result.amounts, [100n, 107n, 114n, 121n]);
  assert.deepEqual(f.inputs.map(input => input.priorQuotes?.length), [0, 1, 2]);
  assert.equal(f.inputs[2]!.priorQuotes![0], f.handles[0]); assert.equal(f.inputs[2]!.priorQuotes![1], f.handles[1]);
});

test("different explicit resources override coincident legacy instance keys and keep independent source-state quotes", async () => {
  const f = await propagate([edge(A, B, "resource:one", { instanceKey: "same-old-instance" }),
    edge(B, A, "resource:two", { instanceKey: "same-old-instance" })]);
  assert(f.inputs.every(input => input.priorQuotes === undefined));
});

test("partial composite-resource reuse requires the complete prefix in either order", async () => {
  for (const compositeFirst of [true, false]) {
    const first = edge(A, B, compositeFirst ? "composite-summary" : "physical:vault", {
      ...(compositeFirst ? { stateResourceKeys: ["physical:curve", "physical:vault"] } : {}), instanceKey: "entry:first" });
    const last = edge(C, A, compositeFirst ? "physical:vault" : "composite-summary", { target: OTHER,
      ...(compositeFirst ? {} : { stateResourceKeys: ["physical:curve", "physical:vault"] }), instanceKey: "entry:last" });
    const result = await propagate([first, edge(B, C, "physical:independent"), last]);
    assert.deepEqual(result.inputs.map(input => input.priorQuotes?.length), [0, 1, 2]);
    await assert.rejects(propagate([first, edge(B, C, "physical:independent"), last], session(true)),
      error => error instanceof SequentialQuoteUnsupportedError);
  }
});

test("a shared-resource route without sequential support fails instead of independently quoting its later leg", async () => {
  const recorder = session(true), edges = [edge(A, B, "resource:shared", { instanceKey: "first" }),
    edge(B, A, "resource:shared", { instanceKey: "second", adapterId: "execution:0xaabbccdd:static-words-4:call" })];
  await assert.rejects(propagate(edges, recorder), error => error instanceof SequentialQuoteUnsupportedError);
  assert.equal(recorder.inputs.length, 2); assert.equal(recorder.inputs[1]!.priorQuotes?.length, 1);
});

test("legacy instance policy stays intact and mixed same-target resources conservatively require a prefix", async () => {
  const repeated = await propagate([edge(A, B, undefined, { instanceKey: "legacy-shared" }), edge(B, A, undefined, { instanceKey: "legacy-shared" })]);
  assert.deepEqual(repeated.inputs.map(input => input.priorQuotes?.length), [0, 1]);
  const distinct = await propagate([edge(A, B, undefined, { instanceKey: "legacy-one" }), edge(B, A, undefined, { instanceKey: "legacy-two" })]);
  assert(distinct.inputs.every(input => input.priorQuotes === undefined));
  for (const explicitFirst of [true, false]) {
    const first = edge(A, B, explicitFirst ? "resource:new" : undefined, { instanceKey: "mixed-first" });
    const second = edge(B, A, explicitFirst ? undefined : "resource:new", { instanceKey: "mixed-second" });
    const sameTarget = await propagate([first, second]);
    assert.deepEqual(sameTarget.inputs.map(input => input.priorQuotes?.length), [0, 1]);
    const separateTarget = await propagate([first, { ...second, target: OTHER }]);
    assert(separateTarget.inputs.every(input => input.priorQuotes === undefined));
    const sharedLegacyIdentity = await propagate([{ ...first, instanceKey: "still-shared" },
      { ...second, target: OTHER, instanceKey: "still-shared" }]);
    assert.deepEqual(sharedLegacyIdentity.inputs.map(input => input.priorQuotes?.length), [0, 1]);
  }
});
