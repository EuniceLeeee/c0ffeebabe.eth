import assert from "node:assert/strict";
import { hashCanonical } from "../venues/canonical-value.js";
import { test } from "node:test";
import { ethers } from "ethers";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { createAdapterFamilyExactQuoteCache } from "../adapter-family-exact-quote-cache.js";
import { executeAdapterFamilyLifecycleBatch, executeFamilyExactQuote, buildFamilyExecutionFragment } from "../venues/adapter-family-runtime.js";
import { FamilyCapabilityCatalog, FAMILY_CAPABILITY_NAMES, capabilityManifestHash } from "../venues/family-capability-catalog.js";

import { plugin as angstromV4StrictFamilyPlugin } from "../venues/production-families/angstrom-v4.production.js";
import { definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";
import { blockScanMulticallIface } from "../venues/swaps/blockscan-state-shared.js";
import { ANGSTROM_CONTROLLER_INTERFACE, ANGSTROM_HOOK_STATE_INTERFACE, UNIV4_QUOTER_INTERFACE, UNIV4_STATE_VIEW_INTERFACE } from "../venues/swaps/univ4-abi.js";
import { ANGSTROM_MAINNET_HOOK } from "../venues/swaps/angstrom-attestation.js";
import sample from "./fixtures/adapter-families/angstrom-signed-tx85-call.json" with { type: "json" };

const SOURCE = sample.source;
const callObservation = { kind: "call" as const, source: SOURCE, data: sample.data, transactionHash: sample.transactionHash,
  target: sample.target, sender: sample.from };
const ANGSTROM_SWAP_CALL_PATTERN_ID = "angstrom-v4-adapter-swap-call";
const candidate = angstromV4StrictFamilyPlugin.discovery!.decodeCandidate({observation: callObservation,
  matchedPatternId: ANGSTROM_SWAP_CALL_PATTERN_ID}) as any;
assert(candidate);
const observed = angstromV4StrictFamilyPlugin.discovery!.runtimeEvidenceFromObservation!({observation:callObservation, source:SOURCE});
assert.equal(observed.length, 1);
const runtimeEvidence = observed[0]!;
const KEY = {currency0:candidate.currency0, currency1:candidate.currency1, fee:candidate.fee, tickSpacing:candidate.tickSpacing, hooks:candidate.hooks};
const EXECUTOR = "0x3000000000000000000000000000000000000033";
const CONTROLLER = "0x4000000000000000000000000000000000000044";
const VALIDATOR = "0x5000000000000000000000000000000000000055";
const Q96 = 1n << 96n;
const LIQUIDITY = 10n ** 20n;
const descriptor = { familyId:angstromV4StrictFamilyPlugin.manifest.familyId,
  lineageId:angstromV4StrictFamilyPlugin.manifest.supportedLineages[0], poolKey:KEY, poolId:candidate.poolId,
  instanceKey:runtimeEvidence.instanceKey!, provenance:[], runtimeRequirements:[],
  immutableBinding:{adapter:sample.target, manager:candidate.manager, hook:KEY.hooks, controller:CONTROLLER,
    quoter:"0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203" }};
const routes = angstromV4StrictFamilyPlugin.routes!.project({descriptor:descriptor as any});
const amountIn = 1000000n;
const amountOut = 900000n;
const exactInput = { descriptor:descriptor as any, route:routes[0]!, amountIn, source:SOURCE, executor:EXECUTOR, runtimeEvidence:[runtimeEvidence] };
const quoterReturn = UNIV4_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [amountOut,80000n]);

import type { AdapterRequestResult } from "../venues/adapter-request-program.js";
function unsignedMethod(input = { ...exactInput, runtimeEvidence: [] as typeof exactInput.runtimeEvidence }) {
  const method = angstromV4StrictFamilyPlugin.exact.methods(input)[1];
  assert.equal(method.kind, "request-program");
  if (method.kind !== "request-program") throw new Error("missing chain quote");
  return method;
}

test("Angstrom unsigned decode rejects locked, malformed, reverted, empty and foreign-source results", () => {
  const input = { ...exactInput, runtimeEvidence: [] };
  const method = unsignedMethod(input);
  const id = method.program.buildRequests(input)[0].id;
  const aggregate = (rows: { success: boolean; returnData: string }[]) =>
    success(id, blockScanMulticallIface.encodeFunctionResult("aggregate3", [rows]));
  const good = aggregate([{ success: true, returnData: quoterReturn }]);
  const bad: readonly AdapterRequestResult[][] = [
    [], [good, good],
    [aggregate([])], [aggregate([{ success: true, returnData: quoterReturn }, { success: true, returnData: quoterReturn }])],
    [aggregate([{ success: false, returnData: quoterReturn }])],
    ...["0x", "0x1234", UNIV4_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [0n, 1n]),
      UNIV4_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [1n << 128n, 1n])]
      .map(returnData => [aggregate([{ success: true, returnData }])]),
    [{ ...good, completion: "reverted-as-declared" }],
    [{ ...good, id: "foreign" }],
    [{ id, ok: false, source: SOURCE, failure: "rpc" }],
    ...[{ ...SOURCE, number: SOURCE.number + 1 }, { ...SOURCE, hash: ethers.ZeroHash },
      { ...SOURCE, generation: SOURCE.generation + 1 }].map(source => [{ ...good, source }]),
  ];
  for (const [index, initialResults] of bad.entries()) assert.throws(() => method.program.decode({
    programInput: input, initialResults, dependentEvidence: [],
  }), undefined, "rejected fixture index " + index);
});

test("Angstrom poisoned nonempty evidence cannot select or borrow the unsigned program", () => {
  const unsigned = { ...exactInput, runtimeEvidence: [] };
  const program = unsignedMethod(unsigned).program;
  const id = program.buildRequests(unsigned)[0].id;
  for (const runtimeEvidence of [
    [{ ...exactInput.runtimeEvidence[0], kind: "foreign" }],
    [{ ...exactInput.runtimeEvidence[0], source: { ...SOURCE, number: SOURCE.number - 1 } }],
    [{ ...exactInput.runtimeEvidence[0], sealedPayloadRef: "0x" }],
    [{ ...exactInput.runtimeEvidence[0], evidenceHash: ethers.ZeroHash }],
    [exactInput.runtimeEvidence[0], exactInput.runtimeEvidence[0]],
  ]) {
    const input = { ...exactInput, runtimeEvidence };
    assert.throws(() => angstromV4StrictFamilyPlugin.exact.methods(input));
    assert.throws(() => angstromV4StrictFamilyPlugin.exact.cacheCompatibilityProjection(input));
    assert.throws(() => program.buildRequests(input));
    assert.throws(() => program.decode({ programInput: input, dependentEvidence: [], initialResults: [success(id,
      blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{ success: true, returnData: quoterReturn }]]))] }));
  }
  assert.throws(() => unsignedMethod(exactInput).program.buildRequests(unsigned), /changed signed authority/,
    "a signed program cannot silently become unsigned either");
});

test("Angstrom unsigned cache binds mode, source, immutable bindings and executor", () => {
  const input = { ...exactInput, runtimeEvidence: [] };
  const fingerprint = (i: typeof input) => hashCanonical(angstromV4StrictFamilyPlugin.exact.cacheCompatibilityProjection(i));
  const base = fingerprint(input);
  assert.notEqual(base, hashCanonical(angstromV4StrictFamilyPlugin.exact.cacheCompatibilityProjection(exactInput)));
  for (const source of [{ ...SOURCE, number: SOURCE.number + 1 }, { ...SOURCE, hash: ethers.ZeroHash },
    { ...SOURCE, generation: SOURCE.generation + 1 }]) assert.notEqual(base, fingerprint({ ...input, source }));
  for (const field of ["managerCodeHash", "adapterCodeHash", "hookCodeHash"] as const) {
    const changed = { ...descriptor, immutableBinding: { ...descriptor.immutableBinding, [field]: ethers.ZeroHash } };
    assert.throws(() => fingerprint({ ...input, descriptor: changed }), /route binding/);
    const updatedRoute = angstromV4StrictFamilyPlugin.routes!.project({ descriptor: changed as any })[0]!;
    assert.notEqual(base, fingerprint({ ...input, descriptor: changed, route: updatedRoute }));
  }
  assert.notEqual(base, fingerprint({ ...input, executor: CONTROLLER }));
  assert.notEqual(base, fingerprint({ ...input, route: routes[1] }));
});

test("Angstrom local zero remains local, has no unsigned unlock authority, and signed zero stays compatible", () => {
  for (const runtimeEvidence of [[], exactInput.runtimeEvidence]) {
    const input = { ...exactInput, amountIn: 0n, runtimeEvidence };
    const methods = angstromV4StrictFamilyPlugin.exact.methods(input);
    const method = methods[0];
    assert.equal(method.kind, "local");
    if (method.kind !== "local") throw new Error("missing local zero");
    const attempt = method.quote(input);
    assert.equal(attempt.status, "quoted");
    if (attempt.status !== "quoted") throw new Error("missing zero quote");
    assert.equal(attempt.result.amountOut, 0n);
    assert.equal(attempt.result.evidence.kind, runtimeEvidence.length === 0
      ? "angstrom-v4-unsigned-local-zero" : "angstrom-v4-tx-bound-quoter");
    assert.deepEqual(unsignedMethod(input).program.buildRequests(input), []);
    assert.throws(() => angstromV4StrictFamilyPlugin.execution.buildFragment({
      descriptor, route: routes[0], amountIn: 0n, quotedAmountOut: 0n, minAmountOut: 0n,
      exactEvidence: attempt.result.evidence, executor: EXECUTOR, runtimeEvidence,
    }));
    assert.equal(method.quote({ ...input, amountIn: 1n }).status, "not-applicable");
  }
});

// Test-local catalog identities and mocked chain bytes exercise the existing
// issuer/lifecycle, not a production manifest or historical acceptance claim.
async function issuedAngstromFixture() {
  const plugin = angstromV4StrictFamilyPlugin;
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({
    familyId: plugin.manifest.familyId, capability, contractVersion: "s1-v1",
    contentHash: ethers.id(`angstrom-fixture:${capability}`).slice(2),
    semanticDependencies: [`contract:${capability}`], provenanceCommit: "a".repeat(40),
  }));
  const catalog = new FamilyCapabilityCatalog({
    modules: [{ sourceFile: "fixture/angstrom.production.ts", plugin,
      definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) },
  });
  const family = catalog.forFamily(plugin.manifest.familyId);
  const state = { source: SOURCE, quotes: 0, unlocked: true, afterQuote: () => {} };
  const cache = createAdapterFamilyExactQuoteCache({ capacity: 32 });
  const runtime = { ...createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: CONTROLLER,
    generationFence: { assertCurrent(g, s) { assert.equal(g, state.source.generation); assert.deepEqual(s, state.source); } },
    provider: {
      getCode: async (_address, block) => { assert.equal(block, state.source.number); return "0x6000"; },
      getStorage: async () => { throw new Error("unexpected storage read"); },
      call: async (request, block) => {
        assert.equal(block, state.source.number);
        const selector = request.data.slice(0, 10);
        for (const [abi, name, values] of [
          [UNIV4_STATE_VIEW_INTERFACE, "getSlot0", [Q96, 0, 0, 250]],
          [UNIV4_STATE_VIEW_INTERFACE, "getLiquidity", [LIQUIDITY]],
          [ANGSTROM_HOOK_STATE_INTERFACE, "extsload", [BigInt(CONTROLLER)]],
          [ANGSTROM_CONTROLLER_INTERFACE, "ANGSTROM", [ANGSTROM_MAINNET_HOOK]],
        ] as const) if (selector === abi.getFunction(name)!.selector) return abi.encodeFunctionResult(name, values);
        assert.equal(selector, blockScanMulticallIface.getFunction("aggregate3")!.selector);
        const calls = blockScanMulticallIface.decodeFunctionData("aggregate3", request.data)[0];
        assert.equal(calls.length, 1);
        assert.equal(calls[0].target, descriptor.immutableBinding.quoter);
        const params = UNIV4_QUOTER_INTERFACE.decodeFunctionData("quoteExactInputSingle", calls[0].callData)[0];
        assert.equal(params.poolKey.hooks, ANGSTROM_MAINNET_HOOK);
        state.quotes++;
        state.afterQuote();
        return blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{
          success: state.unlocked,
          returnData: state.unlocked ? UNIV4_QUOTER_INTERFACE.encodeFunctionResult("quoteExactInputSingle", [params.exactAmount - 1n, 90000n]) : "0x12345678",
        }]]);
      },
    },
  }), exactQuoteCache: cache };
  async function prepare(source = SOURCE) {
    state.source = source;
    const lifecycle = await executeAdapterFamilyLifecycleBatch({ family,
      matches: [{ observation: { ...callObservation, source }, matchedPatternId: ANGSTROM_SWAP_CALL_PATTERN_ID }],
      source, generation: source.generation, runtime, publisher: { publish: () => {} },
    });
    assert(lifecycle.publication, JSON.stringify(lifecycle.outcomes));
    assert.equal(lifecycle.publication.instances.length, 1);
    const route = lifecycle.publication.instances[0].routeHandles[0];
    assert(route);
    return { family, route, source, generation: source.generation, runtime,
      executor: EXECUTOR, runtimeEvidence: [], amountIn: 123457n, requireChainAmountQuote: true };
  }
  return { state, cache, catalog, prepare, input: await prepare() };
}

test("Angstrom actual issued Exact caches only identical source/mode/amount and produces the owning fragment", async () => {
  const f = await issuedAngstromFixture();
  const quote = await executeFamilyExactQuote(f.input);
  assert.equal(quote.status, "resolved");
  if (quote.status !== "resolved") throw new Error("missing issued quote");
  assert.equal(quote.amountIn, 123457n); assert.equal(quote.amountOut, 123456n);
  assert.equal(f.state.quotes, 1);
  assert.equal((await executeFamilyExactQuote(f.input)).status, "resolved");
  assert.equal(f.state.quotes, 1, "same source/input reuses issued work cache");
  const changed = await executeFamilyExactQuote({ ...f.input, amountIn: 1001n });
  assert.equal(changed.status, "resolved");
  assert(changed.status === "resolved"); assert.equal(changed.amountOut, 1000n);
  assert.equal(f.state.quotes, 2, "amount change must physically quote");
  const signed = await executeFamilyExactQuote({ ...f.input, runtimeEvidence: exactInput.runtimeEvidence });
  assert.equal(signed.status, "resolved"); assert.equal(f.state.quotes, 3, "signed mode cannot borrow unsigned bytes");
  const executionInput = { family: f.input.family, actionOwnership: f.catalog, route: f.input.route,
    exact: quote, minAmountOut: 120000n, executor: EXECUTOR, runtimeEvidence: [] };
  const execution = buildFamilyExecutionFragment(executionInput);
  assert.equal(execution.status, "resolved");
  assert(execution.status === "resolved");
  const program = execution.fragment.nodes[0].params.runtimeAmountProgram;
  assert.equal(typeof program, "string");
  const owningAdapter = angstromV4StrictFamilyPlugin.actionAdapters[0]!;
  assert(owningAdapter.encode(execution.fragment.nodes[0], EXECUTOR, new Uint8Array()).length > 24);
  assert(program.toLowerCase().includes(SOURCE.number.toString(16).padStart(64, "0")), "unsigned hook calldata binds B");
  assert.equal(buildFamilyExecutionFragment({ ...executionInput, exact: { ...quote } }).status, "failed", "copied handle is not authority");
  assert.equal(buildFamilyExecutionFragment({ ...executionInput, executor: VALIDATOR }).status, "failed");
  const before = f.state.quotes;
  assert.notEqual((await executeFamilyExactQuote({ ...f.input,
    source: { ...SOURCE, hash: ethers.ZeroHash } })).status, "resolved");
  assert.equal(f.state.quotes, before, "foreign source rejected before work");
  const next = await f.prepare({ ...SOURCE, number: SOURCE.number + 1, generation: SOURCE.generation + 1 });
  assert.equal((await executeFamilyExactQuote(next)).status, "resolved");
  assert.equal(f.state.quotes, before + 1, "B+1 needs its own hook-aware quote");
  assert.notEqual(buildFamilyExecutionFragment({ ...executionInput, route: next.route }).status,
    "resolved", "B quote cannot become authority for a B+1 route handle");
  const old = buildFamilyExecutionFragment(executionInput);
  assert(old.status === "resolved");
  assert.equal(old.fragment.nodes[0].params.runtimeAmountProgram, program, "old observed state still builds the same source-bound program");
  const reorg = await f.prepare({ ...next.source, hash: ethers.ZeroHash, generation: next.generation + 1 });
  assert.equal((await executeFamilyExactQuote(reorg)).status, "resolved");
  assert.equal(f.state.quotes, before + 2, "same-height reorg cannot reuse old hash's quote");
});

test("Angstrom issued work rejects poisoned evidence and controls before I/O, never caches failed hook results", async () => {
  const f = await issuedAngstromFixture();
  for (const poisonedEvidence of [[{ ...runtimeEvidence, evidenceHash: ethers.ZeroHash }],
    [{ ...runtimeEvidence, source: { ...SOURCE, number: SOURCE.number - 1 } }]]) {
    assert.notEqual((await executeFamilyExactQuote({ ...f.input, runtimeEvidence: poisonedEvidence })).status, "resolved");
  }
  const cancelled = new AbortController(); cancelled.abort();
  for (const control of [{ signal: cancelled.signal }, { deadlineAtMs: Date.now() - 1 }]) {
    assert.equal((await executeFamilyExactQuote({ ...f.input, control })).status, "unresolved");
  }
  assert.equal(f.state.quotes, 0);
  f.state.unlocked = false;
  assert.notEqual((await executeFamilyExactQuote(f.input)).status, "resolved");
  assert.notEqual((await executeFamilyExactQuote(f.input)).status, "resolved");
  assert.equal(f.state.quotes, 2); assert.equal(f.cache.snapshot().stores, 0);
  const during = new AbortController(); f.state.unlocked = true;
  f.state.afterQuote = () => during.abort();
  assert.equal((await executeFamilyExactQuote({ ...f.input, control: { signal: during.signal } })).status, "unresolved");
  assert.equal(f.cache.snapshot().stores, 0);
});

test("Angstrom unsigned declaration and execution preserve amount, binding and zero-only boundaries", () => {
  const input = { ...exactInput, runtimeEvidence: [] };
  const method = unsignedMethod(input);
  const quote = method.program.decode({ programInput: input, dependentEvidence: [], initialResults: [success(
    method.program.buildRequests(input)[0].id,
    blockScanMulticallIface.encodeFunctionResult("aggregate3", [[{ success: true, returnData: quoterReturn }]]),
  )] });
  for (const amountIn of [-1n, 1n << 128n]) {
    assert.throws(() => angstromV4StrictFamilyPlugin.exact.methods({ ...input, amountIn }));
    assert.throws(() => method.program.buildRequests({ ...input, amountIn }));
  }
  for (const change of [
    { executor: ethers.ZeroAddress }, { source: { ...SOURCE, number: -1 } },
    { source: { ...SOURCE, number: 1.5 } }, { source: { ...SOURCE, hash: "0x1234" } },
    { route: { ...routes[0], manager: EXECUTOR } },
    { route: { ...routes[0], tokenOut: EXECUTOR } },
  ]) assert.throws(() => angstromV4StrictFamilyPlugin.exact.methods({ ...input, ...change }));
  const execution = { descriptor, route: input.route, amountIn: input.amountIn, quotedAmountOut: quote.amountOut,
    minAmountOut: quote.amountOut, executor: EXECUTOR, runtimeEvidence: [], exactEvidence: quote.evidence };
  assert(quote.evidence.kind === "angstrom-v4-source-unlocked-quoter");
  for (const changed of [
    { ...execution, amountIn: input.amountIn + 1n },
    { ...execution, quotedAmountOut: quote.amountOut + 1n },
    { ...execution, executor: CONTROLLER },
    { ...execution, runtimeEvidence: exactInput.runtimeEvidence },
    { ...execution, descriptor: { ...descriptor, immutableBinding: { ...descriptor.immutableBinding, hookCodeHash: ethers.ZeroHash } } },
    { ...execution, exactEvidence: { ...quote.evidence, kind: "angstrom-v4-unsigned-local-zero" as const } },
  ]) assert.throws(() => angstromV4StrictFamilyPlugin.execution.buildFragment(changed));
});

test("Angstrom a source fence change during issued quote prevents output and cache publication", async () => {
  const f = await issuedAngstromFixture();
  f.state.afterQuote = () => { f.state.source = { ...SOURCE, generation: SOURCE.generation + 1 }; };
  assert.equal((await executeFamilyExactQuote(f.input)).status, "unresolved");
  assert.equal(f.state.quotes, 1);
  assert.equal(f.cache.snapshot().stores, 0);
});

function success(
  id: string,
  data: string,
): Extract<AdapterRequestResult, { readonly ok: true }> {
  return Object.freeze({
    id,
    ok: true as const,
    source: SOURCE,
    provenance: Object.freeze({ kind: "fixture", fingerprint: id }),
    completion: "returned" as const,
    data,
  });
}
