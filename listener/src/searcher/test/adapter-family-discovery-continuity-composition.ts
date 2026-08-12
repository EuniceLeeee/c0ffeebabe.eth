import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDurableDiscoveryContinuityComposition,
} from "../adapter-family-discovery-continuity-composition.js";
import {
  CheckpointDiscoveryInventoryEnumerator,
  type DiscoveryInventoryEnumerator,
} from "../adapter-family-discovery-inventory-enumerator.js";
import {
  type CatalogDiscoverySourceAnchor,
  catalogDiscoverySourceFingerprint,
  catalogFamilySourceAnchorKey,
  catalogInstancePublicationKey,
} from "../adapter-family-catalog-publication.js";
import {
  type AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily,
} from "../adapter-family-discovery-checkpoint.js";
import type {
  StrictShadowCatalogFamilyStage,
} from "../adapter-family-shadow-catalog-publication.js";
import {
  adapterFamilySnapshotInventoryHash,
  type AdapterFamilySnapshotInventoryClosureCandidateInput,
  type AdapterFamilySnapshotInventoryClosureReceipt,
  type AdapterFamilySnapshotInventoryEnumerationFamilyInput,
  type AdapterFamilySnapshotInventoryEnumerationIncumbentInput,
  type AdapterFamilySnapshotInventoryEnumerationInput,
  type AdapterFamilySnapshotInventoryFamilyInput,
  type AdapterFamilySnapshotInventoryIncumbentInput,
  type AdapterFamilySnapshotTerminalCandidateInput,
} from "../adapter-family-snapshot-inventory-closure.js";
import type {
  AdapterFamilyDiscoveryCheckpointCandidateWatermark,
  AdapterFamilyDiscoveryCheckpointReceipt,
} from "../adapter-family-discovery-checkpoint.js";
import {
  definedFamilyPluginContractSummary,
  type AnyDefinedStrictFamilyPlugin,
  type DiscoverySourceKind,
  type UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import type { FamilyId } from
  "../venues/adapter-family-identifiers.js";
import {
  capabilityManifestHash,
  FAMILY_CAPABILITY_NAMES,
  FamilyCapabilityCatalog,
  type GeneratedCapabilityIdentity,
} from "../venues/family-capability-catalog.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import { UNIV2_FAMILY_ID } from
  "../venues/swaps/univ2-family/manifest.js";
import { ASTRA_MULTITOKEN_FAMILY_ID } from
  "../venues/protocols/astra-multitoken-family/manifest.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_TOPIC,
} from "../venues/swaps/univ2-family/codec.js";
import {
  runWstethLifecycle,
  runUniv2Lifecycle,
  UNIV2_FIXTURE_FACTORY,
  UNIV2_FIXTURE_POOL,
  UNIV2_FIXTURE_TOKEN0,
  UNIV2_FIXTURE_TOKEN1,
} from "../architecture-migration-fixture-replay.js";

type AddressSurfaceObservation = Extract<
  UnifiedObservation,
  { readonly kind: "address-surface" }
>;

const CHAIN_ID = "1";
const SOURCE_REGISTRY_FINGERPRINT = "strict-source-registry-v1";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const UNIV2_CANDIDATE_KEY = UNIV2_FIXTURE_POOL.toLowerCase();
const EVENT_SOURCES: ReadonlySet<DiscoverySourceKind> = new Set([
  "factory-log",
  "landed-log",
  "observed-call",
]);
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});

function familyCatalog(modules: readonly {
  readonly plugin: AnyDefinedStrictFamilyPlugin;
  readonly sourceFile: string;
}[]): FamilyCapabilityCatalog {
  const entries = modules.flatMap((module, moduleIndex) => {
    const summary = definedFamilyPluginContractSummary(module.plugin);
    return FAMILY_CAPABILITY_NAMES.map((capability, index) =>
      Object.freeze({
        familyId: summary.familyId,
        capability,
        contractVersion: "adapter-family-contract-v1",
        contentHash: `${moduleIndex.toString(16)}${index.toString(16)
          .padStart(63, "0")}`,
        semanticDependencies: Object.freeze([]),
        provenanceCommit: null,
      }) satisfies GeneratedCapabilityIdentity
    );
  });
  return new FamilyCapabilityCatalog({
    modules: Object.freeze(modules.map((module) => Object.freeze({
      sourceFile: module.sourceFile,
      definitionBoundaryHash:
        definedFamilyPluginContractSummary(module.plugin).definitionBoundaryHash,
      plugin: module.plugin,
    }))),
    generatedManifest: Object.freeze({
      format: "adapter-family-capabilities-v1",
      entries: Object.freeze(entries),
      manifestHash: capabilityManifestHash(entries),
    }),
  });
}

function singleFamilyCatalog(input: {
  readonly plugin: AnyDefinedStrictFamilyPlugin;
  readonly sourceFile: string;
}): FamilyCapabilityCatalog {
  return familyCatalog([input]);
}

function syntheticCatalog(): FamilyCapabilityCatalog {
  return singleFamilyCatalog({
    plugin: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
      .forStrictFamily(WSTETH_FAMILY_ID).plugin,
    sourceFile: "wsteth-family-plugin.ts",
  });
}

function univ2Catalog(): FamilyCapabilityCatalog {
  return singleFamilyCatalog({
    plugin: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
      .forStrictFamily(UNIV2_FAMILY_ID).plugin,
    sourceFile: "univ2-family-plugin.ts",
  });
}

function mixedCatalog(): FamilyCapabilityCatalog {
  return familyCatalog([
    {
      plugin: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .forStrictFamily(WSTETH_FAMILY_ID).plugin,
      sourceFile: "wsteth-family-plugin.ts",
    },
    {
      plugin: PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .forStrictFamily(ASTRA_MULTITOKEN_FAMILY_ID).plugin,
      sourceFile: "astra-multitoken-family-plugin.ts",
    },
  ]);
}

function surface(canonical: CanonicalSource): AddressSurfaceObservation {
  return Object.freeze({
    kind: "address-surface" as const,
    source: canonical,
    address: WSTETH,
    codeHash: `0x${"1".repeat(64)}`,
    implementationWord: `0x${"0".repeat(64)}`,
    interfaceFingerprints: Object.freeze(["wsteth-conversion-surface-v1"]),
  });
}

function terminalCandidate(
  admittedKeys: readonly string[] = ["protocol:wsteth:fixture-instance"],
): AdapterFamilySnapshotTerminalCandidateInput {
  return Object.freeze({
    candidateKey: WSTETH.toLowerCase(),
    status: "terminal" as const,
    outcomeFingerprint: "3".repeat(64),
    evidenceRefs: Object.freeze(["fixture:terminal-evidence"]),
    admittedInstancePublicationKeys: Object.freeze([...admittedKeys]),
    publicationFingerprints: Object.freeze(["4".repeat(64)]),
  });
}

function candidateIncumbent(
  canonical: CanonicalSource,
  admittedKeys?: readonly string[],
): AdapterFamilySnapshotInventoryIncumbentInput {
  return Object.freeze({
    inventoryKey: "legacy:wsteth",
    address: WSTETH,
    currentSurface: surface(canonical),
    terminalCandidates: Object.freeze([terminalCandidate(admittedKeys)]),
  });
}

function enumerationIncumbent(
  canonical: CanonicalSource,
) {
  return Object.freeze({
    inventoryKey: "legacy:wsteth",
    address: WSTETH,
    currentSurface: surface(canonical),
  });
}

function candidateFamily(
  canonical: CanonicalSource,
  incumbents: readonly AdapterFamilySnapshotInventoryIncumbentInput[],
  owner: FamilyId = WSTETH_FAMILY_ID,
): AdapterFamilySnapshotInventoryFamilyInput {
  const inventoryKeys = Object.freeze(
    incumbents.map((incumbent) => incumbent.inventoryKey).sort(),
  );
  return Object.freeze({
    familyId: owner,
    inventoryKeys,
    inventoryCount: inventoryKeys.length,
    inventoryHash: adapterFamilySnapshotInventoryHash({
      familyId: owner,
      source: canonical,
      incumbents,
    }),
    incumbents: Object.freeze([...incumbents]),
  });
}

function enumerationFamily(
  canonical: CanonicalSource,
  incumbents: readonly AdapterFamilySnapshotInventoryEnumerationIncumbentInput[],
  owner: FamilyId = WSTETH_FAMILY_ID,
): AdapterFamilySnapshotInventoryEnumerationFamilyInput {
  const inventoryKeys = Object.freeze(
    incumbents.map((incumbent) => incumbent.inventoryKey).sort(),
  );
  return Object.freeze({
    familyId: owner,
    inventoryKeys,
    inventoryCount: inventoryKeys.length,
    inventoryHash: adapterFamilySnapshotInventoryHash({
      familyId: owner,
      source: canonical,
      incumbents,
    }),
    incumbents: Object.freeze([...incumbents]),
  });
}

function candidateInput(
  canonical: CanonicalSource,
  admittedKeys?: readonly string[],
): AdapterFamilySnapshotInventoryClosureCandidateInput {
  return Object.freeze({
    source: canonical,
    families: Object.freeze([
      candidateFamily(canonical, [candidateIncumbent(canonical, admittedKeys)]),
    ]),
  });
}

function enumerationInput(
  canonical: CanonicalSource,
): AdapterFamilySnapshotInventoryEnumerationInput {
  return Object.freeze({
    source: canonical,
    families: Object.freeze([
      enumerationFamily(canonical, [enumerationIncumbent(canonical)]),
    ]),
  });
}

function factoryLogSurface(
  canonical: CanonicalSource,
): Extract<UnifiedObservation, { readonly kind: "factory-log" }> {
  const pool = UNIV2_FIXTURE_POOL.toLowerCase();
  const log = UNIV2_FACTORY_INTERFACE.encodeEventLog("PairCreated", [
    UNIV2_FIXTURE_TOKEN0,
    UNIV2_FIXTURE_TOKEN1,
    pool,
    0n,
  ]);
  return Object.freeze({
    kind: "factory-log" as const,
    source: canonical,
    factory: UNIV2_FIXTURE_FACTORY.toLowerCase(),
    poolKeyProjection: pool,
    lastFactoryLogBlock: canonical.number,
    topic: UNIV2_PAIR_CREATED_TOPIC,
    topics: Object.freeze(log.topics),
    data: log.data,
  });
}

function univ2CandidateInput(
  canonical: CanonicalSource,
  admittedKeys: readonly string[],
): AdapterFamilySnapshotInventoryClosureCandidateInput {
  const incumbent = Object.freeze({
    inventoryKey: UNIV2_CANDIDATE_KEY,
    address: UNIV2_FIXTURE_POOL,
    currentSurface: factoryLogSurface(canonical),
    terminalCandidates: Object.freeze([Object.freeze({
      candidateKey: UNIV2_CANDIDATE_KEY,
      status: "terminal" as const,
      outcomeFingerprint: "5".repeat(64),
      evidenceRefs: Object.freeze(["fixture:univ2:terminal-evidence"]),
      admittedInstancePublicationKeys: Object.freeze([...admittedKeys]),
      publicationFingerprints: Object.freeze(["6".repeat(64)]),
    })]),
  }) as AdapterFamilySnapshotInventoryIncumbentInput;
  return Object.freeze({
    source: canonical,
    families: Object.freeze([
      candidateFamily(canonical, [incumbent], UNIV2_FAMILY_ID),
    ]),
  });
}

function univ2EnumerationInput(
  canonical: CanonicalSource,
): AdapterFamilySnapshotInventoryEnumerationInput {
  const incumbent = Object.freeze({
    inventoryKey: UNIV2_CANDIDATE_KEY,
    address: UNIV2_FIXTURE_POOL,
    currentSurface: factoryLogSurface(canonical),
  }) as AdapterFamilySnapshotInventoryEnumerationFamilyInput["incumbents"][number];
  return Object.freeze({
    source: canonical,
    families: Object.freeze([
      enumerationFamily(canonical, [incumbent], UNIV2_FAMILY_ID),
    ]),
  });
}

function completeSnapshotAnchors(
  catalog: FamilyCapabilityCatalog,
  canonical: CanonicalSource,
): readonly CatalogDiscoverySourceAnchor[] {
  return Object.freeze(catalog.listAll().flatMap((family) => {
    const familyId = family.plugin.manifest.familyId;
    const sourceIds = "discovery" in family.plugin
      ? family.plugin.discovery.sources
      : [];
    return sourceIds.map((sourceId) => Object.freeze({
      familyId,
      sourceId,
      sourceFingerprint: catalogDiscoverySourceFingerprint({
        familyId,
        sourceId,
        source: canonical,
      }),
      authority: "complete-snapshot" as const,
      status: "complete" as const,
      completeThroughBlock: canonical.number,
      completeThroughHash: canonical.hash,
    }));
  }));
}

function wstethCheckpointInventory(
  canonical: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[] {
  return Object.freeze([Object.freeze({
    familyId: WSTETH_FAMILY_ID,
    incumbents: Object.freeze([Object.freeze({
      inventoryKey: "legacy:wsteth",
      address: WSTETH,
      currentSurface: surface(canonical),
    })]),
  })]);
}

function univ2CheckpointInventory(
  canonical: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[] {
  return Object.freeze([Object.freeze({
    familyId: UNIV2_FAMILY_ID,
    incumbents: Object.freeze([Object.freeze({
      inventoryKey: UNIV2_CANDIDATE_KEY,
      address: UNIV2_FIXTURE_POOL,
      currentSurface: factoryLogSurface(canonical),
    })]),
  })]);
}

async function factoryLogCompleteSnapshotPositivePath(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "adapter-family-univ2-composition-"),
  );
  const path = join(directory, "checkpoint.json");
  const catalog = univ2Catalog();
  let univ2Enumerator: DiscoveryInventoryEnumerator | null = null;
  const composition = createDurableDiscoveryContinuityComposition({
    catalog,
    chainId: CHAIN_ID,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
    checkpointPath: path,
    enumerateSnapshotInventory: async (canonical) => {
      if (univ2Enumerator === null) {
        throw new Error("univ2 checkpoint enumerator is not wired");
      }
      return await univ2Enumerator.enumerate(canonical);
    },
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  });
  univ2Enumerator = new CheckpointDiscoveryInventoryEnumerator({
    checkpointStore: composition.store,
  });
  const empty = await composition.loadForRestart();
  assert.equal(empty.status, "empty");
  const checkpointStaged = composition.checkpointIssuer.prepare({
    source: SOURCE,
    watermarks: checkpointWatermarks(catalog, SOURCE),
    inventoryFamilies: univ2CheckpointInventory(SOURCE),
  });
  assert.equal(await composition.store.compareAndCommit({
    expected: null,
    staged: checkpointStaged,
  }), true);
  const checkpointReceipt = composition.store.capture()!;
  assert(checkpointReceipt);

  const publication = await runUniv2Lifecycle(SOURCE, {
    pool: UNIV2_FIXTURE_POOL,
    factory: UNIV2_FIXTURE_FACTORY,
    token0: UNIV2_FIXTURE_TOKEN0,
    token1: UNIV2_FIXTURE_TOKEN1,
  }, catalog);
  const admittedKey = catalogInstancePublicationKey({
    familyId: publication.instances[0]!.familyId,
    lineageId: publication.instances[0]!.lineageId,
    instanceKey: publication.instances[0]!.instanceKey,
  });
  const closureCandidate = composition.closureIssuer.prepare(
    univ2CandidateInput(SOURCE, [admittedKey]),
  );
  const closureReceipt = await composition.closureVerifier.verifyAndIssue({
    candidate: closureCandidate,
    checkpointReceipt,
  });
  const completeStage = composition.catalogRoot.stageRouteFamily({
    publication,
    inventoryMode: "complete-snapshot",
    snapshotInventoryClosureReceipt: closureReceipt,
  });
  const prepared = composition.catalogRoot.prepare({
    source: SOURCE,
    previous: null,
    stages: Object.freeze([completeStage]),
    sourceAnchors: completeSnapshotAnchors(catalog, SOURCE),
  });
  assert(prepared !== null);
  const published = await composition.catalogRoot.compareAndPublish({
    expected: null,
    staged: prepared,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  });
  assert.equal(published, true);
  const committed = composition.catalogRoot.capture()!;
  assert(committed.envelope.privateState.instances.has(admittedKey));
  assert(committed.envelope.snapshot.delta.added.includes(admittedKey));
  for (const sourceId of ["factory-log", "landed-log", "observed-call"]) {
    const anchor = committed.envelope.snapshot.sourceAnchors.get(
      catalogFamilySourceAnchorKey(UNIV2_FAMILY_ID, sourceId),
    );
    assert(anchor);
    assert.equal(anchor.authority, "complete-snapshot");
    assert.equal(anchor.status, "complete");
    assert.equal(anchor.completeThroughBlock, SOURCE.number);
    assert.equal(anchor.completeThroughHash, SOURCE.hash);
  }

  // Staged-set coupling fails closed at the strict catalog boundary on a
  // fresh root (closure admits zero keys while the stage still carries the
  // publication instances).
  const freshDirectory = await mkdtemp(
    join(tmpdir(), "adapter-family-univ2-fresh-composition-"),
  );
  let freshUniv2Enumerator: DiscoveryInventoryEnumerator | null = null;
  const fresh = createDurableDiscoveryContinuityComposition({
    catalog,
    chainId: CHAIN_ID,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
    checkpointPath: join(freshDirectory, "checkpoint.json"),
    enumerateSnapshotInventory: async (canonical) => {
      if (freshUniv2Enumerator === null) {
        throw new Error("fresh univ2 checkpoint enumerator is not wired");
      }
      return await freshUniv2Enumerator.enumerate(canonical);
    },
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  });
  freshUniv2Enumerator = new CheckpointDiscoveryInventoryEnumerator({
    checkpointStore: fresh.store,
  });
  const freshEmpty = await fresh.loadForRestart();
  assert.equal(freshEmpty.status, "empty");
  const freshCheckpointStaged = fresh.checkpointIssuer.prepare({
    source: SOURCE,
    watermarks: checkpointWatermarks(catalog, SOURCE),
    inventoryFamilies: univ2CheckpointInventory(SOURCE),
  });
  assert.equal(await fresh.store.compareAndCommit({
    expected: null,
    staged: freshCheckpointStaged,
  }), true);
  const freshCheckpointReceipt = fresh.store.capture()!;
  const emptyClosure = await fresh.closureVerifier.verifyAndIssue({
    candidate: fresh.closureIssuer.prepare(
      univ2CandidateInput(SOURCE, []),
    ),
    checkpointReceipt: freshCheckpointReceipt,
  });
  const emptyStage = fresh.catalogRoot.stageRouteFamily({
    publication,
    inventoryMode: "complete-snapshot",
    snapshotInventoryClosureReceipt: emptyClosure,
  });
  assert.throws(() => fresh.catalogRoot.prepare({
    source: SOURCE,
    previous: null,
    stages: Object.freeze([emptyStage]),
    sourceAnchors: completeSnapshotAnchors(catalog, SOURCE),
  }), /staged set mismatch|exact-set/);
}

async function mixedModeCompleteSnapshotPositivePath(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "adapter-family-mixed-composition-"),
  );
  const path = join(directory, "checkpoint.json");
  const catalog = mixedCatalog();
  let enumerator: DiscoveryInventoryEnumerator | null = null;
  const composition = createDurableDiscoveryContinuityComposition({
    catalog,
    chainId: CHAIN_ID,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
    checkpointPath: path,
    enumerateSnapshotInventory: async (canonical) => {
      if (enumerator === null) {
        throw new Error("mixed checkpoint enumerator is not wired");
      }
      return await enumerator.enumerate(canonical);
    },
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  });
  enumerator = new CheckpointDiscoveryInventoryEnumerator({
    checkpointStore: composition.store,
  });
  const empty = await composition.loadForRestart();
  assert.equal(empty.status, "empty");
  const checkpointStaged = composition.checkpointIssuer.prepare({
    source: SOURCE,
    watermarks: checkpointWatermarks(catalog, SOURCE),
    inventoryFamilies: Object.freeze([
      ...wstethCheckpointInventory(SOURCE),
      Object.freeze({
        familyId: ASTRA_MULTITOKEN_FAMILY_ID,
        incumbents: Object.freeze([]),
      }),
    ]),
  });
  assert.equal(await composition.store.compareAndCommit({
    expected: null,
    staged: checkpointStaged,
  }), true);
  const checkpointReceipt = composition.store.capture()!;
  assert(checkpointReceipt);

  const wstethPublication = await runWstethLifecycle(SOURCE, catalog);
  const admittedKey = catalogInstancePublicationKey({
    familyId: wstethPublication.instances[0]!.familyId,
    lineageId: wstethPublication.instances[0]!.lineageId,
    instanceKey: wstethPublication.instances[0]!.instanceKey,
  });
  const closureCandidate = composition.closureIssuer.prepare(
    candidateInput(SOURCE, [admittedKey]),
  );
  const closureReceipt = await composition.closureVerifier.verifyAndIssue({
    candidate: closureCandidate,
    checkpointReceipt,
  });
  const wstethStage = composition.catalogRoot.stageRouteFamily({
    publication: wstethPublication,
    inventoryMode: "complete-snapshot",
    snapshotInventoryClosureReceipt: closureReceipt,
  });
  const astraStage = Object.freeze({
    familyId: ASTRA_MULTITOKEN_FAMILY_ID,
    domain: "protocol",
    source: SOURCE,
    status: "resolved",
    inventoryMode: "append-only-delta",
    instances: Object.freeze([]),
    terminalRemovals: Object.freeze([]),
    outcomeRefs: Object.freeze([]),
  }) as StrictShadowCatalogFamilyStage;
  const anchors = Object.freeze([
    ...completeSnapshotAnchors(catalog, SOURCE).filter(
      (anchor) => anchor.familyId === WSTETH_FAMILY_ID,
    ),
    ...completeSnapshotAnchors(catalog, SOURCE).filter(
      (anchor) => anchor.familyId === ASTRA_MULTITOKEN_FAMILY_ID,
    ).map((anchor) => Object.freeze({
      ...anchor,
      authority: "append-only-nomination",
    }) as CatalogDiscoverySourceAnchor),
  ]);
  const prepared = composition.catalogRoot.prepare({
    source: SOURCE,
    previous: null,
    stages: Object.freeze([wstethStage, astraStage]),
    sourceAnchors: anchors,
  });
  assert(prepared !== null);
  const published = await composition.catalogRoot.compareAndPublish({
    expected: null,
    staged: prepared,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  });
  assert.equal(published, true);
  const committed = composition.catalogRoot.capture()!;
  assert(committed.envelope.privateState.instances.has(admittedKey));
  assert.equal(
    committed.envelope.snapshot.familyStatuses.get(WSTETH_FAMILY_ID)
      ?.inventoryMode,
    "complete-snapshot",
  );
  assert.equal(
    committed.envelope.snapshot.familyStatuses.get(ASTRA_MULTITOKEN_FAMILY_ID)
      ?.inventoryMode,
    "append-only-delta",
  );
  assert.equal(
    committed.envelope.snapshot.status,
    "shadow-partial",
    "append-only Families keep the publication partial until their own " +
      "bootstrap semantics exist",
  );
}

function checkpointWatermarks(
  catalog: FamilyCapabilityCatalog,
  canonical: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointCandidateWatermark[] {
  return Object.freeze(catalog.listAll().flatMap((family) => {
    if (!("discovery" in family.plugin)) return [];
    return family.plugin.discovery.sources.map((sourceId) => {
      const contiguous = EVENT_SOURCES.has(sourceId);
      return Object.freeze({
        familyId: family.plugin.manifest.familyId,
        sourceId,
        coverageAuthority: contiguous
          ? "contiguous-history" as const
          : "append-only" as const,
        completeThroughBlock: contiguous ? canonical.number : -1,
        completeThroughHash: contiguous ? canonical.hash : null,
      });
    });
  }));
}

async function main(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "adapter-family-continuity-composition-"),
  );
  const path = join(directory, "checkpoint.json");
  const catalog = syntheticCatalog();
  let wstethEnumerator: DiscoveryInventoryEnumerator | null = null;
  const composition = createDurableDiscoveryContinuityComposition({
    catalog,
    chainId: CHAIN_ID,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
    checkpointPath: path,
    enumerateSnapshotInventory: async (canonical) => {
      if (wstethEnumerator === null) {
        throw new Error("wsteth checkpoint enumerator is not wired");
      }
      return await wstethEnumerator.enumerate(canonical);
    },
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  });
  wstethEnumerator = new CheckpointDiscoveryInventoryEnumerator({
    checkpointStore: composition.store,
  });
  assert.deepEqual(composition.store.binding(), {
    chainId: CHAIN_ID,
    catalogHash: catalog.catalogHash,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
  });
  assert(Object.isFrozen(composition.store.binding()));

  const empty = await composition.loadForRestart();
  assert.equal(empty.status, "empty");
  const checkpointStaged = composition.checkpointIssuer.prepare({
    source: SOURCE,
    watermarks: checkpointWatermarks(catalog, SOURCE),
    inventoryFamilies: wstethCheckpointInventory(SOURCE),
  });
  assert.equal(await composition.store.compareAndCommit({
    expected: null,
    staged: checkpointStaged,
  }), true);
  const checkpointReceipt = composition.store.capture()!;
  assert(checkpointReceipt);

  const closureCandidate = composition.closureIssuer.prepare(
    candidateInput(SOURCE),
  );
  const closureReceipt = await composition.closureVerifier.verifyAndIssue({
    candidate: closureCandidate,
    checkpointReceipt,
  });
  const resolved = composition.consumeClosureForCatalog({
    receipt: closureReceipt,
    source: SOURCE,
    stagedByFamily: new Map([
      [WSTETH_FAMILY_ID, ["protocol:wsteth:fixture-instance"]],
    ]),
  });
  assert.equal(resolved.families[0]!.familyId, WSTETH_FAMILY_ID);
  assert.deepEqual(
    resolved.families[0]!.admittedInstancePublicationKeys,
    ["protocol:wsteth:fixture-instance"],
  );

  assert.throws(() => composition.consumeClosureForCatalog({
    receipt: closureReceipt,
    source: SOURCE,
    stagedByFamily: new Map([
      [WSTETH_FAMILY_ID, ["protocol:wsteth:fixture-instance"]],
    ]),
  }), /forged or foreign/);

  const secondCandidate = composition.closureIssuer.prepare(
    candidateInput(SOURCE),
  );
  const secondReceipt = await composition.closureVerifier.verifyAndIssue({
    candidate: secondCandidate,
    checkpointReceipt,
  });
  assert.throws(() => composition.consumeClosureForCatalog({
    receipt: secondReceipt,
    source: SOURCE,
    stagedByFamily: new Map([
      [WSTETH_FAMILY_ID, ["protocol:wsteth:other-instance"]],
    ]),
  }), /exact-set mismatch/);

  const forgedClosureReceipt = Object.freeze({}) as
    AdapterFamilySnapshotInventoryClosureReceipt;
  const forgedSnapshotStage = Object.freeze({
    familyId: WSTETH_FAMILY_ID,
    domain: "protocol",
    source: SOURCE,
    status: "resolved",
    inventoryMode: "complete-snapshot",
    instances: Object.freeze([]),
    terminalRemovals: Object.freeze([]),
    outcomeRefs: Object.freeze([]),
    snapshotInventoryClosureReceipt: forgedClosureReceipt,
  }) as StrictShadowCatalogFamilyStage;
  assert.throws(() => composition.catalogRoot.prepare({
    source: SOURCE,
    previous: null,
    stages: Object.freeze([forgedSnapshotStage]),
    sourceAnchors: Object.freeze([]),
  }), /forged or foreign/);

  const thirdCandidate = composition.closureIssuer.prepare(
    candidateInput(SOURCE),
  );
  const thirdReceipt = await composition.closureVerifier.verifyAndIssue({
    candidate: thirdCandidate,
    checkpointReceipt,
  });
  const mismatchSnapshotStage = Object.freeze({
    ...forgedSnapshotStage,
    snapshotInventoryClosureReceipt: thirdReceipt,
  }) as StrictShadowCatalogFamilyStage;
  assert.throws(() => composition.catalogRoot.prepare({
    source: SOURCE,
    previous: null,
    stages: Object.freeze([mismatchSnapshotStage]),
    sourceAnchors: Object.freeze([]),
  }), /staged set mismatch|exact-set/);

  const wstethPublication = await runWstethLifecycle(SOURCE, catalog);
  const admittedKey = catalogInstancePublicationKey({
    familyId: wstethPublication.instances[0]!.familyId,
    lineageId: wstethPublication.instances[0]!.lineageId,
    instanceKey: wstethPublication.instances[0]!.instanceKey,
  });
  const lifecycleClosureCandidate = composition.closureIssuer.prepare(
    candidateInput(SOURCE, [admittedKey]),
  );
  const lifecycleClosureReceipt = await composition.closureVerifier.verifyAndIssue({
    candidate: lifecycleClosureCandidate,
    checkpointReceipt,
  });
  const completeStage = composition.catalogRoot.stageRouteFamily({
    publication: wstethPublication,
    inventoryMode: "complete-snapshot",
    snapshotInventoryClosureReceipt: lifecycleClosureReceipt,
  });
  const snapshotAnchors = completeSnapshotAnchors(catalog, SOURCE);
  const prepared = composition.catalogRoot.prepare({
    source: SOURCE,
    previous: null,
    stages: Object.freeze([completeStage]),
    sourceAnchors: snapshotAnchors,
  });
  assert(prepared !== null);
  assert.equal(composition.catalogRoot.capture(), null);
  const published = await composition.catalogRoot.compareAndPublish({
    expected: null,
    staged: prepared,
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  });
  assert.equal(published, true);
  const committed = composition.catalogRoot.capture()!;
  assert(committed.envelope.privateState.instances.has(admittedKey));
  assert(committed.envelope.snapshot.delta.added.includes(admittedKey));
  for (const sourceId of ["observed-call", "address-surface"]) {
    const anchor = committed.envelope.snapshot.sourceAnchors.get(
      catalogFamilySourceAnchorKey(WSTETH_FAMILY_ID, sourceId),
    );
    assert(anchor);
    assert.equal(anchor.authority, "complete-snapshot");
    assert.equal(anchor.status, "complete");
    assert.equal(anchor.completeThroughBlock, SOURCE.number);
    assert.equal(anchor.completeThroughHash, SOURCE.hash);
  }

  await factoryLogCompleteSnapshotPositivePath();
  await mixedModeCompleteSnapshotPositivePath();

  const restarted = createDurableDiscoveryContinuityComposition({
    catalog,
    chainId: CHAIN_ID,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
    checkpointPath: path,
    enumerateSnapshotInventory: (canonical) => enumerationInput(canonical),
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
  });
  const reloaded = await restarted.loadForRestart();
  assert.equal(reloaded.status, "trusted");
  assert.equal(reloaded.receipt, restarted.store.capture());
  console.log("adapter-family discovery continuity composition PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
