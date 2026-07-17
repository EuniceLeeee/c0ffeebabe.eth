import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

export type V2LineageVenueId =
  | "univ2"
  | "sushiswap-v2"
  | "pancake-v2"
  | "rigelswap"
  | "difx"
  | `v2-factory:${string}`;

export interface V2MeasuredFeeRule {
  readonly kind: "constant-bps";
  readonly feeBps: bigint;
  readonly evidence: string;
}

export interface V2LineageDescriptor {
  readonly venue: V2LineageVenueId;
  readonly factory: string;
  readonly executionFamily: "univ2-standard";
  readonly runtimeAdapter: "univ2";
  readonly discoverable: boolean;
  readonly quotable: boolean;
  readonly buildable: boolean;
  /** Absent means the factory is not fee-verified and retains the legacy fallback. */
  readonly measuredFeeRule: V2MeasuredFeeRule | null;
}

/** Immutable bootstrap trust; generated snapshots may not redefine these rows. */
export const TRUSTED_V2_LINEAGES: readonly V2LineageDescriptor[] = Object.freeze([
  trustedLineage(
    "univ2",
    "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    30n,
    "canonical UniV2 997/1000 invariant",
  ),
  trustedLineage(
    "sushiswap-v2",
    "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
    30n,
    "canonical SushiV2 997/1000 invariant",
  ),
  trustedLineage(
    "pancake-v2",
    "0x1097053fd2ea711dad45caccc45eff7548fcb362",
    25n,
    "fork-swap verified 2026-07-14 on pair 0x17C1Ae82D99379240059940093762c5e4539aba5",
  ),
]);

export const V2_LINEAGE_SNAPSHOT_SCHEMA_VERSION = 1;

export interface V2LineageSnapshotRecord {
  readonly venue: V2LineageVenueId;
  readonly factory: string;
  readonly executionFamily: "univ2-standard";
  readonly runtimeAdapter: "univ2";
  readonly discoverable: boolean;
  readonly quotable: boolean;
  readonly buildable: boolean;
  readonly measuredFeeRule: {
    readonly kind: "constant-bps";
    readonly feeBps: number;
    readonly evidence: string;
  } | null;
}

export interface V2LineageSnapshot {
  readonly schemaVersion: typeof V2_LINEAGE_SNAPSHOT_SCHEMA_VERSION;
  readonly chainId: 1;
  readonly generatedAt: string;
  readonly toBlock: number;
  readonly lineages: readonly V2LineageSnapshotRecord[];
}

export const DEFAULT_V2_LINEAGES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../searcher/pools/v2-lineages.json",
);

/**
 * Production deploys pin SEARCHER_V2_LINEAGES_PATH to one generated snapshot.
 * Local tests retain the investigated baseline when no snapshot is supplied.
 */
export const V2_LINEAGES: readonly V2LineageDescriptor[] = loadV2Lineages(
  process.env.SEARCHER_V2_LINEAGES_PATH,
);

export function loadV2Lineages(path: string | undefined): readonly V2LineageDescriptor[] {
  const absolute = resolve(path || DEFAULT_V2_LINEAGES_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, "utf8"));
  } catch (error) {
    throw new Error(
      `could not load V2 lineage snapshot ${absolute}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Object.freeze([
    ...TRUSTED_V2_LINEAGES,
    ...parseV2LineageSnapshot(parsed, absolute),
  ]);
}

export function parseV2LineageSnapshot(
  value: unknown,
  source = "V2 lineage snapshot",
): readonly V2LineageDescriptor[] {
  if (!isRecord(value)) throw new Error(`${source} must be an object`);
  if (value.schemaVersion !== V2_LINEAGE_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`${source} schemaVersion must be ${V2_LINEAGE_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (value.chainId !== 1) throw new Error(`${source} chainId must be 1`);
  if (!Number.isSafeInteger(value.toBlock) || Number(value.toBlock) < 0) {
    throw new Error(`${source}.toBlock must be a non-negative integer`);
  }
  if (!Array.isArray(value.lineages) || value.lineages.length === 0) {
    throw new Error(`${source}.lineages must be a non-empty array`);
  }

  const factories = new Set<string>();
  const descriptors = value.lineages.map((raw, index): V2LineageDescriptor => {
    const field = `${source}.lineages[${index}]`;
    if (!isRecord(raw)) throw new Error(`${field} must be an object`);
    const factory = addressField(raw.factory, `${field}.factory`);
    const key = factory.toLowerCase();
    if (isTrustedVenue(raw.venue) || isTrustedFactory(key)) {
      throw new Error(`${field} may not redefine an immutable trusted V2 lineage`);
    }
    if (!isV2VenueId(raw.venue, key)) {
      throw new Error(`${field}.venue must be a known label or v2-factory:${key}`);
    }
    if (factories.has(key)) throw new Error(`${source} contains duplicate factory ${factory}`);
    factories.add(key);
    if (raw.executionFamily !== "univ2-standard" || raw.runtimeAdapter !== "univ2") {
      throw new Error(`${field} must use the univ2-standard/univ2 execution family`);
    }
    const measuredFeeRule = parseMeasuredFeeRule(raw.measuredFeeRule, `${field}.measuredFeeRule`);
    const discoverable = booleanField(raw.discoverable, `${field}.discoverable`);
    const quotable = booleanField(raw.quotable, `${field}.quotable`);
    const buildable = booleanField(raw.buildable, `${field}.buildable`);
    if (discoverable && measuredFeeRule === null) {
      throw new Error(`${field} cannot be discoverable without a measured fee rule`);
    }
    return Object.freeze({
      venue: raw.venue as V2LineageVenueId,
      factory,
      executionFamily: "univ2-standard",
      runtimeAdapter: "univ2",
      discoverable,
      quotable,
      buildable,
      measuredFeeRule,
    });
  });
  return Object.freeze(descriptors);
}

export function findV2LineageByFactory(
  factory: string | null | undefined,
): V2LineageDescriptor | null {
  if (!factory) return null;
  const normalized = factory.toLowerCase();
  return V2_LINEAGES.find((descriptor) =>
    descriptor.factory.toLowerCase() === normalized
  ) ?? null;
}

function parseMeasuredFeeRule(value: unknown, field: string): V2MeasuredFeeRule | null {
  if (value === null) return null;
  if (!isRecord(value) || value.kind !== "constant-bps") {
    throw new Error(`${field} must be null or a constant-bps rule`);
  }
  if (!Number.isSafeInteger(value.feeBps) || Number(value.feeBps) < 0 || Number(value.feeBps) >= 10_000) {
    throw new Error(`${field}.feeBps must be an integer in [0, 10000)`);
  }
  if (typeof value.evidence !== "string" || value.evidence.length === 0) {
    throw new Error(`${field}.evidence must be a non-empty string`);
  }
  return Object.freeze({
    kind: "constant-bps",
    feeBps: BigInt(Number(value.feeBps)),
    evidence: value.evidence,
  });
}

function addressField(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be an address string`);
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`${field} must be a valid address`);
  }
}

function booleanField(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be boolean`);
  return value;
}

function isV2VenueId(value: unknown, factoryKey: string): value is V2LineageVenueId {
  return value === "univ2" ||
    value === "sushiswap-v2" ||
    value === "pancake-v2" ||
    value === "rigelswap" ||
    value === "difx" ||
    value === `v2-factory:${factoryKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trustedLineage(
  venue: "univ2" | "sushiswap-v2" | "pancake-v2",
  factory: string,
  feeBps: bigint,
  evidence: string,
): V2LineageDescriptor {
  return Object.freeze({
    venue,
    factory: ethers.getAddress(factory),
    executionFamily: "univ2-standard",
    runtimeAdapter: "univ2",
    discoverable: true,
    quotable: true,
    buildable: true,
    measuredFeeRule: Object.freeze({ kind: "constant-bps", feeBps, evidence }),
  });
}

function isTrustedVenue(value: unknown): boolean {
  return TRUSTED_V2_LINEAGES.some((item) => item.venue === value);
}

function isTrustedFactory(factoryKey: string): boolean {
  return TRUSTED_V2_LINEAGES.some((item) => item.factory.toLowerCase() === factoryKey);
}
