/**
 * Qualification corpus only. It exercises the acceptance contract with
 * deterministic, structurally complete artifacts. It is not a production
 * observer, Checkpoint read, release authority, deployment fact, or live pass.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashCanonicalPartition,
  hashDomain,
  sha256Hex,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  createReadOnlyArtifactRef,
  type ReadOnlyArtifactRefV1,
} from "../../../specs/core-envelope/src/index.ts";
import {
  createArtifactResolutionClaim,
  createObservedImmutableMirror,
  createResolverPolicy,
  createRetentionLeaseReceipt,
  encodeArtifactBytes,
  type ArtifactResolutionClaimV1,
  type RetentionLeaseReceiptV1,
} from "../../../specs/artifact-resolution/src/index.ts";
import {
  candidateEvidenceRoot,
  candidateSubjectHash,
  familyCandidateKey,
  sealSourceCoverage,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  sourcePlanIdentity,
  type CandidateRecordV1,
  type SourcePlanEvidenceReceiptV1,
  type SourcePlanExecutionV1,
  type SourcePlanRefV1,
} from "../../../packages/discovery/src/index.ts";
import { DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN } from "../../../packages/durable-store/src/index.ts";
import { sealInstanceCatalog, type AssetPortV1, type InstancePublicationV1 } from "../../../packages/catalog/src/index.ts";
import { buildPersistedGraph, type PersistedGraphEdgeV1 } from "../../../packages/graph/src/index.ts";
import {
  readGeneratedFamilyRuntimeFactoryMetadata,
} from "../../../packages/family-composition/src/internal/generated-runtime-composition.ts";
import { createReleaseFamilyRuntimeComposition } from "../../../generated/runtime-composition/index.ts";
import { FAMILY_CATALOG } from "../../../generated/family-catalog/index.ts";
import { sealReleaseIntent } from "../../../specs/release-intent/src/index.ts";
import { CURVE_UNDERLYING_DEFINITION } from "../../../families/curve-underlying/src/family-definition.ts";
import { DODO_V2_DEFINITION } from "../../../families/dodo-v2/src/family-definition.ts";
import { FLUID_DEX_DEFINITION } from "../../../families/fluid-dex/src/family-definition.ts";
import { UNIV2_STANDARD_DEFINITION } from "../../../families/univ2-standard/src/family-definition.ts";
import { ROUTE_CYCLE_STRATEGY } from "../../../strategies/route-cycle/src/index.ts";
import {
  familySearchRouteBindingHash,
  type FamilySearchActionArtifactV1,
  type FamilySearchCoarseArtifactV1,
  type FamilySearchSourceReadPortV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import {
  nominateUniV2,
} from "../../../families/univ2-standard/src/stages/nomination.ts";
import { verifyUniV2IdentityStage } from "../../../families/univ2-standard/src/stages/identity.ts";
import { materializeUniV2 } from "../../../families/univ2-standard/src/stages/materialization.ts";
import { projectUniV2 } from "../../../families/univ2-standard/src/stages/projection.ts";
import { createUniV2SearchAdapter } from "../../../families/univ2-standard/src/search/adapter.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
} from "../../../families/univ2-standard/src/family-definition.ts";
import { UNIV2_SYNC_EVENT_TOPIC0 } from "../../../families/univ2-standard/src/schema/index.ts";
import {
  candidatePartitionProofId,
  candidatePartitionProofPayloadHash,
  candidatePartitionProofSigningBytes,
  encodeCandidatePartitionProofV1,
  makeCandidatePartitionProofPayload,
  type CandidatePartitionProofPayloadV1,
  type CandidatePartitionProofV1,
} from "../../../specs/candidate-partition-authority/src/index.ts";
import {
  encodeNominationClosureV1,
  nominationEvidenceRefHash,
  sealNominationClosureV1,
  sealQualifiedSourcePlanNominationReceiptV1,
} from "../../../specs/nomination-authority/src/index.ts";
import {
  deriveFullFamilyOutcomeSummary,
  encodeFullFamilyCandidateProofVerifierBinding,
  encodeFullFamilyEvidenceArtifact,
  encodeFullFamilyOutcomeArtifact,
  encodeFullFamilyReadyRecord,
  encodeFullFamilySourceCoverageArtifact,
  FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS,
  sealFamilyEvidencePartition,
  sealFamilyOutcomePartition,
  sealFullFamilyFacts,
  sealFullFamilyMatrixEntry,
  type FamilyEvidenceItemV1,
  type FamilyOutcomeItemV1,
  type FamilyReleaseSetDraftV1,
  type FullFamilyCandidateProofVerifierBindingV1,
  type FullFamilyActionOwnerArtifactV1,
  type FullFamilyEvidenceArtifactV1,
  type FullFamilyFactBundleV1,
  type FullFamilyGeneratedRuntimeMetadataV1,
  type FullFamilyMatrixEntryV1,
  type FullFamilyOutcomeArtifactV1,
  type FullFamilySourceCoverageArtifactV1,
} from "../src/runtime.ts";
import {
  exactOutcomePartitionRootV1,
  type CandidateFinalOutcomeWireV1,
} from "../../../specs/candidate-final-outcome/src/index.ts";
import {
  issueQualificationChainRejectedOutcome,
  issueQualificationVerifiedOutcome,
  type QualificationOutcomeAuthorityV1,
} from "./qualification-outcome-fixture.ts";

const address = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const addressWord = (value: string): string => `0x${"0".repeat(24)}${value.slice(2)}`;
const h = (value: string): Hash => hashDomain("test/full-family/qualification-fixture/v1", value);
const catalogHash = (value: string, path: string): Hash => {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new TypeError(`expected catalog hash at ${path}`);
  return value as Hash;
};

function qualificationReleaseIntent() {
  const families = [
    Object.freeze({
      definition: CURVE_UNDERLYING_DEFINITION,
      modulePath: "families/curve-underlying/src/public.ts",
      exportName: "CURVE_UNDERLYING_DEFINITION",
    }),
    Object.freeze({
      definition: DODO_V2_DEFINITION,
      modulePath: "families/dodo-v2/src/public.ts",
      exportName: "DODO_V2_DEFINITION",
    }),
    Object.freeze({
      definition: FLUID_DEX_DEFINITION,
      modulePath: "families/fluid-dex/src/public.ts",
      exportName: "FLUID_DEX_DEFINITION",
    }),
    Object.freeze({
      definition: UNIV2_STANDARD_DEFINITION,
      modulePath: "families/univ2-standard/src/public.ts",
      exportName: "UNIV2_STANDARD_DEFINITION",
    }),
  ].map(({ definition, modulePath, exportName }) => Object.freeze({
    familyId: definition.manifest.familyId,
    manifestRoot: hashDomain("aloha/family-manifest/v1", definition.manifest),
    modulePath,
    exportName,
  }));
  const strategies = [Object.freeze({
    strategyId: ROUTE_CYCLE_STRATEGY.strategyId,
    manifestRoot: hashDomain("aloha/strategy-manifest/v1", {
      strategyId: ROUTE_CYCLE_STRATEGY.strategyId,
      version: ROUTE_CYCLE_STRATEGY.version,
      pluginCodeHash: ROUTE_CYCLE_STRATEGY.pluginCodeHash,
    }),
    modulePath: "strategies/route-cycle/src/index.ts",
    exportName: "ROUTE_CYCLE_STRATEGY",
  })];
  return sealReleaseIntent(families, strategies);
}

export const QUALIFICATION_CUTOFF = Object.freeze({
  chainId: "1",
  number: "100",
  hash: h("cutoff-hash"),
  stateRoot: h("cutoff-state-root"),
});

export const QUALIFICATION_ACTUAL_CURRENT_SOURCE = Object.freeze({
  chainId: QUALIFICATION_CUTOFF.chainId,
  number: "101",
  hash: h("actual-current-source-hash"),
  stateRoot: h("actual-current-source-state-root"),
});

export const QUALIFICATION_OBSERVED_HEAD = Object.freeze({
  ...QUALIFICATION_CUTOFF,
  parentHash: h("cutoff-parent-hash"),
});

export type QualificationArtifactSchemaKey = keyof typeof FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS;

export interface QualificationArtifactV1 {
  readonly bytes: Uint8Array;
  readonly schemaKey: QualificationArtifactSchemaKey;
  readonly contentSha256: Hash;
  readonly artifactRefId: Hash;
  readonly ref: ReadOnlyArtifactRefV1;
  readonly claim: ArtifactResolutionClaimV1;
  readonly lease: RetentionLeaseReceiptV1;
}

const qualificationResolverPolicy = createResolverPolicy({
  schemaVersion: 1,
  kind: "aloha.artifact-resolver-policy",
  allowedLocatorKind: "content-object",
  digestAlgorithm: "sha256",
  maxByteLength: "10000000",
  requireExactLengthMediaAndSchema: true,
  minimumRemainingStoreEpochs: "0",
  failureOutcome: "invalid",
});

export const QUALIFICATION_FULL_FAMILY_RESOLVER_POLICY = qualificationResolverPolicy;

export interface FullFamilyQualificationCorpusV1 {
  readonly bundle: FullFamilyFactBundleV1;
  readonly generatedRuntime: FullFamilyGeneratedRuntimeMetadataV1;
  readonly artifacts: readonly QualificationArtifactV1[];
  readonly catalogOutputRoot: Hash;
  readonly instanceCatalogRoot: Hash;
  readonly graphRoot: Hash;
  readonly assetPorts: readonly AssetPortV1[];
  readonly coarseArtifactHashes: readonly Hash[];
  readonly actionOwnerRef: Hash;
  readonly existingQualificationLeaves: ReadonlyMap<string, Hash>;
}

class ArtifactLedger {
  readonly #items: QualificationArtifactV1[] = [];

  add(value: unknown, schemaKey: QualificationArtifactSchemaKey): QualificationArtifactV1 {
    const bytes = value instanceof Uint8Array ? value : encodeCanonicalBytes(value);
    const contentSha256 = sha256Hex(bytes);
    const schema = FULL_FAMILY_ARTIFACT_SCHEMA_MANIFESTS[schemaKey];
    const storeIdentityHash = h("artifact-store");
    const lease = createRetentionLeaseReceipt({
      storeIdentityHash,
      objectKey: contentSha256,
      contentSha256,
      validFromStoreEpoch: "1",
      validThroughStoreEpoch: "100",
      issuerId: "full-family-qualification-fixture-issuer",
      issuerQualificationId: h("artifact-store-issuer-qualification"),
      qualificationRegistryRoot: h("artifact-store-qualification-registry"),
    });
    const ref = createReadOnlyArtifactRef({
      locator: { kind: "content-object", storeIdentityHash, objectKey: contentSha256 },
      immutableMirrorLocator: { kind: "content-object", storeIdentityHash, objectKey: contentSha256 },
      contentSha256,
      byteLength: String(bytes.byteLength),
      mediaType: "application/json",
      schema,
      resolverPolicyHash: qualificationResolverPolicy.policyHash,
      retentionLeaseReceiptId: lease.receiptId,
    });
    const mirror = createObservedImmutableMirror({
      storeIdentityHash,
      objectKey: contentSha256,
      bytes: encodeArtifactBytes(bytes),
      mediaType: ref.mediaType,
      schema: ref.schema,
    });
    const claim = createArtifactResolutionClaim({
      artifactRefId: ref.artifactRefId,
      resolverPolicyHash: qualificationResolverPolicy.policyHash,
      observedMirror: mirror,
      outcome: "content-observed",
    });
    const item = Object.freeze({ bytes, schemaKey, contentSha256, artifactRefId: ref.artifactRefId, ref, claim, lease });
    this.#items.push(item);
    return item;
  }

  items(): readonly QualificationArtifactV1[] {
    return Object.freeze([...this.#items]);
  }
}

function durableContentHash(kind: string, bytes: Uint8Array, references: readonly Hash[] = []): Hash {
  return hashDomain(DURABLE_CONTENT_ENVELOPE_HASH_DOMAIN, {
    kind,
    payloadHash: sha256Hex(bytes),
    references: [...new Set(references)].sort(),
  });
}

function exactReleaseSet(
  artifact: QualificationArtifactV1,
  contractRoot: Hash,
  entries: readonly Readonly<{ readonly familyId: string; readonly familyDefinitionHash: Hash }>[],
): FamilyReleaseSetDraftV1 {
  return Object.freeze({
    sourceArtifactRefId: artifact.artifactRefId,
    sourceArtifactContentSha256: artifact.contentSha256,
    contractRoot,
    entries: entries.map(entry => Object.freeze({ ...entry })),
  });
}

function instanceIdentityRef(publication: InstancePublicationV1): Hash {
  return hashDomain("aloha/full-family/instance-identity-ref/v1", {
    familyDefinitionHash: publication.familyDefinitionHash,
    instanceKey: publication.instanceKey,
  });
}

function rawEvidenceItem(
  ledger: ArtifactLedger,
  familyId: string,
  role: FullFamilyEvidenceArtifactV1["role"],
  itemId: Hash,
  subjectKey: Hash,
  readyRecordHash: Hash,
): FamilyEvidenceItemV1 {
  const artifact = ledger.add({
    schemaVersion: 1,
    kind: "aloha.full-family-evidence-artifact",
    readyRecordHash,
    role,
    familyId,
    itemId,
    subjectKey,
  } satisfies FullFamilyEvidenceArtifactV1, "evidence");
  return Object.freeze({
    familyId,
    itemId,
    subjectKey,
    evidenceArtifactRefId: artifact.artifactRefId,
    evidenceContentSha256: artifact.contentSha256,
  });
}

function qualificationEvidenceItem(
  ledger: ArtifactLedger,
  familyId: string,
  itemId: Hash,
  subjectKey: Hash,
  artifactValue: unknown,
  schemaKey: QualificationArtifactSchemaKey,
): FamilyEvidenceItemV1 {
  const artifact = ledger.add(artifactValue, schemaKey);
  return Object.freeze({
    familyId,
    itemId,
    subjectKey,
    evidenceArtifactRefId: artifact.artifactRefId,
    evidenceContentSha256: artifact.contentSha256,
  });
}

function outcomeItem(
  ledger: ArtifactLedger,
  familyId: string,
  candidate: CandidateRecordV1,
  rawOutcome: CandidateFinalOutcomeWireV1,
  runId: string,
  exactOutcomePartitionRoot: Hash,
  candidatePartitionRoot: Hash,
  readyRecordHash: Hash,
): FamilyOutcomeItemV1 {
  const { candidateKey, instanceKey, outcome } = deriveFullFamilyOutcomeSummary(candidate, rawOutcome);
  const itemId = hashDomain("aloha/full-family/qualification-outcome-item/v1", { familyId, candidateKey, outcome });
  const artifact = ledger.add({
    schemaVersion: 2,
    kind: "aloha.full-family-outcome-artifact",
    readyRecordHash,
    familyId,
    itemId,
    runId,
    cutoff: QUALIFICATION_CUTOFF,
    candidatePartitionRoot,
    exactOutcomePartitionRoot,
    candidate,
    rawOutcome,
    candidateKey,
    instanceKey,
    outcome,
  } satisfies FullFamilyOutcomeArtifactV1, "outcome");
  return Object.freeze({
    familyId,
    itemId,
    candidateKey,
    instanceKey,
    outcome,
    evidenceArtifactRefId: artifact.artifactRefId,
    evidenceContentSha256: artifact.contentSha256,
  });
}

function buildUniV2QualificationArtifacts() {
  const pool = address("1");
  const token0 = address("2");
  const token1 = address("3");
  const factory = address("f");
  const evidence = Object.freeze({
    cutoff: QUALIFICATION_CUTOFF,
    blockNumber: "99",
    blockHash: h("univ2-evidence-block"),
    txHash: h("univ2-evidence-tx"),
    logIndex: "0",
    emitter: pool,
    topic0: UNIV2_SYNC_EVENT_TOPIC0,
    rawLocatorHash: h("univ2-evidence-raw"),
  });
  const nominated = nominateUniV2({ pool, evidence });
  if (nominated.status !== "nominated") throw new Error("qualification UniV2 nomination failed");
  const nomination = Object.freeze({
    ...nominated.candidate,
    candidateSnapshotHash: candidateSubjectHash(
      UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
      nominated.candidate.instanceNominationKey,
    ),
  });
  const identity = verifyUniV2IdentityStage({
    nomination,
    reads: {
      cutoff: QUALIFICATION_CUTOFF,
      pool,
      token0ReturnHex: addressWord(token0),
      token1ReturnHex: addressWord(token1),
      factoryReturnHex: addressWord(factory),
      forwardPairReturnHex: addressWord(pool),
      reversePairReturnHex: addressWord(pool),
    },
  });
  if (identity.status !== "verified") throw new Error("qualification UniV2 identity failed");
  const reservesReturnHex = `0x${word(1_000_000n)}${word(2_000_000n)}${word(42n)}`;
  const materialized = materializeUniV2({
    identity: identity.identity,
    read: { cutoff: QUALIFICATION_CUTOFF, pool, reservesReturnHex },
  });
  if (materialized.status !== "verified") throw new Error("qualification UniV2 materialization failed");
  const familyCandidate = familyCandidateKey(UNIV2_STANDARD_FAMILY_DEFINITION_HASH, nomination.instanceNominationKey);
  const candidateEvidenceRoot = hashDomain("aloha/full-family/qualification-candidate-evidence/v1", {
    familyCandidate,
    evidence,
  });
  const runtimeIdentityMemo = Object.freeze({
    kind: "univ2-identity-memo" as const,
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    familyCandidateKey: familyCandidate,
    instanceNominationKey: nomination.instanceNominationKey,
    candidateSubjectHash: identity.identity.candidateSnapshotHash,
    candidateEvidenceRoot,
    identity: identity.identity,
  });
  const publicationIdentityMemo = decodeCanonicalJson(encodeCanonicalBytes(runtimeIdentityMemo));
  const projected = projectUniV2({
    nomination,
    identity: identity.identity,
    materialization: materialized.materialization,
    feeBps: 30n,
    evidenceRoot: candidateEvidenceRoot,
    publicationIdentityMemo,
  });
  if (projected.status !== "verified") throw new Error("qualification UniV2 projection failed");
  const publication = projected.projection.publication;
  const catalog = sealInstanceCatalog(QUALIFICATION_CUTOFF, [publication]);
  const graph = buildPersistedGraph(catalog);
  const adapter = createUniV2SearchAdapter({ actionOwnerRef: catalogHash(FAMILY_CATALOG.entries
    .find(entry => entry.familyId === UNIV2_STANDARD_FAMILY_ID)!.actionOwnerRefs[0]!, "univ2.actionOwnerRef") });
  const objectivePayload = Object.freeze({ kind: "full-family-qualification-objective", version: 1 });
  const objective = Object.freeze({
    objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload),
    payload: objectivePayload,
  });
  const currentSource = Object.freeze({
    source: QUALIFICATION_ACTUAL_CURRENT_SOURCE,
    async assertCurrent() {},
  });
  const reserveRead: FamilySearchSourceReadPortV1 = Object.freeze({
    async read(input: Parameters<FamilySearchSourceReadPortV1["read"]>[0]) {
      return Object.freeze({
        kind: "returned" as const,
        requestId: input.request.requestId,
        source: input.request.source,
        dataHex: reservesReturnHex,
      });
    },
  });
  const searches = graph.edges.map(async edge => {
    const route = Object.freeze({
      familyId: publication.familyId,
      familyDefinitionHash: publication.familyDefinitionHash,
      instanceKey: publication.instanceKey,
      identityMemo: publication.identityMemo,
      identityMemoHash: publication.identityMemoHash,
      instancePublicationHash: publication.instancePublicationHash,
      staticProjectionMemoHash: publication.staticProjectionMemoHash,
      requestedArtifactDependencyRoot: publication.requestedArtifactDependencyRoot,
      staticProjectionHash: edge.staticProjectionHash,
      projectionHash: edge.projectionHash,
      authoritySessionHash: h("route-authority-session"),
    });
    const inputPort = edge.inputAssetPorts[0]!;
    const outputPort = edge.outputAssetPorts[0]!;
    const recipient = address("9");
    const run = await adapter.run({
      route,
      currentSource,
      objective,
      amount: {
        inputAssetRef: inputPort.assetRef,
        outputAssetRef: outputPort.assetRef,
        amountIn: "1000",
        recipient,
      },
      execution: { transactionOrigin: address("8"), executorAddress: recipient },
      readPort: reserveRead,
    });
    if (run.kind !== "verified") throw new Error(`qualification UniV2 search failed: ${JSON.stringify(run)}`);
    if (run.artifact.coarse.status !== "rankable") throw new Error("qualification UniV2 coarse artifact is not rankable");
    if (run.artifact.coarse.routeBindingHash !== familySearchRouteBindingHash(route)) throw new Error("qualification UniV2 route binding mismatch");
    return Object.freeze({ edge, coarse: run.artifact.coarse, action: run.artifact.action });
  });
  return Promise.all(searches).then(results => Object.freeze({
    nomination,
    publication,
    catalog,
    graph,
    candidateEvidenceRoot,
    coarse: Object.freeze(results.map(result => result.coarse)),
    actions: Object.freeze(results.map(result => result.action)),
  }));
}

function proofIssuer() {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyHex = `0x${pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}` as `0x${string}`;
  const keyId = hashDomain("aloha/test-full-family-proof-key/v1", publicKeyHex);
  return Object.freeze({
    publicKeyHex,
    keyId,
    issue(payload: CandidatePartitionProofPayloadV1): CandidatePartitionProofV1 {
      const payloadHash = candidatePartitionProofPayloadHash(payload);
      return Object.freeze({
        ...payload,
        proofId: candidatePartitionProofId(payloadHash),
        payloadHash,
        signatureAlgorithm: "ed25519" as const,
        signerKeyId: keyId,
        signatureHex: `0x${sign(null, Buffer.from(candidatePartitionProofSigningBytes(payload, keyId)), pair.privateKey).toString("hex")}` as `0x${string}`,
      });
    },
  });
}

async function buildFullFamilyQualificationCorpusOnce(): Promise<FullFamilyQualificationCorpusV1> {
  const ledger = new ArtifactLedger();
  const releaseIntent = qualificationReleaseIntent();
  const factoryMetadata = readGeneratedFamilyRuntimeFactoryMetadata(createReleaseFamilyRuntimeComposition);
  if (factoryMetadata.releaseIntentRoot !== releaseIntent.releaseIntentRoot
    || factoryMetadata.releaseIntentRoot !== FAMILY_CATALOG.releaseIntentRoot
    || factoryMetadata.families.length !== FAMILY_CATALOG.entries.length
    || factoryMetadata.families.some(family => FAMILY_CATALOG.entries.find(entry =>
      entry.familyId === family.familyId && entry.familyDefinitionHash === family.familyDefinitionHash) === undefined)
    || !decodeCanonicalJson(encodeCanonicalBytes(FAMILY_CATALOG))) {
    throw new Error("checked-in generated runtime/catalog does not equal current qualification compiler output");
  }
  const generatedRuntime: FullFamilyGeneratedRuntimeMetadataV1 = Object.freeze({
    releaseIntentRoot: factoryMetadata.releaseIntentRoot,
    definitionCatalogRoot: factoryMetadata.definitionCatalogRoot,
    descriptorRoot: factoryMetadata.descriptorRoot,
    families: Object.freeze(factoryMetadata.families.map(family => Object.freeze({
      familyId: family.familyId,
      familyDefinitionHash: family.familyDefinitionHash,
      sourcePlanRoot: family.sourcePlanRoot,
      sourcePlanRefs: Object.freeze([...family.sourcePlanRefs]
        .sort((left, right) => sourcePlanIdentity(left).localeCompare(sourcePlanIdentity(right)))),
    })).sort((left, right) => left.familyId.localeCompare(right.familyId))),
  });
  const univ2 = await buildUniV2QualificationArtifacts();
  const sourcePlans = generatedRuntime.families.flatMap(family => family.sourcePlanRefs)
    .sort((left, right) => sourcePlanIdentity(left).localeCompare(sourcePlanIdentity(right)));
  const runId = "qualification-full-family-run";
  const releaseBindingId = h("release-binding");
  const releaseProvenanceHash = h("release-provenance");
  const outcomeAuthority: QualificationOutcomeAuthorityV1 = Object.freeze({
    attestationAuthorityRoot: h("attestation-authority-root"),
    releaseAuthorityRoot: h("release-authority-root"),
    releaseProvenanceHash,
    frameworkAuthorityRoot: h("framework-authority-root"),
    executorAuthorityRoot: h("executor-authority-root"),
    attestationProofIssuerKeyId: h("attestation-proof-issuer-key"),
    workerEpoch: "1",
    executorSessionHash: h("executor-session"),
  });
  const sourceAuthorityRoot = h("source-authority");
  const sourceAnchorRoot = h("source-anchor");
  const sourceResults = sourcePlans.map(plan => {
    const physical = Object.freeze({
      kind: "family-source-plan-physical-observation" as const,
      version: 1 as const,
      requestId: hashDomain("aloha/full-family/qualification-source-request/v1", plan),
      releaseBindingId,
      releaseProvenanceHash,
      sourceAuthorityRoot,
      sourceAnchorRoot,
      provider: "qualified-qualification-fixture-provider",
      backendEpoch: "1",
      familyDefinitionHash: plan.familyDefinitionHash,
      plan,
      cutoff: QUALIFICATION_CUTOFF,
      requestSchemaHash: hashDomain("aloha/full-family/qualification-request-schema/v1", plan),
      request: Object.freeze({
        kind: "family-source-plan-rpc" as const,
        version: 1 as const,
        method: "eth_call" as const,
        params: Object.freeze([]),
        target: null,
        manager: null,
        topic: null,
        lookback: null,
        chunk: null,
      }),
      response: Object.freeze({ result: Object.freeze([]) }),
    });
    const physicalArtifact = ledger.add(physical, "sourcePhysicalObservation");
    const rawLocatorHash = sha256Hex(physicalArtifact.bytes);
    const evidenceRef = Object.freeze({
      kind: "source-plan" as const,
      version: 1 as const,
      ownerRef: plan.ownerRef,
      sourcePlanRef: plan.sourcePlanRef,
      evidenceRef: hashDomain("aloha/full-family/qualification-source-evidence-ref/v1", { plan, rawLocatorHash }),
      rawLocatorHash,
    });
    const evidenceWithoutRoot = Object.freeze({
      kind: "source-plan-evidence" as const,
      version: 1 as const,
      plan,
      cutoff: QUALIFICATION_CUTOFF,
      refs: Object.freeze([evidenceRef]),
      rawLocatorHashes: Object.freeze([rawLocatorHash]),
    });
    const sourceEvidence: SourcePlanEvidenceReceiptV1 = Object.freeze({
      ...evidenceWithoutRoot,
      evidenceRoot: sourcePlanEvidenceRoot(evidenceWithoutRoot),
    });
    const resultPartitionRoot = hashDomain("aloha/full-family/qualification-source-result/v1", {
      plan,
      cutoff: QUALIFICATION_CUTOFF,
    });
    const executionWithoutRoot = Object.freeze({
      kind: "source-plan-execution" as const,
      version: 1 as const,
      plan,
      cutoff: QUALIFICATION_CUTOFF,
      outcome: "complete" as const,
      from: plan.completeness === "contiguous-history" ? plan.historyStartBlock! : QUALIFICATION_CUTOFF.number,
      through: QUALIFICATION_CUTOFF.number,
      previousAppliedThrough: null,
      resultPartitionRoot,
      opaqueResult: Object.freeze({ kind: "qualification-fixture-source-result", resultPartitionRoot }),
      sourceEvidenceRefs: Object.freeze([evidenceRef]),
      rawLocatorHashes: Object.freeze([rawLocatorHash]),
      sourceEvidenceRoot: sourceEvidence.evidenceRoot,
    });
    const execution: SourcePlanExecutionV1 = Object.freeze({
      ...executionWithoutRoot,
      executionRoot: sourcePlanExecutionRoot(executionWithoutRoot),
    });
    const executionArtifact = ledger.add(execution, "sourceExecution");
    const sourceEvidenceArtifact = ledger.add(sourceEvidence, "sourceEvidence");
    return Object.freeze({ plan, execution, sourceEvidence, physicalArtifact, rawLocatorHash, executionArtifact, sourceEvidenceArtifact });
  });
  const sourceCoverage = sealSourceCoverage(QUALIFICATION_CUTOFF, sourcePlans, sourceResults.map(result => result.execution));

  const candidatePlans = new Map<string, SourcePlanRefV1>();
  for (const familyId of ["dodo-v2", "univ2-standard"]) {
    const family = generatedRuntime.families.find(item => item.familyId === familyId)!;
    candidatePlans.set(familyId, family.sourcePlanRefs[0]!);
  }
  const makeCandidate = (familyId: string, instanceNominationKey: string): CandidateRecordV1 => {
    const family = generatedRuntime.families.find(item => item.familyId === familyId)!;
    const plan = candidatePlans.get(familyId)!;
    const source = sourceResults.find(result => sourcePlanIdentity(result.plan) === sourcePlanIdentity(plan))!;
    const evidence = Object.freeze([Object.freeze({
      kind: "source-plan" as const,
      version: 1 as const,
      ownerRef: plan.ownerRef,
      sourcePlanRef: plan.sourcePlanRef,
      evidenceRef: source.sourceEvidence.evidenceRoot,
      rawLocatorHash: source.rawLocatorHash,
    })]);
    const key = familyCandidateKey(family.familyDefinitionHash, instanceNominationKey);
    return Object.freeze({
      kind: "aloha.candidate-record" as const,
      version: "2" as const,
      familyId,
      familyDefinitionHash: family.familyDefinitionHash,
      instanceNominationKey,
      familyCandidateKey: key,
      candidateSubjectHash: candidateSubjectHash(family.familyDefinitionHash, instanceNominationKey),
      candidateEvidenceRoot: candidateEvidenceRoot(evidence),
      evidence,
    });
  };
  const candidates = Object.freeze([
    makeCandidate("univ2-standard", univ2.nomination.instanceNominationKey),
    makeCandidate("dodo-v2", "dodo-v2:chain-rejected-qualification-candidate"),
  ].sort((left, right) => left.familyCandidateKey.localeCompare(right.familyCandidateKey)));
  const receipts = sourceResults.map(result => {
    const family = generatedRuntime.families.find(value => value.familyDefinitionHash === result.plan.familyDefinitionHash)!;
    const sourcePlanLeafDigest = hashDomain("aloha/full-family/qualification-source-plan-leaf/v1", result.plan);
    const nominationProgramRoot = hashDomain("aloha/full-family/qualification-nomination-program/v1", result.plan);
    const nominationProgramProposalLeafDigest = hashDomain("aloha/full-family/qualification-nomination-proposal/v1", {
      sourcePlanLeafDigest,
      nominationProgramRoot,
    });
    const claims = candidates.filter(candidate => candidate.evidence.some(evidence =>
      evidence.kind === "source-plan"
      && evidence.ownerRef === result.plan.ownerRef
      && evidence.sourcePlanRef === result.plan.sourcePlanRef)).map(candidate => ({
        sourcePlanIdentity: sourcePlanIdentity(result.plan),
        familyCandidateKey: candidate.familyCandidateKey,
        instanceNominationKey: candidate.instanceNominationKey,
        evidenceRefHash: nominationEvidenceRefHash(candidate.evidence[0]!),
      }));
    return sealQualifiedSourcePlanNominationReceiptV1({
      cutoff: QUALIFICATION_CUTOFF,
      familyId: family.familyId,
      familyDefinitionHash: result.plan.familyDefinitionHash,
      sourcePlanIdentity: sourcePlanIdentity(result.plan),
      sourcePlanLeafDigest,
      nominationProgramRoot,
      nominationProgramProposalLeafDigest,
      qualificationRoot: hashDomain("aloha/test-qualified-nomination/v1", nominationProgramProposalLeafDigest),
      denominator: {
        kind: "complete-source-result",
        persistedExecutionRoot: result.execution.executionRoot,
        resultPartitionRoot: result.execution.resultPartitionRoot,
      },
      claims,
    });
  });
  const candidatePartitionRoot = hashCanonicalPartition("aloha/candidate-partition/v2", candidates);
  const rawOutcomes = candidates.map(candidate => candidate.familyId === "univ2-standard"
    ? issueQualificationVerifiedOutcome({
      runId,
      cutoff: QUALIFICATION_CUTOFF,
      candidatePartitionRoot,
      candidate,
      publication: univ2.publication,
      authority: outcomeAuthority,
    })
    : issueQualificationChainRejectedOutcome({
      runId,
      cutoff: QUALIFICATION_CUTOFF,
      candidatePartitionRoot,
      candidate,
      authority: outcomeAuthority,
    }));
  const rawOutcomeByCandidate = new Map(rawOutcomes.map(outcome => [outcome.familyCandidateKey, outcome]));
  const exactOutcomePartitionRoot = exactOutcomePartitionRootV1({
    runId,
    cutoff: QUALIFICATION_CUTOFF,
    candidatePartitionRoot,
    attestationAuthorityRoot: outcomeAuthority.attestationAuthorityRoot,
    releaseAuthorityRoot: outcomeAuthority.releaseAuthorityRoot,
    releaseProvenanceHash: outcomeAuthority.releaseProvenanceHash,
    executorAuthorityRoot: outcomeAuthority.executorAuthorityRoot,
    outcomes: rawOutcomes,
  });
  const recentObservationRoot = hashDomain("aloha/full-family/qualification-recent-observation/v1", {
    cutoff: QUALIFICATION_CUTOFF,
    from: "51",
    to: "100",
  });
  const nominationClosure = sealNominationClosureV1({
    cutoff: QUALIFICATION_CUTOFF,
    recentObservationRoot,
    sourceExecutionSetRoot: hashCanonicalPartition("aloha/source-execution-set/v1", sourceResults.map(result => result.execution.executionRoot).sort()),
    sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
    sourcePlanIdentities: sourcePlans.map(sourcePlanIdentity),
    receipts,
    candidates,
    candidatePartitionRoot,
  });
  const candidatePartitionStorageHash = durableContentHash("aloha/candidate-partition/v2", encodeCanonicalBytes(candidates));
  const nominationClosureArtifact = ledger.add(encodeNominationClosureV1(nominationClosure), "nominationClosure");
  const nominationClosureStorageHash = durableContentHash("aloha/nomination-closure/v1", nominationClosureArtifact.bytes, [candidatePartitionStorageHash]);
  const issuer = proofIssuer();
  const proofPayload = makeCandidatePartitionProofPayload({
    runId,
    cutoff: QUALIFICATION_CUTOFF,
    candidatePartitionRoot,
    candidatePartitionStorageHash,
    nominationClosureRoot: nominationClosure.root,
    nominationClosureStorageHash,
    candidates,
    recentObservationRoot,
    sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
    checkpointRevision: "1",
    releaseProvenanceHash,
    issuerKeyId: issuer.keyId,
  });
  const proof = issuer.issue(proofPayload);
  const proofArtifact = ledger.add(encodeCandidatePartitionProofV1(proof), "candidatePartitionProof");
  const candidatePartitionProofStorageHash = durableContentHash("aloha/candidate-partition-proof/v2", proofArtifact.bytes);
  const verifierBinding: FullFamilyCandidateProofVerifierBindingV1 = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.full-family-candidate-proof-verifier-binding",
    runtimeBindingId: releaseBindingId,
    releaseProvenanceHash,
    releaseAuthorityRoot: outcomeAuthority.releaseAuthorityRoot,
    candidateReleaseCommit: "a".repeat(40),
    proofKeyId: issuer.keyId,
    proofPublicKeyHex: issuer.publicKeyHex,
  });
  const verifierArtifact = ledger.add(encodeFullFamilyCandidateProofVerifierBinding(verifierBinding), "candidateProofVerifierBinding");

  const instanceCatalog = univ2.catalog;
  const graph = univ2.graph;
  const generationId = h("generation");
  const refreshPolicy = h("generation-refresh-policy");
  const freshnessPayload = Object.freeze({
    cutoff: QUALIFICATION_CUTOFF,
    observedHead: QUALIFICATION_OBSERVED_HEAD,
    observedAgeBlocks: "0",
    maxPromotionAgeBlocks: "1",
    generationRefreshPolicyHash: refreshPolicy,
    journalEpoch: "1",
    canonicalJournalRoot: h("canonical-journal-root"),
  });
  const promotionFreshness = Object.freeze({
    ...freshnessPayload,
    freshnessReceiptHash: hashDomain("aloha/promotion-freshness-receipt/v1", freshnessPayload),
  });
  const readyPayload = Object.freeze({
    generationId,
    parentGenerationId: null,
    generationRefreshPolicyHash: refreshPolicy,
    cutoff: QUALIFICATION_CUTOFF,
    recentObservationRange: Object.freeze({ from: "51", to: "100" }),
    definitionCatalogRoot: generatedRuntime.definitionCatalogRoot,
    sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
    candidatePartitionRoot,
    nominationClosureRoot: nominationClosure.root,
    nominationClosureStorageHash,
    candidatePartitionProofStorageHash,
    releaseProvenanceHash,
    exactOutcomePartitionRoot,
    verifiedMemoSetRoot: h("verified-memo-set"),
    instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
    graphRoot: graph.graphRoot,
    edgeCount: graph.edgeCount,
    instanceCount: instanceCatalog.instanceCount,
    promotionFreshness,
    promotedAtMonotonicNs: "10",
    promotionRevision: "1",
  });
  const ready = Object.freeze({ ...readyPayload, readyRecordHash: hashDomain("aloha/ready-generation/v1", readyPayload) });
  const readyArtifact = ledger.add(encodeFullFamilyReadyRecord(ready), "readyRecord");

  const sourceExecutionBindings = sourceResults.map(result => Object.freeze({
    ownerRef: result.plan.ownerRef,
    sourcePlanRef: result.plan.sourcePlanRef,
    familyDefinitionHash: result.plan.familyDefinitionHash,
    executionRoot: result.execution.executionRoot,
    evidenceRoot: result.sourceEvidence.evidenceRoot,
    resultPartitionRoot: result.execution.resultPartitionRoot,
    executionArtifactRefId: result.executionArtifact.artifactRefId,
    executionContentSha256: result.executionArtifact.contentSha256,
    evidenceArtifactRefId: result.sourceEvidenceArtifact.artifactRefId,
    evidenceContentSha256: result.sourceEvidenceArtifact.contentSha256,
    physicalObservations: Object.freeze([Object.freeze({
      rawLocatorHash: result.rawLocatorHash,
      artifactRefId: result.physicalArtifact.artifactRefId,
      contentSha256: result.physicalArtifact.contentSha256,
    })]),
  })).sort((left, right) => hashDomain("aloha/source-plan-identity/v1", {
    ownerRef: left.ownerRef,
    sourcePlanRef: left.sourcePlanRef,
  }).localeCompare(hashDomain("aloha/source-plan-identity/v1", {
    ownerRef: right.ownerRef,
    sourcePlanRef: right.sourcePlanRef,
  })));
  const sourceCoveragePayload: FullFamilySourceCoverageArtifactV1 = Object.freeze({
    schemaVersion: 1,
    kind: "aloha.full-family-source-coverage-artifact",
    readyRecordHash: ready.readyRecordHash,
    cutoff: QUALIFICATION_CUTOFF,
    executions: sourceExecutionBindings,
    sourceCoverage,
  });
  const sourceCoverageArtifact = ledger.add(encodeFullFamilySourceCoverageArtifact(sourceCoveragePayload), "sourceCoverage");

  const releaseIntentArtifact = ledger.add(releaseIntent, "releaseIntent");
  const definitionCatalogArtifact = ledger.add(FAMILY_CATALOG, "definitionCatalog");
  const runtimeCompositionArtifact = ledger.add(factoryMetadata, "runtimeComposition");
  const releaseEntries = FAMILY_CATALOG.entries.map(entry => Object.freeze({
    familyId: entry.familyId,
    familyDefinitionHash: catalogHash(entry.familyDefinitionHash, `${entry.familyId}.familyDefinitionHash`),
  }));
  const partitionByFamily = new Map(nominationClosure.families.map(partition => [partition.familyId, partition]));
  const candidateByFamily = new Map(candidates.map(candidate => [candidate.familyId, candidate]));
  const catalogEntryByFamily = new Map(FAMILY_CATALOG.entries.map(entry => [entry.familyId, entry]));
  const publicationInstanceRef = instanceIdentityRef(univ2.publication);
  const familyEntries: FullFamilyMatrixEntryV1[] = generatedRuntime.families.map(family => {
    const catalogEntry = catalogEntryByFamily.get(family.familyId)!;
    const sourcePlanItems = family.sourcePlanRefs.map(plan => rawEvidenceItem(
      ledger,
      family.familyId,
      "source-plan",
      sourcePlanIdentity(plan),
      sourcePlanIdentity(plan),
      ready.readyRecordHash,
    ));
    const candidate = candidateByFamily.get(family.familyId);
    const universeItems = candidate === undefined ? [] : [rawEvidenceItem(
      ledger,
      family.familyId,
      "universe-candidate",
      candidate.familyCandidateKey,
      candidate.familyCandidateKey,
      ready.readyRecordHash,
    )];
    const isVerified = family.familyId === "univ2-standard";
    const rawOutcome = candidate === undefined ? undefined : rawOutcomeByCandidate.get(candidate.familyCandidateKey);
    if (candidate !== undefined && rawOutcome === undefined) throw new Error(`missing qualification outcome for ${candidate.familyCandidateKey}`);
    const outcomes = candidate === undefined ? [] : [outcomeItem(
      ledger,
      family.familyId,
      candidate,
      rawOutcome!,
      runId,
      exactOutcomePartitionRoot,
      candidatePartitionRoot,
      ready.readyRecordHash,
    )];
    const instanceItems = !isVerified ? [] : [qualificationEvidenceItem(
      ledger,
      family.familyId,
      univ2.publication.instancePublicationHash,
      publicationInstanceRef,
      univ2.publication,
      "instancePublication",
    )];
    const edgeItems = !isVerified ? [] : graph.edges.map(edge => qualificationEvidenceItem(
      ledger,
      family.familyId,
      edge.edgeId,
      publicationInstanceRef,
      edge,
      "graphEdge",
    ));
    const coarseRef = catalogEntry.extensionRefs.find(ref => ref.capabilityId === `family.${family.familyId}.coarse`)!;
    const exactRef = catalogEntry.extensionRefs.find(ref => ref.capabilityId === `family.${family.familyId}.exact`)!;
    const coarseDeclarations = [qualificationEvidenceItem(
      ledger,
      family.familyId,
      catalogHash(coarseRef.ownerRef, `${family.familyId}.coarse.ownerRef`),
      catalogHash(coarseRef.ownerRef, `${family.familyId}.coarse.ownerRef`),
      coarseRef,
      "generatedCapabilityRef",
    )];
    const exactDeclarations = [qualificationEvidenceItem(
      ledger,
      family.familyId,
      catalogHash(exactRef.ownerRef, `${family.familyId}.exact.ownerRef`),
      catalogHash(exactRef.ownerRef, `${family.familyId}.exact.ownerRef`),
      exactRef,
      "generatedCapabilityRef",
    )];
    const coarseItems = !isVerified ? [] : graph.edges.map((edge, index) => {
      const coarse = univ2.coarse[index]!;
      const observationBody = Object.freeze({
        schemaVersion: 1 as const,
        kind: "aloha.family-runtime-coarse-edge-sweep-observation-v1" as const,
        familyId: family.familyId,
        familyDefinitionHash: family.familyDefinitionHash,
        releaseMembershipRoot: h("release-membership-root"),
        binding: Object.freeze({ edgeId: edge.edgeId }),
        routeHandleBindingHash: coarse.routeBindingHash,
        amountHash: coarse.amountHash,
        projectionId: coarse.projectionHash,
        stateOutcome: Object.freeze({ kind: "verified", artifact: Object.freeze({ stateFactsRoot: coarse.stateFactsRoot }) }),
        coarseOutcome: Object.freeze({ kind: "verified", artifact: coarse }),
      });
      const observation = Object.freeze({
        ...observationBody,
        observationRoot: hashDomain("aloha/family-runtime-coarse-edge-sweep-observation/v1", observationBody),
      });
      return qualificationEvidenceItem(
        ledger,
        family.familyId,
        coarse.artifactHash,
        edge.edgeId,
        observation,
        "coarseObservation",
      );
    });
    const actionOwnerRef = catalogHash(catalogEntry.actionOwnerRefs[0]!, `${family.familyId}.actionOwnerRef`);
    const actionItems = [qualificationEvidenceItem(
      ledger,
      family.familyId,
      actionOwnerRef,
      actionOwnerRef,
      {
        schemaVersion: 1,
        kind: "aloha.full-family-action-owner-artifact",
        familyId: family.familyId,
        familyDefinitionHash: family.familyDefinitionHash,
        actionOwnerRef,
      } satisfies FullFamilyActionOwnerArtifactV1,
      "generatedActionOwner",
    )];
    return sealFullFamilyMatrixEntry({
      familyId: family.familyId,
      familyDefinitionHash: family.familyDefinitionHash,
      sourcePlanRoot: family.sourcePlanRoot,
      sourcePlans: sealFamilyEvidencePartition(sourcePlanItems),
      candidatePartition: partitionByFamily.get(family.familyId)!,
      universeCandidates: sealFamilyEvidencePartition(universeItems),
      outcomes: sealFamilyOutcomePartition(outcomes),
      instancePublications: sealFamilyEvidencePartition(instanceItems),
      projectedEdges: sealFamilyEvidencePartition(edgeItems),
      declaredCoarseCapabilities: sealFamilyEvidencePartition(coarseDeclarations),
      coarseRankable: sealFamilyEvidencePartition(coarseItems),
      coarseUnavailable: sealFamilyEvidencePartition([]),
      unrankedAdmissions: sealFamilyEvidencePartition([]),
      declaredExactCapabilities: sealFamilyEvidencePartition(exactDeclarations),
      ownedActions: sealFamilyEvidencePartition(actionItems),
    });
  });
  const bundle = sealFullFamilyFacts({
    runtime: {
      generationId,
      releaseBindingId,
      readyCutoff: QUALIFICATION_CUTOFF,
      readyCutoffRoot: hashDomain("aloha/full-family/ready-cutoff/v1", QUALIFICATION_CUTOFF),
      actualCurrentSource: QUALIFICATION_ACTUAL_CURRENT_SOURCE,
      actualCurrentSourceRoot: hashDomain("aloha/full-family/actual-current-source/v1", QUALIFICATION_ACTUAL_CURRENT_SOURCE),
      recentObservationStartBlock: "51",
      recentObservationEndBlock: "100",
      recentObservationBlockCount: "50",
      releaseIntentRoot: generatedRuntime.releaseIntentRoot,
      definitionCatalogRoot: generatedRuntime.definitionCatalogRoot,
      generatedRuntimeDescriptorRoot: generatedRuntime.descriptorRoot,
      runtimeCompositionRoot: generatedRuntime.descriptorRoot,
      sourceCoverageRoot: sourceCoverage.sourceCoverageRoot,
      candidatePartitionRoot,
      nominationClosureRoot: nominationClosure.root,
      nominationClosureStorageHash,
      candidatePartitionStorageHash,
      candidatePartitionProofStorageHash,
      releaseProvenanceHash,
      instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
      graphRoot: graph.graphRoot,
      readyRecordHash: ready.readyRecordHash,
      instanceCount: instanceCatalog.instanceCount,
      edgeCount: graph.edgeCount,
      readyRecordArtifactRefId: readyArtifact.artifactRefId,
      readyRecordContentSha256: readyArtifact.contentSha256,
    },
    releaseIntent: exactReleaseSet(releaseIntentArtifact, generatedRuntime.releaseIntentRoot, releaseEntries),
    definitionCatalog: exactReleaseSet(definitionCatalogArtifact, generatedRuntime.definitionCatalogRoot, releaseEntries),
    runtimeComposition: exactReleaseSet(runtimeCompositionArtifact, generatedRuntime.descriptorRoot, releaseEntries),
    sourceCoverage: {
      artifactRefId: sourceCoverageArtifact.artifactRefId,
      contentSha256: sourceCoverageArtifact.contentSha256,
      artifact: sourceCoveragePayload,
    },
    lineage: {
      nominationClosure: {
        artifactRefId: nominationClosureArtifact.artifactRefId,
        contentSha256: nominationClosureArtifact.contentSha256,
        storageHash: nominationClosureStorageHash,
        artifact: nominationClosure,
      },
      candidatePartitionProof: {
        artifactRefId: proofArtifact.artifactRefId,
        contentSha256: proofArtifact.contentSha256,
        storageHash: candidatePartitionProofStorageHash,
        artifact: proof,
      },
      candidateProofVerifierBinding: {
        artifactRefId: verifierArtifact.artifactRefId,
        contentSha256: verifierArtifact.contentSha256,
        artifact: verifierBinding,
      },
    },
    families: familyEntries,
  });
  const existingQualificationLeaves = new Map(generatedRuntime.families.map(family => [
    family.familyId,
    hashDomain("aloha/full-family/qualification-leaf/v1", {
      familyId: family.familyId,
      familyDefinitionHash: family.familyDefinitionHash,
      sourcePlanRoot: family.sourcePlanRoot,
      sourcePlanRefs: family.sourcePlanRefs,
    }),
  ]));
  return Object.freeze({
    bundle,
    generatedRuntime,
    artifacts: ledger.items(),
    catalogOutputRoot: hashDomain("aloha/full-family/current-generated-catalog-artifacts/v1", {
      familyCatalog: FAMILY_CATALOG,
      familyRuntimeMetadata: factoryMetadata,
    }),
    instanceCatalogRoot: instanceCatalog.instanceCatalogRoot,
    graphRoot: graph.graphRoot,
    assetPorts: Object.freeze(graph.edges.flatMap(edge => [...edge.inputAssetPorts, ...edge.outputAssetPorts])),
    coarseArtifactHashes: Object.freeze(univ2.coarse.map(value => value.artifactHash)),
    actionOwnerRef: catalogHash(
      FAMILY_CATALOG.entries.find(entry => entry.familyId === "univ2-standard")!.actionOwnerRefs[0]!,
      "univ2-standard.actionOwnerRef",
    ),
    existingQualificationLeaves,
  });
}

let qualificationCorpusPromise: Promise<FullFamilyQualificationCorpusV1> | null = null;

/** Current compiler facts are an exact one-shot input. Tests share one corpus. */
export function buildFullFamilyQualificationCorpus(): Promise<FullFamilyQualificationCorpusV1> {
  qualificationCorpusPromise ??= buildFullFamilyQualificationCorpusOnce();
  return qualificationCorpusPromise;
}
