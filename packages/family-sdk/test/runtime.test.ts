import assert from "node:assert/strict";
import test from "node:test";
import { asCapabilityVersion, asOwnerRef, asSchemaRef } from "../../capability-contracts/src/index.ts";
import { decodeCanonicalJson, decodeExactObject, hashDomain, sha256Hex, type Hash } from "../../canonical-codec/src/index.ts";
import {
  createFamilyRuntimeAuthority,
  issueRuntimeStageDefinitionBinding,
} from "../runtime/internal/authority-owner.ts";
import {
  familyRawEvidenceHashSet,
  issueFamilyRawEvidenceReadPort,
} from "../runtime/index.ts";
import {
  asFamilyId,
  type StageCapabilityRefV1,
} from "../runtime-refs/index.ts";
import type {
  FamilyRuntimeStageV1,
  FamilyStageDefinitionV1,
  RuntimeStageBindingV1,
} from "../runtime/index.ts";
import type {
  ProgramInterpretationDraftV1,
  TransportFactV1,
} from "../../capability-interpreters/src/index.ts";
import {
  familySearchAmount,
  familySearchObjective,
} from "../search-runtime/index.ts";

const h = (value: string): Hash => hashDomain("test/family-runtime", value);
const familyId = asFamilyId("demo-family");
const familyDefinitionHash = h("definition");
const source = { chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") } as const;
const unusedRawEvidence = Object.freeze({
  read(): Uint8Array { throw new TypeError("unused raw evidence"); },
});

test("search objective and amount envelopes reject every undeclared caller field", () => {
  const objectivePayload = Object.freeze({ kind: "surplus" });
  const objective = {
    objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload),
    payload: objectivePayload,
  };
  const amount = {
    inputAssetRef: h("input-asset"),
    outputAssetRef: h("output-asset"),
    amountIn: "1",
    recipient: "0xrecipient",
  };
  assert.deepEqual(familySearchObjective(objective), objective);
  assert.deepEqual(familySearchAmount(amount), amount);
  assert.throws(() => familySearchObjective({ ...objective, callbackDataHex: "0x1234" } as never), /unknown field/);
  assert.throws(() => familySearchAmount({ ...amount, callbackDataHex: "0x1234" } as never), /unknown field/);
});

function stageRef(stage: StageCapabilityRefV1["stage"], index: number): StageCapabilityRefV1 {
  return Object.freeze({
    familyId,
    familyDefinitionHash,
    stage,
    capabilityId: `demo.${stage}` as StageCapabilityRefV1["capabilityId"],
    version: asCapabilityVersion("1.0.0"),
    schemaHash: asSchemaRef(h(`schema-${index}`)),
    interpreterHash: h(`interpreter-${index}`),
    ownerRef: asOwnerRef(h(`owner-${index}`)),
  });
}

function payloadCodec(schemaHash: Hash) {
  return Object.freeze({
    schemaRef: asSchemaRef(schemaHash),
    decodeExact(value: unknown) {
      return decodeExactObject(value, {
        amount: (item, path) => typeof item === "string" && item.length > 0 ? item : (() => { throw new TypeError(path); })(),
      }, "stagePayload");
    },
  });
}

function outputCodec(value: unknown) {
  return decodeExactObject(value, {
    accepted: (item, path) => typeof item === "boolean" ? item : (() => { throw new TypeError(path); })(),
  }, "stageOutput") as { readonly accepted: boolean };
}

function createSetup(mode: "verified" | "rejected" | "retryable") {
  const refs = (["nomination", "identity", "materialization", "projection", "rehydration"] as const).map((stage, index) => stageRef(stage, index));
  const definitions: FamilyStageDefinitionV1[] = refs.map((ref) => Object.freeze({
    stage: ref.stage as FamilyRuntimeStageV1,
    capabilityId: ref.capabilityId,
    version: ref.version,
    schemaHash: ref.schemaHash,
    payloadCodec: payloadCodec(ref.schemaHash),
    dependencyIds: Object.freeze([]),
    outputSchemaRef: h(`${ref.stage}-output`),
    implementationClosureHash: h(`${ref.stage}-implementation`),
    outputCodecHash: h(`${ref.stage}-codec`),
    outputCodec: Object.freeze({ decodeExact: outputCodec }),
    prepareIssueValue: ({ candidate }: Parameters<FamilyStageDefinitionV1["prepareIssueValue"]>[0]) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new TypeError("candidate object required");
      const amount = (candidate as { readonly amount?: unknown }).amount;
      if (typeof amount !== "string") throw new TypeError("candidate amount required");
      return { amount };
    },
    interpret: (
      input: Parameters<FamilyStageDefinitionV1["interpret"]>[0],
    ): ProgramInterpretationDraftV1 => mode === "rejected"
      ? {
        kind: "chainProvenRejected" as const,
        factSet: input.factSet,
        decisionCode: "not-eligible",
      }
      : {
        kind: "verified" as const,
        output: { accepted: true },
      },
  }));
  const stages: RuntimeStageBindingV1[] = definitions.map((definition, index) => ({
    stageRef: refs[index]!,
    definition,
    definitionBinding: issueRuntimeStageDefinitionBinding({
      stageRef: refs[index]!,
      definition,
      descriptorClosureHash: refs[index]!.interpreterHash,
    }),
    executor: {
      async execute({ program }) {
        const fact: TransportFactV1 = mode === "retryable"
          ? {
            kind: "transportFailure",
            requestId: h(`${definition.stage}-request`),
            requestFingerprint: program.frozenProgram.requestFingerprint,
            failureCode: "resource-limit",
            source: {
              chainId: source.chainId,
              blockNumber: source.number,
              blockHash: source.hash,
              stateRoot: source.stateRoot,
              executorAuthorityRoot: h("executor"),
              workerEpoch: "epoch-1",
              executorSessionHash: h("session"),
            },
          }
          : {
            kind: "returned",
            requestId: h(`${definition.stage}-request`),
            requestFingerprint: program.frozenProgram.requestFingerprint,
            dataHex: "0x01",
            source: {
              chainId: source.chainId,
              blockNumber: source.number,
              blockHash: source.hash,
              stateRoot: source.stateRoot,
              executorAuthorityRoot: h("executor"),
              workerEpoch: "epoch-1",
              executorSessionHash: h("session"),
            },
          };
        return [fact];
      },
    },
  }));
  const binding = {
      familyId,
      familyDefinitionHash,
      releaseAuthorityRoot: h("release"),
      programAuthorityHash: h("program-authority"),
      executorAuthorityRoot: h("executor"),
      workerEpoch: "epoch-1",
      executorSessionHash: h("session"),
    } as const;
  const owner = createFamilyRuntimeAuthority({
    binding,
    stages,
  });
  return { owner, refs, definitions, stages, binding };
}

test("five stage runtime issues one source/payload-bound program and interprets an opaque fact set", async () => {
  const { owner, refs } = createSetup("verified");
  const stage = owner.port.getStage(refs[1]!);
  assert.equal("executor" in stage, false);
  assert.equal("issuer" in stage, false);
  const program = stage.issue({
    candidateKey: h("candidate"),
    instanceKey: null,
    evidenceRoot: h("evidence"),
    invocation: {
      stage: "identity",
      candidate: { kind: "generic-candidate", amount: "7" },
      cutoff: source,
      identityMemo: null,
      materializationOutput: null,
      reusePublication: null,
    },
  });
  assert.equal(program.stage, "identity");
  assert.equal(program.frozenProgram.source.hash, source.hash);
  assert.deepEqual(decodeCanonicalJson(program.frozenProgram.canonicalPayloadBytes), { amount: "7" });
  assert.notEqual(program.requestFingerprint, program.frozenProgram.requestFingerprint);
  const factSet = await stage.execute({ program, rawEvidence: unusedRawEvidence, attemptId: "attempt-1" });
  assert.equal(typeof factSet.factSetHash, "string");
  assert.deepEqual(stage.interpret({ program, factSet }), {
    familyId,
    familyDefinitionHash,
    stage: "identity",
    stageRef: refs[1],
    candidateKey: h("candidate"),
    instanceKey: null,
    source,
    requestFingerprint: program.requestFingerprint,
    evidenceRoot: h("evidence"),
    kind: "verified",
    output: { accepted: true },
    outputSchemaRef: h("identity-output"),
  });
});

test("stage binding, source, and exact owner fact-set are fail-closed", async () => {
  const { owner, refs } = createSetup("verified");
  const identity = owner.port.getStage(refs[1]!);
  const projection = owner.port.getStage(refs[3]!);
  const program = identity.issue({
    candidateKey: h("candidate"),
    instanceKey: "instance-a" as never,
    evidenceRoot: h("evidence"),
    invocation: {
      stage: "identity",
      candidate: { kind: "generic-candidate", amount: "7" },
      cutoff: source,
      identityMemo: null,
      materializationOutput: null,
      reusePublication: null,
    },
  });
  await assert.rejects(() => projection.execute({ program, rawEvidence: unusedRawEvidence }), /wrong stage port/);
  assert.throws(() => identity.interpret({ program: { ...program, evidenceRoot: h("changed") }, factSet: {} as never }), /fingerprint mismatch|transport/);
  const fakeFactOutcome = identity.interpret({ program, factSet: {} as never });
  assert.deepEqual(fakeFactOutcome, {
    ...Object.fromEntries(Object.entries(fakeFactOutcome).filter(([key]) => key !== "kind" && key !== "code")),
    kind: "invalidProgram",
    code: "transport-facts-invalid",
  });
});

test("terminal rejection is plugin-owned and retains the same lifecycle binding", async () => {
  const { owner, refs } = createSetup("rejected");
  const stage = owner.port.getStage(refs[2]!);
  const program = stage.issue({
    candidateKey: h("candidate"),
    instanceKey: null,
    evidenceRoot: h("evidence"),
    invocation: {
      stage: "materialization",
      candidate: { kind: "generic-candidate", amount: "7" },
      cutoff: source,
      identityMemo: { kind: "identity-memo", value: "opaque" },
      materializationOutput: null,
      reusePublication: null,
    },
  });
  const factSet = await stage.execute({ program, rawEvidence: unusedRawEvidence });
  const outcome = stage.interpret({ program, factSet });
  assert.equal(outcome.kind, "chainProvenRejected");
  if (outcome.kind === "chainProvenRejected") {
    assert.equal(outcome.decisionCode, "not-eligible");
    assert.equal(outcome.candidateKey, h("candidate"));
    assert.equal(outcome.evidenceRoot, h("evidence"));
  }
});

test("transport failure maps to retryable without invoking Family interpretation", async () => {
  const { owner, refs } = createSetup("retryable");
  const stage = owner.port.getStage(refs[0]!);
  const program = stage.issue({
    candidateKey: h("candidate"),
    instanceKey: null,
    evidenceRoot: h("evidence"),
    invocation: {
      stage: "nomination",
      candidate: { kind: "generic-candidate", amount: "7" },
      cutoff: source,
      identityMemo: null,
      materializationOutput: null,
      reusePublication: null,
    },
  });
  const factSet = await stage.execute({ program, rawEvidence: unusedRawEvidence });
  const outcome = stage.interpret({ program, factSet });
  assert.equal(outcome.kind, "retryable");
  if (outcome.kind === "retryable") assert.equal(outcome.failureCode, "resource-limit");
});

test("Family raw-evidence port is an exact hash join and returns isolated bytes", () => {
  const bytes = new TextEncoder().encode("pool-manager-swap-raw");
  const rawLocatorHash = sha256Hex(bytes);
  const recent = { rawLocatorHashes: [rawLocatorHash] } as never;
  const port = issueFamilyRawEvidenceReadPort({
    values: [{ kind: "raw-evidence-locator", version: 1, rawLocatorHash, bytes }],
    recent,
    sourceEvidence: [],
  });
  const first = port.read(rawLocatorHash);
  assert.deepEqual(first, bytes);
  first[0] = first[0]! ^ 0xff;
  assert.deepEqual(port.read(rawLocatorHash), bytes);
  assert.throws(() => port.read(h("not-in-join")), /exact family join/);
  assert.throws(
    () => issueFamilyRawEvidenceReadPort({
      values: [{ kind: "raw-evidence-locator", version: 1, rawLocatorHash, bytes: new TextEncoder().encode("changed") }],
      recent,
      sourceEvidence: [],
    }),
    /hash mismatch/,
  );
  assert.throws(
    () => issueFamilyRawEvidenceReadPort({ values: [], recent, sourceEvidence: [] }),
    /does not exactly match/,
  );
});

test("Family raw-evidence hash set keeps one exact locator for shared recent/source refs", () => {
  const shared = h("shared-raw");
  const recent = { rawLocatorHashes: [shared, h("recent-only")] } as never;
  const sourceEvidence = [{ rawLocatorHashes: [shared, h("source-only")] }] as never;
  assert.deepEqual(familyRawEvidenceHashSet({ recent, sourceEvidence }), [h("recent-only"), h("shared-raw"), h("source-only")].sort());
});

test("generic lifecycle invocation is exact and stage-scoped", () => {
  const { owner, refs } = createSetup("verified");
  const identity = owner.port.getStage(refs[1]!);
  const base = {
    candidateKey: h("candidate"),
    instanceKey: null,
    evidenceRoot: h("evidence"),
  } as const;
  assert.throws(
    () => identity.issue({
      ...base,
      invocation: {
        stage: "identity",
        candidate: { amount: "7" },
        cutoff: source,
        identityMemo: null,
        materializationOutput: null,
        reusePublication: null,
        extra: true,
      } as never,
    }),
    /unknown field/,
  );
  assert.throws(
    () => identity.issue({
      ...base,
      invocation: {
        stage: "identity",
        candidate: { amount: "7" },
        cutoff: source,
        identityMemo: { opaque: true },
        materializationOutput: null,
        reusePublication: null,
      },
    }),
    /identity memo/,
  );
});

test("definition binding rejects a replacement prepare implementation", () => {
  const { refs, stages, binding } = createSetup("verified");
  const tamperedStages = stages.map((stageBinding, index) => index === 1
    ? {
      ...stageBinding,
      definition: Object.freeze({
        ...stageBinding.definition,
        prepareIssueValue: (_input: Parameters<FamilyStageDefinitionV1["prepareIssueValue"]>[0]) => ({ amount: "tampered" }),
      }),
    }
    : stageBinding);
  assert.equal(tamperedStages[1]!.stageRef, refs[1]);
  assert.throws(
    () => createFamilyRuntimeAuthority({ binding, stages: tamperedStages }),
    /exact stage definition\/ref\/prepare/,
  );
});

test("route handles are process-local, binding-checked, and invalidated by session/revoke", () => {
  const { owner } = createSetup("verified");
  const publication = {
    familyId,
    familyDefinitionHash,
    instanceKey: "instance-a",
    identityMemo: { kind: "family-sdk-test-identity" },
    identityMemoHash: hashDomain("aloha/identity-memo/v1", { kind: "family-sdk-test-identity" }),
    instancePublicationHash: h("publication"),
    staticProjectionMemoHash: h("memo"),
    requestedArtifactDependencyRoot: h("dependencies"),
  };
  const projection = { staticProjectionHash: h("static-projection"), projectionHash: h("projection") };
  const ref = {
    familyDefinitionHash,
    instanceKey: "instance-a",
    instancePublicationHash: h("publication"),
    staticProjectionMemoHash: h("memo"),
    requestedArtifactDependencyRoot: h("dependencies"),
  };
  const handle = owner.routeHandles.issueRouteHandle(publication, projection, ref);
  assert.equal(JSON.stringify(handle), "{}");
  assert.equal(owner.routeHandles.resolveRouteHandle(handle).projectionHash, h("projection"));
  assert.throws(() => owner.routeHandles.resolveRouteHandle(JSON.parse(JSON.stringify(handle))), /not issued/);
  const other = createSetup("verified").owner.routeHandles;
  assert.throws(() => other.resolveRouteHandle(handle), /not issued/);
  owner.rotate({ executorSessionHash: h("next-session") });
  assert.throws(() => owner.routeHandles.resolveRouteHandle(handle), /stale/);
  owner.revoke();
  assert.throws(() => owner.routeHandles.resolveRouteHandle(handle), /revoked/);
});
