import type {
  CanonicalHead,
  ProducerIngressObservationV1,
  ProducerIngressSourceV1,
} from "../../src/index.ts";
import { brandProducerIngressSource } from "../../src/internal/source-brand.ts";

/** Test-process-only source issuance; this file is outside the production source closure. */
export function issueProducerIngressSourceForTestV1(value: {
  readonly observe: (input: { readonly head: CanonicalHead; readonly signal: AbortSignal }) => Promise<ProducerIngressObservationV1 | null>;
}): ProducerIngressSourceV1 {
  if (value === null || typeof value !== "object" || typeof value.observe !== "function") throw new TypeError("test producer ingress source is required");
  return brandProducerIngressSource(value);
}
