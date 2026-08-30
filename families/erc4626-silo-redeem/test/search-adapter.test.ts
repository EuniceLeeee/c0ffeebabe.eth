import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, encodeCanonicalJson, hashDomain, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { erc20AssetRefV1, nativeAssetRefV1 } from "../../../packages/asset-ref/src/index.ts";
import { candidateSubjectHash, familyCandidateKey } from "../../../packages/discovery/src/index.ts";
import { asOwnerRef } from "../../../packages/capability-contracts/src/index.ts";
import type { FamilySearchAmountEnvelopeV1, FamilySearchCurrentSourceV1, FamilySearchRouteLegBindingV1, FamilySearchSourceReadPortV1, FamilySearchSourceReadRequestV1 } from "../../../packages/family-sdk/search-runtime/index.ts";
import { ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { ERC4626_SILO_REDEEM_FAMILY_ID } from "../src/manifest.ts";
import { verifyErc4626SiloRedeemIdentityStage } from "../src/identity.ts";
import { ERC4626_SILO_REDEEM_SEARCH_RUNTIME_ADAPTER_FACTORY } from "../src/search-adapter.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const h = (value: string): Hash => hashDomain("aloha/erc4626-silo-redeem-search-adapter-test/v1", value);
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("cutoff"), stateRoot: h("state") });
const vault = address("5");
const payoutToken = address("2");
const actor = address("3");
const amountIn = "10";
const subjectHash = candidateSubjectHash(ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH, vault);

const identityResult = verifyErc4626SiloRedeemIdentityStage({
  candidate: { target: vault, instanceNominationKey: vault, candidateSnapshotHash: subjectHash, evidence: { kind: "call", cutoff, blockNumber: "100", blockHash: h("block"), txHash: h("tx"), logIndex: "0", target: vault, rawLocatorHash: h("raw") } },
  reads: { cutoff, target: vault, reverseTarget: vault, vault, payoutToken, actor },
});
assert.equal(identityResult.status, "verified");
if (identityResult.status !== "verified") throw new Error("erc4626 silo identity fixture failed");
const identity = identityResult.identity;

function routeBinding(): FamilySearchRouteLegBindingV1 {
  const memo = { kind: "erc4626-silo-redeem-identity-memo" as const, familyId: ERC4626_SILO_REDEEM_FAMILY_ID, familyDefinitionHash: ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH, familyCandidateKey: familyCandidateKey(ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH, vault), instanceNominationKey: vault, candidateSnapshotHash: identity.candidateSnapshotHash, candidateEvidenceRoot: h("candidate-evidence-root"), identity };
  const identityMemo = decodeCanonicalJson(encodeCanonicalJson(memo)) as CanonicalJson;
  return { familyId: ERC4626_SILO_REDEEM_FAMILY_ID, familyDefinitionHash: ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH, instanceKey: vault, identityMemo, identityMemoHash: hashDomain("aloha/identity-memo/v1", identityMemo), instancePublicationHash: h("publication"), staticProjectionMemoHash: h("static-memo"), requestedArtifactDependencyRoot: h("dependencies"), staticProjectionHash: h("static-projection"), projectionHash: h("projection"), authoritySessionHash: h("authority") };
}

const amount: FamilySearchAmountEnvelopeV1 = Object.freeze({ inputAssetRef: erc20AssetRefV1("1", vault), outputAssetRef: erc20AssetRefV1("1", payoutToken), amountIn, recipient: actor });
const execution = Object.freeze({ transactionOrigin: address("7"), executorAddress: amount.recipient });
const effectPayload = Object.freeze({ kind: "erc4626-silo-redeem-effects-v1", actor, completion: "returned", returnDataHex: `0x${word(9n)}`, tokenDeltas: [{ token: vault, account: actor, delta: "-10" }, { token: payoutToken, account: actor, delta: "9" }], supplyDeltas: [{ token: vault, delta: "-10" }] });
const objective = Object.freeze({ objectiveRef: hashDomain("aloha/search-objective/v1", effectPayload), payload: effectPayload });

function readPort(): FamilySearchSourceReadPortV1 {
  return { read({ request }: { readonly request: FamilySearchSourceReadRequestV1 }) { assert.equal(request.target, vault); assert.equal(request.responseEncoding, "abi-uint256"); assert.equal(request.data.slice(0, 10), "0x4cdad506"); return { kind: "returned" as const, requestId: request.requestId, source: request.source, dataHex: `0x${word(9n)}` }; } };
}
function input(objectiveValue = objective) {
  return { route: routeBinding(), currentSource: { source: cutoff, assertCurrent() {} } satisfies FamilySearchCurrentSourceV1, objective: objectiveValue, amount, execution, readPort: readPort() };
}

const adapter = ERC4626_SILO_REDEEM_SEARCH_RUNTIME_ADAPTER_FACTORY({ familyDefinitionHash: ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH, capabilityRefs: { exact: h("exact"), trigger: h("trigger") } as never, actionOwnerRefs: { redeem: asOwnerRef(h("action-owner")) }, composition: { resolveCapability: () => ({}), resolveActionOwner: () => ({}) } });

test("Silo keeps the current preview state verified but has no effect authority", async () => {
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

test("Silo objective effect injection cannot change the unavailable verdict", async () => {
  const state = await adapter.readState(input());
  assert.equal(state.kind, "verified");
  if (state.kind !== "verified") return;
  const forgedPayload = Object.freeze({ ...effectPayload, tokenDeltas: [{ token: payoutToken, account: actor, delta: "999999" }] });
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
