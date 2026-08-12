import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterFamilyDiscoveryCheckpointStore,
  FileAdapterFamilyDiscoveryCheckpointBackend,
  emptyCheckpointInventoryFamilies,
  type AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily,
} from "../adapter-family-discovery-checkpoint.js";
import {
  CheckpointDiscoveryInventoryEnumerator,
} from "../adapter-family-discovery-inventory-enumerator.js";
import {
  enumeratePointInTimeInventory,
  type AdapterFamilySnapshotInventoryObservation,
} from "../adapter-family-snapshot-inventory-closure.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const EVENT_SOURCE_IDS: ReadonlySet<string> = new Set([
  "factory-log",
  "landed-log",
  "observed-call",
]);
const discoveryFamilyIds = Object.freeze(
  catalog.listAll().filter((family) => "discovery" in family.plugin)
    .map((family) => family.plugin.manifest.familyId),
);

function surface(canonical: CanonicalSource): AdapterFamilySnapshotInventoryObservation {
  return Object.freeze({
    kind: "address-surface",
    source: canonical,
    address: WSTETH,
    codeHash: `0x${"1".repeat(64)}`,
    implementationWord: `0x${"0".repeat(64)}`,
    interfaceFingerprints: Object.freeze(["wsteth-conversion-surface-v1"]),
  });
}

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

function populatedInventory(
  canonical: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[] {
  return Object.freeze([
    ...emptyCheckpointInventoryFamilies(discoveryFamilyIds)
      .filter((family) => family.familyId !== WSTETH_FAMILY_ID),
    Object.freeze({
      familyId: WSTETH_FAMILY_ID,
      incumbents: Object.freeze([Object.freeze({
        inventoryKey: "legacy:wsteth",
        address: WSTETH,
        currentSurface: surface(canonical),
      })]),
    }),
  ]);
}

async function checkpointStore(path: string) {
  const store = new AdapterFamilyDiscoveryCheckpointStore({
    catalog,
    chainId: "1",
    sourceRegistryFingerprint: "strict-source-registry-v1",
    backend: new FileAdapterFamilyDiscoveryCheckpointBackend({
      path,
      lockRetryMs: 1,
      lockAttempts: 500,
    }),
    verifyCanonicalCheckpoint() {},
    assertGenerationCurrent() {},
  });
  await store.loadForRestart();
  return store;
}

async function main(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "adapter-family-inventory-enumerator-"),
  );
  try {
    const emptyStore = await checkpointStore(join(directory, "empty.json"));
    const emptyEnumerator = new CheckpointDiscoveryInventoryEnumerator({
      checkpointStore: emptyStore,
    });
    await assert.rejects(
      () => emptyEnumerator.enumerate(SOURCE),
      /no trusted receipt/,
      "an empty store cannot restore incumbent inventory",
    );

    const emptyRows = emptyCheckpointInventoryFamilies(discoveryFamilyIds);
    const emptyCandidate = emptyStore.takeCandidateIssuer().prepare({
      source: SOURCE,
      watermarks: watermarks(SOURCE),
      inventoryFamilies: emptyRows,
    });
    assert.equal(await emptyStore.compareAndCommit({
      expected: null,
      staged: emptyCandidate,
    }), true);
    const emptyEnumeration = await emptyEnumerator.enumerate(SOURCE);
    assert.deepEqual(
      emptyEnumeration,
      enumeratePointInTimeInventory({ source: SOURCE, families: emptyRows }),
    );
    assert.equal(emptyEnumeration.families.length, discoveryFamilyIds.length);

    const populatedStore = await checkpointStore(join(directory, "populated.json"));
    const populatedRows = populatedInventory(SOURCE);
    const populatedCandidate = populatedStore.takeCandidateIssuer().prepare({
      source: SOURCE,
      watermarks: watermarks(SOURCE),
      inventoryFamilies: populatedRows,
    });
    assert.equal(await populatedStore.compareAndCommit({
      expected: null,
      staged: populatedCandidate,
    }), true);
    const populatedEnumerator = new CheckpointDiscoveryInventoryEnumerator({
      checkpointStore: populatedStore,
    });
    const populatedEnumeration = await populatedEnumerator.enumerate(SOURCE);
    assert.deepEqual(
      populatedEnumeration,
      enumeratePointInTimeInventory({ source: SOURCE, families: populatedRows }),
    );
    const wstethRow = populatedEnumeration.families.find(
      (family) => family.familyId === WSTETH_FAMILY_ID,
    )!;
    assert.equal(wstethRow.inventoryCount, 1);
    assert.deepEqual(wstethRow.inventoryKeys, ["legacy:wsteth"]);

    const reloadedStore = await checkpointStore(join(directory, "populated.json"));
    const reloadedEnumerator = new CheckpointDiscoveryInventoryEnumerator({
      checkpointStore: reloadedStore,
    });
    assert.deepEqual(
      await reloadedEnumerator.enumerate(SOURCE),
      populatedEnumeration,
      "inventory restores byte-stably from the durable checkpoint",
    );

    await assert.rejects(
      () => reloadedEnumerator.enumerate(Object.freeze({
        ...SOURCE,
        number: SOURCE.number + 1,
      })),
      /source mismatch/,
    );

    const appendOnlyStore = await checkpointStore(
      join(directory, "populated.json"),
    );
    const appendOnlyEnumerator = new CheckpointDiscoveryInventoryEnumerator({
      checkpointStore: appendOnlyStore,
    });
    await appendOnlyStore.loadForRestart();
    const tampered = JSON.parse(
      await readFile(join(directory, "populated.json"), "utf8"),
    ) as { sourceRegistryFingerprint: string };
    tampered.sourceRegistryFingerprint = "tampered-registry";
    await writeFile(
      join(directory, "populated.json"),
      `${JSON.stringify(tampered, null, 2)}\n`,
    );
    const degradedLoad = await appendOnlyStore.loadForRestart();
    assert.equal(degradedLoad.status, "degraded-append-only");
    await assert.rejects(
      () => appendOnlyEnumerator.enumerate(SOURCE),
      /no trusted receipt|append-only restart/,
    );

    console.log("adapter-family-discovery-inventory-enumerator PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
