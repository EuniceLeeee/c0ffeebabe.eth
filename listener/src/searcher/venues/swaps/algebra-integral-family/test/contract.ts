import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import {
  activation,
  plugin,
} from "../../../production-families/algebra-integral.production.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import {
  ALGEBRA_FACTORY_INTERFACE,
  ALGEBRA_FACTORY_POOL_PATTERN_ID,
  ALGEBRA_FACTORY_POOL_TOPIC,
  ALGEBRA_INTEGRAL_ADAPTER_ID,
  ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG,
  ALGEBRA_POOL_INTERFACE,
  ALGEBRA_POOL_SURFACE_PATTERN_ID,
  ALGEBRA_SWAP_CALL_PATTERN_ID,
  ALGEBRA_SWAP_LOG_PATTERN_ID,
  ALGEBRA_SWAP_SELECTOR,
  ALGEBRA_SWAP_TOPIC,
} from "../abi.js";
import {
  ALGEBRA_DYNAMIC_FEE_UNSUPPORTED,
  ALGEBRA_REVERSE_BINDING_FAILED,
  ALGEBRA_STATIC_BINDING_MISMATCH,
  ALGEBRA_STATIC_FEE_BINDING_FAILED,
} from "../identity.js";
import { quoteAlgebraExactInput, sqrtRatioAtTick } from "../math.js";
import { reverseBindAlgebraIntegral } from "../reverse-binding.js";
import { ALGEBRA_INTEGRAL_FAMILY_ID } from "../manifest.js";
import {
  answerFor,
  CANDIDATE,
  candidateFor,
  decisionWith,
  descriptor,
  EXECUTOR,
  FACTORY,
  FOREIGN_POOL,
  MEASURED_INSTANCES,
  MEASURED_SWAPS,
  REP_POOL,
  SOURCE,
  STATIC_FEE_CONFIG,
  STATIC_FEE_FACTS,
  STATIC_FEE_POOL,
  USDT,
  WBTC,
} from "./fixtures.js";

assert(plugin.execution.buildRuntimeLeg, "runtime execution must be implemented");
const buildRuntimeLeg = plugin.execution.buildRuntimeLeg;
assert(plugin.pricing.current.classifyUnavailable, "unavailable prices must be classified");
const classifyUnavailable = plugin.pricing.current.classifyUnavailable;

const routesFor = (d: ReturnType<typeof descriptor>) =>
  plugin.routes.project({ descriptor: d });

const inputFor = (
  d: ReturnType<typeof descriptor>,
  route: ReturnType<typeof routesFor>[number],
  amountIn: bigint,
) => ({
  descriptor: d,
  route,
  amountIn,
  source: SOURCE,
  executor: EXECUTOR,
  runtimeEvidence: [],
});

function quote(amountIn: bigint, reply = answerFor()) {
  const d = descriptor(reply);
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, amountIn);
  const method = plugin.exact.methods(input as never)[1]!;
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") {
    throw new Error("algebra-integral is missing its amount request program");
  }
  const requested = method.program.buildRequests(input as never);
  const quoted = method.program.decode({
    programInput: input as never,
    initialResults: requested.map(reply),
    dependentEvidence: [],
  } as never);
  return { d, route, input, method, requested, quoted };
}

function pricingFor(d: ReturnType<typeof descriptor>, reply = answerFor()) {
  const routes = routesFor(d);
  const pricing = plugin.pricing.finalizePricingDescriptor({
    draft: plugin.pricing.compileDraft({
      descriptor: d,
      stateKey: d.instanceKey,
      routes,
    }),
    sharedBindings: [],
  });
  const current = { descriptor: pricing, routes, source: SOURCE };
  const requested = plugin.pricing.current.buildRequests(current as never);
  const snapshot = plugin.pricing.current.decodeSnapshot({
    descriptor: pricing,
    initialResults: requested.map(reply),
    dependentEvidence: [],
  } as never);
  return { pricing, routes, current, requested, snapshot };
}

/** Minimal reader for the family runtime-program encoding (kernel format v1). */
interface Instruction {
  readonly op: string;
  readonly reg?: number;
  readonly value?: bigint;
  readonly kind?: number;
  readonly dst?: number;
  readonly a?: number;
  readonly b?: number;
  readonly offset?: number;
  readonly target?: string;
  readonly isStatic?: number;
  readonly valueReg?: number;
  readonly incomingOffset?: number;
  readonly outgoingOffset?: number;
  readonly patches?: readonly { readonly offset: number; readonly reg: number }[];
  readonly data?: string;
}

function parseRuntimeProgram(program: string): readonly Instruction[] {
  const bytes = ethers.getBytes(program);
  assert.equal(bytes[0], 1, "runtime program version");
  const u24 = (at: number): number =>
    (bytes[at]! << 16) | (bytes[at + 1]! << 8) | bytes[at + 2]!;
  const instructions: Instruction[] = [];
  let ip = 1;
  while (ip < bytes.length) {
    const op = bytes[ip]!;
    ip += 1;
    if (op === 0) {
      instructions.push({
        op: "constant",
        reg: bytes[ip]!,
        value: BigInt(ethers.hexlify(bytes.slice(ip + 1, ip + 33))),
      });
      ip += 33;
    } else if (op === 1) {
      const target = ethers.getAddress(ethers.hexlify(bytes.slice(ip, ip + 20)));
      ip += 20;
      const isStatic = bytes[ip]!;
      const valueReg = bytes[ip + 1]!;
      ip += 2;
      const incomingOffset = u24(ip);
      ip += 3;
      const outgoingOffset = u24(ip);
      ip += 3;
      const patchCount = bytes[ip]!;
      ip += 1;
      const patches: { offset: number; reg: number }[] = [];
      for (let index = 0; index < patchCount; index++) {
        patches.push({ offset: u24(ip), reg: bytes[ip + 3]! });
        ip += 4;
      }
      const dataLength = u24(ip);
      ip += 3;
      const data = ethers.hexlify(bytes.slice(ip, ip + dataLength));
      ip += dataLength;
      instructions.push({
        op: "call",
        target,
        isStatic,
        valueReg,
        incomingOffset,
        outgoingOffset,
        patches,
        data,
      });
    } else if (op === 2) {
      instructions.push({
        op: "math",
        kind: bytes[ip]!,
        dst: bytes[ip + 1]!,
        a: bytes[ip + 2]!,
        b: bytes[ip + 3]!,
      });
      ip += 4;
    } else if (op === 3) {
      instructions.push({ op: "equal", a: bytes[ip]!, b: bytes[ip + 1]! });
      ip += 2;
    } else if (op === 6) {
      instructions.push({ op: "load", reg: bytes[ip]!, offset: u24(ip + 1) });
      ip += 4;
    } else {
      throw new Error(`unexpected runtime opcode ${op}`);
    }
  }
  return instructions;
}

test("manifest declares a swap family owning exactly its own action and no live-seed kind", () => {
  assert.equal(String(plugin.manifest.familyId), String(ALGEBRA_INTEGRAL_FAMILY_ID));
  assert.equal(plugin.manifest.domain, "swap");
  assert.deepEqual([...plugin.manifest.ownedActionAdapterIds], [ALGEBRA_INTEGRAL_ADAPTER_ID]);
  assert(plugin.manifest.edgeAdapterIds);
  assert.deepEqual([...plugin.manifest.edgeAdapterIds], [ALGEBRA_INTEGRAL_ADAPTER_ID]);
  assert.deepEqual(plugin.manifest.allowedTaxonomy.map((slot) => slot.slotKind), ["swap"]);
  assert.equal((plugin.manifest as { livePoolStateKind?: string }).livePoolStateKind, undefined);
  assert.deepEqual(plugin.actionAdapters.map((entry) => entry.id), [ALGEBRA_INTEGRAL_ADAPTER_ID]);
  assert.equal(plugin.swap.victimSupport, "none");
});

test("activation is registered disabled by default for this family's own env key", () => {
  // The production entry must never change the default enabled set: the family
  // only runs when SEARCHER_FAMILY_ALGEBRA_INTEGRAL_ENABLED=1 is set explicitly.
  assert.equal(activation.defaultEnabled, false);
  assert.equal(activation.envKey, "SEARCHER_FAMILY_ALGEBRA_INTEGRAL_ENABLED");
  assert.equal(activation.enabled, false);
});

test("identity admits only a factory-reverse-bound pool whose executed fee is state-readable", () => {
  const identity = descriptor() as unknown as {
    pool: string;
    token0: string;
    token1: string;
    tickSpacing: number;
    factoryBinding: { factory: string; reversePool: string };
    executedFee: { kind: string; fee: bigint; pluginConfig: number; plugin: string };
    provenance: readonly unknown[];
  };
  assert.equal(identity.pool, ethers.getAddress(STATIC_FEE_POOL));
  assert.equal(identity.token0, ethers.getAddress(WBTC));
  assert.equal(identity.token1, ethers.getAddress(USDT));
  assert.equal(identity.tickSpacing, 10);
  assert.equal(identity.factoryBinding.factory, ethers.getAddress(FACTORY));
  assert.equal(identity.factoryBinding.reversePool, ethers.getAddress(STATIC_FEE_POOL));
  assert.equal(identity.executedFee.kind, "global-state-last-fee");
  assert.equal(identity.executedFee.fee, 500n);
  assert.equal(identity.executedFee.pluginConfig, STATIC_FEE_CONFIG);
  assert.ok(identity.provenance.length > 0);
});

test("identity rejects a candidate whose hinted token pair contradicts the pool", () => {
  const decision = decisionWith(
    answerFor(),
    candidateFor({ ...STATIC_FEE_FACTS, token0: STATIC_FEE_FACTS.token1 }),
  );
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    ALGEBRA_STATIC_BINDING_MISMATCH,
  );
});

test("identity rejects a pool the factory does not bind back from poolByPair", () => {
  const decision = decisionWith(answerFor({ foreignReverse: FOREIGN_POOL }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    ALGEBRA_REVERSE_BINDING_FAILED,
  );
});

test("identity rejects a pinned poolByPair revert as chain-proven negative evidence", () => {
  const decision = decisionWith(answerFor({ reverseReverts: true }));
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    ALGEBRA_REVERSE_BINDING_FAILED,
  );
});

test("identity keeps dynamic instances retryable without the required Quoter/code binding", () => {
  // Measured at block 26018534: all six named instances set pluginConfig bit 128
  // (DYNAMIC_FEE), so `_beforeSwap` takes the executed fee from the plugin's
  // `overrideFee` return while `fee()` only proxies `getCurrentFee()`.
  for (const instance of MEASURED_INSTANCES) {
    assert.notEqual(
      instance.pluginConfig & ALGEBRA_PLUGIN_DYNAMIC_FEE_FLAG,
      0,
      `${instance.pool} must be a dynamic-fee pool for this refusal to be the variant gate`,
    );
    const decision = decisionWith(
      answerFor({ facts: { ...STATIC_FEE_FACTS, ...instance, unlocked: true } }),
      candidateFor({ ...STATIC_FEE_FACTS, ...instance }),
    );
    assert.equal(decision.status, "retryable", instance.pool);
    assert.equal(
      (decision as { reasonCode: string }).reasonCode,
      ALGEBRA_DYNAMIC_FEE_UNSUPPORTED,
      instance.pool,
    );
  }
});

test("identity refuses a pool whose fee() disagrees with globalState.lastFee even without the dynamic bit", () => {
  const decision = decisionWith(
    answerFor({ facts: { ...STATIC_FEE_FACTS, feeView: 499n } }),
  );
  assert.equal(decision.status, "chain-proven-rejected");
  assert.equal(
    (decision as { reasonCode: string }).reasonCode,
    ALGEBRA_STATIC_FEE_BINDING_FAILED,
  );
});

test("routes project exactly two swap directions and a pool-anchored graph venue", () => {
  const d = descriptor();
  const routes = routesFor(d);
  assert.equal(routes.length, 2);
  assert.deepEqual(routes.map((route) => route.direction), ["zero-for-one", "one-for-zero"]);
  const forward = routes[0]!;
  assert.equal(forward.tokenIn.toLowerCase(), d.token0.toLowerCase());
  assert.equal(forward.tokenOut.toLowerCase(), d.token1.toLowerCase());
  assert.equal(forward.taxonomy.slotKind, "swap");
  assert.equal(forward.taxonomy.protocolAction, undefined);
  assert.equal(forward.bindingRef.bindingKey, d.pool.toLowerCase());
  assert.equal(forward.tickSpacing, 10);
  const graph = plugin.routes.projectGraph({ descriptor: d, route: forward } as never);
  assert.equal(graph.routeActionAdapterId, ALGEBRA_INTEGRAL_ADAPTER_ID);
  assert.equal(graph.executionTarget, d.pool);
});

test("discovery decodes the factory Pool log, a pool Swap log and a pool swap call", () => {
  const candidates = [
    plugin.discovery.decodeCandidate({
      matchedPatternId: ALGEBRA_FACTORY_POOL_PATTERN_ID,
      observation: {
        kind: "log",
        source: SOURCE,
        address: FACTORY,
        topics: [
          ALGEBRA_FACTORY_POOL_TOPIC,
          ethers.zeroPadValue(WBTC, 32),
          ethers.zeroPadValue(USDT, 32),
        ],
        data: ALGEBRA_FACTORY_INTERFACE.encodeEventLog(
          ALGEBRA_FACTORY_INTERFACE.getEvent("Pool")!,
          [WBTC, USDT, REP_POOL],
        ).data,
      },
    } as never),
    plugin.discovery.decodeCandidate({
      matchedPatternId: ALGEBRA_SWAP_LOG_PATTERN_ID,
      observation: {
        kind: "log",
        source: SOURCE,
        address: REP_POOL,
        topics: [
          ALGEBRA_SWAP_TOPIC,
          ethers.zeroPadValue(EXECUTOR, 32),
          ethers.zeroPadValue(EXECUTOR, 32),
        ],
        data: ALGEBRA_POOL_INTERFACE.encodeEventLog(
          ALGEBRA_POOL_INTERFACE.getEvent("Swap")!,
          [EXECUTOR, EXECUTOR, 1202n, -1001943n, 2286928435526579203707256276449n,
            27179990n, 67256, 345n, 0n],
        ).data,
      },
    } as never),
    plugin.discovery.decodeCandidate({
      matchedPatternId: ALGEBRA_SWAP_CALL_PATTERN_ID,
      observation: {
        kind: "call",
        source: SOURCE,
        target: REP_POOL,
        data: ALGEBRA_POOL_INTERFACE.encodeFunctionData("swap", [
          EXECUTOR, true, 1202n, 4295128740n, "0x",
        ]),
      },
    } as never),
    plugin.discovery.decodeCandidate({
      matchedPatternId: ALGEBRA_POOL_SURFACE_PATTERN_ID,
      observation: {
        kind: "address-surface",
        source: SOURCE,
        address: STATIC_FEE_POOL,
        codeHash: ethers.keccak256("0x60016000f3"),
        implementationWord: ethers.zeroPadValue("0x", 32),
        interfaceFingerprints: ["algebra-integral-pool-surface-v1"],
        opaque: { adapter: "algebra-integral", factory: FACTORY, token0: WBTC, token1: USDT },
      },
    } as never),
  ];
  assert.deepEqual(
    candidates.map((candidate) => candidate?.sourceKind),
    ["factory-pool-log", "pool-swap-log", "pool-call", "pool-surface"],
  );
  assert.equal(
    candidates[0]!.pool.toLowerCase(),
    REP_POOL.toLowerCase(),
    "the factory Pool log nominates the pool address it carries",
  );
  // The factory address is a hint from the observed emitter, never an allowlist.
  assert.equal(candidates[0]!.hintedFactory, ethers.getAddress(FACTORY));
});

test("the landed-event decoder exposes the executed overrideFee and pluginFee", () => {
  const decoded = plugin.swap.observation.decode({
    matchedPatternId: ALGEBRA_SWAP_LOG_PATTERN_ID,
    observation: {
      kind: "log",
      source: SOURCE,
      address: REP_POOL,
      topics: [
        ALGEBRA_SWAP_TOPIC,
        ethers.zeroPadValue(EXECUTOR, 32),
        ethers.zeroPadValue(EXECUTOR, 32),
      ],
      data: ALGEBRA_POOL_INTERFACE.encodeEventLog(
        ALGEBRA_POOL_INTERFACE.getEvent("Swap")!,
        [EXECUTOR, EXECUTOR, -628n, 521284n, 2282196496537812804600976810178n,
          27179990n, 67214, 51n, 0n],
      ).data,
    },
  } as never);
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0]!.kind, "swap");
  const payload = decoded[0]!.canonicalPayload as Record<string, unknown>;
  assert.equal(payload.overrideFee, 51n);
  assert.equal(payload.pluginFee, 0n);
  assert.equal(payload.amountIn, 521284n);
  assert.equal(payload.amountOut, 628n);
  assert.equal(plugin.swap.landedEvents.classify({
    observation: { kind: "log", source: SOURCE, address: REP_POOL, topics: [ALGEBRA_SWAP_TOPIC], data: "0x" },
  }), "swap");
});

test("THE MODEL PROOF: the family's Algebra math reproduces four real swaps including their overrideFee", () => {
  for (const sample of MEASURED_SWAPS) {
    const zeroForOne = sample.direction === "zero-for-one";
    const quote = quoteAlgebraExactInput({
      sqrtPriceX96: sample.sqrtPriceX96,
      liquidity: sample.liquidity,
      // `_calculateSwap` uses overrideFee + pluginFee when the plugin overrides.
      fee: sample.overrideFee + sample.pluginFee,
      targetSqrtPriceX96: sqrtRatioAtTick(
        zeroForOne ? sample.prevTickGlobal : sample.nextTickGlobal,
      ),
      tickSpacing: sample.tickSpacing,
    }, zeroForOne, sample.amountIn);
    assert.equal(quote.status, "quoted", `block ${sample.swapBlock}`);
    if (quote.status !== "quoted") continue;
    assert.equal(quote.amountOut, sample.amountOut, `amountOut at block ${sample.swapBlock}`);
    assert.equal(
      quote.sqrtPriceX96After,
      sample.postSqrtPriceX96,
      `post price at block ${sample.swapBlock}`,
    );
    // The pool's own state-readable fee at the SAME block is a different number,
    // so pricing from `fee()` cannot reproduce what the pool executed: the event
    // proves the executed fee is 345/346/345/51 while `fee()` said 200/200/199
    // and `globalState.lastFee` said 500.
    assert.notEqual(sample.feeView, sample.overrideFee, `block ${sample.swapBlock}`);
    assert.notEqual(sample.lastFee, sample.overrideFee, `block ${sample.swapBlock}`);
  }

  // These four measured swaps are tiny (1202-1379 token0 units), so their fee
  // quantization hides a fee difference below one input unit; the mismatch is
  // therefore established by the event payload above, not by output sensitivity.
  // At a realistic size the fee choice is decisive, which is why a pool whose
  // executed fee is not state-readable cannot be quoted at all.
  const first = MEASURED_SWAPS[0]!;
  const probe = (fee: bigint) => quoteAlgebraExactInput({
    sqrtPriceX96: first.sqrtPriceX96,
    liquidity: first.liquidity,
    fee,
    targetSqrtPriceX96: sqrtRatioAtTick(first.prevTickGlobal),
    tickSpacing: first.tickSpacing,
  }, true, 10_000n);
  const executed = probe(first.overrideFee);
  const lastFee = probe(first.lastFee);
  assert.equal(executed.status, "quoted");
  assert.equal(lastFee.status, "quoted");
  if (executed.status === "quoted" && lastFee.status === "quoted") {
    assert.notEqual(executed.amountOut, lastFee.amountOut);
    assert.notEqual(executed.sqrtPriceX96After, lastFee.sqrtPriceX96After);
  }
});

test("TickMath bounds agree with the measured pool state (validates the tick constants)", () => {
  for (const sample of MEASURED_SWAPS) {
    assert.ok(sqrtRatioAtTick(sample.tick) <= sample.sqrtPriceX96, `tick ${sample.tick}`);
    assert.ok(
      sample.sqrtPriceX96 < sqrtRatioAtTick(sample.tick + 1),
      `tick ${sample.tick} upper bound`,
    );
  }
  assert.equal(sqrtRatioAtTick(0), 1n << 96n);
  assert.equal(
    sqrtRatioAtTick(-887272),
    4295128739n,
    "MIN_TICK must resolve to MIN_SQRT_RATIO",
  );
  assert.equal(
    sqrtRatioAtTick(887272),
    1461446703485210103287273052203988822378723970342n,
    "MAX_TICK must resolve to MAX_SQRT_RATIO",
  );
});

test("exact quote honours the caller's specified amount with the readable executed fee", () => {
  const small = quote(1_000n);
  const large = quote(10_000n);
  assert(small.quoted.evidence.kind === "algebra-integral-single-range");
  assert.equal(small.quoted.evidence.feeProvenance, "algebra-static-last-fee");
  assert.equal(small.quoted.evidence.executedFee, 500n);
  assert.equal(small.quoted.evidence.amountIn, 1_000n);
  assert.equal(small.quoted.evidence.amountOut, small.quoted.amountOut);
  assert.equal(small.quoted.evidence.declinedReason, null);
  assert.ok(small.quoted.amountOut > 0n);
  assert.ok(large.quoted.amountOut > small.quoted.amountOut);
  // Independently re-derive the same number from the same source state.
  const expected = quoteAlgebraExactInput({
    sqrtPriceX96: STATIC_FEE_FACTS.sqrtPriceX96,
    liquidity: STATIC_FEE_FACTS.liquidity,
    fee: STATIC_FEE_FACTS.feeView,
    targetSqrtPriceX96: sqrtRatioAtTick(STATIC_FEE_FACTS.prevTickGlobal),
    tickSpacing: STATIC_FEE_FACTS.tickSpacing,
  }, true, 1_000n);
  assert.equal(expected.status, "quoted");
  if (expected.status === "quoted") {
    assert.equal(small.quoted.amountOut, expected.amountOut);
  }
});

test("exact quote reads only amount-independent pool state, one round of six reads", () => {
  const { requested } = quote(1_000n);
  assert.deepEqual(requested.map((request) => request.id), [
    "pool-global-state",
    "pool-liquidity",
    "pool-fee",
    "pool-tick-spacing",
    "pool-next-tick-global",
    "pool-prev-tick-global",
  ]);
  for (const request of requested) {
    assert.equal(request.kind, "eth-call");
    const encoded = (request as { readonly data: string }).data;
    // No amount ever appears in the quote requests: they are pure state reads.
    assert.ok(!encoded.includes("128acb08"), "the quote must not execute a swap");
  }
});

test("exact quote declines instead of extrapolating when the input would cross the next initialized tick", () => {
  const routes = routesFor(descriptor());
  const forward = routes[0]!;
  // The whole in-range capacity of this geometry is far below 1e30 token0 units.
  const huge = quote(10n ** 30n);
  assert.equal(huge.route.direction, forward.direction);
  assert.equal(huge.quoted.amountOut, 0n);
  assert.match(String(huge.quoted.evidence.declinedReason), /crosses the next initialized tick/);
});

test("exact quote declines (never quotes) once a pool is plugin-fee controlled", () => {
  // The descriptor was admitted on the supported variant; the source reads then
  // report the dynamic-fee plugin config, so the quote must decline.
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, 1_000n);
  const method = plugin.exact.methods(input as never)[1]!;
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") return;
  const requested = method.program.buildRequests(input as never);
  const pooled = answerFor({
    facts: { ...STATIC_FEE_FACTS, pluginConfig: 215, feeView: 50n },
  });
  const quoted = method.program.decode({
    programInput: input as never,
    initialResults: requested.map(pooled),
    dependentEvidence: [],
  } as never);
  assert.equal(quoted.amountOut, 0n);
  assert.match(String(quoted.evidence.declinedReason), /dynamic-fee/);
});

test("exact quote exposes a local-zero method for a zero amount and no swap call", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const methods = plugin.exact.methods(inputFor(d, route, 0n) as never);
  assert.equal(methods[0]!.id, "algebra-local-zero");
  assert.equal(methods[0]!.kind, "local");
});

test("exact quote refuses a foreign canonical source", () => {
  const reply = answerFor({ source: { number: SOURCE.number - 1, hash: SOURCE.hash, generation: 1 } });
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, 1_000n);
  const method = plugin.exact.methods(input as never)[1]!;
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") return;
  const requested = method.program.buildRequests(input as never);
  assert.throws(
    () => method.program.decode({
      programInput: input as never,
      initialResults: requested.map(reply),
      dependentEvidence: [],
    } as never),
    /foreign source/,
  );
});

test("pricing derives both venue mids from the source-bound pool state", () => {
  const d = descriptor();
  const { snapshot, routes, current } = pricingFor(d);
  assert.equal(snapshot.inactiveReason, null);
  assert.equal(snapshot.executedFee, 500n);
  assert.equal(snapshot.lastFee, 500n);
  assert.equal(snapshot.tickSpacing, 10);
  const mids = plugin.pricing.current.deriveMids({
    descriptor: current.descriptor,
    snapshot,
    routes,
  } as never);
  assert.equal(mids.size, 2);
  const unavailable = classifyUnavailable({
    descriptor: current.descriptor,
    snapshot,
    routes,
  } as never);
  assert.equal(unavailable.size, 0);
});

test("pricing reports the unsupported variant as unavailable instead of pricing it", () => {
  const d = descriptor();
  const { snapshot, routes, current } = pricingFor(
    d,
    answerFor({ facts: { ...STATIC_FEE_FACTS, pluginConfig: 215, feeView: 50n } }),
  );
  assert.match(String(snapshot.inactiveReason), /not the supported variant/);
  assert.equal(
    plugin.pricing.current.deriveMids({
      descriptor: current.descriptor,
      snapshot,
      routes,
    } as never).size,
    0,
  );
  assert.equal(
    classifyUnavailable({
      descriptor: current.descriptor,
      snapshot,
      routes,
    } as never).size,
    2,
  );
});

test("pricing invalidates the instance on the pool's own fee/plugin/tick admin events", () => {
  const d = descriptor();
  const { current } = pricingFor(d);
  const keys = plugin.pricing.mutation!.affectedStateKeys({
    descriptor: current.descriptor,
    routes: routesFor(d),
    observation: {
      kind: "log",
      source: SOURCE,
      address: d.pool,
      topics: [ALGEBRA_POOL_INTERFACE.getEvent("PluginConfig")!.topicHash],
      data: "0x",
    },
  } as never);
  assert.deepEqual([...keys], [d.instanceKey]);
});

test("buildRuntimeLeg patches the working amount into amountRequired and never reads a quoted amount", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, 1_000n) as Record<string, unknown>;
  for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"]) {
    Object.defineProperty(input, key, {
      get() {
        throw new Error(`runtime construction accessed ${key}`);
      },
    });
  }
  const leg = buildRuntimeLeg(input as never);
  assert.ok(leg, "a supported route must construct a runtime leg");
  assert.equal(leg.actionAdapterId, ALGEBRA_INTEGRAL_ADAPTER_ID);
  const instructions = parseRuntimeProgram(leg.program);
  // exact-input guard: r2 = (r0 >> 255); require r2 == 0 — a negative
  // amountRequired would mean exact OUTPUT and must be impossible.
  assert.deepEqual(instructions[0], { op: "constant", reg: 1, value: 255n });
  assert.deepEqual(instructions[1], { op: "math", kind: 4, dst: 2, a: 0, b: 1 });
  assert.deepEqual(instructions[2], { op: "constant", reg: 3, value: 0n });
  assert.deepEqual(instructions[3], { op: "equal", a: 2, b: 3 });
  assert.equal(instructions[4]!.target, ethers.getAddress(route.tokenIn));
  assert.equal(instructions[4]!.isStatic, 1, "capture actual input inventory");
  assert.deepEqual(instructions[5], { op: "load", reg: 4, offset: 0 });
  const call = instructions[6]!;
  assert.equal(call.op, "call");
  assert.equal(call.target, ethers.getAddress(d.pool));
  assert.equal(call.isStatic, 0);
  assert.equal(call.valueReg, 255, "the leg must never send native value");
  assert.equal(call.incomingOffset, 132);
  assert.equal(call.outgoingOffset, 196);
  assert.deepEqual(call.patches, [
    { offset: 68, reg: 0 },
    { offset: 197, reg: 0 },
  ]);
  const calldata = call.data!;
  assert.equal(calldata.slice(0, 10), ALGEBRA_SWAP_SELECTOR);
  // The amount-sensitive word and the embedded callback debt word are ZERO in
  // the emitted bytes: the kernel patches the working amount in at run time.
  assert.equal(BigInt(`0x${calldata.slice(2 + 68 * 2, 2 + 100 * 2)}`), 0n);
  assert.equal(BigInt(`0x${calldata.slice(2 + 197 * 2, 2 + 229 * 2)}`), 0n);
  // The callback script is a real bounded program fragment (0x0e flow leg).
  assert.equal(calldata.slice(2 + 196 * 2, 2 + 197 * 2), "0e");
  assert.deepEqual(instructions[7], { op: "load", reg: 1, offset: 0 });
  assert.deepEqual(instructions[8], { op: "equal", a: 1, b: 0 }, "returned input must be full");
  assert.equal(instructions[9]!.target, ethers.getAddress(route.tokenIn));
  assert.equal(instructions[9]!.isStatic, 1);
  assert.deepEqual(instructions[10], { op: "load", reg: 1, offset: 0 });
  assert.deepEqual(instructions[11], { op: "math", kind: 1, dst: 2, a: 4, b: 1 });
  assert.deepEqual(instructions[12], { op: "equal", a: 2, b: 0 }, "actual debit must be full");
  assert.equal(instructions.length, 13);
  assert.equal(instructions.filter(i => i.op === "call" && sameToken(i.target, route.tokenOut)).length, 0,
    "runtime leaves output measurement to the central actual-receipt flow");
});

test("buildRuntimeLeg uses the token1 debt word and return word for the reverse direction", () => {
  const d = descriptor();
  const route = routesFor(d)[1]!;
  assert.equal(route.direction, "one-for-zero");
  const leg = buildRuntimeLeg(inputFor(d, route, 1_000n) as never);
  assert.ok(leg);
  const instructions = parseRuntimeProgram(leg.program);
  // Both directions patch the same two words: amountRequired (68) and the
  // embedded callback script's own amount word (196 + 1).
  assert.deepEqual(instructions[6]!.patches, [
    { offset: 68, reg: 0 },
    { offset: 197, reg: 0 },
  ]);
  assert.deepEqual(instructions[7], { op: "load", reg: 1, offset: 32 });
  // The debt word the callback reads is amount1Delta at offset 36 (0x24) of
  // algebraSwapCallback's head; the forward direction reads amount0Delta at 4.
  assert.ok(
    instructions[6]!.data!.includes("0701000024"),
    "the callback must read amount1Delta for one-for-zero",
  );
  const forward = buildRuntimeLeg(
    inputFor(d, routesFor(d)[0]!, 1_000n) as never,
  );
  assert.ok(forward);
  assert.ok(
    parseRuntimeProgram(forward.program)[6]!.data!.includes("0701000004"),
    "the callback must read amount0Delta for zero-for-one",
  );
});

test("buildFragment attaches the runtime program and refuses incompatible evidence", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const input = inputFor(d, route, 1_000n);
  const method = plugin.exact.methods(input as never)[1]!;
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") return;
  const requested = method.program.buildRequests(input as never);
  const reply = answerFor();
  const quoted = method.program.decode({
    programInput: input as never,
    initialResults: requested.map(reply),
    dependentEvidence: [],
  } as never);
  const fragment = plugin.execution.buildFragment({
    ...input,
    quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut - 1n,
    exactEvidence: quoted.evidence,
  } as never);
  assert.equal(fragment.nodes.length, 1);
  const node = fragment.nodes[0]!;
  assert.equal(node.adapterId, ALGEBRA_INTEGRAL_ADAPTER_ID);
  assert.equal(node.target, d.pool);
  assert.equal(node.amount, 1_000n);
  assert.equal(typeof node.params.runtimeAmountProgram, "string");
  // The shared settlement is retained; only quoted construction adds its
  // actual-output floor. This must not silently alias the floor-free runtime.
  assert.notEqual(
    node.params.runtimeAmountProgram,
    buildRuntimeLeg(input as never)!.program,
  );
  const quotedInstructions = parseRuntimeProgram(String(node.params.runtimeAmountProgram));
  assert.equal(quotedInstructions.filter(i => i.op === "call" && sameToken(i.target, route.tokenOut)).length, 2);
  assert.deepEqual(quotedInstructions.slice(-3), [
    { op: "math", kind: 1, dst: 2, a: 1, b: 5 },
    { op: "constant", reg: 3, value: quoted.amountOut - 1n },
    { op: "math", kind: 1, dst: 2, a: 2, b: 3 },
  ]);
  assert.throws(
    () => plugin.execution.buildFragment({
      ...input,
      quotedAmountOut: quoted.amountOut + 1n,
      minAmountOut: quoted.amountOut,
      exactEvidence: quoted.evidence,
    } as never),
    /incompatible exact evidence/,
  );
});

function sameToken(left: string | undefined, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

test("quoted execution accepts current static fee/config evidence rather than the old Ready values", () => {
  const d = descriptor();
  const input = inputFor(d, routesFor(d)[0]!, 1_000n);
  const method = plugin.exact.methods(input as never)[1]!;
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") return;
  const reply = answerFor({ facts: { ...STATIC_FEE_FACTS, lastFee: 600n, feeView: 600n,
    pluginConfig: STATIC_FEE_CONFIG & ~4 } });
  const quoted = method.program.decode({ programInput: input,
    initialResults: method.program.buildRequests(input as never).map(reply), dependentEvidence: [] } as never);
  assert(quoted.evidence.kind === "algebra-integral-single-range");
  assert.notEqual(quoted.evidence.executedFee, d.executedFee.fee);
  assert.notEqual(quoted.evidence.pluginConfig, d.executedFee.pluginConfig);
  assert(quoted.amountOut > 0n);
  assert.doesNotThrow(() => plugin.execution.buildFragment({ ...input, quotedAmountOut: quoted.amountOut,
    minAmountOut: quoted.amountOut, exactEvidence: quoted.evidence } as never));
});

test("quoted construction rejects invalid minima/amounts without weakening quote identity", () => {
  const q = quote(1_000n);
  const input = { ...q.input, quotedAmountOut: q.quoted.amountOut, minAmountOut: q.quoted.amountOut,
    exactEvidence: q.quoted.evidence };
  for (const change of [{ minAmountOut: -1n }, { minAmountOut: q.quoted.amountOut + 1n },
    { amountIn: 0n }, { amountIn: 1n << 255n }, { exactEvidence: { ...q.quoted.evidence, tokenOut: FOREIGN_POOL } }]) {
    assert.throws(() => plugin.execution.buildFragment({ ...input, ...change } as never), /incompatible exact evidence/);
  }
});

test("buildFragment refuses declined evidence and a plan never carries a zero quote", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const huge = quote(10n ** 30n);
  assert.throws(
    () => plugin.execution.buildFragment({
      ...inputFor(d, route, 10n ** 30n),
      quotedAmountOut: huge.quoted.amountOut,
      minAmountOut: 0n,
      exactEvidence: huge.quoted.evidence,
    } as never),
    /incompatible exact evidence/,
  );
});

test("execution declares no standing allowance and the direction-agnostic token deltas", () => {
  const d = descriptor();
  const route = routesFor(d)[0]!;
  const projection = plugin.execution.runtimeProjection({
    hop: {
      adapterId: ALGEBRA_INTEGRAL_ADAPTER_ID,
      target: d.pool,
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
    },
  });
  assert.equal(projection.allowanceSpender, null);
  assert.deepEqual([...projection.prewarmQuoteCalls], []);
  const effects = plugin.execution.expectedEffects({
    descriptor: d,
    route,
    amountIn: 1_000n,
    quotedAmountOut: 1n,
  } as never);
  assert.deepEqual(
    effects.map((effect) => `${effect.kind}:${String((effect as { token?: string }).token)}:${(effect as { direction: string }).direction}`),
    [
      `token-delta:${route.tokenIn}:decrease`,
      `token-delta:${route.tokenIn}:increase`,
      `token-delta:${route.tokenOut}:decrease`,
      `token-delta:${route.tokenOut}:increase`,
    ],
  );
});

test("the family action owns the swap selector and refuses any node without a runtime program", () => {
  const action = plugin.actionAdapters[0]!;
  assert.equal(action.id, ALGEBRA_INTEGRAL_ADAPTER_ID);
  assert.equal((action as unknown as { field2Offset: number }).field2Offset, 132);
  const matcher = (action as unknown as {
    matchTrace(target: string, selector: string): boolean;
  }).matchTrace;
  assert.equal(matcher(STATIC_FEE_POOL, ALGEBRA_SWAP_SELECTOR), true);
  assert.equal(matcher(STATIC_FEE_POOL, "0xdeadbeef"), false);
  assert.throws(
    () => (action as unknown as { encode(node: unknown, e: string, i: Uint8Array): Uint8Array })
      .encode({
        adapterId: ALGEBRA_INTEGRAL_ADAPTER_ID,
        target: STATIC_FEE_POOL,
        tokenIn: WBTC,
        tokenOut: USDT,
        amount: 1_000n,
        params: {},
        children: [],
      }, EXECUTOR, new Uint8Array()),
    /runtime amount program/,
  );
});

test("no central file owns an algebra-specific address, ABI or action id", () => {
  // The four addresses this family can be reached through are discovered on
  // chain (factory reverse binding); the candidate below carries no allowlist.
  const decision = decisionWith(
    answerFor(),
    { ...CANDIDATE, pool: STATIC_FEE_POOL } as never,
  );
  assert.equal(decision.status, "verified");
  assert.ok(plugin.discovery.sources.includes("factory-log"));
  assert.equal(typeof plugin.discovery.nominate?.nominate, "function");
  assert(plugin.discovery.reverseBinding?.kind === "implementation");
  assert.equal(typeof plugin.discovery.reverseBinding.reverseBinding, "function");
});

test("fixture answer requests are the family's own declaration, not a central table", () => {
  const declared = new Set<string>();
  const reply = (request: AdapterRequest) => {
    declared.add(request.id);
    return answerFor()(request);
  };
  quote(1_000n, reply);
  assert.ok(declared.has("pool-global-state"));
  assert.ok(declared.has("factory-pool-by-pair"), "identity reads the factory reverse binding");
});

test("reverse binding re-materializes a pool surface from chain truth and labels foreign nominations", async () => {
  const provider = {
    getCode: async () => "0x60016000f3",
    call: async () => ALGEBRA_POOL_INTERFACE.encodeFunctionResult("factory", [FACTORY]),
  };
  const verified = await reverseBindAlgebraIntegral({
    source: SOURCE,
    nominations: [{
      address: STATIC_FEE_POOL,
      opaque: { adapter: "algebra-integral", token0: WBTC, token1: USDT },
    }],
    provider,
  } as never);
  assert.equal(verified.length, 1);
  assert.equal(verified[0]!.status, "verified");
  if (verified[0]!.status !== "verified") return;
  const observation = verified[0]!.observation as unknown as {
    kind: string;
    address: string;
    interfaceFingerprints: readonly string[];
    opaque: { factory: string; token0: string; token1: string };
  };
  assert.equal(observation.kind, "address-surface");
  assert.equal(observation.address, STATIC_FEE_POOL);
  // The factory is read from the pool at the source block, never assumed.
  assert.equal(observation.opaque.factory, ethers.getAddress(FACTORY));
  assert.deepEqual([...observation.interfaceFingerprints], ["algebra-integral-pool-surface-v1"]);

  const foreign = await reverseBindAlgebraIntegral({
    source: SOURCE,
    nominations: [{ address: STATIC_FEE_POOL, opaque: { adapter: "univ3" } }],
    provider,
  } as never);
  assert.equal(foreign[0]!.status, "unsupported");
  assert.equal((foreign[0] as { reason: string }).reason, "not-algebra-integral-opaque");

  const undeployed = await reverseBindAlgebraIntegral({
    source: SOURCE,
    nominations: [{ address: FOREIGN_POOL, opaque: { adapter: "algebra-integral" } }],
    provider: { getCode: async () => "0x", call: provider.call },
  } as never);
  assert.equal(undeployed[0]!.status, "failed");
  assert.equal((undeployed[0] as { reason: string }).reason, "no-deployed-code");
});
