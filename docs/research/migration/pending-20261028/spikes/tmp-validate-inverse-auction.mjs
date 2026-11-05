import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JsonRpcProvider, Interface, keccak256, toBeHex } from "ethers";
import { createDeclarativeProtocolRuntime } from "./src/searcher/venues/declarative-protocol.ts";
import { inspectRuntime } from "./src/searcher/test/runtime-program-testkit.ts";

const AUCTION = "0x933cBE81313d9dD523dF6dC9B899A7AF8Ba073e3";
const DOLA = "0x865377367054516e17014CcdED1e7d814EDC9ce4";
const DBR = "0xAD038Eb671c44b853887A7E32528FaB35dC5D710";
const EXECUTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const PRE_BLOCK = 26346566;
const TRADE_BLOCK = 26346567;
const HIST_AMOUNT_IN = 53999369337904472842n;
const HIST_AMOUNT_OUT = 1155708947764273217536n;

const provider = new JsonRpcProvider(process.env.MAINNET_RPC_URL, 1, { staticNetwork: true });
const auctionAbi = new Interface([
  "function dola() view returns (address)", "function dbr() view returns (address)",
  "function dolaReserve() view returns (uint256)", "function dbrReserve() view returns (uint256)",
  "function getCurrentReserves() view returns (uint256,uint256)",
  "function dbrRatePerYear() view returns (uint256)", "function maxDbrRatePerYear() view returns (uint256)",
  "function buyDBR(uint256,uint256,address)",
]);
const preBlock = await provider.getBlock(PRE_BLOCK);
const preSource = Object.freeze({ number: PRE_BLOCK, generation: 0, hash: preBlock.hash });
const tradeBlock = await provider.getBlock(TRADE_BLOCK);
assert.equal(preBlock.timestamp, 1793856839); assert.equal(tradeBlock.timestamp, 1793856851);

const code = await provider.getCode(AUCTION, PRE_BLOCK);
const codeHash = keccak256(code);
const preTag = "0x" + PRE_BLOCK.toString(16);
const callAtPre = data => provider.send("eth_call", [{ to: AUCTION, data }, preTag]);
const preDolaReserve = (await auctionAbi.decodeFunctionResult("dolaReserve", await callAtPre(auctionAbi.encodeFunctionData("dolaReserve"))))[0];
const preDbrReserve = (await auctionAbi.decodeFunctionResult("dbrReserve", await callAtPre(auctionAbi.encodeFunctionData("dbrReserve"))))[0];
const [curDola, curDbr] = await auctionAbi.decodeFunctionResult("getCurrentReserves", await callAtPre(auctionAbi.encodeFunctionData("getCurrentReserves")));
const rate = (await auctionAbi.decodeFunctionResult("dbrRatePerYear", await callAtPre(auctionAbi.encodeFunctionData("dbrRatePerYear"))))[0];
const maxRate = (await auctionAbi.decodeFunctionResult("maxDbrRatePerYear", await callAtPre(auctionAbi.encodeFunctionData("maxDbrRatePerYear"))))[0];
console.log("pre-state", { codeHash, preDolaReserve: String(preDolaReserve), preDbrReserve: String(preDbrReserve), curDola: String(curDola), curDbr: String(curDbr), rate: String(rate), maxRate: String(maxRate) });
assert.equal(codeHash, "0x1f1d270f2f650900307694d91332ba0b5dab7eadc9dae4c1babd7d769c1dd089");

// ── source-order rebase at the trade block timestamp (Solidity semantics) ──
const YEAR = 365n * 86400n;
const K = preDolaReserve * preDbrReserve;
const elapsed = BigInt(tradeBlock.timestamp - preBlock.timestamp) + 624n; // lastUpdate 1793856215 -> preBlock already 624s
const dbrIn = elapsed * rate / YEAR;
const tradeDbrReserve = preDbrReserve + dbrIn;
const tradeDolaReserve = K / tradeDbrReserve;
const tradeMax = HIST_AMOUNT_IN * tradeDbrReserve / (tradeDolaReserve + HIST_AMOUNT_IN);
const tradePost = (tradeDolaReserve + HIST_AMOUNT_IN) * (tradeDbrReserve - HIST_AMOUNT_OUT) - tradeDolaReserve * tradeDbrReserve;
const preQuoteMax = HIST_AMOUNT_IN * curDbr / (curDola + HIST_AMOUNT_IN);
console.log("source-order", { elapsed: String(elapsed), dbrIn: String(dbrIn), tradeDolaReserve: String(tradeDolaReserve), tradeDbrReserve: String(tradeDbrReserve), preQuoteMax: String(preQuoteMax), tradeMax: String(tradeMax), historicalDeltaVsTradeMax: String(HIST_AMOUNT_OUT - tradeMax), invariantSlack: String(tradePost) });
assert.ok(tradePost >= 0n);

// ── compile ──
const raw = JSON.parse(readFileSync("./src/searcher/venues/protocols/inverse-auction-family/inverse-auction.json", "utf8"));
const runtime = createDeclarativeProtocolRuntime(raw);
const family = runtime.definition;
assert.equal(family.manifest.familyId, "protocol:inverse-auction");
assert.equal(family.manifest.domain, "protocol");
assert.equal(family.discovery.callPatterns[0].selector, "0xb23adea6");
assert.equal(family.discovery.logPatterns[0].topic, "0x89f5adc174562e07c9c9b1cae7109bbecb21cf9d1b2847e550042b8653c54a0e");
console.log("discovery", family.discovery.sources, family.discovery.callPatterns.map(p => p.signature), family.discovery.logPatterns.map(p => p.signature));

const CALLS = new Map([
  ["dola()", auctionAbi.encodeFunctionData("dola")],
  ["dbr()", auctionAbi.encodeFunctionData("dbr")],
  ["dolaReserve()", auctionAbi.encodeFunctionData("dolaReserve")],
  ["dbrReserve()", auctionAbi.encodeFunctionData("dbrReserve")],
  ["getCurrentReserves()", auctionAbi.encodeFunctionData("getCurrentReserves")],
  ["dbrRatePerYear()", auctionAbi.encodeFunctionData("dbrRatePerYear")],
  ["maxDbrRatePerYear()", auctionAbi.encodeFunctionData("maxDbrRatePerYear")],
]);
const SELECTORS = new Map([...CALLS].map(([name, data]) => [data.slice(0, 10), name]));
function answer(request, { blockTag = PRE_BLOCK } = {}) {
  assert.equal((request.to ?? request.address)?.toLowerCase(), AUCTION.toLowerCase(), `unexpected target ${request.to ?? request.address}`);
  if (request.kind === "get-code") {
    return { id: request.id, ok: true, source: preSource, completion: "returned",
      provenance: { kind: "synthetic-binding-of-saved-public-inputs", fingerprint: "validation-not-admission" }, data: code };
  }
  const name = SELECTORS.get(request.data.slice(0, 10));
  assert.ok(name, `unexpected calldata ${request.data}`);
  const result = request.kind === "get-code" ? code
    : name === "dola()" ? DOLA : name === "dbr()" ? DBR
    : null;
  return { id: request.id, ok: true, source: preSource, completion: "returned",
    provenance: { kind: "synthetic-binding-of-saved-public-inputs", fingerprint: "validation-not-admission" },
    data: request.kind === "get-code" ? code : result ?? "0x" };
}
const recorded = new Map();
async function rpcAnswer(request) {
  if (request.kind === "get-code") { recorded.set(request.id, code); return { ...answer(request), data: code }; }
  const name = SELECTORS.get(request.data.slice(0, 10));
  const data = await provider.send("eth_call", [{ to: request.to, data: request.data }, preTag]);
  recorded.set(request.id, data);
  return { ...answer(request), data };
}

// ── identity ──
const candidate = { candidateKind: "inverse-auction", target: AUCTION };
const variant = family.identity.variants[0];
let evidence, decision, rounds = 0;
for (;;) {
  const step = { candidate, evidence, step: rounds };
  decision = variant.decide(step);
  if (decision.status !== "continue") break;
  const requests = variant.buildRequests(step);
  const results = [];
  for (const request of requests) results.push(await rpcAnswer(request));
  evidence = variant.decode({ step, results });
  rounds++;
  assert.ok(rounds < 5);
}
assert.equal(decision.status, "verified");
console.log("identity verified after", rounds, "round", JSON.stringify(decision.identity, (k, v) => typeof v === "bigint" ? String(v) : v));
assert.equal(decision.identity.dola, DOLA);
assert.equal(decision.identity.dbr, DBR);
assert.equal(decision.identity.dolaReserve, preDolaReserve);

// negative: code hash mismatch must fail closed
{
  const step = { candidate: { ...candidate, target: "0x0000000000000000000000000000000000000001" }, step: 0 };
  assert.throws(() => variant.decode({ step, results: variant.buildRequests(step).map(request => ({ ...answer(request), data: "0x6000" })) }));
}

const descriptor = family.instance.finalizeDescriptor({ identity: decision.identity, draft: family.instance.compileDraft(decision.identity), sharedBindings: [] });
const routes = family.routes.project({ descriptor });
assert.equal(routes.length, 1);
const route = routes[0];
assert.equal(route.tokenIn, DOLA); assert.equal(route.tokenOut, DBR);
assert.equal(route.target, AUCTION); assert.equal(route.adapterId, "inverse-auction-buy");
assert.equal(route.taxonomy.slotKind, "protocol"); assert.equal(route.taxonomy.protocolAction, "convert");
const graph = family.routes.projectGraph({ descriptor, route });
console.log("descriptor", JSON.stringify(descriptor, (k, v) => typeof v === "bigint" ? String(v) : v));
console.log("route", JSON.stringify({ routeKey: route.routeKey, tokenIn: route.tokenIn, tokenOut: route.tokenOut, target: route.target, adapterId: route.adapterId, taxonomy: route.taxonomy }));
console.log("graph", JSON.stringify(graph));

// ── pricing ──
const draft = family.pricing.compileDraft({ descriptor, routes, stateKey: family.pricing.stateKey(route) });
const staticRequests = family.pricing.staticEvidence.buildRequests(draft);
const staticEvidence = family.pricing.staticEvidence.decode({ draft, results: [] });
const pricingDescriptor = family.pricing.finalizePricingDescriptor({ draft, staticEvidence, sharedBindings: [] });
const current = { descriptor: pricingDescriptor, routes, source: preSource };
const pricingRequests = family.pricing.current.buildRequests(current);
const pricingResults = [];
for (const request of pricingRequests) pricingResults.push(await rpcAnswer(request));
const snapshot = family.pricing.current.decodeSnapshot({ ...current, initialResults: pricingResults, dependentEvidence: [] });
const mids = family.pricing.current.deriveMids({ ...current, snapshot });
console.log("pricing", JSON.stringify({ staticRequests: staticRequests.length, requestIds: pricingRequests.map(r => r.id),
  amountIn: String(snapshot.quotes[route.routeKey].amountIn), amountOut: String(snapshot.quotes[route.routeKey].amountOut),
  mid: mids.get(route.routeKey).mid, dependencies: family.pricing.dependencies(current), refresh: family.pricing.refreshPolicyForInstance({ descriptor }) }, null, 1));
assert.equal(snapshot.quotes[route.routeKey].amountIn, 10n ** 18n);
assert.equal(snapshot.quotes[route.routeKey].amountOut, 10n ** 18n * curDbr / (curDola + 10n ** 18n));

// ── exact quote at the historical amount ──
const exactInput = { descriptor, route, amountIn: HIST_AMOUNT_IN, source: preSource, executor: EXECUTOR, runtimeEvidence: [] };
const method = family.exact.methods(exactInput).find(m => m.kind === "request-program");
assert.ok(method);
const exactRequests = method.program.buildRequests(exactInput);
const exactResults = [];
for (const request of exactRequests) exactResults.push(await rpcAnswer(request));
const quoted = method.program.decode({ programInput: exactInput, initialResults: exactResults, dependentEvidence: [] });
console.log("exact@pre", JSON.stringify({ method: method.id, requests: exactRequests.map(r => r.id), amountOut: String(quoted.amountOut), evidenceKind: quoted.evidence.kind,
  evidenceAmountIn: String(quoted.evidence.amountIn), evidenceAmountOut: String(quoted.evidence.amountOut), hasReadProof: !!quoted.evidence.readProof }));
assert.equal(quoted.amountOut, preQuoteMax);
assert.equal(quoted.evidence.amountOut, preQuoteMax);
const zero = method.program.decode({ programInput: { ...exactInput, amountIn: 0n }, initialResults: [], dependentEvidence: [] });
assert.equal(zero.amountOut, 0n);
console.log("exact@pre delta vs historical", String(quoted.amountOut - HIST_AMOUNT_OUT));
assert.throws(() => method.program.decode({ programInput: { ...exactInput, source: { ...preSource, hash: "0x" + "00".repeat(32) } }, initialResults: exactResults, dependentEvidence: [] }));

// ── execution fragment: on-chain runtime program ──
const fragment = family.execution.buildFragment({ descriptor, route, amountIn: HIST_AMOUNT_IN, quotedAmountOut: quoted.amountOut,
  minAmountOut: quoted.amountOut, exactEvidence: quoted.evidence, executor: EXECUTOR, runtimeEvidence: [] });
assert.equal(fragment.nodes.length, 1);
const fragmentProgram = fragment.nodes[0].params.runtimeAmountProgram;
assert.equal(fragment.nodes[0].amount, HIST_AMOUNT_IN);

const tradeCurDola = tradeDolaReserve, tradeCurDbr = tradeDbrReserve;
const BALANCE_OF = "0x70a08231", APPROVE = "0x095ea7b3", BUY = "0xb23adea6";
function runProgram(program, dolaReserve, dbrReserve, label) {
  const calls = [];
  const baseDola = 10n ** 30n;
  const seen = new Map();
  let lastBuy;
  inspectRuntime(program, HIST_AMOUNT_IN, {
    nativeBalance: () => 0n,
    call: call => {
      calls.push(call);
      const selector = call.data.slice(0, 10);
      if (selector === BALANCE_OF) {
        const token = call.target.toLowerCase();
        const n = (seen.get(token) ?? 0) + 1; seen.set(token, n);
        if (n === 1) return toBeHex(token === DOLA.toLowerCase() ? baseDola : 0n, 32);
        if (token === DOLA.toLowerCase()) return toBeHex(baseDola - lastBuy[0], 32);
        return toBeHex(lastBuy[1], 32);
      }
      if (selector === BUY) { lastBuy = auctionAbi.decodeFunctionData("buyDBR", call.data); return "0x"; }
      if (selector === "0x" + auctionAbi.getFunction("getCurrentReserves").selector.slice(2))
        return "0x" + toBeHex(dolaReserve, 32).slice(2) + toBeHex(dbrReserve, 32).slice(2);
      if (selector === APPROVE) return toBeHex(1, 32);
      throw new Error(`${label}: unexpected runtime call ${selector} -> ${call.target}`);
    },
  });
  const buy = calls.find(call => call.data.slice(0, 10) === BUY);
  assert.ok(buy, `${label}: buyDBR call missing`);
  const decoded = auctionAbi.decodeFunctionData("buyDBR", buy.data);
  assert.equal(decoded[0], HIST_AMOUNT_IN);
  console.log(label, JSON.stringify({ callSelectors: calls.map(c => c.data.slice(0, 10)), callTargets: calls.map(c => c.target.toLowerCase()),
    static: calls.map(c => c.static), buyTarget: buy.target, amountIn: String(decoded[0]), amountOut: String(decoded[1]), to: decoded[2] }));
  return { calls, decoded };
}
const atPre = runProgram(fragmentProgram, curDola, curDbr, "fragment@pre");
assert.equal(atPre.decoded[0], HIST_AMOUNT_IN);
assert.equal(atPre.decoded[1], preQuoteMax, "same-state fragment output must equal the exact quote");
assert.equal(atPre.decoded[2], EXECUTOR);
const atTrade = runProgram(fragmentProgram, tradeCurDola, tradeCurDbr, "fragment@trade-rebased");
assert.equal(atTrade.decoded[1], tradeMax, "execution-block rebase must reproduce the source-order curve");
assert.ok(atTrade.decoded[1] > HIST_AMOUNT_OUT && atTrade.decoded[1] - HIST_AMOUNT_OUT === 9n);

// ── runtime leg (actual-receipt interface) ──
const leg = family.execution.buildRuntimeLeg({ descriptor, route, executor: EXECUTOR, source: preSource, runtimeEvidence: [],
  settlement: { kind: "direct-output", recipient: EXECUTOR } });
assert.ok(leg && leg.program);
console.log("runtimeLeg", JSON.stringify({ adapterId: leg.adapterId, settlement: leg.settlement, inputMode: leg.inputMode, hasProgram: !!leg.program }));
const runtimeAtPre = runProgram(leg.program, curDola, curDbr, "runtimeLeg@pre");
assert.equal(runtimeAtPre.decoded[1], preQuoteMax);
const runtimeAtTrade = runProgram(leg.program, tradeCurDola, tradeCurDbr, "runtimeLeg@trade-rebased");
assert.equal(runtimeAtTrade.decoded[1], tradeMax);

// ── pricing mutation index ──
const dependencies = family.pricing.dependencies(current);
const index = family.pricing.mutation.compile({ entries: [{ ...current, stateKey: family.pricing.stateKey(route), dependencies }] });
for (const [kind, target, expected] of [["call", AUCTION, [family.pricing.stateKey(route)]], ["call", DOLA, []], ["call", "0x0000000000000000000000000000000000000002", []]]) {
  const observation = { kind, source: preSource, target, data: "0x" };
  assert.deepEqual(index.affectedStateKeys({ observation }).map(x => x.stateKey), expected, `${kind} ${target}`);
}
console.log("mutation index ok; dependencies", dependencies);

console.log("VALIDATION OK", JSON.stringify({ preQuoteMax: String(preQuoteMax), tradeMax: String(tradeMax), historical: String(HIST_AMOUNT_OUT), historicalVsTradeMax: String(HIST_AMOUNT_OUT - tradeMax), historicalVsPreQuote: String(HIST_AMOUNT_OUT - preQuoteMax) }));
