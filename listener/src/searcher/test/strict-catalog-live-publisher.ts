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
  deriveLiveDiscoveryCheckpointInventory,
} from "../live-discovery-checkpoint-inventory.js";
import {
  publishStrictCatalogFromLifecycle,
} from "../strict-catalog-live-publisher.js";
import {
  runWstethLifecycle,
  runFluidDexLifecycle,
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
import {
  createProtocolDiscoveryEvidenceCache,
} from "../protocol-discovery-cache.js";
import type { LiveDiscoveryPublicationState } from
  "../live-discovery-publication.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const SOURCE2: CanonicalSource = Object.freeze({
  number: SOURCE.number + 40,
  hash: `0x${"52".repeat(32)}`,
  generation: 45,
});
const SOURCE3: CanonicalSource = Object.freeze({
  number: SOURCE2.number + 10,
  hash: `0x${"53".repeat(32)}`,
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

    // Production catalog: a single-family publication must still stage every
    // other catalog Family as unsupported, or the catalogRoot CAS rejects the
    // whole publication ("missing Family ..."). Regression for the node
    // acceptance unresolved after fluid-dex identity passed.
    const prodDirectory = await mkdtemp(
      join(tmpdir(), "strict-catalog-live-publisher-prod-"),
    );
    try {
      const prodPath = join(prodDirectory, "checkpoint.json");
      const prodCat = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
      const prodComposition = createDurableDiscoveryContinuityComposition({
        catalog: prodCat,
        chainId: CHAIN_ID,
        sourceRegistryFingerprint: REGISTRY,
        checkpointPath: prodPath,
        enumerateSnapshotInventory: async (source) => {
          const enumerator = new CheckpointDiscoveryInventoryEnumerator({
            checkpointStore: prodComposition.store,
          });
          return await enumerator.enumerate(source);
        },
        verifyCanonicalSource: () => {},
        assertGenerationCurrent: () => {},
      });
      assert.equal((await prodComposition.loadForRestart()).status, "empty");
      const prodCache = createProtocolDiscoveryEvidenceCache(1n);
      prodCache.verifiedCandidates.set("wsteth-adapter", {
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
      const prodPublicationState = Object.freeze({
        protocolEvidenceCache: prodCache,
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
      const prodDerived = deriveLiveDiscoveryCheckpointInventory({
        publication: prodPublicationState,
        source: SOURCE,
        catalog: prodCat,
        familyIdForAdapter: (adapterId) =>
          adapterId === "wsteth-adapter" ? WSTETH_FAMILY_ID : null,
      });
      const prodWriter = new CheckpointDiscoveryInventoryWriter({
        checkpointStore: prodComposition.store,
        checkpointIssuer: prodComposition.checkpointIssuer,
      });
      const prodWrite = await prodWriter.write({
        source: SOURCE,
        watermarks: prodDerived.watermarks,
        inventoryFamilies: prodDerived.inventoryFamilies,
      });
      assert.equal(prodWrite.status, "committed");
      const prodPublication = await runWstethLifecycle(SOURCE, prodCat);
      const prodResult = await publishStrictCatalogFromLifecycle({
        composition: prodComposition,
        catalog: prodCat,
        source: SOURCE,
        publications: Object.freeze([{
          familyId: WSTETH_FAMILY_ID,
          publication: prodPublication,
        }]),
      });
      if (prodResult.status !== "published") {
        throw new Error("production catalog unresolved: " + prodResult.reason);
      }
      assert.equal(prodResult.revision, 1);

      // Multi-family observed-complete publication: two real lifecycle
      // publications must stage in one catalogRoot CAS. The previous
      // implementation shared one closure receipt across complete-snapshot
      // stages (receipt is consumed on first use), so this failed as soon as
      // more than one family published.
      const multiPublication = await runWstethLifecycle(SOURCE2, prodCat);
      const fluidPublication = await runFluidDexLifecycle(SOURCE2);
      const multiResult = await publishStrictCatalogFromLifecycle({
        composition: prodComposition,
        catalog: prodCat,
        source: SOURCE2,
        publications: Object.freeze([
          Object.freeze({ familyId: WSTETH_FAMILY_ID, publication: multiPublication }),
          Object.freeze({
            familyId: fluidPublication.familyId,
            publication: fluidPublication,
          }),
        ]),
      });
      if (multiResult.status !== "published") {
        throw new Error("multi-family catalog unresolved: " + multiResult.reason);
      }
      assert.equal(multiResult.revision, 2);
      const multiCommitted = prodComposition.catalogRoot.capture();
      assert(multiCommitted);
      assert.equal(multiCommitted.envelope.privateState.instances.size, 2);
      assert(
        [...multiCommitted.envelope.snapshot.sourceAnchors.values()].every(
          (anchor) => anchor.authority === "append-only-nomination",
        ),
        "live publications must never grant complete-snapshot anchors",
      );

      // The final catalogRoot CAS must use the composition's real fences:
      // canonical verification is invoked, and a stale source generation is
      // rejected instead of being committed through a no-op.
      const fenceDirectory = await mkdtemp(
        join(tmpdir(), "strict-catalog-live-publisher-fence-"),
      );
      try {
        let canonicalVerifications = 0;
        const fenceComposition = createDurableDiscoveryContinuityComposition({
          catalog: prodCat,
          chainId: CHAIN_ID,
          sourceRegistryFingerprint: REGISTRY,
          checkpointPath: join(fenceDirectory, "checkpoint.json"),
          enumerateSnapshotInventory: async (source) => {
            const enumerator = new CheckpointDiscoveryInventoryEnumerator({
              checkpointStore: fenceComposition.store,
            });
            return await enumerator.enumerate(source);
          },
          verifyCanonicalSource: async () => { canonicalVerifications++; },
          assertGenerationCurrent: () => {},
        });
        assert.equal((await fenceComposition.loadForRestart()).status, "empty");
        const fencePublication = await runWstethLifecycle(SOURCE, prodCat);
        const fenceResult = await publishStrictCatalogFromLifecycle({
          composition: fenceComposition,
          catalog: prodCat,
          source: SOURCE,
          publications: Object.freeze([{
            familyId: WSTETH_FAMILY_ID,
            publication: fencePublication,
          }]),
        });
        assert.equal(fenceResult.status, "published");
        assert(
          canonicalVerifications >= 1,
          "final catalog CAS must invoke the composition canonical verifier",
        );
        const stalePublication = await runWstethLifecycle(SOURCE3, prodCat);
        const staleResult = await publishStrictCatalogFromLifecycle({
          composition: fenceComposition,
          catalog: prodCat,
          source: SOURCE3,
          publications: Object.freeze([{
            familyId: WSTETH_FAMILY_ID,
            publication: stalePublication,
          }]),
        });
        assert.equal(staleResult.status, "unresolved");
        if (staleResult.status === "unresolved") {
          assert.match(
            staleResult.reason,
            /(strict catalog source generation is stale|staged publication generation is not newer)/,
          );
        }
      } finally {
        await rm(fenceDirectory, { recursive: true, force: true });
      }
    } finally {
      await rm(prodDirectory, { recursive: true, force: true });
    }
    console.log("strict-catalog-live-publisher PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
