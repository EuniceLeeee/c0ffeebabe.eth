// Synthetic emitted-program / balance models, not historical EVM acceptance.
// The production settlement composer observes real model balance changes. Only
// its quote and deferred-funding counterpart below are explicit fixtures; this
// does NOT declare quote-output/deferred-input capability for these Families.
import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { RuntimeAmountProgram, type RuntimeAmountLeg, type RuntimeSettlementRequest } from "../../adapters/runtime-amount-program.js";
import { buildRuntimeSettlementRoot } from "../simulator/runtime-settlement.js";
import { inspectRuntime, type RuntimeCall } from "./runtime-program-testkit.js";
import { curvePlainExecution } from "../venues/swaps/curve-plain-family/execution.js";
import { curvePlainInstance } from "../venues/swaps/curve-plain-family/instance.js";
import { curvePlainRoutes } from "../venues/swaps/curve-plain-family/routes.js";
import { CURVE_PLAIN_FAMILY_ID, CURVE_PLAIN_LINEAGE } from "../venues/swaps/curve-plain-family/manifest.js";
import type { CurvePlainMode } from "../venues/swaps/curve-plain-family/types.js";
import { dodoV2Execution } from "../venues/swaps/dodo-v2-family/execution.js";
import { dodoV2Instance } from "../venues/swaps/dodo-v2-family/instance.js";
import { dodoV2Routes } from "../venues/swaps/dodo-v2-family/routes.js";
import { DODO_V2_FAMILY_ID, DODO_V2_REGISTRY_LINEAGE_ID } from "../venues/swaps/dodo-v2-family/manifest.js";
import { ekuboExecution } from "../venues/swaps/ekubo-family/execution.js";
import { ekuboInstance } from "../venues/swaps/ekubo-family/instance.js";
import { ekuboRoutes } from "../venues/swaps/ekubo-family/routes.js";
import { EKUBO_FAMILY_ID, EKUBO_LINEAGE } from "../venues/swaps/ekubo-family/manifest.js";
import { EKUBO_SUPPORTED_CORE_HASH, EKUBO_SUPPORTED_ROUTER_HASH } from "../venues/swaps/ekubo-family/extension.js";
import { ekuboPoolId } from "../venues/swaps/ekubo/pool-key.js";
import { EKUBO_CORE, EKUBO_ROUTER, ekuboRouterIface } from "../venues/swaps/ekubo/abi.js";

const addr = (n: number) => ethers.getAddress(ethers.toBeHex(n, 20));
const actor = addr(101), recipient = addr(102), origin = addr(103), pool = addr(200);
const token0 = addr(201), token1 = addr(202), amount = 37n, expectedOutput = 74n;
const word = (n: bigint) => ethers.toBeHex(n, 32);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const token = new ethers.Interface(["function balanceOf(address) view returns(uint256)", "function transfer(address,uint256) returns(bool)"]);
const swaps = new ethers.Interface([
  "function exchange_received(int128,int128,uint256,uint256,address) returns(uint256)",
  "function exchange_received(uint256,uint256,uint256,uint256,address) returns(uint256)",
  "function sellBase(address) returns(uint256)", "function sellQuote(address) returns(uint256)",
]);
const release = new ethers.Interface(["function fixtureRelease(uint256)"]);
type Fault = "none" | "wrong-recipient" | "short-output" | "old-output-only" | "under-debit" | "over-debit" | "native";
type Build = (request?: RuntimeSettlementRequest) => RuntimeAmountLeg | null;

function runRecipientModel(input: {
  build: Build; tokenIn: string; tokenOut: string; custody: string;
  fault: Fault; kind: "curve-int" | "curve-uint" | "dodo-base" | "dodo-quote" | "ekubo";
}) {
  const balanceKey = (t: string, a: string) => `${t.toLowerCase()}:${a.toLowerCase()}`;
  const balances = new Map<string, bigint>();
  const get = (t: string, a: string) => balances.get(balanceKey(t, a)) ?? 0n;
  const add = (t: string, a: string, delta: bigint) => {
    const next = get(t, a) + delta; assert(next >= 0n, "fixture balance underflow"); balances.set(balanceKey(t, a), next);
  };
  add(input.tokenIn, actor, 101n); add(input.tokenOut, actor, 103n);
  add(input.tokenOut, recipient, 107n); // More old output than the expected new receipt.
  add(input.tokenIn, input.custody, 1000n); add(input.tokenOut, input.custody, 1000n);
  let native = 17n, swapCalls = 0;
  const debit = () => amount + (input.fault === "under-debit" ? -1n : input.fault === "over-debit" ? 1n : 0n);
  const base = input.build(); assert(base?.settlement?.directOutput);
  const direct = input.build({ kind: "direct-output", recipient }); assert(direct);
  assert.deepEqual(direct.settlementRequest, { kind: "direct-output", recipient });
  assert.equal(input.build({ kind: "quote-output" }), null);
  assert.equal(input.build({ kind: "deferred-input", paymentAmount: amount, paymentProgram: "0x" }), null);
  const quote = new RuntimeAmountProgram().constant(0, expectedOutput);
  const fixtureLegs: Array<RuntimeAmountLeg & { tokenIn: string; tokenOut: string }> = [
    { ...base, tokenIn: input.tokenIn, tokenOut: input.tokenOut,
      settlement: { directOutput: true, quoteOutput: true } },
    { actionAdapterId: "fixture-deferred", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 0n).bytes()),
      tokenIn: input.tokenOut, tokenOut: input.tokenIn, settlement: { deferredInput: recipient } },
  ];
  const root = buildRuntimeSettlementRoot({ legs: fixtureLegs, amount, minimumProfit: 1n, executor: actor,
    build(index, request) {
      if (index === 0) return request.kind === "quote-output"
        ? { actionAdapterId: "fixture-quote", program: ethers.hexlify(quote.bytes()) } : input.build(request);
      if (request.kind !== "deferred-input") return null;
      // A fixed debt fixture releases the input before the production payment
      // program. Debt is checked against the measured recipient increment,
      // never a Family return value or the recipient's pre-existing balance.
      const p = new RuntimeAmountProgram().call(recipient, release.encodeFunctionData("fixtureRelease", [amount + 1n]))
        .constant(1, request.paymentAmount).run(request.paymentProgram, 1, 2).constant(3, expectedOutput).equal(2, 3);
      return { actionAdapterId: "fixture-deferred", program: ethers.hexlify(p.bytes()) };
    },
  });
  assert(root);
  const call = (c: RuntimeCall): string => {
    if (c.static && c.data.startsWith(token.getFunction("balanceOf")!.selector)) {
      const [owner] = token.decodeFunctionData("balanceOf", c.data); return word(get(c.target, owner));
    }
    assert.equal(c.value, 0n); assert.equal(c.incoming, 0); assert.equal(c.outgoing, 0);
    if (same(c.target, recipient)) {
      const [value] = release.decodeFunctionData("fixtureRelease", c.data); assert.equal(value, amount + 1n);
      add(input.tokenIn, actor, value); return "0x";
    }
    if (same(c.target, input.tokenIn)) {
      const [to, value] = token.decodeFunctionData("transfer", c.data);
      assert(same(to, input.custody)); assert.equal(value, amount);
      add(input.tokenIn, actor, -debit()); add(input.tokenIn, input.custody, amount); return word(1n);
    }
    swapCalls++;
    let to: string;
    if (input.kind === "ekubo") {
      assert(same(c.target, EKUBO_ROUTER));
      const q = ekuboRouterIface.decodeFunctionData("swap", c.data);
      assert.equal(q[2], amount); assert.equal(q[3], 0n); assert.equal(q[4], 0n); assert.equal(q[5], 1n);
      to = q[6]; add(input.tokenIn, actor, -debit()); add(input.tokenIn, input.custody, amount);
    } else {
      assert(same(c.target, pool));
      const q = swaps.parseTransaction({ data: c.data })!;
      if (input.kind.startsWith("curve")) {
        assert.equal(q.signature, input.kind === "curve-int" ? "exchange_received(int128,int128,uint256,uint256,address)" :
          "exchange_received(uint256,uint256,uint256,uint256,address)");
        assert.equal(q.args[0], 0n); assert.equal(q.args[1], 1n); assert.equal(q.args[2], amount);
        assert.equal(q.args[3], 1n); to = q.args[4];
      } else {
        assert.equal(q.name, input.kind === "dodo-base" ? "sellBase" : "sellQuote"); to = q.args[0];
      }
      assert.equal(get(input.tokenIn, input.custody), 1000n + amount, "prepayment precedes the ordinary swap");
    }
    assert(same(to, recipient));
    const received = input.fault === "old-output-only" ? 0n : expectedOutput - (input.fault === "short-output" ? 1n : 0n);
    add(input.tokenOut, input.custody, -received);
    add(input.tokenOut, input.fault === "wrong-recipient" ? actor : to, received);
    if (input.fault === "native") native--;
    return word(999999n); // Deliberately untrusted; the composer measures balances.
  };
  const result = inspectRuntime(root.params.settlementProgram as string, amount, {
    call, nativeBalance: () => native,
    allowance(grant) { assert.equal(input.kind, "ekubo"); assert(same(grant.token, input.tokenIn));
      assert(same(grant.spender, EKUBO_ROUTER)); assert.equal(grant.minimum, amount); },
  });
  assert.equal(swapCalls, 1); assert.equal(get(input.tokenIn, actor), 102n);
  assert.equal(get(input.tokenOut, actor), 103n); assert.equal(get(input.tokenOut, recipient), 107n + expectedOutput);
  assert.equal(get(input.tokenIn, input.custody), 1000n + amount);
  assert.equal(get(input.tokenOut, input.custody), 1000n - expectedOutput); assert.equal(native, 17n);
  return result;
}

function curve(mode: CurvePlainMode) {
  const d = curvePlainInstance.compileDraft({ familyId: CURVE_PLAIN_FAMILY_ID, lineageId: CURVE_PLAIN_LINEAGE,
    subject: pool, provenance: [], facts: { pool,
      binding: { quoteAbi: mode.includes("uint") ? "uint256" : "int128", coinAbi: "uint256", balanceAbi: "uint256",
        registry: addr(301), handlers: [addr(302)], codeHash: ethers.ZeroHash, coins: [token0, token1], decimals: [18, 18] },
      directions: [{ i: 0, j: 1, tokenIn: token0, tokenOut: token1, amountIn: amount, amountOut: expectedOutput, executionMode: mode }] } });
  const route = curvePlainRoutes.project({ descriptor: d })[0];
  return (settlement?: RuntimeSettlementRequest) => curvePlainExecution.buildRuntimeLeg({ descriptor: d, route,
    executor: actor, runtimeEvidence: [], ...(settlement ? { settlement } : {}) });
}
for (const mode of ["received", "received-uint"] as const) test(`Curve ${mode}: direct recipient receipt and production settlement rejection controls`, () => {
  const build = curve(mode);
  for (const fault of ["none", "wrong-recipient", "short-output", "old-output-only", "under-debit", "over-debit", "native"] as const) {
    const run = () => runRecipientModel({ build, tokenIn: token0, tokenOut: token1, custody: pool,
      kind: mode === "received" ? "curve-int" : "curve-uint", fault });
    if (fault === "none") run(); else assert.throws(run, /runtime amount mismatch|checked uint256 math/);
  }
});
test("Curve non-receiver entry modes retain default execution without a direct-output declaration", () => {
  for (const mode of ["received-no-receiver", "exchange", "exchange-uint"] as const) {
    const build = curve(mode); assert.equal(build()?.settlement?.directOutput, undefined);
    assert.equal(build({ kind: "direct-output", recipient }), null);
  }
});

const dodo = dodoV2Instance.compileDraft({ familyId: DODO_V2_FAMILY_ID, lineageId: DODO_V2_REGISTRY_LINEAGE_ID,
  subject: pool, provenance: [], facts: { pool, baseToken: token0, quoteToken: token1,
    registryBinding: { registry: addr(401), listedPool: pool }, quoteActorBinding: { actor: origin, role: "verified-actor",
      feeSemantics: "getUserFeeRate(actor)", querySemantics: "querySellBase/querySellQuote(actor,effectiveInput)",
      inputSemantics: "balance-reserve-mt-fee-v1" } } });
for (const route of dodoV2Routes.project({ descriptor: dodo })) test(`DODO ${route.direction}: ordinary to recipient, caller prepayment and unchanged origin requirement`, () => {
  const base = { descriptor: dodo, route, executor: actor, runtimeEvidence: [] };
  const build: Build = settlement => dodoV2Execution.buildRuntimeLeg({ ...base, transactionOrigin: origin,
    ...(settlement ? { settlement } : {}) });
  assert.throws(() => dodoV2Execution.buildRuntimeLeg({ ...base, settlement: { kind: "direct-output", recipient } }), /origin/);
  for (const fault of ["none", "wrong-recipient", "short-output", "old-output-only", "under-debit", "over-debit", "native"] as const) {
    const run = () => runRecipientModel({ build, tokenIn: route.tokenIn, tokenOut: route.tokenOut, custody: pool,
      kind: route.direction === "sell-base" ? "dodo-base" : "dodo-quote", fault });
    if (fault === "none") run(); else assert.throws(run, /runtime amount mismatch|checked uint256 math/);
  }
});

function ekubo(native = false) {
  const poolKey = { token0: native ? ethers.ZeroAddress : token0, token1, config: word(3000n) };
  return ekuboInstance.compileDraft({ familyId: EKUBO_FAMILY_ID, lineageId: EKUBO_LINEAGE,
    subject: ekuboPoolId(poolKey), provenance: [], facts: { poolId: ekuboPoolId(poolKey), poolKey,
      coreCodeHash: EKUBO_SUPPORTED_CORE_HASH, routerCodeHash: EKUBO_SUPPORTED_ROUTER_HASH, decimals: [18, 18] } });
}
const ekuboDescriptor = ekubo();
for (const route of ekuboRoutes.project({ descriptor: ekuboDescriptor })) test(`Ekubo token${route.isToken1 ? "1" : "0"} input: ordinary ERC20 recipient and actual settlement deltas`, () => {
  const build: Build = settlement => ekuboExecution.buildRuntimeLeg({ descriptor: ekuboDescriptor, route,
    executor: actor, runtimeEvidence: [], ...(settlement ? { settlement } : {}) });
  for (const fault of ["none", "wrong-recipient", "short-output", "old-output-only", "under-debit", "over-debit", "native"] as const) {
    const run = () => runRecipientModel({ build, tokenIn: route.tokenIn, tokenOut: route.tokenOut, custody: EKUBO_CORE,
      kind: "ekubo", fault });
    if (fault === "none") run(); else assert.throws(run, /runtime amount mismatch|checked uint256 math/);
  }
  assert.throws(() => inspectRuntime(build({ kind: "direct-output", recipient })!.program, 1n << 127n), /runtime amount mismatch/);
});
test("Ekubo native pairs expose mapped direct delivery and reject raw external native output", () => {
  const descriptor = ekubo(true);
  for (const route of ekuboRoutes.project({ descriptor })) {
    const input = { descriptor, route, executor: actor, runtimeEvidence: [] };
    assert.equal(ekuboExecution.buildRuntimeLeg(input)?.settlement?.directOutput, true);
    const direct = ekuboExecution.buildRuntimeLeg({ ...input, settlement: { kind: "direct-output", recipient } });
    if (route.isToken1) assert.equal(direct, null); else assert(direct);
    assert(ekuboExecution.buildRuntimeLeg({ ...input, settlement: { kind: "direct-output", recipient: actor } }));
    assert.equal(ekuboExecution.buildRuntimeLeg({ ...input, settlement: { kind: "quote-output" } }), null);
    assert.equal(ekuboExecution.buildRuntimeLeg({ ...input, settlement: { kind: "deferred-input", paymentAmount: amount, paymentProgram: "0x" } }), null);
  }
});
