// Real lifecycle, Graph, coordinator, Exact and execution issuers; synthetic
// transport only. These changed preview replies test freshness, not YB math,
// historical EVM execution, natural production P or representative latency.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ethers } from "ethers";
import type { CentralAdapterRuntime } from "../../../../adapter-work-intent.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { runUniv2Lifecycle } from "../../../../architecture-migration-fixture-replay.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import {
  StrictProductionRuntimeRoot,
  type StrictProductionRuntimeSession,
} from "../../../../strict-production-runtime-session.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import {
  createBoundedRequestExecutor,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
} from "../../../adapter-request-program.js";
import { executeAdapterFamilyLifecycleBatch } from "../../../adapter-family-runtime.js";
import { createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  isPricedFamily,
} from "../../../family-capability-catalog.js";
import { plugin as univ2 } from "../../../production-families/univ2-standard.production.js";
import { plugin } from "../../../production-families/yieldbasis-lt.production.js";
import { UNIV2_PAIR_INTERFACE } from "../../../swaps/univ2-family/codec.js";
import { LT_INTERFACE } from "../abi.js";
import {
  ADMIN, AGG, AMM, answerFor, CRYPTOPOOL, EXECUTOR, FOREIGN, LT, result, word,
  type AnswerOptions,
} from "./fixtures.js";

const familyId = plugin.manifest.familyId;
const source = (number = 100): CanonicalSource => ({
  number, hash: ethers.toBeHex(number, 32), generation: number,
});
const pool = {
  pool: "0x" + "41".repeat(20), factory: "0x" + "42".repeat(20),
  token0: LT, token1: FOREIGN,
  reserves: { reserve0: 10n ** 24n, reserve1: 2n * 10n ** 24n, blockTimestampLast: 1 },
};

function testCatalog() {
  // Test-only capability labels, never saved manifest/Ready authority.
  const plugins = [plugin, univ2];
  const entries = plugins.flatMap(p => FAMILY_CAPABILITY_NAMES.map(capability => ({
    familyId: p.manifest.familyId, capability, contractVersion: "s1-v1",
    contentHash: createHash("sha256").update(`offline-yb-refresh:${p.manifest.familyId}:${capability}`).digest("hex"),
    semanticDependencies: ["contract:" + capability], provenanceCommit: null,
  })));
  return new FamilyCapabilityCatalog({
    modules: plugins.map(p => ({
      plugin: p, sourceFile: `${p.manifest.familyId}.production.ts`,
      definitionBoundaryHash: definedFamilyPluginContractSummary(p).definitionBoundaryHash,
    })),
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) },
    requireCapture: true,
  });
}

for (const path of ["coarse", "runtime"] as const) test(`${path}: YB each-block refresh withdraws failed prices and recovers in the same run`, async () => {
  const catalog = testCatalog(), family = catalog.forFamily(familyId), start = source();
  assert(isPricedFamily(family));
  let state: AnswerOptions = {};
  const currentReads: string[][] = [], exactReads: string[][] = [];

  function reply(request: AdapterRequest, at: CanonicalSource): AdapterRequestResult {
    if (request.id === "current-reserves" || request.id === "exact-reserves") {
      return result(request.id, UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [
        pool.reserves.reserve0, pool.reserves.reserve1, pool.reserves.blockTimestampLast,
      ]), at);
    }
    if (request.id.startsWith("current-balance-") || request.id === "exact-input-balance") {
      assert(request.kind === "eth-call");
      return result(request.id, word(request.to.toLowerCase() === pool.token0.toLowerCase()
        ? pool.reserves.reserve0 : pool.reserves.reserve1), at);
    }
    return { ...answerFor(state)(request), source: at };
  }

  function runtime(at: CanonicalSource, reads: string[][] = []): CentralAdapterRuntime {
    return {
      clock: { nowMs: () => 1_000 },
      generationFence: { assertCurrent(generation, pinned) {
        assert.equal(generation, at.generation); assert.deepEqual(pinned, at);
      } },
      callerAuthority: { bind: () => ({ executor: EXECUTOR, transactionOrigin: EXECUTOR }) },
      policy: { bind: input => ({ lane: "foreground", deadlineAtMs: 100_000,
        maxAttempts: 1, transportPool: "state-read", fairnessKey: input.subjectKey }) },
      budgets: { assertAdmitted() {} },
      scheduler: { issueExecutor(input) {
        return {
          executor: createBoundedRequestExecutor({
            assertSupported: requirements => assert.deepEqual(requirements, input.requirements),
            assertCallerBinding() {},
            assertWithinBudget: (_family, requests) => assert.deepEqual(requests, input.requests),
            async execute(execution) {
              reads.push(execution.requests.map(request => request.id));
              return execution.requests.map(request => reply(request, at));
            },
            sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
          }),
          timing: () => ({ queueWaitMs: 0, transportWallMs: 0, attempts: 1 }),
        };
      } },
    };
  }

  const admitted = await executeAdapterFamilyLifecycleBatch({
    family, source: start, generation: start.generation, runtime: runtime(start),
    publisher: { publish() {} },
    matches: [{ matchedPatternId: "yieldbasis-lt-withdraw-call", observation: {
      kind: "call", source: start, target: LT,
      data: LT_INTERFACE.encodeFunctionData("withdraw(uint256,uint256)", [10n ** 18n, 1n]),
    } }],
  });
  assert(admitted.publication); assert.equal(admitted.publication.instances.length, 1);
  const unrelated = await runUniv2Lifecycle(start, pool, catalog);
  const ready = [...admitted.publication.instances, ...unrelated.instances];
  const { edges } = buildFamilyRouteGraphView({ routes: ready.flatMap(instance => {
    const owner = catalog.forFamily(instance.familyId); assert(isPricedFamily(owner));
    return instance.routes.map((route, n) => ({
      family: owner, descriptor: instance.descriptor, route, handle: instance.routeHandles[n]!,
    }));
  }) });
  assert.equal(edges.length, 3);
  const ownerByInstance = new Map<string, string>(ready.map(instance => [instance.instanceKey, instance.familyId]));
  const root = new StrictProductionRuntimeRoot({
    catalog, readySource: start, readyGraph: edges, readyInstances: ready, readyFundingAssets: [],
  });
  const graph = (at: CanonicalSource) => createVerifiedGraphView({
    id: "yb-offline-refresh-" + at.number, edges,
    generation: at.generation, sourceBlock: at.number, sourceBlockHash: at.hash,
    completenessWatermark: at.number,
    familyIdForEdge: edge => ownerByInstance.get(edge.instanceKey!)!,
    perSourceCoverage: [familyId, univ2.manifest.familyId].map(id => ({
      familyId: id, sourceId: "synthetic-test", sourceFingerprint: "offline-only",
      completeThroughBlock: at.number, completeThroughHash: at.hash,
    })),
  });
  const makeCoordinator = () => new StrictCurrentRuntimeCoordinator(input => root.createSession({
    source: input.source, runtime: runtime(input.source, currentReads), fundingAssets: [],
    kind: input.purpose === "exact-execution" ? "exact" : "pricing",
    requiredEdgeIds: input.requiredEdgeIds, touchedPools: input.touchedPools, control: input.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing;
    const at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({
      pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, control,
      disabledEdgeIds: reuse?.disabledEdgeIds,
      // Synthetic share anchor, not a claim about natural production valuation.
      weth: LT, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 1,
      prepareQuote: async requiredEdgeIds => {
        exact = await root.createSession({ source: at, runtime: runtime(at, exactReads),
          kind: "exact", fundingAssets: [], requiredEdgeIds, control });
      },
      quote: async request => {
        assert(exact);
        const quoted = await exact.issueExact({ ...request, executor: EXECUTOR, runtimeEvidence: [] });
        assert("amountIn" in quoted); return quoted;
      },
    });
  });
  const coordinator = makeCoordinator();

  let previous = source(99);
  async function step(address?: string) {
    const at = source(previous.number + 1);
    const touched = new Set(address === undefined ? [] : root.resolveBlockTouchedStateKeys({
      kind: "log", address, topics: [], data: "0x",
    }, at));
    // External observations need not map to an LT mutation: time also moves.
    assert.equal(touched.size, 0);
    currentReads.length = 0; exactReads.length = 0;
    const input = { graph: graph(at), deadlineAtMs: Date.now() + 10_000,
      ...(at.number === start.number ? {} : { touchedPools: touched,
        canonicalActivity: { source: at, parentHash: previous.hash, touchedStateKeys: touched, complete: true as const } }),
    };
    if (path === "coarse") await coordinator.prepareCoarsePricing(input);
    else await coordinator.prepare({ ...input, fundingTokens: [] });
    previous = at;
    const snapshot = coordinator.latestPricingSnapshot(); assert(snapshot?.effectiveMids);
    assert.deepEqual(snapshot.effectiveMids.source, at);
    assert.equal(snapshot.sourceBlock, at.number); assert.equal(snapshot.sourceBlockHash, at.hash); assert.equal(snapshot.generation, at.generation);
    return snapshot;
  }
  const first = await step();
  const ybEdge = edges.find(edge => edge.instanceKey === admitted.publication!.instances[0]!.instanceKey)!;
  assert(first.perBlockRefreshStateKeys?.includes(ybEdge.instanceKey!));
  for (const instance of unrelated.instances) assert(!first.perBlockRefreshStateKeys?.includes(instance.instanceKey));
  const row = (snapshot: typeof first) => snapshot.effectiveMids!.rows.get(ybEdge.canonicalEdgeId)!;
  assert.equal(row(first).status, "quoted");
  assert(row(first).amountIn! > 0n);
  const reference = first;
  const otherRows = [...first.effectiveMids!.rows.values()].filter(r => r.edgeId !== ybEdge.canonicalEdgeId);
  assert.equal(otherRows.length, 2);
  assert(otherRows.every(r => r.status === "quoted"));

  async function check(expectedOutput: bigint | null, address?: string) {
    const snapshot = await step(address), refreshed = row(snapshot);
    assert.strictEqual(snapshot.mids, reference.mids, "raw mids remain bootstrap references");
    assert.deepEqual(currentReads, [], "no recurring raw reads");
    assert.deepEqual(exactReads, [["quote-preview-withdraw", "quote-is-killed", "quote-staker",
      "quote-live-supply", "quote-liquidity", "quote-pool-asset-balance"]],
    "one six-request YB round, no unrelated Exact reads");
    for (const other of otherRows) {
      assert.strictEqual(snapshot.effectiveMids!.rows.get(other.edgeId), other, "unrelated Family must carry");
    }
    assert.equal(refreshed.amountIn, row(reference).amountIn, "keep the production-selected amount");
    assert.equal(refreshed.amountOut, expectedOutput);
    if (expectedOutput === null) {
      assert.equal(refreshed.status, "quote-failed");
      assert.equal(refreshed.effectiveMid, null);
      assert.equal(refreshed.quotedAt, undefined, "never relabel a stale quote");
      assert(!snapshot.coverage.resolvedEdgeKeys.includes(ybEdge.canonicalEdgeId));
    } else {
      assert.equal(refreshed.status, "quoted");
      assert.deepEqual(refreshed.quotedAt, previous);
      assert(snapshot.coverage.resolvedEdgeKeys.includes(ybEdge.canonicalEdgeId));
    }
    return snapshot;
  }

  let previewOutput = row(first).amountOut! + 1n;
  state = { previewAmountFor: () => previewOutput };
  await check(previewOutput); // Timestamp-only change; no observations at all.
  for (const dependency of [CRYPTOPOOL, AMM, AGG, ADMIN, "0x" + "77".repeat(20)]) {
    // Canned chain replies represent pool/oracle/admin changes, including a
    // replacement admin or aggregator child not present in Ready dependencies.
    previewOutput += 1n;
    await check(previewOutput, dependency);
  }
  state = { ...state, previewReplies: false };
  await check(null); await check(null);
  state = { ...state, previewReplies: true };
  // Keep the same coordinator: only a valid new-source quote restores coverage.
  await check(previewOutput);
  state = { ...state, currentStaker: EXECUTOR };
  await check(null); await check(null);
  state = { ...state, currentStaker: ethers.ZeroAddress };
  await check(previewOutput);

  const reads: string[][] = [];
  const session = await root.createSession({ source: previous, runtime: runtime(previous, reads), kind: "exact", fundingAssets: [] });
  const before = reads.length;
  assert(session.buildRuntimeAmountLeg({ edge: ybEdge, executor: EXECUTOR, runtimeEvidence: [] }));
  assert.equal(reads.length, before, "actual-received runtime construction adds no Exact calls");
  const quoted = await session.issueExact({ edge: ybEdge, amountIn: row(first).amountIn!, executor: EXECUTOR, runtimeEvidence: [] });
  assert("amountIn" in quoted);
  assert.equal(session.buildExecution({ edge: ybEdge, exact: quoted, minAmountOut: quoted.amountOut, executor: EXECUTOR }).status, "resolved");
});
