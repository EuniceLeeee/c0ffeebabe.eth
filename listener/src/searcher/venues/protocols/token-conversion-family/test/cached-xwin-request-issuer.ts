import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { keccak256 } from "ethers";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import { applyExactTrialState, emptyExactTrialState } from "../../../../exact-trial-state.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "../../../adapter-request-program.js";
import type { ExactQuoteInput, ExactQuotePrefixStep } from "../../../adapter-family-plugin.js";
import { exact } from "../exact.js";
import { instance } from "../instance.js";
import { FAMILY, XWIN_LINEAGE } from "../manifest.js";
import { routes } from "../routes.js";
import { decodeXwinSurface } from "../xwin.js";
import { XWIN_LOCAL_ABI } from "../xwin-local.js";
import type { ConversionDescriptor, ConversionRoute, Direction } from "../types.js";

// Offline issuer integration, not new identity admission or final EVM execution.
// All protocol reads are captured at B; the executor runtime is the code-only
// override saved by the historical production harness, not a claimed deployment.
// Unlike the pure decoder regression, every round passes the actual central
// declaration, caller authority, budget, transport and result-issuance boundary.
// tool-reconciled: listener:searcher:at-block n/a this cached issuer regression
// does not create a new enumeration pipeline or claim historical replay success.
type Input = ExactQuoteInput<ConversionDescriptor, ConversionRoute>;
type Saved = { source: CanonicalSource; executor: string; surface: { target: string }; results: AdapterRequestResult[] };

function fixture() {
  const root = process.env.XWIN_LOCAL_STATE_EVIDENCE;
  const executorPath = process.env.XWIN_LOCAL_EXECUTOR_EVIDENCE;
  assert(root && executorPath, "XWIN_LOCAL_STATE_EVIDENCE and XWIN_LOCAL_EXECUTOR_EVIDENCE are required");
  const saved = JSON.parse(readFileSync(resolve(root, "xwin-local-program-state.json"), "utf8")) as Saved;
  const actor = JSON.parse(readFileSync(executorPath, "utf8")) as { code: string; keccak256: string };
  assert.equal(keccak256(actor.code), actor.keccak256);
  assert.equal(saved.results.length, 126);
  assert.equal(saved.source.number, 26029584);
  const surface = decodeXwinSurface(saved.results, "exact-xwin", saved.surface.target);
  assert.deepEqual(surface.source, saved.source);
  // This descriptor is only fixture metadata for the request-program boundary;
  // no fabricated identity or execution receipt is submitted for admission.
  const descriptor = instance.compileDraft({ familyId: FAMILY, lineageId: XWIN_LINEAGE,
    subject: surface.target, variant: "xwin-allocations-v1", asset: surface.asset,
    codeHash: surface.codeHash, proxyAdmin: surface.proxyAdmin,
    provenance: [{ kind: "cached-xwin-issuer-fixture", subject: surface.target }] });
  const projected = routes.project({ descriptor });
  const captured = new Map(saved.results.map(result => [result.id, result]));
  let reads = 0;
  const transport = new Map<string, string>();
  const key = (...fields: string[]) => fields.map(field => field.toLowerCase()).join("|");
  function lookup(requestKey: string, block: number | undefined) {
    assert.equal(block, saved.source.number);
    const data = transport.get(requestKey);
    assert.notEqual(data, undefined, `uncaptured physical request: ${requestKey}`);
    reads++;
    return data!;
  }
  const runtime = createStrictCentralAdapterRuntime({ executor: saved.executor,
    generationFence: { assertCurrent(generation, source) {
      assert.equal(generation, saved.source.generation); assert.deepEqual(source, saved.source);
    } },
    provider: {
      async getCode(address, block) { return lookup(key("get-code", address), block); },
      async getStorage(address, slot, block) { return lookup(key("get-storage", address, slot), block); },
      async call(tx, block) { return lookup(key("eth-call", tx.to, tx.data, tx.from ?? ""), block ?? tx.blockTag); },
    },
    simulator: { async simulate() { assert.fail("local amount quotation must not simulate"); } },
  });
  function stageResponses(requests: readonly AdapterRequest[]) {
    transport.clear();
    for (const request of requests) {
      const result = captured.get(request.id);
      const data = request.id === "exact-xwin-actor-code" ? actor.code : (() => {
        assert(result?.ok && result.completion === "returned", `missing capture: ${request.id}`);
        assert.deepEqual(result.source, saved.source);
        return result.data;
      })();
      const physicalKey = request.kind === "get-code" ? key(request.kind, request.address)
        : request.kind === "get-storage" ? key(request.kind, request.address, request.slot)
        : request.kind === "eth-call" ? key(request.kind, request.to, request.data,
          request.caller ? (assert.equal(request.caller.kind, "executor"), saved.executor) : "")
        : assert.fail("captured local program may only issue state reads");
      if (transport.has(physicalKey)) assert.equal(transport.get(physicalKey), data);
      transport.set(physicalKey, data);
    }
  }
  function input(direction: Direction, amountIn: bigint, prefix?: readonly ExactQuotePrefixStep[]): Input {
    return { descriptor, route: projected.find(route => route.direction === direction)!,
      source: saved.source, executor: saved.executor, amountIn, runtimeEvidence: [], prefix, trialState: emptyExactTrialState().view };
  }
  async function round(requests: readonly AdapterRequest[], requirements: RequestRequirements) {
    stageResponses(requests);
    return executeAdapterWork({ runtime, intent: { stage: "exact-refine", familyId: FAMILY,
      source: saved.source, generation: saved.source.generation, programInput: {},
      program: { requirements: () => requirements, buildRequests: () => requests, decode: ({ results }) => results } } });
  }
  async function run(i: Input, corruptFinalRequirements = false) {
    const method = exact.methods(i).find(method => method.kind === "request-program");
    assert(method?.kind === "request-program");
    assert.equal(method.id, "xwin-local-state");
    const program = method.program;
    const initial = await round(program.buildRequests(i), program.requirements(i));
    assert.equal(initial.status, "resolved", initial.status === "unresolved" ? initial.failure.message : "");
    if (initial.status !== "resolved") throw new Error("initial issuer failed");
    const initialResults = initial.executed.evidence;
    const dependentEvidence: unknown[] = [];
    const counts: number[] = [];
    for (let completedRound = 0; ; completedRound++) {
      const bound = program.buildDependentProgram!({ programInput: i, completedRound, initialResults, priorEvidence: dependentEvidence });
      if (bound === null) break;
      assert(completedRound < 4, "expected four dependent rounds without raising the production limit");
      const before = reads;
      const work = await round(bound.requests, corruptFinalRequirements && completedRound === 3
        ? { ...bound.requirements, transports: [...bound.requirements.transports, "get-storage"] }
        : bound.requirements);
      if (corruptFinalRequirements && completedRound === 3) {
        assert.equal(work.status, "unresolved");
        if (work.status !== "unresolved") throw new Error("unused transport escaped issuer validation");
        assert.match(work.failure.message, /declared request transport get-storage is not used/);
        assert.equal(reads, before, "bad declaration must fail before any final-round reads");
        return null;
      }
      assert.equal(work.status, "resolved", work.status === "unresolved" ? work.failure.message : "");
      if (work.status !== "resolved") throw new Error("dependent issuer failed");
      counts.push(bound.requests.length);
      dependentEvidence.push(bound.decode(work.executed.evidence));
    }
    assert.deepEqual(counts, [39, 31, 13, 34]);
    assert.equal(initialResults.length, 10);
    const result = program.decode({ programInput: i, initialResults, dependentEvidence });
    return { ...result, counts };
  }
  return { input, run, readCount: () => reads, setPausedData(data: string) {
    const result = captured.get("exact-xwin-paused");
    assert(result?.ok);
    captured.set(result.id, { ...result, data });
  } };
}

test("cached xWin local quote crosses the real issuer for all four dependent rounds, including sequential V3 state", async () => {
  const f = fixture(), amountIn = 5538803n;
  const deposit = f.input("mint", amountIn);
  const minted = await f.run(deposit); assert(minted);
  assert.equal(minted.amountOut, 5228263254874214432n);
  const redeemed = await f.run({ ...f.input("redeem", minted.amountOut, [{ descriptor: deposit.descriptor,
    route: deposit.route, amountIn, amountOut: minted.amountOut }]),
    trialState: applyExactTrialState(emptyExactTrialState(), minted.stateChanges!, minted.stateEffects).view });
  assert(redeemed); assert.equal(redeemed.amountOut, 5501246n);
  console.log(JSON.stringify({ kind: "xwin-local-real-issuer-cached-regression", sourceBlock: 26029584,
    dependentRequests: minted.counts, shares: String(minted.amountOut), returnedBase: String(redeemed.amountOut),
    newFinalSim: false, protocolReadsCaptured: 126, executorCodeOnlyOverride: true }));
});

test("real xWin issuer rejects the previous unused final-round storage declaration before transport", async () => {
  const f = fixture();
  assert.equal(await f.run(f.input("mint", 5538803n), true), null);
});

test("paused xWin stops after its initial source-pinned reads, then recovers without permanent rejection", async () => {
  const f = fixture();
  f.setPausedData(XWIN_LOCAL_ABI.encodeFunctionResult("paused", [true]));
  for (const direction of ["mint", "redeem"] as const) {
    const before = f.readCount();
    await assert.rejects(f.run(f.input(direction, 5538803n)), /xWin paused/);
    assert.equal(f.readCount() - before, 10, "paused quotes must not request dependency/price rounds");
  }
  f.setPausedData(XWIN_LOCAL_ABI.encodeFunctionResult("paused", [false]));
  const result = await f.run(f.input("mint", 5538803n));
  assert(result); assert.equal(result.amountOut, 5228263254874214432n);
});

test("empty pause response remains fail-closed before expensive xWin dependency reads", async () => {
  const f = fixture();
  f.setPausedData("0x");
  await assert.rejects(f.run(f.input("mint", 5538803n)));
  assert.equal(f.readCount(), 10);
});
