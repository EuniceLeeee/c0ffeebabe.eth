import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, hexlify, keccak256, zeroPadValue } from "ethers";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, ObservedEffects, RequestRequirements } from "../../../adapter-request-program.js";
import { ABI, MAX_UINT } from "../variants.js";
import { FAMILY } from "../manifest.js";
import { discovery } from "../discovery.js";
import { xwinIdentity } from "../xwin-identity.js";
import { instance } from "../instance.js";
import { routes } from "../routes.js";
import { pricing } from "../pricing.js";
import { exact, exactProgram } from "../exact.js";
import { xwinPrefix } from "../sequential.js";
import type { ExactQuotePrefixStep } from "../../../adapter-family-plugin.js";
import { execution } from "../execution.js";
import { mintAction, redeemAction } from "../action.js";
import { XWIN_ABI, XWIN_IMPLEMENTATION_HASH, XWIN_IMPLEMENTATION_SLOT, decodeXwinReceipt, proveXwinProxy, xwinCalldata, type XwinSurface } from "../xwin.js";
import type { ConversionDescriptor, ConversionIdentity, ConversionPricingDescriptor, ConversionRoute, Direction } from "../types.js";
import { runStrictFamilyLifecycle } from "../../../../strict-family-lifecycle-runner.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from "../../../production-family-composition.js";
import { refreshFixture } from "./refresh-fixture.js";
import { attestPoolIdentitiesStrict } from "../../../../strict-identity-attestation.js";

// Offline fixtures exercise the real request issuer and Family methods. They
// are NOT EVM/historical execution. The production-root test below additionally
// proves strict fixture publication and each-block scheduling, not chain parity.
const cache = process.env.TOKEN_CONVERSION_EVIDENCE;
assert(cache, "TOKEN_CONVERSION_EVIDENCE must name the supplied read-only cache");
const TARGET = getAddress("0x49edcc5aab2e349c1f71c27c98fe9c65b01745b1");
const IMPL = getAddress("0xc77f5620cea9a67002b3511843f47bf9e2adc7ac");
const address = (byte: string) => getAddress(`0x${byte.repeat(20)}`);
const ASSET = address("31"), EXECUTOR = address("32"), ORIGIN = address("33");
const SWAP = address("34"), ORACLE = address("35"), LOCK = address("36"), TOKEN = address("37"), NEXT = address("38");
const ZERO = address("00");
const SOURCE: CanonicalSource = { number: 25000000, hash: `0x${"61".repeat(32)}`, generation: 1 };
function cachedCode(a: string) {
  const html = readFileSync(join(cache!, "contracts", `${a.toLowerCase()}.html`), "utf8");
  return html.slice(html.indexOf("Deployed Bytecode")).match(/<div>(0x[0-9a-fA-F]+)<\/div>/)![1]!;
}
const PROXY_CODE = cachedCode(TARGET), IMPL_CODE = cachedCode(IMPL);
const PROXY = proveXwinProxy(PROXY_CODE);

test("production re-observation selects xWin by runtime, not the first surface fingerprint", async () => {
  // Real production re-observation + lifecycle, cached deployed proxy code.
  // The subsequent state/effect backend is a fixture, NOT historical strict.
  for (const variantHint of [undefined, "btb-bear-v1", "xwin-allocations-v1"] as const) {
    const f = fixture();
    const result = await attestPoolIdentitiesStrict({ catalog, source: SOURCE, runtime: f.runtime,
      pools: [{ address: TARGET, adapter: "token-conversion", variantHint }],
      provider: {
        async getCode(address, block) { assert.equal(block, SOURCE.number); assert.equal(address.toLowerCase(), TARGET.toLowerCase()); return PROXY_CODE; },
        async getStorage(address, slot, block) { assert.equal(block, SOURCE.number); assert.equal(address.toLowerCase(), TARGET.toLowerCase()); assert.equal(slot, XWIN_IMPLEMENTATION_SLOT); return zeroPadValue(IMPL, 32); },
        async call() { throw new Error("nomination cannot quote"); },
      },
    });
    assert.equal(result.accepted.length, 1, JSON.stringify(result.rejected));
    assert.equal(result.accepted[0]!.lineageId, "token-conversion:xwin-allocations-v1");
    assert(f.simulated.length >= 2, "real lifecycle must reach its executor-effect requirements");
  }
});
function returned(id: string, data: string, source = SOURCE): AdapterRequestResult {
  return { id, ok: true, completion: "returned", data, source, provenance: { kind: "offline-fixture", fingerprint: "fixture" } };
}
function receipt(id: string, s: XwinSurface, direction: Direction, input: bigint, output: bigint, actor = EXECUTOR): AdapterRequestResult {
  const shares = direction === "mint" ? output : -input;
  const event = ABI.encodeEventLog(ABI.getEvent("Transfer")!, direction === "mint" ? [ZERO, actor, output] : [actor, ZERO, input]);
  return { ...returned(id, XWIN_ABI.encodeFunctionResult(direction === "mint" ? "deposit" : "withdraw", [output]), s.source),
    effects: { nativeDeltas: [{ account: actor, delta: 0n }], tokenDeltas: [...new Set([s.asset, s.target, ...s.targets].map(a => a.toLowerCase()))].map(token => ({ token, account: actor,
      delta: token === s.target.toLowerCase() ? shares : token === s.asset.toLowerCase() ? direction === "mint" ? -input : output : 0n })),
    totalSupplyDeltas: [{ token: s.target, delta: shares }], logs: [{ address: s.target, ...event }] } } as AdapterRequestResult;
}
function fixture(source = SOURCE, options: {
  oracle?: string; locking?: string; targets?: string[]; implementation?: string; badImplementation?: boolean;
  actor?: string; eoa?: boolean; missingCode?: string; malformedReceipt?: boolean; supply?: bigint;
  output?: (direction: Direction, input: bigint) => bigint;
  nativeDeltas?: ObservedEffects["nativeDeltas"];
  sequence?: boolean;
} = {}) {
  const actor = options.actor ?? EXECUTOR;
  const s: XwinSurface = { source, target: TARGET, ...PROXY, implementation: options.implementation ?? IMPL,
    asset: ASSET, swap: SWAP, oracle: options.oracle ?? ORACLE, locking: options.locking ?? LOCK,
    targets: options.targets ?? [TOKEN], supply: options.supply ?? 10n ** 24n };
  const requests: AdapterRequest[] = [];
  const codeReads: string[] = [];
  const simulated: { input: bigint; output: bigint; actor: string; source: CanonicalSource }[] = [];
  const runtime = createStrictCentralAdapterRuntime({ executor: actor, transactionOrigin: ORIGIN, generationFence: { assertCurrent() {} },
    provider: {
      async getCode(a) {
        codeReads.push(a.toLowerCase());
        if (a.toLowerCase() === options.missingCode?.toLowerCase()) return "0x";
        if (a.toLowerCase() === TARGET.toLowerCase()) return PROXY_CODE;
        if (a.toLowerCase() === s.implementation.toLowerCase()) return options.badImplementation ? "0x6000" : IMPL_CODE;
        if (a.toLowerCase() === actor.toLowerCase() && options.eoa) return "0x";
        return "0x6000";
      },
      async getStorage(a, slot) { assert.equal(a.toLowerCase(), TARGET.toLowerCase()); assert.equal(slot, XWIN_IMPLEMENTATION_SLOT); return zeroPadValue(s.implementation, 32); },
      async call(tx) {
        const parsed = XWIN_ABI.parseTransaction(tx) ?? ABI.parseTransaction(tx);
        assert(parsed);
        if (tx.to.toLowerCase() === TARGET.toLowerCase()) {
          assert.equal(tx.from?.toLowerCase(), actor.toLowerCase());
          if (actor === PROXY.proxyAdmin) throw Object.assign(new Error("ProxyDeniedAdminAccess"), { code: "CALL_EXCEPTION", data: "0x" });
        }
        const addresses: Record<string, string> = { baseToken: s.asset, xWinSwap: s.swap, priceMaster: s.oracle, lockingAddress: s.locking };
        if (addresses[parsed.name]) return XWIN_ABI.encodeFunctionResult(parsed.name, [addresses[parsed.name]]);
        if (parsed.name === "getTargetNamesAddress") return XWIN_ABI.encodeFunctionResult(parsed.name, [s.targets]);
        if (parsed.name === "totalSupply") return ABI.encodeFunctionResult(parsed.name, [s.supply]);
        if (parsed.name === "decimals") return ABI.encodeFunctionResult(parsed.name, [tx.to.toLowerCase() === ASSET.toLowerCase() ? 6 : 18]);
        throw new Error(`unexpected xWin fixture call ${parsed.name}`);
      },
    },
    simulator: { async simulate({ request, source: actual, callerAuthority }) {
      assert.deepEqual(actual, source); assert.equal(callerAuthority.executor?.toLowerCase(), actor.toLowerCase());
      assert.equal(callerAuthority.transactionOrigin?.toLowerCase(), ORIGIN.toLowerCase());
      assert.equal(request.call.caller.kind, "executor"); assert.equal(request.call.executionMode, "impersonated-call-frame");
      assert(request.observe.includes("native-delta"), "all xWin simulation paths must request native observation");
      const parsed = XWIN_ABI.parseTransaction({ data: request.call.data })!;
      assert.equal(BigInt(parsed.args[1]), 0n);
      const direction = parsed.name === "deposit" ? "mint" : "redeem";
      const input = BigInt(parsed.args[0]);
      // Deliberately non-linear fixture outputs. This is not xWin fee math.
      const prior = (request.preCalls ?? []).filter(call => call.to.toLowerCase() === s.target.toLowerCase())
        .map(call => XWIN_ABI.parseTransaction({ data: call.data })!);
      const output = options.sequence && prior.length ? 11n : options.output?.(direction, input) ?? (input === 7n ? 13n : input === 8n ? 19n : input / 3n + BigInt(source.generation));
      simulated.push({ input, output, actor, source: actual });
      const r = receipt(request.id, s, direction, input, output, actor); assert(r.ok);
      if (options.sequence && prior.length) {
        assert.deepEqual(request.overrideIntent?.tokenBalances, [{ token: s.asset, amount: 7n }, { token: s.target, amount: 0n }]);
        assert.equal(prior.length, 1); assert.equal(prior[0]!.name, "deposit"); assert.equal(BigInt(prior[0]!.args[0]), 7n);
        const before = receipt("prefix", s, "mint", 7n, 13n, actor); assert(before.ok);
        return { data: r.data, effects: { ...r.effects,
          tokenDeltas: r.effects!.tokenDeltas!.map((row, index) => ({ ...row, delta: row.delta + before.effects!.tokenDeltas![index]!.delta })),
          totalSupplyDeltas: [{ token: s.target, delta: 13n - input }],
          logs: [...before.effects!.logs!, ...r.effects!.logs!],
        } };
      }
      return { data: r.data, effects: { ...r.effects,
        ...(options.malformedReceipt ? { logs: [] } : {}),
        ...("nativeDeltas" in options ? { nativeDeltas: options.nativeDeltas } : {}) } };
    } },
  });
  async function round(input: readonly AdapterRequest[], requirements: RequestRequirements) {
    requests.push(...input);
    const result = await executeAdapterWork({ runtime, intent: { stage: "exact-refine", familyId: FAMILY,
      source, generation: source.generation, programInput: {}, program: { requirements: () => requirements,
        buildRequests: () => input, decode: ({ results }) => results } } });
    if (result.status !== "resolved") throw new Error(`request round failed: ${result.failure.code}: ${result.failure.message}`);
    return result.executed.evidence;
  }
  return { source, s, actor, runtime, requests, codeReads, simulated, round };
}
async function identify(f = fixture()): Promise<ConversionIdentity> {
  const candidate = { candidateKind: "token-conversion" as const, target: TARGET, variantHint: "xwin-allocations-v1" as const };
  let evidence: Parameters<typeof xwinIdentity.decide>[0]["evidence"];
  for (let step = 0; step <= 4; step++) {
    const input = { candidate, step, evidence };
    const decision = xwinIdentity.decide(input);
    if (decision.status === "verified") return decision.identity;
    if (decision.status !== "continue") throw new Error(`identity ${decision.status}: ${decision.reasonCode}`);
    assert(step < 4, "must fit the existing four-round identity budget");
    evidence = xwinIdentity.decode({ step: input, results: await f.round(xwinIdentity.buildRequests(input), xwinIdentity.requirements(input)) });
  }
  throw new Error("unreachable identity");
}
async function descriptors() {
  const d: ConversionDescriptor = instance.compileDraft(await identify());
  return { descriptor: d, routes: routes.project({ descriptor: d }) };
}
async function quote(f: ReturnType<typeof fixture>, d: ConversionDescriptor, r: ConversionRoute, amountIn: bigint, prefix?: readonly ExactQuotePrefixStep[]) {
  const input = { descriptor: d, route: r, source: f.source, executor: f.actor, amountIn, runtimeEvidence: [], prefix };
  const initialResults = await f.round(exactProgram.buildRequests(input), exactProgram.requirements(input));
  const dependentEvidence: unknown[] = [];
  for (let completedRound = 0; completedRound < 4; completedRound++) {
    const round = exactProgram.buildDependentProgram!({ programInput: input, completedRound, initialResults, priorEvidence: dependentEvidence });
    if (!round) break;
    dependentEvidence.push(round.decode(await f.round(round.requests, round.requirements)));
  }
  return exactProgram.decode({ programInput: input, initialResults, dependentEvidence });
}
async function current(f: ReturnType<typeof fixture>, descriptor: ConversionPricingDescriptor) {
  const input = { descriptor, routes: descriptor.routes, source: f.source };
  const initialResults = await f.round(pricing.current.buildRequests(input), pricing.current.requirements(input));
  const dependentEvidence: unknown[] = [];
  for (let completedRound = 0; completedRound < 5; completedRound++) {
    const round = pricing.current.buildDependentProgram({ current: input, completedRound, initialResults, priorEvidence: dependentEvidence });
    if (!round) break;
    dependentEvidence.push(round.decode(await f.round(round.requests, round.requirements)));
  }
  return pricing.current.decodeSnapshot({ descriptor, initialResults, dependentEvidence });
}

test("xWin cached templates, implementation identity and canonical call nomination", () => {
  assert.equal(keccak256(IMPL_CODE), XWIN_IMPLEMENTATION_HASH);
  assert.equal(PROXY.codeHash, keccak256(PROXY_CODE));
  const relocated = PROXY_CODE.slice(0, 34) + zeroPadValue(NEXT, 32).slice(2) + PROXY_CODE.slice(98);
  assert.equal(proveXwinProxy(relocated).proxyAdmin, NEXT);
  assert.throws(() => proveXwinProxy(PROXY_CODE.slice(0, -2) + "00"), /template/);
  for (const name of ["deposit", "withdraw"]) {
    const data = XWIN_ABI.encodeFunctionData(name, [7n, 100]);
    const observation = { kind: "call" as const, source: SOURCE, target: TARGET, data };
    assert.equal(discovery.decodeCandidate({ observation, matchedPatternId: `token-conversion-${name}` })?.variantHint, "xwin-allocations-v1");
    assert.equal(discovery.decodeCandidate({ observation: { ...observation, data: data + "00" }, matchedPatternId: `token-conversion-${name}` }), null);
  }
});
test("xWin identity requires actual executor effects and code, not only selectors or refresh declaration", async () => {
  const id = await identify(); assert.equal(id.variant, "xwin-allocations-v1");
  assert.equal(pricing.refreshPolicy, "each-block");
  await assert.rejects(identify(fixture(SOURCE, { badImplementation: true })), /implementation code/);
  await assert.rejects(identify(fixture(SOURCE, { malformedReceipt: true })), /log mismatch/);
  await assert.rejects(identify(fixture(SOURCE, { eoa: true })), /runtime code/);
  await assert.rejects(identify(fixture(SOURCE, { actor: PROXY.proxyAdmin })), /baseToken did not return/);
  await assert.rejects(identify(fixture(SOURCE, { supply: 0n })), /retryable/);
});
test("xWin Exact preserves each amount, re-reads changed dependencies, binds actor and encodes the same call", async () => {
  const { descriptor: d, routes: rs } = await descriptors();
  for (const r of rs) {
    const f = fixture();
    const a = await quote(f, d, r, 7n), b = await quote(f, d, r, 8n);
    assert.equal(a.amountOut, 13n); assert.equal(b.amountOut, 19n);
    assert.deepEqual(f.simulated.map(r => r.input), [7n, 8n]);
    assert.equal(f.requests.filter(r => r.kind === "get-storage").length, 2);
    const changed = fixture({ ...SOURCE, number: SOURCE.number + 1, generation: 2, hash: `0x${"62".repeat(32)}` },
      { oracle: NEXT, locking: ZERO, targets: [ASSET, NEXT], implementation: address("39"), output: () => 123n });
    assert.equal((await quote(changed, d, r, 7n)).amountOut, 123n);
    const codeAddresses = changed.requests.filter(r => r.kind === "get-code").map(r => r.address.toLowerCase());
    assert(codeAddresses.includes(NEXT.toLowerCase())); assert(!codeAddresses.includes(ORACLE.toLowerCase())); assert(!codeAddresses.includes(LOCK.toLowerCase()));
    await assert.rejects(quote(fixture(SOURCE, { oracle: NEXT, missingCode: NEXT }), d, r, 7n), /runtime code/);
    assert.equal((await quote(fixture(SOURCE, { oracle: NEXT }), d, r, 7n)).amountOut, 13n, "new dependencies recover without editing Ready");
    const alternateActor = fixture(SOURCE, { actor: NEXT, output: () => 11n });
    assert.equal((await quote(alternateActor, d, r, 7n)).amountOut, 11n);
    assert.equal(alternateActor.simulated[0]!.actor, NEXT);
    await assert.rejects(quote(fixture(SOURCE, { actor: PROXY.proxyAdmin }), d, r, 7n), /admin/);
    const fragment = execution.buildFragment({ descriptor: d, route: r, executor: EXECUTOR, amountIn: 7n, quotedAmountOut: a.amountOut,
      minAmountOut: a.amountOut, exactEvidence: a.evidence, runtimeEvidence: [] });
    const bytes = hexlify((r.direction === "mint" ? mintAction : redeemAction).encode(fragment.nodes[0]!, EXECUTOR, new Uint8Array()));
    assert(bytes.includes(xwinCalldata(r.direction, 7n).slice(2)));
    assert.equal((bytes.match(/095ea7b3/g) ?? []).length, r.direction === "mint" ? 3 : 0);
    await assert.rejects(quote(fixture(), d, r, MAX_UINT + 1n), /uint256/);
  }
});
test("xWin current refresh recomputes both directions, fails on bad effects, and can recover", async () => {
  const { descriptor, routes: rs } = await descriptors();
  const d = { ...descriptor, routes: rs };
  const first = await current(fixture(), d);
  assert.equal(Object.keys(first.quotes).length, 2);
  const next = { ...SOURCE, number: SOURCE.number + 1, generation: 2, hash: `0x${"62".repeat(32)}` };
  const second = await current(fixture(next, { oracle: NEXT, output: () => 4321n }), d);
  assert.notDeepEqual(second.quotes, first.quotes);
  assert.equal(second.source.hash, next.hash);
  await assert.rejects(current(fixture(next, { malformedReceipt: true }), d), /log mismatch/);
  assert.equal(Object.keys((await current(fixture(next), d)).quotes).length, 2);
  // Direct calls alone do not prove scheduling; the production-root test does.
});
test("xWin repeated-instance Exact replays the complete prefix and checks aggregate effects", async () => {
  const { descriptor: d, routes: rs } = await descriptors();
  const mint = rs.find(r => r.direction === "mint")!, redeem = rs.find(r => r.direction === "redeem")!;
  const prefix = [{ descriptor: d, route: mint, amountIn: 7n, amountOut: 13n }];
  const input = { descriptor: d, route: redeem, amountIn: 13n, executor: EXECUTOR, source: SOURCE, runtimeEvidence: [], prefix };
  assert(exact.methods(input).some(m => m.kind === "request-program" && m.sequentialPrefix));
  assert.equal((await quote(fixture(SOURCE, { sequence: true }), d, redeem, 13n, prefix)).amountOut, 11n);
  assert.notEqual((await quote(fixture(), d, redeem, 13n)).amountOut, 11n, "independent leg state is not reused");
  // An old independent receipt must never be accepted for the sequence.
  await assert.rejects(quote(fixture(), d, redeem, 13n, prefix), /balance|supply|log/);
  for (const bad of [
    { ...input, amountIn: 12n },
    { ...input, prefix: [{ ...prefix[0]!, amountIn: 0n }] },
    { ...input, prefix: [{ ...prefix[0]!, amountIn: MAX_UINT + 1n }] },
    { ...input, prefix: [{ ...prefix[0]!, descriptor: { ...d, instanceKey: "foreign" as typeof d.instanceKey } }] },
    { ...input, prefix: [{ ...prefix[0]!, descriptor: { ...d, asset: NEXT } }] },
    { ...input, prefix: [{ ...prefix[0]!, route: { ...mint, tokenOut: NEXT } }] },
    { ...input, prefix: [{ ...prefix[0]!, route: redeem }] },
    { ...input, prefix: [prefix[0]!, { ...prefix[0]!, descriptor: { ...d, familyId: "foreign" as typeof d.familyId } }] },
  ]) {
    assert.throws(() => xwinPrefix(bad));
    assert(!exact.methods(bad).some(m => m.kind === "request-program"), "unsupported prefix fails closed");
  }
  const f = fixture(SOURCE, { sequence: true });
  await quote(f, d, redeem, 13n, prefix);
  const simulation = f.requests.find(r => r.kind === "effect-delta-simulation")!;
  assert.equal(simulation.kind, "effect-delta-simulation");
  if (simulation.kind !== "effect-delta-simulation") throw new Error("missing simulation");
  assert.deepEqual(simulation.preCalls!.map(c => c.to.toLowerCase() === d.target.toLowerCase() ? XWIN_ABI.parseTransaction({ data: c.data })!.name : ABI.parseTransaction({ data: c.data })!.name), ["approve", "approve", "deposit", "approve"]);
  const doubled = { ...input, prefix: [...prefix, { descriptor: d, route: redeem, amountIn: 13n, amountOut: 11n }, { descriptor: d, route: mint, amountIn: 11n, amountOut: 13n }] };
  assert.equal(xwinPrefix(doubled).length, 3, "full prefix is retained without a hardcoded hop count");
});
test("xWin production root/coordinator refreshes quoted rows on empty blocks and fails closed on mutable dependencies", async () => {
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: FAMILY, source: SOURCE,
    runtime: fixture().runtime, observations: [{ kind: "call", source: SOURCE, target: TARGET,
      data: XWIN_ABI.encodeFunctionData("deposit", [7n, 0]) }] });
  assert.equal(publication.instances.length, 1);
  let options: Parameters<typeof fixture>[1] = {};
  const rounds: { lane: string; f: ReturnType<typeof fixture> }[] = [];
  const harness = refreshFixture({ publication, start: SOURCE, executor: EXECUTOR, asset: ASSET,
    runtime(at, lane) {
      // Synthetic changing outputs deliberately avoid pretending to implement
      // xWin fees. Real amount parity still requires the serialized chain slot.
      const f = fixture(at, { ...options, output: (_direction, amount) => amount * BigInt(at.generation + 1) });
      rounds.push({ lane, f }); return f.runtime;
    } });
  assert.deepEqual(harness.root.pricingIndex().perBlockRefreshStateKeys, [TARGET.toLowerCase()]);
  const source = (generation: number) => ({ number: SOURCE.number + generation - 1,
    hash: zeroPadValue(hexlify(new Uint8Array([generation])), 32), generation });
  let before = await harness.step(SOURCE);
  assert.equal(before.mids.size, 2);
  assert.equal(before.effectiveMids!.rows.size, 2);
  assert([...before.effectiveMids!.rows.values()].every(row => row.status === "quoted"));
  const startupMids = before.mids;
  for (const generation of [2, 3]) {
    // No pool/oracle logs or calls. Even changing the dependency *address*
    // reaches both branches because each request resolves the current surface.
    options = generation === 3 ? { oracle: NEXT, locking: ZERO, targets: [ASSET, NEXT] } : {};
    rounds.length = 0;
    const at = source(generation), after = await harness.step(at);
    assert.equal(after.mids.size, 2); assert.equal(after.effectiveMids!.rows.size, 2);
    assert.strictEqual(after.mids, startupMids);
    assert.deepEqual(after.rawMidSource, SOURCE);
    for (const [key, row] of after.effectiveMids!.rows) {
      assert.equal(row.status, "quoted"); assert.deepEqual(row.quotedAt, at);
      assert.notEqual(row.amountOut, before.effectiveMids!.rows.get(key)!.amountOut);
      assert.equal(after.pricingProvenanceByEdgeKey!.get(key), "refreshed");
      assert.equal(row.amountIn, before.effectiveMids!.rows.get(key)!.amountIn,
        "the refreshed amount quote must keep startup raw sizing");
    }
    for (const lane of ["raw", "exact"]) {
      const entries = rounds.filter(r => r.lane === lane);
      assert.equal(entries.flatMap(r => r.f.simulated).length, lane === "raw" ? 0 : 2);
      if (lane === "raw") assert(entries.every(r => r.f.requests.length === 0 && r.f.codeReads.length === 0));
      if (generation === 3 && lane === "exact") {
        const reads = entries.flatMap(r => r.f.codeReads);
        assert(reads.includes(NEXT.toLowerCase())); assert(!reads.includes(ORACLE.toLowerCase()));
        assert(!reads.includes(LOCK.toLowerCase()));
      }
    }
    before = after;
  }
  for (const [generation, bad] of [
    [4, { oracle: NEXT, missingCode: NEXT }],
    [5, { oracle: NEXT, missingCode: NEXT }],
    [6, { malformedReceipt: true }],
    [7, { actor: PROXY.proxyAdmin }],
    [8, { badImplementation: true }],
    [9, { nativeDeltas: [{ account: EXECUTOR, delta: 1n }] }],
    [10, { nativeDeltas: [{ account: EXECUTOR, delta: -1n }] }],
  ] as const) {
    options = bad;
    const failed = await harness.step(source(generation));
    assert.strictEqual(failed.mids, startupMids);
    assert.equal(failed.effectiveMids!.rows.size, 2);
    assert([...failed.effectiveMids!.rows.values()].every(row => row.status === "quote-failed"));
    assert.equal(failed.coverage.resolvedEdgeKeys.length, 0);
    assert.equal(failed.coverage.unresolvedEdgeKeys.length, 2);
  }
  options = { oracle: NEXT, locking: ZERO, targets: [ASSET, NEXT] };
  const recovery = await harness.step(source(11));
  assert.strictEqual(recovery.mids, startupMids);
  assert([...recovery.effectiveMids!.rows.values()].every(row => row.status === "quoted"));
  assert([...recovery.effectiveMids!.rows.values()].every(row => row.quotedAt?.number === source(11).number));
  const recovered = await harness.step(source(12));
  assert.strictEqual(recovered.mids, startupMids);
  assert.equal(recovered.effectiveMids!.rows.size, 2);
  assert([...recovered.effectiveMids!.rows.values()].every(row => row.status === "quoted"));
  console.log(JSON.stringify({ kind: "offline-production-root-coordinator-fixture",
    emptyActivity: true, startupRawFrozen: true, effectiveRequoted: true, dependencyRelocationRecovery: true,
    historicalQuoteExecutionParity: "not run", actualCallerExecutionProof: "not run" }));
});
test("xWin native conservation requires exactly one zero delta for the token-balance actor", async () => {
  const { descriptor: d, routes: rs } = await descriptors();
  const badNative: ObservedEffects["nativeDeltas"][] = [
    undefined, [],
    [{ account: EXECUTOR, delta: 0n }, { account: EXECUTOR, delta: 0n }],
    [{ account: EXECUTOR, delta: 1n }], [{ account: EXECUTOR, delta: -1n }],
    [{ account: NEXT, delta: 0n }],
    [{ account: EXECUTOR, delta: 0n }, { account: NEXT, delta: 0n }],
  ];
  for (const r of rs) {
    const s = fixture().s, good = receipt("native", s, r.direction, 7n, 13n); assert(good.ok);
    // A legitimate zero observation for the bound actor remains accepted.
    const zero = { ...good, effects: { ...good.effects, nativeDeltas: [{ account: EXECUTOR.toLowerCase(), delta: 0n }] } };
    assert.equal(decodeXwinReceipt([zero], "native", s, r.direction, 7n, EXECUTOR).amountOut, 13n);
    for (const nativeDeltas of badNative) {
      const bad = { ...good, effects: { ...good.effects, nativeDeltas } };
      assert.throws(() => decodeXwinReceipt([bad], "native", s, r.direction, 7n, EXECUTOR), /native/);
      await assert.rejects(quote(fixture(SOURCE, { nativeDeltas }), d, r, 7n));
    }
  }
  for (const nativeDeltas of badNative) {
    await assert.rejects(identify(fixture(SOURCE, { nativeDeltas })));
    await assert.rejects(current(fixture(SOURCE, { nativeDeltas }), { ...d, routes: rs }));
  }
});
test("xWin balance/source/supply and actor negative controls reject false receipts", () => {
  const s = fixture().s;
  for (const direction of ["mint", "redeem"] as const) {
    const good = receipt("r", s, direction, 7n, 13n); assert(good.ok);
    assert.equal(decodeXwinReceipt([good], "r", s, direction, 7n, EXECUTOR).amountOut, 13n);
    const effects = good.effects!;
    for (const bad of [
      { ...good, effects: { ...effects, tokenDeltas: effects.tokenDeltas!.map((r, i) => i === 0 ? { ...r, delta: r.delta - 1n } : r) } },
      { ...good, effects: { ...effects, totalSupplyDeltas: [] } },
      { ...good, effects: { ...effects, tokenDeltas: effects.tokenDeltas!.filter((_, i) => i !== 2) } },
      { ...good, source: { ...SOURCE, generation: 2 } },
    ]) assert.throws(() => decodeXwinReceipt([bad], "r", s, direction, 7n, EXECUTOR));
    assert.throws(() => decodeXwinReceipt([good], "r", s, direction, 7n, NEXT), /binding/);
    assert.throws(() => decodeXwinReceipt([good], "r", s, direction, 8n, EXECUTOR), /balance/);
  }
});
test("xWin cached real N/trace is evidence, not fixture quote/execution parity", () => {
  const tx = "0xacb3f261665bb1516ff03be65b890b3edf9413edc5ea32a78ff4b5a667b3ea8b";
  const raw = JSON.parse(readFileSync(join(cache!, "raw", `${tx}.json`), "utf8"));
  assert.equal(raw.receipt.transactionHash, tx); assert.equal(raw.receipt.status, "0x1");
  assert.equal(Number(BigInt(raw.receipt.blockNumber)), 26029585); assert.equal(BigInt(raw.tx.chainId), 1n);
  const legs: { direction: string; amountIn: string; amountOut: string; slippage: string; actor: string }[] = [];
  interface TraceCall { to?: string; from: string; input: string; output?: string; calls?: TraceCall[] }
  function visit(call: TraceCall) {
    if (call.to?.toLowerCase() === TARGET.toLowerCase()) {
      const p = XWIN_ABI.parseTransaction({ data: call.input });
      if (p && ["deposit", "withdraw"].includes(p.name)) legs.push({ direction: p.name, amountIn: p.args[0].toString(),
        amountOut: BigInt(XWIN_ABI.decodeFunctionResult(p.name, call.output!)[0]).toString(), slippage: p.args[1].toString(), actor: call.from });
    }
    for (const child of call.calls ?? []) visit(child);
  }
  visit(raw.trace); assert.equal(legs.length, 2);
  assert.equal(legs[0]!.amountIn, "1"); assert.equal(legs[1]!.slippage, "100");
  console.log(JSON.stringify({ kind: "cached-trace-only", tx, N: 26029585, blockHash: raw.receipt.blockHash, legs,
    originalLegPrestateParity: "unknown", encodedDefaultSlippage: 0, chainAcceptance: "not run" }));
});
