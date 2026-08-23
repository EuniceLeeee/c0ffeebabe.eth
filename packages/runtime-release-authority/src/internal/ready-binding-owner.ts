import {
  runtimeReleaseBindingProvenanceHash,
  type RuntimeReleaseReadyBindingPortV1,
} from "../../../../specs/release-authority/src/index.ts";
import { assertActiveRuntimeReleaseAuthorityState } from "./state.ts";
import type { RuntimeReleaseAuthorityV1 } from "../index.ts";

const issued = new WeakSet<object>();

/** Runtime-release owner seam for ReadyGeneration's narrow current binding. */
export function issueRuntimeReleaseReadyBindingPort(
  authorityValue: RuntimeReleaseAuthorityV1,
): RuntimeReleaseReadyBindingPortV1 {
  const issuedVersion = assertActiveRuntimeReleaseAuthorityState(authorityValue).version;
  const port: RuntimeReleaseReadyBindingPortV1 = Object.freeze({
    currentProvenanceHash(): `0x${string}` {
      const state = assertActiveRuntimeReleaseAuthorityState(authorityValue);
      if (state.version !== issuedVersion) throw new TypeError("runtime release ready binding stale after rotation");
      return runtimeReleaseBindingProvenanceHash(state.binding);
    },
  });
  issued.add(port);
  return port;
}

export function isIssuedRuntimeReleaseReadyBindingPort(value: unknown): value is RuntimeReleaseReadyBindingPortV1 {
  return value !== null && typeof value === "object" && issued.has(value);
}
