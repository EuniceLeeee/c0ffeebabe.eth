import {
  assertDecimalString,
  assertExactKeys,
  assertHash,
  assertNonEmptyString,
  decodeCanonicalJson,
  deepFreeze,
  encodeCanonicalJson,
  fieldArray,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import {
  candidateSubjectHash as centralCandidateSubjectHash,
  familyCandidateKey as centralFamilyCandidateKey,
} from "../../../packages/discovery/src/index.ts";
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
import { CURVE_UNDERLYING_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { CURVE_UNDERLYING_SWAP_ACTION_PORT } from "./action.ts";
import { exactCurveUnderlying } from "./exact.ts";
import { materializeCurveUnderlying } from "./instance.ts";
import { CURVE_UNDERLYING_FAMILY_ID } from "./manifest.ts";
import { encodeCurveStateCall, decodeCurveUint256, decodeCurveUint256Array, decodeCurveUint256Array8, trimCurveArray } from "./search-codec.ts";
import { coarseCurveUnderlying } from "./pricing.ts";
import { assertCurveRoute, deriveCurveUnderlyingRoutes } from "./routes.ts";
import {
  canonicalAddress,
  cutoffEqual,
  type CurveIdentityV1,
  type CurveMaterializedStateV1,
  type CurveQuoteV1,
  type CurveRouteV1,
  type CurveStateReadFactsV1,
} from "./types.ts";

type Memo = {
  readonly kind: "curve-underlying-identity-memo";
  readonly familyId: typeof CURVE_UNDERLYING_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSubjectHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: CurveIdentityV1;
};
function record(value: unknown, path: string): Record<string, unknown> { if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`); return value as Record<string, unknown>; }
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> { const result = record(value, path); assertExactKeys(result, keys, path); return result; }
function text(value: unknown, path: string): string { return assertNonEmptyString(value, path); }
function address(value: unknown, path: string): string { return canonicalAddress(text(value, path)); }
function decimal(value: unknown, path: string): string { return assertDecimalString(value, path); }
function hash(value: unknown, path: string): Hash { return assertHash(value, path); }
function integer(value: unknown, path: string): number { if (!Number.isInteger(value)) throw new TypeError(`${path} must be an integer`); return value as number; }
function boolean(value: unknown, path: string): boolean { if (typeof value !== "boolean") throw new TypeError(`${path} must be boolean`); return value; }
function cutoff(value: unknown, path: string): ReturnType<typeof familySearchSource> { return familySearchSource(value, path); }
function canonical(value: unknown): CanonicalJson { return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value))); }
function sameCutoff(left: ReturnType<typeof familySearchSource>, right: ReturnType<typeof familySearchSource>): boolean { return cutoffEqual(left, right); }
function decodeIdentity(value: unknown, path: string): CurveIdentityV1 {
  const source = exact(value, ["candidateSnapshotHash", "cutoff", "facts", "factsHash", "instanceKey"], path);
  const facts = exact(source.facts, ["handlers", "metaRegistry", "pool", "poolHasCode", "underlyingCoins", "underlyingDecimals", "verifiedDirections"], `${path}.facts`);
  const directions = Object.freeze(fieldArray(facts.verifiedDirections, (item, itemPath) => {
    const direction = exact(item, ["amountIn", "amountOut", "i", "j", "selectorVariant"], itemPath);
    if (direction.selectorVariant !== "int128" && direction.selectorVariant !== "uint256") throw new TypeError(`${itemPath}.selectorVariant mismatch`);
    return Object.freeze({ i: integer(direction.i, `${itemPath}.i`), j: integer(direction.j, `${itemPath}.j`), selectorVariant: direction.selectorVariant, amountIn: decimal(direction.amountIn, `${itemPath}.amountIn`), amountOut: decimal(direction.amountOut, `${itemPath}.amountOut`) });
  }, `${path}.facts.verifiedDirections`));
  const decodedFacts = Object.freeze({
    pool: address(facts.pool, `${path}.facts.pool`),
    metaRegistry: address(facts.metaRegistry, `${path}.facts.metaRegistry`),
    poolHasCode: boolean(facts.poolHasCode, `${path}.facts.poolHasCode`),
    handlers: Object.freeze(fieldArray(facts.handlers, (item, itemPath) => address(item, itemPath), `${path}.facts.handlers`)),
    underlyingCoins: Object.freeze(fieldArray(facts.underlyingCoins, (item, itemPath) => address(item, itemPath), `${path}.facts.underlyingCoins`)),
    underlyingDecimals: Object.freeze(fieldArray(facts.underlyingDecimals, (item, itemPath) => integer(item, itemPath), `${path}.facts.underlyingDecimals`)),
    verifiedDirections: directions,
  });
  const identity = Object.freeze({ cutoff: cutoff(source.cutoff, `${path}.cutoff`), candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`), instanceKey: address(source.instanceKey, `${path}.instanceKey`), factsHash: hash(source.factsHash, `${path}.factsHash`), facts: decodedFacts });
  if (identity.instanceKey !== identity.facts.pool) throw new TypeError("curve identity instance mismatch");
  if (identity.factsHash !== hashDomain("aloha/curve-underlying/identity-facts/v1", identity.facts)) throw new TypeError("curve identity facts hash mismatch");
  return identity;
}
function decodeMemo(value: unknown, path = "route.identityMemo"): Memo {
  const source = exact(value, ["candidateEvidenceRoot", "candidateSubjectHash", "familyCandidateKey", "familyDefinitionHash", "familyId", "instanceNominationKey", "identity", "kind"], path);
  if (source.kind !== "curve-underlying-identity-memo" || source.familyId !== CURVE_UNDERLYING_FAMILY_ID) throw new TypeError("curve identity memo discriminator mismatch");
  const familyDefinitionHash = hash(source.familyDefinitionHash, `${path}.familyDefinitionHash`);
  if (familyDefinitionHash !== CURVE_UNDERLYING_FAMILY_DEFINITION_HASH) throw new TypeError("curve identity memo definition mismatch");
  const instanceNominationKey = address(source.instanceNominationKey, `${path}.instanceNominationKey`);
  const memo = Object.freeze({ kind: "curve-underlying-identity-memo" as const, familyId: CURVE_UNDERLYING_FAMILY_ID, familyDefinitionHash, familyCandidateKey: hash(source.familyCandidateKey, `${path}.familyCandidateKey`), instanceNominationKey, candidateSubjectHash: hash(source.candidateSubjectHash, `${path}.candidateSubjectHash`), candidateEvidenceRoot: hash(source.candidateEvidenceRoot, `${path}.candidateEvidenceRoot`), identity: decodeIdentity(source.identity, `${path}.identity`) });
  if (memo.familyCandidateKey !== centralFamilyCandidateKey(familyDefinitionHash, instanceNominationKey) || memo.candidateSubjectHash !== centralCandidateSubjectHash(familyDefinitionHash, instanceNominationKey) || memo.instanceNominationKey !== memo.identity.instanceKey || memo.candidateSubjectHash !== memo.identity.candidateSnapshotHash) throw new TypeError("curve identity memo lineage mismatch");
  return memo;
}
function decodeStateFact(value: unknown, path = "curve-underlying.stateFact"): CurveStateReadFactsV1 {
  const source = exact(value, ["kind", "read", "version"], path);
  if (source.kind !== "curve-underlying-state-facts" || source.version !== 1) throw new TypeError("curve state fact discriminator mismatch");
  const read = record(source.read, `${path}.read`);
  const baseKeys = ["A", "balances", "cutoff", "fee", "pool", "rates", "variant"] as const;
  const optionalKeys = ["exactAmountOut", "exactSelectorVariant"] as const;
  assertExactKeys(read, read.variant === "plain" ? [...baseKeys, ...optionalKeys] : [...baseKeys, "offpegFeeMultiplier", ...optionalKeys], `${path}.read`);
  const variant = read.variant;
  if (variant !== "plain" && variant !== "ng") throw new TypeError("curve state variant mismatch");
  if ((read.exactAmountOut === undefined) !== (read.exactSelectorVariant === undefined) || (read.exactSelectorVariant !== undefined && read.exactSelectorVariant !== "int128" && read.exactSelectorVariant !== "uint256")) throw new TypeError("curve exact selector binding mismatch");
  return Object.freeze({ cutoff: cutoff(read.cutoff, `${path}.read.cutoff`), pool: address(read.pool, `${path}.read.pool`), variant, A: decimal(read.A, `${path}.read.A`), fee: decimal(read.fee, `${path}.read.fee`), balances: Object.freeze(fieldArray(read.balances, (item, itemPath) => decimal(item, itemPath), `${path}.read.balances`)), rates: Object.freeze(fieldArray(read.rates, (item, itemPath) => decimal(item, itemPath), `${path}.read.rates`)), ...(variant === "ng" ? { offpegFeeMultiplier: decimal(read.offpegFeeMultiplier, `${path}.read.offpegFeeMultiplier`) } : {}), ...(read.exactAmountOut === undefined ? {} : { exactAmountOut: decimal(read.exactAmountOut, `${path}.read.exactAmountOut`), exactSelectorVariant: read.exactSelectorVariant }) });
}
function protocolAssetRef(chainId: string, token: string): Hash { return erc20AssetRefV1(chainId, token); }
interface Context extends FamilySearchLegRequestV1 { readonly routeBindingHash: Hash; readonly source: ReturnType<typeof familySearchSource>; readonly objective: ReturnType<typeof familySearchObjective>; readonly amount: ReturnType<typeof familySearchAmount>; readonly identity: CurveIdentityV1; readonly protocolRoute: CurveRouteV1; }
function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== CURVE_UNDERLYING_FAMILY_ID || route.familyDefinitionHash !== CURVE_UNDERLYING_FAMILY_DEFINITION_HASH) throw new TypeError("curve search route family mismatch");
  const memo = decodeMemo(route.identityMemo);
  if (hashDomain("aloha/identity-memo/v1", memo) !== route.identityMemoHash || route.instanceKey !== memo.identity.instanceKey) throw new TypeError("curve search identity memo binding mismatch");
  const source = familySearchSource(input.currentSource.source); const objective = familySearchObjective(input.objective); const amount = familySearchAmount(input.amount);
  const protocolRoute = deriveCurveUnderlyingRoutes(memo.identity).find(item => protocolAssetRef(source.chainId, item.inputToken) === amount.inputAssetRef && protocolAssetRef(source.chainId, item.outputToken) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("curve search amount assets do not match identity");
  assertCurveRoute(protocolRoute, memo.identity);
  return Object.freeze({ ...input, route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, identity: memo.identity, protocolRoute });
}
function materializedState(ctx: Context, artifact: FamilySearchStateArtifactV1): CurveMaterializedStateV1 {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("curve search state artifact binding mismatch");
  const payload = canonical(artifact.payload); const payloadHash = familySearchPayloadHash("state", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("curve search state artifact hash mismatch");
  const read = decodeStateFact(payload); if (!sameCutoff(read.cutoff, ctx.source) || read.pool !== ctx.identity.instanceKey) throw new TypeError("curve search state lineage mismatch");
  if (read.exactSelectorVariant !== ctx.protocolRoute.selectorVariant) throw new TypeError("curve search state selector variant mismatch");
  if (artifact.factsRoot !== hashDomain("aloha/curve-underlying/state-facts/v1", read)) throw new TypeError("curve search state facts root mismatch");
  const result = materializeCurveUnderlying({ identity: ctx.identity, read }); if (result.status !== "verified") throw new TypeError(`curve search state ${result.reasonCode}`); return result.state;
}
function quoteFromPayload(value: unknown, path: string): CurveQuoteV1 {
  const source = exact(value, ["amountIn", "amountOut", "cutoff", "quoteHash", "routeBindingHash", "stateHash"], path);
  const quote = Object.freeze({ cutoff: cutoff(source.cutoff, `${path}.cutoff`), routeBindingHash: hash(source.routeBindingHash, `${path}.routeBindingHash`), amountIn: decimal(source.amountIn, `${path}.amountIn`), amountOut: decimal(source.amountOut, `${path}.amountOut`), stateHash: hash(source.stateHash, `${path}.stateHash`), quoteHash: hash(source.quoteHash, `${path}.quoteHash`) });
  if (quote.quoteHash !== hashDomain("aloha/curve-underlying/quote/v1", { cutoff: quote.cutoff, routeBindingHash: quote.routeBindingHash, amountIn: quote.amountIn, amountOut: quote.amountOut, stateHash: quote.stateHash })) throw new TypeError("curve search quote hash mismatch");
  return quote;
}
function coarseArtifact(ctx: Context, stateArtifact: FamilySearchStateArtifactV1, state: CurveMaterializedStateV1, quote: CurveQuoteV1): FamilySearchCoarseArtifactV1 {
  const payload = canonical(quote); const payloadHash = familySearchPayloadHash("coarse", payload); const amountHash = familySearchAmountHash(ctx.amount);
  const projectionHash = hashDomain("aloha/curve-underlying/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash }); const rankKey = hashDomain("aloha/curve-underlying/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash });
  return Object.freeze({ kind: "coarse", status: "rankable", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash }), projectionHash, stateFactsRoot: stateArtifact.factsRoot, input: { assetRef: ctx.amount.inputAssetRef, amount: ctx.amount.amountIn }, output: { assetRef: ctx.amount.outputAssetRef, amount: quote.amountOut }, conservativeOutputUpperBound: quote.amountOut, inputCapacityUpperBound: null, rankKey, reasonCode: null });
}
function validateCoarse(ctx: Context, stateArtifact: FamilySearchStateArtifactV1, state: CurveMaterializedStateV1, artifact: FamilySearchCoarseArtifactV1): CurveQuoteV1 {
  const amountHash = familySearchAmountHash(ctx.amount);
  if (artifact.kind !== "coarse" || artifact.status !== "rankable" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== amountHash) throw new TypeError("curve search coarse artifact binding mismatch");
  const payload = canonical(artifact.payload); const payloadHash = familySearchPayloadHash("coarse", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash })) throw new TypeError("curve search coarse artifact hash mismatch");
  const quote = quoteFromPayload(payload, "curve.search.coarse.payload");
  if (quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || quote.amountIn !== ctx.amount.amountIn || quote.stateHash !== state.stateHash || artifact.stateFactsRoot !== stateArtifact.factsRoot || artifact.output?.assetRef !== ctx.amount.outputAssetRef || artifact.output.amount !== quote.amountOut || artifact.projectionHash !== hashDomain("aloha/curve-underlying/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash }) || artifact.rankKey !== hashDomain("aloha/curve-underlying/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash })) throw new TypeError("curve search coarse artifact lineage mismatch");
  return quote;
}
function exactArtifact(ctx: Context, stateArtifact: FamilySearchStateArtifactV1, quote: CurveQuoteV1): FamilySearchExactArtifactV1 {
  const payload = canonical(quote); const payloadHash = familySearchPayloadHash("exact", payload); const amountHash = familySearchAmountHash(ctx.amount); const evaluationHash = hashDomain("aloha/curve-underlying/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateHash: quote.stateHash }); const obligationRoot = hashDomain("aloha/curve-underlying/search-obligation/v1", { evaluationHash, routeBindingHash: ctx.routeBindingHash });
  return Object.freeze({ kind: "exact", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash }), evaluationHash, stateFactsRoot: stateArtifact.factsRoot, inputs: [{ assetRef: ctx.amount.inputAssetRef, amount: quote.amountIn }], outputs: [{ assetRef: ctx.amount.outputAssetRef, amount: quote.amountOut }], obligationRoot, reasonCode: null });
}
function validateExact(ctx: Context, artifact: FamilySearchExactArtifactV1): CurveQuoteV1 {
  const amountHash = familySearchAmountHash(ctx.amount);
  if (artifact.kind !== "exact" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== amountHash) throw new TypeError("curve search exact artifact binding mismatch");
  const payload = canonical(artifact.payload); const payloadHash = familySearchPayloadHash("exact", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash })) throw new TypeError("curve search exact artifact hash mismatch");
  const quote = quoteFromPayload(payload, "curve.search.exact.payload"); const evaluationHash = hashDomain("aloha/curve-underlying/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateHash: quote.stateHash });
  if (quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || quote.amountIn !== ctx.amount.amountIn || artifact.evaluationHash !== evaluationHash || artifact.inputs[0]?.assetRef !== ctx.amount.inputAssetRef || artifact.outputs[0]?.assetRef !== ctx.amount.outputAssetRef || artifact.outputs[0]?.amount !== quote.amountOut || artifact.obligationRoot !== hashDomain("aloha/curve-underlying/search-obligation/v1", { evaluationHash, routeBindingHash: ctx.routeBindingHash })) throw new TypeError("curve search exact artifact lineage mismatch");
  return quote;
}
export function assertCurveActionArtifactExactBinding(value: FamilySearchActionArtifactV1): FamilySearchActionArtifactV1 {
  assertExactKeys(value, ["actionHash", "actionOwnerId", "actionOwnerRef", "amountHash", "artifactHash", "effectTransport", "exactEvaluationHash", "inputs", "kind", "objectiveRef", "obligationRoot", "opaqueBytes", "outputs", "payload", "payloadHash", "routeBindingHash", "source", "status"], "curve.actionArtifact");
  if (value.kind !== "action" || value.status !== "ready" || value.effectTransport === undefined) throw new TypeError("curve action artifact discriminator mismatch");
  const source = familySearchSource(value.source, "curve.actionArtifact.source");
  const payload = canonical(value.payload);
  const payloadHash = familySearchPayloadHash("action", payload);
  if (value.payloadHash !== payloadHash
    || value.artifactHash !== familySearchArtifactHash({ kind: "action", source, routeBindingHash: value.routeBindingHash, objectiveRef: value.objectiveRef, amountHash: value.amountHash, payloadHash })) throw new TypeError("curve action artifact hash mismatch");
  const verified = CURVE_UNDERLYING_SWAP_ACTION_PORT.decode(payload);
  if (!sameFamilySearchSource(source, verified.quote.cutoff)
    || verified.searchRouteBindingHash !== value.routeBindingHash
    || value.amountHash !== familySearchAmountHash({ inputAssetRef: verified.inputs[0]!.assetRef, outputAssetRef: verified.outputs[0]!.assetRef, amountIn: verified.inputs[0]!.amount, recipient: verified.recipient })
    || verified.actionHash !== value.actionHash
    || verified.exactEvaluationHash !== value.exactEvaluationHash
    || verified.actionOwnerId !== value.actionOwnerId
    || verified.opaqueBytes !== value.opaqueBytes
    || encodeCanonicalJson(verified.effectTransport as unknown as CanonicalJson) !== encodeCanonicalJson(value.effectTransport as unknown as CanonicalJson)
    || encodeCanonicalJson(verified.inputs as unknown as CanonicalJson) !== encodeCanonicalJson(value.inputs as unknown as CanonicalJson)
    || encodeCanonicalJson(verified.outputs as unknown as CanonicalJson) !== encodeCanonicalJson(value.outputs as unknown as CanonicalJson)
    || verified.obligationRoot !== value.obligationRoot) throw new TypeError("curve action artifact exact binding mismatch");
  return value;
}
type CurveActionPort = typeof CURVE_UNDERLYING_SWAP_ACTION_PORT;
function resolvedActionPort(value: object): CurveActionPort {
  if (value !== CURVE_UNDERLYING_SWAP_ACTION_PORT) throw new TypeError("generated curve action owner identity mismatch");
  return value as CurveActionPort;
}
function actionArtifact(ctx: Context, exact: FamilySearchExactArtifactV1, quote: CurveQuoteV1, actionOwnerRef: Hash, actionPort: CurveActionPort): FamilySearchActionArtifactV1 {
  const rawAction = actionPort.build({ identity: ctx.identity, route: ctx.protocolRoute, quote, minAmountOut: quote.amountOut });
  const action = actionPort.buildSearchAction({
    rawAction,
    quote,
    route: ctx.protocolRoute,
    recipient: ctx.amount.recipient,
    searchRouteBindingHash: ctx.routeBindingHash,
    stateFactsRoot: exact.stateFactsRoot,
    inputs: exact.inputs,
    outputs: exact.outputs,
    exactEvaluationHash: exact.evaluationHash,
    obligationRoot: exact.obligationRoot,
  });
  const payload = canonical(action);
  const payloadHash = familySearchPayloadHash("action", payload);
  const artifact = Object.freeze({
    kind: "action" as const,
    status: "ready" as const,
    source: ctx.source,
    routeBindingHash: ctx.routeBindingHash,
    objectiveRef: ctx.objective.objectiveRef,
    amountHash: familySearchAmountHash(ctx.amount),
    payload,
    payloadHash,
    artifactHash: familySearchArtifactHash({ kind: "action", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: familySearchAmountHash(ctx.amount), payloadHash }),
    actionHash: action.actionHash,
    exactEvaluationHash: exact.evaluationHash,
    actionOwnerId: actionPort.actionOwnerId,
    actionOwnerRef,
    opaqueBytes: action.opaqueBytes,
    effectTransport: action.effectTransport,
    inputs: exact.inputs,
    outputs: exact.outputs,
    obligationRoot: exact.obligationRoot,
  });
  return assertCurveActionArtifactExactBinding(artifact);
}
function unavailableReason(result: Exclude<FamilySearchSourceReadResultV1, { readonly kind: "returned" }>): string { return result.kind === "unavailable" ? result.reasonCode : "unexpected-reverted-response"; }
function decodeReadResult(result: FamilySearchSourceReadResultV1, requestId: Hash, source: ReturnType<typeof familySearchSource>): string { if (result.kind !== "returned") throw new Error(unavailableReason(result)); if (result.requestId !== requestId || !sameFamilySearchSource(result.source, source)) throw new TypeError("curve search source response binding mismatch"); if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(result.dataHex)) throw new TypeError("curve search source response is not canonical bytes"); return result.dataHex.toLowerCase(); }

const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== CURVE_UNDERLYING_FAMILY_DEFINITION_HASH) throw new TypeError("curve search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  const actionOwnerRef = assertHash(input.actionOwnerRefs.swap, "curve actionOwnerRefs.swap");
  const actionPort = resolvedActionPort(input.composition.resolveActionOwner(input.familyDefinitionHash, input.actionOwnerRefs.swap));
  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      const pool = ctx.identity.instanceKey;
      const specs = [
        { key: "A" as const, optional: false },
        { key: "fee" as const, optional: false },
        { key: "underlyingBalances" as const, optional: false },
        { key: "underlyingDecimals" as const, optional: false },
        { key: "offpegFeeMultiplier" as const, optional: true },
        { key: "storedRates" as const, optional: true },
      ] as const;
      const responses = new Map<string, { readonly requestId: Hash; readonly dataHex: string | null }>();
      for (const spec of specs) {
        const physical = encodeCurveStateCall(spec.key, pool);
        const requestId = hashDomain("aloha/curve-underlying/search-state-read/v1", { route: ctx.routeBindingHash, source: ctx.source, key: spec.key });
        await request.currentSource.assertCurrent();
        let result: FamilySearchSourceReadResultV1;
        try {
          result = await request.readPort.read({ request: { kind: "family-search.current-source-read", requestId, source: ctx.source, target: physical.target, data: physical.data, responseEncoding: physical.responseEncoding }, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) });
        } catch (error) {
          return unavailableFamilySearchStage("state", "source-transport-unavailable", { requestId, key: spec.key, error: String(error) });
        }
        if (result.kind !== "returned") {
          if (spec.optional) {
            responses.set(spec.key, { requestId, dataHex: null });
            continue;
          }
          return unavailableFamilySearchStage("state", unavailableReason(result), { requestId, key: spec.key });
        }
        responses.set(spec.key, { requestId, dataHex: decodeReadResult(result, requestId, ctx.source) });
      }
      const exactPhysical = encodeCurveStateCall("getDyUnderlying", pool, [ctx.protocolRoute.i, ctx.protocolRoute.j, ctx.amount.amountIn], ctx.protocolRoute.selectorVariant);
      const exactRequestId = hashDomain("aloha/curve-underlying/search-state-read/v1", { route: ctx.routeBindingHash, source: ctx.source, key: "exactAmountOut", amount: ctx.amount.amountIn });
      await request.currentSource.assertCurrent();
      let exactResult: FamilySearchSourceReadResultV1;
      try { exactResult = await request.readPort.read({ request: { kind: "family-search.current-source-read", requestId: exactRequestId, source: ctx.source, target: exactPhysical.target, data: exactPhysical.data, responseEncoding: exactPhysical.responseEncoding }, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) }); } catch (error) { return unavailableFamilySearchStage("state", "source-transport-unavailable", { requestId: exactRequestId, key: "exactAmountOut", error: String(error) }); }
      if (exactResult.kind !== "returned") return unavailableFamilySearchStage("state", unavailableReason(exactResult), { requestId: exactRequestId, key: "exactAmountOut" });
      responses.set("exactAmountOut", { requestId: exactRequestId, dataHex: decodeReadResult(exactResult, exactRequestId, ctx.source) });
      await request.currentSource.assertCurrent();
      const required = (key: string): string => {
        const value = responses.get(key);
        if (value?.dataHex === null || value?.dataHex === undefined) throw new TypeError(`curve ${key} read is missing`);
        return value.dataHex;
      };
      const count = ctx.identity.facts.underlyingCoins.length;
      const balances = trimCurveArray(decodeCurveUint256Array8(required("underlyingBalances"), "curve underlying balances"), count, "curve underlying balances");
      const decimals = trimCurveArray(decodeCurveUint256Array8(required("underlyingDecimals"), "curve underlying decimals"), count, "curve underlying decimals");
      if (decimals.some((value, index) => value !== BigInt(ctx.identity.facts.underlyingDecimals[index]!))) throw new TypeError("curve underlying decimals changed at the current source");
      const offpeg = responses.get("offpegFeeMultiplier")?.dataHex;
      const storedRates = responses.get("storedRates")?.dataHex;
      if ((offpeg === null) !== (storedRates === null)) throw new TypeError("curve NG state exposed only one dynamic-fee getter");
      const variant = offpeg === null ? "plain" as const : "ng" as const;
      const rates = variant === "ng"
        ? trimCurveArray(decodeCurveUint256Array(storedRates!, "curve stored rates"), count, "curve stored rates")
        : decimals.map(value => 10n ** (36n - value));
      if (balances.some(value => value <= 0n) || rates.some(value => value <= 0n)) throw new TypeError("curve state vectors contain a non-positive value");
      const stateFact: CurveStateReadFactsV1 = Object.freeze({ cutoff: ctx.source, pool, variant, A: decodeCurveUint256(required("A"), "curve A").toString(10), fee: decodeCurveUint256(required("fee"), "curve fee").toString(10), balances: Object.freeze(balances.map(value => value.toString(10))), rates: Object.freeze(rates.map(value => value.toString(10))), ...(variant === "ng" ? { offpegFeeMultiplier: decodeCurveUint256(offpeg!, "curve offpeg fee multiplier").toString(10) } : {}), exactAmountOut: decodeCurveUint256(required("exactAmountOut"), "curve get_dy_underlying").toString(10), exactSelectorVariant: ctx.protocolRoute.selectorVariant });
      const materialized = materializeCurveUnderlying({ identity: ctx.identity, read: stateFact });
      if (materialized.status !== "verified") return unavailableFamilySearchStage("state", `state-${materialized.reasonCode}`, { pool: stateFact.pool });
      const payload = canonical({ kind: "curve-underlying-state-facts", version: 1, read: stateFact }); const payloadHash = familySearchPayloadHash("state", payload); const factsRoot = hashDomain("aloha/curve-underlying/state-facts/v1", stateFact); const sourceRequestId = hashDomain("aloha/curve-underlying/search-state-reads/v1", [...responses.values()].map(value => value.requestId)); const artifact = Object.freeze({ kind: "state" as const, status: "verified" as const, source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot, sourceRequestId });
      return Object.freeze({ kind: "verified" as const, artifact });
    } catch (error) { return Object.freeze({ kind: "invalidProgram" as const, stage: "state", code: error instanceof Error ? error.message : "curve-state-invalid" }); }
  };
  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => { try { const ctx = context(request); const state = materializedState(ctx, request.state); const result = coarseCurveUnderlying({ identity: ctx.identity, state, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn }); if (result.status !== "rankable") return unavailableFamilySearchStage("coarse", result.reasonCode, { stateHash: state.stateHash }); return Object.freeze({ kind: "verified" as const, artifact: coarseArtifact(ctx, request.state, state, result.quote) }); } catch (error) { return Object.freeze({ kind: "invalidProgram" as const, stage: "coarse", code: error instanceof Error ? error.message : "curve-coarse-invalid" }); } };
  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => { try { const ctx = context(request); const state = materializedState(ctx, request.state); validateCoarse(ctx, request.state, state, request.coarse); const result = exactCurveUnderlying({ identity: ctx.identity, state, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn }); if (result.status !== "verified") return unavailableFamilySearchStage("exact", result.status === "unavailable" ? result.reasonCode : result.reasonCode, { stateHash: state.stateHash }); if (state.exactSelectorVariant !== ctx.protocolRoute.selectorVariant) throw new TypeError("curve exact selector variant diverges from identity route"); if (state.exactAmountOut === undefined || state.exactAmountOut !== result.quote.amountOut) throw new TypeError("curve exact ABI quote diverges from local kernel quote"); return Object.freeze({ kind: "verified" as const, artifact: exactArtifact(ctx, request.state, result.quote) }); } catch (error) { return Object.freeze({ kind: "invalidProgram" as const, stage: "exact", code: error instanceof Error ? error.message : "curve-exact-invalid" }); } };
  const buildAction: FamilySearchAdapterV1["buildAction"] = request => { try { const ctx = context(request); if (request.exact.kind !== "exact" || request.exact.status !== "verified") return unavailableFamilySearchStage("action", "exact-unavailable", request.exact); const quote = validateExact(ctx, request.exact); return Object.freeze({ kind: "verified" as const, artifact: actionArtifact(ctx, request.exact, quote, actionOwnerRef, actionPort) }); } catch (error) { return Object.freeze({ kind: "invalidProgram" as const, stage: "action", code: error instanceof Error ? error.message : "curve-action-invalid" }); } };
  const run: FamilySearchAdapterV1["run"] = async (request: FamilySearchRunRequestV1) => { const state = await readState(request); if (state.kind !== "verified") return state; const coarse = projectCoarse({ ...request, state: state.artifact }); if (coarse.kind !== "verified") return coarse; if (coarse.artifact.status !== "rankable") return unavailableFamilySearchStage("coarse", coarse.artifact.reasonCode ?? "coarse-unavailable", coarse.artifact); const exact = evaluateExact({ ...request, state: state.artifact, coarse: coarse.artifact }); if (exact.kind !== "verified") return exact; if (exact.artifact.status !== "verified") return unavailableFamilySearchStage("exact", exact.artifact.reasonCode ?? "exact-unavailable", exact.artifact); const action = buildAction({ ...request, exact: exact.artifact }); if (action.kind !== "verified") return action; return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ state: state.artifact, coarse: coarse.artifact, exact: exact.artifact, action: action.artifact }) }); };
  return Object.freeze({ readState, projectCoarse, evaluateExact, buildAction, run });
};
export const CURVE_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
