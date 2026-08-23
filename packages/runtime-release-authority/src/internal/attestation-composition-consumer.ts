import type { RuntimeReleaseAttestationCompositionResolvedV1 } from "../../../../specs/release-authority/src/index.ts";
import { readIssuedRuntimeReleaseAttestationComposition } from "./attestation-composition-owner.ts";
import {
  assertIssuedRuntimeReleaseAttestationProofPort,
  } from "./attestation-proof-consumer.ts";
import type { RuntimeReleaseAttestationCompositionResolvedWithProofV1 } from "./attestation-composition-owner.ts";

/** Exact consumer edge used by Attestation composition resolution. */
export function assertIssuedRuntimeReleaseAttestationComposition(
  value: unknown,
): RuntimeReleaseAttestationCompositionResolvedWithProofV1 {
  const issued = readIssuedRuntimeReleaseAttestationComposition(value);
  const resolved = issued.binding.resolver.resolve(issued.binding.capability) as RuntimeReleaseAttestationCompositionResolvedV1 & {
    readonly provenance: RuntimeReleaseAttestationCompositionResolvedV1["provenance"] & { readonly proofPortCapability: object };
  };
  const proofPort = assertIssuedRuntimeReleaseAttestationProofPort(
    resolved.provenance.proofPortCapability,
    issued.authority,
  );
  return Object.freeze({
    provenance: Object.freeze({ runtimeBinding: resolved.provenance.runtimeBinding }),
    proofPort,
  });
}
