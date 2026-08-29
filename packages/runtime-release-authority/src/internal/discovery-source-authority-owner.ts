import {
  assertDecimalString,
  assertExactKeys,
  assertNonEmptyString,
  assertPlainObject,
  readOwnEnumerableDataProperty,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  decodeRuntimeReleaseDiscoverySourceQualificationV1,
  hashRuntimeReleaseDiscoveryEndpointLocatorV1,
  runtimeReleaseBindingProvenanceHash,
  runtimeReleaseDiscoverySourceAuthorityRootV1,
  type RuntimeReleaseDiscoverySourceQualificationV1,
} from "../../../../specs/release-authority/src/index.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";

/**
 * Opaque deployment-to-release-owner capability.  It is intentionally not
 * exported from the package root and carries no enumerable data.  The raw
 * endpoint is retained only in the private state below.
 */
export type RuntimeReleaseQualifiedDiscoverySourcePortV1 = object;

export interface RuntimeReleaseDiscoverySourceDeploymentInputV1 {
  readonly profile: "reth-json-rpc-v1";
  readonly endpoint: string;
  readonly chainId: string;
  /** Stable operator identity for the provider role, not the endpoint URL. */
  readonly providerIdentity: string;
  /** Actual observed backend/process epoch; never derived from the URL. */
  readonly backendEpoch: string;
  readonly timeoutMs?: number;
}

export interface RuntimeReleaseQualifiedDiscoverySourceStateV1 {
  readonly profile: "reth-json-rpc-v1";
  readonly endpoint: string;
  readonly chainId: string;
  readonly timeoutMs: number;
  readonly provider: Readonly<{
    readonly provider: string;
    readonly backendEpoch: string;
  }>;
  readonly qualification: RuntimeReleaseDiscoverySourceQualificationV1;
  /** Stable source identity used by durable coverage continuity. */
  readonly sourceAuthorityRoot: Hash;
  /** Release lineage remains separate so unrelated release changes do not rewrite source identity. */
  readonly release: Readonly<{
    readonly bindingId: Hash;
    readonly releaseProvenanceHash: Hash;
  }>;
}

interface IssuedStateV1 {
  readonly authority: RuntimeReleaseAuthorityV1;
  readonly authorityVersion: bigint;
  readonly bindingId: Hash;
  readonly source: RuntimeReleaseQualifiedDiscoverySourceStateV1;
}

const issuedPorts = new WeakMap<object, IssuedStateV1>();
const issuedStates = new WeakSet<object>();

function normalizeEndpoint(value: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("runtime release discovery endpoint must be a URL");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("runtime release discovery endpoint must use HTTP(S)");
  }
  return endpoint.href;
}

function decodeDeploymentInput(
  value: RuntimeReleaseDiscoverySourceDeploymentInputV1,
): Readonly<Required<RuntimeReleaseDiscoverySourceDeploymentInputV1>> {
  assertPlainObject(value, "runtimeReleaseDiscoverySourceDeployment");
  const keys = ["profile", "endpoint", "chainId", "providerIdentity", "backendEpoch"];
  if (Object.prototype.hasOwnProperty.call(value, "timeoutMs")) keys.push("timeoutMs");
  assertExactKeys(value, keys, "runtimeReleaseDiscoverySourceDeployment");
  const profile = readOwnEnumerableDataProperty(value, "profile", "runtimeReleaseDiscoverySourceDeployment");
  const endpoint = readOwnEnumerableDataProperty(value, "endpoint", "runtimeReleaseDiscoverySourceDeployment");
  const chainId = readOwnEnumerableDataProperty(value, "chainId", "runtimeReleaseDiscoverySourceDeployment");
  const providerIdentity = readOwnEnumerableDataProperty(value, "providerIdentity", "runtimeReleaseDiscoverySourceDeployment");
  const backendEpoch = readOwnEnumerableDataProperty(value, "backendEpoch", "runtimeReleaseDiscoverySourceDeployment");
  const configuredTimeout = Object.prototype.hasOwnProperty.call(value, "timeoutMs")
    ? readOwnEnumerableDataProperty(value, "timeoutMs", "runtimeReleaseDiscoverySourceDeployment")
    : undefined;
  if (profile !== "reth-json-rpc-v1") {
    throw new TypeError("runtime release discovery source profile is invalid");
  }
  if (typeof endpoint !== "string") throw new TypeError("runtime release discovery endpoint must be a URL");
  const timeoutMs = configuredTimeout ?? 5_000;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("runtime release discovery timeoutMs must be an integer in [1, 60000]");
  }
  return Object.freeze({
    profile,
    endpoint: normalizeEndpoint(endpoint),
    chainId: assertDecimalString(chainId, "runtimeReleaseDiscoverySourceDeployment.chainId"),
    providerIdentity: assertNonEmptyString(
      providerIdentity,
      "runtimeReleaseDiscoverySourceDeployment.providerIdentity",
    ),
    backendEpoch: assertNonEmptyString(
      backendEpoch,
      "runtimeReleaseDiscoverySourceDeployment.backendEpoch",
    ),
    timeoutMs,
  });
}

function assertDeploymentMatchesQualification(
  deployment: Readonly<Required<RuntimeReleaseDiscoverySourceDeploymentInputV1>>,
  qualificationValue: RuntimeReleaseDiscoverySourceQualificationV1,
): RuntimeReleaseDiscoverySourceQualificationV1 {
  const qualification = decodeRuntimeReleaseDiscoverySourceQualificationV1(qualificationValue);
  if (
    deployment.profile !== qualification.profile
    || deployment.chainId !== qualification.chainId
    || deployment.providerIdentity !== qualification.providerIdentity
    || deployment.backendEpoch !== qualification.backendEpoch
    || hashRuntimeReleaseDiscoveryEndpointLocatorV1(deployment.endpoint) !== qualification.endpointLocatorHash
  ) {
    throw new TypeError("deployment discovery source does not match signed runtime qualification");
  }
  return qualification;
}

/**
 * Internal release-owner join.  Raw source data is inert: issuance requires
 * the already verified signed runtime authority and exact agreement with its
 * discovery qualification.  Production application code has no package-root
 * issuer; deployment composition owns this one internal edge.
 */
export function issueRuntimeReleaseQualifiedDiscoverySourcePort(
  authorityValue: unknown,
  deploymentValue: RuntimeReleaseDiscoverySourceDeploymentInputV1,
): RuntimeReleaseQualifiedDiscoverySourcePortV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const releaseState = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  const deployment = decodeDeploymentInput(deploymentValue);
  const qualification = assertDeploymentMatchesQualification(
    deployment,
    releaseState.binding.discoverySourceQualification,
  );
  const port = Object.freeze(Object.create(null)) as RuntimeReleaseQualifiedDiscoverySourcePortV1;
  const source: RuntimeReleaseQualifiedDiscoverySourceStateV1 = Object.freeze({
    profile: deployment.profile,
    endpoint: deployment.endpoint,
    chainId: deployment.chainId,
    timeoutMs: deployment.timeoutMs,
    provider: Object.freeze({
      provider: qualification.providerIdentity,
      backendEpoch: qualification.backendEpoch,
    }),
    qualification,
    sourceAuthorityRoot: runtimeReleaseDiscoverySourceAuthorityRootV1(qualification),
    release: Object.freeze({
      bindingId: releaseState.binding.bindingId,
      releaseProvenanceHash: runtimeReleaseBindingProvenanceHash(releaseState.binding),
    }),
  });
  issuedStates.add(source);
  issuedPorts.set(port, Object.freeze({
    authority,
    authorityVersion: releaseState.version,
    bindingId: releaseState.binding.bindingId,
    source,
  }));
  return port;
}

/** Bootstrap-only read. Structural objects, clones and cross-release ports fail closed. */
export function readRuntimeReleaseQualifiedDiscoverySourcePort(
  authorityValue: unknown,
  portValue: unknown,
): RuntimeReleaseQualifiedDiscoverySourceStateV1 {
  const authority = authorityValue as RuntimeReleaseAuthorityV1;
  const current = assertActiveRuntimeReleaseAuthorityState(authorityValue);
  if (portValue === null || typeof portValue !== "object") {
    throw new TypeError("runtime release qualified discovery source port is invalid");
  }
  const issued = issuedPorts.get(portValue);
  if (issued === undefined || issued.authority !== authority) {
    throw new TypeError("runtime release qualified discovery source port is not owner-issued");
  }
  if (issued.authorityVersion !== current.version || issued.bindingId !== current.binding.bindingId) {
    throw new TypeError("runtime release qualified discovery source port is stale after rotation");
  }
  assertDeploymentMatchesQualification(Object.freeze({
    profile: issued.source.profile,
    endpoint: issued.source.endpoint,
    chainId: issued.source.chainId,
    providerIdentity: issued.source.provider.provider,
    backendEpoch: issued.source.provider.backendEpoch,
    timeoutMs: issued.source.timeoutMs,
  }), current.binding.discoverySourceQualification);
  return issued.source;
}

/** Discovery-owner boundary: only the exact private state read from this owner is usable. */
export function assertRuntimeReleaseQualifiedDiscoverySourceState(
  value: unknown,
): asserts value is RuntimeReleaseQualifiedDiscoverySourceStateV1 {
  if (value === null || typeof value !== "object" || !issuedStates.has(value)) {
    throw new TypeError("runtime release qualified discovery source state is not owner-issued");
  }
}
