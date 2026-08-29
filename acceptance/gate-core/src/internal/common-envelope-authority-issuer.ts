import {
  registerCommonEnvelopeAuthorityPortV1,
  type CommonEnvelopeAssemblerV1,
} from "./material-provider-state.ts";
import type { CommonEnvelopeAuthorityPortV1 } from "../material-provider.ts";

/** The deployment release runner is the sole production importer. */
export function issueCommonEnvelopeAuthorityPortV1(
  assemble: CommonEnvelopeAssemblerV1,
): CommonEnvelopeAuthorityPortV1 {
  return registerCommonEnvelopeAuthorityPortV1(assemble);
}
