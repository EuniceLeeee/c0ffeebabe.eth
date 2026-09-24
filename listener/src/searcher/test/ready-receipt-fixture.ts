import assert from "node:assert/strict";
import { ethers } from "ethers";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import {
  runUniv2Lifecycle, runUniv3Lifecycle, univ3FixtureRuntime, type UniV3PoolContext,
} from "../architecture-migration-fixture-replay.js";
import type { CentralAdapterRuntime } from "../adapter-work-intent.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { createBoundedRequestExecutor, type CanonicalSource } from "../venues/adapter-request-program.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from
  "../venues/production-family-composition.js";

/** Offline lifecycle authority, not chain proof. Pass the returned edge objects
 * unchanged to receipt detection: copying an edge intentionally loses binding. */
export function readyReceiptContext(
  publication: Awaited<ReturnType<typeof runUniv2Lifecycle>>,
  source: CanonicalSource,
) {
  const family = catalog.forFamily(publication.familyId);
  const view = buildFamilyRouteGraphView({
    routes: publication.instances.flatMap((instance) =>
      instance.routes.map((route, index) => ({
        family, descriptor: instance.descriptor, route,
        handle: instance.routeHandles[index],
      }))),
  });
  const root = new StrictProductionRuntimeRoot({
    catalog, readySource: source, readyGraph: view.edges,
    readyInstances: publication.instances, readyFundingAssets: [],
  });
  const graph = [...view.edges];
  assert.equal(graph.length, 2);
  assert(graph.every((item) => item.poolToken0 === undefined && item.poolToken1 === undefined));
  assert(graph.every((item) => root.resolveSwapObservationBinding(item) !== null));
  return { publication, graph, root, resolveBinding: root.resolveSwapObservationBinding };
}

export function receiptV3FixtureRuntime(ctx: UniV3PoolContext): CentralAdapterRuntime {
  const runtime = univ3FixtureRuntime(ctx);
  // Synthetic Solidity-shaped dispatcher with only swap's selector and a
  // reverting fallback. The production classifier derives swapAccess itself;
  // this is fixture evidence, not deployed-code or historical execution proof.
  const code = "0x608060405234801561001057600080fd5b506004361061002f5760003560e01c8063128acb08146100345761002f565b600080fd5b600080fd";
  return {
    ...runtime,
    scheduler: {
      issueExecutor(input) {
        if (!input.requests.some((request) => request.id === "pool-swap-access-code")) {
          return runtime.scheduler.issueExecutor(input);
        }
        assert.equal(input.requests.length, 1);
        assert.deepEqual(input.requests[0], {
          id: "pool-swap-access-code", kind: "get-code", address: ctx.pool,
        });
        return {
          executor: createBoundedRequestExecutor({
            assertSupported: (requirements) => assert.deepEqual(requirements, input.requirements),
            assertCallerBinding() {},
            assertWithinBudget: (_, requests) => assert.deepEqual(requests, input.requests),
            execute: async ({ requests, source }) => requests.map((request) => ({
              id: request.id, ok: true as const, source, completion: "returned" as const,
              data: code, provenance: { kind: "fixture", fingerprint: ethers.keccak256(code) },
            })),
            sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
          }),
          timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
        };
      },
    },
  };
}

export async function createUniv2ReadyReceiptFixture(
  source: CanonicalSource,
  pool: Parameters<typeof runUniv2Lifecycle>[1],
) {
  return readyReceiptContext(await runUniv2Lifecycle(source, pool), source);
}

export async function createUniv3ReadyReceiptFixture(
  source: CanonicalSource,
  ctx: UniV3PoolContext,
) {
  return readyReceiptContext(
    await runUniv3Lifecycle(source, ctx, receiptV3FixtureRuntime(ctx)), source,
  );
}
