import {
  projectRuntimeAuthorityDescriptorV1,
  type CurrentRuntimeAuthorityPortV1,
} from "../../../runtime-authority/src/index.ts";
import { assertActiveRuntimeAuthorityState } from "./state.ts";
import type { RuntimeAuthorityV1 } from "../index.ts";

const currentIssued = new WeakSet<object>();

/** Runtime-authority Ready fence for the sole canonical runtime. */
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
      });
    },
  });
  currentIssued.add(port);
  return port;
}

export function isIssuedCurrentRuntimeAuthorityPort(value: unknown): value is CurrentRuntimeAuthorityPortV1 {
  return value !== null && typeof value === "object" && currentIssued.has(value);
}
