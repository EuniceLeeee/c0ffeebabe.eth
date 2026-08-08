import assert from "node:assert/strict";
import {
  AdapterFamilyCatalogPublicationStore,
  catalogDiscoverySourceFingerprint,
  catalogInstancePublicationKey,
  catalogPublicationDefinition,
  createCatalogPublicationValueAuthority,
  createCatalogSourceTransitionIssuer,
  createCatalogTerminalRemovalIssuer,
  prepareAdapterFamilyCatalogPublication,
  type AdapterFamilyCatalogDefinition,
  type AdapterFamilyCatalogPublicationEnvelope,
  type CatalogDiscoveryAuthority,
  type CatalogDiscoverySourceAnchor,
  type CatalogFamilyStage,
  type CatalogPublicationValueAuthority,
  type CatalogSourceTransitionProof,
  type CatalogTerminalRemovalIssuer,
  type CatalogStagedInstance,
  type CatalogStagedInstanceBundle,
  type CatalogTerminalRemovalProof,
} from "../adapter-family-catalog-publication.js";
import { familyId, type FamilyId } from "../venues/adapter-family-identifiers.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";

const SWAP = familyId("swap:catalog-publication-fixture");
const FUNDING = familyId("funding:catalog-publication-fixture");
const EXTRA = familyId("protocol:catalog-publication-extra");
const SOURCE_ID = "factory-log";
const CATALOG_HASH = "catalog-publication-fixture-v2";
const CHAIN_ID = "1";

interface InstanceValue {
  label: string;
  nested?: { count: number };
  boundGeneration?: number;
}

interface OpaqueValue {
  label: string;
  nested?: { count: number };
  boundGeneration?: number;
}

type Envelope = AdapterFamilyCatalogPublicationEnvelope<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
>;
type Stage = CatalogFamilyStage<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
>;
type Bundle = CatalogStagedInstanceBundle<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
>;
type ValueAuthority = CatalogPublicationValueAuthority<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
>;

const TERMINAL_ISSUER = createCatalogTerminalRemovalIssuer();
const TERMINAL = TERMINAL_ISSUER.authority;
const TRANSITION_ISSUER = createCatalogSourceTransitionIssuer();
const TRANSITION = TRANSITION_ISSUER.authority;
const VALUE_AUTHORITY = createCatalogPublicationValueAuthority<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
>({
  instance: plainValueContract<InstanceValue>(),
  routeHandle: plainValueContract<OpaqueValue>(),
  graphEntry: plainValueContract<OpaqueValue>(),
  pricingEntry: plainValueContract<OpaqueValue>(),
});

const DEFINITION: AdapterFamilyCatalogDefinition = Object.freeze({
  catalogHash: CATALOG_HASH,
  families: Object.freeze([
    Object.freeze({
      familyId: SWAP,
      domain: "swap" as const,
      sourceIds: Object.freeze([SOURCE_ID]),
      requiresGraphProjection: true,
      requiresPricingProjection: true,
    }),
    Object.freeze({
      familyId: FUNDING,
      domain: "funding" as const,
      sourceIds: Object.freeze([]),
      requiresGraphProjection: false,
      requiresPricingProjection: false,
    }),
  ]),
  terminalRemovalAuthority: TERMINAL,
  sourceTransitionAuthority: TRANSITION,
});

function source(
  number = 25_700_100,
  generation = number - 25_700_000,
): CanonicalSource {
  return Object.freeze({
    number,
    hash: `0x${number.toString(16).padStart(64, "0")}`,
    generation,
  });
}

function descriptor(
  label: string,
  fingerprint = `fingerprint:${label}`,
  valueOverride?: InstanceValue,
): CatalogStagedInstance<InstanceValue> {
  return {
    familyId: SWAP,
    lineageId: "univ2",
    instanceKey: `pool:${label}`,
    fingerprint,
    value: valueOverride ?? { label },
  };
}

function bundle(
  canonical: CanonicalSource,
  label: string,
  options: {
    readonly fingerprint?: string;
    readonly bundleKey?: string;
    readonly bundleSource?: CanonicalSource;
    readonly routeKey?: string;
    readonly graphKey?: string;
    readonly pricingKey?: string;
    readonly routeFingerprint?: string;
    readonly graphFingerprint?: string;
    readonly pricingFingerprint?: string;
    readonly noGraph?: boolean;
    readonly noPricing?: boolean;
    readonly value?: InstanceValue;
    readonly routeValue?: OpaqueValue;
  } = {},
): Bundle {
  const instance = descriptor(label, options.fingerprint, options.value);
  const publicationKey = catalogInstancePublicationKey(instance);
  const routeKey = options.routeKey ?? `edge:${label}`;
  return {
    instancePublicationKey: options.bundleKey ?? publicationKey,
    source: options.bundleSource ?? canonical,
    instance,
    routeHandles: new Map([[routeKey, {
      fingerprint: options.routeFingerprint ?? `route:${label}`,
      value: options.routeValue ?? { label: `route:${label}` },
    }]]),
    graphEntries: options.noGraph
      ? new Map()
      : new Map([[options.graphKey ?? routeKey, {
        fingerprint: options.graphFingerprint ?? `graph:${label}`,
        value: { label: `graph:${label}` },
      }]]),
    pricingEntries: options.noPricing
      ? new Map()
      : new Map([[options.pricingKey ?? `pricing:${label}`, {
        fingerprint: options.pricingFingerprint ?? `pricing:${label}`,
        value: { label: `pricing:${label}` },
      }]]),
  };
}

function fundingBundle(canonical: CanonicalSource): Bundle {
  const instance: CatalogStagedInstance<InstanceValue> = {
    familyId: FUNDING,
    lineageId: "funding-state",
    instanceKey: "state:funding",
    fingerprint: "funding-state:v1",
    value: { label: "funding-state" },
  };
  return {
    instancePublicationKey: catalogInstancePublicationKey(instance),
    source: canonical,
    instance,
    routeHandles: new Map(),
    graphEntries: new Map(),
    pricingEntries: new Map(),
  };
}

function anchor(
  canonical: CanonicalSource,
  options: {
    readonly status?: "complete" | "partial";
    readonly authority?: CatalogDiscoveryAuthority;
    readonly completeThroughBlock?: number;
    readonly completeThroughHash?: string | null;
    readonly fingerprintSource?: CanonicalSource;
  } = {},
): CatalogDiscoverySourceAnchor {
  const status = options.status ?? "complete";
  const completeThroughBlock = options.completeThroughBlock ??
    (status === "complete" ? canonical.number : -1);
  const completeThroughHash = options.completeThroughHash !== undefined
    ? options.completeThroughHash
    : status === "complete"
    ? canonical.hash
    : null;
  return Object.freeze({
    familyId: SWAP,
    sourceId: SOURCE_ID,
    sourceFingerprint: catalogDiscoverySourceFingerprint({
      familyId: SWAP,
      sourceId: SOURCE_ID,
      source: options.fingerprintSource ?? canonical,
    }),
    authority: options.authority ?? "append-only-nomination",
    status,
    completeThroughBlock,
    completeThroughHash,
  });
}

function swapStage(
  canonical: CanonicalSource,
  options: Partial<Omit<Stage, "familyId" | "domain" | "source">> = {},
): Stage {
  return Object.freeze({
    familyId: SWAP,
    domain: "swap",
    source: canonical,
    status: options.status ?? "resolved",
    inventoryMode: options.inventoryMode ?? "append-only-delta",
    instances: options.instances ?? [],
    ...(options.terminalRemovals === undefined
      ? {}
      : { terminalRemovals: options.terminalRemovals }),
    ...(options.outcomeRefs === undefined
      ? {}
      : { outcomeRefs: options.outcomeRefs }),
  });
}

function fundingStage(
  canonical: CanonicalSource,
  options: Partial<Omit<Stage, "familyId" | "domain" | "source">> = {},
): Stage {
  const status = options.status ?? "resolved";
  return Object.freeze({
    familyId: FUNDING,
    domain: "funding",
    source: canonical,
    status,
    inventoryMode: options.inventoryMode ?? "complete-snapshot",
    instances: options.instances ??
      (status === "unsupported" ? [] : [fundingBundle(canonical)]),
    ...(options.terminalRemovals === undefined
      ? {}
      : { terminalRemovals: options.terminalRemovals }),
    ...(options.outcomeRefs === undefined
      ? {}
      : { outcomeRefs: options.outcomeRefs }),
  });
}

function transition(
  previous: CanonicalSource,
  current: CanonicalSource,
  status: "canonical-descendant" | "unresolved" = "canonical-descendant",
): CatalogSourceTransitionProof {
  return TRANSITION_ISSUER.issue({
    previous,
    current,
    status,
    evidenceRef: `ancestry:${previous.number}:${current.number}`,
  });
}

function prepare(input: {
  readonly canonical: CanonicalSource;
  readonly previous?: Envelope | null;
  readonly swap?: Stage;
  readonly funding?: Stage;
  readonly anchors?: readonly CatalogDiscoverySourceAnchor[];
  readonly definition?: AdapterFamilyCatalogDefinition;
  readonly stages?: readonly Stage[];
  readonly transitionProof?: CatalogSourceTransitionProof;
  readonly valueAuthority?: ValueAuthority;
}): Envelope {
  return prepareAdapterFamilyCatalogPublication({
    definition: input.definition ?? DEFINITION,
    chainId: CHAIN_ID,
    source: input.canonical,
    previous: input.previous ?? null,
    stages: input.stages ?? [
      input.swap ?? swapStage(input.canonical),
      input.funding ?? fundingStage(input.canonical),
    ],
    sourceAnchors: input.anchors ?? [anchor(input.canonical)],
    valueAuthority: input.valueAuthority ?? VALUE_AUTHORITY,
    ...(input.transitionProof === undefined
      ? {}
      : { sourceTransitionProof: input.transitionProof }),
  });
}

async function publish(
  store: AdapterFamilyCatalogPublicationStore<
    InstanceValue,
    OpaqueValue,
    OpaqueValue,
    OpaqueValue
  >,
  expected: Envelope | null,
  staged: Envelope,
): Promise<void> {
  assert.equal(await store.compareAndPublish({
    expected,
    staged,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  }), true);
}

function publicationStore(
  valueAuthority: ValueAuthority = VALUE_AUTHORITY,
): AdapterFamilyCatalogPublicationStore<
  InstanceValue,
  OpaqueValue,
  OpaqueValue,
  OpaqueValue
> {
  return new AdapterFamilyCatalogPublicationStore({
    definition: DEFINITION,
    chainId: CHAIN_ID,
    valueAuthority,
  });
}

function initialWithInstance(canonical: CanonicalSource): Envelope {
  return prepare({
    canonical,
    swap: swapStage(canonical, {
      inventoryMode: "complete-snapshot",
      instances: [bundle(canonical, "incumbent")],
    }),
    anchors: [anchor(canonical, { authority: "complete-snapshot" })],
  });
}

function terminalProof(
  canonical: CanonicalSource,
  options: {
    readonly issuer?: CatalogTerminalRemovalIssuer;
    readonly familyId?: FamilyId;
    readonly status?: "terminal" | "unresolved";
    readonly evidenceRef?: string;
  } = {},
): CatalogTerminalRemovalProof {
  return (options.issuer ?? TERMINAL_ISSUER).issue({
    familyId: options.familyId ?? SWAP,
    lineageId: "univ2",
    instanceKey: "pool:incumbent",
    source: canonical,
    status: options.status ?? "terminal",
    reason: "reverse-identity-terminal-reject",
    evidenceRef: options.evidenceRef ?? "probe:incumbent",
  });
}

function testDefinitionDerivesEveryCatalogFamily(): void {
  const mock = {
    catalogHash: "derived-catalog-hash",
    listAll: () => [
      {
        plugin: {
          manifest: { familyId: SWAP, domain: "swap" },
          discovery: { sources: ["landed-log", "factory-log", "landed-log"] },
        },
      },
      {
        plugin: {
          manifest: { familyId: FUNDING, domain: "funding" },
          funding: {},
        },
      },
    ],
  } as unknown as Pick<FamilyCapabilityCatalog, "catalogHash" | "listAll">;
  const derived = catalogPublicationDefinition(mock, {
    terminalRemovalAuthority: TERMINAL,
    sourceTransitionAuthority: TRANSITION,
  });
  assert.deepEqual(
    derived.families.map((family) => family.familyId),
    [FUNDING, SWAP],
  );
  assert.equal(derived.families[0]?.requiresGraphProjection, false);
  assert.equal(derived.families[1]?.requiresGraphProjection, true);
  assert.equal(derived.families[1]?.requiresPricingProjection, true);
  assert.deepEqual(derived.families[1]?.sourceIds, ["factory-log", "landed-log"]);
  assert.equal("issue" in derived.terminalRemovalAuthority, false);
  assert.equal("issue" in derived.sourceTransitionAuthority, false);
}

function testExactFamilyStageMatrixAndAuthority(): void {
  const canonical = source();
  assert.throws(() => prepare({ canonical, stages: [swapStage(canonical)] }),
    /missing Family/);
  assert.throws(() => prepare({
    canonical,
    stages: [swapStage(canonical), swapStage(canonical), fundingStage(canonical)],
  }), /duplicates Family/);
  assert.throws(() => prepare({
    canonical,
    stages: [swapStage(canonical), fundingStage(canonical), {
      familyId: EXTRA,
      domain: "protocol",
      source: canonical,
      status: "resolved",
      inventoryMode: "append-only-delta",
      instances: [],
    }],
  }), /extra Family/);
  assert.throws(() => prepare({
    canonical,
    definition: {
      ...DEFINITION,
      terminalRemovalAuthority: Object.freeze({ issue: () => ({}) }) as never,
    },
  }), /terminal removal authority was not centrally issued/);
}

function testPartialAndUnsupportedAreExplicit(): void {
  const canonical = source();
  const publication = prepare({
    canonical,
    swap: swapStage(canonical, {
      status: "partial",
      outcomeRefs: ["factory-log-timeout"],
    }),
    funding: fundingStage(canonical, {
      status: "unsupported",
      inventoryMode: "append-only-delta",
      outcomeRefs: ["funding-shadow-not-wired"],
    }),
    anchors: [anchor(canonical, { status: "partial" })],
  });
  assert.equal(publication.snapshot.status, "shadow-partial");
  assert.equal(publication.snapshot.familyStatuses.get(SWAP)?.status, "partial");
  assert.equal(publication.snapshot.familyStatuses.get(FUNDING)?.status, "unsupported");
}

function testFundingUsesAtomicInstanceStateWithoutRouteProjection(): void {
  const canonical = source();
  const publication = prepare({ canonical });
  const fundingKey = catalogInstancePublicationKey({
    familyId: FUNDING,
    lineageId: "funding-state",
    instanceKey: "state:funding",
  });
  assert.equal(publication.privateState.instances.has(fundingKey), true);
  assert.equal(publication.privateState.routeHandles.size, 0);
  assert.equal(publication.privateState.graphEntries.size, 0);
  assert.equal(publication.privateState.pricingEntries.size, 0);

  assert.throws(() => prepare({
    canonical,
    funding: fundingStage(canonical, { instances: [] }),
  }), /resolved funding Family .* lacks atomic instance state/);
}

function testAppendOnlyCompletenessRequiresAncestryProof(): void {
  const firstSource = source();
  const firstAppendOnly = prepare({ canonical: firstSource });
  assert.equal(firstAppendOnly.snapshot.status, "shadow-partial");

  const baseline = prepare({
    canonical: firstSource,
    swap: swapStage(firstSource, { inventoryMode: "complete-snapshot" }),
    anchors: [anchor(firstSource, { authority: "complete-snapshot" })],
  });
  assert.equal(baseline.snapshot.status, "shadow-complete");
  const nextSource = source(25_700_101);
  const missingProof = prepare({ canonical: nextSource, previous: baseline });
  assert.equal(missingProof.snapshot.status, "shadow-partial");
  assert.equal(missingProof.snapshot.sourceTransition, null);

  const unresolved = prepare({
    canonical: nextSource,
    previous: baseline,
    transitionProof: transition(firstSource, nextSource, "unresolved"),
  });
  assert.equal(unresolved.snapshot.status, "shadow-partial");

  const complete = prepare({
    canonical: nextSource,
    previous: baseline,
    transitionProof: transition(firstSource, nextSource),
  });
  assert.equal(complete.snapshot.status, "shadow-complete");
  assert.equal(complete.snapshot.sourceTransition?.status, "canonical-descendant");

  const foreign = createCatalogSourceTransitionIssuer().issue({
    previous: firstSource,
    current: nextSource,
    status: "canonical-descendant",
    evidenceRef: "foreign",
  });
  assert.throws(() => prepare({
    canonical: nextSource,
    previous: baseline,
    transitionProof: foreign,
  }), /source transition proof is forged or foreign/);
  assert.throws(() => prepare({
    canonical: nextSource,
    previous: baseline,
    transitionProof: transition(source(25_700_099), nextSource),
  }), /source transition predecessor canonical source mismatch/);
}

async function testResolvedFamiliesPublishByOnePointerSwap(): Promise<void> {
  const canonical = source();
  const publication = prepare({
    canonical,
    swap: swapStage(canonical, { inventoryMode: "complete-snapshot" }),
    anchors: [anchor(canonical, { authority: "complete-snapshot" })],
  });
  const store = publicationStore();
  let verified = 0;
  let fenced = 0;
  assert.equal(await store.compareAndPublish({
    expected: null,
    staged: publication,
    verifyCanonicalSource: () => {
      verified++;
    },
    assertGenerationCurrent: () => {
      fenced++;
    },
  }), true);
  assert.equal(verified, 1);
  assert.equal(fenced, 1);
  assert.equal(store.capture(), publication);
}

function testOpaqueBundlesAreInstanceAndSourceBound(): void {
  const canonical = source();
  const publication = initialWithInstance(canonical);
  const key = catalogInstancePublicationKey(descriptor("incumbent"));
  const route = publication.privateState.routeHandles.get("edge:incumbent")!;
  const graph = publication.privateState.graphEntries.get("edge:incumbent")!;
  const pricing = publication.privateState.pricingEntries.get("pricing:incumbent")!;
  for (const entry of [route, graph, pricing]) {
    assert.equal(entry.instancePublicationKey, key);
    assert.equal(entry.familyId, SWAP);
    assert.equal(entry.lineageId, "univ2");
    assert.equal(entry.instanceKey, "pool:incumbent");
    assert.deepEqual(entry.source, canonical);
    assert.equal(Object.isFrozen(entry), true);
  }

  assert.throws(() => prepare({
    canonical,
    swap: swapStage(canonical, {
      instances: [bundle(canonical, "wrong-key", { bundleKey: "forged" })],
    }),
  }), /publication key .* does not match/);
  assert.throws(() => prepare({
    canonical,
    swap: swapStage(canonical, {
      instances: [bundle(canonical, "old-source", {
        bundleSource: source(25_700_099),
      })],
    }),
  }), /staged bundle .* canonical source mismatch/);
  assert.throws(() => prepare({
    canonical,
    swap: swapStage(canonical, {
      instances: [bundle(canonical, "mismatch", { graphKey: "other-edge" })],
    }),
  }), /key sets differ|missing route-handle key/);
  assert.throws(() => prepare({
    canonical,
    swap: swapStage(canonical, {
      instances: [bundle(canonical, "no-pricing", { noPricing: true })],
    }),
  }), /no required pricing projection/);
}

function testCarryAndRemovalCannotLoseOrRetainOpaqueMaps(): void {
  const firstSource = source();
  const first = initialWithInstance(firstSource);
  const key = catalogInstancePublicationKey(descriptor("incumbent"));
  const nextSource = source(25_700_101);
  const carried = prepare({ canonical: nextSource, previous: first });
  assert.equal(carried.privateState.instances.has(key), true);
  assert.equal(
    carried.privateState.routeHandles.get("edge:incumbent")
      ?.instancePublicationKey,
    key,
  );
  assert.deepEqual(
    carried.privateState.routeHandles.get("edge:incumbent")?.source,
    nextSource,
  );
  assert.deepEqual(carried.snapshot.delta.carried.map((entry) => entry.key), [key]);

  const removed = prepare({
    canonical: nextSource,
    previous: first,
    swap: swapStage(nextSource, { inventoryMode: "complete-snapshot" }),
    anchors: [anchor(nextSource, { authority: "complete-snapshot" })],
  });
  assert.equal(removed.privateState.instances.has(key), false);
  assert.equal(removed.privateState.routeHandles.has("edge:incumbent"), false);
  assert.equal(removed.privateState.graphEntries.has("edge:incumbent"), false);
  assert.equal(removed.privateState.pricingEntries.has("pricing:incumbent"), false);
  assert.equal(removed.privateState.tombstones.has(key), true);

  const forgedPrevious = {
    ...first,
    privateState: {
      ...first.privateState,
      routeHandles: new Map(),
    },
  } as Envelope;
  assert.throws(() => prepare({
    canonical: nextSource,
    previous: forgedPrevious,
  }), /publication predecessor was not centrally issued/);
}

function testCarryRequiresAuthorityToReissueSourceBoundValues(): void {
  const firstSource = source();
  const nextSource = source(25_700_101);
  const authority = generationBoundAuthority(false);
  const first = prepare({
    canonical: firstSource,
    valueAuthority: authority,
    swap: swapStage(firstSource, {
      inventoryMode: "complete-snapshot",
      instances: [bundle(firstSource, "bound-handle")],
    }),
    anchors: [anchor(firstSource, { authority: "complete-snapshot" })],
  });
  assert.equal(
    first.privateState.routeHandles.get("edge:bound-handle")?.value
      .boundGeneration,
    firstSource.generation,
  );

  const carried = prepare({
    canonical: nextSource,
    previous: first,
    valueAuthority: authority,
  });
  const instanceKey = catalogInstancePublicationKey(descriptor("bound-handle"));
  assert.equal(
    carried.privateState.instances.get(instanceKey)?.value.boundGeneration,
    nextSource.generation,
  );
  assert.equal(
    carried.privateState.routeHandles.get("edge:bound-handle")?.value
      .boundGeneration,
    nextSource.generation,
  );
  assert.equal(
    carried.privateState.graphEntries.get("edge:bound-handle")?.value
      .boundGeneration,
    nextSource.generation,
  );
  assert.equal(
    carried.privateState.pricingEntries.get("pricing:bound-handle")?.value
      .boundGeneration,
    nextSource.generation,
  );

  const brokenAuthority = generationBoundAuthority(true);
  const brokenFirst = prepare({
    canonical: firstSource,
    valueAuthority: brokenAuthority,
    swap: swapStage(firstSource, {
      inventoryMode: "complete-snapshot",
      instances: [bundle(firstSource, "stale-handle")],
    }),
    anchors: [anchor(firstSource, { authority: "complete-snapshot" })],
  });
  assert.throws(() => prepare({
    canonical: nextSource,
    previous: brokenFirst,
    valueAuthority: brokenAuthority,
  }), /value remains bound to generation .* expected/);
}

function testUnchangedInstanceCannotChangeOpaqueBinding(): void {
  const first = initialWithInstance(source());
  const nextSource = source(25_700_101);
  assert.throws(() => prepare({
    canonical: nextSource,
    previous: first,
    swap: swapStage(nextSource, {
      instances: [bundle(nextSource, "incumbent", {
        routeKey: "edge:changed",
        graphKey: "edge:changed",
      })],
    }),
  }), /unchanged instance changes .* route handles/);

  const changed = prepare({
    canonical: nextSource,
    previous: first,
    swap: swapStage(nextSource, {
      instances: [bundle(nextSource, "incumbent", {
        fingerprint: "fingerprint:incumbent:v2",
        routeKey: "edge:changed",
        graphKey: "edge:changed",
      })],
    }),
  });
  assert.equal(changed.privateState.routeHandles.has("edge:changed"), true);
  assert.equal(changed.privateState.routeHandles.has("edge:incumbent"), false);
}

function testOpaqueKeysCannotCollideAcrossInstances(): void {
  const canonical = source();
  assert.throws(() => prepare({
    canonical,
    swap: swapStage(canonical, {
      instances: [
        bundle(canonical, "one", {
          routeKey: "edge:collision",
          graphKey: "edge:collision",
        }),
        bundle(canonical, "two", {
          routeKey: "edge:collision",
          graphKey: "edge:collision",
        }),
      ],
    }),
  }), /owned by multiple instances/);
}

function testTerminalRemovalRequiresIssuerBoundResolvedProof(): void {
  const first = initialWithInstance(source());
  const nextSource = source(25_700_101);
  const next = prepare({
    canonical: nextSource,
    previous: first,
    swap: swapStage(nextSource, {
      status: "partial",
      terminalRemovals: [terminalProof(nextSource)],
      outcomeRefs: ["probe:incumbent"],
    }),
    anchors: [anchor(nextSource, { status: "partial" })],
  });
  const key = catalogInstancePublicationKey(descriptor("incumbent"));
  assert.equal(next.privateState.instances.has(key), false);
  assert.equal(next.privateState.tombstones.get(key)?.outcomeRef, "probe:incumbent");
  assert.equal(next.privateState.routeHandles.size, 0);

  const cases: readonly [CatalogTerminalRemovalProof, RegExp, readonly string[]][] = [
    [Object.freeze({}) as CatalogTerminalRemovalProof, /forged or foreign/, ["probe:incumbent"]],
    [terminalProof(nextSource, {
      issuer: createCatalogTerminalRemovalIssuer(),
    }), /forged or foreign/, ["probe:incumbent"]],
    [terminalProof(nextSource, {
      familyId: FUNDING,
    }), /staged a foreign terminal proof/, ["probe:incumbent"]],
    [terminalProof(source(25_700_099)), /canonical source mismatch/, ["probe:incumbent"]],
    [terminalProof(nextSource, { status: "unresolved" }), /unresolved/, ["probe:incumbent"]],
    [terminalProof(nextSource), /missing from Family outcomeRefs/, ["different-outcome"]],
  ];
  for (const [proof, expected, outcomeRefs] of cases) {
    assert.throws(() => prepare({
      canonical: nextSource,
      previous: first,
      swap: swapStage(nextSource, {
        status: "partial",
        terminalRemovals: [proof],
        outcomeRefs,
      }),
      anchors: [anchor(nextSource, { status: "partial" })],
    }), expected);
  }
}

function testContentIsSealedBeforePublication(): void {
  const canonical = source();
  const mutableInstance: InstanceValue = { label: "mutable", nested: { count: 1 } };
  const mutableRoute: OpaqueValue = { label: "route", nested: { count: 2 } };
  const publication = prepare({
    canonical,
    swap: swapStage(canonical, {
      instances: [bundle(canonical, "mutable", {
        value: mutableInstance,
        routeValue: mutableRoute,
      })],
    }),
  });
  mutableInstance.label = "changed";
  mutableInstance.nested!.count = 99;
  mutableRoute.label = "changed";
  mutableRoute.nested!.count = 99;
  const key = catalogInstancePublicationKey(descriptor("mutable"));
  assert.equal(publication.privateState.instances.get(key)?.value.label, "mutable");
  assert.equal(publication.privateState.instances.get(key)?.value.nested?.count, 1);
  assert.equal(publication.privateState.routeHandles.get("edge:mutable")?.value.label, "route");
  assert.equal(publication.privateState.routeHandles.get("edge:mutable")?.value.nested?.count, 2);

  const unsafeAuthority = createCatalogPublicationValueAuthority<
    InstanceValue, OpaqueValue, OpaqueValue, OpaqueValue
  >({
    instance: {
      seal: (value) => value,
      carry: (value) => value,
      assertValid: () => {},
    },
    routeHandle: plainValueContract<OpaqueValue>(),
    graphEntry: plainValueContract<OpaqueValue>(),
    pricingEntry: plainValueContract<OpaqueValue>(),
  });
  assert.throws(() => prepareAdapterFamilyCatalogPublication({
    definition: DEFINITION,
    chainId: CHAIN_ID,
    source: canonical,
    previous: null,
    stages: [
      swapStage(canonical, { instances: [bundle(canonical, "unsafe")] }),
      fundingStage(canonical),
    ],
    sourceAnchors: [anchor(canonical)],
    valueAuthority: unsafeAuthority,
  }), /authority returned an unsealed value/);
}

async function testCasFailureCannotChangeSealedContent(): Promise<void> {
  const first = initialWithInstance(source());
  const nextSource = source(25_700_101);
  const mutableInstance: InstanceValue = {
    label: "candidate",
    nested: { count: 7 },
  };
  const staged = prepare({
    canonical: nextSource,
    previous: first,
    swap: swapStage(nextSource, {
      instances: [bundle(nextSource, "candidate", { value: mutableInstance })],
    }),
  });
  const candidateKey = catalogInstancePublicationKey(descriptor("candidate"));
  mutableInstance.label = "input-mutated";
  mutableInstance.nested!.count = 99;

  const store = publicationStore();
  await publish(store, null, first);
  await assert.rejects(store.compareAndPublish({
    expected: first,
    staged,
    verifyCanonicalSource: () => {
      assert.throws(() => {
        staged.privateState.instances.get(candidateKey)!.value.label = "callback";
      }, TypeError);
      throw new Error("canonical source changed");
    },
    assertGenerationCurrent: () => {},
  }), /canonical source changed/);
  assert.equal(store.capture(), first);
  assert.equal(
    staged.privateState.instances.get(candidateKey)?.value.label,
    "candidate",
  );
  assert.equal(
    staged.privateState.instances.get(candidateKey)?.value.nested?.count,
    7,
  );
}

async function testCasRejectsCloneAndForeignPredecessorBeforeCallback(): Promise<void> {
  const foreignValueAuthority = createCatalogPublicationValueAuthority<
    InstanceValue, OpaqueValue, OpaqueValue, OpaqueValue
  >({
    instance: plainValueContract<InstanceValue>(),
    routeHandle: plainValueContract<OpaqueValue>(),
    graphEntry: plainValueContract<OpaqueValue>(),
    pricingEntry: plainValueContract<OpaqueValue>(),
  });
  const initialSource = source();
  const foreignInitial = prepareAdapterFamilyCatalogPublication({
    definition: DEFINITION,
    chainId: CHAIN_ID,
    source: initialSource,
    previous: null,
    stages: [swapStage(initialSource), fundingStage(initialSource)],
    sourceAnchors: [anchor(initialSource)],
    valueAuthority: foreignValueAuthority,
  });
  let foreignCallbacks = 0;
  await assert.rejects(publicationStore().compareAndPublish({
    expected: null,
    staged: foreignInitial,
    verifyCanonicalSource: () => {
      foreignCallbacks++;
    },
    assertGenerationCurrent: () => {
      foreignCallbacks++;
    },
  }), /does not match store authority/);
  assert.equal(foreignCallbacks, 0);

  const firstA = initialWithInstance(source());
  const firstB = initialWithInstance(source());
  const nextSource = source(25_700_101);
  const fromA = prepare({ canonical: nextSource, previous: firstA });
  const fromB = prepare({ canonical: nextSource, previous: firstB });
  const store = publicationStore();
  await publish(store, null, firstA);
  let callbacks = 0;
  await assert.rejects(store.compareAndPublish({
    expected: firstA,
    staged: { ...fromA } as Envelope,
    verifyCanonicalSource: () => {
      callbacks++;
    },
    assertGenerationCurrent: () => {
      callbacks++;
    },
  }), /staged publication was not centrally issued/);
  await assert.rejects(store.compareAndPublish({
    expected: firstA,
    staged: fromB,
    verifyCanonicalSource: () => {
      callbacks++;
    },
    assertGenerationCurrent: () => {
      callbacks++;
    },
  }), /foreign predecessor/);
  assert.equal(callbacks, 0);
  assert.equal(store.capture(), firstA);

  const clonedPrevious = { ...firstA } as Envelope;
  assert.throws(() => prepare({
    canonical: nextSource,
    previous: clonedPrevious,
  }), /publication predecessor was not centrally issued/);
}

async function testFailuresAndRacePreservePublishedIdentity(): Promise<void> {
  const first = initialWithInstance(source());
  const nextSource = source(25_700_101);
  const losing = prepare({ canonical: nextSource, previous: first });
  const winning = prepare({ canonical: nextSource, previous: first });
  const store = publicationStore();
  await publish(store, null, first);
  const identities = captureNestedIdentities(first);

  await assert.rejects(store.compareAndPublish({
    expected: first,
    staged: losing,
    verifyCanonicalSource: () => {
      throw new Error("canonical source changed");
    },
    assertGenerationCurrent: () => {},
  }), /canonical source changed/);
  assert.equal(store.capture(), first);
  assertNestedIdentities(store.capture()!, identities);

  await assert.rejects(store.compareAndPublish({
    expected: first,
    staged: losing,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {
      throw new Error("generation superseded");
    },
  }), /generation superseded/);
  assert.equal(store.capture(), first);
  assertNestedIdentities(store.capture()!, identities);

  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => release = resolve);
  const verificationEntered = new Promise<void>((resolve) => entered = resolve);
  let losingFenceCalls = 0;
  const losingAttempt = store.compareAndPublish({
    expected: first,
    staged: losing,
    verifyCanonicalSource: async () => {
      entered();
      await blocked;
    },
    assertGenerationCurrent: () => losingFenceCalls++,
  });
  await verificationEntered;
  await publish(store, first, winning);
  release();
  assert.equal(await losingAttempt, false);
  assert.equal(losingFenceCalls, 0);
  assert.equal(store.capture(), winning);
}

function testSourceFingerprintAndHashValidation(): void {
  const canonical = source();
  assert.throws(() => prepare({
    canonical,
    anchors: [anchor(canonical, { fingerprintSource: source(25_700_099) })],
  }), /source fingerprint mismatch/);
  assert.throws(() => prepare({
    canonical,
    anchors: [anchor(canonical, { completeThroughHash: `0x${"ff".repeat(32)}` })],
  }), /source anchor hash does not match/);
  const uppercase = Object.freeze({
    ...canonical,
    hash: `0x${canonical.hash.slice(2).toUpperCase()}`,
  });
  const publication = prepare({
    canonical,
    stages: [
      swapStage(uppercase, { inventoryMode: "complete-snapshot" }),
      fundingStage(uppercase),
    ],
    anchors: [anchor(uppercase, { authority: "complete-snapshot" })],
  });
  assert.equal(publication.snapshot.source.hash, canonical.hash.toLowerCase());
  assert.throws(() => prepare({
    canonical: { ...canonical, hash: "0x01" },
  }), /32-byte hex value/);
}

function captureNestedIdentities(envelope: Envelope) {
  return {
    snapshot: envelope.snapshot,
    familyStatuses: envelope.snapshot.familyStatuses,
    sourceAnchors: envelope.snapshot.sourceAnchors,
    delta: envelope.snapshot.delta,
    privateState: envelope.privateState,
    instances: envelope.privateState.instances,
    tombstones: envelope.privateState.tombstones,
    routeHandles: envelope.privateState.routeHandles,
    graphEntries: envelope.privateState.graphEntries,
    pricingEntries: envelope.privateState.pricingEntries,
  };
}

function assertNestedIdentities(
  envelope: Envelope,
  identities: ReturnType<typeof captureNestedIdentities>,
): void {
  assert.equal(envelope.snapshot, identities.snapshot);
  assert.equal(envelope.snapshot.familyStatuses, identities.familyStatuses);
  assert.equal(envelope.snapshot.sourceAnchors, identities.sourceAnchors);
  assert.equal(envelope.snapshot.delta, identities.delta);
  assert.equal(envelope.privateState, identities.privateState);
  assert.equal(envelope.privateState.instances, identities.instances);
  assert.equal(envelope.privateState.tombstones, identities.tombstones);
  assert.equal(envelope.privateState.routeHandles, identities.routeHandles);
  assert.equal(envelope.privateState.graphEntries, identities.graphEntries);
  assert.equal(envelope.privateState.pricingEntries, identities.pricingEntries);
}

function plainValueContract<Value>() {
  return {
    seal: (value: Value): Value => deepCloneAndFreeze(value),
    carry: (value: Value): Value => deepCloneAndFreeze(value),
    assertValid: (value: Value): void => assertDeepFrozenPlain(value),
  };
}

function generationBoundAuthority(
  brokenCarry: boolean,
): ValueAuthority {
  return createCatalogPublicationValueAuthority({
    instance: generationBoundValueContract<InstanceValue>(brokenCarry),
    routeHandle: generationBoundValueContract<OpaqueValue>(brokenCarry),
    graphEntry: generationBoundValueContract<OpaqueValue>(brokenCarry),
    pricingEntry: generationBoundValueContract<OpaqueValue>(brokenCarry),
  });
}

function generationBoundValueContract<
  Value extends { boundGeneration?: number },
>(brokenCarry: boolean) {
  return {
    seal: (value: Value, binding: { readonly source: CanonicalSource }): Value =>
      deepCloneAndFreeze({
        ...value,
        boundGeneration: binding.source.generation,
      } as Value),
    carry: (
      value: Value,
      binding: {
        readonly current: { readonly source: CanonicalSource };
      },
    ): Value => brokenCarry
      ? value
      : deepCloneAndFreeze({
        ...value,
        boundGeneration: binding.current.source.generation,
      } as Value),
    assertValid: (
      value: Value,
      binding: { readonly source: CanonicalSource },
    ): void => {
      assertDeepFrozenPlain(value);
      if (value.boundGeneration !== binding.source.generation) {
        throw new Error(
          `value remains bound to generation ${String(value.boundGeneration)}; ` +
            `expected ${binding.source.generation}`,
        );
      }
    },
  };
}

function deepCloneAndFreeze<Value>(value: Value): Value {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => deepCloneAndFreeze(item))) as Value;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("plain fixture authority rejects opaque non-plain values");
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = deepCloneAndFreeze(item);
  }
  return Object.freeze(copy) as Value;
}

function assertDeepFrozenPlain(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true, "fixture value must be frozen");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("fixture value must remain plain");
  }
  for (const item of Object.values(value)) assertDeepFrozenPlain(item);
}

async function main(): Promise<void> {
  testDefinitionDerivesEveryCatalogFamily();
  testExactFamilyStageMatrixAndAuthority();
  testPartialAndUnsupportedAreExplicit();
  testFundingUsesAtomicInstanceStateWithoutRouteProjection();
  testAppendOnlyCompletenessRequiresAncestryProof();
  await testResolvedFamiliesPublishByOnePointerSwap();
  testOpaqueBundlesAreInstanceAndSourceBound();
  testCarryAndRemovalCannotLoseOrRetainOpaqueMaps();
  testCarryRequiresAuthorityToReissueSourceBoundValues();
  testUnchangedInstanceCannotChangeOpaqueBinding();
  testOpaqueKeysCannotCollideAcrossInstances();
  testTerminalRemovalRequiresIssuerBoundResolvedProof();
  testContentIsSealedBeforePublication();
  await testCasFailureCannotChangeSealedContent();
  await testCasRejectsCloneAndForeignPredecessorBeforeCallback();
  await testFailuresAndRacePreservePublishedIdentity();
  testSourceFingerprintAndHashValidation();
  console.log("adapter-family catalog publication tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
