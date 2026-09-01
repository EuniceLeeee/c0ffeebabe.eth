import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type Hash,
} from "../../../canonical-codec/src/index.ts";
import { assertIssuedCandidatePartitionReader } from "../../../candidate-partition-runtime/src/internal/reader-consumer.ts";
import {
  candidatePartitionRoot,
  runCandidateKey,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../../discovery/src/index.ts";
import type { FamilyRawEvidenceReadPortV1 } from "../../../family-sdk/runtime/index.ts";
import type {
  CandidatePartitionCapabilityV1,
  CandidatePartitionReaderPortV1,
} from "../../../../specs/candidate-partition-authority/src/index.ts";
import { candidatePartitionKeysRoot } from "../../../../specs/candidate-partition-authority/src/index.ts";
import {
  type AttestationCompositionResolvedV2,
  type AttestationIdentityIssuerProofV1,
  type AttestationIdentityOriginV1,
} from "../internal-authority.ts";
import {
  ATTESTATION_STAGES,
  FRAMEWORK_FAILURE_CLASSES,
  FRAMEWORK_ISSUER_ID,
  REJECTION_ISSUER_ID,
  attestationPartialIdentitySemanticHash,
  bytesToHex,
  candidateFinalOutcomeHash,
  compareText,
  contextMatchesEvidence,
  decodeFrameworkFailureBinding,
  effectObservationRoot,
  evidenceBundleRoot,
  evidenceBundleWithoutRoot,
  exactObject,
  frameworkContextMatches,
  frameworkFailureTokenHash,
  freezeCandidateRecord,
  freezeRawEffectObservation,
  freezeRawTransportRecord,
  freezeRejectionContext,
  freezeRequestRecord,
  identityProofVerificationContext,
  orderedTransportFactsRoot,
  rejectionContextValues,
  rejectionProgramId,
  rejectionProofFromEvidence,
  rejectionTokenHash,
  requestFingerprint,
  assertNativeBytes,
  validateEvidenceBundle,
  validateIdentityObservation,
  validateVerifiedPublication,
  validateCutoff,
  validateProbeReceipt,
  verifiedIdentitySubjectHash,
  type AttestationFinalSessionResultV1,
  type AttestationIdentityContinuationV1,
  type AttestationIdentitySessionResultV1,
  type AttestationOutcomeCapabilityV1,
  type AttestationOutcomeResumeCapabilityV1,
  type AttestationVerifiedMemoReuseCapabilityV1,
  type AttestationPartitionCapabilityV1,
  type AttestationPersistenceBatchClaimV1,
  type AttestationPersistenceCapabilityV1,
  type AttestationProgramPort,
  type AttestationRunSessionInputV1,
  type AttestationRunSessionV1,
  type AttestationServiceConstructorV1,
  type AttestationServiceV1,
  type AttestationStageV1,
  type AttestationWriterCapabilityV1,
  type CandidateFinalOutcomeBodyV1,
  type CandidateFinalOutcomeV1,
  type ExecutorAuthoritySnapshotV1,
  type FrameworkFailureBindingV1,
  type FrameworkFailureClassifierPort,
  type FrameworkFailureContextV1,
  type FrameworkFailureIssuerPort,
  type FrameworkFailureRuntimePort,
  type FrameworkFailureTokenV1,
  type FrozenProgramExecutionViewV1,
  type GeneratedFactSetV1,
  type IdentityDecisionV1,
  type IdentityVerifiedObservationV1,
  type IdentityVerifiedV1,
  type InstanceDecisionV1,
  type InstanceLifecycleSingleFlightPort,
  type IssuedRejectionFactTokenV1,
  type ProbeReceiptV1,
  type RetryableProbeCapabilityV1,
  type ProbeStorePort,
  type PersistedRequestRecordV1,
  type ReadonlyFactSetViewV1,
  type RejectionEvidenceBundleV2,
  type RejectionExecutorAuthorityIssuerV1,
  type RejectionExecutorCapabilityV1,
  type RejectionFactContextV1,
  type RejectionFactProgramBuilderPort,
  type RejectionFactRuntimePort,
  type RejectionFactTokenV1,
  type RejectionFactWorkPlanePort,
  type RejectionTransportExecutorV1,
} from "../index.ts";
import {
  bindOutcomeAuthority,
  bindPartitionAuthority,
  issueAttestationValidationAuthority,
  verifyOutcomeForAuthority,
  verifyIdentityForAuthority,
} from "./validation-authority-issuer.ts";
import {
  attestationIdentityResumeStates,
  attestationOutcomeResumeStates,
  attestationVerifiedMemoReuseStates,
  consumedAttestationIdentityResumeCapabilities,
  consumedAttestationOutcomeResumeCapabilities,
  consumedAttestationVerifiedMemoReuseCapabilities,
  registerAttestationOutcomeCapability,
  registerAttestationService,
  type AttestationAuthorityStateV1,
  type AttestationIdentityResumeStateV1,
  type AttestationOutcomeResumeStateV1,
  type AttestationVerifiedMemoReuseStateV1,
  type AttestationWriterConsumerV1,
} from "./validation-authority-state.ts";
import { validateIdentityIssuerProof } from "./identity-proof.ts";

interface ExecutorAuthorityLeaseV1 {
  readonly authorityRoot: Hash;
  workerEpoch: string;
  executorSessionHash: Hash;
  version: bigint;
  active: boolean;
}

interface ExecutorCapabilityStateV1 {
  readonly executor: RejectionTransportExecutorV1;
  readonly authority: ExecutorAuthoritySnapshotV1;
  readonly lease: ExecutorAuthorityLeaseV1;
  readonly leaseVersion: bigint;
}

// These registries are intentionally module-private.  A JSON/object clone of
// either capability or runtime is not a capability, even when every visible
// field and hash is copied exactly.
const executorCapabilityStates = new WeakMap<object, ExecutorCapabilityStateV1>();
const rejectionRuntimeBrands = new WeakSet<object>();
const frameworkRuntimeBrands = new WeakSet<object>();
const frameworkRuntimeStates = new WeakMap<object, { readonly authorityRoot: Hash }>();
interface RejectionFactRuntimeStateV1 {
  readonly executorAuthority: ExecutorAuthoritySnapshotV1;
  readonly validateDecision: (
    decision: {
      readonly rejectionFacts: RejectionFactTokenV1;
      readonly decisionCode: string;
      readonly decisionBytes: Uint8Array;
    },
    context: RejectionFactContextV1,
  ) => RejectionEvidenceBundleV2;
}
const rejectionRuntimeStates = new WeakMap<object, RejectionFactRuntimeStateV1>();

async function observeIdentity(
  programs: AttestationProgramPort,
  candidate: CandidateRecordV1,
  cutoff: CanonicalCutoffV1,
  signal: AbortSignal,
  rawEvidence: FamilyRawEvidenceReadPortV1,
): Promise<IdentityDecisionV1> {
  const decision = await programs.attestIdentity(candidate, cutoff, signal, rawEvidence);
  return decision.kind === "identityVerified"
    ? validateIdentityObservation(decision, "attestation.identity")
    : decision;
}

async function observeInstance(
  runId: string,
  programs: AttestationProgramPort,
  instanceLifecycle: InstanceLifecycleSingleFlightPort,
  candidate: CandidateRecordV1,
  identity: IdentityVerifiedObservationV1,
  cutoff: CanonicalCutoffV1,
  signal: AbortSignal,
  rawEvidence: FamilyRawEvidenceReadPortV1,
): Promise<InstanceDecisionV1> {
  const programIdentity = validateIdentityObservation({
    kind: identity.kind,
    familyInstanceKey: identity.familyInstanceKey,
    identityMemo: identity.identityMemo,
    identityMemoHash: identity.identityMemoHash,
    descriptorHash: identity.descriptorHash,
    evidenceRoot: identity.evidenceRoot,
  }, "attestation.materializationIdentity");
  const decision = await instanceLifecycle.getOrBuild(
    hashDomain("aloha/instance-lifecycle-work/v1", {
      runId,
      familyDefinitionHash: candidate.familyDefinitionHash,
      familyInstanceKey: programIdentity.familyInstanceKey,
      cutoff,
    }),
    () => programs.materializeAndProject(candidate, programIdentity, cutoff, signal, rawEvidence),
  );
  if (decision.kind === "verified") {
    validateVerifiedPublication(candidate, programIdentity, cutoff, decision.publication);
  }
  return decision;
}

interface IdentityGroupMemberV1<T> {
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly familyInstanceKey: string;
  readonly value: T;
}

interface IdentityGroupV1<T> {
  readonly groupKey: Hash;
  readonly members: readonly IdentityGroupMemberV1<T>[];
}

function assertIdentityBarrier(
  expectedCandidateKeys: readonly Hash[],
  resolvedCandidateKeys: readonly Hash[],
): void {
  const expected = [...expectedCandidateKeys].sort();
  const resolved = [...resolvedCandidateKeys].sort();
  if (
    new Set(expected).size !== expected.length
    || new Set(resolved).size !== resolved.length
    || expected.length !== resolved.length
    || expected.some((key, index) => key !== resolved[index])
  ) throw new TypeError("attestation-identity-phase-incomplete");
}

function groupVerifiedIdentities<T>(
  members: readonly IdentityGroupMemberV1<T>[],
): readonly IdentityGroupV1<T>[] {
  const groups = new Map<Hash, IdentityGroupMemberV1<T>[]>();
  for (const member of members) {
    const groupKey = hashDomain("aloha/attestation-identity-group/v1", {
      familyDefinitionHash: member.familyDefinitionHash,
      familyInstanceKey: member.familyInstanceKey,
    });
    const group = groups.get(groupKey) ?? [];
    group.push(member);
    groups.set(groupKey, group);
  }
  return Object.freeze([...groups.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([groupKey, group]) => Object.freeze({
      groupKey,
      members: Object.freeze(group.sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey))
        .map(member => Object.freeze({ ...member }))),
    })));
}

function collisionEvidenceRoot<T>(group: IdentityGroupV1<T>): Hash {
  if (group.members.length < 2) throw new TypeError("attestation-collision-group-too-small");
  return hashDomain("aloha/nomination-key-collision/v1", group.members.map(member => ({
    familyCandidateKey: member.familyCandidateKey,
    familyInstanceKey: member.familyInstanceKey,
  })));
}

function capabilityLeaseIsActive(state: ExecutorCapabilityStateV1): boolean {
  return state.lease.active
    && state.lease.version === state.leaseVersion
    && state.authority.authorityRoot === state.lease.authorityRoot
    && state.authority.workerEpoch === state.lease.workerEpoch
    && state.authority.executorSessionHash === state.lease.executorSessionHash;
}

function normalizeExecutorAuthority(
  value: unknown,
  context: string,
): ExecutorAuthoritySnapshotV1 {
  const authority = exactObject(value, ["authorityRoot", "workerEpoch", "executorSessionHash"], context);
  return deepFreeze({
    authorityRoot: assertHash(authority.authorityRoot, `${context}.authorityRoot`),
    workerEpoch: assertNonEmptyString(authority.workerEpoch, `${context}.workerEpoch`),
    executorSessionHash: assertHash(authority.executorSessionHash, `${context}.executorSessionHash`),
  });
}

/**
 * Construct the scheduler-owned issuer for one worker epoch/session.  The
 * issuer is the only place where a transport executor becomes a trusted
 * authority capability.  Family code receives only the resulting capability
 * through composition and never receives this issuer.
 */
export function createRejectionExecutorAuthorityIssuerInternal(
  seed: AttestationCompositionResolvedV2,
): RejectionExecutorAuthorityIssuerV1 {
  const approval = seed.provenance.runtimeBinding;
  const initial = normalizeExecutorAuthority({
    authorityRoot: approval.executorAuthorityRoot,
    workerEpoch: approval.workerEpoch,
    executorSessionHash: approval.executorSessionHash,
  }, "rejectionExecutorAuthority");
  const lease: ExecutorAuthorityLeaseV1 = {
    authorityRoot: initial.authorityRoot,
    workerEpoch: initial.workerEpoch,
    executorSessionHash: initial.executorSessionHash,
    version: 0n,
    active: true,
  };
  const currentSnapshot = (): ExecutorAuthoritySnapshotV1 => deepFreeze({
    authorityRoot: lease.authorityRoot,
    workerEpoch: lease.workerEpoch,
    executorSessionHash: lease.executorSessionHash,
  });
  const issuer = {
    issue(executor: RejectionTransportExecutorV1): RejectionExecutorCapabilityV1 {
      if (
        executor === null
        || typeof executor !== "object"
        || typeof executor.execute !== "function"
      ) throw new TypeError("rejection executor is invalid");
      // The issuer keeps the executable object and the active bit out of the
      // capability's serializable surface.
      if (!lease.active) throw new TypeError("rejection-executor-authority-revoked");
      const snapshot = currentSnapshot();
      const capability = deepFreeze({
        authorityRoot: snapshot.authorityRoot,
        workerEpoch: snapshot.workerEpoch,
        executorSessionHash: snapshot.executorSessionHash,
      });
      executorCapabilityStates.set(capability, {
        executor,
        authority: snapshot,
        lease,
        leaseVersion: lease.version,
      });
      return capability;
    },
    revoke(): void {
      lease.active = false;
    },
    rotate(next: { readonly workerEpoch: string; readonly executorSessionHash: Hash }): void {
      if (!lease.active) throw new TypeError("rejection-executor-authority-revoked");
      lease.workerEpoch = assertNonEmptyString(next.workerEpoch, "rejectionExecutorAuthority.workerEpoch");
      lease.executorSessionHash = assertHash(next.executorSessionHash, "rejectionExecutorAuthority.executorSessionHash");
      lease.version += 1n;
    },
  } satisfies RejectionExecutorAuthorityIssuerV1;
  return Object.freeze(issuer);
}

/**
 * The work-plane is the only terminal-rejection authority.  It accepts a
 * framework-created program capability and the executor captured at runtime
 * construction; there is deliberately no public `issue()` or `seal()` API.
 * Raw executor output is converted to canonical child records inside this
 * closure, then a process-local token is handed to the Family interpreter.
 */
export function createRejectionFactRuntimeInternal(
  capability: RejectionExecutorCapabilityV1,
): RejectionFactRuntimePort {
  if (capability === null || typeof capability !== "object") {
    throw new TypeError("rejection-executor-capability-invalid");
  }
  const capabilityState = executorCapabilityStates.get(capability);
  if (!capabilityState) throw new TypeError("rejection-executor-capability-not-issued");
  if (!capabilityLeaseIsActive(capabilityState)) {
    throw new TypeError("rejection-executor-capability-stale-or-revoked");
  }
  const authority = capabilityState.authority;
  const programs = new WeakMap<object, {
    readonly programId: Hash;
    readonly context: RejectionFactContextV1;
    readonly request: PersistedRequestRecordV1;
  }>();
  const sessions = new WeakMap<object, {
    readonly programId: Hash;
    readonly sessionHash: Hash;
    readonly context: RejectionFactContextV1;
    readonly facts: GeneratedFactSetV1;
  }>();
  const issuedTokens = new WeakSet<object>();
  const consumedTokens = new WeakSet<object>();
  const tokenSessions = new WeakMap<object, object>();
  const evidenceByToken = new WeakMap<object, RejectionEvidenceBundleV2>();
  let nextSession = 0n;

  const builder: RejectionFactProgramBuilderPort = {
    freezeProgram(input) {
      if (input === null || typeof input !== "object") throw new TypeError("rejection program is invalid");
      const context = freezeRejectionContext(input.context, "rejection.program.context");
      const request = freezeRequestRecord(input.request, "rejection.program.request");
      const programId = rejectionProgramId(context, request, authority);
      const capability = deepFreeze({ programId });
      programs.set(capability, { programId, context, request });
      return capability;
    },
  };

  const executeAndInterpret: RejectionFactWorkPlanePort["executeAndInterpret"] = async (
    program,
    interpret,
    signal,
  ) => {
    if (program === null || typeof program !== "object") throw new TypeError("rejection-program-capability-invalid");
    const state = programs.get(program);
    if (!state) throw new TypeError("rejection-program-capability-not-issued");
    if (!capabilityLeaseIsActive(capabilityState)) throw new TypeError("rejection-executor-capability-stale-or-revoked");
    if (signal.aborted) throw signal.reason;
    const recomputedProgramId = rejectionProgramId(state.context, state.request, authority);
    if (recomputedProgramId !== state.programId || program.programId !== state.programId) {
      throw new TypeError("rejection-program-id-mismatch");
    }
    const executionView: FrozenProgramExecutionViewV1 = deepFreeze({
      programId: state.programId,
      context: state.context,
      request: state.request,
      executorAuthorityRoot: authority.authorityRoot,
      workerEpoch: authority.workerEpoch,
      executorSessionHash: authority.executorSessionHash,
    });
    const raw = await capabilityState.executor.execute(executionView, signal);
    if (raw === null || typeof raw !== "object") throw new TypeError("rejection-executor-result-invalid");
    assertExactKeys(raw, ["transport", "effects"], "rejection.executorResult");
    if (!Array.isArray(raw.transport) || raw.transport.length === 0) {
      throw new TypeError("rejection.executorResult.transport must not be empty");
    }
    if (!Array.isArray(raw.effects)) throw new TypeError("rejection.executorResult.effects must be an array");
    const transportFacts = raw.transport.map((item, index) => freezeRawTransportRecord(
      item,
      `rejection.executorResult.transport[${index}]`,
      state.request.requestId,
      index,
      state.context.cutoff,
      authority,
    ));
    const effectObservations = raw.effects.map((item, index) => freezeRawEffectObservation(
      item,
      `rejection.executorResult.effects[${index}]`,
      state.request.requestId,
      index,
      state.context.cutoff,
      authority,
    ));
    const sessionHash = hashDomain("aloha/rejection-execution-session/v1", {
      programId: state.programId,
      sequence: String(nextSession++),
      requestFingerprint: requestFingerprint(state.request),
      orderedTransportFactsRoot: orderedTransportFactsRoot(transportFacts),
      effectObservationRoot: effectObservationRoot(effectObservations),
    });
    const facts: GeneratedFactSetV1 = Object.freeze({
      context: state.context,
      request: state.request,
      authority,
      executionSessionHash: sessionHash,
      transportFacts: deepFreeze(transportFacts),
      effectObservations: deepFreeze(effectObservations),
    });
    const session = Object.freeze({});
    sessions.set(session, {
      programId: state.programId,
      sessionHash,
      context: state.context,
      facts,
    });
    const tokenInput = deepFreeze({
      issuerId: REJECTION_ISSUER_ID,
      programId: state.programId,
      executionSessionHash: sessionHash,
      ...rejectionContextValues(state.context),
      executorAuthorityRoot: authority.authorityRoot,
      workerEpoch: authority.workerEpoch,
      executorSessionHash: authority.executorSessionHash,
      requestFingerprint: requestFingerprint(state.request),
      orderedTransportFactsRoot: orderedTransportFactsRoot(transportFacts),
      effectObservationRoot: effectObservationRoot(effectObservations),
    });
    const token = deepFreeze({ ...tokenInput, tokenHash: rejectionTokenHash(tokenInput) }) as IssuedRejectionFactTokenV1;
    issuedTokens.add(token);
    tokenSessions.set(token, session);
    const view: ReadonlyFactSetViewV1 = deepFreeze({
      programId: state.programId,
      runId: state.context.runId,
      stage: state.context.stage,
      request: state.request,
      executorAuthorityRoot: authority.authorityRoot,
      workerEpoch: authority.workerEpoch,
      executorSessionHash: authority.executorSessionHash,
      transportFacts: facts.transportFacts,
      effectObservations: facts.effectObservations,
      requestFingerprint: tokenInput.requestFingerprint,
      orderedTransportFactsRoot: tokenInput.orderedTransportFactsRoot,
      effectObservationRoot: tokenInput.effectObservationRoot,
    });
    const decision = await interpret(view, token);
    if (decision === null || typeof decision !== "object") throw new TypeError("rejection-interpreter-result-invalid");
    if ((decision as { readonly kind?: unknown }).kind !== "chainProvenRejected") {
      return { decision, rejectionEvidence: null };
    }
    const chainDecision = decision as unknown as {
      readonly kind: "chainProvenRejected";
      readonly rejectionFacts: unknown;
      readonly decisionCode: unknown;
      readonly decisionBytes: unknown;
    };
    if (chainDecision.rejectionFacts !== token) throw new TypeError("rejection-interpreter-token-mismatch");
    const decisionCode = assertNonEmptyString(chainDecision.decisionCode, "rejection.decisionCode");
    const decisionBytes = assertNativeBytes(chainDecision.decisionBytes, "rejection.decisionBytes");
    const evidenceWithoutRoot = evidenceBundleWithoutRoot(facts, decisionCode, decisionBytes);
    const evidence = deepFreeze({
      ...evidenceWithoutRoot,
      evidenceBundleRoot: evidenceBundleRoot(evidenceWithoutRoot),
    });
    const sessionForToken = tokenSessions.get(token);
    if (!sessionForToken || sessions.get(sessionForToken)?.programId !== state.programId) {
      throw new TypeError("rejection-execution-session-mismatch");
    }
    evidenceByToken.set(token, evidence);
    return {
      decision,
      rejectionEvidence: evidence,
    };
  };

  const validateDecision: RejectionFactRuntimeStateV1["validateDecision"] = (decision, context) => {
    if (decision === null || typeof decision !== "object") {
      throw new TypeError("rejection-decision-invalid");
    }
    assertExactKeys(
      decision,
      ["rejectionFacts", "decisionCode", "decisionBytes"],
      "rejectionDecision",
    );
    const token = decision.rejectionFacts;
    if (
      token === null
      || typeof token !== "object"
      || !issuedTokens.has(token)
      || consumedTokens.has(token)
    ) throw new TypeError("rejection-fact-token-not-issued-or-consumed");
    const issued = token as IssuedRejectionFactTokenV1;
    assertExactKeys(issued, [
      "issuerId", "programId", "executionSessionHash", "runId", "chainId", "cutoffNumber",
      "cutoffHash", "cutoffStateRoot", "stage", "familyDefinitionHash", "familyCandidateKey",
      "candidateSubjectHash", "identitySubjectHash", "instanceNominationKey", "executorAuthorityRoot",
      "workerEpoch", "executorSessionHash", "requestFingerprint",
      "orderedTransportFactsRoot", "effectObservationRoot", "tokenHash",
    ], "rejectionFactToken");
    if (issued.issuerId !== REJECTION_ISSUER_ID) throw new TypeError("rejection-fact-issuer-mismatch");
    if (!capabilityLeaseIsActive(capabilityState)) throw new TypeError("rejection-executor-capability-stale-or-revoked");
    const sessionKey = tokenSessions.get(token);
    const session = sessionKey === undefined ? undefined : sessions.get(sessionKey);
    const evidence = evidenceByToken.get(token);
    if (!session || !evidence) throw new TypeError("rejection-fact-evidence-missing");
    validateEvidenceBundle(evidence, "rejectionFact.evidence");
    contextMatchesEvidence(evidence, context);
    const expectedContext = rejectionContextValues(context);
    for (const field of [
      "runId", "chainId", "cutoffNumber", "cutoffHash", "cutoffStateRoot", "stage",
      "familyDefinitionHash", "familyCandidateKey", "candidateSubjectHash",
      "identitySubjectHash", "instanceNominationKey",
    ] as const) {
      if (issued[field] !== expectedContext[field]) throw new TypeError("rejection-fact-token-context-mismatch");
    }
    if (
      issued.executorAuthorityRoot !== authority.authorityRoot
      || issued.workerEpoch !== authority.workerEpoch
      || issued.executorSessionHash !== authority.executorSessionHash
      || evidence.executorAuthorityRoot !== authority.authorityRoot
      || evidence.workerEpoch !== authority.workerEpoch
      || evidence.executorSessionHash !== authority.executorSessionHash
      || evidence.executionSessionHash !== issued.executionSessionHash
    ) throw new TypeError("rejection-fact-source-authority-mismatch");
    if (
      issued.programId !== session.programId
      || issued.executionSessionHash !== session.sessionHash
      || issued.requestFingerprint !== evidence.requestFingerprint
      || issued.orderedTransportFactsRoot !== evidence.orderedTransportFactsRoot
      || issued.effectObservationRoot !== evidence.effectObservationRoot
    ) throw new TypeError("rejection-fact-token-evidence-mismatch");
    const { tokenHash, ...tokenInput } = issued;
    if (tokenHash !== rejectionTokenHash(tokenInput)) {
      throw new TypeError("rejection-fact-token-hash-mismatch");
    }
    const decisionCode = assertNonEmptyString(decision.decisionCode, "rejectionDecision.decisionCode");
    const decisionBytesHex = bytesToHex(assertNativeBytes(
      decision.decisionBytes,
      "rejectionDecision.decisionBytes",
    ));
    if (
      decisionCode !== evidence.decisionCode
      || decisionBytesHex !== evidence.decisionBytesHex
    ) throw new TypeError("rejection-decision-evidence-mismatch");
    consumedTokens.add(token);
    return evidence;
  };

  const runtime = Object.freeze({
    workPlane: Object.freeze({ builder: Object.freeze(builder), executeAndInterpret }),
  });
  rejectionRuntimeBrands.add(runtime);
  rejectionRuntimeStates.set(runtime, { validateDecision, executorAuthority: authority });
  return runtime;
}

/**
 * Create the only issuer accepted by the constructor-bound AttestationService. The opaque
 * WeakSet membership prevents a plugin from cloning a token-shaped object;
 * the content-addressed binding remains available in the durable outcome.
 */
export function createFrameworkFailureRuntimeInternal(
  seed: AttestationCompositionResolvedV2,
  classifier: FrameworkFailureClassifierPort,
): FrameworkFailureRuntimePort {
  const issuerRoot = seed.provenance.runtimeBinding.frameworkAuthorityRoot;
  const issuedTokens = new WeakSet<object>();
  const issuer: FrameworkFailureIssuerPort = {
    issue(input) {
      const context = input.context;
      const stage = context.stage;
      if (!ATTESTATION_STAGES.includes(stage)) throw new TypeError("framework-failure-stage-invalid");
      if (!FRAMEWORK_FAILURE_CLASSES.includes(input.failureClass)) {
        throw new TypeError("framework-failure-class-invalid");
      }
      const attemptCount = assertDecimalString(input.attemptCount, "frameworkFailure.attemptCount");
      if (attemptCount === "0") throw new TypeError("framework-failure-attempt-invalid");
      const tokenInput: Omit<FrameworkFailureBindingV1, "tokenHash"> = deepFreeze({
        issuerId: FRAMEWORK_ISSUER_ID,
        authorityRoot: issuerRoot,
        runId: assertNonEmptyString(context.runId, "frameworkFailure.runId"),
        familyCandidateKey: assertHash(context.candidate.familyCandidateKey, "frameworkFailure.familyCandidateKey"),
        candidateSubjectHash: assertHash(context.candidate.candidateSubjectHash, "frameworkFailure.candidateSubjectHash"),
        stage,
        failureClass: input.failureClass,
        failureCode: assertNonEmptyString(input.failureCode, "frameworkFailure.failureCode"),
        attemptCount,
        evidenceRoot: assertHash(input.evidenceRoot, "frameworkFailure.evidenceRoot"),
      });
      const token = deepFreeze({ ...tokenInput, tokenHash: frameworkFailureTokenHash(tokenInput) });
      issuedTokens.add(token);
      return token;
    },
    validate(value, context) {
      if (value === null || typeof value !== "object" || !issuedTokens.has(value)) {
        throw new TypeError("framework-failure-token-not-issued");
      }
      const binding = decodeFrameworkFailureBinding(value, "frameworkFailureToken");
      if (binding.authorityRoot !== issuerRoot) throw new TypeError("framework-failure-authority-mismatch");
      frameworkContextMatches(binding, context);
      return binding;
    },
  };
  const runtime = Object.freeze({ issuer, classifier });
  frameworkRuntimeBrands.add(runtime);
  frameworkRuntimeStates.set(runtime, { authorityRoot: issuerRoot });
  return runtime;
}

const outcomeFor = (
  runId: string,
  candidate: CandidateRecordV1,
  cutoff: CanonicalCutoffV1,
  decision: Exclude<IdentityDecisionV1, IdentityVerifiedObservationV1> | InstanceDecisionV1,
  frameworkRuntime: FrameworkFailureRuntimePort | null,
  rejectionValidator: RejectionFactRuntimeStateV1["validateDecision"] | null,
  expectedStage: Exclude<AttestationStageV1, "framework">,
  expectedIdentitySubjectHash: Hash | null,
  identityProof: AttestationIdentityIssuerProofV1 | null,
): CandidateFinalOutcomeBodyV1 => {
  const key = runCandidateKey(runId, candidate.familyCandidateKey);
  switch (decision.kind) {
    case "verified":
      if (identityProof === null) throw new TypeError("verified-outcome-identity-proof-missing");
      return deepFreeze({
        kind: "verified",
        runCandidateKey: key,
        familyCandidateKey: candidate.familyCandidateKey,
        instanceKey: decision.publication.instanceKey,
        publication: decision.publication,
        identityProof,
      });
    case "chainProvenRejected":
      {
        if (!rejectionValidator) throw new Error("rejection-fact-validator-missing");
        const rejectionEvidence = rejectionValidator({
          rejectionFacts: decision.rejectionFacts,
          decisionCode: decision.decisionCode,
          decisionBytes: decision.decisionBytes,
        }, {
          runId,
          candidate,
          cutoff,
          stage: expectedStage,
          identitySubjectHash: expectedIdentitySubjectHash,
        });
        const proof = rejectionProofFromEvidence(rejectionEvidence);
        if (
          proof.stage !== expectedStage
          || proof.familyDefinitionHash !== candidate.familyDefinitionHash
          || proof.familyCandidateKey !== candidate.familyCandidateKey
          || proof.chainId !== cutoff.chainId
          || proof.cutoffNumber !== cutoff.number
          || proof.cutoffHash !== cutoff.hash
          || proof.cutoffStateRoot !== cutoff.stateRoot
          || proof.candidateSubjectHash !== candidate.candidateSubjectHash
        ) throw new Error("rejection-proof-candidate-mismatch");
        return deepFreeze({
          kind: decision.kind,
          runCandidateKey: key,
          familyCandidateKey: candidate.familyCandidateKey,
          proof,
          rejectionEvidence,
          identityProof,
        });
      }
    case "retryable":
      if (decision.failure.stage !== expectedStage) throw new Error("framework-failure-stage-mismatch");
      if (
        decision.failure.failureCode.length === 0
        || !/^[1-9][0-9]*$/.test(decision.failure.attemptCount)
        || decision.failure.candidateSubjectHash !== candidate.candidateSubjectHash
        || decision.failure.evidenceRoot.length === 0
      ) throw new Error("failure-lineage-mismatch");
      if ("frameworkFailureToken" in decision) {
        if (!frameworkRuntime) throw new Error("framework-failure-runtime-missing");
        const binding = frameworkRuntime.issuer.validate(
          decision.frameworkFailureToken,
          { runId, candidate, cutoff, stage: expectedStage },
        );
        if (
          decision.failure.frameworkBinding !== null
          && encodeCanonicalJson(decision.failure.frameworkBinding) !== encodeCanonicalJson(binding)
        ) throw new Error("framework-failure-binding-mismatch");
        return deepFreeze({
          kind: decision.kind,
          runCandidateKey: key,
          familyCandidateKey: candidate.familyCandidateKey,
          failure: deepFreeze({ ...decision.failure, frameworkBinding: binding }),
          identityProof,
        });
      }
      if (decision.failure.frameworkBinding !== null) {
        throw new Error("plugin-framework-binding-without-issuer-token");
      }
      return deepFreeze({ kind: decision.kind, runCandidateKey: key, familyCandidateKey: candidate.familyCandidateKey, failure: decision.failure, identityProof });
    case "invalidProgram":
      if (
        decision.failure.stage !== expectedStage
        || decision.failure.failureCode.length === 0
        || !/^[1-9][0-9]*$/.test(decision.failure.attemptCount)
        || decision.failure.candidateSubjectHash !== candidate.candidateSubjectHash
        || decision.failure.evidenceRoot.length === 0
        || decision.failure.frameworkBinding !== null
      ) throw new Error("failure-lineage-mismatch");
      return deepFreeze({ kind: decision.kind, runCandidateKey: key, familyCandidateKey: candidate.familyCandidateKey, failure: decision.failure, identityProof });
  }
};

const frameworkFailure = (
  runId: string,
  candidate: CandidateRecordV1,
  cutoff: CanonicalCutoffV1,
  stage: Exclude<AttestationStageV1, "framework">,
  frameworkRuntime: FrameworkFailureRuntimePort,
  rejectionValidator: RejectionFactRuntimeStateV1["validateDecision"] | null,
  identityProof: AttestationIdentityIssuerProofV1 | null,
  thrown: unknown,
): CandidateFinalOutcomeBodyV1 => {
  const context: FrameworkFailureContextV1 = { runId, candidate, cutoff, stage };
  let classified: unknown = null;
  try {
    classified = frameworkRuntime.classifier.classify(thrown, context);
  } catch {
    classified = null;
  }
  if (classified !== null && classified !== undefined) {
    try {
      const binding = frameworkRuntime.issuer.validate(classified, context);
      return outcomeFor(runId, candidate, cutoff, {
        kind: "retryable",
        failure: {
          stage,
          failureCode: binding.failureCode,
          attemptCount: binding.attemptCount,
          candidateSubjectHash: candidate.candidateSubjectHash,
          evidenceRoot: binding.evidenceRoot,
          frameworkBinding: binding,
        },
        frameworkFailureToken: classified as FrameworkFailureTokenV1,
      }, frameworkRuntime, rejectionValidator, stage, null, identityProof);
    } catch {
      // A classifier result without the issuer's exact authority is a
      // program defect, never a retryable transport result.
    }
  }
  return outcomeFor(runId, candidate, cutoff, {
    kind: "invalidProgram",
    failure: {
      stage,
      failureCode: "plugin-program-threw",
      attemptCount: "1",
      candidateSubjectHash: candidate.candidateSubjectHash,
      evidenceRoot: candidate.candidateEvidenceRoot,
      frameworkBinding: null,
    },
  }, frameworkRuntime, rejectionValidator, stage, null, identityProof);
};

function resolveRejectionTerminalValidator(
  runtime: RejectionFactRuntimePort,
): RejectionFactRuntimeStateV1["validateDecision"] {
  if (
    runtime === null
    || typeof runtime !== "object"
    || !rejectionRuntimeBrands.has(runtime)
  ) throw new TypeError("rejection-fact-runtime-not-issued");
  const state = rejectionRuntimeStates.get(runtime);
  if (!state) throw new TypeError("rejection-fact-runtime-state-missing");
  return state.validateDecision;
}

function resolveRejectionAuthority(
  runtime: RejectionFactRuntimePort,
): ExecutorAuthoritySnapshotV1 {
  if (
    runtime === null
    || typeof runtime !== "object"
    || !rejectionRuntimeBrands.has(runtime)
  ) throw new TypeError("rejection-fact-runtime-not-issued");
  const state = rejectionRuntimeStates.get(runtime);
  if (!state) throw new TypeError("rejection-fact-runtime-state-missing");
  return state.executorAuthority;
}

function resolveFrameworkAuthorityRoot(
  runtime: FrameworkFailureRuntimePort,
): Hash {
  if (
    runtime === null
    || typeof runtime !== "object"
    || !frameworkRuntimeBrands.has(runtime)
  ) throw new TypeError("framework-failure-runtime-not-issued");
  const state = frameworkRuntimeStates.get(runtime);
  if (!state) throw new TypeError("framework-failure-runtime-state-missing");
  return state.authorityRoot;
}

function deriveAttestationAuthorityRoot(composition: AttestationCompositionResolvedV2): Hash {
  const binding = composition.provenance.runtimeBinding;
  return hashDomain("aloha/attestation-authority/v3", {
    releaseProvenanceHash: composition.provenance.releaseProvenanceHash,
    releaseAuthorityRoot: binding.releaseAuthorityRoot,
    frameworkAuthorityRoot: binding.frameworkAuthorityRoot,
    executorAuthorityRoot: binding.executorAuthorityRoot,
    workerEpoch: binding.workerEpoch,
    executorSessionHash: binding.executorSessionHash,
  });
}

/**
 * Bind the framework and terminal authorities once.  The returned service is
 * the only public partition entry point; a run cannot replace its rejection
 * validator or executor authority by passing a different object per call.
 */
export function createAttestationServiceInternal(
  input: Omit<AttestationServiceConstructorV1, "composition"> & {
      readonly composition: AttestationCompositionResolvedV2;
    readonly candidatePartitionReader: CandidatePartitionReaderPortV1;
  },
): AttestationServiceV1 {
  if (input === null || typeof input !== "object") {
    throw new TypeError("attestation-service-constructor-invalid");
  }
  const candidatePartitionReader = assertIssuedCandidatePartitionReader(input.candidatePartitionReader);
  const frameworkRuntime = input.frameworkRuntime;
  if (frameworkRuntime === null || typeof frameworkRuntime !== "object") {
    throw new TypeError("attestation-service-framework-runtime-invalid");
  }
  const composition = input.composition;
  const provenance = composition.provenance;
  const releaseBinding = provenance.runtimeBinding;
  const frameworkAuthorityRoot = resolveFrameworkAuthorityRoot(frameworkRuntime);
  const executorAuthority = resolveRejectionAuthority(input.rejectionRuntime);
  if (
    releaseBinding.frameworkAuthorityRoot !== frameworkAuthorityRoot
    || releaseBinding.executorAuthorityRoot !== executorAuthority.authorityRoot
    || releaseBinding.workerEpoch !== executorAuthority.workerEpoch
    || releaseBinding.executorSessionHash !== executorAuthority.executorSessionHash
  ) throw new TypeError("attestation-composition-authority-mismatch");
  const authorityState: AttestationAuthorityStateV1 = {
    authorityRoot: deriveAttestationAuthorityRoot(composition),
    releaseAuthorityRoot: releaseBinding.releaseAuthorityRoot,
    releaseProvenanceHash: provenance.releaseProvenanceHash,
    frameworkAuthorityRoot,
    executorAuthorityRoot: executorAuthority.authorityRoot,
    attestationProof: provenance.attestationProof,
    attestationProofIssuerKeyId: releaseBinding.attestationProofIssuerKeyId,
    outcomeCapabilities: new WeakSet<object>(),
    partitionCapabilities: new WeakSet<object>(),
    resumeCapabilities: new WeakSet<object>(),
    writerConsumers: new WeakMap<object, AttestationWriterConsumerV1>(),
  };
  const validationAuthority = issueAttestationValidationAuthority(authorityState);
  const rejectionValidator = resolveRejectionTerminalValidator(input.rejectionRuntime);
  const service = {
    validationAuthority,
    openRunSession(sessionInput: AttestationRunSessionInputV1): AttestationRunSessionV1 {
      return createAttestationRunSession(
        sessionInput,
        candidatePartitionReader,
        input.programs,
        input.instanceLifecycle,
        frameworkRuntime,
        authorityState,
        rejectionValidator,
      );
    },
  } satisfies AttestationServiceV1;
  registerAttestationService(service, authorityState);
  return Object.freeze(service);
}

interface AttestationSessionPersistenceStateV1 {
  readonly runId: string;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly outcomeHash: Hash;
  readonly stage: "identity" | "materialization";
  readonly identity: IdentityVerifiedV1 | null;
  readonly outcome: AttestationOutcomeCapabilityV1 | null;
  readonly durability: "new" | "durable";
}

interface AttestationIdentityContinuationStateV1 {
  readonly runId: string;
  readonly candidatePartitionRoot: Hash;
  readonly familyCandidateKey: Hash;
  readonly candidateSubjectHash: Hash;
  readonly candidate: CandidateRecordV1;
  readonly identity: IdentityVerifiedV1;
  status: "pending" | "materializing" | "completed" | "collision";
  materializationPromise: Promise<AttestationFinalSessionResultV1> | null;
}

function issueIdentityWithProof(
  runId: string,
  cutoff: CanonicalCutoffV1,
  candidatePartitionRoot: Hash,
  candidate: CandidateRecordV1,
  observation: IdentityVerifiedObservationV1,
  identityOrigin: AttestationIdentityOriginV1,
  authority: AttestationAuthorityStateV1,
): IdentityVerifiedV1 {
  const normalizedObservation = validateIdentityObservation(observation, "attestation.identityVerified");
  const proofInput = identityProofVerificationContext(
    runId,
    cutoff,
    candidatePartitionRoot,
    candidate,
    normalizedObservation,
    identityOrigin,
    {
      releaseProvenanceHash: authority.releaseProvenanceHash,
      attestationAuthorityRoot: authority.authorityRoot,
      releaseAuthorityRoot: authority.releaseAuthorityRoot,
      frameworkAuthorityRoot: authority.frameworkAuthorityRoot,
      executorAuthorityRoot: authority.executorAuthorityRoot,
      attestationProofIssuerKeyId: authority.attestationProofIssuerKeyId,
    },
  );
  const issued = authority.attestationProof.issueIdentity(proofInput);
  const normalizedProof = validateIdentityIssuerProof(issued, proofInput);
  const verified = authority.attestationProof.verifyIdentity(normalizedProof, proofInput);
  const exactVerified = validateIdentityIssuerProof(verified, proofInput);
  if (exactVerified.proofHash !== normalizedProof.proofHash) throw new TypeError("identity-proof-issuer-result-mismatch");
  return deepFreeze({ ...normalizedObservation, issuerProof: exactVerified });
}

/**
 * Constructor-bound startup session.  The session owns all per-candidate
 * capability state; callers receive only opaque writer/persistence tokens and
 * cannot substitute programs, lifecycle, or authority ports after opening it.
 */
function createAttestationRunSession(
  input: AttestationRunSessionInputV1,
  candidatePartitionReader: CandidatePartitionReaderPortV1,
  programs: AttestationProgramPort,
  instanceLifecycle: InstanceLifecycleSingleFlightPort,
  frameworkRuntime: FrameworkFailureRuntimePort,
  authority: AttestationAuthorityStateV1,
  rejectionValidator: RejectionFactRuntimeStateV1["validateDecision"],
): AttestationRunSessionV1 {
  if (input.candidatePartition === null || typeof input.candidatePartition !== "object") {
    throw new TypeError("attestationSession.candidatePartition must be an opaque capability");
  }
  const partitionBinding = candidatePartitionReader.binding(input.candidatePartition);
  const runId = assertNonEmptyString(partitionBinding.runId, "attestationSession.partition.runId");
  const cutoff = validateCutoff(partitionBinding.cutoff, "attestationSession.partition.cutoff");
  const candidatePartitionRoot = assertHash(partitionBinding.candidatePartitionRoot, "attestationSession.partition.candidatePartitionRoot");
  const candidateKeys = [...candidatePartitionReader.listKeys(input.candidatePartition)].map((key, index) => assertHash(key, `attestationSession.partition.candidateKeys[${index}]`));
  if (candidateKeys.length === 0) throw new TypeError("attestationSession.partition must not be empty");
  if (partitionBinding.recordCount !== String(candidateKeys.length)
    || partitionBinding.candidateKeysRoot !== candidatePartitionKeysRoot(candidateKeys)) {
    throw new TypeError("attestationSession.partition key commitment mismatch");
  }
  if (new Set(candidateKeys).size !== candidateKeys.length) throw new TypeError("attestationSession.candidateKeys must be unique");
  const candidateKeySet = new Set(candidateKeys);
  const resumeCapabilities = input.identityResumeCapabilities ?? [];
  if (!Array.isArray(resumeCapabilities)) throw new TypeError("attestationSession.identityResumeCapabilities must be an array");
  const resumeByCandidate = new Map<Hash, { readonly capability: object; readonly state: AttestationIdentityResumeStateV1 }>();
  for (const suppliedCapability of resumeCapabilities) {
    if (suppliedCapability === null || typeof suppliedCapability !== "object") {
      throw new TypeError("attestation-identity-resume-capability-invalid");
    }
    if (!authority.resumeCapabilities.has(suppliedCapability)) {
      throw new TypeError("attestation-identity-resume-capability-not-issued");
    }
    const resumeState = attestationIdentityResumeStates.get(suppliedCapability);
    if (!resumeState || consumedAttestationIdentityResumeCapabilities.has(suppliedCapability)) {
      throw new TypeError("attestation-identity-resume-capability-consumed");
    }
    if (
      resumeState.runId !== runId
      || resumeState.candidatePartitionRoot !== candidatePartitionRoot
      || encodeCanonicalJson(resumeState.cutoff) !== encodeCanonicalJson(cutoff)
      || resumeState.attestationAuthorityRoot !== authority.authorityRoot
      || resumeState.releaseAuthorityRoot !== authority.releaseAuthorityRoot
      || resumeState.releaseProvenanceHash !== authority.releaseProvenanceHash
      || resumeState.executorAuthorityRoot !== authority.executorAuthorityRoot
      || !candidateKeySet.has(resumeState.familyCandidateKey)
    ) throw new TypeError("attestation-identity-resume-capability-lineage-mismatch");
    if (resumeByCandidate.has(resumeState.familyCandidateKey)) {
      throw new TypeError("attestation-identity-resume-capability-duplicate");
    }
    resumeByCandidate.set(resumeState.familyCandidateKey, { capability: suppliedCapability, state: resumeState });
  }
  const outcomeResumeCapabilities = input.outcomeResumeCapabilities ?? [];
  if (!Array.isArray(outcomeResumeCapabilities)) throw new TypeError("attestationSession.outcomeResumeCapabilities must be an array");
  const outcomeResumeByCandidate = new Map<Hash, { readonly capability: AttestationOutcomeResumeCapabilityV1; readonly state: AttestationOutcomeResumeStateV1 }>();
  for (const suppliedCapability of outcomeResumeCapabilities) {
    if (suppliedCapability === null || typeof suppliedCapability !== "object") {
      throw new TypeError("attestation-outcome-resume-capability-invalid");
    }
    if (!authority.resumeCapabilities.has(suppliedCapability)) {
      throw new TypeError("attestation-outcome-resume-capability-not-issued");
    }
    const resumeState = attestationOutcomeResumeStates.get(suppliedCapability);
    if (!resumeState || consumedAttestationOutcomeResumeCapabilities.has(suppliedCapability)) {
      throw new TypeError("attestation-outcome-resume-capability-consumed");
    }
    if (
      resumeState.runId !== runId
      || resumeState.candidatePartitionRoot !== candidatePartitionRoot
      || encodeCanonicalJson(resumeState.cutoff) !== encodeCanonicalJson(cutoff)
      || resumeState.attestationAuthorityRoot !== authority.authorityRoot
      || resumeState.releaseAuthorityRoot !== authority.releaseAuthorityRoot
      || resumeState.releaseProvenanceHash !== authority.releaseProvenanceHash
      || resumeState.executorAuthorityRoot !== authority.executorAuthorityRoot
      || !candidateKeySet.has(resumeState.familyCandidateKey)
    ) throw new TypeError("attestation-outcome-resume-capability-lineage-mismatch");
    if (outcomeResumeByCandidate.has(resumeState.familyCandidateKey)) {
      throw new TypeError("attestation-outcome-resume-capability-duplicate");
    }
    if (resumeByCandidate.has(resumeState.familyCandidateKey)) {
      throw new TypeError("attestation-resume-capability-duplicate");
    }
    outcomeResumeByCandidate.set(resumeState.familyCandidateKey, { capability: suppliedCapability, state: resumeState });
  }
  const verifiedMemoReuseCapabilities = input.verifiedMemoReuseCapabilities ?? [];
  if (!Array.isArray(verifiedMemoReuseCapabilities)) throw new TypeError("attestationSession.verifiedMemoReuseCapabilities must be an array");
  const memoReuseByCandidate = new Map<Hash, { readonly capability: AttestationVerifiedMemoReuseCapabilityV1; readonly state: AttestationVerifiedMemoReuseStateV1 }>();
  for (const suppliedCapability of verifiedMemoReuseCapabilities) {
    if (suppliedCapability === null || typeof suppliedCapability !== "object") {
      throw new TypeError("attestation-memo-reuse-capability-invalid");
    }
    if (!authority.resumeCapabilities.has(suppliedCapability)) {
      throw new TypeError("attestation-memo-reuse-capability-not-issued");
    }
    const reuseState = attestationVerifiedMemoReuseStates.get(suppliedCapability);
    if (!reuseState || consumedAttestationVerifiedMemoReuseCapabilities.has(suppliedCapability)) {
      throw new TypeError("attestation-memo-reuse-capability-consumed");
    }
    if (
      reuseState.runId !== runId
      || reuseState.candidatePartitionRoot !== candidatePartitionRoot
      || encodeCanonicalJson(reuseState.cutoff) !== encodeCanonicalJson(cutoff)
      || reuseState.authorityRoot !== authority.authorityRoot
      || reuseState.releaseAuthorityRoot !== authority.releaseAuthorityRoot
      || reuseState.releaseProvenanceHash !== authority.releaseProvenanceHash
      || !candidateKeySet.has(reuseState.familyCandidateKey)
    ) throw new TypeError("attestation-memo-reuse-capability-lineage-mismatch");
    if (
      resumeByCandidate.has(reuseState.familyCandidateKey)
      || outcomeResumeByCandidate.has(reuseState.familyCandidateKey)
      || memoReuseByCandidate.has(reuseState.familyCandidateKey)
    ) throw new TypeError("attestation-memo-reuse-capability-duplicate");
    memoReuseByCandidate.set(reuseState.familyCandidateKey, { capability: suppliedCapability, state: reuseState });
  }
  const writerCapability = Object.freeze({}) as AttestationWriterCapabilityV1;
  const writerCapabilities = new WeakSet<object>([writerCapability]);
  const persistenceStates = new WeakMap<object, AttestationSessionPersistenceStateV1>();
  const persistenceCapabilities = new Set<object>();
  const consumedPersistence = new WeakSet<object>();
  const claimedPersistence = new WeakSet<object>();
  const identityResults = new Map<Hash, AttestationIdentitySessionResultV1>();
  const identityCandidateSnapshots = new Map<Hash, Hash>();
  const identityInFlight = new Map<Hash, Promise<AttestationIdentitySessionResultV1>>();
  const continuationStates = new WeakMap<object, AttestationIdentityContinuationStateV1>();
  const continuationByCandidate = new Map<Hash, AttestationIdentityContinuationStateV1>();
  const finalOutcomes = new Map<Hash, AttestationOutcomeCapabilityV1>();
  const durableFinalKeys = new Set<Hash>();

  const candidateForSession = (familyCandidateKey: Hash): CandidateRecordV1 => {
    const key = assertHash(familyCandidateKey, "attestationSession.familyCandidateKey");
    if (!candidateKeySet.has(key)) throw new TypeError("attestation-session-candidate-outside-partition");
    const frozen = freezeCandidateRecord(
      candidatePartitionReader.readCandidate(input.candidatePartition, key),
      "attestationSession.candidate",
    );
    if (frozen.familyCandidateKey !== key) throw new TypeError("attestation-session-reader-key-mismatch");
    return frozen;
  };

  const rawEvidencePorts = new Map<Hash, FamilyRawEvidenceReadPortV1>();
  const rawEvidenceFor = (candidate: CandidateRecordV1): FamilyRawEvidenceReadPortV1 => {
    const existing = rawEvidencePorts.get(candidate.familyCandidateKey);
    if (existing !== undefined) return existing;
    const port = Object.freeze({
      read(rawLocatorHash: Hash): Uint8Array {
        return candidatePartitionReader.readRawEvidence(
          input.candidatePartition,
          candidate.familyCandidateKey,
          rawLocatorHash,
        );
      },
    });
    rawEvidencePorts.set(candidate.familyCandidateKey, port);
    return port;
  };

  const issueIdentityContinuation = (
    candidate: CandidateRecordV1,
    identity: IdentityVerifiedV1,
  ): AttestationIdentityContinuationV1 => {
    const continuation = Object.freeze({}) as AttestationIdentityContinuationV1;
    const state: AttestationIdentityContinuationStateV1 = {
      runId,
      candidatePartitionRoot,
      familyCandidateKey: candidate.familyCandidateKey,
      candidateSubjectHash: candidate.candidateSubjectHash,
      candidate,
      identity,
      status: "pending",
      materializationPromise: null,
    };
    continuationStates.set(continuation, state);
    continuationByCandidate.set(candidate.familyCandidateKey, state);
    return continuation;
  };

  const resolvedIdentityGroups = (): readonly IdentityGroupV1<AttestationIdentityContinuationStateV1>[] => {
    assertIdentityBarrier(candidateKeys, [...identityResults.keys()]);
    return groupVerifiedIdentities([...continuationByCandidate.values()].map(state => ({
      familyDefinitionHash: state.candidate.familyDefinitionHash,
      familyCandidateKey: state.familyCandidateKey,
      familyInstanceKey: state.identity.familyInstanceKey,
      value: state,
    })));
  };

  const resolvedGroupFor = (
    state: AttestationIdentityContinuationStateV1,
  ): IdentityGroupV1<AttestationIdentityContinuationStateV1> => {
    const group = resolvedIdentityGroups().find(value => value.members.some(member => member.familyCandidateKey === state.familyCandidateKey));
    if (!group) throw new TypeError("attestation-identity-group-missing");
    return group;
  };

  const continuationState = (
    suppliedContinuation: AttestationIdentityContinuationV1,
  ): AttestationIdentityContinuationStateV1 => {
    if (suppliedContinuation === null || typeof suppliedContinuation !== "object") {
      throw new TypeError("attestation-identity-continuation-invalid");
    }
    const state = continuationStates.get(suppliedContinuation);
    if (!state) throw new TypeError("attestation-identity-continuation-not-issued");
    if (
      state.runId !== runId
      || state.candidatePartitionRoot !== candidatePartitionRoot
      || state.familyCandidateKey !== state.candidate.familyCandidateKey
      || state.candidateSubjectHash !== state.candidate.candidateSubjectHash
      || !candidateKeySet.has(state.familyCandidateKey)
    ) throw new TypeError("attestation-identity-continuation-lineage-mismatch");
    return state;
  };

  const persistence = (
    candidate: CandidateRecordV1,
    stage: "identity" | "materialization",
    identity: IdentityVerifiedV1 | null,
    outcome: AttestationOutcomeCapabilityV1 | null,
    durability: "new" | "durable" = "new",
  ): AttestationPersistenceCapabilityV1 => {
    let outcomeHash: Hash;
    if (outcome) {
      outcomeHash = candidateFinalOutcomeHash(outcome);
    } else {
      if (identity === null) throw new TypeError("attestation-partial-identity-missing");
      outcomeHash = attestationPartialIdentitySemanticHash({
        runId,
        cutoff,
        candidatePartitionRoot,
        candidate,
        identity,
        releaseProvenanceHash: authority.releaseProvenanceHash,
        attestationAuthorityRoot: authority.authorityRoot,
        releaseAuthorityRoot: authority.releaseAuthorityRoot,
        executorAuthorityRoot: authority.executorAuthorityRoot,
      });
    }
    const capability = Object.freeze({
      runId,
      candidatePartitionRoot,
      familyCandidateKey: candidate.familyCandidateKey,
      outcomeHash,
      stage,
    }) as AttestationPersistenceCapabilityV1;
    persistenceStates.set(capability, {
      runId,
      candidatePartitionRoot,
      familyCandidateKey: candidate.familyCandidateKey,
      outcomeHash,
      stage,
      identity,
      outcome,
      durability,
    });
    persistenceCapabilities.add(capability);
    return capability;
  };

  const resultFromOutcome = (
    candidate: CandidateRecordV1,
    outcome: AttestationOutcomeCapabilityV1,
    expectedStage: Exclude<AttestationStageV1, "framework">,
    durability: "new" | "durable" = "new",
  ): AttestationFinalSessionResultV1 => {
    finalOutcomes.set(candidate.familyCandidateKey, outcome);
    if (durability === "durable") durableFinalKeys.add(candidate.familyCandidateKey);
    return Object.freeze({
      kind: "final" as const,
      durability,
      outcome,
      persistenceCapability: persistence(candidate, expectedStage === "identity" ? "identity" : "materialization", null, outcome, durability),
    });
  };

  const issueFinal = (
    candidate: CandidateRecordV1,
    decision: Exclude<IdentityDecisionV1, IdentityVerifiedObservationV1> | InstanceDecisionV1,
    expectedStage: Exclude<AttestationStageV1, "framework">,
    expectedIdentitySubjectHash: Hash | null,
    identityProof: AttestationIdentityIssuerProofV1 | null,
  ): AttestationFinalSessionResultV1 => {
    const body = outcomeFor(
      runId,
      candidate,
      cutoff,
      decision,
      frameworkRuntime,
      rejectionValidator,
      expectedStage,
      expectedIdentitySubjectHash,
      identityProof,
    );
    const outcome = bindOutcomeAuthority(body, authority, {
      runId,
      cutoff,
      candidatePartitionRoot,
      candidate,
    });
    return resultFromOutcome(candidate, outcome, expectedStage);
  };

  const resolveIdentityOrReuseProofOnce = (
    familyCandidateKey: Hash,
    signal: AbortSignal,
  ): Promise<AttestationIdentitySessionResultV1> => {
    const candidate = candidateForSession(familyCandidateKey);
    const knownSnapshot = identityCandidateSnapshots.get(candidate.familyCandidateKey);
    if (knownSnapshot !== undefined && knownSnapshot !== candidate.candidateSubjectHash) {
      throw new TypeError("attestation-session-candidate-snapshot-mismatch");
    }
    identityCandidateSnapshots.set(candidate.familyCandidateKey, candidate.candidateSubjectHash);
    const existing = identityResults.get(candidate.familyCandidateKey);
    if (existing) return Promise.resolve(existing);
    const inFlight = identityInFlight.get(candidate.familyCandidateKey);
    if (inFlight) return inFlight;
    const computation = (async (): Promise<AttestationIdentitySessionResultV1> => {
      if (signal.aborted) throw signal.reason;
      const finalResume = outcomeResumeByCandidate.get(candidate.familyCandidateKey);
      if (finalResume) {
        if (finalResume.state.candidateSubjectHash !== candidate.candidateSubjectHash) {
          throw new TypeError("attestation-outcome-resume-candidate-snapshot-mismatch");
        }
        if (consumedAttestationOutcomeResumeCapabilities.has(finalResume.capability)) {
          throw new TypeError("attestation-outcome-resume-capability-consumed");
        }
        consumedAttestationOutcomeResumeCapabilities.add(finalResume.capability);
        const normalizedOutcome = verifyOutcomeForAuthority(finalResume.state.outcome, authority, {
          runId,
          cutoff,
          candidatePartitionRoot,
          candidate,
        });
        registerAttestationOutcomeCapability(normalizedOutcome, authority);
        const result = resultFromOutcome(candidate, normalizedOutcome, "materialization", "durable");
        identityResults.set(candidate.familyCandidateKey, result);
        return result;
      }
      const resume = resumeByCandidate.get(candidate.familyCandidateKey);
      if (resume) {
        if (resume.state.candidateSubjectHash !== candidate.candidateSubjectHash) {
          throw new TypeError("attestation-identity-resume-candidate-snapshot-mismatch");
        }
        const expectedOutcomeHash = attestationPartialIdentitySemanticHash({
          runId,
          cutoff,
          candidate,
          identity: resume.state.identity,
          releaseProvenanceHash: authority.releaseProvenanceHash,
          candidatePartitionRoot,
          attestationAuthorityRoot: authority.authorityRoot,
          releaseAuthorityRoot: authority.releaseAuthorityRoot,
          executorAuthorityRoot: authority.executorAuthorityRoot,
        });
        if (expectedOutcomeHash !== resume.state.outcomeHash) {
          throw new TypeError("attestation-identity-resume-hash-mismatch");
        }
        // Session construction only validates the capability's lineage. Two
        // sessions may therefore be opened before either one resolves it; the
        // one-shot check must happen again at the synchronous consumption point.
        if (consumedAttestationIdentityResumeCapabilities.has(resume.capability)) {
          throw new TypeError("attestation-identity-resume-capability-consumed");
        }
        consumedAttestationIdentityResumeCapabilities.add(resume.capability);
        const normalizedIdentity = verifyIdentityForAuthority(resume.state.identity, authority, {
          runId,
          cutoff,
          candidatePartitionRoot,
          candidate,
        });
        const identityResult = Object.freeze({
          kind: "identityVerified" as const,
          durability: "durable" as const,
          candidate,
          identity: normalizedIdentity,
          continuation: issueIdentityContinuation(candidate, normalizedIdentity),
          persistenceCapability: persistence(candidate, "identity", normalizedIdentity, null, "durable"),
        });
        identityResults.set(candidate.familyCandidateKey, identityResult);
        return identityResult;
      }
      const memoReuse = memoReuseByCandidate.get(candidate.familyCandidateKey);
      if (memoReuse) {
        if (
          memoReuse.state.candidateSubjectHash !== candidate.candidateSubjectHash
          || memoReuse.state.publication.familyId !== candidate.familyId
          || memoReuse.state.publication.instanceKey !== candidate.instanceNominationKey
        ) throw new TypeError("attestation-memo-reuse-candidate-binding-mismatch");
        if (consumedAttestationVerifiedMemoReuseCapabilities.has(memoReuse.capability)) {
          throw new TypeError("attestation-memo-reuse-capability-consumed");
        }
        consumedAttestationVerifiedMemoReuseCapabilities.add(memoReuse.capability);
        if (programs.reuseVerifiedMemo === undefined) throw new TypeError("attestation-memo-reuse-program-missing");
        const reuseDecision = await programs.reuseVerifiedMemo(candidate, memoReuse.state.publication, cutoff, signal, rawEvidenceFor(candidate));
        if (reuseDecision.kind === "reusable") {
          const reuseProof = reuseDecision.proof;
          if (
            reuseProof.familyId !== candidate.familyId
            || reuseProof.familyDefinitionHash !== candidate.familyDefinitionHash
            || reuseProof.familyCandidateKey !== candidate.familyCandidateKey
            || reuseProof.candidateSubjectHash !== candidate.candidateSubjectHash
            || reuseProof.instanceNominationKey !== candidate.instanceNominationKey
            || encodeCanonicalJson(reuseProof.cutoff) !== encodeCanonicalJson(cutoff)
            || reuseProof.oldInstancePublicationHash !== memoReuse.state.publication.instancePublicationHash
            || reuseProof.requestedArtifactDependencyRoot !== memoReuse.state.publication.requestedArtifactDependencyRoot
            || reuseProof.descriptorHash !== memoReuse.state.publication.descriptorHash
            || reuseProof.validityDependencyRoot !== memoReuse.state.publication.validityDependencyRoot
            || reuseProof.identityMemoHash !== reuseDecision.identity.identityMemoHash
            || encodeCanonicalJson(reuseProof.identityMemo) !== encodeCanonicalJson(reuseDecision.identity.identityMemo)
            || reuseProof.evidenceRoot !== reuseDecision.identity.evidenceRoot
          ) throw new TypeError("attestation-memo-reuse-proof-binding-mismatch");
          const identityOrigin = deepFreeze({
            kind: "verified-memo-reuse" as const,
            verifiedMemoSetRoot: memoReuse.state.verifiedMemoSetRoot,
            proof: reuseProof,
          });
          const normalizedIdentity = issueIdentityWithProof(
            runId,
            cutoff,
            candidatePartitionRoot,
            candidate,
            reuseDecision.identity,
            identityOrigin,
            authority,
          );
          const identityResult = Object.freeze({
            kind: "identityVerified" as const,
            durability: "new" as const,
            candidate,
            identity: normalizedIdentity,
            continuation: issueIdentityContinuation(candidate, normalizedIdentity),
            persistenceCapability: persistence(candidate, "identity", normalizedIdentity, null),
          });
          identityResults.set(candidate.familyCandidateKey, identityResult);
          return identityResult;
        }
      }
      try {
        const decision = await observeIdentity(
          programs,
          candidate,
          cutoff,
          signal,
          rawEvidenceFor(candidate),
        );
        if (decision.kind === "identityVerified") {
          const normalizedIdentity = issueIdentityWithProof(
            runId,
            cutoff,
            candidatePartitionRoot,
            candidate,
            decision,
            deepFreeze({ kind: "fresh" as const }),
            authority,
          );
          const identityResult = Object.freeze({
            kind: "identityVerified" as const,
            durability: "new" as const,
            candidate,
            identity: normalizedIdentity,
            continuation: issueIdentityContinuation(candidate, normalizedIdentity),
            persistenceCapability: persistence(candidate, "identity", normalizedIdentity, null),
          });
          identityResults.set(candidate.familyCandidateKey, identityResult);
          return identityResult;
        }
        const result = issueFinal(candidate, decision, "identity", null, null);
        identityResults.set(candidate.familyCandidateKey, result);
        return result;
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        const failure = frameworkFailure(
          runId,
          candidate,
          cutoff,
          "identity",
          frameworkRuntime,
          rejectionValidator,
          null,
          error,
        );
        const result = resultFromOutcome(candidate, bindOutcomeAuthority(failure, authority, {
          runId, cutoff, candidatePartitionRoot, candidate,
        }), "identity");
        identityResults.set(candidate.familyCandidateKey, result);
        return result;
      }
    })();
    let tracked!: Promise<AttestationIdentitySessionResultV1>;
    tracked = computation.finally(() => {
      if (identityInFlight.get(candidate.familyCandidateKey) === tracked) {
        identityInFlight.delete(candidate.familyCandidateKey);
      }
    });
    identityInFlight.set(candidate.familyCandidateKey, tracked);
    return tracked;
  };

  const resolveIdentityDenominator = async (
    signal: AbortSignal,
  ): Promise<readonly AttestationIdentitySessionResultV1[]> => {
    const results = await Promise.all(candidateKeys.map(
      key => resolveIdentityOrReuseProofOnce(key, signal),
    ));
    assertIdentityBarrier(candidateKeys, results.map(result => result.kind === "identityVerified"
      ? result.candidate.familyCandidateKey
      : result.outcome.familyCandidateKey));
    return Object.freeze(results);
  };

  const materializeAndProjectOnce = (
    suppliedContinuation: AttestationIdentityContinuationV1,
    signal: AbortSignal,
  ): Promise<AttestationFinalSessionResultV1> => {
    const state = continuationState(suppliedContinuation);
    const identityGroup = resolvedGroupFor(state);
    if (identityGroup.members.length !== 1) {
      throw new TypeError("attestation-collision-group-must-be-terminated-before-materialization");
    }
    if (state.status === "completed" || state.status === "materializing") {
      if (!state.materializationPromise) throw new TypeError("attestation-identity-continuation-state-invalid");
      return state.materializationPromise;
    }
    if (state.status !== "pending") throw new TypeError("attestation-identity-continuation-consumed");
    if (signal.aborted) return Promise.reject(signal.reason);
    state.status = "materializing";
    const computation = (async (): Promise<AttestationFinalSessionResultV1> => {
      const candidate = state.candidate;
      const identity = state.identity;
      const expectedIdentitySubjectHash = verifiedIdentitySubjectHash(candidate, identity);
      try {
        const decision = await observeInstance(
          runId,
          programs,
          instanceLifecycle,
          candidate,
          identity,
          cutoff,
          signal,
          rawEvidenceFor(candidate),
        );
        const result = issueFinal(candidate, decision, "materialization", expectedIdentitySubjectHash, identity.issuerProof);
        state.status = "completed";
        return result;
      } catch (error) {
        if (signal.aborted) {
          state.status = "pending";
          state.materializationPromise = null;
          throw signal.reason ?? error;
        }
        const failure = frameworkFailure(
          runId,
          candidate,
          cutoff,
          "materialization",
          frameworkRuntime,
          rejectionValidator,
          identity.issuerProof,
          error,
        );
        const result = resultFromOutcome(candidate, bindOutcomeAuthority(failure, authority, {
          runId, cutoff, candidatePartitionRoot, candidate,
        }), "materialization");
        state.status = "completed";
        return result;
      }
    })();
    state.materializationPromise = computation;
    return computation;
  };

  const issueNominationKeyCollision = (
    suppliedGroup: readonly AttestationIdentityContinuationV1[],
  ): readonly AttestationFinalSessionResultV1[] => {
    if (suppliedGroup.length < 2) throw new TypeError("attestation-session-collision-group-too-small");
    const states = suppliedGroup.map(continuationState);
    const keys = new Set<Hash>();
    const first = states[0]!;
    for (const state of states) {
      if (state.status !== "pending") throw new TypeError("attestation-identity-continuation-consumed");
      if (keys.has(state.familyCandidateKey)) throw new TypeError("attestation-session-collision-duplicate");
      keys.add(state.familyCandidateKey);
      if (
        state.candidate.familyDefinitionHash !== first.candidate.familyDefinitionHash
        || state.identity.familyInstanceKey !== first.identity.familyInstanceKey
      ) throw new TypeError("attestation-session-collision-group-mismatch");
    }
    const expectedGroup = resolvedGroupFor(first);
    const suppliedKeys = [...keys].sort(compareText);
    const expectedKeys = expectedGroup.members.map(member => member.familyCandidateKey);
    if (
      expectedGroup.members.length < 2
      || suppliedKeys.length !== expectedKeys.length
      || suppliedKeys.some((key, index) => key !== expectedKeys[index])
    ) throw new TypeError("attestation-session-collision-group-not-exact");
    const normalized = states.map(state => ({ candidate: state.candidate, identity: state.identity }));
    const evidenceRoot = collisionEvidenceRoot(expectedGroup);
    // Build and validate the whole collision outcome set before changing any
    // continuation state or registering a final capability. This keeps a
    // malformed group from partially terminating its members.
    const bodies = normalized.map(item => outcomeFor(runId, item.candidate, cutoff, {
      kind: "invalidProgram",
      failure: {
        stage: "identity",
        failureCode: "nomination-key-collision",
        attemptCount: "1",
        candidateSubjectHash: item.candidate.candidateSubjectHash,
        evidenceRoot,
        frameworkBinding: null,
      },
    }, frameworkRuntime, rejectionValidator, "identity", null, null));
    const outcomes = bodies.map((body, index) => bindOutcomeAuthority(body, authority, {
      runId,
      cutoff,
      candidatePartitionRoot,
      candidate: normalized[index]!.candidate,
    }));
    for (const state of states) state.status = "collision";
    const issuedResults: AttestationFinalSessionResultV1[] = [];
    try {
      for (const [index, outcome] of outcomes.entries()) {
        issuedResults.push(resultFromOutcome(normalized[index]!.candidate, outcome, "identity"));
      }
      for (const state of states) state.status = "completed";
      return Object.freeze(issuedResults);
    } catch (error) {
      for (const result of issuedResults) {
        finalOutcomes.delete(result.outcome.familyCandidateKey);
        persistenceStates.delete(result.persistenceCapability);
        persistenceCapabilities.delete(result.persistenceCapability);
      }
      for (const state of states) state.status = "pending";
      throw error;
    }
  };

  const claimPersistenceCapabilities = (
    suppliedWriterCapability: AttestationWriterCapabilityV1,
    suppliedPersistenceCapabilities: readonly AttestationPersistenceCapabilityV1[],
  ): AttestationPersistenceBatchClaimV1 => {
    if (suppliedWriterCapability === null || typeof suppliedWriterCapability !== "object" || !writerCapabilities.has(suppliedWriterCapability)) {
      throw new TypeError("attestation-writer-capability-not-issued");
    }
    if (!Array.isArray(suppliedPersistenceCapabilities)) {
      throw new TypeError("attestation-persistence-capabilities-invalid");
    }
    if (suppliedPersistenceCapabilities.length === 0) {
      throw new TypeError("attestation-persistence-capabilities-empty");
    }
    const seen = new Set<object>();
    const states: AttestationSessionPersistenceStateV1[] = [];
    for (const suppliedPersistenceCapability of suppliedPersistenceCapabilities) {
      if (suppliedPersistenceCapability === null || typeof suppliedPersistenceCapability !== "object") {
        throw new TypeError("attestation-persistence-capability-invalid");
      }
      if (seen.has(suppliedPersistenceCapability)) {
        throw new TypeError("attestation-persistence-capability-duplicate");
      }
      seen.add(suppliedPersistenceCapability);
      const state = persistenceStates.get(suppliedPersistenceCapability);
      if (!state || consumedPersistence.has(suppliedPersistenceCapability) || claimedPersistence.has(suppliedPersistenceCapability)) {
        throw new TypeError("attestation-persistence-capability-not-issued-or-consumed");
      }
      if (
        state.runId !== runId
        || state.candidatePartitionRoot !== candidatePartitionRoot
        || suppliedPersistenceCapability.candidatePartitionRoot !== candidatePartitionRoot
        || !candidateKeySet.has(state.familyCandidateKey)
      ) {
        throw new TypeError("attestation-persistence-capability-session-mismatch");
      }
      states.push(state);
    }
    for (const suppliedPersistenceCapability of suppliedPersistenceCapabilities) {
      claimedPersistence.add(suppliedPersistenceCapability);
    }
    let status: "active" | "committed" | "aborted" = "active";
    const entries = deepFreeze(states.map(state => deepFreeze({
      runId: state.runId,
      candidatePartitionRoot: state.candidatePartitionRoot,
      familyCandidateKey: state.familyCandidateKey,
      outcomeHash: state.outcomeHash,
      attestationAuthorityRoot: authority.authorityRoot,
      releaseAuthorityRoot: authority.releaseAuthorityRoot,
      releaseProvenanceHash: authority.releaseProvenanceHash,
      executorAuthorityRoot: authority.executorAuthorityRoot,
      kind: state.outcome ? "final" as const : "partial-identity" as const,
      identity: state.identity,
      outcome: state.outcome,
    })));
    const finish = (next: "committed" | "aborted"): void => {
      if (status !== "active") throw new TypeError("attestation-persistence-claim-already-finished");
      status = next;
      for (const suppliedPersistenceCapability of suppliedPersistenceCapabilities) {
        if (next === "committed") consumedPersistence.add(suppliedPersistenceCapability);
        claimedPersistence.delete(suppliedPersistenceCapability);
      }
    };
    return Object.freeze({
      entries,
      commit: () => finish("committed"),
      abort: () => finish("aborted"),
    });
  };

  // The writer is consumed only through the constructor-bound validation
  // authority.  Keeping this closure in the authority-owned registry means a
  // caller cannot supply a session-local bypass or a structurally copied token.
  authority.writerConsumers.set(writerCapability, {
    candidatePartitionRoot,
    claim: claimPersistenceCapabilities,
  });

  const sealExactPartition = (outcomeHashes: readonly Hash[]): AttestationPartitionCapabilityV1 => {
    if (outcomeHashes.length !== candidateKeys.length) throw new TypeError("attestation-session-partition-size-mismatch");
    const expected = new Set(candidateKeys);
    const selected = new Set<Hash>();
    for (const outcomeHash of outcomeHashes) {
      const outcome = [...finalOutcomes.values()].find(value => candidateFinalOutcomeHash(value) === outcomeHash);
      if (!outcome || selected.has(outcome.familyCandidateKey)) throw new TypeError("attestation-session-outcome-hash-mismatch");
      selected.add(outcome.familyCandidateKey);
    }
    if (selected.size !== expected.size || [...expected].some(key => !selected.has(key))) {
      throw new TypeError("attestation-session-partition-incomplete");
    }
    const missingPersistence = [...finalOutcomes.values()].some(outcome => {
      const outcomeHash = candidateFinalOutcomeHash(outcome);
      return ![...persistenceCapabilities].some(capability => {
        const state = persistenceStates.get(capability);
      return state?.outcomeHash === outcomeHash
        && (consumedPersistence.has(capability) || durableFinalKeys.has(outcome.familyCandidateKey));
      });
    });
    if (missingPersistence) throw new TypeError("attestation-session-writer-not-drained");
    const outcomes = [...finalOutcomes.values()].sort((left, right) => compareText(left.familyCandidateKey, right.familyCandidateKey));
    const accounting = {
      pending: "0",
      verified: String(outcomes.filter(value => value.kind === "verified").length),
      chainProvenRejected: String(outcomes.filter(value => value.kind === "chainProvenRejected").length),
      retryable: String(outcomes.filter(value => value.kind === "retryable").length),
      invalidProgram: String(outcomes.filter(value => value.kind === "invalidProgram").length),
    };
    return bindPartitionAuthority(runId, cutoff, candidatePartitionRoot, outcomes, accounting, authority);
  };

  return Object.freeze({
    writerCapability,
    resolveIdentityDenominator,
    resolveIdentityOrReuseProofOnce,
    materializeAndProjectOnce,
    issueNominationKeyCollision,
    sealExactPartition,
  });
}

export async function probeRetryableCandidate(
  runId: string,
  familyCandidateKey: Hash,
  store: ProbeStorePort,
  canonical: { assertStillCanonical(cutoff: CanonicalCutoffV1): Promise<void> },
  service: AttestationServiceV1,
  signal: AbortSignal,
): Promise<ProbeReceiptV1> {
  const stored = await store.loadRetryable(runId, familyCandidateKey);
  if (
    stored.runId !== runId
    || stored.candidatePartitionBinding.runId !== runId
    || stored.candidatePartitionBinding.candidatePartitionRoot !== stored.before.outcomeIssuerProof.candidatePartitionRoot
    || stored.before.familyCandidateKey !== familyCandidateKey
    || stored.before.runCandidateKey !== runCandidateKey(runId, familyCandidateKey)
    || stored.before.failure.candidateSubjectHash !== stored.candidateSubjectHash
  ) throw new Error("probe-stored-lineage-mismatch");
  await canonical.assertStillCanonical(stored.cutoff);
  const session = service.openRunSession({
    candidatePartition: stored.candidatePartition,
  });
  const identities = await session.resolveIdentityDenominator(signal);
  const identity = identities.find(result => (result.kind === "identityVerified"
    ? result.candidate.familyCandidateKey
    : result.outcome.familyCandidateKey) === familyCandidateKey);
  if (identity === undefined) throw new Error("probe-target-absent-from-identity-denominator");
  let final: AttestationFinalSessionResultV1;
  if (identity.kind === "identityVerified") {
    const collisionGroup = identities.filter((result): result is Extract<AttestationIdentitySessionResultV1, { readonly kind: "identityVerified" }> =>
      result.kind === "identityVerified"
      && result.candidate.familyDefinitionHash === identity.candidate.familyDefinitionHash
      && result.identity.familyInstanceKey === identity.identity.familyInstanceKey,
    );
    if (collisionGroup.length > 1) {
      const collisionResults = session.issueNominationKeyCollision(collisionGroup.map(result => result.continuation));
      const target = collisionResults.find(result => result.outcome.familyCandidateKey === familyCandidateKey);
      if (target === undefined) throw new Error("probe-target-absent-from-collision-outcomes");
      final = target;
    } else {
      final = await session.materializeAndProjectOnce(identity.continuation, signal);
    }
  } else {
    final = identity;
  }
  const after = final.outcome;
  if (after.kind === "invalidProgram") {
    throw new Error("probe-invalid-program-is-diagnostic-only");
  }
  const afterOutcomeHash = candidateFinalOutcomeHash(after);
  const receipt = await store.replaceRetryableCAS(
    stored.probeCapability,
    session.writerCapability,
    final.persistenceCapability,
  );
  validateProbeReceipt(receipt);
  if (
    receipt.runId !== runId
    || receipt.familyCandidateKey !== familyCandidateKey
    || receipt.beforeOutcomeHash !== stored.beforeOutcomeHash
    || receipt.afterOutcomeHash !== afterOutcomeHash
    || receipt.afterKind !== after.kind
    || receipt.candidateSubjectHash !== stored.candidateSubjectHash
    || receipt.evidenceRoot !== stored.before.failure.evidenceRoot
  ) throw new Error("probe-receipt-transition-mismatch");
  return receipt;
}

export async function probeRetryableCategory(
  runId: string,
  failureCode: string,
  store: ProbeStorePort,
  canonical: { assertStillCanonical(cutoff: CanonicalCutoffV1): Promise<void> },
  service: AttestationServiceV1,
  signal: AbortSignal,
): Promise<readonly ProbeReceiptV1[]> {
  if (failureCode.length === 0) throw new TypeError("failureCode is empty");
  const keys = [...await store.listRetryableCandidateKeys(runId, failureCode)].sort(compareText);
  if (new Set(keys).size !== keys.length) throw new Error("duplicate-probe-candidate-key");
  const receipts: ProbeReceiptV1[] = [];
  for (const key of keys) {
    receipts.push(await probeRetryableCandidate(
      runId, key, store, canonical, service, signal,
    ));
  }
  return deepFreeze(receipts);
}
