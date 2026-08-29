import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanonicalJson,
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1, nativeAssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { familyCandidateKey } from "../../../packages/discovery/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import type {
  FamilySearchAmountEnvelopeV1,
  FamilySearchCoarseArtifactV1,
  FamilySearchCurrentSourceV1,
  FamilySearchRouteLegBindingV1,
  FamilySearchSourceReadPortV1,
  FamilySearchSourceReadRequestV1,
} from "../../../packages/family-sdk/search-runtime/index.ts";
import { SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { SELF_BURN_NATIVE_FAMILY_ID } from "../src/manifest.ts";
import { verifySelfBurnNativeIdentityStage } from "../src/stages.ts";
import { SELF_BURN_NATIVE_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/search-adapter.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const h = (value: string): Hash => hashDomain("aloha/self-burn-native-search-adapter-test/v1", value);
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const boolTrue = `0x${word(1n)}`;
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("cutoff"), stateRoot: h("state") });
const token = address("5");
const recipient = address("8");
const amountIn = "6";

function identity() {
  const result = verifySelfBurnNativeIdentityStage({
    candidate: {
      target: token,
      instanceNominationKey: token,
      candidateSnapshotHash: h("candidate"),
      evidence: {
        kind: "call",
        cutoff,
        blockNumber: "100",
        blockHash: h("block"),
        txHash: h("tx"),
        logIndex: "0",
        target: token,
        rawLocatorHash: h("raw"),
      },
    },
    reads: { cutoff, target: token, reverseTarget: token, token, actor: recipient, redeemSelector: "0xa9059cbb" },
  });
  assert.equal(result.status, "verified");
  if (result.status !== "verified") throw new Error("identity fixture failed");
  return result.identity;
}

const protocolIdentity = identity();

function routeBinding(): FamilySearchRouteLegBindingV1 {
  const memo = {
    kind: "self-burn-native-identity-memo" as const,
    familyId: SELF_BURN_NATIVE_FAMILY_ID,
    familyDefinitionHash: SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH,
    familyCandidateKey: familyCandidateKey(SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH, token),
    instanceNominationKey: token,
    candidateSnapshotHash: protocolIdentity.candidateSnapshotHash,
    identity: protocolIdentity,
  };
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(memo)) as CanonicalJson;
  return {
    familyId: SELF_BURN_NATIVE_FAMILY_ID,
    familyDefinitionHash: SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH,
    instanceKey: token,
    identityMemo,
    identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo),
    instancePublicationHash: h("publication"),
    staticProjectionMemoHash: h("static-memo"),
    requestedArtifactDependencyRoot: h("dependencies"),
    staticProjectionHash: h("static-projection"),
    projectionHash: h("projection"),
    authoritySessionHash: h("authority"),
  };
}

const amount: FamilySearchAmountEnvelopeV1 = Object.freeze({
  inputAssetRef: erc20AssetRefV1("1", token),
  outputAssetRef: nativeAssetRefV1("1"),
  amountIn,
  recipient,
});
const effects = Object.freeze({
  kind: "self-burn-native-effects-v1" as const,
  actor: recipient,
  completion: "returned" as const,
  returnDataHex: boolTrue,
  tokenDeltas: [{ token, account: recipient, delta: "-6" }],
  nativeDeltas: [{ account: recipient, delta: "4" }],
  supplyDeltas: [{ token, delta: "-6" }],
});
const objectivePayload = effects;
const objective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", objectivePayload), payload: objectivePayload });

function input(readPort: FamilySearchSourceReadPortV1 = readPortFactory()) {
  return { route: routeBinding(), currentSource: { source: cutoff, assertCurrent() {} } satisfies FamilySearchCurrentSourceV1, objective, amount, readPort };
}
function readPortFactory(options: { readonly malformed?: boolean; readonly mismatch?: boolean } = {}): FamilySearchSourceReadPortV1 {
  return {
    read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) {
      if (options.malformed) return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: "0x01" };
      if (options.mismatch) return { kind: "returned" as const, requestId: request.requestId, source: { ...request.source, number: "101" }, dataHex: boolTrue };
      assert.equal(request.target, token);
      assert.equal(request.responseEncoding, "abi-bool");
      assert.equal(request.data.slice(0, 10), "0xa9059cbb");
      assert.equal(request.data.slice(10, 74), token.slice(2).padStart(64, "0"));
      assert.equal(BigInt(`0x${request.data.slice(74)}`), BigInt(amountIn));
      return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: boolTrue };
    },
  };
}

const adapter = SELF_BURN_NATIVE_SEARCH_RUNTIME_ADAPTER_FACTORY({
  familyDefinitionHash: SELF_BURN_NATIVE_FAMILY_AUTHORING_HASH,
  capabilityRefs: { exact: h("exact"), trigger: h("trigger") } as never,
  actionOwnerRefs: { redeem: asOwnerRef(h("action-owner")) },
  composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({}) },
});
const coarsePlaceholder = {} as FamilySearchCoarseArtifactV1;

test("self-burn adapter keeps the current-source read but refuses exact/action without qualified effects", async () => {
  const state = await adapter.readState(input());
  assert.equal(state.kind, "verified");
  if (state.kind !== "verified") return;
  const exact = adapter.evaluateExact({ ...input(), state: state.artifact, coarse: coarsePlaceholder });
  assert.equal(exact.kind, "unavailable");
  if (exact.kind !== "unavailable") return;
  assert.match(exact.reasonCode, /effect-observation-not-in-release/);
  const action = adapter.buildAction({ ...input(), exact: {} as never });
  assert.equal(action.kind, "unavailable");
  if (action.kind !== "unavailable") return;
  assert.match(action.reasonCode, /effect-observation-not-in-release/);
});

test("self-burn adapter rejects malformed/stale source and ignores caller effect payload", async () => {
  const malformed = await adapter.readState(input(readPortFactory({ malformed: true })));
  assert.equal(malformed.kind, "unavailable");
  const stale = await adapter.readState(input(readPortFactory({ mismatch: true })));
  assert.equal(stale.kind, "invalidProgram");
  const state = await adapter.readState(input());
  assert.equal(state.kind, "verified");
  if (state.kind !== "verified") return;
  const forgedObjective = Object.freeze({
    ...objective,
    payload: Object.freeze({ ...effects, actor: address("9") }),
    objectiveRef: hashDomain("aloha/search-objective/v1", Object.freeze({ ...effects, actor: address("9") })),
  });
  const forgedState = await adapter.readState({ ...input(), objective: forgedObjective });
  assert.equal(forgedState.kind, "verified");
  if (forgedState.kind !== "verified") return;
  assert.equal(forgedState.artifact.sourceRequestId, state.artifact.sourceRequestId);
  assert.equal(forgedState.artifact.payloadHash, state.artifact.payloadHash);
  const exact = adapter.evaluateExact({ ...input(), objective: forgedObjective, state: forgedState.artifact, coarse: coarsePlaceholder });
  assert.equal(exact.kind, "unavailable");
  if (exact.kind !== "unavailable") return;
  const baseline = adapter.evaluateExact({ ...input(), state: state.artifact, coarse: coarsePlaceholder });
  assert.equal(baseline.kind, "unavailable");
  if (baseline.kind !== "unavailable") return;
  assert.equal(exact.reasonCode, baseline.reasonCode);
  assert.equal(exact.evidenceHash, baseline.evidenceHash);
});

test("self-burn adapter cannot turn a caller-supplied exact artifact into action", () => {
  const action = adapter.buildAction({ ...input(), exact: { kind: "exact", status: "verified" } as never });
  assert.equal(action.kind, "unavailable");
  if (action.kind !== "unavailable") return;
  assert.match(action.reasonCode, /effect-observation-not-in-release/);
});
