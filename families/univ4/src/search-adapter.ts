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
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1, nativeAssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { encodePackedCallProgram } from "../../../packages/execution-program/src/index.ts";
import {
  familySearchAmount,
  familySearchAmountHash,
  familySearchArtifactHash,
  familySearchObjective,
  familySearchPayloadHash,
  familySearchRouteBindingHash,
  familySearchSource,
  sameFamilySearchSource,
  unavailableFamilySearchStage,
  validateFamilySearchRouteLegBinding,
  type FamilySearchActionArtifactV1,
  type FamilySearchAdapterFactoryV1,
  type FamilySearchAdapterV1,
  type FamilySearchCoarseArtifactV1,
  type FamilySearchExactArtifactV1,
  type FamilySearchLegRequestV1,
  type FamilySearchRunRequestV1,
  type FamilySearchSourceReadResultV1,
  type FamilySearchStateArtifactV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { UNIV4_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { UNIV4_ACTION_PORT, buildUniv4Action, buildUniv4SearchAction } from "./action.ts";
import { coarseUniv4, deriveUniv4Routes, assertUniv4Route } from "./stages.ts";
import { UNIV4_ACTION_OWNER_ID } from "./manifest.ts";
import { encodePoolIdCall, encodeQuoteCall, encodeSwapCall, decodeWords, assertPoolKey, poolIdForKey, UNIV4_GET_LIQUIDITY_SELECTOR, UNIV4_GET_SLOT0_SELECTOR, UNIV4_POOL_MANAGER, UNIV4_QUOTER, UNIV4_STATE_VIEW } from "./abi.ts";
import type { Univ4IdentityV1, Univ4PoolKey, Univ4QuoteV1, Univ4RouteV1 } from "./types.ts";

type Context = {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly source: ReturnType<typeof familySearchSource>;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly amountHash: Hash;
  readonly routeBindingHash: Hash;
  readonly identity: Univ4IdentityV1;
  readonly protocolRoute: Univ4RouteV1;
};

type StatePayload = {
  readonly kind: "univ4-state-read";
  readonly version: 1;
  readonly cutoff: ReturnType<typeof familySearchSource>;
  readonly routeBindingHash: Hash;
  readonly amountHash: Hash;
  readonly instanceKey: string;
  readonly poolId: Hash;
  readonly poolKey: Univ4PoolKey;
  readonly managerBinding: { readonly manager: string; readonly stateView: string; readonly quoter: string };
  readonly slot0ReturnDataHex: string;
  readonly liquidityReturnDataHex: string;
  readonly quoteReturnDataHex: string;
  readonly requestIds: readonly Hash[];
};

function record(value: unknown, path: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`); return value as Record<string, unknown>; }
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> { const result = record(value, path); assertExactKeys(result, keys, path); return result; }
function text(value: unknown, path: string): string { return assertNonEmptyString(value, path); }
function address(value: unknown, path: string): string { const result = text(value, path); if (!/^0x[0-9a-fA-F]{40}$/.test(result)) throw new TypeError(`${path} must be an address`); return result.toLowerCase(); }
function bytes(value: unknown, path: string): string { const result = text(value, path); if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new TypeError(`${path} must be even-length hex bytes`); return result.toLowerCase(); }
function decimal(value: unknown, path: string): string { return assertDecimalString(value, path); }
function hash(value: unknown, path: string): Hash { return assertHash(value, path); }
function canonical(value: unknown): CanonicalJson { return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value))); }
function assetRef(chainId: string, value: string): Hash { return value === "0x0000000000000000000000000000000000000000" ? nativeAssetRefV1(chainId) : erc20AssetRefV1(chainId, value); }

function decodeIdentity(value: unknown, path = "univ4.identityMemo.identity"): Univ4IdentityV1 {
  const source = exact(value, ["candidateSnapshotHash", "cutoff", "facts", "factsHash", "instanceKey"], path);
  const factsRecord = record(source.facts, `${path}.facts`);
  assertExactKeys(factsRecord, ["inputAsset", "managerBinding", "outputAsset", "poolId", "poolKey", "target"], `${path}.facts`);
  const bindingRecord = exact(factsRecord.managerBinding, ["manager", "quoter", "stateView"], `${path}.facts.managerBinding`);
  const managerBinding = Object.freeze({ manager: address(bindingRecord.manager, `${path}.facts.managerBinding.manager`), stateView: address(bindingRecord.stateView, `${path}.facts.managerBinding.stateView`), quoter: address(bindingRecord.quoter, `${path}.facts.managerBinding.quoter`) });
  const poolId = hash(factsRecord.poolId, `${path}.facts.poolId`);
  const poolKey = assertPoolKey(factsRecord.poolKey, `${path}.facts.poolKey`);
  const target = address(factsRecord.target, `${path}.facts.target`);
  const inputAsset = address(factsRecord.inputAsset, `${path}.facts.inputAsset`);
  const outputAsset = address(factsRecord.outputAsset, `${path}.facts.outputAsset`);
  if (
    poolIdForKey(poolKey) !== poolId
    || target !== UNIV4_POOL_MANAGER.toLowerCase()
    || managerBinding.manager !== target
    || managerBinding.stateView !== UNIV4_STATE_VIEW.toLowerCase()
    || managerBinding.quoter !== UNIV4_QUOTER.toLowerCase()
    || (inputAsset !== poolKey.currency0 && inputAsset !== poolKey.currency1)
    || (outputAsset !== poolKey.currency0 && outputAsset !== poolKey.currency1)
    || inputAsset === outputAsset
  ) throw new TypeError("univ4 strict PoolKey identity binding mismatch");
  const facts = Object.freeze({ target, inputAsset, outputAsset, poolId, poolKey, managerBinding });
  const identity = Object.freeze({ cutoff: familySearchSource(source.cutoff, `${path}.cutoff`), candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`), instanceKey: text(source.instanceKey, `${path}.instanceKey`), factsHash: hash(source.factsHash, `${path}.factsHash`), facts }) as Univ4IdentityV1;
  if (identity.instanceKey !== poolId) throw new TypeError("univ4 identity facts invalid");
  if (identity.factsHash !== hashDomain("aloha/univ4/identity-facts/v1", identity.facts)) throw new TypeError("univ4 identity facts hash mismatch");
  return identity;
}

function decodeMemo(value: unknown, path = "route.identityMemo") {
  const source = exact(value, ["candidateSnapshotHash", "familyCandidateKey", "familyDefinitionHash", "familyId", "identity", "instanceNominationKey", "kind"], path);
  if (source.kind !== "univ4-identity-memo" || source.familyId !== "univ4") throw new TypeError("univ4 identity memo discriminator mismatch");
  const familyDefinitionHash = hash(source.familyDefinitionHash, `${path}.familyDefinitionHash`);
  if (familyDefinitionHash !== UNIV4_FAMILY_DEFINITION_HASH) throw new TypeError("univ4 identity memo definition mismatch");
  const identity = decodeIdentity(source.identity, `${path}.identity`);
  const instanceNominationKey = text(source.instanceNominationKey, `${path}.instanceNominationKey`);
  const candidateSnapshotHash = hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`);
  const familyCandidateKey = hash(source.familyCandidateKey, `${path}.familyCandidateKey`);
  if (instanceNominationKey !== identity.instanceKey || candidateSnapshotHash !== identity.candidateSnapshotHash) throw new TypeError("univ4 identity memo lineage mismatch");
  return Object.freeze({ familyDefinitionHash, identity, instanceNominationKey, candidateSnapshotHash, familyCandidateKey });
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== "univ4" || route.familyDefinitionHash !== UNIV4_FAMILY_DEFINITION_HASH) throw new TypeError("univ4 search route family mismatch");
  const memo = decodeMemo(route.identityMemo);
  if (hashDomain("aloha/identity-memo/v1", route.identityMemo) !== route.identityMemoHash || route.instanceKey !== memo.identity.instanceKey) throw new TypeError("univ4 identity memo binding mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const protocolRoute = deriveUniv4Routes(memo.identity).find(item => assetRef(source.chainId, item.inputAsset) === amount.inputAssetRef && assetRef(source.chainId, item.outputAsset) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("univ4 search amount assets do not match identity");
  assertUniv4Route(protocolRoute, memo.identity);
  return Object.freeze({ route, source, objective, amount, amountHash: familySearchAmountHash(amount), routeBindingHash: familySearchRouteBindingHash(route), identity: memo.identity, protocolRoute });
}

function invalid(stage: "state" | "coarse" | "exact" | "action", error: unknown) { return Object.freeze({ kind: "invalidProgram" as const, stage, code: error instanceof Error ? error.message : `${stage}-invalid` }); }
function unavailable(stage: "state" | "coarse" | "exact" | "action", reasonCode: string, evidence: unknown) { return unavailableFamilySearchStage(stage, `univ4-${reasonCode}`, canonical(evidence)); }

function stateRequest(ctx: Context, kind: "slot0" | "liquidity" | "quote") {
  const binding = ctx.identity.facts.managerBinding;
  const poolKey = ctx.identity.facts.poolKey;
  const poolId = ctx.identity.facts.poolId;
  const root = hashDomain("aloha/univ4/search-state-request/v2", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, source: ctx.source });
  const requestId = hashDomain("aloha/univ4/search-state-request-part/v1", { root, kind });
  const target = kind === "slot0" || kind === "liquidity" ? binding.stateView : binding.quoter;
  const data = kind === "slot0" ? encodePoolIdCall(UNIV4_GET_SLOT0_SELECTOR, poolId) : kind === "liquidity" ? encodePoolIdCall(UNIV4_GET_LIQUIDITY_SELECTOR, poolId) : encodeQuoteCall(poolKey, ctx.protocolRoute.inputAsset === poolKey.currency0, ctx.amount.amountIn);
  return Object.freeze({ request: Object.freeze({ kind: "family-search.current-source-read" as const, requestId, source: ctx.source, target, data, responseEncoding: `abi-univ4-${kind}` as `abi-${string}` }), requestId, kind });
}

function readResult(result: FamilySearchSourceReadResultV1, expected: ReturnType<typeof stateRequest>, source: Context["source"]): string {
  if (result.kind !== "returned") throw new Error(result.reasonCode || "source-read-unavailable");
  if (result.requestId !== expected.requestId || !sameFamilySearchSource(result.source, source)) throw new TypeError("univ4 source response binding mismatch");
  return bytes(result.dataHex, "univ4 source return data");
}

function decodeStatePayload(value: unknown, path = "univ4.state.payload"): StatePayload {
  const source = exact(value, ["amountHash", "cutoff", "instanceKey", "kind", "liquidityReturnDataHex", "managerBinding", "poolId", "poolKey", "quoteReturnDataHex", "requestIds", "routeBindingHash", "slot0ReturnDataHex", "version"], path);
  if (source.kind !== "univ4-state-read" || source.version !== 1) throw new TypeError("univ4 state payload discriminator mismatch");
  const bindingRecord = exact(source.managerBinding, ["manager", "quoter", "stateView"], `${path}.managerBinding`);
  const managerBinding = Object.freeze({ manager: address(bindingRecord.manager, `${path}.managerBinding.manager`), stateView: address(bindingRecord.stateView, `${path}.managerBinding.stateView`), quoter: address(bindingRecord.quoter, `${path}.managerBinding.quoter`) });
  if (!Array.isArray(source.requestIds)) throw new TypeError(`${path}.requestIds must be an array`);
  const requestIds = source.requestIds.map((item, index) => hash(item, `${path}.requestIds[${index}]`));
  if (requestIds.length !== 3) throw new TypeError(`${path}.requestIds must contain three reads`);
  return Object.freeze({ kind: "univ4-state-read", version: 1, cutoff: familySearchSource(source.cutoff, `${path}.cutoff`), routeBindingHash: hash(source.routeBindingHash, `${path}.routeBindingHash`), amountHash: hash(source.amountHash, `${path}.amountHash`), instanceKey: text(source.instanceKey, `${path}.instanceKey`), poolId: hash(source.poolId, `${path}.poolId`), poolKey: assertPoolKey(source.poolKey, `${path}.poolKey`), managerBinding, slot0ReturnDataHex: bytes(source.slot0ReturnDataHex, `${path}.slot0ReturnDataHex`), liquidityReturnDataHex: bytes(source.liquidityReturnDataHex, `${path}.liquidityReturnDataHex`), quoteReturnDataHex: bytes(source.quoteReturnDataHex, `${path}.quoteReturnDataHex`), requestIds });
}

function stateFromArtifact(ctx: Context, artifact: FamilySearchStateArtifactV1): StatePayload {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("univ4 state artifact binding mismatch");
  const payload = decodeStatePayload(canonical(artifact.payload));
  const payloadHash = familySearchPayloadHash("state", canonical(payload));
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }) || payload.amountHash !== ctx.amountHash || payload.routeBindingHash !== ctx.routeBindingHash || payload.instanceKey !== ctx.identity.instanceKey || payload.poolId !== ctx.identity.facts.poolId || encodeCanonicalJson(payload.poolKey) !== encodeCanonicalJson(ctx.identity.facts.poolKey) || encodeCanonicalJson(payload.managerBinding) !== encodeCanonicalJson(ctx.identity.facts.managerBinding)) throw new TypeError("univ4 state artifact lineage mismatch");
  if (artifact.factsRoot !== hashDomain("aloha/univ4/state-facts/v2", payload)) throw new TypeError("univ4 state facts root mismatch");
  return payload;
}
function stateArtifact(ctx: Context, payload: StatePayload): FamilySearchStateArtifactV1 {
  const canonicalPayload = canonical(payload);
  const payloadHash = familySearchPayloadHash("state", canonicalPayload);
  return Object.freeze({ kind: "state", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload: canonicalPayload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: hashDomain("aloha/univ4/state-facts/v2", payload), sourceRequestId: payload.requestIds[0]! });
}

function quoteFromState(ctx: Context, state: StatePayload): Univ4QuoteV1 {
  const slot0 = decodeWords(state.slot0ReturnDataHex, 4, "univ4.slot0");
  const liquidity = decodeWords(state.liquidityReturnDataHex, 1, "univ4.liquidity");
  const quote = decodeWords(state.quoteReturnDataHex, 2, "univ4.quote");
  if (slot0[0] === 0n || liquidity[0] === 0n || quote[0] === 0n) throw new Error("pool-inactive-at-current-source");
  const result = coarseUniv4({ identity: ctx.identity, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn, observedAmountOut: quote[0]!.toString(10) });
  if (result.status !== "rankable") throw new Error(result.reasonCode);
  return result.quote;
}

function coarseArtifact(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, quote: Univ4QuoteV1): FamilySearchCoarseArtifactV1 {
  const payload = canonical(quote);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  return Object.freeze({ kind: "coarse", status: "rankable", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), projectionHash: hashDomain("aloha/univ4/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateFactsRoot: stateArtifactValue.factsRoot }), stateFactsRoot: stateArtifactValue.factsRoot, input: { assetRef: ctx.amount.inputAssetRef, amount: quote.amountIn }, output: { assetRef: ctx.amount.outputAssetRef, amount: quote.observedAmountOut }, conservativeOutputUpperBound: quote.observedAmountOut, inputCapacityUpperBound: null, rankKey: hashDomain("aloha/univ4/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash }), reasonCode: null });
}

function decodeQuote(value: unknown, path: string): Univ4QuoteV1 {
  const source = exact(value, ["amountIn", "cutoff", "observedAmountOut", "quoteHash", "routeBindingHash"], path);
  const quote = Object.freeze({ cutoff: familySearchSource(source.cutoff, `${path}.cutoff`) as Univ4QuoteV1["cutoff"], routeBindingHash: hash(source.routeBindingHash, `${path}.routeBindingHash`), amountIn: decimal(source.amountIn, `${path}.amountIn`), observedAmountOut: decimal(source.observedAmountOut, `${path}.observedAmountOut`), quoteHash: hash(source.quoteHash, `${path}.quoteHash`) });
  if (quote.quoteHash !== hashDomain("aloha/univ4/quote/v1", { cutoff: quote.cutoff, routeBindingHash: quote.routeBindingHash, amountIn: quote.amountIn, observedAmountOut: quote.observedAmountOut })) throw new TypeError("univ4 quote hash mismatch");
  return quote;
}
function validateCoarse(ctx: Context, artifact: FamilySearchCoarseArtifactV1, stateArtifactValue: FamilySearchStateArtifactV1): Univ4QuoteV1 {
  if (artifact.kind !== "coarse" || artifact.status !== "rankable" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== ctx.amountHash) throw new TypeError("univ4 coarse artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }) || artifact.stateFactsRoot !== stateArtifactValue.factsRoot) throw new TypeError("univ4 coarse artifact hash mismatch");
  const quote = decodeQuote(payload, "univ4.coarse.payload");
  if (quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || quote.amountIn !== ctx.amount.amountIn || artifact.input.assetRef !== ctx.amount.inputAssetRef || artifact.output?.assetRef !== ctx.amount.outputAssetRef || artifact.output.amount !== quote.observedAmountOut || artifact.projectionHash !== hashDomain("aloha/univ4/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateFactsRoot: stateArtifactValue.factsRoot })) throw new TypeError("univ4 coarse artifact lineage mismatch");
  return quote;
}
function exactArtifact(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, quote: Univ4QuoteV1): FamilySearchExactArtifactV1 {
  const payload = canonical({ quote });
  const payloadHash = familySearchPayloadHash("exact", payload);
  const evaluationHash = hashDomain("aloha/univ4/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateFactsRoot: stateArtifactValue.factsRoot });
  const obligationRoot = hashDomain("aloha/univ4/search-obligation/v1", { evaluationHash, quoteHash: quote.quoteHash });
  return Object.freeze({ kind: "exact", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), evaluationHash, stateFactsRoot: stateArtifactValue.factsRoot, inputs: [{ assetRef: ctx.amount.inputAssetRef, amount: quote.amountIn }], outputs: [{ assetRef: ctx.amount.outputAssetRef, amount: quote.observedAmountOut }], obligationRoot, reasonCode: null });
}
function validateExact(ctx: Context, artifact: FamilySearchExactArtifactV1): Univ4QuoteV1 {
  if (artifact.kind !== "exact" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== ctx.amountHash) throw new TypeError("univ4 exact artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("exact", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash })) throw new TypeError("univ4 exact artifact hash mismatch");
  const source = exact(payload, ["quote"], "univ4.exact.payload");
  const quote = decodeQuote(source.quote, "univ4.exact.quote");
  const evaluationHash = hashDomain("aloha/univ4/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateFactsRoot: artifact.stateFactsRoot });
  if (quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || quote.amountIn !== ctx.amount.amountIn || artifact.evaluationHash !== evaluationHash || artifact.inputs[0]?.assetRef !== ctx.amount.inputAssetRef || artifact.outputs[0]?.assetRef !== ctx.amount.outputAssetRef || artifact.obligationRoot !== hashDomain("aloha/univ4/search-obligation/v1", { evaluationHash, quoteHash: quote.quoteHash })) throw new TypeError("univ4 exact artifact lineage mismatch");
  return quote;
}
function actionArtifact(ctx: Context, exactArtifactValue: FamilySearchExactArtifactV1, quote: Univ4QuoteV1, ownerRef: Hash | null): FamilySearchActionArtifactV1 {
  const poolKey = ctx.identity.facts.poolKey;
  const rawAction = buildUniv4Action({ identity: ctx.identity, quote, calldata: encodeSwapCall(poolKey, ctx.protocolRoute.inputAsset === poolKey.currency0, quote.amountIn) });
  const action = buildUniv4SearchAction({ rawAction, quote, route: ctx.protocolRoute, poolKey, zeroForOne: ctx.protocolRoute.inputAsset === poolKey.currency0, stateFactsRoot: exactArtifactValue.stateFactsRoot, inputs: exactArtifactValue.inputs, outputs: exactArtifactValue.outputs, exactEvaluationHash: exactArtifactValue.evaluationHash, obligationRoot: exactArtifactValue.obligationRoot });
  const payload = canonical(action);
  const payloadHash = familySearchPayloadHash("action", payload);
  return Object.freeze({ kind: "action", status: "ready", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "action", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), actionHash: action.actionHash, exactEvaluationHash: exactArtifactValue.evaluationHash, actionOwnerId: UNIV4_ACTION_PORT.actionOwnerId, actionOwnerRef: ownerRef, opaqueBytes: encodePackedCallProgram([{ target: rawAction.target as `0x${string}`, value: "0", calldata: rawAction.calldata as `0x${string}` }]), inputs: exactArtifactValue.inputs, outputs: exactArtifactValue.outputs, obligationRoot: exactArtifactValue.obligationRoot });
}

const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== UNIV4_FAMILY_DEFINITION_HASH) throw new TypeError("univ4 search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  for (const ref of Object.values(input.actionOwnerRefs)) input.composition.resolveActionOwner(input.familyDefinitionHash, ref);
  const ownerRef = input.actionOwnerRefs.action === undefined ? null : hash(input.actionOwnerRefs.action, "univ4 action owner ref");
  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      await request.currentSource.assertCurrent();
      const requests = [stateRequest(ctx, "slot0"), stateRequest(ctx, "liquidity"), stateRequest(ctx, "quote")];
      const results = await Promise.all(requests.map(async physical => { try { return await request.readPort.read({ request: physical.request, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) }); } catch (error) { return Object.freeze({ kind: "unavailable" as const, requestId: physical.requestId, source: ctx.source, reasonCode: String(error) }); } }));
      const data = results.map((result, index) => readResult(result, requests[index]!, ctx.source));
      decodeWords(data[0]!, 4, "univ4.slot0"); decodeWords(data[1]!, 1, "univ4.liquidity"); decodeWords(data[2]!, 2, "univ4.quote");
      const payload = Object.freeze({ kind: "univ4-state-read" as const, version: 1 as const, cutoff: ctx.source, routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, instanceKey: ctx.identity.instanceKey, poolId: ctx.identity.facts.poolId, poolKey: ctx.identity.facts.poolKey, managerBinding: ctx.identity.facts.managerBinding, slot0ReturnDataHex: data[0]!, liquidityReturnDataHex: data[1]!, quoteReturnDataHex: data[2]!, requestIds: Object.freeze(requests.map(item => item.requestId)) });
      const state = stateArtifact(ctx, payload);
      const slot0 = decodeWords(data[0]!, 4, "univ4.slot0"); const liquidity = decodeWords(data[1]!, 1, "univ4.liquidity"); const quote = decodeWords(data[2]!, 2, "univ4.quote");
      if (slot0[0] === 0n || liquidity[0] === 0n || quote[0] === 0n) return unavailable("state", "pool-inactive-at-current-source", { factsRoot: state.factsRoot, sqrtPriceX96: slot0[0]!.toString(), liquidity: liquidity[0]!.toString(), amountOut: quote[0]!.toString() });
      return Object.freeze({ kind: "verified" as const, artifact: state });
    } catch (error) { return invalid("state", error); }
  };
  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => { try { const ctx = context(request); const state = stateFromArtifact(ctx, request.state); return Object.freeze({ kind: "verified" as const, artifact: coarseArtifact(ctx, request.state, quoteFromState(ctx, state)) }); } catch (error) { return invalid("coarse", error); } };
  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => { try { const ctx = context(request); const state = stateFromArtifact(ctx, request.state); const quote = validateCoarse(ctx, request.coarse, request.state); const current = quoteFromState(ctx, state); if (current.quoteHash !== quote.quoteHash) return unavailable("exact", "current-quote-coarse-mismatch", { coarseQuoteHash: quote.quoteHash, currentQuoteHash: current.quoteHash }); return Object.freeze({ kind: "verified" as const, artifact: exactArtifact(ctx, request.state, quote) }); } catch (error) { return invalid("exact", error); } };
  const buildAction: FamilySearchAdapterV1["buildAction"] = request => { try { const ctx = context(request); if (request.exact.kind !== "exact" || request.exact.status !== "verified") return unavailable("action", "exact-unavailable", request.exact); return Object.freeze({ kind: "verified" as const, artifact: actionArtifact(ctx, request.exact, validateExact(ctx, request.exact), ownerRef) }); } catch (error) { return invalid("action", error); } };
  const run: FamilySearchAdapterV1["run"] = async request => { const state = await readState(request); if (state.kind !== "verified") return state; const coarse = projectCoarse({ ...request, state: state.artifact }); if (coarse.kind !== "verified") return coarse; const exact = evaluateExact({ ...request, state: state.artifact, coarse: coarse.artifact }); if (exact.kind !== "verified") return exact; const action = buildAction({ ...request, exact: exact.artifact }); if (action.kind !== "verified") return action; return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ state: state.artifact, coarse: coarse.artifact, exact: exact.artifact, action: action.artifact }) }); };
  return Object.freeze({ readState, projectCoarse, evaluateExact, buildAction, run });
};

export const UNIV4_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
