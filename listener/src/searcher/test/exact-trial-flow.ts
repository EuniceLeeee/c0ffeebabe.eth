import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createAdapterFamilyExactQuoteCache } from "../adapter-family-exact-quote-cache.js";
import { runUniv2Lifecycle, UNIV2_FIXTURE_FACTORY, UNIV2_FIXTURE_TOKEN0,
  UNIV2_FIXTURE_TOKEN1 } from "../architecture-migration-fixture-replay.js";
import { StrictProductionRuntimeRoot } from "../strict-production-runtime-session.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { defineSwapFamily, definedFamilyPluginContractSummary,
  type ExactMethod, type ExactQuoteInput, type ExactRequestProgram } from "../venues/adapter-family-plugin.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { plugin as baseV2Plugin } from "../venues/production-families/univ2-standard.production.js";
import { UNIV2_PAIR_INTERFACE, UNIV2_TOKEN_INTERFACE } from "../venues/swaps/univ2-family/codec.js";
import type { UniV2Descriptor, UniV2ExactEvidence, UniV2Route } from "../venues/swaps/univ2-family/types.js";
import type { CanonicalSource } from "../venues/adapter-request-program.js";
import type { ExactPrefixReadInput, ExactPrefixReadResult } from "../exact-prefix-context.js";
import * as actionRegistry from "../../adapters/registry.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../venues/production-infra-actions.js";

// Real production identity/lifecycle/session/issuer + real V2 state transitions.
// Other methods are synthetic quote transports. The sequentialPrefix fixture
// proves only dispatch and authority: it encodes the received prefix length,
// NOT actual prefix EVM execution. No external RPC or new pipeline is used.
const address = (n: number) => ethers.toBeHex(0x10000 + n, 20);
const LOCAL = address(1), MIDDLE = address(2), PREFIX = address(3);
const EXECUTOR = address(9), TOKEN0 = UNIV2_FIXTURE_TOKEN0, TOKEN1 = UNIV2_FIXTURE_TOKEN1;
const SOURCE: CanonicalSource = { number: 25_800_000, hash: ethers.id("trial-flow-fixture"), generation: 1 };
const RESERVE0 = 1_000_000_000n, RESERVE1 = 2_000_000_000n;
const QUOTE = new ethers.Interface([
  "function quote(uint256 amountIn,uint256 prefixLength) view returns (uint256)",
]);
type Input = ExactQuoteInput<UniV2Descriptor, UniV2Route>;
type Method = ExactMethod<UniV2Descriptor, UniV2Route, UniV2ExactEvidence>;
interface Config {
  readonly kind: "chain" | "prefix-rejecting-chain" | "sequential-fixture" | "invalid-dual";
}
function mutable<T>(value: T): T {
  if (Array.isArray(value)) return value.map(mutable) as T;
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, mutable(item)])) as T;
  return value;
}
function evidence(i: Input, amountOut: bigint): UniV2ExactEvidence {
  return { kind: "univ2-reserves-exact", quoteModel: "constant-product", source: i.source,
    pool: i.descriptor.pool, tokenIn: i.route.tokenIn, tokenOut: i.route.tokenOut,
    amountIn: i.amountIn, amountOut, receivedAmountIn: i.amountIn, poolAmountOut: amountOut,
    reserveIn: RESERVE0, reserveOut: RESERVE1, feeBps: i.descriptor.feeRule.feeBps };
}
async function fixture(configs: ReadonlyMap<string, Config>, omitLocalZeroFor: ReadonlySet<string> = new Set(),
  prefixRead?: (input: ExactPrefixReadInput) => Promise<ExactPrefixReadResult>) {
  const calls: { to: string; data: string }[] = [];
  const semanticInputs: { pool: string; stage: string; prefixLength: number | undefined }[] = [];
  function record(stage: string, input: Input) {
    semanticInputs.push({ pool: input.descriptor.pool.toLowerCase(), stage, prefixLength: input.prefix?.length });
  }
  function requestMethod(config: Config): Method {
    const program: ExactRequestProgram<UniV2Descriptor, UniV2Route, UniV2ExactEvidence> = {
      requirements(input) { record("requirements", input); return { transports: ["eth-call"] }; },
      buildRequests(input) {
        record("build", input);
        return [{ id: "fixture-quote", kind: "eth-call", to: input.descriptor.pool,
          data: QUOTE.encodeFunctionData("quote", [input.amountIn, input.prefix?.length ?? 0]), completion: "return-data" }];
      },
      decode({ programInput: input, initialResults, dependentEvidence }) {
        record("decode", input); assert.equal(dependentEvidence.length, 0);
        assert.equal(initialResults.length, 1);
        const result = initialResults[0]; assert(result.ok && result.completion === "returned");
        const amountOut = BigInt(result.data);
        return { amountOut, evidence: evidence(input, amountOut) };
      },
    };
    const base = { id: "fixture-trial-flow", kind: "request-program" as const, program };
    if (config.kind === "invalid-dual") return { ...base, chainAmountQuote: true,
      trialState: { quote: () => ({ status: "not-applicable", reason: "invalid dual declaration" }) } } as unknown as Method;
    return { ...base, chainAmountQuote: true,
      ...(config.kind === "sequential-fixture" ? { sequentialPrefix: true as const } : {}) };
  }
  const definition = mutable(baseV2Plugin);
  const plugin = defineSwapFamily({ ...definition, actionAdapters: baseV2Plugin.actionAdapters,
    exact: { ...definition.exact, methods(input) {
      const config = configs.get(input.descriptor.pool.toLowerCase());
      if (config?.kind === "prefix-rejecting-chain" && input.prefix?.length) return [];
      if (config) return [requestMethod(config)];
      const methods = baseV2Plugin.exact.methods(input);
      // Test-only selection of the actual production state-model method, so a
      // zero identity cannot mask whether an inherited snapshot exists.
      return omitLocalZeroFor.has(input.descriptor.pool.toLowerCase())
        ? methods.filter(method => method.kind !== "local") : methods;
    } },
  });
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: plugin.manifest.familyId, capability,
    contractVersion: "trial-flow-fixture-v1", contentHash: ethers.sha256(ethers.toUtf8Bytes(capability)).slice(2),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
  const catalog = new FamilyCapabilityCatalog({ modules: [{ sourceFile: "fixture/trial-flow.production.ts", plugin,
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const publications = await Promise.all([LOCAL, MIDDLE, PREFIX].map(pool =>
    runUniv2Lifecycle(SOURCE, { pool, factory: UNIV2_FIXTURE_FACTORY, token0: TOKEN0, token1: TOKEN1,
      reserves: { reserve0: RESERVE0, reserve1: RESERVE1, blockTimestampLast: 1 } }, catalog)));
  const instances = publications.flatMap(p => p.instances);
  const graph = buildFamilyRouteGraphView({ routes: instances.flatMap(instance => instance.routes.map((route, index) => ({
    family: catalog.forFamily(instance.familyId), descriptor: instance.descriptor, route, handle: instance.routeHandles[index],
  }))) });
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: SOURCE, readyGraph: graph.edges,
    readyInstances: instances, readyFundingAssets: [] });
  if (prefixRead) for (const adapter of [...PRODUCTION_INFRA_ACTION_ADAPTERS, ...baseV2Plugin.actionAdapters]) {
    if (!actionRegistry.listAll().some(existing => existing.id === adapter.id)) actionRegistry.register(adapter);
  }
  const session = await root.createSession({ source: SOURCE, kind: "exact", fundingAssets: [],
    runtime: createStrictCentralAdapterRuntime({ executor: EXECUTOR, exactQuoteCache: createAdapterFamilyExactQuoteCache(),
      ...(prefixRead === undefined ? {} : { transactionOrigin: address(10), simulator: {
        simulate() { throw new Error("mixed reads must use the prefix transport"); }, simulatePrefix: prefixRead,
      } }),
      generationFence: { assertCurrent(generation, source) {
      assert.deepEqual({ ...source, generation }, SOURCE);
    } }, provider: {
      async getCode() { throw new Error("unexpected fixture code read"); },
      async getStorage() { throw new Error("unexpected fixture storage read"); },
      async call(request, block) {
        assert.equal(block, SOURCE.number); calls.push({ to: request.to.toLowerCase(), data: request.data });
        const selector = request.data.slice(0, 10);
        if (selector === UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector) {
          return UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [RESERVE0, RESERVE1, 1]);
        }
        if (selector === UNIV2_TOKEN_INTERFACE.getFunction("balanceOf")!.selector) {
          return UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [request.to.toLowerCase() === TOKEN0 ? RESERVE0 : RESERVE1]);
        }
        const [amount, prefixLength] = QUOTE.decodeFunctionData("quote", request.data);
        // Synthetic transport response, not actual prefix execution evidence.
        return QUOTE.encodeFunctionResult("quote", [amount / 2n + prefixLength]);
      },
    } }),
  });
  calls.length = 0; semanticInputs.length = 0;
  function edge(pool: string, forward: boolean) {
    const result = session.edges.find(e => e.instanceKey === pool && e.tokenIn.toLowerCase() === (forward ? TOKEN0 : TOKEN1));
    assert(result); return result;
  }
  type Handle = Awaited<ReturnType<typeof session.issueExact>>;
  async function quote(pool: string, forward: boolean, amountIn: bigint, priorQuotes: readonly Handle[] = []) {
    const quoted = await session.issueExact({ edge: edge(pool, forward), amountIn, executor: EXECUTOR, runtimeEvidence: [], priorQuotes });
    assert("amountIn" in quoted); return quoted;
  }
  return { session, edge, quote, calls, semanticInputs };
}

const v2 = (reserveIn: bigint, reserveOut: bigint, amount: bigint) =>
  amount * 9970n * reserveOut / (reserveIn * 10000n + amount * 9970n);

test("local pool A → pool B → A → B advances both states and isolates each amount trial", async () => {
  const f = await fixture(new Map());
  async function run(amount: bigint) {
    const first = await f.quote(LOCAL, true, amount);
    const middle = await f.quote(MIDDLE, false, first.amountOut, [first]);
    assert.equal(middle.amountOut, v2(RESERVE1, RESERVE0, first.amountOut));
    const readsBeforeLast = f.calls.length;
    const last = await f.quote(LOCAL, true, middle.amountOut, [first, middle]);
    assert.equal(f.calls.length, readsBeforeLast, "revisiting a local pool uses current trial state without another read");
    assert.equal(last.amountOut, v2(RESERVE0 + amount, RESERVE1 - first.amountOut, middle.amountOut));
    assert.notEqual(last.amountOut, v2(RESERVE0, RESERVE1, middle.amountOut));
    const fourth = await f.quote(MIDDLE, false, last.amountOut, [first, middle, last]);
    assert.equal(fourth.amountOut, v2(RESERVE1 + middle.amountIn, RESERVE0 - middle.amountOut, last.amountOut));
    assert.equal(f.calls.length, readsBeforeLast);
    const execution = { edge: f.edge(LOCAL, true), exact: last, minAmountOut: last.amountOut, executor: EXECUTOR };
    assert.throws(() => f.session.buildExecution(execution), /original sequential quote prefix/);
    assert.equal(f.session.buildExecution({ ...execution, priorQuotes: [first, middle] }).status, "resolved");
    await assert.rejects(f.quote(LOCAL, true, middle.amountOut, [middle]), /same-session|ordering/,
      "a local quote retains the original route prefix in its issued authority");
    return [first.amountOut, middle.amountOut, last.amountOut, fourth.amountOut];
  }
  const first = await run(1_000_000n), second = await run(4_000_000n);
  assert.notDeepEqual(first, second); assert.deepEqual(await run(1_000_000n), first);
});

test("ordinary chain quote cannot consume an existing trial or produce local poststate", async () => {
  const f = await fixture(new Map([[MIDDLE, { kind: "chain" }]]));
  const local = await f.quote(LOCAL, true, 1_000_000n), before = f.calls.length;
  await assert.rejects(f.quote(MIDDLE, false, local.amountOut, [local]), /sequential-prefix-unsupported/);
  assert.equal(f.calls.length, before, "a different pool address is not a trial-state consumption capability");
  const chainFirst = await f.quote(MIDDLE, true, 1_000_000n), afterChain = f.calls.length;
  await assert.rejects(f.quote(LOCAL, false, chainFirst.amountOut, [chainFirst]), /sequential-prefix-unsupported/,
    "a source amount result cannot manufacture an advanced local snapshot");
  assert.equal(f.calls.length, afterChain);
});

test("chain and local-model dual declaration fails before any amount quote transport", async () => {
  const f = await fixture(new Map([[MIDDLE, { kind: "invalid-dual" }]]));
  const before = f.calls.length;
  await assert.rejects(f.quote(MIDDLE, true, 1_000_000n), /exact.*(declare|model)|exact-declaration-invalid/);
  assert.equal(f.calls.length, before);
});

test("synthetic sequentialPrefix declaration retains full authority but cannot issue local poststate", async () => {
  const f = await fixture(new Map([
    [MIDDLE, { kind: "chain" }], [PREFIX, { kind: "sequential-fixture" }],
  ]));
  for (const start of [LOCAL, MIDDLE]) {
    const first = await f.quote(start, true, 1_000_000n);
    const prefixed = await f.quote(PREFIX, false, first.amountOut, [first]);
    assert.equal(prefixed.amountOut, first.amountOut / 2n + 1n, "fixture received one prefix step; this is not EVM replay evidence");
    const execution = { edge: f.edge(PREFIX, false), exact: prefixed, minAmountOut: prefixed.amountOut, executor: EXECUTOR };
    assert.throws(() => f.session.buildExecution(execution), /original sequential quote prefix/);
    assert.equal(f.session.buildExecution({ ...execution, priorQuotes: [first] }).status, "resolved");
    const before = f.calls.length;
    await assert.rejects(f.quote(LOCAL, true, prefixed.amountOut, [first, prefixed]), /sequential-prefix-unsupported/);
    assert.equal(f.calls.length, before, "an amount-only prefix result cannot claim current local state");
  }
  const captured = f.semanticInputs.filter(i => i.pool === PREFIX);
  assert(captured.length > 0); assert(captured.every(i => i.prefixLength === 1));
});

test("cache reuse preserves the chain method's lack of local poststate", async () => {
  const f = await fixture(new Map([[MIDDLE, { kind: "chain" }]]));
  const fresh = await f.quote(MIDDLE, true, 1_000_000n);
  assert.equal(fresh.outcome.reasonCode, "request-exact-derived");
  const readsAfterFresh = f.calls.length;
  const cached = await f.quote(MIDDLE, true, 1_000_000n);
  assert.equal(cached.outcome.reasonCode, "exact-cache-reused");
  assert.equal(cached.amountOut, fresh.amountOut); assert.equal(f.calls.length, readsAfterFresh);
  for (const first of [fresh, cached]) {
    await assert.rejects(f.quote(LOCAL, false, first.amountOut, [first]), /sequential-prefix-unsupported/);
    assert.equal(f.calls.length, readsAfterFresh, "cached evidence cannot manufacture a local trial snapshot");
  }
});

test("V2 unavailable zero output stays a quote but cannot issue or launder local poststate", async () => {
  const f = await fixture(new Map(), new Set([PREFIX]));
  // Real V2 capacity math rejects input that exceeds uint112 reserve space.
  const unavailable = await f.quote(LOCAL, true, 1n << 112n);
  assert.equal(unavailable.amountIn, 1n << 112n); assert.equal(unavailable.amountOut, 0n);
  const before = f.calls.length;
  await assert.rejects(f.quote(PREFIX, false, 0n, [unavailable]), /sequential-prefix-unsupported/,
    "an unavailable amount quote has no modeled execution poststate");
  const zeroIdentity = await f.quote(MIDDLE, false, 0n, [unavailable]);
  assert.equal(zeroIdentity.amountOut, 0n, "zero-input identity semantics remain available");
  await assert.rejects(f.quote(PREFIX, true, 0n, [unavailable, zeroIdentity]), /sequential-prefix-unsupported/,
    "a zero no-op must preserve an unknown snapshot, not replace it with an empty one");
  assert.equal(f.calls.length, before, "continuations cannot reread source state to invent poststate");
});

test("common prefix view handles local → ordinary chain → local without Family prefix handling or source cache", async () => {
  const reads: ExactPrefixReadInput[] = [];
  const subscript = new ethers.Interface(["function execSubscript(bytes)"]);
  const f = await fixture(new Map([[MIDDLE, { kind: "prefix-rejecting-chain" }]]), new Set(), async input => {
    reads.push(input);
    assert.deepEqual(input.source, SOURCE);
    assert.equal(input.prefix.executor, EXECUTOR);
    assert.equal(input.callerAuthority.transactionOrigin, address(10));
    assert.equal(input.prefix.inputToken, TOKEN0);
    const script = ethers.getBytes(subscript.decodeFunctionData("execSubscript", input.prefix.calldata)[0]);
    assert.equal(script[0], 9); assert.equal(script[36], 0, "prefix execution measures exact deltas");
    const count = script[37]; assert(count === 1 || count === 2);
    const request = input.request; assert.equal(request.kind, "eth-call");
    if (request.kind !== "eth-call") throw new Error("unexpected state read");
    let data: string;
    if (request.to.toLowerCase() === MIDDLE) {
      const [amount, familyPrefix] = QUOTE.decodeFunctionData("quote", request.data);
      assert.equal(familyPrefix, 0n, "Family receives its own leg only; framework owns the prefix");
      data = QUOTE.encodeFunctionResult("quote", [amount / 2n]);
    } else {
      assert.equal(count, 2, "local reads include the actual chain step");
      const r0 = RESERVE0 + input.prefix.inputAmount + 12345n;
      const r1 = RESERVE1 - v2(RESERVE0, RESERVE1, input.prefix.inputAmount) - 67890n;
      data = request.data.startsWith(UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector)
        ? UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [r0, r1, 1])
        : UNIV2_TOKEN_INTERFACE.encodeFunctionResult("balanceOf", [request.to.toLowerCase() === TOKEN0 ? r0 : r1]);
    }
    return { data, completion: "returned" };
  });
  async function run(amount: bigint) {
    const first = await f.quote(LOCAL, true, amount), baselineReads = f.calls.length;
    const middle = await f.quote(MIDDLE, false, first.amountOut, [first]);
    const last = await f.quote(LOCAL, true, middle.amountOut, [first, middle]);
    assert.equal(f.calls.length, baselineReads, "EVM-bound rounds never fall back to source reads");
    assert.equal(last.amountOut, v2(RESERVE0 + amount + 12345n, RESERVE1 - first.amountOut - 67890n, middle.amountOut));
    assert.notEqual(last.amountOut, v2(RESERVE0 + amount, RESERVE1 - first.amountOut, middle.amountOut));
    assert.equal(f.session.buildExecution({ edge: f.edge(LOCAL, true), exact: last,
      minAmountOut: last.amountOut, executor: EXECUTOR, priorQuotes: [first, middle] }).status, "resolved");
    return last.amountOut;
  }
  const first = await run(1000000n), second = await run(4000000n);
  assert.notEqual(first, second); assert.equal(await run(1000000n), first);
  assert(reads.length > 3);
});

test("common prefix replay failure is not a chain quote result or a source fallback", async () => {
  const f = await fixture(new Map([[MIDDLE, { kind: "chain" }]]), new Set(), async () => {
    throw new Error("prefix execution rejected");
  });
  const first = await f.quote(LOCAL, true, 1000000n), before = f.calls.length;
  await assert.rejects(f.quote(MIDDLE, false, first.amountOut, [first]));
  assert.equal(f.calls.length, before);
});
