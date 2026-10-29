import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from "../../../production-families/ammalgam.production.js";
import { declareRequestProgram } from "../../../adapter-request-program.js";
import type { AdapterRequest, AdapterRequestResult } from "../../../adapter-request-program.js";
import { inspectRuntime } from "../../../../test/runtime-program-testkit.js";
import { BEACON, IMPLEMENTATION_CODE_HASH, PAIR, PROXY_CODE_HASH, SWAP_EVENT, TOKEN, address } from "../codec.js";
import { decodeSwapLog } from "../simulation.js";
import { exactProgram } from "../exact.js";
import { quoteForRoute } from "../quote.js";
import { swapFeeQ64 } from "../math.js";
import { netBalances, quotable } from "../state.js";
import { swapProgram } from "../runtime.js";
import type { Descriptor, Route, State } from "../types.js";

const runtimeCodes = JSON.parse(
  fs.readFileSync(new URL("./runtime-code.json", import.meta.url), "utf8"),
) as { proxy: string; implementation: string };

const SOURCE = {
  number: 26185105,
  hash: "0xd42de7f328280ea6e102314f77e830f1a2afd643c5f37d393ad0ed3be8bb071c",
  generation: 26185105,
};
const PAIR_ADDRESS = "0x1df5595c634167120d027cd68b847057b97f0f53";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SFI = "0xb753428af26e81097e7fd17f40c88aaa3e04902c";
const BEACON_ADDRESS = "0xf6ef8febba67e70640d5f293c8fe3ea35906990a";
const IMPLEMENTATION = "0x4c48819118171a2f907e8218a9aee7df5971fbca";
const EXECUTOR = "0x1000000000000000000000000000000000000002";

/** Verified pair state at block 26185105 (post-swap end of the sample tx). */
const STATE_N: State = {
  source: SOURCE,
  reserves: [4_960_246_606n, 45_365_946_039_424_921_550n],
  references: [4_979_919_536n, 45_098_158_590_151_407_739n],
  assets: [474_369_349_631_736n, 5_000_005_000n, 0n, 0n, 10_005_000n, 0n],
  balances: [9_950_246_606n, 45_365_946_039_424_921_550n],
  lastUpdateTimestamp: 1_791_912_995n,
};

/**
 * State immediately before the observed swap, reconstructed from the pair's
 * own `Swap` (in/out amounts) and `Sync` (post-swap reserves) events:
 *   reserveX_pre = SyncX + amountXOut, reserveY_pre = SyncY - amountYIn.
 */
const STATE_PRE_SWAP: State = {
  ...STATE_N,
  reserves: [4_996_324_819n, 45_038_045_076_686_576_957n],
  balances: [9_986_324_819n, 45_038_045_076_686_576_957n],
};

const OBSERVED_AMOUNT_IN = 327_900_962_738_344_593n;
const OBSERVED_AMOUNT_OUT = 36_078_213n;

const returned = (id: string, data: string): AdapterRequestResult => ({
  id, data, ok: true, completion: "returned", source: SOURCE,
  provenance: { kind: "fixture", fingerprint: "0x" + "1".repeat(64) },
});

function assetsVector(values: readonly bigint[]): bigint[] {
  return [...values];
}

/** Offline transport fixture bound to the verified state at block N. */
function answer(request: AdapterRequest): AdapterRequestResult {
  const pair = PAIR_ADDRESS;
  if (request.kind === "get-code") {
    if (request.id === "pair-code") return returned(request.id, runtimeCodes.proxy);
    if (request.id === "implementation-code") return returned(request.id, runtimeCodes.implementation);
    return returned(request.id, "0x60006000");
  }
  if (request.kind === "get-storage") {
    if (request.id === "beacon-slot") return returned(request.id, ethers.zeroPadValue(BEACON_ADDRESS, 32));
    if (request.id === "implementation-slot") return returned(request.id, ethers.zeroPadValue(IMPLEMENTATION, 32));
    throw new Error(`fixture unknown storage ${request.id}`);
  }
  if (request.kind !== "eth-call") throw new Error(`fixture unsupported ${request.kind}`);
  const to = request.to.toLowerCase();
  if (to === BEACON_ADDRESS) {
    assert.equal(BEACON.parseTransaction({ data: request.data })!.name, "implementation");
    return returned(request.id, BEACON.encodeFunctionResult("implementation", [IMPLEMENTATION]));
  }
  if (to === USDC || to === SFI) {
    const parsed = TOKEN.parseTransaction({ data: request.data })!;
    if (parsed.name === "decimals") {
      return returned(request.id, TOKEN.encodeFunctionResult("decimals", [to === USDC ? 6n : 18n]));
    }
    if (parsed.name === "balanceOf") {
      return returned(request.id, TOKEN.encodeFunctionResult("balanceOf", [to === USDC ? STATE_N.balances[0] : STATE_N.balances[1]]));
    }
    throw new Error(`fixture unknown token function ${parsed.name}`);
  }
  assert.equal(to, pair);
  const parsed = PAIR.parseTransaction({ data: request.data })!;
  switch (parsed.name) {
    case "underlyingTokens":
      return returned(request.id, PAIR.encodeFunctionResult("underlyingTokens", [USDC, SFI]));
    case "getReserves":
      return returned(request.id, PAIR.encodeFunctionResult("getReserves", [STATE_N.reserves[0], STATE_N.reserves[1], STATE_N.lastUpdateTimestamp]));
    case "referenceReserves":
      return returned(request.id, PAIR.encodeFunctionResult("referenceReserves", [STATE_N.references[0], STATE_N.references[1]]));
    case "totalAssetsAndShares":
      return returned(request.id, PAIR.encodeFunctionResult("totalAssetsAndShares", [assetsVector(STATE_N.assets), assetsVector(STATE_N.assets)]));
    default:
      throw new Error(`fixture unknown pair function ${parsed.name}`);
  }
}

function identityDescriptor(): Descriptor {
  const candidate = { candidateKind: "ammalgam-pair" as const, pair: PAIR_ADDRESS };
  const variant = plugin.identity.variants[0];
  let evidence: unknown;
  for (let step = 0; step < 8; step += 1) {
    const input = { candidate, step, evidence };
    const requests = variant.buildRequests(input as never);
    if (requests.length === 0) break;
    evidence = variant.decode({ step: input as never, results: requests.map(answer) });
    if ((evidence as { phase: string }).phase === "rejected" || (evidence as { phase: string }).phase === "complete") break;
  }
  const decision = variant.decide({ candidate, step: 9, evidence } as never);
  if (decision.status !== "verified") throw new Error(`fixture identity not verified: ${decision.status}`);
  const draft = plugin.instance.compileDraft(decision.identity);
  return plugin.instance.finalizeDescriptor({ identity: decision.identity, draft, sharedBindings: [] } as never);
}

const DESCRIPTOR = identityDescriptor();
const ROUTES = plugin.routes.project({ descriptor: DESCRIPTOR });
const routeOf = (xForY: boolean): Route => {
  const found = ROUTES.find(route => route.xForY === xForY);
  if (!found) throw new Error("missing route");
  return found;
};

/** Program transport fixture: serves the supplied state for one pair. */
function programState(state: State) {
  return (call: { target: string; data: string }) => {
    const to = call.target.toLowerCase();
    if (to === USDC || to === SFI) {
      const parsed = TOKEN.parseTransaction({ data: call.data })!;
      if (parsed.name === "balanceOf") {
        return TOKEN.encodeFunctionResult("balanceOf", [to === USDC ? state.balances[0] : state.balances[1]]);
      }
      if (parsed.name === "transfer") return TOKEN.encodeFunctionResult("transfer", [true]);
      throw new Error(`program fixture token ${parsed.name}`);
    }
    const parsed = PAIR.parseTransaction({ data: call.data });
    if (!parsed) return "0x";
    switch (parsed.name) {
      case "getReserves":
        return PAIR.encodeFunctionResult("getReserves", [state.reserves[0], state.reserves[1], state.lastUpdateTimestamp]);
      case "referenceReserves":
        return PAIR.encodeFunctionResult("referenceReserves", [state.references[0], state.references[1]]);
      case "totalAssetsAndShares":
        return PAIR.encodeFunctionResult("totalAssetsAndShares", [assetsVector(state.assets), assetsVector(state.assets)]);
      case "swap":
        return "0x";
      default:
        throw new Error(`program fixture pair ${parsed.name}`);
    }
  };
}

function runProgram(program: string, amount: bigint, state: State, minimum = 1n) {
  const calls: { name: string; args: readonly unknown[] }[] = [];
  const result = inspectRuntime(program, amount, {
    call(call) {
      const data = programState(state)(call);
      if (call.target.toLowerCase() === PAIR_ADDRESS) {
        const parsed = PAIR.parseTransaction({ data: call.data });
        if (parsed) calls.push({ name: parsed.name, args: [...parsed.args] });
      } else {
        const parsed = TOKEN.parseTransaction({ data: call.data });
        if (parsed) calls.push({ name: parsed.name, args: [...parsed.args] });
      }
      return data;
    },
  });
  void minimum;
  return { result, calls };
}

test("every identity round declares exactly the transports its requests use", () => {
  const variant = plugin.identity.variants[0];
  const candidate = { candidateKind: "ammalgam-pair" as const, pair: PAIR_ADDRESS };
  let evidence: unknown;
  for (let step = 0; step < 8; step += 1) {
    const input = { candidate, step, evidence };
    const requirements = variant.requirements(input as never);
    const requests = variant.buildRequests(input as never);
    const used = new Set(requests.map(request => request.kind));
    for (const transport of requirements.transports ?? []) {
      assert(used.has(transport as never), `declared ${transport} unused at step ${step}`);
    }
    for (const kind of used) {
      assert((requirements.transports ?? []).includes(kind as never), `undeclared ${kind} at step ${step}`);
    }
    if (requests.length === 0) break;
    evidence = variant.decode({ step: input as never, results: requests.map(answer) });
    if ((evidence as { phase: string }).phase === "rejected" || (evidence as { phase: string }).phase === "complete") break;
  }
});

test("verified runtime profile and beacon implementation reconstruct the real pair", () => {
  assert.equal(ethers.keccak256(runtimeCodes.proxy), PROXY_CODE_HASH);
  assert.equal(ethers.keccak256(runtimeCodes.implementation), IMPLEMENTATION_CODE_HASH);
  assert.equal(DESCRIPTOR.pair, address(PAIR_ADDRESS));
  assert.equal(DESCRIPTOR.tokenX, USDC);
  assert.equal(DESCRIPTOR.tokenY, SFI);
  assert.equal(DESCRIPTOR.instanceKey, PAIR_ADDRESS);
  assert.equal(DESCRIPTOR.beacon, BEACON_ADDRESS);
  assert.equal(DESCRIPTOR.implementation, IMPLEMENTATION);
  assert.equal(DESCRIPTOR.decimalsX, 6n);
  assert.equal(DESCRIPTOR.decimalsY, 18n);
});

test("identity rejects non-Ammalgam runtime and a beacon/implementation mismatch", () => {
  const variant = plugin.identity.variants[0];
  const candidate = { candidateKind: "ammalgam-pair" as const, pair: PAIR_ADDRESS };
  const wrongCode = variant.decode({
    step: { candidate, step: 0 } as never,
    results: [returned("pair-code", "0x60006000")],
  }) as { phase: string; reasonCode?: string };
  assert.equal(wrongCode.phase, "rejected");
  assert.equal(wrongCode.reasonCode, "ammalgam-proxy-runtime-unsupported");
  const rejected = variant.decide({ candidate, step: 1, evidence: wrongCode } as never);
  assert.equal(rejected.status, "chain-proven-rejected");

  const proxyPhase = {
    phase: "code", source: SOURCE, ids: ["pair-code"],
  };
  const beacon = variant.decode({
    step: { candidate, step: 1, evidence: proxyPhase } as never,
    results: [
      returned("beacon-slot", ethers.zeroPadValue(BEACON_ADDRESS, 32)),
      returned("implementation-slot", ethers.zeroPadValue(IMPLEMENTATION, 32)),
    ],
  });
  assert.equal((beacon as { phase: string }).phase, "proxy");
  const mismatch = variant.decode({
    step: { candidate, step: 2, evidence: beacon } as never,
    results: [
      returned("beacon-implementation", BEACON.encodeFunctionResult("implementation", ["0x1000000000000000000000000000000000000009"])),
      returned("implementation-code", runtimeCodes.implementation),
      returned("underlying-tokens", PAIR.encodeFunctionResult("underlyingTokens", [USDC, SFI])),
      returned("reserves", PAIR.encodeFunctionResult("getReserves", [STATE_N.reserves[0], STATE_N.reserves[1], STATE_N.lastUpdateTimestamp])),
      returned("references", PAIR.encodeFunctionResult("referenceReserves", [STATE_N.references[0], STATE_N.references[1]])),
    ],
  }) as { phase: string; reasonCode?: string };
  assert.equal(mismatch.phase, "rejected");
  assert.equal(mismatch.reasonCode, "ammalgam-beacon-implementation-mismatch");
});

test("the observed Swap log and swap call nominate the pair; both directions share one instance", () => {
  const log = PAIR.encodeEventLog(SWAP_EVENT, [
    EXECUTOR, 0n, OBSERVED_AMOUNT_IN, OBSERVED_AMOUNT_OUT, 0n, EXECUTOR,
  ]);
  const observation = { kind: "log" as const, source: SOURCE, address: PAIR_ADDRESS, ...log };
  const candidate = plugin.discovery.decodeCandidate({ observation, matchedPatternId: "ammalgam-pair-swap-log" });
  assert.deepEqual(candidate, { candidateKind: "ammalgam-pair", pair: PAIR_ADDRESS });
  assert.equal(plugin.discovery.decodeCandidate({ observation: { ...observation, data: observation.data + "00" }, matchedPatternId: "ammalgam-pair-swap-log" }), null);
  const call = {
    kind: "call" as const, source: SOURCE, target: PAIR_ADDRESS,
    data: PAIR.encodeFunctionData("swap", [0n, OBSERVED_AMOUNT_OUT, EXECUTOR, "0x"]),
  };
  assert.deepEqual(plugin.discovery.decodeCandidate({ observation: call, matchedPatternId: "ammalgam-pair-swap-call" }), candidate);
  const decoded = decodeSwapLog(log);
  assert(decoded);
  assert.equal(decoded.amountYIn, OBSERVED_AMOUNT_IN);
  assert.equal(decoded.amountXOut, OBSERVED_AMOUNT_OUT);
  assert.equal(ROUTES.length, 2);
  for (const route of ROUTES) {
    assert.equal(route.instanceKey, DESCRIPTOR.instanceKey);
    assert.deepEqual(plugin.routes.projectGraph({ descriptor: DESCRIPTOR, route }).venueIdentity, { kind: "address-pool", pool: PAIR_ADDRESS });
    assert.equal(route.tokenIn, route.xForY ? USDC : SFI);
    assert.equal(route.tokenOut, route.xForY ? SFI : USDC);
  }
  assert.notEqual(ROUTES[0].routeKey, ROUTES[1].routeKey);
});

test("pricing snapshot decodes real state; mids are the net reserve ratio", () => {
  const requests = plugin.pricing.current.buildRequests({ descriptor: DESCRIPTOR, routes: ROUTES, source: SOURCE });
  assert.equal(requests.length, 5);
  const snapshot = plugin.pricing.current.decodeSnapshot({
    descriptor: DESCRIPTOR, initialResults: requests.map(answer), dependentEvidence: [],
  });
  assert.deepEqual(netBalances(snapshot), STATE_N.reserves);
  assert.equal(quotable(snapshot), null);
  const mids = plugin.pricing.current.deriveMids({ descriptor: DESCRIPTOR, snapshot, routes: ROUTES });
  assert.equal(mids.size, 2);
  for (const route of ROUTES) {
    const mid = mids.get(route.routeKey)!;
    const expected = Number(route.xForY ? STATE_N.reserves[1] : STATE_N.reserves[0]) /
      Number(route.xForY ? STATE_N.reserves[0] : STATE_N.reserves[1]);
    assert(Math.abs(mid.mid - expected) / expected < 1e-9);
  }
  const mismatched = { ...snapshot, balances: [snapshot.balances[0] + 1n, snapshot.balances[1]] };
  assert.equal(quotable(mismatched), "ammalgam-pair-net-balance-mismatch");
  assert.equal(plugin.pricing.current.deriveMids({ descriptor: DESCRIPTOR, snapshot: mismatched, routes: ROUTES }).size, 0);
  const unavailable = plugin.pricing.current.classifyUnavailable?.({
    descriptor: DESCRIPTOR, snapshot: mismatched, routes: ROUTES,
  });
  assert.equal(unavailable?.get(ROUTES[0].routeKey), "ammalgam-pair-net-balance-mismatch");
});

test("verified invariant reproduces the observed Ammalgam leg exactly", () => {
  const fee = swapFeeQ64(OBSERVED_AMOUNT_IN, STATE_PRE_SWAP.reserves[1], STATE_PRE_SWAP.references[1]);
  assert.equal(fee, 178_907_544_034_220_378_108n);
  assert.equal(Number(fee) / 2 ** 64, 9.698597395797389);
  const out = quoteForRoute(DESCRIPTOR, { xForY: false }, STATE_PRE_SWAP, OBSERVED_AMOUNT_IN);
  assert.equal(out, OBSERVED_AMOUNT_OUT);
  // The pair's K check accepts exactly this output and rejects one unit more.
  const afterIn = STATE_PRE_SWAP.reserves[1] + OBSERVED_AMOUNT_IN;
  const feeQ64 = swapFeeQ64(OBSERVED_AMOUNT_IN, STATE_PRE_SWAP.reserves[1], STATE_PRE_SWAP.references[1]);
  const bipsQ64 = 10_000n * (1n << 64n);
  const netIn = (afterIn * bipsQ64 - OBSERVED_AMOUNT_IN * feeQ64) / bipsQ64;
  const product = STATE_PRE_SWAP.reserves[0] * STATE_PRE_SWAP.reserves[1];
  assert((product <= netIn * (STATE_PRE_SWAP.reserves[0] - OBSERVED_AMOUNT_OUT)));
  assert(product > netIn * (STATE_PRE_SWAP.reserves[0] - OBSERVED_AMOUNT_OUT - 1n));
  // Directional symmetry: quoting the other direction at the same state works.
  const reverse = quoteForRoute(DESCRIPTOR, { xForY: true }, STATE_PRE_SWAP, 1_000_000n);
  assert(reverse > 0n);
});

test("runtime program computes the same output from chain state and executes input-first", () => {
  for (const [state, amount, xForY] of [
    [STATE_PRE_SWAP, OBSERVED_AMOUNT_IN, false],
    [STATE_N, 10n ** 18n, false],
    [STATE_N, 10n ** 6n, true],
  ] as const) {
    const route = routeOf(xForY);
    const expected = quoteForRoute(DESCRIPTOR, route, state, amount);
    const program = swapProgram({
      pair: DESCRIPTOR.pair, tokenX: DESCRIPTOR.tokenX, tokenY: DESCRIPTOR.tokenY,
      xForY, executor: EXECUTOR, recipient: EXECUTOR, minimum: 1n,
    }).bytes();
    const { result, calls } = runProgram(ethers.hexlify(program), amount, state);
    assert.equal(result.registers[0], amount);
    const swapCall = calls[calls.length - 1];
    assert.equal(swapCall.name, "swap");
    const args = swapCall.args as readonly [bigint, bigint, string, string];
    assert.equal(args[0] + args[1], expected);
    assert.equal(args[0], xForY ? 0n : expected);
    assert.equal(args[1], xForY ? expected : 0n);
    assert.equal(args[2], ethers.getAddress(EXECUTOR));
    const transfer = calls.find(call => call.name === "transfer")!;
    assert.deepEqual(transfer.args, [ethers.getAddress(PAIR_ADDRESS), amount]);
  }
});

test("runtime program refuses state the pair's own swap assumption does not hold for", () => {
  const program = ethers.hexlify(swapProgram({
    pair: DESCRIPTOR.pair, tokenX: DESCRIPTOR.tokenX, tokenY: DESCRIPTOR.tokenY,
    xForY: false, executor: EXECUTOR, recipient: EXECUTOR, minimum: 1n,
  }).bytes());
  const skewed = { ...STATE_N, balances: [STATE_N.balances[0] + 1n, STATE_N.balances[1]] as const };
  assert.throws(() => runProgram(program, 10n ** 6n, skewed), /amount mismatch/);
  const minimum = ethers.hexlify(swapProgram({
    pair: DESCRIPTOR.pair, tokenX: DESCRIPTOR.tokenX, tokenY: DESCRIPTOR.tokenY,
    xForY: false, executor: EXECUTOR, recipient: EXECUTOR, minimum: 10n ** 30n,
  }).bytes());
  assert.throws(() => runProgram(minimum, 10n ** 6n, STATE_N), /amount mismatch/);
});

test("exact executes the runtime program at the source state and requires the full effect shape", () => {
  const route = routeOf(false);
  const input = {
    descriptor: DESCRIPTOR, route, amountIn: OBSERVED_AMOUNT_IN, source: SOURCE,
    executor: EXECUTOR, runtimeEvidence: [],
  };
  const initial = exactProgram.buildRequests(input).map(answer);
  const round = exactProgram.buildDependentProgram!({ programInput: input, completedRound: 0, initialResults: initial, priorEvidence: [] })!;
  const simulation = round.requests[0];
  assert.equal(simulation.kind, "effect-delta-simulation");
  const output = quoteForRoute(DESCRIPTOR, route, STATE_PRE_SWAP, OBSERVED_AMOUNT_IN);
  const log = PAIR.encodeEventLog(SWAP_EVENT, [EXECUTOR, 0n, OBSERVED_AMOUNT_IN, output, 0n, EXECUTOR]);
  const good: AdapterRequestResult = {
    ...returned("ammalgam-pair-swap", "0x"),
    effects: {
      tokenDeltas: [
        { token: SFI, account: EXECUTOR, delta: -OBSERVED_AMOUNT_IN },
        { token: SFI, account: PAIR_ADDRESS, delta: OBSERVED_AMOUNT_IN },
        { token: USDC, account: PAIR_ADDRESS, delta: -output },
        { token: USDC, account: EXECUTOR, delta: output },
      ],
      totalSupplyDeltas: [{ token: USDC, delta: 0n }, { token: SFI, delta: 0n }],
      nativeDeltas: [{ account: EXECUTOR, delta: 0n }],
      logs: [{ address: PAIR_ADDRESS, ...log }],
    },
  };
  const decoded = exactProgram.decode({
    programInput: input, initialResults: initial,
    dependentEvidence: [{ results: [good] }],
  });
  assert.equal(decoded.amountOut, output);
  assert.equal(decoded.evidence.kind, "ammalgam-pair-execution");
  for (let index = 0; index < 4; index += 1) {
    const tampered = {
      ...good,
      effects: {
        ...good.effects!,
        tokenDeltas: good.effects!.tokenDeltas!.map((item, position) =>
          position === index ? { ...item, delta: item.delta + 1n } : item),
      },
    };
    assert.throws(() => exactProgram.decode({
      programInput: input, initialResults: initial, dependentEvidence: [{ results: [tampered] }],
    }));
  }
  assert.throws(() => exactProgram.decode({
    programInput: input, initialResults: initial,
    dependentEvidence: [{ results: [{ ...good, effects: { ...good.effects!, logs: [] } }] }],
  }), /swap event missing/);
  const zero = exactProgram.buildRequests({ ...input, amountIn: 0n });
  assert.deepEqual(zero, []);
  assert.equal(exactProgram.decode({
    programInput: { ...input, amountIn: 0n }, initialResults: [], dependentEvidence: [],
  }).amountOut, 0n);
});

test("production request-program validation accepts every exact round", () => {
  const route = routeOf(false);
  const input = {
    descriptor: DESCRIPTOR, route, amountIn: OBSERVED_AMOUNT_IN, source: SOURCE,
    executor: EXECUTOR, runtimeEvidence: [],
  };
  const initial = declareRequestProgram(exactProgram, input as never);
  assert.equal(initial.requests.length, 5);
  const round = exactProgram.buildDependentProgram!({
    programInput: input as never, completedRound: 0, initialResults: initial.requests.map(answer), priorEvidence: [],
  })!;
  assert.equal(round.requests.length, 1);
  declareRequestProgram({
    requirements: () => round.requirements,
    buildRequests: () => round.requests,
    decode: () => null,
  }, input as never);
});

test("execution, action and the audit contract construct every route", () => {
  for (const route of ROUTES) {
    const leg = plugin.execution.buildRuntimeLeg!({
      descriptor: DESCRIPTOR, route, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE,
    });
    assert(leg);
    assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
    assert.deepEqual(leg.settlement, { directOutput: true });
    const direct = plugin.execution.buildRuntimeLeg!({
      descriptor: DESCRIPTOR, route, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE,
      settlement: { kind: "direct-output", recipient: "0x1000000000000000000000000000000000000003" },
    });
    assert(direct);
    const deferred = plugin.execution.buildRuntimeLeg!({
      descriptor: DESCRIPTOR, route, executor: EXECUTOR, runtimeEvidence: [], source: SOURCE,
      settlement: { kind: "deferred-input", paymentProgram: leg.program, paymentAmount: 1n },
    });
    assert.equal(deferred, null);
    const output = 1_000n;
    const amountIn = route.xForY ? 10n ** 6n : 10n ** 18n;
    const evidence = {
      kind: "ammalgam-pair-execution" as const, source: SOURCE,
      binding: route.bindingRef.fingerprint, routeKey: route.routeKey,
      executor: EXECUTOR, amountIn, amountOut: output,
    };
    const fragment = plugin.execution.buildFragment({
      descriptor: DESCRIPTOR, route, amountIn, quotedAmountOut: output,
      minAmountOut: output, exactEvidence: evidence, executor: EXECUTOR, runtimeEvidence: [],
    });
    assert.equal(fragment.nodes.length, 1);
    const node = fragment.nodes[0];
    const encoded = plugin.actionAdapters[0].encode(node, EXECUTOR, new Uint8Array());
    assert.equal(ethers.hexlify(encoded.slice(0, 1)), "0x0e");
    assert.equal(ethers.hexlify(encoded.slice(1, 33)), ethers.toBeHex(amountIn, 32));
    const quotedProgram = ethers.hexlify(encoded.slice(36));
    assert.match(quotedProgram, /^0x01/);
    assert.equal(plugin.actionAdapters[0].matchTrace(PAIR_ADDRESS, "0x022c0d9f"), true);
    assert.equal(plugin.actionAdapters[0].matchTrace(PAIR_ADDRESS, "0x12345678"), false);
    const decoded = runProgram(quotedProgram, amountIn, STATE_N);
    const swapCall = decoded.calls[decoded.calls.length - 1];
    assert.equal(swapCall.name, "swap");
  }
});
