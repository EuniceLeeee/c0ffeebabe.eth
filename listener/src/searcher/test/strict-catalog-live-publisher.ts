import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDurableDiscoveryContinuityComposition,
} from "../adapter-family-discovery-continuity-composition.js";
import {
  CheckpointDiscoveryInventoryEnumerator,
} from "../adapter-family-discovery-inventory-enumerator.js";
import {
  publishStrictCatalogFromLifecycle,
} from "../strict-catalog-live-publisher.js";
import {
  runWstethLifecycle,
} from "../architecture-migration-fixture-replay.js";
import {
  definedFamilyPluginContractSummary,
  type AnyDefinedStrictFamilyPlugin,
} from "../venues/adapter-family-plugin.js";
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
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const CHAIN_ID = "1";
const REGISTRY = "strict-source-registry-v1";

function catalog(): FamilyCapabilityCatalog {
  const plugin =
    PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG.forStrictFamily(
      WSTETH_FAMILY_ID,
    ).plugin;
  const summary = definedFamilyPluginContractSummary(plugin);
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
      sourceFile: "wsteth-family-plugin.ts",
      definitionBoundaryHash: summary.definitionBoundaryHash,
      plugin: plugin as AnyDefinedStrictFamilyPlugin,
    })],
    generatedManifest: Object.freeze({
      format: "adapter-family-capabilities-v1",
      entries: Object.freeze(entries),
      manifestHash: capabilityManifestHash(entries),
    }),
  });
}

async function main(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "strict-catalog-live-publisher-"),
  );
  try {
    const path = join(directory, "checkpoint.json");
    const cat = catalog();
    const composition = createDurableDiscoveryContinuityComposition({
      catalog: cat,
      chainId: CHAIN_ID,
      sourceRegistryFingerprint: REGISTRY,
      checkpointPath: path,
      enumerateSnapshotInventory: async (source) => {
        const enumerator = new CheckpointDiscoveryInventoryEnumerator({
          checkpointStore: composition.store,
        });
        return await enumerator.enumerate(source);
      },
      verifyCanonicalSource: () => {},
      assertGenerationCurrent: () => {},
    });
    const empty = await composition.loadForRestart();
    assert.equal(empty.status, "empty");
    const inventoryFamilies = Object.freeze([Object.freeze({
      familyId: WSTETH_FAMILY_ID,
      incumbents: Object.freeze([Object.freeze({
        inventoryKey: "legacy:wsteth",
        address: WSTETH,
        currentSurface: Object.freeze({
          kind: "address-surface" as const,
          source: SOURCE,
          address: WSTETH,
          codeHash: `0x${"1".repeat(64)}`,
          implementationWord: `0x${"0".repeat(64)}`,
          interfaceFingerprints: Object.freeze([
            "wsteth-conversion-surface-v1",
          ]),
        }),
      })]),
    })]);
    const staged = composition.checkpointIssuer.prepare({
      source: SOURCE,
      watermarks: Object.freeze([
        Object.freeze({
          familyId: WSTETH_FAMILY_ID,
          sourceId: "observed-call",
          coverageAuthority: "contiguous-history" as const,
          completeThroughBlock: SOURCE.number,
          completeThroughHash: SOURCE.hash,
        }),
        Object.freeze({
          familyId: WSTETH_FAMILY_ID,
          sourceId: "address-surface",
          coverageAuthority: "append-only" as const,
          completeThroughBlock: -1,
          completeThroughHash: null,
        }),
      ]),
      inventoryFamilies,
    });
    assert.equal(await composition.store.compareAndCommit({
      expected: null,
      staged,
    }), true);

    const publication = await runWstethLifecycle(SOURCE, cat);
    const result = await publishStrictCatalogFromLifecycle({
      composition,
      catalog: cat,
      source: SOURCE,
      publications: Object.freeze([{
        familyId: WSTETH_FAMILY_ID,
        publication,
      }]),
    });
    if (result.status !== "published") { throw new Error("unresolved: " + result.reason); }
    assert(result.status === "published");
    assert.equal(result.revision, 1);
    const committed = composition.catalogRoot.capture();
    assert(committed);
    assert(committed.views.pricingByPublicationKey.size >= 1);
    assert(committed.envelope.privateState.instances.size >= 1);
    console.log("strict-catalog-live-publisher PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
