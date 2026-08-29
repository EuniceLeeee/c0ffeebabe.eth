import {
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import { erc20AssetReferenceV1 } from "../../../../packages/asset-ref/src/index.ts";
import {
  candidateSubjectHash,
  familyCandidateKey,
} from "../../../../packages/discovery/src/index.ts";
import {
  familySearchAmount,
  familySearchAmountHash,
  familySearchArtifactHash,
  familySearchObjective,
  familySearchPayloadHash,
  familySearchRouteBindingHash,
  familySearchSource,
  validateFamilySearchRouteLegBinding,
  type FamilySearchActionArtifactV1,
  type FamilySearchActionRequestV1,
  type FamilySearchAdapterV1,
  type FamilySearchAdapterFactoryV1,
  type FamilySearchCoarseArtifactV1,
  type FamilySearchCoarseRequestV1,
  type FamilySearchCompositionResolverV1,
  type FamilySearchCurrentSourceV1,
  type FamilySearchExactArtifactV1,
  type FamilySearchExactRequestV1,
  type FamilySearchLegRequestV1,
  type FamilySearchRunArtifactsV1,
  type FamilySearchRunRequestV1,
  type FamilySearchRouteLegBindingV1,
  type FamilySearchSourceReadResultV1,
  type FamilySearchSourceReadRequestV1,
  type FamilySearchStageOutcomeV1,
  type FamilySearchStateArtifactV1,
  type FamilySearchStateRequestV1,
} from "../../../../packages/family-sdk/search-runtime/index.ts";
import { assertStageCapabilityRef, type ActionOwnerRef, type StageCapabilityRefV1 } from "../../../../packages/family-sdk/runtime-refs/index.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
  UNIV2_STANDARD_FAMILY_VERSION,
} from "../family-definition.ts";
import {
  decodeIdentityMemo,
  type UniV2IdentityMemoV1,
} from "../schema/index.ts";
import {
  UNIV2_STANDARD_COARSE_PORT,
  type UniV2CoarseDirectionV1,
  type UniV2CoarsePortV1,
  type UniV2CoarseProjectionV1,
} from "../capabilities/coarse.ts";
import {
  UNIV2_STANDARD_EXACT_PORT,
  type UniV2ExactEvaluationV1,
  type UniV2ExactPortV1,
} from "../capabilities/exact.ts";
import {
  UNIV2_STANDARD_STATE_PORT,
  decodeUniV2StateSnapshot,
  type UniV2StateReadPortV1,
  type UniV2StateReadResponseV1,
  type UniV2StateReadProgramV1,
  type UniV2StateSnapshotV1,
} from "../capabilities/state.ts";
import {
  UNIV2_STANDARD_SWAP_ACTION_PORT,
  type UniV2SwapActionPortV1,
  type UniV2SwapActionV1,
} from "../capabilities/action.ts";
import {
  UNIV2_STANDARD_COARSE_CAPABILITY_ID,
  UNIV2_STANDARD_COARSE_SCHEMA_HASH,
  UNIV2_STANDARD_EXACT_CAPABILITY_ID,
  UNIV2_STANDARD_EXACT_SCHEMA_HASH,
  UNIV2_STANDARD_STATE_CAPABILITY_ID,
  UNIV2_STANDARD_STATE_SCHEMA_HASH,
} from "../capabilities/metadata.ts";

export interface UniV2SearchAdapterPortsV1 {
  /** Defaults to the release's real, schema-bound capability ports. */
  readonly state?: UniV2StateReadPortV1;
  readonly coarse?: UniV2CoarsePortV1;
  readonly exact?: UniV2ExactPortV1;
  readonly action?: UniV2SwapActionPortV1;
  /** Supplied by generated composition when the action owner is resolved. */
  readonly actionOwnerRef?: Hash | null;
}

export interface UniV2SearchAdapterCompositionInputV1 {
  readonly composition: FamilySearchCompositionResolverV1;
  readonly familyDefinitionHash?: Hash;
  readonly capabilityRefs: Readonly<{
    readonly state: StageCapabilityRefV1;
    readonly coarse: StageCapabilityRefV1;
    readonly exact: StageCapabilityRefV1;
  }>;
  readonly actionOwnerRefs: Readonly<Record<string, ActionOwnerRef>>;
}

interface UniV2SearchContextV1 {
  readonly route: FamilySearchRouteLegBindingV1;
  readonly source: ReturnType<typeof familySearchSource>;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly amountHash: Hash;
  readonly routeBindingHash: Hash;
  readonly identity: UniV2IdentityMemoV1;
  readonly direction: UniV2CoarseDirectionV1;
}

interface RuntimeIdentityMemoV2 {
  readonly kind: "univ2-identity-memo";
  readonly familyId: typeof UNIV2_STANDARD_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSubjectHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: UniV2IdentityMemoV1;
}

type UniV2StateOutcomeV1 = FamilySearchStageOutcomeV1<FamilySearchStateArtifactV1>;
type UniV2CoarseOutcomeV1 = FamilySearchStageOutcomeV1<FamilySearchCoarseArtifactV1>;
type UniV2ExactOutcomeV1 = FamilySearchStageOutcomeV1<FamilySearchExactArtifactV1>;
type UniV2ActionOutcomeV1 = FamilySearchStageOutcomeV1<FamilySearchActionArtifactV1>;

function canonical(value: unknown): CanonicalJson {
  return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function invalid<Artifact>(stage: "state" | "coarse" | "exact" | "action", error: unknown): FamilySearchStageOutcomeV1<Artifact> {
  return Object.freeze({ kind: "invalidProgram" as const, stage, code: errorCode(error, `${stage}-invalid`) });
}

function unavailable<Artifact>(stage: "state" | "coarse" | "exact" | "action", reasonCode: string, evidence: unknown): FamilySearchStageOutcomeV1<Artifact> {
  const code = typeof reasonCode === "string" && reasonCode.length > 0 ? reasonCode : `${stage}-unavailable`;
  return Object.freeze({
    kind: "unavailable" as const,
    stage,
    reasonCode: code,
    evidenceHash: hashDomain("aloha/univ2-standard/search-unavailable/v1", { stage, reasonCode: code, evidence: canonical(evidence) }),
  });
}

function assertSourceReadRequest(value: unknown, path = "sourceReadRequest"): FamilySearchSourceReadRequestV1 {
  assertExactKeys(value, ["kind", "requestId", "source", "target", "data", "responseEncoding"], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "family-search.current-source-read") throw new TypeError(`${path}.kind mismatch`);
  if (typeof record.target !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(record.target)) throw new TypeError(`${path}.target is not an address`);
  if (typeof record.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(record.data)) throw new TypeError(`${path}.data is not hex bytes`);
  if (typeof record.responseEncoding !== "string" || (record.responseEncoding !== "hex" && !/^abi-[a-z0-9][a-z0-9+._:-]*$/.test(record.responseEncoding))) {
    throw new TypeError(`${path}.responseEncoding is not a raw-byte codec`);
  }
  return deepFreeze({
    kind: "family-search.current-source-read" as const,
    requestId: assertHash(record.requestId, `${path}.requestId`),
    source: familySearchSource(record.source, `${path}.source`),
    target: record.target,
    data: record.data,
    responseEncoding: record.responseEncoding as FamilySearchSourceReadRequestV1["responseEncoding"],
  });
}

function assertReadResult(value: unknown, request: FamilySearchSourceReadRequestV1): FamilySearchSourceReadResultV1 {
  if (value === null || typeof value !== "object") throw new TypeError("source read result is required");
  const record = value as Record<string, unknown>;
  if (record.kind !== "returned" && record.kind !== "unavailable") throw new TypeError("source read result kind is invalid");
  assertExactKeys(value, record.kind === "returned"
    ? ["kind", "requestId", "source", "dataHex"]
    : ["kind", "requestId", "source", "reasonCode"], "sourceReadResult");
  const requestId = assertHash(record.requestId, "sourceReadResult.requestId");
  if (requestId !== request.requestId) throw new TypeError("source read request binding mismatch");
  const source = familySearchSource(record.source, "sourceReadResult.source");
  if (!sameSource(source, request.source)) throw new TypeError("source read source mismatch");
  if (record.kind === "returned") {
    if (typeof record.dataHex !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(record.dataHex)) throw new TypeError("source read data is not hex bytes");
    return deepFreeze({ kind: "returned" as const, requestId, source, dataHex: record.dataHex.toLowerCase() });
  }
  if (typeof record.reasonCode !== "string" || record.reasonCode.length === 0) throw new TypeError("source read unavailable reason is empty");
  return deepFreeze({ kind: "unavailable" as const, requestId, source, reasonCode: record.reasonCode });
}

function sameSource(left: ReturnType<typeof familySearchSource>, right: ReturnType<typeof familySearchSource>): boolean {
  return left.chainId === right.chainId && left.number === right.number && left.hash === right.hash && left.stateRoot === right.stateRoot;
}

function assetRef(chainId: string, address: string): Hash {
  return erc20AssetReferenceV1(chainId, address).assetRef;
}

function decodeRuntimeIdentityMemo(value: unknown, path: string): RuntimeIdentityMemoV2 {
  assertExactKeys(value, [
    "kind",
    "familyId",
    "familyDefinitionHash",
    "familyCandidateKey",
    "instanceNominationKey",
    "candidateSubjectHash",
    "candidateEvidenceRoot",
    "identity",
  ], path);
  const record = value as Record<string, unknown>;
  if (record.kind !== "univ2-identity-memo") throw new TypeError("univ2-search-identity-kind-mismatch");
  if (record.familyId !== UNIV2_STANDARD_FAMILY_ID) throw new TypeError("univ2-search-identity-family-id-mismatch");
  const familyDefinitionHash = assertHash(record.familyDefinitionHash, `${path}.familyDefinitionHash`);
  const instanceNominationKey = assertNonEmptyString(record.instanceNominationKey, `${path}.instanceNominationKey`);
  const identity = decodeIdentityMemo(record.identity, `${path}.identity`);
  const memo = deepFreeze({
    kind: "univ2-identity-memo" as const,
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash,
    familyCandidateKey: assertHash(record.familyCandidateKey, `${path}.familyCandidateKey`),
    instanceNominationKey,
    candidateSubjectHash: assertHash(record.candidateSubjectHash, `${path}.candidateSubjectHash`),
    candidateEvidenceRoot: assertHash(record.candidateEvidenceRoot, `${path}.candidateEvidenceRoot`),
    identity,
  });
  if (
    memo.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH
    || memo.familyCandidateKey !== familyCandidateKey(memo.familyDefinitionHash, memo.instanceNominationKey)
    || memo.candidateSubjectHash !== candidateSubjectHash(memo.familyDefinitionHash, memo.instanceNominationKey)
    || memo.instanceNominationKey !== memo.identity.instanceNominationKey
    || memo.candidateSubjectHash !== memo.identity.candidateSnapshotHash
  ) throw new TypeError("univ2-search-identity-lineage-mismatch");
  return memo;
}

function validateIdentity(route: UniV2SearchContextV1["route"]): UniV2IdentityMemoV1 {
  if (route.familyId !== UNIV2_STANDARD_FAMILY_ID) throw new TypeError("univ2-search-family-id-mismatch");
  if (route.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH) throw new TypeError("univ2-search-family-definition-mismatch");
  const runtimeMemo = decodeRuntimeIdentityMemo(route.identityMemo, "univ2.search.identityMemo");
  const identity = runtimeMemo.identity;
  if (identity.familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH) throw new TypeError("univ2-search-identity-family-mismatch");
  if (identity.instanceKey !== route.instanceKey || identity.instanceKey !== identity.facts.pool) throw new TypeError("univ2-search-instance-binding-mismatch");
  if (identity.factsHash !== hashDomain("aloha/univ2-standard/identity-facts/v1", identity.facts)) throw new TypeError("univ2-search-identity-facts-hash-mismatch");
  return identity;
}

function direction(identity: UniV2IdentityMemoV1, amount: ReturnType<typeof familySearchAmount>): UniV2CoarseDirectionV1 {
  const token0 = assetRef(identity.cutoff.chainId, identity.facts.token0);
  const token1 = assetRef(identity.cutoff.chainId, identity.facts.token1);
  if (amount.inputAssetRef === token0 && amount.outputAssetRef === token1) return "token0-to-token1";
  if (amount.inputAssetRef === token1 && amount.outputAssetRef === token0) return "token1-to-token0";
  throw new TypeError("univ2-search-amount-assets-do-not-match-identity");
}

function context(input: FamilySearchLegRequestV1): UniV2SearchContextV1 {
  if (input === null || typeof input !== "object") throw new TypeError("univ2 search input is required");
  const route = validateFamilySearchRouteLegBinding(input.route);
  const source = familySearchSource(input.currentSource.source, "currentSource.source");
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const amountHash = familySearchAmountHash(amount);
  const routeBindingHash = familySearchRouteBindingHash(route);
  const identity = validateIdentity(route);
  return { route, source, objective, amount, amountHash, routeBindingHash, identity, direction: direction(identity, amount) };
}

function stateArtifact(contextInput: UniV2SearchContextV1, snapshot: UniV2StateSnapshotV1): FamilySearchStateArtifactV1 {
  const payload = canonical(snapshot);
  const payloadHash = familySearchPayloadHash("state", payload);
  if (snapshot.identityFactsHash !== contextInput.identity.factsHash || snapshot.instanceKey !== contextInput.route.instanceKey || snapshot.pool !== contextInput.identity.facts.pool || snapshot.token0 !== contextInput.identity.facts.token0 || snapshot.token1 !== contextInput.identity.facts.token1) throw new TypeError("univ2-search-state-identity-lineage-mismatch");
  return deepFreeze({
    kind: "state" as const,
    status: "verified" as const,
    source: contextInput.source,
    routeBindingHash: contextInput.routeBindingHash,
    payload,
    payloadHash,
    artifactHash: familySearchArtifactHash({ kind: "state", source: contextInput.source, routeBindingHash: contextInput.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }),
    factsRoot: snapshot.stateFactsRoot,
    sourceRequestId: snapshot.sourceRequest.requestId,
  });
}

function assertStateArtifact(value: FamilySearchStateArtifactV1, contextInput: UniV2SearchContextV1, statePort: UniV2StateReadPortV1): UniV2StateSnapshotV1 {
  assertExactKeys(value, ["kind", "status", "source", "routeBindingHash", "payload", "payloadHash", "artifactHash", "factsRoot", "sourceRequestId"], "stateArtifact");
  if (value.kind !== "state" || value.status !== "verified") throw new TypeError("univ2-search-state-artifact-status-mismatch");
  const source = familySearchSource(value.source, "stateArtifact.source");
  if (!sameSource(source, contextInput.source) || value.routeBindingHash !== contextInput.routeBindingHash) throw new TypeError("univ2-search-state-artifact-binding-mismatch");
  const payload = canonical(value.payload);
  const payloadHash = familySearchPayloadHash("state", payload);
  if (value.payloadHash !== payloadHash || value.artifactHash !== familySearchArtifactHash({ kind: "state", source, routeBindingHash: value.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("univ2-search-state-artifact-hash-mismatch");
  const snapshot = decodeUniV2StateSnapshot(payload);
  if (!sameSource(snapshot.source, source) || snapshot.identityFactsHash !== contextInput.identity.factsHash || snapshot.instanceKey !== contextInput.route.instanceKey || snapshot.pool !== contextInput.identity.facts.pool || snapshot.token0 !== contextInput.identity.facts.token0 || snapshot.token1 !== contextInput.identity.facts.token1 || snapshot.stateFactsRoot !== value.factsRoot || snapshot.sourceRequest.requestId !== value.sourceRequestId) throw new TypeError("univ2-search-state-artifact-lineage-mismatch");
  return snapshot;
}

function coarseArtifact(contextInput: UniV2SearchContextV1, projection: UniV2CoarseProjectionV1): FamilySearchCoarseArtifactV1 {
  if (!sameSource(projection.source, contextInput.source)) throw new TypeError("univ2-search-coarse-source-mismatch");
  const payload = canonical(projection);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  const nativeInput = projection.inputs[0];
  if (!nativeInput || nativeInput.assetRef !== contextInput.amount.inputAssetRef || nativeInput.amount !== contextInput.amount.amountIn) throw new TypeError("univ2-search-coarse-input-binding-mismatch");
  const nativeOutput = projection.outputs[0] ?? null;
  if (projection.status === "rankable" && (!nativeOutput || nativeOutput.assetRef !== contextInput.amount.outputAssetRef)) throw new TypeError("univ2-search-coarse-output-binding-mismatch");
  assertHash(projection.stateFactsRoot, "univ2.coarse.stateFactsRoot");
  const output = nativeOutput === null ? null : { assetRef: nativeOutput.assetRef, amount: nativeOutput.amount };
  const rankKey = projection.status === "rankable"
    ? hashDomain("aloha/univ2-standard/search-coarse-rank/v1", { objectiveRef: contextInput.objective.objectiveRef, routeBindingHash: contextInput.routeBindingHash, projectionHash: projection.projectionHash, inputAmount: contextInput.amount.amountIn, outputAmount: nativeOutput?.amount ?? null })
    : null;
  return deepFreeze({
    kind: "coarse" as const,
    status: projection.status,
    source: contextInput.source,
    routeBindingHash: contextInput.routeBindingHash,
    objectiveRef: contextInput.objective.objectiveRef,
    amountHash: contextInput.amountHash,
    payload,
    payloadHash,
    artifactHash: familySearchArtifactHash({ kind: "coarse", source: contextInput.source, routeBindingHash: contextInput.routeBindingHash, objectiveRef: contextInput.objective.objectiveRef, amountHash: contextInput.amountHash, payloadHash }),
    projectionHash: projection.projectionHash,
    stateFactsRoot: projection.stateFactsRoot,
    input: { assetRef: nativeInput.assetRef, amount: nativeInput.amount },
    output,
    conservativeOutputUpperBound: projection.conservativeOutputUpperBound?.amount ?? null,
    inputCapacityUpperBound: projection.inputCapacityUpperBound,
    rankKey,
    reasonCode: projection.reasonCode,
  });
}

function assertCoarseArtifact(value: FamilySearchCoarseArtifactV1, contextInput: UniV2SearchContextV1, snapshot: UniV2StateSnapshotV1, coarsePort: UniV2CoarsePortV1): UniV2CoarseProjectionV1 {
  assertExactKeys(value, ["kind", "status", "source", "routeBindingHash", "objectiveRef", "amountHash", "payload", "payloadHash", "artifactHash", "projectionHash", "stateFactsRoot", "input", "output", "conservativeOutputUpperBound", "inputCapacityUpperBound", "rankKey", "reasonCode"], "coarseArtifact");
  const source = familySearchSource(value.source, "coarseArtifact.source");
  if (value.kind !== "coarse" || !sameSource(source, contextInput.source) || value.routeBindingHash !== contextInput.routeBindingHash || value.objectiveRef !== contextInput.objective.objectiveRef || value.amountHash !== contextInput.amountHash) throw new TypeError("univ2-search-coarse-artifact-binding-mismatch");
  const payload = canonical(value.payload);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  if (value.payloadHash !== payloadHash || value.artifactHash !== familySearchArtifactHash({ kind: "coarse", source, routeBindingHash: value.routeBindingHash, objectiveRef: value.objectiveRef, amountHash: value.amountHash, payloadHash })) throw new TypeError("univ2-search-coarse-artifact-hash-mismatch");
  const projection = coarsePort.decode(payload);
  if (!sameSource(projection.source, contextInput.source) || projection.projectionHash !== value.projectionHash || projection.stateFactsRoot !== snapshot.stateFactsRoot || projection.status !== value.status || projection.reasonCode !== value.reasonCode) throw new TypeError("univ2-search-coarse-artifact-lineage-mismatch");
  const nativeInput = projection.inputs[0];
  if (!nativeInput || nativeInput.assetRef !== contextInput.amount.inputAssetRef || nativeInput.amount !== contextInput.amount.amountIn) throw new TypeError("univ2-search-coarse-artifact-input-mismatch");
  if (value.status === "rankable" && (projection.outputs[0]?.assetRef !== contextInput.amount.outputAssetRef || value.rankKey === null)) throw new TypeError("univ2-search-coarse-artifact-output-mismatch");
  if (value.status === "unavailable" && value.rankKey !== null) throw new TypeError("univ2-search-coarse-artifact-rank-mismatch");
  return projection;
}

function exactArtifact(contextInput: UniV2SearchContextV1, evaluation: UniV2ExactEvaluationV1): FamilySearchExactArtifactV1 {
  if (!sameSource(evaluation.source, contextInput.source)) throw new TypeError("univ2-search-exact-source-mismatch");
  const payload = canonical(evaluation);
  const payloadHash = familySearchPayloadHash("exact", payload);
  const input = evaluation.inputs[0];
  const output = evaluation.outputs[0];
  if (!input || !output || input.assetRef !== contextInput.amount.inputAssetRef || input.amount !== contextInput.amount.amountIn || output.assetRef !== contextInput.amount.outputAssetRef) throw new TypeError("univ2-search-exact-amount-binding-mismatch");
  return deepFreeze({
    kind: "exact" as const,
    status: evaluation.status,
    source: contextInput.source,
    routeBindingHash: contextInput.routeBindingHash,
    objectiveRef: contextInput.objective.objectiveRef,
    amountHash: contextInput.amountHash,
    payload,
    payloadHash,
    artifactHash: familySearchArtifactHash({ kind: "exact", source: contextInput.source, routeBindingHash: contextInput.routeBindingHash, objectiveRef: contextInput.objective.objectiveRef, amountHash: contextInput.amountHash, payloadHash }),
    evaluationHash: evaluation.evaluationHash,
    stateFactsRoot: evaluation.stateFactsRoot,
    inputs: Object.freeze(evaluation.inputs.map(item => ({ assetRef: item.assetRef, amount: item.amount }))),
    outputs: Object.freeze(evaluation.outputs.map(item => ({ assetRef: item.assetRef, amount: item.amount }))),
    obligationRoot: evaluation.obligationRoot,
    reasonCode: evaluation.reasonCode,
  });
}

function assertExactArtifact(value: FamilySearchExactArtifactV1, contextInput: UniV2SearchContextV1, snapshot: UniV2StateSnapshotV1, coarse: UniV2CoarseProjectionV1, exactPort: UniV2ExactPortV1): UniV2ExactEvaluationV1 {
  assertExactKeys(value, ["kind", "status", "source", "routeBindingHash", "objectiveRef", "amountHash", "payload", "payloadHash", "artifactHash", "evaluationHash", "stateFactsRoot", "inputs", "outputs", "obligationRoot", "reasonCode"], "exactArtifact");
  const source = familySearchSource(value.source, "exactArtifact.source");
  if (value.kind !== "exact" || !sameSource(source, contextInput.source) || value.routeBindingHash !== contextInput.routeBindingHash || value.objectiveRef !== contextInput.objective.objectiveRef || value.amountHash !== contextInput.amountHash) throw new TypeError("univ2-search-exact-artifact-binding-mismatch");
  const payload = canonical(value.payload);
  const payloadHash = familySearchPayloadHash("exact", payload);
  if (value.payloadHash !== payloadHash || value.artifactHash !== familySearchArtifactHash({ kind: "exact", source, routeBindingHash: value.routeBindingHash, objectiveRef: value.objectiveRef, amountHash: value.amountHash, payloadHash })) throw new TypeError("univ2-search-exact-artifact-hash-mismatch");
  const evaluation = exactPort.decode(payload);
  if (!sameSource(evaluation.source, contextInput.source) || evaluation.evaluationHash !== value.evaluationHash || evaluation.stateFactsRoot !== snapshot.stateFactsRoot || evaluation.status !== value.status || evaluation.reasonCode !== value.reasonCode) throw new TypeError("univ2-search-exact-artifact-lineage-mismatch");
  if (coarse.status !== "rankable" && evaluation.status === "verified") throw new TypeError("univ2-search-exact-coarse-status-mismatch");
  const input = evaluation.inputs[0];
  const output = evaluation.outputs[0];
  if (!input || !output || input.assetRef !== contextInput.amount.inputAssetRef || input.amount !== contextInput.amount.amountIn || output.assetRef !== contextInput.amount.outputAssetRef) throw new TypeError("univ2-search-exact-artifact-amount-mismatch");
  return evaluation;
}

function assertExactArtifactForAction(value: FamilySearchExactArtifactV1, contextInput: UniV2SearchContextV1, exactPort: UniV2ExactPortV1): UniV2ExactEvaluationV1 {
  assertExactKeys(value, ["kind", "status", "source", "routeBindingHash", "objectiveRef", "amountHash", "payload", "payloadHash", "artifactHash", "evaluationHash", "stateFactsRoot", "inputs", "outputs", "obligationRoot", "reasonCode"], "exactArtifact");
  const source = familySearchSource(value.source, "exactArtifact.source");
  if (value.kind !== "exact" || !sameSource(source, contextInput.source) || value.routeBindingHash !== contextInput.routeBindingHash || value.objectiveRef !== contextInput.objective.objectiveRef || value.amountHash !== contextInput.amountHash) throw new TypeError("univ2-search-exact-artifact-binding-mismatch");
  const payload = canonical(value.payload);
  const payloadHash = familySearchPayloadHash("exact", payload);
  if (value.payloadHash !== payloadHash || value.artifactHash !== familySearchArtifactHash({ kind: "exact", source, routeBindingHash: value.routeBindingHash, objectiveRef: value.objectiveRef, amountHash: value.amountHash, payloadHash })) throw new TypeError("univ2-search-exact-artifact-hash-mismatch");
  const evaluation = exactPort.decode(payload);
  if (!sameSource(evaluation.source, contextInput.source) || evaluation.evaluationHash !== value.evaluationHash || evaluation.status !== value.status || evaluation.reasonCode !== value.reasonCode || evaluation.stateFactsRoot !== value.stateFactsRoot) throw new TypeError("univ2-search-exact-artifact-lineage-mismatch");
  const input = evaluation.inputs[0];
  const output = evaluation.outputs[0];
  if (!input || !output || input.assetRef !== contextInput.amount.inputAssetRef || input.amount !== contextInput.amount.amountIn || output.assetRef !== contextInput.amount.outputAssetRef) throw new TypeError("univ2-search-exact-artifact-amount-mismatch");
  return evaluation;
}

function actionArtifact(contextInput: UniV2SearchContextV1, action: UniV2SwapActionV1, actionOwnerRef: Hash | null, exactEvaluationHash: Hash): FamilySearchActionArtifactV1 {
  if (!sameSource(action.source, contextInput.source)) throw new TypeError("univ2-search-action-lineage-mismatch");
  if (action.exactEvaluationHash !== assertHash(exactEvaluationHash, "univ2.exact.evaluationHash")) throw new TypeError("univ2-search-action-exact-lineage-mismatch");
  const actionInput = action.inputs[0];
  const actionOutput = action.outputs[0];
  if (!actionInput || !actionOutput || actionInput.assetRef !== contextInput.amount.inputAssetRef || actionInput.amount !== contextInput.amount.amountIn || actionOutput.assetRef !== contextInput.amount.outputAssetRef) throw new TypeError("univ2-search-action-amount-binding-mismatch");
  const payload = canonical(action);
  const payloadHash = familySearchPayloadHash("action", payload);
  return deepFreeze({
    kind: "action" as const,
    status: "ready" as const,
    source: contextInput.source,
    routeBindingHash: contextInput.routeBindingHash,
    objectiveRef: contextInput.objective.objectiveRef,
    amountHash: contextInput.amountHash,
    payload,
    payloadHash,
    artifactHash: familySearchArtifactHash({ kind: "action", source: contextInput.source, routeBindingHash: contextInput.routeBindingHash, objectiveRef: contextInput.objective.objectiveRef, amountHash: contextInput.amountHash, payloadHash }),
    actionHash: action.actionHash,
    exactEvaluationHash: action.exactEvaluationHash,
    actionOwnerId: action.actionOwnerId,
    actionOwnerRef,
    opaqueBytes: action.opaqueBytes,
    effectTransport: action.effectTransport,
    inputs: Object.freeze(action.inputs.map(item => ({ assetRef: item.assetRef, amount: item.amount }))),
    outputs: Object.freeze(action.outputs.map(item => ({ assetRef: item.assetRef, amount: item.amount }))),
    obligationRoot: action.obligationRoot,
  });
}

function assertActionArtifact(value: FamilySearchActionArtifactV1, contextInput: UniV2SearchContextV1, exact: UniV2ExactEvaluationV1, actionPort: UniV2SwapActionPortV1): UniV2SwapActionV1 {
  assertExactKeys(value, ["kind", "status", "source", "routeBindingHash", "objectiveRef", "amountHash", "payload", "payloadHash", "artifactHash", "actionHash", "exactEvaluationHash", "actionOwnerId", "actionOwnerRef", "opaqueBytes", "effectTransport", "inputs", "outputs", "obligationRoot"], "actionArtifact");
  const source = familySearchSource(value.source, "actionArtifact.source");
  if (value.kind !== "action" || value.status !== "ready" || !sameSource(source, contextInput.source) || value.routeBindingHash !== contextInput.routeBindingHash || value.objectiveRef !== contextInput.objective.objectiveRef || value.amountHash !== contextInput.amountHash) throw new TypeError("univ2-search-action-artifact-binding-mismatch");
  const payload = canonical(value.payload);
  const payloadHash = familySearchPayloadHash("action", payload);
  if (value.payloadHash !== payloadHash || value.artifactHash !== familySearchArtifactHash({ kind: "action", source, routeBindingHash: value.routeBindingHash, objectiveRef: value.objectiveRef, amountHash: value.amountHash, payloadHash })) throw new TypeError("univ2-search-action-artifact-hash-mismatch");
  const action = actionPort.decode(payload);
  if (action.actionHash !== value.actionHash || action.exactEvaluationHash !== value.exactEvaluationHash || action.exactEvaluationHash !== exact.evaluationHash || action.actionOwnerId !== value.actionOwnerId || action.opaqueBytes !== value.opaqueBytes || action.obligationRoot !== value.obligationRoot || JSON.stringify(action.effectTransport) !== JSON.stringify(value.effectTransport)) throw new TypeError("univ2-search-action-artifact-lineage-mismatch");
  return action;
}

function sourceReadRequest(program: UniV2StateReadProgramV1): FamilySearchSourceReadRequestV1 {
  return assertSourceReadRequest({
    kind: "family-search.current-source-read",
    requestId: program.request.requestId,
    source: program.source,
    target: program.request.target,
    data: program.request.data,
    responseEncoding: program.request.responseEncoding,
  });
}

function makeAdapter(options: UniV2SearchAdapterPortsV1 = {}): FamilySearchAdapterV1 {
  const statePort = options.state ?? UNIV2_STANDARD_STATE_PORT;
  const coarsePort = options.coarse ?? UNIV2_STANDARD_COARSE_PORT;
  const exactPort = options.exact ?? UNIV2_STANDARD_EXACT_PORT;
  const actionPort = options.action ?? UNIV2_STANDARD_SWAP_ACTION_PORT;
  const actionOwnerRef = options.actionOwnerRef === undefined || options.actionOwnerRef === null ? null : assertHash(options.actionOwnerRef, "actionOwnerRef");

  const readState = async (input: FamilySearchStateRequestV1): Promise<UniV2StateOutcomeV1> => {
    let contextInput: UniV2SearchContextV1;
    try {
      contextInput = context(input);
      await input.currentSource.assertCurrent();
      const program = statePort.issueReserveReadProgram({ identity: contextInput.identity, source: contextInput.source });
      const request = sourceReadRequest(program);
      let raw: unknown;
      try {
        raw = await input.readPort.read({
          request,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
          ...(input.deadlineAtMs === undefined ? {} : { deadlineAtMs: input.deadlineAtMs }),
        });
      } catch (error) {
        return unavailable("state", "source-transport-unavailable", { requestId: request.requestId, source: request.source, error: errorCode(error, "transport-error") });
      }
      const result = assertReadResult(raw, request);
      if (result.kind === "unavailable") return unavailable("state", result.reasonCode, { requestId: result.requestId, source: result.source });
      await input.currentSource.assertCurrent();
      const response: UniV2StateReadResponseV1 = {
        kind: "univ2-standard.state-read-response",
        programHash: program.programHash,
        source: result.source,
        pool: program.pool,
        dataHex: result.dataHex,
      };
      const snapshot = statePort.decodeReserveReadResponse(program, response);
      return Object.freeze({ kind: "verified" as const, artifact: stateArtifact(contextInput, snapshot) });
    } catch (error) {
      return invalid("state", error);
    }
  };

  const projectCoarse = (input: FamilySearchCoarseRequestV1): UniV2CoarseOutcomeV1 => {
    try {
      const contextInput = context(input);
      const snapshot = assertStateArtifact(input.state, contextInput, statePort);
      const projection = coarsePort.project({ state: snapshot, direction: contextInput.direction, sampleInputAmount: contextInput.amount.amountIn });
      const artifact = coarseArtifact(contextInput, projection);
      return Object.freeze({ kind: "verified" as const, artifact });
    } catch (error) {
      return invalid("coarse", error);
    }
  };

  const evaluateExact = (input: FamilySearchExactRequestV1): UniV2ExactOutcomeV1 => {
    try {
      const contextInput = context(input);
      const snapshot = assertStateArtifact(input.state, contextInput, statePort);
      const coarse = assertCoarseArtifact(input.coarse, contextInput, snapshot, coarsePort);
      const evaluation = exactPort.propagateAmount({ state: snapshot, direction: contextInput.direction, amountIn: contextInput.amount.amountIn });
      const artifact = exactArtifact(contextInput, evaluation);
      if (artifact.stateFactsRoot !== coarse.stateFactsRoot) throw new TypeError("univ2-search-exact-coarse-state-mismatch");
      return Object.freeze({ kind: "verified" as const, artifact });
    } catch (error) {
      return invalid("exact", error);
    }
  };

  const buildAction = (input: FamilySearchActionRequestV1): UniV2ActionOutcomeV1 => {
    try {
      const contextInput = context(input);
      const exact = assertExactArtifactForAction(input.exact, contextInput, exactPort);
      if (exact.status !== "verified") return unavailable("action", "exact-unavailable", { evaluationHash: exact.evaluationHash, reasonCode: exact.reasonCode });
      const action = actionPort.build({
        exact,
        pool: contextInput.identity.facts.pool,
        tokenIn: contextInput.direction === "token0-to-token1" ? contextInput.identity.facts.token0 : contextInput.identity.facts.token1,
        tokenOut: contextInput.direction === "token0-to-token1" ? contextInput.identity.facts.token1 : contextInput.identity.facts.token0,
        direction: contextInput.direction,
        recipient: contextInput.amount.recipient,
        // The generic amount envelope is not an owner-issued callback
        // program.  UniV2's current action contract therefore always emits
        // its canonical empty callback bytes.
        callbackDataHex: "0x",
      });
      return Object.freeze({ kind: "verified" as const, artifact: actionArtifact(contextInput, action, actionOwnerRef, exact.evaluationHash) });
    } catch (error) {
      return invalid("action", error);
    }
  };

  const run = async (input: FamilySearchRunRequestV1): Promise<FamilySearchStageOutcomeV1<FamilySearchRunArtifactsV1>> => {
    const state = await readState(input);
    if (state.kind !== "verified") return state;
    const coarse = projectCoarse({ ...input, state: state.artifact });
    if (coarse.kind !== "verified") return coarse;
    if (coarse.artifact.status !== "rankable") return unavailable("coarse", coarse.artifact.reasonCode ?? "coarse-unavailable", { projectionHash: coarse.artifact.projectionHash });
    const exact = evaluateExact({ ...input, state: state.artifact, coarse: coarse.artifact });
    if (exact.kind !== "verified") return exact;
    if (exact.artifact.status !== "verified") return unavailable("exact", exact.artifact.reasonCode ?? "exact-unavailable", { evaluationHash: exact.artifact.evaluationHash });
    const action = buildAction({ ...input, exact: exact.artifact });
    if (action.kind !== "verified") return action;
    return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ state: state.artifact, coarse: coarse.artifact, exact: exact.artifact, action: action.artifact }) });
  };

  return Object.freeze({ readState, projectCoarse, evaluateExact, buildAction, run });
}

function resolvedCapability<T extends object>(value: object, method: keyof T, name: string): T {
  if (value === null || typeof value !== "object" || typeof (value as Record<string, unknown>)[method as string] !== "function") {
    throw new TypeError(`generated ${name} port is incomplete`);
  }
  return value as T;
}

/** Bind this Family adapter to the exact ports emitted by generated composition. */
export function createUniV2SearchAdapterFromComposition(input: UniV2SearchAdapterCompositionInputV1): FamilySearchAdapterV1 {
  if (input === null || typeof input !== "object") throw new TypeError("UniV2 search composition input is required");
  const composition = input.composition;
  if (composition === null || typeof composition !== "object") throw new TypeError("Family search composition is required");
  const familyDefinitionHash = assertHash(input.familyDefinitionHash ?? UNIV2_STANDARD_FAMILY_DEFINITION_HASH, "familyDefinitionHash");
  if (familyDefinitionHash !== UNIV2_STANDARD_FAMILY_DEFINITION_HASH) throw new TypeError("generated UniV2 family-definition hash mismatch");
  const refs = input.capabilityRefs;
  for (const [name, ref, capabilityId] of [
    ["state", refs?.state, "family.univ2-standard.state"],
    ["coarse", refs?.coarse, "family.univ2-standard.coarse"],
    ["exact", refs?.exact, "family.univ2-standard.exact"],
  ] as const) {
    assertStageCapabilityRef(ref, `capabilityRefs.${name}`);
    const expectedSchemaHash = name === "state"
      ? UNIV2_STANDARD_STATE_SCHEMA_HASH
      : name === "coarse"
        ? UNIV2_STANDARD_COARSE_SCHEMA_HASH
        : UNIV2_STANDARD_EXACT_SCHEMA_HASH;
    if (
      ref.familyId !== UNIV2_STANDARD_FAMILY_ID
      || ref.familyDefinitionHash !== familyDefinitionHash
      || ref.stage !== "capability"
      || ref.capabilityId !== capabilityId
      || ref.version !== UNIV2_STANDARD_FAMILY_VERSION
      || ref.schemaHash !== expectedSchemaHash
    ) throw new TypeError(`generated UniV2 ${name} capability ref mismatch`);
  }
  const actionOwnerRefInput = input.actionOwnerRefs.swap;
  const actionOwnerRef = assertHash(actionOwnerRefInput, "actionOwnerRef") as ActionOwnerRef;
  const state = resolvedCapability<UniV2StateReadPortV1>(composition.resolveCapability(familyDefinitionHash, refs.state), "issueReserveReadProgram", "state");
  const coarse = resolvedCapability<UniV2CoarsePortV1>(composition.resolveCapability(familyDefinitionHash, refs.coarse), "project", "coarse");
  const exact = resolvedCapability<UniV2ExactPortV1>(composition.resolveCapability(familyDefinitionHash, refs.exact), "propagateAmount", "exact");
  const action = resolvedCapability<UniV2SwapActionPortV1>(composition.resolveActionOwner(familyDefinitionHash, actionOwnerRef), "build", "action-owner");
  return makeAdapter({ state, coarse, exact, action, actionOwnerRef });
}

/** Typed generated-registry entry point; all refs still flow to the existing factory. */
export const UNIV2_STANDARD_SEARCH_ADAPTER_FACTORY: FamilySearchAdapterFactoryV1 = input => createUniV2SearchAdapterFromComposition({
  composition: input.composition,
  familyDefinitionHash: input.familyDefinitionHash,
  capabilityRefs: {
    state: input.capabilityRefs.state!,
    coarse: input.capabilityRefs.coarse!,
    exact: input.capabilityRefs.exact!,
  },
  actionOwnerRefs: input.actionOwnerRefs,
});

export function createUniV2SearchAdapter(options: UniV2SearchAdapterPortsV1 = {}): FamilySearchAdapterV1 {
  return makeAdapter(options);
}

export const UNIV2_STANDARD_SEARCH_ADAPTER: FamilySearchAdapterV1 = createUniV2SearchAdapter();
