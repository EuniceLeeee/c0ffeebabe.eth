import assert from "node:assert/strict";
import test from "node:test";
import { executeAdapterWork } from "../../../../adapter-work-intent.js";
import { RevmFatalError } from "../../../../revm-sim-client.js";
import { plugin } from "../../../production-families/compound-ctoken.production.js";
import { CTOKEN_INTERFACE } from "../abi.js";
import type { AdapterRequest } from "../../../adapter-request-program.js";
import { answerFor, CANDIDATE, EXECUTOR, identityWith, MARKET, UNDERLYING } from "./fixtures.js";
import { fixture, lower, ORIGIN, source, state, type Mutation } from "./runtime-fixture.js";

const variant = plugin.identity.variants[0]!;
async function identity(f = fixture()) {
  let evidence: unknown;
  const rounds: string[][] = [];
  for (const step of [0, 1, 2]) {
    const input = { candidate: CANDIDATE, evidence, step };
    const decision = variant.decide(input);
    if (decision.status !== "continue") return { decision, rounds };
    rounds.push(variant.buildRequests(input).map(r => r.id));
    const work = await executeAdapterWork({ runtime: f.runtime, intent: {
      stage: "identity", familyId: plugin.manifest.familyId, source: source(), generation: source().generation, programInput: input,
      program: { requirements: x => variant.requirements(x), buildRequests: x => variant.buildRequests(x),
        decode: ({ programInput, results }) => variant.decode({ step: programInput, results }) },
    } });
    if (work.status !== "resolved") return { work, rounds };
    evidence = work.executed.evidence;
  }
  return { decision: variant.decide({ candidate: CANDIDATE, evidence, step: 3 }), rounds };
}

test("real strict request/REVM transport: registry+current same round then funded positive redeem effects", async () => {
  const f = fixture(), result = await identity(f);
  assert.equal(result.decision?.status, "verified");
  assert.equal(result.rounds.length, 3);
  assert.deepEqual(result.rounds[1], ["registry-markets", "registry-all-markets", "registry-current-rate"]);
  assert.deepEqual(result.rounds[2], ["active-redeem"]);
  assert.equal(f.wires.length, 1);
  const wire = f.wires[0], shares = BigInt(CTOKEN_INTERFACE.decodeFunctionData("redeem", wire.data)[0]);
  assert(shares > 0n);
  assert.equal(wire.to, lower(MARKET)); assert.equal(wire.from, lower(EXECUTOR));
  assert.equal(wire.transactionOrigin, ORIGIN); assert.equal(wire.callerMode, "impersonated-call-frame");
  assert.equal(wire.blockNumber, source().number); assert.deepEqual(wire.sourcePin, f.pin);
  assert.deepEqual(wire.tokenDeals, [{ token: lower(MARKET), to: lower(EXECUTOR), amount: String(shares) }]);
  assert.equal(wire.nativeBalanceWei, undefined); assert.deepEqual(wire.preCalls, []);
  assert.deepEqual(wire.observeTokenBalances, [{ token: lower(MARKET), account: lower(EXECUTOR) },
    { token: lower(UNDERLYING), account: lower(EXECUTOR) }, { token: lower(UNDERLYING), account: lower(MARKET) }]);
  assert.deepEqual(wire.observeTotalSupply, [lower(MARKET)]); assert.equal(wire.observeLogs, true);
});

for (const [name, mutate] of [
  ["nonzero error with otherwise perfect effects", r => { r.output = CTOKEN_INTERFACE.encodeFunctionResult("redeem", [1n]); r.strict!.outcome = { kind: "Success", phase: "main", output: r.output }; }],
  ["no burn", r => { r.strict!.tokenDeltas[0].delta = "0"; }],
  ["no receipt", r => { r.strict!.tokenDeltas[1].delta = "0"; }],
  ["cash not debited", r => { r.strict!.tokenDeltas[2].delta = "0"; }],
  ["no supply burn", r => { r.strict!.totalSupplyDeltas[0].delta = "0"; }],
  ["missing Redeem", r => { r.strict!.logs = []; }],
] as [string, Mutation][]) test(`unproven ${name} is retryable, never verified/permanently rejected`, async () => {
  assert.equal((await identity(fixture(source(), state(), mutate))).decision?.status, "retryable");
});

for (const [name, mutate] of [
  ["foreign source", r => { r.sourceAttestation = { ...r.sourceAttestation!, blockHash: "0x" + "ff".repeat(32) }; }],
  ["wrong observed actor", r => { r.strict!.tokenDeltas[1].account = MARKET; }],
  ["missing observed output", r => { r.strict!.tokenDeltas.splice(1, 1); }],
] as [string, Mutation][]) test(`transport rejects ${name} before any Family proof`, async () => {
  const f = fixture(source(), state(), mutate);
  // Trusted transport faults may propagate or be represented by central work;
  // either way no verified or permanent-rejection evidence is produced.
  try { const result = await identity(f); assert(!result.decision); assert.notEqual(result.work?.status, "resolved"); }
  catch (e) { assert(e instanceof RevmFatalError); }
});

test("zero cash and unavailable current accrual never make permanent identity rejection", async () => {
  const empty = state(); empty.cash = 0n;
  const f = fixture(source(), empty), result = await identity(f);
  assert.equal(result.decision?.status, "retryable"); assert.equal(f.wires.length, 0);
  const failed = state(); failed.failCurrent = true;
  const unavailable = await identity(fixture(source(), failed));
  assert(!unavailable.decision); assert.notEqual(unavailable.work?.status, "resolved");
});

test("missing transactionOrigin cannot enter the funded simulation lease", async () => {
  const f = fixture();
  const requests: AdapterRequest[] = [];
  identityWith(request => { requests.push(request); return answerFor()(request); });
  const request = requests.find(r => r.kind === "effect-delta-simulation");
  assert(request?.kind === "effect-delta-simulation");
  await assert.rejects(f.simulator.simulate({ request, source: source(), callerAuthority: { executor: EXECUTOR } }));
  assert.equal(f.leases, 0); assert.equal(f.wires.length, 0);
});
