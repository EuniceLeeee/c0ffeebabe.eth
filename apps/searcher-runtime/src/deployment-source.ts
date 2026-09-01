import {
  assertDecimalString,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashDomain,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";

export interface RuntimeSourceConfigV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.runtime-source-config-v1";
  readonly profile: "reth-json-rpc-v1";
  readonly chainId: string;
  readonly providerIdentity: string;
  readonly backendEpoch: string;
  readonly timeoutMs: number;
  readonly headPollIntervalMs: number;
  readonly canonicalJournalPath: string;
  readonly checkpointDatabasePath: string;
  readonly observationDatabasePath: string;
}

function absolutePath(value: unknown, path: string): string {
  const decoded = assertNonEmptyString(value, path);
  if (!decoded.startsWith("/")) throw new TypeError(`${path} must be absolute`);
  return decoded;
}

function boundedMs(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError(`${path} must be an integer in [1, 60000]`);
  }
  return value;
}

export function decodeRuntimeSourceConfigV1(value: unknown): RuntimeSourceConfigV1 {
  assertPlainObject(value, "runtimeSource");
  assertExactKeys(value, [
    "schemaVersion", "kind", "profile", "chainId", "providerIdentity", "backendEpoch",
    "timeoutMs", "headPollIntervalMs", "canonicalJournalPath", "checkpointDatabasePath",
    "observationDatabasePath",
  ], "runtimeSource");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.runtime-source-config-v1") {
    throw new TypeError("runtimeSource kind/version mismatch");
  }
  if (value.profile !== "reth-json-rpc-v1") throw new TypeError("runtimeSource profile mismatch");
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.runtime-source-config-v1" as const,
    profile: "reth-json-rpc-v1" as const,
    chainId: assertDecimalString(value.chainId, "runtimeSource.chainId"),
    providerIdentity: assertNonEmptyString(value.providerIdentity, "runtimeSource.providerIdentity"),
    backendEpoch: assertNonEmptyString(value.backendEpoch, "runtimeSource.backendEpoch"),
    timeoutMs: boundedMs(value.timeoutMs, "runtimeSource.timeoutMs"),
    headPollIntervalMs: boundedMs(value.headPollIntervalMs, "runtimeSource.headPollIntervalMs"),
    canonicalJournalPath: absolutePath(value.canonicalJournalPath, "runtimeSource.canonicalJournalPath"),
    checkpointDatabasePath: absolutePath(value.checkpointDatabasePath, "runtimeSource.checkpointDatabasePath"),
    observationDatabasePath: absolutePath(value.observationDatabasePath, "runtimeSource.observationDatabasePath"),
  });
}

export function decodeRuntimeSourceConfigBytesV1(bytes: Uint8Array): RuntimeSourceConfigV1 {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("runtime source config bytes are required");
  const decoded = decodeRuntimeSourceConfigV1(decodeCanonicalJson(bytes));
  if (!Buffer.from(bytes).equals(Buffer.from(encodeCanonicalBytes(decoded)))) {
    throw new TypeError("runtime source config is not canonical exact bytes");
  }
  return decoded;
}

export function runtimeSourceAuthorityRootV1(configValue: RuntimeSourceConfigV1): Hash {
  const config = decodeRuntimeSourceConfigV1(configValue);
  return hashDomain("aloha/runtime-source-authority/v1", {
    profile: config.profile,
    chainId: config.chainId,
    providerIdentity: config.providerIdentity,
    backendEpoch: config.backendEpoch,
  });
}
