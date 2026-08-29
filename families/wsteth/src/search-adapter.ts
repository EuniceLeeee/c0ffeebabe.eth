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
import { familyCandidateKey as discoveryFamilyCandidateKey } from "../../../packages/discovery/src/index.ts";
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
import { WSTETH_FAMILY_DEFINITION_HASH, WSTETH_FAMILY_ID } from "./manifest.ts";
import { exactWsteth } from "./exact.ts";
import { materializeWsteth } from "./instance.ts";
import { coarseWsteth } from "./pricing.ts";
import { assertWstethRoute, deriveWstethRoutes } from "./routes.ts";
import {
  canonicalAddress,
  type WstethIdentityV1,
  type WstethMaterializedStateV1,
  type WstethQuoteV1,
  type WstethRouteV1,
} from "./types.ts";

type Source = ReturnType<typeof familySearchSource>;
type Context = {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly routeBindingHash: Hash;
  readonly source: Source;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly amountHash: Hash;
  readonly identity: WstethIdentityV1;
  readonly protocolRoute: WstethRouteV1;
};
type StateResponse = {
  readonly kind: "wsteth-state-read-response";
  readonly requestId: Hash;
  readonly source: Source;
  readonly routeBindingHash: Hash;
  readonly amountHash: Hash;
  readonly instanceKey: string;
  readonly quoteReturnDataHex: string;
  readonly stateHash: Hash;
};

function canonical(value: unknown): CanonicalJson { return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value))); }
function record(value: unknown, path: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`); return value as Record<string, unknown>; }
function text(value: unknown, path: string): string { return assertNonEmptyString(value, path); }
function bytes(value: unknown, path: string): string { const result = text(value, path); if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new TypeError(`${path} must be even-length hex bytes`); return result.toLowerCase(); }
function abiUint256(value: string, path: string): string { const hex = bytes(value, path); if (hex.length !== 66) throw new TypeError(`${path} must be one ABI uint256 word`); return hex; }
function sameSource(left: Source, right: Source): boolean { return sameFamilySearchSource(left, right); }
function assetRef(chainId: string, value: string): Hash { return erc20AssetRefV1(chainId, value); }
function invalid(stage: "state" | "coarse" | "exact" | "action", error: unknown) { return Object.freeze({ kind: "invalidProgram" as const, stage, code: error instanceof Error ? error.message : `${stage}-invalid` }); }
function unavailable(stage: "state" | "coarse" | "exact" | "action", reasonCode: string, evidence: unknown) { return unavailableFamilySearchStage(stage, `wsteth-${reasonCode}`, canonical(evidence)); }
function word(value: bigint, path: string): string { if (value < 0n || value >= (1n << 256n)) throw new RangeError(`${path} is outside uint256`); return value.toString(16).padStart(64, "0"); }
function call(selector: string, values: readonly bigint[]): string { if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) throw new TypeError("wstETH selector is not canonical"); return `${selector}${values.map((value, index) => word(value, `wsteth calldata[${index}]`)).join("")}`.toLowerCase(); }
function quoteSelector(direction: WstethRouteV1["direction"]): `0x${string}` { return direction === "wrap" ? "0xb0e38900" : "0xbb2952fc"; }

function decodeIdentity(value: unknown): WstethIdentityV1 {
  const outer = record(value, "wsteth.route.identityMemo");
  assertExactKeys(outer, ["kind", "version", "familyId", "familyDefinitionHash", "familyCandidateKey", "instanceNominationKey", "candidateSnapshotHash", "identity"], "wsteth.identityMemo");
  if (outer.kind !== "wsteth-identity-memo" || outer.version !== 1 || outer.familyId !== WSTETH_FAMILY_ID) throw new TypeError("wsteth identity memo discriminator mismatch");
  const definitionHash = assertHash(outer.familyDefinitionHash, "wsteth.identityMemo.familyDefinitionHash");
  const nominationKey = text(outer.instanceNominationKey, "wsteth.identityMemo.instanceNominationKey");
  if (definitionHash !== WSTETH_FAMILY_DEFINITION_HASH || assertHash(outer.familyCandidateKey, "wsteth.identityMemo.familyCandidateKey") !== discoveryFamilyCandidateKey(definitionHash, nominationKey)) throw new TypeError("wsteth identity memo family binding mismatch");
  const source = record(outer.identity, "wsteth.identity");
  assertExactKeys(source, ["cutoff", "candidateSnapshotHash", "instanceKey", "factsHash", "facts"], "wsteth.identity");
  const facts = record(source.facts, "wsteth.identity.facts");
  assertExactKeys(facts, ["target", "stEth", "wstEth", "wrapSelector", "unwrapSelector"], "wsteth.identity.facts");
  const decodedFacts = Object.freeze({
    target: canonicalAddress(text(facts.target, "wsteth.identity.facts.target")),
    stEth: canonicalAddress(text(facts.stEth, "wsteth.identity.facts.stEth")),
    wstEth: canonicalAddress(text(facts.wstEth, "wsteth.identity.facts.wstEth")),
    wrapSelector: bytes(facts.wrapSelector, "wsteth.identity.facts.wrapSelector") as `0x${string}`,
    unwrapSelector: bytes(facts.unwrapSelector, "wsteth.identity.facts.unwrapSelector") as `0x${string}`,
  });
  const identity = Object.freeze({
    cutoff: familySearchSource(source.cutoff, "wsteth.identity.cutoff") as WstethIdentityV1["cutoff"],
    candidateSnapshotHash: assertHash(source.candidateSnapshotHash, "wsteth.identity.candidateSnapshotHash"),
    instanceKey: canonicalAddress(text(source.instanceKey, "wsteth.identity.instanceKey")),
    factsHash: assertHash(source.factsHash, "wsteth.identity.factsHash"),
    facts: decodedFacts,
  });
  if (identity.instanceKey !== identity.facts.target || identity.factsHash !== hashDomain("aloha/wsteth/identity-facts/v1", identity.facts)) throw new TypeError("wsteth identity facts hash mismatch");
  if (nominationKey !== identity.instanceKey || assertHash(outer.candidateSnapshotHash, "wsteth.identityMemo.candidateSnapshotHash") !== identity.candidateSnapshotHash) throw new TypeError("wsteth identity memo lineage mismatch");
  return identity;
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== WSTETH_FAMILY_ID || route.familyDefinitionHash !== WSTETH_FAMILY_DEFINITION_HASH) throw new TypeError("wsteth search route family mismatch");
  if (route.identityMemoHash !== hashDomain("aloha/identity-memo/v1", route.identityMemo)) throw new TypeError("wsteth identity memo hash mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const identity = decodeIdentity(route.identityMemo);
  if (route.instanceKey !== identity.instanceKey) throw new TypeError("wsteth search instance binding mismatch");
  const protocolRoute = deriveWstethRoutes(identity).find(item => assetRef(source.chainId, item.inputAsset) === amount.inputAssetRef && assetRef(source.chainId, item.outputAsset) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("wsteth search amount assets do not match identity");
  assertWstethRoute(protocolRoute, identity);
  return Object.freeze({ route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, amountHash: familySearchAmountHash(amount), identity, protocolRoute });
}

function requestId(ctx: Context): Hash { return hashDomain("aloha/wsteth/search-state-request/v3", { familyDefinitionHash: WSTETH_FAMILY_DEFINITION_HASH, routeBindingHash: ctx.routeBindingHash, instanceKey: ctx.identity.instanceKey, amountHash: ctx.amountHash, source: ctx.source }); }
function readRequest(ctx: Context) { const id = requestId(ctx); return Object.freeze({ kind: "family-search.current-source-read" as const, requestId: id, source: ctx.source, target: ctx.identity.instanceKey, data: call(quoteSelector(ctx.protocolRoute.direction), [BigInt(ctx.amount.amountIn)]), responseEncoding: "abi-uint256" }); }
function stateResponse(ctx: Context, id: Hash, returnDataHex: string): StateResponse { const quoteReturnDataHex = abiUint256(returnDataHex, "wsteth.state.returnDataHex"); return Object.freeze({ kind: "wsteth-state-read-response", requestId: id, source: ctx.source, routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, instanceKey: ctx.identity.instanceKey, stateHash: hashDomain("aloha/wsteth/search-state/v4", { cutoff: ctx.source, routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, instanceKey: ctx.identity.instanceKey, quoteReturnDataHex }), quoteReturnDataHex }); }
function decodeStateResponse(value: CanonicalJson, ctx: Context, id: Hash): StateResponse { const source = record(value, "wsteth.stateResponse"); assertExactKeys(source, ["kind", "requestId", "source", "routeBindingHash", "amountHash", "instanceKey", "stateHash", "quoteReturnDataHex"], "wsteth.stateResponse"); if (source.kind !== "wsteth-state-read-response" || assertHash(source.requestId, "wsteth.stateResponse.requestId") !== id) throw new TypeError("wsteth state response request mismatch"); const responseSource = familySearchSource(source.source, "wsteth.stateResponse.source"); const routeBindingHash = assertHash(source.routeBindingHash, "wsteth.stateResponse.routeBindingHash"); const amountHash = assertHash(source.amountHash, "wsteth.stateResponse.amountHash"); const instanceKey = canonicalAddress(text(source.instanceKey, "wsteth.stateResponse.instanceKey")); if (!sameSource(responseSource, ctx.source) || routeBindingHash !== ctx.routeBindingHash || amountHash !== ctx.amountHash || instanceKey !== ctx.identity.instanceKey) throw new TypeError("wsteth state response lineage mismatch"); const quoteReturnDataHex = abiUint256(text(source.quoteReturnDataHex, "wsteth.stateResponse.quoteReturnDataHex"), "wsteth.stateResponse.quoteReturnDataHex"); const stateHash = assertHash(source.stateHash, "wsteth.stateResponse.stateHash"); if (stateHash !== hashDomain("aloha/wsteth/search-state/v4", { cutoff: responseSource, routeBindingHash, amountHash, instanceKey, quoteReturnDataHex })) throw new TypeError("wsteth state hash mismatch"); return Object.freeze({ kind: "wsteth-state-read-response", requestId: id, source: responseSource, routeBindingHash, amountHash, instanceKey, stateHash, quoteReturnDataHex }); }
function materialized(ctx: Context, response: StateResponse): WstethMaterializedStateV1 { const result = materializeWsteth({ identity: ctx.identity, read: { cutoff: response.source as WstethMaterializedStateV1["cutoff"], instanceKey: response.instanceKey, stateHash: response.stateHash } }); if (result.status !== "verified") throw new TypeError(`wsteth state ${result.reasonCode}`); return result.state; }
function stateArtifact(ctx: Context, response: StateResponse): FamilySearchStateArtifactV1 { const state = materialized(ctx, response); const read = { cutoff: response.source, instanceKey: response.instanceKey, stateHash: response.stateHash }; const payload = canonical(response); const payloadHash = familySearchPayloadHash("state", payload); return Object.freeze({ kind: "state", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: hashDomain("aloha/wsteth/state-facts/v1", read), sourceRequestId: response.requestId }); }
function assertState(ctx: Context, artifact: FamilySearchStateArtifactV1): StateResponse { if (artifact.kind !== "state" || artifact.status !== "verified" || !sameSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("wsteth state artifact binding mismatch"); const payload = canonical(artifact.payload); const payloadHash = familySearchPayloadHash("state", payload); if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("wsteth state artifact hash mismatch"); const response = decodeStateResponse(payload, ctx, artifact.sourceRequestId); const state = materialized(ctx, response); if (artifact.factsRoot !== hashDomain("aloha/wsteth/state-facts/v1", { cutoff: response.source, instanceKey: response.instanceKey, stateHash: response.stateHash }) || state.stateHash !== response.stateHash) throw new TypeError("wsteth state facts root mismatch"); return response; }
function decodeQuote(value: unknown, path: string): WstethQuoteV1 { const source = record(value, path); assertExactKeys(source, ["cutoff", "routeBindingHash", "amountIn", "amountOut", "quoteHash"], path); const body = { cutoff: familySearchSource(source.cutoff, `${path}.cutoff`) as WstethQuoteV1["cutoff"], routeBindingHash: assertHash(source.routeBindingHash, `${path}.routeBindingHash`), amountIn: assertDecimalString(source.amountIn, `${path}.amountIn`), amountOut: assertDecimalString(source.amountOut, `${path}.amountOut`) }; const quote = Object.freeze({ ...body, quoteHash: assertHash(source.quoteHash, `${path}.quoteHash`) }); if (quote.quoteHash !== hashDomain("aloha/wsteth/quote/v1", body)) throw new TypeError(`${path}.quoteHash mismatch`); return quote; }
function assertQuoteContext(ctx: Context, quote: WstethQuoteV1): void { if (!sameSource(quote.cutoff, ctx.source) || quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || quote.amountIn !== ctx.amount.amountIn) throw new TypeError("wsteth quote lineage mismatch"); }
function assertCoarse(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, state: WstethMaterializedStateV1, artifact: FamilySearchCoarseArtifactV1): WstethQuoteV1 { if (artifact.kind !== "coarse" || artifact.status !== "rankable" || !sameSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== ctx.amountHash || artifact.stateFactsRoot !== stateArtifactValue.factsRoot) throw new TypeError("wsteth coarse artifact binding mismatch"); const payload = canonical(artifact.payload); const payloadHash = familySearchPayloadHash("coarse", payload); if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash })) throw new TypeError("wsteth coarse artifact hash mismatch"); const quote = decodeQuote(payload, "wsteth.coarse.payload"); assertQuoteContext(ctx, quote); if (artifact.input.assetRef !== ctx.amount.inputAssetRef || artifact.input.amount !== ctx.amount.amountIn || artifact.output?.assetRef !== ctx.amount.outputAssetRef || artifact.output?.amount !== quote.amountOut || artifact.conservativeOutputUpperBound !== quote.amountOut || artifact.projectionHash !== hashDomain("aloha/wsteth/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash })) throw new TypeError("wsteth coarse artifact lineage mismatch"); return quote; }
function coarseArtifact(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, state: WstethMaterializedStateV1, quote: WstethQuoteV1): FamilySearchCoarseArtifactV1 { const payload = canonical(quote); const payloadHash = familySearchPayloadHash("coarse", payload); return Object.freeze({ kind: "coarse", status: "rankable", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), projectionHash: hashDomain("aloha/wsteth/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash }), stateFactsRoot: stateArtifactValue.factsRoot, input: { assetRef: ctx.amount.inputAssetRef, amount: quote.amountIn }, output: { assetRef: ctx.amount.outputAssetRef, amount: quote.amountOut }, conservativeOutputUpperBound: quote.amountOut, inputCapacityUpperBound: null, rankKey: hashDomain("aloha/wsteth/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash }), reasonCode: null }); }
function exactArtifact(ctx: Context, stateArtifactValue: FamilySearchStateArtifactV1, state: WstethMaterializedStateV1, quote: WstethQuoteV1): FamilySearchExactArtifactV1 { const payload = canonical({ quote }); const payloadHash = familySearchPayloadHash("exact", payload); const evaluationHash = hashDomain("aloha/wsteth/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash }); return Object.freeze({ kind: "exact", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), evaluationHash, stateFactsRoot: stateArtifactValue.factsRoot, inputs: [{ assetRef: ctx.amount.inputAssetRef, amount: quote.amountIn }], outputs: [{ assetRef: ctx.amount.outputAssetRef, amount: quote.amountOut }], obligationRoot: hashDomain("aloha/wsteth/search-obligation/v1", { evaluationHash, routeBindingHash: ctx.routeBindingHash }), reasonCode: null }); }
const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== WSTETH_FAMILY_DEFINITION_HASH) throw new TypeError("wsteth search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  for (const ref of Object.values(input.actionOwnerRefs)) input.composition.resolveActionOwner(input.familyDefinitionHash, ref);
  const readState: FamilySearchAdapterV1["readState"] = async request => { try { const ctx = context(request); await request.currentSource.assertCurrent(); const physical = readRequest(ctx); let raw: FamilySearchSourceReadResultV1; try { raw = await request.readPort.read({ request: physical, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) }); } catch (error) { return unavailable("state", "source-transport-error", { requestId: physical.requestId, error: String(error) }); } if (raw.kind !== "returned") return unavailable("state", raw.reasonCode || "source-read-unavailable", raw); if (raw.requestId !== physical.requestId || !sameSource(raw.source, physical.source)) throw new TypeError("wsteth source response binding mismatch"); try { const response = stateResponse(ctx, physical.requestId, raw.dataHex); return Object.freeze({ kind: "verified" as const, artifact: stateArtifact(ctx, response) }); } catch (error) { return unavailable("state", "malformed-abi-return", { requestId: physical.requestId, dataHex: raw.dataHex, error: String(error) }); } } catch (error) { return invalid("state", error); } };
  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => { try { const ctx = context(request); const response = assertState(ctx, request.state); const result = coarseWsteth({ identity: ctx.identity, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn, returnDataHex: response.quoteReturnDataHex }); if (result.status !== "rankable") return unavailable("coarse", result.reasonCode, result); return Object.freeze({ kind: "verified" as const, artifact: coarseArtifact(ctx, request.state, materialized(ctx, response), result.quote) }); } catch (error) { return invalid("coarse", error); } };
  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => { try { const ctx = context(request); const response = assertState(ctx, request.state); const state = materialized(ctx, response); const coarse = assertCoarse(ctx, request.state, state, request.coarse); const result = exactWsteth({ identity: ctx.identity, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn, returnDataHex: response.quoteReturnDataHex }); if (result.status !== "rankable") return unavailable("exact", result.reasonCode, result); if (result.quote.quoteHash !== coarse.quoteHash) throw new TypeError("wsteth exact/coarse quote mismatch"); return Object.freeze({ kind: "verified" as const, artifact: exactArtifact(ctx, request.state, state, result.quote) }); } catch (error) { return invalid("exact", error); } };
  const buildAction: FamilySearchAdapterV1["buildAction"] = request => { try { const ctx = context(request); return unavailable("action", "qualified-effect-observation-or-simulation-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, required: "qualified-effect-observation-or-simulation" }); } catch (error) { return invalid("action", error); } };
  const run: FamilySearchAdapterV1["run"] = async (request: FamilySearchRunRequestV1) => { const state = await readState(request); if (state.kind !== "verified") return state; const coarse = projectCoarse({ ...request, state: state.artifact }); if (coarse.kind !== "verified") return coarse; const exact = evaluateExact({ ...request, state: state.artifact, coarse: coarse.artifact }); if (exact.kind !== "verified") return exact; const action = buildAction({ ...request, exact: exact.artifact }); if (action.kind !== "verified") return action; return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ state: state.artifact, coarse: coarse.artifact, exact: exact.artifact, action: action.artifact }) }); };
  return Object.freeze({ readState, projectCoarse, evaluateExact, buildAction, run });
};

export const WSTETH_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
