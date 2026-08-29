import type {
  ProductionFullFamilyObservationPortV1,
  ProductionFullFamilyObservationResultCapabilityV1,
} from "../../../packages/full-family-observation-port/src/index.ts";
import {
  issueProductionFullFamilyObservationPortV1,
  readProductionFullFamilyObservationResultV1,
} from "../../../packages/full-family-observation-port/src/internal/owner.ts";
import type {
  ReadyFullFamilyEvidenceReaderPortV1,
  ReadyStage12EvidenceCapabilityV1,
} from "../../../packages/checkpoint/src/ready-full-family-evidence-consumer.ts";
import type { RuntimeReleaseFullFamilyTerminalBindingCapabilityV1 } from "../../../packages/runtime-release-authority/src/full-family-terminal-consumer.ts";
import type { FullGraphCoarseSweepCapabilityV1 } from "../../../packages/runtime-release-authority/src/full-graph-coarse-sweep-consumer.ts";
import { ContentAddressedObserverSinkV1 } from "./content-addressed-sink.ts";
import {
  observeProductionFullFamily,
  type ProductionFullFamilyObserverResultV1,
} from "./full-family-observer.ts";

export interface ProductionFullFamilyObservationPortOptionsV1 {
  readonly releaseIntentCanonicalBytes: Uint8Array;
  readonly familyCatalogSourceBytes: Uint8Array;
  readonly runtimeCompositionSourceBytes: Uint8Array;
  readonly strategyCatalogSourceBytes: Uint8Array;
  readonly candidateProofVerifierBindingBytes: Uint8Array;
  readonly sink: ContentAddressedObserverSinkV1;
}

/**
 * External acceptance composition closes over exact release bytes and the
 * collector-owned content store. Production receives only the branded port;
 * it cannot inject facts, expected verdicts, artifact bytes, or a sink.
 */
export function issueProductionFullFamilyCollectorPortV1(
  options: ProductionFullFamilyObservationPortOptionsV1,
): ProductionFullFamilyObservationPortV1 {
  if (options === null || typeof options !== "object") {
    throw new TypeError("production full-family collector port options are required");
  }
  const keys = Reflect.ownKeys(options);
  const expected = [
    "releaseIntentCanonicalBytes",
    "familyCatalogSourceBytes",
    "runtimeCompositionSourceBytes",
    "strategyCatalogSourceBytes",
    "candidateProofVerifierBindingBytes",
    "sink",
  ];
  if (keys.length !== expected.length || expected.some(key => !keys.includes(key))) {
    throw new TypeError("production full-family collector port options have non-exact fields");
  }
  if (!(options.sink instanceof ContentAddressedObserverSinkV1)) {
    throw new TypeError("production full-family collector port requires collector-owned sink");
  }
  const frozen = Object.freeze({
    releaseIntentCanonicalBytes: Uint8Array.from(options.releaseIntentCanonicalBytes),
    familyCatalogSourceBytes: Uint8Array.from(options.familyCatalogSourceBytes),
    runtimeCompositionSourceBytes: Uint8Array.from(options.runtimeCompositionSourceBytes),
    strategyCatalogSourceBytes: Uint8Array.from(options.strategyCatalogSourceBytes),
    candidateProofVerifierBindingBytes: Uint8Array.from(options.candidateProofVerifierBindingBytes),
    sink: options.sink,
  });
  return issueProductionFullFamilyObservationPortV1(async invocation => observeProductionFullFamily({
    checkpointReader: invocation.checkpointReader as ReadyFullFamilyEvidenceReaderPortV1,
    stage12Capability: invocation.stage12Capability as ReadyStage12EvidenceCapabilityV1,
    runtimeReleaseTerminalBindingCapability:
      invocation.runtimeReleaseTerminalBindingCapability as RuntimeReleaseFullFamilyTerminalBindingCapabilityV1,
    fullGraphCoarseSweepCapability:
      invocation.fullGraphCoarseSweepCapability as FullGraphCoarseSweepCapabilityV1,
    ...frozen,
  }));
}

/** Read a result only after the acceptance-owned implementation sealed it. */
export function readProductionFullFamilyCollectorResultV1(
  capability: ProductionFullFamilyObservationResultCapabilityV1,
): ProductionFullFamilyObserverResultV1 {
  return readProductionFullFamilyObservationResultV1(capability) as ProductionFullFamilyObserverResultV1;
}
