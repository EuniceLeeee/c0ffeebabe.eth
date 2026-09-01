import type { RuntimeAuthorityV1, RuntimeReleaseAuthorityV1 } from "../index.ts";
import {
  assertIssuedRuntimeAuthorityState,
  assertIssuedRuntimeReleaseAuthorityState,
} from "./state.ts";

export function assertIssuedRuntimeAuthority(
  value: unknown,
): RuntimeAuthorityV1 {
  assertIssuedRuntimeAuthorityState(value);
  return value as RuntimeAuthorityV1;
}

/** Exact consumer edge for downstream authorities. */
export function assertIssuedRuntimeReleaseAuthority(
  value: unknown,
): RuntimeReleaseAuthorityV1 {
  assertIssuedRuntimeReleaseAuthorityState(value);
  return value as RuntimeReleaseAuthorityV1;
}
