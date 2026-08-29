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
import { candidateSubjectHash, familyCandidateKey as discoveryFamilyCandidateKey } from "../../../packages/discovery/src/index.ts";
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
  type FamilySearchExactArtifactV1,
  type FamilySearchLegRequestV1,
  type FamilySearchRunRequestV1,
  type FamilySearchSourceReadResultV1,
  type FamilySearchStateArtifactV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { EIGENPIE_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { EIGENPIE_FAMILY_ID } from "./manifest.ts";
import { exactEigenpie } from "./exact.ts";
import { materializeEigenpie } from "./instance.ts";
import { assertEigenpieRoute, deriveEigenpieRoutes } from "./routes.ts";
import { canonicalAddress, type EigenpieIdentityV1, type EigenpieQuoteV1, type EigenpieRouteV1 } from "./types.ts";

type Source = ReturnType<typeof familySearchSource>;
type Context = {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly routeBindingHash: Hash;
  readonly source: Source;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly amountHash: Hash;
  readonly identity: EigenpieIdentityV1;
  readonly protocolRoute: EigenpieRouteV1;
};
type StateResponse = {
  readonly kind: "eigenpie-state-read-response";
  readonly requestId: Hash;
  readonly source: Source;
  readonly routeBindingHash: Hash;
  readonly amountHash: Hash;
  readonly objectiveRef: Hash;
  readonly instanceKey: string;
  readonly quoteReturnDataHex: string;
  readonly stateHash: Hash;
};

function canonical(value: unknown): CanonicalJson { return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value))); }
function record(value: unknown, path: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`); return value as Record<string, unknown>; }
function text(value: unknown, path: string): string { return assertNonEmptyString(value, path); }
function bytes(value: unknown, path: string): string { const result = text(value, path); if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new TypeError(`${path} must be even-length hex bytes`); return result.toLowerCase(); }
function sameSource(left: Source, right: Source): boolean { return sameFamilySearchSource(left, right); }
function assetRef(chainId: string, value: string): Hash { return erc20AssetRefV1(chainId, value); }
function invalid(stage: "state" | "coarse" | "exact" | "action", error: unknown) { return Object.freeze({ kind: "invalidProgram" as const, stage, code: error instanceof Error ? error.message : `${stage}-invalid` }); }
function unavailable(stage: "state" | "coarse" | "exact" | "action", reasonCode: string, evidence: unknown) { return unavailableFamilySearchStage(stage, `eigenpie-${reasonCode}`, canonical(evidence)); }
function word(value: bigint, path: string): string { if (value < 0n || value >= (1n << 256n)) throw new RangeError(`${path} is outside uint256`); return value.toString(16).padStart(64, "0"); }
function addressWord(value: string, path: string): string { return canonicalAddress(text(value, path)).slice(2).padStart(64, "0"); }
function call(selector: string, words: readonly string[]): string { if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) throw new TypeError("eigenpie selector is not canonical"); return `${selector}${words.join("")}`.toLowerCase(); }
function abiQuote(value: string, path: string): string { const result = bytes(value, path); if (result.length !== 130) throw new TypeError(`${path} must contain one uint256 and one address ABI word`); if (!/^0{24}[0-9a-f]{40}$/i.test(result.slice(66))) throw new TypeError(`${path} address word is not canonical`); return result; }

function decodeIdentity(value: unknown): EigenpieIdentityV1 {
  const outer = record(value, "eigenpie.route.identityMemo");
  assertExactKeys(outer, ["kind", "familyId", "familyDefinitionHash", "familyCandidateKey", "instanceNominationKey", "candidateSnapshotHash", "candidateEvidenceRoot", "identity"], "eigenpie.identityMemo");
  if (outer.kind !== "eigenpie-identity-memo" || outer.familyId !== EIGENPIE_FAMILY_ID) throw new TypeError("eigenpie identity memo discriminator mismatch");
  const definitionHash = assertHash(outer.familyDefinitionHash, "eigenpie.identityMemo.familyDefinitionHash");
  const nominationKey = canonicalAddress(text(outer.instanceNominationKey, "eigenpie.identityMemo.instanceNominationKey"));
  if (definitionHash !== EIGENPIE_FAMILY_AUTHORING_HASH || assertHash(outer.familyCandidateKey, "eigenpie.identityMemo.familyCandidateKey") !== discoveryFamilyCandidateKey(definitionHash, nominationKey) || assertHash(outer.candidateSnapshotHash, "eigenpie.identityMemo.candidateSnapshotHash") !== candidateSubjectHash(definitionHash, nominationKey)) throw new TypeError("eigenpie identity memo family binding mismatch");
  assertHash(outer.candidateEvidenceRoot, "eigenpie.identityMemo.candidateEvidenceRoot");
  const source = record(outer.identity, "eigenpie.identity");
  assertExactKeys(source, ["cutoff", "candidateSnapshotHash", "instanceKey", "factsHash", "facts"], "eigenpie.identity");
  const facts = record(source.facts, "eigenpie.identity.facts");
  assertExactKeys(facts, ["target", "inputAsset", "outputAsset"], "eigenpie.identity.facts");
  const decodedFacts = Object.freeze({ target: canonicalAddress(text(facts.target, "eigenpie.identity.facts.target")), inputAsset: canonicalAddress(text(facts.inputAsset, "eigenpie.identity.facts.inputAsset")), outputAsset: canonicalAddress(text(facts.outputAsset, "eigenpie.identity.facts.outputAsset")) });
  const identity = Object.freeze({ cutoff: familySearchSource(source.cutoff, "eigenpie.identity.cutoff") as EigenpieIdentityV1["cutoff"], candidateSnapshotHash: assertHash(source.candidateSnapshotHash, "eigenpie.identity.candidateSnapshotHash"), instanceKey: canonicalAddress(text(source.instanceKey, "eigenpie.identity.instanceKey")), factsHash: assertHash(source.factsHash, "eigenpie.identity.factsHash"), facts: decodedFacts });
  if (identity.instanceKey !== identity.facts.target || identity.factsHash !== hashDomain("aloha/eigenpie/identity-facts/v1", identity.facts)) throw new TypeError("eigenpie identity facts hash mismatch");
  if (nominationKey !== identity.instanceKey || assertHash(outer.candidateSnapshotHash, "eigenpie.identityMemo.candidateSnapshotHash") !== identity.candidateSnapshotHash) throw new TypeError("eigenpie identity memo lineage mismatch");
  return identity;
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== EIGENPIE_FAMILY_ID || route.familyDefinitionHash !== EIGENPIE_FAMILY_AUTHORING_HASH) throw new TypeError("eigenpie search route family mismatch");
  if (route.identityMemoHash !== hashDomain("aloha/identity-memo/v1", route.identityMemo)) throw new TypeError("eigenpie identity memo hash mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const identity = decodeIdentity(route.identityMemo);
  if (route.instanceKey !== identity.instanceKey) throw new TypeError("eigenpie search instance binding mismatch");
  const protocolRoute = deriveEigenpieRoutes(identity).find(item => assetRef(source.chainId, item.inputAsset) === amount.inputAssetRef && assetRef(source.chainId, item.outputAsset) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("eigenpie search amount assets do not match identity");
  assertEigenpieRoute(protocolRoute, identity);
  return Object.freeze({ route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, amountHash: familySearchAmountHash(amount), identity, protocolRoute });
}

function requestId(ctx: Context): Hash { return hashDomain("aloha/eigenpie/search-state-request/v2", { familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, routeBindingHash: ctx.routeBindingHash, instanceKey: ctx.identity.instanceKey, amountHash: ctx.amountHash, objectiveRef: ctx.objective.objectiveRef, source: ctx.source }); }
function readRequest(ctx: Context) { const requestIdValue = requestId(ctx); return Object.freeze({ kind: "family-search.current-source-read" as const, requestId: requestIdValue, source: ctx.source, target: ctx.identity.instanceKey, data: call("0x8a9e83ac", [addressWord(ctx.protocolRoute.inputAsset, "eigenpie quote asset"), word(BigInt(ctx.amount.amountIn), "eigenpie quote amount")]), responseEncoding: "abi-uint256-address" as const }); }
function stateResponse(ctx: Context, id: Hash, returnDataHex: string): StateResponse { const quoteReturnDataHex = abiQuote(returnDataHex, "eigenpie.state.returnDataHex"); return Object.freeze({ kind: "eigenpie-state-read-response", requestId: id, source: ctx.source, routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, objectiveRef: ctx.objective.objectiveRef, instanceKey: ctx.identity.instanceKey, quoteReturnDataHex, stateHash: hashDomain("aloha/eigenpie/search-state/v3", { cutoff: ctx.source, instanceKey: ctx.identity.instanceKey, routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, quoteReturnDataHex }) }); }
function decodeStateResponse(value: CanonicalJson, ctx: Context, id: Hash): StateResponse { const source = record(value, "eigenpie.stateResponse"); assertExactKeys(source, ["kind", "requestId", "source", "routeBindingHash", "amountHash", "objectiveRef", "instanceKey", "quoteReturnDataHex", "stateHash"], "eigenpie.stateResponse"); if (source.kind !== "eigenpie-state-read-response" || assertHash(source.requestId, "eigenpie.stateResponse.requestId") !== id) throw new TypeError("eigenpie state response request mismatch"); const responseSource = familySearchSource(source.source, "eigenpie.stateResponse.source"); const instanceKey = canonicalAddress(text(source.instanceKey, "eigenpie.stateResponse.instanceKey")); const routeBindingHash = assertHash(source.routeBindingHash, "eigenpie.stateResponse.routeBindingHash"); const amountHash = assertHash(source.amountHash, "eigenpie.stateResponse.amountHash"); const objectiveRef = assertHash(source.objectiveRef, "eigenpie.stateResponse.objectiveRef"); const quoteReturnDataHex = abiQuote(text(source.quoteReturnDataHex, "eigenpie.stateResponse.quoteReturnDataHex"), "eigenpie.stateResponse.quoteReturnDataHex"); const stateHash = assertHash(source.stateHash, "eigenpie.stateResponse.stateHash"); if (!sameSource(responseSource, ctx.source) || routeBindingHash !== ctx.routeBindingHash || amountHash !== ctx.amountHash || objectiveRef !== ctx.objective.objectiveRef || instanceKey !== ctx.identity.instanceKey || stateHash !== hashDomain("aloha/eigenpie/search-state/v3", { cutoff: responseSource, instanceKey, routeBindingHash, amountHash, quoteReturnDataHex })) throw new TypeError("eigenpie state response lineage mismatch"); return Object.freeze({ kind: "eigenpie-state-read-response", requestId: id, source: responseSource, routeBindingHash, amountHash, objectiveRef, instanceKey, quoteReturnDataHex, stateHash }); }
function stateArtifact(ctx: Context, response: StateResponse): FamilySearchStateArtifactV1 { const factsHash = hashDomain("aloha/eigenpie/state-read/v1", { cutoff: response.source, instanceKey: response.instanceKey, amountHash: ctx.amountHash, quoteReturnDataHex: response.quoteReturnDataHex }); const materialized = materializeEigenpie({ identity: ctx.identity, read: { cutoff: response.source as EigenpieIdentityV1["cutoff"], instanceKey: response.instanceKey, factsHash } }); if (materialized.status !== "verified") throw new TypeError(`eigenpie state ${materialized.reasonCode}`); const payload = canonical(response); const payloadHash = familySearchPayloadHash("state", payload); return Object.freeze({ kind: "state", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: hashDomain("aloha/eigenpie/state-facts/v1", { factsHash, stateHash: materialized.state.stateHash, quoteReturnDataHex: response.quoteReturnDataHex }), sourceRequestId: response.requestId }); }
function assertState(ctx: Context, artifact: FamilySearchStateArtifactV1): StateResponse { if (artifact.kind !== "state" || artifact.status !== "verified" || !sameSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("eigenpie state artifact binding mismatch"); const payload = canonical(artifact.payload); const payloadHash = familySearchPayloadHash("state", payload); if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("eigenpie state artifact hash mismatch"); const response = decodeStateResponse(payload, ctx, artifact.sourceRequestId); const factsHash = hashDomain("aloha/eigenpie/state-read/v1", { cutoff: response.source, instanceKey: response.instanceKey, amountHash: ctx.amountHash, quoteReturnDataHex: response.quoteReturnDataHex }); const materialized = materializeEigenpie({ identity: ctx.identity, read: { cutoff: response.source as EigenpieIdentityV1["cutoff"], instanceKey: response.instanceKey, factsHash } }); if (materialized.status !== "verified" || artifact.factsRoot !== hashDomain("aloha/eigenpie/state-facts/v1", { factsHash, stateHash: materialized.state.stateHash, quoteReturnDataHex: response.quoteReturnDataHex })) throw new TypeError("eigenpie state facts root mismatch"); return response; }
function quote(ctx: Context, returnDataHex: string): EigenpieQuoteV1 { const result = exactEigenpie({ identity: ctx.identity, route: ctx.protocolRoute, quoteDataHex: returnDataHex }); if (result.status !== "verified") throw new TypeError(`eigenpie exact ${result.reasonCode}`); if (result.quote.amountOut === "0" || result.quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || result.quote.tokenOut !== ctx.identity.facts.outputAsset) throw new TypeError("eigenpie quote lineage mismatch"); return result.quote; }
function quoteFromPayload(ctx: Context, value: unknown, path: string): EigenpieQuoteV1 { const source = record(value, path); assertExactKeys(source, ["cutoff", "routeBindingHash", "amountOut", "tokenOut", "quoteHash"], path); const body = { cutoff: familySearchSource(source.cutoff, `${path}.cutoff`) as EigenpieQuoteV1["cutoff"], routeBindingHash: assertHash(source.routeBindingHash, `${path}.routeBindingHash`), amountOut: assertDecimalString(source.amountOut, `${path}.amountOut`), tokenOut: canonicalAddress(text(source.tokenOut, `${path}.tokenOut`)) }; const result = Object.freeze({ ...body, quoteHash: assertHash(source.quoteHash, `${path}.quoteHash`) }); if (result.quoteHash !== hashDomain("aloha/eigenpie/quote/v1", body) || !sameSource(result.cutoff, ctx.source) || result.routeBindingHash !== ctx.protocolRoute.routeBindingHash || result.tokenOut !== ctx.identity.facts.outputAsset || BigInt(result.amountOut) <= 0n) throw new TypeError(`${path} lineage mismatch`); return result; }
function exactArtifact(ctx: Context, state: FamilySearchStateArtifactV1, exactQuote: EigenpieQuoteV1): FamilySearchExactArtifactV1 { const payload = canonical({ quote: exactQuote }); const payloadHash = familySearchPayloadHash("exact", payload); const statePayload = record(state.payload, "eigenpie.state.payload"); const evaluationHash = hashDomain("aloha/eigenpie/search-exact-evaluation/v1", { quoteHash: exactQuote.quoteHash, stateFactsRoot: state.factsRoot, quoteReturnDataHex: statePayload.quoteReturnDataHex }); return Object.freeze({ kind: "exact", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash }), evaluationHash, stateFactsRoot: state.factsRoot, inputs: [{ assetRef: ctx.amount.inputAssetRef, amount: ctx.amount.amountIn }], outputs: [{ assetRef: ctx.amount.outputAssetRef, amount: exactQuote.amountOut }], obligationRoot: hashDomain("aloha/eigenpie/search-obligation/v1", { evaluationHash, routeBindingHash: ctx.routeBindingHash }), reasonCode: null }); }
function assertExact(ctx: Context, artifact: FamilySearchExactArtifactV1, state: FamilySearchStateArtifactV1): EigenpieQuoteV1 { if (artifact.kind !== "exact" || artifact.status !== "verified" || !sameSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== ctx.amountHash || artifact.stateFactsRoot !== state.factsRoot) throw new TypeError("eigenpie exact artifact binding mismatch"); const payload = canonical(artifact.payload); const payloadHash = familySearchPayloadHash("exact", payload); if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: ctx.amountHash, payloadHash })) throw new TypeError("eigenpie exact artifact hash mismatch"); const quoteValue = quoteFromPayload(ctx, record(payload, "eigenpie.exact.payload").quote, "eigenpie.exact.quote"); const statePayload = record(state.payload, "eigenpie.state.payload"); if (artifact.inputs[0]?.assetRef !== ctx.amount.inputAssetRef || artifact.inputs[0]?.amount !== ctx.amount.amountIn || artifact.outputs[0]?.assetRef !== ctx.amount.outputAssetRef || artifact.outputs[0]?.amount !== quoteValue.amountOut || artifact.evaluationHash !== hashDomain("aloha/eigenpie/search-exact-evaluation/v1", { quoteHash: quoteValue.quoteHash, stateFactsRoot: state.factsRoot, quoteReturnDataHex: statePayload.quoteReturnDataHex })) throw new TypeError("eigenpie exact artifact lineage mismatch"); return quoteValue; }
const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== EIGENPIE_FAMILY_AUTHORING_HASH) throw new TypeError("eigenpie search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  for (const ref of Object.values(input.actionOwnerRefs)) input.composition.resolveActionOwner(input.familyDefinitionHash, ref);
  const releaseReadState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      await request.currentSource.assertCurrent();
      return unavailable("state", "state-capability-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash });
    } catch (error) { return invalid("state", error); }
  };
  const releaseProjectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => {
    try { const ctx = context(request); return unavailable("coarse", "state-prerequisite-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash }); }
    catch (error) { return invalid("coarse", error); }
  };
  const releaseEvaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => {
    try { const ctx = context(request); return unavailable("exact", "state-prerequisite-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash }); }
    catch (error) { return invalid("exact", error); }
  };
  const releaseBuildAction: FamilySearchAdapterV1["buildAction"] = request => {
    try { const ctx = context(request); return unavailable("action", "state-or-effect-capability-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, required: "qualified-effect-observation-or-simulation" }); }
    catch (error) { return invalid("action", error); }
  };
  const readState: FamilySearchAdapterV1["readState"] = async request => { try { const ctx = context(request); await request.currentSource.assertCurrent(); const physical = readRequest(ctx); let raw: FamilySearchSourceReadResultV1; try { raw = await request.readPort.read({ request: physical, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) }); } catch (error) { return unavailable("state", "source-transport-error", { requestId: physical.requestId, error: String(error) }); } if (raw.kind !== "returned") return unavailable("state", raw.reasonCode || "source-read-unavailable", raw); if (raw.requestId !== physical.requestId || !sameSource(raw.source, physical.source)) throw new TypeError("eigenpie source response binding mismatch"); try { const response = stateResponse(ctx, physical.requestId, raw.dataHex); return Object.freeze({ kind: "verified" as const, artifact: stateArtifact(ctx, response) }); } catch (error) { return unavailable("state", "malformed-abi-return", { requestId: physical.requestId, dataHex: raw.dataHex, error: String(error) }); } } catch (error) { return invalid("state", error); } };
  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => { try { const ctx = context(request); assertState(ctx, request.state); return unavailable("coarse", "coarse-capability-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash }); } catch (error) { return invalid("coarse", error); } };
  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => { try { const ctx = context(request); const state = assertState(ctx, request.state); const exactQuote = quote(ctx, state.quoteReturnDataHex); return Object.freeze({ kind: "verified" as const, artifact: exactArtifact(ctx, request.state, exactQuote) }); } catch (error) { return invalid("exact", error); } };
  const buildAction: FamilySearchAdapterV1["buildAction"] = request => { try { const ctx = context(request); return unavailable("action", "qualified-effect-observation-or-simulation-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, required: "qualified-effect-observation-or-simulation" }); } catch (error) { return invalid("action", error); } };
  const run: FamilySearchAdapterV1["run"] = async request => { const state = await readState(request); if (state.kind !== "verified") return state; const coarse = projectCoarse({ ...request, state: state.artifact }); if (coarse.kind !== "verified") return coarse; const exact = evaluateExact({ ...request, state: state.artifact, coarse: coarse.artifact }); if (exact.kind !== "verified") return exact; const action = buildAction({ ...request, exact: exact.artifact }); if (action.kind !== "verified") return action; return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ state: state.artifact, coarse: coarse.artifact, exact: exact.artifact, action: action.artifact }) }); };
  const releaseRun: FamilySearchAdapterV1["run"] = async request => {
    try {
      const ctx = context(request);
      await request.currentSource.assertCurrent();
      return unavailable("state", "state-capability-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash });
    } catch (error) { return invalid("state", error); }
  };
  return Object.freeze({ readState: releaseReadState, projectCoarse: releaseProjectCoarse, evaluateExact: releaseEvaluateExact, buildAction: releaseBuildAction, run: releaseRun });
};

export const EIGENPIE_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
