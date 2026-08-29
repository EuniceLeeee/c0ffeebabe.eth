import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1, nativeAssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { candidateSubjectHash, familyCandidateKey } from "../../../packages/discovery/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import type { FamilySearchAmountEnvelopeV1, FamilySearchCurrentSourceV1, FamilySearchRouteLegBindingV1, FamilySearchSourceReadPortV1, FamilySearchSourceReadRequestV1 } from "../../../packages/family-sdk/search-runtime/index.ts";
import { ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { ETHERTOKEN_NATIVE_REDEEM_FAMILY_ID } from "../src/manifest.ts";
import { verifyEtherTokenNativeRedeemIdentityStage } from "../src/identity.ts";
import { ETHERTOKEN_NATIVE_REDEEM_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/search-adapter.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const h = (value: string): Hash => hashDomain("aloha/ethertoken-native-redeem-search-adapter-test/v1", value);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("cutoff"), stateRoot: h("state") });
const target = address("5");
const token = address("1");
const actor = address("3");
const amountIn = "10";

const identityResult = verifyEtherTokenNativeRedeemIdentityStage({
  candidate: { target, instanceNominationKey: target, candidateSnapshotHash: candidateSubjectHash(ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH, target), evidence: { kind: "call", cutoff, blockNumber: "100", blockHash: h("block"), txHash: h("tx"), logIndex: "0", target, rawLocatorHash: h("raw") } },
  reads: { cutoff, target, reverseTarget: target, token, actor },
});
assert.equal(identityResult.status, "verified");
if (identityResult.status !== "verified") throw new Error("ethertoken identity fixture failed");
const identity = identityResult.identity;

function routeBinding(): FamilySearchRouteLegBindingV1 {
  const memo = { kind: "ethertoken-native-redeem-identity-memo" as const, familyId: ETHERTOKEN_NATIVE_REDEEM_FAMILY_ID, familyDefinitionHash: ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH, familyCandidateKey: familyCandidateKey(ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH, target), instanceNominationKey: target, candidateSnapshotHash: identity.candidateSnapshotHash, candidateEvidenceRoot: h("candidate-evidence-root"), identity };
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(memo)) as CanonicalJson;
  return { familyId: ETHERTOKEN_NATIVE_REDEEM_FAMILY_ID, familyDefinitionHash: ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH, instanceKey: target, identityMemo, identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo), instancePublicationHash: h("publication"), staticProjectionMemoHash: h("static-memo"), requestedArtifactDependencyRoot: h("dependencies"), staticProjectionHash: h("static-projection"), projectionHash: h("projection"), authoritySessionHash: h("authority") };
}

const amount: FamilySearchAmountEnvelopeV1 = Object.freeze({ inputAssetRef: erc20AssetRefV1("1", token), outputAssetRef: nativeAssetRefV1("1"), amountIn, recipient: actor });
const effectPayload = Object.freeze({ kind: "ethertoken-native-redeem-effects-v1", actor, completion: "returned", returnDataHex: "0x", tokenDeltas: [{ token, account: actor, delta: "-10" }], nativeDeltas: [{ account: actor, delta: "10" }], supplyDeltas: [{ token, delta: "-10" }] });
const objective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", effectPayload), payload: effectPayload });

function readPort(): FamilySearchSourceReadPortV1 {
  return { read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) { assert.equal(request.target, target); assert.equal(request.responseEncoding, "hex"); assert.equal(request.data.slice(0, 10), "0x2e1a7d4d"); return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: "0x" }; } };
}
function input(objectiveValue = objective) {
  return { route: routeBinding(), currentSource: { source: cutoff, assertCurrent() {} } satisfies FamilySearchCurrentSourceV1, objective: objectiveValue, amount, readPort: readPort() };
}

const adapter = ETHERTOKEN_NATIVE_REDEEM_SEARCH_RUNTIME_ADAPTER_FACTORY({ familyDefinitionHash: ETHERTOKEN_NATIVE_REDEEM_FAMILY_AUTHORING_HASH, capabilityRefs: { exact: h("exact"), trigger: h("trigger") } as never, actionOwnerRefs: { redeem: asOwnerRef(h("action-owner")) }, composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({}) } });

test("ethertoken keeps current-source state verified but has no effect authority", async () => {
  const state = await adapter.readState(input());
  assert.equal(state.kind, "verified");
  if (state.kind !== "verified") return;
  const exact = adapter.evaluateExact({ ...input(), state: state.artifact, coarse: {} as never });
  assert.equal(exact.kind, "unavailable");
  if (exact.kind !== "unavailable") return;
  assert.match(exact.reasonCode, /effect-observation-not-in-release/);
  const action = adapter.buildAction({ ...input(), exact: {} as never });
  assert.equal(action.kind, "unavailable");
});

test("ethertoken objective effect injection cannot change the unavailable verdict", async () => {
  const state = await adapter.readState(input());
  assert.equal(state.kind, "verified");
  if (state.kind !== "verified") return;
  const forgedPayload = Object.freeze({ ...effectPayload, nativeDeltas: [{ account: actor, delta: "999999" }] });
  const forgedObjective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", forgedPayload), payload: forgedPayload });
  const forgedState = await adapter.readState(input(forgedObjective));
  assert.equal(forgedState.kind, "verified");
  if (forgedState.kind !== "verified") return;
  assert.equal(forgedState.artifact.sourceRequestId, state.artifact.sourceRequestId);
  assert.equal(forgedState.artifact.payloadHash, state.artifact.payloadHash);
  const baseline = adapter.evaluateExact({ ...input(), state: state.artifact, coarse: {} as never });
  const forged = adapter.evaluateExact({ ...input(forgedObjective), state: forgedState.artifact, coarse: {} as never });
  assert.equal(baseline.kind, "unavailable");
  assert.equal(forged.kind, "unavailable");
  if (baseline.kind !== "unavailable" || forged.kind !== "unavailable") return;
  assert.equal(forged.reasonCode, baseline.reasonCode);
  assert.equal(forged.evidenceHash, baseline.evidenceHash);
});
