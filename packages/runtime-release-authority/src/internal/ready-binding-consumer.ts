import type { RuntimeReleaseReadyBindingPortV1 } from "../../../../specs/release-authority/src/index.ts";
import { isIssuedRuntimeReleaseReadyBindingPort } from "./ready-binding-owner.ts";

/** Exact ReadyGeneration consumer edge; structural ports are rejected. */
export function assertIssuedRuntimeReleaseReadyBindingPort(
  value: unknown,
): RuntimeReleaseReadyBindingPortV1 {
  if (!isIssuedRuntimeReleaseReadyBindingPort(value)) {
    throw new TypeError("runtime release ready binding port is not release-issued");
  }
  return value;
}
