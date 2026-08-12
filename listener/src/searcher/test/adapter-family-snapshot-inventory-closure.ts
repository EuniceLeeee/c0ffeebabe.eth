import assert from "node:assert/strict";
import {
  AdapterFamilyDiscoveryCheckpointStore,
  emptyCheckpointInventoryFamilies,
  type AdapterFamilyDiscoveryCheckpointCandidateWatermark,
  type AdapterFamilyDiscoveryCheckpointDurableBackend,
  type AdapterFamilyDiscoveryCheckpointReceipt,
} from "../adapter-family-discovery-checkpoint.js";
import {
  AdapterFamilySnapshotInventoryClosureVerifier,
  adapterFamilySnapshotInventoryHash,
  enumeratePointInTimeInventory,
  type AdapterFamilySnapshotCatalogPublicationPointer,
  type AdapterFamilySnapshotInventoryClosureCandidateInput,
  type AdapterFamilySnapshotInventoryClosureCandidateIssuer,
  type AdapterFamilySnapshotInventoryEnumerationFamilyInput,
  type AdapterFamilySnapshotInventoryEnumerationInput,
  type AdapterFamilySnapshotInventoryFamilyInput,
  type AdapterFamilySnapshotInventoryIncumbentInput,
  type AdapterFamilySnapshotInventoryObservation,
  type AdapterFamilySnapshotTerminalCandidateInput,
} from "../adapter-family-snapshot-inventory-closure.js";
import {
  definedFamilyPluginContractSummary,
  type DiscoverySourceKind,
  type UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
import {
  familyId,
  type FamilyId,
} from "../venues/adapter-family-identifiers.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
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
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_TOPIC,
} from "../venues/swaps/univ2-family/codec.js";

type AddressSurfaceObservation = Extract<
  UnifiedObservation,
  { readonly kind: "address-surface" }
>;

const CHAIN_ID = "1";
const SOURCE_REGISTRY_FINGERPRINT = "strict-source-registry-v1";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const OTHER_ADDRESS = `0x${"22".repeat(20)}`;
const WSTETH_CANDIDATE_KEY = WSTETH.toLowerCase();
const UNIV2_FIXTURE_POOL = `0x${"41".repeat(20)}`;
const UNIV2_FIXTURE_FACTORY = `0x${"42".repeat(20)}`;
const UNIV2_FIXTURE_TOKEN0 = `0x${"43".repeat(20)}`;
const UNIV2_FIXTURE_TOKEN1 = `0x${"44".repeat(20)}`;
const UNIV2_CANDIDATE_KEY = UNIV2_FIXTURE_POOL.toLowerCase();
const UNIV2_STRICT_FAMILY_PLUGIN =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forStrictFamily(
    UNIV2_FAMILY_ID,
  ).plugin;
const SOURCE = source(10, "a", 4);
const SOURCE_NEXT = source(11, "b", 5);
const EVENT_SOURCES: ReadonlySet<DiscoverySourceKind> = new Set([
  "factory-log",
  "landed-log",
  "observed-call",
]);
const WSTETH_STRICT_FAMILY_PLUGIN =
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forStrictFamily(
    WSTETH_FAMILY_ID,
  ).plugin;
const SYNTHETIC_CATALOG = syntheticCatalog();

class MemoryCheckpointBackend
  implements AdapterFamilyDiscoveryCheckpointDurableBackend {
  #raw: string | null = null;

  async read(): Promise<string | null> {
    return this.#raw;
  }

  async compareAndSwap(input: {
    readonly expectedSerialized: string | null;
    readonly nextSerialized: string;
    readonly beforeCommit: () => boolean;
  }): Promise<boolean> {
    if (this.#raw !== input.expectedSerialized || !input.beforeCommit()) {
      return false;
    }
    this.#raw = input.nextSerialized;
    return true;
  }
}

interface HarnessControls {
  currentGeneration: number;
  publication: AdapterFamilySnapshotCatalogPublicationPointer;
  enumerate: (
    source: CanonicalSource,
  ) => AdapterFamilySnapshotInventoryEnumerationInput |
    Promise<AdapterFamilySnapshotInventoryEnumerationInput>;
  verifyCanonical: (source: CanonicalSource) => void | Promise<void>;
  readonly calls: string[];
}

interface Harness {
  readonly checkpointStore: AdapterFamilyDiscoveryCheckpointStore;
  readonly checkpointReceipt: AdapterFamilyDiscoveryCheckpointReceipt;
  readonly verifier: AdapterFamilySnapshotInventoryClosureVerifier;
  readonly issuer: AdapterFamilySnapshotInventoryClosureCandidateIssuer;
  readonly controls: HarnessControls;
}

function source(
  number: number,
  hashDigit: string,
  generation: number,
): CanonicalSource {
  return Object.freeze({
    number,
    hash: `0x${hashDigit.repeat(64)}`,
    generation,
  });
}

function singleFamilyCatalog(input: {
  readonly plugin: typeof WSTETH_STRICT_FAMILY_PLUGIN;
  readonly sourceFile: string;
}): FamilyCapabilityCatalog {
  const summary = definedFamilyPluginContractSummary(input.plugin);
  const entries = FAMILY_CAPABILITY_NAMES.map((capability, index) =>
    Object.freeze({
      familyId: summary.familyId,
      capability,
      contractVersion: "adapter-family-contract-v1",
      contentHash: index.toString(16).padStart(64, "0"),
      semanticDependencies: Object.freeze([]),
      provenanceCommit: null,
    }) satisfies GeneratedCapabilityIdentity
  );
  return new FamilyCapabilityCatalog({
    modules: [Object.freeze({
      sourceFile: input.sourceFile,
      definitionBoundaryHash: summary.definitionBoundaryHash,
      plugin: input.plugin,
    })],
    generatedManifest: Object.freeze({
      format: "adapter-family-capabilities-v1",
      entries: Object.freeze(entries),
      manifestHash: capabilityManifestHash(entries),
    }),
  });
}

function syntheticCatalog(): FamilyCapabilityCatalog {
  return singleFamilyCatalog({
    plugin: WSTETH_STRICT_FAMILY_PLUGIN,
    sourceFile: "wsteth-family-plugin.ts",
  });
}

function univ2Catalog(): FamilyCapabilityCatalog {
  return singleFamilyCatalog({
    plugin: UNIV2_STRICT_FAMILY_PLUGIN,
    sourceFile: "univ2-family-plugin.ts",
  });
}

function surface(
  canonical: CanonicalSource = SOURCE,
  input: {
    readonly address?: string;
    readonly codeHashDigit?: string;
    readonly interfaceFingerprints?: readonly string[];
  } = {},
): AddressSurfaceObservation {
  return Object.freeze({
    kind: "address-surface" as const,
    source: canonical,
    address: input.address ?? WSTETH,
    codeHash: `0x${(input.codeHashDigit ?? "1").repeat(64)}`,
    implementationWord: `0x${"0".repeat(64)}`,
    interfaceFingerprints: Object.freeze([
      ...(input.interfaceFingerprints ?? ["wsteth-conversion-surface-v1"]),
    ]),
  });
}

function terminalCandidate(
  input: {
    readonly candidateKey?: string;
    readonly status?: "terminal" | "partial";
    readonly admittedInstancePublicationKeys?: readonly string[];
  } = {},
): AdapterFamilySnapshotTerminalCandidateInput {
  return Object.freeze({
    candidateKey: input.candidateKey ?? WSTETH_CANDIDATE_KEY,
    status: input.status ?? "terminal",
    outcomeFingerprint: "3".repeat(64),
    evidenceRefs: Object.freeze(["fixture:terminal-evidence"]),
    admittedInstancePublicationKeys: Object.freeze([
      ...(input.admittedInstancePublicationKeys ??
        ["protocol:wsteth:fixture-instance"]),
    ]),
    publicationFingerprints: Object.freeze(["4".repeat(64)]),
  });
}

function candidateIncumbent(
  canonical: CanonicalSource = SOURCE,
  input: {
    readonly inventoryKey?: string;
    readonly address?: string;
    readonly currentSurface?: AdapterFamilySnapshotInventoryObservation;
    readonly terminalCandidates?:
      readonly AdapterFamilySnapshotTerminalCandidateInput[];
  } = {},
): AdapterFamilySnapshotInventoryIncumbentInput {
  return Object.freeze({
    inventoryKey: input.inventoryKey ?? "legacy:wsteth",
    address: input.address ?? WSTETH,
    currentSurface: input.currentSurface ?? surface(canonical),
    terminalCandidates: Object.freeze([
      ...(input.terminalCandidates ?? [terminalCandidate()]),
    ]),
  });
}

function enumerationIncumbent(
  canonical: CanonicalSource = SOURCE,
  input: {
    readonly inventoryKey?: string;
    readonly address?: string;
    readonly currentSurface?: AdapterFamilySnapshotInventoryObservation;
  } = {},
) {
  return Object.freeze({
    inventoryKey: input.inventoryKey ?? "legacy:wsteth",
    address: input.address ?? WSTETH,
    currentSurface: input.currentSurface ?? surface(canonical),
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
  incumbents: readonly ReturnType<typeof enumerationIncumbent>[],
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
  canonical: CanonicalSource = SOURCE,
  incumbents: readonly AdapterFamilySnapshotInventoryIncumbentInput[] = [
    candidateIncumbent(canonical),
  ],
): AdapterFamilySnapshotInventoryClosureCandidateInput {
  return Object.freeze({
    source: canonical,
    families: Object.freeze([candidateFamily(canonical, incumbents)]),
  });
}

function enumerationInput(
  canonical: CanonicalSource = SOURCE,
  incumbents: readonly ReturnType<typeof enumerationIncumbent>[] = [
    enumerationIncumbent(canonical),
  ],
): AdapterFamilySnapshotInventoryEnumerationInput {
  return Object.freeze({
    source: canonical,
    families: Object.freeze([enumerationFamily(canonical, incumbents)]),
  });
}

function factoryLogSurface(
  canonical: CanonicalSource = SOURCE,
  input: {
    readonly pool?: string;
    readonly factory?: string;
    readonly lastFactoryLogBlock?: number;
    readonly poolKeyProjection?: string;
  } = {},
): Extract<UnifiedObservation, { readonly kind: "factory-log" }> {
  const pool = (input.pool ?? UNIV2_FIXTURE_POOL).toLowerCase();
  const factory = (input.factory ?? UNIV2_FIXTURE_FACTORY).toLowerCase();
  const log = UNIV2_FACTORY_INTERFACE.encodeEventLog("PairCreated", [
    UNIV2_FIXTURE_TOKEN0,
    UNIV2_FIXTURE_TOKEN1,
    pool,
    0n,
  ]);
  return Object.freeze({
    kind: "factory-log" as const,
    source: canonical,
    factory,
    poolKeyProjection: input.poolKeyProjection ?? pool,
    lastFactoryLogBlock: input.lastFactoryLogBlock ?? canonical.number,
    topic: UNIV2_PAIR_CREATED_TOPIC,
    topics: Object.freeze(log.topics),
    data: log.data,
  });
}

function univ2CandidateInput(
  canonical: CanonicalSource = SOURCE,
  admittedKeys: readonly string[] = ["swap:univ2:fixture-pool"],
): AdapterFamilySnapshotInventoryClosureCandidateInput {
  const incumbent = candidateIncumbent(canonical, {
    inventoryKey: UNIV2_CANDIDATE_KEY,
    address: UNIV2_FIXTURE_POOL,
    currentSurface: factoryLogSurface(canonical),
    terminalCandidates: Object.freeze([
      terminalCandidate({
        candidateKey: UNIV2_CANDIDATE_KEY,
        admittedInstancePublicationKeys: admittedKeys,
      }),
    ]),
  });
  return Object.freeze({
    source: canonical,
    families: Object.freeze([
      candidateFamily(canonical, [incumbent], UNIV2_FAMILY_ID),
    ]),
  });
}

function univ2EnumerationInput(
  canonical: CanonicalSource = SOURCE,
): AdapterFamilySnapshotInventoryEnumerationInput {
  const incumbent = enumerationIncumbent(canonical, {
    inventoryKey: UNIV2_CANDIDATE_KEY,
    address: UNIV2_FIXTURE_POOL,
    currentSurface: factoryLogSurface(canonical),
  });
  return Object.freeze({
    source: canonical,
    families: Object.freeze([
      enumerationFamily(canonical, [incumbent], UNIV2_FAMILY_ID),
    ]),
  });
}

function checkpointStore(
  catalog: FamilyCapabilityCatalog,
): AdapterFamilyDiscoveryCheckpointStore {
  return new AdapterFamilyDiscoveryCheckpointStore({
    catalog,
    chainId: CHAIN_ID,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
    backend: new MemoryCheckpointBackend(),
    verifyCanonicalCheckpoint() {},
    assertGenerationCurrent() {},
  });
}

function checkpointWatermarks(
  catalog: FamilyCapabilityCatalog,
  canonical: CanonicalSource,
  eventContinuity: boolean,
): readonly AdapterFamilyDiscoveryCheckpointCandidateWatermark[] {
  return Object.freeze(catalog.listAll().flatMap((family) => {
    if (!("discovery" in family.plugin)) return [];
    return family.plugin.discovery.sources.map((sourceId) => {
      const contiguous = eventContinuity && EVENT_SOURCES.has(sourceId);
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

async function trustedCheckpoint(input: {
  readonly catalog?: FamilyCapabilityCatalog;
  readonly source?: CanonicalSource;
  readonly eventContinuity?: boolean;
} = {}): Promise<{
  readonly store: AdapterFamilyDiscoveryCheckpointStore;
  readonly receipt: AdapterFamilyDiscoveryCheckpointReceipt;
}> {
  const catalog = input.catalog ?? SYNTHETIC_CATALOG;
  const canonical = input.source ?? SOURCE;
  const store = checkpointStore(catalog);
  const issuer = store.takeCandidateIssuer();
  const empty = await store.loadForRestart();
  assert.equal(empty.status, "empty");
  const staged = issuer.prepare({
    source: canonical,
    watermarks: checkpointWatermarks(
      catalog,
      canonical,
      input.eventContinuity ?? true,
    ),
    inventoryFamilies: emptyCheckpointInventoryFamilies(
      catalog.listAll().map((family) => family.plugin.manifest.familyId),
    ),
  });
  assert.equal(await store.compareAndCommit({ expected: null, staged }), true);
  const receipt = store.capture();
  assert(receipt);
  return { store, receipt };
}

async function harness(input: {
  readonly catalog?: FamilyCapabilityCatalog;
  readonly source?: CanonicalSource;
  readonly eventContinuity?: boolean;
  readonly enumeration?: AdapterFamilySnapshotInventoryEnumerationInput;
  readonly publication?: AdapterFamilySnapshotCatalogPublicationPointer;
} = {}): Promise<Harness> {
  const catalog = input.catalog ?? SYNTHETIC_CATALOG;
  const canonical = input.source ?? SOURCE;
  const checkpoint = await trustedCheckpoint({
    catalog,
    source: canonical,
    eventContinuity: input.eventContinuity,
  });
  const controls: HarnessControls = {
    currentGeneration: canonical.generation,
    publication: input.publication ?? Object.freeze({
      revision: 7,
      publicationFingerprint: "7".repeat(64),
    }),
    enumerate: () => input.enumeration ?? enumerationInput(canonical),
    verifyCanonical: () => {},
    calls: [],
  };
  const verifier = new AdapterFamilySnapshotInventoryClosureVerifier({
    catalog,
    chainId: CHAIN_ID,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
    checkpointStore: checkpoint.store,
    captureCatalogPublication: () => {
      controls.calls.push("publication");
      return controls.publication;
    },
    verifyCanonicalSource: async (actual) => {
      controls.calls.push("canonical");
      await controls.verifyCanonical(actual);
    },
    enumerateSnapshotInventory: async (actual) => {
      controls.calls.push("enumerate");
      return await controls.enumerate(actual);
    },
    assertGenerationCurrent: (actual) => {
      controls.calls.push("fence");
      if (actual.generation !== controls.currentGeneration) {
        throw new Error("fixture generation superseded");
      }
    },
  });
  return Object.freeze({
    checkpointStore: checkpoint.store,
    checkpointReceipt: checkpoint.receipt,
    verifier,
    issuer: verifier.takeCandidateIssuer(),
    controls,
  });
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return Object.freeze({ promise, resolve });
}

async function positiveAndZeroInventory(): Promise<void> {
  const positive = await harness();
  assert(Object.isFrozen(positive.issuer));
  assert(Object.isFrozen(positive.issuer.binding));
  assert.throws(
    () => positive.verifier.takeCandidateIssuer(),
    /already taken/,
  );
  const candidate = positive.issuer.prepare(candidateInput());
  assert.deepEqual(Object.keys(candidate), []);
  const receipt = await positive.verifier.verifyAndIssue({
    candidate,
    checkpointReceipt: positive.checkpointReceipt,
  });
  assert.deepEqual(
    positive.controls.calls,
    ["publication", "canonical", "enumerate", "fence", "publication"],
  );
  assert.deepEqual(Object.keys(receipt), []);
  assert(Object.isFrozen(receipt));
  assert.equal(JSON.stringify(receipt), "{}");
  const snapshot = positive.verifier.closureSnapshot(receipt);
  assert.equal(positive.verifier.closureSnapshot(receipt), snapshot);
  assert(Object.isFrozen(snapshot));
  assert(Object.isFrozen(snapshot.families));
  assert.equal(snapshot.families.length, 1);
  assert.equal(snapshot.families[0]?.inventoryCount, 1);
  assert.deepEqual(snapshot.families[0]?.inventoryKeys, ["legacy:wsteth"]);
  assert.deepEqual(snapshot.families[0]?.declaredSourceIds, [
    "address-surface",
    "observed-call",
  ]);
  assert.equal(snapshot.expectedRevision, 7);
  assert.equal(snapshot.expectedPublicationFingerprint, "7".repeat(64));
  assert.match(snapshot.inventoryMatrixFingerprint, /^[0-9a-f]{64}$/);
  assert.match(snapshot.matrixFingerprint, /^[0-9a-f]{64}$/);
  assert.match(snapshot.closureFingerprint, /^[0-9a-f]{64}$/);
  assert.equal("authority" in snapshot, false);
  assert.equal("sourceAnchors" in snapshot, false);
  assert.equal("inventoryMode" in snapshot, false);
  assert.equal("terminalRemovals" in snapshot, false);
  assert.equal(
    positive.verifier.consumeForCatalog(receipt, { source: SOURCE }),
    snapshot,
  );
  assert.throws(
    () => positive.verifier.closureSnapshot(receipt),
    /forged or foreign/,
    "a consumed closure receipt is one-shot",
  );
  await assert.rejects(
    () => positive.verifier.verifyAndIssue({
      candidate,
      checkpointReceipt: positive.checkpointReceipt,
    }),
    /forged or foreign/,
    "a prepared candidate is one-shot",
  );

  const zero = await harness({ enumeration: enumerationInput(SOURCE, []) });
  const zeroCandidate = zero.issuer.prepare(candidateInput(SOURCE, []));
  const zeroReceipt = await zero.verifier.verifyAndIssue({
    candidate: zeroCandidate,
    checkpointReceipt: zero.checkpointReceipt,
  });
  const zeroSnapshot = zero.verifier.closureSnapshot(zeroReceipt);
  assert.equal(zeroSnapshot.families.length, 1);
  assert.equal(zeroSnapshot.families[0]?.inventoryCount, 0);
  assert.deepEqual(zeroSnapshot.families[0]?.inventoryKeys, []);
  assert.equal(
    zeroSnapshot.families[0]?.inventoryHash,
    adapterFamilySnapshotInventoryHash({
      familyId: WSTETH_FAMILY_ID,
      source: SOURCE,
      incumbents: [],
    }),
    "an explicit zero row carries a source-bound canonical hash",
  );
  zero.verifier.consumeForCatalog(zeroReceipt, { source: SOURCE });
}

async function candidateAndEnumerationValidation(): Promise<void> {
  const candidateHarness = await harness();
  const row = candidateFamily(SOURCE, [candidateIncumbent()]);
  assert.throws(
    () => candidateHarness.issuer.prepare({ source: SOURCE, families: [] }),
    /missing discovery Family rows/,
  );
  assert.throws(
    () => candidateHarness.issuer.prepare({
      source: SOURCE,
      families: [row, row],
    }),
    /duplicate snapshot inventory Family/,
  );
  assert.throws(
    () => candidateHarness.issuer.prepare({
      source: SOURCE,
      families: [{
        ...row,
        familyId: familyId("protocol:extra-fixture"),
      }],
    }),
    /unknown snapshot inventory Family/,
  );
  assert.throws(
    () => candidateHarness.issuer.prepare({
      source: SOURCE,
      families: [{ ...row, inventoryCount: 2 }],
    }),
    /count mismatch/,
  );
  assert.throws(
    () => candidateHarness.issuer.prepare({
      source: SOURCE,
      families: [{ ...row, inventoryHash: "0".repeat(64) }],
    }),
    /hash mismatch/,
  );
  assert.throws(
    () => candidateHarness.issuer.prepare({
      source: SOURCE,
      families: [{
        ...row,
        incumbents: [candidateIncumbent(SOURCE, { address: OTHER_ADDRESS })],
      }],
    }),
    /surface address mismatch/,
  );
  assert.throws(
    () => candidateHarness.issuer.prepare({
      source: SOURCE,
      families: [{
        ...row,
        incumbents: [candidateIncumbent(SOURCE, {
          currentSurface: surface(SOURCE_NEXT),
        })],
      }],
    }),
    /canonical source mismatch/,
  );
  assert.throws(
    () => candidateHarness.issuer.prepare({
      source: SOURCE,
      families: [{
        ...row,
        incumbents: [candidateIncumbent(SOURCE, {
          currentSurface: surface(SOURCE, {
            interfaceFingerprints: ["foreign-surface"],
          }),
        })],
      }],
    }),
    /surface does not match Family/,
  );
  assert.throws(
    () => candidateHarness.issuer.prepare({
      source: SOURCE,
      families: [{
        ...row,
        incumbents: [candidateIncumbent(SOURCE, {
          terminalCandidates: [terminalCandidate({ status: "partial" })],
        })],
      }],
    }),
    /terminal evidence is partial/,
  );
  assert.throws(
    () => candidateHarness.issuer.prepare({
      source: SOURCE,
      families: [{
        ...row,
        incumbents: [candidateIncumbent(SOURCE, { terminalCandidates: [] })],
      }],
    }),
    /terminal candidates do not close/,
  );

  const wrongSourceCandidate = candidateHarness.issuer.prepare(
    candidateInput(SOURCE_NEXT),
  );
  await assert.rejects(
    () => candidateHarness.verifier.verifyAndIssue({
      candidate: wrongSourceCandidate,
      checkpointReceipt: candidateHarness.checkpointReceipt,
    }),
    /canonical source mismatch/,
  );

  async function rejectEnumeration(
    enumeration: AdapterFamilySnapshotInventoryEnumerationInput,
    expected: RegExp,
  ): Promise<void> {
    candidateHarness.controls.enumerate = () => enumeration;
    const candidate = candidateHarness.issuer.prepare(candidateInput());
    await assert.rejects(
      () => candidateHarness.verifier.verifyAndIssue({
        candidate,
        checkpointReceipt: candidateHarness.checkpointReceipt,
      }),
      expected,
    );
  }

  await rejectEnumeration(
    { source: SOURCE, families: [] },
    /missing discovery Family rows/,
  );
  const enumeratedRow = enumerationFamily(SOURCE, [enumerationIncumbent()]);
  await rejectEnumeration(
    { source: SOURCE, families: [enumeratedRow, enumeratedRow] },
    /duplicate snapshot inventory Family/,
  );
  await rejectEnumeration(
    {
      source: SOURCE,
      families: [{
        ...enumeratedRow,
        familyId: familyId("protocol:extra-enumeration"),
      }],
    },
    /unknown snapshot inventory Family/,
  );
  await rejectEnumeration(
    enumerationInput(SOURCE, []),
    /disagrees with authoritative enumeration/,
  );
  await rejectEnumeration(
    enumerationInput(SOURCE_NEXT),
    /canonical source mismatch/,
  );
  const changedSurface = enumerationIncumbent(SOURCE, {
    currentSurface: surface(SOURCE, { codeHashDigit: "8" }),
  });
  await rejectEnumeration(
    enumerationInput(SOURCE, [changedSurface]),
    /disagrees with authoritative enumeration/,
  );
  await rejectEnumeration(
    {
      source: SOURCE,
      families: [{ ...enumeratedRow, inventoryHash: "0".repeat(64) }],
    },
    /hash mismatch/,
  );
}

async function opaqueAuthorityAndReplay(): Promise<void> {
  const local = await harness();
  const foreign = await harness();
  const localCandidate = local.issuer.prepare(candidateInput());
  await assert.rejects(
    () => local.verifier.verifyAndIssue({
      candidate: { ...localCandidate },
      checkpointReceipt: local.checkpointReceipt,
    }),
    /candidate is forged or foreign/,
  );
  const foreignCandidate = foreign.issuer.prepare(candidateInput());
  await assert.rejects(
    () => local.verifier.verifyAndIssue({
      candidate: foreignCandidate,
      checkpointReceipt: local.checkpointReceipt,
    }),
    /candidate is forged or foreign/,
  );

  const foreignReceipt = await foreign.verifier.verifyAndIssue({
    candidate: foreignCandidate,
    checkpointReceipt: foreign.checkpointReceipt,
  });
  assert.throws(
    () => local.verifier.closureSnapshot(foreignReceipt),
    /receipt is forged or foreign/,
  );
  assert.throws(
    () => foreign.verifier.closureSnapshot({ ...foreignReceipt }),
    /receipt is forged or foreign/,
  );
  const parsed = JSON.parse(JSON.stringify(foreignReceipt));
  assert.throws(
    () => foreign.verifier.closureSnapshot(parsed),
    /receipt is forged or foreign/,
  );
  foreign.verifier.consumeForCatalog(foreignReceipt, { source: SOURCE });

  const localReceipt = await local.verifier.verifyAndIssue({
    candidate: localCandidate,
    checkpointReceipt: local.checkpointReceipt,
  });
  await assert.rejects(
    () => local.verifier.verifyAndIssue({
      candidate: localCandidate,
      checkpointReceipt: local.checkpointReceipt,
    }),
    /candidate is forged or foreign/,
  );
  local.verifier.consumeForCatalog(localReceipt, { source: SOURCE });
  assert.throws(
    () => local.verifier.consumeForCatalog(localReceipt, { source: SOURCE }),
    /receipt is forged or foreign/,
  );
}

async function checkpointPublicationAndAsyncFences(): Promise<void> {
  const continuity = await harness({ eventContinuity: false });
  const continuityCandidate = continuity.issuer.prepare(candidateInput());
  await assert.rejects(
    () => continuity.verifier.verifyAndIssue({
      candidate: continuityCandidate,
      checkpointReceipt: continuity.checkpointReceipt,
    }),
    /lacks current event continuity/,
  );
  assert.deepEqual(
    continuity.controls.calls,
    ["publication"],
    "continuity rejects before canonical verification or enumeration",
  );

  const current = await harness();
  const currentCandidate = current.issuer.prepare(candidateInput());
  const oldReceipt = current.checkpointReceipt;
  const reloaded = await current.checkpointStore.loadForRestart();
  assert.equal(reloaded.status, "trusted");
  await assert.rejects(
    () => current.verifier.verifyAndIssue({
      candidate: currentCandidate,
      checkpointReceipt: oldReceipt,
    }),
    /checkpoint receipt is not current/,
  );

  const publicationRace = await harness();
  publicationRace.controls.enumerate = () => {
    publicationRace.controls.publication = Object.freeze({
      revision: 8,
      publicationFingerprint: "8".repeat(64),
    });
    return enumerationInput();
  };
  const publicationRaceCandidate = publicationRace.issuer.prepare(candidateInput());
  await assert.rejects(
    () => publicationRace.verifier.verifyAndIssue({
      candidate: publicationRaceCandidate,
      checkpointReceipt: publicationRace.checkpointReceipt,
    }),
    /catalog publication changed during inventory verification/,
  );

  const consumption = await harness();
  const consumptionReceipt = await consumption.verifier.verifyAndIssue({
    candidate: consumption.issuer.prepare(candidateInput()),
    checkpointReceipt: consumption.checkpointReceipt,
  });
  const originalPublication = consumption.controls.publication;
  consumption.controls.publication = Object.freeze({
    revision: 8,
    publicationFingerprint: "8".repeat(64),
  });
  assert.throws(
    () => consumption.verifier.consumeForCatalog(
      consumptionReceipt,
      { source: SOURCE },
    ),
    /prior publication mismatch/,
  );
  consumption.controls.publication = originalPublication;
  consumption.controls.currentGeneration = SOURCE_NEXT.generation;
  assert.throws(
    () => consumption.verifier.consumeForCatalog(
      consumptionReceipt,
      { source: SOURCE },
    ),
    /fixture generation superseded/,
  );
  consumption.controls.currentGeneration = SOURCE.generation;
  assert.throws(
    () => consumption.verifier.consumeForCatalog(
      consumptionReceipt,
      { source: SOURCE_NEXT },
    ),
    /canonical source mismatch/,
  );
  consumption.verifier.consumeForCatalog(consumptionReceipt, { source: SOURCE });

  const generationRace = await harness();
  const generationEntered = deferred<void>();
  const generationRelease = deferred<
    AdapterFamilySnapshotInventoryEnumerationInput
  >();
  generationRace.controls.enumerate = async () => {
    generationEntered.resolve();
    return await generationRelease.promise;
  };
  const generationVerification = generationRace.verifier.verifyAndIssue({
    candidate: generationRace.issuer.prepare(candidateInput()),
    checkpointReceipt: generationRace.checkpointReceipt,
  });
  await generationEntered.promise;
  generationRace.controls.currentGeneration = SOURCE_NEXT.generation;
  generationRelease.resolve(enumerationInput());
  await assert.rejects(
    () => generationVerification,
    /fixture generation superseded/,
  );

  const checkpointRace = await harness();
  const checkpointEntered = deferred<void>();
  const checkpointRelease = deferred<
    AdapterFamilySnapshotInventoryEnumerationInput
  >();
  checkpointRace.controls.enumerate = async () => {
    checkpointEntered.resolve();
    return await checkpointRelease.promise;
  };
  const checkpointVerification = checkpointRace.verifier.verifyAndIssue({
    candidate: checkpointRace.issuer.prepare(candidateInput()),
    checkpointReceipt: checkpointRace.checkpointReceipt,
  });
  await checkpointEntered.promise;
  const checkpointReloaded = await checkpointRace.checkpointStore.loadForRestart();
  assert.equal(checkpointReloaded.status, "trusted");
  checkpointRelease.resolve(enumerationInput());
  await assert.rejects(
    () => checkpointVerification,
    /checkpoint changed during verification/,
  );
}

function productionCatalogFailsClosed(): void {
  const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
  const discoveryFamilies = catalog.listAll().filter((family) =>
    "discovery" in family.plugin
  );
  const lackingSnapshotBootstrap = discoveryFamilies.filter((family) => {
    if (!("discovery" in family.plugin)) return false;
    const { discovery } = family.plugin;
    const scopedSources = discovery.sources.every((sourceId) =>
      EVENT_SOURCES.has(sourceId) || sourceId === "address-surface"
    );
    const addressSurfaceBootstrap =
      discovery.sources.includes("address-surface") &&
      (discovery.addressSurfaces?.length ?? 0) > 0;
    const factoryLogBootstrap =
      discovery.sources.includes("factory-log") &&
      (discovery.logPatterns?.length ?? 0) > 0;
    return !scopedSources ||
      (!addressSurfaceBootstrap && !factoryLogBootstrap);
  });
  assert.equal(catalog.listAll().length, 22);
  assert.equal(discoveryFamilies.length, 20);
  assert.equal(lackingSnapshotBootstrap.length, 7);

  const store = checkpointStore(catalog);
  const verifier = new AdapterFamilySnapshotInventoryClosureVerifier({
    catalog,
    chainId: CHAIN_ID,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
    checkpointStore: store,
    enumerateSnapshotInventory: () => ({ source: SOURCE, families: [] }),
    captureCatalogPublication: () => ({
      revision: 0,
      publicationFingerprint: null,
    }),
    verifyCanonicalSource() {},
    assertGenerationCurrent() {},
  });
  const issuer = verifier.takeCandidateIssuer();
  const zeroRows = discoveryFamilies.map((family) =>
    candidateFamily(
      SOURCE,
      [],
      family.plugin.manifest.familyId,
    )
  );
  assert.throws(
    () => issuer.prepare({ source: SOURCE, families: zeroRows }),
    /lacks snapshot bootstrap coverage/,
    "the current 7-Family snapshot bootstrap gap must prevent catalog-wide closure",
  );
}

async function factoryLogClosurePositive(): Promise<void> {
  const catalog = univ2Catalog();
  const local = await harness({
    catalog,
    enumeration: univ2EnumerationInput(),
  });
  const candidate = local.issuer.prepare(univ2CandidateInput());
  const receipt = await local.verifier.verifyAndIssue({
    candidate,
    checkpointReceipt: local.checkpointReceipt,
  });
  const snapshot = local.verifier.closureSnapshot(receipt);
  assert.equal(snapshot.families.length, 1);
  assert.equal(snapshot.families[0]?.familyId, UNIV2_FAMILY_ID);
  assert.deepEqual(snapshot.families[0]?.inventoryKeys, [UNIV2_CANDIDATE_KEY]);
  assert.deepEqual(
    snapshot.families[0]?.admittedInstancePublicationKeys,
    ["swap:univ2:fixture-pool"],
  );
  assert.deepEqual(snapshot.families[0]?.declaredSourceIds, [
    "factory-log",
    "landed-log",
    "observed-call",
  ]);
  local.verifier.consumeForCatalog(receipt, { source: SOURCE });
  assert.throws(
    () => local.verifier.consumeForCatalog(receipt, { source: SOURCE }),
    /forged or foreign/,
    "a factory-log closure receipt is one-shot",
  );

  const addressSurfaceHash = adapterFamilySnapshotInventoryHash({
    familyId: UNIV2_FAMILY_ID,
    source: SOURCE,
    incumbents: [{
      inventoryKey: UNIV2_CANDIDATE_KEY,
      address: UNIV2_FIXTURE_POOL,
      currentSurface: surface(SOURCE, {
        address: UNIV2_FIXTURE_POOL,
        interfaceFingerprints: ["univ2-pair-surface-v1"],
      }),
    }],
  });
  const factoryLogHash = adapterFamilySnapshotInventoryHash({
    familyId: UNIV2_FAMILY_ID,
    source: SOURCE,
    incumbents: [{
      inventoryKey: UNIV2_CANDIDATE_KEY,
      address: UNIV2_FIXTURE_POOL,
      currentSurface: factoryLogSurface(),
    }],
  });
  assert.notEqual(
    addressSurfaceHash,
    factoryLogHash,
    "incumbent kind and factory-log projection must be fingerprinted",
  );
}

async function factoryLogValidation(): Promise<void> {
  const catalog = univ2Catalog();
  const local = await harness({
    catalog,
    enumeration: univ2EnumerationInput(),
  });
  const wrongKey = `0x${"51".repeat(20)}`;
  const wrongKeyInput = Object.freeze({
    source: SOURCE,
    families: Object.freeze([
      candidateFamily(SOURCE, [candidateIncumbent(SOURCE, {
        inventoryKey: wrongKey.toLowerCase(),
        address: wrongKey,
        currentSurface: factoryLogSurface(),
        terminalCandidates: Object.freeze([
          terminalCandidate({
            candidateKey: wrongKey.toLowerCase(),
            admittedInstancePublicationKeys: ["swap:univ2:wrong-pool"],
          }),
        ]),
      })], UNIV2_FAMILY_ID),
    ]),
  });
  assert.throws(
    () => local.issuer.prepare(wrongKeyInput),
    /factory-log surface does not close/,
  );

  const staleSurface = candidateIncumbent(SOURCE, {
    inventoryKey: UNIV2_CANDIDATE_KEY,
    address: UNIV2_FIXTURE_POOL,
    currentSurface: factoryLogSurface(SOURCE, {
      lastFactoryLogBlock: SOURCE.number + 1,
    }),
    terminalCandidates: Object.freeze([
      terminalCandidate({
        candidateKey: UNIV2_CANDIDATE_KEY,
        admittedInstancePublicationKeys: ["swap:univ2:fixture-pool"],
      }),
    ]),
  });
  assert.throws(
    () => local.issuer.prepare(Object.freeze({
      source: SOURCE,
      families: Object.freeze([
        candidateFamily(SOURCE, [staleSurface], UNIV2_FAMILY_ID),
      ]),
    })),
    /must not exceed its source/,
  );

  const droppedTopic = Object.freeze({
    ...factoryLogSurface(SOURCE),
    topics: Object.freeze(factoryLogSurface(SOURCE).topics.slice(1)),
  });
  assert.throws(
    () => freezeSurfaceViaEnumeration(droppedTopic),
    /topic not in topics/,
  );
}

function freezeSurfaceViaEnumeration(
  surface: AdapterFamilySnapshotInventoryObservation,
): void {
  enumeratePointInTimeInventory({
    source: SOURCE,
    families: [{
      familyId: UNIV2_FAMILY_ID,
      incumbents: [{
        inventoryKey: UNIV2_CANDIDATE_KEY,
        address: UNIV2_FIXTURE_POOL,
        currentSurface: surface,
      }],
    }],
  });
}

async function main(): Promise<void> {
  await positiveAndZeroInventory();
  await candidateAndEnumerationValidation();
  await opaqueAuthorityAndReplay();
  await checkpointPublicationAndAsyncFences();
  productionCatalogFailsClosed();
  await factoryLogClosurePositive();
  await factoryLogValidation();
  console.log("adapter-family-snapshot-inventory-closure PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
