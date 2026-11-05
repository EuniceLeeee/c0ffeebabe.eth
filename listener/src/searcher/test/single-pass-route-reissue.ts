import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Session } from "node:inspector";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import * as issuer from "../venues/adapter-family-runtime.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as catalog } from
  "../venues/production-family-composition.js";
import { runUniv2Lifecycle, UNIV2_FIXTURE_POOL, UNIV2_FIXTURE_FACTORY,
  UNIV2_FIXTURE_TOKEN0, UNIV2_FIXTURE_TOKEN1 } from "../architecture-migration-fixture-replay.js";
import { buildFamilyRouteGraphView } from "../adapter-family-graph-runtime.js";

let forbiddenNetworkAttempts = 0;
const forbidNetwork = (): never => { forbiddenNetworkAttempts++; throw new Error("offline reissue test forbids network"); };
globalThis.fetch = forbidNetwork;
net.Socket.prototype.connect = forbidNetwork;
for (const [target, names] of [[net, ["connect", "createConnection"]], [http, ["request", "get"]],
  [https, ["request", "get"]], [tls, ["connect"]]] as const) {
  for (const name of names) (target as unknown as Record<string, unknown>)[name] = forbidNetwork;
}
syncBuiltinESMExports();

const READY = Object.freeze({ number: 25_800_000, hash: `0x${"61".repeat(32)}`, generation: 1 });
const CURRENT = Object.freeze({ number: 25_800_007, hash: `0x${"62".repeat(32)}`, generation: 2 });
const EXECUTOR = `0x${"64".repeat(20)}`;
const pool = { pool: UNIV2_FIXTURE_POOL, factory: UNIV2_FIXTURE_FACTORY,
  token0: UNIV2_FIXTURE_TOKEN0, token1: UNIV2_FIXTURE_TOKEN1,
  reserves: { reserve0: 1_000_000_000n, reserve1: 2_000_000_000n, blockTimestampLast: 1 } };
const publication = await runUniv2Lifecycle(READY, pool);
const family = catalog.forFamily(publication.familyId), instance = publication.instances[0]!;
const args = { family, instance, source: CURRENT, generation: CURRENT.generation };
let negativeCases = 0;
function rejects(run: () => unknown, pattern?: RegExp) {
  assert.throws(run, pattern); negativeCases++;
}
for (const bad of [
  { ...instance, familyId: "foreign" },
  { ...instance, descriptor: { ...instance.descriptor, familyId: "foreign" } },
  { ...instance, instanceKey: "foreign" },
  { ...instance, descriptor: { ...instance.descriptor, instanceKey: "foreign" } },
  { ...instance, lineageId: "foreign" },
  { ...instance, descriptor: { ...instance.descriptor, lineageId: "foreign" } },
  { ...instance, descriptor: { ...instance.descriptor, lineageId: undefined } },
]) rejects(() => issuer.reissuePreparedInstanceRouteHandles({ ...args, instance: bad as never }), /escaped/);
rejects(() => issuer.reissuePreparedInstanceRouteHandles({ ...args, family: { ...family } as never }), /issued|Family/);
rejects(() => issuer.reissuePreparedInstanceRouteHandles({ ...args, family: catalog.forFamily("univ3-standard") }), /escaped/);
for (const invalid of [
  { source: { ...CURRENT, number: -1 }, generation: CURRENT.generation },
  { source: { ...CURRENT, hash: "0x12" }, generation: CURRENT.generation },
  { source: CURRENT, generation: CURRENT.generation + 1 },
]) rejects(() => issuer.reissuePreparedInstanceRouteHandles({ ...args, ...invalid }));

const one = issuer.reissuePreparedInstanceRouteHandles(args);
const two = issuer.reissuePreparedInstanceRouteHandles({ ...args,
  instance: issuer.reissuePreparedInstanceAuthority(args) });
assert.deepEqual(one.routeHandles, two.routeHandles);
assert.deepEqual(one.routes, two.routes);
assert.strictEqual(one.descriptor, instance.descriptor);
for (const owner of [one, two]) {
  issuer.assertIssuedPreparedFamilyInstance({ family, instance: owner, source: CURRENT, generation: CURRENT.generation });
  for (const pricing of owner.pricingInstances) issuer.assertIssuedPreparedFamilyPricingStateInstance({
    family, instance: owner, pricing, source: CURRENT, generation: CURRENT.generation });
}
assert.notStrictEqual(one, instance);
assert.notStrictEqual(one.pricingInstances[0], instance.pricingInstances[0]);
assert.notStrictEqual(one.pricingInstances[0], two.pricingInstances[0]);
issuer.assertIssuedPreparedFamilyInstance({ family, instance, source: READY, generation: READY.generation });
rejects(() => issuer.assertIssuedPreparedFamilyInstance({ family, instance, source: CURRENT, generation: CURRENT.generation }), /source/);
rejects(() => issuer.assertIssuedPreparedFamilyInstance({ family, instance: one, source: READY, generation: READY.generation }), /source/);
rejects(() => issuer.assertIssuedPreparedFamilyPricingStateInstance({ family, instance,
  pricing: one.pricingInstances[0]!, source: READY, generation: READY.generation }), /issuer-bound/);
rejects(() => issuer.assertIssuedPreparedFamilyPricingStateInstance({ family, instance: one,
  pricing: instance.pricingInstances[0]!, source: CURRENT, generation: CURRENT.generation }), /issuer-bound/);
rejects(() => issuer.assertIssuedPreparedFamilyPricingStateInstance({ family, instance: one,
  pricing: two.pricingInstances[0]!, source: CURRENT, generation: CURRENT.generation }), /issuer-bound/);
issuer.assertIssuedFamilyRouteRuntimeHandleAtSource({ family, handle: one.routeHandles[0]!, source: CURRENT, generation: CURRENT.generation });
rejects(() => issuer.assertIssuedFamilyRouteRuntimeHandleAtSource({ family, handle: instance.routeHandles[0]!, source: CURRENT, generation: CURRENT.generation }), /source/);
rejects(() => issuer.assertIssuedFamilyRouteRuntimeHandleAtSource({ family, handle: one.routeHandles[0]!, source: READY, generation: READY.generation }), /source/);
rejects(() => issuer.assertFamilyRouteRuntimeHandleBinding(family, one.routeHandles[0]!,
  { ...one.descriptor }, one.routes[0]!), /bound/);
rejects(() => issuer.assertFamilyRouteRuntimeHandleBinding(family, one.routeHandles[0]!,
  one.descriptor, { ...one.routes[0]! }), /bound/);
rejects(() => issuer.assertIssuedFamilyRouteRuntimeHandle({ ...family } as never, one.routeHandles[0]!), /Family/);

// An outer freeze never authorizes a mutable nested value. Final fingerprint
// validation must still detect each kind of post-issuance mutation.
for (const mutation of ["snapshot", "descriptor", "mids", "unavailable"] as const) {
  const old = instance.pricingInstances[0]!;
  const snapshot = { ...old.snapshot, probe: { value: 1 } };
  const pricingDescriptor = { ...old.pricingDescriptor, probe: { value: 1 } };
  const mids = new Map(old.mids), unavailable = new Map(old.unavailable);
  const copied = Object.freeze({ ...old, snapshot, pricingDescriptor, mids, unavailable });
  const input = Object.freeze({ ...instance, pricingInstances: Object.freeze([copied]) });
  const owner = issuer.reissuePreparedInstanceRouteHandles({ ...args, instance: input });
  const check = () => issuer.assertIssuedPreparedFamilyPricingStateInstance({ family,
    instance: owner, pricing: owner.pricingInstances[0]!, source: CURRENT, generation: CURRENT.generation });
  check();
  if (mutation === "snapshot") snapshot.probe.value++;
  if (mutation === "descriptor") pricingDescriptor.probe.value++;
  if (mutation === "mids") { const [key, value] = [...mids][0]!; mids.set(key, { ...value, mid: value.mid + 1 }); }
  if (mutation === "unavailable") unavailable.set("foreign", "mutated");
  rejects(check, /issuer-bound/);
}

// Source-pinned roots below use separate complete module closures, not handles
// crossing a diagnostic clone. Only synthetic fixture return bytes are used.
const candidateListener = new URL("../../../", import.meta.url);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
async function setup(listener: URL) {
  const load = (path: string) => import(new URL(`src/searcher/${path}.ts`, listener).href);
  const [fixture, { StrictProductionRuntimeRoot }, { createStrictCentralAdapterRuntime },
    { buildFamilyRouteGraphView }, { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG: catalog },
    { UNIV2_PAIR_INTERFACE }, { ethers }] = await Promise.all([
    load("architecture-migration-fixture-replay"), load("strict-production-runtime-session"),
    load("strict-central-adapter-runtime"), load("adapter-family-graph-runtime"),
    load("venues/production-family-composition"), load("venues/swaps/univ2-family/codec"),
    import(new URL("node_modules/ethers/lib.esm/index.js", listener).href),
  ]);
  const publication = await fixture.runUniv2Lifecycle(READY, pool), family = catalog.forFamily(publication.familyId);
  const view = buildFamilyRouteGraphView({ routes: publication.instances.flatMap((instance: typeof publication.instances[number]) =>
    instance.routes.map((route: typeof instance.routes[number], index: number) => ({ family,
      descriptor: instance.descriptor, route, handle: instance.routeHandles[index] }))) });
  const root = new StrictProductionRuntimeRoot({ catalog, readySource: READY, readyGraph: view.edges,
    readyInstances: publication.instances, readyFundingAssets: [] });
  const balance = new ethers.Interface(["function balanceOf(address account) view returns(uint256)"]);
  const reserveBytes = UNIV2_PAIR_INTERFACE.encodeFunctionResult("getReserves", [pool.reserves.reserve0, pool.reserves.reserve1, 1]);
  const balanceBytes = balance.encodeFunctionResult("balanceOf", [10n ** 24n]);
  let requests = 0, current = true;
  const runtime = createStrictCentralAdapterRuntime({ executor: EXECUTOR, transactionOrigin: `0x${"65".repeat(20)}`,
    provider: { call: async (request: { data: string }) => { requests++;
      if (request.data.slice(0, 10) === UNIV2_PAIR_INTERFACE.getFunction("getReserves")!.selector) return reserveBytes;
      if (request.data.slice(0, 10) === balance.getFunction("balanceOf")!.selector) return balanceBytes;
      throw new Error("unplanned fixture read"); },
      getCode: async () => { throw new Error("unexpected code read"); },
      getStorage: async () => { throw new Error("unexpected storage read"); } },
    generationFence: { assertCurrent(generation: number, source: typeof CURRENT) {
      assert(current, "retired fixture source"); assert.equal(generation, CURRENT.generation); assert.deepEqual(source, CURRENT);
    } } });
  const create = () => root.createSession({ source: CURRENT, kind: "exact", runtime, fundingAssets: [],
    requiredEdgeIds: new Set([view.edges[0].canonicalEdgeId]) });
  const session = await create(), quote = await session.issueExact({ edge: session.edges[0], amountIn: 1_000_000n,
    executor: EXECUTOR, runtimeEvidence: [] });
  assert(quote.amountOut > 0n);
  current = false;
  await assert.rejects(session.issueExact({ edge: session.edges[0], amountIn: 1_000_000n,
    executor: EXECUTOR, runtimeEvidence: [] }), /retired/);
  current = true;
  const summary = JSON.stringify({ source: session.source, edges: session.edges, pricingIndex: root.pricingIndex(),
    quote: { amountIn: quote.amountIn, amountOut: quote.amountOut, source: quote.source },
    scope: { selectedInstanceCount: session.creationTiming.selectedInstanceCount,
      projectedRouteCount: session.creationTiming.projectedRouteCount, fundingOfferCount: session.creationTiming.fundingOfferCount } },
  (_key, value) => value instanceof Map || value instanceof Set ? [...value] : typeof value === "bigint" ? String(value) : value);
  return { create, summary, requests: () => requests };
}
const candidate = await setup(candidateListener);
const summary: Record<string, unknown> = { test: "single-pass-route-reissue", negativeCases,
  nestedMutationCases: 4, finalFingerprintStillRequired: true, candidateRootDigest: sha(candidate.summary) };
if (process.argv.includes("--compare-baseline")) {
  assert(process.env.REISSUE_BASELINE_LISTENER, "an exact baseline source tree is required");
  assert.equal(typeof globalThis.gc, "function", "allocation comparison requires --expose-gc");
  const baselineListener = pathToFileURL(resolve(process.env.REISSUE_BASELINE_LISTENER) + "/");
  assert.notEqual(baselineListener.href, candidateListener.href);
  assert.equal(sha(readFileSync(new URL("src/searcher/strict-production-runtime-session.ts", baselineListener))),
    "60695c9a329131eacc05ad621ee3a1e8c00a6ad92fa68482e15b2b060390c0f4");
  assert.equal(sha(readFileSync(new URL("src/searcher/venues/adapter-family-runtime.ts", baselineListener))),
    "f751f7100bfd5b1aa7b17183909211949cb6346294f482a534fb3bab3a536912");
  const baseline = await setup(baselineListener); assert.equal(candidate.summary, baseline.summary);
  const inspector = new Session(); inspector.connect();
  const post = (method: string, params = {}) => new Promise<any>((resolve, reject) =>
    inspector.post(method as never, params, (error, value) => error ? reject(error) : resolve(value)));
  const measurements = [];
  for (const [variant, fixture] of [["baseline", baseline], ["candidate", candidate]] as const) {
    for (let i = 0; i < 5; i++) await fixture.create();
    globalThis.gc!(); const beforeRequests = fixture.requests();
    await post("HeapProfiler.startSampling", { samplingInterval: 16_384,
      includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const start = performance.now(); for (let i = 0; i < 30; i++) await fixture.create();
    const wallMs = performance.now() - start, { profile } = await post("HeapProfiler.stopSampling");
    measurements.push({ variant, sessions: 30, wallMs, reads: fixture.requests() - beforeRequests,
      sampledBytes: profile.samples.reduce((total: number, sample: { size: number }) => total + sample.size, 0) });
  }
  inspector.disconnect();
  assert(measurements.every(value => value.reads === 0));
  summary.actualCreateSessionOutputParity = true;
  summary.measurements = measurements;
  summary.measurementScope = "Synthetic one-instance Root; sampled allocations, not live latency or full cohort acceptance";
}
assert.equal(forbiddenNetworkAttempts, 0);
console.log(JSON.stringify({ ...summary, forbiddenNetworkAttempts }));
