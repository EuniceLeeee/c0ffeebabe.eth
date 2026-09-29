import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ethers } from "ethers";
import { applyExactTrialState, emptyExactTrialState } from "../../../../exact-trial-state.js";
import { storageState } from "../../../local-state-models/resources.js";
import { etherTokenNativeRedeemInstance } from "../instance.js";
import { etherTokenNativeRedeemRoutes } from "../routes.js";
import { etherTokenNativeRedeemExact } from "../exact.js";
import { ETHERTOKEN_NATIVE_FAMILY_ID, ETHERTOKEN_NATIVE_LINEAGE_ID } from "../manifest.js";
import { decodeEtherTokenTrial, etherTokenTrialRequests, quoteEtherTokenTrial, verifyEtherTokenTrialRuntime } from "../trial-state.js";
import type { AdapterRequestResult } from "../../../adapter-request-program.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/runtime.json", import.meta.url), "utf8"));
const token = "0x2222222222222222222222222222222222222222", executor = "0x1111111111111111111111111111111111111111";
const descriptor = etherTokenNativeRedeemInstance.compileDraft({ familyId: ETHERTOKEN_NATIVE_FAMILY_ID,
  lineageId: ETHERTOKEN_NATIVE_LINEAGE_ID, subject: token, token, provenance: [] });
const route = etherTokenNativeRedeemRoutes.project({ descriptor })[0];
const source = { number: 123, hash: ethers.id("ethertoken-trial-test"), generation: 1 };
const input = { descriptor, route, source, executor, runtimeEvidence: [], amountIn: 100n };
const baseline = { source, supply: 250n, nativeBalance: 200n };

test("EtherToken repeated burn consumes inventory; independent amount trials stay isolated", () => {
  const base = emptyExactTrialState(), first = quoteEtherTokenTrial({ ...input, trialState: base.view }, baseline)!;
  const after = applyExactTrialState(base, first.stateChanges!, first.stateEffects);
  const second = quoteEtherTokenTrial({ ...input, trialState: after.view }, baseline)!;
  assert.equal(second.amountOut, 100n);
  assert.equal((second.stateChanges![0].value as typeof baseline).nativeBalance, 0n);
  const afterSecond = applyExactTrialState(after, second.stateChanges!, second.stateEffects);
  assert.throws(() => quoteEtherTokenTrial({ ...input, amountIn: 1n, trialState: afterSecond.view }, baseline), /capacity/);
  assert.throws(() => quoteEtherTokenTrial({ ...input, amountIn: 251n, trialState: base.view }, { ...baseline, nativeBalance: 1000n }), /capacity/);
  assert.equal(quoteEtherTokenTrial({ ...input, amountIn: 200n, trialState: base.view }, baseline)!.amountOut, 200n);
  assert.equal(baseline.supply, 250n);
});

test("EtherToken effects cannot be overwritten by old source reads", () => {
  const base = emptyExactTrialState(), first = quoteEtherTokenTrial({ ...input, trialState: base.view }, baseline)!;
  for (const dependency of first.stateChanges![0].ref.dependencies!) {
    const dirty = applyExactTrialState(base, [], [dependency]);
    assert.throws(() => quoteEtherTokenTrial({ ...input, trialState: dirty.view }, baseline), /invalidated dependency/);
    const after = applyExactTrialState(base, first.stateChanges!, first.stateEffects);
    assert.throws(() => quoteEtherTokenTrial({ ...input, trialState: applyExactTrialState(after, [], [dependency]).view }, baseline), /invalidated dependency/);
  }
  const observer = { key: "observer:wrapped-native", schema: "test:v1", binding: "test", dependencies: [storageState(descriptor.nativeAnchor)] };
  const observed = applyExactTrialState(base, [{ ref: observer, value: 1n }]);
  const afterWrap = applyExactTrialState(observed, first.stateChanges!, first.stateEffects);
  assert.throws(() => afterWrap.view.get(observer), /invalidated dependency/, "WETH deposit also changes storage-bound views");
  assert.throws(() => quoteEtherTokenTrial({ ...input, source: { ...source, number: 124 }, trialState: base.view }, baseline), /foreign source/);
  assert.throws(() => quoteEtherTokenTrial({ ...input, executor: token, trialState: base.view }, baseline), /alias/);
});

test("positive method binds a verified runtime model; preparation and fast path share state", () => {
  assert(verifyEtherTokenTrialRuntime(fixture.runtime));
  assert(!verifyEtherTokenTrialRuntime("0x6000"));
  const changed = ethers.getBytes(fixture.runtime); changed[100] ^= 1;
  assert(!verifyEtherTokenTrialRuntime(ethers.hexlify(changed)));
  const base = emptyExactTrialState(), i = { ...input, trialState: base.view };
  const values: Record<string, string> = { "trial-token-code": fixture.runtime, "trial-supply": ethers.toBeHex(250n, 32), "trial-native": ethers.toBeHex(200n, 32) };
  const results: AdapterRequestResult[] = etherTokenTrialRequests(i).map(({ id }) => ({ id, ok: true, source,
    completion: "returned", provenance: { kind: "test", fingerprint: id }, data: values[id] }));
  const first = quoteEtherTokenTrial(i, decodeEtherTokenTrial(i, results))!, after = applyExactTrialState(base, first.stateChanges!, first.stateEffects);
  const method = etherTokenNativeRedeemExact.methods()[1];
  assert(method.kind === "request-program" && method.trialState && typeof method.trialState.quote === "function");
  assert.deepEqual(method.program.requirements(i), { transports: ["eth-call", "get-code"] });
  assert.deepEqual(method.program.buildRequests(i), etherTokenTrialRequests(i));
  assert.deepEqual(method.program.decode({ programInput: i, initialResults: results, dependentEvidence: [] }), first);
  assert.deepEqual(method.program.requirements(input), { transports: [] }, "independent original amount model is retained");
  assert.equal(method.program.decode({ programInput: input, initialResults: [], dependentEvidence: [] }).amountOut, 100n);
  assert.equal(method.trialState.quote({ ...i, trialState: after.view }).status, "quoted");
  assert.throws(() => decodeEtherTokenTrial(i, results.map(r => r.id === "trial-token-code" ? { ...r, data: "0x6000" } as AdapterRequestResult : r)), /unproven/);
  assert.throws(() => decodeEtherTokenTrial(i, results.map(r => ({ ...r, source: { ...source, number: 124 } }))), /foreign source/);
});
