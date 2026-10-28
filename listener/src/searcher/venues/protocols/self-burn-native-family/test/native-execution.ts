import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { encodeCall } from "../../../../../encoder.js";
import { applyQuotedAssetBoundary, applyRuntimeAssetBoundary, executionAssetBoundaryAdapter } from "../../../../execution-asset-boundary.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { selfBurnNativeFamilyOwnedAction as action } from "../action.js";
import { selfBurnNativeExecution as execution } from "../execution.js";
import { selfBurnNativeExact as exact } from "../exact.js";
import { selfBurnNativeInstance as instance } from "../instance.js";
import { selfBurnNativeRoutes as routes } from "../routes.js";
import { SELF_BURN_NATIVE_FAMILY_ID, SELF_BURN_NATIVE_LINEAGE_ID } from "../manifest.js";
import { SELF_BURN_NATIVE_TOKEN_INTERFACE as abi, SELF_BURN_NATIVE_PROBE_ACTOR as actor,
  SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID, selfBurnNativeSimulation, validateSelfBurnNativeEffects } from "../shared.js";

// Synthetic fee/behavior answers only; not new strict or historical acceptance.
const token = "0x2222222222222222222222222222222222222222", executor = "0x1111111111111111111111111111111111111111";
const source = { number: 123, hash: ethers.id("self-burn-native-execution"), generation: 1 };
const descriptor = instance.compileDraft({ familyId: SELF_BURN_NATIVE_FAMILY_ID, lineageId: SELF_BURN_NATIVE_LINEAGE_ID,
  subject: token, token, provenance: [] });
const route = routes.project({ descriptor })[0];
function quoted(amountIn: bigint) {
  const input = { descriptor, route, source, executor, runtimeEvidence: [], amountIn };
  const method = exact.methods()[1]; assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing fee quote");
  const values: Record<string, bigint> = { "exact-wrapFeeParts": 100n, "exact-wrapFeeRate": 10n,
    "exact-wrapFeeMin": 0n, "exact-wrapFeeMax": ethers.MaxUint256 };
  const initialResults: AdapterRequestResult[] = method.program.buildRequests(input).map(({ id }) => {
    assert(id in values);
    return { id, ok: true, completion: "returned", source, data: ethers.toBeHex(values[id], 32),
      provenance: { kind: "synthetic", fingerprint: id } };
  });
  const q = method.program.decode({ programInput: input, initialResults, dependentEvidence: [] });
  return { ...input, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence };
}

test("SelfBurn retains transfer-to-self and fee quote, with only central receipt wrapping", () => {
  assert.deepEqual(route.executionAssets, { input: "erc20", output: "native" });
  for (const amount of [10n, 100n, 10n ** 18n]) {
    const input = quoted(amount), fragment = execution.buildFragment(input);
    assert.equal(input.quotedAmountOut, amount - amount / 10n, "do not replace fee semantics with 1:1");
    assert.deepEqual(fragment.requirements, []); assert.equal(fragment.nodes.length, 1);
    const node = fragment.nodes[0]; assert.equal(node.adapterId, "self-burn-native-redeem");
    assert.equal(node.target, descriptor.token); assert.equal(node.tokenIn, route.tokenIn); assert.equal(node.tokenOut, route.tokenOut);
    const rawCall = encodeCall(descriptor.token, ethers.getBytes(abi.encodeFunctionData("transfer", [descriptor.token, amount])));
    assert.deepEqual(action.encode(node, executor, new Uint8Array()), rawCall);
    const boundary = applyQuotedAssetBoundary({ route, executor, amountIn: amount, minimum: input.minAmountOut, fragment });
    assert.deepEqual(boundary.requirements, []); assert.deepEqual(boundary.nodes[0].children, [node]);
    assert.equal(boundary.nodes[0].params.minAmountOut, input.quotedAmountOut);
    assert.equal(boundary.nodes[0].params.nativeOutput, true);
    assert(executionAssetBoundaryAdapter.encode(boundary.nodes[0], executor, rawCall).length > rawCall.length);
    const raw = execution.buildRuntimeLeg({ descriptor, route, executor, runtimeEvidence: [],
      get exactEvidence() { throw new Error("runtime must not quote"); },
    } as Parameters<typeof execution.buildRuntimeLeg>[0]);
    assert.equal(raw.program, ethers.hexlify(new RuntimeAmountProgram()
      .call(descriptor.token, abi.encodeFunctionData("transfer", [descriptor.token, 0n]), { patches: [{ offset: 36, reg: 0 }] }).bytes()));
    assert.notEqual(applyRuntimeAssetBoundary({ route, executor, leg: raw }).program, raw.program);
    assert(execution.expectedEffects(input).some(e => e.kind === "total-supply-delta" && e.token === descriptor.token));
  }
});

test("SelfBurn rejects stale declarations, forged fees/evidence, invalid minimum and alias", () => {
  const input = quoted(100n);
  const { executionAssets: _assets, ...withoutAssets } = route;
  for (const badRoute of [withoutAssets,
    { ...route, executionAssets: { input: "erc20" as const, output: "erc20" as const } },
    { ...route, tokenOut: token }]) {
    assert.throws(() => execution.buildRuntimeLeg({ descriptor, route: badRoute, executor, runtimeEvidence: [] }), /route/i);
    assert.throws(() => execution.buildFragment({ ...input, route: badRoute }), /route/i);
  }
  for (const minAmountOut of [-1n, input.quotedAmountOut + 1n])
    assert.throws(() => execution.buildFragment({ ...input, minAmountOut }), /incompatible/);
  for (const amountIn of [0n, ethers.MaxUint256 + 1n])
    assert.throws(() => execution.buildFragment({ ...input, amountIn }), /incompatible/);
  for (const evidence of [{ ...input.exactEvidence, fee: -1n }, { ...input.exactEvidence, fee: 101n },
    { ...input.exactEvidence, fees: null }, { ...input.exactEvidence, executor: token },
    { ...input.exactEvidence, amountOut: 100n }])
    assert.throws(() => execution.buildFragment({ ...input, exactEvidence: evidence }), /incompatible/);
  assert.throws(() => execution.buildRuntimeLeg({ descriptor, route, executor: token, runtimeEvidence: [] }), /executor/);
});

test("SelfBurn original strict probe still requires true return, exact burn/debit and positive native receipt", () => {
  const amountIn = 100n, callerRef = { kind: "verified-actor" as const, evidenceId: SELF_BURN_NATIVE_PROBE_ACTOR_EVIDENCE_ID };
  const probe = selfBurnNativeSimulation({ id: "behavior", token, actor, callerRef, amountIn });
  assert.equal(probe.kind, "effect-delta-simulation");
  if (probe.kind !== "effect-delta-simulation") throw new Error("wrong behavior probe");
  assert.equal(probe.call.to, token); assert.equal(probe.call.executionMode, "impersonated-call-frame");
  assert.deepEqual(probe.call.caller, callerRef); assert(!("executionAssetBoundary" in probe));
  assert(probe.observe.includes("total-supply-delta") && probe.observe.includes("native-delta"));
  assert.equal(probe.call.data, abi.encodeFunctionData("transfer", [token, amountIn]));
  const result: Extract<AdapterRequestResult, { ok: true }> = { id: "behavior", ok: true, source, completion: "returned",
    provenance: { kind: "synthetic", fingerprint: "not-chain-proof" }, data: abi.encodeFunctionResult("transfer", [true]), effects: {
      tokenDeltas: [{ token, account: actor, delta: -amountIn }], totalSupplyDeltas: [{ token, delta: -amountIn }],
      nativeDeltas: [{ account: actor, delta: 90n }],
    } };
  assert.equal(validateSelfBurnNativeEffects({ result, token, actor, amountIn }), 90n);
  assert.throws(() => validateSelfBurnNativeEffects({ result: { ...result, data: abi.encodeFunctionResult("transfer", [false]) }, token, actor, amountIn }), /returned false/);
  for (const effects of [
    { ...result.effects, tokenDeltas: [] }, { ...result.effects, totalSupplyDeltas: [] },
    { ...result.effects, totalSupplyDeltas: [{ token: descriptor.nativeAnchor, delta: -amountIn }] },
    { ...result.effects, nativeDeltas: [{ account: actor, delta: 0n }] },
    { ...result.effects, nativeDeltas: [{ account: executor, delta: 90n }] },
  ]) assert.throws(() => validateSelfBurnNativeEffects({ result: { ...result, effects }, token, actor, amountIn }), /invariants/);
  assert.throws(() => validateSelfBurnNativeEffects({ result: { ...result, completion: "reverted-as-declared" }, token, actor, amountIn }), /did not return/);
});
