import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { applyExactTrialState, emptyExactTrialState } from "../../../../exact-trial-state.js";
import { nativeBalanceState, storageState, tokenSupplyState } from "../../../local-state-models/resources.js";
import { selfBurnNativeInstance } from "../instance.js";
import { selfBurnNativeRoutes } from "../routes.js";
import { selfBurnNativeExact } from "../exact.js";
import { SELF_BURN_SELF_OFFSETS, verifySelfBurnImplementation, verifySelfBurnProxy } from "../local-model.js";
import { SELF_BURN_NATIVE_FAMILY_ID, SELF_BURN_NATIVE_LINEAGE_ID } from "../manifest.js";
import { decodeSelfBurnTrial, quoteSelfBurnTrial, selfBurnTrialDependentRequests, selfBurnTrialRequests } from "../trial-state.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/runtime.json", import.meta.url), "utf8"));
const token = "0x2222222222222222222222222222222222222222", executor = "0x1111111111111111111111111111111111111111";
const descriptor = selfBurnNativeInstance.compileDraft({ familyId: SELF_BURN_NATIVE_FAMILY_ID,
  lineageId: SELF_BURN_NATIVE_LINEAGE_ID, subject: token, token, provenance: [] });
const route = selfBurnNativeRoutes.project({ descriptor })[0];
const source = { number: 123, hash: ethers.id("self-burn-trial-test"), generation: 1 };
const input = { descriptor, route, source, executor, runtimeEvidence: [], amountIn: 100n };
const baseline = { source, implementation: fixture.implementation, oracle: "0x3333333333333333333333333333333333333333",
  supply: 250n, nativeBalance: 180n, fees: { parts: 100n, rate: 10n, min: 0n, max: 1000n } };

test("self-burn repeated use consumes supply and native backing without restoring the source", () => {
  const base = emptyExactTrialState(), first = quoteSelfBurnTrial({ ...input, trialState: base.view }, baseline)!;
  assert.equal(first.amountOut, 90n);
  const after = applyExactTrialState(base, first.stateChanges!, first.stateEffects);
  const second = quoteSelfBurnTrial({ ...input, trialState: after.view }, baseline)!;
  assert.equal(second.amountOut, 90n);
  assert.equal((second.stateChanges![0].value as typeof baseline).nativeBalance, 0n);
  const afterSecond = applyExactTrialState(after, second.stateChanges!, second.stateEffects);
  assert.throws(() => quoteSelfBurnTrial({ ...input, amountIn: 1n, trialState: afterSecond.view }, baseline), /capacity/);
  assert.throws(() => quoteSelfBurnTrial({ ...input, amountIn: 251n, trialState: base.view }, { ...baseline, nativeBalance: 1000n }), /capacity/);
  assert.equal(quoteSelfBurnTrial({ ...input, amountIn: 150n, trialState: base.view }, baseline)!.amountOut, 135n);
  assert.equal(baseline.supply, 250n, "solver amount trials never mutate baseline");
});

test("self-burn config, oracle, supply and native dependencies fail closed before and after loading", () => {
  const base = emptyExactTrialState(), first = quoteSelfBurnTrial({ ...input, trialState: base.view }, baseline)!;
  for (const dependency of first.stateChanges![0].ref.dependencies!) {
    const dirtyFirst = applyExactTrialState(base, [], [dependency]);
    assert.throws(() => quoteSelfBurnTrial({ ...input, trialState: dirtyFirst.view }, baseline), /invalidated dependency/);
    const after = applyExactTrialState(base, first.stateChanges!, first.stateEffects);
    const dirtyAfter = applyExactTrialState(after, [], [dependency]);
    assert.throws(() => quoteSelfBurnTrial({ ...input, trialState: dirtyAfter.view }), /invalidated dependency/);
  }
  assert(first.stateEffects!.includes(tokenSupplyState(token)));
  assert(first.stateEffects!.includes(nativeBalanceState(token)));
  assert(!first.stateEffects!.includes(storageState(baseline.oracle)), "oracle is STATICCALL only");
  const observer = { key: "observer:wrapped-native", schema: "test:v1", binding: "test", dependencies: [storageState(descriptor.nativeAnchor)] };
  const observed = applyExactTrialState(base, [{ ref: observer, value: 1n }]);
  const afterWrap = applyExactTrialState(observed, first.stateChanges!, first.stateEffects);
  assert.throws(() => afterWrap.view.get(observer), /invalidated dependency/, "WETH deposit also changes storage-bound views");
  assert.throws(() => quoteSelfBurnTrial({ ...input, source: { ...source, number: 124 }, trialState: base.view }, baseline), /foreign source/);
  assert.throws(() => quoteSelfBurnTrial({ ...input, executor: token, trialState: base.view }, baseline), /alias/);
});

test("runtime proof binds the proxy and every implementation immutable, not a token address", () => {
  assert(verifySelfBurnProxy(fixture.proxyRuntime));
  assert(verifySelfBurnImplementation(fixture.implementationRuntime, fixture.implementation));
  const moved = ethers.getBytes(fixture.implementationRuntime);
  for (const offset of SELF_BURN_SELF_OFFSETS) moved.set(ethers.getBytes(ethers.zeroPadValue(executor, 32)), offset);
  assert(verifySelfBurnImplementation(ethers.hexlify(moved), executor));
  assert(!verifySelfBurnImplementation(ethers.hexlify(moved), fixture.implementation));
  for (const offset of [0, 400, moved.length - 1]) {
    const changed = ethers.getBytes(fixture.implementationRuntime); changed[offset] ^= 1;
    assert(!verifySelfBurnImplementation(ethers.hexlify(changed), fixture.implementation));
  }
});

test("production preparation validates source/runtime and the fast path overlays its current cell", () => {
  const base = emptyExactTrialState(), i = { ...input, trialState: base.view };
  const values: Record<string, string> = { "exact-wrapFeeParts": ethers.toBeHex(100n, 32), "exact-wrapFeeRate": ethers.toBeHex(10n, 32),
    "exact-wrapFeeMin": ethers.toBeHex(0n, 32), "exact-wrapFeeMax": ethers.toBeHex(1000n, 32),
    "trial-proxy-code": fixture.proxyRuntime, "trial-implementation": ethers.zeroPadValue(fixture.implementation, 32),
    "trial-supply": ethers.toBeHex(250n, 32), "trial-native": ethers.toBeHex(180n, 32), "trial-oracle": ethers.zeroPadValue(baseline.oracle, 32),
    "trial-implementation-code": fixture.implementationRuntime };
  const results = (ids: readonly { id: string }[]): AdapterRequestResult[] => ids.map(({ id }) => ({ id, ok: true, source,
    completion: "returned", provenance: { kind: "test", fingerprint: id }, data: values[id] }));
  const initial = results(selfBurnTrialRequests(i)), dependent = results(selfBurnTrialDependentRequests(i, initial));
  const state = decodeSelfBurnTrial(i, initial, [...initial, ...dependent]);
  const first = quoteSelfBurnTrial(i, state)!, after = applyExactTrialState(base, first.stateChanges!, first.stateEffects);
  const method = selfBurnNativeExact.methods()[1];
  assert(method.kind === "request-program" && method.trialState && typeof method.trialState.quote === "function");
  assert.deepEqual(method.program.requirements(i), { transports: ["eth-call", "get-code", "get-storage"] });
  assert.deepEqual(method.program.buildRequests(i), selfBurnTrialRequests(i));
  const round = method.program.buildDependentProgram!({ programInput: i, initialResults: initial, completedRound: 0, priorEvidence: [] })!;
  const decoded = method.program.decode({ programInput: i, initialResults: initial, dependentEvidence: [round.decode(dependent)] });
  assert.deepEqual(decoded, first, "the production request program returns the same complete transition");
  const quoted = method.trialState.quote({ ...i, trialState: after.view });
  assert.equal(quoted.status, "quoted");
  assert.throws(() => decodeSelfBurnTrial(i, initial, [...initial, { ...dependent[0], source: { ...source, generation: 2 } }]), /foreign source/);
  assert.throws(() => decodeSelfBurnTrial(i, initial, [...initial, { ...dependent[0], data: "0x6000" } as AdapterRequestResult]), /unproven/);
});
