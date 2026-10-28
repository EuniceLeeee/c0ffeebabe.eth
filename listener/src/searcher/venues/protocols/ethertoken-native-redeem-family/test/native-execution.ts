import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram } from "../../../../../adapters/runtime-amount-program.js";
import { encodeCall } from "../../../../../encoder.js";
import { applyQuotedAssetBoundary, applyRuntimeAssetBoundary, executionAssetBoundaryAdapter } from "../../../../execution-asset-boundary.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";
import { etherTokenNativeRedeemFamilyOwnedAction as action } from "../action.js";
import { etherTokenNativeRedeemExecution as execution } from "../execution.js";
import { etherTokenNativeRedeemExact as exact } from "../exact.js";
import { etherTokenNativeRedeemInstance as instance } from "../instance.js";
import { etherTokenNativeRedeemRoutes as routes } from "../routes.js";
import { ETHERTOKEN_NATIVE_FAMILY_ID, ETHERTOKEN_NATIVE_LINEAGE_ID } from "../manifest.js";
import { ETHERTOKEN_NATIVE_INTERFACE as abi, ETHERTOKEN_NATIVE_PROBE_ACTOR as actor,
  ETHERTOKEN_NATIVE_PROBE_ACTOR_EVIDENCE_ID, etherTokenWithdrawalSimulation, validateEtherTokenWithdrawal } from "../shared.js";

// Synthetic contract inputs only: no new admission, chain execution or historical proof.
const token = "0x2222222222222222222222222222222222222222", executor = "0x1111111111111111111111111111111111111111";
const source = { number: 123, hash: ethers.id("ethertoken-native-execution"), generation: 1 };
const descriptor = instance.compileDraft({ familyId: ETHERTOKEN_NATIVE_FAMILY_ID, lineageId: ETHERTOKEN_NATIVE_LINEAGE_ID,
  subject: token, token, provenance: [] });
const route = routes.project({ descriptor })[0];
function quoted(amountIn: bigint) {
  const input = { descriptor, route, source, executor, runtimeEvidence: [], amountIn };
  const method = exact.methods()[1]; assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing amount quote");
  assert.deepEqual(method.program.buildRequests(input), []);
  const q = method.program.decode({ programInput: input, initialResults: [], dependentEvidence: [] });
  return { ...input, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence };
}

test("EtherToken keeps the real withdraw in both raw paths and delegates wrapping", () => {
  assert.deepEqual(route.executionAssets, { input: "erc20", output: "native" });
  for (const amount of [1n, 100n, 10n ** 18n]) {
    const input = quoted(amount), fragment = execution.buildFragment(input);
    assert.deepEqual(fragment.requirements, []); assert.equal(fragment.nodes.length, 1);
    const node = fragment.nodes[0];
    assert.equal(node.adapterId, "ethertoken-native-redeem"); assert.equal(node.target, descriptor.token);
    assert.equal(node.tokenIn, route.tokenIn); assert.equal(node.tokenOut, route.tokenOut);
    const rawCall = encodeCall(descriptor.token, ethers.getBytes(abi.encodeFunctionData("withdraw", [amount])));
    assert.deepEqual(action.encode(node, executor, new Uint8Array()), rawCall);
    const boundary = applyQuotedAssetBoundary({ route, executor, amountIn: amount, minimum: input.minAmountOut, fragment });
    assert.deepEqual(boundary.requirements, []); assert.deepEqual(boundary.nodes[0].children, [node]);
    assert.equal(boundary.nodes[0].params.minAmountOut, amount);
    assert.equal(boundary.nodes[0].params.nativeOutput, true);
    assert(executionAssetBoundaryAdapter.encode(boundary.nodes[0], executor, rawCall).length > rawCall.length);
    const raw = execution.buildRuntimeLeg({ descriptor, route, executor, runtimeEvidence: [],
      get exactEvidence() { throw new Error("runtime must not quote"); },
    } as Parameters<typeof execution.buildRuntimeLeg>[0]);
    assert.equal(raw.program, ethers.hexlify(new RuntimeAmountProgram()
      .call(descriptor.token, abi.encodeFunctionData("withdraw", [0n]), { patches: [{ offset: 4, reg: 0 }] }).bytes()));
    assert.notEqual(applyRuntimeAssetBoundary({ route, executor, leg: raw }).program, raw.program);
    assert(execution.expectedEffects(input).some(e => e.kind === "total-supply-delta" && e.token === descriptor.token));
  }
});

test("EtherToken rejects stale native declarations, forged evidence, actor alias and invalid minimum", () => {
  const input = quoted(100n);
  const { executionAssets: _assets, ...withoutAssets } = route;
  for (const badRoute of [withoutAssets,
    { ...route, executionAssets: { input: "erc20" as const, output: "erc20" as const } },
    { ...route, tokenOut: token }]) {
    assert.throws(() => execution.buildRuntimeLeg({ descriptor, route: badRoute, executor, runtimeEvidence: [] }), /route/i);
    assert.throws(() => execution.buildFragment({ ...input, route: badRoute }), /route/i);
  }
  for (const minAmountOut of [-1n, 101n])
    assert.throws(() => execution.buildFragment({ ...input, minAmountOut }), /incompatible/);
  for (const amountIn of [0n, ethers.MaxUint256 + 1n])
    assert.throws(() => execution.buildFragment({ ...input, amountIn }), /incompatible/);
  assert.throws(() => execution.buildFragment({ ...input, quotedAmountOut: 99n }), /incompatible/);
  assert.throws(() => execution.buildFragment({ ...input, exactEvidence: { ...input.exactEvidence, executor: token } }), /incompatible/);
  assert.throws(() => execution.buildRuntimeLeg({ descriptor, route, executor: token, runtimeEvidence: [] }), /executor/);
  assert.throws(() => action.encode({ ...execution.buildFragment(input).nodes[0], target: descriptor.nativeAnchor }, executor, new Uint8Array()), /canonical WETH/);
});

test("EtherToken raw strict probe retains token target, original actor, burn and native receipt evidence", () => {
  const amountIn = 100n, callerRef = { kind: "verified-actor" as const, evidenceId: ETHERTOKEN_NATIVE_PROBE_ACTOR_EVIDENCE_ID };
  const probe = etherTokenWithdrawalSimulation({ id: "behavior", token, actor, callerRef, amountIn });
  assert.equal(probe.kind, "effect-delta-simulation");
  if (probe.kind !== "effect-delta-simulation") throw new Error("wrong behavior probe");
  assert.equal(probe.call.to, token); assert.equal(probe.call.executionMode, "impersonated-call-frame");
  assert.deepEqual(probe.call.caller, callerRef); assert(!("executionAssetBoundary" in probe));
  assert(probe.observe.includes("total-supply-delta") && probe.observe.includes("native-delta"));
  assert.equal(probe.call.data, abi.encodeFunctionData("withdraw", [amountIn]));
  const result: Extract<AdapterRequestResult, { ok: true }> = { id: "behavior", ok: true, source, completion: "returned",
    provenance: { kind: "synthetic", fingerprint: "not-chain-proof" }, data: "0x", effects: {
      tokenDeltas: [{ token, account: actor, delta: -amountIn }], totalSupplyDeltas: [{ token, delta: -amountIn }],
      nativeDeltas: [{ account: actor, delta: amountIn }],
    } };
  assert.equal(validateEtherTokenWithdrawal({ result, token, actor, amountIn }), amountIn);
  for (const effects of [
    { ...result.effects, tokenDeltas: [] }, { ...result.effects, totalSupplyDeltas: [] },
    { ...result.effects, totalSupplyDeltas: [{ token: descriptor.nativeAnchor, delta: -amountIn }] },
    { ...result.effects, nativeDeltas: [{ account: actor, delta: amountIn - 1n }] },
    { ...result.effects, nativeDeltas: [{ account: executor, delta: amountIn }] },
  ]) assert.throws(() => validateEtherTokenWithdrawal({ result: { ...result, effects }, token, actor, amountIn }), /invariants/);
  assert.throws(() => validateEtherTokenWithdrawal({ result: { ...result, completion: "reverted-as-declared" }, token, actor, amountIn }), /did not return/);
});
