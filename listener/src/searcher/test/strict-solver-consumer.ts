import assert from "node:assert/strict";
import {
  catalogDiscoverySourceFingerprint,
  createCatalogSourceTransitionIssuer,
  createCatalogTerminalRemovalIssuer,
} from "../adapter-family-catalog-publication.js";
import {
  StrictAdapterFamilyShadowCatalogPublicationRoot,
  type StrictShadowCatalogFamilyStage,
} from "../adapter-family-shadow-catalog-publication.js";
import {
  resolveStrictSolverConsumer,
} from "../strict-solver-consumer.js";
import type {
  DurableDiscoveryContinuityComposition,
} from "../adapter-family-discovery-continuity-composition.js";
import type {
  AdapterGenerationFence,
  CentralAdapterRuntime,
  CentralAdapterScheduler,
} from "../adapter-work-intent.js";
import {
  executeAdapterFamilyLifecycleBatch,
  type AdapterFamilyPublication,
} from "../venues/adapter-family-runtime.js";
import {
  createBoundedRequestExecutor,
  type AdapterRequest,
  type AdapterRequestResult,
  type CanonicalSource,
} from "../venues/adapter-request-program.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_INTERFACE,
  UNIV2_SWAP_CALL_PATTERN_ID,
  UNIV2_SWAP_SELECTOR,
} from "../venues/swaps/univ2-family/codec.js";
import { UNIV2_FAMILY_ID } from
  "../venues/swaps/univ2-family/manifest.js";

const CATALOG = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const FAMILY = CATALOG.forFamily(UNIV2_FAMILY_ID);
const POOL = `0x${"41".repeat(20)}`;

function source(number: number): CanonicalSource {
  return Object.freeze({
    number,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    generation: number,
  });
}

class TestFence implements AdapterGenerationFence {
  assertCurrent(): void {}
}

class TestScheduler implements CentralAdapterScheduler {
  issueExecutor(
    input: Parameters<CentralAdapterScheduler["issueExecutor"]>[0],
  ): ReturnType<CentralAdapterScheduler["issueExecutor"]> {
    const executor = createBoundedRequestExecutor({
      assertSupported: (requirements) => assert.deepEqual(
        requirements,
        input.requirements,
      ),
      assertCallerBinding() {},
      assertWithinBudget: (_familyId, requests) => {
        assert.deepEqual(requests, input.requests);
      },
      execute: async (execution) => Promise.all(execution.requests.map(
        (request) => successResult(request, execution.source),
      )),
      sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
    });
    return Object.freeze({
      executor,
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    });
  }
}

function runtime(): CentralAdapterRuntime {
  let now = 1_000;
  return {
    clock: { nowMs: () => now++ },
    generationFence: new TestFence(),
    callerAuthority: { bind: () => ({}) },
    policy: {
      bind: (input) => ({
        lane: input.stage === "identity" ? "critical-proof" : "background",
        deadlineAtMs: 100_000,
        maxAttempts: 1,
        transportPool: "state-read",
        fairnessKey: input.subjectKey,
      }),
    },
    budgets: { assertAdmitted() {} },
    scheduler: new TestScheduler(),
  };
}

function successResult(
  request: AdapterRequest,
  canonical: CanonicalSource,
): AdapterRequestResult {
  const data = request.id === "pair-factory"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("factory", [`0x${"42".repeat(20)}`])
    : request.id === "pair-token0"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("token0", [`0x${"43".repeat(20)}`])
    : request.id === "pair-token1"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("token1", [`0x${"44".repeat(20)}`])
    : request.id === "factory-get-pair"
    ? UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [POOL])
    : request.id === "pair-reserves" || request.id === "current-reserves"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult(
        "getReserves",
        [1_000_000n, 2_000_000n, 1_234],
      )
    : (() => { throw new Error(`unexpected fixture request ${request.id}`); })();
  return Object.freeze({
    id: request.id,
    ok: true as const,
    source: canonical,
    provenance: Object.freeze({
      kind: "strict-solver-consumer-fixture",
      fingerprint: `fixture:${request.id}`,
    }),
    completion: "returned" as const,
    data,
  });
}

async function lifecycle(canonical: CanonicalSource): Promise<
  AdapterFamilyPublication
> {
  let publication: AdapterFamilyPublication | null = null;
  const result = await executeAdapterFamilyLifecycleBatch({
    family: FAMILY,
    matches: [Object.freeze({
      matchedPatternId: UNIV2_SWAP_CALL_PATTERN_ID,
      observation: Object.freeze({
        kind: "call" as const,
        source: canonical,
        target: POOL,
        data: UNIV2_SWAP_SELECTOR,
      }),
    })],
    source: canonical,
    generation: canonical.generation,
    runtime: runtime(),
    publisher: { publish: (value) => { publication = value; } },
  });
  assert(result.publication);
  assert(publication);
  return publication;
}

function stages(
  root: StrictAdapterFamilyShadowCatalogPublicationRoot,
  canonical: CanonicalSource,
  route: StrictShadowCatalogFamilyStage,
): readonly StrictShadowCatalogFamilyStage[] {
  return CATALOG.listAll().map((family) =>
    family.plugin.manifest.familyId === route.familyId
      ? route
      : root.stageUnsupported({
          familyId: family.plugin.manifest.familyId,
          source: canonical,
          outcomeRefs: ["shadow:not-wired"],
        })
  );
}

function anchors(canonical: CanonicalSource) {
  return CATALOG.listAll().flatMap((family) => {
    const familyId = family.plugin.manifest.familyId;
    const sourceIds = "discovery" in family.plugin
      ? family.plugin.discovery.sources
      : [];
    const complete = familyId === UNIV2_FAMILY_ID;
    return sourceIds.map((sourceId) => Object.freeze({
      familyId,
      sourceId,
      sourceFingerprint: catalogDiscoverySourceFingerprint({
        familyId,
        sourceId,
        source: canonical,
      }),
      authority: "append-only-nomination" as const,
      status: complete ? "complete" as const : "partial" as const,
      completeThroughBlock: complete ? canonical.number : -1,
      completeThroughHash: complete ? canonical.hash : null,
    }));
  });
}

async function main(): Promise<void> {
  const terminalIssuer = createCatalogTerminalRemovalIssuer();
  const transitionIssuer = createCatalogSourceTransitionIssuer();
  const root = new StrictAdapterFamilyShadowCatalogPublicationRoot({
    catalog: CATALOG,
    chainId: "1",
    terminalRemovalAuthority: terminalIssuer.authority,
    sourceTransitionAuthority: transitionIssuer.authority,
  });
  const source1 = source(101);
  const publication1 = await lifecycle(source1);
  const staged = root.prepare({
    source: source1,
    previous: null,
    stages: stages(
      root,
      source1,
      root.stageRouteFamily({ publication: publication1 }),
    ),
    sourceAnchors: anchors(source1),
  });
  assert.equal(await root.compareAndPublish({
    expected: null,
    staged,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  }), true);
  const composition = Object.freeze({
    catalogRoot: root,
  }) as unknown as DurableDiscoveryContinuityComposition;

  const summary = resolveStrictSolverConsumer({
    composition,
    source: source1,
    generation: source1.generation,
  });
  assert.match(summary, /^resolved\(revision=1,edges=2,handles=2,pricing=[1-9][0-9]*/);
  assert.match(summary, /funding=[0-9]+/);
  assert.match(summary, /credit=[0-9]+/);

  const mismatched = resolveStrictSolverConsumer({
    composition,
    source: source(102),
    generation: 102,
  });
  assert.match(mismatched, /^failed:strict catalog consumer source mismatch/);
  assert.equal(resolveStrictSolverConsumer({
    composition: null,
    source: source1,
    generation: source1.generation,
  }), "no-composition");
  console.log("strict-solver-consumer PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
