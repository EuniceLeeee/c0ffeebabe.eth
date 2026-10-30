import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createDeclarativeSwapRuntime } from "../venues/declarative-swap.js";
import { createDeclarativeProtocolRuntime } from "../venues/declarative-protocol.js";
import { PRODUCTION_INFRA_ACTION_ADAPTERS } from "../venues/production-infra-actions.js";
import { concatBytes } from "../../encoder.js";
import { planFragmentNodes } from "../solver/plan-fragment-requirements.js";
import { loadSwapJsonSamples } from "./swap-json-samples.js";
import { createStrictCentralAdapterRuntime } from "../strict-central-adapter-runtime.js";
import { executeAdapterFamilyLifecycleBatch } from "../venues/adapter-family-runtime.js";
import { capabilityManifestHash, FAMILY_CAPABILITY_NAMES, FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { defineProtocolFamily, defineSwapFamily, definedFamilyPluginContractSummary } from "../venues/adapter-family-plugin.js";

// This is a common field-contract runner. New Families/variants add JSON only.
// Recorded reads and synthetic observations test compiler field wiring, never
// replace current strict Ready, actual EVM execution, opportunity or latency evidence.
const FORMAT = "declarative-family-fields-v1";
const fixtureDirectory = fileURLToPath(new URL("./fixtures/swap-json/", import.meta.url));
const listenerDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
const library = loadSwapJsonSamples();
const enabled = new Set<string>(library.index.scopeReference.familyIds);
const safeFile = (root: string, name: string) => {
  assert(typeof name === "string" && name.length > 0 && !isAbsolute(name));
  const file = realpathSync(resolve(root, name)), rel = relative(realpathSync(root), file);
  assert(!rel.startsWith("..") && !isAbsolute(rel), "fixture reference escaped its source directory");
  return file;
};
function typed(value: any): any {
  if (Array.isArray(value)) return value.map(typed);
  if (value && typeof value === "object") {
    if (value.$type === "bigint") {
      assert.deepEqual(Object.keys(value).sort(), ["$type", "value"]);
      assert(typeof value.value === "string" && /^-?(0|[1-9][0-9]*)$/.test(value.value));
      return BigInt(value.value);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typed(item)]));
  }
  return value;
}
function normalized(value: any): any {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalized);
  if (value instanceof Map) return [...value].map(([key, item]) => [key, normalized(item)]);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalized(item)]));
  return value;
}
function checks(actual: any, assertions: any[], label: string) {
  assert(Array.isArray(assertions) && assertions.length > 0, `${label}: explicit field expectations required`);
  for (const assertion of assertions) {
    assert(Array.isArray(assertion.path) && Object.hasOwn(assertion, "equals"));
    let value = actual;
    for (const key of assertion.path) {
      assert(value !== null && value !== undefined && Object.hasOwn(value, key), `${label}: missing ${assertion.path.join(".")}`);
      value = value[key];
    }
    assert.deepEqual(normalized(value), normalized(typed(assertion.equals)), `${label}:${assertion.path.join(".")}`);
  }
}
function selectRoute(routes: any[], selector: any) {
  assert(selector && typeof selector === "object" && !Array.isArray(selector) && Object.keys(selector).length > 0);
  const matches = routes.filter(route => Object.entries(selector).every(([key, value]) =>
    isDeepStrictEqual(normalized(route[key]), normalized(typed(value)))));
  assert.equal(matches.length, 1, "fixture must select exactly one naturally projected route");
  return matches[0];
}
function fixtureHarness(path: string) {
  const fixture = read(path); assert.equal(fixture.format, FORMAT);
  assert.equal(fixture.domain, library.index.domain); assert(enabled.has(fixture.familyId), "out-of-scope Family fixture");
  assert.equal(fixture.coverage, "all-projected-routes", "partial cases must not claim the complete fields contract");
  assert(/^src\/searcher\/venues\/.+\.json$/.test(fixture.definition), "definition must be venue JSON");
  const definitionPath = safeFile(listenerDirectory, fixture.definition), definition = read(definitionPath);
  const children = definition.variantFiles.map((name: string) => read(safeFile(dirname(definitionPath), name)));
  const runtime = fixture.domain === "swap" ? createDeclarativeSwapRuntime(definition, children)
    : createDeclarativeProtocolRuntime(definition, children);
  const family: any = runtime.definition;
  assert.equal(family.manifest.familyId, fixture.familyId); assert.equal(family.manifest.domain, fixture.domain);
  const responsePath = safeFile(fixtureDirectory, fixture.recorded.file), bytes = readFileSync(responsePath);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fixture.recorded.sha256, "recorded response source changed");
  const recorded = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(recorded.source, fixture.source, "recorded reads must share the tested historical state");
  const answer = (request: any, overrides: any[] = []) => {
    const matches = recorded.responses.entries
      ? recorded.responses.entries.filter((entry: any) => isDeepStrictEqual(normalized(typed(entry.request)), normalized(request)))
      : request.kind === "get-code"
        ? recorded.responses.code.filter((entry: any) => entry.address.toLowerCase() === request.address.toLowerCase())
        : request.kind === "eth-call" && (request.caller === undefined || request.caller.kind === "none")
          ? recorded.responses.calls.filter((entry: any) => entry.to.toLowerCase() === request.to.toLowerCase() && entry.data.toLowerCase() === request.data.toLowerCase()) : [];
    assert.equal(matches.length, 1, `no unique recorded complete request: ${request.kind}/${request.id}`);
    const saved = matches[0], result = typeof saved.result === "object" ? typed(saved.result)
      : { data: saved.result, ok: true, completion: "returned", source: fixture.source,
        provenance: { kind: "recorded-read-contract-fixture", fingerprint: fixture.recorded.sha256 } };
    const changes = overrides.filter(row => row.requestId === request.id); assert(changes.length <= 1);
    return { id: request.id, ...result, ...(changes.length ? typed(changes[0].result) : {}) };
  };
  function identity(overrides: any[] = []) {
    const variant = family.identity.variants.find((variant: any) => variant.id === fixture.identity.variantId);
    assert(variant && variant.applies(fixture.candidate), "declared identity variant must apply to the candidate");
    const rounds: string[][] = []; let evidence: unknown;
    for (let step = 0; step <= 128; step++) {
      const input = { candidate: fixture.candidate, step, evidence }, decision = variant.decide(input);
      if (decision.status !== "continue") return { decision, rounds };
      const requests = variant.buildRequests(input); rounds.push(requests.map((request: any) => request.id));
      evidence = variant.decode({ step: input, results: requests.map((request: any) => answer(request, overrides)) });
    }
    throw new Error("identity fixture exceeded bounded step count");
  }
  const verified = identity(); assert.equal(verified.decision.status, "verified");
  assert.deepEqual(verified.rounds, fixture.identity.requestRounds);
  const identityValue = verified.decision.identity, draft = family.instance.compileDraft(identityValue);
  const instanceRequests = family.instance.staticEvidence?.buildRequests(draft) ?? [];
  assert.deepEqual(instanceRequests.map((request: any) => request.id), fixture.instance.staticRequestIds);
  const staticEvidence = family.instance.staticEvidence?.decode({ programInput: draft, results: instanceRequests.map((request: any) => answer(request)) });
  const sharedBindings = typed(fixture.sharedBindings ?? []);
  const descriptor = family.instance.finalizeDescriptor({ identity: identityValue, draft, staticEvidence, sharedBindings });
  const routes = family.routes.project({ descriptor });
  assert(routes.length > 0);
  return { fixture, recorded, runtime, family, descriptor, routes, answer, identity, sharedBindings };
}
function completeProgram(program: any, input: any, answer: (request: any) => any) {
  const initial = program.buildRequests(input), initialResults = initial.map(answer), dependentEvidence: unknown[] = [];
  const rounds = [initial.map((request: any) => request.id)];
  for (let completedRound = 0; completedRound <= 128; completedRound++) {
    const bound = program.buildDependentProgram?.({ programInput: input, initialResults, priorEvidence: dependentEvidence, completedRound });
    if (!bound) return { rounds, result: program.decode({ programInput: input, initialResults, dependentEvidence }) };
    rounds.push(bound.requests.map((request: any) => request.id)); dependentEvidence.push(bound.decode(bound.requests.map(answer)));
  }
  throw new Error("request fixture exceeded bounded dependent rounds");
}

const declarations = readdirSync(fixtureDirectory).filter(name => name.endsWith("-fields.json")).sort().map(name => ({ name, document: read(resolve(fixtureDirectory, name)) }));
const generic = declarations.filter(row => row.document.format === FORMAT);
test("field fixtures are discovered automatically inside the frozen enabled-Family scope", () => {
  assert(generic.length > 0, "no generic field fixture discovered");
  for (const row of declarations) {
    assert(enabled.has(row.document.familyId), `${row.name}: field fixture outside enabled app-run2 scope`);
    assert(row.document.format === undefined || row.document.format === FORMAT, `${row.name}: unknown field fixture format`);
  }
});
for (const row of declarations.filter(row => row.document.format === undefined))
  test(`${row.name}: legacy-specific reference is not generic fields acceptance`, { skip: "Retained by its existing reference regression; no generic-format claim." }, () => {});

for (const { name } of generic) {
  const open = () => fixtureHarness(resolve(fixtureDirectory, name));
  test(`${name}: production lifecycle publishes recorded instances, routes and prices`, async () => {
    const h = open(), f = h.fixture;
    const selected = f.domain === "swap" ? defineSwapFamily(h.family) : defineProtocolFamily(h.family);
    const entries = FAMILY_CAPABILITY_NAMES.map(capability => ({ familyId: selected.manifest.familyId, capability,
      contractVersion: "recorded-family-lifecycle", contentHash: createHash("sha256").update(`fixture:${capability}`).digest("hex"),
      semanticDependencies: [`contract:${capability}`], provenanceCommit: null }));
    const catalog = new FamilyCapabilityCatalog({ modules: [{ plugin: selected, sourceFile: "fixture/declarative-family.production.ts",
      definitionBoundaryHash: definedFamilyPluginContractSummary(selected).definitionBoundaryHash }],
      generatedManifest: { format: "adapter-family-capabilities-v1", entries, manifestHash: capabilityManifestHash(entries) } });
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const reads: string[] = [];
    function recordedRead(kind: string, fields: Record<string, any>, block: number): string {
      assert.equal(block, f.source.number, "lifecycle reads must retain the fixture's historical state");
      reads.push(kind);
      const saved = h.recorded.responses.entries
        ? h.recorded.responses.entries.filter((row: any) => row.request.kind === kind &&
          Object.entries(fields).every(([key, value]) => same(row.request[key], value)))
        : kind === "get-code" ? h.recorded.responses.code.filter((row: any) => same(row.address, fields.address))
        : kind === "eth-call" ? h.recorded.responses.calls.filter((row: any) => same(row.to, fields.to) && same(row.data, fields.data)) : [];
      assert.equal(saved.length, 1, `lifecycle has no unique recorded ${kind} response`);
      const result = saved[0].result;
      if (typeof result === "string") return result;
      assert.equal(result.ok, true); assert.equal(result.completion, "returned"); assert.deepEqual(result.source, f.source);
      return result.data;
    }
    const runtime = createStrictCentralAdapterRuntime({ executor: f.executor,
      ...(f.transactionOrigin === undefined ? {} : { transactionOrigin: f.transactionOrigin }),
      ...(f.verifiedActors === undefined ? {} : { verifiedActors: f.verifiedActors }),
      generationFence: { assertCurrent(generation, source) { assert.equal(generation, f.source.generation); assert.deepEqual(source, f.source); } },
      provider: {
        async getCode(address, block) { return recordedRead("get-code", { address }, block); },
        async getStorage(address, slot, block) { return recordedRead("get-storage", { address, slot }, block); },
        async call(request, block) {
          // Legacy response archives contain callerless reads only. A new
          // caller-dependent sample must preserve its complete request data.
          assert(request.from === undefined, "caller-dependent reads require a complete transport fixture");
          return recordedRead("eth-call", { to: request.to, data: request.data }, block);
        },
      },
      simulator: { async simulate({ request }) {
        const result = h.answer(request);
        assert.equal(result.ok, true); assert.equal(result.completion, "returned"); assert.deepEqual(result.source, f.source);
        return { data: result.data, ...(result.effects === undefined ? {} : { effects: result.effects }) };
      } },
    });
    const observations = f.discovery.filter((row: any) => row.expectedCandidate !== null)
      .map((row: any) => ({ ...typed(row.observation), source: f.source }));
    const matches = observations.flatMap((observation: any) => catalog.matches(observation)
      .filter(match => match.familyId === f.familyId).map(match => ({ matchedPatternId: match.patternId, observation })));
    assert(matches.length > 0, "production discovery must nominate the fixture instance");
    const publications: unknown[] = [];
    const result = await executeAdapterFamilyLifecycleBatch({ family: catalog.forFamily(selected.manifest.familyId), matches,
      source: f.source, generation: f.source.generation, runtime, publisher: { publish(publication) { publications.push(publication); } } });
    assert.equal(result.publication?.instances.length, 1, JSON.stringify(result.outcomes));
    assert.equal(publications.length, 1);
    const instance = result.publication!.instances[0]!;
    checks(instance.descriptor, f.instance.checks, "published instance");
    assert.equal(instance.routes.length, f.routes.length); assert.equal(instance.routeHandles.length, f.routes.length);
    for (const row of f.routes) checks(selectRoute([...instance.routes], row.select), row.checks, "published route");
    assert.equal(instance.pricingInstances.length, f.pricing.length);
    for (const row of f.pricing) {
      const state = instance.pricingInstances.find(state => state.stateKey === row.stateKey); assert(state, "missing published price state");
      checks(state.snapshot, row.snapshotChecks, "published snapshot"); assert.equal(state.mids.size, row.mids.length);
      for (const mid of row.mids) { assert(state.mids.has(mid.routeKey)); checks(state.mids.get(mid.routeKey), mid.checks, "published mid"); }
      assert.deepEqual([...state.unavailable], row.unavailable);
    }
    assert(result.outcomes.some(outcome => outcome.stage === "identity" && outcome.status === "verified"));
    assert(reads.length > 0, "lifecycle must execute recorded transport through the central runtime");
  });
  test(`${name}: declared discovery, source-bound identity and instance fields`, () => {
    const h = open(), f = h.fixture;
    assert(Array.isArray(f.discovery) && f.discovery.length > 0);
    for (const row of f.discovery) {
      const observation = { ...typed(row.observation), source: f.source };
      const actual = h.family.discovery.decodeCandidate({ observation, matchedPatternId: row.patternId });
      assert.deepEqual(normalized(actual), normalized(row.expectedCandidate));
    }
    checks(h.descriptor, f.instance.checks, "instance");
    checks(h.runtime.projection(h.descriptor), f.instance.bindingChecks, "binding");
    for (const rejection of f.identity.rejections ?? []) {
      if (rejection.throws !== undefined) assert.throws(() => h.identity(rejection.overrides), new RegExp(rejection.throws));
      else checks(h.identity(rejection.overrides).decision, rejection.checks, "identity rejection");
    }
  });
  test(`${name}: all route and graph projections come from declaration data`, () => {
    const h = open(), covered = new Set<string>();
    for (const row of h.fixture.routes) {
      const route = selectRoute(h.routes, row.select); assert(!covered.has(route.routeKey)); covered.add(route.routeKey);
      checks(route, row.checks, "route");
      checks(h.family.routes.projectGraph({ descriptor: h.descriptor, route }), row.graphChecks, "graph");
    }
    assert.equal(covered.size, h.routes.length, "unasserted projected route");
  });
  test(`${name}: recorded current-price request rounds and projections`, () => {
    const h = open(), groups = new Map<string, any[]>();
    for (const route of h.routes) { const key = h.family.pricing.stateKey(route); groups.set(key, [...(groups.get(key) ?? []), route]); }
    assert.equal(h.fixture.pricing.length, groups.size, "all pricing state groups require expectations");
    const covered = new Set<string>();
    for (const row of h.fixture.pricing) {
      const routes = groups.get(row.stateKey); assert(routes && !covered.has(row.stateKey)); covered.add(row.stateKey);
      const draft = h.family.pricing.compileDraft({ descriptor: h.descriptor, routes, stateKey: row.stateKey });
      const staticRequests = h.family.pricing.staticEvidence?.buildRequests(draft) ?? [];
      assert.deepEqual(staticRequests.map((request: any) => request.id), row.staticRequestIds);
      const staticEvidence = h.family.pricing.staticEvidence?.decode({ programInput: draft, results: staticRequests.map((request: any) => h.answer(request)) });
      const descriptor = h.family.pricing.finalizePricingDescriptor({ draft, staticEvidence, sharedBindings: h.sharedBindings });
      const current = { descriptor, routes, source: h.fixture.source }, pricing = h.family.pricing.current;
      const result = completeProgram({ buildRequests: (input: any) => pricing.buildRequests(input),
        buildDependentProgram: ({ programInput, ...input }: any) => pricing.buildDependentProgram?.({ ...input, current: programInput }) ?? null,
        decode: ({ programInput, ...input }: any) => pricing.decodeSnapshot({ descriptor: programInput.descriptor, ...input }),
      }, current, request => h.answer(request));
      assert.deepEqual(result.rounds, row.requestRounds); checks(result.result, row.snapshotChecks, "snapshot");
      const projected = { ...current, snapshot: result.result }, mids = pricing.deriveMids(projected);
      assert.equal(mids.size, row.mids.length);
      assert.equal(new Set(row.mids.map((mid: any) => mid.routeKey)).size, row.mids.length, "duplicate expected mid route");
      for (const mid of row.mids) { assert(mids.has(mid.routeKey)); checks(mids.get(mid.routeKey), mid.checks, "mid"); }
      assert.deepEqual([...(pricing.classifyUnavailable?.(projected) ?? new Map())], row.unavailable);
      assert.equal(h.family.pricing.refreshPolicyForInstance?.(current) ?? h.family.pricing.refreshPolicy ?? "on-touch", row.refreshPolicy);
      assert.deepEqual(normalized(h.family.pricing.dependencies(current)), normalized(row.dependencies));
    }
  });
  test(`${name}: specified amounts quote and construct quoted/runtime interfaces`, () => {
    const h = open(), covered = new Set<string>(), adapters = [...h.family.actionAdapters, ...PRODUCTION_INFRA_ACTION_ADAPTERS];
    const encode = (node: any): Uint8Array => {
      const adapter = adapters.find(adapter => adapter.id === node.adapterId); assert(adapter, `unowned action ${node.adapterId}`);
      return adapter.encode(node, h.fixture.executor, concatBytes(...node.children.map(encode)));
    };
    assert(Array.isArray(h.fixture.quotes) && h.fixture.quotes.length > 0);
    for (const row of h.fixture.quotes) {
      const route = selectRoute(h.routes, row.select), amountIn = BigInt(row.amountIn);
      const base: any = { descriptor: h.descriptor, route, source: h.fixture.source, executor: h.fixture.executor,
        runtimeEvidence: typed(row.runtimeEvidence ?? []), ...(h.fixture.transactionOrigin ? { transactionOrigin: h.fixture.transactionOrigin } : {}) };
      const input = { ...base, amountIn };
      if (row.throws === undefined) {
        // Runtime construction precedes even method selection, including the
        // first amount, so the fixture cannot supply a prior Exact result.
        for (const key of ["amountIn", "quotedAmountOut", "exactEvidence", "minAmountOut"])
          Object.defineProperty(base, key, { get() { throw new Error(`runtime construction read ${key}`); } });
        assert(["supported", "unsupported"].includes(row.runtime), "fixture must state runtime support truthfully");
        const leg = h.family.execution.buildRuntimeLeg?.(base) ?? null;
        if (row.runtime === "supported") {
          assert(leg && typeof leg.program === "string" && /^0x[0-9a-fA-F]+$/.test(leg.program));
          assert(h.family.manifest.ownedActionAdapterIds.includes(leg.actionAdapterId));
          checks(leg, row.runtimeChecks, "runtime");
        } else assert.equal(leg, null);
      }
      const method = h.family.exact.methods(input).find((method: any) => method.id === row.methodId);
      assert(method && method.kind === "request-program", "declared quote method not offered");
      if (row.throws !== undefined) {
        assert.throws(() => completeProgram(method.program, input, request => h.answer(request)), new RegExp(row.throws)); continue;
      }
      const exact = completeProgram(method.program, input, request => h.answer(request));
      assert.deepEqual(exact.rounds, row.requestRounds); assert.equal(exact.result.amountOut, BigInt(row.amountOut));
      const fragment = h.family.execution.buildFragment({ ...input, quotedAmountOut: exact.result.amountOut,
        minAmountOut: BigInt(row.minAmountOut), exactEvidence: exact.result.evidence });
      const nodes = planFragmentNodes(fragment, route.tokenIn, amountIn);
      assert(nodes.length > 0 && concatBytes(...nodes.map(encode)).length > 0, "quoted path did not encode an owned program");
      covered.add(route.routeKey);
    }
    assert.equal(covered.size, h.routes.length, "every admitted route needs a successful amount/build field case");
  });
}
