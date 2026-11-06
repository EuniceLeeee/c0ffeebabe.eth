import { plugin as conversionPlugin } from "../../../production-families/token-conversion.production.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Interface, zeroPadValue } from "ethers";
import { createStrictCentralAdapterRuntime } from "../../../../strict-central-adapter-runtime.js";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import { applyExactTrialState, emptyExactTrialState } from "../../../../exact-trial-state.js";
import type { AdapterRequest, AdapterRequestResult, CanonicalSource, RequestRequirements } from "../../../adapter-request-program.js";
import type { ExactQuoteInput, ExactQuotePrefixStep } from "../../../adapter-family-plugin.js";
import { familyId, lineageId } from "../../../adapter-family-identifiers.js";
import { createRecordedFamilyReadReplay, type RecordedFamilyReadWitness } from "../../../../test/recorded-family-read-witness.js";
const XWIN_LOCAL_ABI = new Interface(["function paused() view returns(bool)"]);
import type { ConversionDescriptor, ConversionRoute, Direction } from "./reference/types.js";

const { instance, routes, exact } = conversionPlugin;
const FAMILY = familyId("protocol:token-conversion"), XWIN_LINEAGE = lineageId("token-conversion:xwin-allocations-v1");


// Offline issuer integration, not new identity admission or final EVM execution.
// All protocol reads are captured at B; the executor runtime is the code-only
// override saved by the historical production harness, not a claimed deployment.
// Unlike the pure decoder regression, every round passes the actual central
// declaration, caller authority, budget, transport and result-issuance boundary.
// tool-reconciled: listener:searcher:at-block n/a this cached issuer regression
// does not create a new enumeration pipeline or claim historical replay success.
type Input = ExactQuoteInput<ConversionDescriptor, ConversionRoute>;
type Witness = RecordedFamilyReadWitness & { readonly subject: { family: string; lineage: string; target: string; asset: string; codeHash: string; proxyAdmin: string } };

function fixture() {
  const saved = JSON.parse(readFileSync(new URL("./fixtures/xwin-exact-b26029584.json", import.meta.url), "utf8")) as Witness;
  const source = { number: 26029584, hash: "0xad5cae5e3dfee81a2e01e7bbdfc0595dbc3de4a525bb7c6ad9fa3c9749dbc6cc", generation: 1 };
  const surface = saved.subject;
  assert.equal(surface.family, FAMILY); assert.equal(surface.lineage, XWIN_LINEAGE);
  assert.deepEqual(saved.source, source);
  const provisioned = saved.rounds.flatMap(round => round.reads).filter(row => row.provisioning !== undefined);
  assert.deepEqual(provisioned.map(row => [row.id, row.kind, row.target]), [["exact-xwin-actor-code", "get-code", saved.executor.toLowerCase()]]);
  const start = () => createRecordedFamilyReadReplay(saved, { source, chainId: 1, resolveCaller(caller) {
    assert.equal(caller.kind, "executor"); return saved.executor;
  } });
  let replay = start();
  const changes = new Map<string, string>();
  // This descriptor is only fixture metadata for the request-program boundary;
  // no fabricated identity or execution receipt is submitted for admission.
  const descriptor = instance.compileDraft({ familyId: FAMILY, lineageId: XWIN_LINEAGE,
    subject: surface.target, variant: "xwin-allocations-v1", asset: surface.asset,
    codeHash: surface.codeHash, proxyAdmin: surface.proxyAdmin,
    provenance: [{ kind: "cached-xwin-issuer-fixture", subject: surface.target }] });
  const projected = routes.project({ descriptor });
  let reads = 0;
  const transport = new Map<string, string>();
  const counts = new Map<string, number>();
  const hits = new Set<string>();
  const key = (...fields: string[]) => fields.map(field => field.toLowerCase()).join("|");
  function lookup(requestKey: string, block: number | undefined) {
    assert.equal(block, saved.source.number);
    const data = transport.get(requestKey);
    assert.notEqual(data, undefined, `uncaptured physical request: ${requestKey}`);
    hits.add(requestKey);
    const remaining = counts.get(requestKey) ?? 0;
    assert(remaining > 0, "unexpected repeated physical request");
    counts.set(requestKey, remaining - 1);
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
    transport.clear(); counts.clear(); hits.clear();
    for (const { id, key, data } of replay.readRound(requests)) {
      const supplied = changes.get(id) ?? data;
      if (transport.has(key)) assert.equal(transport.get(key), supplied);
      transport.set(key, supplied); counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  function input(direction: Direction, amountIn: bigint, prefix?: readonly ExactQuotePrefixStep[]): Input {
    return { descriptor, route: projected.find(route => route.direction === direction)!,
      source: saved.source, executor: saved.executor, amountIn, runtimeEvidence: [], prefix, trialState: emptyExactTrialState().view };
  }
  async function round(requests: readonly AdapterRequest[], requirements: RequestRequirements) {
    stageResponses(requests);
    const issued = await executeAdapterWork({ runtime, intent: { stage: "exact-refine", familyId: FAMILY,
      source: saved.source, generation: saved.source.generation, programInput: {},
      program: { requirements: () => requirements, buildRequests: () => requests, decode: ({ results }) => results } } });
    if (issued.status === "resolved") assert.equal(hits.size, transport.size, "issued round did not consume all physical reads");
    return issued;
  }
  async function run(i: Input, corruptFinalRequirements = false) {
    replay = start();
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
    replay.finish();
    const result = program.decode({ programInput: i, initialResults, dependentEvidence });
    return { ...result, counts };
  }
  async function nextOracleRound(newOracle: string) {
    replay = start();
    const i = input("mint", 5538803n);
    const method = exact.methods(i).find(item => item.kind === "request-program");
    assert(method?.kind === "request-program");
    const program = method.program;
    const first = await round(program.buildRequests(i), program.requirements(i));
    assert(first.status === "resolved");
    const initialResults = first.executed.evidence;
    const dependencies = program.buildDependentProgram!({ programInput: i, completedRound: 0, initialResults, priorEvidence: [] });
    assert(dependencies);
    changes.set("exact-xwin-swap-oracle", zeroPadValue(newOracle, 32));
    const second = await round(dependencies.requests, dependencies.requirements);
    assert(second.status === "resolved");
    const next = program.buildDependentProgram!({ programInput: i, completedRound: 1, initialResults,
      priorEvidence: [dependencies.decode(second.executed.evidence)] });
    assert(next); return next.requests;
  }
  return { input, run, nextOracleRound, readCount: () => reads, setPausedData(data: string) {
    changes.set("exact-xwin-paused", data);
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
  const carried = { ...f.input("redeem", minted.amountOut),
    trialState: applyExactTrialState(emptyExactTrialState(), minted.stateChanges!, minted.stateEffects).view };
  const fast = exact.methods(carried).find(method => method.kind === "request-program");
  assert(fast?.kind === "request-program" && fast.trialState);
  const beforeCarry = f.readCount();
  const local = fast.trialState.quote(carried);
  assert.equal(local.status, "quoted");
  if (local.status === "quoted") assert.equal(local.result.amountOut, redeemed.amountOut);
  assert.equal(f.readCount(), beforeCarry, "issued state must quote without reading the unchanged pool again");
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

test("distinct fund and swap oracles are both queried for their own rates before admission", async () => {
  const second = "0x0000000000000000000000000000000000000201";
  const requests = await fixture().nextOracleRound(second);
  const first = requests.find(r => r.id === "exact-xwin-oracle-code-0");
  assert(first?.kind === "get-code" && first.address.toLowerCase() !== second);
  const distinct = requests.find(r => r.id === "exact-xwin-oracle-code-1");
  assert(distinct?.kind === "get-code" && distinct.address.toLowerCase() === second);
  for (const [index, address] of [first.address, distinct.address].entries()) {
    for (const name of ["price", "map", "reverse-map"]) {
      for (let pair = 0; pair < 4; pair++) {
        const request = requests.find(r => r.id === `exact-xwin-${name}-${index}-${pair}`);
        assert(request?.kind === "eth-call" && request.to.toLowerCase() === address.toLowerCase());
      }
    }
  }
});
