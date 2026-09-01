import type {
  CurrentRuntimeAuthorityPortV1,
  RuntimeAuthorityDescriptorV1,
} from "../../../packages/runtime-authority/src/index.ts";
import { issueRuntimeAuthorityInternalV1 } from "./internal/runtime-authority-owner.ts";

export interface RuntimeAuthorityV1 {
  readonly capability: object;
  readonly readyGeneration: CurrentRuntimeAuthorityPortV1;
  revoke(): void;
}

/** The only runtime authority constructor. It records exact run bytes and
 * carries no signer, approval, release resolver, or production elevation. */
export function issueRuntimeAuthorityV1(
  descriptor: RuntimeAuthorityDescriptorV1,
): RuntimeAuthorityV1 {
  return issueRuntimeAuthorityInternalV1(descriptor);
}
