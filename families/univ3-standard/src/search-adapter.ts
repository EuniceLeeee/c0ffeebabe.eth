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
  type FamilySearchStageOutcomeV1,
  type FamilySearchSourceReadResultV1,
  type FamilySearchStateArtifactV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { UNIV3_STANDARD_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { buildUniV3Action, buildUniV3SearchAction, UNIV3_STANDARD_SWAP_ACTION_PORT } from "./action.ts";
import { exactUniV3 } from "./exact.ts";
import { materializeUniV3 } from "./instance.ts";
import { UNIV3_STANDARD_FAMILY_ID } from "./manifest.ts";
import { coarseUniV3 } from "./pricing.ts";
import { assertUniV3Route, deriveUniV3Routes } from "./routes.ts";
import { decodeUniV3Fee, decodeUniV3Liquidity, decodeUniV3Quoter, decodeUniV3Slot0, decodeUniV3Tick, decodeUniV3TickBitmap, decodeUniV3TickSpacing, encodeUniV3QuoterCall, encodeUniV3StateCall, factoryBoundUniV3Quoter } from "./search-codec.ts";
import {
  canonicalAddress,
  cutoffEqual,
  type UniV3IdentityV1,
  type UniV3MaterializedStateV1,
  type UniV3QuoteV1,
  type UniV3RouteV1,
  type UniV3StateReadFactsV1,
  type UniV3TickBitmapWordV1,
  type UniV3TickLiquidityV1,
} from "./types.ts";

type Memo = {
  readonly kind: "univ3-identity-memo";
  readonly familyId: typeof UNIV3_STANDARD_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSubjectHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: UniV3IdentityV1;
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
function address(value: unknown, path: string): string { return canonicalAddress(text(value, path)); }
function decimal(value: unknown, path: string): string { return assertDecimalString(value, path); }
function hash(value: unknown, path: string): Hash { return assertHash(value, path); }
function integer(value: unknown, path: string): number { if (!Number.isInteger(value)) throw new TypeError(`${path} must be an integer`); return value as number; }
function cutoff(value: unknown, path: string): ReturnType<typeof familySearchSource> { return familySearchSource(value, path); }
function canonical(value: unknown): CanonicalJson { return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value))); }
function sameCutoff(left: ReturnType<typeof familySearchSource>, right: ReturnType<typeof familySearchSource>): boolean { return cutoffEqual(left, right); }

function decodeTickBitmap(value: unknown, path: string): readonly UniV3TickBitmapWordV1[] {
  return Object.freeze(fieldArray(value, (item, itemPath) => {
    const entry = exact(item, ["word", "bits"], itemPath);
    return Object.freeze({ word: integer(entry.word, `${itemPath}.word`), bits: decimal(entry.bits, `${itemPath}.bits`) });
  }, path));
}
function decodeTicks(value: unknown, path: string): readonly UniV3TickLiquidityV1[] {
  return Object.freeze(fieldArray(value, (item, itemPath) => {
    const entry = exact(item, ["liquidityNet", "tick"], itemPath);
    const liquidityNet = text(entry.liquidityNet, `${itemPath}.liquidityNet`);
    if (!/^-?\d+$/.test(liquidityNet)) throw new TypeError(`${itemPath}.liquidityNet must be signed decimal`);
    return Object.freeze({ tick: integer(entry.tick, `${itemPath}.tick`), liquidityNet });
  }, path));
}

function decodeIdentity(value: unknown, path: string): UniV3IdentityV1 {
  const source = exact(value, ["candidateSnapshotHash", "cutoff", "facts", "factsHash", "instanceKey"], path);
  const facts = exact(source.facts, ["factory", "fee", "pool", "reversePool", "tickSpacing", "token0", "token1"], `${path}.facts`);
  const decodedFacts = Object.freeze({
    pool: address(facts.pool, `${path}.facts.pool`),
    factory: address(facts.factory, `${path}.facts.factory`),
    token0: address(facts.token0, `${path}.facts.token0`),
    token1: address(facts.token1, `${path}.facts.token1`),
    fee: decimal(facts.fee, `${path}.facts.fee`),
    tickSpacing: integer(facts.tickSpacing, `${path}.facts.tickSpacing`),
    reversePool: address(facts.reversePool, `${path}.facts.reversePool`),
  });
  const identity = Object.freeze({
    cutoff: cutoff(source.cutoff, `${path}.cutoff`),
    candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`),
    facts: decodedFacts,
    factsHash: hash(source.factsHash, `${path}.factsHash`),
    instanceKey: address(source.instanceKey, `${path}.instanceKey`),
  });
  if (identity.instanceKey !== identity.facts.pool) throw new TypeError("univ3 identity instance mismatch");
  if (identity.factsHash !== hashDomain("aloha/univ3-standard/identity-facts/v1", identity.facts)) throw new TypeError("univ3 identity facts hash mismatch");
  return identity;
}

function decodeMemo(value: unknown, path = "route.identityMemo"): Memo {
  const source = exact(value, ["candidateEvidenceRoot", "candidateSubjectHash", "familyCandidateKey", "familyDefinitionHash", "familyId", "instanceNominationKey", "identity", "kind"], path);
  if (source.kind !== "univ3-identity-memo") throw new TypeError("univ3 identity memo kind mismatch");
  if (source.familyId !== UNIV3_STANDARD_FAMILY_ID) throw new TypeError("univ3 identity memo family mismatch");
  const familyDefinitionHash = hash(source.familyDefinitionHash, `${path}.familyDefinitionHash`);
  if (familyDefinitionHash !== UNIV3_STANDARD_FAMILY_DEFINITION_HASH) throw new TypeError("univ3 identity memo definition mismatch");
  const instanceNominationKey = address(source.instanceNominationKey, `${path}.instanceNominationKey`);
  const memo = Object.freeze({
    kind: "univ3-identity-memo" as const,
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash,
    familyCandidateKey: hash(source.familyCandidateKey, `${path}.familyCandidateKey`),
    instanceNominationKey,
    candidateSubjectHash: hash(source.candidateSubjectHash, `${path}.candidateSubjectHash`),
    candidateEvidenceRoot: hash(source.candidateEvidenceRoot, `${path}.candidateEvidenceRoot`),
    identity: decodeIdentity(source.identity, `${path}.identity`),
  });
  if (memo.familyCandidateKey !== centralFamilyCandidateKey(familyDefinitionHash, instanceNominationKey)) throw new TypeError("univ3 identity memo candidate key mismatch");
  if (memo.candidateSubjectHash !== centralCandidateSubjectHash(familyDefinitionHash, instanceNominationKey) || memo.instanceNominationKey !== memo.identity.instanceKey || memo.candidateSubjectHash !== memo.identity.candidateSnapshotHash) throw new TypeError("univ3 identity memo lineage mismatch");
  return memo;
}

function decodeStateFact(value: unknown, path = "univ3.stateFact"): UniV3StateReadFactsV1 {
  const source = exact(value, ["kind", "read", "version"], path);
  if (source.kind !== "univ3-state-facts" || source.version !== 1) throw new TypeError("univ3 state fact discriminator mismatch");
  const read = record(source.read, `${path}.read`);
  assertExactKeys(read, ["cutoff", "fee", "liquidity", "pool", "sqrtPriceX96", "tick", "tickBitmap", "tickSpacing", "ticks", ...(read.exactAmountOut === undefined ? [] : ["exactAmountOut"])], `${path}.read`);
  return Object.freeze({
    cutoff: cutoff(read.cutoff, `${path}.read.cutoff`),
    pool: address(read.pool, `${path}.read.pool`),
    sqrtPriceX96: decimal(read.sqrtPriceX96, `${path}.read.sqrtPriceX96`),
    tick: integer(read.tick, `${path}.read.tick`),
    liquidity: decimal(read.liquidity, `${path}.read.liquidity`),
    fee: decimal(read.fee, `${path}.read.fee`),
    tickSpacing: integer(read.tickSpacing, `${path}.read.tickSpacing`),
    tickBitmap: decodeTickBitmap(read.tickBitmap, `${path}.read.tickBitmap`),
    ticks: decodeTicks(read.ticks, `${path}.read.ticks`),
    ...(read.exactAmountOut === undefined ? {} : { exactAmountOut: decimal(read.exactAmountOut, `${path}.read.exactAmountOut`) }),
  });
}

function protocolAssetRef(chainId: string, token: string): Hash { return erc20AssetRefV1(chainId, token); }
interface Context extends FamilySearchLegRequestV1 {
  readonly routeBindingHash: Hash;
  readonly source: ReturnType<typeof familySearchSource>;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly identity: UniV3IdentityV1;
  readonly protocolRoute: UniV3RouteV1;
}
function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== UNIV3_STANDARD_FAMILY_ID || route.familyDefinitionHash !== UNIV3_STANDARD_FAMILY_DEFINITION_HASH) throw new TypeError("univ3 search route family mismatch");
  const memo = decodeMemo(route.identityMemo);
  if (hashDomain("aloha/identity-memo/v1", memo) !== route.identityMemoHash) throw new TypeError("univ3 search identity memo hash mismatch");
  if (route.instanceKey !== memo.identity.instanceKey) throw new TypeError("univ3 search route instance mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const protocolRoute = deriveUniV3Routes(memo.identity).find(item => protocolAssetRef(source.chainId, item.inputToken) === amount.inputAssetRef && protocolAssetRef(source.chainId, item.outputToken) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("univ3 search amount assets do not match identity");
  assertUniV3Route(protocolRoute, memo.identity);
  return Object.freeze({ ...input, route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, identity: memo.identity, protocolRoute });
}

function materializedState(ctx: Context, artifact: FamilySearchStateArtifactV1): UniV3MaterializedStateV1 {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("univ3 search state artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("state", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("univ3 search state artifact hash mismatch");
  const read = decodeStateFact(payload);
  if (!sameCutoff(read.cutoff, ctx.source) || read.pool !== ctx.identity.instanceKey) throw new TypeError("univ3 search state lineage mismatch");
  if (artifact.factsRoot !== hashDomain("aloha/univ3-standard/state-facts/v1", read)) throw new TypeError("univ3 search state facts root mismatch");
  const result = materializeUniV3({ identity: ctx.identity, read });
  if (result.status !== "verified") throw new TypeError(`univ3 search state ${result.reasonCode}`);
  return result.state;
}

function quoteFromPayload(value: unknown, path: string): UniV3QuoteV1 {
  const source = exact(value, ["amountIn", "amountOut", "cutoff", "quoteHash", "routeBindingHash", "stateHash"], path);
  const quote = Object.freeze({
    cutoff: cutoff(source.cutoff, `${path}.cutoff`),
    routeBindingHash: hash(source.routeBindingHash, `${path}.routeBindingHash`),
    amountIn: decimal(source.amountIn, `${path}.amountIn`),
    amountOut: decimal(source.amountOut, `${path}.amountOut`),
    stateHash: hash(source.stateHash, `${path}.stateHash`),
    quoteHash: hash(source.quoteHash, `${path}.quoteHash`),
  });
  const body = { cutoff: quote.cutoff, routeBindingHash: quote.routeBindingHash, amountIn: quote.amountIn, amountOut: quote.amountOut, stateHash: quote.stateHash };
  if (quote.quoteHash !== hashDomain("aloha/univ3-standard/quote/v1", body)) throw new TypeError("univ3 search quote hash mismatch");
  return quote;
}

function coarseArtifact(ctx: Context, stateArtifact: FamilySearchStateArtifactV1, state: UniV3MaterializedStateV1, quote: UniV3QuoteV1): FamilySearchCoarseArtifactV1 {
  const payload = canonical(quote);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  const projectionHash = hashDomain("aloha/univ3-standard/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash });
  const rankKey = hashDomain("aloha/univ3-standard/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash });
  const amountHash = familySearchAmountHash(ctx.amount);
  return Object.freeze({
    kind: "coarse", status: "rankable", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash,
    payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash }),
    projectionHash, stateFactsRoot: stateArtifact.factsRoot,
    input: { assetRef: ctx.amount.inputAssetRef, amount: ctx.amount.amountIn }, output: { assetRef: ctx.amount.outputAssetRef, amount: quote.amountOut },
    conservativeOutputUpperBound: quote.amountOut, inputCapacityUpperBound: null, rankKey, reasonCode: null,
  });
}

function validateCoarse(ctx: Context, stateArtifact: FamilySearchStateArtifactV1, state: UniV3MaterializedStateV1, artifact: FamilySearchCoarseArtifactV1): UniV3QuoteV1 {
  const amountHash = familySearchAmountHash(ctx.amount);
  if (artifact.kind !== "coarse" || artifact.status !== "rankable" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== amountHash) throw new TypeError("univ3 search coarse artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash })) throw new TypeError("univ3 search coarse artifact hash mismatch");
  const quote = quoteFromPayload(payload, "univ3.search.coarse.payload");
  if (quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || quote.amountIn !== ctx.amount.amountIn || quote.stateHash !== state.stateHash || artifact.stateFactsRoot !== stateArtifact.factsRoot || artifact.input.assetRef !== ctx.amount.inputAssetRef || artifact.input.amount !== ctx.amount.amountIn || artifact.output?.assetRef !== ctx.amount.outputAssetRef || artifact.output.amount !== quote.amountOut || artifact.projectionHash !== hashDomain("aloha/univ3-standard/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateHash: state.stateHash }) || artifact.rankKey !== hashDomain("aloha/univ3-standard/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash })) throw new TypeError("univ3 search coarse artifact lineage mismatch");
  return quote;
}

function exactArtifact(ctx: Context, stateArtifact: FamilySearchStateArtifactV1, quote: UniV3QuoteV1): FamilySearchExactArtifactV1 {
  const payload = canonical(quote);
  const payloadHash = familySearchPayloadHash("exact", payload);
  const evaluationHash = hashDomain("aloha/univ3-standard/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateHash: quote.stateHash });
  const obligationRoot = hashDomain("aloha/univ3-standard/search-obligation/v1", { evaluationHash, routeBindingHash: ctx.routeBindingHash });
  const amountHash = familySearchAmountHash(ctx.amount);
  return Object.freeze({
    kind: "exact", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash,
    payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash }),
    evaluationHash, stateFactsRoot: stateArtifact.factsRoot,
    inputs: [{ assetRef: ctx.amount.inputAssetRef, amount: quote.amountIn }], outputs: [{ assetRef: ctx.amount.outputAssetRef, amount: quote.amountOut }], obligationRoot, reasonCode: null,
  });
}

function validateExact(ctx: Context, artifact: FamilySearchExactArtifactV1): UniV3QuoteV1 {
  const amountHash = familySearchAmountHash(ctx.amount);
  if (artifact.kind !== "exact" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== amountHash) throw new TypeError("univ3 search exact artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("exact", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "exact", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash })) throw new TypeError("univ3 search exact artifact hash mismatch");
  const quote = quoteFromPayload(payload, "univ3.search.exact.payload");
  const evaluationHash = hashDomain("aloha/univ3-standard/search-exact-evaluation/v1", { quoteHash: quote.quoteHash, stateHash: quote.stateHash });
  if (quote.routeBindingHash !== ctx.protocolRoute.routeBindingHash || quote.amountIn !== ctx.amount.amountIn || artifact.evaluationHash !== evaluationHash || artifact.inputs[0]?.assetRef !== ctx.amount.inputAssetRef || artifact.inputs[0]?.amount !== quote.amountIn || artifact.outputs[0]?.assetRef !== ctx.amount.outputAssetRef || artifact.outputs[0]?.amount !== quote.amountOut || artifact.obligationRoot !== hashDomain("aloha/univ3-standard/search-obligation/v1", { evaluationHash, routeBindingHash: ctx.routeBindingHash })) throw new TypeError("univ3 search exact artifact lineage mismatch");
  return quote;
}

function actionArtifact(ctx: Context, exact: FamilySearchExactArtifactV1, quote: UniV3QuoteV1, actionOwnerRef: Hash): FamilySearchActionArtifactV1 {
  const rawAction = buildUniV3Action({ identity: ctx.identity, route: ctx.protocolRoute, quote, recipient: ctx.amount.recipient, minAmountOut: quote.amountOut });
  const action = buildUniV3SearchAction({ rawAction, quote, route: ctx.protocolRoute, zeroForOne: ctx.protocolRoute.zeroForOne, searchRouteBindingHash: ctx.routeBindingHash, stateFactsRoot: exact.stateFactsRoot, inputs: exact.inputs, outputs: exact.outputs, exactEvaluationHash: exact.evaluationHash, obligationRoot: exact.obligationRoot });
  const payload = canonical(action);
  const payloadHash = familySearchPayloadHash("action", payload);
  const opaqueBytes = encodePackedCallProgram([{ target: rawAction.target as `0x${string}`, value: "0", calldata: rawAction.calldata as `0x${string}` }]);
  const calls = decodePackedCallProgram(opaqueBytes, "univ3 action program");
  if (calls.length !== 1 || calls[0]!.target !== rawAction.target || calls[0]!.value !== "0" || calls[0]!.calldata !== rawAction.calldata) throw new TypeError("univ3 action program binding mismatch");
  return Object.freeze({
    kind: "action", status: "ready", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: familySearchAmountHash(ctx.amount),
    payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "action", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash: familySearchAmountHash(ctx.amount), payloadHash }),
    actionHash: action.actionHash, exactEvaluationHash: exact.evaluationHash, actionOwnerId: UNIV3_STANDARD_SWAP_ACTION_PORT.actionOwnerId, actionOwnerRef,
    opaqueBytes,
    inputs: exact.inputs, outputs: exact.outputs, obligationRoot: exact.obligationRoot,
  });
}

function decodeReadResult(result: FamilySearchSourceReadResultV1, requestId: Hash, source: ReturnType<typeof familySearchSource>): string {
  if (result.kind !== "returned") throw new Error(result.reasonCode || "source-read-unavailable");
  if (result.requestId !== requestId || !sameFamilySearchSource(result.source, source)) throw new TypeError("univ3 search source response binding mismatch");
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(result.dataHex)) throw new TypeError("univ3 search source response is not canonical bytes");
  return result.dataHex.toLowerCase();
}

const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== UNIV3_STANDARD_FAMILY_DEFINITION_HASH) throw new TypeError("univ3 search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  const actionOwnerRef = assertHash(input.actionOwnerRefs.swap, "univ3 actionOwnerRefs.swap");
  input.composition.resolveActionOwner(input.familyDefinitionHash, input.actionOwnerRefs.swap);

  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      const responses = new Map<string, { readonly requestId: Hash; readonly dataHex: string }>();
      type StateReadFailure = Exclude<FamilySearchStageOutcomeV1<null>, { readonly kind: "verified" }>;
      const readOne = async (key: string, physical: ReturnType<typeof encodeUniV3StateCall>): Promise<StateReadFailure | string> => {
        const requestId = hashDomain("aloha/univ3-standard/search-state-read/v1", { route: ctx.routeBindingHash, source: ctx.source, key });
        await request.currentSource.assertCurrent();
        let result: FamilySearchSourceReadResultV1;
        try { result = await request.readPort.read({ request: { kind: "family-search.current-source-read", requestId, source: ctx.source, target: physical.target, data: physical.data, responseEncoding: physical.responseEncoding }, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) }); } catch (error) { return unavailableFamilySearchStage("state", "source-transport-unavailable", { requestId, key, error: String(error) }) as StateReadFailure; }
        if (result.kind !== "returned") return unavailableFamilySearchStage("state", result.reasonCode || "source-read-unavailable", { requestId, key }) as StateReadFailure;
        const dataHex = decodeReadResult(result, requestId, ctx.source);
        responses.set(key, { requestId, dataHex });
        return dataHex;
      };
      const pool = ctx.identity.instanceKey;
      const slot0Raw = await readOne("slot0", encodeUniV3StateCall("slot0", pool));
      if (typeof slot0Raw !== "string") return slot0Raw;
      const liquidityRaw = await readOne("liquidity", encodeUniV3StateCall("liquidity", pool));
      if (typeof liquidityRaw !== "string") return liquidityRaw;
      const feeRaw = await readOne("fee", encodeUniV3StateCall("fee", pool));
      if (typeof feeRaw !== "string") return feeRaw;
      const spacingRaw = await readOne("tickSpacing", encodeUniV3StateCall("tickSpacing", pool));
      if (typeof spacingRaw !== "string") return spacingRaw;
      const slot0 = decodeUniV3Slot0(slot0Raw);
      const fee = decodeUniV3Fee(feeRaw);
      const tickSpacing = decodeUniV3TickSpacing(spacingRaw);
      if (fee !== BigInt(ctx.identity.facts.fee) || tickSpacing !== ctx.identity.facts.tickSpacing) throw new TypeError("univ3 static fee or tick spacing changed at the current source");
      const compressed = Math.floor(slot0.tick / tickSpacing);
      const wordIndex = Math.floor(compressed / 256);
      const bitmapRaw = await readOne(`tickBitmap:${wordIndex}`, encodeUniV3StateCall("tickBitmap", pool, wordIndex));
      if (typeof bitmapRaw !== "string") return bitmapRaw;
      const bitmap = decodeUniV3TickBitmap(bitmapRaw);
      const tickFacts: UniV3TickLiquidityV1[] = [];
      for (let bit = 0; bit < 256; bit += 1) {
        if ((bitmap & (1n << BigInt(bit))) === 0n) continue;
        const tick = (wordIndex * 256 + bit) * tickSpacing;
        if (tick < -887272 || tick > 887272) continue;
        const tickRaw = await readOne(`ticks:${tick}`, encodeUniV3StateCall("ticks", pool, tick));
        if (typeof tickRaw !== "string") return tickRaw;
        const decoded = decodeUniV3Tick(tickRaw, `univ3.ticks(${tick})`);
        if (!decoded.initialized) throw new TypeError(`univ3 bitmap marked uninitialized tick ${tick}`);
        tickFacts.push(Object.freeze({ tick, liquidityNet: decoded.liquidityNet.toString(10) }));
      }
      const quoter = factoryBoundUniV3Quoter(ctx.identity.facts.factory);
      let exactAmountOut: string | undefined;
      if (quoter !== null) {
        const exactPhysical = encodeUniV3QuoterCall({ quoter, tokenIn: ctx.protocolRoute.inputToken, tokenOut: ctx.protocolRoute.outputToken, amountIn: ctx.amount.amountIn, fee: ctx.identity.facts.fee });
        const exactRaw = await readOne("exactAmountOut", exactPhysical);
        if (typeof exactRaw !== "string") return exactRaw;
        exactAmountOut = decodeUniV3Quoter(exactRaw).toString(10);
      }
      await request.currentSource.assertCurrent();
      const stateFact: UniV3StateReadFactsV1 = Object.freeze({ cutoff: ctx.source, pool, sqrtPriceX96: slot0.sqrtPriceX96.toString(10), tick: slot0.tick, liquidity: decodeUniV3Liquidity(liquidityRaw).toString(10), fee: fee.toString(10), tickSpacing, tickBitmap: Object.freeze([{ word: wordIndex, bits: bitmap.toString(10) }]), ticks: Object.freeze(tickFacts), ...(exactAmountOut === undefined ? {} : { exactAmountOut }) });
      const materialized = materializeUniV3({ identity: ctx.identity, read: stateFact });
      if (materialized.status !== "verified") return unavailableFamilySearchStage("state", `state-${materialized.reasonCode}`, { pool: stateFact.pool });
      const payload = canonical({ kind: "univ3-state-facts", version: 1, read: stateFact });
      const payloadHash = familySearchPayloadHash("state", payload);
      const factsRoot = hashDomain("aloha/univ3-standard/state-facts/v1", stateFact);
      const sourceRequestId = hashDomain("aloha/univ3-standard/search-state-reads/v1", [...responses.values()].map(value => value.requestId));
      const artifact = Object.freeze({ kind: "state" as const, status: "verified" as const, source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot, sourceRequestId });
      const resealed = materializeUniV3({ identity: ctx.identity, read: stateFact });
      if (resealed.status !== "verified" || materialized.state.stateHash !== resealed.state.stateHash) throw new TypeError("univ3 search materialization reseal mismatch");
      return Object.freeze({ kind: "verified" as const, artifact });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "state", code: error instanceof Error ? error.message : "univ3-state-invalid" });
    }
  };

  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => {
    try {
      const ctx = context(request);
      const state = materializedState(ctx, request.state);
      const result = coarseUniV3({ identity: ctx.identity, state, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn });
      if (result.status !== "rankable") return unavailableFamilySearchStage("coarse", result.reasonCode, { stateHash: state.stateHash });
      return Object.freeze({ kind: "verified" as const, artifact: coarseArtifact(ctx, request.state, state, result.quote) });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "coarse", code: error instanceof Error ? error.message : "univ3-coarse-invalid" });
    }
  };

  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => {
    try {
      const ctx = context(request);
      const state = materializedState(ctx, request.state);
      validateCoarse(ctx, request.state, state, request.coarse);
      const result = exactUniV3({ identity: ctx.identity, state, route: ctx.protocolRoute, amountIn: ctx.amount.amountIn });
      if (result.status !== "verified") return unavailableFamilySearchStage("exact", result.status === "unavailable" ? result.reasonCode : result.reasonCode, { stateHash: state.stateHash });
      if (state.exactAmountOut !== undefined && state.exactAmountOut !== result.quote.amountOut) throw new TypeError("univ3 exact ABI quote diverges from local swap kernel quote");
      return Object.freeze({ kind: "verified" as const, artifact: exactArtifact(ctx, request.state, result.quote) });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "exact", code: error instanceof Error ? error.message : "univ3-exact-invalid" });
    }
  };

  const buildAction: FamilySearchAdapterV1["buildAction"] = request => {
    try {
      const ctx = context(request);
      if (request.exact.kind !== "exact" || request.exact.status !== "verified") return unavailableFamilySearchStage("action", "exact-unavailable", request.exact);
      const quote = validateExact(ctx, request.exact);
      return Object.freeze({ kind: "verified" as const, artifact: actionArtifact(ctx, request.exact, quote, actionOwnerRef) });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "action", code: error instanceof Error ? error.message : "univ3-action-invalid" });
    }
  };

  const run: FamilySearchAdapterV1["run"] = async (request: FamilySearchRunRequestV1) => {
    const state = await readState(request);
    if (state.kind !== "verified") return state;
    const coarse = projectCoarse({ ...request, state: state.artifact });
    if (coarse.kind !== "verified") return coarse;
    if (coarse.artifact.status !== "rankable") return unavailableFamilySearchStage("coarse", coarse.artifact.reasonCode ?? "coarse-unavailable", coarse.artifact);
    const exact = evaluateExact({ ...request, state: state.artifact, coarse: coarse.artifact });
    if (exact.kind !== "verified") return exact;
    if (exact.artifact.status !== "verified") return unavailableFamilySearchStage("exact", exact.artifact.reasonCode ?? "exact-unavailable", exact.artifact);
    const action = buildAction({ ...request, exact: exact.artifact });
    if (action.kind !== "verified") return action;
    return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ state: state.artifact, coarse: coarse.artifact, exact: exact.artifact, action: action.artifact }) });
  };
  return Object.freeze({ readState, projectCoarse, evaluateExact, buildAction, run });
};

export const UNIV3_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
