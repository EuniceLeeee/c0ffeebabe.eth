import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterFamilyDiscoveryCheckpointStore,
  FileAdapterFamilyDiscoveryCheckpointBackend,
  emptyCheckpointInventoryFamilies,
  type AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily,
} from "./adapter-family-discovery-checkpoint.js";
import {
  CheckpointDiscoveryInventoryEnumerator,
} from "./adapter-family-discovery-inventory-enumerator.js";
import type { CanonicalSource } from
  "./venues/adapter-request-program.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "./venues/production-family-composition.js";
import { WSTETH_FAMILY_ID } from
  "./venues/protocols/wsteth-family/manifest.js";
import { UNIV2_FAMILY_ID } from
  "./venues/swaps/univ2-family/manifest.js";
import {
  UNIV2_FACTORY_INTERFACE,
  UNIV2_PAIR_CREATED_TOPIC,
} from "./venues/swaps/univ2-family/codec.js";

/**
 * Node dry-run for the checkpoint-backed point-in-time enumerator (§2
 * acceptance 1, fixture-backed): builds a real file-backed checkpoint with
 * fixture incumbent inventory (address-surface + factory-log), restores it
 * through the production catalog and CheckpointDiscoveryInventoryEnumerator,
 * and prints a machine-readable pass record. It never touches RPC, the live
 * searcher, signing or broadcasting.
 */

const EVENT_SOURCE_IDS: ReadonlySet<string> = new Set([
  "factory-log",
  "landed-log",
  "observed-call",
]);
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const UNIV2_POOL = `0x${"41".repeat(20)}`;
const UNIV2_FACTORY = `0x${"42".repeat(20)}`;
const UNIV2_TOKEN0 = `0x${"43".repeat(20)}`;
const UNIV2_TOKEN1 = `0x${"44".repeat(20)}`;
const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;

function watermarks(canonical: CanonicalSource) {
  return catalog.listAll().flatMap((family) =>
    "discovery" in family.plugin
      ? family.plugin.discovery.sources.map((sourceId) =>
          Object.freeze({
            familyId: family.plugin.manifest.familyId,
            sourceId,
            coverageAuthority: EVENT_SOURCE_IDS.has(sourceId)
              ? "contiguous-history" as const
              : "append-only" as const,
            completeThroughBlock: EVENT_SOURCE_IDS.has(sourceId)
              ? canonical.number
              : -1,
            completeThroughHash: EVENT_SOURCE_IDS.has(sourceId)
              ? canonical.hash
              : null,
          })
        )
      : []
  );
}

function fixtureInventory(
  canonical: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[] {
  const log = UNIV2_FACTORY_INTERFACE.encodeEventLog("PairCreated", [
    UNIV2_TOKEN0,
    UNIV2_TOKEN1,
    UNIV2_POOL,
    0n,
  ]);
  return Object.freeze([
    Object.freeze({
      familyId: WSTETH_FAMILY_ID,
      incumbents: Object.freeze([Object.freeze({
        inventoryKey: "legacy:wsteth",
        address: WSTETH,
        currentSurface: Object.freeze({
          kind: "address-surface" as const,
          source: canonical,
          address: WSTETH,
          codeHash: `0x${"1".repeat(64)}`,
          implementationWord: `0x${"0".repeat(64)}`,
          interfaceFingerprints: Object.freeze([
            "wsteth-conversion-surface-v1",
          ]),
        }),
      })]),
    }),
    Object.freeze({
      familyId: UNIV2_FAMILY_ID,
      incumbents: Object.freeze([Object.freeze({
        inventoryKey: UNIV2_POOL.toLowerCase(),
        address: UNIV2_POOL,
        currentSurface: Object.freeze({
          kind: "factory-log" as const,
          source: canonical,
          factory: UNIV2_FACTORY.toLowerCase(),
          poolKeyProjection: UNIV2_POOL.toLowerCase(),
          lastFactoryLogBlock: canonical.number,
          topic: UNIV2_PAIR_CREATED_TOPIC,
          topics: Object.freeze(log.topics),
          data: log.data,
        }),
      })]),
    }),
  ]);
}

async function main(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "mev-s1-node-enumerator-dry-run-"),
  );
  const store = new AdapterFamilyDiscoveryCheckpointStore({
    catalog,
    chainId: "1",
    sourceRegistryFingerprint: "strict-source-registry-v1",
    backend: new FileAdapterFamilyDiscoveryCheckpointBackend({
      path: join(directory, "checkpoint.json"),
      lockRetryMs: 1,
      lockAttempts: 500,
    }),
    verifyCanonicalCheckpoint() {},
    assertGenerationCurrent() {},
  });
  const empty = await store.loadForRestart();
  if (empty.status !== "empty") {
    throw new Error("fixture checkpoint store did not start empty");
  }
  const inventoryFamilies = Object.freeze([
    ...emptyCheckpointInventoryFamilies(
      catalog.listAll().filter((family) => "discovery" in family.plugin)
        .map((family) => family.plugin.manifest.familyId),
    ).filter((family) =>
      family.familyId !== WSTETH_FAMILY_ID &&
      family.familyId !== UNIV2_FAMILY_ID
    ),
    ...fixtureInventory(SOURCE),
  ]);
  const staged = store.takeCandidateIssuer().prepare({
    source: SOURCE,
    watermarks: watermarks(SOURCE),
    inventoryFamilies,
  });
  if (!(await store.compareAndCommit({ expected: null, staged }))) {
    throw new Error("fixture checkpoint commit failed");
  }
  const enumerator = new CheckpointDiscoveryInventoryEnumerator({
    checkpointStore: store,
  });
  const enumeration = await enumerator.enumerate(SOURCE);
  const covered = enumeration.families.filter((family) =>
    family.familyId === WSTETH_FAMILY_ID ||
    family.familyId === UNIV2_FAMILY_ID
  );
  if (covered.length !== 2) {
    throw new Error(
      `fixture enumerator restored ${covered.length} expected Families`,
    );
  }
  for (const family of covered) {
    if (family.inventoryCount !== 1) {
      throw new Error(
        `fixture enumerator restored wrong inventory for ${family.familyId}`,
      );
    }
  }
  console.log(JSON.stringify({
    format: "s1-node-enumerator-dry-run-v1",
    status: "pass",
    source: SOURCE,
    catalogHash: catalog.catalogHash,
    inventoryFamilies: covered.map((family) => Object.freeze({
      familyId: family.familyId,
      inventoryCount: family.inventoryCount,
      inventoryHash: family.inventoryHash,
    })),
    familyCount: enumeration.families.length,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
