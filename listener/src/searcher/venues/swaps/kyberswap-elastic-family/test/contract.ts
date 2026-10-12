import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { plugin } from
  "../../../production-families/kyberswap-elastic.production.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import {
  KYSWAP_CALLBACK_INTERFACE,
  KYSWAP_FEE_UNITS,
  KYSWAP_FACTORY_INTERFACE,
  KYSWAP_POOL_INTERFACE,
  KYSWAP_SWAP_DATA_OFFSET,
  KYSWAP_SWAP_QTY_OFFSET,
  KYSWAP_SWAP_SELECTOR,
  KYSWAP_SWAP_TOPIC,
} from "../abi.js";
import { decodeSwapLog, tokenInFor, tokenOutFor } from "../codec.js";
import {
  KYSWAP_FAMILY_ID,
  KYSWAP_SWAP_ACTION,
} from "../manifest.js";
import {
  quoteExactInputStep,
  quoteExactInput,
  KYSWAP_MAX_QUOTE_STEPS,
  spotQuoteExactInput,
  virtualReserves,
} from "../math.js";
import type { KyberSwapDirection, KyberSwapRoute, KyberSwapPoolState, KyberSwapTickState } from "../types.js";
import { crossingRequests, decodeCrossings } from "../state.js";
import { getSqrtRatioAtTick, MIN_TICK, MAX_TICK } from "../../../../solver/v3-math.js";
import {
  answerFor,
  BASE_L,
  CANDIDATE,
  CURRENT_TICK,
  descriptor,
  decisionWith,
  EXECUTOR,
  identityWith,
  FACTORY,
  FOREIGN,
  NEXT_TICK,
  NEAREST_CURRENT_TICK,
  POOL,
  POOL_FEE_UNITS,
  PREVIOUS_TICK,
  SOURCE,
  SQRT_P,
  swapLogEvent,
  USDT,
  WETH,
  crossingFixture,
  CROSSING_BOUNDARIES,
  result,
} from "./fixtures.js";

const routesFor = (d: ReturnType<typeof descriptor>) =>
  plugin.routes.project({ descriptor: d }) as readonly KyberSwapRoute[];

const inputFor = (
  d: ReturnType<typeof descriptor>,
  route: KyberSwapRoute,
  amountIn: bigint,
) => ({
  descriptor: d,
  route,
  amountIn,
  source: SOURCE,
  executor: EXECUTOR,
  transactionOrigin: EXECUTOR,
  runtimeEvidence: [],
});

function quote(
  amountIn: bigint,
  options: Parameters<typeof answerFor>[0] = {},
  direction: KyberSwapDirection = "token0-in",
) {
  const d = descriptor(answerFor(options));
  const route = routesFor(d).find((r) => r.direction === direction)!;
  const input = inputFor(d, route, amountIn);
  const method = (plugin.exact.methods(input as never) as readonly {
    readonly id: string;
    readonly kind: string;
    readonly program?: {
      buildRequests(input: unknown): readonly AdapterRequest[];
      buildDependentProgram?(input: unknown): {
        requests: readonly AdapterRequest[];
        decode(results: readonly unknown[]): unknown;
      } | null;
      decode(input: unknown): { amountOut: bigint; evidence: Record<string, unknown> };
    };
  }[])[1]!;
  assert.equal(method.kind, "request-program");
  const program = method.program!;
  const requested = program.buildRequests(input as never);
  const initialResults = requested.map(answerFor(options));
  const dependentEvidence: unknown[] = [];
  const rounds: (readonly AdapterRequest[])[] = [];
  const seenIds = new Set(requested.map(request => request.id));
  if (program.buildDependentProgram !== undefined) {
    for (let completedRound = 0; ; completedRound++) {
      const round = program.buildDependentProgram({
        programInput: input as never, initialResults,
        completedRound, priorEvidence: dependentEvidence,
      } as never);
      if (round === null || round === undefined) break;
      assert(completedRound < 4, "fixture must respect the unchanged central dependent-round budget");
      for (const request of round.requests) {
        assert(!seenIds.has(request.id), `repeated dependent request ${request.id}`);
        seenIds.add(request.id);
      }
      rounds.push(round.requests);
      dependentEvidence.push(round.decode(round.requests.map(answerFor(options))));
    }
  }
  const quoted = program.decode({
    programInput: input as never,
    initialResults,
    dependentEvidence,
  } as never);
  return { descriptor: d, route, input, requested, dependentRequests: rounds, quoted };
}

test("manifest declares the factory-child Elastic swap family", () => {
  assert.equal(String(plugin.manifest.familyId), String(KYSWAP_FAMILY_ID));
  assert.equal(plugin.manifest.domain, "swap");
  assert.deepEqual(
    [...plugin.manifest.ownedActionAdapterIds],
    [KYSWAP_SWAP_ACTION],
  );
  assert.deepEqual(
    [...plugin.manifest.allowedTaxonomy],
    [{ slotKind: "swap" }],
  );
  assert.deepEqual(
    plugin.actionAdapters.map((entry) => entry.id),
    [KYSWAP_SWAP_ACTION],
  );
});

test("declared ABI surfaces match the measured on-chain identities", () => {
  // Topics and the callback selector were read off chain for these pools.
  assert.equal(
    KYSWAP_SWAP_TOPIC,
    "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  );
  assert.equal(
    KYSWAP_POOL_INTERFACE.getEvent("Mint")!.topicHash.toLowerCase(),
    "0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde",
  );
  assert.equal(
    KYSWAP_POOL_INTERFACE.getEvent("Burn")!.topicHash.toLowerCase(),
    "0x0c396cd989a39f4459b5fa1aed6a9a8dcdbc45908acfd67e028cd568da98982c",
  );
  assert.equal(
    KYSWAP_POOL_INTERFACE.getEvent("BurnRTokens")!.topicHash.toLowerCase(),
    "0x324487c99a1f7f0e3127499a548452d3a198e78ccd07add913cb93d59f0f039b",
  );
  assert.equal(
    KYSWAP_CALLBACK_INTERFACE.getFunction("swapCallback")!.selector,
    "0xfa483e72",
  );
  // The pool exposes swapFeeUnits()/tickDistance()/getPoolState(); there is no
  // fee()/tickSpacing()/slot0() on these contracts.
  assert.ok(KYSWAP_POOL_INTERFACE.getFunction("swapFeeUnits"));
  assert.ok(KYSWAP_POOL_INTERFACE.getFunction("tickDistance"));
  assert.ok(KYSWAP_POOL_INTERFACE.getFunction("getPoolState"));
  assert.ok(KYSWAP_POOL_INTERFACE.getFunction("getLiquidityState"));
  assert.equal(KYSWAP_POOL_INTERFACE.getFunction("fee"), null);
  assert.equal(KYSWAP_POOL_INTERFACE.getFunction("slot0"), null);
  assert.equal(
    KYSWAP_SWAP_SELECTOR,
    ethers.id("swap(address,int256,bool,uint160,bytes)").slice(0, 10),
  );
});

test("identity verifies through the pool's factory reverse binding", () => {
  const identity = identityWith();
  assert.equal(identity.subject, ethers.getAddress(POOL));
  assert.equal(identity.facts.factoryBinding.factory, ethers.getAddress(FACTORY));
  assert.equal(identity.facts.factoryBinding.reversePool, ethers.getAddress(POOL));
  assert.equal(identity.facts.token0, ethers.getAddress(WETH));
  assert.equal(identity.facts.token1, ethers.getAddress(USDT));
  assert.equal(identity.facts.feeUnits, POOL_FEE_UNITS);
  assert.ok(identity.provenance.length > 0);
  assert.equal(
    (identity.provenance[0] as { kind: string }).kind,
    "factory-reverse-binding",
  );
});

test("identity rejects a pool the factory does not reverse-resolve", () => {
  const decision = decisionWith(answerFor({ reversePool: FOREIGN }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_factory_reverse_binding_failed",
  );
});

test("identity rejects a pinned getPool revert as a failed reverse binding", () => {
  const decision = decisionWith(answerFor({ reverseReverts: true }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_factory_reverse_binding_failed",
  );
});

test("identity rejects a pool whose fee units cannot support the swap math", () => {
  for (const feeUnits of [0n, KYSWAP_FEE_UNITS, KYSWAP_FEE_UNITS + 1n]) {
    const decision = decisionWith(answerFor({ feeUnits }));
    assert.equal(decision.status, "chain-proven-rejected", `fee=${feeUnits}`);
    assert.equal(
      (decision as { reasonCode: string }).reasonCode,
      "kyberswap_elastic_pool_surfaces_failed",
    );
  }
});

test("identity rejects a pool whose tick distance is not positive", () => {
  const decision = decisionWith(answerFor({ tickDistance: 0 }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_pool_surfaces_failed",
  );
});

test("identity rejects a state whose sqrt price or tick relation is not swapable", () => {
  // nearestCurrentTick > currentTick can never be a swapable Elastic state.
  const inverted = decisionWith(answerFor({
    nearestCurrentTick: CURRENT_TICK + 1,
  }));
  assert.equal(inverted.status, "chain-proven-rejected");
  assert.equal(
    (inverted as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_pool_surfaces_failed",
  );
  // A locked pool cannot execute a swap at this state.
  const locked = decisionWith(answerFor({ locked: true }));
  assert.equal(locked.status, "chain-proven-rejected");
});

test("identity rejects a candidate whose factory hint contradicts chain truth", () => {
  const variant = plugin.identity.variants[0]!;
  const decision = variant.decide({
    candidate: { ...CANDIDATE, hintedFactory: FOREIGN },
    evidence: {
      phase: "reverse-binding",
      pool: POOL,
      poolCodeHash: `0x${"11".repeat(32)}`,
      factory: FACTORY,
      token0: WETH,
      token1: USDT,
      feeUnits: POOL_FEE_UNITS,
      tickDistance: 10,
      sqrtP: SQRT_P,
      currentTick: CURRENT_TICK,
      nearestCurrentTick: NEAREST_CURRENT_TICK,
      locked: false,
      baseL: BASE_L,
      reinvestL: 0n,
      staticValid: true,
      evidenceRequestIds: [],
      reversePool: POOL,
      bindingValid: true,
    },
    step: 1,
  } as never);
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_factory_hint_mismatch",
  );
});

test("identity is not satisfied by a hardcoded pool list", () => {
  // The same candidate flips purely on chain evidence: the factory either
  // reverse-resolves it or it does not.
  const accepted = decisionWith(answerFor());
  assert.equal(accepted.status, "verified");
  const rejected = decisionWith(answerFor({ reversePool: FOREIGN }));
  assert.equal(rejected.status, "chain-proven-rejected");
});

test("routes project exactly two exact-input directions with measured flags", () => {
  const d = descriptor();
  const routes = routesFor(d);
  assert.deepEqual(
    routes.map((route) => route.direction),
    ["token0-in", "token1-in"],
  );
  for (const route of routes) {
    assert.equal(route.isToken0, route.direction === "token0-in");
    assert.equal(route.tokenIn, tokenInFor(d, route.direction));
    assert.equal(route.tokenOut, tokenOutFor(d, route.direction));
    assert.equal(route.taxonomy.slotKind, "swap");
    assert.equal(route.taxonomy.protocolAction, undefined);
    assert.equal(route.feeUnits, POOL_FEE_UNITS);
    assert.equal(route.bindingRef.bindingKey, POOL.toLowerCase());
  }
  const graph = plugin.routes.projectGraph({
    descriptor: d,
    route: routes[1]!,
  } as never);
  assert.equal((graph as { routeActionAdapterId: string }).routeActionAdapterId, KYSWAP_SWAP_ACTION);
  assert.equal(graph.executionTarget, d.pool);
});

test("an exact-output variant has no route, no direction and no runtime leg", () => {
  const routes = routesFor(descriptor());
  // `isToken0` only names an input token for `swapQty > 0`; nothing in this
  // family projects a negative swapQty direction.
  assert.equal(routes.length, 2);
  assert.ok(routes.every((route) => route.isToken0 === (route.direction === "token0-in")));
  assert.ok(!routes.some((route) =>
    String(route.direction).includes("exact-output")));
  // The observation decoder refuses a negative (exact-output) swap call instead
  // of inventing a direction for it.
  const exactOutputCall = KYSWAP_POOL_INTERFACE.encodeFunctionData("swap", [
    EXECUTOR,
    -1838763n,
    false,
    0n,
    "0x",
  ]);
  assert.deepEqual(
    plugin.swap.observation.decode({
      observation: {
        kind: "call",
        target: POOL,
        data: exactOutputCall,
      },
    } as never),
    [],
  );
});

test("exact quote honours the caller's specified amount in both directions", () => {
  const cases = [
    { direction: "token0-in" as const, amounts: [10n ** 12n, 10n ** 13n, 10n ** 14n] },
    { direction: "token1-in" as const, amounts: [10n ** 6n, 5n * 10n ** 6n, 10n ** 7n] },
  ];
  for (const probe of cases) {
    for (const amountIn of probe.amounts) {
      const { quoted, route } = quote(amountIn, {}, probe.direction);
      assert.equal(quoted.evidence.amountIn, amountIn);
      assert.equal(quoted.evidence.amountOut, quoted.amountOut);
      assert.equal(quoted.evidence.refusal, null,
        `${probe.direction} amountIn=${amountIn}`);
      assert.equal(quoted.evidence.isToken0, route.isToken0);
      assert.ok(quoted.amountOut > 0n,
        `${probe.direction} amountIn=${amountIn}`);
    }
  }
});

test("exact quote is a function of the amount, not a point-price sample", () => {
  const small = quote(10n ** 12n).quoted.amountOut;
  const large = quote(10n ** 14n).quoted.amountOut;
  assert.ok(small > 0n && large > small, `${small} -> ${large}`);
  assert.notEqual(small, large);
  // Compare valid amount scales for this WETH/USDT fixture in both directions.
  assert.notEqual(
    small,
    quote(10n ** 6n, {}, "token1-in").quoted.amountOut,
  );
});

test("exact quote for token1-in reads the initialized-tick neighbour round", () => {
  const up = quote(10n ** 6n, {}, "token1-in");
  assert.ok(up.quoted.amountOut > 0n);
  assert.equal(up.quoted.evidence.direction, "token1-in");
  assert.equal(up.quoted.evidence.isToken0, false);
  // The up-tick step target comes from `initializedTicks(nearest).next`, capped
  // by MAX_TICK_DISTANCE (480 ticks) exactly as the pool caps it.
  assert.equal(
    up.quoted.evidence.targetTick,
    Math.min(NEXT_TICK, CURRENT_TICK + 480),
  );
  const down = quote(10n ** 12n, {}, "token0-in");
  // The down-tick step target is `nearestCurrentTick` itself.
  assert.equal(down.quoted.evidence.targetTick, NEAREST_CURRENT_TICK);
  // Same pool, opposite directions: the outputs differ.
  assert.notEqual(up.quoted.amountOut, down.quoted.amountOut);
});

test("exact quote reaches and crosses an initialized boundary only with its tick evidence", () => {
  for (const direction of ["token0-in", "token1-in"] as const) {
    const { options } = crossingFixture(), expected = CROSSING_BOUNDARIES.first;
    const { quoted, dependentRequests } = quote(expected.amountIn, options, direction);
    assert.equal(quoted.amountOut, expected.amountOut);
    assert.equal(quoted.evidence.kind, "kyberswap-elastic-exact-input");
    assert.equal(quoted.evidence.deltaL, expected.deltaL);
    assert.equal(quoted.evidence.refusal, null);
    assert.deepEqual(quoted.evidence.crossedTicks, [direction === "token0-in" ? -10 : 10]);
    assert.equal(dependentRequests.length, direction === "token0-in" ? 1 : 2);
  }
});

test("exact quote fails closed on a pool with no active liquidity", () => {
  const { quoted } = quote(1_000n, { baseL: 0n, reinvestL: 0n });
  assert.equal(quoted.amountOut, 0n);
  assert.equal(quoted.evidence.refusal, "no-active-liquidity");
});

test("a locked pool is refused by identity and by the step quote", () => {
  const decision = decisionWith(answerFor({ locked: true }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    "kyberswap_elastic_pool_surfaces_failed",
  );
  const outcome = quoteExactInputStep({
    state: {
      source: SOURCE,
      sqrtP: SQRT_P,
      currentTick: CURRENT_TICK,
      nearestCurrentTick: NEAREST_CURRENT_TICK,
      locked: true,
      baseL: BASE_L,
      reinvestL: 0n,
      feeUnits: POOL_FEE_UNITS,
      previousTick: PREVIOUS_TICK,
      nextTick: NEXT_TICK,
    },
    isToken0: true,
    amountIn: 10n ** 12n,
  });
  assert.equal(outcome.ok, false);
  assert.equal(
    (outcome as { refusal: string }).refusal,
    "no-active-liquidity",
  );
});

test("the pool fee reduces the quoted output at the same state", () => {
  const cheap = quote(10n ** 6n, { feeUnits: 100n }, "token1-in").quoted.amountOut;
  const dear = quote(10n ** 6n, { feeUnits: 10_000n }, "token1-in").quoted.amountOut;
  assert.ok(cheap > dear, `${cheap} should exceed ${dear}`);
});

test("the mid sample is the pool price with the fee, not its reciprocal", () => {
  // The raw marginal price is (sqrtP / 2^96)^2, so a token0-in mid sample and
  // the exact step quote for the same amount must agree to within the step's
  // own price impact. An inverted mid would differ by a factor of price^2.
  const state = {
    source: SOURCE,
    sqrtP: SQRT_P,
    currentTick: CURRENT_TICK,
    nearestCurrentTick: NEAREST_CURRENT_TICK,
    locked: false,
    baseL: BASE_L,
    reinvestL: 0n,
    feeUnits: POOL_FEE_UNITS,
    previousTick: PREVIOUS_TICK,
    nextTick: NEXT_TICK,
  };
  const reserves = virtualReserves(state);
  // token1 reserve / token0 reserve is the raw price of token0 in token1.
  const impliedPrice = (reserves.token1 * 10n ** 18n) / reserves.token0;
  for (const isToken0 of [true, false]) {
    const amountIn = isToken0 ? 10n ** 12n : 10n ** 6n;
    const mid = spotQuoteExactInput(state, isToken0, amountIn);
    const step = quoteExactInputStep({ state, isToken0, amountIn });
    assert.equal(step.ok, true);
    const quoted = (step as { quote: { amountOut: bigint } }).quote.amountOut;
    // Within 1% of the amount-accurate single-range quote.
    assert.ok(
      mid * 100n <= quoted * 101n && quoted * 100n <= mid * 101n,
      `isToken0=${isToken0}: mid ${mid} vs step ${quoted}`,
    );
  }
  // A round trip through the mid must return the input minus both fees; an
  // inverted mid would be off by price^4.
  const forward = spotQuoteExactInput(state, true, 10n ** 12n);
  const backward = spotQuoteExactInput(state, false, forward);
  const net = KYSWAP_FEE_UNITS - POOL_FEE_UNITS;
  const expected = (10n ** 12n) * net * net /
    (KYSWAP_FEE_UNITS * KYSWAP_FEE_UNITS);
  assert.ok(
    backward * 100n <= expected * 101n && expected * 100n <= backward * 101n,
    `mid round trip ${backward} vs expected ${expected}`,
  );
  assert.ok(impliedPrice > 0n);
});

test("pricing projects one mid per routed direction from the same state read", () => {
  const d = descriptor();
  const draft = plugin.pricing.compileDraft({
    descriptor: d,
    stateKey: d.instanceKey,
    routes: routesFor(d),
  } as never);
  const pricingDescriptor = plugin.pricing.finalizePricingDescriptor({
    draft,
    sharedBindings: [],
  } as never);
  const requests = plugin.pricing.current.buildRequests({
    descriptor: pricingDescriptor,
    routes: routesFor(d),
  } as never);
  const snapshot = plugin.pricing.current.decodeSnapshot({
    descriptor: pricingDescriptor,
    routes: routesFor(d),
    initialResults: requests.map(answerFor()),
    dependentEvidence: [],
  } as never);
  const mids = plugin.pricing.current.deriveMids({
    descriptor: pricingDescriptor,
    routes: routesFor(d),
    snapshot,
  } as never) as ReadonlyMap<string, unknown>;
  assert.equal(mids.size, 2);
  for (const route of routesFor(d)) {
    assert.ok(mids.has(route.routeKey), route.direction);
  }
  assert.deepEqual(
    [...plugin.pricing.dependencies({ descriptor: pricingDescriptor } as never)],
    [d.pool],
  );
});

test("exact quote exposes a local-zero method without reading chain state", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const methods = plugin.exact.methods(inputFor(d, route, 0n) as never);
  assert.equal(methods[0]!.id, "local-zero");
  assert.equal(methods.length, 2);
});

test("step math refuses a non-movable price target instead of guessing", () => {
  const state = {
    source: SOURCE,
    sqrtP: getSqrtRatioAtTick(CURRENT_TICK),
    currentTick: CURRENT_TICK,
    nearestCurrentTick: CURRENT_TICK,
    locked: false,
    baseL: BASE_L,
    reinvestL: 0n,
    feeUnits: POOL_FEE_UNITS,
    previousTick: CURRENT_TICK,
    nextTick: CURRENT_TICK,
  };
  const outcome = quoteExactInputStep({
    state,
    isToken0: true,
    amountIn: 10n ** 12n,
  });
  assert.equal(outcome.ok, false);
  assert.equal(
    (outcome as { refusal: string }).refusal,
    "price-limit-not-movable",
  );
});

test("buildRuntimeLeg patches the working amount into swapQty and needs no approval", () => {
  const d = descriptor();
  for (const route of routesFor(d)) {
    const leg = plugin.execution.buildRuntimeLeg(
      inputFor(d, route, 10n ** 12n) as never,
    );
    assert.ok(leg, "a supported route must construct a runtime leg");
    assert.equal(leg.actionAdapterId, KYSWAP_SWAP_ACTION);
    assert.match(leg.program, /^0x01(?:[a-fA-F0-9]{2})+$/);
    assert.ok(
      leg.program.includes(KYSWAP_SWAP_SELECTOR.slice(2)),
      "the runtime leg must call swap(address,int256,bool,uint160,bytes)",
    );
    // The exact-input guard plus the patched amount/script registers.
    assert.equal(KYSWAP_SWAP_QTY_OFFSET, 36);
    assert.equal(KYSWAP_SWAP_DATA_OFFSET, 196);
  }
});

test("buildRuntimeLeg constructs without reading any quoted amount field", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, 10n ** 12n) as Record<string, unknown>;
  for (
    const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"]
  ) {
    Object.defineProperty(input, key, {
      get() {
        throw new Error(`runtime construction accessed ${key}`);
      },
    });
  }
  const leg = plugin.execution.buildRuntimeLeg(input as never);
  assert.ok(leg);
});

test("buildRuntimeLeg rejects a foreign token and a self-recipient pool", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  assert.throws(() => plugin.execution.buildRuntimeLeg(
    inputFor(d, { ...route, tokenOut: FOREIGN } as never, 10n ** 12n) as never,
  ));
  assert.throws(() => plugin.execution.buildRuntimeLeg({
    ...inputFor(d, route, 10n ** 12n),
    executor: d.pool,
  } as never));
});

test("buildFragment needs no approve and rejects incompatible exact evidence", () => {
  const { input, quoted } = quote(10n ** 7n, {}, "token1-in");
  const fragment = plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut,
    exactEvidence: quoted.evidence,
  } as never);
  assert.deepEqual([...fragment.requirements], []);
  assert.equal(fragment.nodes.length, 1);
  assert.equal(fragment.nodes[0]!.adapterId, KYSWAP_SWAP_ACTION);
  assert.equal(fragment.nodes[0]!.amount, input.amountIn);
  assert.equal(
    typeof (fragment.nodes[0]!.params as { runtimeAmountProgram?: string })
      .runtimeAmountProgram,
    "string",
  );
  assert.throws(() => plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut + 1n,
    minAmountOut: quoted.amountOut,
    exactEvidence: quoted.evidence,
  } as never));
  assert.throws(() => plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut + 1n,
    exactEvidence: quoted.evidence,
  } as never));
  // A refused quote can never become an execution fragment.
  const refused = quote(1n); // WETH input below a representable USDT output.
  assert.equal(refused.quoted.amountOut, 0n);
  assert.equal(refused.quoted.evidence.refusal, "no-representable-output");
  assert.throws(() => plugin.execution.buildFragment({
    ...refused.input,
    quotedAmountOut: 1n,
    minAmountOut: 1n,
    exactEvidence: refused.quoted.evidence,
  } as never));
});

test("the action encodes a positive exact-input swap with a callback payment", () => {
  const d = descriptor();
  const route = routesFor(d)[1]!;
  const data = plugin.actionAdapters[0]!.encode({
    adapterId: KYSWAP_SWAP_ACTION,
    target: d.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    amount: 1_000_000n,
    params: { isToken0: route.isToken0 },
    children: [],
  } as never, EXECUTOR, new Uint8Array());
  const hex = ethers.hexlify(data as Uint8Array);
  assert.ok(hex.includes(KYSWAP_SWAP_SELECTOR.slice(2)));
  // ERC20 transfer(address,uint256) = 0xa9059cbb inside the callback script.
  assert.ok(hex.includes("a9059cbb"));
  assert.throws(() => plugin.actionAdapters[0]!.encode({
    adapterId: KYSWAP_SWAP_ACTION,
    target: d.pool,
    tokenIn: route.tokenIn,
    tokenOut: route.tokenOut,
    amount: 0n,
    params: { isToken0: route.isToken0 },
    children: [],
  } as never, EXECUTOR, new Uint8Array()));
});

test("landed events classify swaps and liquidity mutations, and the decoder recovers the measured swap", () => {
  const log = swapLogEvent();
  assert.equal(
    plugin.swap.landedEvents.classify({ observation: { kind: "log", ...log } } as never),
    "swap",
  );
  const decimals = KYSWAP_POOL_INTERFACE.encodeEventLog("Mint", [
    EXECUTOR,
    EXECUTOR,
    -198260,
    -198250,
    1n,
    1n,
    1n,
  ]);
  assert.equal(
    plugin.swap.landedEvents.classify({
      observation: {
        kind: "log",
        address: POOL,
        topics: decimals.topics,
        data: decimals.data,
      },
    } as never),
    "mutation",
  );
  const decoded = decodeSwapLog(log)!;
  assert.equal(decoded.deltaQty0, -743921665931488n);
  assert.equal(decoded.deltaQty1, 1838763n);
  assert.equal(decoded.isToken0, false);
  assert.equal(decoded.amountIn, 1838763n);
  assert.equal(decoded.amountOut, 743921665931488n);
  assert.equal(decoded.sqrtP, SQRT_P);
  assert.equal(decoded.liquidity, BASE_L);
  assert.equal(decoded.tick, CURRENT_TICK);
  assert.equal(decoded.sender, ethers.getAddress(EXECUTOR));
});

test("expected effects describe a conserving executor swap", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const effects = plugin.execution.expectedEffects({
    descriptor: d,
    route,
  } as never);
  assert.deepEqual(
    effects.map((effect) => `${effect.kind}:${effect.account}:${effect.direction}`),
    [
      "token-delta:executor:decrease",
      "token-delta:route-target:increase",
      "token-delta:route-target:decrease",
      "token-delta:executor:increase",
    ],
  );
  assert.equal(
    (effects[0] as { token: string }).token.toLowerCase(),
    d.token0.toLowerCase(),
  );
  assert.equal(
    (effects[3] as { token: string }).token.toLowerCase(),
    d.token1.toLowerCase(),
  );
});

test("runtime projection declares no standing allowance for a callback pull", () => {
  const projection = plugin.execution.runtimeProjection() as {
    readonly allowanceSpender: string | null;
    readonly prewarmQuoteCalls: readonly unknown[];
  };
  assert.equal(projection.allowanceSpender, null);
  assert.deepEqual([...projection.prewarmQuoteCalls], []);
});

test("discovery nominates pools from calls, swaps and the interface surface", () => {
  assert.equal(plugin.discovery.evidenceChannel, "nominate");
  const candidate = plugin.discovery.decodeCandidate({
    observation: {
      kind: "call",
      target: POOL,
      data: KYSWAP_POOL_INTERFACE.encodeFunctionData("swap", [
        EXECUTOR,
        1n,
        false,
        0n,
        "0x",
      ]),
    },
    matchedPatternId: "kyberswap-elastic-swap-call",
  } as never);
  assert.deepEqual(candidate, {
    candidateKind: "kyberswap-elastic-pool",
    pool: ethers.getAddress(POOL),
    sourceKind: "pool-call",
    hintedFactory: null,
  });
  assert.equal(plugin.discovery.candidateKey(CANDIDATE), POOL.toLowerCase());
  const fromLog = plugin.discovery.decodeCandidate({
    observation: { kind: "log", ...swapLogEvent() },
    matchedPatternId: "kyberswap-elastic-swap-log",
  } as never);
  assert.equal((fromLog as { pool: string }).pool, ethers.getAddress(POOL));
  // A log that is not an Elastic swap nominate nothing.
  assert.equal(plugin.discovery.decodeCandidate({
    observation: {
      kind: "log",
      address: POOL,
      topics: [ethers.ZeroHash],
      data: "0x",
    },
    matchedPatternId: "kyberswap-elastic-swap-log",
  } as never), null);
});

test("fixture answers cover every declared request id of both rounds", () => {
  const reply = answerFor();
  const ids: string[] = [];
  const d = descriptor((request: AdapterRequest) => {
    ids.push(request.id);
    return reply(request);
  });
  assert.ok(d.pool.length > 0);
  assert.ok(ids.includes("pool-state"));
  assert.ok(ids.includes("pool-liquidity-state"));
  assert.ok(ids.includes("factory-get-pool"));
  assert.ok(ids.length >= 9, `expected several evidence rounds, saw ${ids.join(",")}`);
  assert.equal(PREVIOUS_TICK <= NEAREST_CURRENT_TICK, true);
});

for (const direction of ["token0-in", "token1-in"] as const) {
  const isToken0 = direction === "token0-in", sign = isToken0 ? -1 : 1;
  test(`cross-range ${direction}: first-step controls, exact boundary and two initialized crossings`, () => {
    const { state, ticks, options } = crossingFixture(), expected = CROSSING_BOUNDARIES[direction];
    for (const amountIn of [100_000_000n, CROSSING_BOUNDARIES.first.amountIn - 1n]) {
      const old = quoteExactInputStep({ state, isToken0, amountIn });
      const current = quoteExactInput({ state, isToken0, amountIn, ticks });
      assert(old.ok && current.ok);
      assert.equal(current.quote.amountOut, old.quote.amountOut);
      assert.equal(current.quote.sqrtPAfter, old.quote.sqrtPAfter);
      assert.equal(current.quote.deltaL, old.quote.deltaL);
      assert.deepEqual(current.quote.crossedTicks, []);
      assert.equal(current.quote.steps, 1);
    }
    const old = quoteExactInputStep({ state, isToken0, amountIn: expected.amountIn });
    assert(!old.ok); assert.equal(old.refusal, "input-reaches-next-initialized-tick");
    const current = quoteExactInput({ state, isToken0, amountIn: expected.amountIn, ticks });
    assert(current.ok);
    assert.equal(current.quote.amountIn, expected.amountIn);
    assert.equal(current.quote.amountOut, expected.amountOut);
    assert.equal(current.quote.deltaL, expected.deltaL);
    assert.equal(current.quote.sqrtPAfter, getSqrtRatioAtTick(sign * 20));
    assert.equal(current.quote.steps, 2);
    assert.deepEqual(current.quote.crossedTicks, expected.crossedTicks);
    const issued = quote(expected.amountIn, options, direction);
    assert.equal(issued.quoted.amountOut, expected.amountOut);
    assert.equal(issued.quoted.evidence.kind, "kyberswap-elastic-exact-input");
    assert.equal(issued.quoted.evidence.deltaL, expected.deltaL);
    assert.deepEqual(issued.quoted.evidence.crossedTicks, expected.crossedTicks);
    assert.deepEqual(issued.dependentRequests.map(round => round.map(r => r.id)), [
      ...(!isToken0 ? [["kyswap-initialized-ticks"]] : []),
      ...expected.crossedTicks.map(tick => [`kyswap-tick:${tick}`, `kyswap-tick-neighbours:${tick}`]),
    ]);
  });

  test(`cross-range ${direction}: continuation carries reinvest fees and both signed base changes`, () => {
    const { state, ticks } = crossingFixture(), boundary = CROSSING_BOUNDARIES[direction];
    // Verified Pool.swap adds deltaL after EVERY step and subtracts liquidityNet
    // downward / adds it upward. The two net changes are +1e11 and -2e11.
    const after: KyberSwapPoolState = { ...state,
      sqrtP: getSqrtRatioAtTick(sign * 20), currentTick: isToken0 ? -21 : 20,
      nearestCurrentTick: isToken0 ? -30 : 20, previousTick: isToken0 ? -40 : 10,
      nextTick: isToken0 ? -20 : 30,
      baseL: isToken0 ? 1_100_000_000_000n : 900_000_000_000n,
      reinvestL: state.reinvestL + boundary.deltaL,
    };
    for (const tailAmount of [100_000_000n, 200_000_000n]) {
      const tail = quoteExactInputStep({ state: after, isToken0, amountIn: tailAmount });
      const whole = quoteExactInput({ state, isToken0, amountIn: boundary.amountIn + tailAmount, ticks });
      assert(tail.ok && whole.ok);
      assert.equal(whole.quote.amountOut, boundary.amountOut + tail.quote.amountOut);
      assert.equal(whole.quote.sqrtPAfter, tail.quote.sqrtPAfter);
      assert.equal(whole.quote.deltaL, boundary.deltaL + tail.quote.deltaL);
      assert.equal(whole.quote.steps, 3);
      assert.deepEqual(whole.quote.crossedTicks, boundary.crossedTicks);
      const droppedFees = quoteExactInputStep({ state: { ...after, reinvestL: state.reinvestL }, isToken0, amountIn: tailAmount });
      assert(droppedFees.ok);
      assert.notEqual(whole.quote.sqrtPAfter, droppedFees.quote.sqrtPAfter, "accumulated fees must participate in the next step");
    }
  });

  test(`cross-range ${direction}: zero-distance initial crossing updates signed liquidity before spending input`, () => {
    for (const net of [100_000_000_000n, -100_000_000_000n]) {
      const f = crossingFixture();
      const state = { ...f.state, currentTick: isToken0 ? 0 : -1,
        nearestCurrentTick: isToken0 ? 0 : -10, nextTick: isToken0 ? 10 : 0 };
      f.ticks.set(0, { tick: 0, liquidityGross: 200_000_000_000n, liquidityNet: net, previous: -10, next: 10 });
      const after = { ...f.state, baseL: state.baseL + (isToken0 ? -net : net), currentTick: isToken0 ? -1 : 0 };
      const tail = quoteExactInputStep({ state: after, isToken0, amountIn: 100_000_000n });
      const whole = quoteExactInput({ state, isToken0, amountIn: 100_000_000n, ticks: f.ticks });
      assert(tail.ok && whole.ok);
      assert.equal(whole.quote.amountOut, tail.quote.amountOut);
      assert.equal(whole.quote.sqrtPAfter, tail.quote.sqrtPAfter);
      assert.equal(whole.quote.deltaL, tail.quote.deltaL, "zero-distance crossing charges no step fee");
      assert.deepEqual(whole.quote.crossedTicks, [0]); assert.equal(whole.quote.steps, 2);
    }
  });

  test(`cross-range ${direction}: 480-tick virtual steps require no initialized tick rows`, () => {
    const f = crossingFixture();
    const state = { ...f.state, nearestCurrentTick: -10000, previousTick: -20000, nextTick: 10000 };
    const noTicks = new Map<number, KyberSwapTickState>();
    for (const amountIn of [30_000_000_000n, 60_000_000_000n]) {
      const local = quoteExactInput({ state, isToken0, amountIn, ticks: noTicks });
      assert(local.ok); assert(local.quote.steps >= 2); assert.deepEqual(local.quote.crossedTicks, []);
      assert.equal(local.quote.amountIn, amountIn); assert(local.quote.amountOut > 0n);
      const issued = quote(amountIn, { ...state, ticks: noTicks }, direction);
      assert.equal(issued.quoted.amountOut, local.quote.amountOut);
      assert.deepEqual(issued.dependentRequests.map(round => round.map(r => r.id)),
        isToken0 ? [] : [["kyswap-initialized-ticks"]]);
    }
  });

  test(`cross-range ${direction}: missing first/second tick never yields a partial successful fill`, () => {
    const { state, ticks } = crossingFixture(), amountIn = CROSSING_BOUNDARIES[direction].amountIn;
    for (const missingTick of [sign * 10, sign * 20]) {
      const incomplete = new Map(ticks); incomplete.delete(missingTick);
      const outcome = quoteExactInput({ state, isToken0, amountIn, ticks: incomplete });
      assert(!outcome.ok); assert.equal(outcome.refusal, "crossing-state-unavailable");
      assert.equal(outcome.missingTick, missingTick); assert(!Object.hasOwn(outcome, "quote"));
    }
    for (const change of [{ tick: sign * 30 }, isToken0 ? { previous: sign * 10 } : { next: sign * 10 }]) {
      const malformed = new Map(ticks); malformed.set(sign * 10, { ...ticks.get(sign * 10)!, ...change });
      const outcome = quoteExactInput({ state, isToken0, amountIn, ticks: malformed });
      assert(!outcome.ok); assert.equal(outcome.refusal, "tick-list-inconsistent");
    }
    const limitState = { ...state, sqrtP: getSqrtRatioAtTick(isToken0 ? MIN_TICK + 1 : MAX_TICK - 1),
      currentTick: isToken0 ? MIN_TICK + 1 : MAX_TICK - 1, nearestCurrentTick: isToken0 ? MIN_TICK : MAX_TICK - 1,
      nextTick: isToken0 ? MIN_TICK + 2 : MAX_TICK };
    const limited = quoteExactInput({ state: limitState, isToken0, amountIn: 1n << 200n, ticks: new Map() });
    assert(!limited.ok); assert.equal(limited.refusal, "price-limit-partial-fill");
    assert(!Object.hasOwn(limited, "quote"));
  });
}

test("crossing evidence binds both ABI rows to the exact tick and source", () => {
  const f = crossingFixture(), requests = crossingRequests(POOL, -10), reply = answerFor(f.options);
  assert.deepEqual(requests.map(r => r.id), ["kyswap-tick:-10", "kyswap-tick-neighbours:-10"]);
  const rows = requests.map(reply);
  assert.deepEqual(decodeCrossings(rows, SOURCE).get(-10), f.ticks.get(-10));
  assert.throws(() => decodeCrossings([rows[0]!], SOURCE));
  assert.throws(() => decodeCrossings([...rows, rows[0]!], SOURCE));
  for (const tick of [MIN_TICK - 1, MAX_TICK + 1, 0.5, NaN]) assert.throws(() => crossingRequests(POOL, tick));
  for (const i of [0, 1]) {
    for (const source of [{ ...SOURCE, number: SOURCE.number + 1 }, { ...SOURCE, hash: ethers.ZeroHash },
      { ...SOURCE, generation: SOURCE.generation + 1 }]) {
      const stale = [...rows]; stale[i] = { ...rows[i]!, source };
      assert.throws(() => decodeCrossings(stale, SOURCE));
    }
    for (const bad of [result(rows[i]!.id, "0x"), result(rows[i]!.id, "0x", "reverted-as-declared")]) {
      const broken = [...rows]; broken[i] = bad; assert.throws(() => decodeCrossings(broken, SOURCE));
    }
  }
  for (const patch of [{ liquidityGross: 0n, liquidityNet: 0n }, { liquidityGross: 1n },
    { previous: -10 }, { next: -10 }, { previous: MIN_TICK - 1 }, { next: MAX_TICK + 1 }]) {
    const ticks = new Map(f.ticks); ticks.set(-10, { ...ticks.get(-10)!, ...patch });
    assert.throws(() => decodeCrossings(requests.map(answerFor({ ...f.options, ticks })), SOURCE));
  }
});

test("cross-range exhaustion/invalid amounts/liquidity never return a partial quote", () => {
  const f = crossingFixture();
  for (const amountIn of [0n, -1n, 1n << 255n]) {
    const outcome = quoteExactInput({ state: f.state, isToken0: true, amountIn, ticks: f.ticks });
    assert(!outcome.ok); assert.equal(outcome.refusal, "invalid-exact-input");
  }
  const ticks = new Map<number, KyberSwapTickState>();
  for (let tick = 0; tick >= -KYSWAP_MAX_QUOTE_STEPS; tick--)
    ticks.set(tick, { tick, liquidityGross: 1n, liquidityNet: 0n, previous: tick - 1, next: tick + 1 });
  const exhausted = quoteExactInput({ state: { ...f.state, nearestCurrentTick: 0, baseL: 1_000_000n, reinvestL: 0n },
    isToken0: true, amountIn: 1_000_000_000_000n, ticks });
  assert(!exhausted.ok); assert.equal(exhausted.refusal, "quote-step-budget-exhausted");
  assert(!Object.hasOwn(exhausted, "quote"));
  for (const [baseL, net] of [[10n, 11n], [(1n << 128n) - 1n, -1n]]) {
    const row = { tick: 0, liquidityGross: 100n, liquidityNet: net!, previous: -10, next: 10 };
    const outcome = quoteExactInput({ state: { ...f.state, baseL: baseL!, reinvestL: 0n, nearestCurrentTick: 0 },
      isToken0: true, amountIn: 100n, ticks: new Map([[0, row]]) });
    assert(!outcome.ok); assert.equal(outcome.refusal, "liquidity-overflow");
  }
});
