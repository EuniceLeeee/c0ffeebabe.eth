import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type { FamilyRouteHandleBindingV1 } from "../runtime/index.ts";
import type { ActionOwnerRef, StageCapabilityRefV1 } from "../runtime-refs/index.ts";
import type { EffectTransportDeclarationV1 } from "../../execution-program/src/index.ts";

/** Stable public role for every Family's generic search adapter contract. */
export const FAMILY_SEARCH_RUNTIME_ADAPTER_ROLE_V1 = "search/v1" as const;

/** The only source identity a Family search adapter may consume. */
export interface FamilySearchSourceV1 {
  readonly chainId: string;
  readonly number: string;
  readonly hash: Hash;
  readonly stateRoot: Hash;
}

/** A current-source session is a check, not a source-of-truth shortcut. */
export interface FamilySearchCurrentSourceV1 {
  readonly source: FamilySearchSourceV1;
  readonly assertCurrent: () => Promise<void> | void;
}

/**
 * Family-owned declaration for an EVM method whose successful observation is
 * carried in direct JSON-RPC error data.  The transport preserves the bytes;
 * only the owning Family may interpret the declared ABI payload.
 */
export interface FamilySearchDeclaredRevertDataV1 {
  readonly kind: "declared-revert-data";
  readonly dataEncoding: `abi-${string}`;
  readonly selector: `0x${string}`;
  readonly byteLength: number;
}

/** Narrow physical transport owned by the current-source/state runtime. */
export interface FamilySearchSourceReadRequestV1 {
  readonly kind: "family-search.current-source-read";
  readonly requestId: Hash;
  readonly source: FamilySearchSourceV1;
  readonly target: string;
  readonly data: string;
  /**
   * The physical transport returns raw EVM bytes. Families may describe an
   * ABI shape or consume the bytes as opaque hex, but they cannot ask the
   * transport to synthesize a protocol object (for example canonical JSON).
   */
  readonly responseEncoding: "hex" | `abi-${string}`;
  readonly declaredRevertData?: FamilySearchDeclaredRevertDataV1;
}

export type FamilySearchSourceReadResultV1 =
  | {
    readonly kind: "returned";
    readonly requestId: Hash;
    readonly source: FamilySearchSourceV1;
    readonly dataHex: string;
  }
  | {
    readonly kind: "reverted";
    readonly reasonCode: "declared-revert-data";
    readonly requestId: Hash;
    readonly source: FamilySearchSourceV1;
    readonly rpcErrorCode: number;
    readonly dataEncoding: `abi-${string}`;
    readonly dataHex: string;
  }
  | {
    readonly kind: "unavailable";
    readonly requestId: Hash;
    readonly source: FamilySearchSourceV1;
    readonly reasonCode: string;
  };

export interface FamilySearchSourceReadPortV1 {
  readonly read: (input: {
    readonly request: FamilySearchSourceReadRequestV1;
    readonly signal?: AbortSignal;
    /** Logical consumer deadline; never part of the semantic WorkKey. */
    readonly deadlineAtMs?: number;
  }) => Promise<FamilySearchSourceReadResultV1> | FamilySearchSourceReadResultV1;
}

/** Narrow generated-composition lookup used by a Family-owned adapter. */
export interface FamilySearchCompositionResolverV1 {
  readonly resolveCapability: (familyDefinitionHash: Hash, capabilityRef: StageCapabilityRefV1) => object;
  readonly resolveActionOwner: (familyDefinitionHash: Hash, ownerRef: ActionOwnerRef) => object;
}

/**
 * Generated runtime composition invokes one Family-owned orchestration
 * factory with only release-qualified capability/action-owner refs.  The
 * factory remains the Family leaf; this envelope carries no semantic result
 * authority or protocol dispatch.
 */
export interface FamilySearchAdapterFactoryInputV1 {
  readonly composition: FamilySearchCompositionResolverV1;
  readonly familyDefinitionHash: Hash;
  readonly capabilityRefs: Readonly<Record<string, StageCapabilityRefV1>>;
  readonly actionOwnerRefs: Readonly<Record<string, ActionOwnerRef>>;
}

export type FamilySearchAdapterFactoryV1 = (input: FamilySearchAdapterFactoryInputV1) => FamilySearchAdapterV1;

/** Objective and amount are canonical envelopes; the Family owns their meaning. */
export interface FamilySearchObjectiveV1 {
  readonly objectiveRef: Hash;
  readonly payload: CanonicalJson;
}

export interface FamilySearchAmountEnvelopeV1 {
  readonly inputAssetRef: Hash;
  readonly outputAssetRef: Hash;
  readonly amountIn: string;
  /** Opaque to the coordinator; the action owner gives it protocol meaning. */
  readonly recipient: string;
}

/** Release-bound EVM actors. The transaction origin prices actor-sensitive
 * protocol calls; the executor is the program receiver/profit account. */
export interface FamilySearchExecutionContextV1 {
  readonly transactionOrigin: string;
  readonly executorAddress: string;
}

/** A resolved process-local handle binding is the only route-leg identity input. */
export type FamilySearchRouteLegBindingV1 = FamilyRouteHandleBindingV1;

export interface FamilySearchLegRequestV1 {
  readonly route: FamilySearchRouteLegBindingV1;
  readonly currentSource: FamilySearchCurrentSourceV1;
  readonly objective: FamilySearchObjectiveV1;
  readonly amount: FamilySearchAmountEnvelopeV1;
  readonly execution: FamilySearchExecutionContextV1;
}

export interface FamilySearchAssetAmountV1 {
  readonly assetRef: Hash;
  readonly amount: string;
}

export interface FamilySearchStateArtifactV1 {
  readonly kind: "state";
  readonly status: "verified";
  readonly source: FamilySearchSourceV1;
  readonly routeBindingHash: Hash;
  readonly payload: CanonicalJson;
  readonly payloadHash: Hash;
  readonly artifactHash: Hash;
  readonly factsRoot: Hash;
  readonly sourceRequestId: Hash;
}

export interface FamilySearchCoarseArtifactV1 {
  readonly kind: "coarse";
  readonly status: "rankable" | "unavailable";
  readonly source: FamilySearchSourceV1;
  readonly routeBindingHash: Hash;
  readonly objectiveRef: Hash;
  readonly amountHash: Hash;
  readonly payload: CanonicalJson;
  readonly payloadHash: Hash;
  readonly artifactHash: Hash;
  readonly projectionHash: Hash;
  readonly stateFactsRoot: Hash;
  readonly input: FamilySearchAssetAmountV1;
  readonly output: FamilySearchAssetAmountV1 | null;
  readonly conservativeOutputUpperBound: string | null;
  readonly inputCapacityUpperBound: string | null;
  readonly rankKey: Hash | null;
  readonly reasonCode: string | null;
}

export interface FamilySearchExactArtifactV1 {
  readonly kind: "exact";
  readonly status: "verified" | "unavailable";
  readonly source: FamilySearchSourceV1;
  readonly routeBindingHash: Hash;
  readonly objectiveRef: Hash;
  readonly amountHash: Hash;
  readonly payload: CanonicalJson;
  readonly payloadHash: Hash;
  readonly artifactHash: Hash;
  readonly evaluationHash: Hash;
  readonly stateFactsRoot: Hash;
  readonly inputs: readonly FamilySearchAssetAmountV1[];
  readonly outputs: readonly FamilySearchAssetAmountV1[];
  readonly obligationRoot: Hash;
  readonly reasonCode: string | null;
}

export interface FamilySearchActionArtifactV1 {
  readonly kind: "action";
  readonly status: "ready";
  readonly source: FamilySearchSourceV1;
  readonly routeBindingHash: Hash;
  readonly objectiveRef: Hash;
  readonly amountHash: Hash;
  readonly payload: CanonicalJson;
  readonly payloadHash: Hash;
  readonly artifactHash: Hash;
  readonly actionHash: Hash;
  readonly exactEvaluationHash: Hash;
  readonly actionOwnerId: string;
  /** Null when the deployment has not supplied the generated owner ref yet. */
  readonly actionOwnerRef: Hash | null;
  readonly opaqueBytes: string;
  /** Optional protocol-owned effect transport declaration; central code only binds it. */
  readonly effectTransport?: EffectTransportDeclarationV1;
  readonly inputs: readonly FamilySearchAssetAmountV1[];
  readonly outputs: readonly FamilySearchAssetAmountV1[];
  readonly obligationRoot: Hash;
}

export type FamilySearchArtifactV1 =
  | FamilySearchStateArtifactV1
  | FamilySearchCoarseArtifactV1
  | FamilySearchExactArtifactV1
  | FamilySearchActionArtifactV1;

export type FamilySearchStageOutcomeV1<Artifact> =
  | { readonly kind: "verified"; readonly artifact: Artifact }
  | { readonly kind: "unavailable"; readonly stage: "state" | "coarse" | "exact" | "action"; readonly reasonCode: string; readonly evidenceHash: Hash }
  | { readonly kind: "invalidProgram"; readonly stage: "state" | "coarse" | "exact" | "action"; readonly code: string };

export interface FamilySearchRunArtifactsV1 {
  readonly state: FamilySearchStateArtifactV1;
  readonly coarse: FamilySearchCoarseArtifactV1;
  readonly exact: FamilySearchExactArtifactV1;
  readonly action: FamilySearchActionArtifactV1;
}

export interface FamilySearchAdapterV1 {
  readonly readState: (input: FamilySearchStateRequestV1) => Promise<FamilySearchStageOutcomeV1<FamilySearchStateArtifactV1>>;
  readonly projectCoarse: (input: FamilySearchCoarseRequestV1) => FamilySearchStageOutcomeV1<FamilySearchCoarseArtifactV1>;
  readonly evaluateExact: (input: FamilySearchExactRequestV1) => FamilySearchStageOutcomeV1<FamilySearchExactArtifactV1>;
  readonly buildAction: (input: FamilySearchActionRequestV1) => FamilySearchStageOutcomeV1<FamilySearchActionArtifactV1>;
  readonly run: (input: FamilySearchRunRequestV1) => Promise<FamilySearchStageOutcomeV1<FamilySearchRunArtifactsV1>>;
}

export interface FamilySearchStateRequestV1 extends FamilySearchLegRequestV1 {
  readonly readPort: FamilySearchSourceReadPortV1;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
}

export interface FamilySearchCoarseRequestV1 extends FamilySearchLegRequestV1 {
  readonly state: FamilySearchStateArtifactV1;
}

export interface FamilySearchExactRequestV1 extends FamilySearchLegRequestV1 {
  readonly state: FamilySearchStateArtifactV1;
  readonly coarse: FamilySearchCoarseArtifactV1;
}

export interface FamilySearchActionRequestV1 extends FamilySearchLegRequestV1 {
  readonly exact: FamilySearchExactArtifactV1;
}

export interface FamilySearchRunRequestV1 extends FamilySearchLegRequestV1 {
  readonly readPort: FamilySearchSourceReadPortV1;
  readonly signal?: AbortSignal;
  readonly deadlineAtMs?: number;
}

export function familySearchSource(value: unknown, path = "source"): FamilySearchSourceV1 {
  assertExactKeys(value, ["chainId", "number", "hash", "stateRoot"], path);
  const record = value as Record<string, unknown>;
  return deepFreeze({
    chainId: assertNonEmptyString(record.chainId, `${path}.chainId`),
    number: assertDecimalString(record.number, `${path}.number`),
    hash: assertHash(record.hash, `${path}.hash`),
    stateRoot: assertHash(record.stateRoot, `${path}.stateRoot`),
  });
}

export function sameFamilySearchSource(left: FamilySearchSourceV1, right: FamilySearchSourceV1): boolean {
  return left.chainId === right.chainId
    && left.number === right.number
    && left.hash === right.hash
    && left.stateRoot === right.stateRoot;
}

function canonical(value: unknown, path: string): CanonicalJson {
  try {
    return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
  } catch (error) {
    throw new TypeError(`${path} is not canonical: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function familySearchObjective(value: FamilySearchObjectiveV1, path = "objective"): FamilySearchObjectiveV1 {
  if (value === null || typeof value !== "object") throw new TypeError(`${path} is required`);
  assertExactKeys(value, ["objectiveRef", "payload"], path);
  const payload = canonical(value.payload, `${path}.payload`);
  const objectiveRef = assertHash(value.objectiveRef, `${path}.objectiveRef`);
  if (objectiveRef !== hashDomain("aloha/search-objective/v1", payload)) throw new TypeError(`${path}.objectiveRef mismatch`);
  return deepFreeze({ objectiveRef, payload });
}

export function familySearchAmount(value: FamilySearchAmountEnvelopeV1, path = "amount"): FamilySearchAmountEnvelopeV1 {
  if (value === null || typeof value !== "object") throw new TypeError(`${path} is required`);
  assertExactKeys(value, ["inputAssetRef", "outputAssetRef", "amountIn", "recipient"], path);
  const result = {
    inputAssetRef: assertHash(value.inputAssetRef, `${path}.inputAssetRef`),
    outputAssetRef: assertHash(value.outputAssetRef, `${path}.outputAssetRef`),
    amountIn: assertDecimalString(value.amountIn, `${path}.amountIn`),
    recipient: assertNonEmptyString(value.recipient, `${path}.recipient`),
  } as FamilySearchAmountEnvelopeV1;
  if (result.inputAssetRef === result.outputAssetRef) throw new TypeError(`${path} assets must differ`);
  if (BigInt(result.amountIn) <= 0n) throw new TypeError(`${path}.amountIn must be positive`);
  return deepFreeze(result);
}

export function familySearchAmountHash(amount: FamilySearchAmountEnvelopeV1): Hash {
  return hashDomain("aloha/family-search-amount/v1", familySearchAmount(amount));
}

export function familySearchExecutionContext(
  value: FamilySearchExecutionContextV1,
  path = "execution",
): FamilySearchExecutionContextV1 {
  if (value === null || typeof value !== "object") throw new TypeError(`${path} is required`);
  assertExactKeys(value, ["transactionOrigin", "executorAddress"], path);
  return deepFreeze({
    transactionOrigin: assertNonEmptyString(value.transactionOrigin, `${path}.transactionOrigin`),
    executorAddress: assertNonEmptyString(value.executorAddress, `${path}.executorAddress`),
  });
}

export function familySearchExecutionContextHash(value: FamilySearchExecutionContextV1): Hash {
  return hashDomain("aloha/family-search-execution-context/v1", familySearchExecutionContext(value));
}

export function validateFamilySearchRouteLegBinding(value: unknown, path = "route"): FamilySearchRouteLegBindingV1 {
  assertExactKeys(value, [
    "familyId",
    "familyDefinitionHash",
    "instanceKey",
    "identityMemo",
    "identityMemoHash",
    "instancePublicationHash",
    "staticProjectionMemoHash",
    "requestedArtifactDependencyRoot",
    "staticProjectionHash",
    "projectionHash",
    "authoritySessionHash",
  ], path);
  const record = value as Record<string, unknown>;
  const binding = deepFreeze({
    familyId: assertNonEmptyString(record.familyId, `${path}.familyId`),
    familyDefinitionHash: assertHash(record.familyDefinitionHash, `${path}.familyDefinitionHash`),
    instanceKey: assertNonEmptyString(record.instanceKey, `${path}.instanceKey`),
    identityMemo: canonical(record.identityMemo, `${path}.identityMemo`),
    identityMemoHash: assertHash(record.identityMemoHash, `${path}.identityMemoHash`),
    instancePublicationHash: assertHash(record.instancePublicationHash, `${path}.instancePublicationHash`),
    staticProjectionMemoHash: assertHash(record.staticProjectionMemoHash, `${path}.staticProjectionMemoHash`),
    requestedArtifactDependencyRoot: assertHash(record.requestedArtifactDependencyRoot, `${path}.requestedArtifactDependencyRoot`),
    staticProjectionHash: assertHash(record.staticProjectionHash, `${path}.staticProjectionHash`),
    projectionHash: assertHash(record.projectionHash, `${path}.projectionHash`),
    authoritySessionHash: assertHash(record.authoritySessionHash, `${path}.authoritySessionHash`),
  }) as FamilySearchRouteLegBindingV1;
  if (binding.identityMemoHash !== hashDomain("aloha/identity-memo/v1", binding.identityMemo)) throw new TypeError(`${path}.identityMemoHash mismatch`);
  return binding;
}

export function familySearchRouteBindingHash(value: FamilySearchRouteLegBindingV1): Hash {
  const binding = validateFamilySearchRouteLegBinding(value);
  return hashDomain("aloha/family-search-route-leg-binding/v1", binding);
}

export function familySearchPayloadHash(kind: FamilySearchArtifactV1["kind"], payload: CanonicalJson): Hash {
  return hashDomain("aloha/family-search-payload/v1", { kind, payload: canonical(payload, "payload") });
}

export function familySearchArtifactHash(input: {
  readonly kind: FamilySearchArtifactV1["kind"];
  readonly source: FamilySearchSourceV1;
  readonly routeBindingHash: Hash;
  readonly objectiveRef: Hash | null;
  readonly amountHash: Hash | null;
  readonly payloadHash: Hash;
}): Hash {
  return hashDomain("aloha/family-search-artifact/v1", {
    kind: input.kind,
    source: familySearchSource(input.source),
    routeBindingHash: assertHash(input.routeBindingHash, "routeBindingHash"),
    objectiveRef: input.objectiveRef === null ? null : assertHash(input.objectiveRef, "objectiveRef"),
    amountHash: input.amountHash === null ? null : assertHash(input.amountHash, "amountHash"),
    payloadHash: assertHash(input.payloadHash, "payloadHash"),
  });
}

export function unavailableFamilySearchStage(
  stage: "state" | "coarse" | "exact" | "action",
  reasonCode: string,
  evidenceInput: unknown,
): FamilySearchStageOutcomeV1<never> {
  const code = assertNonEmptyString(reasonCode, `${stage}.reasonCode`);
  return Object.freeze({
    kind: "unavailable" as const,
    stage,
    reasonCode: code,
    evidenceHash: hashDomain("aloha/family-search-unavailable/v1", { stage, reasonCode: code, evidenceInput: canonical(evidenceInput, `${stage}.evidence`) }),
  });
}
