import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDurableDiscoveryContinuityComposition,
} from "../adapter-family-discovery-continuity-composition.js";
import {
  adapterFamilySnapshotInventoryHash,
  type AdapterFamilySnapshotInventoryClosureCandidateInput,
  type AdapterFamilySnapshotInventoryClosureReceipt,
  type AdapterFamilySnapshotInventoryEnumerationFamilyInput,
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
  type DiscoverySourceKind,
  type UnifiedObservation,
} from "../venues/adapter-family-plugin.js";
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

type AddressSurfaceObservation = Extract<
  UnifiedObservation,
  { readonly kind: "address-surface" }
>;

const CHAIN_ID = "1";
const SOURCE_REGISTRY_FINGERPRINT = "strict-source-registry-v1";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
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

function syntheticCatalog(): FamilyCapabilityCatalog {
  const plugin =
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forStrictFamily(
      WSTETH_FAMILY_ID,
    ).plugin;
  const summary = definedFamilyPluginContractSummary(plugin);
  const entries = FAMILY_CAPABILITY_NAMES.map((capability, index) =>
    Object.freeze({
      familyId: WSTETH_FAMILY_ID,
      capability,
      contractVersion: "adapter-family-contract-v1",
      contentHash: index.toString(16).padStart(64, "0"),
      semanticDependencies: Object.freeze([]),
      provenanceCommit: null,
    }) satisfies GeneratedCapabilityIdentity
  );
  return new FamilyCapabilityCatalog({
    modules: [Object.freeze({
      sourceFile: "wsteth-family-plugin.ts",
      definitionBoundaryHash: summary.definitionBoundaryHash,
      plugin,
    })],
    generatedManifest: Object.freeze({
      format: "adapter-family-capabilities-v1",
      entries: Object.freeze(entries),
      manifestHash: capabilityManifestHash(entries),
    }),
  });
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

function terminalCandidate(): AdapterFamilySnapshotTerminalCandidateInput {
  return Object.freeze({
    candidateKey: WSTETH.toLowerCase(),
    status: "terminal" as const,
    outcomeFingerprint: "3".repeat(64),
    evidenceRefs: Object.freeze(["fixture:terminal-evidence"]),
    admittedInstancePublicationKeys: Object.freeze([
      "protocol:wsteth:fixture-instance",
    ]),
    publicationFingerprints: Object.freeze(["4".repeat(64)]),
  });
}

function candidateIncumbent(
  canonical: CanonicalSource,
): AdapterFamilySnapshotInventoryIncumbentInput {
  return Object.freeze({
    inventoryKey: "legacy:wsteth",
    address: WSTETH,
    currentSurface: surface(canonical),
    terminalCandidates: Object.freeze([terminalCandidate()]),
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
): AdapterFamilySnapshotInventoryFamilyInput {
  const inventoryKeys = Object.freeze(
    incumbents.map((incumbent) => incumbent.inventoryKey).sort(),
  );
  return Object.freeze({
    familyId: WSTETH_FAMILY_ID,
    inventoryKeys,
    inventoryCount: inventoryKeys.length,
    inventoryHash: adapterFamilySnapshotInventoryHash({
      familyId: WSTETH_FAMILY_ID,
      source: canonical,
      incumbents,
    }),
    incumbents: Object.freeze([...incumbents]),
  });
}

function enumerationFamily(
  canonical: CanonicalSource,
  incumbents: readonly ReturnType<typeof enumerationIncumbent>[],
): AdapterFamilySnapshotInventoryEnumerationFamilyInput {
  const inventoryKeys = Object.freeze(
    incumbents.map((incumbent) => incumbent.inventoryKey).sort(),
  );
  return Object.freeze({
    familyId: WSTETH_FAMILY_ID,
    inventoryKeys,
    inventoryCount: inventoryKeys.length,
    inventoryHash: adapterFamilySnapshotInventoryHash({
      familyId: WSTETH_FAMILY_ID,
      source: canonical,
      incumbents,
    }),
    incumbents: Object.freeze([...incumbents]),
  });
}

function candidateInput(
  canonical: CanonicalSource,
): AdapterFamilySnapshotInventoryClosureCandidateInput {
  return Object.freeze({
    source: canonical,
    families: Object.freeze([
      candidateFamily(canonical, [candidateIncumbent(canonical)]),
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
  const composition = createDurableDiscoveryContinuityComposition({
    catalog,
    chainId: CHAIN_ID,
    sourceRegistryFingerprint: SOURCE_REGISTRY_FINGERPRINT,
    checkpointPath: path,
    enumerateSnapshotInventory: (canonical) => enumerationInput(canonical),
    verifyCanonicalSource: () => {},
    assertGenerationCurrent: () => {},
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
