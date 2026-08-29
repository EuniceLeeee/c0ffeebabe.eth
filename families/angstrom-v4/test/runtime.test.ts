import assert from "node:assert/strict";
import test from "node:test";
import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
} from "../../../packages/capability-contracts/src/index.ts";
import type {
  TransportFactV1,
} from "../../../packages/capability-interpreters/src/index.ts";
import {
  CORE_PROGRAM_ENVELOPE_SCHEMA,
  type FrozenProgramEnvelopeV1,
} from "../../../packages/request-program/src/index.ts";
import {
  candidateEvidenceRoot,
  candidateSubjectHash,
  familyCandidateKey,
} from "../../../packages/discovery/src/index.ts";
import {
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { encodeEvmLogObservation } from "../../../packages/observation/src/index.ts";
import type {
  FamilyStageDefinitionV1,
  FamilyStageGenericInvocationV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import {
  ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC,
  ANGSTROM_V4_FAMILY_ID,
  ANGSTROM_V4_FAMILY_VERSION,
  ANGSTROM_V4_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
} from "../src/manifest.ts";
import { ANGSTROM_V4_FAMILY_DEFINITION_HASH } from "../src/family-definition.ts";
import {
  ANGSTROM_V4_IDENTITY_RUNTIME,
  ANGSTROM_V4_MATERIALIZATION_RUNTIME,
  ANGSTROM_V4_NOMINATION_RUNTIME,
  ANGSTROM_V4_PROJECTION_RUNTIME,
  ANGSTROM_V4_REHYDRATION_RUNTIME,
  ANGSTROM_V4_STAGE_DEFINITIONS,
} from "../src/runtime.ts";
import { nominateAngstromV4 } from "../src/stages.ts";
import { ANGSTROM_MAINNET_HOOK, ANGSTROM_V4_POOL_MANAGER, poolIdForKey, type AngstromV4PoolKey } from "../src/abi.ts";

type ReturnedFact = Extract<TransportFactV1, { readonly kind: "returned" }>;

const h = (label: string): Hash => hashDomain("aloha/angstrom-v4/runtime-test/v1", label);
const addr = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const reserveWords = (reserveIn: bigint, reserveOut: bigint): string => `0x${word(reserveIn)}${word(reserveOut)}`;
const bytesHex = (value: Uint8Array): string => `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;

const cutoff: { readonly chainId: string; readonly number: string; readonly hash: Hash; readonly stateRoot: Hash } = Object.freeze({
  chainId: "1",
  number: "100",
  hash: h("cutoff-block"),
  stateRoot: h("cutoff-state"),
});
const target = ANGSTROM_V4_POOL_MANAGER.toLowerCase();
const inputAsset = addr("1");
const outputAsset = addr("2");
const poolKey: AngstromV4PoolKey = Object.freeze({ currency0: inputAsset, currency1: outputAsset, fee: "3000", tickSpacing: "60", hooks: ANGSTROM_MAINNET_HOOK.toLowerCase() });
const poolId = "0x9e859ae72a6431be70d754d02ec0dd5d9ac95be3f293a80a917f95e9e0eea6a7" as const;
if (poolIdForKey(poolKey) !== poolId) throw new Error("independent PoolKey vector mismatch");
const initializeLog = Object.freeze({
  kind: "evm-log" as const,
  version: 1 as const,
  blockNumber: "100",
  blockHash: h("evidence-block"),
  transactionHash: h("evidence-tx"),
  logIndex: "0",
  address: target,
  topics: Object.freeze([
    ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC,
    poolId,
    `0x${"0".repeat(24)}${inputAsset.slice(2)}` as const,
    `0x${"0".repeat(24)}${outputAsset.slice(2)}` as const,
  ]),
  data: `0x${word(3000n)}${word(60n)}${word(BigInt(ANGSTROM_MAINNET_HOOK))}${word(1n << 96n)}${word(0n)}`,
});
const initializeBytes = encodeEvmLogObservation(initializeLog);
const initializeDataHex = `0x${Array.from(initializeBytes, byte => byte.toString(16).padStart(2, "0")).join("")}`;
const initializeRawLocatorHash = sha256Hex(initializeBytes);
const observation = Object.freeze({
  kind: "log" as const,
  cutoff,
  blockNumber: "100",
  blockHash: initializeLog.blockHash,
  txHash: initializeLog.transactionHash,
  logIndex: "0",
  target,
  topic: ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC,
  rawLocatorHash: initializeRawLocatorHash,
});
const seedNomination = nominateAngstromV4({ target, poolId, evidence: observation });
if (seedNomination.status !== "nominated") throw new Error("runtime fixture nomination failed");
const candidateEvidence = Object.freeze([Object.freeze({
  kind: "recent-log" as const,
  version: 1 as const,
  sourcePlanRef: null,
  ownerRef: null,
  blockNumber: observation.blockNumber,
  blockHash: observation.blockHash,
  txHash: observation.txHash,
  logIndex: observation.logIndex,
  address: observation.target,
  topic: observation.topic,
  rawLocatorHash: observation.rawLocatorHash,
})]);
const familyCandidate = Object.freeze({
  kind: "aloha.candidate-record" as const,
  version: "2" as const,
  familyId: ANGSTROM_V4_FAMILY_ID,
  familyDefinitionHash: ANGSTROM_V4_FAMILY_DEFINITION_HASH,
  instanceNominationKey: seedNomination.candidate.instanceNominationKey,
  familyCandidateKey: familyCandidateKey(ANGSTROM_V4_FAMILY_DEFINITION_HASH, seedNomination.candidate.instanceNominationKey),
  candidateSubjectHash: candidateSubjectHash(ANGSTROM_V4_FAMILY_DEFINITION_HASH, seedNomination.candidate.instanceNominationKey),
  candidateEvidenceRoot: candidateEvidenceRoot(candidateEvidence),
  evidence: candidateEvidence,
});

function invocation(
  stage: "nomination" | "identity" | "materialization" | "projection" | "rehydration",
  identityMemo: CanonicalJson | null = null,
  materializationOutput: CanonicalJson | null = null,
): FamilyStageGenericInvocationV1 {
  return { stage, candidate: familyCandidate, cutoff, identityMemo, materializationOutput };
}

function payloadRecord(value: unknown): Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected payload object");
  return value as Record<string, any>;
}

function programFor(definition: FamilyStageDefinitionV1, payload: unknown, requestFingerprint: Hash): FrozenProgramEnvelopeV1 {
  const canonicalPayloadBytes = encodeCanonicalJson(payload);
  return Object.freeze({
    schemaVersion: 1,
    kind: "aloha.frozen-program",
    envelopeSchemaRef: CORE_PROGRAM_ENVELOPE_SCHEMA,
    payloadSchemaRef: asSchemaRef(definition.schemaHash),
    capabilityRef: Object.freeze({
      capabilityId: asCapabilityId(definition.capabilityId),
      version: asCapabilityVersion(definition.version),
      schemaHash: asSchemaRef(definition.schemaHash),
      interpreterHash: h("interpreter"),
      ownerRef: asOwnerRef(h("owner")),
    }),
    issuerRef: asOwnerRef(h("issuer")),
    source: cutoff,
    authorityHash: h("program-authority"),
    canonicalPayloadBytes,
    payloadHash: hashDomain("aloha/program-payload/v1", { schemaRef: definition.schemaHash, canonicalPayloadBytes }),
    requestFingerprint,
  });
}

function factSource(): TransportFactV1["source"] {
  return {
    chainId: cutoff.chainId,
    blockNumber: cutoff.number,
    blockHash: cutoff.hash,
    stateRoot: cutoff.stateRoot,
    executorAuthorityRoot: h("executor-authority"),
    workerEpoch: "epoch-1",
    executorSessionHash: h("executor-session"),
  };
}

function returnedFacts(requestIds: readonly Hash[], dataHex: readonly string[], requestFingerprint: Hash): readonly ReturnedFact[] {
  return requestIds.map((requestId, index) => ({
    kind: "returned" as const,
    requestId,
    requestFingerprint,
    dataHex: dataHex[index]!,
    source: factSource(),
  }));
}

function interpret(
  definition: FamilyStageDefinitionV1,
  prepared: unknown,
  facts: readonly TransportFactV1[],
  requestFingerprint = h(`${definition.stage}-program`),
) {
  return definition.interpret({
    program: programFor(definition, prepared, requestFingerprint),
    payload: prepared as CanonicalJson,
    facts,
    dependencyRefs: [],
    factSet: { factSetHash: h("framework-fact-set") },
  });
}

function prepare(definition: FamilyStageDefinitionV1, input: ReturnType<typeof invocation>): unknown {
  return definition.payloadCodec.decodeExact(definition.prepareIssueValue(input));
}

test("Angstrom v4 exports five deeply frozen Family stage definitions", () => {
  assert.deepEqual(ANGSTROM_V4_STAGE_DEFINITIONS.map(definition => definition.stage), ["nomination", "identity", "materialization", "projection", "rehydration"]);
  for (const definition of ANGSTROM_V4_STAGE_DEFINITIONS) {
    assert.equal(Object.isFrozen(definition), true);
    assert.equal(Object.isFrozen(definition.payloadCodec), true);
    assert.equal(Object.isFrozen(definition.outputCodec), true);
    assert.equal(Object.isFrozen(definition.dependencyIds), true);
    assert.equal(definition.schemaHash, definition.payloadCodec.schemaRef);
    assert.equal("executor" in definition, false);
    assert.equal("issuer" in definition, false);
  }
});

test("generic lifecycle input becomes bound nomination, identity, materialization, projection, and rehydration payloads", () => {
  const nominationPayload = prepare(ANGSTROM_V4_NOMINATION_RUNTIME, invocation("nomination"));
  const nomination = payloadRecord(nominationPayload);
  const nominationFingerprint = h("nomination-program");
  const nominationOutcome = interpret(ANGSTROM_V4_NOMINATION_RUNTIME, nominationPayload, returnedFacts([nomination.requestId], [`0x${familyCandidate.candidateSubjectHash.slice(2)}`], nominationFingerprint), nominationFingerprint);
  assert.equal(nominationOutcome.kind, "verified");

  const identityPayload = prepare(ANGSTROM_V4_IDENTITY_RUNTIME, invocation("identity"));
  const identity = payloadRecord(identityPayload);
  const identityFingerprint = h("identity-program");
  const identityOutcome = interpret(ANGSTROM_V4_IDENTITY_RUNTIME, identityPayload, returnedFacts(
    identity.requestIds,
    [initializeDataHex],
    identityFingerprint,
  ), identityFingerprint);
  assert.equal(identityOutcome.kind, "verified");
  if (identityOutcome.kind !== "verified") throw new Error("identity fixture failed");
  const identityObservation = payloadRecord(ANGSTROM_V4_IDENTITY_RUNTIME.outputCodec.decodeExact(identityOutcome.output));
  const identityMemo = identityObservation.identityMemo as CanonicalJson;
  const memoRecord = payloadRecord(identityMemo);
  const strictIdentity = payloadRecord(memoRecord.identity);
  const strictFacts = payloadRecord(strictIdentity.facts);
  const { poolKey: _removedPoolKey, ...factsWithoutPoolKey } = strictFacts;
  assert.throws(() => ANGSTROM_V4_IDENTITY_RUNTIME.outputCodec.decodeExact({
    ...identityObservation,
    identityMemo: { ...memoRecord, identity: { ...strictIdentity, facts: factsWithoutPoolKey } },
  }), /poolKey|invalid fields|identity facts/);

  const materializationPayload = prepare(ANGSTROM_V4_MATERIALIZATION_RUNTIME, invocation("materialization", identityMemo));
  const materialization = payloadRecord(materializationPayload);
  const materializationFingerprint = h("materialization-program");
  const materializationOutcome = interpret(ANGSTROM_V4_MATERIALIZATION_RUNTIME, materializationPayload, returnedFacts(
    [materialization.requestId],
    [reserveWords(100n, 200n)],
    materializationFingerprint,
  ), materializationFingerprint);
  assert.equal(materializationOutcome.kind, "verified");
  if (materializationOutcome.kind !== "verified") throw new Error("materialization fixture failed");
  const materializationOutput = ANGSTROM_V4_MATERIALIZATION_RUNTIME.outputCodec.decodeExact(materializationOutcome.output);

  const projectionPayload = prepare(ANGSTROM_V4_PROJECTION_RUNTIME, invocation("projection", identityMemo, materializationOutput));
  const projection = payloadRecord(projectionPayload);
  const projectionFingerprint = h("projection-program");
  const projectionOutcome = interpret(ANGSTROM_V4_PROJECTION_RUNTIME, projectionPayload, returnedFacts(
    [projection.requestId],
    [reserveWords(100n, 200n)],
    projectionFingerprint,
  ), projectionFingerprint);
  assert.equal(projectionOutcome.kind, "verified");
  if (projectionOutcome.kind !== "verified") throw new Error("projection fixture failed");
  const publication = ANGSTROM_V4_PROJECTION_RUNTIME.outputCodec.decodeExact(projectionOutcome.output);
  assert.equal(payloadRecord(publication).familyId, ANGSTROM_V4_FAMILY_ID);

  const rehydrationPayload = prepare(ANGSTROM_V4_REHYDRATION_RUNTIME, invocation("rehydration"));
  const rehydration = payloadRecord(rehydrationPayload);
  const rehydrationFingerprint = h("rehydration-program");
  const rehydrationOutcome = interpret(ANGSTROM_V4_REHYDRATION_RUNTIME, rehydrationPayload, returnedFacts(
    [rehydration.requestId],
    [`0x${rehydration.referenceHash.slice(2)}`],
    rehydrationFingerprint,
  ), rehydrationFingerprint);
  assert.equal(rehydrationOutcome.kind, "verified");
});

test("candidate, prior-output, request, and source mutations fail closed", () => {
  assert.throws(() => prepare(ANGSTROM_V4_IDENTITY_RUNTIME, {
    ...invocation("identity"),
    candidate: { ...familyCandidate, familyCandidateKey: h("forged-key") },
  }), /candidate-key-mismatch/);
  assert.throws(() => prepare(ANGSTROM_V4_IDENTITY_RUNTIME, {
    ...invocation("identity"),
    cutoff: { ...cutoff, number: "99" },
  }), /candidate-(?:cutoff-mismatch|evidence-after-cutoff)/);
  assert.throws(() => prepare(ANGSTROM_V4_MATERIALIZATION_RUNTIME, invocation("materialization")), /prior-output/);
  assert.throws(() => prepare(ANGSTROM_V4_PROJECTION_RUNTIME, invocation("projection")), /prior-output/);

  const prepared = prepare(ANGSTROM_V4_IDENTITY_RUNTIME, invocation("identity"));
  const payload = payloadRecord(prepared);
  const fingerprint = h("identity-program");
  const ids = payload.requestIds as readonly Hash[];
  const valid = returnedFacts(ids, [initializeDataHex], fingerprint);
  assert.equal(interpret(ANGSTROM_V4_IDENTITY_RUNTIME, prepared, valid, fingerprint).kind, "verified");
  assert.equal(interpret(ANGSTROM_V4_IDENTITY_RUNTIME, prepared, [], fingerprint).kind, "invalidProgram");
  assert.equal(interpret(ANGSTROM_V4_IDENTITY_RUNTIME, prepared, [valid[0]!, valid[0]!], fingerprint).kind, "invalidProgram");
  assert.equal(interpret(ANGSTROM_V4_IDENTITY_RUNTIME, prepared, valid.map(fact => ({ ...fact, source: { ...fact.source, blockNumber: "99" } })), fingerprint).kind, "invalidProgram");
  assert.equal(interpret(ANGSTROM_V4_IDENTITY_RUNTIME, prepared, valid.map(fact => ({ kind: "reverted" as const, requestId: fact.requestId, requestFingerprint: fact.requestFingerprint, dataHex: fact.dataHex, source: fact.source })), fingerprint).kind, "invalidProgram");
  assert.equal(interpret(ANGSTROM_V4_IDENTITY_RUNTIME, prepared, valid.map(fact => ({ ...fact, dataHex: "0x01" })), fingerprint).kind, "invalidProgram");
});

test("mutated Initialize bytes are invalid while zero materialized state is chain-proven rejected", () => {
  const identityPayload = prepare(ANGSTROM_V4_IDENTITY_RUNTIME, invocation("identity"));
  const identity = payloadRecord(identityPayload);
  const fingerprint = h("identity-rejection-program");
  const rejected = interpret(ANGSTROM_V4_IDENTITY_RUNTIME, identityPayload, returnedFacts(
    identity.requestIds,
    [`${initializeDataHex.slice(0, -2)}00`],
    fingerprint,
  ), fingerprint);
  assert.equal(rejected.kind, "invalidProgram");

  const validIdentity = interpret(ANGSTROM_V4_IDENTITY_RUNTIME, identityPayload, returnedFacts(
    identity.requestIds,
    [initializeDataHex],
    fingerprint,
  ), fingerprint);
  if (validIdentity.kind !== "verified") throw new Error("identity fixture failed");
  const identityMemo = payloadRecord(ANGSTROM_V4_IDENTITY_RUNTIME.outputCodec.decodeExact(validIdentity.output)).identityMemo as CanonicalJson;
  const statePayload = prepare(ANGSTROM_V4_MATERIALIZATION_RUNTIME, invocation("materialization", identityMemo));
  const state = payloadRecord(statePayload);
  const stateOutcome = interpret(ANGSTROM_V4_MATERIALIZATION_RUNTIME, statePayload, returnedFacts([state.requestId], [reserveWords(0n, 200n)], h("state-zero-program")), h("state-zero-program"));
  assert.equal(stateOutcome.kind, "chainProvenRejected");
});

test("transport failures cannot be upgraded by the Family interpreter", () => {
  const prepared = prepare(ANGSTROM_V4_IDENTITY_RUNTIME, invocation("identity"));
  const payload = payloadRecord(prepared);
  const fingerprint = h("transport-failure-program");
  const failure = {
    kind: "transportFailure" as const,
    requestId: payload.requestIds[0] as Hash,
    requestFingerprint: fingerprint,
    failureCode: "rpc" as const,
    source: factSource(),
  };
  assert.equal(interpret(ANGSTROM_V4_IDENTITY_RUNTIME, prepared, [failure], fingerprint).kind, "invalidProgram");
});

test("contiguous-history source evidence reaches the same strict identity stage", () => {
  const historyPlan = Object.freeze({
    ownerRef: h("history-owner"),
    sourcePlanRef: h("history-plan"),
    familyDefinitionHash: ANGSTROM_V4_FAMILY_DEFINITION_HASH,
    completeness: "contiguous-history" as const,
    historyStartBlock: "0",
  });
  const filter = Object.freeze({
    address: target,
    fromBlock: "0x0",
    toBlock: "0x64",
    topics: Object.freeze([ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC]),
  });
  const historyLog = Object.freeze({
    address: target,
    blockHash: initializeLog.blockHash,
    blockNumber: "0x64",
    data: initializeLog.data,
    logIndex: "0x0",
    removed: false,
    topics: initializeLog.topics,
    transactionHash: initializeLog.transactionHash,
    transactionIndex: "0x0",
  });
  const physicalObservation = Object.freeze({
    kind: "family-source-plan-physical-observation" as const,
    version: 1 as const,
    requestId: h("history-request"),
    releaseBindingId: h("history-release-binding"),
    releaseProvenanceHash: h("history-release-provenance"),
    sourceAuthorityRoot: h("history-source-authority"),
    sourceAnchorRoot: h("history-source-anchor"),
    provider: "reth",
    backendEpoch: "epoch-1",
    familyDefinitionHash: ANGSTROM_V4_FAMILY_DEFINITION_HASH,
    plan: historyPlan,
    cutoff,
    requestSchemaHash: ANGSTROM_V4_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
    request: Object.freeze({
      kind: "family-source-plan-rpc" as const,
      version: 1 as const,
      method: "eth_getLogs",
      params: Object.freeze([filter]),
      target,
      manager: target,
      topic: ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC,
      lookback: Object.freeze({ from: "0", through: "100" }),
      chunk: Object.freeze({ maxBlocks: "10000" }),
    }),
    response: Object.freeze([historyLog]),
  });
  const historyBytes = encodeCanonicalBytes(physicalObservation);
  const historyEvidence = Object.freeze([Object.freeze({
    kind: "source-plan" as const,
    version: 1 as const,
    ownerRef: historyPlan.ownerRef,
    sourcePlanRef: historyPlan.sourcePlanRef,
    evidenceRef: h("history-evidence"),
    rawLocatorHash: sha256Hex(historyBytes),
  })]);
  const historyCandidate = Object.freeze({
    kind: "aloha.candidate-record" as const,
    version: "2" as const,
    familyId: ANGSTROM_V4_FAMILY_ID,
    familyDefinitionHash: ANGSTROM_V4_FAMILY_DEFINITION_HASH,
    instanceNominationKey: poolId,
    familyCandidateKey: familyCandidateKey(ANGSTROM_V4_FAMILY_DEFINITION_HASH, poolId),
    candidateSubjectHash: candidateSubjectHash(ANGSTROM_V4_FAMILY_DEFINITION_HASH, poolId),
    candidateEvidenceRoot: candidateEvidenceRoot(historyEvidence),
    evidence: historyEvidence,
  });
  const prepared = prepare(ANGSTROM_V4_IDENTITY_RUNTIME, { ...invocation("identity"), candidate: historyCandidate });
  const payload = payloadRecord(prepared);
  const fingerprint = h("history-identity-program");
  const outcome = interpret(ANGSTROM_V4_IDENTITY_RUNTIME, prepared, returnedFacts(payload.requestIds, [bytesHex(historyBytes)], fingerprint), fingerprint);
  assert.equal(outcome.kind, "verified");
  if (outcome.kind !== "verified") throw new Error("history identity fixture failed");
  const output = payloadRecord(ANGSTROM_V4_IDENTITY_RUNTIME.outputCodec.decodeExact(outcome.output));
  assert.equal(output.evidenceRoot, historyCandidate.candidateEvidenceRoot);

  const forgedEvidence = Object.freeze([{ ...historyEvidence[0]!, ownerRef: h("forged-history-owner") }]);
  const forgedCandidate = Object.freeze({ ...historyCandidate, candidateEvidenceRoot: candidateEvidenceRoot(forgedEvidence), evidence: forgedEvidence });
  const forgedPrepared = prepare(ANGSTROM_V4_IDENTITY_RUNTIME, { ...invocation("identity"), candidate: forgedCandidate });
  const forgedPayload = payloadRecord(forgedPrepared);
  const forgedOutcome = interpret(ANGSTROM_V4_IDENTITY_RUNTIME, forgedPrepared, returnedFacts(forgedPayload.requestIds, [bytesHex(historyBytes)], fingerprint), fingerprint);
  assert.equal(forgedOutcome.kind, "invalidProgram");
});
