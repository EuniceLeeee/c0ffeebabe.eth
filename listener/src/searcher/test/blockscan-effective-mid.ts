import assert from "node:assert/strict";
import {
  buildEffectiveMids,
  DEFAULT_EFFECTIVE_WETH_INPUT,
  effectiveEnumerationMids,
  effectiveMidPairStatistics,
  effectiveMidRowCarried,
  type EffectiveMidRow,
  type EffectiveMidSnapshot,
  type EffectivePricingInput,
} from "../blockscan-effective-mid.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { TokenEdge } from "../planner/token-graph.js";
import { blockScanEdgeKey, createVerifiedGraphView } from "../venues/blockscan-state-capability.js";
import type { RouteVenueMid } from "../venues/mid-readers.js";
import type { StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";
import { BlockScanAmountReference } from "../blockscan-amount-reference.js";
import { scannerConsumesEdge } from "../blockscan-pricing-delta.js";
import type { BlockScanOpportunity } from "../detector/detector.js";

// Offline behavior tests only: callbacks are fixtures, not chain-quote evidence
// or full production acceptance. Shapes follow blockscan-amount-reference.ts.
const W = "weth", U = "usdc";
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const SOURCE = Object.freeze({ number: 42, hash: hash(0xabcdef), generation: 7 });
const DEFAULT_RAW = 10_000_000_000_000_000n; // Independent expectation: 0.01 ETH in wei.
type BuildInput = Parameters<typeof buildEffectiveMids>[0];
type Quote = BuildInput["quote"];
type QuoteInput = Parameters<Quote>[0];
type QuoteResult = Awaited<ReturnType<Quote>>;
type PriceRow = readonly [TokenEdge, number, number?];

function edge(a: string, b: string, id: string, instanceKey = id): TokenEdge {
  return {
    tokenIn: a, tokenOut: b, adapterId: "test-swap", target: id,
    instanceKey, executionVariantKey: id,
    canonicalEdgeId: id as TokenEdge["canonicalEdgeId"],
    slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
  };
}

function graphAt(edges: readonly TokenEdge[], source: EffectiveMidSnapshot["source"]) {
  return createVerifiedGraphView({
    id: `effective-mid-${source.number}-${source.generation}`,
    sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation,
    completenessWatermark: source.number,
    perSourceCoverage: [{
      familyId: "test-swap", sourceId: "effective-mid-fixture", sourceFingerprint: "offline-fixture",
      completeThroughBlock: source.number, completeThroughHash: source.hash,
    }],
    edges,
  });
}

function pricing(rows: readonly PriceRow[]): EffectivePricingInput {
  const mids = new Map<string, RouteVenueMid>(rows.map(([e, mid, feeBps = 0]) => [blockScanEdgeKey(e), {
    edges: [e], kind: "external-swap", pool: e.target, mid, feeBps, depthProxy: 1,
  }]));
  return {
    sourceBlock: SOURCE.number, sourceBlockHash: SOURCE.hash, generation: SOURCE.generation,
    graph: { edges: rows.map(([e]) => e) },
    pricingStateKeyByEdgeKey: new Map(rows.filter(([e]) => !e.leavesStandingPosition)
      .map(([e]) => [blockScanEdgeKey(e), e.instanceKey ?? e.target])),
    coverage: { resolvedEdgeKeys: rows.map(([e]) => blockScanEdgeKey(e)) },
    mids,
  };
}

function build(prices: EffectivePricingInput, overrides: Partial<BuildInput> = {}) {
  return buildEffectiveMids({
    pricing: prices, weth: W, gasCostWei: null, enumerationSpreadBps: 200,
    control: {}, concurrency: 2,
    quote: async ({ amountIn }) => ({ source: SOURCE, amountIn, amountOut: amountIn * 7n }),
    ...overrides,
  });
}

function row(snapshot: EffectiveMidSnapshot, e: TokenEdge): EffectiveMidRow {
  const found = snapshot.rows.get(blockScanEdgeKey(e));
  assert(found, `missing row for ${blockScanEdgeKey(e)}`);
  return found;
}

function noQuote(r: EffectiveMidRow, status: EffectiveMidRow["status"]) {
  assert.equal(r.status, status, r.edgeId);
  assert.equal(r.amountOut, null, `${r.edgeId}: no fabricated output`);
  assert.equal(r.effectiveMid, null, `${r.edgeId}: no fallback to the sizing mark`);
}

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, run: () => void | Promise<void>) => { tests.push([name, run]); };

test("declared standing-position pricing shares Exact but does not grant scanner admission", async () => {
  const graph = graphAt([{ ...edge(W, U, "credit"), slotKind: "lend" as const,
    edgeKind: "credit" as const, leavesStandingPosition: true }], SOURCE);
  const credit = graph.edges[0]!;
  const prices = pricing([[credit, 2], [edge(W, U, "spot"), 2]]);
  const declared = { ...prices, pricingStateKeyByEdgeKey: new Map([[blockScanEdgeKey(credit), "credit"]]) };
  let calls = 0;
  const effective = await build(declared, { quoteGraph: graph, quote: async input => {
    calls++; assert.equal(input.amountIn, DEFAULT_RAW);
    return { source: SOURCE, amountIn: input.amountIn, amountOut: 12_345n };
  } });
  assert.equal(calls, 1);
  assert.equal(row(effective, credit).amountOut, 12_345n);
  assert.equal(row(effective, credit).status, "quoted");
  assert.equal(scannerConsumesEdge(credit), false);
  assert.equal(graph.scannerEdgeCount, 0);
  const unsupported = await build(prices);
  noQuote(row(unsupported, credit), "unsupported");
});

for (const gasCostWei of [null, 100_000_000_000_000n]) {
  test(`${gasCostWei === null ? "default 0.01 ETH" : "gas at 200 bps"}: every input token, three hops and raw units`, async () => {
    const rows: PriceRow[] = [
      // Deliberately order the four-hop chain backwards to catch in-pass propagation.
      [edge("z", "y", "z-y"), 4], [edge("y", "x", "y-x"), 3],
      [edge("x", "USDC", "x-u"), 2], [edge("USDC", "WETH", "u-w"), 5e8],
      [edge(W, U, "w-u"), 2e-9],
      [edge(U, "output-only", "u-output"), 987_654_321],
      [edge(W, "reverse-only", "w-reverse"), 1],
      [edge("reverse-only", "output-only", "reverse-output"), 1],
      [edge("disconnected", "output-only", "disconnected"), 1],
      [edge("fee", W, "fee-w"), 100, 100],
      [edge("fee2", "fee", "fee2-fee"), 2, 500],
      [edge("third", W, "third-w"), 3],
      [edge("large-unit", W, "large-w"), 1e16],
      [edge("tiny-unit", W, "tiny-w"), 1e-20],
    ];
    // Independent expected values, not calls back into the amount-reference helper.
    const expected = new Map<string, bigint | null>(gasCostWei === null ? [
      [W, DEFAULT_RAW], [U, 20_000_000n], ["x", 10_000_000n], ["y", 3_333_334n],
      ["fee", (DEFAULT_RAW + 98n) / 99n], ["fee2", (DEFAULT_RAW * 10n + 1880n) / 1881n],
      ["third", 3_333_333_333_333_334n], ["large-unit", 1n], ["tiny-unit", 10n ** 36n],
      ["z", null], ["reverse-only", null], ["disconnected", null],
    ] : [
      [W, 5_000_000_000_000_001n], [U, 10_000_001n], ["x", 5_000_001n], ["y", 1_666_667n],
      ["fee", 5_000_000_000_000_000n / 99n + 1n],
      ["fee2", 50_000_000_000_000_000n / 1881n + 1n],
      ["third", 1_666_666_666_666_667n], ["large-unit", 1n], ["tiny-unit", 5n * 10n ** 35n + 1n],
      ["z", null], ["reverse-only", null], ["disconnected", null],
    ]);
    const prices = pricing(rows);
    const controller = new AbortController();
    const control = { signal: controller.signal };
    const calls: QuoteInput[] = [];
    const snapshot = await build(prices, {
      gasCostWei, control, weth: "WETH", concurrency: 3,
      quote: async call => {
        calls.push(call);
        // Deliberately unrelated to each mark and its fee; only this output may be published.
        return { source: SOURCE, amountIn: call.amountIn, amountOut: call.amountIn * 7n + 1n };
      },
    });
    assert.equal(DEFAULT_EFFECTIVE_WETH_INPUT, DEFAULT_RAW);
    assert.equal(snapshot.reference, gasCostWei === null ? "default" : "gas");
    assert.equal(snapshot.referenceWethInput, expected.get(W));
    assert.equal(snapshot.complete, true);
    assert.deepEqual(snapshot.source, SOURCE);
    const opportunities = rows.map(([e]) => ({ seedEdges: [e], flashToken: e.tokenIn } as BlockScanOpportunity));
    const exactInputs = new BlockScanAmountReference().prepare({
      pricing: { ...prices, effectiveMids: snapshot }, opportunities,
    });
    for (const [index, candidate] of opportunities.entries()) {
      const amount = row(snapshot, rows[index]![0]).amountIn;
      assert.equal(exactInputs.get(candidate), amount ?? undefined,
        "Exact must reuse effective's default/gas input, including converted tokens and sub-ten raw units");
    }
    assert.equal(snapshot.rows.size, rows.length);
    assert.deepEqual([...snapshot.rows.keys()], [...prices.mids.keys()]);
    assert(Number.isFinite(snapshot.wallMs) && snapshot.wallMs >= 0);
    assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.source));
    const quotedIds = new Set<string>();
    for (const [e] of rows) {
      const r = row(snapshot, e);
      const token = e.tokenIn.toLowerCase();
      assert(expected.has(token));
      const amount = expected.get(token)!;
      assert.equal(r.amountIn, amount, token);
      assert.equal(r.tokenIn, token);
      assert.equal(r.tokenOut, e.tokenOut.toLowerCase());
      assert.equal(r.instanceKey, e.instanceKey);
      assert(Object.isFrozen(r));
      if (amount === null) noQuote(r, "missing-valuation");
      else {
        quotedIds.add(r.edgeId);
        assert.equal(r.status, "quoted");
        assert.equal(r.amountOut, amount * 7n + 1n);
        assert.equal(r.effectiveMid, Number(amount * 7n + 1n) / Number(amount));
      }
    }
    assert.equal(calls.length, quotedIds.size, "one quote per valued direction");
    assert.deepEqual(new Set(calls.map(c => blockScanEdgeKey(c.edge))), quotedIds);
    for (const call of calls) {
      assert.strictEqual(call.control, control);
      assert.equal(Object.hasOwn(call, "requireChainAmountQuote"), false);
      assert.strictEqual(call.edge, rows.find(([e]) => e === call.edge)![0]);
      assert.equal(call.amountIn, expected.get(call.edge.tokenIn.toLowerCase()), "explicit Exact input preserved");
    }
  });
}

test("gas reference replaces the default even when smaller; threshold and strict rounding apply", async () => {
  const e = edge(W, U, "gas");
  const prices = pricing([[e, 2e-9]]);
  const small = await build(prices, { gasCostWei: 1n });
  assert.equal(small.referenceWethInput, 51n);
  assert.equal(row(small, e).amountIn, 51n);
  const wider = await build(prices, { gasCostWei: 100_000_000_000_000n, enumerationSpreadBps: 500 });
  assert.equal(wider.referenceWethInput, 2_000_000_000_000_001n);
  assert.equal(row(wider, e).amountIn, 2_000_000_000_000_001n);
});

test("effective leaves original Exact method selection unset and preserves its returned output", async () => {
  const e = edge(W, U, "original-exact"), prices = pricing([[e, 123]]);
  const control = { signal: new AbortController().signal };
  const runtimeEvidence = Object.freeze([]);
  const calls: Parameters<StrictProductionRuntimeSession["issueExact"]>[0][] = [];
  const session = {
    async issueExact(input: Parameters<StrictProductionRuntimeSession["issueExact"]>[0]) {
      calls.push(input);
      assert.notEqual(input.requireChainAmountQuote, true, "fixture's original method is not chain-only");
      return { source: SOURCE, amountIn: input.amountIn, amountOut: input.amountIn * 13n + 17n };
    },
  };
  for (const requireChainAmountQuote of [undefined, false]) {
    const result = await build(prices, { control, quote: call => {
      assert.deepEqual(Object.keys(call).sort(), ["amountIn", "control", "edge"]);
      return session.issueExact({ ...call, executor: "fixture-executor", runtimeEvidence,
        ...(requireChainAmountQuote === undefined ? {} : { requireChainAmountQuote }) });
    } });
    assert.equal(result.complete, true);
    assert.equal(row(result, e).status, "quoted");
    assert.equal(row(result, e).amountOut, DEFAULT_RAW * 13n + 17n);
    assert.deepEqual(row(result, e).quotedAt, SOURCE);
  }
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.strictEqual(call.edge, e);
    assert.strictEqual(call.control, control);
    assert.strictEqual(call.runtimeEvidence, runtimeEvidence);
    assert.equal(call.amountIn, DEFAULT_RAW);
  }
});

test("one immutable sizing pass; best available rates on shortest paths", async () => {
  const direct = edge(U, W, "u-direct", "one");
  const rows: PriceRow[] = [
    [direct, 2], [edge(U, W, "u-variant", "one"), 100],
    [edge(U, W, "u-second", "two"), 3], [edge(U, W, "u-third", "three"), 4],
    [edge(U, "x", "longer"), 100], [edge("x", W, "x-direct"), 100],
    [edge("linked", U, "linked-u"), 2],
  ];
  const prices = pricing(rows);
  const mids = prices.mids as Map<string, RouteVenueMid>;
  const original = mids.get(blockScanEdgeKey(direct))!;
  const snapshot = await build(prices, {
    concurrency: 1,
    quote: async ({ amountIn }) => {
      mids.set(blockScanEdgeKey(direct), { ...original, mid: 1e30 });
      return { source: SOURCE, amountIn, amountOut: amountIn * 11n };
    },
  });
  for (const [e] of rows) {
    const expected = e.tokenIn === "linked" ? DEFAULT_RAW / 200n : DEFAULT_RAW / 100n;
    assert.equal(row(snapshot, e).amountIn, expected, "later mid changes cannot reprice this pass");
    assert.equal(row(snapshot, e).effectiveMid, 11);
  }
});

test("unresolved, invalid, absent and standing-position marks cannot manufacture valuations", async () => {
  const rows: PriceRow[] = [
    ...[0, -1, NaN, Infinity].map((mid, i): PriceRow => [edge(`bad-mid-${i}`, W, `bad-mid-${i}`), mid]),
    ...[-1, 10_000, NaN, Infinity].map((fee, i): PriceRow => [edge(`bad-fee-${i}`, W, `bad-fee-${i}`), 1, fee]),
    [edge("unresolved", W, "unresolved"), 1],
    [edge("dependent", "unresolved", "dependent"), 1],
    [{ ...edge("standing", W, "standing"), leavesStandingPosition: true }, 1],
    [edge("self-only", "self-only", "self-only"), 1],
  ];
  const absent = edge("absent", W, "absent");
  const original = pricing([...rows, [absent, 1]]);
  const prices: EffectivePricingInput = {
    ...original,
    mids: new Map([...original.mids].filter(([key]) => key !== blockScanEdgeKey(absent))),
    coverage: {
      ...original.coverage,
      resolvedEdgeKeys: original.coverage.resolvedEdgeKeys.filter(key => key !== "unresolved"),
    },
  };
  let calls = 0;
  const snapshot = await build(prices, { quote: async () => { calls++; throw new Error("unexpected quote"); } });
  assert.equal(calls, 0);
  assert.equal(snapshot.rows.size, rows.length);
  assert.equal(snapshot.rows.has(blockScanEdgeKey(absent)), false, "no row without a ready mid");
  for (const r of snapshot.rows.values()) {
    assert.equal(r.amountIn, null);
    noQuote(r, r.edgeId === "standing" ? "unsupported" : "missing-valuation");
  }
  assert.equal(snapshot.complete, true, "complete means work finished, not every direction quoted");
});

test("unsupported, thrown errors and zero output stay distinct; positive coarse marks are never fake quotes", async () => {
  const standing = { ...edge(W, U, "standing"), leavesStandingPosition: true };
  const ids = ["unsupported", "error", "string", "null", "wrong-code", "zero", "negative", "overflow", "good"];
  const edges = [standing, ...ids.map(id => edge(W, U, id))];
  const calls: string[] = [];
  const snapshot = await build(pricing(edges.map(e => [e, 999, 100])), {
    quote: async ({ edge: e, amountIn }) => {
      calls.push(e.target);
      switch (e.target) {
        case "unsupported": throw Object.assign(new Error("no chain amount quote"), { code: "CHAIN_AMOUNT_QUOTE_UNAVAILABLE" });
        case "error": throw new Error("fixture failure");
        case "string": throw "fixture string rejection";
        case "null": throw null;
        case "wrong-code": throw { code: "chain_amount_quote_unavailable" };
        case "zero": return { source: SOURCE, amountIn, amountOut: 0n };
        case "negative": return { source: SOURCE, amountIn, amountOut: -1n };
        case "overflow": return { source: SOURCE, amountIn, amountOut: 10n ** 400n };
        default: return { source: SOURCE, amountIn, amountOut: amountIn * 2n };
      }
    },
  });
  assert.deepEqual(new Set(calls), new Set(ids));
  assert.equal(calls.length, ids.length);
  for (const e of edges) {
    const r = row(snapshot, e);
    assert.equal(r.amountIn, DEFAULT_RAW);
    if (e.target === "good") {
      assert.equal(r.status, "quoted");
      assert.equal(r.amountOut, DEFAULT_RAW * 2n);
      assert.equal(r.effectiveMid, 2, "do not apply the coarse fee a second time");
    } else if (e.target === "zero") {
      assert.equal(r.status, "no-output");
      assert.equal(r.amountOut, 0n, "a measured zero is different from unavailable output");
      assert.equal(r.effectiveMid, null);
    } else noQuote(r, ["standing", "unsupported"].includes(e.target) ? "unsupported" : "quote-failed");
  }
  assert.equal(snapshot.complete, true);
  assert.deepEqual(effectiveMidPairStatistics(snapshot), {
    directions: 10, quoted: 1,
    byStatus: { unsupported: 2, "quote-failed": 6, "no-output": 1, quoted: 1 },
    comparablePairs: 0, pairsAboveThreshold: 0, thresholdBps: 100,
  });
});

test("returned source number, hash, generation and explicit amount must all match", async () => {
  const variants: [string, (amount: bigint) => Partial<QuoteResult>][] = [
    ["number", () => ({ source: { ...SOURCE, number: SOURCE.number - 1 } })],
    ["hash", () => ({ source: { ...SOURCE, hash: hash(99) } })],
    ["generation", () => ({ source: { ...SOURCE, generation: SOURCE.generation + 1 } })],
    ["amount", amount => ({ amountIn: amount + 1n })],
    ["missing-source", () => ({ source: undefined } as unknown as Partial<QuoteResult>)],
  ];
  const e = edge(W, U, "source");
  for (const [label, change] of variants) {
    let calls = 0;
    const snapshot = await build(pricing([[e, 2]]), {
      quote: async ({ amountIn }) => {
        calls++;
        return { source: SOURCE, amountIn, amountOut: amountIn * 2n, ...change(amountIn) };
      },
    });
    assert.equal(calls, 1, label);
    noQuote(row(snapshot, e), "quote-failed");
    assert.equal(row(snapshot, e).amountIn, DEFAULT_RAW);
    assert.deepEqual(snapshot.source, SOURCE);
  }
  const prices = { ...pricing([[e, 2]]), sourceBlockHash: SOURCE.hash.toUpperCase() };
  const same = await build(prices, {
    quote: async ({ amountIn }) => ({ source: { ...SOURCE, hash: SOURCE.hash.toUpperCase() }, amountIn, amountOut: 23n }),
  });
  assert.equal(row(same, e).status, "quoted", "hash casing is not a source mismatch");
  assert.deepEqual(same.source, SOURCE);
  const nextSource = { number: SOURCE.number + 1, hash: hash(0xfedcba), generation: SOURCE.generation + 1 };
  const next = await build({
    ...prices, sourceBlock: nextSource.number, sourceBlockHash: nextSource.hash, generation: nextSource.generation,
  }, { quote: async ({ amountIn }) => ({ source: nextSource, amountIn, amountOut: 41n }) });
  assert.equal(row(next, e).amountOut, 41n);
  assert.deepEqual(next.source, nextSource);
  assert.equal(row(same, e).amountOut, 23n, "later builds do not mutate earlier rows");
  assert.deepEqual(same.source, SOURCE);
});

test("explicit raw amounts below the probe floor and above safe integers reach Exact unchanged", async () => {
  const edges = [edge("huge-value", W, "one-raw"), edge("tiny-value", W, "big-raw")];
  const calls: bigint[] = [];
  const snapshot = await build(pricing([[edges[0]!, 1e16], [edges[1]!, 1e-20]]), {
    quote: async ({ amountIn }) => {
      calls.push(amountIn);
      return { source: SOURCE, amountIn, amountOut: amountIn + 17n };
    },
  });
  assert.deepEqual(calls, [1n, DEFAULT_RAW * 10n ** 20n]);
  for (let i = 0; i < edges.length; i++) {
    const r = row(snapshot, edges[i]!);
    assert.equal(r.status, "quoted");
    assert.equal(r.amountIn, calls[i]);
    assert.equal(r.amountOut, calls[i]! + 17n, "bigint output must not round through Number");
  }
});

test("positive output with an unrepresentable effective rate fails closed; measured zero is retained", async () => {
  const e = edge("tiny", W, "tiny");
  for (const amountOut of [1n, 0n]) {
    const snapshot = await build(pricing([[e, 1e-300]]), {
      quote: async ({ amountIn }) => ({ source: SOURCE, amountIn, amountOut }),
    });
    assert.equal(row(snapshot, e).amountIn, DEFAULT_RAW * 10n ** 300n);
    if (amountOut > 0n) noQuote(row(snapshot, e), "quote-failed");
    else {
      assert.equal(row(snapshot, e).status, "no-output");
      assert.equal(row(snapshot, e).amountOut, 0n);
      assert.equal(row(snapshot, e).effectiveMid, null);
    }
  }
});

test("abort and deadline before work prevent every quote", async () => {
  const originalNow = Date.now;
  Date.now = () => 1000;
  try {
    const controller = new AbortController();
    controller.abort();
    const controls: BuildInput["control"][] = [
      { signal: controller.signal }, { deadlineAtMs: 999 }, { deadlineAtMs: 1000 },
    ];
    const prices = pricing([0, 1, 2].map(i => [edge(W, U, `cancel-${i}`), 999]));
    for (const control of controls) {
      let calls = 0;
      const snapshot = await build(prices, {
        control, concurrency: 10,
        quote: async () => { calls++; throw new Error("unexpected quote"); },
      });
      assert.equal(calls, 0);
      assert.equal(snapshot.complete, false);
      assert.equal(snapshot.wallMs, 0);
      assert.equal(snapshot.rows.size, 3);
      for (const r of snapshot.rows.values()) {
        assert.equal(r.amountIn, DEFAULT_RAW);
        noQuote(r, "cancelled");
      }
    }
  } finally { Date.now = originalNow; }
});

for (const reason of ["abort", "deadline"] as const) {
  for (const rejects of [false, true]) {
    test(`${reason} during ${rejects ? "rejected" : "successful"} quote discards it and stops queued work`, async () => {
      const originalNow = Date.now;
      let now = 1000;
      Date.now = () => now;
      try {
        const controller = new AbortController();
        const control = { signal: controller.signal, deadlineAtMs: 1100 };
        const edges = ["first", "in-flight", "queued"].map(id => edge(W, U, id));
        const calls: QuoteInput[] = [];
        const snapshot = await build(pricing(edges.map(e => [e, 999])), {
          control, concurrency: 1,
          quote: async call => {
            calls.push(call);
            if (call.edge === edges[1]) {
              if (reason === "abort") controller.abort();
              else now = 1100; // Equality is already expired.
              if (rejects) throw { code: "CHAIN_AMOUNT_QUOTE_UNAVAILABLE" };
            }
            return { source: SOURCE, amountIn: call.amountIn, amountOut: 123n };
          },
        });
        assert.deepEqual(calls.map(c => c.edge), edges.slice(0, 2));
        for (const call of calls) assert.strictEqual(call.control, control);
        assert.equal(row(snapshot, edges[0]!).status, "quoted");
        assert.equal(row(snapshot, edges[0]!).amountOut, 123n);
        noQuote(row(snapshot, edges[1]!), "cancelled");
        noQuote(row(snapshot, edges[2]!), "cancelled");
        assert.equal(snapshot.complete, false);
        assert.equal(snapshot.wallMs, reason === "deadline" ? 100 : 0);
        assert.equal(effectiveMidPairStatistics(snapshot).quoted, 1);
      } finally { Date.now = originalNow; }
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("bounded concurrent quotes can finish out of order while rows retain input order", async () => {
  const edges = [0, 1, 2, 3].map(i => edge(W, U, `concurrent-${i}`));
  const pending = edges.map(() => deferred<QuoteResult>());
  const started = edges.map(() => deferred<void>());
  const calls: QuoteInput[] = [];
  let active = 0, peak = 0;
  const promise = build(pricing(edges.map(e => [e, 1])), {
    concurrency: 2,
    quote: async call => {
      const i = edges.indexOf(call.edge);
      calls.push(call);
      active++;
      peak = Math.max(peak, active);
      started[i]!.resolve();
      try { return await pending[i]!.promise; }
      finally { active--; }
    },
  });
  await Promise.all([started[0]!.promise, started[1]!.promise]);
  assert.equal(calls.length, 2, "queued work cannot exceed concurrency");
  const finish = (i: number) => pending[i]!.resolve({ source: SOURCE, amountIn: DEFAULT_RAW, amountOut: BigInt(i + 1) });
  finish(1);
  await started[2]!.promise;
  finish(2);
  await started[3]!.promise;
  finish(3);
  finish(0);
  const snapshot = await promise;
  assert.equal(peak, 2);
  assert.equal(active, 0);
  assert.equal(calls.length, edges.length);
  assert.deepEqual([...snapshot.rows.keys()], edges.map(blockScanEdgeKey));
  assert.deepEqual([...snapshot.rows.values()].map(r => r.amountOut), [1n, 2n, 3n, 4n]);
  assert([...snapshot.rows.values()].every(r => r.status === "quoted"));
  assert.equal(snapshot.complete, true);
});

test("abort while two quotes are pending discards both late results without starting more", async () => {
  const controller = new AbortController();
  const pending = deferred<QuoteResult>();
  const edges = [0, 1, 2, 3].map(i => edge(W, U, `pending-${i}`));
  const calls: QuoteInput[] = [];
  const promise = build(pricing(edges.map(e => [e, 999])), {
    concurrency: 2, control: { signal: controller.signal },
    quote: async call => { calls.push(call); return pending.promise; },
  });
  assert.equal(calls.length, 2);
  controller.abort();
  pending.resolve({ source: SOURCE, amountIn: DEFAULT_RAW, amountOut: DEFAULT_RAW * 999n });
  const snapshot = await promise;
  assert.equal(calls.length, 2);
  assert.equal(snapshot.rows.size, 4);
  assert.equal(snapshot.complete, false);
  for (const r of snapshot.rows.values()) noQuote(r, "cancelled");
});

function quoted(id: string, tokenIn: string, tokenOut: string, instanceKey: string,
  amountIn: bigint, amountOut: bigint): EffectiveMidRow {
  return { edgeId: id, instanceKey, tokenIn, tokenOut, amountIn, amountOut,
    effectiveMid: Number(amountOut) / Number(amountIn), status: "quoted" };
}

function snapshotOf(rows: readonly EffectiveMidRow[]): EffectiveMidSnapshot {
  return { source: SOURCE, reference: "default", referenceWethInput: DEFAULT_RAW,
    rows: new Map(rows.map(r => [r.edgeId, r])), complete: true, wallMs: 0 };
}

test("pair >1% is strict and evaluated with bigint raw amounts, not rounded rates", () => {
  const scale = 10n ** 35n;
  for (const delta of [-1n, 0n, 1n]) {
    const a = quoted("a", U, W, "venue-a", scale, scale);
    const b = quoted("b", W, U, "venue-b", scale, scale * 101n / 100n + delta);
    assert.equal(b.effectiveMid, 1.01, "Number cannot distinguish these boundary cases");
    const stats = effectiveMidPairStatistics(snapshotOf([a, b]));
    assert.equal(stats.comparablePairs, 1);
    assert.equal(stats.pairsAboveThreshold, delta > 0n ? 1 : 0);
    assert.equal(stats.thresholdBps, 100);
  }
  const equal = snapshotOf([quoted("a", U, W, "a", 100n, 100n), quoted("b", W, U, "b", 100n, 100n)]);
  assert.equal(effectiveMidPairStatistics(equal, 0).pairsAboveThreshold, 0);
  const above = snapshotOf([quoted("a", U, W, "a", 100n, 100n), quoted("b", W, U, "b", 100n, 101n)]);
  assert.equal(effectiveMidPairStatistics(above, 0).pairsAboveThreshold, 1);
  assert.equal(effectiveMidPairStatistics(above, 200).pairsAboveThreshold, 0);
});

test("pair comparison excludes the same instance and finds the next distinct venue after duplicate variants", () => {
  const rows = [
    quoted("a-high", U, W, "same", 10n, 30n),
    quoted("a-variant", U, W, "same", 10n, 29n),
    quoted("a-other", U, W, "other", 10n, 6n),
    quoted("b-high", W, U, "same", 10n, 20n),
  ];
  const sameOnly = effectiveMidPairStatistics(snapshotOf([rows[0]!, rows[1]!, rows[3]!]));
  assert.equal(sameOnly.comparablePairs, 0);
  assert.equal(sameOnly.pairsAboveThreshold, 0);
  for (const ordered of [rows, [...rows].reverse()]) {
    const stats = effectiveMidPairStatistics(snapshotOf(ordered));
    assert.equal(stats.comparablePairs, 1);
    assert.equal(stats.pairsAboveThreshold, 1, "duplicate variants must not crowd out the distinct instance");
  }
  const below = [...rows];
  below[2] = quoted("a-other", U, W, "other", 10n, 5n);
  assert.equal(effectiveMidPairStatistics(snapshotOf(below)).pairsAboveThreshold, 0,
    "a profitable same-instance round trip cannot create a two-venue indication");
});

test("pair counts are unordered token pairs, exclude unavailable/self/one-way rows and do not mutate snapshots", () => {
  const rows: EffectiveMidRow[] = [
    quoted("a1", "a", "b", "v1", 10n, 30n),
    quoted("a2", "a", "b", "v2", 10n, 20n),
    quoted("b1", "b", "a", "v3", 10n, 10n),
    quoted("b2", "b", "a", "v4", 10n, 10n),
    quoted("c", "c", "d", "v5", 100n, 100n),
    quoted("d", "d", "c", "v6", 100n, 101n),
    quoted("one-way", "x", "y", "v7", 1n, 100n),
    quoted("self", "a", "a", "v8", 1n, 100n),
    ...(["missing-valuation", "unsupported", "quote-failed", "no-output", "cancelled"] as const).map((status, i) => ({
      edgeId: `unavailable-${i}`, instanceKey: `v${i + 9}`, tokenIn: "y", tokenOut: "x",
      amountIn: status === "missing-valuation" ? null : 1n,
      amountOut: status === "no-output" ? 0n : null, effectiveMid: null, status,
    })),
  ];
  const snapshot = snapshotOf(rows.map(r => Object.freeze(r)));
  const before = [...snapshot.rows.entries()];
  assert.deepEqual(effectiveMidPairStatistics(snapshot), {
    directions: 13, quoted: 8,
    byStatus: { quoted: 8, "missing-valuation": 1, unsupported: 1, "quote-failed": 1, "no-output": 1, cancelled: 1 },
    comparablePairs: 2, pairsAboveThreshold: 1, thresholdBps: 100,
  });
  assert.deepEqual([...snapshot.rows.entries()], before);
});

test("end-to-end raw USDC/WETH pair uses distinct instances even with a shared execution target", async () => {
  const forward = { ...edge(U, W, "forward", "pool-a"), target: "shared-manager" };
  const reverse = { ...edge(W, U, "reverse", "pool-b"), target: "shared-manager" };
  const snapshot = await build(pricing([[forward, 5e8], [reverse, 2e-9]]), {
    quote: async ({ edge: e, amountIn }) => ({ source: SOURCE, amountIn,
      amountOut: e === forward ? 25_250_000_000_000_000n : 50_025_000n }),
  });
  assert.equal(row(snapshot, forward).amountIn, DEFAULT_RAW / 500_000_000n);
  assert.equal(row(snapshot, reverse).amountIn, DEFAULT_RAW);
  assert.equal(row(snapshot, forward).effectiveMid, 1_262_500_000);
  assert.equal(row(snapshot, reverse).effectiveMid, 5.0025e-9);
  assert.deepEqual(effectiveMidPairStatistics(snapshot), {
    directions: 2, quoted: 2, byStatus: { quoted: 2 },
    comparablePairs: 1, pairsAboveThreshold: 1, thresholdBps: 100,
  });
});

test("zero spread builds real amount quotes with the global fallback P, including when gas is known", async () => {
  const forward = edge(W, U, "zero-w-u"), reverse = edge(U, W, "zero-u-w");
  const prices = pricing([[forward, 2e-9], [reverse, 5e8]]);
  for (const gasCostWei of [null, 100_000_000_000_000n]) {
    const snapshot = await build(prices, { gasCostWei, enumerationSpreadBps: 0 });
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.reference, "default", "0% cannot define a gas-cover amount");
    assert.equal(snapshot.referenceWethInput, DEFAULT_RAW);
    assert.equal(row(snapshot, forward).amountIn, DEFAULT_RAW);
    assert.equal(row(snapshot, reverse).amountIn, DEFAULT_RAW / 500_000_000n);
    for (const r of snapshot.rows.values()) {
      assert.equal(r.status, "quoted");
      assert.equal(r.amountOut, r.amountIn! * 7n);
    }
  }
});

test("invalid policy and a mid outside the graph reject before invoking quotes; empty input completes", async () => {
  const e = edge(W, U, "policy");
  const prices = pricing([[e, 1]]);
  let calls = 0;
  const quote: Quote = async ({ amountIn }) => { calls++; return { source: SOURCE, amountIn, amountOut: 1n }; };
  for (const concurrency of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(build(prices, { concurrency, quote }), /invalid effective-mid work or spread policy/);
  }
  for (const enumerationSpreadBps of [-1, NaN, Infinity]) {
    await assert.rejects(build(prices, { enumerationSpreadBps, quote }), /invalid effective-mid work or spread policy/);
  }
  for (const gasCostWei of [0n, -1n]) {
    await assert.rejects(build(prices, { gasCostWei, quote }), /invalid gas cost/);
  }
  const outside = { ...prices, graph: { ...prices.graph, edges: [] } };
  await assert.rejects(build(outside, { quote }), /outside the Ready Graph/);
  assert.equal(calls, 0);
  const empty = await build(pricing([]), { quote });
  assert.equal(calls, 0);
  assert.equal(empty.complete, true);
  assert.equal(empty.rows.size, 0);
  assert.equal(empty.referenceWethInput, DEFAULT_RAW);
  assert.deepEqual(effectiveMidPairStatistics(empty), {
    directions: 0, quoted: 0, byStatus: {}, comparablePairs: 0, pairsAboveThreshold: 0, thresholdBps: 100,
  });
  for (const threshold of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => effectiveMidPairStatistics(empty, threshold), /invalid pair threshold/);
  }
});

// Consumer projection only; coordinator publication/integration has its own tests.
function enumerationPricing(prices: EffectivePricingInput, effectiveMids?: EffectiveMidSnapshot): BlockScanStateSnapshot {
  return { ...prices, ...(effectiveMids === undefined ? {} : { effectiveMids }) } as BlockScanStateSnapshot;
}

test("enumeration uses quoted effective prices with zero fee and preserves original prices, depth and metadata", async () => {
  const e = edge(W, U, "projected");
  const base = pricing([[e, 987, 125]]);
  const original: Readonly<RouteVenueMid> = Object.freeze({
    kind: "external-swap", pool: e.target, edges: [e], mid: 987, feeBps: 125, depthProxy: 4321,
    reserveA: 10n ** 24n, reserveB: 10n ** 12n, balanceHeadroomIn: 10n ** 18n,
    sqrtABX96: 2n ** 96n, liquidity: 900_000n,
  });
  const prices = { ...base, mids: new Map([[blockScanEdgeKey(e), original]]) };
  const effective = await build(prices, {
    quote: async ({ amountIn }) => ({ source: SOURCE, amountIn, amountOut: amountIn * 2n }),
  });
  const input = enumerationPricing(prices, effective);
  const projected = effectiveEnumerationMids(input);
  const result = projected.get(blockScanEdgeKey(e))!;
  assert.equal(projected.size, 1);
  assert.notStrictEqual(projected, input.mids);
  assert.notStrictEqual(result, original);
  assert.equal(result.mid, 2);
  assert.equal(result.feeBps, 0);
  assert.equal(result.quoteAmountIn, DEFAULT_RAW);
  assert.equal(result.quoteAmountOut, DEFAULT_RAW * 2n);
  for (const key of ["kind", "pool", "depthProxy", "reserveA", "reserveB", "balanceHeadroomIn", "sqrtABX96", "liquidity"] as const) {
    assert.strictEqual(result[key], original[key], `preserved ${key}`);
  }
  assert.strictEqual(result.edges, original.edges);
  assert.strictEqual(result.edges[0], e);
  assert.strictEqual(input.mids.get(blockScanEdgeKey(e)), original);
  assert.equal(original.mid, 987);
  assert.equal(original.feeBps, 125);
  assert.equal(original.depthProxy, 4321);
  assert.equal(row(effective, e).effectiveMid, 2);
  assert.strictEqual(input.effectiveMids, effective);
});

test("enumeration with a companion includes quoted rows only and never falls back to a missing row's spot price", () => {
  const statuses = ["missing-valuation", "unsupported", "quote-failed", "no-output", "cancelled"] as const;
  const edges = ["quoted", ...statuses, "missing-row"].map(id => edge(W, U, id));
  const prices = pricing(edges.map(e => [e, 1e20, 50]));
  const rows: EffectiveMidRow[] = [
    quoted("quoted", W, U, "quoted", 1n, 2n),
    ...statuses.map(status => ({
      edgeId: status, instanceKey: status, tokenIn: W, tokenOut: U,
      amountIn: status === "missing-valuation" ? null : 1n,
      amountOut: status === "no-output" ? 0n : null, effectiveMid: null, status,
    })),
  ];
  const projected = effectiveEnumerationMids(enumerationPricing(prices, snapshotOf(rows)));
  assert.deepEqual([...projected.keys()], ["quoted"]);
  assert.equal(projected.get("quoted")!.mid, 2);
  assert.equal(projected.get("quoted")!.feeBps, 0);
  for (const e of edges.slice(1)) assert.equal(projected.has(blockScanEdgeKey(e)), false);
  assert.equal(prices.mids.size, edges.length, "the raw pricing map retains every original row");
  assert.equal(effectiveEnumerationMids(enumerationPricing(prices, snapshotOf([]))).size, 0,
    "an empty companion cannot silently restore spot prices");
  const legacy = enumerationPricing(prices);
  assert.strictEqual(effectiveEnumerationMids(legacy), legacy.mids, "only absence of the companion retains legacy behavior");
});

test("enumeration rejects partial and stale companions independently for block number, hash and generation", () => {
  const e = edge(W, U, "freshness");
  const prices = pricing([[e, 9, 100]]);
  const effective = snapshotOf([quoted("freshness", W, U, "freshness", 1n, 2n)]);
  const invalid: EffectiveMidSnapshot[] = [
    { ...effective, complete: false },
    { ...effective, source: { ...SOURCE, number: SOURCE.number - 1 } },
    { ...effective, source: { ...SOURCE, hash: hash(0xbad) } },
    { ...effective, source: { ...SOURCE, generation: SOURCE.generation + 1 } },
    { ...snapshotOf([]), complete: false },
  ];
  for (const companion of invalid) {
    assert.throws(() => effectiveEnumerationMids(enumerationPricing(prices, companion)),
      /enumeration effective pricing incomplete or mismatched source/);
  }
  const upper = { ...effective, source: { ...SOURCE, hash: SOURCE.hash.toUpperCase() } };
  assert.equal(effectiveEnumerationMids(enumerationPricing(prices, upper)).get("freshness")!.mid, 2);
  const upperPricing = { ...prices, sourceBlockHash: SOURCE.hash.toUpperCase() };
  assert.equal(effectiveEnumerationMids(enumerationPricing(upperPricing, effective)).get("freshness")!.feeBps, 0);
  assert.equal(prices.mids.get("freshness")!.mid, 9);
});

test("enumeration rejects malformed quoted rows instead of exposing a spot fallback", () => {
  const e = edge(W, U, "valid");
  const prices = pricing([[e, 99, 30]]);
  const valid = quoted("valid", W, U, "valid", 1n, 2n);
  const invalid = [
    ...[null, 0, -1, NaN, Infinity].map(effectiveMid => ({ ...valid, effectiveMid })),
    { ...valid, edgeId: "different-key" },
  ];
  for (const r of invalid) {
    const companion = { ...snapshotOf([]), rows: new Map([["valid", r]]) };
    assert.throws(() => effectiveEnumerationMids(enumerationPricing(prices, companion)), /invalid effective enumeration row/);
  }
  const outside = snapshotOf([quoted("outside", W, U, "outside", 1n, 2n)]);
  assert.throws(() => effectiveEnumerationMids(enumerationPricing(prices, outside)), /invalid effective enumeration row/);
  assert.equal(prices.mids.get("valid")!.mid, 99);
  assert.equal(prices.mids.get("valid")!.feeBps, 30);
});

function atSource(prices: EffectivePricingInput, source: EffectiveMidSnapshot["source"]): EffectivePricingInput {
  return { ...prices, sourceBlock: source.number, sourceBlockHash: source.hash, generation: source.generation };
}

function assertReferenceRetained(current: EffectiveMidRow, original: EffectiveMidRow): void {
  assert.equal(current.status, "quoted");
  assert.equal(current.amountIn, original.amountIn, "do not relabel the input to this pass's new notional");
  assert.equal(current.amountOut, original.amountOut, "do not fabricate an output at the new notional");
  assert.equal(current.effectiveMid, original.effectiveMid, "retain the recorded reference rate exactly");
  assert.deepEqual(current.quotedAt, original.quotedAt, "do not relabel the original observation source");
  assert(Object.isFrozen(current));
  assert.strictEqual(current, original, "clean immutable rows are reused, not copied to stamp a carry flag");
}

// Opaque IDs from the existing 20-Family cache inventory. These generic fixture
// callbacks test reference-table policy, NOT those Families' live quote paths,
// chain success, transitive dependency closure or Exact/execution equivalence.
const OFFLINE_FAMILY_IDS = Object.freeze([
  "curve-underlying", "custom-swap:angstrom-v4", "custom-swap:dodo-v2", "fluid-dex",
  "protocol:astra-multitoken", "protocol:eigenpie", "protocol:erc4626",
  "protocol:erc4626-silo-redeem", "protocol:ethertoken-native-redeem", "protocol:goldx",
  "protocol:metronome-hgusdc", "protocol:metronome-synth", "protocol:psm",
  "protocol:rocksolid", "protocol:self-burn-native", "protocol:wsteth",
  "univ2-standard", "univ3-standard", "univ4", "univ4-fee-hook",
]);

test("offline reference contract for all 20 opaque Family IDs: clean reuse, unchanged raw ratio plus touched requotes", async () => {
  assert.equal(new Set(OFFLINE_FAMILY_IDS).size, 20);
  const all = OFFLINE_FAMILY_IDS.flatMap((family, index) => [
    { ...edge(W, U, family + "/forward", "instance-" + index), adapterId: family },
    { ...edge(U, W, family + "/reverse", "instance-" + index), adapterId: family },
  ]);
  const stateKeys = all.map((_, index) => "opaque-state-" + Math.floor(index / 2));
  const prices = { ...pricing(all.map(e => [e, e.tokenIn === W ? 2e-9 : 5e8])),
    pricingStateKeyByEdgeKey: new Map(all.map((e, index) => [blockScanEdgeKey(e), stateKeys[index]!])),
  };
  const initialCalls: QuoteInput[] = [];
  const previous = await build(prices, { quote: async call => {
    initialCalls.push(call);
    return { source: SOURCE, amountIn: call.amountIn, amountOut: call.amountIn * 2n + 137n };
  } });
  assert.equal(initialCalls.length, 40);
  assert.equal(new Set(initialCalls.map(call => call.edge.adapterId)).size, 20);
  assert(initialCalls.every(call => !Object.hasOwn(call, "requireChainAmountQuote")));
  const before = structuredClone(previous);
  const nextSource = { number: SOURCE.number + 119, hash: hash(321), generation: SOURCE.generation + 1 };
  const nextPrices = atSource(prices, nextSource);
  let calls = 0;
  const clean = await build(nextPrices, { previous, touchedStateKeys: new Set(),
    quote: async () => { calls++; throw new Error("clean reference must not invoke quote"); },
  });
  assert.equal(calls, 0);
  assert.equal(clean.complete, true);
  assert.deepEqual(clean.source, nextSource);
  assert.strictEqual(clean.rows, previous.rows, "an unchanged table reuses its original Map");
  for (const e of all) {
    assertReferenceRetained(row(clean, e), row(previous, e));
    assert.deepEqual(row(clean, e).quotedAt, SOURCE);
    assert.equal(effectiveMidRowCarried(clean, row(clean, e)), true);
    assert.equal(effectiveMidRowCarried(previous, row(previous, e)), false);
    assert.deepEqual(Object.keys(row(clean, e)).sort(), [
      "edgeId", "instanceKey", "tokenIn", "tokenOut", "amountIn", "amountOut",
      "effectiveMid", "status", "quotedAt",
    ].sort(), "the reference row carries data only, no Exact handle or execution authority");
  }
  const touchedCalls: QuoteInput[] = [];
  const touched = await build(nextPrices, { previous: clean, touchedStateKeys: new Set(stateKeys),
    quote: async call => {
      touchedCalls.push(call);
      return { source: nextSource, amountIn: call.amountIn, amountOut: call.amountIn * 3n + 89n };
    },
  });
  assert.equal(touchedCalls.length, 40, "unchanged raw ratios do not override the raw state-key touched set");
  assert.deepEqual(touchedCalls.map(call => call.edge), all);
  assert.strictEqual(nextPrices.mids, prices.mids);
  for (const e of all) {
    assert.equal(row(touched, e).carried, undefined);
    assert.deepEqual(row(touched, e).quotedAt, nextSource);
    assert.notEqual(row(touched, e).amountOut, row(clean, e).amountOut);
  }
  const laterSource = { ...nextSource, number: nextSource.number + 7, hash: hash(322), generation: nextSource.generation + 1 };
  const later = await build(atSource(prices, laterSource), { previous: clean, touchedStateKeys: new Set(),
    gasCostWei: 1n, quote: async () => { calls++; throw new Error("no TTL or notional invalidation"); },
  });
  assert.equal(calls, 0);
  for (const e of all) assertReferenceRetained(row(later, e), row(previous, e));
  assert.deepEqual(previous, before, "current classification must not mutate original reference data");
});

test("previous raw sizes current quotes, including a recovered direction missing from that raw table", async () => {
  const old = edge(U, W, "valuation");
  const prices = pricing([[old, 5e8]]);
  const current = { number: SOURCE.number + 1, hash: hash(700), generation: SOURCE.generation + 1 };
  const quoteGraph = graphAt([edge(U, "new-output", "recovered")], current);
  const recovered = quoteGraph.edges[0]!;
  const previous = await build(prices);
  const calls: QuoteInput[] = [];
  const result = await build(prices, { quoteGraph, previous, touchedStateKeys: new Set(["recovered"]),
    quote: async call => { calls.push(call); return { source: current, amountIn: call.amountIn, amountOut: 456n }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.edge, recovered);
  assert.equal(calls[0]!.amountIn, DEFAULT_RAW / 500_000_000n, "amount uses the old raw conversion, not a current quote");
  assert.deepEqual(result.source, current);
  assert.deepEqual(row(result, recovered).quotedAt, current);
  assert.equal(row(result, recovered).amountOut, 456n);
  assert.equal(result.rows.has(blockScanEdgeKey(old)), false, "delta removes a retired graph direction");
  assert.equal(previous.rows.has(blockScanEdgeKey(old)), true, "old table remains immutable");
  const wrong = await build(prices, { quoteGraph });
  noQuote(row(wrong, recovered), "quote-failed");
  const clean = await build(prices, { quoteGraph, previous, touchedStateKeys: new Set(),
    quote: async () => { throw new Error("unpriced clean graph directions must not issue quotes"); } });
  assert.equal(clean.rows.size, 0, "the current graph cannot silently broaden the raw touched work set");
});

test("all-clean steady work reuses the Map without even reading valuation coverage", async () => {
  const unpriced = Array.from({length: 2364}, (_, i) => edge(W, U, "unpriced-clean-" + i));
  const current = graphAt([edge(U, W, "clean-no-sizing"), ...unpriced], {
    number: SOURCE.number + 1, hash: hash(701), generation: SOURCE.generation + 1,
  });
  const e = current.edges[0]!, prices = pricing([[e, 5e8]]);
  const previous = await build(prices);
  const noSizing = { ...prices, get coverage(): EffectivePricingInput["coverage"] {
    throw new Error("clean rows must not compute valuation");
  } };
  const result = await build(noSizing, { quoteGraph: current, previous, touchedStateKeys: new Set(),
    quote: async () => { throw new Error("clean rows must not quote"); },
  });
  assert.strictEqual(result.rows, previous.rows);
  assert.equal(result.rows.size, 1, "unpriced clean graph directions do not expand the table or work set");
  assert.equal(effectiveMidRowCarried(result, row(result, e)), true);
});

for (const change of ["gas", "mark", "gas-and-mark"] as const) {
  test("changed " + change + " affects dirty/new rows only, not a clean row's original amounts or rate", async () => {
    const clean = edge(U, W, "reference-clean"), dirty = edge(U, W, "reference-dirty");
    const prices = pricing([[clean, 5e8], [dirty, 5e8]]);
    const previous = await build(prices);
    const original = row(previous, clean);
    assert.equal(original.amountIn, DEFAULT_RAW / 500_000_000n);
    const added = edge(W, U, "new-reference-row");
    const mark = change === "gas" ? 5e8 : 1e9;
    const gasCostWei = change === "mark" ? null : 100_000_000_000_000n;
    const current = { number: SOURCE.number + 1, hash: hash(555), generation: SOURCE.generation + 1 };
    const currentPrices = atSource(pricing([[clean, mark], [dirty, mark], [added, 2e-9]]), current);
    const calls: QuoteInput[] = [];
    const next = await build(currentPrices, { previous, touchedStateKeys: new Set([dirty.instanceKey!]), gasCostWei,
      quote: async call => {
        calls.push(call);
        return { source: current, amountIn: call.amountIn, amountOut: call.amountIn * 11n + 1n };
      },
    });
    assert.deepEqual(calls.map(call => call.edge), [dirty, added]);
    assertReferenceRetained(row(next, clean), original);
    const expectedDirtyAmount = change === "gas" ? 10_000_001n
      : change === "mark" ? DEFAULT_RAW / 1_000_000_000n : 5_000_001n;
    assert.equal(row(next, dirty).amountIn, expectedDirtyAmount);
    assert.equal(row(next, dirty).amountOut, expectedDirtyAmount * 11n + 1n);
    assert.deepEqual(row(next, dirty).quotedAt, current);
    assert.equal(row(next, dirty).carried, undefined);
    const expectedWethAmount = gasCostWei === null ? DEFAULT_RAW : 5_000_000_000_000_001n;
    assert.equal(next.referenceWethInput, expectedWethAmount);
    assert.equal(row(next, added).amountIn, expectedWethAmount);
    assert.equal(row(next, added).carried, undefined);
    assert.equal(next.reference, gasCostWei === null ? "default" : "gas");
    assert.equal(next.complete, true);
  });
}

test("a lost sizing mark does not erase a clean reference; a touched unvalued row remains unavailable", async () => {
  const clean = edge(U, W, "lost-mark-clean"), dirty = edge(U, W, "lost-mark-dirty");
  const previous = await build(pricing([[clean, 5e8], [dirty, 5e8]]));
  let calls = 0;
  const next = await build(pricing([[clean, 0], [dirty, 0]]), { previous, gasCostWei: 1n,
    touchedStateKeys: new Set([dirty.instanceKey!]),
    quote: async () => { calls++; throw new Error("no valued fresh input"); },
  });
  assert.equal(calls, 0);
  assertReferenceRetained(row(next, clean), row(previous, clean));
  assert.equal(row(next, dirty).amountIn, null);
  noQuote(row(next, dirty), "missing-valuation");
});

test("the declared raw state key, not target/instance/direction, chooses refresh; instance fallback remains supported", async () => {
  const a = { ...edge(W, U, "key-a", "instance-a"), target: "shared-manager" };
  const b = { ...edge(W, U, "key-b", "instance-b"), target: "shared-manager" };
  const base = pricing([[a, 2], [b, 2]]);
  const prices = { ...base, pricingStateKeyByEdgeKey: new Map([
    [blockScanEdgeKey(a), "MANAGER\u001fPOOL-A"], [blockScanEdgeKey(b), "MANAGER\u001fPOOL-B"],
  ]) };
  const previous = await build(prices);
  for (const [touchedStateKeys, expected] of [
    [new Set(["manager\u001fpool-a"]), [a]],
    [new Set(["shared-manager", "instance-a", "key-b"]), []],
  ] as const) {
    const calls: TokenEdge[] = [];
    const result = await build(prices, { previous, touchedStateKeys,
      quote: async ({ edge, amountIn }) => { calls.push(edge); return { source: SOURCE, amountIn, amountOut: 89n }; },
    });
    assert.deepEqual(calls, expected);
    for (const e of [a, b]) if (!expected.some(value => value === e)) assertReferenceRetained(row(result, e), row(previous, e));
  }
  const calls: TokenEdge[] = [];
  await build({ ...base, pricingStateKeyByEdgeKey: undefined }, {
    previous, touchedStateKeys: new Set(["instance-b"]),
    quote: async ({ edge, amountIn }) => { calls.push(edge); return { source: SOURCE, amountIn, amountOut: 89n }; },
  });
  assert.deepEqual(calls, [b]);
});

test("absent touched set means full refresh even at the same physical source", async () => {
  const all = [edge(W, U, "full-a"), edge(W, U, "full-b")];
  const prices = pricing(all.map(e => [e, 2]));
  const previous = await build(prices);
  for (const current of [SOURCE, { number: SOURCE.number + 1, hash: hash(77), generation: SOURCE.generation + 1 }]) {
    const calls: TokenEdge[] = [];
    const next = await build(atSource(prices, current), { previous,
      quote: async ({ edge, amountIn }) => { calls.push(edge); return { source: current, amountIn, amountOut: 89n }; },
    });
    assert.deepEqual(calls, all);
    assert([...next.rows.values()].every(r => r.carried === undefined && r.amountOut === 89n));
  }
});

test("reference reuse requires a newer generation across blocks and the same hash within a block", async () => {
  const e = edge(W, U, "source-fence");
  const prices = pricing([[e, 2]]), previous = await build(prices);
  for (const current of [
    { ...SOURCE, number: SOURCE.number - 1 },
    { ...SOURCE, generation: SOURCE.generation - 1 },
    { ...SOURCE, hash: hash(0xbad) },
    { ...SOURCE, hash: hash(0xbad), generation: SOURCE.generation + 1 },
    { number: SOURCE.number + 1, hash: hash(101), generation: SOURCE.generation - 1 },
    { number: SOURCE.number + 1, hash: hash(102), generation: SOURCE.generation },
  ]) {
    let calls = 0;
    const result = await build(atSource(prices, current), { previous, touchedStateKeys: new Set(),
      quote: async ({ amountIn }) => { calls++; return { source: current, amountIn, amountOut: 89n }; },
    });
    assert.equal(calls, 1, "rollback, same-height reorg or equal-generation forward reuse must require a fresh request");
    assert.equal(row(result, e).carried, undefined);
    assert.equal(row(result, e).amountOut, 89n);
  }
  for (const current of [SOURCE, { ...SOURCE, hash: SOURCE.hash.toUpperCase(), generation: SOURCE.generation + 1 },
    { number: SOURCE.number + 1, hash: hash(102), generation: SOURCE.generation + 1 }]) {
    let calls = 0;
    const result = await build(atSource(prices, current), { previous, touchedStateKeys: new Set(),
      quote: async () => { calls++; throw new Error("unchanged reference"); },
    });
    assert.equal(calls, 0);
    assertReferenceRetained(row(result, e), row(previous, e));
  }
});

for (const reason of ["abort", "deadline"] as const) {
  test("partition before quotes: " + reason + " behind dirty work retains later clean reference rows but bars publication", async () => {
    const originalNow = Date.now;
    let now = 1000;
    Date.now = () => now;
    try {
      const dirty = [0, 1, 2].map(i => edge(W, U, "dirty-" + i));
      const clean = [0, 1].map(i => edge(W, U, "clean-" + i));
      const missing = edge("unvalued", U, "missing");
      const standing = { ...edge(W, U, "standing"), leavesStandingPosition: true };
      const all = [...dirty, missing, standing, ...clean];
      const prices = pricing(all.map(e => [e, 99]));
      let initialCalls = 0;
      const previous = await build(prices, { quote: async ({ amountIn }) => {
        initialCalls++;
        return { source: SOURCE, amountIn, amountOut: amountIn * 2n };
      } });
      assert.equal(initialCalls, 5);
      const before = structuredClone(previous);
      const current = { number: SOURCE.number + 1, hash: hash(987), generation: SOURCE.generation + 1 };
      const currentPrices = atSource(prices, current);
      const touchedStateKeys = new Set(dirty.map(e => e.instanceKey!));
      const has = touchedStateKeys.has.bind(touchedStateKeys);
      const checked: string[] = [], checksAtDispatch: number[] = [];
      touchedStateKeys.has = key => { checked.push(key); return has(key); };
      const controller = new AbortController();
      const control = { signal: controller.signal, deadlineAtMs: 1100 };
      const pending = deferred<QuoteResult>(), calls: QuoteInput[] = [];
      const promise = build(currentPrices, { previous, touchedStateKeys, control, concurrency: 2, gasCostWei: 1n,
        quote: call => { calls.push(call); checksAtDispatch.push(checked.length); return pending.promise; },
      });
      if (reason === "abort") controller.abort(); else now = 1100;
      pending.resolve({ source: current, amountIn: 51n, amountOut: 51n * 999n });
      const result = await promise;
      assert.deepEqual(calls.map(call => call.edge), dirty.slice(0, 2), "only two fresh quote requests are invoked");
      assert(calls.every(call => call.amountIn === 51n && call.control === control && !Object.hasOwn(call, "requireChainAmountQuote")));
      assert.deepEqual(checked, [...dirty, missing, ...clean].map(e => e.instanceKey!),
        "unavailable clean rows use the same touched classification as quoted rows");
      assert.deepEqual(checksAtDispatch, [6, 6], "all clean/dirty classification precedes quote dispatch");
      assert.equal(result.complete, false);
      assert.deepEqual([...result.rows.keys()], [...prices.mids.keys()]);
      for (const e of dirty) noQuote(row(result, e), "cancelled");
      noQuote(row(result, missing), "missing-valuation");
      noQuote(row(result, standing), "unsupported");
      for (const e of clean) assertReferenceRetained(row(result, e), row(previous, e));
      assert.throws(() => effectiveEnumerationMids(enumerationPricing(currentPrices, result)), /incomplete/);
      assert.deepEqual(previous, before);
    } finally { Date.now = originalNow; }
  });
}

test("partial previous tables reuse completed rows only; every unquoted or absent row retries when valued", async () => {
  const names = ["complete-a", "complete-b", "failed", "unsupported", "zero", "missing", "cancelled", "absent"];
  const all = names.map(id => edge(id === "missing" ? "newly-valued" : W, id === "missing" ? W : U, id));
  const controller = new AbortController(), initialCalls: TokenEdge[] = [];
  const previous = await build(pricing(all.slice(0, -1).map(e => [e, e.target === "missing" ? 0 : 19])), {
    concurrency: 1, control: { signal: controller.signal }, quote: async ({ edge, amountIn }) => {
      initialCalls.push(edge);
      if (edge.target === "failed") throw new Error("ordinary failure");
      if (edge.target === "unsupported") throw { code: "CHAIN_AMOUNT_QUOTE_UNAVAILABLE" };
      if (edge.target === "cancelled") controller.abort();
      return { source: SOURCE, amountIn, amountOut: edge.target === "zero" ? 0n : amountIn * 2n };
    },
  });
  assert.equal(initialCalls.length, 6);
  assert.equal(previous.complete, false);
  assert.deepEqual([...previous.rows.values()].map(r => r.status),
    ["quoted", "quoted", "quote-failed", "unsupported", "no-output", "missing-valuation", "cancelled"]);
  // Leftover values/observation metadata cannot convert an unquoted status into a reference.
  const pending: EffectiveMidSnapshot = { ...previous, rows: new Map([...previous.rows].map(([key, value]) => [key,
    value.status === "quoted" ? value : { ...value, amountIn: 137n, amountOut: 89n, effectiveMid: 89 / 137, quotedAt: SOURCE },
  ])) };
  for (const forward of [false, true]) {
    const current = { number: SOURCE.number + (forward ? 1 : 0), hash: forward ? hash(988) : SOURCE.hash,
      generation: SOURCE.generation + 1 };
    const calls: TokenEdge[] = [];
    const result = await build(atSource(pricing(all.map(e => [e, 2])), current), {
      previous: pending, touchedStateKeys: new Set(), gasCostWei: 1n,
      quote: async ({ edge, amountIn }) => {
        calls.push(edge);
        return { source: current, amountIn, amountOut: amountIn * 3n };
      },
    });
    assert.deepEqual(calls, all.slice(2), "all six unquoted/absent rows require fresh requests");
    assert.equal(result.complete, true);
    assert.equal(result.rows.size, 8);
    for (const e of all.slice(0, 2)) assertReferenceRetained(row(result, e), row(previous, e));
    for (const e of all.slice(2)) {
      assert.equal(row(result, e).carried, undefined);
      assert.equal(row(result, e).amountIn, e.target === "missing" ? 26n : 51n);
      assert.deepEqual(row(result, e).quotedAt, current);
    }
  }
});

test("already closed work never accepts clean references and never invokes fresh requests", async () => {
  const all = ["clean-a", "clean-b", "dirty"].map(id => edge(W, U, id));
  const prices = pricing(all.map(e => [e, 1])), previous = await build(prices);
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  const result = await build(prices, { previous, touchedStateKeys: new Set(["dirty"]), control: { signal: controller.signal },
    quote: async () => { calls++; throw new Error("closed work"); },
  });
  assert.equal(calls, 0);
  assert.equal(result.complete, false);
  for (const r of result.rows.values()) {
    noQuote(r, "cancelled");
    assert.equal(r.carried, undefined);
    assert.equal(r.quotedAt, undefined);
  }
});

test("changed row identity cannot borrow a reference despite an unchanged opaque edge key", async () => {
  const original = edge(W, U, "same-edge-id", "old-instance");
  const prices = pricing([[original, 2]]), previous = await build(prices);
  for (const changed of [
    { ...original, instanceKey: "new-instance" },
    { ...original, tokenIn: U, tokenOut: W },
    { ...original, tokenOut: "new-output" },
  ]) {
    let calls = 0;
    const result = await build(pricing([[changed, 2]]), { previous, touchedStateKeys: new Set(),
      quote: async ({ edge, amountIn }) => {
        calls++; assert.strictEqual(edge, changed);
        return { source: SOURCE, amountIn, amountOut: 89n };
      },
    });
    assert.equal(calls, 1);
    assert.equal(row(result, changed).amountOut, 89n);
    assert.equal(row(result, changed).carried, undefined);
  }
  const wrongId = { ...previous, rows: new Map([[blockScanEdgeKey(original), { ...row(previous, original), edgeId: "other" }]]) };
  let calls = 0;
  await build(prices, { previous: wrongId, touchedStateKeys: new Set(), quote: async ({ amountIn }) => {
    calls++; return { source: SOURCE, amountIn, amountOut: 89n };
  } });
  assert.equal(calls, 1);
  assert.equal(row(previous, original).amountOut, DEFAULT_RAW * 7n);
});

test("legacy quoted rows without quotedAt bind their previous snapshot source once, not each later carry", async () => {
  const e = edge(W, U, "legacy-reference");
  const prices = pricing([[e, 2]]);
  const previous = snapshotOf([quoted("legacy-reference", W, U, "legacy-reference", 137n, 89n)]);
  const nextSource = { number: SOURCE.number + 1, hash: hash(991), generation: SOURCE.generation + 1 };
  let calls = 0;
  const quote: Quote = async () => { calls++; throw new Error("legacy clean reference"); };
  const next = await build(atSource(prices, nextSource), { previous, touchedStateKeys: new Set(), quote });
  assert.deepEqual(row(next, e).quotedAt, SOURCE);
  const laterSource = { ...nextSource, number: nextSource.number + 1, hash: hash(992), generation: nextSource.generation + 1 };
  const later = await build(atSource(prices, laterSource), { previous: next, touchedStateKeys: new Set(), gasCostWei: 1n, quote });
  assertReferenceRetained(row(later, e), row(next, e));
  assert.equal(row(later, e).amountIn, 137n);
  assert.equal(row(later, e).amountOut, 89n);
  assert.equal(calls, 0);
  assert.equal(row(previous, e).quotedAt, undefined);
});

test("quote session is prepared once for actual work, excluding carried and missing-price rows", async () => {
  const clean = Array.from({ length: 512 }, (_, i) => edge(W, U, `clean-${i}`));
  const dirty = edge(W, U, "dirty"), retry = edge(W, U, "unavailable"), missing = edge("unknown", U, "missing");
  const prices = pricing([...clean, dirty, retry, missing].map(e => [e, 1]));
  const base = await build(prices);
  const priorRows = new Map(base.rows);
  priorRows.set(retry.canonicalEdgeId!, { ...row(base, retry), status: "unsupported", amountOut: null, effectiveMid: null });
  const previous = { ...base, rows: priorRows };
  const current = { number: SOURCE.number + 1, hash: hash(996), generation: SOURCE.generation + 1 };
  const prepared: string[][] = [], issued: string[] = [];
  let ready = false;
  const result = await build(atSource(prices, current), { previous, touchedStateKeys: new Set([dirty.instanceKey!]),
    prepareQuote: async required => {
      prepared.push([...required]);
      await Promise.resolve();
      ready = true;
    },
    quote: async ({ edge, amountIn }) => {
      assert(ready, "no issuance before source-bound preparation settles");
      issued.push(blockScanEdgeKey(edge));
      return { source: current, amountIn, amountOut: 123n };
    },
  });
  assert.deepEqual(prepared, [[blockScanEdgeKey(dirty)]]);
  assert.deepEqual(issued, prepared[0]);
  assert.equal(result.complete, true);
  for (const e of clean) assertReferenceRetained(row(result, e), row(previous, e));
  noQuote(row(result, missing), "missing-valuation");
  assert.strictEqual(row(result, retry), row(previous, retry), "complete clean unavailable rows await touch, like raw mid");
  assert.equal(row(result, dirty).quotedAt?.number, current.number);
  const retried = await build(atSource(prices, current), { previous: result,
    touchedStateKeys: new Set([retry.instanceKey!]),
    quote: async ({edge, amountIn}) => {
      assert.equal(edge, retry);
      return {source: current, amountIn, amountOut: 789n};
    },
  });
  assert.equal(row(retried, retry).status, "quoted", "touch reopens the unavailable row through the same quote entry");
});

test("no quote session is prepared for all-clean, no-valued-input or already-cancelled work", async () => {
  const prices = pricing([[edge(W, U, "clean"), 1]]), previous = await build(prices);
  const controller = new AbortController(); controller.abort();
  let prepared = 0, issued = 0;
  const hooks = { prepareQuote: async () => { prepared++; }, quote: async () => { issued++; throw new Error("no quote work"); } };
  const clean = await build(prices, { previous, touchedStateKeys: new Set(), ...hooks });
  assert.equal(clean.complete, true);
  const absent = await build(pricing([[edge("unknown", U, "no-mark"), 1]]), hooks);
  assert.equal(absent.complete, true);
  const closed = await build(prices, { control: { signal: controller.signal }, ...hooks });
  assert.equal(closed.complete, false);
  assert.equal(prepared, 0);
  assert.equal(issued, 0);
});

test("preparation cancellation issues no quote and preparation failure cannot publish a table", async () => {
  const e = edge(W, U, "fresh"), prices = pricing([[e, 1]]);
  const controller = new AbortController();
  let calls = 0;
  const cancelled = await build(prices, { control: { signal: controller.signal },
    prepareQuote: async required => { assert.deepEqual([...required], [blockScanEdgeKey(e)]); controller.abort(); },
    quote: async () => { calls++; throw new Error("cancelled preparation"); },
  });
  assert.equal(cancelled.complete, false);
  noQuote(row(cancelled, e), "cancelled");
  const failure = new Error("current source session unavailable");
  await assert.rejects(build(prices, {
    prepareQuote: async () => { throw failure; },
    quote: async () => { calls++; throw new Error("failed preparation"); },
  }), error => error === failure);
  assert.equal(calls, 0);
});

test("effective consumes the supplied raw valuation index lazily, once per pass", async () => {
  const a = edge(U, W, "indexed-a"), b = edge(U, W, "indexed-b");
  const prices = pricing([[a, 5e8], [b, 5e8]]);
  let lookups = 0;
  const tokenReferences = () => {
    lookups++;
    return new Map([[U, { num: 500_000_000n, den: 1n }]]);
  };
  const poisoned = { ...prices, coverage: { ...prices.coverage,
    get resolvedEdgeKeys(): readonly string[] { throw new Error("effective rebuilt the raw valuation index"); },
  } };
  const first = await build(poisoned, { tokenReferences });
  assert.equal(lookups, 1);
  assert.equal(row(first, a).amountIn, DEFAULT_RAW / 500_000_000n);
  assert.equal(row(first, b).amountIn, DEFAULT_RAW / 500_000_000n);
  const clean = await build(poisoned, { previous: first, touchedStateKeys: new Set(),
    gasCostWei: 100_000_000_000_000n,
    tokenReferences: () => { throw new Error("clean rows must not request valuations"); },
  });
  assert.strictEqual(clean.rows, first.rows);
  const dirty = await build(poisoned, { previous: first, touchedStateKeys: new Set([a.instanceKey!]),
    gasCostWei: 100_000_000_000_000n, tokenReferences,
  });
  assert.equal(lookups, 2);
  assert.equal(row(dirty, a).amountIn, 10_000_001n);
  assert.strictEqual(row(dirty, b), row(first, b));
});

let failed = 0;
for (const [name, run] of tests) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
assert.equal(failed, 0, `${failed}/${tests.length} offline effective-mid tests failed`);
console.log(`blockscan-effective-mid PASS: ${tests.length} offline behavior tests; implemented behavior only, not full acceptance`);
