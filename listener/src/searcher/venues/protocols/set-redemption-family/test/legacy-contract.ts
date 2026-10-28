import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import runtimes from "./legacy-runtimes.json";
import { plugin } from "../../../production-families/set-redemption.production.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { createBlockScanSimAmountSelector } from "../../../../simulator/blockscan-sim-amount-selector.js";
import { CORE, CORE_HASH, CORE_LIBRARIES, FACTORY, LEGACY_SET, LEGACY_SET_HASH, REBALANCING_V3_HASH, VAULT, VAULT_HASH, legacyIdentity } from "../legacy.js";
import { TOKEN, MAX, WAD } from "../codec.js";
import { FAMILY, LEGACY_ACTION, LEGACY_ISSUE_ACTION, LEGACY_LINEAGE } from "../manifest.js";
import { dependencies } from "../pricing.js";
import { decodeState, stateRequests, capacity, redemptionOutputs, issuanceOutput, midSample } from "../state.js";
import { program, exactRequests } from "../exact.js";
import { nomination } from "../nomination.js";
import type { Candidate, Descriptor } from "../types.js";
import { actor, source } from "./fixture.js";
const at = source(), core = "0xf55186cc537e7067ea616f2aae007b4427a120c8", vault = "0x5b67871c3a857de81a1ca0f9f7945e5670d986dc";
const base = "0x6011242b6dc2c67ed3d484db09327e933054c90a", rebal = "0xac8ea871e2d5f4be618905f36f73c760f8cfdc8e";
const addr = (n: number) => ethers.toBeHex(n, 20);
function fixture(rebalancing = false, count = 1) {
  return { set: rebalancing ? rebal : base, core, vault, factory: addr(31), rebalancing,
    components: Array.from({ length: count }, (_, n) => addr(n + 100)), units: Array.from({ length: count }, (_, n) => BigInt(n + 1) * 400n),
    naturalUnit: 1000000000000n, supply: 1000000000000000000n, owned: Array<bigint>(count).fill(9999999999999n), available: Array<bigint>(count).fill(MAX),
    validSet: true, validFactory: true, authorized: true, rebalanceState: 0n, factoryCore: core, setCore: core, setVault: vault,
    transferProxy: addr(32), operationState: 0n, proxyAuthorized: true, entryFee: 0n, feeRecipient: addr(33), issuerCredit: 0n };
}
type Fixture = ReturnType<typeof fixture>;
function results(f: Fixture, requests: readonly AdapterRequest[]): AdapterRequestResult[] {
  return requests.map(r => {
    let data: string;
    if (r.kind === "get-code") {
      const a = r.address.toLowerCase();
      data = a === f.set ? runtimes.runtimes[f.rebalancing ? "rebalancing-set" : "base-set"] :
        a === f.core ? runtimes.runtimes.core : a === f.vault ? runtimes.runtimes.vault :
        a === CORE_LIBRARIES[0].address ? runtimes.runtimes["set-library"] :
        a === CORE_LIBRARIES[1].address ? runtimes.runtimes["issuance-library"] : "0x6000";
    } else {
      assert.equal(r.kind, "eth-call"); if (r.kind !== "eth-call") throw Error("unexpected request");
      const a = r.to.toLowerCase(), abi = a === f.set ? LEGACY_SET : a === f.core ? CORE : a === f.vault || a === f.transferProxy ? VAULT : a === f.factory ? FACTORY : TOKEN;
      const p = abi.parseTransaction({ data: r.data }); assert(p); let v: unknown;
      switch (p.name) {
        case "factory": v = f.factory; break;
        case "getComponents": v = f.components; break;
        case "getUnits": v = f.units; break;
        case "naturalUnit": v = f.naturalUnit; break;
        case "totalSupply": v = f.supply; break;
        case "core": v = a === f.factory ? f.factoryCore : f.setCore; break;
        case "vault": v = a === f.core ? f.vault : f.setVault; break;
        case "validSets": assert.equal(p.args[0].toLowerCase(), f.set); v = f.validSet; break;
        case "validFactories": assert.equal(p.args[0].toLowerCase(), f.factory); v = f.validFactory; break;
        case "authorized": assert.equal(p.args[0].toLowerCase(), f.core); v = a === f.transferProxy ? f.proxyAuthorized : f.authorized; break;
        case "transferProxy": v = f.transferProxy; break;
        case "operationState": v = f.operationState; break;
        case "entryFee": v = f.entryFee; break;
        case "feeRecipient": v = f.feeRecipient; break;
        case "rebalanceState": v = f.rebalanceState; break;
        case "getOwnerBalance": assert([f.set, actor].includes(p.args[1].toLowerCase()));
          v = p.args[1].toLowerCase() === actor ? f.issuerCredit : f.owned[f.components.indexOf(p.args[0].toLowerCase())]; break;
        case "balanceOf": assert.equal(p.args[0].toLowerCase(), f.vault); v = f.available[f.components.indexOf(a)]; break;
        case "decimals": v = 18n; break;
        default: throw Error("unexpected getter " + p.name);
      }
      data = abi.encodeFunctionResult(p.name, [v]);
    }
    return { id: r.id, source: at, ok: true, completion: "returned", data, provenance: { kind: "fixture", fingerprint: "synthetic-public-runtime" } };
  });
}
function attest(f = fixture()) {
  const candidate: Candidate = { candidateKind: "set-redemption", set: f.set, module: f.core, legacyCore: true };
  let evidence: unknown;
  for (let n = 0; n < 4; n++) {
    const step = { candidate, evidence, step: n };
    const declared = declareRequestProgram({ requirements: () => legacyIdentity.requirements(step),
      buildRequests: () => legacyIdentity.buildRequests(step), decode: () => null }, step);
    evidence = legacyIdentity.decode({ step, results: results(f, declared.requests) });
    const result = legacyIdentity.decide({ ...step, evidence });
    if (result.status !== "continue") return result;
  }
  throw Error("identity did not terminate");
}
function descriptor(f = fixture()): Descriptor {
  const a = attest(f); assert.equal(a.status, "verified"); if (a.status !== "verified") throw Error("identity");
  const draft = plugin.instance.compileDraft(a.identity);
  return plugin.instance.finalizeDescriptor({ draft });
}
test("legacy behavior hashes are captured, while Core registration and factory reciprocity remain mandatory", () => {
  for (const [name, hash] of [["core", CORE_HASH], ["base-set", LEGACY_SET_HASH], ["rebalancing-set", REBALANCING_V3_HASH], ["vault", VAULT_HASH]] as const)
    assert.equal(ethers.keccak256(runtimes.runtimes[name]), hash);
  for (const rebalancing of [false, true]) {
    const f = fixture(rebalancing); assert.equal(attest(f).status, "verified");
    f.set = addr(51); f.core = f.factoryCore = f.setCore = addr(52); assert.equal(attest(f).status, "verified", "not a Set/Core address allowlist");
    for (const flag of ["validSet", "authorized"] as const) assert.equal(attest({ ...f, [flag]: false }).status, "retryable");
    const retiredFactory = { ...f, validFactory: false }, d = descriptor(retiredFactory);
    assert.equal(attest(retiredFactory).status, "verified", "creation enable is not redemption eligibility");
    assert.equal(redemptionOutputs(decodeState(d, results(retiredFactory, stateRequests(d)), at), f.naturalUnit)[0], 400n);
    assert.equal(attest({ ...f, factoryCore: addr(55) }).status, "chain-proven-rejected");
  }
  assert.equal(attest({ ...fixture(true), rebalanceState: 1n }).status, "retryable");
  assert.equal(attest({ ...fixture(true), rebalanceState: 2n }).status, "retryable");
  assert.equal(attest({ ...fixture(true), setCore: addr(61) }).status, "chain-proven-rejected");
});
test("legacy logs and calls nominate Set+Core, never the whole shared Core as one instance", () => {
  for (const set of [base, rebal]) {
    for (const name of ["SetIssued", "SetRedeemed"]) {
      const event = CORE.encodeEventLog(CORE.getEvent(name)!, [set, 1000n]);
      const o = { kind: "log" as const, address: core, ...event, source: at };
      const c = plugin.discovery.decodeCandidate({ observation: o, matchedPatternId: "legacy-" + name });
      assert.deepEqual(c, { candidateKind: "set-redemption", set, module: core, legacyCore: true });
      assert.equal(plugin.discovery.decodeCandidate({ observation: { ...o, data: o.data + "00" }, matchedPatternId: "legacy-" + name }), null);
    }
    for (const [name, args] of [["issue", [set, 1000n]], ["issueTo", [actor, set, 1000n]], ["redeem", [set, 1000n]],
      ["redeemTo", [actor, set, 1000n]], ["redeemAndWithdrawTo", [set, actor, 1000n, 0n]]] as const) {
      const o = { kind: "call" as const, target: core, data: CORE.encodeFunctionData(name, args), source: at };
      assert.equal(plugin.discovery.decodeCandidate({ observation: o, matchedPatternId: "legacy-" + name })?.set, set);
    }
  }
});
test("receipt nomination keeps two baskets sharing one Core separate before production attestation", async () => {
  const tx = ethers.toBeHex(1001, 32), logs = [base, rebal].flatMap(set => ["SetIssued", "SetRedeemed"].map(name =>
    ({ address: core, ...CORE.encodeEventLog(CORE.getEvent(name)!, [set, 1000n]) })));
  for (const set of [base, rebal]) for (const hint of [true, false]) for (const tag of [{ familyId: FAMILY }, { adapterId: LEGACY_ACTION }, { adapterId: LEGACY_ISSUE_ACTION }]) {
    const observations = await nomination.nominate({ source: at,
      nominations: [{ address: core, opaque: { ...tag, set, module: core, ...(hint ? { legacyCore: true } : {}) }, evidence: { transactionHash: tx } }],
      provider: { async getTransactionReceipt(hash: string) { assert.equal(hash, tx); return { blockNumber: at.number, logs }; },
        async call() { throw Error("legacy nomination must not attempt BasicIssuance getModules"); },
        async getCode(a: string) { return a === core ? runtimes.runtimes.core : runtimes.runtimes[set === base ? "base-set" : "rebalancing-set"]; } } as any });
    assert.equal(observations.length, 2);
    for (const observation of observations) {
      assert.equal(observation.kind, "log"); if (observation.kind !== "log") throw Error("log required");
      const name = observation.topics[0] === CORE.getEvent("SetIssued")!.topicHash ? "SetIssued" : "SetRedeemed";
      assert.equal(plugin.discovery.decodeCandidate({ observation, matchedPatternId: "legacy-" + name })!.set, set);
    }
  }
});
test("legacy quotes use Vault owner credit AND available tokens; quantized inputs are not WAD-floor redemption", () => {
  const f = fixture(), d = descriptor(f), s = decodeState(d, results(f, stateRequests(d)), at);
  assert.equal(s.naturalUnit, f.naturalUnit);
  assert.deepEqual(redemptionOutputs(s, 7n * f.naturalUnit), [2800n]);
  assert.throws(() => redemptionOutputs(s, 7n * f.naturalUnit + 1n), /exact multiple/);
  assert.throws(() => redemptionOutputs({ ...s, naturalUnit: 0n }, 0n));
  assert.equal(capacity({ ...s, balances: [799n] }), f.naturalUnit);
  assert.equal(capacity({ ...s, supply: f.naturalUnit - 1n }), 0n);
  assert.equal(midSample({ ...s, naturalUnit: WAD + 1n }), 0n);
  const large = { ...fixture(), naturalUnit: 2n * WAD, supply: 20n * WAD }, largeDescriptor = descriptor(large);
  const largeState = decodeState(largeDescriptor, results(large, stateRequests(largeDescriptor)), at);
  assert.equal(midSample(largeState), 2n * WAD); assert.deepEqual(redemptionOutputs(largeState, midSample(largeState)), [400n]);
  const largeRoutes = plugin.routes.project({ descriptor: largeDescriptor });
  assert.equal(plugin.pricing.current.deriveMids({ descriptor: largeDescriptor, snapshot: largeState, routes: largeRoutes }).size, 2);
  for (const k of ["owned", "available"] as const) {
    const limited = { ...f, [k]: [399n] };
    const current = decodeState(d, results(limited, stateRequests(d)), at);
    assert.equal(capacity(current), 0n); assert.throws(() => redemptionOutputs(current, f.naturalUnit), /capacity/);
  }
  const route = plugin.routes.project({ descriptor: d })[0];
  assert.equal(route.lineageId, LEGACY_LINEAGE); assert.equal(plugin.routes.projectGraph({ descriptor: d, route }).routeActionAdapterId, LEGACY_ACTION);
  const i = { descriptor: d, route, amountIn: 7n * f.naturalUnit, source: at, executor: actor, runtimeEvidence: [] };
  assert.equal(program.decode({ programInput: i, initialResults: results(f, stateRequests(d)), dependentEvidence: [] }).amountOut, 2800n);
  assert.deepEqual(program.buildRequests(i), program.buildRequests({ ...i, amountIn: 14n * f.naturalUnit }));
  for (const mutate of [(x: Fixture) => { x.validSet = false; }, (x: Fixture) => { x.components = [actor]; },
    (x: Fixture) => { x.units = []; }, (x: Fixture) => { x.naturalUnit = 0n; }, (x: Fixture) => { x.authorized = false; }]) {
    const other = fixture(); mutate(other); assert.throws(() => decodeState(d, results(other, stateRequests(d)), at));
  }
  const mismatched = results(f, stateRequests(d)); mismatched[0] = { ...mismatched[0], source: source(101) };
  assert.throws(() => decodeState(d, mismatched, at));
  for (const a of [f.set, f.core, f.factory, f.vault, ...f.components, ...CORE_LIBRARIES.map(l => l.address)]) assert(dependencies(d).includes(a));
});
function execute(f: Fixture, amount: bigint, options: { short?: number; extraBurn?: bigint; quote?: boolean; units?: bigint[]; inventory?: bigint } = {}) {
  const d = descriptor(f), route = plugin.routes.project({ descriptor: d })[0], input = { descriptor: d, route, executor: actor, source: at, runtimeEvidence: [] };
  let selected = plugin.execution.buildRuntimeLeg!(input)!;
  if (options.quote) {
    const i = { ...input, amountIn: amount }, q = program.decode({ programInput: i, initialResults: results(f, stateRequests(d)), dependentEvidence: [] });
    const fragment = plugin.execution.buildFragment({ ...i, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut, exactEvidence: q.evidence });
    const node = fragment.nodes[0]; const action = plugin.actionAdapters.find(a => a.id === LEGACY_ACTION)!;
    assert.equal(action.encode(node, actor, new Uint8Array())[0], 14);
    selected = { actionAdapterId: LEGACY_ACTION, program: String(node.params.runtimeAmountProgram) };
  }
  const inventory = options.inventory ?? 1000000000000000000000000000000n, balances = f.components.map(() => inventory);
  let shares = inventory, burns = 0;
  const units = options.units ?? f.units, subscript = new ethers.Interface(["function execSubscript(bytes)"]);
  const run = (programBytes: string, n: bigint): ReturnType<typeof inspectRuntime> => inspectRuntime(programBytes, n, { call(c) {
    const a = c.target.toLowerCase();
    if (a === actor) {
      const bytes = ethers.getBytes(subscript.decodeFunctionData("execSubscript", c.data)[0]);
      assert.equal(bytes[0], 14); run(ethers.hexlify(bytes.slice(36)), BigInt(ethers.hexlify(bytes.slice(1, 33)))); return "0x";
    }
    if (a === f.core) {
      assert.deepEqual([...CORE.decodeFunctionData("redeemAndWithdrawTo", c.data)].map(x => typeof x === "string" ? x.toLowerCase() : x), [f.set, actor, amount, 0n]);
      assert.equal(amount % f.naturalUnit, 0n); assert.equal(c.static, false);
      burns++; shares -= amount + (options.extraBurn ?? 0n);
      for (let i = 0; i < balances.length; i++) balances[i] += amount / f.naturalUnit * units[i] - (options.short === i ? 1n : 0n);
      return "0x";
    }
    assert.equal(c.static, true);
    if (c.data.startsWith(TOKEN.getFunction("balanceOf")!.selector)) return TOKEN.encodeFunctionResult("balanceOf", [a === f.set ? shares : balances[f.components.indexOf(a)]]);
    assert.equal(a, f.set); const p = LEGACY_SET.parseTransaction({ data: c.data }); assert(p);
    return LEGACY_SET.encodeFunctionResult(p.name, [p.name === "getComponents" ? f.components : p.name === "getUnits" ? units : f.naturalUnit]);
  } });
  const output = run(selected.program, amount); assert.equal(burns, 1); assert.equal(output.allowances.length, 0);
  return balances.map(v => v - inventory);
}
test("legacy runtime and quoted executions debit exactly the input and guard actual receipts including nested baskets", () => {
  for (const n of [1, 7, 8, 15]) {
    const f = fixture(false, n), amount = f.naturalUnit * 13n;
    for (const quote of [false, true]) {
      assert.deepEqual(execute(f, amount, { quote }), f.units.map(u => 13n * u));
      for (const short of [0, n - 1]) assert.throws(() => execute(f, amount, { quote, short }), /checked uint256/);
      for (const extraBurn of [-1n, 1n]) assert.throws(() => execute(f, amount, { quote, extraBurn }), /mismatch/);
    }
    assert.throws(() => execute(f, amount + 1n), /mismatch/);
    assert.throws(() => execute(f, amount, { quote: true, units: f.units.map(u => u - 1n) }), /checked uint256/);
  }
});
test("legacy runtime construction consumes no amount, quote evidence or chain reads; original Set path remains separate", () => {
  for (const rebalancing of [false, true]) {
    const d = descriptor(fixture(rebalancing)), route = plugin.routes.project({ descriptor: d })[0];
    const i = { descriptor: d, route, executor: actor, source: at, runtimeEvidence: [] };
    for (const k of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"]) Object.defineProperty(i, k, { get() { throw Error("unexpected " + k); } });
    assert.equal(plugin.execution.buildRuntimeLeg!(i)!.actionAdapterId, LEGACY_ACTION);
    assert.throws(() => plugin.execution.buildRuntimeLeg!({ ...i, executor: d.legacy!.vault }));
  }
  assert.equal(plugin.manifest.familyId, FAMILY); assert.equal(plugin.manifest.supportedLineages.length, 2);
});
test("production sim amount selector uses legacy actual-receipt emitters without Exact or quoted fallback", async () => {
  for (const rebalancing of [false, true]) for (const issue of [false, true]) {
    const d = descriptor(fixture(rebalancing)), route = plugin.routes.project({ descriptor: d }).find(r => Boolean(r.issue) === issue)!;
    const leg = plugin.execution.buildRuntimeLeg!({ descriptor: d, route, executor: actor, source: at, runtimeEvidence: [] })!;
    const edges: any[] = [{ adapterId: issue ? LEGACY_ISSUE_ACTION : LEGACY_ACTION, target: core, tokenIn: route.tokenIn, tokenOut: route.tokenOut },
      { adapterId: "fixture-return", target: actor, tokenIn: route.tokenOut, tokenOut: route.tokenIn }];
    let exact = 0, quoted = 0, rpc = 0, simulated = 0; const events: any[] = [];
    const session: any = { source: at, fundingActionIds: () => ["verified-fixture-funding"],
      buildRuntimeAmountLeg({ edge }: any) { return edge === edges[0] ? leg : { actionAdapterId: "fixture-return", program: "0x010001" + "00".repeat(32) }; },
      issueExact() { exact++; throw Error("unexpected Exact"); },
      buildExecution() { quoted++; throw Error("unexpected quoted fallback"); },
      buildFundingRoot(i: any) { return { adapterId: "fixture", target: actor, tokenIn: route.tokenIn, tokenOut: route.tokenIn, amount: i.amount, params: {}, children: i.children }; } };
    const selector = createBlockScanSimAmountSelector({ source: at, executor: actor, record: e => events.push(e),
      async simulate(plan) {
        simulated++; const flow = plan.root.children[0]!;
        assert.equal(flow.adapterId, "runtime-amount-flow"); assert.equal(JSON.parse(String(flow.params.legs))[0].program, leg.program);
        return { success: true, netProfit: 1n, grossProfit: 1n, gasUsed: 1n, profitToken: route.tokenIn, calldata: "0x" };
      } });
    await selector.solve({ opportunity: { kind: "block-scan-arb", searchSeed: { searchCenter: 10n }, flashToken: route.tokenIn, profitToken: route.tokenIn },
      tokenPath: { edges }, maxFlashAmount: 10000n, templateName: "synthetic-legacy-set-construction" } as any,
      { call() { rpc++; throw Error("unexpected RPC"); } } as any, { executor: actor } as any,
      { strictSession: session, deferPhase2Sim: true, gssMaxTries: 2, deadlineAtMs: Date.now() + 10000 });
    assert.deepEqual([exact, quoted, rpc], [0, 0, 0]); assert(simulated >= 4);
    assert(events.some(e => e.type === "sim_amount_construction"));
    assert(events.filter(e => e.type === "sim_amount_construction").every(e => e.mode === "runtime-actual"));
  }
});

test("legacy unary issuance quotes retain exact input, fee rounding, caller credit and operation eligibility", () => {
  for (const rebalancing of [false, true]) {
    const f = fixture(rebalancing), d = descriptor(f), route = plugin.routes.project({ descriptor: d }).find(r => r.issue)!;
    assert(route); assert.equal(route.taxonomy.protocolAction, "wrap");
    assert.equal(plugin.routes.projectGraph({ descriptor: d, route }).routeActionAdapterId, LEGACY_ISSUE_ACTION);
    const quote = (value: Fixture, amountIn: bigint) => {
      const i = { descriptor: d, route, amountIn, source: at, executor: actor, runtimeEvidence: [] };
      return program.decode({ programInput: i, initialResults: results(value, exactRequests(i)), dependentEvidence: [] });
    };
    for (const multiple of [1n, 13n, 1000000001n]) {
      const amount = f.units[0] * multiple, quantity = f.naturalUnit * multiple;
      assert.equal(quote(f, amount).amountOut, quantity);
      assert.throws(() => quote(f, amount + 1n), /component-unit multiple/);
      if (rebalancing) {
        const fee = 123456789123456789n;
        assert.equal(quote({ ...f, entryFee: fee }, amount).amountOut, quantity - quantity * fee / WAD);
        assert.equal(quote({ ...f, entryFee: fee, feeRecipient: actor }, amount).amountOut, quantity);
        assert.throws(() => quote({ ...f, entryFee: WAD }, amount), /issuance unavailable/);
      }
    }
    for (const mutate of [{ operationState: 1n }, { proxyAuthorized: false }, { issuerCredit: 1n }])
      assert.throws(() => quote({ ...f, ...mutate }, f.units[0]), /issuance unavailable|Vault credit/);
    assert.throws(() => quote({ ...f, supply: MAX }, f.units[0]), /overflow/);
    assert.equal(redemptionOutputs(decodeState(d, results({ ...f, operationState: 1n }, stateRequests(d)), at), f.naturalUnit)[0], 400n,
      "shutdown issuance does not disable supported redemption");
    assert(dependencies(d).includes(f.transferProxy));
  }
  const multi = descriptor(fixture(false, 2));
  assert(plugin.routes.project({ descriptor: multi }).every(r => !r.issue), "no unary projection of multi-asset issuance");
});

test("issuance-only fee and capacity rejection preserves the independently valid redemption direction", () => {
  const f = { ...fixture(true), feeRecipient: ethers.ZeroAddress }, d = descriptor(f), routes = plugin.routes.project({ descriptor: d });
  const issue = routes.find(r => r.issue)!, redeem = routes.find(r => !r.issue)!;
  for (const [value, canIssue] of [[f, true], [{ ...f, entryFee: 1n, naturalUnit: 100n }, true],
    [{ ...f, entryFee: WAD / 10n }, false], [{ ...f, supply: MAX }, false]] as const) {
    const s = decodeState(d, results(value, stateRequests(d)), at);
    assert.deepEqual(redemptionOutputs(s, s.naturalUnit!), [400n]);
    const mids = plugin.pricing.current.deriveMids({ descriptor: d, snapshot: s, routes });
    assert(mids.has(redeem.routeKey)); assert.equal(mids.has(issue.routeKey), canIssue);
    const unavailable = plugin.pricing.current.classifyUnavailable!({ descriptor: d, snapshot: s, routes });
    assert(!unavailable.has(redeem.routeKey)); assert.equal(unavailable.has(issue.routeKey), !canIssue);
    if (canIssue) assert(issuanceOutput(s, value.units[0]) > 0n);
    else assert.throws(() => issuanceOutput(s, value.units[0]), /overflow|nonzero recipient/);
  }
});

test("legacy issuance runtime and quoted encoders guard full debit, net receipt, old Vault credit and temporary allowance", () => {
  const approvals = new ethers.Interface(["function approve(address,uint256) returns(bool)", "function allowance(address,address) view returns(uint256)"]);
  for (const rebalancing of [false, true]) for (const quoted of [false, true]) for (const feeRecipient of [addr(1), actor, ethers.toBeHex(BigInt(actor) + 1n, 20)]) {
    const f = { ...fixture(rebalancing), feeRecipient, entryFee: rebalancing ? 123456789123456789n : 0n };
    const d = descriptor(f), route = plugin.routes.project({ descriptor: d }).find(r => r.issue)!;
    const run = (amount: bigint, opts: { short?: bigint; debit?: bigint; oldCredit?: bigint; oldAllowance?: bigint; cleanup?: boolean; omitOwnFee?: boolean } = {}) => {
      const i = { descriptor: d, route, source: at, executor: actor, runtimeEvidence: [] };
      let programBytes: string;
      if (quoted) {
        const qi = { ...i, amountIn: amount }, q = program.decode({ programInput: qi, initialResults: results(f, exactRequests(qi)), dependentEvidence: [] });
        const node = plugin.execution.buildFragment({ ...qi, exactEvidence: q.evidence, quotedAmountOut: q.amountOut, minAmountOut: q.amountOut }).nodes[0];
        assert.equal(plugin.actionAdapters.find(a => a.id === LEGACY_ISSUE_ACTION)!.encode(node, actor, new Uint8Array())[0], 14);
        programBytes = String(node.params.runtimeAmountProgram);
      } else {
        for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"]) Object.defineProperty(i, key, { get() { throw Error("construction accessed " + key); } });
        programBytes = plugin.execution.buildRuntimeLeg!(i)!.program;
      }
      const inventory = 10n ** 35n;
      let inputBalance = inventory, outputBalance = inventory, allowance = opts.oldAllowance ?? 0n, issues = 0;
      const output = inspectRuntime(programBytes, amount, { call(c) {
        const a = c.target.toLowerCase();
        if (c.data.startsWith(TOKEN.getFunction("balanceOf")!.selector)) {
          assert(c.static); assert([f.components[0], f.set].includes(a));
          return TOKEN.encodeFunctionResult("balanceOf", [a === f.set ? outputBalance : inputBalance]);
        }
        if (a === f.components[0]) {
          const tx = approvals.parseTransaction({ data: c.data })!; assert.equal(tx.args[0].toLowerCase(), tx.name === "allowance" ? actor : f.transferProxy);
          if (tx.name === "allowance") { assert(c.static); assert.equal(tx.args[1].toLowerCase(), f.transferProxy); return approvals.encodeFunctionResult("allowance", [allowance]); }
          assert(!c.static); if (!(opts.cleanup === false && tx.args[1] === 0n)) allowance = tx.args[1];
          return approvals.encodeFunctionResult("approve", [true]);
        }
        if (a === f.core && c.data.startsWith(CORE.getFunction("issue")!.selector)) {
          assert(!c.static); const [set, quantity] = CORE.decodeFunctionData("issue", c.data);
          assert.equal(set.toLowerCase(), f.set); assert.equal(quantity, amount / f.units[0] * f.naturalUnit); assert.equal(allowance, amount);
          issues++; inputBalance -= amount + (opts.debit ?? 0n);
          outputBalance += quantity - (f.feeRecipient !== actor || opts.omitOwnFee ? quantity * f.entryFee / WAD : 0n) - (opts.short ?? 0n);
          return "0x";
        }
        assert(c.static);
        if (a === f.vault) return VAULT.encodeFunctionResult("getOwnerBalance", [opts.oldCredit ?? 0n]);
        if (a === f.core) return CORE.encodeFunctionResult("transferProxy", [f.transferProxy]);
        assert.equal(a, f.set); const tx = LEGACY_SET.parseTransaction({ data: c.data })!;
        const value = tx.name === "getComponents" ? f.components : tx.name === "getUnits" ? f.units : tx.name === "naturalUnit" ? f.naturalUnit :
          tx.name === "feeRecipient" ? f.feeRecipient : f.entryFee;
        return LEGACY_SET.encodeFunctionResult(tx.name, [value]);
      } });
      assert.equal(issues, 1); assert.equal(allowance, 0n); assert.equal(output.allowances.length, 0);
      assert.equal(inventory - inputBalance, amount);
      assert.equal(outputBalance - inventory, issuanceOutput(decodeState(d, results(f, stateRequests(d)), at), amount, actor));
    };
    for (const amount of [400n, 5200n, 400000000400n]) run(amount);
    for (const opts of [{ short: 1n }, { debit: 1n }, { debit: -1n }, { oldCredit: 1n }, { oldAllowance: 1n }, { cleanup: false }])
      assert.throws(() => run(5200n, opts), /mismatch|checked uint256/);
    assert.throws(() => run(5201n), /mismatch|component-unit multiple/);
    if (rebalancing && feeRecipient === actor) assert.throws(() => run(5200n, { omitOwnFee: true }), /checked uint256/);
  }
});
