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
import {
  familySearchAmount,
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
  type FamilySearchLegRequestV1,
  type FamilySearchRunRequestV1,
  type FamilySearchSourceReadResultV1,
  type FamilySearchStateArtifactV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { MORPHO_FLASH_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { MORPHO_FLASH_FAMILY_ID } from "./manifest.ts";
import { deriveMorphoFlashRoutes, materializeMorphoFlash, assertMorphoFlashRoute } from "./stages.ts";
import { encodeErc20BalanceOf, decodeUint256 } from "./abi.ts";
import type { MorphoFlashIdentityV1, MorphoFlashMaterializedStateV1, MorphoFlashRouteV1, MorphoFlashStateReadFactsV1 } from "./types.ts";

type Memo = {
  readonly kind: "morpho-flash-identity-memo";
  readonly version: 1;
  readonly familyId: typeof MORPHO_FLASH_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly identity: MorphoFlashIdentityV1;
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
  const valueText = text(value, path);
  if (!/^0x[0-9a-fA-F]{40}$/.test(valueText)) throw new TypeError(`${path} must be an address`);
  return valueText.toLowerCase();
}
function decimal(value: unknown, path: string): string { return assertDecimalString(value, path); }
function hash(value: unknown, path: string): Hash { return assertHash(value, path); }
function cutoff(value: unknown, path: string): ReturnType<typeof familySearchSource> { return familySearchSource(value, path); }
function canonical(value: unknown): CanonicalJson { return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value))); }

function decodeIdentity(value: unknown, path: string): MorphoFlashIdentityV1 {
  const source = exact(value, ["candidateSnapshotHash", "cutoff", "facts", "factsHash", "instanceKey"], path);
  const facts = exact(source.facts, ["asset", "feeBps", "lender", "receiver"], `${path}.facts`);
  const decodedFacts = Object.freeze({
    lender: address(facts.lender, `${path}.facts.lender`),
    asset: address(facts.asset, `${path}.facts.asset`),
    receiver: address(facts.receiver, `${path}.facts.receiver`),
    feeBps: decimal(facts.feeBps, `${path}.facts.feeBps`),
  });
  const identity = Object.freeze({
    cutoff: cutoff(source.cutoff, `${path}.cutoff`),
    candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`),
    instanceKey: hash(source.instanceKey, `${path}.instanceKey`),
    factsHash: hash(source.factsHash, `${path}.factsHash`),
    facts: decodedFacts,
  });
  if (identity.facts.asset === identity.facts.receiver || identity.facts.asset === "0x0000000000000000000000000000000000000000" || identity.facts.receiver === "0x0000000000000000000000000000000000000000") throw new TypeError("morpho-flash identity asset binding mismatch");
  if (identity.factsHash !== hashDomain("aloha/morpho-flash/identity-facts/v1", identity.facts) || identity.instanceKey !== hashDomain("aloha/morpho-flash/instance/v1", identity.facts)) throw new TypeError("morpho-flash identity facts lineage mismatch");
  return identity;
}

function decodeMemo(value: unknown, path = "route.identityMemo"): Memo {
  const source = exact(value, ["candidateSnapshotHash", "familyCandidateKey", "familyDefinitionHash", "familyId", "identity", "instanceNominationKey", "kind", "version"], path);
  if (source.kind !== "morpho-flash-identity-memo" || source.version !== 1 || source.familyId !== MORPHO_FLASH_FAMILY_ID) throw new TypeError("morpho-flash identity memo discriminator mismatch");
  const familyDefinitionHash = hash(source.familyDefinitionHash, `${path}.familyDefinitionHash`);
  if (familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("morpho-flash identity memo definition mismatch");
  const instanceNominationKey = address(source.instanceNominationKey, `${path}.instanceNominationKey`);
  const memo = Object.freeze({
    kind: "morpho-flash-identity-memo" as const,
    version: 1 as const,
    familyId: MORPHO_FLASH_FAMILY_ID,
    familyDefinitionHash,
    familyCandidateKey: hash(source.familyCandidateKey, `${path}.familyCandidateKey`),
    instanceNominationKey,
    candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`),
    identity: decodeIdentity(source.identity, `${path}.identity`),
  });
  if (memo.familyCandidateKey !== centralFamilyCandidateKey(familyDefinitionHash, instanceNominationKey) || memo.candidateSnapshotHash !== memo.identity.candidateSnapshotHash) throw new TypeError("morpho-flash identity memo lineage mismatch");
  return memo;
}

function decodeStateFact(value: unknown, path = "morpho-flash.stateFact"): MorphoFlashStateReadFactsV1 {
  const source = exact(value, ["kind", "read", "version"], path);
  if (source.kind !== "morpho-flash-state-facts" || source.version !== 1) throw new TypeError("morpho-flash state fact discriminator mismatch");
  const read = exact(source.read, ["availableLiquidity", "cutoff", "instanceKey"], `${path}.read`);
  return Object.freeze({
    cutoff: cutoff(read.cutoff, `${path}.read.cutoff`),
    instanceKey: hash(read.instanceKey, `${path}.read.instanceKey`),
    availableLiquidity: decimal(read.availableLiquidity, `${path}.read.availableLiquidity`),
  });
}

function decodeBytes(value: string, path: string): CanonicalJson {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError(`${path} must be even-length hex bytes`);
  const bytes = new Uint8Array((value.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16);
  return decodeCanonicalJson(bytes);
}

function protocolAssetRef(chainId: string, asset: string): Hash { return erc20AssetRefV1(chainId, asset); }

interface Context extends FamilySearchLegRequestV1 {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly routeBindingHash: Hash;
  readonly source: ReturnType<typeof familySearchSource>;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly identity: MorphoFlashIdentityV1;
  readonly protocolRoute: MorphoFlashRouteV1;
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== MORPHO_FLASH_FAMILY_ID || route.familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("morpho-flash search route family mismatch");
  const memo = decodeMemo(route.identityMemo);
  if (hashDomain("aloha/identity-memo/v1", memo) !== route.identityMemoHash || route.instanceKey !== memo.identity.instanceKey) throw new TypeError("morpho-flash search identity memo binding mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const protocolRoute = deriveMorphoFlashRoutes(memo.identity)[0];
  if (protocolRoute === undefined || protocolAssetRef(source.chainId, protocolRoute.asset) !== amount.inputAssetRef) throw new TypeError("morpho-flash search input asset does not match identity");
  assertMorphoFlashRoute(protocolRoute, memo.identity);
  address(amount.recipient, "amount.recipient");
  if (amount.recipient !== protocolRoute.receiver) throw new TypeError("morpho-flash search receiver does not match identity");
  // The output ref is intentionally not interpreted as another token.  The
  // generic envelope requires it to differ from inputAssetRef, whereas the
  // Family's funding route has one actual asset on both loan and repayment.
  return Object.freeze({ ...input, route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, identity: memo.identity, protocolRoute });
}

function materializedState(ctx: Context, artifact: FamilySearchStateArtifactV1): MorphoFlashMaterializedStateV1 {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("morpho-flash search state artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("state", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("morpho-flash search state artifact hash mismatch");
  const read = decodeStateFact(payload);
  if (!sameFamilySearchSource(read.cutoff, ctx.source) || read.instanceKey !== ctx.identity.instanceKey) throw new TypeError("morpho-flash search state lineage mismatch");
  if (artifact.factsRoot !== hashDomain("aloha/morpho-flash/state-facts/v1", read)) throw new TypeError("morpho-flash search state facts root mismatch");
  const result = materializeMorphoFlash({ identity: ctx.identity, read });
  if (result.status !== "verified") throw new TypeError(`morpho-flash search state ${result.reasonCode}`);
  return result.state;
}

const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== MORPHO_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("morpho-flash search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  hash(input.actionOwnerRefs.action, "morpho-flash action owner ref");
  input.composition.resolveActionOwner(input.familyDefinitionHash, input.actionOwnerRefs.action);

  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      await request.currentSource.assertCurrent();
      const requestId = hashDomain("aloha/morpho-flash/search-state-request/v1", { route: ctx.routeBindingHash, source: ctx.source });
      let result: FamilySearchSourceReadResultV1;
      try {
        result = await request.readPort.read({ request: { kind: "family-search.current-source-read", requestId, source: ctx.source, target: ctx.identity.facts.asset, data: encodeErc20BalanceOf(ctx.protocolRoute.lender), responseEncoding: "abi-erc20-balance-of" }, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) });
      } catch (error) {
        return unavailableFamilySearchStage("state", "source-transport-unavailable", { requestId, error: String(error) });
      }
      if (result.kind !== "returned") return unavailableFamilySearchStage("state", result.reasonCode || "source-read-unavailable", result);
      if (result.requestId !== requestId || !sameFamilySearchSource(result.source, ctx.source)) throw new TypeError("morpho-flash search source response binding mismatch");
      const availableLiquidity = decodeUint256(result.dataHex, "morpho-flash search balanceOf");
      const read: MorphoFlashStateReadFactsV1 = Object.freeze({ cutoff: ctx.source, instanceKey: ctx.identity.instanceKey, availableLiquidity: availableLiquidity.toString() });
      const materialized = materializeMorphoFlash({ identity: ctx.identity, read });
      if (materialized.status !== "verified") return unavailableFamilySearchStage("state", `state-${materialized.reasonCode}`, { instanceKey: ctx.identity.instanceKey });
      const payload = canonical({ kind: "morpho-flash-state-facts", version: 1, read });
      const payloadHash = familySearchPayloadHash("state", payload);
      const artifact = Object.freeze({ kind: "state" as const, status: "verified" as const, source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: hashDomain("aloha/morpho-flash/state-facts/v1", read), sourceRequestId: requestId });
      return Object.freeze({ kind: "verified" as const, artifact });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "state", code: error instanceof Error ? error.message : "morpho-flash-state-invalid" });
    }
  };

  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => {
    try {
      const ctx = context(request);
      const state = materializedState(ctx, request.state);
      return unavailableFamilySearchStage("coarse", "qualified-funding-offer-not-in-release", { familyId: MORPHO_FLASH_FAMILY_ID, stateHash: state.stateHash });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "coarse", code: error instanceof Error ? error.message : "morpho-flash-coarse-invalid" });
    }
  };

  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => {
    try {
      const ctx = context(request);
      const state = materializedState(ctx, request.state);
      return unavailableFamilySearchStage("exact", "qualified-funding-program-not-in-release", { familyId: MORPHO_FLASH_FAMILY_ID, stateHash: state.stateHash });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "exact", code: error instanceof Error ? error.message : "morpho-flash-exact-invalid" });
    }
  };

  const buildAction: FamilySearchAdapterV1["buildAction"] = request => {
    try {
      const ctx = context(request);
      return unavailableFamilySearchStage("action", "qualified-funding-program-not-in-release", { familyId: MORPHO_FLASH_FAMILY_ID, routeBindingHash: ctx.routeBindingHash });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "action", code: error instanceof Error ? error.message : "morpho-flash-action-invalid" });
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

export const MORPHO_FLASH_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
