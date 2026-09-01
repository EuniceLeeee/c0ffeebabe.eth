import {
  decodeRuntimeAuthorityDescriptorV1,
  type RuntimeAuthorityDescriptorV1,
} from "../../../../packages/runtime-authority/src/index.ts";
import {
  assertActiveRuntimeAuthorityState,
} from "./state.ts";

export function readActiveRuntimeAuthorityDescriptorV1(
  authorityValue: unknown,
): RuntimeAuthorityDescriptorV1 {
  return decodeRuntimeAuthorityDescriptorV1(
    assertActiveRuntimeAuthorityState(authorityValue).descriptor,
  );
}
