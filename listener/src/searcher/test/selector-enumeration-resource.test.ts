import assert from "node:assert/strict";
import test from "node:test";
import { ADDR } from "../../shared/constants/addresses.js";
import { buildBlockScanEthView } from "../blockscan-eth-view.js";
import { protocolRepeatEligible, scanBlockStateFromResolvedMids, type ResolvedBlockScanQuote } from "../detector/blockscan-scanner-core.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";

// Public production ETH projection and scanner; no forced route, private
// fingerprint import, protocol registry, network or synthetic enumeration.
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const WETH = ADDR.WETH.toLowerCase(), TOKEN = address(101), MANAGER = address(201);
function edge(input: { from: string; to: string; resource: string; instance: string; variant: string; selector?: string; target?: string }): TokenEdge {
  return Object.freeze({ adapterId: `execution:${input.selector ?? "0x11223344"}:static-words-3:call`,
    target: input.target ?? MANAGER, tokenIn: input.from, tokenOut: input.to,
    stateResourceKey: input.resource, instanceKey: input.instance, executionVariantKey: input.variant,
    slotKind: "protocol", protocolAction: "convert", ...deriveEdgeTaxonomy("protocol", "convert") });
}
function mids(edges: readonly TokenEdge[]): Map<string, ResolvedBlockScanQuote> {
  return new Map(edges.map(e => [blockScanEdgeKey(e), { kind: "protocol", pool: e.instanceKey!, edges: [e],
    mid: e.tokenIn === WETH ? 2 : 1, feeBps: 0, depthProxy: 0,
    quoteAmountIn: 100n, quoteAmountOut: e.tokenIn === WETH ? 200n : 100n }]));
}
function scan(edges: readonly TokenEdge[], allowRepeatedPools: boolean, ethView?: ReturnType<typeof buildBlockScanEthView>,
  maxHops = 2, enumerationMethod: "joint-dfs" | "dfs" | "layered" = "joint-dfs") {
  return scanBlockStateFromResolvedMids({ edges: [...edges], mids: mids(edges), sourceBlock: 100, swapTouched: null,
    ...(ethView ? { ethView } : {}), cfg: { enumerationBackend: "typescript", enumerationMethod,
      allowRepeatedPools, allowRepeatedTokens: false, deduplicateRotations: true, prefixPruningEnabled: false,
      hopPoolsPerPair: 0, hopTokensPerStep: 0, ethSignalPairsPerToken: 100,
      maxHops, minSpreadBps: 1, maxCandidates: 100, budgetMs: 5000,
      pricedTokens: new Map([[WETH, { maxBorrow: 100_000n }]]) } });
}

test("different selectors sharing one resource obey the production repeated-pool switch", () => {
  const edges = [
    edge({ from: WETH, to: TOKEN, resource: "execution-resource:shared", instance: "selector-A-parameters", variant: "call-A", selector: "0x11223344" }),
    edge({ from: TOKEN, to: WETH, resource: "execution-resource:shared", instance: "selector-B-parameters", variant: "call-B", selector: "0x55667788" }),
  ];
  const view = buildBlockScanEthView(edges, mids(edges), 100, true);
  assert.equal(view.quotes.length, 2);
  assert.deepEqual(new Set(view.quotes.map(q => q.instance)), new Set(["execution-resource:shared"]));
  assert.equal(scan(edges, false).opportunities.length, 0);
  assert.equal(scan(edges, true).opportunities.length, 1);
  assert.equal(scan(edges, false, view).opportunities.length, 0, "a permissive precomputed ETH view cannot override scanner policy");
});

test("same target and token pair with distinct resources survive scanner route deduplication", () => {
  const first = edge({ from: WETH, to: TOKEN, resource: "execution-resource:pool-A", instance: "pool-A-instance", variant: "shared-call" });
  const second = edge({ from: WETH, to: TOKEN, resource: "execution-resource:pool-B", instance: "pool-B-instance", variant: "shared-call" });
  const close = edge({ from: TOKEN, to: WETH, resource: "execution-resource:close", instance: "close-instance", variant: "close-call", target: address(202) });
  const edges = [first, second, close], result = scan(edges, false);
  assert.equal(result.outcome, "ran"); assert.equal(result.selection.forcedSelectionCount, 0);
  assert.equal(result.opportunities.length, 2);
  assert.deepEqual(new Set(result.opportunities.map(o => blockScanEdgeKey(o.seedEdges[0]!))), new Set([blockScanEdgeKey(first), blockScanEdgeKey(second)]));
});

test("different execution variants of one resource are not merged by directed route fingerprints", () => {
  const first = edge({ from: WETH, to: TOKEN, resource: "execution-resource:shared", instance: "one-instance", variant: "parameter-binding-A" });
  const second = edge({ from: WETH, to: TOKEN, resource: "execution-resource:shared", instance: "one-instance", variant: "parameter-binding-B" });
  const close = edge({ from: TOKEN, to: WETH, resource: "execution-resource:close", instance: "close-instance", variant: "close-call", target: address(202) });
  const edges = [first, second, close], view = buildBlockScanEthView(edges, mids(edges), 100, false);
  assert.equal(view.quotes.length, 3, "the observed variants remain separate edges");
  assert.equal(new Set(view.quotes.filter(q => q.tokenIn === WETH).map(q => q.instance)).size, 1, "resource identity remains shared");
  const result = scan(edges, false, view);
  assert.equal(result.opportunities.length, 2, "unlimited variant enumeration must not conflate execution bindings");
  assert.deepEqual(new Set(result.opportunities.map(o => o.seedEdges[0]!.executionVariantKey)), new Set(["parameter-binding-A", "parameter-binding-B"]));
});

test("composite resource overlap obeys scanner policy even with a permissive precomputed view", () => {
  const composite = { ...edge({ from: WETH, to: TOKEN, resource: "router-summary", instance: "composite", variant: "path" }),
    stateResourceKeys: ["physical:curve", "physical:vault"] };
  const single = edge({ from: TOKEN, to: WETH, resource: "physical:vault", instance: "single", variant: "withdraw", target: address(202) });
  const edges = [composite, single], permissive = buildBlockScanEthView(edges, mids(edges), 100, true);
  assert.equal(scan(edges, false).opportunities.length, 0);
  assert.equal(scan(edges, false, permissive).opportunities.length, 0);
  assert.equal(scan(edges, true, permissive).opportunities.length, 1);
  const disjoint = { ...single, stateResourceKey: "router-summary", stateResourceKeys: ["physical:other-vault"] };
  assert.equal(scan([composite, disjoint], false).opportunities.length, 1, "same execution router does not merge disjoint resource sets");
});

test("all TypeScript enumeration methods reject internal partial resource reuse before candidate ranking", () => {
  const third = address(103);
  const composite = { ...edge({ from: WETH, to: TOKEN, resource: "composite", instance: "composite", variant: "path" }),
    stateResourceKeys: ["physical:curve", "physical:vault"] };
  const middle = edge({ from: TOKEN, to: third, resource: "physical:middle", instance: "middle", variant: "middle", target: address(202) });
  const close = edge({ from: third, to: WETH, resource: "physical:curve", instance: "single", variant: "close", target: address(203) });
  const edges = [composite, middle, close];
  for (const method of ["joint-dfs", "dfs", "layered"] as const) {
    assert.equal(scan(edges, false, undefined, 3, method).opportunities.length, 0, method);
    assert.equal(scan(edges, true, undefined, 3, method).opportunities.length, 1, method);
    assert.equal(scan([composite, middle, { ...close, stateResourceKey: "physical:independent" }], false, undefined, 3, method).opportunities.length, 1, method);
  }
  const priorView = buildBlockScanEthView(edges, mids(edges), 100, true);
  const missingResourceMetadata = { ...priorView, allowRepeatedPools: false,
    quotes: priorView.quotes.map(({ resources: _resources, ...quote }) => quote) };
  assert.equal(scan(edges, false, missingResourceMetadata, 3).opportunities.length, 0,
    "actual Graph resources cannot be erased by an older precomputed quote projection");
});

test("protocol token-repeat policy recognizes the same resource across selector instances", () => {
  const thirdToken = address(102), first = edge({ from: WETH, to: TOKEN, resource: "execution-resource:shared",
    instance: "selector-A-instance", variant: "call-A", selector: "0x11223344" });
  const middle = edge({ from: TOKEN, to: thirdToken, resource: "execution-resource:middle", instance: "middle-instance", variant: "middle-call", target: address(203) });
  const reenter = edge({ from: thirdToken, to: TOKEN, resource: "execution-resource:shared",
    instance: "selector-B-instance", variant: "call-B", selector: "0x55667788" });
  const close = edge({ from: TOKEN, to: WETH, resource: "execution-resource:close", instance: "close-instance", variant: "close-call", target: address(202) });
  assert.equal(protocolRepeatEligible([first, middle, reenter, close]), false,
    "a second selector cannot hide already used state when reintroducing TOKEN");
  assert.equal(protocolRepeatEligible([first, middle, { ...reenter, stateResourceKey: "execution-resource:distinct" }, close]), true,
    "a separate protocol resource may legitimately reintroduce the token");
  assert.equal(protocolRepeatEligible([{ ...first, stateResourceKey: "composite-summary",
    stateResourceKeys: ["execution-resource:shared", "another-resource"] }, middle, reenter, close]), false,
    "partial overlap with an earlier composite path also prevents a repeated protocol resource");
});
