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
  CheckpointDiscoveryInventoryWriter,
} from "../adapter-family-discovery-inventory-writer.js";
import {
  deriveLiveDiscoveryAddressSurfaceObservations,
  deriveLiveDiscoveryCheckpointInventory,
} from "../live-discovery-checkpoint-inventory.js";
import {
  publishStrictCatalogFromLifecycle,
} from "../strict-catalog-live-publisher.js";
import {
  runStrictFamilyLifecycle,
} from "../strict-family-lifecycle-runner.js";
import {
  createStrictCentralAdapterRuntime,
} from "../strict-central-adapter-runtime.js";
import {
  createProtocolDiscoveryEvidenceCache,
} from "../protocol-discovery-cache.js";
import type { LiveDiscoveryPublicationState } from
  "../live-discovery-publication.js";
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
import { WSTETH_INTERFACE } from
  "../venues/protocols/wsteth-family/codec.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const SOURCE2: CanonicalSource = Object.freeze({
  number: SOURCE.number + 1,
  hash: `0x${"52".repeat(32)}`,
  generation: 45,
});
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const STETH = "0xae7ab96520de3a18e5e111b5eaab095312d7fe84";
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

function fixturePublication(): LiveDiscoveryPublicationState {
  const cache = createProtocolDiscoveryEvidenceCache(1n);
  cache.addressEntries.set(WSTETH.toLowerCase(), Object.freeze({
    adapterId: "wsteth-adapter",
    address: WSTETH.toLowerCase(),
    codeHash: `0x${"1".repeat(64)}`,
    implementationWord: `0x${"0".repeat(64)}`,
    matcherVersion: "fixture-v1",
    dependencyPolicyVersion: null,
    dependencyFingerprint: null,
    checkedAtBlock: SOURCE.number,
    candidate: Object.freeze({
      pool: Object.freeze({}) as never,
      source: "fixture",
    }),
  }));
  return Object.freeze({
    protocolEvidenceCache: cache,
    protocolFamilySourceCoverage: new Map(),
    dexSourceAnchor: Object.freeze({
      completeThroughBlock: SOURCE.number,
      completeThroughHash: SOURCE.hash,
    }),
    protocolObservedCursor: Object.freeze({
      completeThroughBlock: SOURCE.number,
      completeThroughHash: SOURCE.hash,
    }),
  }) as unknown as LiveDiscoveryPublicationState;
}

function mockProvider() {
  return Object.freeze({
    call: async (tx: { readonly to: string; readonly data: string }) => {
      const data = tx.data.toLowerCase();
      if (data.startsWith(WSTETH_INTERFACE.getFunction("stETH")!.selector)) {
        return WSTETH_INTERFACE.encodeFunctionResult("stETH", [STETH]);
      }
      if (data.startsWith(
        WSTETH_INTERFACE.getFunction("getWstETHByStETH")!.selector,
      )) {
        return WSTETH_INTERFACE.encodeFunctionResult("getWstETHByStETH", [
          10n ** 18n,
        ]);
      }
      if (data.startsWith(
        WSTETH_INTERFACE.getFunction("getStETHByWstETH")!.selector,
      )) {
        return WSTETH_INTERFACE.encodeFunctionResult("getStETHByWstETH", [
          10n ** 18n,
        ]);
      }
      throw new Error(`unexpected mock call ${data}`);
    },
    getCode: async () => "0x00",
    getStorage: async () => `0x${"0".repeat(64)}`,
  });
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "strict-live-feed-"));
  try {
    const cat = catalog();
    const composition = createDurableDiscoveryContinuityComposition({
      catalog: cat,
      chainId: CHAIN_ID,
      sourceRegistryFingerprint: REGISTRY,
      checkpointPath: join(directory, "checkpoint.json"),
      enumerateSnapshotInventory: async (source) => {
        const enumerator = new CheckpointDiscoveryInventoryEnumerator({
          checkpointStore: composition.store,
        });
        return await enumerator.enumerate(source);
      },
      verifyCanonicalSource: () => {},
      assertGenerationCurrent: () => {},
    });
    assert.equal((await composition.loadForRestart()).status, "empty");
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

    const runtime = createStrictCentralAdapterRuntime({
      provider: mockProvider() as never,
      generationFence: Object.freeze({ assertCurrent() {} }),
    });
    const observations = deriveLiveDiscoveryAddressSurfaceObservations({
      publication: fixturePublication(),
      source: SOURCE,
      catalog: cat,
      familyIdForAdapter: (adapterId) =>
        adapterId === "wsteth-adapter" ? WSTETH_FAMILY_ID : null,
    });
    assert.equal(observations.size, 1);
    const publication = await runStrictFamilyLifecycle({
      catalog: cat,
      familyId: WSTETH_FAMILY_ID,
      source: SOURCE,
      observations: observations.get(WSTETH_FAMILY_ID)!,
      runtime,
    });
    assert(publication.instances.length >= 1);
    const result = await publishStrictCatalogFromLifecycle({
      composition,
      catalog: cat,
      source: SOURCE,
      publications: Object.freeze([{
        familyId: WSTETH_FAMILY_ID,
        publication,
      }]),
    });
    assert.equal(result.status, "published");
    assert(result.status === "published");
    assert.equal(result.revision, 1);
    assert(composition.catalogRoot.capture()!.views.pricingByPublicationKey
      .size >= 1);

    // Verified legacy candidates are retained nominations: they must re-enter
    // the strict pipeline as current-source address-surface observations and
    // publish a new catalogRoot revision instead of being dropped by an
    // address-entry-only feed.
    const verifiedCache = createProtocolDiscoveryEvidenceCache(1n);
    verifiedCache.verifiedCandidates.set("wsteth-adapter", {
      adapterId: "wsteth-adapter",
      candidate: Object.freeze({
        pool: Object.freeze({ address: WSTETH.toLowerCase() }) as never,
        source: "persisted-verified-evidence",
        evidence: Object.freeze([Object.freeze({
          codeHash: `0x${"1".repeat(64)}`,
          implementationWord: `0x${"0".repeat(64)}`,
        })]),
      }),
    });
    const verifiedPublication = Object.freeze({
      ...fixturePublication(),
      protocolEvidenceCache: verifiedCache,
      protocolObservedCursor: Object.freeze({
        completeThroughBlock: SOURCE2.number,
        completeThroughHash: SOURCE2.hash,
      }),
      dexSourceAnchor: Object.freeze({
        completeThroughBlock: SOURCE2.number,
        completeThroughHash: SOURCE2.hash,
      }),
      protocolFamilySourceCoverage: new Map(),
    }) as unknown as LiveDiscoveryPublicationState;
    const verifiedObservations = deriveLiveDiscoveryAddressSurfaceObservations({
      publication: verifiedPublication,
      source: SOURCE2,
      catalog: cat,
      familyIdForAdapter: (adapterId) =>
        adapterId === "wsteth-adapter" ? WSTETH_FAMILY_ID : null,
    });
    assert.equal(verifiedObservations.size, 1);
    const verifiedObservation = verifiedObservations.get(WSTETH_FAMILY_ID)![0];
    assert.equal(verifiedObservation.kind, "address-surface");
    assert.equal(
      verifiedObservation.address.toLowerCase(),
      WSTETH.toLowerCase(),
    );
    assert.deepEqual(
      verifiedObservation.interfaceFingerprints,
      ["wsteth-conversion-surface-v1"],
    );
    // Production ordering: sync the checkpoint inventory at the new source
    // before the catalogRoot publication so closure sees the incumbents.
    const verifiedInventory = deriveLiveDiscoveryCheckpointInventory({
      publication: verifiedPublication,
      source: SOURCE2,
      catalog: cat,
      familyIdForAdapter: (adapterId) =>
        adapterId === "wsteth-adapter" ? WSTETH_FAMILY_ID : null,
    });
    const verifiedInventoryWriter = new CheckpointDiscoveryInventoryWriter({
      checkpointStore: composition.store,
      checkpointIssuer: composition.checkpointIssuer,
    });
    const verifiedInventoryResult = await verifiedInventoryWriter.write({
      source: SOURCE2,
      watermarks: verifiedInventory.watermarks,
      inventoryFamilies: verifiedInventory.inventoryFamilies,
    });
    assert.equal(verifiedInventoryResult.status, "committed");
    const verifiedPublicationResult = await runStrictFamilyLifecycle({
      catalog: cat,
      familyId: WSTETH_FAMILY_ID,
      source: SOURCE2,
      observations: verifiedObservations.get(WSTETH_FAMILY_ID)!,
      runtime,
    });
    assert(verifiedPublicationResult.instances.length >= 1);
    const verifiedPublishResult = await publishStrictCatalogFromLifecycle({
      composition,
      catalog: cat,
      source: SOURCE2,
      publications: Object.freeze([{
        familyId: WSTETH_FAMILY_ID,
        publication: verifiedPublicationResult,
      }]),
    });
    assert.equal(
      verifiedPublishResult.status,
      "published",
      verifiedPublishResult.status === "unresolved"
        ? `unresolved: ${verifiedPublishResult.reason}`
        : "",
    );
    assert.equal(verifiedPublishResult.revision, 2);
    console.log("strict-live-observation-feed PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
