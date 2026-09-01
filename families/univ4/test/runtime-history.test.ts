import assert from "node:assert/strict";
import test from "node:test";
import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
} from "../../../packages/capability-contracts/src/index.ts";
import type { TransportFactV1 } from "../../../packages/capability-interpreters/src/index.ts";
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
import type {
  FamilyStageDefinitionV1,
  FamilyStageGenericInvocationV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import {
  CORE_PROGRAM_ENVELOPE_SCHEMA,
  type FrozenProgramEnvelopeV1,
} from "../../../packages/request-program/src/index.ts";
import {
  UNIV4_CONTRACT_EVIDENCE_TOPIC,
  UNIV4_FAMILY_ID,
  UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
} from "../src/manifest.ts";
import { UNIV4_FAMILY_DEFINITION_HASH } from "../src/family-definition.ts";
import { UNIV4_IDENTITY_RUNTIME } from "../src/public.ts";
import { UNIV4_POOL_MANAGER, poolIdForKey, type Univ4PoolKey } from "../src/abi.ts";

const h = (label: string): Hash => hashDomain("aloha/univ4/runtime-history-test/v1", label);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: bigint): string => BigInt.asUintN(256, value).toString(16).padStart(64, "0");
const bytesHex = (value: Uint8Array): string => `0x${Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("")}`;
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const target = UNIV4_POOL_MANAGER.toLowerCase();
const poolKey: Univ4PoolKey = Object.freeze({ currency0: address("1"), currency1: address("2"), fee: "3000", tickSpacing: "60", hooks: address("0") });
const poolId = poolIdForKey(poolKey);
const initializeLog = Object.freeze({
  address: target,
  blockHash: h("initialize-block"),
  blockNumber: "0x64",
  data: `0x${word(3000n)}${word(60n)}${word(0n)}${word(1n << 96n)}${word(0n)}`,
  logIndex: "0x0",
  removed: false,
  topics: Object.freeze([
    UNIV4_CONTRACT_EVIDENCE_TOPIC,
    poolId,
    `0x${"0".repeat(24)}${poolKey.currency0.slice(2)}` as Hash,
    `0x${"0".repeat(24)}${poolKey.currency1.slice(2)}` as Hash,
  ]),
  transactionHash: h("initialize-transaction"),
  transactionIndex: "0x0",
});

function programFor(definition: FamilyStageDefinitionV1, payload: unknown, fingerprint: Hash): FrozenProgramEnvelopeV1 {
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
    requestFingerprint: fingerprint,
  });
}

function invocation(candidate: CanonicalJson): FamilyStageGenericInvocationV1 {
  return Object.freeze({ stage: "identity", candidate, cutoff, identityMemo: null, materializationOutput: null });
}

function interpret(prepared: unknown, requestIds: readonly Hash[], bytes: Uint8Array, fingerprint: Hash) {
  const facts: readonly TransportFactV1[] = requestIds.map(requestId => Object.freeze({
    kind: "returned" as const,
    requestId,
    requestFingerprint: fingerprint,
    dataHex: bytesHex(bytes),
    source: Object.freeze({
      chainId: cutoff.chainId,
      blockNumber: cutoff.number,
      blockHash: cutoff.hash,
      stateRoot: cutoff.stateRoot,
      executorAuthorityRoot: h("executor-authority"),
      workerEpoch: "epoch-1",
      executorSessionHash: h("executor-session"),
    }),
  }));
  return UNIV4_IDENTITY_RUNTIME.interpret({
    program: programFor(UNIV4_IDENTITY_RUNTIME, prepared, fingerprint),
    payload: prepared as CanonicalJson,
    facts,
    dependencyRefs: [],
    factSet: { factSetHash: h("fact-set") },
  });
}

test("UniV4 rolling-history source evidence reaches strict identity", () => {
  const plan = Object.freeze({
    ownerRef: h("history-owner"),
    sourcePlanRef: h("history-plan"),
    familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH,
    completeness: "rolling-observation" as const,
    historyStartBlock: null,
  });
  const filter = Object.freeze({ address: target, fromBlock: "0x0", toBlock: "0x64", topics: Object.freeze([UNIV4_CONTRACT_EVIDENCE_TOPIC]) });
  const observation = Object.freeze({
    kind: "family-source-plan-physical-observation" as const,
    version: 1 as const,
    requestId: h("history-request"),
    runtimeAuthority: Object.freeze({ authorityBindingHash: h("runtime-authority"), implementationCommit: "a".repeat(40) }),
    sourceAuthorityRoot: h("source-authority"),
    sourceAnchorRoot: h("source-anchor"),
    provider: "reth",
    backendEpoch: "epoch-1",
    familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH,
    plan,
    cutoff,
    requestSchemaHash: UNIV4_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
    request: Object.freeze({
      kind: "family-source-plan-rpc" as const,
      version: 1 as const,
      method: "eth_getLogs",
      params: Object.freeze([filter]),
      target,
      manager: target,
      topic: UNIV4_CONTRACT_EVIDENCE_TOPIC,
      lookback: Object.freeze({ from: "0", through: "100" }),
      chunk: Object.freeze({ maxBlocks: "500" }),
    }),
    response: Object.freeze([initializeLog]),
  });
  const bytes = encodeCanonicalBytes(observation);
  const evidence = Object.freeze([Object.freeze({
    kind: "source-plan" as const,
    version: 1 as const,
    ownerRef: plan.ownerRef,
    sourcePlanRef: plan.sourcePlanRef,
    evidenceRef: h("history-evidence"),
    rawLocatorHash: sha256Hex(bytes),
  })]);
  const candidate = Object.freeze({
    kind: "aloha.candidate-record" as const,
    version: "2" as const,
    familyId: UNIV4_FAMILY_ID,
    familyDefinitionHash: UNIV4_FAMILY_DEFINITION_HASH,
    instanceNominationKey: poolId,
    familyCandidateKey: familyCandidateKey(UNIV4_FAMILY_DEFINITION_HASH, poolId),
    candidateSubjectHash: candidateSubjectHash(UNIV4_FAMILY_DEFINITION_HASH, poolId),
    candidateEvidenceRoot: candidateEvidenceRoot(evidence),
    evidence,
  });
  const prepared = UNIV4_IDENTITY_RUNTIME.payloadCodec.decodeExact(UNIV4_IDENTITY_RUNTIME.prepareIssueValue(invocation(candidate)));
  const payload = prepared as Record<string, unknown>;
  const requestIds = payload.requestIds as readonly Hash[];
  const fingerprint = h("history-program");
  const outcome = interpret(prepared, requestIds, bytes, fingerprint);
  assert.equal(outcome.kind, "verified", JSON.stringify(outcome));
  if (outcome.kind !== "verified") throw new Error("UniV4 history identity failed");
  const output = UNIV4_IDENTITY_RUNTIME.outputCodec.decodeExact(outcome.output) as Record<string, unknown>;
  assert.equal(output.evidenceRoot, candidate.candidateEvidenceRoot);

  const forgedEvidence = Object.freeze([{ ...evidence[0]!, ownerRef: h("forged-owner") }]);
  const forgedCandidate = Object.freeze({ ...candidate, candidateEvidenceRoot: candidateEvidenceRoot(forgedEvidence), evidence: forgedEvidence });
  const forgedPrepared = UNIV4_IDENTITY_RUNTIME.payloadCodec.decodeExact(UNIV4_IDENTITY_RUNTIME.prepareIssueValue(invocation(forgedCandidate)));
  const forgedRequestIds = (forgedPrepared as Record<string, unknown>).requestIds as readonly Hash[];
  assert.equal(interpret(forgedPrepared, forgedRequestIds, bytes, fingerprint).kind, "invalidProgram");
});
