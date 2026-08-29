import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
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
  type FamilySearchAdapterFactoryV1,
  type FamilySearchAdapterV1,
  type FamilySearchCoarseArtifactV1,
  type FamilySearchExactArtifactV1,
  type FamilySearchLegRequestV1,
  type FamilySearchRunRequestV1,
  type FamilySearchSourceReadResultV1,
  type FamilySearchStateArtifactV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { GOLDX_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { exactGoldx } from "./exact.ts";
import { materializeGoldx } from "./instance.ts";
import { GOLDX_FAMILY_ID } from "./manifest.ts";
import { coarseGoldx } from "./pricing.ts";
import { assertGoldxRoute, deriveGoldxRoutes } from "./routes.ts";
import {
  canonicalAddress,
  type GoldxIdentityV1,
  type GoldxMaterializedStateV1,
  type GoldxQuoteV1,
  type GoldxRouteV1,
} from "./types.ts";

type Source = ReturnType<typeof familySearchSource>;
type Context = {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly routeBindingHash: Hash;
  readonly source: Source;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly amountHash: Hash;
  readonly identity: GoldxIdentityV1;
  readonly protocolRoute: GoldxRouteV1;
};
type StateResponse = {
  readonly kind: "goldx-state-read-response";
  readonly requestId: Hash;
  readonly source: Source;
  readonly routeBindingHash: Hash;
  readonly amountHash: Hash;
  readonly instanceKey: string;
  readonly unitWad: string;
  readonly stateHash: Hash;
};

function canonical(value: unknown): CanonicalJson {
  return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${path} must be a non-empty string`);
  return value;
}

function bytes(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new TypeError(`${path} must be even-length hex bytes`);
  return result.toLowerCase();
}

function sameSource(left: Source, right: Source): boolean { return sameFamilySearchSource(left, right); }
function assetRef(chainId: string, value: string): Hash { return erc20AssetRefV1(chainId, value); }
function invalid(stage: "state" | "coarse" | "exact" | "action", error: unknown) { return Object.freeze({ kind: "invalidProgram" as const, stage, code: error instanceof Error ? error.message : `${stage}-invalid` }); }
function unavailable(stage: "state" | "coarse" | "exact" | "action", reasonCode: string, evidence: unknown) { return unavailableFamilySearchStage(stage, reasonCode, canonical(evidence)); }

function decodeUint256(value: string, path: string): string { const hex = bytes(value, path); if (hex.length !== 66) throw new TypeError(`${path} must be one ABI uint256 word`); return BigInt(`0x${hex.slice(2)}`).toString(); }

function decodeIdentityMemo(value: unknown): GoldxIdentityV1 {
  const outer = record(value, "goldx.route.identityMemo");
  const candidate = "identity" in outer ? (() => {
    assertExactKeys(outer, ["kind", "familyId", "familyDefinitionHash", "familyCandidateKey", "instanceNominationKey", "candidateSnapshotHash", "identity"], "goldx.identityMemo");
    if (outer.familyId !== GOLDX_FAMILY_ID || outer.familyDefinitionHash !== GOLDX_FAMILY_AUTHORING_HASH) throw new TypeError("goldx identity memo family mismatch");
    return outer.identity;
  })() : value;
  const identity = record(candidate, "goldx.identity");
  assertExactKeys(identity, ["cutoff", "candidateSnapshotHash", "instanceKey", "factsHash", "facts"], "goldx.identity");
  const facts = record(identity.facts, "goldx.identity.facts");
  assertExactKeys(facts, ["target", "inputAsset", "outputAsset"], "goldx.identity.facts");
  const decoded = Object.freeze({
    cutoff: familySearchSource(identity.cutoff, "goldx.identity.cutoff") as GoldxIdentityV1["cutoff"],
    candidateSnapshotHash: assertHash(identity.candidateSnapshotHash, "goldx.identity.candidateSnapshotHash"),
    instanceKey: canonicalAddress(text(identity.instanceKey, "goldx.identity.instanceKey")),
    factsHash: assertHash(identity.factsHash, "goldx.identity.factsHash"),
    facts: Object.freeze({
      target: canonicalAddress(text(facts.target, "goldx.identity.facts.target")),
      inputAsset: canonicalAddress(text(facts.inputAsset, "goldx.identity.facts.inputAsset")),
      outputAsset: canonicalAddress(text(facts.outputAsset, "goldx.identity.facts.outputAsset")),
    }),
  });
  if (decoded.instanceKey !== decoded.facts.target || decoded.factsHash !== hashDomain("aloha/goldx/identity-facts/v1", decoded.facts)) throw new TypeError("goldx identity facts hash mismatch");
  return decoded;
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== GOLDX_FAMILY_ID || route.familyDefinitionHash !== GOLDX_FAMILY_AUTHORING_HASH) throw new TypeError("goldx search route family mismatch");
  if (route.identityMemoHash !== hashDomain("aloha/identity-memo/v1", route.identityMemo)) throw new TypeError("goldx identity memo binding mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const identity = decodeIdentityMemo(route.identityMemo);
  if (route.instanceKey !== identity.instanceKey) throw new TypeError("goldx search instance binding mismatch");
  const protocolRoute = deriveGoldxRoutes(identity).find(item => assetRef(source.chainId, item.inputAsset) === amount.inputAssetRef && assetRef(source.chainId, item.outputAsset) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("goldx search amount assets do not match identity");
  assertGoldxRoute(protocolRoute, identity);
  const amountHash = familySearchAmountHash(amount);
  return Object.freeze({ route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, amountHash, identity, protocolRoute });
}

function requestId(ctx: Context): Hash {
  return hashDomain("aloha/goldx/search-state-request/v3", { familyDefinitionHash: GOLDX_FAMILY_AUTHORING_HASH, routeBindingHash: ctx.routeBindingHash, instanceKey: ctx.identity.instanceKey, amountHash: ctx.amountHash, source: ctx.source });
}

function stateReadRequest(ctx: Context) {
  const id = requestId(ctx);
  return Object.freeze({
    kind: "family-search.current-source-read" as const,
    requestId: id,
    source: ctx.source,
    target: ctx.identity.instanceKey,
    data: "0x907af6c0",
    responseEncoding: "abi-uint256",
  });
}

function stateResponse(expected: Context, id: Hash, returnDataHex: string): StateResponse {
  const unitWad = decodeUint256(returnDataHex, "goldx.state.returnDataHex");
  return Object.freeze({ kind: "goldx-state-read-response", requestId: id, source: expected.source, routeBindingHash: expected.routeBindingHash, amountHash: expected.amountHash, instanceKey: expected.identity.instanceKey, unitWad, stateHash: hashDomain("aloha/goldx/search-state/v4", { cutoff: expected.source, routeBindingHash: expected.routeBindingHash, amountHash: expected.amountHash, instanceKey: expected.identity.instanceKey, unitWad }) });
}

function decodeStateResponse(value: CanonicalJson, expected: Context, id: Hash): StateResponse {
  const source = record(value, "goldx.stateResponse");
  assertExactKeys(source, ["kind", "requestId", "source", "routeBindingHash", "amountHash", "instanceKey", "unitWad", "stateHash"], "goldx.stateResponse");
  if (source.kind !== "goldx-state-read-response" || assertHash(source.requestId, "goldx.stateResponse.requestId") !== id) throw new TypeError("goldx state response request mismatch");
  const responseSource = familySearchSource(source.source, "goldx.stateResponse.source");
  const routeBindingHash = assertHash(source.routeBindingHash, "goldx.stateResponse.routeBindingHash");
  const amountHash = assertHash(source.amountHash, "goldx.stateResponse.amountHash");
  if (!sameSource(responseSource, expected.source) || routeBindingHash !== expected.routeBindingHash || amountHash !== expected.amountHash || canonicalAddress(text(source.instanceKey, "goldx.stateResponse.instanceKey")) !== expected.identity.instanceKey) throw new TypeError("goldx state response lineage mismatch");
  const unitWad = assertDecimalString(source.unitWad, "goldx.stateResponse.unitWad");
  const stateHash = assertHash(source.stateHash, "goldx.stateResponse.stateHash");
  if (stateHash !== hashDomain("aloha/goldx/search-state/v4", { cutoff: responseSource, routeBindingHash, amountHash, instanceKey: expected.identity.instanceKey, unitWad })) throw new TypeError("goldx state hash mismatch");
  return Object.freeze({ kind: "goldx-state-read-response", requestId: id, source: responseSource, routeBindingHash, amountHash, instanceKey: expected.identity.instanceKey, unitWad, stateHash });
}

function materialized(ctx: Context, response: StateResponse): GoldxMaterializedStateV1 {
  const result = materializeGoldx({ identity: ctx.identity, read: { cutoff: response.source as GoldxIdentityV1["cutoff"], instanceKey: response.instanceKey, unitWad: response.unitWad } });
  if (result.status !== "verified") throw new TypeError(`goldx state ${result.reasonCode}`);
  return result.state;
}

function stateArtifact(ctx: Context, response: StateResponse): FamilySearchStateArtifactV1 {
  const state = materialized(ctx, response); const payload = canonical(response); const payloadHash = familySearchPayloadHash("state", payload);
  return Object.freeze({ kind: "state", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: state.stateHash, sourceRequestId: response.requestId });
}

function assertState(ctx: Context, artifact: FamilySearchStateArtifactV1): { readonly response: StateResponse; readonly state: GoldxMaterializedStateV1 } {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("goldx state artifact binding mismatch");
  const payload = canonical(artifact.payload); const payloadHash = familySearchPayloadHash("state", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("goldx state artifact hash mismatch");
  const response = decodeStateResponse(payload, ctx, artifact.sourceRequestId); const state = materialized(ctx, response);
  if (artifact.factsRoot !== state.stateHash) throw new TypeError("goldx state facts root mismatch");
  return { response, state };
}

function getQuote(ctx: Context, state: GoldxMaterializedStateV1): GoldxQuoteV1 {
  const result = coarseGoldx({ identity: ctx.identity, state, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn });
  if (result.status !== "rankable") throw new TypeError(`goldx quote ${result.reasonCode}`);
  return result.quote;
}

function quotePayload(quote: GoldxQuoteV1): Record<string, unknown> {
  return { cutoff: quote.cutoff, routeBindingHash: quote.routeBindingHash, amountIn: quote.amountIn, amountOut: quote.amountOut, unitWad: quote.unitWad };
}

function decodeQuote(value: unknown, path: string): GoldxQuoteV1 {
  const source = record(value, path); assertExactKeys(source, ["cutoff", "routeBindingHash", "amountIn", "amountOut", "unitWad", "quoteHash"], path);
  const payload = { cutoff: familySearchSource(source.cutoff, `${path}.cutoff`) as GoldxQuoteV1["cutoff"], routeBindingHash: assertHash(source.routeBindingHash, `${path}.routeBindingHash`), amountIn: assertDecimalString(source.amountIn, `${path}.amountIn`), amountOut: assertDecimalString(source.amountOut, `${path}.amountOut`), unitWad: assertDecimalString(source.unitWad, `${path}.unitWad`) };
  const quote = Object.freeze({ ...payload, quoteHash: assertHash(source.quoteHash, `${path}.quoteHash`) });
  if (quote.quoteHash !== hashDomain("aloha/goldx/quote/v1", payload)) throw new TypeError(`${path}.quoteHash mismatch`);
  return quote;
}

function assertQuoteContext(ctx: Context, quote: GoldxQuoteV1, state?: GoldxMaterializedStateV1): void {
  if (!sameSource(quote.cutoff, ctx.source)
    || quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash
    || quote.amountIn !== ctx.amount.amountIn
    || (state !== undefined && quote.unitWad !== state.unitWad)) {
    throw new TypeError("goldx quote lineage mismatch");
  }
}

function assertCoarse(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, state: GoldxMaterializedStateV1, artifact: FamilySearchCoarseArtifactV1): GoldxQuoteV1 {
  if (artifact.kind !== "coarse" || artifact.status !== "rankable"
    || !sameSource(artifact.source, ctx.source)
    || artifact.routeBindingHash !== ctx.routeBindingHash
    || artifact.objectiveRef !== ctx.objective.objectiveRef
    || artifact.amountHash !== ctx.amountHash
    || artifact.stateFactsRoot !== stateArtifactValue.factsRoot) throw new TypeError("goldx coarse artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash })) throw new TypeError("goldx coarse artifact hash mismatch");
  const quote = decodeQuote(payload, "goldx.coarse.payload");
  assertQuoteContext(ctx, quote, state);
  if (artifact.input.assetRef !== ctx.amount.inputAssetRef || artifact.input.amount !== ctx.amount.amountIn
    || artifact.output?.assetRef !== ctx.amount.outputAssetRef || artifact.output?.amount !== quote.amountOut
    || artifact.conservativeOutputUpperBound !== quote.amountOut
    || artifact.projectionHash !== hashDomain("aloha/goldx/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash })) throw new TypeError("goldx coarse artifact lineage mismatch");
  return quote;
}

function coarseArtifact(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, state: GoldxMaterializedStateV1, quote: GoldxQuoteV1): FamilySearchCoarseArtifactV1 {
  const payload = canonical(quote); const payloadHash = familySearchPayloadHash("coarse", payload);
  return Object.freeze({ kind: "coarse", status: "rankable", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), projectionHash: hashDomain("aloha/goldx/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash }), stateFactsRoot: stateArtifactValue.factsRoot, input: { assetRef: ctx.amount.inputAssetRef, amount: ctx.amount.amountIn }, output: { assetRef: ctx.amount.outputAssetRef, amount: quote.amountOut }, conservativeOutputUpperBound: quote.amountOut, inputCapacityUpperBound: null, rankKey: hashDomain("aloha/goldx/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash }), reasonCode: null });
}

function exactArtifact(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, state: GoldxMaterializedStateV1, quote: GoldxQuoteV1): FamilySearchExactArtifactV1 {
  const payload = canonical({ quote }); const payloadHash = familySearchPayloadHash("exact", payload); const evaluationHash = hashDomain("aloha/goldx/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash });
  return Object.freeze({ kind: "exact", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), evaluationHash, stateFactsRoot: stateArtifactValue.factsRoot, inputs: [{ assetRef: ctx.amount.inputAssetRef, amount: quote.amountIn }], outputs: [{ assetRef: ctx.amount.outputAssetRef, amount: quote.amountOut }], obligationRoot: hashDomain("aloha/goldx/search-obligation/v1", { evaluationHash, routeBindingHash: ctx.routeBindingHash }), reasonCode: null });
}

function exactParts(ctx: Context, artifact: FamilySearchExactArtifactV1): { readonly quote: GoldxQuoteV1 } {
  if (artifact.kind !== "exact" || artifact.status !== "verified" || !sameSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== ctx.amountHash) throw new TypeError("goldx exact artifact binding mismatch");
  const payload = canonical(artifact.payload); const payloadHash = familySearchPayloadHash("exact", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash })) throw new TypeError("goldx exact artifact hash mismatch");
  const source = record(payload, "goldx.exact.payload"); assertExactKeys(source, ["quote"], "goldx.exact.payload"); const quote = decodeQuote(source.quote, "goldx.exact.quote");
  assertQuoteContext(ctx, quote);
  if (artifact.inputs.length !== 1 || artifact.outputs.length !== 1 || artifact.inputs[0]?.assetRef !== ctx.amount.inputAssetRef || artifact.inputs[0]?.amount !== ctx.amount.amountIn || artifact.outputs[0]?.assetRef !== ctx.amount.outputAssetRef || artifact.outputs[0]?.amount !== quote.amountOut || artifact.evaluationHash !== hashDomain("aloha/goldx/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateHash: artifact.stateFactsRoot })) throw new TypeError("goldx exact artifact lineage mismatch");
  return { quote };
}

const factory: FamilySearchAdapterFactoryV1 = input => {
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  for (const ref of Object.values(input.actionOwnerRefs)) input.composition.resolveActionOwner(input.familyDefinitionHash, ref);
  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request); await request.currentSource.assertCurrent(); const physical = stateReadRequest(ctx); let raw: FamilySearchSourceReadResultV1;
      try { raw = await request.readPort.read({ request: physical, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) }); } catch (error) { return unavailable("state", "source-transport-error", { requestId: physical.requestId, source: physical.source, error: String(error) }); }
      if (raw.kind !== "returned") return unavailable("state", raw.reasonCode || "source-read-unavailable", raw);
      if (raw.requestId !== physical.requestId || !sameSource(raw.source, physical.source)) throw new TypeError("goldx source response binding mismatch");
      const response = stateResponse(ctx, physical.requestId, raw.dataHex);
      return Object.freeze({ kind: "verified" as const, artifact: stateArtifact(ctx, response) });
    } catch (error) { return invalid("state", error); }
  };
  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => { try { const ctx = context(request); const materializedState = assertState(ctx, request.state); return Object.freeze({ kind: "verified" as const, artifact: coarseArtifact(ctx, request.state, materializedState.state, getQuote(ctx, materializedState.state)) }); } catch (error) { return invalid("coarse", error); } };
  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => { try { const ctx = context(request); const materializedState = assertState(ctx, request.state); const coarseValue = assertCoarse(ctx, request.state, materializedState.state, request.coarse); const exactValue = exactGoldx({ identity: ctx.identity, state: materializedState.state, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn }); if (exactValue.status !== "rankable") return unavailable("exact", exactValue.reasonCode, exactValue); if (exactValue.quote.quoteHash !== coarseValue.quoteHash) throw new TypeError("goldx exact/coarse quote mismatch"); return Object.freeze({ kind: "verified" as const, artifact: exactArtifact(ctx, request.state, materializedState.state, exactValue.quote) }); } catch (error) { return invalid("exact", error); } };
  const buildAction: FamilySearchAdapterV1["buildAction"] = request => { try { const ctx = context(request); return unavailable("action", "qualified-effect-observation-or-simulation-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, required: "qualified-effect-observation-or-simulation" }); } catch (error) { return invalid("action", error); } };
  const run: FamilySearchAdapterV1["run"] = async request => { const state = await readState(request); if (state.kind !== "verified") return state; const coarse = projectCoarse({ ...request, state: state.artifact }); if (coarse.kind !== "verified") return coarse; const exact = evaluateExact({ ...request, state: state.artifact, coarse: coarse.artifact }); if (exact.kind !== "verified") return exact; const action = buildAction({ ...request, exact: exact.artifact }); if (action.kind !== "verified") return action; return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ state: state.artifact, coarse: coarse.artifact, exact: exact.artifact, action: action.artifact }) }); };
  return Object.freeze({ readState, projectCoarse, evaluateExact, buildAction, run });
};

export const GOLDX_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
