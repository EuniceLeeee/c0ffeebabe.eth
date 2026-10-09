// Production lifecycle/Graph/coordinator/Exact; compiled code templates with
// synthetic transport. This is refresh wiring, NOT historical/performance proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ethers } from "ethers";
import type { CentralAdapterRuntime } from "../../../../adapter-work-intent.js";
import { buildFamilyRouteGraphView } from "../../../../adapter-family-graph-runtime.js";
import { buildEffectiveMids } from "../../../../blockscan-effective-mid.js";
import { runUniv2Lifecycle } from "../../../../architecture-migration-fixture-replay.js";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { StrictCurrentRuntimeCoordinator } from "../../../../strict-current-runtime-coordinator.js";
import { StrictProductionRuntimeRoot, type StrictProductionRuntimeSession } from "../../../../strict-production-runtime-session.js";
import { definedFamilyPluginContractSummary } from "../../../adapter-family-plugin.js";
import { executeFamilyExactQuote, type PreparedFamilyInstance } from "../../../adapter-family-runtime.js";
import { createBoundedRequestExecutor, type AdapterRequest, type CanonicalSource } from "../../../adapter-request-program.js";
import { createVerifiedGraphView } from "../../../blockscan-state-capability.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog, isPricedFamily } from "../../../family-capability-catalog.js";
import { plugin } from "../../../production-families/algebra-integral.production.js";
import { plugin as univ2 } from "../../../production-families/univ2-standard.production.js";
import { UNIV2_PAIR_INTERFACE } from "../../univ2-family/codec.js";
import { ALGEBRA_POOL_INTERFACE } from "../abi.js";
import { ALGEBRA_QUOTER_INTERFACE } from "../quoter-model.js";
import { answerFor, EXECUTOR, result, STATIC_FEE_FACTS } from "./fixtures.js";
import { dynamicAnswer, DYNAMIC_FACTS } from "./dynamic-fixtures.js";

const ORIGIN = "0x" + "66".repeat(20);
const source = (number: number): CanonicalSource => ({ number, hash: ethers.toBeHex(number, 32), generation: number });
const staticFacts = { ...STATIC_FEE_FACTS, liquidity: 10n ** 18n, sqrtPriceX96: 1n << 96n,
  tick: 0, prevTickGlobal: -10000, nextTickGlobal: 10000 }; // Synthetic in-range capacity for the shared reference amount.
const pool = { pool: "0x" + "41".repeat(20), factory: "0x" + "42".repeat(20),
  token0: DYNAMIC_FACTS.token0, token1: "0x" + "43".repeat(20),
  reserves: { reserve0: 10n ** 24n, reserve1: 2n * 10n ** 24n, blockTimestampLast: 1 } };

test("production dynamic Algebra refresh and distinct-origin caller boundary", async t => {
  const plugins = [plugin, univ2], familyId = plugin.manifest.familyId, start = source(100);
  // Test-only capability labels: never saved Ready/manifest authority.
  const entries = plugins.flatMap(p => FAMILY_CAPABILITY_NAMES.map(capability => ({
    familyId: p.manifest.familyId, capability, contractVersion: "s1-v1",
    contentHash: createHash("sha256").update(`offline-algebra-refresh:${p.manifest.familyId}:${capability}`).digest("hex"),
    semanticDependencies: ["contract:" + capability], provenanceCommit: null,
  })));
  const catalog = new FamilyCapabilityCatalog({ modules: plugins.map(p => ({ plugin: p,
    sourceFile: `${p.manifest.familyId}.production.ts`,
    definitionBoundaryHash: definedFamilyPluginContractSummary(p).definitionBoundaryHash,
  })), generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) }, requireCapture: true });
  let multiplier = 2n, fail = false;
  const currentReads: string[][] = [], exactReads: string[][] = [];
  const quoterRequests: AdapterRequest[] = [];
  const dynamicReply = dynamicAnswer(), staticReply = answerFor({ facts: staticFacts });
  function reply(request: AdapterRequest) {
    if (request.id === "current-reserves" || request.id === "exact-reserves") {
      return result(request.id, UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", Object.values(pool.reserves)));
    }
    if (request.id.startsWith("current-balance-") || request.id === "exact-input-balance") {
      assert(request.kind === "eth-call");
      return result(request.id, ethers.toBeHex(request.to.toLowerCase() === pool.token0.toLowerCase()
        ? pool.reserves.reserve0 : pool.reserves.reserve1, 32));
    }
    if (request.id === "exact-quoter") {
      assert(request.kind === "eth-call");
      if (fail) throw new Error("synthetic Quoter unavailable");
      const args = ALGEBRA_QUOTER_INTERFACE.decodeFunctionData("quoteExactInputSingle", request.data);
      return result(request.id, ALGEBRA_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [args.amountIn * multiplier, 500n]));
    }
    return request.kind === "eth-call" && request.to.toLowerCase() === staticFacts.pool.toLowerCase()
      ? staticReply(request) : dynamicReply(request);
  }
  function runtime(at: CanonicalSource, reads: string[][] = [], answer = reply): CentralAdapterRuntime {
    return { clock: { nowMs: () => 1_000 },
      generationFence: { assertCurrent(generation, pinned) { assert.equal(generation, at.generation); assert.deepEqual(pinned, at); } },
      callerAuthority: { bind: () => ({ executor: EXECUTOR, transactionOrigin: ORIGIN }) },
      policy: { bind: input => ({ lane: "foreground", deadlineAtMs: 100_000,
        maxAttempts: 1, transportPool: "state-read", fairnessKey: input.subjectKey }) },
      budgets: { assertAdmitted() {} }, scheduler: { issueExecutor(input) { return {
        executor: createBoundedRequestExecutor({
          assertSupported: requirements => assert.deepEqual(requirements, input.requirements),
          assertCallerBinding: binding => assert.deepEqual(binding.callerRef, { kind: "transaction-origin" }),
          assertWithinBudget: (_family, requests) => assert.deepEqual(requests, input.requests),
          async execute(execution) {
            assert.deepEqual(execution.source, at);
            reads.push(execution.requests.map(r => r.id));
            for (const call of execution.requests) {
              if (call.id !== "exact-quoter") continue;
              assert(call.kind === "eth-call"); assert.deepEqual(call.caller, { kind: "transaction-origin" });
              assert.deepEqual(input.callerAuthority, { executor: EXECUTOR, transactionOrigin: ORIGIN });
              assert.notEqual(ORIGIN, EXECUTOR); quoterRequests.push(call);
            }
            return execution.requests.map(request => ({ ...answer(request), source: at }));
          }, sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
        }), timing: () => ({ queueWaitMs: 0, transportWallMs: 0, attempts: 1 }),
      }; } },
    };
  }
  const ready: PreparedFamilyInstance[] = [];
  for (const facts of [DYNAMIC_FACTS, staticFacts]) {
    const event = ALGEBRA_POOL_INTERFACE.encodeEventLog(ALGEBRA_POOL_INTERFACE.getEvent("Swap")!,
      [EXECUTOR, EXECUTOR, 1000n, -2000n, facts.sqrtPriceX96, facts.liquidity, facts.tick, 99n, 0n]);
    const publication = await runStrictFamilyLifecycle({ catalog, familyId, source: start,
      runtime: runtime(start, [], facts === DYNAMIC_FACTS ? dynamicReply : staticReply),
      observations: [{ kind: "log", source: start, address: facts.pool, topics: event.topics, data: event.data,
        transactionHash: "0x" + "01".repeat(32) }],
    });
    assert.equal(publication.instances.length, 1); ready.push(...publication.instances);
  }
  ready.push(...(await runUniv2Lifecycle(start, pool, catalog)).instances);
  const { edges } = buildFamilyRouteGraphView({ routes: ready.flatMap(instance => {
    const family = catalog.forFamily(instance.familyId); assert(isPricedFamily(family));
    return instance.routes.map((route, n) => ({ family, descriptor: instance.descriptor, route, handle: instance.routeHandles[n]! }));
  }) });
  assert.equal(edges.length, 6);
  const owners = new Map<string, string>(ready.map(instance => [instance.instanceKey, instance.familyId]));
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: start, readyGraph: edges, readyInstances: ready, readyFundingAssets: [] });
  const graph = (at: CanonicalSource) => createVerifiedGraphView({ id: "algebra-offline-refresh-" + at.number, edges,
    generation: at.generation, sourceBlock: at.number, sourceBlockHash: at.hash, completenessWatermark: at.number,
    familyIdForEdge: edge => owners.get(edge.instanceKey!)!,
    perSourceCoverage: plugins.map(p => ({ familyId: p.manifest.familyId, sourceId: "synthetic-test",
      sourceFingerprint: "offline-only", completeThroughBlock: at.number, completeThroughHash: at.hash })),
  });
  const makeCoordinator = () => new StrictCurrentRuntimeCoordinator(input => root.createSession({
    source: input.source, runtime: runtime(input.source, currentReads), fundingAssets: [],
    kind: input.purpose === "exact-execution" ? "exact" : "pricing",
    requiredEdgeIds: input.requiredEdgeIds, touchedPools: input.touchedPools, control: input.control,
  }), () => {}, undefined, async (pricing, control, _backend, reuse) => {
    const target = reuse?.quoteGraph ?? pricing;
    const at = { number: target.sourceBlock, hash: target.sourceBlockHash, generation: target.generation };
    let exact: StrictProductionRuntimeSession | undefined;
    return buildEffectiveMids({ pricing, quoteGraph: reuse?.quoteGraph, previous: reuse?.previous,
      touchedStateKeys: reuse?.touchedStateKeys, disabledEdgeIds: reuse?.disabledEdgeIds, control,
      weth: pool.token0, gasCostWei: null, enumerationSpreadBps: 0, concurrency: 1, // Synthetic anchor, shared amount policy.
      prepareQuote: async requiredEdgeIds => { exact = await root.createSession({ source: at,
        runtime: runtime(at, exactReads), kind: "exact", fundingAssets: [], requiredEdgeIds, control }); },
      quote: async request => { assert(exact);
        const quoted = await exact.issueExact({ ...request, executor: EXECUTOR, runtimeEvidence: [] });
        assert("amountIn" in quoted); return quoted;
      },
    });
  });
  let coordinator = makeCoordinator(), previous = source(99);
  async function step(freshRun = false) {
    const at = source(previous.number + 1), touched = new Set<string>();
    currentReads.length = 0; exactReads.length = 0;
    // Empty complete canonical activity drives production preparePricingInputs.
    await coordinator.prepareCoarsePricing({ graph: graph(at), deadlineAtMs: Date.now() + 10_000,
      ...(at.number === start.number || freshRun ? {} : { touchedPools: touched,
        canonicalActivity: { source: at, parentHash: previous.hash, touchedStateKeys: touched, complete: true } }),
    });
    previous = at;
    const snapshot = coordinator.latestPricingSnapshot(); assert(snapshot?.effectiveMids);
    assert.deepEqual(snapshot.effectiveMids.source, at);
    assert.equal(snapshot.sourceBlock, at.number); assert.equal(snapshot.sourceBlockHash, at.hash); assert.equal(snapshot.generation, at.generation);
    return snapshot;
  }
  await t.test("quiet refresh, static/V2 carry, failure withdrawal, same-run disable and new-run recovery", async () => {
    const first = await step(), dynamicInstance = ready[0]!.instanceKey;
    const dynamicRows = (snapshot: typeof first) => [...snapshot.effectiveMids!.rows.values()].filter(r => r.instanceKey === dynamicInstance);
    const carried = [...first.effectiveMids!.rows.values()].filter(r => r.instanceKey !== dynamicInstance);
    assert.equal(dynamicRows(first).length, 2); assert.equal(carried.length, 4);
    for (const row of first.effectiveMids!.rows.values()) {
      assert.equal(row.status, "quoted", JSON.stringify(row, (_key, value) => typeof value === "bigint" ? String(value) : value)); assert(row.amountIn! > 0n);
    }
    const round = ["exact-quoter", "pool-plugin", "plugin-code", "quoter-code"];
    async function check(status: "quoted" | "quote-failed" | "disabled-for-run") {
      const snapshot = await step();
      assert.strictEqual(snapshot.mids, first.mids, "raw mids remain bootstrap references");
      assert.deepEqual(currentReads, [], "quiet heads do not rebuild raw mids");
      assert.deepEqual(exactReads, status === "disabled-for-run" ? [] : [round, round], "only two dynamic directions refresh");
      for (const row of carried) assert.strictEqual(snapshot.effectiveMids!.rows.get(row.edgeId), row, "static Algebra and UniV2 carry");
      for (const row of dynamicRows(snapshot)) {
        assert.equal(row.status, status);
        if (status === "quoted") {
          assert.deepEqual(row.quotedAt, previous); assert.equal(row.amountOut, row.amountIn! * multiplier);
          assert.notEqual(row.amountOut, first.effectiveMids!.rows.get(row.edgeId)!.amountOut);
          assert(snapshot.coverage.resolvedEdgeKeys.includes(row.edgeId));
        } else {
          assert.equal(row.amountOut, null); assert.equal(row.effectiveMid, null); assert.equal(row.quotedAt, undefined);
          assert(!snapshot.coverage.resolvedEdgeKeys.includes(row.edgeId));
        }
      }
    }
    multiplier = 3n; await check("quoted"); // No pool touch/log, only changed Quoter output at the next source.
    fail = true; await check("quote-failed"); await check("disabled-for-run");
    fail = false; await check("disabled-for-run"); // Backend recovery MUST NOT clear run-local exclusions.
    coordinator = makeCoordinator(); // Explicit NEW run, no disabled-set reset on the existing coordinator.
    const recovered = await step(true);
    assert([...recovered.effectiveMids!.rows.values()].every(r => r.status === "quoted"));
    for (const row of dynamicRows(recovered)) {
      assert.deepEqual(row.quotedAt, previous); assert.equal(row.amountOut, row.amountIn! * multiplier);
      assert(recovered.coverage.resolvedEdgeKeys.includes(row.edgeId));
    }
  });
  await t.test("current strict runtime sends Quoter calls from origin, not executor", async () => {
    assert(quoterRequests.length > 0);
    const at = start; // Reuse the lifecycle-issued handles at their own publication source.
    let declared: readonly AdapterRequest[] = [], quoterCalls = 0;
    const strict = createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: ORIGIN,
      generationFence: runtime(at).generationFence, provider: {
        async call(call, block) {
          assert.equal(block, at.number); assert.equal(call.blockTag, at.number);
          const request = declared.find(r => r.kind === "eth-call" && r.to.toLowerCase() === call.to.toLowerCase() && r.data === call.data);
          assert(request?.kind === "eth-call", "provider call must match the actual Family declaration");
          if (request.id === "exact-quoter") {
            assert.equal(call.from, ORIGIN); assert.notEqual(call.from, EXECUTOR); quoterCalls++;
          }
          const answer = dynamicReply(request); assert(answer.ok); return answer.data;
        },
        async getCode(address, block) {
          assert.equal(block, at.number);
          const request = declared.find(r => r.kind === "get-code" && r.address.toLowerCase() === address.toLowerCase());
          assert(request?.kind === "get-code", "provider code read must match the actual Family declaration");
          const answer = dynamicReply(request); assert(answer.ok); return answer.data;
        },
        async getStorage() { throw new Error("unexpected storage read"); },
      },
    });
    // Observe declarations only; the current production scheduler still owns execution/caller binding.
    const actualRuntime: CentralAdapterRuntime = { ...strict, scheduler: { issueExecutor(input) {
      declared = input.requests; return strict.scheduler.issueExecutor(input);
    } } };
    for (const route of ready[0]!.routeHandles) {
      const quoted = await executeFamilyExactQuote({ family: catalog.forFamily(familyId), route, amountIn: 1000n,
        source: at, generation: at.generation, runtime: actualRuntime, executor: EXECUTOR,
        runtimeEvidence: [], requireChainAmountQuote: true });
      assert(quoted.status === "resolved", JSON.stringify(quoted, (_key, value) => typeof value === "bigint" ? String(value) : value));
      assert.deepEqual(quoted.source, at); assert.equal(quoted.amountOut, 2000n);
    }
    assert.equal(quoterCalls, 2, "both admitted directions reach the provider with the real origin");
  });
});
