import assert from "node:assert/strict";
import test from "node:test";
import type {
  FrameworkFactSetCapabilityV1,
  TransportFactV1,
} from "../../../packages/capability-interpreters/src/index.ts";
import {
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { sealInstancePublication, type InstancePublicationV1 } from "../../../packages/catalog/src/index.ts";
import { mergeAndDedupeNominations, type CandidateRecordV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilyStageDefinitionV1 } from "../../../packages/family-sdk/runtime/index.ts";
import type { FrozenProgramEnvelopeV1, ProgramSourceAnchorV1 } from "../../../packages/request-program/src/index.ts";
import {
  nominateUniV2,
  UNIV2_GET_RESERVES_SELECTOR,
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_DEFINITION,
  PUBLIC_ENTRY,
  UNIV2_STANDARD_RUNTIME_DEFINITIONS,
  UNIV2_STANDARD_STAGE_EXPORT_NAMES,
  UNIV2_STANDARD_STAGE_DEFINITIONS,
  UNIV2_STANDARD_STAGE_IDS,
  type UniV2IdentityVerifiedV1,
} from "../src/public.ts";
import type { UniV2MaterializedStateV1 } from "../src/schema/index.ts";

const hash = (value: string): Hash => hashDomain("aloha/univ2-standard/runtime-test/v1", value);
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const addressWord = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;

const cutoff = Object.freeze({
  chainId: "1",
  number: "100",
  hash: hash("cutoff-hash"),
  stateRoot: hash("cutoff-state"),
});
const source: ProgramSourceAnchorV1 = cutoff;
const pool = address("1");
const token0 = address("2");
const token1 = address("3");
const factory = address("f");
const nominationObservation = Object.freeze({
  pool,
  evidence: Object.freeze({
    cutoff,
    blockNumber: "99",
    blockHash: hash("evidence-block"),
    txHash: hash("evidence-tx"),
    logIndex: "0",
    emitter: pool,
    topic0: "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1" as Hash,
    rawLocatorHash: hash("evidence-locator"),
  }),
});

function nomination() {
  const result = nominateUniV2(nominationObservation);
  assert.equal(result.status, "nominated");
  return result.candidate;
}

function genericCandidate(candidate = nomination()) {
  if ("kind" in candidate.evidence) throw new Error("runtime fixture expected recent-log evidence");
  return mergeAndDedupeNominations([{
    kind: "aloha.candidate-nomination",
    version: "2",
    familyId: "univ2-standard",
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    instanceNominationKey: candidate.instanceNominationKey,
    evidence: {
      kind: "recent-log" as const,
      version: 1 as const,
      ownerRef: null,
      sourcePlanRef: null,
      blockNumber: candidate.evidence.blockNumber,
      blockHash: candidate.evidence.blockHash,
      txHash: candidate.evidence.txHash,
      logIndex: candidate.evidence.logIndex,
      address: candidate.evidence.emitter,
      topic: candidate.evidence.topic0,
      rawLocatorHash: candidate.evidence.rawLocatorHash,
    },
  }])[0]! as unknown as CandidateRecordV1 & Readonly<Record<string, CanonicalJson>>;
}

function identityPayload(candidate: ReturnType<typeof nomination>) {
  const generic = genericCandidate(candidate);
  return UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "identity")!.prepareIssueValue({
    stage: "identity",
    candidate: generic,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
  }) as { readonly requestIds: readonly Hash[] };
}

function reservesRequestId() {
  return hashDomain("aloha/univ2-standard/request-id/v1", {
    phase: "materialization",
    target: pool,
    data: UNIV2_GET_RESERVES_SELECTOR,
    cutoff,
  });
}

function program(requestFingerprint: Hash): FrozenProgramEnvelopeV1 {
  return {
    schemaVersion: 1,
    kind: "aloha.frozen-program",
    envelopeSchemaRef: hash("envelope-schema"),
    payloadSchemaRef: hash("payload-schema") as never,
    capabilityRef: {} as never,
    issuerRef: hash("issuer") as never,
    source,
    authorityHash: hash("authority"),
    canonicalPayloadBytes: "{}",
    payloadHash: hash("payload"),
    requestFingerprint,
  };
}

function factSource(): TransportFactV1["source"] {
  return {
    chainId: source.chainId,
    blockNumber: source.number,
    blockHash: source.hash,
    stateRoot: source.stateRoot,
    executorAuthorityRoot: hash("executor-authority"),
    workerEpoch: "epoch-1",
    executorSessionHash: hash("executor-session"),
  };
}

function returnedFacts(
  requestFingerprint: Hash,
  requestIds: readonly Hash[],
  data: readonly string[],
): readonly TransportFactV1[] {
  return Object.freeze(requestIds.map((requestId, index) => ({
    kind: "returned" as const,
    requestId,
    requestFingerprint,
    dataHex: data[index]!,
    source: factSource(),
  })));
}

function factSet(): FrameworkFactSetCapabilityV1 {
  return Object.freeze({ factSetHash: hash("framework-fact-set") });
}

function interpret(
  definition: FamilyStageDefinitionV1,
  payload: unknown,
  facts: readonly TransportFactV1[],
  requestFingerprint = hash(`${definition.stage}-program`),
) {
  return definition.interpret({
    program: program(requestFingerprint),
    payload: payload as never,
    facts,
    dependencyRefs: [],
    factSet: factSet(),
  });
}

function requireVerified(definition: FamilyStageDefinitionV1, payload: unknown, facts: readonly TransportFactV1[]) {
  const draft = interpret(definition, payload, facts);
  if (draft.kind !== "verified") throw new Error(`expected verified outcome: ${JSON.stringify(draft)}`);
  return definition.outputCodec.decodeExact(draft.output) as unknown as Record<string, unknown>;
}

test("public runtime composition exports the exact five definitions", () => {
  assert.deepEqual(
    UNIV2_STANDARD_STAGE_DEFINITIONS.map(item => item.stage),
    ["nomination", "identity", "materialization", "projection", "rehydration"],
  );
  assert.deepEqual(
    UNIV2_STANDARD_STAGE_DEFINITIONS.map(item => item.capabilityId),
    Object.values(UNIV2_STANDARD_STAGE_IDS),
  );
  for (const definition of UNIV2_STANDARD_STAGE_DEFINITIONS) {
    assert.equal("executor" in definition, false);
    assert.equal("issuer" in definition, false);
    assert.equal("authority" in definition, false);
  }
  const expected = {
    nomination: "UNIV2_STANDARD_NOMINATION_DEFINITION",
    identity: "UNIV2_STANDARD_IDENTITY_DEFINITION",
    materialization: "UNIV2_STANDARD_MATERIALIZATION_DEFINITION",
    projection: "UNIV2_STANDARD_PROJECTION_DEFINITION",
    rehydration: "UNIV2_STANDARD_REHYDRATION_DEFINITION",
  } as const;
  for (const [stage, exportName] of Object.entries(expected)) {
    const declaration = UNIV2_STANDARD_DEFINITION.core[stage as keyof typeof expected];
    assert.equal(declaration.modulePath, "families/univ2-standard/src/runtime/definitions.ts");
    assert.equal(declaration.exportName, exportName);
  }
  assert.equal(PUBLIC_ENTRY.familyDefinition, UNIV2_STANDARD_DEFINITION);
  assert.equal(PUBLIC_ENTRY.runtimeDefinitions, UNIV2_STANDARD_RUNTIME_DEFINITIONS);
  assert.equal(PUBLIC_ENTRY.stageExportNames, UNIV2_STANDARD_STAGE_EXPORT_NAMES);
  assert.deepEqual(Object.keys(PUBLIC_ENTRY).sort(), ["familyDefinition", "runtimeDefinitions", "stageExportNames"]);
  assert.equal("runtimeDefinitionRoot" in PUBLIC_ENTRY, false);
  assert.equal("closureRoot" in PUBLIC_ENTRY, false);
  assert.equal("authority" in PUBLIC_ENTRY, false);
  assert.equal("executor" in PUBLIC_ENTRY, false);
});

test("generic lifecycle invocation is projected into the real UniV2 payloads", () => {
  const candidate = nomination();
  const generic = genericCandidate(candidate);
  const identityDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  const identityPrepared = identityDefinition.prepareIssueValue({
    stage: "identity",
    candidate: generic,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
  });
  const decodedIdentity = identityDefinition.payloadCodec.decodeExact(identityPrepared) as { readonly requestIds: readonly Hash[]; readonly nomination: { readonly pool: string } };
  assert.equal(decodedIdentity.nomination.pool, pool);
  assert.equal(decodedIdentity.requestIds.length, 5);
  assert.equal(new Set(decodedIdentity.requestIds).size, 5);

  const identityObservation = requireVerified(identityDefinition, identityPrepared, returnedFacts(
    hash("identity-program"),
    decodedIdentity.requestIds,
    [addressWord(token0), addressWord(token1), addressWord(factory), addressWord(pool), addressWord(pool)],
  ));
  const identityMemo = (identityObservation as { readonly identityMemo: CanonicalJson }).identityMemo;
  const materializationDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "materialization")!;
  const materializationPrepared = materializationDefinition.prepareIssueValue({
    stage: "materialization",
    candidate: generic,
    cutoff,
    identityMemo,
    materializationOutput: null,
  });
  const decodedMaterialization = materializationDefinition.payloadCodec.decodeExact(materializationPrepared) as { readonly requestId: Hash; readonly identity: { readonly identity: UniV2IdentityVerifiedV1 } };
  assert.equal(decodedMaterialization.identity.identity.instanceKey, pool);
  assert.equal(decodedMaterialization.requestId, reservesRequestId());

  const reserves = `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`;
  const materializationOutput = requireVerified(materializationDefinition, materializationPrepared, returnedFacts(
    hash("materialization-program"),
    [decodedMaterialization.requestId],
    [reserves],
  ));
  const projectionDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "projection")!;
  const projectionPrepared = projectionDefinition.prepareIssueValue({
    stage: "projection",
    candidate: generic,
    cutoff,
    identityMemo,
    materializationOutput: materializationOutput as unknown as CanonicalJson,
  });
  const decodedProjection = projectionDefinition.payloadCodec.decodeExact(projectionPrepared) as { readonly feeBps: string; readonly identity: { readonly identity: UniV2IdentityVerifiedV1 } };
  assert.equal(decodedProjection.identity.identity.instanceKey, pool);
  assert.equal(decodedProjection.feeBps, "30");
});

test("generic lifecycle preparation fails closed on lineage mutation and owner-only stages", () => {
  const candidate = nomination();
  const generic = genericCandidate(candidate);
  const identityDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  assert.throws(() => identityDefinition.prepareIssueValue({
    stage: "identity",
    candidate: { ...generic, candidateSubjectHash: hash("forged-subject") } as unknown as CanonicalJson,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
  }), /subject-mismatch/);
  assert.throws(() => identityDefinition.prepareIssueValue({
    stage: "identity",
    candidate: { ...generic, evidence: [{ ...generic.evidence[0]!, topic: hash("wrong-topic") }] },
    cutoff,
    identityMemo: null,
    materializationOutput: null,
  }), /candidate-evidence-root-mismatch/);
  for (const stage of ["nomination"] as const) {
    const definition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === stage)!;
    assert.throws(() => definition.prepareIssueValue({
      stage,
      candidate: generic,
      cutoff,
      identityMemo: null,
      materializationOutput: null,
    }), new RegExp(`univ2-${stage}-owner-only`));
  }
  const rehydration = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "rehydration")!;
  assert.throws(() => rehydration.prepareIssueValue({
    stage: "rehydration",
    candidate: generic,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
    reusePublication: null,
  }), /prior-publication-required/);
});

test("all recent and history aliases are traversed, canonicalized, and bound to one subject", () => {
  const base = genericCandidate();
  const recent = base.evidence[0]!;
  if (recent.kind !== "recent-log") throw new Error("expected recent alias");
  const nominationBase = {
    kind: "aloha.candidate-nomination" as const,
    version: "2" as const,
    familyId: base.familyId,
    familyDefinitionHash: base.familyDefinitionHash,
    instanceNominationKey: base.instanceNominationKey,
  };
  const secondRecent = { ...recent, txHash: hash("second-recent-alias"), logIndex: "1", rawLocatorHash: hash("second-recent-raw") };
  const history = {
    kind: "source-plan" as const,
    version: 1 as const,
    ownerRef: hash("history-owner"),
    sourcePlanRef: hash("history-plan"),
    evidenceRef: hash("history-evidence"),
    rawLocatorHash: hash("history-raw"),
  };
  const aliases = mergeAndDedupeNominations([
    { ...nominationBase, evidence: secondRecent },
    { ...nominationBase, evidence: recent },
    { ...nominationBase, evidence: history },
    { ...nominationBase, evidence: recent },
  ])[0]!;
  const reordered = mergeAndDedupeNominations([
    { ...nominationBase, evidence: history },
    { ...nominationBase, evidence: recent },
    { ...nominationBase, evidence: secondRecent },
  ])[0]!;
  assert.deepEqual(aliases, reordered);
  assert.equal(aliases.evidence.length, 3);
  const identityDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  const identityPrepared = identityDefinition.prepareIssueValue({
    stage: "identity",
    candidate: aliases as unknown as CanonicalJson,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
  });
  const decodedIdentity = identityDefinition.payloadCodec.decodeExact(identityPrepared) as { readonly requestIds: readonly Hash[] };
  const identityObservation = requireVerified(identityDefinition, identityPrepared, returnedFacts(
    hash("identity-program"),
    decodedIdentity.requestIds,
    [addressWord(token0), addressWord(token1), addressWord(factory), addressWord(pool), addressWord(pool)],
  ));
  const identityMemo = identityObservation.identityMemo as Record<string, unknown>;
  assert.equal(identityMemo.candidateSubjectHash, aliases.candidateSubjectHash);
  assert.equal(identityMemo.candidateEvidenceRoot, aliases.candidateEvidenceRoot);
  assert.equal(identityObservation.evidenceRoot, aliases.candidateEvidenceRoot);
  assert.throws(() => identityDefinition.outputCodec.decodeExact({ ...identityObservation, evidenceRoot: hash("forged-identity-observation-root") }), /evidenceRoot mismatch/);
  const forgedSubjectMemo = { ...identityMemo, candidateSubjectHash: hash("forged-identity-subject") };
  assert.throws(() => identityDefinition.outputCodec.decodeExact({ ...identityObservation, identityMemo: forgedSubjectMemo, identityMemoHash: hashDomain("aloha/identity-memo/v1", forgedSubjectMemo) }), /identity memo lineage mismatch/);
  const forgedEvidenceMemo = { ...identityMemo, candidateEvidenceRoot: hash("forged-identity-memo-root") };

  const materializationDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "materialization")!;
  assert.throws(() => materializationDefinition.prepareIssueValue({
    stage: "materialization",
    candidate: aliases as unknown as CanonicalJson,
    cutoff,
    identityMemo: forgedEvidenceMemo as CanonicalJson,
    materializationOutput: null,
  }), /candidate-identity-lineage-mismatch/);
  const materializationPrepared = materializationDefinition.prepareIssueValue({
    stage: "materialization",
    candidate: aliases as unknown as CanonicalJson,
    cutoff,
    identityMemo: identityMemo as CanonicalJson,
    materializationOutput: null,
  });
  const reserves = `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`;
  const materialization = requireVerified(materializationDefinition, materializationPrepared, returnedFacts(hash("materialization-program"), [reservesRequestId()], [reserves]));
  assert.equal(materialization.candidateSubjectHash, aliases.candidateSubjectHash);
  assert.equal(materialization.candidateEvidenceRoot, aliases.candidateEvidenceRoot);
  assert.throws(() => materializationDefinition.outputCodec.decodeExact({ ...materialization, candidateSubjectHash: hash("forged-materialization-subject") }), /candidate lineage mismatch/);

  const projectionDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "projection")!;
  assert.throws(() => projectionDefinition.prepareIssueValue({
    stage: "projection",
    candidate: aliases as unknown as CanonicalJson,
    cutoff,
    identityMemo: identityMemo as CanonicalJson,
    materializationOutput: { ...materialization, candidateEvidenceRoot: hash("forged-materialization-root") } as CanonicalJson,
  }), /projection-candidate-lineage-mismatch/);
  const projectionPrepared = projectionDefinition.prepareIssueValue({
    stage: "projection",
    candidate: aliases as unknown as CanonicalJson,
    cutoff,
    identityMemo: identityMemo as CanonicalJson,
    materializationOutput: materialization as CanonicalJson,
  });
  const publication = requireVerified(projectionDefinition, projectionPrepared, returnedFacts(hash("projection-program"), [reservesRequestId()], [reserves]));
  assert.equal(publication.evidenceRoot, aliases.candidateEvidenceRoot);
  assert.deepEqual(publication.identityMemo, identityMemo);
  assert.throws(() => projectionDefinition.outputCodec.decodeExact({ ...publication, evidenceRoot: hash("forged-publication-root") }));

  const conflictingAlias = mergeAndDedupeNominations([
    { ...nominationBase, evidence: recent },
    { ...nominationBase, evidence: { ...secondRecent, address: address("9") } },
  ])[0]!;
  assert.throws(() => identityDefinition.prepareIssueValue({
    stage: "identity",
    candidate: conflictingAlias as unknown as CanonicalJson,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
  }), /nomination-key-mismatch/);
});

test("runtime definitions decode returned facts through the real identity/materialization/projection slice", () => {
  const candidate = nomination();
  const generic = genericCandidate(candidate);
  const identityDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  const identityPayloadValue = identityPayload(candidate);
  const identity = requireVerified(identityDefinition, identityPayloadValue, returnedFacts(
    hash("identity-program"),
    identityPayloadValue.requestIds,
    [addressWord(token0), addressWord(token1), addressWord(factory), addressWord(pool), addressWord(pool)],
  ));
  assert.equal(identity.familyInstanceKey, pool);
  const identityMemo = identity.identityMemo as CanonicalJson;

  const reserves = `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`;
  const materializationDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "materialization")!;
  const materializationPayload = materializationDefinition.prepareIssueValue({
    stage: "materialization",
    candidate: generic,
    cutoff,
    identityMemo,
    materializationOutput: null,
  });
  const materialization = requireVerified(materializationDefinition, materializationPayload, returnedFacts(
    hash("materialization-program"),
    [reservesRequestId()],
    [reserves],
  )) as unknown as { readonly state: UniV2MaterializedStateV1 };
  assert.equal(materialization.state.pool, pool);

  const projectionDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "projection")!;
  const projectionPayload = projectionDefinition.prepareIssueValue({
    stage: "projection",
    candidate: generic,
    cutoff,
    identityMemo,
    materializationOutput: materialization as unknown as CanonicalJson,
  });
  const projection = requireVerified(projectionDefinition, projectionPayload, returnedFacts(hash("projection-program"), [reservesRequestId()], [reserves]));
  assert.equal(projection.instanceKey, pool);
  assert.equal(projection.evidenceRoot, generic.candidateEvidenceRoot);
  assert.deepEqual(projection.identityMemo, identityMemo);
});

test("rehydration issues a current proof and rejects a changed requested dependency root", () => {
  const candidate = nomination();
  const generic = genericCandidate(candidate);
  const identityDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  const identityPayloadValue = identityPayload(candidate);
  const identity = requireVerified(identityDefinition, identityPayloadValue, returnedFacts(
    hash("identity-program"),
    identityPayloadValue.requestIds,
    [addressWord(token0), addressWord(token1), addressWord(factory), addressWord(pool), addressWord(pool)],
  ));
  const identityMemo = identity.identityMemo as CanonicalJson;
  const reserves = `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`;
  const materializationDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "materialization")!;
  const materializationPayload = materializationDefinition.prepareIssueValue({
    stage: "materialization",
    candidate: generic,
    cutoff,
    identityMemo,
    materializationOutput: null,
  });
  const materialization = requireVerified(materializationDefinition, materializationPayload, returnedFacts(
    hash("materialization-program"),
    [reservesRequestId()],
    [reserves],
  ));
  const projectionDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "projection")!;
  const projectionPayload = projectionDefinition.prepareIssueValue({
    stage: "projection",
    candidate: generic,
    cutoff,
    identityMemo,
    materializationOutput: materialization as CanonicalJson,
  });
  const publication = requireVerified(
    projectionDefinition,
    projectionPayload,
    returnedFacts(hash("projection-program"), [reservesRequestId()], [reserves]),
  ) as unknown as InstancePublicationV1;
  const rehydrationDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "rehydration")!;
  const rehydrationPayload = rehydrationDefinition.prepareIssueValue({
    stage: "rehydration",
    candidate: generic,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
    reusePublication: publication as unknown as CanonicalJson,
  }) as { readonly requestId: Hash; readonly referenceHash: Hash };
  const proof = requireVerified(
    rehydrationDefinition,
    rehydrationPayload,
    returnedFacts(hash("rehydration-program"), [rehydrationPayload.requestId], [rehydrationPayload.referenceHash]),
  );
  assert.equal(proof.kind, "verifiedMemoReuseProof");
  assert.equal(proof.oldInstancePublicationHash, publication.instancePublicationHash);
  assert.equal(proof.familyCandidateKey, generic.familyCandidateKey);
  assert.equal(proof.candidateSubjectHash, generic.candidateSubjectHash);

  const { instancePublicationHash: _oldHash, ...publicationDraft } = publication;
  const changedPublication = sealInstancePublication({
    ...publicationDraft,
    transitions: publication.transitions.map(({ projectionHash: _projectionHash, ...transition }) => transition),
    requestedArtifactDependencyRoot: hash("changed-requested-dependencies"),
  });
  assert.throws(() => rehydrationDefinition.prepareIssueValue({
    stage: "rehydration",
    candidate: generic,
    cutoff,
    identityMemo: null,
    materializationOutput: null,
    reusePublication: changedPublication as unknown as CanonicalJson,
  }), /dependency-or-identity-mismatch/);
});

test("malformed or incomplete returned facts are invalid, not verified", () => {
  const candidate = nomination();
  const definition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  const payload = identityPayload(candidate);
  const malformed = interpret(definition, payload, returnedFacts(
    hash("identity-program"),
    payload.requestIds,
    [`0x01${"0".repeat(22)}${token0.slice(2)}`, addressWord(token1), addressWord(factory), addressWord(pool), addressWord(pool)],
  ));
  assert.equal(malformed.kind, "invalidProgram");
  const missing = interpret(definition, payload, returnedFacts(hash("identity-program"), payload.requestIds.slice(0, 4), [addressWord(token0), addressWord(token1), addressWord(factory), addressWord(pool)]));
  assert.equal(missing.kind, "invalidProgram");
});

test("chain rejection remains distinct from invalid program and owner-only stages never verify", () => {
  const candidate = nomination();
  const identityDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  const payload = identityPayload(candidate);
  const rejected = interpret(identityDefinition, payload, returnedFacts(
    hash("identity-program"),
    payload.requestIds,
    [addressWord(token0), addressWord(token1), addressWord(factory), addressWord(pool), addressWord(address("4"))],
  ));
  assert.deepEqual(rejected, { kind: "chainProvenRejected", factSet: factSet(), decisionCode: "factory-reverse-binding-failed" });

  for (const stage of ["nomination"] as const) {
    const definition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === stage)!;
    const outcome = interpret(definition, {}, [{
      kind: "returned",
      requestId: hash(`${stage}-request`),
      requestFingerprint: hash(`${stage}-program`),
      dataHex: "0x",
      source: factSource(),
    }]);
    assert.deepEqual(outcome, { kind: "invalidProgram", code: `univ2-${stage}-owner-only` });
  }
});

test("zero liquidity and projection lineage mutations cannot produce a publication", () => {
  const candidate = nomination();
  const identityDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "identity")!;
  const identityPayloadValue = identityPayload(candidate);
  const identity = requireVerified(identityDefinition, identityPayloadValue, returnedFacts(
    hash("identity-program"),
    identityPayloadValue.requestIds,
    [addressWord(token0), addressWord(token1), addressWord(factory), addressWord(pool), addressWord(pool)],
  ));
  const identityMemo = identity.identityMemo as unknown as UniV2IdentityVerifiedV1;
  const materializationDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "materialization")!;
  const materializationPayload = {
    kind: "family-materialization-input" as const,
    identity: identityMemo,
    cutoff,
    readPlan: ["getReserves"],
    requestId: reservesRequestId(),
  };
  const zero = interpret(materializationDefinition, materializationPayload, returnedFacts(hash("materialization-program"), [reservesRequestId()], [`0x${word(0n)}${word(2_000_000n)}${word(42n)}`]));
  assert.deepEqual(zero, { kind: "chainProvenRejected", factSet: factSet(), decisionCode: "zero-liquidity" });

  const validMaterialization = requireVerified(materializationDefinition, materializationPayload, returnedFacts(hash("materialization-program"), [reservesRequestId()], [`0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`]));
  const validMaterializationRecord = validMaterialization as unknown as { readonly state: UniV2MaterializedStateV1 };
  const projectionDefinition = UNIV2_STANDARD_STAGE_DEFINITIONS.find(item => item.stage === "projection")!;
  const invalidLineage = interpret(projectionDefinition, {
    kind: "family-projection-input" as const,
    nomination: candidate,
    identity: identityMemo,
    materialization: { ...validMaterializationRecord, state: { ...validMaterializationRecord.state, stateHash: hash("forged-state") } },
    cutoff,
    feeBps: "30",
    readPlan: ["getReserves"],
    requestId: reservesRequestId(),
    evidenceRoot: genericCandidate(candidate).candidateEvidenceRoot,
  }, returnedFacts(hash("projection-program"), [reservesRequestId()], [`0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`]));
  assert.equal(invalidLineage.kind, "invalidProgram");
});
