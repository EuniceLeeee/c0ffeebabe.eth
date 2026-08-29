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
import { candidateSubjectHash, familyCandidateKey as centralFamilyCandidateKey } from "../../../packages/discovery/src/index.ts";
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
import { BALANCER_FLASH_FAMILY_DEFINITION_HASH } from "./family-definition.ts";
import { materializeBalancerFlash, assertBalancerFlashRoute, deriveBalancerFlashRoutes } from "./stages.ts";
import { BALANCER_FLASH_FAMILY_ID } from "./manifest.ts";
import { decodeUint256, encodeErc20BalanceOf } from "./abi.ts";
import type { BalancerFlashIdentityV1, BalancerFlashMaterializedStateV1, BalancerFlashRouteV1, BalancerFlashStateReadFactsV1 } from "./types.ts";

type Memo = {
  readonly kind: "balancer-flash-identity-memo";
  readonly familyId: typeof BALANCER_FLASH_FAMILY_ID;
  readonly familyDefinitionHash: Hash;
  readonly familyCandidateKey: Hash;
  readonly instanceNominationKey: string;
  readonly candidateSnapshotHash: Hash;
  readonly candidateEvidenceRoot: Hash;
  readonly identity: BalancerFlashIdentityV1;
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
function sameCutoff(left: ReturnType<typeof familySearchSource>, right: ReturnType<typeof familySearchSource>): boolean { return sameFamilySearchSource(left, right); }

function decodeIdentity(value: unknown, path: string): BalancerFlashIdentityV1 {
  const source = exact(value, ["candidateSnapshotHash", "cutoff", "facts", "factsHash", "instanceKey"], path);
  const facts = exact(source.facts, ["inputAsset", "outputAsset", "target"], `${path}.facts`);
  const decodedFacts = Object.freeze({
    target: address(facts.target, `${path}.facts.target`),
    inputAsset: address(facts.inputAsset, `${path}.facts.inputAsset`),
    outputAsset: address(facts.outputAsset, `${path}.facts.outputAsset`),
  });
  const identity = Object.freeze({
    cutoff: cutoff(source.cutoff, `${path}.cutoff`),
    candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`),
    instanceKey: address(source.instanceKey, `${path}.instanceKey`),
    factsHash: hash(source.factsHash, `${path}.factsHash`),
    facts: decodedFacts,
  });
  if (identity.instanceKey !== identity.facts.target || identity.facts.inputAsset === identity.facts.outputAsset) throw new TypeError("balancer-flash identity facts invalid");
  if (identity.factsHash !== hashDomain("aloha/balancer-flash/identity-facts/v1", identity.facts)) throw new TypeError("balancer-flash identity facts hash mismatch");
  return identity;
}

function decodeMemo(value: unknown, path = "route.identityMemo"): Memo {
  const source = exact(value, ["candidateEvidenceRoot", "candidateSnapshotHash", "familyCandidateKey", "familyDefinitionHash", "familyId", "identity", "instanceNominationKey", "kind"], path);
  if (source.kind !== "balancer-flash-identity-memo" || source.familyId !== BALANCER_FLASH_FAMILY_ID) throw new TypeError("balancer-flash identity memo discriminator mismatch");
  const familyDefinitionHash = hash(source.familyDefinitionHash, `${path}.familyDefinitionHash`);
  if (familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("balancer-flash identity memo definition mismatch");
  const instanceNominationKey = text(source.instanceNominationKey, `${path}.instanceNominationKey`);
  const memo = Object.freeze({
    kind: "balancer-flash-identity-memo" as const,
    familyId: BALANCER_FLASH_FAMILY_ID,
    familyDefinitionHash,
    familyCandidateKey: hash(source.familyCandidateKey, `${path}.familyCandidateKey`),
    instanceNominationKey,
    candidateSnapshotHash: hash(source.candidateSnapshotHash, `${path}.candidateSnapshotHash`),
    candidateEvidenceRoot: hash(source.candidateEvidenceRoot, `${path}.candidateEvidenceRoot`),
    identity: decodeIdentity(source.identity, `${path}.identity`),
  });
  if (memo.familyCandidateKey !== centralFamilyCandidateKey(familyDefinitionHash, instanceNominationKey)
    || memo.instanceNominationKey !== memo.identity.instanceKey
    || memo.candidateSnapshotHash !== candidateSubjectHash(familyDefinitionHash, instanceNominationKey)
    || memo.candidateSnapshotHash !== memo.identity.candidateSnapshotHash) throw new TypeError("balancer-flash identity memo lineage mismatch");
  return memo;
}

function decodeStateFact(value: unknown, path = "balancer-flash.stateFact"): BalancerFlashStateReadFactsV1 {
  const source = exact(value, ["kind", "read", "version"], path);
  if (source.kind !== "balancer-flash-state-facts" || source.version !== 1) throw new TypeError("balancer-flash state fact discriminator mismatch");
  const read = exact(source.read, ["cutoff", "instanceKey", "reserveIn", "reserveOut"], `${path}.read`);
  return Object.freeze({
    cutoff: cutoff(read.cutoff, `${path}.read.cutoff`),
    instanceKey: address(read.instanceKey, `${path}.read.instanceKey`),
    reserveIn: decimal(read.reserveIn, `${path}.read.reserveIn`),
    reserveOut: decimal(read.reserveOut, `${path}.read.reserveOut`),
  });
}

interface Context extends FamilySearchLegRequestV1 {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly routeBindingHash: Hash;
  readonly source: ReturnType<typeof familySearchSource>;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly identity: BalancerFlashIdentityV1;
  readonly protocolRoute: BalancerFlashRouteV1;
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== BALANCER_FLASH_FAMILY_ID || route.familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("balancer-flash search route family mismatch");
  const memo = decodeMemo(route.identityMemo);
  if (hashDomain("aloha/identity-memo/v1", memo) !== route.identityMemoHash || route.instanceKey !== memo.identity.instanceKey) throw new TypeError("balancer-flash search identity memo binding mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const protocolAssetRef = (token: string): Hash => erc20AssetRefV1(source.chainId, token);
  const protocolRoute = deriveBalancerFlashRoutes(memo.identity).find(item => protocolAssetRef(item.inputAsset) === amount.inputAssetRef && protocolAssetRef(item.outputAsset) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("balancer-flash search amount assets do not match identity");
  assertBalancerFlashRoute(protocolRoute, memo.identity);
  address(amount.recipient, "amount.recipient");
  return Object.freeze({ ...input, route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, identity: memo.identity, protocolRoute });
}

function materializedState(ctx: Context, artifact: FamilySearchStateArtifactV1): BalancerFlashMaterializedStateV1 {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameFamilySearchSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("balancer-flash search state artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("state", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("balancer-flash search state artifact hash mismatch");
  const read = decodeStateFact(payload);
  if (!sameCutoff(read.cutoff, ctx.source) || read.instanceKey !== ctx.identity.instanceKey) throw new TypeError("balancer-flash search state lineage mismatch");
  if (artifact.factsRoot !== hashDomain("aloha/balancer-flash/state-facts/v1", read)) throw new TypeError("balancer-flash search state facts root mismatch");
  const result = materializeBalancerFlash({ identity: ctx.identity, read });
  if (result.status !== "verified") throw new TypeError(`balancer-flash search state ${result.reasonCode}`);
  return result.state;
}

function decodeReadResult(result: FamilySearchSourceReadResultV1, requestId: Hash, source: ReturnType<typeof familySearchSource>): string {
  if (result.kind !== "returned") throw new Error(result.reasonCode || "source-read-unavailable");
  if (result.requestId !== requestId || !sameFamilySearchSource(result.source, source)) throw new TypeError("balancer-flash search source response binding mismatch");
  return result.dataHex;
}

function stateRequest(ctx: Context, kind: "reserveIn" | "reserveOut") {
  const root = hashDomain("aloha/balancer-flash/search-state-request/v2", { routeBindingHash: ctx.routeBindingHash, source: ctx.source });
  const requestId = hashDomain("aloha/balancer-flash/search-state-request-part/v1", { root, kind });
  const token = kind === "reserveIn" ? ctx.identity.facts.inputAsset : ctx.identity.facts.outputAsset;
  return Object.freeze({
    request: Object.freeze({
      kind: "family-search.current-source-read" as const,
      requestId,
      source: ctx.source,
      target: token,
      data: encodeErc20BalanceOf(ctx.identity.facts.target),
      responseEncoding: "abi-erc20-balance-of" as const,
    }),
    requestId,
    kind,
  });
}

const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== BALANCER_FLASH_FAMILY_DEFINITION_HASH) throw new TypeError("balancer-flash search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  assertHash(input.actionOwnerRefs.action, "balancer-flash actionOwnerRefs.action");
  input.composition.resolveActionOwner(input.familyDefinitionHash, input.actionOwnerRefs.action);

  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      await request.currentSource.assertCurrent();
      const requests = [stateRequest(ctx, "reserveIn"), stateRequest(ctx, "reserveOut")];
      const results = await Promise.all(requests.map(async physical => {
        try {
          return await request.readPort.read({ request: physical.request, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) });
        } catch (error) {
          return Object.freeze({ kind: "unavailable" as const, requestId: physical.requestId, source: ctx.source, reasonCode: String(error) });
        }
      }));
      const values = results.map((result, index) => decodeUint256(decodeReadResult(result, requests[index]!.requestId, ctx.source), `balancer-flash search ${requests[index]!.kind}`));
      const read: BalancerFlashStateReadFactsV1 = Object.freeze({ cutoff: ctx.source, instanceKey: ctx.identity.instanceKey, reserveIn: values[0]!.toString(10), reserveOut: values[1]!.toString(10) });
      const materialized = materializeBalancerFlash({ identity: ctx.identity, read });
      if (materialized.status !== "verified") return unavailableFamilySearchStage("state", `state-${materialized.reasonCode}`, { instanceKey: ctx.identity.instanceKey });
      const payload = canonical({ kind: "balancer-flash-state-facts", version: 1, read });
      const payloadHash = familySearchPayloadHash("state", payload);
      const artifact = Object.freeze({ kind: "state" as const, status: "verified" as const, source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: hashDomain("aloha/balancer-flash/state-facts/v1", read), sourceRequestId: requests[0]!.requestId });
      return Object.freeze({ kind: "verified" as const, artifact });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "state", code: error instanceof Error ? error.message : "balancer-flash-state-invalid" });
    }
  };

  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => {
    try {
      const ctx = context(request);
      const state = materializedState(ctx, request.state);
      return unavailableFamilySearchStage("coarse", "qualified-funding-offer-not-in-release", { familyId: BALANCER_FLASH_FAMILY_ID, stateHash: state.stateHash });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "coarse", code: error instanceof Error ? error.message : "balancer-flash-coarse-invalid" });
    }
  };

  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => {
    try {
      const ctx = context(request);
      const state = materializedState(ctx, request.state);
      return unavailableFamilySearchStage("exact", "qualified-funding-offer-not-in-release", { familyId: BALANCER_FLASH_FAMILY_ID, stateHash: state.stateHash });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "exact", code: error instanceof Error ? error.message : "balancer-flash-exact-invalid" });
    }
  };

  const buildAction: FamilySearchAdapterV1["buildAction"] = request => {
    try {
      const ctx = context(request);
      return unavailableFamilySearchStage("action", "qualified-funding-offer-not-in-release", { familyId: BALANCER_FLASH_FAMILY_ID, routeBindingHash: ctx.routeBindingHash });
    } catch (error) {
      return Object.freeze({ kind: "invalidProgram" as const, stage: "action", code: error instanceof Error ? error.message : "balancer-flash-action-invalid" });
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

export const BALANCER_FLASH_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
