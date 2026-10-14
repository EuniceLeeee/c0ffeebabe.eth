// Offline actual-balance models through the production lifecycle and sealed
// runtime issuer. Historical deployed-Vault execution is recorded separately.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import type { RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { executeAdapterFamilyLifecycle, buildFamilyRuntimeAmountLeg } from "../venues/adapter-family-runtime.js";
import { FamilyCapabilityCatalog, asPricedFamily } from "../venues/family-capability-catalog.js";
import { generatedCapabilityManifestFromShadowArtifact } from "../venues/family-capability-shadow.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_LOAD as load } from "../venues/production-family-composition.js";
import artifact from "../generated/family-capability-shadow.generated.json";
import { fixture, SOURCE, EXECUTOR, FOREIGN, TOKENS, EXTRA } from "../venues/swaps/balancer-v2-family/test/fixtures.js";
import { VAULT, VAULT_ABI, MAX_INPUT, queryData, swapData } from "../venues/swaps/balancer-v2-family/codec.js";
import { BALANCER_V2_FAMILY_ID } from "../venues/swaps/balancer-v2-family/manifest.js";
import { LOG_ID } from "../venues/swaps/balancer-v2-family/discovery.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

const modules = [...load.plugins, ...load.disabledPlugins];
const catalog = new FamilyCapabilityCatalog({ modules, requireCapture: true,
  generatedManifest: generatedCapabilityManifestFromShadowArtifact({ artifact, strictFamilyIds: modules.map(m => m.familyId) }) });
const family = asPricedFamily(catalog.forFamily(BALANCER_V2_FAMILY_ID));
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ERC20 = new ethers.Interface(["function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)"]);

async function prepared(f: ReturnType<typeof fixture>) {
  let queries = 0;
  const runtime = createStrictCentralAdapterRuntime({ executor: EXECUTOR,
    generationFence: { assertCurrent(g, s) { assert.equal(g, SOURCE.generation); assert.deepEqual(s, SOURCE); } },
    provider: {
      async getCode(_address, block) { queries++; assert.equal(block, SOURCE.number); return "0x60006000"; },
      async getStorage() { throw Error("unexpected storage query"); },
      async call(tx, block) { queries++; assert.equal(block ?? tx.blockTag, SOURCE.number);
        const result = f.answer({ id: "recipient-fixture", kind: "eth-call", to: tx.to, data: tx.data, completion: "return-data" });
        assert(result.ok); return result.data;
      },
    } });
  const event = VAULT_ABI.encodeEventLog(VAULT_ABI.getEvent("Swap")!, [f.poolId, ...f.tokens.slice(0, 2), 10n, 20n]);
  const result = await executeAdapterFamilyLifecycle({ family, source: SOURCE, generation: SOURCE.generation, runtime,
    match: { observation: { kind: "log", source: SOURCE, address: VAULT, ...event }, matchedPatternId: LOG_ID },
    publisher: { publish() {} } });
  assert.equal(result.publication?.instances.length, 1);
  const instance = result.publication!.instances[0];
  return instance.routeHandles.map((route, index) => ({ route: instance.routes[index],
    build(settlement?: RuntimeSettlementRequest, executor = EXECUTOR) {
      const before = queries;
      const leg = buildFamilyRuntimeAmountLeg({ family, route, source: SOURCE, executor, runtime,
        runtimeEvidence: [], actionOwnership: catalog, ...(settlement ? { settlement } : {}) });
      assert.equal(queries, before, "runtime construction performed Exact/RPC"); return leg;
    } }));
}

type Fault = "none" | "wrong-recipient" | "old-output-only" | "short-output" | "zero-debit" |
  "under-debit" | "over-debit" | "return-mismatch" | "approval-false" | "cleanup-failed" | "native";
function run(program: string, tokenIn: string, tokenOut: string, poolId: string, amount: bigint, receiver: string, fault: Fault = "none") {
  const key = (t: string, a: string) => `${t.toLowerCase()}:${a.toLowerCase()}`;
  const balances = new Map<string, bigint>();
  const get = (t: string, a: string) => balances.get(key(t, a)) ?? 0n;
  const add = (t: string, a: string, delta: bigint) => {
    const next = get(t, a) + delta; assert(next >= 0n, "fixture underflow"); balances.set(key(t, a), next);
  };
  add(tokenIn, EXECUTOR, amount + 101n); add(tokenOut, EXECUTOR, 103n);
  if (!same(receiver, EXECUTOR)) { add(tokenIn, receiver, 107n); add(tokenOut, receiver, 10n ** 30n); }
  add(tokenIn, VAULT, 10000n); add(tokenOut, VAULT, 10000n);
  const beforeOut = get(tokenOut, receiver), expected = amount * 2n;
  let allowance = 0n, native = 17n, swaps = 0;
  const approvals: bigint[] = [];
  inspectRuntime(program, amount, { nativeBalance: () => native, call(c) {
    assert.equal(c.value, 0n); assert.equal(c.incoming, 0); assert.equal(c.outgoing, 0);
    if (!same(c.target, VAULT)) {
      const q = ERC20.parseTransaction({ data: c.data }); assert(q);
      if (q.name === "balanceOf") { assert(c.static); return ERC20.encodeFunctionResult(q.name, [get(c.target, q.args[0])]); }
      assert(same(c.target, tokenIn));
      if (q.name === "allowance") { assert(c.static); assert(same(q.args[0], EXECUTOR)); assert(same(q.args[1], VAULT));
        return ERC20.encodeFunctionResult(q.name, [allowance]); }
      assert.equal(q.name, "approve"); assert(!c.static); assert(same(q.args[0], VAULT));
      approvals.push(q.args[1]);
      if (!(fault === "approval-false" && q.args[1] > 0n) && !(fault === "cleanup-failed" && swaps > 0)) allowance = q.args[1];
      return ERC20.encodeFunctionResult(q.name, [fault !== "approval-false"]);
    }
    assert(!c.static); const q = VAULT_ABI.decodeFunctionData("swap", c.data), s = q[0], funds = q[1];
    assert.equal(s.poolId, poolId); assert.equal(s.kind, 0n); assert(same(s.assetIn, tokenIn)); assert(same(s.assetOut, tokenOut));
    assert.equal(s.amount, amount); assert.equal(s.userData, "0x"); assert.equal(q[2], 1n); assert.equal(q[3], ethers.MaxUint256);
    assert(same(funds.sender, EXECUTOR)); assert(same(funds.recipient, receiver));
    assert.equal(funds.fromInternalBalance, false); assert.equal(funds.toInternalBalance, false); assert.equal(allowance, amount);
    swaps++;
    const debit = fault === "zero-debit" ? 0n : amount + (fault === "under-debit" ? -1n : fault === "over-debit" ? 1n : 0n);
    add(tokenIn, EXECUTOR, -debit); add(tokenIn, VAULT, debit);
    const credit = fault === "old-output-only" ? 0n : expected - (fault === "short-output" ? 1n : 0n);
    add(tokenOut, VAULT, -credit); add(tokenOut, fault === "wrong-recipient" ? EXECUTOR : receiver, credit);
    if (fault !== "cleanup-failed") allowance = 0n;
    if (fault === "native") native--;
    return VAULT_ABI.encodeFunctionResult("swap", [expected + (fault === "return-mismatch" ? 1n : 0n)]);
  } });
  assert.equal(swaps, 1); assert.deepEqual(approvals, [0n, amount, 0n]); assert.equal(allowance, 0n);
  assert.equal(get(tokenIn, EXECUTOR), 101n); assert.equal(get(tokenIn, VAULT), 10000n + amount);
  assert.equal(get(tokenOut, receiver), beforeOut + expected); assert.equal(get(tokenOut, VAULT), 10000n - expected);
  if (!same(receiver, EXECUTOR)) { assert.equal(get(tokenIn, receiver), 107n); assert.equal(get(tokenOut, EXECUTOR), 103n); }
  assert.equal(native, 17n);
}

test("Balancer V2 issued direct output separates payer/recipient for all two/three-token directions and rejects false receipts", async () => {
  for (const f of [fixture(), fixture([...TOKENS, EXTRA], [18, 18, 6])]) {
    const routes = await prepared(f); assert.equal(routes.length, f.tokens.length * (f.tokens.length - 1));
    for (const { route, build } of routes) {
      const request = { kind: "direct-output" as const, recipient: FOREIGN }, leg = build(request); assert(leg);
      assert.deepEqual(leg.settlement, { directOutput: true }); assert.deepEqual(leg.settlementRequest, request);
      const original = build(); assert(original); assert.equal(original.settlementRequest, undefined);
      for (const amount of [37n, 74n]) {
        run(leg.program, route.tokenIn, route.tokenOut, f.poolId, amount, FOREIGN);
        run(original.program, route.tokenIn, route.tokenOut, f.poolId, amount, EXECUTOR);
      }
      for (const fault of ["wrong-recipient", "old-output-only", "short-output", "zero-debit", "under-debit", "over-debit",
        "return-mismatch", "approval-false", "cleanup-failed", "native"] as const) {
        assert.throws(() => run(leg.program, route.tokenIn, route.tokenOut, f.poolId, 37n, FOREIGN, fault), /runtime amount mismatch|checked uint256 math/);
      }
      assert.throws(() => inspectRuntime(leg.program, 0n), /checked uint256 math/);
      assert.throws(() => inspectRuntime(leg.program, MAX_INPUT + 1n), /runtime amount mismatch/);
      assert.equal(build({ kind: "quote-output" }), null); // queryBatchSwap is not static-call safe.
      assert.equal(build({ kind: "deferred-input", paymentAmount: 37n, paymentProgram: "0x" }), null);
      assert.throws(() => build(request, FOREIGN), /caller mismatch/);
      for (const recipient of [ethers.ZeroAddress, VAULT, f.pool, route.tokenIn, route.tokenOut]) {
        assert.throws(() => build({ kind: "direct-output", recipient }), /invalid executor/);
      }
    }
  }
});

test("Balancer V2 quote and execution ABI preserve default sender and pass the explicit receiver to pool hooks", () => {
  const f = fixture();
  for (const receiver of [EXECUTOR, FOREIGN]) for (const amount of [1n, 37n, MAX_INPUT]) {
    assert.equal(queryData(f.poolId, ...TOKENS as [string, string], amount, EXECUTOR, receiver),
      VAULT_ABI.encodeFunctionData("queryBatchSwap", [0, [[f.poolId, 0, 1, amount, "0x"]], TOKENS,
        [EXECUTOR, false, receiver, false]]));
    const q = VAULT_ABI.decodeFunctionData("swap", swapData(f.poolId, ...TOKENS as [string, string], amount, 1n, EXECUTOR, receiver));
    assert(same(q[1].sender, EXECUTOR)); assert(same(q[1].recipient, receiver));
  }
  assert.equal(queryData(f.poolId, TOKENS[0], TOKENS[1], 37n, EXECUTOR), queryData(f.poolId, TOKENS[0], TOKENS[1], 37n, EXECUTOR, EXECUTOR));
  assert.equal(swapData(f.poolId, TOKENS[0], TOKENS[1], 37n, 1n, EXECUTOR), swapData(f.poolId, TOKENS[0], TOKENS[1], 37n, 1n, EXECUTOR, EXECUTOR));
});
