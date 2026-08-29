import { hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";

export type DeploymentReleaseClockCapabilityV1 = object;

interface DeploymentReleaseClockStateV1 {
  readonly runtimeBindingId: Hash;
}

const clocks = new WeakMap<object, DeploymentReleaseClockStateV1>();

/**
 * Internal deployment owner.  The clock is issued only after the caller has
 * verified the signed RuntimeReleaseBinding, and the capability is bound to
 * that exact binding.  No producer callback or caller-authored timestamp can
 * enter this boundary.
 */
export function issueDeploymentReleaseClockV1(
  runtimeBindingId: Hash,
): DeploymentReleaseClockCapabilityV1 {
  if (typeof runtimeBindingId !== "string" || !/^0x[0-9a-f]{64}$/.test(runtimeBindingId)) {
    throw new TypeError("deployment release clock runtime binding id must be an exact lowercase hash");
  }
  const capability = Object.freeze(Object.create(null)) as object;
  clocks.set(capability, Object.freeze({ runtimeBindingId }));
  return capability;
}

export function readDeploymentReleaseClockUnixNsV1(
  capability: DeploymentReleaseClockCapabilityV1,
  expectedRuntimeBindingId: Hash,
): string {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("deployment release clock capability is invalid");
  }
  const state = clocks.get(capability);
  if (state === undefined) {
    throw new TypeError("deployment release clock capability was not deployment-owner-issued");
  }
  if (state.runtimeBindingId !== expectedRuntimeBindingId) {
    throw new TypeError("deployment release clock runtime binding mismatch");
  }
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export const DEPLOYMENT_RELEASE_CLOCK_CONTRACT_DIGEST = hashDomain(
  "aloha/deployment-release-clock-contract/v1",
  Object.freeze({
    source: "node-wall-clock",
    unit: "unix-nanoseconds",
    binding: "verified-runtime-release-binding-id",
    callerTimestamp: false,
    producerCallback: false,
  }),
);
