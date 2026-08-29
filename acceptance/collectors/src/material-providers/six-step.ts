import { decodeCanonicalBytes, hashDomain, type Hash } from "../../../../packages/canonical-codec/src/index.ts";
import { readProductionPredicateMaterialSourceStateV1 } from "../internal/predicate-material-source-owner.ts";
import {
  assertProductionTerminalPhaseDurableDiscoveryV1,
  type ProductionTerminalPhaseDurableDiscoveryV1,
} from "../terminal-phase-locator-index.ts";
import { available, defineProvider, unavailable } from "./shared.ts";

const PREDICATE_ID = "aloha.six-step.facts";

interface SixStepEconomicEvaluatorBindingObservationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aloha.six-step-economic-evaluator-binding-observation-v1";
  readonly runtimeBindingId: Hash;
  readonly candidateReleaseCommit: string;
  readonly releaseProvenanceHash: Hash;
  readonly authorityRoot: Hash;
  readonly implementationHash: Hash;
  readonly policyRoot: Hash;
  readonly evaluatorExportIdentityHash: Hash;
  readonly objectiveTemplates: readonly unknown[];
  readonly actionOwners: readonly unknown[];
  readonly valuationOwners: readonly unknown[];
  readonly executorQualification: unknown;
  readonly safetyProfile: unknown;
  readonly observationRoot: Hash;
}

function terminalBinding(discovery: ProductionTerminalPhaseDurableDiscoveryV1): Readonly<Record<string, unknown>> {
  const artifact = discovery.sixStepTerminalBindingArtifact;
  if (artifact === null) throw new TypeError("Six-Step terminal binding artifact is missing");
  const value = decodeCanonicalBytes(artifact.bytes);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Six-Step terminal binding artifact is invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}

function candidateReleaseCommit(discovery: ProductionTerminalPhaseDurableDiscoveryV1): string {
  const commit = terminalBinding(discovery).candidateReleaseCommit;
  if (typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new TypeError("Six-Step terminal binding candidate commit is invalid");
  }
  return commit;
}

function positiveHash(value: unknown, path: string): Hash {
  if (typeof value !== "string" || !/^0x[0-9a-f]{64}$/.test(value) || /^0x0+$/.test(value)) {
    throw new TypeError(`${path} is not a positive hash`);
  }
  return value as Hash;
}

function economicEvaluatorBindingObservation(
  discovery: ProductionTerminalPhaseDurableDiscoveryV1,
): SixStepEconomicEvaluatorBindingObservationV1 {
  const binding = terminalBinding(discovery);
  const raw = binding.economicEvaluatorBindingObservation;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("Six-Step terminal economic evaluator observation is missing");
  }
  const value = raw as Readonly<Record<string, unknown>>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [
    "schemaVersion", "kind", "runtimeBindingId", "candidateReleaseCommit", "releaseProvenanceHash",
    "authorityRoot", "implementationHash", "policyRoot", "evaluatorExportIdentityHash", "objectiveTemplates",
    "actionOwners", "valuationOwners", "executorQualification", "safetyProfile", "observationRoot",
  ].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)
    || value.schemaVersion !== 1
    || value.kind !== "aloha.six-step-economic-evaluator-binding-observation-v1") {
    throw new TypeError("Six-Step terminal economic evaluator observation is invalid");
  }
  const payload = Object.freeze({
    schemaVersion: 1 as const,
    kind: "aloha.six-step-economic-evaluator-binding-observation-v1" as const,
    runtimeBindingId: positiveHash(value.runtimeBindingId, "sixStepTerminal.economicEvaluator.runtimeBindingId"),
    candidateReleaseCommit: typeof value.candidateReleaseCommit === "string" && /^[0-9a-f]{40}$/.test(value.candidateReleaseCommit)
      ? value.candidateReleaseCommit
      : (() => { throw new TypeError("sixStepTerminal.economicEvaluator.candidateReleaseCommit is invalid"); })(),
    releaseProvenanceHash: positiveHash(value.releaseProvenanceHash, "sixStepTerminal.economicEvaluator.releaseProvenanceHash"),
    authorityRoot: positiveHash(value.authorityRoot, "sixStepTerminal.economicEvaluator.authorityRoot"),
    implementationHash: positiveHash(value.implementationHash, "sixStepTerminal.economicEvaluator.implementationHash"),
    policyRoot: positiveHash(value.policyRoot, "sixStepTerminal.economicEvaluator.policyRoot"),
    evaluatorExportIdentityHash: positiveHash(value.evaluatorExportIdentityHash, "sixStepTerminal.economicEvaluator.exportIdentityHash"),
    objectiveTemplates: Array.isArray(value.objectiveTemplates) && value.objectiveTemplates.length > 0
      ? Object.freeze([...value.objectiveTemplates])
      : (() => { throw new TypeError("sixStepTerminal.economicEvaluator.objectiveTemplates is invalid"); })(),
    actionOwners: Array.isArray(value.actionOwners) && value.actionOwners.length > 0
      ? Object.freeze([...value.actionOwners])
      : (() => { throw new TypeError("sixStepTerminal.economicEvaluator.actionOwners is invalid"); })(),
    valuationOwners: Array.isArray(value.valuationOwners) && value.valuationOwners.length > 0
      ? Object.freeze([...value.valuationOwners])
      : (() => { throw new TypeError("sixStepTerminal.economicEvaluator.valuationOwners is invalid"); })(),
    executorQualification: value.executorQualification !== null
      && typeof value.executorQualification === "object"
      && !Array.isArray(value.executorQualification)
      ? value.executorQualification
      : (() => { throw new TypeError("sixStepTerminal.economicEvaluator.executorQualification is invalid"); })(),
    safetyProfile: value.safetyProfile !== null
      && typeof value.safetyProfile === "object"
      && !Array.isArray(value.safetyProfile)
      ? value.safetyProfile
      : (() => { throw new TypeError("sixStepTerminal.economicEvaluator.safetyProfile is invalid"); })(),
  });
  const observationRoot = positiveHash(value.observationRoot, "sixStepTerminal.economicEvaluator.observationRoot");
  if (observationRoot !== hashDomain("aloha/six-step-economic-evaluator-binding-observation/v1", payload)) {
    throw new TypeError("Six-Step terminal economic evaluator observation root mismatch");
  }
  if (payload.policyRoot !== hashDomain("aloha/runtime-release-economic-evaluator-policies/v4", {
    templates: payload.objectiveTemplates,
    actionOwners: payload.actionOwners,
    valuationOwners: payload.valuationOwners,
    executorQualification: payload.executorQualification,
    safetyProfile: payload.safetyProfile,
  })) {
    throw new TypeError("Six-Step terminal economic evaluator policy root mismatch");
  }
  if (payload.runtimeBindingId !== binding.runtimeBindingId
    || payload.candidateReleaseCommit !== binding.candidateReleaseCommit
    || payload.releaseProvenanceHash !== binding.releaseProvenanceHash
    || payload.authorityRoot !== binding.economicEvaluatorAuthorityRoot
    || payload.implementationHash !== binding.economicEvaluatorImplementationHash) {
    throw new TypeError("Six-Step terminal economic evaluator observation binding mismatch");
  }
  return Object.freeze({ ...payload, observationRoot });
}

export const SIX_STEP_MATERIAL_PROVIDER = defineProvider(PREDICATE_ID, async source => {
  const state = readProductionPredicateMaterialSourceStateV1(source);
  if (state.readDurableTerminalDiscovery === null) {
    return unavailable(PREDICATE_ID, "missing", "owner-port-missing", "durable-terminal-discovery");
  }
  try {
    const discovery = state.readDurableTerminalDiscovery() as ProductionTerminalPhaseDurableDiscoveryV1;
    assertProductionTerminalPhaseDurableDiscoveryV1(discovery);
    if (discovery.sixStepPhysicalStatus === "invalid") {
      return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", discovery.sixStepPhysicalReason);
    }
    if (discovery.manifest.sixStep.status !== "observed") {
      return unavailable(
        PREDICATE_ID,
        discovery.manifest.sixStep.status,
        "owner-material-missing",
        discovery.manifest.sixStep.reason,
      );
    }
    if (discovery.sixStepPredicateArtifacts.length === 0
      || discovery.sixStepEventFacts.length === 0
      || discovery.sixStepArtifactMaterials.length === 0) {
      return unavailable(PREDICATE_ID, "invalid", "predicate-artifact-closure-missing", {
        finalDurableWindowId: discovery.manifest.finalDurableWindowId,
        predicateArtifactRoot: discovery.manifest.sixStep.predicateArtifactRoot,
      });
    }
    const artifacts = Object.freeze(discovery.sixStepArtifactMaterials.flatMap(material => [
      material.eventArtifact,
      material.semanticArtifactRef,
      material.productionReceiptRef,
      ...material.inputArtifacts,
    ]).map(stored => Object.freeze({
      contentSha256: stored.ref.contentSha256,
      bytes: stored.bytes,
      ref: stored.ref,
      claim: stored.claim,
      lease: stored.lease,
    })).filter((artifact, index, values) => values.findIndex(value =>
      value.ref.artifactRefId === artifact.ref.artifactRefId) === index)
      .sort((left, right) => left.ref.artifactRefId.localeCompare(right.ref.artifactRefId)));
    return available(
      PREDICATE_ID,
      candidateReleaseCommit(discovery),
      artifacts,
      [state.sink.resolverPolicy],
      [...discovery.sixStepArtifactMaterials.map(material => material.eventFact), economicEvaluatorBindingObservation(discovery)],
    );
  } catch (error) {
    return unavailable(PREDICATE_ID, "invalid", "owner-material-invalid", error instanceof Error ? error.message : "six-step-ledger");
  }
});
