import type { RuntimeReleaseAuthorityV1 } from "../index.ts";
import { assertIssuedRuntimeReleaseAuthorityState } from "./state.ts";

/** Exact consumer edge for downstream authorities. */
export function assertIssuedRuntimeReleaseAuthority(
  value: unknown,
): RuntimeReleaseAuthorityV1 {
  assertIssuedRuntimeReleaseAuthorityState(value);
  return value as RuntimeReleaseAuthorityV1;
}
