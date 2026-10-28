import assert from "node:assert/strict";
import { test } from "node:test";
import type { TokenEdge } from "../planner/token-graph.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { EffectiveMidRow } from "../blockscan-effective-mid.js";
import { StrictCurrentRuntimeCoordinator } from "../strict-current-runtime-coordinator.js";
import { blockScanEdgeKey } from "../venues/blockscan-state-capability.js";
import { edgeInstanceKey } from "../venues/route-instance-identity.js";

// Focused bookkeeping tests; public prepare/atomic publication is covered by
// strict-production-runtime-session.ts. No new production testing interface.
function fixture(count = 8) {
  const edges: TokenEdge[] = Array.from({ length: count * 2 }, (_, i) => ({
    instanceKey: `instance-${i >> 1}`, executionVariantKey: `variant-${i % 2}`,
    adapterId: "univ3-swap", slotKind: "swap", edgeKind: "swap", leavesStandingPosition: false,
    target: `0x${"3".repeat(40)}`, tokenIn: `0x${(i % 2 ? "1" : "2").repeat(40)}`,
    tokenOut: `0x${(i % 2 ? "2" : "1").repeat(40)}`,
  }));
  const keys = edges.map(blockScanEdgeKey);
  const owners = new Map(keys.map(key => [key, "fixture-family"]));
  const stateKeys = new Map(keys.map((key, i) => [key, `state-${i >> 1}`]));
  const policy: string[] = [];
  const rows = new Map(keys.map((key, i) => [key, {
    edgeId: key, instanceKey: edges[i]!.instanceKey!, tokenIn: edges[i]!.tokenIn, tokenOut: edges[i]!.tokenOut,
    amountIn: 1n, amountOut: 2n, effectiveMid: 2, status: "quoted" as const,
  } as EffectiveMidRow]));
  // Only fields consumed by the private bookkeeping, not a forged runtime.
  const pricing = { graph: { edges }, effectiveMids: { complete: true, rows },
    pricingFamilyIdByEdgeKey: owners, pricingStateKeyByEdgeKey: stateKeys,
    perBlockRefreshStateKeys: policy } as unknown as BlockScanStateSnapshot;
  const coordinator = new StrictCurrentRuntimeCoordinator(async () => { throw new Error("no session in unit test"); }, () => {});
  const internal = coordinator as unknown as {
    recordFailedEffectiveInstances(pricing: BlockScanStateSnapshot): void;
    disabledEffectiveEdges(pricing: BlockScanStateSnapshot): ReadonlySet<string> | undefined;
    disabledEffectiveInstances: Set<string>;
    effectiveInstanceIndex: unknown;
    publishPricing(built: { snapshot: BlockScanStateSnapshot }, epoch: number): void;
  };
  return { edges, keys, owners, stateKeys, policy, rows, pricing, coordinator, internal };
}

// Original all-directions AND rule, intentionally uncached and full-table.
function reference(pricing: BlockScanStateSnapshot, disabled: Set<string>): Set<string> | undefined {
  if (pricing.effectiveMids?.complete) {
    const failed = new Map<string, boolean>();
    for (const edge of pricing.graph.edges) {
      const id = blockScanEdgeKey(edge), family = pricing.pricingFamilyIdByEdgeKey?.get(id);
      if (family === undefined) continue;
      const key = JSON.stringify([family, edgeInstanceKey(edge)]);
      if (disabled.has(key)) continue;
      const row = pricing.effectiveMids.rows.get(id), stateKey = pricing.pricingStateKeyByEdgeKey?.get(id);
      const eachBlock = stateKey !== undefined && (pricing.perBlockRefreshStateKeys ?? []).includes(stateKey);
      failed.set(key, (failed.get(key) ?? true) && !eachBlock && row !== undefined &&
        row.amountIn !== null && row.amountIn > 0n &&
        (row.status === "quote-failed" || row.status === "unsupported" || row.status === "no-output"));
    }
    for (const [key, allFailed] of failed) if (allFailed) disabled.add(key);
  }
  if (!disabled.size) return undefined;
  return new Set(pricing.graph.edges.filter(edge => {
    const family = pricing.pricingFamilyIdByEdgeKey?.get(blockScanEdgeKey(edge));
    return family !== undefined && disabled.has(JSON.stringify([family, edgeInstanceKey(edge)]));
  }).map(blockScanEdgeKey));
}

test("reuse index and disabled set, but never retain row failure decisions", () => {
  const f = fixture(2);
  const fail = (i: number) => Object.assign(f.rows.get(f.keys[i]!)!, { status: "quote-failed" });
  fail(0); fail(1);
  f.internal.recordFailedEffectiveInstances(f.pricing);
  const index = f.internal.effectiveInstanceIndex;
  const first = f.internal.disabledEffectiveEdges(f.pricing);
  assert.deepEqual(first, new Set(f.keys.slice(0, 2)));
  f.internal.recordFailedEffectiveInstances(f.pricing);
  assert.strictEqual(f.internal.effectiveInstanceIndex, index);
  assert.strictEqual(f.internal.disabledEffectiveEdges(f.pricing), first);
  fail(2); // mixed directions must not disable the second instance
  f.internal.recordFailedEffectiveInstances(f.pricing);
  assert.strictEqual(f.internal.disabledEffectiveEdges(f.pricing), first);
  fail(3); // same map AND row objects, but changed content
  f.internal.recordFailedEffectiveInstances(f.pricing);
  assert.deepEqual(f.internal.disabledEffectiveEdges(f.pricing), new Set(f.keys));
  assert.deepEqual(first, new Set(f.keys.slice(0, 2)), "prior returned set stays unchanged");
});

test("failure gates, per-block policy and missing rows remain current", () => {
  const f = fixture(1), [a, b] = f.keys;
  Object.assign(f.rows.get(a!)!, { status: "unsupported" });
  for (const status of ["quoted", "cancelled", "missing-valuation", "disabled-for-run"] as const) {
    Object.assign(f.rows.get(b!)!, { status });
    f.internal.recordFailedEffectiveInstances(f.pricing);
    assert.equal(f.internal.disabledEffectiveInstances.size, 0);
  }
  const saved = f.rows.get(b!)!;
  f.rows.delete(b!); f.internal.recordFailedEffectiveInstances(f.pricing);
  assert.equal(f.internal.disabledEffectiveInstances.size, 0);
  f.rows.set(b!, saved);
  Object.assign(saved, { status: "no-output", amountIn: 0n });
  f.internal.recordFailedEffectiveInstances(f.pricing);
  assert.equal(f.internal.disabledEffectiveInstances.size, 0);
  Object.assign(saved, { amountIn: 1n });
  f.policy.push("state-0"); f.internal.recordFailedEffectiveInstances(f.pricing);
  assert.equal(f.internal.disabledEffectiveInstances.size, 0);
  f.policy.length = 0;
  Object.assign(f.pricing.effectiveMids!, { complete: false });
  f.internal.recordFailedEffectiveInstances(f.pricing);
  assert.equal(f.internal.disabledEffectiveInstances.size, 0);
  Object.assign(f.pricing.effectiveMids!, { complete: true });
  f.internal.recordFailedEffectiveInstances(f.pricing);
  assert.deepEqual(f.internal.disabledEffectiveEdges(f.pricing), new Set(f.keys));
});

test("same-count ownership and topology changes invalidate derived membership", () => {
  const f = fixture(2);
  for (const row of f.rows.values()) Object.assign(row, { status: "quote-failed" });
  f.internal.recordFailedEffectiveInstances(f.pricing);
  const previous = f.internal.disabledEffectiveEdges(f.pricing), oldIndex = f.internal.effectiveInstanceIndex;
  f.owners.set(f.keys[0]!, "other-family");
  assert.deepEqual(f.internal.disabledEffectiveEdges(f.pricing), new Set(f.keys.slice(1)));
  assert.notStrictEqual(f.internal.effectiveInstanceIndex, oldIndex);
  f.owners.delete(f.keys[1]!);
  assert.deepEqual(f.internal.disabledEffectiveEdges(f.pricing), new Set(f.keys.slice(2)));
  // Mutable graph retaining its array and stale wrapper metadata must rehash.
  f.edges[2]!.instanceKey = "new-instance";
  assert.deepEqual(f.internal.disabledEffectiveEdges(f.pricing), new Set([f.keys[3]!]));
  assert.deepEqual(previous, new Set(f.keys));
});

test("reset keeps run exclusions; retired publication cannot add failures", async () => {
  const f = fixture(2);
  for (const id of f.keys.slice(0, 2)) Object.assign(f.rows.get(id)!, { status: "quote-failed" });
  f.internal.recordFailedEffectiveInstances(f.pricing);
  await f.coordinator.resetDynamicStateForReplay();
  for (const row of f.rows.values()) Object.assign(row, { status: "quote-failed" });
  assert.throws(() => f.internal.publishPricing({ snapshot: f.pricing }, 0), /retired/);
  assert.deepEqual(f.internal.disabledEffectiveEdges(f.pricing), new Set(f.keys.slice(0, 2)));
  assert.equal(fixture().internal.disabledEffectiveEdges(f.pricing), undefined, "new run starts clean");
});

test("varied publications match original full-table policy exactly", async () => {
  const f = fixture(20), disabled = new Set<string>();
  const statuses: EffectiveMidRow["status"][] = ["quoted", "unsupported", "quote-failed", "no-output",
    "cancelled", "missing-valuation", "disabled-for-run"];
  for (let round = 0; round < 100; round++) {
    f.policy.splice(0, f.policy.length, `state-${round % 20}`);
    for (let i = 0; i < f.keys.length; i++) {
      const id = f.keys[i]!;
      f.owners.set(id, `family-${Math.floor(i / 2 + round / 7) % 3}`);
      f.stateKeys.set(id, `state-${(i + round) % 20}`);
      f.rows.set(id, { ...f.rows.get(id)!, status: statuses[Math.floor(i / 2 + round) % statuses.length]!,
        amountIn: (i + round) % 13 === 0 ? null : (i + round) % 11 === 0 ? 0n : 1n });
    }
    if (round % 9 === 0) f.owners.delete(f.keys[0]!);
    if (round % 10 === 0) await f.coordinator.resetDynamicStateForReplay();
    Object.assign(f.pricing.effectiveMids!, { complete: round % 8 !== 0 });
    const expected = reference(f.pricing, disabled);
    f.internal.recordFailedEffectiveInstances(f.pricing);
    assert.deepEqual(f.internal.disabledEffectiveInstances, disabled, `instances at ${round}`);
    assert.deepEqual(f.internal.disabledEffectiveEdges(f.pricing), expected, `edges at ${round}`);
  }
});
