import { createHash } from "node:crypto";
import {
  blindProductionCanonicalJson,
} from "./blind-production-audit.js";

export const BLIND_PRODUCTION_ARTIFACT_PROFILE =
  "adapter-family-production-artifact-v1" as const;
export const BLIND_PRODUCTION_ARTIFACT_SCHEMA_VERSION = 1 as const;

export type BlindProductionArtifactKind =
  | "resolved-config"
  | "production-universe"
  | "active-family-manifest"
  | "base-graph-view"
  | "source-delta";

export interface BlindProductionArtifact<
  Kind extends BlindProductionArtifactKind = BlindProductionArtifactKind,
> {
  readonly schemaVersion: typeof BLIND_PRODUCTION_ARTIFACT_SCHEMA_VERSION;
  readonly profile: typeof BLIND_PRODUCTION_ARTIFACT_PROFILE;
  readonly kind: Kind;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadSha256: string;
}

export interface BlindProductionArtifactReceipt {
  readonly kind: BlindProductionArtifactKind;
  /** SHA-256 of the canonical owner-only artifact file, including its newline. */
  readonly sha256: string;
  /**
   * The trusted production closure sets this only at the point where the
   * represented runtime object crosses its production consumer boundary.
   */
  readonly consumed: true;
}

export interface BlindProductionArtifactReceipts {
  readonly resolvedConfig: BlindProductionArtifactReceipt;
  readonly universe: BlindProductionArtifactReceipt;
  readonly activeFamilyManifest: BlindProductionArtifactReceipt;
  readonly baseGraphView: BlindProductionArtifactReceipt;
  readonly sourceDelta: BlindProductionArtifactReceipt;
}

export interface BlindProductionArtifactDocuments {
  readonly resolvedConfig: BlindProductionArtifact<"resolved-config">;
  readonly universe: BlindProductionArtifact<"production-universe">;
  readonly activeFamilyManifest:
    BlindProductionArtifact<"active-family-manifest">;
  readonly baseGraphView: BlindProductionArtifact<"base-graph-view">;
  readonly sourceDelta: BlindProductionArtifact<"source-delta">;
}

export function createBlindProductionArtifact<
  Kind extends BlindProductionArtifactKind,
>(
  kind: Kind,
  payload: Readonly<Record<string, unknown>>,
): BlindProductionArtifact<Kind> {
  assertArtifactPayload(kind, payload);
  const normalized = deepFreeze(canonicalObject(payload));
  return Object.freeze({
    schemaVersion: BLIND_PRODUCTION_ARTIFACT_SCHEMA_VERSION,
    profile: BLIND_PRODUCTION_ARTIFACT_PROFILE,
    kind,
    payload: normalized,
    payloadSha256: blindProductionArtifactPayloadHash(normalized),
  });
}

export function validateBlindProductionArtifact(
  value: unknown,
  expectedKind?: BlindProductionArtifactKind,
): BlindProductionArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("blind production artifact must be an object");
  }
  const artifact = value as Partial<BlindProductionArtifact>;
  assertExactKeys(
    artifact,
    ["kind", "payload", "payloadSha256", "profile", "schemaVersion"],
    "blind production artifact",
  );
  if (artifact.schemaVersion !== BLIND_PRODUCTION_ARTIFACT_SCHEMA_VERSION) {
    throw new Error("blind production artifact schema mismatch");
  }
  if (artifact.profile !== BLIND_PRODUCTION_ARTIFACT_PROFILE) {
    throw new Error("blind production artifact profile mismatch");
  }
  if (!isArtifactKind(artifact.kind)) {
    throw new Error("blind production artifact kind");
  }
  if (expectedKind && artifact.kind !== expectedKind) {
    throw new Error(
      `blind production artifact kind mismatch expected=${expectedKind} actual=${artifact.kind}`,
    );
  }
  if (
    !artifact.payload ||
    typeof artifact.payload !== "object" ||
    Array.isArray(artifact.payload)
  ) {
    throw new Error("blind production artifact payload");
  }
  assertArtifactPayload(
    artifact.kind,
    artifact.payload as Readonly<Record<string, unknown>>,
  );
  if (
    artifact.payloadSha256 !==
      blindProductionArtifactPayloadHash(artifact.payload)
  ) {
    throw new Error("blind production artifact payload hash mismatch");
  }
  return artifact as BlindProductionArtifact;
}

export function blindProductionArtifactPayloadHash(value: unknown): string {
  return createHash("sha256")
    .update(blindProductionCanonicalJson(value))
    .digest("hex");
}

export function blindProductionArtifactFileContents(
  artifact: BlindProductionArtifact,
): string {
  validateBlindProductionArtifact(artifact);
  return `${blindProductionCanonicalJson(artifact)}\n`;
}

export function blindProductionArtifactFileSha256(
  artifact: BlindProductionArtifact,
): string {
  return createHash("sha256")
    .update(blindProductionArtifactFileContents(artifact))
    .digest("hex");
}

export function blindProductionArtifactReceipt(
  artifact: BlindProductionArtifact,
): BlindProductionArtifactReceipt {
  return Object.freeze({
    kind: artifact.kind,
    sha256: blindProductionArtifactFileSha256(artifact),
    consumed: true,
  });
}

export function validateBlindProductionArtifactReceipt(
  value: BlindProductionArtifactReceipt,
  expectedKind: BlindProductionArtifactKind,
): void {
  assertExactKeys(
    value,
    ["consumed", "kind", "sha256"],
    `blind ${expectedKind} receipt`,
  );
  if (value.kind !== expectedKind) {
    throw new Error(`blind artifact receipt kind mismatch ${expectedKind}`);
  }
  if (value.consumed !== true) {
    throw new Error(`blind artifact ${expectedKind} was not consumed`);
  }
  if (!/^[0-9a-f]{64}$/.test(value.sha256)) {
    throw new Error(`blind artifact ${expectedKind} receipt hash`);
  }
}

export function validateBlindProductionArtifactBinding(
  artifact: BlindProductionArtifact,
  receipt: BlindProductionArtifactReceipt,
  expectedKind: BlindProductionArtifactKind,
): void {
  validateBlindProductionArtifact(artifact, expectedKind);
  validateBlindProductionArtifactReceipt(receipt, expectedKind);
  if (blindProductionArtifactFileSha256(artifact) !== receipt.sha256) {
    throw new Error(`blind artifact ${expectedKind} document/receipt mismatch`);
  }
}

function assertArtifactPayload(
  kind: BlindProductionArtifactKind,
  payload: Readonly<Record<string, unknown>>,
): void {
  switch (kind) {
    case "resolved-config":
      assertExactKeys(payload, [
        "configLoaderFingerprint",
        "effectiveConfig",
        "effectiveConfigSha256",
      ], kind);
      assertHash(payload.effectiveConfigSha256, `${kind} effective config`);
      if (
        payload.effectiveConfigSha256 !==
          blindProductionArtifactPayloadHash(payload.effectiveConfig)
      ) {
        throw new Error(`${kind} effective config hash mismatch`);
      }
      assertNoSecretMaterial(payload.effectiveConfig);
      return;
    case "production-universe":
      assertExactKeys(payload, [
        "builderFingerprint",
        "contentSha256",
        "poolCount",
        "provenanceSha256",
      ], kind);
      assertHash(payload.builderFingerprint, `${kind} builder`);
      assertHash(payload.contentSha256, `${kind} content`);
      assertHash(payload.provenanceSha256, `${kind} provenance`);
      assertNonnegativeInteger(payload.poolCount, `${kind} poolCount`);
      return;
    case "active-family-manifest":
      assertExactKeys(payload, [
        "families",
        "familyCount",
        "registryFingerprint",
      ], kind);
      assertHash(payload.registryFingerprint, `${kind} registry`);
      assertNonnegativeInteger(payload.familyCount, `${kind} familyCount`);
      if (!Array.isArray(payload.families)) {
        throw new Error(`${kind} families`);
      }
      if (payload.families.length !== payload.familyCount) {
        throw new Error(`${kind} family count mismatch`);
      }
      for (const family of payload.families) {
        if (!family || typeof family !== "object" || Array.isArray(family)) {
          throw new Error(`${kind} family entry`);
        }
        const entry = family as Record<string, unknown>;
        assertExactKeys(entry, ["descriptorSha256", "familyId", "kind"], kind);
        assertNonempty(entry.familyId, `${kind} family id`);
        assertNonempty(entry.kind, `${kind} family kind`);
        assertHash(entry.descriptorSha256, `${kind} family descriptor`);
      }
      return;
    case "base-graph-view":
      assertGraphPayload(kind, payload, false);
      return;
    case "source-delta":
      assertGraphPayload(kind, payload, true);
      assertHash(payload.baseGraphViewSha256, `${kind} base graph`);
      assertHash(payload.addedEdgeHash, `${kind} added edges`);
      assertHash(payload.removedEdgeHash, `${kind} removed edges`);
      assertNonnegativeInteger(payload.addedEdgeCount, `${kind} added edges`);
      assertNonnegativeInteger(payload.removedEdgeCount, `${kind} removed edges`);
      return;
  }
}

function assertGraphPayload(
  kind: "base-graph-view" | "source-delta",
  payload: Readonly<Record<string, unknown>>,
  sourceDelta: boolean,
): void {
  assertExactKeys(payload, [
    "anchorHash",
    "anchorNumber",
    "completenessWatermark",
    "edgeCount",
    "metadataHash",
    "orderedCanonicalEdgeIdHash",
    "orderedEdgeHash",
    "ownershipHash",
    "perSourceCoverage",
    "perSourceCoverageSha256",
    ...(sourceDelta
      ? [
          "addedEdgeCount",
          "addedEdgeHash",
          "baseGraphViewSha256",
          "removedEdgeCount",
          "removedEdgeHash",
        ]
      : []),
  ], kind);
  assertNonnegativeInteger(payload.anchorNumber, `${kind} anchor number`);
  assertHash(payload.anchorHash, `${kind} anchor hash`);
  assertInteger(
    payload.completenessWatermark,
    `${kind} completeness watermark`,
  );
  assertNonnegativeInteger(payload.edgeCount, `${kind} edge count`);
  assertHash(payload.orderedEdgeHash, `${kind} ordered edge`);
  assertHash(
    payload.orderedCanonicalEdgeIdHash,
    `${kind} ordered canonical edge ids`,
  );
  assertHash(payload.metadataHash, `${kind} metadata`);
  assertHash(payload.ownershipHash, `${kind} ownership`);
  assertHash(payload.perSourceCoverageSha256, `${kind} coverage`);
  if (!Array.isArray(payload.perSourceCoverage)) {
    throw new Error(`${kind} per-source coverage`);
  }
  for (const coverage of payload.perSourceCoverage) {
    if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) {
      throw new Error(`${kind} per-source coverage entry`);
    }
    const item = coverage as Record<string, unknown>;
    assertExactKeys(item, [
      "completeThroughBlock",
      "completeThroughHash",
      "familyId",
      "sourceFingerprint",
      "sourceId",
    ], `${kind} per-source coverage`);
    assertNonempty(item.familyId, `${kind} coverage family`);
    assertNonempty(item.sourceId, `${kind} coverage source`);
    assertNonempty(item.sourceFingerprint, `${kind} coverage fingerprint`);
    assertNonnegativeInteger(
      item.completeThroughBlock,
      `${kind} coverage block`,
    );
    assertHash(item.completeThroughHash, `${kind} coverage block hash`);
  }
  if (
    payload.perSourceCoverageSha256 !==
      blindProductionArtifactPayloadHash(payload.perSourceCoverage)
  ) {
    throw new Error(`${kind} per-source coverage hash mismatch`);
  }
}

function assertNoSecretMaterial(value: unknown): void {
  const serialized = blindProductionCanonicalJson(value);
  const keys = collectKeys(value);
  const secretName = /(?:private|secret|mnemonic|password|api|access|signer|wallet)[-_]?(?:key|token)?/i;
  if (keys.some((key) => secretName.test(key))) {
    throw new Error("resolved config contains a secret-shaped field");
  }
  if (/0x[0-9a-f]{64}/i.test(serialized)) {
    throw new Error("resolved config contains a private-key-shaped value");
  }
  for (const match of serialized.matchAll(/https?:\\?\/\\?\/[^"\\]+/gi)) {
    const candidate = match[0]!.replaceAll("\\/", "/");
    const url = new URL(candidate);
    if (url.username || url.password || url.search) {
      throw new Error("resolved config contains credential-bearing URL material");
    }
  }
}

function collectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, item]) => [key, ...collectKeys(item)],
  );
}

function canonicalObject(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return JSON.parse(blindProductionCanonicalJson(value)) as Record<string, unknown>;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} contains unexpected or missing fields`);
  }
}

function assertHash(value: unknown, label: string): void {
  if (!/^(?:0x)?[0-9a-f]{64}$/i.test(String(value ?? ""))) {
    throw new Error(`${label} hash`);
  }
}

function assertNonempty(value: unknown, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(label);
  }
}

function assertNonnegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(label);
  }
}

function assertInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(label);
}

function isArtifactKind(value: unknown): value is BlindProductionArtifactKind {
  return [
    "resolved-config",
    "production-universe",
    "active-family-manifest",
    "base-graph-view",
    "source-delta",
  ].includes(String(value));
}
