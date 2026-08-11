import assert from "node:assert/strict";
import {
  catalogDiscoverySourceFingerprint,
  createCatalogSourceTransitionIssuer,
  createCatalogTerminalRemovalIssuer,
  type CatalogSourceTransitionIssuer,
} from "../adapter-family-catalog-publication.js";
import {
  StrictAdapterFamilyShadowCatalogPublicationRoot,
  createStrictCatalogConsumer,
  readStrictFundingOffers,
  readStrictPricingMid,
  strictFundingPublicationKeysByFamily,
  strictPricingPublicationKey,
  strictPricingPublicationKeysByFamily,
  type CommittedStrictShadowCatalogPublication,
  type StrictShadowCatalogViews,
  type StrictShadowCatalogFamilyStage,
} from "../adapter-family-shadow-catalog-publication.js";
import type {
  AdapterFamilySnapshotInventoryClosureReceipt,
} from "../adapter-family-snapshot-inventory-closure.js";
import {
  type AdapterGenerationFence,
  type CentralAdapterRuntime,
  type CentralAdapterScheduler,
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
  familyId,
  instanceKey,
  lineageId,
  routeKey,
  type FamilyId,
} from
  "../venues/adapter-family-identifiers.js";
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
const FACTORY = `0x${"42".repeat(20)}`;
const TOKEN0 = `0x${"43".repeat(20)}`;
const TOKEN1 = `0x${"44".repeat(20)}`;

function publicationRoot() {
  const terminalIssuer = createCatalogTerminalRemovalIssuer();
  const transitionIssuer = createCatalogSourceTransitionIssuer();
  return Object.freeze({
    terminalIssuer,
    transitionIssuer,
    root: new StrictAdapterFamilyShadowCatalogPublicationRoot({
      catalog: CATALOG,
      chainId: "1",
      terminalRemovalAuthority: terminalIssuer.authority,
      sourceTransitionAuthority: transitionIssuer.authority,
    }),
  });
}

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
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("factory", [FACTORY])
    : request.id === "pair-token0"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("token0", [TOKEN0])
    : request.id === "pair-token1"
    ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("token1", [TOKEN1])
    : request.id === "factory-get-pair"
    ? UNIV2_FACTORY_INTERFACE.encodeFunctionResult("getPair", [POOL])
    : request.id === "current-reserves"
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
      kind: "strict-shadow-catalog-fixture",
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

function scoreMap(
  publication: AdapterFamilyPublication,
  score: number,
): ReadonlyMap<string, number> {
  return new Map(publication.instances.flatMap((instance) =>
    instance.routes.map((route) => [route.routeKey, score] as const)
  ));
}

function stages(input: {
  readonly root: StrictAdapterFamilyShadowCatalogPublicationRoot;
  readonly canonical: CanonicalSource;
  readonly route?: StrictShadowCatalogFamilyStage;
}): readonly StrictShadowCatalogFamilyStage[] {
  return CATALOG.listAll().map((family) =>
    family.plugin.manifest.familyId === input.route?.familyId
      ? input.route
      : input.root.stageUnsupported({
          familyId: family.plugin.manifest.familyId,
          source: input.canonical,
          outcomeRefs: ["shadow:not-wired"],
        })
  );
}

function anchors(input: {
  readonly canonical: CanonicalSource;
  readonly completeFamilyId?: FamilyId;
}) {
  return CATALOG.listAll().flatMap((family) => {
    const familyId = family.plugin.manifest.familyId;
    const sourceIds = "discovery" in family.plugin
      ? family.plugin.discovery.sources
      : [];
    const complete = familyId === input.completeFamilyId;
    return sourceIds.map((sourceId) => Object.freeze({
      familyId,
      sourceId,
      sourceFingerprint: catalogDiscoverySourceFingerprint({
        familyId,
        sourceId,
        source: input.canonical,
      }),
      authority: "append-only-nomination" as const,
      status: complete ? "complete" as const : "partial" as const,
      completeThroughBlock: complete ? input.canonical.number : -1,
      completeThroughHash: complete ? input.canonical.hash : null,
    }));
  });
}

async function publish(
  root: StrictAdapterFamilyShadowCatalogPublicationRoot,
  expected: CommittedStrictShadowCatalogPublication | null,
  staged: ReturnType<StrictAdapterFamilyShadowCatalogPublicationRoot["prepare"]>,
): Promise<void> {
  assert.equal(await root.compareAndPublish({
    expected,
    staged,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  }), true);
}

function transitionProof(
  issuer: CatalogSourceTransitionIssuer,
  previous: CanonicalSource,
  current: CanonicalSource,
): ReturnType<CatalogSourceTransitionIssuer["issue"]> {
  return issuer.issue({
    previous,
    current,
    status: "canonical-descendant",
    evidenceRef: `canonical:${current.number}`,
  });
}

function captureIdentities(
  committed: CommittedStrictShadowCatalogPublication,
) {
  return Object.freeze({
    committed,
    envelope: committed.envelope,
    views: committed.views,
    graphRoutes: committed.views.graphRoutes,
    edges: committed.views.edges,
    handles: committed.views.handleByCanonicalEdgeId,
    pricing: committed.views.pricingByPublicationKey,
    instances: committed.envelope.privateState.instances,
    tombstones: committed.envelope.privateState.tombstones,
    routeHandles: committed.envelope.privateState.routeHandles,
    graphEntries: committed.envelope.privateState.graphEntries,
    pricingEntries: committed.envelope.privateState.pricingEntries,
    content: committedContent(committed),
  });
}

function committedContent(
  committed: CommittedStrictShadowCatalogPublication,
) {
  return {
    revision: committed.envelope.snapshot.revision,
    publicationFingerprint:
      committed.envelope.snapshot.publicationFingerprint,
    source: { ...committed.envelope.snapshot.source },
    edges: committed.views.edges.map((edge) => ({
      canonicalEdgeId: edge.canonicalEdgeId,
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      score: edge.score,
    })),
    handleKeys: [...committed.views.handleByCanonicalEdgeId.keys()],
    pricingKeys: [...committed.views.pricingByPublicationKey.keys()],
    instances: [...committed.envelope.privateState.instances]
      .map(([key, instance]) => ({
        key,
        fingerprint: instance.fingerprint,
        publishedRevision: instance.publishedRevision,
      })),
    tombstones: [...committed.envelope.privateState.tombstones.keys()],
  };
}

function assertIdentitiesUnchanged(
  root: StrictAdapterFamilyShadowCatalogPublicationRoot,
  identities: ReturnType<typeof captureIdentities>,
): void {
  assert.equal(root.capture(), identities.committed);
  assert.equal(root.capture()!.envelope, identities.envelope);
  assert.equal(root.capture()!.views, identities.views);
  assert.equal(root.capture()!.views.graphRoutes, identities.graphRoutes);
  assert.equal(root.capture()!.views.edges, identities.edges);
  assert.equal(root.capture()!.views.handleByCanonicalEdgeId, identities.handles);
  assert.equal(root.capture()!.views.pricingByPublicationKey, identities.pricing);
  assert.equal(root.capture()!.envelope.privateState.instances, identities.instances);
  assert.equal(root.capture()!.envelope.privateState.tombstones, identities.tombstones);
  assert.equal(
    root.capture()!.envelope.privateState.routeHandles,
    identities.routeHandles,
  );
  assert.equal(
    root.capture()!.envelope.privateState.graphEntries,
    identities.graphEntries,
  );
  assert.equal(
    root.capture()!.envelope.privateState.pricingEntries,
    identities.pricingEntries,
  );
  assert.deepEqual(committedContent(root.capture()!), identities.content);
}

function assertReadonlyMapPrototypeSealed(
  value: ReadonlyMap<unknown, unknown>,
): void {
  const prototype = Object.getPrototypeOf(value) as Record<
    PropertyKey,
    unknown
  >;
  const originalGet = prototype.get;
  const originalIterator = prototype[Symbol.iterator];
  assert(Object.isFrozen(prototype));
  assert.throws(() => Object.defineProperty(prototype, "get", {
    value: () => undefined,
  }), TypeError);
  assert.throws(() => Object.defineProperty(prototype, Symbol.iterator, {
    value: () => [][Symbol.iterator](),
  }), TypeError);
  assert.equal(prototype.get, originalGet);
  assert.equal(prototype[Symbol.iterator], originalIterator);
}

async function main(): Promise<void> {
  const harness = publicationRoot();
  const { root, transitionIssuer } = harness;
  assert.equal("issueSourceTransition" in root, false);
  assert.equal("issueTerminalRemoval" in root, false);

  const source1 = source(101);
  const publication1 = await lifecycle(source1);
  const stageScore1 = root.stageRouteFamily({
    publication: publication1,
    centralScores: scoreMap(publication1, 1),
  });
  const stageScore2SameInstance = root.stageRouteFamily({
    publication: publication1,
    centralScores: scoreMap(publication1, 2),
  });
  assert.notEqual(
    stageScore1.instances[0]?.instance.fingerprint,
    stageScore2SameInstance.instances[0]?.instance.fingerprint,
    "score-only Graph changes must change the atomic bundle fingerprint",
  );

  const initial = root.prepare({
    source: source1,
    previous: null,
    stages: stages({ root, canonical: source1, route: stageScore1 }),
    sourceAnchors: anchors({
      canonical: source1,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
  });
  assert.deepEqual(Object.keys(initial), []);
  assert.equal("envelope" in initial, false);
  await publish(root, null, initial);
  const committed1 = root.capture()!;
  await assert.rejects(() => root.compareAndPublish({
    expected: committed1,
    staged: initial,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  }), /not prepared by this root/);
  assert.equal(committed1.views.edges.length, 2);
  assert(committed1.views.edges.every((edge) => edge.score === 1));
  assert.equal(committed1.views.handleByCanonicalEdgeId.size, 2);
  assert.equal(committed1.views.pricingByPublicationKey.size, 1);
  assertReadonlyMapPrototypeSealed(committed1.views.handleByCanonicalEdgeId);
  assertReadonlyMapPrototypeSealed(committed1.views.pricingByPublicationKey);
  assertReadonlyMapPrototypeSealed(committed1.envelope.privateState.instances);
  const committedPricing = [...committed1.views.pricingByPublicationKey.values()][0]!;
  const committedMid = [...committedPricing.mids.values()][0]!;
  assert(Object.isFrozen(committedPricing));
  assert(Object.isFrozen(committedPricing.pricingDescriptor));
  assert(Object.isFrozen(committedPricing.snapshot));
  assert(Object.isFrozen(committedMid));
  assert(Object.isFrozen(committedMid.edges));
  assert.equal(committedPricing.mids instanceof Map, false);
  assert.equal(committedPricing.unavailable instanceof Map, false);
  const pricingKey = [...committed1.views.pricingByPublicationKey.keys()][0]!;
  const readRouteKey = [...committedPricing.mids.keys()][0]!;
  const readMid = readStrictPricingMid({
    views: committed1.views,
    pricingPublicationKey: pricingKey,
    routeKey: readRouteKey,
  });
  assert.equal(readMid.kind, "mid");
  assert(Object.isFrozen(readMid));
  const readMissing = readStrictPricingMid({
    views: committed1.views,
    pricingPublicationKey: pricingKey,
    routeKey: routeKey("missing-route"),
  });
  assert.deepEqual(readMissing, { kind: "missing" });
  assert.deepEqual(readStrictPricingMid({
    views: committed1.views,
    pricingPublicationKey: "missing-pricing-key",
    routeKey: readRouteKey,
  }), { kind: "missing" });
  const readUnavailable = readStrictPricingMid({
    views: {
      ...committed1.views,
      pricingByPublicationKey: new Map([[pricingKey, {
        ...committedPricing,
        mids: new Map(),
        unavailable: new Map([[readRouteKey, "fixture-unavailable"]]),
      }]]),
    } as unknown as StrictShadowCatalogViews,
    pricingPublicationKey: pricingKey,
    routeKey: readRouteKey,
  });
  assert.deepEqual(readUnavailable, {
    kind: "unavailable",
    reason: "fixture-unavailable",
  });
  assert(Object.isFrozen(readUnavailable));
  assert.throws(() => {
    (committedPricing.pricingDescriptor as { pool: string }).pool = FACTORY;
  }, TypeError);
  assert.throws(() => {
    (committedMid as { mid: number }).mid = 2;
  }, TypeError);
  assert.throws(() => {
    (committedPricing.mids as unknown as Map<string, unknown>).set(
      "forged",
      {},
    );
  }, TypeError);

  const source2 = source(102);
  const publication2 = await lifecycle(source2);
  const stage2 = root.stageRouteFamily({
    publication: publication2,
    centralScores: scoreMap(publication2, 2),
  });
  const changed = root.prepare({
    source: source2,
    previous: committed1,
    stages: stages({ root, canonical: source2, route: stage2 }),
    sourceAnchors: anchors({
      canonical: source2,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
    sourceTransitionProof: transitionProof(transitionIssuer, source1, source2),
  });
  await publish(root, committed1, changed);
  const committed2 = root.capture()!;
  assert(committed2.views.edges.every((edge) => edge.score === 2));

  const source3 = source(103);
  const closureCastIdentities = captureIdentities(committed2);
  const forgedClosureReceipt = Object.freeze({}) as
    AdapterFamilySnapshotInventoryClosureReceipt;
  assert.deepEqual(Object.keys(forgedClosureReceipt), []);
  assert.throws(() => root.stageRouteFamily({
    publication: publication2,
    inventoryMode: "complete-snapshot",
    snapshotInventoryClosureReceipt: forgedClosureReceipt,
  } as Parameters<
    StrictAdapterFamilyShadowCatalogPublicationRoot["stageRouteFamily"]
  >[0]), /requires append-only-delta/);
  assertIdentitiesUnchanged(root, closureCastIdentities);
  const completeSnapshotStage = Object.freeze({
    ...stage2,
    inventoryMode: "complete-snapshot" as const,
    snapshotInventoryClosureReceipt: forgedClosureReceipt,
  }) as StrictShadowCatalogFamilyStage;
  assert.throws(() => root.prepare({
    source: source3,
    previous: committed2,
    stages: stages({ root, canonical: source3, route: completeSnapshotStage }),
    sourceAnchors: anchors({
      canonical: source3,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
    sourceTransitionProof: transitionProof(transitionIssuer, source2, source3),
    snapshotInventoryClosureReceipt: forgedClosureReceipt,
  } as Parameters<
    StrictAdapterFamilyShadowCatalogPublicationRoot["prepare"]
  >[0]), /requires append-only-delta/);
  assertIdentitiesUnchanged(root, closureCastIdentities);

  const omissionIdentities = captureIdentities(committed2);
  assert.throws(() => root.prepare({
    source: source3,
    previous: committed2,
    stages: stages({ root, canonical: source3 }),
    sourceAnchors: anchors({ canonical: source3 }),
    sourceTransitionProof: transitionProof(transitionIssuer, source2, source3),
  }), /requires an issuer-bound StateInstance mutation proof/);
  assertIdentitiesUnchanged(root, omissionIdentities);

  assert.throws(() => root.stageRouteFamily({
    publication: Object.freeze({
      ...publication2,
      instances: Object.freeze([
        Object.freeze({ ...publication2.instances[0]! }),
      ]),
    }),
  }), /lifecycle-issued/);

  const source4 = source(104);
  const source5 = source(105);
  const publication4 = await lifecycle(source4);
  const publication5 = await lifecycle(source5);
  const winner = root.prepare({
    source: source4,
    previous: committed2,
    stages: stages({
      root,
      canonical: source4,
      route: root.stageRouteFamily({
        publication: publication4,
        centralScores: scoreMap(publication4, 4),
      }),
    }),
    sourceAnchors: anchors({
      canonical: source4,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
    sourceTransitionProof: transitionProof(transitionIssuer, source2, source4),
  });
  const loser = root.prepare({
    source: source5,
    previous: committed2,
    stages: stages({
      root,
      canonical: source5,
      route: root.stageRouteFamily({
        publication: publication5,
        centralScores: scoreMap(publication5, 5),
      }),
    }),
    sourceAnchors: anchors({
      canonical: source5,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
    sourceTransitionProof: transitionProof(transitionIssuer, source2, source5),
  });
  assert.deepEqual(Object.keys(winner), []);
  assert.deepEqual(Object.keys(loser), []);
  await publish(root, committed2, winner);
  const committed4 = root.capture()!;
  const identities = captureIdentities(committed4);
  assert.equal(await root.compareAndPublish({
    expected: committed2,
    staged: loser,
    verifyCanonicalSource: () => { throw new Error("must not run"); },
    assertGenerationCurrent: () => { throw new Error("must not run"); },
  }), false);
  assertIdentitiesUnchanged(root, identities);
  await assert.rejects(() => root.compareAndPublish({
    expected: committed4,
    staged: loser,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  }), /not prepared by this root/);

  const source6 = source(106);
  const publication6 = await lifecycle(source6);
  const rejectedByVerifier = root.prepare({
    source: source6,
    previous: committed4,
    stages: stages({
      root,
      canonical: source6,
      route: root.stageRouteFamily({ publication: publication6 }),
    }),
    sourceAnchors: anchors({
      canonical: source6,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
    sourceTransitionProof: transitionProof(transitionIssuer, source4, source6),
  });
  await assert.rejects(() => root.compareAndPublish({
    expected: committed4,
    staged: rejectedByVerifier,
    verifyCanonicalSource: () => { throw new Error("canonical verifier failed"); },
    assertGenerationCurrent: () => {},
  }), /canonical verifier failed/);
  assertIdentitiesUnchanged(root, identities);
  await assert.rejects(() => root.compareAndPublish({
    expected: committed4,
    staged: rejectedByVerifier,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  }), /not prepared by this root/);

  const source7 = source(107);
  const publication7 = await lifecycle(source7);
  const stage7 = root.stageRouteFamily({ publication: publication7 });
  const source7Stages = stages({
    root,
    canonical: source7,
    route: stage7,
  });
  const source7Anchors = anchors({
    canonical: source7,
    completeFamilyId: UNIV2_FAMILY_ID,
  });
  const wrongTransition = transitionIssuer.issue({
    previous: source3,
    current: source7,
    status: "canonical-descendant",
    evidenceRef: "wrong-predecessor:107",
  });
  assert.throws(() => root.prepare({
    source: source7,
    previous: committed4,
    stages: source7Stages,
    sourceAnchors: source7Anchors,
    sourceTransitionProof: wrongTransition,
  }), /source transition predecessor canonical source mismatch/);
  assertIdentitiesUnchanged(root, identities);

  const unresolvedTransition = transitionIssuer.issue({
    previous: source4,
    current: source7,
    status: "unresolved",
    evidenceRef: "unresolved:107",
  });
  assert.throws(() => root.prepare({
    source: source7,
    previous: committed4,
    stages: source7Stages,
    sourceAnchors: source7Anchors,
    sourceTransitionProof: unresolvedTransition,
  }), /requires a resolved canonical source transition proof/);
  assertIdentitiesUnchanged(root, identities);

  const foreignTransitionIssuer = createCatalogSourceTransitionIssuer();
  assert.throws(() => root.prepare({
    source: source7,
    previous: committed4,
    stages: source7Stages,
    sourceAnchors: source7Anchors,
    sourceTransitionProof: foreignTransitionIssuer.issue({
      previous: source4,
      current: source7,
      status: "canonical-descendant",
      evidenceRef: "foreign:107",
    }),
  }), /source transition proof is forged or foreign/);
  assertIdentitiesUnchanged(root, identities);

  const incumbent = [...committed4.envelope.privateState.instances.values()][0]!;
  const terminalEvidenceRef = "terminal:incumbent:107";
  const terminalInput = {
    familyId: UNIV2_FAMILY_ID,
    lineageId: incumbent.lineageId,
    instanceKey: incumbent.instanceKey,
    reason: "terminal-fixture",
    evidenceRef: terminalEvidenceRef,
  } as const;
  const foreignTerminalIssuer = createCatalogTerminalRemovalIssuer();
  const terminalCases = [
    {
      proof: foreignTerminalIssuer.issue({
        ...terminalInput,
        source: source7,
        status: "terminal",
      }),
      expected: /terminal removal proof is forged or foreign/,
    },
    {
      proof: harness.terminalIssuer.issue({
        ...terminalInput,
        source: source6,
        status: "terminal",
      }),
      expected: /terminal removal proof canonical source mismatch/,
    },
    {
      proof: harness.terminalIssuer.issue({
        ...terminalInput,
        source: source7,
        status: "unresolved",
      }),
      expected: /terminal removal proof is unresolved/,
    },
  ] as const;
  for (const terminalCase of terminalCases) {
    const terminalStage: StrictShadowCatalogFamilyStage = Object.freeze({
      familyId: UNIV2_FAMILY_ID,
      domain: "swap",
      source: source7,
      status: "partial",
      inventoryMode: "append-only-delta",
      instances: Object.freeze([]),
      terminalRemovals: Object.freeze([terminalCase.proof]),
      outcomeRefs: Object.freeze([terminalEvidenceRef]),
    });
    assert.throws(() => root.prepare({
      source: source7,
      previous: committed4,
      stages: stages({
        root,
        canonical: source7,
        route: terminalStage,
      }),
      sourceAnchors: anchors({ canonical: source7 }),
      sourceTransitionProof: transitionProof(
        transitionIssuer,
        source4,
        source7,
      ),
    }), terminalCase.expected);
    assertIdentitiesUnchanged(root, identities);
  }

  const rejectedByGenerationFence = root.prepare({
    source: source7,
    previous: committed4,
    stages: source7Stages,
    sourceAnchors: source7Anchors,
    sourceTransitionProof: transitionProof(transitionIssuer, source4, source7),
  });
  await assert.rejects(() => root.compareAndPublish({
    expected: committed4,
    staged: rejectedByGenerationFence,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {
      throw new Error("generation fence rejected publication");
    },
  }), /generation fence rejected publication/);
  assertIdentitiesUnchanged(root, identities);
  await assert.rejects(() => root.compareAndPublish({
    expected: committed4,
    staged: rejectedByGenerationFence,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  }), /not prepared by this root/);

  const foreign = publicationRoot().root;
  const foreignStage = foreign.stageRouteFamily({ publication: publication1 });
  const foreignPrepared = foreign.prepare({
    source: source1,
    previous: null,
    stages: stages({ root: foreign, canonical: source1, route: foreignStage }),
    sourceAnchors: anchors({
      canonical: source1,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
  });
  await assert.rejects(() => root.compareAndPublish({
    expected: committed4,
    staged: foreignPrepared,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  }), /not prepared by this root/);

  // Explicit zero row: a resolved route Family with zero staged instances
  // must publish zero edges/handles and advance the revision without
  // fabricating an inventory or route-handle index.
  const zeroHarness = publicationRoot();
  const zeroRoot = zeroHarness.root;
  const zeroSource = source(401);
  const zeroPublication = Object.freeze({
    familyId: UNIV2_FAMILY_ID,
    source: zeroSource,
    generation: zeroSource.generation,
    instances: Object.freeze([]),
  }) as unknown as Awaited<ReturnType<typeof lifecycle>>;
  const zeroStage = zeroRoot.stageRouteFamily({
    publication: zeroPublication,
  });
  assert.equal(zeroStage.instances.length, 0);
  const zeroPrepared = zeroRoot.prepare({
    source: zeroSource,
    previous: null,
    stages: stages({
      root: zeroRoot,
      canonical: zeroSource,
      route: zeroStage,
    }),
    sourceAnchors: anchors({
      canonical: zeroSource,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
  });
  await publish(zeroRoot, null, zeroPrepared);
  const zeroCommitted = zeroRoot.capture()!;
  assert.equal(zeroCommitted.views.edges.length, 0);
  assert.equal(zeroCommitted.views.handleByCanonicalEdgeId.size, 0);
  assert.equal(zeroCommitted.views.graphRoutes.length, 0);
  assert.equal(zeroCommitted.envelope.snapshot.revision, 1);

  assert.throws(() => zeroRoot.stageUnsupported({
    familyId: UNIV2_FAMILY_ID,
    source: zeroSource,
  }), /requires explicit non-empty outcome refs/);
  assert.throws(() => zeroRoot.stageUnsupported({
    familyId: UNIV2_FAMILY_ID,
    source: zeroSource,
    outcomeRefs: ["   "],
  }), /requires explicit non-empty outcome refs/);

  // Funding joins the same strict catalog CAS as an instance-slot shard.
  const fundingFamily = CATALOG.listAll().find((family) =>
    (family.plugin.manifest as { domain?: string }).domain === "funding",
  );
  assert(fundingFamily);
  const fundingFamilyId = fundingFamily.plugin.manifest.familyId;
  const fundingHarness = publicationRoot();
  const fundingRoot = fundingHarness.root;
  const fundingSource = source(501);
  const univ2Box = CATALOG.forStrictFamily(UNIV2_FAMILY_ID);
  assert.throws(() => fundingRoot.stageFundingFamily({
    publication: Object.freeze({
      familyId: UNIV2_FAMILY_ID,
      source: fundingSource,
      generation: fundingSource.generation,
      offers: Object.freeze([]),
      outcomes: Object.freeze([]),
    }) as never,
  }), /requires a Funding FamilyBox/);
  const fundingBox = CATALOG.forStrictFamily(fundingFamilyId);
  assert.throws(() => fundingRoot.stageCreditFamily({
    family: fundingBox,
    publication: Object.freeze({
      familyId: fundingFamilyId,
      candidateKey: "candidate",
      instanceKey: "state:funding",
      source: fundingSource,
      generation: fundingSource.generation,
      routes: Object.freeze([]),
    }) as never,
    instance: Object.freeze({}) as never,
  }), /requires a Credit FamilyBox/);
  assert.throws(() => fundingRoot.stageRouteFamily({
    publication: Object.freeze({
      familyId: familyId("swap:not-in-catalog"),
      source: fundingSource,
      generation: fundingSource.generation,
      instances: Object.freeze([]),
    }) as never,
  }), /has no |not a route Family|Domain/);
  assert.throws(() => fundingRoot.stageUnsupported({
    familyId: familyId("swap:not-in-catalog"),
    source: fundingSource,
    outcomeRefs: ["shadow:not-wired"],
  }), /has no /);
  const fundingRoutePublication = await lifecycle(fundingSource);
  const fundingRouteStage = fundingRoot.stageRouteFamily({
    publication: fundingRoutePublication,
  });
  const tombstonePublication = Object.freeze({
    familyId: fundingFamilyId,
    source: fundingSource,
    generation: fundingSource.generation,
    offers: Object.freeze([]),
    outcomes: Object.freeze([Object.freeze({
      familyId: fundingFamilyId,
      fundingId: "morpho",
      instanceKey: "state:funding",
      stateKey: "funding:morpho",
      asset: `0x${"77".repeat(20)}`,
      status: "verified" as const,
      reasonCode: "",
      source: fundingSource,
      workReceipt: null,
      evidenceRefs: Object.freeze(["funding:verified"]),
    })]),
  }) as unknown as Parameters<
    typeof fundingRoot.stageFundingFamily
  >[0]["publication"];
  const fundingStage = fundingRoot.stageFundingFamily({
    publication: tombstonePublication,
  });
  assert.equal(fundingStage.instances.length, 1);
  const fundingStages = CATALOG.listAll().map((family) => {
    const familyId = family.plugin.manifest.familyId;
    if (familyId === fundingFamilyId) return fundingStage;
    if (familyId === UNIV2_FAMILY_ID) return fundingRouteStage;
    return fundingRoot.stageUnsupported({
      familyId,
      source: fundingSource,
      outcomeRefs: ["shadow:not-wired"],
    });
  });
  const fundingPrepared = fundingRoot.prepare({
    source: fundingSource,
    previous: null,
    stages: fundingStages,
    sourceAnchors: anchors({
      canonical: fundingSource,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
  });
  await publish(fundingRoot, null, fundingPrepared);
  const fundingCommitted = fundingRoot.capture()!;
  assert.equal(fundingCommitted.views.fundingByPublicationKey.size, 1);
  const fundingState = [
    ...fundingCommitted.views.fundingByPublicationKey.values(),
  ][0]!;
  assert.equal(fundingState.kind, "funding");
  assert.equal(fundingState.familyId, fundingFamilyId);
  assert.equal(fundingState.tombstone, true);
  assert.equal(fundingState.offers.length, 0);
  assert.deepEqual(readStrictFundingOffers({
    views: fundingCommitted.views,
    fundingPublicationKey:
      [...fundingCommitted.views.fundingByPublicationKey.keys()][0]!,
  }), { kind: "tombstone" });
  assert.deepEqual(readStrictFundingOffers({
    views: fundingCommitted.views,
    fundingPublicationKey: "missing-funding-key",
  }), { kind: "missing" });
  const fundingConsumer = createStrictCatalogConsumer(fundingCommitted.views);
  assert(Object.isFrozen(fundingConsumer.views));
  assert.equal(fundingConsumer.views, fundingCommitted.views);
  assert.deepEqual(fundingConsumer.resolveFundingOffers({
    fundingPublicationKey:
      [...fundingCommitted.views.fundingByPublicationKey.keys()][0]!,
  }), { kind: "tombstone" });
  assert(Object.isFrozen(fundingConsumer.resolveFundingOffers({
    fundingPublicationKey: "missing-funding-key",
  })));
  assert.deepEqual(fundingConsumer.resolvePricingMid({
    pricingPublicationKey: pricingKey,
    routeKey: readRouteKey,
  }).kind, "mid");
  assert.deepEqual(fundingConsumer.resolvePricingMid({
    pricingPublicationKey: "missing-pricing-key",
    routeKey: readRouteKey,
  }), { kind: "missing" });
  const fundingKeys = strictFundingPublicationKeysByFamily({
    views: fundingCommitted.views,
    familyId: fundingFamilyId,
  });
  assert.deepEqual(fundingKeys, [
    [...fundingCommitted.views.fundingByPublicationKey.keys()][0]!,
  ]);
  const stagedInstance = stageScore1.instances[0]!.instance;
  assert.equal(strictPricingPublicationKey({
    familyId: stagedInstance.familyId,
    lineageId: lineageId(stagedInstance.lineageId),
    instanceKey: instanceKey(stagedInstance.instanceKey),
    stateInstanceKey: committedPricing.stateInstanceKey,
  }), pricingKey);
  assert.deepEqual(strictPricingPublicationKeysByFamily({
    views: committed1.views,
    familyId: stagedInstance.familyId,
  }), [pricingKey]);
  assert.deepEqual(strictPricingPublicationKeysByFamily({
    views: committed1.views,
    familyId: familyId("swap:not-in-catalog"),
  }), []);
  assert.equal(fundingCommitted.envelope.snapshot.revision, 1);
  assert.equal(fundingCommitted.envelope.snapshot.familyStatuses.get(
    fundingFamilyId,
  )?.status, "resolved");

  // A funding shard omitted in the next generation cannot be silently
  // carried: the central instance carry gate must reject it.
  const nextFundingSource = source(502);
  const omitFundingStages = CATALOG.listAll().map((family) =>
    fundingRoot.stageUnsupported({
      familyId: family.plugin.manifest.familyId,
      source: nextFundingSource,
      outcomeRefs: ["shadow:not-wired"],
    })
  );
  assert.throws(() => fundingRoot.prepare({
    source: nextFundingSource,
    previous: fundingCommitted,
    stages: omitFundingStages,
    sourceAnchors: anchors({ canonical: nextFundingSource }),
    sourceTransitionProof: transitionProof(
      fundingHarness.transitionIssuer,
      fundingSource,
      nextFundingSource,
    ),
  }), /issuer-bound StateInstance mutation proof/);

  // A non-empty offer generation publishes offers (not a tombstone) in the
  // same CAS and rebinds the funding publication source.
  const offersSource = source(502);
  const offersRoutePublication = await lifecycle(offersSource);
  const offersRouteStage = fundingRoot.stageRouteFamily({
    publication: offersRoutePublication,
  });
  const offer = Object.freeze({
    familyId: fundingFamilyId,
    fundingId: "morpho",
    asset: `0x${"77".repeat(20)}`,
    maxBorrow: 1_000_000n,
    fee: 50n,
    actionAdapterId: "morpho-flash",
    planningPriority: 1,
    liquidityPriority: 1,
    source: offersSource,
    generation: offersSource.generation,
    capabilityHash: "ab".repeat(32),
    evidenceRefs: Object.freeze(["funding:offer"]),
  }) as unknown as Parameters<
    typeof fundingRoot.stageFundingFamily
  >[0]["publication"]["offers"][number];
  const offersPublication = Object.freeze({
    familyId: fundingFamilyId,
    source: offersSource,
    generation: offersSource.generation,
    offers: Object.freeze([offer]),
    outcomes: Object.freeze([]),
  }) as unknown as Parameters<
    typeof fundingRoot.stageFundingFamily
  >[0]["publication"];
  const offersStage = fundingRoot.stageFundingFamily({
    publication: offersPublication,
  });
  const offersStages = CATALOG.listAll().map((family) => {
    const familyId = family.plugin.manifest.familyId;
    if (familyId === fundingFamilyId) return offersStage;
    if (familyId === UNIV2_FAMILY_ID) return offersRouteStage;
    return fundingRoot.stageUnsupported({
      familyId,
      source: offersSource,
      outcomeRefs: ["shadow:not-wired"],
    });
  });
  const offersPrepared = fundingRoot.prepare({
    source: offersSource,
    previous: fundingCommitted,
    stages: offersStages,
    sourceAnchors: anchors({
      canonical: offersSource,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
    sourceTransitionProof: transitionProof(
      fundingHarness.transitionIssuer,
      fundingSource,
      offersSource,
    ),
  });
  await publish(fundingRoot, fundingCommitted, offersPrepared);
  const offersCommitted = fundingRoot.capture()!;
  const offersState = [
    ...offersCommitted.views.fundingByPublicationKey.values(),
  ][0]!;
  assert.equal(offersState.tombstone, false);
  assert.equal(offersState.offers.length, 1);
  assert(Object.isFrozen(offersState.offers));
  assert.deepEqual(readStrictFundingOffers({
    views: offersCommitted.views,
    fundingPublicationKey:
      [...offersCommitted.views.fundingByPublicationKey.keys()][0]!,
  }), { kind: "offers", offers: offersState.offers });
  assert.throws(() => createStrictCatalogConsumer(
    Object.freeze({}) as StrictShadowCatalogViews,
  ), /committed frozen view/);
  assert.throws(() => createStrictCatalogConsumer({
    ...offersCommitted.views,
  } as StrictShadowCatalogViews), /committed frozen view/);
  const badAssetOfferPublication = Object.freeze({
    familyId: fundingFamilyId,
    source: offersSource,
    generation: offersSource.generation,
    offers: Object.freeze([Object.freeze({
      ...offer,
      asset: "0x1234",
    })]),
    outcomes: Object.freeze([]),
  }) as unknown as Parameters<
    typeof fundingRoot.stageFundingFamily
  >[0]["publication"];
  assert.throws(() => fundingRoot.stageFundingFamily({
    publication: badAssetOfferPublication,
  }), /asset must be an address/);
  const mismatchedSourceOfferPublication = Object.freeze({
    familyId: fundingFamilyId,
    source: offersSource,
    generation: offersSource.generation,
    offers: Object.freeze([Object.freeze({
      ...offer,
      source: fundingSource,
    })]),
    outcomes: Object.freeze([]),
  }) as unknown as Parameters<
    typeof fundingRoot.stageFundingFamily
  >[0]["publication"];
  assert.throws(() => fundingRoot.stageFundingFamily({
    publication: mismatchedSourceOfferPublication,
  }), /source escaped its publication/);
  const noEvidenceVerifiedPublication = Object.freeze({
    familyId: fundingFamilyId,
    source: offersSource,
    generation: offersSource.generation,
    offers: Object.freeze([]),
    outcomes: Object.freeze([Object.freeze({
      familyId: fundingFamilyId,
      fundingId: "morpho",
      instanceKey: "state:funding",
      stateKey: "funding:morpho",
      asset: `0x${"77".repeat(20)}`,
      status: "verified" as const,
      reasonCode: "",
      source: offersSource,
      workReceipt: null,
      evidenceRefs: Object.freeze([]),
    })]),
  }) as unknown as Parameters<
    typeof fundingRoot.stageFundingFamily
  >[0]["publication"];
  assert.throws(() => fundingRoot.stageFundingFamily({
    publication: noEvidenceVerifiedPublication,
  }), /non-empty evidence refs/);

  // Tombstone -> offers -> tombstone round trip across three generations.
  const tombstoneAgainSource = source(503);
  const tombstoneAgainRoute = await lifecycle(tombstoneAgainSource);
  const tombstoneAgainRouteStage = fundingRoot.stageRouteFamily({
    publication: tombstoneAgainRoute,
  });
  const tombstoneAgainPublication = Object.freeze({
    familyId: fundingFamilyId,
    source: tombstoneAgainSource,
    generation: tombstoneAgainSource.generation,
    offers: Object.freeze([]),
    outcomes: Object.freeze([Object.freeze({
      familyId: fundingFamilyId,
      fundingId: "morpho",
      instanceKey: "state:funding",
      stateKey: "funding:morpho",
      asset: `0x${"77".repeat(20)}`,
      status: "verified" as const,
      reasonCode: "",
      source: tombstoneAgainSource,
      workReceipt: null,
      evidenceRefs: Object.freeze(["funding:verified-again"]),
    })]),
  }) as unknown as Parameters<
    typeof fundingRoot.stageFundingFamily
  >[0]["publication"];
  const tombstoneAgainStage = fundingRoot.stageFundingFamily({
    publication: tombstoneAgainPublication,
  });
  const tombstoneAgainStages = CATALOG.listAll().map((family) => {
    const familyId = family.plugin.manifest.familyId;
    if (familyId === fundingFamilyId) return tombstoneAgainStage;
    if (familyId === UNIV2_FAMILY_ID) return tombstoneAgainRouteStage;
    return fundingRoot.stageUnsupported({
      familyId,
      source: tombstoneAgainSource,
      outcomeRefs: ["shadow:not-wired"],
    });
  });
  const tombstoneAgainPrepared = fundingRoot.prepare({
    source: tombstoneAgainSource,
    previous: offersCommitted,
    stages: tombstoneAgainStages,
    sourceAnchors: anchors({
      canonical: tombstoneAgainSource,
      completeFamilyId: UNIV2_FAMILY_ID,
    }),
    sourceTransitionProof: transitionProof(
      fundingHarness.transitionIssuer,
      offersSource,
      tombstoneAgainSource,
    ),
  });
  await publish(fundingRoot, offersCommitted, tombstoneAgainPrepared);
  const tombstoneAgainCommitted = fundingRoot.capture()!;
  const tombstoneAgainState = [
    ...tombstoneAgainCommitted.views.fundingByPublicationKey.values(),
  ][0]!;
  assert.equal(tombstoneAgainState.tombstone, true);
  assert.equal(tombstoneAgainCommitted.envelope.snapshot.revision, 3);
  assert.deepEqual(strictFundingPublicationKeysByFamily({
    views: tombstoneAgainCommitted.views,
    familyId: familyId("swap:not-in-catalog"),
  }), []);

  console.log("adapter-family strict shadow catalog publication tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
