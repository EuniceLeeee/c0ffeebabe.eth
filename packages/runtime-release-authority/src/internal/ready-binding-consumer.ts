import type { RuntimeReleaseReadyBindingPortV1 } from "../../../../specs/release-authority/src/index.ts";
import type { CurrentRuntimeAuthorityPortV1 } from "../../../runtime-authority/src/index.ts";
import {
  isIssuedCurrentRuntimeAuthorityPort,
  isIssuedRuntimeReleaseReadyBindingPort,
} from "./ready-binding-owner.ts";

/** Exact ReadyGeneration consumer edge; structural ports are rejected. */
export function assertIssuedRuntimeReleaseReadyBindingPort(
  value: unknown,
): RuntimeReleaseReadyBindingPortV1 {
  if (!isIssuedRuntimeReleaseReadyBindingPort(value)) {
    throw new TypeError("runtime release ready binding port is not release-issued");
  }
  return value;
}

export function assertIssuedCurrentRuntimeAuthorityPort(
  value: unknown,
): CurrentRuntimeAuthorityPortV1 {
  if (!isIssuedCurrentRuntimeAuthorityPort(value)) {
    throw new TypeError("current runtime authority port is not owner-issued");
  }
  return value;
}
