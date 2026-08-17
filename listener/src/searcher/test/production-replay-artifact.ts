import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";
import { poolProjectionRowKey } from "../pool-universe.js";
import type { PoolEntry, VerifiedRouteSpec } from "../planner/token-graph.js";
import { STRICT_PROJECTED_FAMILY_TEST_REGISTRY } from "./strict-family-test-compat.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG } from
  "../venues/production-family-composition.js";
import type { FamilySourceCoverage } from "../../shared/evidence/canonical-edge-set.js";

export const PRODUCTION_REPLAY_ARTIFACT_SCHEMA = 4 as const;
export const PRODUCTION_REPLAY_ARTIFACT_PRODUCER = "shared-protocol-discovery-v4" as const;

export interface ProductionReplayUniverseEvidence {
  readonly sha256: string;
  readonly schemaVersion: number | null;
  readonly generatedAt: string | null;
  readonly fromBlock: number | null;
  readonly toBlock: number | null;
  readonly rawPoolCount: number;
  readonly selectedPoolCount: number;
  readonly maxPools: number;
  readonly minScore: number;
}

export interface ProductionReplayDiscoveryArtifact {
  readonly schemaVersion: typeof PRODUCTION_REPLAY_ARTIFACT_SCHEMA;
  readonly producer: typeof PRODUCTION_REPLAY_ARTIFACT_PRODUCER;
  readonly sourceFromBlock: number;
  readonly sourceToBlock: number;
  readonly identityBlock: number;
  readonly sourceUniverse: ProductionReplayUniverseEvidence;
  /** Compatibility summaries only; never interpreted as all-family proof. */
  readonly sourceComplete: boolean;
  readonly evaluationComplete: boolean;
  readonly familySourceCoverage: readonly FamilySourceCoverage[];
  readonly discoveredPoolKeys: readonly string[];
  /** Exact discovered subset; static/legacy pools stay in the ordinary universe. */
  readonly pools: readonly PoolEntry[];
}

export interface LoadedProductionReplayDiscoveryArtifact {
  readonly sourceComplete: boolean;
  readonly evaluationComplete: boolean;
  readonly familySourceCoverage:
    ProductionReplayDiscoveryArtifact["familySourceCoverage"];
  readonly pools: readonly PoolEntry[];
}

export function writeProductionReplayDiscoveryArtifact(
  path: string,
  artifact: ProductionReplayDiscoveryArtifact,
): string {
  if (
    artifact.schemaVersion !== PRODUCTION_REPLAY_ARTIFACT_SCHEMA ||
    artifact.producer !== PRODUCTION_REPLAY_ARTIFACT_PRODUCER ||
    typeof artifact.sourceComplete !== "boolean" ||
    typeof artifact.evaluationComplete !== "boolean" ||
    artifact.sourceFromBlock > artifact.sourceToBlock ||
    artifact.sourceToBlock > artifact.identityBlock ||
    artifact.pools.length !== artifact.discoveredPoolKeys.length
  ) {
    throw new Error("production replay discovery artifact is incomplete or unsupported");
  }
  parseFamilySourceCoverage(artifact.familySourceCoverage);
  selectProductionReplayDiscoveredPools(
    artifact.pools,
    artifact.discoveredPoolKeys,
  );
  assertDiscoveredPoolCoverage(
    artifact.pools,
    artifact.familySourceCoverage,
  );
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  writeFileSync(path, bytes, { encoding: "utf8", mode: 0o600 });
  return sha256(bytes);
}

/**
 * Load the wrapper-owned discovery snapshot without teaching the ordinary
 * pool-universe loader to trust externally supplied verifiedRoutes.
 */
export function loadProductionReplayDiscoveredPools(
  path: string,
  expectedSha256: string,
): PoolEntry[] {
  return [...loadProductionReplayDiscoveryArtifact(
    path,
    expectedSha256,
  ).pools];
}

export function loadProductionReplayDiscoveryArtifact(
  path: string,
  expectedSha256: string,
): LoadedProductionReplayDiscoveryArtifact {
  const bytes = readFileSync(path, "utf8");
  if (!/^[0-9a-f]{64}$/.test(expectedSha256) || sha256(bytes) !== expectedSha256) {
    throw new Error("production replay discovery artifact hash mismatch");
  }
  const raw = JSON.parse(bytes) as unknown;
  if (!isRecord(raw)) throw new Error("production replay discovery artifact must be an object");
  if (
    raw.schemaVersion !== PRODUCTION_REPLAY_ARTIFACT_SCHEMA ||
    raw.producer !== PRODUCTION_REPLAY_ARTIFACT_PRODUCER ||
    typeof raw.sourceComplete !== "boolean" ||
    typeof raw.evaluationComplete !== "boolean"
  ) {
    throw new Error("production replay discovery artifact is incomplete or unsupported");
  }
  const sourceFromBlock = safeBlock(raw.sourceFromBlock, "sourceFromBlock");
  const sourceToBlock = safeBlock(raw.sourceToBlock, "sourceToBlock");
  const identityBlock = safeBlock(raw.identityBlock, "identityBlock");
  if (sourceFromBlock > sourceToBlock || sourceToBlock > identityBlock) {
    throw new Error("production replay discovery artifact has an invalid block range");
  }
  if (!Array.isArray(raw.pools) || !Array.isArray(raw.discoveredPoolKeys)) {
    throw new Error("production replay discovery artifact omits pools or discoveredPoolKeys");
  }
  const familySourceCoverage = parseFamilySourceCoverage(
    raw.familySourceCoverage,
  );
  const sourceUniverse = parseUniverseEvidence(raw.sourceUniverse);
  const expectedUniverseSha256 = process.env.PRODUCTION_REPLAY_UNIVERSE_SHA256;
  if (
    !expectedUniverseSha256 ||
    !/^[0-9a-f]{64}$/.test(expectedUniverseSha256) ||
    sourceUniverse.sha256 !== expectedUniverseSha256
  ) {
    throw new Error("production replay source universe hash is absent or mismatched");
  }
  if (sourceUniverse.toBlock !== null && sourceUniverse.toBlock !== sourceToBlock) {
    throw new Error("production replay source universe does not end at the discovery source block");
  }

  const keys = raw.discoveredPoolKeys.map((value, index) => {
    if (typeof value !== "string" || !value) {
      throw new Error(`discoveredPoolKeys[${index}] must be a non-empty string`);
    }
    return value;
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error("production replay discovery artifact repeats a discovered pool key");
  }
  if (raw.pools.length !== keys.length) {
    throw new Error("production replay artifact pools must exactly match discoveredPoolKeys");
  }
  const pools = raw.pools.map((item, index) => parseProjectedPool(item, index));
  assertDiscoveredPoolCoverage(pools, familySourceCoverage);
  return Object.freeze({
    sourceComplete: raw.sourceComplete,
    evaluationComplete: raw.evaluationComplete,
    familySourceCoverage,
    pools: Object.freeze(selectProductionReplayDiscoveredPools(pools, keys)),
  });
}

export function selectProductionReplayDiscoveredPools(
  projectedPools: readonly PoolEntry[],
  discoveredPoolKeys: readonly string[],
): PoolEntry[] {
  if (new Set(discoveredPoolKeys).size !== discoveredPoolKeys.length) {
    throw new Error("production replay discovery repeats a discovered pool key");
  }
  const poolByKey = new Map<string, PoolEntry>();
  for (const pool of projectedPools) {
    const key = poolProjectionRowKey(pool);
    if (poolByKey.has(key)) throw new Error(`duplicate projected pool key ${key}`);
    poolByKey.set(key, pool);
  }
  return discoveredPoolKeys.map((key) => {
    const pool = poolByKey.get(key);
    if (!pool) throw new Error(`discovered pool key ${key} is absent from projected pools`);
    if (!pool.verifiedRoutes || pool.verifiedRoutes.length === 0) {
      throw new Error(`discovered pool ${key} has no probe-verified route`);
    }
    const family = STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().findForPool(pool.adapter);
    // F8: dynamic ownership is projected from the strict catalog's
    // plugin-declared candidate sources; the legacy discovery object is gone.
    const dynamicallyOwned = family !== null && (
      family.kind === "credit" ||
      PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG
        .discoverableFamilySources()
        .some((entry) => entry.familyId === family.id)
    );
    if (!dynamicallyOwned) {
      throw new Error(`discovered pool ${key} is not owned by a dynamic route family`);
    }
    if (
      !pool.discoveryOwnerAdapterId ||
      pool.discoveryOwnerAdapterId !== family.id
    ) {
      throw new Error(
        `discovered pool ${key} has a missing or mismatched projection owner`,
      );
    }
    return pool;
  });
}

function parseUniverseEvidence(raw: unknown): ProductionReplayUniverseEvidence {
  if (!isRecord(raw)) throw new Error("sourceUniverse must be an object");
  const sha = stringField(raw.sha256, "sourceUniverse.sha256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error("sourceUniverse.sha256 must be SHA-256");
  const schemaVersion = nullableBlock(raw.schemaVersion, "sourceUniverse.schemaVersion");
  const generatedAt = nullableString(raw.generatedAt, "sourceUniverse.generatedAt");
  const fromBlock = nullableBlock(raw.fromBlock, "sourceUniverse.fromBlock");
  const toBlock = nullableBlock(raw.toBlock, "sourceUniverse.toBlock");
  if (fromBlock !== null && toBlock !== null && fromBlock > toBlock) {
    throw new Error("sourceUniverse block range is invalid");
  }
  const rawPoolCount = safeBlock(raw.rawPoolCount, "sourceUniverse.rawPoolCount");
  const selectedPoolCount = safeBlock(raw.selectedPoolCount, "sourceUniverse.selectedPoolCount");
  const maxPools = safeBlock(raw.maxPools, "sourceUniverse.maxPools");
  const minScore = finiteNumber(raw.minScore, "sourceUniverse.minScore");
  if (selectedPoolCount > rawPoolCount) {
    throw new Error("sourceUniverse selectedPoolCount exceeds rawPoolCount");
  }
  return {
    sha256: sha,
    schemaVersion,
    generatedAt,
    fromBlock,
    toBlock,
    rawPoolCount,
    selectedPoolCount,
    maxPools,
    minScore,
  };
}

function parseFamilySourceCoverage(raw: unknown): ProductionReplayDiscoveryArtifact[
  "familySourceCoverage"
] {
  if (!Array.isArray(raw)) {
    throw new Error("production replay discovery artifact omits familySourceCoverage");
  }
  const keys = new Set<string>();
  const parsed = raw.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`familySourceCoverage[${index}] must be an object`);
    }
    if (typeof item.complete !== "boolean" || !Array.isArray(item.issues)) {
      throw new Error(
        `familySourceCoverage[${index}] has invalid complete/issues`,
      );
    }
    const parsedItem = Object.freeze({
      familyId: stringField(
        item.familyId,
        `familySourceCoverage[${index}].familyId`,
      ),
      sourceId: stringField(
        item.sourceId,
        `familySourceCoverage[${index}].sourceId`,
      ),
      complete: item.complete,
      issues: Object.freeze(item.issues.map((issue, issueIndex) =>
        stringField(
          issue,
          `familySourceCoverage[${index}].issues[${issueIndex}]`,
        ))),
    });
    if (parsedItem.complete && parsedItem.issues.length > 0) {
      throw new Error("complete production replay family source has issues");
    }
    const key = `${parsedItem.familyId}\u001f${parsedItem.sourceId}`;
    if (keys.has(key)) {
      throw new Error(`duplicate production replay family source ${key}`);
    }
    keys.add(key);
    return parsedItem;
  });
  return Object.freeze(parsed);
}

function assertDiscoveredPoolCoverage(
  pools: readonly PoolEntry[],
  coverage: ProductionReplayDiscoveryArtifact["familySourceCoverage"],
): void {
  const familyIds = new Set(coverage.map((item) => item.familyId));
  for (const pool of pools) {
    if (
      !pool.discoveryOwnerAdapterId ||
      !familyIds.has(pool.discoveryOwnerAdapterId)
    ) {
      throw new Error(
        `discovered pool ${poolProjectionRowKey(pool)} has no family source coverage`,
      );
    }
  }
}

function parseProjectedPool(raw: unknown, index: number): PoolEntry {
  if (!isRecord(raw)) throw new Error(`pools[${index}] must be an object`);
  const adapter = stringField(raw.adapter, `pools[${index}].adapter`) as PoolEntry["adapter"];
  STRICT_PROJECTED_FAMILY_TEST_REGISTRY.routes().forPool(adapter);
  const pool: PoolEntry = {
    address: addressField(raw.address, `pools[${index}].address`),
    adapter,
  };
  copyOptionalAddress(raw, pool, "receiptEmitters", index);
  for (const field of [
    "factory", "token0", "token1", "currency0", "currency1", "hooks",
    "fixedTokenIn", "fixedTokenOut", "redeemTokenOut",
  ] as const) {
    const value = raw[field];
    if (value !== undefined) pool[field] = addressField(value, `pools[${index}].${field}`) as never;
  }
  if (raw.underlyingCoins !== undefined) {
    if (!Array.isArray(raw.underlyingCoins)) throw new Error(`pools[${index}].underlyingCoins must be an array`);
    pool.underlyingCoins = raw.underlyingCoins.map((value, coinIndex) =>
      addressField(value, `pools[${index}].underlyingCoins[${coinIndex}]`));
  }
  if (raw.venueId !== undefined) pool.venueId = stringField(raw.venueId, `pools[${index}].venueId`) as PoolEntry["venueId"];
  if (raw.identitySource !== undefined) pool.identitySource = stringField(raw.identitySource, `pools[${index}].identitySource`) as PoolEntry["identitySource"];
  if (raw.poolId !== undefined) pool.poolId = stringField(raw.poolId, `pools[${index}].poolId`);
  if (raw.fixedSlotKind !== undefined) pool.fixedSlotKind = stringField(raw.fixedSlotKind, `pools[${index}].fixedSlotKind`) as PoolEntry["fixedSlotKind"];
  if (raw.fixedProtocolAction !== undefined) pool.fixedProtocolAction = stringField(raw.fixedProtocolAction, `pools[${index}].fixedProtocolAction`) as PoolEntry["fixedProtocolAction"];
  if (raw.logicalInstanceId !== undefined) pool.logicalInstanceId = stringField(raw.logicalInstanceId, `pools[${index}].logicalInstanceId`);
  if (raw.discoveryOwnerAdapterId !== undefined) {
    pool.discoveryOwnerAdapterId = stringField(
      raw.discoveryOwnerAdapterId,
      `pools[${index}].discoveryOwnerAdapterId`,
    );
  }
  for (const field of ["fee", "tickSpacing", "score"] as const) {
    if (raw[field] !== undefined) pool[field] = finiteNumber(raw[field], `pools[${index}].${field}`);
  }
  if (raw.nonStandardRedeem !== undefined) {
    if (typeof raw.nonStandardRedeem !== "boolean") throw new Error(`pools[${index}].nonStandardRedeem must be boolean`);
    pool.nonStandardRedeem = raw.nonStandardRedeem;
  }
  if (raw.verifiedRoutes !== undefined) {
    if (!Array.isArray(raw.verifiedRoutes) || raw.verifiedRoutes.length === 0) {
      throw new Error(`pools[${index}].verifiedRoutes must be a non-empty array`);
    }
    pool.verifiedRoutes = raw.verifiedRoutes.map((route, routeIndex) =>
      parseVerifiedRoute(route, `pools[${index}].verifiedRoutes[${routeIndex}]`));
  }
  return pool;
}

function parseVerifiedRoute(raw: unknown, field: string): VerifiedRouteSpec {
  if (!isRecord(raw)) throw new Error(`${field} must be an object`);
  const slotKind = stringField(raw.slotKind, `${field}.slotKind`);
  if (slotKind !== "swap" && slotKind !== "protocol" && slotKind !== "lend") {
    throw new Error(`${field}.slotKind is invalid`);
  }
  const parsed: VerifiedRouteSpec = {
    edgeAdapterId: stringField(raw.edgeAdapterId, `${field}.edgeAdapterId`),
    tokenIn: addressField(raw.tokenIn, `${field}.tokenIn`),
    tokenOut: addressField(raw.tokenOut, `${field}.tokenOut`),
    slotKind,
    ...(raw.protocolAction === undefined
      ? {}
      : { protocolAction: stringField(raw.protocolAction, `${field}.protocolAction`) as VerifiedRouteSpec["protocolAction"] }),
  };
  if (raw.poolToken0 !== undefined) {
    parsed.poolToken0 = addressField(raw.poolToken0, `${field}.poolToken0`);
  }
  if (raw.poolToken1 !== undefined) {
    parsed.poolToken1 = addressField(raw.poolToken1, `${field}.poolToken1`);
  }
  return parsed;
}

function copyOptionalAddress(
  raw: Record<string, unknown>,
  pool: PoolEntry,
  field: "receiptEmitters",
  index: number,
): void {
  const value = raw[field];
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`pools[${index}].${field} must be an array`);
  pool[field] = value.map((item, itemIndex) =>
    addressField(item, `pools[${index}].${field}[${itemIndex}]`));
}

function safeBlock(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be finite`);
  return value;
}

function nullableBlock(value: unknown, field: string): number | null {
  if (value === null) return null;
  return safeBlock(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return stringField(value, field);
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function addressField(value: unknown, field: string): string {
  try {
    return ethers.getAddress(stringField(value, field));
  } catch {
    throw new Error(`${field} must be an address`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
