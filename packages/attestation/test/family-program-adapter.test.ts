import assert from "node:assert/strict";
import test from "node:test";
import {
  asCapabilityId,
  asCapabilityVersion,
  asOwnerRef,
  asSchemaRef,
} from "../../capability-contracts/src/index.ts";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import { erc20AssetPortBindingV1 } from "../../asset-ref/src/index.ts";
import {
  candidatePartitionRoot,
  mergeAndDedupeNominations,
  type CandidateRecordV1,
  type CanonicalCutoffV1,
} from "../../discovery/src/index.ts";
import type { ProgramInterpretationDraftV1 } from "../../capability-interpreters/src/index.ts";
import {
  sealInstancePublication,
  validateInstancePublication,
  type InstancePublicationV1,
} from "../../catalog/src/index.ts";
import {
  type FamilyStageDefinitionV1,
  type RuntimeStageExecutorV1,
} from "../../family-sdk/runtime/index.ts";
import {
  createFamilyRuntimeAuthority,
  issueRuntimeStageDefinitionBinding,
} from "../../family-sdk/runtime/internal/authority-owner.ts";
import {
  asFamilyId,
  type GeneratedFamilyEntryV1,
  type StageCapabilityRefV1,
} from "../../family-sdk/runtime-refs/index.ts";
import {
  createFamilyRuntimeComposition,
  type FamilyRuntimeCompositionV1,
} from "../../family-composition/src/index.ts";
import {
  createAttestationProgramPortFromFamilyComposition,
  type FamilyProgramAdapterInputV1,
} from "../src/internal/family-program-adapter.ts";
import {
  identityProofVerificationContext,
  identityMemoHash,
  type IdentityVerifiedV1,
  type IdentityVerifiedObservationV1,
} from "../src/index.ts";
import { runtimeReleaseBindingProvenanceHash } from "../../../specs/release-authority/src/index.ts";
import {
  attestationProofPortForReleaseApproval,
  releaseApproval,
} from "./authority-fixture.ts";

const h = (value: string): Hash => hashDomain("test/family-program-adapter", value);
const memo = (value: string) => ({ kind: "adapter-identity-memo", value } as const);
const familyId = asFamilyId("adapter-family");
const familyDefinitionHash = h("family-definition");
const cutoff: CanonicalCutoffV1 = {
  chainId: "1",
  number: "10",
  hash: h("cutoff-block"),
  stateRoot: h("cutoff-state"),
};
const inputAsset = erc20AssetPortBindingV1("1", `0x${h("input-asset").slice(-40)}`);
const outputAsset = erc20AssetPortBindingV1("1", `0x${h("output-asset").slice(-40)}`);

const candidate: CandidateRecordV1 = mergeAndDedupeNominations([{
  kind: "aloha.candidate-nomination",
  version: "2",
  familyId,
  familyDefinitionHash,
  instanceNominationKey: "instance-nomination",
  evidence: {
    kind: "recent-log",
    version: 1,
    sourcePlanRef: null,
    ownerRef: null,
    blockNumber: cutoff.number,
    blockHash: cutoff.hash,
    txHash: h("candidate-tx"),
    logIndex: "0",
    address: "0xabc",
    topic: h("candidate-topic"),
    rawLocatorHash: h("candidate-raw"),
  },
}])[0]!;

function stageRef(stage: Exclude<StageCapabilityRefV1["stage"], "capability">, index: number): StageCapabilityRefV1 {
  return Object.freeze({
    familyId,
    familyDefinitionHash,
    stage,
    capabilityId: asCapabilityId("adapter." + stage),
    version: asCapabilityVersion("1.0.0"),
    schemaHash: asSchemaRef(h("schema:" + index)),
    interpreterHash: h("interpreter:" + index),
    ownerRef: asOwnerRef(h("owner:" + index)),
  });
}

function canonicalObject(value: unknown): CanonicalJson {
  const decoded = decodeCanonicalJson(encodeCanonicalJson(value));
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new TypeError("test stage value must be a canonical object");
  }
  return decoded;
}

function publicationDraft(): CanonicalJson {
  return canonicalObject(sealInstancePublication({
    familyId,
    familyDefinitionHash,
    familyCandidateKey: candidate.familyCandidateKey,
    instanceKey: "instance-a",
    cutoff,
    identityMemo: memo("identity-memo"),
    identityMemoHash: identityMemoHash(memo("identity-memo")),
    descriptorHash: h("identity-descriptor"),
    staticProjectionMemoHash: h("projection-memo"),
    requestedArtifactDependencyRoot: h("requested-dependencies"),
    validityDependencyRoot: h("validity-dependencies"),
    transitions: [{
      inputAssetPorts: [{ ...inputAsset, portRef: h("input-port"), ordinal: "0" }],
      outputAssetPorts: [{ ...outputAsset, portRef: h("output-port"), ordinal: "0" }],
      opaqueTransitionRef: h("transition"),
      constraintRefs: [],
      staticProjectionHash: h("static-projection"),
    }],
    evidenceRoot: candidate.candidateEvidenceRoot,
  }));
}

function reusePublicationDraft(): InstancePublicationV1 {
  return sealInstancePublication({
    familyId,
    familyDefinitionHash,
    familyCandidateKey: candidate.familyCandidateKey,
    instanceKey: candidate.instanceNominationKey,
    cutoff: { ...cutoff, number: "9", hash: h("prior-cutoff-block"), stateRoot: h("prior-cutoff-state") },
    identityMemo: memo("prior-identity-memo"),
    identityMemoHash: identityMemoHash(memo("prior-identity-memo")),
    descriptorHash: h("identity-descriptor"),
    staticProjectionMemoHash: h("prior-projection-memo"),
    requestedArtifactDependencyRoot: h("requested-dependencies"),
    validityDependencyRoot: h("validity-dependencies"),
    transitions: [],
    evidenceRoot: h("prior-evidence-root"),
  });
}

type ReuseProofMutation = "old-publication" | "cross-candidate" | "cross-cutoff" | "requested-dependency";

function createComposition(
  mode: "verified" | "retryable" | "forged-identity-evidence-root" = "verified",
  reuseProofMutation: ReuseProofMutation | null = null,
): {
  readonly composition: FamilyRuntimeCompositionV1;
  readonly calls: string[];
} {
  const refs = (["nomination", "identity", "materialization", "projection", "rehydration"] as const)
    .map((stage, index) => stageRef(stage, index));
  const calls: string[] = [];
  const definitions: FamilyStageDefinitionV1[] = refs.map(ref => Object.freeze({
    stage: ref.stage as Exclude<StageCapabilityRefV1["stage"], "capability">,
    capabilityId: ref.capabilityId,
    version: ref.version,
    schemaHash: ref.schemaHash,
    payloadCodec: Object.freeze({
      schemaRef: ref.schemaHash,
      decodeExact: canonicalObject,
    }),
    dependencyIds: Object.freeze([]),
    outputSchemaRef: h("output-schema:" + ref.stage),
    implementationClosureHash: h("implementation:" + ref.stage),
    outputCodecHash: h("output-codec:" + ref.stage),
    outputCodec: Object.freeze({ decodeExact: canonicalObject }),
    prepareIssueValue: ({ candidate, cutoff, identityMemo: priorIdentityMemo, materializationOutput, reusePublication }: Parameters<FamilyStageDefinitionV1["prepareIssueValue"]>[0]) => ({
      candidate,
      cutoff,
      identityMemo: priorIdentityMemo,
      materializationOutput,
      reusePublication: reusePublication ?? null,
    }),
    interpret: (input: Parameters<FamilyStageDefinitionV1["interpret"]>[0]): ProgramInterpretationDraftV1 => {
      if (ref.stage === "identity") {
        const identityMemoValue = memo("identity-memo");
        const identity: IdentityVerifiedObservationV1 = {
          kind: "identityVerified",
          familyInstanceKey: "instance-a",
          identityMemo: identityMemoValue,
          identityMemoHash: identityMemoHash(identityMemoValue),
          descriptorHash: h("identity-descriptor"),
          evidenceRoot: mode === "forged-identity-evidence-root"
            ? h("forged-identity-evidence-root")
            : candidate.candidateEvidenceRoot,
        };
        return { kind: "verified", output: identity };
      }
      if (ref.stage === "materialization") return { kind: "verified", output: { materialized: true } };
      if (ref.stage === "projection") return { kind: "verified", output: publicationDraft() };
      if (ref.stage === "rehydration") {
        const payload = canonicalObject(input.payload) as Record<string, unknown>;
        const priorPublication = payload.reusePublication as InstancePublicationV1;
        validateInstancePublication(priorPublication);
        const currentMemo = memo("identity-memo");
        const currentMemoHash = identityMemoHash(currentMemo);
        const proofFields = {
          familyId,
          familyDefinitionHash,
          familyCandidateKey: reuseProofMutation === "cross-candidate" ? h("foreign-candidate") : candidate.familyCandidateKey,
          candidateSubjectHash: candidate.candidateSubjectHash,
          instanceNominationKey: candidate.instanceNominationKey,
          cutoff: reuseProofMutation === "cross-cutoff" ? { ...cutoff, number: "9" } : cutoff,
          oldInstancePublicationHash: reuseProofMutation === "old-publication" ? h("foreign-publication") : priorPublication.instancePublicationHash,
          requestedArtifactDependencyRoot: reuseProofMutation === "requested-dependency" ? h("changed-requested-dependencies") : priorPublication.requestedArtifactDependencyRoot,
          descriptorHash: priorPublication.descriptorHash,
          validityDependencyRoot: priorPublication.validityDependencyRoot,
          identityMemo: currentMemo,
          identityMemoHash: currentMemoHash,
          evidenceRoot: candidate.candidateEvidenceRoot,
        } as const;
        const candidateToCanonicalIdentityBindingProof = hashDomain("aloha/candidate-to-canonical-identity-binding/v1", {
          familyId: proofFields.familyId,
          familyDefinitionHash: proofFields.familyDefinitionHash,
          familyCandidateKey: proofFields.familyCandidateKey,
          candidateSubjectHash: proofFields.candidateSubjectHash,
          instanceNominationKey: proofFields.instanceNominationKey,
          cutoff: proofFields.cutoff,
          oldInstancePublicationHash: proofFields.oldInstancePublicationHash,
          identityMemoHash: proofFields.identityMemoHash,
          descriptorHash: proofFields.descriptorHash,
        });
        const proofPayload = {
          kind: "verifiedMemoReuseProof" as const,
          ...proofFields,
          candidateToCanonicalIdentityBindingProof,
        };
        return {
          kind: "verified",
          output: {
            ...proofPayload,
            proofHash: hashDomain("aloha/verified-memo-reuse-proof/v1", proofPayload),
          },
        };
      }
      return { kind: "verified", output: { ready: true } };
    },
  }));
  const executors: RuntimeStageExecutorV1[] = refs.map(ref => ({
    async execute({ program }) {
      calls.push(ref.stage);
      const source = {
        chainId: cutoff.chainId,
        blockNumber: cutoff.number,
        blockHash: cutoff.hash,
        stateRoot: cutoff.stateRoot,
        executorAuthorityRoot: h("executor-authority"),
        workerEpoch: "epoch-1",
        executorSessionHash: h("executor-session"),
      };
      const fact = mode === "retryable" && ref.stage === "identity"
        ? {
          kind: "transportFailure" as const,
          requestId: h("request:" + program.requestFingerprint),
          requestFingerprint: program.frozenProgram.requestFingerprint,
          failureCode: "resource-limit" as const,
          source,
        }
        : {
          kind: "returned" as const,
          requestId: h("request:" + program.requestFingerprint),
          requestFingerprint: program.frozenProgram.requestFingerprint,
          dataHex: "0x01",
          source,
        };
      return [fact];
    },
  }));
  const owner = createFamilyRuntimeAuthority({
    binding: {
      familyId,
      familyDefinitionHash,
      releaseAuthorityRoot: h("release-authority"),
      programAuthorityHash: h("program-authority"),
      executorAuthorityRoot: h("executor-authority"),
      workerEpoch: "epoch-1",
      executorSessionHash: h("executor-session"),
    },
    stages: definitions.map((definition, index) => ({
      stageRef: refs[index]!,
      definition,
      definitionBinding: issueRuntimeStageDefinitionBinding({
        stageRef: refs[index]!,
        definition,
        descriptorClosureHash: refs[index]!.interpreterHash,
      }),
      executor: executors[index]!,
    })),
  });
  const entry: GeneratedFamilyEntryV1 = {
    familyId,
    familyDefinitionHash,
    issuerRef: asOwnerRef(h("family-issuer")),
    authorityRef: h("family-authority") as GeneratedFamilyEntryV1["authorityRef"],
    lifecycleRefs: {
      nomination: refs[0]!,
      identity: refs[1]!,
      materialization: refs[2]!,
      projection: refs[3]!,
      rehydration: refs[4]!,
    },
    extensionRefs: [],
    actionOwnerRefs: [],
    factContractRefs: [],
    sourcePlanRefs: [],
    definitionCatalogLeafDigest: h("family-leaf"),
    capabilityCatalogRoot: h("capability-root"),
  };
  return {
    composition: createFamilyRuntimeComposition({
      definitionCatalogRoot: h("definition-catalog"),
      bindings: [{ entry, owner }],
    }),
    calls,
  };
}

function adapter(composition: FamilyRuntimeCompositionV1): ReturnType<typeof createAttestationProgramPortFromFamilyComposition> {
  const input: FamilyProgramAdapterInputV1 = { composition };
  return createAttestationProgramPortFromFamilyComposition(input);
}

test("generated composition resolves the Family and drives identity through the AttestationProgramPort", async () => {
  const fixture = createComposition();
  const programs = adapter(fixture.composition);
  const identity = await programs.attestIdentity(candidate, cutoff, new AbortController().signal);
  assert.equal(identity.kind, "identityVerified");
  if (identity.kind !== "identityVerified") throw new Error("identity stage did not verify");
  assert.equal(identity.familyInstanceKey, "instance-a");
  assert.equal(identity.evidenceRoot, candidate.candidateEvidenceRoot);
  assert.deepEqual(fixture.calls, ["identity"]);

  // The central engine issues and checks this proof before the next stage.
  // The adapter treats it as opaque and must not mint or reinterpret it.
  const approval = releaseApproval(h("framework"), h("executor"), "epoch-1", h("executor-session"));
  const binding = approval.resolver.resolve(approval.capability).provenance.runtimeBinding;
  const releaseProvenanceHash = runtimeReleaseBindingProvenanceHash(binding);
  const authorityRoot = hashDomain("aloha/attestation-authority/v3", {
    releaseProvenanceHash,
    releaseAuthorityRoot: binding.releaseAuthorityRoot,
    frameworkAuthorityRoot: binding.frameworkAuthorityRoot,
    executorAuthorityRoot: binding.executorAuthorityRoot,
    workerEpoch: binding.workerEpoch,
    executorSessionHash: binding.executorSessionHash,
  });
  const proofContext = identityProofVerificationContext(
    "run-a",
    cutoff,
    candidatePartitionRoot([candidate]),
    candidate,
    identity,
    { kind: "fresh" },
    {
      releaseProvenanceHash,
      attestationAuthorityRoot: authorityRoot,
      releaseAuthorityRoot: binding.releaseAuthorityRoot,
      frameworkAuthorityRoot: binding.frameworkAuthorityRoot,
      executorAuthorityRoot: binding.executorAuthorityRoot,
      attestationProofIssuerKeyId: binding.attestationProofIssuerKeyId,
    },
  );
  const identityWithProof: IdentityVerifiedV1 = Object.freeze({
    ...identity,
    issuerProof: attestationProofPortForReleaseApproval(approval).issueIdentity(proofContext) as IdentityVerifiedV1["issuerProof"],
  });
  const final = await programs.materializeAndProject(candidate, identityWithProof, cutoff, new AbortController().signal);
  assert.equal(final.kind, "verified");
  assert.equal(final.kind === "verified" ? final.publication.instanceKey : null, "instance-a");
  assert.deepEqual(fixture.calls, ["identity", "materialization", "projection"]);
});

test("unknown Family is fail-closed before any concrete stage executes", async () => {
  const fixture = createComposition();
  const programs = adapter(fixture.composition);
  const unknown = { ...candidate, familyId: asFamilyId("unknown-family"), familyDefinitionHash: h("unknown-definition") };
  const decision = await programs.attestIdentity(unknown, cutoff, new AbortController().signal);
  assert.equal(decision.kind, "invalidProgram");
  assert.match(decision.kind === "invalidProgram" ? decision.failure.failureCode : "", /not-release-qualified|adapter-error|identity-adapter-error/);
  assert.deepEqual(fixture.calls, []);
});

test("rehydration accepts only the composition-issued opaque session", () => {
  const fixture = createComposition();
  const session = fixture.composition.openRehydrationSession(familyDefinitionHash);
  assert.throws(
    () => fixture.composition.openRehydrationSession(h("unknown-definition")),
    /not release-qualified/,
  );
  assert.throws(
    () => fixture.composition.rehydrateRouteHandle({ ...session }, {} as never, {} as never, {} as never),
    /not issued by this composition/,
  );
});

test("verified memo reuse accepts a current plugin proof and rejects replay or lineage substitutions", async () => {
  const priorPublication = reusePublicationDraft();
  const valid = createComposition();
  const reusable = await adapter(valid.composition).reuseVerifiedMemo!(candidate, priorPublication, cutoff, new AbortController().signal);
  assert.equal(reusable.kind, "reusable");
  if (reusable.kind !== "reusable") throw new Error("expected verified memo reuse");
  assert.equal(reusable.identity.familyInstanceKey, candidate.instanceNominationKey);
  assert.equal(reusable.identity.evidenceRoot, candidate.candidateEvidenceRoot);
  assert.deepEqual(valid.calls, ["rehydration"]);

  for (const mutation of ["old-publication", "cross-candidate", "cross-cutoff", "requested-dependency"] as const) {
    const fixture = createComposition("verified", mutation);
    const decision = await adapter(fixture.composition).reuseVerifiedMemo!(candidate, priorPublication, cutoff, new AbortController().signal);
    assert.deepEqual(decision, { kind: "requiresAttestation" }, mutation);
    assert.deepEqual(fixture.calls, ["rehydration"], mutation);
  }
});

test("Family retryable transport remains retryable and is not relabeled as invalid", async () => {
  const fixture = createComposition("retryable");
  const decision = await adapter(fixture.composition).attestIdentity(candidate, cutoff, new AbortController().signal);
  assert.equal(decision.kind, "retryable");
  if (decision.kind === "retryable") assert.equal(decision.failure.failureCode, "resource-limit");
});

test("verified Family identity output cannot substitute a different candidate evidence root", async () => {
  const fixture = createComposition("forged-identity-evidence-root");
  const decision = await adapter(fixture.composition).attestIdentity(candidate, cutoff, new AbortController().signal);
  assert.equal(decision.kind, "invalidProgram");
  if (decision.kind === "invalidProgram") {
    assert.equal(decision.failure.failureCode, "family-identity-evidence-root-mismatch");
    assert.equal(decision.failure.candidateSubjectHash, candidate.candidateSubjectHash);
    assert.equal(decision.failure.evidenceRoot, candidate.candidateEvidenceRoot);
  }
  assert.deepEqual(fixture.calls, ["identity"]);
});
