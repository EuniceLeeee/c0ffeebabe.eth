import {
  runtimeReleaseBindingProvenanceHash,
  type RuntimeReleaseReadyBindingPortV1,
} from "../../../../specs/release-authority/src/index.ts";
import {
  projectRuntimeAuthorityDescriptorV1,
  type CurrentRuntimeAuthorityPortV1,
} from "../../../runtime-authority/src/index.ts";
import { assertActiveRuntimeAuthorityState } from "./state.ts";
import type { RuntimeAuthorityV1, RuntimeReleaseAuthorityV1 } from "../index.ts";

const currentIssued = new WeakSet<object>();
const signedIssued = new WeakSet<object>();

/** Mode-neutral Ready fence. Unsigned dry-run has no release provenance. */
export function issueCurrentRuntimeAuthorityPort(
  authorityValue: RuntimeAuthorityV1,
): CurrentRuntimeAuthorityPortV1 {
  const issuedVersion = assertActiveRuntimeAuthorityState(authorityValue).version;
  const port: CurrentRuntimeAuthorityPortV1 = Object.freeze({
    readCurrent() {
      const state = assertActiveRuntimeAuthorityState(authorityValue);
      if (state.version !== issuedVersion) throw new TypeError("runtime authority ready binding stale after rotation");
      return Object.freeze({
        runtimeAuthority: projectRuntimeAuthorityDescriptorV1(state.descriptor),
        releaseProvenanceHash: state.authorityClass === "signed-release"
          ? runtimeReleaseBindingProvenanceHash(state.binding)
          : null,
      });
    },
  });
  currentIssued.add(port);
  return port;
}

/** Runtime-release owner seam for ReadyGeneration's narrow current binding. */
export function issueRuntimeReleaseReadyBindingPort(
  authorityValue: RuntimeReleaseAuthorityV1,
): RuntimeReleaseReadyBindingPortV1 & CurrentRuntimeAuthorityPortV1 {
  const currentAuthority = issueCurrentRuntimeAuthorityPort(authorityValue);
  const issuedVersion = assertActiveRuntimeAuthorityState(authorityValue).version;
  const current = () => {
    const state = assertActiveRuntimeAuthorityState(authorityValue);
    if (state.authorityClass !== "signed-release") throw new TypeError("runtime release ready binding requires signed release");
    if (state.version !== issuedVersion) throw new TypeError("runtime release ready binding stale after rotation");
    return state.binding;
  };
  const port: RuntimeReleaseReadyBindingPortV1 & CurrentRuntimeAuthorityPortV1 = Object.freeze({
    readCurrent: currentAuthority.readCurrent,
    currentProvenanceHash(): `0x${string}` {
      return runtimeReleaseBindingProvenanceHash(current());
    },
    currentBindingId(): `0x${string}` {
      return current().bindingId;
    },
    currentImplementationCommit(): string {
      return current().candidateReleaseCommit;
    },
  });
  currentIssued.add(port);
  signedIssued.add(port);
  return port;
}

export function isIssuedRuntimeReleaseReadyBindingPort(value: unknown): value is RuntimeReleaseReadyBindingPortV1 {
  return value !== null && typeof value === "object" && signedIssued.has(value);
}

export function isIssuedCurrentRuntimeAuthorityPort(value: unknown): value is CurrentRuntimeAuthorityPortV1 {
  return value !== null && typeof value === "object" && currentIssued.has(value);
}
