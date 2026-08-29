import {
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  decodeExactObject,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import {
  validateInstancePublication,
  type InstancePublicationV1,
} from "../../../catalog/src/index.ts";
import type { CandidateRecordV1, CanonicalCutoffV1 } from "../../../discovery/src/index.ts";
import { decodeCanonicalCutoff } from "../../../discovery/src/index.ts";
import type {
  FamilyLifecycleOutcomeV1,
  FamilyRuntimeStageV1,
  FamilyStageRuntimePortV1,
  FamilyStageProgramV1,
} from "../../../family-sdk/runtime/index.ts";
import type { FamilyRuntimeCompositionV1 } from "../../../family-composition/src/index.ts";
import {
  validateFailure,
  validateIdentityObservation,
  validateVerifiedPublication,
  type AttestationProgramPort,
  type IdentityDecisionV1,
  type IdentityVerifiedObservationV1,
  type IdentityVerifiedV1,
  type InstanceDecisionV1,
  type OutcomeFailureV1,
  type VerifiedMemoReuseDecisionV1,
} from "../index.ts";

/**
 * The stage payload is deliberately a generic envelope.  Concrete Family
 * codecs live behind generated stage registrations; this adapter never
 * imports a Family or interprets protocol fields.
 */
/** Generic identity result envelope. The memo itself is opaque to the
 * adapter; only the fixed lifecycle coordinates are interpreted centrally. */
export interface FamilyIdentityStageOutputV1 {
  readonly kind: "identityVerified";
  readonly familyInstanceKey: string;
  readonly identityMemo: CanonicalJson;
  readonly identityMemoHash: Hash;
  readonly descriptorHash: Hash;
  readonly evidenceRoot: Hash;
}

export interface FamilyProgramAdapterInputV1 {
  readonly composition: FamilyRuntimeCompositionV1;
}

function source(cutoff: CanonicalCutoffV1) {
  return Object.freeze({
    chainId: cutoff.chainId,
    number: cutoff.number,
    hash: cutoff.hash,
    stateRoot: cutoff.stateRoot,
  });
}

function evidenceRoot(candidate: CandidateRecordV1): Hash {
  return candidate.candidateEvidenceRoot;
}

function code(value: string, fallback: string): string {
  const normalized = value.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length === 0 ? fallback : normalized;
}

function failure(
  candidate: CandidateRecordV1,
  stage: "identity" | "materialization" | "projection",
  failureCode: string,
  root: Hash,
  kind: "retryable" | "invalidProgram",
): OutcomeFailureV1 {
  return validateFailure({
    stage,
    failureCode: code(failureCode, "family-stage-failure"),
    attemptCount: "1",
    candidateSubjectHash: candidate.candidateSubjectHash,
    evidenceRoot: root,
    frameworkBinding: null,
  }, `family.${stage}.${kind}`, kind);
}

function invalidIdentityDecision(
  candidate: CandidateRecordV1,
  stage: "identity" | "materialization" | "projection",
  failureCode: string,
  root: Hash,
): IdentityDecisionV1 {
  return {
    kind: "invalidProgram",
    failure: failure(candidate, stage, failureCode, root, "invalidProgram"),
  };
}

function invalidInstanceDecision(
  candidate: CandidateRecordV1,
  stage: "materialization" | "projection",
  failureCode: string,
  root: Hash,
): InstanceDecisionV1 {
  return {
    kind: "invalidProgram",
    failure: failure(candidate, stage, failureCode, root, "invalidProgram"),
  };
}

function assertSource(program: FamilyStageProgramV1, cutoff: CanonicalCutoffV1): void {
  if (
    program.source.chainId !== cutoff.chainId
    || program.source.number !== cutoff.number
    || program.source.hash !== cutoff.hash
    || program.source.stateRoot !== cutoff.stateRoot
  ) throw new TypeError("family-stage-source-mismatch");
}

function assertBinding(
  outcome: FamilyLifecycleOutcomeV1,
  candidate: CandidateRecordV1,
  cutoff: CanonicalCutoffV1,
  stage: FamilyRuntimeStageV1,
  expectedEvidenceRoot: Hash,
): void {
  if (
    outcome.familyId !== candidate.familyId
    || outcome.familyDefinitionHash !== candidate.familyDefinitionHash
    || outcome.stage !== stage
    || outcome.candidateKey !== candidate.familyCandidateKey
    || outcome.source.chainId !== cutoff.chainId
    || outcome.source.number !== cutoff.number
    || outcome.source.hash !== cutoff.hash
    || outcome.source.stateRoot !== cutoff.stateRoot
    || outcome.evidenceRoot !== expectedEvidenceRoot
  ) throw new TypeError("family-stage-outcome-lineage-mismatch");
}

function identityObservation(value: unknown, path: string): IdentityVerifiedObservationV1 {
  return validateIdentityObservation(value, path);
}

function identityValue(value: unknown, path: string): IdentityVerifiedObservationV1 {
  return identityObservation(value, path);
}

function materializationValue(value: unknown, path: string): CanonicalJson {
  const decoded = decodeCanonicalJson(encodeCanonicalJson(value));
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError(`${path} must be a canonical object`);
  return decoded;
}

function publicationValue(value: unknown, path: string): InstancePublicationV1 {
  const decoded = decodeCanonicalJson(encodeCanonicalJson(value));
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new TypeError(`${path} must be a sealed publication object`);
  validateInstancePublication(decoded as unknown as InstancePublicationV1);
  return decoded as unknown as InstancePublicationV1;
}

/**
 * Adapt one generated Family composition to the fixed AttestationProgramPort.
 * The only central decisions here are stage order and common lifecycle
 * envelopes; identity/publication meaning remains plugin-owned output.
 */
export function createAttestationProgramPortFromFamilyComposition(
  input: FamilyProgramAdapterInputV1,
): AttestationProgramPort {
  const composition = input.composition;
  if (composition === null || typeof composition !== "object") throw new TypeError("family composition is required");

  const issue = (
    candidate: CandidateRecordV1,
    cutoff: CanonicalCutoffV1,
    stageName: "identity" | "materialization" | "projection" | "rehydration",
    identityMemo: CanonicalJson | null,
    materializationOutput: CanonicalJson | null,
    instanceKey: string | null,
    reusePublication: InstancePublicationV1 | null,
  ): { readonly stage: FamilyStageRuntimePortV1; readonly program: FamilyStageProgramV1 } => {
    const family = composition.require(candidate.familyDefinitionHash, candidate.familyId);
    const stageRef = family.lifecycleRefs[stageName];
    const stage = family.owner.port.getStage(stageRef);
    if (stage.stageRef.familyDefinitionHash !== candidate.familyDefinitionHash || stage.stageRef.stage !== stageName) {
      throw new TypeError("family-stage-ref-not-bound");
    }
    const program = stage.issue({
      candidateKey: candidate.familyCandidateKey,
      instanceKey: instanceKey as never,
      evidenceRoot: evidenceRoot(candidate),
      invocation: {
        stage: stageName,
        candidate: decodeCanonicalJson(encodeCanonicalJson(candidate)),
        cutoff: source(cutoff),
        identityMemo,
        materializationOutput,
        reusePublication: reusePublication === null ? null : decodeCanonicalJson(encodeCanonicalJson(reusePublication)),
      },
    });
    assertSource(program, cutoff);
    return { stage, program };
  };

  const execute = async (
    stage: FamilyStageRuntimePortV1,
    program: FamilyStageProgramV1,
    signal: AbortSignal,
  ): Promise<FamilyLifecycleOutcomeV1> => {
    const factSet = await stage.execute({ program, signal, attemptId: program.requestFingerprint });
    return stage.interpret({ program, factSet });
  };

  const identity = async (
    candidate: CandidateRecordV1,
    cutoff: CanonicalCutoffV1,
    signal: AbortSignal,
  ): Promise<IdentityDecisionV1> => {
    try {
      const issued = issue(candidate, cutoff, "identity", null, null, null, null);
      const outcome = await execute(issued.stage, issued.program, signal);
      assertBinding(outcome, candidate, cutoff, "identity", evidenceRoot(candidate));
      if (outcome.kind === "verified") {
        const observation = identityValue(outcome.output, "family.identity.output");
        if (observation.evidenceRoot !== candidate.candidateEvidenceRoot) {
          throw new TypeError("family-identity-evidence-root-mismatch");
        }
        return Object.freeze({ ...observation });
      }
      if (outcome.kind === "retryable") {
        return Object.freeze({ kind: "retryable" as const, failure: failure(candidate, "identity", outcome.failureCode, outcome.evidenceRoot, "retryable") });
      }
      return invalidIdentityDecision(candidate, "identity", outcome.kind === "invalidProgram" ? outcome.code : "family-rejection-bridge-unavailable", outcome.evidenceRoot);
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return invalidIdentityDecision(candidate, "identity", error instanceof Error ? error.message : "family-identity-adapter-error", evidenceRoot(candidate));
    }
  };

  const reuseVerifiedMemo = async (
    candidate: CandidateRecordV1,
    publication: InstancePublicationV1,
    cutoff: CanonicalCutoffV1,
    signal: AbortSignal,
  ): Promise<VerifiedMemoReuseDecisionV1> => {
    try {
      validateInstancePublication(publication);
      if (publication.familyId !== candidate.familyId || publication.instanceKey !== candidate.instanceNominationKey) {
        return Object.freeze({ kind: "requiresAttestation" as const });
      }
      const issued = issue(candidate, cutoff, "rehydration", null, null, candidate.instanceNominationKey, publication);
      const outcome = await execute(issued.stage, issued.program, signal);
      assertBinding(outcome, candidate, cutoff, "rehydration", evidenceRoot(candidate));
      if (outcome.kind !== "verified") return Object.freeze({ kind: "requiresAttestation" as const });
      const proof = decodeExactObject(outcome.output, {
        kind: (item, path) => { if (item !== "verifiedMemoReuseProof") throw new TypeError(`${path} kind mismatch`); return "verifiedMemoReuseProof" as const; },
        familyId: (item, path) => assertNonEmptyString(item, path),
        familyDefinitionHash: (item, path) => assertHash(item, path),
        familyCandidateKey: (item, path) => assertHash(item, path),
        candidateSubjectHash: (item, path) => assertHash(item, path),
        instanceNominationKey: (item, path) => assertNonEmptyString(item, path),
        cutoff: (item, path) => decodeCanonicalCutoff(item, path),
        oldInstancePublicationHash: (item, path) => assertHash(item, path),
        requestedArtifactDependencyRoot: (item, path) => assertHash(item, path),
        descriptorHash: (item, path) => assertHash(item, path),
        validityDependencyRoot: (item, path) => assertHash(item, path),
        candidateToCanonicalIdentityBindingProof: (item, path) => assertHash(item, path),
        identityMemo: (item) => decodeCanonicalJson(encodeCanonicalJson(item)),
        identityMemoHash: (item, path) => assertHash(item, path),
        evidenceRoot: (item, path) => assertHash(item, path),
        proofHash: (item, path) => assertHash(item, path),
      }, "family.rehydration.output");
      const proofPayload = {
        kind: proof.kind,
        familyId: proof.familyId,
        familyDefinitionHash: proof.familyDefinitionHash,
        familyCandidateKey: proof.familyCandidateKey,
        candidateSubjectHash: proof.candidateSubjectHash,
        instanceNominationKey: proof.instanceNominationKey,
        cutoff: proof.cutoff,
        oldInstancePublicationHash: proof.oldInstancePublicationHash,
        requestedArtifactDependencyRoot: proof.requestedArtifactDependencyRoot,
        descriptorHash: proof.descriptorHash,
        validityDependencyRoot: proof.validityDependencyRoot,
        candidateToCanonicalIdentityBindingProof: proof.candidateToCanonicalIdentityBindingProof,
        identityMemo: proof.identityMemo,
        identityMemoHash: proof.identityMemoHash,
        evidenceRoot: proof.evidenceRoot,
      } as const;
      if (
        proof.familyId !== candidate.familyId
        || proof.familyDefinitionHash !== candidate.familyDefinitionHash
        || proof.familyCandidateKey !== candidate.familyCandidateKey
        || proof.candidateSubjectHash !== candidate.candidateSubjectHash
        || proof.instanceNominationKey !== candidate.instanceNominationKey
        || encodeCanonicalJson(proof.cutoff) !== encodeCanonicalJson(cutoff)
        || proof.oldInstancePublicationHash !== publication.instancePublicationHash
        || proof.requestedArtifactDependencyRoot !== publication.requestedArtifactDependencyRoot
        || proof.descriptorHash !== publication.descriptorHash
        || proof.validityDependencyRoot !== publication.validityDependencyRoot
        || proof.identityMemoHash !== hashDomain("aloha/identity-memo/v1", proof.identityMemo)
        || proof.evidenceRoot !== candidate.candidateEvidenceRoot
        || proof.proofHash !== hashDomain("aloha/verified-memo-reuse-proof/v1", proofPayload)
      ) return Object.freeze({ kind: "requiresAttestation" as const });
      const expectedIdentityBinding = hashDomain("aloha/candidate-to-canonical-identity-binding/v1", {
        familyId: proof.familyId,
        familyDefinitionHash: proof.familyDefinitionHash,
        familyCandidateKey: proof.familyCandidateKey,
        candidateSubjectHash: proof.candidateSubjectHash,
        instanceNominationKey: proof.instanceNominationKey,
        cutoff: proof.cutoff,
        oldInstancePublicationHash: proof.oldInstancePublicationHash,
        identityMemoHash: proof.identityMemoHash,
        descriptorHash: proof.descriptorHash,
      });
      if (proof.candidateToCanonicalIdentityBindingProof !== expectedIdentityBinding) {
        return Object.freeze({ kind: "requiresAttestation" as const });
      }
      const identity = identityObservation({
        kind: "identityVerified",
        familyInstanceKey: proof.instanceNominationKey,
        identityMemo: proof.identityMemo,
        identityMemoHash: proof.identityMemoHash,
        descriptorHash: proof.descriptorHash,
        evidenceRoot: proof.evidenceRoot,
      }, "family.rehydration.identity");
      return Object.freeze({ kind: "reusable" as const, identity, proof });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return Object.freeze({ kind: "requiresAttestation" as const });
    }
  };

  const materializeAndProject = async (
    candidate: CandidateRecordV1,
    identityResult: IdentityVerifiedV1,
    cutoff: CanonicalCutoffV1,
    signal: AbortSignal,
  ): Promise<InstanceDecisionV1> => {
    try {
      const materializationIssued = issue(
        candidate,
        cutoff,
        "materialization",
        identityResult.identityMemo,
        null,
        identityResult.familyInstanceKey,
        null,
      );
      const materializationOutcome = await execute(materializationIssued.stage, materializationIssued.program, signal);
      assertBinding(materializationOutcome, candidate, cutoff, "materialization", evidenceRoot(candidate));
      if (materializationOutcome.kind !== "verified") {
        if (materializationOutcome.kind === "retryable") {
          return Object.freeze({ kind: "retryable" as const, failure: failure(candidate, "materialization", materializationOutcome.failureCode, materializationOutcome.evidenceRoot, "retryable") });
        }
        return invalidInstanceDecision(candidate, "materialization", materializationOutcome.kind === "invalidProgram" ? materializationOutcome.code : "family-rejection-bridge-unavailable", materializationOutcome.evidenceRoot);
      }
      const projectionIssued = issue(
        candidate,
        cutoff,
        "projection",
        identityResult.identityMemo,
        materializationValue(materializationOutcome.output, "family.materialization.output"),
        identityResult.familyInstanceKey,
        null,
      );
      const projectionOutcome = await execute(projectionIssued.stage, projectionIssued.program, signal);
      assertBinding(projectionOutcome, candidate, cutoff, "projection", evidenceRoot(candidate));
      if (projectionOutcome.kind !== "verified") {
        if (projectionOutcome.kind === "retryable") {
          return Object.freeze({ kind: "retryable" as const, failure: failure(candidate, "projection", projectionOutcome.failureCode, projectionOutcome.evidenceRoot, "retryable") });
        }
        return invalidInstanceDecision(candidate, "projection", projectionOutcome.kind === "invalidProgram" ? projectionOutcome.code : "family-rejection-bridge-unavailable", projectionOutcome.evidenceRoot);
      }
      const publication = publicationValue(projectionOutcome.output, "family.projection.output");
      validateVerifiedPublication(candidate, identityResult, cutoff, publication);
      return Object.freeze({ kind: "verified" as const, publication });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      return invalidInstanceDecision(candidate, "materialization", error instanceof Error ? error.message : "family-lifecycle-adapter-error", evidenceRoot(candidate));
    }
  };

  return Object.freeze({ attestIdentity: identity, reuseVerifiedMemo, materializeAndProject });
}

export type { FamilyRuntimeCompositionV1 } from "../../../family-composition/src/index.ts";
