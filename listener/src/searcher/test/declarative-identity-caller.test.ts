import assert from "node:assert/strict";
import test from "node:test";
import { Interface, keccak256, toBeHex } from "ethers";
import { compileDeclarativeIdentity } from "../venues/declarative-identity.js";
import definition from "../venues/protocols/erc4626-silo-redeem-family/erc4626-silo-redeem.json";
import { createRevmStrictSimulationTransport } from "../revm-strict-simulation-transport.js";
import type { StrictSimulateRequest, DaemonResponse } from "../revm-sim-client.js";

// Exercise the installed declaration through the production transport. An EOA
// behavior probe is not an executor frame, even in a counterfactual test run.
test("installed identity probe retains its own caller with deployed and counterfactual executors", async () => {
  const address = (n: number) => toBeHex(n, 20);
  const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
  const pin = { chainId: 1, blockHash: source.hash, stateRoot: toBeHex(101, 32) };
  const executor = address(2), owner = address(1), vault = address(3), payout = address(4);
  const actor = definition.identity.definition.constants.probeActor;
  const caller = definition.identity.definition.constants.caller;
  const identity = compileDeclarativeIdentity(definition.identity.definition as any, {
    id: "observed-payout-active-proof", familyId: definition.scope.family as any,
    lineageId: definition.standard.lineageId as any,
  });
  const step = { candidate: {}, step: 2, evidence: {
    phase: "preview", vault, payoutToken: payout, sampleShares: 7n, sampleAssets: 11n,
  } };
  const request = identity.buildRequests(step as any).find(r => r.id === "identity-active-redeem");
  assert(request && request.kind === "effect-delta-simulation");
  const abi = new Interface(definition.identity.definition.abi.vault);
  assert.deepEqual([...abi.decodeFunctionData("redeem", request.call.data)].map(String), [payout, "7", actor, actor]);
  assert.deepEqual(request.call.caller, caller);
  assert.deepEqual(request.overrideIntent.caller, caller);
  assert.equal(request.call.executionMode, "top-level");
  for (const counterfactual of [false, true]) {
    const calls: StrictSimulateRequest[] = [];
    const code = { code: "0x60006000", keccak256: keccak256("0x60006000") };
    const transport = createRevmStrictSimulationTransport({
      rpcUrl: "http://127.0.0.1:1", executionGasLimit: 1_000_000,
      executorRuntimeCode: code,
      ...(counterfactual ? { preserveExecutorCode: false, provisionedExecutor: executor } : {}),
      leaseFor: async () => ({ source, sourcePin: pin, closeAndDrain: async () => {},
        strictSimulate: async (wire): Promise<DaemonResponse> => {
          calls.push(wire);
          assert.equal(wire.from, actor); assert.equal(wire.to, vault);
          assert.equal(wire.callerMode, "top-level");
          assert.equal(wire.transactionOrigin, undefined);
          assert.equal(wire.executorRuntimeCode, undefined);
          assert.deepEqual(wire.tokenDeals, [{ token: vault, to: actor, amount: "7" }]);
          assert.deepEqual(wire.observeTokenBalances, [{ token: vault, account: actor }, { token: payout, account: actor }]);
          const output = abi.encodeFunctionResult("redeem", [11n]);
          return { ok: true, success: true, output, gasUsed: "21000", latencyMs: 1,
            sourceAttestation: { kind: "node-attested", ...pin, blockNumber: source.number, parentHash: toBeHex(99, 32) },
            strict: { outcome: { kind: "Success", phase: "main", output }, executionGasUsed: "21000",
              tokenDeltas: [{ token: vault, account: actor, delta: "-7" }, { token: payout, account: actor, delta: "11" }],
              nativeDeltas: [], totalSupplyDeltas: [{ token: vault, delta: "-7" }], logs: [] } };
        } }),
      onFatal: () => assert.fail("valid probe must not fault the source"),
    });
    const invocation = { source, request, callerAuthority: { executor, transactionOrigin: owner,
      verifiedActors: { [caller.evidenceId]: actor } } };
    const result = await transport.simulate(invocation);
    assert.equal(result.data, abi.encodeFunctionResult("redeem", [11n]));
    assert.equal(calls.length, 1);
    if (counterfactual) {
      await assert.rejects(transport.simulate({ ...invocation, request: { ...request,
        call: { ...request.call, executionMode: "impersonated-call-frame" } } }), /invalid strict simulation/);
      assert.equal(calls.length, 1, "the old declaration must still fail before dispatch; no impersonation bypass");
    }
  }
});
