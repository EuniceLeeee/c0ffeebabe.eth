import {
  assertDecimalString,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainObject,
  decodeCanonicalJson,
  encodeCanonicalBytes,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  decodeRuntimeReleaseBindingV1,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  type RuntimeReleaseBindingV1,
} from "../../../specs/release-authority/src/index.ts";

export interface DeploymentSourceConfigV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.deployment-source-config-v1";
  readonly profile: "reth-json-rpc-v1";
  readonly endpoint: string;
  readonly chainId: string;
  readonly providerIdentity: string;
  readonly backendEpoch: string;
  readonly timeoutMs: number;
  readonly headPollIntervalMs: number;
  readonly canonicalJournalPath: string;
  readonly checkpointDatabasePath: string;
  readonly productionEvidenceDatabasePath: string;
  readonly observerContentDirectory: string;
  readonly terminalLocatorDirectory: string;
}

function absolutePath(value: unknown, path: string): string {
  const decoded = assertNonEmptyString(value, path);
  if (!decoded.startsWith("/")) throw new TypeError(`${path} must be absolute`);
  return decoded;
}

function boundedMs(value: unknown, path: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${path} must be an integer in [1, ${maximum}]`);
  }
  return value;
}

function endpoint(value: unknown): string {
  const raw = assertNonEmptyString(value, "deploymentSource.endpoint");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError("deploymentSource.endpoint must be a URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError("deploymentSource.endpoint must use HTTP(S)");
  }
  if (parsed.username.length !== 0 || parsed.password.length !== 0) {
    throw new TypeError("deploymentSource.endpoint must not contain credentials");
  }
  return parsed.href;
}

export function decodeDeploymentSourceConfigV1(value: unknown): DeploymentSourceConfigV1 {
  assertPlainObject(value, "deploymentSource");
  assertExactKeys(value, [
    "schemaVersion", "kind", "profile", "endpoint", "chainId", "providerIdentity", "backendEpoch",
    "timeoutMs", "headPollIntervalMs", "canonicalJournalPath", "checkpointDatabasePath",
    "productionEvidenceDatabasePath", "observerContentDirectory", "terminalLocatorDirectory",
  ], "deploymentSource");
  if (value.schemaVersion !== 1 || value.kind !== "aloha.deployment-source-config-v1") {
    throw new TypeError("deploymentSource kind/version mismatch");
  }
  if (value.profile !== "reth-json-rpc-v1") throw new TypeError("deploymentSource profile mismatch");
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.deployment-source-config-v1" as const,
    profile: "reth-json-rpc-v1" as const,
    endpoint: endpoint(value.endpoint),
    chainId: assertDecimalString(value.chainId, "deploymentSource.chainId"),
    providerIdentity: assertNonEmptyString(value.providerIdentity, "deploymentSource.providerIdentity"),
    backendEpoch: assertNonEmptyString(value.backendEpoch, "deploymentSource.backendEpoch"),
    timeoutMs: boundedMs(value.timeoutMs, "deploymentSource.timeoutMs", 60_000),
    headPollIntervalMs: boundedMs(value.headPollIntervalMs, "deploymentSource.headPollIntervalMs", 60_000),
    canonicalJournalPath: absolutePath(value.canonicalJournalPath, "deploymentSource.canonicalJournalPath"),
    checkpointDatabasePath: absolutePath(value.checkpointDatabasePath, "deploymentSource.checkpointDatabasePath"),
    productionEvidenceDatabasePath: absolutePath(value.productionEvidenceDatabasePath, "deploymentSource.productionEvidenceDatabasePath"),
    observerContentDirectory: absolutePath(value.observerContentDirectory, "deploymentSource.observerContentDirectory"),
    terminalLocatorDirectory: absolutePath(value.terminalLocatorDirectory, "deploymentSource.terminalLocatorDirectory"),
  });
}

export function decodeDeploymentSourceConfigBytesV1(bytes: Uint8Array): DeploymentSourceConfigV1 {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("deployment source config bytes are required");
  const decoded = decodeDeploymentSourceConfigV1(decodeCanonicalJson(bytes));
  if (!Buffer.from(bytes).equals(Buffer.from(encodeCanonicalBytes(decoded)))) {
    throw new TypeError("deployment source config is not canonical exact bytes");
  }
  return decoded;
}

/** Join inert package data to the independently verified signed release. */
export function assertDeploymentSourceJoinsReleaseV1(
  configValue: DeploymentSourceConfigV1,
  bindingValue: RuntimeReleaseBindingV1,
): DeploymentSourceConfigV1 {
  const config = decodeDeploymentSourceConfigV1(configValue);
  const binding = decodeRuntimeReleaseBindingV1(bindingValue);
  const qualification = binding.discoverySourceQualification;
  if (config.profile !== qualification.profile
    || config.chainId !== qualification.chainId
    || config.providerIdentity !== qualification.providerIdentity
    || config.backendEpoch !== qualification.backendEpoch
    || hashRuntimeReleaseDiscoveryEndpointLocatorV1(config.endpoint) !== qualification.endpointLocatorHash) {
    throw new TypeError("deployment source config does not join the signed release");
  }
  return config;
}
