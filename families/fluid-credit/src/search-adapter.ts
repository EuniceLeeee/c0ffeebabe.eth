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
import { FLUID_CREDIT_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import {
  assertFluidCreditRoute,
  deriveFluidCreditRoutes,
  materializeFluidCredit,
} from "./stages.ts";
import { FLUID_CREDIT_FAMILY_ID } from "./manifest.ts";
import { decodeUint256, encodeErc20BalanceOf } from "./abi.ts";
import type {
  FluidCreditIdentityV1,
  FluidCreditMaterializedStateV1,
  FluidCreditRouteV1,
  FluidCreditStateReadFactsV1,
} from "./types.ts";

type Memo = {
  readonly kind: "fluid-credit-identity-memo";
  readonly version: 1;
  readonly familyId: typeof FLUID_CREDIT_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: FluidCreditIdentityV1;
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

function decodeDecimals(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 36) throw new TypeError(`${path} decimals invalid`);
  return value as number;
}

function decodeIdentity(value: unknown, path: string): FluidCreditIdentityV1 {
  const source = exact(value, ["candidateSnapshotHash", "cutoff", "facts", "factsHash", "instanceKey"], path);
  const facts = exact(source.facts, ["activeProbeActor", "collateralAsset", "collateralDecimals", "debtAsset", "debtDecimals", "factory", "vault", "vaultId"], `${path}.facts`);
  const decodedFacts = Object.freeze({
    vault: address(facts.vault, `${path}.facts.vault`),
    factory: address(facts.factory, `${path}.facts.factory`),
    vaultId: decimal(facts.vaultId, `${path}.facts.vaultId`),
    collateralAsset: address(facts.collateralAsset, `${path}.facts.collateralAsset`),
    debtAsset: address(facts.debtAsset, `${path}.facts.debtAsset`),
    collateralDecimals: decodeDecimals(facts.collateralDecimals, `${path}.facts.collateralDecimals`),
    debtDecimals: decodeDecimals(facts.debtDecimals, `${path}.facts.debtDecimals`),
    activeProbeActor: address(facts.activeProbeActor, `${path}.facts.activeProbeActor`),
  });
  const identity = Object.freeze({
    cutoff: cutoff(source.cutoff, `${path}.cutoff`),
    candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`),
    instanceKey: hash(source.instanceKey, `${path}.instanceKey`),
    factsHash: hash(source.factsHash, `${path}.factsHash`),
    facts: decodedFacts,
  });
  if (identity.facts.collateralAsset === identity.facts.debtAsset) throw new TypeError("fluid-credit identity assets must differ");
  if (identity.factsHash !== hashDomain("aloha/fluid-credit/identity-facts/v1", identity.facts)
    || identity.instanceKey !== hashDomain("aloha/fluid-credit/instance/v1", identity.facts)) throw new TypeError("fluid-credit identity facts lineage mismatch");
  return identity;
}

function decodeMemo(value: unknown, path = "route.identityMemo"): Memo {
  const source = exact(value, ["candidateEvidenceRoot", "candidateSnapshotHash", "familyCandidateKey", "familyDefinitionHash", "familyId", "identity", "instanceNominationKey", "kind", "version"], path);
  if (source.kind !== "fluid-credit-identity-memo" || source.version !== 1 || source.familyId !== FLUID_CREDIT_FAMILY_ID) throw new TypeError("fluid-credit identity memo discriminator mismatch");
  const familyDefinitionHash = hash(source.familyDefinitionHash, `${path}.familyDefinitionHash`);
  if (familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-credit identity memo definition mismatch");
  const instanceNominationKey = address(source.instanceNominationKey, `${path}.instanceNominationKey`);
  const memo = Object.freeze({
    kind: "fluid-credit-identity-memo" as const,
    version: 1 as const,
    familyId: FLUID_CREDIT_FAMILY_ID,
    familyDefinitionHash,
    familyCandidateKey: hash(source.familyCandidateKey, `${path}.familyCandidateKey`),
    instanceNominationKey,
    candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`),
    candidateEvidenceRoot: hash(source.candidateEvidenceRoot, `${path}.candidateEvidenceRoot`),
    identity: decodeIdentity(source.identity, `${path}.identity`),
  });
  if (memo.familyCandidateKey !== centralFamilyCandidateKey(familyDefinitionHash, instanceNominationKey)
    || memo.candidateSnapshotHash !== memo.identity.candidateSnapshotHash
    || memo.instanceNominationKey !== memo.identity.facts.vault) throw new TypeError("fluid-credit identity memo lineage mismatch");
  return memo;
}

function decodeStateFact(value: unknown, path = "fluid-credit.stateFact"): FluidCreditStateReadFactsV1 {
  const source = exact(value, ["kind", "read", "version"], path);
  if (source.kind !== "fluid-credit-state-facts" || source.version !== 1) throw new TypeError("fluid-credit state fact discriminator mismatch");
  const read = exact(source.read, ["availableCollateral", "cutoff", "debtCapacity", "instanceKey"], `${path}.read`);
  return Object.freeze({
    cutoff: cutoff(read.cutoff, `${path}.read.cutoff`),
    instanceKey: hash(read.instanceKey, `${path}.read.instanceKey`),
    availableCollateral: decimal(read.availableCollateral, `${path}.read.availableCollateral`),
    debtCapacity: decimal(read.debtCapacity, `${path}.read.debtCapacity`),
  });
}

function protocolAssetRef(chainId: string, asset: string): Hash { return erc20AssetRefV1(chainId, asset); }

interface Context extends FamilySearchLegRequestV1 {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly routeBindingHash: Hash;
  readonly source: ReturnType<typeof familySearchSource>;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly identity: FluidCreditIdentityV1;
  readonly protocolRoute: FluidCreditRouteV1;
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== FLUID_CREDIT_FAMILY_ID || route.familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-credit search route family mismatch");
  const memo = decodeMemo(route.identityMemo);
  if (hashDomain("aloha/identity-memo/v1", memo) !== route.identityMemoHash || route.instanceKey !== memo.identity.instanceKey) throw new TypeError("fluid-credit search identity memo binding mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const protocolRoute = deriveFluidCreditRoutes(memo.identity).find(item => protocolAssetRef(source.chainId, item.collateralAsset) === amount.inputAssetRef && protocolAssetRef(source.chainId, item.debtAsset) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("fluid-credit search amount assets do not match identity");
  assertFluidCreditRoute(protocolRoute, memo.identity);
  address(amount.recipient, "amount.recipient");
  return Object.freeze({ ...input, route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, identity: memo.identity, protocolRoute });
}

function materializedState(ctx: Context, artifact: FamilySearchStateArtifactV1): FluidCreditMaterializedStateV1 {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("fluid-credit search state artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("state", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("fluid-credit search state artifact hash mismatch");
  const read = decodeStateFact(payload);
  if (!sameFamilySearchSource(read.cutoff, ctx.source) || read.instanceKey !== ctx.identity.instanceKey) throw new TypeError("fluid-credit search state lineage mismatch");
  if (artifact.factsRoot !== hashDomain("aloha/fluid-credit/state-facts/v1", read)) throw new TypeError("fluid-credit search state facts root mismatch");
  const result = materializeFluidCredit({ identity: ctx.identity, read });
  if (result.status !== "verified") throw new TypeError(`fluid-credit search state ${result.reasonCode}`);
  return result.state;
}

function invalid(stage: "state" | "coarse" | "exact" | "action", error: unknown) {
  return Object.freeze({ kind: "invalidProgram" as const, stage, code: error instanceof Error ? error.message : String(error) });
}

function stateRequest(ctx: Context, kind: "availableCollateral" | "debtCapacity") {
  const root = hashDomain("aloha/fluid-credit/search-state-request/v2", { routeBindingHash: ctx.routeBindingHash, source: ctx.source });
  const requestId = hashDomain("aloha/fluid-credit/search-state-request-part/v1", { root, kind });
  const token = kind === "availableCollateral" ? ctx.identity.facts.collateralAsset : ctx.identity.facts.debtAsset;
  return Object.freeze({
    request: Object.freeze({
      kind: "family-search.current-source-read" as const,
      requestId,
      source: ctx.source,
      target: token,
      data: encodeErc20BalanceOf(ctx.identity.facts.vault),
      responseEncoding: "abi-erc20-balance-of" as const,
    }),
    requestId,
    kind,
  });
}

function readResult(result: FamilySearchSourceReadResultV1, requestId: Hash, source: ReturnType<typeof familySearchSource>, path: string): bigint {
  if (result.kind !== "returned") throw new Error(result.reasonCode || "source-read-unavailable");
  if (result.requestId !== requestId || !sameFamilySearchSource(result.source, source)) throw new TypeError("fluid-credit search source response binding mismatch");
  return decodeUint256(result.dataHex, path);
}

const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== FLUID_CREDIT_FAMILY_DEFINITION_HASH) throw new TypeError("fluid-credit search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  assertHash(input.actionOwnerRefs.action, "fluid-credit actionOwnerRefs.action");
  input.composition.resolveActionOwner(input.familyDefinitionHash, input.actionOwnerRefs.action);

  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      await request.currentSource.assertCurrent();
      const requests = [stateRequest(ctx, "availableCollateral"), stateRequest(ctx, "debtCapacity")];
      const results = await Promise.all(requests.map(async physical => {
        try {
          return await request.readPort.read({ request: physical.request, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) });
        } catch (error) {
          return Object.freeze({ kind: "unavailable" as const, requestId: physical.requestId, source: ctx.source, reasonCode: String(error) });
        }
      }));
      const availableCollateral = readResult(results[0]!, requests[0]!.requestId, ctx.source, "fluid-credit.availableCollateral");
      const debtCapacity = readResult(results[1]!, requests[1]!.requestId, ctx.source, "fluid-credit.debtCapacity");
      const read: FluidCreditStateReadFactsV1 = Object.freeze({ cutoff: ctx.source, instanceKey: ctx.identity.instanceKey, availableCollateral: availableCollateral.toString(10), debtCapacity: debtCapacity.toString(10) });
      const materialized = materializeFluidCredit({ identity: ctx.identity, read });
      if (materialized.status !== "verified") return unavailableFamilySearchStage("state", `state-${materialized.reasonCode}`, { instanceKey: ctx.identity.instanceKey });
      const payload = canonical({ kind: "fluid-credit-state-facts", version: 1, read });
      const payloadHash = familySearchPayloadHash("state", payload);
      return Object.freeze({ kind: "verified" as const, artifact: Object.freeze({ kind: "state" as const, status: "verified" as const, source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: hashDomain("aloha/fluid-credit/state-facts/v1", read), sourceRequestId: requests[0]!.requestId }) });
    } catch (error) { return invalid("state", error); }
  };

  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => {
    try {
      const ctx = context(request);
      const state = materializedState(ctx, request.state);
      return unavailableFamilySearchStage("coarse", "qualified-credit-terms-not-in-release", { familyId: FLUID_CREDIT_FAMILY_ID, stateHash: state.stateHash });
    } catch (error) { return invalid("coarse", error); }
  };

  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => {
    try {
      const ctx = context(request);
      const state = materializedState(ctx, request.state);
      return unavailableFamilySearchStage("exact", "qualified-credit-effects-not-in-release", { familyId: FLUID_CREDIT_FAMILY_ID, stateHash: state.stateHash });
    } catch (error) { return invalid("exact", error); }
  };

  const buildAction: FamilySearchAdapterV1["buildAction"] = request => {
    try {
      const ctx = context(request);
      return unavailableFamilySearchStage("action", "qualified-credit-effects-not-in-release", { familyId: FLUID_CREDIT_FAMILY_ID, routeBindingHash: ctx.routeBindingHash });
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

export const FLUID_CREDIT_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
