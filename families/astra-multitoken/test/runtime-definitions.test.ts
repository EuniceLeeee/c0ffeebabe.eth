import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  encodeCanonicalJson,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import type { FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import type { FrozenProgramEnvelopeV1 } from "../../../packages/request-program/src/index.ts";
import { mergeAndDedupeNominations, type RecentLogEvidenceRefV1, type SourcePlanEvidenceRefV1 } from "../../../packages/discovery/src/index.ts";
import { encodeEvmLogObservation } from "../../../packages/observation/src/index.ts";
import {
  ASTRA_CHANGE_TOPIC,
  ASTRA_FAMILY_DEFINITION_HASH,
  ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  ASTRA_FAMILY_ID,
  ASTRA_IDENTITY_DEFINITION,
  ASTRA_MATERIALIZATION_DEFINITION,
  ASTRA_PROJECTION_DEFINITION,
  ASTRA_NOMINATION_DEFINITION,
  ASTRA_REHYDRATION_DEFINITION,
} from "../src/public.ts";
import type { Address } from "../src/types.ts";

const h = (value: string): Hash => hashDomain("test/astra-runtime-definitions", value);
const address = (digit: string): Address => `0x${digit.repeat(40)}` as Address;
const target = address("1");
const actor = address("2");
const tokenIn = address("3");
const tokenOut = address("4");
const source = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const executorSource = Object.freeze({ ...source, blockNumber: source.number, blockHash: source.hash, executorAuthorityRoot: h("executor"), workerEpoch: "7", executorSessionHash: h("session") });
const word = (value: string): string => value.slice(2).padStart(64, "0");
const bytesHex = (bytes: Uint8Array): string => `0x${Array.from(bytes).map(value => value.toString(16).padStart(2, "0")).join("")}`;
const canonical = (value: unknown): CanonicalJson => decodeCanonicalJson(encodeCanonicalJson(value));

const changeData = `0x${"7".padStart(64, "0")}${"5".padStart(64, "0")}`;
const changeTopics = Object.freeze([ASTRA_CHANGE_TOPIC, `0x${word(tokenIn)}`, `0x${word(tokenOut)}`, `0x${word(actor)}`] as readonly Hash[]);
const recentEvidenceBytes = encodeEvmLogObservation({
  kind: "evm-log",
  version: 1,
  blockNumber: source.number,
  blockHash: source.hash,
  transactionHash: h("tx"),
  logIndex: "0",
  address: target,
  topics: changeTopics,
  data: changeData,
});

const evidence: RecentLogEvidenceRefV1 = Object.freeze({
  kind: "recent-log",
  version: 1,
  sourcePlanRef: null,
  ownerRef: null,
  blockNumber: source.number,
  blockHash: source.hash,
  txHash: h("tx"),
  logIndex: "0",
  address: target,
  topic: ASTRA_CHANGE_TOPIC,
  rawLocatorHash: sha256Hex(recentEvidenceBytes),
});

const candidateRecord = mergeAndDedupeNominations([{
  kind: "aloha.candidate-nomination",
  version: "2",
  familyId: ASTRA_FAMILY_ID,
  familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH,
  instanceNominationKey: target,
  evidence,
}])[0]!;
const candidateRecordCanonical = canonical(candidateRecord);

const witness = {
  target,
  actor,
  tokenIn,
  tokenOut,
  amountIn: "7",
  minAmountOut: "5",
  observedAmountOut: "5",
  sourceKind: "change-log" as const,
  txHash: h("tx"),
  logIndex: "0",
};

const identityFact = {
  kind: "astra-identity-facts" as const,
  version: 1 as const,
  candidateSnapshotHash: candidateRecord.candidateSubjectHash,
  candidateEvidenceBytesHex: bytesHex(recentEvidenceBytes),
  candidate: witness,
  reads: {
    target,
    tokens: [tokenIn, tokenOut],
    tokenCodeHashes: [h("in-code"), h("out-code")],
    weights: ["50", "50"],
    changesEnabled: true,
    totalPercents: "100",
    changeFee: "1",
    inLendingMode: null,
    activeQuote: "9",
  },
};

function historyFixture(physicalOwnerRef: Hash, evidenceOwnerRef: Hash) {
  const plan = Object.freeze({
    ownerRef: physicalOwnerRef,
    sourcePlanRef: h("history-source-plan"),
    familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH,
    completeness: "contiguous-history" as const,
    historyStartBlock: "0",
  });
  const historyTx = h("history-tx");
  const response = Object.freeze([Object.freeze({
    address: target,
    blockHash: source.hash,
    blockNumber: "0x64",
    data: changeData,
    logIndex: "0x0",
    removed: false,
    topics: changeTopics,
    transactionHash: historyTx,
    transactionIndex: "0x0",
  })]);
  const filter = Object.freeze({ fromBlock: "0x0", toBlock: "0x64", topics: Object.freeze([ASTRA_CHANGE_TOPIC]) });
  const rawBytes = encodeCanonicalBytes({
    kind: "family-source-plan-physical-observation",
    version: 1,
    requestId: h("history-request"),
    releaseBindingId: h("history-release-binding"),
    releaseProvenanceHash: h("history-release-provenance"),
    sourceAuthorityRoot: h("history-source-authority"),
    sourceAnchorRoot: h("history-source-anchor"),
    provider: "history-provider",
    backendEpoch: "1",
    familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH,
    plan,
    cutoff: source,
    requestSchemaHash: ASTRA_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
    request: {
      kind: "family-source-plan-rpc",
      version: 1,
      method: "eth_getLogs",
      params: [filter],
      target: null,
      manager: null,
      topic: ASTRA_CHANGE_TOPIC,
      lookback: { from: "0", through: "100" },
      chunk: { maxBlocks: "10000" },
    },
    response,
  });
  const evidence: SourcePlanEvidenceRefV1 = Object.freeze({
    kind: "source-plan",
    version: 1,
    ownerRef: evidenceOwnerRef,
    sourcePlanRef: plan.sourcePlanRef,
    evidenceRef: h("history-evidence"),
    rawLocatorHash: sha256Hex(rawBytes),
  });
  const record = mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: ASTRA_FAMILY_ID,
    familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH,
    instanceNominationKey: target,
    evidence,
  }])[0]!;
  return Object.freeze({
    candidate: canonical(record),
    fact: {
      ...identityFact,
      candidateSnapshotHash: record.candidateSubjectHash,
      candidateEvidenceBytesHex: bytesHex(rawBytes),
      candidate: { ...witness, txHash: historyTx },
    },
  });
}

function program(definition: FamilyStageDefinitionV1, requestFingerprint: Hash): FrozenProgramEnvelopeV1 {
  return {
    schemaVersion: 1,
    kind: "aloha.frozen-program",
    envelopeSchemaRef: h("envelope"),
    payloadSchemaRef: definition.schemaHash,
    capabilityRef: {
      capabilityId: definition.capabilityId,
      version: definition.version,
      schemaHash: definition.schemaHash,
      interpreterHash: h("interpreter"),
      ownerRef: asOwnerRef(h("owner")),
    },
    issuerRef: asOwnerRef(h("issuer")),
    source,
    authorityHash: h("authority"),
    canonicalPayloadBytes: "null",
    payloadHash: h("payload"),
    requestFingerprint,
  };
}

function returnedFact(requestId: Hash, requestFingerprint: Hash, value: unknown): TransportFactV1 {
  return {
    kind: "returned",
    requestId,
    requestFingerprint,
    dataHex: bytesHex(encodeCanonicalBytes(value)),
    source: executorSource,
  };
}

function prepare(definition: FamilyStageDefinitionV1, input: Parameters<FamilyStageDefinitionV1["prepareIssueValue"]>[0]): { readonly payload: CanonicalJson; readonly requestId: Hash } {
  const payload = canonical(definition.payloadCodec.decodeExact(definition.prepareIssueValue(input)));
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw new Error("fixture payload is not an object");
  const requestId = (payload as { readonly requestId?: unknown }).requestId;
  if (typeof requestId !== "string") throw new Error("fixture request id missing");
  return { payload, requestId: requestId as Hash };
}

function interpret(definition: FamilyStageDefinitionV1, payload: CanonicalJson, requestId: Hash, value: unknown, label: string) {
  const requestFingerprint = h(`${label}-program`);
  return definition.interpret({
    program: program(definition, requestFingerprint),
    payload,
    facts: [returnedFact(requestId, requestFingerprint, value)],
    dependencyRefs: [],
    factSet: { factSetHash: h(`${label}-fact-set`) },
  });
}

test("Astra runtime definitions run identity, materialization and projection with exact lineage", () => {
  const identityPrepared = prepare(ASTRA_IDENTITY_DEFINITION, {
    stage: "identity",
    candidate: candidateRecordCanonical,
    cutoff: source,
    identityMemo: null,
    materializationOutput: null,
  });
  const identity = interpret(ASTRA_IDENTITY_DEFINITION, identityPrepared.payload, identityPrepared.requestId, identityFact, "identity");
  assert.equal(identity.kind, "verified", JSON.stringify(identity));
  if (identity.kind !== "verified") return;
  const identityOutput = identity.output as { readonly identityMemo: CanonicalJson };

  const materializationPrepared = prepare(ASTRA_MATERIALIZATION_DEFINITION, {
    stage: "materialization",
    candidate: candidateRecordCanonical,
    cutoff: source,
    identityMemo: identityOutput.identityMemo,
    materializationOutput: null,
  });
  const materialization = interpret(ASTRA_MATERIALIZATION_DEFINITION, materializationPrepared.payload, materializationPrepared.requestId, {
    kind: "astra-materialization-facts",
    version: 1,
    target,
    identityFactsHash: h("identity-facts-placeholder"),
  }, "materialization");
  // The identity facts hash is part of the verified memo; use the exact value
  // emitted by the definition for the positive materialization fact.
  const identityMemo = identityOutput.identityMemo as { readonly identity: { readonly factsHash: Hash } };
  const materializationPositive = interpret(ASTRA_MATERIALIZATION_DEFINITION, materializationPrepared.payload, materializationPrepared.requestId, {
    kind: "astra-materialization-facts",
    version: 1,
    target,
    identityFactsHash: identityMemo.identity.factsHash,
  }, "materialization-positive");
  assert.equal(materialization.kind, "invalidProgram");
  assert.equal(materializationPositive.kind, "verified");
  if (materializationPositive.kind !== "verified") return;

  const projectionPrepared = prepare(ASTRA_PROJECTION_DEFINITION, {
    stage: "projection",
    candidate: candidateRecordCanonical,
    cutoff: source,
    identityMemo: identityOutput.identityMemo,
    materializationOutput: materializationPositive.output as CanonicalJson,
  });
  const projection = interpret(ASTRA_PROJECTION_DEFINITION, projectionPrepared.payload, projectionPrepared.requestId, {
    kind: "astra-projection-facts",
    version: 1,
    target,
    instanceKey: target,
    identityFactsHash: identityMemo.identity.factsHash,
  }, "projection");
  assert.equal(projection.kind, "verified");
});

test("Astra runtime definitions reject request/fact lineage mutations and keep owner-only stages closed", () => {
  const prepared = prepare(ASTRA_IDENTITY_DEFINITION, {
    stage: "identity",
    candidate: candidateRecordCanonical,
    cutoff: source,
    identityMemo: null,
    materializationOutput: null,
  });
  const mutatedPayload = { ...prepared.payload as Record<string, CanonicalJson>, requestId: h("wrong-request") };
  const outcome = interpret(ASTRA_IDENTITY_DEFINITION, mutatedPayload, prepared.requestId, identityFact, "mutated");
  assert.equal(outcome.kind, "invalidProgram");
  const forgedRaw = interpret(ASTRA_IDENTITY_DEFINITION, prepared.payload, prepared.requestId, {
    ...identityFact,
    candidateEvidenceBytesHex: `${identityFact.candidateEvidenceBytesHex}00`,
  }, "forged-raw");
  assert.equal(forgedRaw.kind, "invalidProgram");
  assert.throws(() => ASTRA_NOMINATION_DEFINITION.prepareIssueValue({ stage: "nomination", candidate: candidateRecordCanonical, cutoff: source, identityMemo: null, materializationOutput: null }));
  assert.throws(() => ASTRA_REHYDRATION_DEFINITION.prepareIssueValue({ stage: "rehydration", candidate: candidateRecordCanonical, cutoff: source, identityMemo: null, materializationOutput: null }));
});

test("Astra strict identity consumes complete-history physical evidence and rejects a forged owner", () => {
  const owner = h("history-owner");
  const valid = historyFixture(owner, owner);
  const prepared = prepare(ASTRA_IDENTITY_DEFINITION, {
    stage: "identity",
    candidate: valid.candidate,
    cutoff: source,
    identityMemo: null,
    materializationOutput: null,
  });
  const verified = interpret(ASTRA_IDENTITY_DEFINITION, prepared.payload, prepared.requestId, valid.fact, "history-valid");
  assert.equal(verified.kind, "verified", JSON.stringify(verified));

  const forged = historyFixture(h("forged-history-owner"), owner);
  const forgedPrepared = prepare(ASTRA_IDENTITY_DEFINITION, {
    stage: "identity",
    candidate: forged.candidate,
    cutoff: source,
    identityMemo: null,
    materializationOutput: null,
  });
  const rejected = interpret(ASTRA_IDENTITY_DEFINITION, forgedPrepared.payload, forgedPrepared.requestId, forged.fact, "history-forged-owner");
  assert.equal(rejected.kind, "invalidProgram");
});
