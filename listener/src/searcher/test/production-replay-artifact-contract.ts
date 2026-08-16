import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { PoolEntry } from "../planner/token-graph.js";
import {
  poolProjectionRowKey,
  poolRegistryKey,
} from "../pool-universe.js";
import { enabledDiscoveryAdapters } from "../protocol-discovery-runtime.js";
import { PRODUCTION_ADAPTER_FAMILIES } from "../venues/production-registry.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "../venues/production-family-composition.js";
import {
  loadProductionReplayDiscoveredPools,
  PRODUCTION_REPLAY_ARTIFACT_PRODUCER,
  PRODUCTION_REPLAY_ARTIFACT_SCHEMA,
  selectProductionReplayDiscoveredPools,
  writeProductionReplayDiscoveryArtifact,
} from "./production-replay-artifact.js";

const target = "0x24db6717db1c75b9db6ea47164d8730b63875db7";
const asset = "0xc43c6bfeda065fe2c4c11765bf838789bd0bb5de";
const receipt = "0xd48067f122afc3a58f0f79611f5f1afae0d7f25b";
const logicalInstanceId = `${asset}:${receipt}`;
const discovered: PoolEntry = owned({
  address: target,
  adapter: "eigenpie-deposit-router",
  fixedTokenIn: asset,
  fixedTokenOut: receipt,
  fixedSlotKind: "protocol",
  fixedProtocolAction: "wrap",
  logicalInstanceId,
  verifiedRoutes: [{
    edgeAdapterId: "eigenpie-deposit-asset",
    tokenIn: asset,
    tokenOut: receipt,
    slotKind: "protocol",
    protocolAction: "wrap",
  }],
});
const legacy: PoolEntry = {
  address: "0x667701edda83cc03424ac7e5426aefe342957ea6",
  adapter: "fluid-dex",
  token0: asset,
  token1: receipt,
};
const dynamicSwap: PoolEntry = owned({
  address: "0x667701e51b4d1ca244f17c78f7ab8744b4c99f9b",
  adapter: "fluid-dex",
  token0: asset,
  token1: receipt,
  verifiedRoutes: [{
    edgeAdapterId: "fluid-dex-swap",
    tokenIn: asset,
    tokenOut: receipt,
    slotKind: "swap",
    poolToken0: asset,
    poolToken1: receipt,
  }],
});
const dynamicCredit: PoolEntry = owned({
  address: "0xee327311d8640156e87ec33ea55fcbf2309e0ce6",
  adapter: "fluid-vault",
  fixedTokenIn: asset,
  fixedTokenOut: receipt,
  fixedSlotKind: "lend",
  verifiedRoutes: [{
    edgeAdapterId: "fluid-vault",
    tokenIn: asset,
    tokenOut: receipt,
    slotKind: "lend",
  }],
});
const staticDexUniversePool: PoolEntry = {
  address: "0x1111111111111111111111111111111111111111",
  adapter: "univ2",
  token0: asset,
  token1: receipt,
  verifiedRoutes: [{
    edgeAdapterId: "univ2-swap",
    tokenIn: asset,
    tokenOut: receipt,
    slotKind: "swap",
  }],
};
const coLocatedStandardVault = owned({
  address: target,
  adapter: "erc4626",
  verifiedRoutes: [{
    edgeAdapterId: "erc4626-deposit",
    tokenIn: asset,
    tokenOut: target,
    slotKind: "protocol",
    protocolAction: "wrap",
  }],
});
const coLocatedSiloVault = owned({
  address: target,
  adapter: "erc4626-silo-redeem",
  verifiedRoutes: [{
    edgeAdapterId: "erc4626-redeem-silo",
    tokenIn: target,
    tokenOut: receipt,
    slotKind: "protocol",
    protocolAction: "redeem",
  }],
});
const discoveredKey = poolProjectionRowKey(discovered);
const dynamicSwapKey = poolProjectionRowKey(dynamicSwap);
const dynamicCreditKey = poolProjectionRowKey(dynamicCredit);
const standardVaultKey = poolProjectionRowKey(coLocatedStandardVault);
const siloVaultKey = poolProjectionRowKey(coLocatedSiloVault);
assert.equal(
  poolRegistryKey(coLocatedStandardVault),
  poolRegistryKey(coLocatedSiloVault),
  "co-located families must retain one family-neutral physical key",
);
assert.notEqual(
  standardVaultKey,
  siloVaultKey,
  "discovery projection rows must be owner-qualified without fake logical ids",
);
// F8: discovery scope is projected from the strict catalog's plugin-declared
// candidate sources; the legacy discoverableRoutes surface is empty.
const catalogDiscoveryScope = (
  protocolEdgesEnabled: boolean,
): readonly string[] =>
  PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
    .discoverableFamilySources()
    .filter((entry) =>
      !PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .requiresProtocolEdgesFlagFor(entry.familyId) ||
      protocolEdgesEnabled,
    )
    .map((entry) => entry.familyId);
const enabledDiscoveryFamilyIds = new Set(catalogDiscoveryScope(true));
assert(
  enabledDiscoveryFamilyIds.has("fluid-dex"),
  "production replay discovery scope must include dynamic swap families",
);
assert(
  !enabledDiscoveryFamilyIds.has("credit:fluid"),
  "production replay discovery scope must exclude the credit family (independent lifecycle)",
);
const protocolDisabledDiscoveryFamilyIds = new Set(catalogDiscoveryScope(false));
assert(
  [...protocolDisabledDiscoveryFamilyIds].every(
    (familyId) =>
      !PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .requiresProtocolEdgesFlagFor(familyId as never),
  ),
  "disabled protocol edges must exclude every family that requires the flag",
);
assert(
  protocolDisabledDiscoveryFamilyIds.has("fluid-dex") &&
    !protocolDisabledDiscoveryFamilyIds.has("credit:fluid"),
  "disabled protocol edges must retain dynamic families that do not require the flag",
);

const selected = selectProductionReplayDiscoveredPools(
  [legacy, discovered, dynamicSwap, dynamicCredit],
  [discoveredKey, dynamicSwapKey, dynamicCreditKey],
);
assert.deepEqual(
  selected,
  [discovered, dynamicSwap, dynamicCredit],
  "artifact selection must accept every registry-owned dynamic route category",
);
assert.deepEqual(
  selectProductionReplayDiscoveredPools(
    [coLocatedStandardVault, coLocatedSiloVault],
    [standardVaultKey, siloVaultKey],
  ),
  [coLocatedStandardVault, coLocatedSiloVault],
  "artifact selection must retain two verified families at one address",
);
assert.throws(
  () => {
    const mismatched = {
      ...coLocatedStandardVault,
      discoveryOwnerAdapterId:
        coLocatedSiloVault.discoveryOwnerAdapterId,
    };
    selectProductionReplayDiscoveredPools(
      [mismatched],
      [poolProjectionRowKey(mismatched)],
    );
  },
  /missing or mismatched projection owner/,
  "artifact selection must reject an owner/family mismatch",
);
assert.throws(
  () => selectProductionReplayDiscoveredPools(
    [staticDexUniversePool],
    [poolRegistryKey(staticDexUniversePool)],
  ),
  /not owned by a dynamic route family/,
  "verifiedRoutes must not turn a static DEX-universe family into dynamic discovery evidence",
);

const root = mkdtempSync(resolve(tmpdir(), "production-replay-artifact-"));
const path = resolve(root, "artifact.json");
const universeSha256 = "ab".repeat(32);
const previousUniverseSha = process.env.PRODUCTION_REPLAY_UNIVERSE_SHA256;
try {
  process.env.PRODUCTION_REPLAY_UNIVERSE_SHA256 = universeSha256;
  const artifact = {
    schemaVersion: PRODUCTION_REPLAY_ARTIFACT_SCHEMA,
    producer: PRODUCTION_REPLAY_ARTIFACT_PRODUCER,
    sourceFromBlock: 10,
    sourceToBlock: 20,
    identityBlock: 20,
    sourceUniverse: {
      sha256: universeSha256,
      schemaVersion: 2,
      generatedAt: "2026-07-22T00:00:00.000Z",
      fromBlock: 10,
      toBlock: 20,
      rawPoolCount: 2,
      selectedPoolCount: 2,
      maxPools: 20_000,
      minScore: 1,
    },
    sourceComplete: true as const,
    evaluationComplete: true as const,
    familySourceCoverage: [
      "protocol:eigenpie",
      "fluid-dex",
      "credit:fluid",
      "protocol:erc4626",
      "protocol:erc4626-silo-redeem",
      "protocol:rocksolid",
    ].map((familyId) => ({
      familyId,
      sourceId: "fixture-source",
      complete: true,
      issues: [],
    })),
    discoveredPoolKeys: [
      discoveredKey,
      dynamicSwapKey,
      dynamicCreditKey,
      standardVaultKey,
      siloVaultKey,
    ],
    pools: [
      ...selected,
      coLocatedStandardVault,
      coLocatedSiloVault,
    ],
  };
  const sha = writeProductionReplayDiscoveryArtifact(path, artifact);
  const loaded = loadProductionReplayDiscoveredPools(path, sha);
  assert.equal(loaded.length, 5);
  assert.equal(poolProjectionRowKey(loaded[0]), discoveredKey);
  assert.equal(loaded[0].adapter, "eigenpie-deposit-router");
  assert.equal(poolProjectionRowKey(loaded[1]), dynamicSwapKey);
  assert.equal(loaded[1].adapter, "fluid-dex");
  assert.equal(
    loaded[1].verifiedRoutes?.[0].poolToken0?.toLowerCase(),
    asset,
  );
  assert.equal(
    loaded[1].verifiedRoutes?.[0].poolToken1?.toLowerCase(),
    receipt,
  );
  assert.equal(poolProjectionRowKey(loaded[2]), dynamicCreditKey);
  assert.equal(loaded[2].adapter, "fluid-vault");
  assert.equal(poolProjectionRowKey(loaded[3]), standardVaultKey);
  assert.equal(loaded[3].adapter, "erc4626");
  assert.equal(poolProjectionRowKey(loaded[4]), siloVaultKey);
  assert.equal(loaded[4].adapter, "erc4626-silo-redeem");

  const isolatedIncompletePath = resolve(
    root,
    "artifact-isolated-incomplete.json",
  );
  const isolatedIncompleteSha = writeProductionReplayDiscoveryArtifact(
    isolatedIncompletePath,
    {
      ...artifact,
      sourceComplete: false,
      evaluationComplete: false,
      familySourceCoverage: artifact.familySourceCoverage.map((item) =>
        item.familyId === "protocol:rocksolid"
          ? {
              ...item,
              complete: false,
              issues: ["fixture timeout"],
            }
          : item
      ),
    },
  );
  assert.equal(
    loadProductionReplayDiscoveredPools(
      isolatedIncompletePath,
      isolatedIncompleteSha,
    ).length,
    loaded.length,
    "transporting an unrelated incomplete shard must not invent a global-complete requirement",
  );

  const oldSchemaPath = resolve(root, "artifact-v3.json");
  const oldSchemaBytes = `${JSON.stringify({
    ...artifact,
    schemaVersion: 3,
    producer: "shared-protocol-discovery-v3",
  })}\n`;
  writeFileSync(oldSchemaPath, oldSchemaBytes, { mode: 0o600 });
  assert.throws(
    () => loadProductionReplayDiscoveredPools(
      oldSchemaPath,
      createHash("sha256").update(oldSchemaBytes).digest("hex"),
    ),
    /incomplete or unsupported/,
    "schema-v3 artifacts must fail closed after shard-coverage migration",
  );

  assert.throws(
    () => writeProductionReplayDiscoveryArtifact(
      resolve(root, "artifact-with-legacy.json"),
      {
        ...artifact,
        pools: [legacy, discovered],
      },
    ),
    /incomplete or unsupported/,
    "writer must reject a complete strategy view disguised as discovered pools",
  );
  assert.equal(
    sha,
    createHash("sha256").update(readFileSync(path, "utf8")).digest("hex"),
    "writer hash must bind the exact artifact bytes",
  );
} finally {
  if (previousUniverseSha === undefined) delete process.env.PRODUCTION_REPLAY_UNIVERSE_SHA256;
  else process.env.PRODUCTION_REPLAY_UNIVERSE_SHA256 = previousUniverseSha;
  rmSync(root, { recursive: true, force: true });
}

function owned(pool: PoolEntry): PoolEntry {
  const family = PRODUCTION_ADAPTER_FAMILIES.routes().forPool(pool.adapter);
  if (family.kind !== "credit") {
    // F8: dynamic discoverability is projected from the strict catalog's
    // plugin-declared candidate sources, not from a legacy discovery object.
    assert(
      PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .discoverableFamilySources()
        .some((entry) => entry.familyId === family.id),
      `${family.id} must be dynamically discoverable`,
    );
  }
  return {
    ...pool,
    discoveryOwnerAdapterId: family.id,
  };
}

console.log("production-replay-artifact-contract PASS");
