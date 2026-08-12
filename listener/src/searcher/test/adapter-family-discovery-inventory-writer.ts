import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  CheckpointDiscoveryInventoryWriter,
  type DiscoveryCheckpointInventoryWriter,
} from "../adapter-family-discovery-inventory-writer.js";
import type { CanonicalSource } from
  "../venues/adapter-request-program.js";
import {
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG,
} from "../venues/production-family-composition.js";
import { WSTETH_FAMILY_ID } from
  "../venues/protocols/wsteth-family/manifest.js";
import { ASTRA_MULTITOKEN_FAMILY_ID } from
  "../venues/protocols/astra-multitoken-family/manifest.js";
import { ASTRA_MULTITOKEN_CHANGE_SELECTOR } from
  "../venues/protocols/astra-multitoken-family/codec.js";

const SOURCE: CanonicalSource = Object.freeze({
  number: 25_700_444,
  hash: `0x${"51".repeat(32)}`,
  generation: 44,
});
const SOURCE_NEXT: CanonicalSource = Object.freeze({
  number: 25_700_445,
  hash: `0x${"52".repeat(32)}`,
  generation: 45,
});
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const ASTRA_POOL = `0x${"61".repeat(20)}`;
const catalog = PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG;
const EVENT_SOURCE_IDS: ReadonlySet<string> = new Set([
  "factory-log",
  "landed-log",
  "observed-call",
]);

function discoveryFamilyIds() {
  return catalog.listAll().filter((family) => "discovery" in family.plugin)
    .map((family) => family.plugin.manifest.familyId);
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

function inventoryWith(
  canonical: CanonicalSource,
): readonly AdapterFamilyDiscoveryCheckpointInventoryCandidateFamily[] {
  return Object.freeze([
    ...emptyCheckpointInventoryFamilies(discoveryFamilyIds())
      .filter((family) =>
        family.familyId !== WSTETH_FAMILY_ID &&
        family.familyId !== ASTRA_MULTITOKEN_FAMILY_ID
      ),
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
      familyId: ASTRA_MULTITOKEN_FAMILY_ID,
      incumbents: Object.freeze([Object.freeze({
        inventoryKey: ASTRA_POOL.toLowerCase(),
        address: ASTRA_POOL,
        currentSurface: Object.freeze({
          kind: "call" as const,
          source: canonical,
          target: ASTRA_POOL,
          data: ASTRA_MULTITOKEN_CHANGE_SELECTOR,
        }),
      })]),
    }),
  ]);
}

async function harness(path: string): Promise<{
  readonly store: AdapterFamilyDiscoveryCheckpointStore;
  readonly issuer: ReturnType<
    AdapterFamilyDiscoveryCheckpointStore["takeCandidateIssuer"]
  >;
  readonly writer: DiscoveryCheckpointInventoryWriter;
  readonly enumerator: CheckpointDiscoveryInventoryEnumerator;
}> {
  const store = new AdapterFamilyDiscoveryCheckpointStore({
    catalog,
    chainId: "1",
    sourceRegistryFingerprint: "strict-source-registry-v1",
    backend: new FileAdapterFamilyDiscoveryCheckpointBackend({
      path,
      lockRetryMs: 1,
      lockAttempts: 100,
    }),
    verifyCanonicalCheckpoint() {},
    assertGenerationCurrent() {},
  });
  const empty = await store.loadForRestart();
  assert.equal(empty.status, "empty");
  const issuer = store.takeCandidateIssuer();
  const writer = new CheckpointDiscoveryInventoryWriter({
    checkpointStore: store,
    checkpointIssuer: issuer,
  });
  const enumerator = new CheckpointDiscoveryInventoryEnumerator({
    checkpointStore: store,
  });
  return Object.freeze({ store, issuer, writer, enumerator });
}

async function main(): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), "adapter-family-inventory-writer-"),
  );
  try {
    const path = join(directory, "checkpoint.json");
    const h = await harness(path);

    // Empty (already loaded) store: the writer seeds the first revision
    // through the store's first-CAS path (expected null), then advances.
    const seedWrite = await h.writer.write({
      source: SOURCE,
      watermarks: watermarks(SOURCE),
      inventoryFamilies: inventoryWith(SOURCE),
    });
    assert.equal(seedWrite.status, "committed");
    assert(seedWrite.status === "committed");
    assert.equal(seedWrite.revision, 1);
    assert.equal(h.store.checkpointSnapshot(h.store.capture()!)?.revision, 1);

    const write = await h.writer.write({
      source: SOURCE_NEXT,
      watermarks: watermarks(SOURCE_NEXT),
      inventoryFamilies: inventoryWith(SOURCE_NEXT),
    });
    assert.equal(write.status, "committed");
    assert(write.status === "committed");
    assert.equal(write.revision, 2);
    const snapshot = h.store.checkpointSnapshot(h.store.capture()!)!;
    assert.equal(snapshot.source.number, SOURCE_NEXT.number);
    const wstethRow = snapshot.inventoryFamilies.find(
      (family) => family.familyId === WSTETH_FAMILY_ID,
    )!;
    assert.equal(wstethRow.inventoryCount, 1);
    assert.equal(
      wstethRow.incumbents[0]?.currentSurface.source.number,
      SOURCE_NEXT.number,
    );
    const astraRow = snapshot.inventoryFamilies.find(
      (family) => family.familyId === ASTRA_MULTITOKEN_FAMILY_ID,
    )!;
    assert.equal(astraRow.inventoryCount, 1);
    assert.equal(astraRow.incumbents[0]?.address, ASTRA_POOL.toLowerCase());
    assert.equal(astraRow.incumbents[0]?.currentSurface.kind, "call");
    const restored = await h.enumerator.enumerate(SOURCE_NEXT);
    assert.equal(
      restored.families.find((family) => family.familyId === WSTETH_FAMILY_ID)
        ?.inventoryCount,
      1,
    );
    assert.equal(
      restored.families.find(
        (family) => family.familyId === ASTRA_MULTITOKEN_FAMILY_ID,
      )?.inventoryCount,
      1,
    );

    // Non-canonical inventory (missing Family row) must leave the store
    // unchanged.
    const before = h.store.capture();
    const badWrite = await h.writer.write({
      source: Object.freeze({
        ...SOURCE_NEXT,
        number: SOURCE_NEXT.number + 1,
        hash: `0x${"53".repeat(32)}`,
        generation: 46,
      }),
      watermarks: watermarks(Object.freeze({
        ...SOURCE_NEXT,
        number: SOURCE_NEXT.number + 1,
        hash: `0x${"53".repeat(32)}`,
        generation: 46,
      })),
      inventoryFamilies: emptyCheckpointInventoryFamilies(
        discoveryFamilyIds().filter((familyId) => familyId !== WSTETH_FAMILY_ID),
      ),
    });
    assert.equal(badWrite.status, "unresolved");
    assert(badWrite.status === "unresolved");
    assert.match(badWrite.reason, /missing Family rows/);
    assert.equal(h.store.capture(), before);

    // Invalid observed-call surface (non-hex data) must fail closed.
    const badSurfaceSource = Object.freeze({
      ...SOURCE_NEXT,
      number: SOURCE_NEXT.number + 1,
      hash: `0x${"54".repeat(32)}`,
      generation: 47,
    });
    const badSurfaceWrite = await h.writer.write({
      source: badSurfaceSource,
      watermarks: watermarks(badSurfaceSource),
      inventoryFamilies: Object.freeze([
        ...inventoryWith(badSurfaceSource).filter(
          (family) => family.familyId !== ASTRA_MULTITOKEN_FAMILY_ID,
        ),
        Object.freeze({
          familyId: ASTRA_MULTITOKEN_FAMILY_ID,
          incumbents: Object.freeze([Object.freeze({
            inventoryKey: ASTRA_POOL.toLowerCase(),
            address: ASTRA_POOL,
            currentSurface: Object.freeze({
              kind: "call" as const,
              source: badSurfaceSource,
              target: ASTRA_POOL,
              data: "0xzz",
            }),
          })]),
        }),
      ]),
    });
    assert.equal(badSurfaceWrite.status, "unresolved");
    assert(badSurfaceWrite.status === "unresolved");
    assert.match(badSurfaceWrite.reason, /data must be hex/);
    assert.equal(h.store.capture(), before);

    // A non-successor source must also fail closed.
    const staleWrite = await h.writer.write({
      source: SOURCE,
      watermarks: watermarks(SOURCE),
      inventoryFamilies: inventoryWith(SOURCE),
    });
    assert.equal(staleWrite.status, "unresolved");
    assert(staleWrite.status === "unresolved");
    assert.equal(h.store.capture(), before);

    console.log("adapter-family-discovery-inventory-writer PASS");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
