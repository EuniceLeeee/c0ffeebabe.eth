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
import { erc20AssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { familyCandidateKey as centralFamilyCandidateKey } from "../../../packages/discovery/src/index.ts";
import { decodePackedCallProgram, encodePackedCallProgram } from "../../../packages/execution-program/src/index.ts";
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
import { FLUID_DEX_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { FLUID_DEX_ACTION_PORT, buildFluidDexAction, buildFluidDexSearchAction } from "./action.ts";
import { assertFluidDexRoute, coarseFluidDex, deriveFluidDexRoutes, exactFluidDex, materializeFluidDex } from "./stages.ts";
import { FLUID_DEX_FAMILY_ID } from "./manifest.ts";
import { decodeConstantsView, decodeUint256, encodeConstantsView, encodeSwapInCall, type FluidDexConstantsV1 } from "./abi.ts";
import type { FluidDexIdentityV1, FluidDexMaterializedStateV1, FluidDexQuoteV1, FluidDexRouteV1, FluidDexStateReadFactsV1 } from "./types.ts";

type Source = ReturnType<typeof familySearchSource>;
type StatePayload = {
  readonly kind: "fluid-dex-state-read";
  readonly version: 1;
  readonly cutoff: Source;
  readonly routeBindingHash: Hash;
  readonly amountHash: Hash;
  readonly instanceKey: string;
  readonly constantsReturnDataHex: string;
  readonly quoteReturnDataHex: string;
  readonly read: FluidDexStateReadFactsV1;
  readonly requestIds: readonly Hash[];
};
type Context = FamilySearchLegRequestV1 & {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly source: Source;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly amountHash: Hash;
  readonly routeBindingHash: Hash;
  readonly identity: FluidDexIdentityV1;
  readonly protocolRoute: FluidDexRouteV1;
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  const result = record(value, path);
  assertExactKeys(result, keys, path);
  return result;
}
function text(value: unknown, path: string): string { return assertNonEmptyString(value, path); }
function address(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(result)) throw new TypeError(`${path} must be an address`);
  return result.toLowerCase();
}
function bytes(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new TypeError(`${path} must be even-length hex bytes`);
  return result.toLowerCase();
}
function decimal(value: unknown, path: string): string { return assertDecimalString(value, path); }
function hash(value: unknown, path: string): Hash { return assertHash(value, path); }
function canonical(value: unknown): CanonicalJson { return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value))); }
function assetRef(chainId: string, asset: string): Hash { return erc20AssetRefV1(chainId, asset); }

function decodeIdentity(value: unknown, path: string): FluidDexIdentityV1 {
  const source = exact(value, ["candidateSnapshotHash", "cutoff", "facts", "factsHash", "instanceKey"], path);
  const facts = exact(source.facts, ["inputAsset", "outputAsset", "target"], `${path}.facts`);
  const decodedFacts = Object.freeze({ target: address(facts.target, `${path}.facts.target`), inputAsset: address(facts.inputAsset, `${path}.facts.inputAsset`), outputAsset: address(facts.outputAsset, `${path}.facts.outputAsset`) });
  const identity = Object.freeze({ cutoff: familySearchSource(source.cutoff, `${path}.cutoff`), candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`), instanceKey: address(source.instanceKey, `${path}.instanceKey`), factsHash: hash(source.factsHash, `${path}.factsHash`), facts: decodedFacts }) as FluidDexIdentityV1;
  if (identity.instanceKey !== identity.facts.target || identity.facts.inputAsset === identity.facts.outputAsset) throw new TypeError("fluid-dex identity facts invalid");
  if (identity.factsHash !== hashDomain("aloha/fluid-dex/identity-facts/v1", identity.facts)) throw new TypeError("fluid-dex identity facts hash mismatch");
  return identity;
}

function decodeMemo(value: unknown, path = "route.identityMemo") {
  const source = exact(value, ["candidateEvidenceRoot", "candidateSnapshotHash", "familyCandidateKey", "familyDefinitionHash", "familyId", "identity", "instanceNominationKey", "kind", "version"], path);
  if (source.kind !== "fluid-dex-identity-memo" || source.version !== 1 || source.familyId !== FLUID_DEX_FAMILY_ID) throw new TypeError("fluid-dex identity memo discriminator mismatch");
  const familyDefinitionHash = hash(source.familyDefinitionHash, `${path}.familyDefinitionHash`);
  if (familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-dex identity memo definition mismatch");
  const instanceNominationKey = address(source.instanceNominationKey, `${path}.instanceNominationKey`);
  const memo = Object.freeze({ kind: "fluid-dex-identity-memo" as const, version: 1 as const, familyId: FLUID_DEX_FAMILY_ID, familyDefinitionHash, familyCandidateKey: hash(source.familyCandidateKey, `${path}.familyCandidateKey`), instanceNominationKey, candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`), candidateEvidenceRoot: hash(source.candidateEvidenceRoot, `${path}.candidateEvidenceRoot`), identity: decodeIdentity(source.identity, `${path}.identity`) });
  if (memo.familyCandidateKey !== centralFamilyCandidateKey(familyDefinitionHash, instanceNominationKey) || memo.instanceNominationKey !== memo.identity.instanceKey || memo.candidateSnapshotHash !== memo.identity.candidateSnapshotHash) throw new TypeError("fluid-dex identity memo lineage mismatch");
  return memo;
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== FLUID_DEX_FAMILY_ID || route.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-dex search route family mismatch");
  const memo = decodeMemo(route.identityMemo);
  if (hashDomain("aloha/identity-memo/v1", memo) !== route.identityMemoHash || route.instanceKey !== memo.identity.instanceKey) throw new TypeError("fluid-dex search identity memo binding mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const protocolRoute = deriveFluidDexRoutes(memo.identity).find(item => assetRef(source.chainId, item.inputAsset) === amount.inputAssetRef && assetRef(source.chainId, item.outputAsset) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("fluid-dex search amount assets do not match identity");
  assertFluidDexRoute(protocolRoute, memo.identity);
  if (!/^0x[0-9a-fA-F]{40}$/.test(amount.recipient)) throw new TypeError("fluid-dex amount recipient must be an address");
  return Object.freeze({ ...input, route, source, objective, amount, amountHash: familySearchAmountHash(amount), routeBindingHash: familySearchRouteBindingHash(route), identity: memo.identity, protocolRoute });
}

function invalid(stage: "state" | "coarse" | "exact" | "action", error: unknown) {
  return Object.freeze({ kind: "invalidProgram" as const, stage, code: error instanceof Error ? error.message : `${stage}-invalid` });
}
function unavailable(stage: "state" | "coarse" | "exact" | "action", reasonCode: string, evidence: unknown) {
  return unavailableFamilySearchStage(stage, `fluid-dex-${reasonCode}`, canonical(evidence));
}

function stateRequest(ctx: Context, kind: "constants" | "quote", swap0to1 = false) {
  const root = hashDomain("aloha/fluid-dex/search-state-request/v2", { familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH, routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, source: ctx.source });
  const requestId = hashDomain("aloha/fluid-dex/search-state-request-part/v1", { root, kind, swap0to1 });
  return Object.freeze({
    request: Object.freeze({
      kind: "family-search.current-source-read" as const,
      requestId,
      source: ctx.source,
      target: ctx.identity.instanceKey,
      data: kind === "constants" ? encodeConstantsView() : encodeSwapInCall(swap0to1, ctx.amount.amountIn, "0", ctx.amount.recipient),
      responseEncoding: kind === "constants" ? "abi-fluid-dex-constants-view" as const : "abi-fluid-dex-swap-in" as const,
    }),
    requestId,
    kind,
  });
}

function returned(result: FamilySearchSourceReadResultV1, requestId: Hash, source: Source, path: string): string {
  if (result.kind !== "returned") throw new Error(result.reasonCode || "source-read-unavailable");
  if (result.requestId !== requestId || !sameFamilySearchSource(result.source, source)) throw new TypeError("fluid-dex search source response binding mismatch");
  return bytes(result.dataHex, path);
}

function assertConstants(ctx: Context, constants: FluidDexConstantsV1): boolean {
  if (constants.token0 === constants.token1) throw new TypeError("fluid-dex constants token pair is not distinct");
  const expected = new Set([ctx.identity.facts.inputAsset, ctx.identity.facts.outputAsset]);
  if (new Set([constants.token0, constants.token1]).size !== expected.size || !expected.has(constants.token0) || !expected.has(constants.token1)) throw new TypeError("fluid-dex constants token pair does not match identity");
  return ctx.protocolRoute.inputAsset === constants.token0;
}

function decodeStatePayload(value: unknown, path = "fluid-dex.state.payload"): StatePayload {
  const source = exact(value, ["amountHash", "constantsReturnDataHex", "cutoff", "instanceKey", "kind", "quoteReturnDataHex", "read", "requestIds", "routeBindingHash", "version"], path);
  if (source.kind !== "fluid-dex-state-read" || source.version !== 1) throw new TypeError("fluid-dex state payload discriminator mismatch");
  const readSource = exact(source.read, ["cutoff", "instanceKey", "reserveIn", "reserveOut"], `${path}.read`);
  if (!Array.isArray(source.requestIds) || source.requestIds.length !== 2) throw new TypeError(`${path}.requestIds must contain two reads`);
  return Object.freeze({ kind: "fluid-dex-state-read", version: 1, cutoff: familySearchSource(source.cutoff, `${path}.cutoff`), routeBindingHash: hash(source.routeBindingHash, `${path}.routeBindingHash`), amountHash: hash(source.amountHash, `${path}.amountHash`), instanceKey: address(source.instanceKey, `${path}.instanceKey`), constantsReturnDataHex: bytes(source.constantsReturnDataHex, `${path}.constantsReturnDataHex`), quoteReturnDataHex: bytes(source.quoteReturnDataHex, `${path}.quoteReturnDataHex`), read: Object.freeze({ cutoff: familySearchSource(readSource.cutoff, `${path}.read.cutoff`) as FluidDexStateReadFactsV1["cutoff"], instanceKey: address(readSource.instanceKey, `${path}.read.instanceKey`), reserveIn: decimal(readSource.reserveIn, `${path}.read.reserveIn`), reserveOut: decimal(readSource.reserveOut, `${path}.read.reserveOut`) }), requestIds: Object.freeze(source.requestIds.map((item, index) => hash(item, `${path}.requestIds[${index}]`))) });
}

function materializedState(ctx: Context, artifact: FamilySearchStateArtifactV1): { readonly payload: StatePayload; readonly state: FluidDexMaterializedStateV1; readonly constants: FluidDexConstantsV1; readonly swap0to1: boolean } {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("fluid-dex search state artifact binding mismatch");
  const payload = decodeStatePayload(canonical(artifact.payload));
  const payloadHash = familySearchPayloadHash("state", canonical(payload));
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }) || payload.amountHash !== ctx.amountHash || payload.routeBindingHash !== ctx.routeBindingHash || payload.instanceKey !== ctx.identity.instanceKey || !sameFamilySearchSource(payload.cutoff, ctx.source) || !sameFamilySearchSource(payload.read.cutoff, ctx.source) || payload.read.instanceKey !== ctx.identity.instanceKey) throw new TypeError("fluid-dex search state artifact lineage mismatch");
  const constants = decodeConstantsView(payload.constantsReturnDataHex);
  const swap0to1 = assertConstants(ctx, constants);
  const observedAmountOut = decodeUint256(payload.quoteReturnDataHex, "fluid-dex search swapIn return data");
  if (payload.read.reserveIn !== ctx.amount.amountIn || payload.read.reserveOut !== observedAmountOut.toString(10) || artifact.factsRoot !== hashDomain("aloha/fluid-dex/state-facts/v1", payload.read)) throw new TypeError("fluid-dex search state facts mismatch");
  const materialized = materializeFluidDex({ identity: ctx.identity, read: payload.read });
  if (materialized.status !== "verified") throw new TypeError(`fluid-dex search state ${materialized.reasonCode}`);
  return Object.freeze({ payload, state: materialized.state, constants, swap0to1 });
}

function stateArtifact(ctx: Context, payload: StatePayload): FamilySearchStateArtifactV1 {
  const canonicalPayload = canonical(payload);
  const payloadHash = familySearchPayloadHash("state", canonicalPayload);
  return Object.freeze({ kind: "state", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload: canonicalPayload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: hashDomain("aloha/fluid-dex/state-facts/v1", payload.read), sourceRequestId: hashDomain("aloha/fluid-dex/search-state-reads/v1", payload.requestIds) });
}

function quoteFromState(ctx: Context, payload: StatePayload): FluidDexQuoteV1 {
  const result = coarseFluidDex({ identity: ctx.identity, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn, observedAmountOut: decodeUint256(payload.quoteReturnDataHex, "fluid-dex search swapIn return data").toString(10) });
  if (result.status !== "rankable") throw new TypeError(`fluid-dex quote ${result.reasonCode}`);
  return result.quote;
}

function coarseArtifact(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, state: FluidDexMaterializedStateV1, quote: FluidDexQuoteV1): FamilySearchCoarseArtifactV1 {
  const payload = canonical(quote);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  return Object.freeze({ kind: "coarse", status: "rankable", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), projectionHash: hashDomain("aloha/fluid-dex/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash }), stateFactsRoot: stateArtifactValue.factsRoot, input: { assetRef: ctx.amount.inputAssetRef, amount: quote.amountIn }, output: { assetRef: ctx.amount.outputAssetRef, amount: quote.observedAmountOut }, conservativeOutputUpperBound: quote.observedAmountOut, inputCapacityUpperBound: null, rankKey: hashDomain("aloha/fluid-dex/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash }), reasonCode: null });
}

function decodeQuote(value: unknown, path: string): FluidDexQuoteV1 {
  const source = exact(value, ["amountIn", "cutoff", "observedAmountOut", "quoteHash", "routeBindingHash"], path);
  const quote = Object.freeze({ cutoff: familySearchSource(source.cutoff, `${path}.cutoff`) as FluidDexQuoteV1["cutoff"], routeBindingHash: hash(source.routeBindingHash, `${path}.routeBindingHash`), amountIn: decimal(source.amountIn, `${path}.amountIn`), observedAmountOut: decimal(source.observedAmountOut, `${path}.observedAmountOut`), quoteHash: hash(source.quoteHash, `${path}.quoteHash`) });
  if (quote.quoteHash !== hashDomain("aloha/fluid-dex/quote/v1", { cutoff: quote.cutoff, routeBindingHash: quote.routeBindingHash, amountIn: quote.amountIn, observedAmountOut: quote.observedAmountOut })) throw new TypeError("fluid-dex search quote hash mismatch");
  return quote;
}

function validateCoarse(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, artifact: FamilySearchCoarseArtifactV1): FluidDexQuoteV1 {
  if (artifact.kind !== "coarse" || artifact.status !== "rankable" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== ctx.amountHash) throw new TypeError("fluid-dex search coarse artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }) || artifact.stateFactsRoot !== stateArtifactValue.factsRoot) throw new TypeError("fluid-dex search coarse artifact hash mismatch");
  const quote = decodeQuote(payload, "fluid-dex.search.coarse.payload");
  if (quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || quote.amountIn !== ctx.amount.amountIn || artifact.input.assetRef !== ctx.amount.inputAssetRef || artifact.input.amount !== quote.amountIn || artifact.output?.assetRef !== ctx.amount.outputAssetRef || artifact.output.amount !== quote.observedAmountOut || artifact.projectionHash !== hashDomain("aloha/fluid-dex/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: materializedState(ctx, stateArtifactValue).state.stateHash }) || artifact.rankKey !== hashDomain("aloha/fluid-dex/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash })) throw new TypeError("fluid-dex search coarse artifact lineage mismatch");
  return quote;
}

function actionFor(ctx: Context, quote: FluidDexQuoteV1, swap0to1: boolean) {
  return buildFluidDexAction({ identity: ctx.identity, quote, calldata: encodeSwapInCall(swap0to1, quote.amountIn, quote.observedAmountOut, ctx.amount.recipient) });
}

function exactArtifact(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, quote: FluidDexQuoteV1, swap0to1: boolean, token0: string, token1: string): FamilySearchExactArtifactV1 {
  const action = actionFor(ctx, quote, swap0to1);
  const payload = canonical({ quote, swap0to1, token0, token1 });
  const payloadHash = familySearchPayloadHash("exact", payload);
  const evaluationHash = hashDomain("aloha/fluid-dex/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateFactsRoot: stateArtifactValue.factsRoot, actionHash: action.actionHash });
  return Object.freeze({ kind: "exact", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), evaluationHash, stateFactsRoot: stateArtifactValue.factsRoot, inputs: [{ assetRef: ctx.amount.inputAssetRef, amount: quote.amountIn }], outputs: [{ assetRef: ctx.amount.outputAssetRef, amount: quote.observedAmountOut }], obligationRoot: hashDomain("aloha/fluid-dex/search-obligation/v1", { evaluationHash, quoteHash: quote.quoteHash }), reasonCode: null });
}

function decodeExactPayload(value: unknown, path: string): { readonly quote: FluidDexQuoteV1; readonly swap0to1: boolean; readonly token0: string; readonly token1: string } {
  const source = exact(value, ["quote", "swap0to1", "token0", "token1"], path);
  if (typeof source.swap0to1 !== "boolean") throw new TypeError(`${path}.swap0to1 must be boolean`);
  return Object.freeze({ quote: decodeQuote(source.quote, `${path}.quote`), swap0to1: source.swap0to1, token0: address(source.token0, `${path}.token0`), token1: address(source.token1, `${path}.token1`) });
}

function validateExact(ctx: Context, artifact: FamilySearchExactArtifactV1): { readonly quote: FluidDexQuoteV1; readonly swap0to1: boolean; readonly token0: string; readonly token1: string; readonly action: ReturnType<typeof buildFluidDexAction> } {
  if (artifact.kind !== "exact" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== ctx.amountHash) throw new TypeError("fluid-dex search exact artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("exact", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash })) throw new TypeError("fluid-dex search exact artifact hash mismatch");
  const decoded = decodeExactPayload(payload, "fluid-dex.search.exact.payload");
  const expectedAssets = new Set([ctx.identity.facts.inputAsset, ctx.identity.facts.outputAsset]);
  if (decoded.token0 === decoded.token1 || !expectedAssets.has(decoded.token0) || !expectedAssets.has(decoded.token1) || ctx.protocolRoute.inputAsset !== (decoded.swap0to1 ? decoded.token0 : decoded.token1) || ctx.protocolRoute.outputAsset !== (decoded.swap0to1 ? decoded.token1 : decoded.token0)) throw new TypeError("fluid-dex search exact token direction mismatch");
  const action = actionFor(ctx, decoded.quote, decoded.swap0to1);
  const evaluationHash = hashDomain("aloha/fluid-dex/search-exact-evaluation/v1", { quoteHash: decoded.quote.quoteHash, stateFactsRoot: artifact.stateFactsRoot, actionHash: action.actionHash });
  if (decoded.quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || decoded.quote.amountIn !== ctx.amount.amountIn || artifact.evaluationHash !== evaluationHash || artifact.inputs[0]?.assetRef !== ctx.amount.inputAssetRef || artifact.inputs[0]?.amount !== decoded.quote.amountIn || artifact.outputs[0]?.assetRef !== ctx.amount.outputAssetRef || artifact.outputs[0]?.amount !== decoded.quote.observedAmountOut || artifact.obligationRoot !== hashDomain("aloha/fluid-dex/search-obligation/v1", { evaluationHash, quoteHash: decoded.quote.quoteHash })) throw new TypeError("fluid-dex search exact artifact lineage mismatch");
  return Object.freeze({ ...decoded, action });
}

function actionArtifact(ctx: Context, exactArtifactValue: FamilySearchExactArtifactV1, decoded: { readonly quote: FluidDexQuoteV1; readonly swap0to1: boolean; readonly token0: string; readonly token1: string; readonly action: ReturnType<typeof buildFluidDexAction> }, actionOwnerRef: Hash): FamilySearchActionArtifactV1 {
  const action = buildFluidDexSearchAction({ rawAction: decoded.action, quote: decoded.quote, route: ctx.protocolRoute, token0: decoded.token0, token1: decoded.token1, swap0to1: decoded.swap0to1, recipient: ctx.amount.recipient, stateFactsRoot: exactArtifactValue.stateFactsRoot, inputs: exactArtifactValue.inputs, outputs: exactArtifactValue.outputs, exactEvaluationHash: exactArtifactValue.evaluationHash, obligationRoot: exactArtifactValue.obligationRoot });
  const payload = canonical(action);
  const payloadHash = familySearchPayloadHash("action", payload);
  const opaqueBytes = encodePackedCallProgram([{ target: decoded.action.target as `0x${string}`, value: "0", calldata: decoded.action.calldata as `0x${string}` }]);
  const calls = decodePackedCallProgram(opaqueBytes, "fluid-dex action program");
  if (calls.length !== 1 || calls[0]!.target !== decoded.action.target || calls[0]!.value !== "0" || calls[0]!.calldata !== decoded.action.calldata) throw new TypeError("fluid-dex action program binding mismatch");
  return Object.freeze({ kind: "action", status: "ready", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "action", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), actionHash: action.actionHash, exactEvaluationHash: exactArtifactValue.evaluationHash, actionOwnerId: FLUID_DEX_ACTION_PORT.actionOwnerId, actionOwnerRef, opaqueBytes, inputs: exactArtifactValue.inputs, outputs: exactArtifactValue.outputs, obligationRoot: exactArtifactValue.obligationRoot });
}

const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== FLUID_DEX_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-dex search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  const actionOwnerRef = assertHash(input.actionOwnerRefs.action, "fluid-dex action owner ref");
  input.composition.resolveActionOwner(input.familyDefinitionHash, input.actionOwnerRefs.action);

  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      await request.currentSource.assertCurrent();
      const constantsPhysical = stateRequest(ctx, "constants");
      let constantsResult: FamilySearchSourceReadResultV1;
      try {
        constantsResult = await request.readPort.read({ request: constantsPhysical.request, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) });
      } catch (error) {
        return unavailable("state", "constants-view-unavailable", { requestId: constantsPhysical.requestId, error: String(error) });
      }
      let constantsReturnDataHex: string;
      try {
        constantsReturnDataHex = returned(constantsResult, constantsPhysical.requestId, ctx.source, "fluid-dex.constantsView.returnDataHex");
      } catch (error) {
        return unavailable("state", "constants-view-unavailable", { requestId: constantsPhysical.requestId, error: String(error) });
      }
      let swap0to1: boolean;
      try {
        swap0to1 = assertConstants(ctx, decodeConstantsView(constantsReturnDataHex));
      } catch (error) {
        return invalid("state", error);
      }
      const quotePhysical = stateRequest(ctx, "quote", swap0to1);
      let quoteResult: FamilySearchSourceReadResultV1;
      try {
        quoteResult = await request.readPort.read({ request: quotePhysical.request, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) });
      } catch (error) {
        return unavailable("state", "swap-in-simulation-unavailable", { requestId: quotePhysical.requestId, error: String(error) });
      }
      let quoteReturnDataHex: string;
      try {
        quoteReturnDataHex = returned(quoteResult, quotePhysical.requestId, ctx.source, "fluid-dex.swapIn.returnDataHex");
      } catch (error) {
        return unavailable("state", "swap-in-simulation-unavailable", { requestId: quotePhysical.requestId, error: String(error) });
      }
      const observedAmountOut = decodeUint256(quoteReturnDataHex, "fluid-dex.swapIn.returnDataHex");
      if (observedAmountOut === 0n) return unavailable("state", "swap-in-zero-output", { requestId: quotePhysical.requestId });
      await request.currentSource.assertCurrent();
      const read: FluidDexStateReadFactsV1 = Object.freeze({ cutoff: ctx.source as FluidDexStateReadFactsV1["cutoff"], instanceKey: ctx.identity.instanceKey, reserveIn: ctx.amount.amountIn, reserveOut: observedAmountOut.toString(10) });
      const materialized = materializeFluidDex({ identity: ctx.identity, read });
      if (materialized.status !== "verified") return unavailable("state", `state-${materialized.reasonCode}`, { instanceKey: ctx.identity.instanceKey });
      const payload: StatePayload = Object.freeze({ kind: "fluid-dex-state-read", version: 1, cutoff: ctx.source, routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, instanceKey: ctx.identity.instanceKey, constantsReturnDataHex, quoteReturnDataHex, read, requestIds: Object.freeze([constantsPhysical.requestId, quotePhysical.requestId]) });
      return Object.freeze({ kind: "verified" as const, artifact: stateArtifact(ctx, payload) });
    } catch (error) {
      return invalid("state", error);
    }
  };

  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => {
    try {
      const ctx = context(request);
      const current = materializedState(ctx, request.state);
      return Object.freeze({ kind: "verified" as const, artifact: coarseArtifact(ctx, request.state, current.state, quoteFromState(ctx, current.payload)) });
    } catch (error) {
      return invalid("coarse", error);
    }
  };

  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => {
    try {
      const ctx = context(request);
      const current = materializedState(ctx, request.state);
      const coarse = validateCoarse(ctx, request.state, request.coarse);
      const currentQuote = quoteFromState(ctx, current.payload);
      const exactResult = exactFluidDex({ identity: ctx.identity, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn, observedAmountOut: currentQuote.observedAmountOut });
      if (exactResult.status !== "rankable") return unavailable("exact", exactResult.reasonCode, { stateHash: current.state.stateHash });
      if (coarse.quoteHash !== exactResult.quote.quoteHash) return unavailable("exact", "current-quote-coarse-mismatch", { coarseQuoteHash: coarse.quoteHash, currentQuoteHash: exactResult.quote.quoteHash });
      return Object.freeze({ kind: "verified" as const, artifact: exactArtifact(ctx, request.state, exactResult.quote, current.swap0to1, current.constants.token0, current.constants.token1) });
    } catch (error) {
      return invalid("exact", error);
    }
  };

  const buildAction: FamilySearchAdapterV1["buildAction"] = request => {
    try {
      const ctx = context(request);
      if (request.exact.kind !== "exact" || request.exact.status !== "verified") return unavailable("action", "exact-unavailable", request.exact);
      const decoded = validateExact(ctx, request.exact);
      return Object.freeze({ kind: "verified" as const, artifact: actionArtifact(ctx, request.exact, decoded, actionOwnerRef) });
    } catch (error) {
      return invalid("action", error);
    }
  };

  const run: FamilySearchAdapterV1["run"] = async (request: FamilySearchRunRequestV1) => {
    const state = await readState(request);
    if (state.kind !== "verified") return state;
    const coarse = projectCoarse({ ...request, state: state.artifact });
    if (coarse.kind !== "verified") return coarse;
    const exact = evaluateExact({ ...request, state: state.artifact, coarse: coarse.artifact });
    if (exact.kind !== "verified") return exact;
    const action = buildAction({ ...request, exact: exact.artifact });
    if (action.kind !== "verified") return action;
    return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ state: state.artifact, coarse: coarse.artifact, exact: exact.artifact, action: action.artifact }) });
  };

  return Object.freeze({ readState, projectCoarse, evaluateExact, buildAction, run });
};

export const FLUID_DEX_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
