import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AbiCoder, Interface, getBytes, hexlify, toBeHex } from "ethers";
import { RuntimeAmountProgram, runtimeProgramScript, type RuntimeAmountLeg } from "../../adapters/runtime-amount-program.js";
import type { CentralAdapterRuntime } from "../adapter-work-intent.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { runStrictFamilyLifecycle } from "../strict-family-lifecycle-runner.js";
import { defineProtocolFamily, definedFamilyPluginContractSummary, explicitReverseBindingUnsupported } from "../venues/adapter-family-plugin.js";
import { familyId, lineageId } from "../venues/adapter-family-identifiers.js";
import { bindFamilyOwnedAction } from "../venues/family-owned-action.js";
import { FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog, capabilityManifestHash } from "../venues/family-capability-catalog.js";
import { hashCanonical } from "../venues/canonical-value.js";
import { acceptanceConstructionGuard, directQuoteReceiptProgram, selectAcceptanceRoute, runProtocolJsonAcceptance } from "./protocol-json-acceptance.js";
import { parseProtocolJsonAcceptanceCase } from "./protocol-json-acceptance-facts.js";
import { inspectRuntime } from "./runtime-program-testkit.js";

const address = (value: number) => toBeHex(value, 20);
const executor = address(101), owner = address(102), tokenIn = address(103), tokenOut = address(104), target = address(105);
const source = { number: 100, hash: toBeHex(100, 32), generation: 1 };
const sample = () => parseProtocolJsonAcceptanceCase({ version: 1, familyId: "protocol:fixture", lineageId: "fixture:standard",
  instanceKey: "fixture-instance", source: { number: source.number, hash: source.hash }, executor, owner,
  trials: [{ id: "forward", tokenIn, tokenOut, amountIn: "17" }] });

test("route selection disambiguates existing directions and rejects missing or conflicting bindings", () => {
  const routes = [{ routeKey: "a", tokenIn, tokenOut }, { routeKey: "b", tokenIn, tokenOut },
    { routeKey: "reverse", tokenIn: tokenOut, tokenOut: tokenIn }];
  assert.throws(() => selectAcceptanceRoute(routes, { tokenIn, tokenOut }), /naturally admitted/);
  assert.equal(selectAcceptanceRoute(routes, { tokenIn, tokenOut, routeKey: "b" }), routes[1]);
  assert.equal(selectAcceptanceRoute(routes.slice(0, 1), { tokenIn, tokenOut }), routes[0]);
  for (const routeKey of ["missing", "reverse"])
    assert.throws(() => selectAcceptanceRoute(routes, { tokenIn, tokenOut, routeKey }), /naturally admitted/);
  assert.throws(() => selectAcceptanceRoute([routes[0]!, routes[0]!], { tokenIn, tokenOut, routeKey: "a" }), /naturally admitted/);
});

test("construction exposes only caller/source authority and never obtains an I/O handle", () => {
  let ioReads = 0;
  const callerAuthority = Object.freeze({ executor }), generationFence = Object.freeze({ assertCurrent() {} });
  const runtime = { callerAuthority, generationFence, get scheduler() { ioReads++; return {}; } } as unknown as CentralAdapterRuntime;
  const guard = acceptanceConstructionGuard(runtime);
  assert.equal(guard.build(() => guard.runtime.callerAuthority), callerAuthority);
  assert.equal(guard.build(() => guard.runtime.generationFence), generationFence);
  assert.throws(() => guard.build(() => (guard.runtime as any).scheduler), /I\/O handle/);
  assert.throws(() => guard.build(() => guard.exact(() => 1)), /Exact\/quoted/);
  assert.throws(() => guard.build(() => guard.quoted(() => 1)), /Exact\/quoted/);
  assert.equal(ioReads, 0);
  assert.equal(guard.exact(() => 7), 7); assert.equal(guard.quoted(() => 8), 8);
  assert.deepEqual(guard.counts, { runtimeBuilds: 5, exact: 1, quoted: 1, forbiddenDuringRuntimeBuild: 3 });
});

test("retained construction handles cannot access I/O in a deferred microtask", async () => {
  let ioCalls = 0, delayed!: Promise<unknown>;
  const guard = acceptanceConstructionGuard({ executor() { ioCalls++; } } as unknown as CentralAdapterRuntime);
  guard.build(() => { delayed = Promise.resolve().then(() => (guard.runtime as any).executor()); return {}; });
  await assert.rejects(delayed, /I\/O handle/);
  assert.equal(ioCalls, 0); assert.equal(guard.counts.forbiddenDuringRuntimeBuild, 1);
});

test("construction rejects promises and thenables and restores the synchronous guard", () => {
  const guard = acceptanceConstructionGuard({} as CentralAdapterRuntime);
  for (const value of [Promise.resolve(1), { then() {} }])
    assert.throws(() => guard.build(() => value), /must be synchronous/);
  assert.equal(guard.build(() => 3), 3);
  assert.equal(guard.exact(() => 4), 4);
  assert.equal(guard.counts.runtimeBuilds, 3);
});

const abi = new Interface(["function balanceOf(address) view returns(uint256)",
  "function preview(uint256,address) view returns(uint256)", "function convert(uint256,address) returns(uint256)"]);
function receiptFixture(options: { credit?: bigint; returnValue?: bigint; quoteStatic?: boolean; recipient?: string } = {}) {
  const recipient = options.recipient ?? owner, events: string[] = [], observed: string[] = [];
  const quote = new RuntimeAmountProgram().constant(1, 999n)
    .call(target, abi.encodeFunctionData("preview", [0, recipient]), { static: options.quoteStatic ?? true, patches: [{ offset: 4, reg: 0 }] }).load(0, 0);
  const direct = new RuntimeAmountProgram().constant(1, 888n)
    .call(target, abi.encodeFunctionData("convert", [0, recipient]), { patches: [{ offset: 4, reg: 0 }] }).load(0, 0);
  const leg = (program: RuntimeAmountProgram) => ({ program: hexlify(program.bytes()) }) as RuntimeAmountLeg;
  const program = directQuoteReceiptProgram({ quote: leg(quote), direct: leg(direct), tokenOut, recipient });
  let balance = 109n;
  const run = () => inspectRuntime(hexlify(program.bytes()), 17n, { call(call) {
    const decoded = abi.parseTransaction({ data: call.data }); assert(decoded); events.push(decoded.name);
    if (decoded.name === "balanceOf") {
      assert.equal(call.target.toLowerCase(), tokenOut); assert.equal(call.static, true);
      observed.push(String(decoded.args[0]).toLowerCase());
      return abi.encodeFunctionResult("balanceOf", [balance]);
    }
    assert.equal(call.target.toLowerCase(), target); assert.equal(decoded.args[0], 17n);
    assert.equal(String(decoded.args[1]).toLowerCase(), recipient);
    if (decoded.name === "preview") return abi.encodeFunctionResult("preview", [34n]);
    balance += options.credit ?? 34n;
    return abi.encodeFunctionResult("convert", [options.returnValue ?? 34n]);
  } });
  return { run, events, observed, recipient };
}

test("direct quote checks independent receipt in the same recipient context and isolates child registers", () => {
  for (const recipient of [executor, owner]) {
    const fixture = receiptFixture({ recipient, returnValue: 999_999n }), inspected = fixture.run();
    assert.deepEqual(fixture.events, ["balanceOf", "preview", "convert", "balanceOf"]);
    assert.deepEqual(fixture.observed, [recipient, recipient]);
    assert.equal(inspected.registers[0], 17n); assert.equal(inspected.registers[1], 109n);
    assert.equal(inspected.registers[2], 34n); assert.equal(inspected.registers[3], 999_999n);
  }
});

test("direct receipt rejects short, excess, zero or negative credit despite a correct claimed return", () => {
  for (const credit of [33n, 35n, 0n, -1n])
    assert.throws(() => receiptFixture({ credit, returnValue: 34n }).run(), /runtime amount mismatch|checked uint256/);
});

test("quote child is actually readonly and cannot perform a mutating call", () => {
  const fixture = receiptFixture({ quoteStatic: false });
  assert.throws(fixture.run, /runtime readonly call/);
  assert.deepEqual(fixture.events, ["balanceOf"], "mutating quote must fail before the host sees it");
});

test("an empty direct invocation cannot claim acceptance from vacuous coverage", async () => {
  const input: any = { ...sample(), trials: [] };
  const context: any = { family: { plugin: { manifest: { familyId: input.familyId }, actionAdapters: [] } },
    instance: { descriptor: { lineageId: input.lineageId }, instanceKey: input.instanceKey, routes: [] },
    source, executor, owner, runtime: {}, catalog: {}, control: {}, graph: [], evidence: {} };
  const report: any = {};
  await assert.rejects(runProtocolJsonAcceptance(input, context, report), /trial|route|empty|case/i);
  assert.notEqual(report.result, "pass");
});

function cliFixture() {
  const directory = mkdtempSync(join(tmpdir(), "protocol-runner-test-"));
  const caseFile = join(directory, "case.json"), out = join(directory, "report.json"), guard = join(directory, "guard.cjs");
  writeFileSync(caseFile, JSON.stringify(sample()));
  writeFileSync(guard, 'require("node:net").Socket.prototype.connect = function () { throw new Error("FORBIDDEN_TEST_NETWORK"); }; globalThis.fetch = async () => { throw new Error("FORBIDDEN_TEST_NETWORK"); };\n');
  const cli = fileURLToPath(new URL("./protocol-json-acceptance.ts", import.meta.url));
  const run = (...args: string[]) => spawnSync(process.execPath,
    ["--require", guard, "--import", import.meta.resolve("tsx"), cli, "--case", caseFile, ...args],
    { encoding: "utf8", timeout: 20_000, env: { ...process.env, NODE_OPTIONS: "" } });
  const missing = ["--ready", join(directory, "missing-ready"), "--rpc-file", join(directory, "missing-rpc"),
    "--revm-bin", join(directory, "missing-revm"), "--out", out];
  return { directory, caseFile, out, run, missing, close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("CLI validate-only performs no execution and rejects empty cases or execution arguments", () => {
  const fixture = cliFixture();
  try {
    const good = fixture.run("--validate-only"); assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout), { result: "case-valid", familyId: sample().familyId, execution: "not-run" });
    const mixed = fixture.run("--validate-only", ...fixture.missing); assert.notEqual(mixed.status, 0);
    const empty = { ...sample(), trials: [] }; writeFileSync(fixture.caseFile, JSON.stringify(empty));
    const invalid = fixture.run("--validate-only"); assert.notEqual(invalid.status, 0);
    assert.doesNotMatch(good.stderr + mixed.stderr + invalid.stderr, /FORBIDDEN_TEST_NETWORK/);
  } finally { fixture.close(); }
});

test("CLI saves structured early failures with restrictive permissions and never overwrites evidence", () => {
  const fixture = cliFixture();
  try {
    const failed = fixture.run(...fixture.missing); assert.equal(failed.status, 1, failed.stderr);
    const first = readFileSync(fixture.out, "utf8"), report = JSON.parse(first);
    assert.equal(report.result, "failed"); assert.equal(report.failedStage, "inputs");
    assert.equal(report.signing, false); assert.equal(report.broadcast, false); assert.equal(report.drained, false);
    assert(report.evidence && typeof report.evidence === "object"); assert(report.errors.length > 0);
    assert.equal(statSync(fixture.out).mode & 0o777, 0o600);
    assert.doesNotMatch(first + failed.stdout + failed.stderr, /FORBIDDEN_TEST_NETWORK/);
    const second = fixture.run(...fixture.missing); assert.notEqual(second.status, 0);
    assert.equal(readFileSync(fixture.out, "utf8"), first);
  } finally { fixture.close(); }
});

// A generic, synthetic conversion fixture. The actual Family issuer, Graph,
// exact/quoted/runtime dispatch, scheduler and fact checker are exercised here.
// Only provider responses and VM host balances are synthetic, not EVM evidence.
async function issuedFixture(options: { fault?: "zero-debit" | "short-credit" | "old-inventory"; missingRuntime?: boolean; unsampledRoute?: boolean } = {}) {
  const input = sample(), family = familyId(input.familyId), lineage = lineageId(input.lineageId), actionId = "fixture-convert";
  const calls: string[] = [], simulations: string[] = [];
  const emit = () => new RuntimeAmountProgram().call(target, abi.encodeFunctionData("convert", [0n, executor]), { patches: [{ offset: 4, reg: 0 }] });
  const plugin = defineProtocolFamily<any, any, any, any, any, any, any>({
    manifest: { familyId: family, domain: "protocol", ownedActionAdapterIds: [actionId], requiredInfraActionAdapterIds: [],
      supportedLineages: [lineage], allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "convert" }] },
    discovery: { sources: ["observed-call"], evidenceChannel: "tx-evidence", reverseBinding: explicitReverseBindingUnsupported("synthetic fixture"),
      callPatterns: [{ id: "convert", selector: abi.getFunction("convert")!.selector as `0x${string}`, signature: "convert(uint256,address)", candidateAddress: { from: "call-target" } }],
      decodeCandidate: ({ observation }: any) => observation.kind === "call" ? { candidateKind: "observed-call", target: observation.target } : null,
      candidateKey: (candidate: any) => candidate.target },
    identity: { variants: [{ id: "fixture-proof", kind: "standalone-contract", lineageId: lineage, applies: () => true,
      requirements: () => ({ transports: ["eth-call"] }),
      buildRequests: ({ candidate }: any) => [{ id: "identity", kind: "eth-call", to: candidate.target,
        data: abi.encodeFunctionData("preview", [1n, executor]), completion: "return-data" }],
      decode: ({ results }: any) => { assert(results[0].ok); return BigInt(results[0].data); },
      decide: ({ candidate, evidence }: any) => evidence === undefined ? { status: "continue" } : evidence === 2n ? {
        status: "verified", identity: { familyId: family, lineageId: lineage, subject: candidate.target,
          provenance: [{ kind: "active-probe", subject: candidate.target }] } } : { status: "chain-proven-rejected", reasonCode: "fixture-proof", evidenceRequestIds: ["identity"] } }],
      identityKey: (identity: any) => identity.subject },
    instance: { instanceKey: () => input.instanceKey as never,
      compileDraft: (identity: any) => ({ familyId: family, lineageId: lineage, instanceKey: input.instanceKey,
        provenance: identity.provenance, runtimeRequirements: [], target: identity.subject }),
      finalizeDescriptor: ({ draft }: any) => draft, staticBindingProjection: (descriptor: any) => ({ target: descriptor.target }) },
    routes: { project: ({ descriptor }: any) => [false, ...(options.unsampledRoute ? [true] : [])].map(reverse => ({
      familyId: family, lineageId: lineage, instanceKey: descriptor.instanceKey, routeKey: `${descriptor.instanceKey}:${reverse ? "reverse" : "forward"}`,
      tokenIn: reverse ? tokenOut : tokenIn, tokenOut: reverse ? tokenIn : tokenOut,
      taxonomy: { slotKind: "protocol", protocolAction: "convert" }, runtimeRequirements: [],
      bindingRef: { bindingKey: descriptor.target, fingerprint: hashCanonical({ target: descriptor.target }) } })),
      projectGraph: ({ descriptor, route }: any) => ({ routeActionAdapterId: actionId, executionTarget: descriptor.target,
        venueIdentity: { pool: descriptor.target }, centralScoreKey: route.routeKey }) },
    pricing: { stateKey: (route: any) => route.instanceKey,
      staticBindingProjection: ({ descriptor }: any) => ({ target: descriptor.target }),
      snapshotCompatibilityProjection: ({ descriptor }: any) => ({ target: descriptor.target }),
      compileDraft: ({ descriptor }: any) => ({ target: descriptor.target }), finalizePricingDescriptor: ({ draft }: any) => draft,
      current: { requirements: () => ({ transports: [] }), buildRequests: () => [], decodeSnapshot: () => ({}),
        deriveMids: ({ routes }: any) => new Map(routes.map((route: any) => [route.routeKey,
          { kind: "protocol", pool: target, edges: [], mid: 2, feeBps: 0, depthProxy: 1 }])), classifyUnavailable: () => new Map() },
      dependencies: () => [target] },
    exact: { methods: () => [{ id: "fixture-exact", kind: "request-program", chainAmountQuote: true,
      program: { requirements: () => ({ transports: ["eth-call"] }),
        buildRequests: ({ amountIn }: any) => [{ id: "exact", kind: "eth-call", to: target,
          data: abi.encodeFunctionData("preview", [amountIn, executor]), completion: "return-data" }],
        decode: ({ initialResults }: any) => { assert(initialResults[0].ok); return { amountOut: BigInt(initialResults[0].data), evidence: {} }; } } }],
      cacheCompatibilityProjection: ({ route }: any) => ({ routeKey: route.routeKey }) },
    execution: { runtimeProjection: () => ({ allowanceSpender: null, prewarmQuoteCalls: [] }),
      buildRuntimeLeg: () => options.missingRuntime ? null : ({ actionAdapterId: actionId, program: hexlify(emit().bytes()) }),
      buildFragment: ({ route, amountIn }: any) => ({ requirements: [], nodes: [{ adapterId: actionId, target,
        tokenIn: route.tokenIn, tokenOut: route.tokenOut, amount: amountIn, params: {}, children: [] }] }),
      expectedEffects: () => [{ kind: "token-delta", token: tokenOut, account: "executor", direction: "increase" }] },
    protocol: { candidateKinds: ["observed-call"], activeBehaviorProof: "required" },
    actionAdapters: [bindFamilyOwnedAction({ action: { id: actionId, isWrapper: false, field2Offset: null, matchTrace: () => false,
      encode: node => runtimeProgramScript(emit().bytes(), node.amount) }, descriptor: { adapterId: actionId, lineage: `custom-protocol:${actionId}`,
      edgeKind: "protocol", action: "convert", canSendValue: false, leavesStandingPositionDefault: false } })],
  });
  const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: family, capability, contractVersion: "s1-v1" as const,
    contentHash: createHash("sha256").update(`fixture/${capability}`).digest("hex"), semanticDependencies: ["fixture:runner"], provenanceCommit: null }));
  const catalog = new FamilyCapabilityCatalog({ modules: [{ plugin, sourceFile: "fixture.production.ts",
    definitionBoundaryHash: definedFamilyPluginContractSummary(plugin).definitionBoundaryHash }],
    generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
  const runtime = createStrictCentralAdapterRuntime({ executor, transactionOrigin: owner,
    generationFence: { assertCurrent(generation, pinned) { assert.equal(generation, source.generation); assert.deepEqual(pinned, source); } },
    provider: { async getCode() { throw new Error("unexpected fixture getCode"); }, async getStorage() { throw new Error("unexpected fixture getStorage"); },
      async call(tx, block) { assert.equal(block ?? tx.blockTag, source.number); assert.equal(tx.to.toLowerCase(), target);
        const parsed = abi.parseTransaction(tx); assert.equal(parsed?.name, "preview"); calls.push(parsed.name);
        return abi.encodeFunctionResult("preview", [parsed.args[0] * 2n]); } },
    simulator: { executorProgramCodeHash: toBeHex(999, 32), async simulate({ request, source: pinned }) {
      assert.deepEqual(pinned, source); assert.equal(request.kind, "effect-delta-simulation");
      assert.equal(request.call.executionMode, "executor-program"); assert.equal(request.call.to.toLowerCase(), executor);
      simulations.push(request.id);
      const balances = new Map((request.overrideIntent?.tokenBalances ?? []).map(row => [row.token.toLowerCase(), row.amount]));
      const before = new Map(balances), script = getBytes(AbiCoder.defaultAbiCoder().decode(["bytes"], `0x${request.call.data.slice(10)}`)[0]);
      try {
        let cursor = 0;
        while (cursor < script.length) {
          assert.equal(script[cursor], 14); const amount = BigInt(hexlify(script.slice(cursor + 1, cursor + 33)));
          const size = script[cursor + 33]! * 65536 + script[cursor + 34]! * 256 + script[cursor + 35]!;
          const program = hexlify(script.slice(cursor + 36, cursor + 36 + size)); cursor += 36 + size;
          inspectRuntime(program, amount, { call(call) {
            const parsed = abi.parseTransaction(call); assert.equal(parsed?.name, "convert"); assert.equal(call.target.toLowerCase(), target);
            const amount = BigInt(parsed.args[0]); assert((balances.get(tokenIn) ?? 0n) >= amount, "fixture insufficient input");
            const debit = options.fault === "zero-debit" ? 0n : options.fault === "old-inventory" ? amount + 1n : amount;
            balances.set(tokenIn, balances.get(tokenIn)! - debit);
            balances.set(tokenOut, balances.get(tokenOut)! + amount * 2n - (options.fault === "short-credit" ? 1n : 0n));
            return abi.encodeFunctionResult("convert", [amount * 2n]);
          } }, { output: true });
        }
      } catch (error) { throw Object.assign(new Error(String(error)), { code: "CALL_EXCEPTION", data: "0x" }); }
      return { data: "0x", effects: { tokenDeltas: (request.observeTokenBalances ?? []).map(row => {
        assert(typeof row.account === "string");
        return { token: row.token, account: row.account,
          delta: row.account.toLowerCase() === executor ? (balances.get(row.token.toLowerCase()) ?? 0n) - (before.get(row.token.toLowerCase()) ?? 0n) : 0n };
      }),
        nativeDeltas: [{ account: executor, delta: 0n }], logs: [] } };
    } },
  });
  const publication = await runStrictFamilyLifecycle({ catalog, familyId: family, runtime, source,
    observations: [{ kind: "call", target, data: abi.encodeFunctionData("convert", [17n, executor]), source }] });
  assert.equal(publication.instances.length, 1); const instance = publication.instances[0]!, loaded = catalog.forFamily(family);
  const graph = buildFamilyRouteGraphView({ routes: instance.routes.map(route => ({ family: loaded, descriptor: instance.descriptor,
    route, handle: instance.routeHandles.find(handle => handle.routeKey === route.routeKey)! })) }).edges;
  return { sample: input, calls, simulations, context: { family: loaded, instance, source, executor, owner, runtime, catalog, graph,
    evidence: { kind: "synthetic-offline-fixture" }, control: { signal: new AbortController().signal, deadlineAtMs: Date.now() + 30_000 } } as any };
}

test("real issuer and central runtime feed quote and both encodings into independent effect checks", async () => {
  const fixture = await issuedFixture(), report: any = {};
  await runProtocolJsonAcceptance(fixture.sample, fixture.context, report);
  assert.equal(report.result, "pass", report.samples.map((row: any) => row.error ?? "").join("; "));
  assert.equal(fixture.simulations.length, 6); assert.equal(report.samples[0].executions.length, 6);
  assert.equal(report.coverage.scope, "one-admitted-instance");
  assert.equal(report.coverage.sampledRoutes, 1); assert.equal(report.coverage.executedRoutes, 1);
  assert.equal(report.coverage.domain, "protocol");
  assert.deepEqual(report.runtimeConstruction, { runtimeBuilds: 1, exact: 1, quoted: 1, forbiddenDuringRuntimeBuild: 0 });
  assert.deepEqual(report.samples[0].executions.map((row: any) => row.facts.classification),
    ["executed-as-quoted", "observed-revert", "observed-revert", "executed-as-quoted", "observed-revert", "observed-revert"]);
});

test("common runner retains effect failures and never promotes missing runtime or direction coverage", async () => {
  for (const options of [{ fault: "zero-debit" }, { fault: "short-credit" }, { fault: "old-inventory" }, { missingRuntime: true }, { unsampledRoute: true }] as const) {
    const fixture = await issuedFixture(options), report: any = {};
    await runProtocolJsonAcceptance(fixture.sample, fixture.context, report);
    assert.equal(report.result, "incomplete-or-failed", JSON.stringify(options));
    if ("missingRuntime" in options) { assert.equal(fixture.simulations.length, 0); assert.equal(report.runtimeConstruction.exact, 0); }
    if ("unsampledRoute" in options) { assert.equal(report.samples[0].result, "pass"); assert.equal(report.coverage.unsampledRoutes.length, 1); }
    if ("fault" in options) { assert.equal(report.samples[0].executions[0].facts.passed, false); assert(report.samples[0].error);
      assert.equal(report.coverage.sampledRoutes, 1); assert.equal(report.coverage.executedRoutes, 0); }
  }
});

test("case source, actor and identity must agree before execution; copying a handle does not forge issuer authority", async () => {
  const fixture = await issuedFixture();
  for (const context of [
    { ...fixture.context, source: { ...source, hash: toBeHex(999, 32) } },
    { ...fixture.context, executor: owner },
    { ...fixture.context, owner: executor },
    { ...fixture.context, family: { ...fixture.context.family, plugin: { ...fixture.context.family.plugin,
      manifest: { ...fixture.context.family.plugin.manifest, domain: "swap" } } } },
    { ...fixture.context, instance: { ...fixture.context.instance, instanceKey: "wrong-instance" } },
  ]) await assert.rejects(runProtocolJsonAcceptance(fixture.sample, context, {}));
  assert.equal(fixture.simulations.length, 0);
  const context = { ...fixture.context, instance: { ...fixture.context.instance,
    routeHandles: fixture.context.instance.routeHandles.map((handle: object) => ({ ...handle })) } };
  const report: any = {};
  await runProtocolJsonAcceptance(fixture.sample, context, report);
  assert.equal(report.result, "incomplete-or-failed"); assert.equal(fixture.simulations.length, 0);
  assert.match(report.samples[0].error, /issuer|issued|handle/i);
});
