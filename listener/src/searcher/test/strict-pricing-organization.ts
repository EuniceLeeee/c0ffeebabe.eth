import assert from "node:assert/strict";
import { test } from "node:test";
import { StrictCurrentRuntimeCoordinator } from "../strict-current-runtime-coordinator.js";
import type { BlockScanStateSnapshot } from "../blockscan-state-coordinator.js";
import type { StrictPricingPublication } from "../strict-current-runtime-coordinator.js";
import { createVerifiedGraphView, exactSetHash } from "../venues/blockscan-state-capability.js";
import { strictReadyGraphContractFingerprint, type StrictProductionRuntimeSession } from "../strict-production-runtime-session.js";

test("organization belongs to the successful publication seam; returned and published identity agree", async () => {
  let organized = 0;
  const observed: StrictPricingPublication[] = [];
  const coordinator = new StrictCurrentRuntimeCoordinator(async () => { throw new Error("unpublished session"); },
    () => {}, publication => observed.push(publication), undefined, undefined,
    pricing => { organized++; return Object.freeze({ ...pricing }); });
  // Exercise the synchronous commit seam independently from Family fixtures.
  // No pricing/EVM authority is claimed by this intentionally minimal snapshot.
  const pricing = Object.freeze({ generation: 1, sourceBlock: 1, sourceBlockHash: "hash" }) as BlockScanStateSnapshot;
  const built = { snapshot: pricing, publication: { kind: "baseline" as const, graphFingerprint: "fixture", snapshot: pricing } };
  const seam = coordinator as unknown as { publishPricing(input: typeof built, epoch: number): typeof built };
  assert.throws(() => seam.publishPricing(built, -1), /retired/);
  assert.equal(organized, 0);
  const result = seam.publishPricing(built, 0);
  assert.equal(organized, 1);
  assert.notEqual(result.snapshot, pricing);
  assert.equal(result.snapshot, result.publication.snapshot);
  assert.equal(result.snapshot, observed[0]!.snapshot);
  assert.equal(result.snapshot, coordinator.latestPricingSnapshot());
  await coordinator.resetDynamicStateForReplay();
  assert.throws(() => seam.publishPricing(built, 0), /retired/);
  assert.equal(organized, 1);
  const hash = `0x${"11".repeat(32)}`;
  const graph = createVerifiedGraphView({ id: "organization-test", generation: 2,
    sourceBlock: 2, sourceBlockHash: hash, completenessWatermark: 2, edges: [],
    perSourceCoverage: [{ familyId: "fixture", sourceId: "fixture", sourceFingerprint: "fixture",
      completeThroughBlock: 2, completeThroughHash: hash }] });
  await assert.rejects(coordinator.prepare({ graph, fundingTokens: [], deadlineAtMs: Date.now() + 10000 }),
    /unpublished session/);
  assert.equal(organized, 1, "failed preparation cannot advance the derived working state");
  assert.equal(observed.length, 1);
  assert.equal(coordinator.latestPricingSnapshot(), null);
});

test("canonical rejection does not organize; successful prepare publishes one shared pricing object", async () => {
  const hash = `0x${"22".repeat(32)}`;
  const graph = createVerifiedGraphView({ id: "organization-canonical-test", generation: 3,
    sourceBlock: 3, sourceBlockHash: hash, completenessWatermark: 3, edges: [], perSourceCoverage: [] });
  const session = {
    source: { number: 3, hash, generation: 3 }, edges: graph.edges,
    pricingIndex: () => ({ expectedEdgeKeys: [], expectedEdgeKeyHash: exactSetHash([]),
      readyGraphContractFingerprint: strictReadyGraphContractFingerprint(graph.edges),
      familyIdByEdgeKey: new Map(), stateKeyByEdgeKey: new Map(), perBlockRefreshStateKeys: [] }),
    fundingProjection: () => ({ outcomes: [], sources: new Map() }),
  } as unknown as StrictProductionRuntimeSession;
  let organized = 0;
  const observed: StrictPricingPublication[] = [];
  const coordinator = new StrictCurrentRuntimeCoordinator(async () => session, () => {},
    publication => observed.push(publication), undefined, undefined,
    pricing => { organized++; return Object.freeze({ ...pricing }); });
  const input = { graph, fundingTokens: [], deadlineAtMs: Date.now() + 10000 };
  await assert.rejects(coordinator.prepare({ ...input,
    validateBeforePublish: async () => { throw new Error("canonical source changed"); } }), /canonical source changed/);
  assert.equal(organized, 0);
  assert.equal(coordinator.latestPricingSnapshot(), null);
  const result = await coordinator.prepare(input);
  assert.equal(organized, 1);
  assert.equal(result.snapshot!.pricing, result.pricing.snapshot);
  assert.equal(result.snapshot!.pricing, observed[0]!.snapshot);
  assert.equal(result.snapshot!.pricing, coordinator.latestPricingSnapshot());
});
