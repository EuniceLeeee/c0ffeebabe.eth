import assert from "node:assert/strict";
import { ethers } from "ethers";
import { RuntimeAmountProgram, runtimeAmountFlowAdapter } from "../../../../../adapters/runtime-amount-program.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { plugin } from "../../../production-families/psm.production.js";
import { PSM_INTERFACE, PSM_WAD, psmBuyCost, psmBuyQuote, psmSellQuote } from "../codec.js";
import { PSM_FAMILY_ID, PSM_LINEAGE_ID } from "../manifest.js";
import type { PsmIdentity } from "../types.js";
import type { AdapterRequestResult, CanonicalSource } from "../../../adapter-request-program.js";

// Synthetic contract tests over the actual production plugin, not chain acceptance.
const executor = "0x1111111111111111111111111111111111111111";
const identity: PsmIdentity = { familyId: PSM_FAMILY_ID, lineageId: PSM_LINEAGE_ID,
  subject: "0x2222222222222222222222222222222222222222", provenance: [],
  gem: "0x3333333333333333333333333333333333333333", dai: "0x4444444444444444444444444444444444444444" };
const descriptor = plugin.instance.finalizeDescriptor({ identity,
  draft: plugin.instance.compileDraft(identity), sharedBindings: [] });
const routes = plugin.routes.project({ descriptor });
const source: CanonicalSource = { number: 123, hash: ethers.id("psm-test"), generation: 1 };
const returned = (id: string, fee: bigint): AdapterRequestResult => ({ id, source, ok: true,
  completion: "returned", provenance: { kind: "fixture", fingerprint: "psm-bidirectional" },
  data: ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [fee]) });
assert.deepEqual(routes.map(r => [r.direction, r.tokenIn.toLowerCase(), r.tokenOut.toLowerCase()]), [
  ["sell-gem", identity.gem, identity.dai], ["buy-gem", identity.dai, identity.gem],
]);
assert.notEqual(routes[0].routeKey, routes[1].routeKey);

// Independent forward-cost check verifies the exact integer inverse, including
// boundaries where flooring the continuous inverse would lose one output unit.
for (const scale of [1n, 10n, 10n ** 12n]) for (const fee of [0n, 1n, PSM_WAD / 1000n, PSM_WAD]) {
  for (let amount = 0n; amount < 1000n; amount++) {
    const input = amount * scale + amount % scale;
    const output = psmBuyQuote(input, fee, scale);
    const cost = (gem: bigint) => gem * scale + gem * scale * fee / PSM_WAD;
    assert(cost(output) <= input);
    assert(cost(output + 1n) > input);
    assert.equal(psmBuyCost(output, fee, scale), cost(output));
  }
}
assert.throws(() => psmBuyQuote(-1n, 0n, 1n));
assert.throws(() => psmBuyQuote(1n << 256n, 0n, 1n));
assert.throws(() => psmBuyQuote(1n, (1n << 256n) - 1n, 1n));
assert.throws(() => psmBuyCost(1n << 255n, PSM_WAD, 1n), /overflow/);

for (const route of routes) for (const fee of [0n, 10n ** 15n]) {
  const sell = route.direction === "sell-gem";
  const amountIn = sell ? 1_234_567n : 1_234_567_890_123_456_789n;
  const input = { descriptor, route, amountIn, source, executor, runtimeEvidence: [] };
  const method = plugin.exact.methods(input)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing request method");
  const requests = method.program.buildRequests(input);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert(request.kind === "eth-call");
  assert.equal(PSM_INTERFACE.parseTransaction({ data: request.data })!.name, sell ? "tin" : "tout");
  const initialResults = [returned(request.id, fee)];
  const exact = method.program.decode({ programInput: input, initialResults, dependentEvidence: [] });
  assert.equal(exact.amountOut, (sell ? psmSellQuote : psmBuyQuote)(amountIn, fee, descriptor.decimalScale));
  assert.throws(() => method.program.decode({ programInput: input,
    initialResults: initialResults.map(r => ({ ...r, source: { ...source, generation: 2 } })), dependentEvidence: [] }), /foreign source/);
  assert.throws(() => method.program.buildRequests({ ...input, route: { ...route, tokenIn: route.tokenOut } }), /verified direction/);
  const fragmentInput = { ...input, quotedAmountOut: exact.amountOut, minAmountOut: exact.amountOut,
    exactEvidence: exact.evidence };
  const fragment = plugin.execution.buildFragment(fragmentInput);
  const node = fragment.nodes[0];
  const encoded = plugin.actionAdapters[0].encode(node, executor, new Uint8Array());
  const parsed = PSM_INTERFACE.parseTransaction({ data: ethers.hexlify(encoded.slice(24)) })!;
  assert.equal(parsed.name, sell ? "sellGem" : "buyGem");
  assert.equal(parsed.args[0].toLowerCase(), executor);
  assert.equal(parsed.args[1], sell ? amountIn : exact.amountOut);
  assert.equal(node.amount, amountIn, "input amount remains DAI for buyGem");
  assert.throws(() => plugin.execution.buildFragment({ ...fragmentInput,
    exactEvidence: { ...exact.evidence, direction: sell ? "buy-gem" : "sell-gem" } }), /incompatible/);
  assert.throws(() => plugin.actionAdapters[0].encode({ ...node, params: {} }, executor, new Uint8Array()), /invalid/);
}
const draft = plugin.pricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes });
const pricing = plugin.pricing.finalizePricingDescriptor({ draft, sharedBindings: [] });
const reads = plugin.pricing.current.buildRequests({ descriptor: pricing, routes, source });
assert.equal(reads.length, 2);
const snapshot = plugin.pricing.current.decodeSnapshot({ descriptor: pricing,
  initialResults: reads.map(r => returned(r.id, 10n ** 15n)), dependentEvidence: [] });
const mids = plugin.pricing.current.deriveMids({ descriptor: pricing, snapshot, routes });
assert.equal(mids.size, 2);
assert.equal(snapshot.quotes[routes[0].routeKey].amountOut, psmSellQuote(10n ** 6n, 10n ** 15n, descriptor.decimalScale));
assert.equal(snapshot.quotes[routes[1].routeKey].amountOut, psmBuyQuote(10n ** 18n, 10n ** 15n, descriptor.decimalScale));
assert.throws(() => plugin.pricing.compileDraft({ descriptor, stateKey: descriptor.instanceKey, routes: [routes[0], routes[0]] }), /distinct/);
for (const halted of ["buy-gem", "sell-gem", null]) {
  const current = plugin.pricing.current.decodeSnapshot({ descriptor: pricing, dependentEvidence: [],
    initialResults: reads.map(r => returned(r.id, r.id === `current-${halted}` ? (1n << 256n) - 1n : 0n)) });
  const available = plugin.pricing.current.deriveMids({ descriptor: pricing, snapshot: current, routes });
  assert.equal(available.size, halted === null ? 2 : 1);
  for (const route of routes) assert.equal(available.has(route.routeKey), route.direction !== halted);
}
console.log("PSM production plugin bidirectional integer quotes, raw mids, exact evidence and execution encoding PASS (synthetic)");


// A buyGem budget may leave more than one raw DAI unit without reducing the
// requested input. The shared selector must encode that policy independently
// of the 0/1 rounding flag; sellGem continues to require an exact debit.
for (const route of routes) for (const tolerance of [0n, 1n]) {
  const buy = route.direction === "buy-gem", amount = buy ? 1_234_567_890_123_456_789n : 1_234_567n;
  if (buy) assert(amount - psmBuyCost(psmBuyQuote(amount, 0n, descriptor.decimalScale), 0n, descriptor.decimalScale) > 1n);
  let exactCalls = 0, quotedCalls = 0, rpcCalls = 0, simulated = 0;
  const edges = [
    { adapterId: "psm", target: descriptor.target, tokenIn: route.tokenIn, tokenOut: route.tokenOut },
    { adapterId: "fixture-return", target: executor, tokenIn: route.tokenOut, tokenOut: route.tokenIn },
  ];
  const session: any = {
    source, fundingActionIds: () => ["fixture-funding"],
    buildRuntimeAmountLeg({ edge }: any) {
      return edge === edges[0]
        ? plugin.execution.buildRuntimeLeg!({ descriptor, route, source, executor, runtimeEvidence: [] })
        : { actionAdapterId: "fixture-return", program: ethers.hexlify(new RuntimeAmountProgram().constant(1, 1n).bytes()) };
    },
    issueExact() { exactCalls++; throw new Error("unexpected Exact"); },
    buildExecution() { quotedCalls++; throw new Error("unexpected quoted fallback"); },
    buildFundingRoot(input: any) {
      return { adapterId: "fixture-funding", target: executor, tokenIn: route.tokenIn,
        tokenOut: route.tokenIn, amount: input.amount, params: {}, children: input.children };
    },
  };
  const selector = createBlockScanSimAmountSelector({ source, executor, async simulate(plan) {
    simulated++;
    const flow = plan.root.children[0]!;
    const bytes = runtimeAmountFlowAdapter.encode(flow, executor, new Uint8Array());
    assert.equal(bytes[36], 2 | (Number(tolerance) << 7) | (buy ? 0x40 : 0));
    if (buy) assert.equal(bytes[37], 1, "only buyGem declares a maximum input");
    assert.equal(BigInt(ethers.hexlify(bytes.slice(4, 36))), plan.root.amount,
      "the funding/request amount is not pre-rounded");
    return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n,
      profitToken: route.tokenIn, calldata: "0x" };
  } });
  await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: amount },
    flashToken: route.tokenIn, profitToken: route.tokenIn }, tokenPath: { edges },
    maxFlashAmount: amount * 1000n, templateName: "psm-budget-contract" } as any,
    { call() { rpcCalls++; throw new Error("unexpected RPC"); } } as any, { executor } as any,
    { strictSession: session, deferPhase2Sim: true, quoteToleranceRawUnits: tolerance,
      gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
  assert.equal(exactCalls, 0); assert.equal(quotedCalls, 0); assert.equal(rpcCalls, 0);
  assert(simulated >= 6, "exercise production amount-selection construction");
}
console.log("PSM production sim budget policy and independent 0/1 flow encoding PASS (fixture execution)");
