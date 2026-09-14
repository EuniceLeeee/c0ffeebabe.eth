import assert from "node:assert/strict";
import test from "node:test";
import { ethers } from "ethers";
import { executeAdapterWork } from "../adapter-work-intent.js";
import { createRevmStrictSimulationTransport } from "../revm-strict-simulation-transport.js";
import { RevmFatalError, type DaemonResponse, type StrictSimulateRequest } from "../revm-sim-client.js";
import { createStrictCentralAdapterRuntime, type StrictSimulationTransport } from "../strict-central-adapter-runtime.js";
import type { AdapterRequestResult, CanonicalSource } from "../venues/adapter-request-program.js";
import { plugin } from "../venues/production-families/eigenpie.production.js";
import { EIGENPIE_INTERFACE } from "../venues/protocols/eigenpie-family/codec.js";
import type { EigenpieCandidate, EigenpieQuoteEvidence } from "../venues/protocols/eigenpie-family/types.js";

// Offline declaration/transport regressions, not historical execution evidence.
// Addresses/amounts reproduce the failed nominee; code, effects and authority
// below are mocks. No checkpoint, generated catalog, node or RPC is accessed.
const TARGET = "0x24db6717dB1C75B9Db6eA47164D8730B63875dB7";
const ASSET = "0xc43C6bfeDA065fE2c4c11765Bf838789bd0BB5dE";
const RECEIPT = "0xD48067f122AFC3a58f0F79611f5F1AfAe0d7f25B";
const ACTOR = "0xE08D97e151473A848C3d9CA3f323Cb720472D015";
const EXECUTOR = `0x${"11".repeat(20)}`;
const ORIGIN = `0x${"22".repeat(20)}`;
const SOURCE: CanonicalSource = Object.freeze({
  number: 25_585_335,
  hash: "0x7cbdaf19a25e9615f09a3d695c9deb48bfa949fdf76f168ecbe4f4517d47b809",
  generation: 25_585_335,
});
const PIN = { chainId: 1, blockHash: SOURCE.hash, stateRoot: `0x${"33".repeat(32)}` };
const AUTHORITY = { executor: EXECUTOR, transactionOrigin: ORIGIN, observedSender: ACTOR.toLowerCase() };
const CANDIDATE: EigenpieCandidate = Object.freeze({
  candidateKind: "eigenpie-deposit-pair", target: TARGET, actor: ACTOR,
  tokenIn: ASSET, amountIn: 155167433355795378068n,
  minAmountOut: 149640805284635957914n, observedAmountOut: 149640805284635957914n,
  transactionHash: "0x4cca0e665fa0d66181fd5aa89551d4e449c63fb987d87a2c4b7c8e305ae28be4",
});
const ERC20 = new ethers.Interface([
  "function approve(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)",
]);
const variant = plugin.identity.variants[0]!;
type Invocation = Parameters<StrictSimulationTransport["simulate"]>[0];
type Simulation = Invocation["request"];
type Success = Extract<AdapterRequestResult, { readonly ok: true }>;
type Mutation = (response: DaemonResponse) => void;
const lower = (value: string) => value.toLowerCase();

function returned(id: string, data: string): Success {
  return { id, ok: true, source: SOURCE, completion: "returned", data,
    provenance: { kind: "unit-test-only", fingerprint: "unit-test-only" } };
}
function quote(candidate = CANDIDATE): EigenpieQuoteEvidence {
  return variant.decode({ step: { candidate, step: 0 }, results: [
    returned("identity-target-code", "0x6000"),
    returned("identity-asset-code", "0x6000"),
    returned("identity-quote", EIGENPIE_INTERFACE.encodeFunctionResult(
      "getMLRTAmountToMint", [candidate.observedAmountOut, RECEIPT],
    )),
  ] }) as EigenpieQuoteEvidence;
}
function request(evidence = quote()): Simulation {
  const value = variant.buildRequests({ candidate: CANDIDATE, evidence, step: 1 })
    .find(item => item.id === "identity-active-deposit");
  assert(value?.kind === "effect-delta-simulation");
  return value;
}
function depositLog(q = quote(), preDeposit = false) {
  return { address: q.target, ...EIGENPIE_INTERFACE.encodeEventLog(
    EIGENPIE_INTERFACE.getEvent("AssetDeposit")!,
    [q.actor, q.tokenIn, q.amountIn, ethers.ZeroAddress, q.amountOut, preDeposit],
  ) };
}
function response(wire: StrictSimulateRequest, q = quote()): DaemonResponse {
  const output = ERC20.encodeFunctionResult("totalSupply", [q.amountOut]);
  // Never supply receipt effects that the actual wire did not request.
  return { ok: true, success: true, output, gasUsed: "21000", latencyMs: 0,
    sourceAttestation: { kind: "node-attested", ...PIN,
      blockNumber: SOURCE.number, parentHash: `0x${"44".repeat(32)}` },
    strict: { outcome: { kind: "Success", phase: "main", output },
      executionGasUsed: "21000", nativeDeltas: [],
      tokenDeltas: (wire.observeTokenBalances ?? []).map(pair => ({ ...pair,
        delta: pair.token === lower(q.tokenIn) ? String(-q.amountIn)
          : pair.token === lower(q.tokenOut) ? String(q.amountOut) : "0",
      })),
      totalSupplyDeltas: (wire.observeTotalSupply ?? []).map(token => ({ token,
        delta: token === lower(q.tokenOut) ? String(q.amountOut) : "0",
      })),
      logs: wire.observeLogs ? [depositLog(q)] : [],
    },
  };
}
function fixture(mutate?: Mutation, q = quote()) {
  const calls: StrictSimulateRequest[] = [];
  let leases = 0;
  const transport = createRevmStrictSimulationTransport({
    rpcUrl: "http://offline.invalid", executionGasLimit: 0x1000000,
    leaseFor: async source => {
      leases++;
      assert.deepEqual(source, SOURCE);
      return { source: SOURCE, sourcePin: PIN,
        strictSimulate: async wire => {
          calls.push(wire);
          const result = response(wire, q);
          mutate?.(result);
          return result;
        },
        closeAndDrain: async () => assert.fail("transport must not retire lease"),
      };
    },
    onFatal() {},
  });
  return { transport, calls, get leases() { return leases; },
    simulate: (draft = request(q), callerAuthority: Invocation["callerAuthority"] = AUTHORITY) =>
      transport.simulate({ request: draft, source: SOURCE, callerAuthority }),
  };
}
function decode(value: Awaited<ReturnType<StrictSimulationTransport["simulate"]>>, q = quote()) {
  return variant.decode({ step: { candidate: CANDIDATE, evidence: q, step: 1 }, results: [
    returned("identity-receipt-code", "0x6000"),
    { ...returned("identity-active-deposit", value.data), effects: value.effects },
  ] });
}
function verdict(evidence: ReturnType<typeof decode>) {
  return variant.decide({ candidate: CANDIDATE, evidence, step: 2 });
}

test("wire scope observes the receipt, not the deposit router", async () => {
  const f = fixture();
  await f.simulate();
  assert.deepEqual(f.calls[0]!.observeTokenBalances, [
    { token: lower(ASSET), account: lower(ACTOR) },
    { token: lower(RECEIPT), account: lower(ACTOR) },
  ]);
  assert.deepEqual(f.calls[0]!.observeTotalSupply, [lower(RECEIPT)]);
});

test("ordered program preserves exact approval/deposit, actor, origin and source", async () => {
  const q = quote(), draft = request(q), f = fixture();
  await f.simulate(draft);
  const wire = f.calls[0]!;
  assert.equal(draft.required, undefined, "active proof stays required by default");
  assert.deepEqual(draft.call.caller, { kind: "observed-sender" });
  assert.equal(wire.callerMode, "impersonated-call-frame");
  assert.equal(wire.from, lower(ACTOR));
  assert.equal(wire.transactionOrigin, ORIGIN);
  assert.equal(wire.blockNumber, SOURCE.number);
  assert.deepEqual(wire.sourcePin, PIN);
  assert.deepEqual(wire.tokenDeals, [{ token: lower(ASSET), to: lower(ACTOR), amount: String(q.amountIn) }]);
  assert.deepEqual(wire.preCalls, [
    { from: lower(ACTOR), to: lower(ASSET), calldata: ERC20.encodeFunctionData("approve", [TARGET, q.amountIn]) },
    { from: lower(ACTOR), to: lower(TARGET), calldata: EIGENPIE_INTERFACE.encodeFunctionData(
      "depositAsset", [ASSET, q.amountIn, q.amountOut, ethers.ZeroAddress],
    ) },
  ]);
  assert.equal(wire.to, lower(RECEIPT));
  assert.equal(wire.data, ERC20.encodeFunctionData("totalSupply"));
  assert.deepEqual(draft.observe, ["return-data", "token-delta", "total-supply-delta", "logs"]);
  assert(Object.isFrozen(draft.preCalls));
  assert(Object.isFrozen(draft.observeTokenBalances));
});

test("declared-scope effects satisfy every unchanged Family predicate", async () => {
  const f = fixture();
  const decision = verdict(decode(await f.simulate()));
  assert.equal(decision.status, "verified");
  if (decision.status !== "verified") assert.fail("missing identity");
  assert("sampleAmountIn" in decision.identity);
  assert.equal(decision.identity.sampleAmountIn, CANDIDATE.amountIn);
  assert.equal(decision.identity.subject, [TARGET, ASSET, RECEIPT].map(lower).join(":"));
});

test("strict runtime issues the original two-round Family program", async () => {
  const f = fixture();
  const runtime = createStrictCentralAdapterRuntime({
    ...AUTHORITY, simulator: f.transport,
    generationFence: { assertCurrent(generation, source) {
      assert.equal(generation, SOURCE.generation); assert.deepEqual(source, SOURCE);
    } },
    provider: {
      getCode: async (_address, block) => { assert.equal(block, SOURCE.number); return "0x6000"; },
      getStorage: async () => assert.fail("unexpected storage read"),
      call: async (tx, block) => {
        assert.equal(block, SOURCE.number); assert.equal(lower(tx.to), lower(TARGET));
        assert.equal(tx.data, EIGENPIE_INTERFACE.encodeFunctionData("getMLRTAmountToMint", [ASSET, CANDIDATE.amountIn]));
        return EIGENPIE_INTERFACE.encodeFunctionResult("getMLRTAmountToMint", [CANDIDATE.observedAmountOut, RECEIPT]);
      },
    },
  });
  let evidence: unknown;
  for (const step of [0, 1]) {
    const input = { candidate: CANDIDATE, evidence, step };
    const outcome = await executeAdapterWork({ runtime, intent: {
      stage: "identity", familyId: plugin.manifest.familyId, source: SOURCE,
      generation: SOURCE.generation, programInput: input,
      program: { requirements: value => variant.requirements(value),
        buildRequests: value => variant.buildRequests(value),
        decode: ({ programInput, results }) => variant.decode({ step: programInput, results }),
      },
    } });
    assert.equal(outcome.status, "resolved");
    if (outcome.status !== "resolved") assert.fail("identity program unresolved");
    evidence = outcome.executed.evidence;
    assert.equal(variant.decide({ candidate: CANDIDATE, evidence, step: step + 1 }).status,
      step === 0 ? "continue" : "verified");
  }
  assert.equal(f.calls.length, 1);
});

const negativeEffects: readonly [string, Mutation][] = [
  ["missing input debit", r => { r.strict!.tokenDeltas[0]!.delta = "0"; }],
  ["short input debit", r => { r.strict!.tokenDeltas[0]!.delta = String(1n - CANDIDATE.amountIn); }],
  ["missing receipt credit", r => { r.strict!.tokenDeltas[1]!.delta = "0"; }],
  ["short receipt credit", r => { r.strict!.tokenDeltas[1]!.delta = String(CANDIDATE.minAmountOut - 1n); }],
  ["missing supply increase", r => { r.strict!.totalSupplyDeltas[0]!.delta = "0"; }],
  ["short supply increase", r => { r.strict!.totalSupplyDeltas[0]!.delta = String(CANDIDATE.minAmountOut - 1n); }],
  ["missing event", r => { r.strict!.logs = []; }],
  ["foreign event emitter", r => { r.strict!.logs[0]!.address = RECEIPT; }],
  ["foreign event actor", r => { r.strict!.logs[0]!.topics[1] = ethers.zeroPadValue(EXECUTOR, 32); }],
  ["foreign event asset", r => { r.strict!.logs[0]!.topics[2] = ethers.zeroPadValue(RECEIPT, 32); }],
  ["wrong event input", r => { r.strict!.logs = [depositLog({ ...quote(), amountIn: 1n })]; }],
  ["wrong event output", r => { r.strict!.logs = [depositLog({ ...quote(), amountOut: 1n })]; }],
  ["predeposit event", r => { r.strict!.logs = [depositLog(quote(), true)]; }],
];
for (const [name, mutate] of negativeEffects) test(`rejects ${name}`, async () => {
  assert.equal(verdict(decode(await fixture(mutate).simulate())).status, "chain-proven-rejected");
});

for (const index of [0, 1]) for (const kind of ["Revert", "Halt"] as const) {
  test(`failed ${index === 0 ? "approval" : "deposit"} ${kind} cannot supply proof`, async () => {
    const f = fixture(r => {
      r.success = false;
      r.output = kind === "Revert" ? "0x" : undefined;
      r.revertReason = r.output;
      r.strict!.outcome = kind === "Revert"
        ? { kind, phase: "preCall", preCallIndex: index, output: "0x" }
        : { kind, phase: "preCall", preCallIndex: index, reason: "OutOfGas" };
      r.strict!.tokenDeltas = []; r.strict!.totalSupplyDeltas = []; r.strict!.logs = [];
    });
    await assert.rejects(f.simulate());
  });
}

for (const role of ["observedSender", "transactionOrigin"] as const) test(`missing ${role} fails before lease`, async () => {
  const authority: Invocation["callerAuthority"] = { ...AUTHORITY, [role]: undefined };
  const f = fixture();
  await assert.rejects(f.simulate(request(), authority));
  assert.equal(f.leases, 0); assert.equal(f.calls.length, 0);
});
const invalidResponses: readonly [string, Mutation][] = [
  ["missing attestation", r => { r.sourceAttestation = undefined; }],
  ["wrong block hash", r => { r.sourceAttestation = { ...r.sourceAttestation!, blockHash: `0x${"ff".repeat(32)}` }; }],
  ["wrong block number", r => { r.sourceAttestation = { ...r.sourceAttestation!, blockNumber: SOURCE.number + 1 }; }],
  ["wrong chain", r => { r.sourceAttestation = { ...r.sourceAttestation!, chainId: 2 }; }],
  ["wrong supply token", r => { r.strict!.totalSupplyDeltas[0]!.token = TARGET; }],
  ["wrong balance actor", r => { r.strict!.tokenDeltas[1]!.account = EXECUTOR; }],
];
for (const [name, mutate] of invalidResponses) test(`${name} cannot enter Family evidence`, async () => {
  await assert.rejects(fixture(mutate).simulate(), RevmFatalError);
});

test("no-proof, runtime-code and mixed-source guards remain closed", async () => {
  const q = quote(), step = { candidate: CANDIDATE, evidence: q, step: 1 };
  assert.equal(variant.decide({ candidate: CANDIDATE, step: 0 }).status, "continue");
  assert.equal(variant.decide(step).status, "continue");
  assert.throws(() => variant.decode({ step, results: [] }));
  const value = await fixture().simulate();
  const simulation: Success = { ...returned("identity-active-deposit", value.data), effects: value.effects };
  const receipt = returned("identity-receipt-code", "0x6000");
  for (const source of [{ ...SOURCE, hash: `0x${"ff".repeat(32)}` },
    { ...SOURCE, number: SOURCE.number + 1 }, { ...SOURCE, generation: SOURCE.generation + 1 }]) {
    assert.throws(() => variant.decode({ step, results: [receipt, { ...simulation, source }] }), /foreign source/);
  }
  assert.throws(() => variant.decode({ step, results: [{ ...receipt, data: "0x" }, simulation] }), /no runtime code/);
  assert.throws(() => variant.decode({ step, results: [receipt, {
    id: "identity-active-deposit", ok: false, source: SOURCE, failure: "resource-limited",
  }] }), /unresolved/);
  assert.throws(() => variant.decide({ candidate: CANDIDATE, evidence: decode(value), step: 0 }), /before active behavior proof/);
});

test("request derives targets and amounts from evidence, not the historical nominee", async () => {
  const q = { ...quote(), target: `0x${"aa".repeat(20)}`, tokenIn: `0x${"bb".repeat(20)}`,
    tokenOut: `0x${"cc".repeat(20)}`, actor: `0x${"dd".repeat(20)}`, amountIn: 137n, amountOut: 91n };
  const f = fixture(undefined, q);
  const result = await f.simulate(request(q), { ...AUTHORITY, observedSender: q.actor });
  const wire = f.calls[0]!;
  assert.deepEqual(wire.tokenDeals, [{ token: q.tokenIn, to: q.actor, amount: "137" }]);
  assert.deepEqual(wire.preCalls, [
    { from: q.actor, to: q.tokenIn, calldata: ERC20.encodeFunctionData("approve", [q.target, q.amountIn]) },
    { from: q.actor, to: q.target, calldata: EIGENPIE_INTERFACE.encodeFunctionData(
      "depositAsset", [q.tokenIn, q.amountIn, q.amountOut, ethers.ZeroAddress],
    ) },
  ]);
  assert.deepEqual(wire.observeTokenBalances, [
    { token: q.tokenIn, account: q.actor }, { token: q.tokenOut, account: q.actor },
  ]);
  assert.deepEqual(wire.observeTotalSupply, [q.tokenOut]);
  assert.equal(verdict(decode(result, q)).status, "verified");
});

test("quote binding still rejects zero, same-token, below-minimum and changed observed output", () => {
  const q = quote();
  for (const evidence of [{ ...q, amountOut: 0n }, { ...q, tokenOut: ASSET },
    { ...q, amountOut: CANDIDATE.minAmountOut - 1n }, { ...q, amountOut: CANDIDATE.minAmountOut + 1n }]) {
    assert.equal(variant.decide({ candidate: CANDIDATE, evidence, step: 1 }).status, "chain-proven-rejected");
  }
});
