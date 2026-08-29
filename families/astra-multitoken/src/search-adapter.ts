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
  type FamilySearchLegRequestV1,
  type FamilySearchRunRequestV1,
  type FamilySearchSourceReadResultV1,
  type FamilySearchStateArtifactV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { ASTRA_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { decodeAstraCandidate } from "./discovery.ts";
import { compileAstraInstance } from "./instance.ts";
import { ASTRA_CHANGE_SELECTOR, ASTRA_CHANGE_TOPIC, ASTRA_FAMILY_ID } from "./manifest.ts";
import { encodeAstraGetReturn, decodeAstraUint256 } from "./abi.ts";
import { quoteAstra } from "./pricing.ts";
import { assertAstraRoute, deriveAstraRoutes } from "./routes.ts";
import { verifyAstraIdentity } from "./identity.ts";
import type { Address, AstraIdentityV1, AstraQuoteV1, AstraRouteV1 } from "./types.ts";

type Witness = {
  readonly target: Address;
  readonly actor: Address;
  readonly tokenIn: Address;
  readonly tokenOut: Address;
  readonly amountIn: bigint;
  readonly minAmountOut: bigint;
  readonly observedAmountOut: bigint | null;
  readonly sourceKind: "observed-change-call" | "change-log";
  readonly txHash: Hash;
  readonly logIndex: string;
};

type Memo = {
  readonly kind: "astra-identity-memo";
  readonly version: 1;
  readonly familyDefinitionHash: Hash;
  readonly candidateSnapshotHash: Hash;
  readonly witness: Witness;
  readonly identity: AstraIdentityV1;
};

type StateRead = {
  readonly cutoff: ReturnType<typeof familySearchSource>;
  readonly target: Address;
  readonly activeQuote: string;
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
function address(value: unknown, path: string): Address {
  const valueText = text(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(valueText)) throw new TypeError(`${path} must be an address`);
  return `0x${valueText.slice(2).toLowerCase()}` as Address;
}
function decimal(value: unknown, path: string): string { return assertDecimalString(value, path); }
function hash(value: unknown, path: string): Hash { return assertHash(value, path); }
function canonical(value: unknown): CanonicalJson { return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value))); }
function cutoff(value: unknown, path: string): ReturnType<typeof familySearchSource> { return familySearchSource(value, path); }

function sameSource(left: ReturnType<typeof familySearchSource>, right: ReturnType<typeof familySearchSource>): boolean { return sameFamilySearchSource(left, right); }

function word(value: string): string { return value.slice(2).toLowerCase().padStart(64, "0"); }
function wordAddress(value: string, path: string): Address {
  if (!/^0x[0-9a-f]{64}$/.test(value)) throw new TypeError(`${path} must be an ABI word`);
  return address(`0x${value.slice(-40)}`, path);
}
function decodeBytes(value: string, path: string): CanonicalJson {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError(`${path} must be even-length hex bytes`);
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return decodeCanonicalJson(bytes);
}

function decodeWitness(value: unknown, path: string): Witness {
  const source = exact(value, ["actor", "amountIn", "logIndex", "minAmountOut", "observedAmountOut", "sourceKind", "target", "tokenIn", "tokenOut", "txHash"], path);
  if (source.sourceKind !== "observed-change-call" && source.sourceKind !== "change-log") throw new TypeError(`${path}.sourceKind is invalid`);
  const observedAmountOut = source.observedAmountOut === null ? null : BigInt(decimal(source.observedAmountOut, `${path}.observedAmountOut`));
  if (source.sourceKind === "change-log" && observedAmountOut === null) throw new TypeError(`${path}.observedAmountOut is required for a log witness`);
  return Object.freeze({
    target: address(source.target, `${path}.target`),
    actor: address(source.actor, `${path}.actor`),
    tokenIn: address(source.tokenIn, `${path}.tokenIn`),
    tokenOut: address(source.tokenOut, `${path}.tokenOut`),
    amountIn: BigInt(decimal(source.amountIn, `${path}.amountIn`)),
    minAmountOut: BigInt(decimal(source.minAmountOut, `${path}.minAmountOut`)),
    observedAmountOut,
    sourceKind: source.sourceKind,
    txHash: hash(source.txHash, `${path}.txHash`),
    logIndex: decimal(source.logIndex, `${path}.logIndex`),
  });
}

function witnessCandidate(witness: Witness, source: ReturnType<typeof familySearchSource>, snapshotHash: Hash) {
  const observation = witness.sourceKind === "observed-change-call"
    ? {
      kind: "call" as const,
      target: witness.target,
      sender: witness.actor,
      source,
      blockNumber: source.number,
      blockHash: source.hash,
      txHash: witness.txHash,
      logIndex: witness.logIndex,
      dataHex: `${ASTRA_CHANGE_SELECTOR}${word(witness.tokenIn)}${word(witness.tokenOut)}${witness.amountIn.toString(16).padStart(64, "0")}${witness.minAmountOut.toString(16).padStart(64, "0")}`,
    }
    : {
      kind: "log" as const,
      target: witness.target,
      source,
      blockNumber: source.number,
      blockHash: source.hash,
      txHash: witness.txHash,
      logIndex: witness.logIndex,
      topics: [ASTRA_CHANGE_TOPIC, `0x${word(witness.tokenIn)}`, `0x${word(witness.tokenOut)}`, `0x${word(witness.actor)}`],
      dataHex: `0x${witness.amountIn.toString(16).padStart(64, "0")}${(witness.observedAmountOut ?? 0n).toString(16).padStart(64, "0")}`,
    };
  const candidate = decodeAstraCandidate(observation, witness.sourceKind === "observed-change-call" ? "astra-change-call" : "astra-change-log");
  if (candidate === null || candidate.candidateSnapshotHash !== snapshotHash) throw new TypeError("astra identity witness snapshot mismatch");
  return candidate;
}

function decodeIdentity(value: unknown, path: string): AstraIdentityV1 {
  const source = exact(value, ["activeQuote", "actor", "changeFee", "changesEnabled", "familyDefinitionHash", "familyId", "factsHash", "inLendingMode", "instanceKey", "source", "target", "tokenCodeHashes", "tokens", "totalPercents", "weights"], path);
  if (source.familyId !== ASTRA_FAMILY_ID || source.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH || source.changesEnabled !== true) throw new TypeError("astra identity discriminator mismatch");
  const tokens = fieldArray(source.tokens, (item, itemPath) => address(item, itemPath), `${path}.tokens`);
  const tokenCodeHashes = fieldArray(source.tokenCodeHashes, (item, itemPath) => hash(item, itemPath), `${path}.tokenCodeHashes`);
  const weights = fieldArray(source.weights, (item, itemPath) => BigInt(decimal(item, itemPath)), `${path}.weights`);
  const identity = Object.freeze({
    actor: address(source.actor, `${path}.actor`),
    target: address(source.target, `${path}.target`),
    tokens,
    tokenCodeHashes,
    weights,
    changesEnabled: true as const,
    totalPercents: BigInt(decimal(source.totalPercents, `${path}.totalPercents`)),
    changeFee: BigInt(decimal(source.changeFee, `${path}.changeFee`)),
    inLendingMode: source.inLendingMode === null ? null : BigInt(decimal(source.inLendingMode, `${path}.inLendingMode`)),
    activeQuote: BigInt(decimal(source.activeQuote, `${path}.activeQuote`)),
    source: cutoff(source.source, `${path}.source`),
    factsHash: hash(source.factsHash, `${path}.factsHash`),
    instanceKey: address(source.instanceKey, `${path}.instanceKey`),
  });
  const facts = {
    familyId: ASTRA_FAMILY_ID,
    actor: identity.actor,
    target: identity.target,
    tokens: identity.tokens,
    tokenCodeHashes: identity.tokenCodeHashes,
    weights: identity.weights.map(value => value.toString()),
    changesEnabled: true,
    totalPercents: identity.totalPercents.toString(),
    changeFee: identity.changeFee.toString(),
    inLendingMode: identity.inLendingMode?.toString() ?? null,
    activeQuote: identity.activeQuote.toString(),
    source: identity.source,
  };
  if (identity.target !== identity.instanceKey || identity.factsHash !== hashDomain("aloha/astra-multitoken/identity-facts/v1", facts)) throw new TypeError("astra identity facts lineage mismatch");
  return identity;
}

function decodeMemo(value: unknown, path = "route.identityMemo"): Memo {
  const source = exact(value, ["candidateSnapshotHash", "familyDefinitionHash", "identity", "kind", "version", "witness"], path);
  if (source.kind !== "astra-identity-memo" || source.version !== 1) throw new TypeError("astra identity memo discriminator mismatch");
  const familyDefinitionHash = hash(source.familyDefinitionHash, `${path}.familyDefinitionHash`);
  if (familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH) throw new TypeError("astra identity memo definition mismatch");
  const candidateSnapshotHash = hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`);
  const identity = decodeIdentity(source.identity, `${path}.identity`);
  const witness = decodeWitness(source.witness, `${path}.witness`);
  const memo = Object.freeze({ kind: "astra-identity-memo" as const, version: 1 as const, familyDefinitionHash, candidateSnapshotHash, witness, identity });
  if (identity.target !== witness.target) throw new TypeError("astra identity memo target lineage mismatch");
  const candidate = witnessCandidate(witness, identity.source, candidateSnapshotHash);
  const verified = verifyAstraIdentity({ candidate, reads: { target: identity.target, tokens: identity.tokens, tokenCodeHashes: identity.tokenCodeHashes, weights: identity.weights, changesEnabled: true, totalPercents: identity.totalPercents, changeFee: identity.changeFee, inLendingMode: identity.inLendingMode, activeQuote: identity.activeQuote, source: identity.source } });
  if (verified.status !== "verified" || verified.identity.actor !== identity.actor || verified.identity.factsHash !== identity.factsHash) throw new TypeError("astra identity memo facts mismatch");
  return memo;
}

function protocolAssetRef(chainId: string, asset: string): Hash { return erc20AssetRefV1(chainId, asset); }

interface Context extends FamilySearchLegRequestV1 {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly routeBindingHash: Hash;
  readonly source: ReturnType<typeof familySearchSource>;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly identity: AstraIdentityV1;
  readonly protocolRoute: AstraRouteV1;
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== ASTRA_FAMILY_ID || route.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH) throw new TypeError("astra search route family mismatch");
  const memo = decodeMemo(route.identityMemo);
  if (route.instanceKey !== memo.identity.instanceKey) throw new TypeError("astra search identity memo binding mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const instance = compileAstraInstance(memo.identity);
  const protocolRoute = deriveAstraRoutes(instance).find(item => protocolAssetRef(source.chainId, item.tokenIn) === amount.inputAssetRef && protocolAssetRef(source.chainId, item.tokenOut) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("astra search amount assets do not match identity");
  assertAstraRoute(protocolRoute, instance);
  if (address(amount.recipient, "amount.recipient") !== memo.identity.actor) throw new TypeError("astra search recipient must match observed caller");
  return Object.freeze({ ...input, route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, identity: memo.identity, protocolRoute });
}

function decodeStateFact(value: unknown, path = "astra.stateFact"): StateRead {
  const source = exact(value, ["kind", "read", "version"], path);
  if (source.kind !== "astra-state-facts" || source.version !== 1) throw new TypeError("astra state fact discriminator mismatch");
  const read = exact(source.read, ["activeQuote", "cutoff", "target"], `${path}.read`);
  const activeQuote = decimal(read.activeQuote, `${path}.read.activeQuote`);
  if (BigInt(activeQuote) <= 0n) throw new TypeError(`${path}.read.activeQuote must be positive`);
  return Object.freeze({ cutoff: cutoff(read.cutoff, `${path}.read.cutoff`), target: address(read.target, `${path}.read.target`), activeQuote });
}

function stateRead(ctx: Context, artifact: FamilySearchStateArtifactV1): StateRead {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("astra search state artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("state", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("astra search state artifact hash mismatch");
  const read = decodeStateFact(payload);
  if (!sameSource(read.cutoff, ctx.source) || read.target !== ctx.identity.target || read.activeQuote !== ctx.identity.activeQuote.toString()) throw new TypeError("astra search state lineage mismatch");
  if (artifact.factsRoot !== hashDomain("aloha/astra-multitoken/state-facts/v1", read)) throw new TypeError("astra search state facts root mismatch");
  return read;
}

function quoteJson(quote: AstraQuoteV1): CanonicalJson {
  return canonical({ source: quote.source, routeKey: quote.routeKey, amountIn: quote.amountIn.toString(), amountOut: quote.amountOut.toString(), quoteHash: quote.quoteHash });
}

function quoteFromPayload(ctx: Context, value: unknown, path: string): AstraQuoteV1 {
  const source = exact(value, ["amountIn", "amountOut", "quoteHash", "routeKey", "source"], path);
  const quote = Object.freeze({ source: cutoff(source.source, `${path}.source`), routeKey: text(source.routeKey, `${path}.routeKey`), amountIn: BigInt(decimal(source.amountIn, `${path}.amountIn`)), amountOut: BigInt(decimal(source.amountOut, `${path}.amountOut`)), quoteHash: hash(source.quoteHash, `${path}.quoteHash`) });
  const body = { routeKey: quote.routeKey, source: quote.source, amountIn: quote.amountIn.toString(), amountOut: quote.amountOut.toString(), identityFactsHash: ctx.identity.factsHash };
  if (quote.amountIn <= 0n || quote.amountOut <= 0n || quote.quoteHash !== hashDomain("aloha/astra-multitoken/quote/v1", body)) throw new TypeError("astra search quote hash mismatch");
  return quote;
}

function coarseArtifact(ctx: Context, stateArtifact: FamilySearchStateArtifactV1, state: StateRead, quote: AstraQuoteV1): FamilySearchCoarseArtifactV1 {
  const payload = quoteJson(quote);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  const amountHash = familySearchAmountHash(ctx.amount);
  return Object.freeze({
    kind: "coarse", status: "rankable", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash,
    payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash }),
    projectionHash: hashDomain("aloha/astra-multitoken/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateFactsRoot: stateArtifact.factsRoot, activeQuote: state.activeQuote }), stateFactsRoot: stateArtifact.factsRoot,
    input: { assetRef: ctx.amount.inputAssetRef, amount: ctx.amount.amountIn }, output: { assetRef: ctx.amount.outputAssetRef, amount: quote.amountOut.toString() }, conservativeOutputUpperBound: quote.amountOut.toString(), inputCapacityUpperBound: null,
    rankKey: hashDomain("aloha/astra-multitoken/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash, domain: "observed-effect" }), reasonCode: null,
  });
}

function validateCoarse(ctx: Context, stateArtifact: FamilySearchStateArtifactV1, state: StateRead, artifact: FamilySearchCoarseArtifactV1): AstraQuoteV1 {
  const amountHash = familySearchAmountHash(ctx.amount);
  if (artifact.kind !== "coarse" || artifact.status !== "rankable" || !sameSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash || artifact.objectiveRef !== ctx.objective.objectiveRef || artifact.amountHash !== amountHash) throw new TypeError("astra search coarse artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("coarse", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "coarse", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: ctx.objective.objectiveRef, amountHash, payloadHash })) throw new TypeError("astra search coarse artifact hash mismatch");
  const quote = quoteFromPayload(ctx, payload, "astra.search.coarse.payload");
  if (quote.source.hash !== ctx.source.hash || quote.source.number !== ctx.source.number || quote.routeKey !== ctx.protocolRoute.routeKey || quote.amountIn.toString() !== ctx.amount.amountIn
    || artifact.stateFactsRoot !== stateArtifact.factsRoot || artifact.input.assetRef !== ctx.amount.inputAssetRef || artifact.input.amount !== ctx.amount.amountIn || artifact.output?.assetRef !== ctx.amount.outputAssetRef || artifact.output.amount !== quote.amountOut.toString()
    || artifact.conservativeOutputUpperBound !== quote.amountOut.toString() || artifact.projectionHash !== hashDomain("aloha/astra-multitoken/search-coarse-projection/v1", { quoteHash: quote.quoteHash, stateFactsRoot: stateArtifact.factsRoot, activeQuote: state.activeQuote })
    || artifact.rankKey !== hashDomain("aloha/astra-multitoken/search-coarse-rank/v1", { objectiveRef: ctx.objective.objectiveRef, routeBindingHash: ctx.routeBindingHash, quoteHash: quote.quoteHash, domain: "observed-effect" })) throw new TypeError("astra search coarse artifact lineage mismatch");
  return quote;
}

function invalid(stage: "state" | "coarse" | "exact" | "action", error: unknown) {
  return Object.freeze({ kind: "invalidProgram" as const, stage, code: error instanceof Error ? error.message : String(error) });
}

const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== ASTRA_FAMILY_DEFINITION_HASH) throw new TypeError("astra search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  assertHash(input.actionOwnerRefs.protocol, "astra actionOwnerRefs.protocol");
  input.composition.resolveActionOwner(input.familyDefinitionHash, input.actionOwnerRefs.protocol);

  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      await request.currentSource.assertCurrent();
      const requestId = hashDomain("aloha/astra-multitoken/search-state-request/v1", { route: ctx.routeBindingHash, source: ctx.source });
      let result: FamilySearchSourceReadResultV1;
      try {
        result = await request.readPort.read({ request: { kind: "family-search.current-source-read", requestId, source: ctx.source, target: ctx.identity.target, data: encodeAstraGetReturn(ctx.protocolRoute.tokenIn, ctx.protocolRoute.tokenOut, ctx.amount.amountIn), responseEncoding: "abi-astra-get-return" }, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) });
      } catch (error) {
        return unavailableFamilySearchStage("state", "source-transport-unavailable", { requestId, error: String(error) });
      }
      if (result.kind !== "returned") return unavailableFamilySearchStage("state", result.reasonCode || "source-read-unavailable", result);
      if (result.requestId !== requestId || !sameSource(result.source, ctx.source)) throw new TypeError("astra search source response binding mismatch");
      const activeQuote = decodeAstraUint256(result.dataHex, "astra search getReturn");
      if (activeQuote <= 0n) return unavailableFamilySearchStage("state", "active-quote-empty", { target: ctx.identity.target });
      const read: StateRead = Object.freeze({ cutoff: ctx.source, target: ctx.identity.target, activeQuote: activeQuote.toString() });
      if (!sameSource(read.cutoff, ctx.source) || read.target !== ctx.identity.target) throw new TypeError("astra search state source lineage mismatch");
      const payload = canonical({ kind: "astra-state-facts", version: 1, read });
      const payloadHash = familySearchPayloadHash("state", payload);
      return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ kind: "state" as const, status: "verified" as const, source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: hashDomain("aloha/astra-multitoken/state-facts/v1", read), sourceRequestId: requestId }) });
    } catch (error) { return invalid("state", error); }
  };

  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => {
    try {
      const ctx = context(request);
      const state = stateRead(ctx, request.state);
      const quote = quoteAstra({ identity: ctx.identity, route: ctx.protocolRoute, source: ctx.source, amountIn: BigInt(ctx.amount.amountIn), amountOut: BigInt(state.activeQuote) });
      return Object.freeze({ kind: "verified" as const, artifact: coarseArtifact(ctx, request.state, state, quote) });
    } catch (error) { return invalid("coarse", error); }
  };

  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => {
    try {
      const ctx = context(request);
      const state = stateRead(ctx, request.state);
      validateCoarse(ctx, request.state, state, request.coarse);
      return unavailableFamilySearchStage("exact", "qualified-effect-facts-not-in-release", { familyId: ASTRA_FAMILY_ID, stateFactsRoot: request.state.factsRoot });
    } catch (error) { return invalid("exact", error); }
  };

  const buildAction: FamilySearchAdapterV1["buildAction"] = request => {
    try {
      const ctx = context(request);
      return unavailableFamilySearchStage("action", "qualified-effect-facts-not-in-release", { familyId: ASTRA_FAMILY_ID, routeBindingHash: ctx.routeBindingHash });
    } catch (error) { return invalid("action", error); }
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

export const ASTRA_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
