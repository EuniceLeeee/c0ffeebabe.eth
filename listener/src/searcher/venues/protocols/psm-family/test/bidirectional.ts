import assert from "node:assert/strict";
import { ethers } from "ethers";
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
