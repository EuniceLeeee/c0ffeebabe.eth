import {
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
import { erc20AssetRefV1, nativeAssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
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
  type FamilySearchLegRequestV1,
  type FamilySearchRunRequestV1,
  type FamilySearchSourceReadResultV1,
  type FamilySearchStateArtifactV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH } from "./family-definition.ts";
import { SELF_BURN_NATIVE_FAMILY_ID } from "./manifest.ts";
import { deriveSelfBurnNativeRoutes, assertSelfBurnNativeRoute } from "./routes.ts";
import { canonicalAddress, type SelfBurnNativeIdentityV1, type SelfBurnNativeRouteV1 } from "./types.ts";

const TRANSFER_SELECTOR = "0xa9059cbb" as const;
type Address = `0x${string}`;
type Source = ReturnType<typeof familySearchSource>;
type Context = {
  readonly route: ReturnType<typeof validateFamilySearchRouteLegBinding>;
  readonly routeBindingHash: Hash;
  readonly source: Source;
  readonly objective: ReturnType<typeof familySearchObjective>;
  readonly amount: ReturnType<typeof familySearchAmount>;
  readonly amountHash: Hash;
  readonly identity: SelfBurnNativeIdentityV1;
  readonly protocolRoute: SelfBurnNativeRouteV1;
};
type StateResponse = {
  readonly kind: "self-burn-native-state-read-response";
  readonly requestId: Hash;
  readonly source: Source;
  readonly routeBindingHash: Hash;
  readonly amountHash: Hash;
  readonly instanceKey: string;
  readonly returnDataHex: string;
  readonly stateHash: Hash;
};

function canonical(value: unknown): CanonicalJson {
  return deepFreeze(decodeCanonicalJson(encodeCanonicalJson(value)));
}
function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object`);
  return value as Record<string, unknown>;
}
function text(value: unknown, path: string): string { return assertNonEmptyString(value, path); }
function address(value: unknown, path: string): Address { return canonicalAddress(text(value, path)) as Address; }
function bytes(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(result)) throw new TypeError(`${path} must be even-length hex bytes`);
  return result.toLowerCase();
}
function sameSource(left: Source, right: Source): boolean { return sameFamilySearchSource(left, right); }
function assetRef(chainId: string, value: string): Hash { return value === "native" ? nativeAssetRefV1(chainId) : erc20AssetRefV1(chainId, value); }
function invalid(stage: "state" | "coarse" | "exact" | "action", error: unknown) {
  return Object.freeze({ kind: "invalidProgram" as const, stage, code: error instanceof Error ? error.message : `${stage}-invalid` });
}
function unavailable(stage: "state" | "coarse" | "exact" | "action", reasonCode: string, evidence: unknown) {
  return unavailableFamilySearchStage(stage, `self-burn-native-${reasonCode}`, canonical(evidence));
}
function word(value: bigint, path: string): string {
  if (value < 0n || value >= (1n << 256n)) throw new RangeError(`${path} is outside uint256`);
  return value.toString(16).padStart(64, "0");
}
function addressWord(value: unknown, path: string): string { return address(value, path).slice(2).padStart(64, "0"); }
function call(selector: string, words: readonly string[]): string {
  if (!/^0x[0-9a-fA-F]{8}$/.test(selector)) throw new TypeError("self-burn-native selector is not canonical");
  return `${selector}${words.join("")}`.toLowerCase();
}
function abiBool(value: string, path: string): string {
  const result = bytes(value, path);
  if (result.length !== 66 || !/^0{63}[01]$/.test(result.slice(2))) throw new TypeError(`${path} must be one canonical ABI bool word`);
  if (!result.endsWith("1")) throw new TypeError(`${path} transfer returned false`);
  return result;
}

function decodeIdentity(value: unknown): SelfBurnNativeIdentityV1 {
  const outer = record(value, "self-burn-native.route.identityMemo");
  assertExactKeys(outer, ["kind", "familyId", "familyDefinitionHash", "familyCandidateKey", "instanceNominationKey", "candidateSnapshotHash", "identity"], "self-burn-native.identityMemo");
  if (outer.kind !== "self-burn-native-identity-memo" || outer.familyId !== SELF_BURN_NATIVE_FAMILY_ID) throw new TypeError("self-burn-native identity memo discriminator mismatch");
  const definitionHash = assertHash(outer.familyDefinitionHash, "self-burn-native.identityMemo.familyDefinitionHash");
  const nominationKey = canonicalAddress(text(outer.instanceNominationKey, "self-burn-native.identityMemo.instanceNominationKey"));
  if (definitionHash !== SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH || assertHash(outer.familyCandidateKey, "self-burn-native.identityMemo.familyCandidateKey") !== discoveryFamilyCandidateKey(definitionHash, nominationKey)) throw new TypeError("self-burn-native identity memo family binding mismatch");
  const source = record(outer.identity, "self-burn-native.identity");
  assertExactKeys(source, ["cutoff", "candidateSnapshotHash", "instanceKey", "factsHash", "facts"], "self-burn-native.identity");
  const facts = record(source.facts, "self-burn-native.identity.facts");
  assertExactKeys(facts, ["target", "token", "actor", "redeemSelector"], "self-burn-native.identity.facts");
  const decodedFacts = Object.freeze({
    target: canonicalAddress(text(facts.target, "self-burn-native.identity.facts.target")),
    token: canonicalAddress(text(facts.token, "self-burn-native.identity.facts.token")),
    actor: canonicalAddress(text(facts.actor, "self-burn-native.identity.facts.actor")),
    redeemSelector: bytes(facts.redeemSelector, "self-burn-native.identity.facts.redeemSelector") as `0x${string}`,
  });
  if (!/^0x[0-9a-f]{8}$/.test(decodedFacts.redeemSelector)) throw new TypeError("self-burn-native identity redeem selector must be four bytes");
  const identity = Object.freeze({
    cutoff: familySearchSource(source.cutoff, "self-burn-native.identity.cutoff") as SelfBurnNativeIdentityV1["cutoff"],
    candidateSnapshotHash: assertHash(source.candidateSnapshotHash, "self-burn-native.identity.candidateSnapshotHash"),
    instanceKey: canonicalAddress(text(source.instanceKey, "self-burn-native.identity.instanceKey")),
    factsHash: assertHash(source.factsHash, "self-burn-native.identity.factsHash"),
    facts: decodedFacts,
  });
  if (identity.instanceKey !== identity.facts.target || identity.factsHash !== hashDomain("aloha/self-burn-native/identity-facts/v1", identity.facts)) throw new TypeError("self-burn-native identity facts hash mismatch");
  if (identity.instanceKey !== identity.facts.token) throw new TypeError("self-burn-native identity target/token mismatch");
  if (identity.facts.redeemSelector !== TRANSFER_SELECTOR) throw new TypeError("self-burn-native identity selector mismatch");
  if (nominationKey !== identity.instanceKey || assertHash(outer.candidateSnapshotHash, "self-burn-native.identityMemo.candidateSnapshotHash") !== identity.candidateSnapshotHash) throw new TypeError("self-burn-native identity memo lineage mismatch");
  return identity;
}

function context(input: FamilySearchLegRequestV1): Context {
  const route = validateFamilySearchRouteLegBinding(input.route);
  if (route.familyId !== SELF_BURN_NATIVE_FAMILY_ID || route.familyDefinitionHash !== SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH) throw new TypeError("self-burn-native search route family mismatch");
  if (route.identityMemoHash !== hashDomain("aloha/identity-memo/v1", route.identityMemo)) throw new TypeError("self-burn-native identity memo hash mismatch");
  const source = familySearchSource(input.currentSource.source);
  const objective = familySearchObjective(input.objective);
  const amount = familySearchAmount(input.amount);
  const identity = decodeIdentity(route.identityMemo);
  if (route.instanceKey !== identity.instanceKey) throw new TypeError("self-burn-native search instance binding mismatch");
  const protocolRoute = deriveSelfBurnNativeRoutes(identity).find(item => assetRef(source.chainId, item.inputAsset) === amount.inputAssetRef && assetRef(source.chainId, item.outputAsset) === amount.outputAssetRef);
  if (protocolRoute === undefined) throw new TypeError("self-burn-native search amount assets do not match identity");
  assertSelfBurnNativeRoute(protocolRoute, identity);
  canonicalAddress(amount.recipient);
  return Object.freeze({ route, routeBindingHash: familySearchRouteBindingHash(route), source, objective, amount, amountHash: familySearchAmountHash(amount), identity, protocolRoute });
}

function requestId(ctx: Context): Hash {
  return hashDomain("aloha/self-burn-native/search-state-request/v2", {
    familyDefinitionHash: SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH,
    routeBindingHash: ctx.routeBindingHash,
    instanceKey: ctx.identity.instanceKey,
    amountHash: ctx.amountHash,
    source: ctx.source,
  });
}
function readRequest(ctx: Context) {
  const id = requestId(ctx);
  return Object.freeze({
    kind: "family-search.current-source-read" as const,
    requestId: id,
    source: ctx.source,
    target: ctx.identity.instanceKey,
    data: call(TRANSFER_SELECTOR, [addressWord(ctx.identity.facts.token, "self-burn-native transfer recipient"), word(BigInt(ctx.amount.amountIn), "self-burn-native transfer amount")]),
    responseEncoding: "abi-bool" as const,
  });
}
function stateResponse(ctx: Context, id: Hash, returnDataHex: string): StateResponse {
  const result = abiBool(returnDataHex, "self-burn-native state.returnDataHex");
  return Object.freeze({
    kind: "self-burn-native-state-read-response",
    requestId: id,
    source: ctx.source,
    routeBindingHash: ctx.routeBindingHash,
    amountHash: ctx.amountHash,
    instanceKey: ctx.identity.instanceKey,
    returnDataHex: result,
    stateHash: hashDomain("aloha/self-burn-native/search-state/v3", { cutoff: ctx.source, instanceKey: ctx.identity.instanceKey, routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash, returnDataHex: result }),
  });
}
function decodeStateResponse(value: CanonicalJson, ctx: Context, id: Hash): StateResponse {
  const source = record(value, "self-burn-native.stateResponse");
  assertExactKeys(source, ["kind", "requestId", "source", "routeBindingHash", "amountHash", "instanceKey", "returnDataHex", "stateHash"], "self-burn-native.stateResponse");
  if (source.kind !== "self-burn-native-state-read-response" || assertHash(source.requestId, "self-burn-native stateResponse.requestId") !== id) throw new TypeError("self-burn-native state response request mismatch");
  const responseSource = familySearchSource(source.source, "self-burn-native stateResponse.source");
  const routeBindingHash = assertHash(source.routeBindingHash, "self-burn-native stateResponse.routeBindingHash");
  const amountHash = assertHash(source.amountHash, "self-burn-native stateResponse.amountHash");
  const instanceKey = canonicalAddress(text(source.instanceKey, "self-burn-native stateResponse.instanceKey"));
  const returnDataHex = abiBool(text(source.returnDataHex, "self-burn-native stateResponse.returnDataHex"), "self-burn-native stateResponse.returnDataHex");
  const stateHash = assertHash(source.stateHash, "self-burn-native stateResponse.stateHash");
  if (!sameSource(responseSource, ctx.source) || routeBindingHash !== ctx.routeBindingHash || amountHash !== ctx.amountHash || instanceKey !== ctx.identity.instanceKey || stateHash !== hashDomain("aloha/self-burn-native/search-state/v3", { cutoff: responseSource, instanceKey, routeBindingHash, amountHash, returnDataHex })) throw new TypeError("self-burn-native state response lineage mismatch");
  return Object.freeze({ kind: "self-burn-native-state-read-response", requestId: id, source: responseSource, routeBindingHash, amountHash, instanceKey, returnDataHex, stateHash });
}
function stateArtifact(ctx: Context, response: StateResponse): FamilySearchStateArtifactV1 {
  const payload = canonical(response);
  const payloadHash = familySearchPayloadHash("state", payload);
  return Object.freeze({ kind: "state", status: "verified", source: ctx.source, routeBindingHash: ctx.routeBindingHash, payload, payloadHash, artifactHash: familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash }), factsRoot: hashDomain("aloha/self-burn-native/state-facts/v1", { stateHash: response.stateHash, returnDataHex: response.returnDataHex }), sourceRequestId: response.requestId });
}
function assertState(ctx: Context, artifact: FamilySearchStateArtifactV1): StateResponse {
  if (artifact.kind !== "state" || artifact.status !== "verified" || !sameSource(artifact.source, ctx.source) || artifact.routeBindingHash !== ctx.routeBindingHash) throw new TypeError("self-burn-native state artifact binding mismatch");
  const payload = canonical(artifact.payload);
  const payloadHash = familySearchPayloadHash("state", payload);
  if (artifact.payloadHash !== payloadHash || artifact.artifactHash !== familySearchArtifactHash({ kind: "state", source: ctx.source, routeBindingHash: ctx.routeBindingHash, objectiveRef: null, amountHash: null, payloadHash })) throw new TypeError("self-burn-native state artifact hash mismatch");
  const response = decodeStateResponse(payload, ctx, artifact.sourceRequestId);
  if (artifact.factsRoot !== hashDomain("aloha/self-burn-native/state-facts/v1", { stateHash: response.stateHash, returnDataHex: response.returnDataHex })) throw new TypeError("self-burn-native state facts root mismatch");
  return response;
}


const factory: FamilySearchAdapterFactoryV1 = input => {
  if (input.familyDefinitionHash !== SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH) throw new TypeError("self-burn-native search factory definition mismatch");
  for (const ref of Object.values(input.capabilityRefs)) input.composition.resolveCapability(input.familyDefinitionHash, ref);
  for (const ref of Object.values(input.actionOwnerRefs)) input.composition.resolveActionOwner(input.familyDefinitionHash, ref);
  const readState: FamilySearchAdapterV1["readState"] = async request => {
    try {
      const ctx = context(request);
      await request.currentSource.assertCurrent();
      const physical = readRequest(ctx);
      let raw: FamilySearchSourceReadResultV1;
      try {
        raw = await request.readPort.read({ request: physical, signal: request.signal, ...(request.deadlineAtMs === undefined ? {} : { deadlineAtMs: request.deadlineAtMs }) });
      } catch (error) {
        return unavailable("state", "source-transport-error", { requestId: physical.requestId, error: String(error) });
      }
      if (raw.kind !== "returned") return unavailable("state", raw.reasonCode || "source-read-unavailable", raw);
      if (raw.requestId !== physical.requestId || !sameSource(raw.source, physical.source)) throw new TypeError("self-burn-native source response binding mismatch");
      try {
        const response = stateResponse(ctx, physical.requestId, raw.dataHex);
        return Object.freeze({ kind: "verified" as const, artifact: stateArtifact(ctx, response) });
      } catch (error) {
        return unavailable("state", "malformed-abi-return", { requestId: physical.requestId, dataHex: raw.dataHex, error: String(error) });
      }
    } catch (error) {
      return invalid("state", error);
    }
  };
  const projectCoarse: FamilySearchAdapterV1["projectCoarse"] = request => {
    try {
      const ctx = context(request);
      assertState(ctx, request.state);
      return unavailable("coarse", "coarse-capability-not-in-release", { routeBindingHash: ctx.routeBindingHash, amountHash: ctx.amountHash });
    } catch (error) {
      return invalid("coarse", error);
    }
  };
  const evaluateExact: FamilySearchAdapterV1["evaluateExact"] = request => {
    try {
      const ctx = context(request);
      assertState(ctx, request.state);
      return unavailable("exact", "effect-observation-not-in-release", {
        routeBindingHash: ctx.routeBindingHash,
        amountHash: ctx.amountHash,
        stateFactsRoot: request.state.factsRoot,
        required: "qualified-effect-observation-or-simulation",
      });
    } catch (error) {
      return invalid("exact", error);
    }
  };
  const buildAction: FamilySearchAdapterV1["buildAction"] = request => {
    try {
      const ctx = context(request);
      return unavailable("action", "effect-observation-not-in-release", {
        routeBindingHash: ctx.routeBindingHash,
        amountHash: ctx.amountHash,
        required: "qualified-effect-observation-or-simulation",
      });
    } catch (error) {
      return invalid("action", error);
    }
  };
  const run: FamilySearchAdapterV1["run"] = async request => {
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

export const SELF_BURN_NATIVE_SEARCH_RUNTIME_ADAPTER_FACTORY = factory;
