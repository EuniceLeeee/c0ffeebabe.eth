import assert from "node:assert/strict";
import test from "node:test";
import { keccak256 } from "ethers";
import { executeAdapterWork } from "../adapter-work-intent.js";
import { createReadyProofSimulation } from "../ready-proof-simulation.js";
import { RevmStrictError, type DaemonResponse, type StrictSimulateRequest } from "../revm-sim-client.js";
import { createRevmStrictSourceSimulation } from "../revm-strict-source-simulation.js";
import { createStrictCentralAdapterRuntime, type StrictSimulationTransport } from "../strict-central-adapter-runtime.js";

const source = { number: 700, hash: `0x${"a1".repeat(32)}`, generation: 9 };
const executor = `0x${"11".repeat(20)}`, owner = `0x${"22".repeat(20)}`;
const actor = `0x${"33".repeat(20)}`, secondActor = `0x${"44".repeat(20)}`, target = `0x${"55".repeat(20)}`;
const code = { code: "0x60006000", keccak256: keccak256("0x60006000") };
type Invocation = Parameters<StrictSimulationTransport["simulate"]>[0];
function invocation(role = "proof", boundExecutor = executor): Invocation {
  const caller = role === "executor" ? { kind: "executor" as const } : { kind: "verified-actor" as const, evidenceId: role };
  return { source, callerAuthority: { executor: boundExecutor, transactionOrigin: owner, verifiedActors: { proof: actor, second: secondActor } },
    request: { id: "actor-proof", required: true, kind: "effect-delta-simulation",
      call: { caller, executionMode: "impersonated-call-frame", to: target, data: "0x1234" },
      overrideIntent: { caller }, observe: ["return-data"] } };
}
function harness(options: {
  boundExecutor?: string; actorCode?: string; runtimeCode?: typeof code; missingCode?: boolean;
  readCode?: () => Promise<string>;
} = {}) {
  const boundExecutor = options.boundExecutor ?? executor, runtimeCode = options.runtimeCode ?? code;
  const dispatched: { configured: string; request: StrictSimulateRequest }[] = [], created: { actor: string; override: boolean }[] = [];
  const reads: { actor: string; source: typeof source }[] = [], drained: string[] = [];
  function frame(configured: string, override: boolean) {
    return createRevmStrictSourceSimulation({
      identity: { source, rpcUrl: "http://127.0.0.1:1", chainId: 1 }, executionGasLimit: 100_000,
      executorRuntimeCode: runtimeCode, ...(override ? { preserveExecutorCode: false, provisionedExecutor: configured } : {}),
      onFatal(reason) { assert.fail(JSON.stringify(reason)); },
      createClient() {
        return { isTerminal: false, async closeAndDrain() { drained.push(configured); },
          async strictSimulate(request): Promise<DaemonResponse> {
            if (request.from !== configured) throw new RevmStrictError("validation", "node frame requires configured deployed executor and distinct origin");
            dispatched.push({ configured, request });
            return { ok: true, success: true, output: "0xbeef", gasUsed: "1", latencyMs: 0,
              sourceAttestation: { kind: "node-attested", chainId: 1, blockNumber: source.number,
                blockHash: source.hash, parentHash: `0x${"b1".repeat(32)}`, stateRoot: `0x${"c1".repeat(32)}` },
              strict: { outcome: { kind: "Success", phase: "main", output: "0xbeef" }, executionGasUsed: "1",
                ...(override ? { counterfactualExecutorCode: { address: configured, keccak256: runtimeCode.keccak256 } } : {}),
                tokenDeltas: [], nativeDeltas: [], totalSupplyDeltas: [], logs: [] } };
          } };
      },
    });
  }
  const primary = frame(boundExecutor, false);
  const simulation = createReadyProofSimulation({ source, executor: boundExecutor, transactionOrigin: owner,
    verifiedActors: { proof: actor, second: secondActor }, primary, assertOpen() {},
    ...(options.missingCode ? {} : { executorRuntimeCode: runtimeCode }),
    async readCode(address, at) { reads.push({ actor: address, source: { ...at } }); return options.readCode ? options.readCode() : options.actorCode ?? "0x"; },
    createProof(address, actualCode, override) { assert.deepEqual(actualCode, runtimeCode); created.push({ actor: address, override }); return frame(address, override); },
  });
  async function run(inv = invocation("proof", boundExecutor)) {
    const runtime = createStrictCentralAdapterRuntime({ executor: boundExecutor, transactionOrigin: owner,
      verifiedActors: { proof: actor, second: secondActor }, simulator: simulation.transport,
      provider: { call: async () => assert.fail("no provider call"), getCode: async () => assert.fail("no provider code"), getStorage: async () => assert.fail("no provider storage") },
      generationFence: { assertCurrent(generation, actual) { assert.equal(generation, source.generation); assert.deepEqual(actual, source); } },
    });
    return executeAdapterWork({ runtime, control: inv.control, intent: {
      stage: "runtime-evidence", familyId: "test:ready-proof" as never, source: inv.source, generation: inv.source.generation, programInput: undefined,
      program: { requirements: () => ({ transports: [inv.request.kind], caller: inv.request.call.caller.kind, effects: inv.request.observe }),
        buildRequests: () => [inv.request], decode: ({ results }) => results },
    } });
  }
  return { primary, simulation, created, reads, dispatched, drained, run };
}

test("Ready proof actor uses its own strict frame, while ordinary execution keeps the configured executor", async () => {
  for (const boundExecutor of [executor, `0x${"66".repeat(20)}`]) {
    const h = harness({ boundExecutor });
    try {
      await assert.rejects(h.primary.transport.simulate(invocation("proof", boundExecutor)), /strict simulation transport failed/,
        "the original single-executor wiring rejects the same declared proof actor");
      const proof = await h.run(); assert.equal(proof.status, "resolved");
      if (proof.status === "resolved") { assert(proof.executed.evidence[0]?.ok); assert.equal(proof.executed.evidence[0].data, "0xbeef"); }
      const actual = await h.run(invocation("executor", boundExecutor)); assert.equal(actual.status, "resolved");
      const again = await h.run(); assert.equal(again.status, "resolved");
      assert.deepEqual(h.created, [{ actor, override: true }]);
      assert.deepEqual(h.reads, [{ actor, source }]);
      assert.deepEqual(h.dispatched.map(row => [row.configured, row.request.from, row.request.transactionOrigin]),
        [[actor, actor, owner], [boundExecutor, boundExecutor, owner], [actor, actor, owner]]);
      assert(h.dispatched.every(row => row.request.blockNumber === source.number && row.request.sourcePin?.blockHash === source.hash));
    } finally { await h.simulation.closeAndDrain(); }
    assert.deepEqual(h.drained.sort(), [actor, boundExecutor].sort());
  }
});

test("proof evidence binds the selected actor and its trusted code capability", async () => {
  const fingerprints: string[] = [];
  for (const runtimeCode of [code, { code: "0x60016000", keccak256: keccak256("0x60016000") }]) {
    const h = harness({ runtimeCode });
    try {
      for (const role of ["proof", "second"]) {
        const result = await h.run(invocation(role)); assert.equal(result.status, "resolved");
        if (result.status === "resolved") { const receipt = result.executed.evidence[0]; assert(receipt?.ok); fingerprints.push(receipt.provenance.fingerprint); }
      }
    } finally { await h.simulation.closeAndDrain(); }
  }
  assert.equal(new Set(fingerprints).size, 4, "neither a different actor nor different injected runtime can reuse evidence");
});

test("occupied actors and missing trusted code fail as configuration/authority gaps before proof dispatch", async () => {
  for (const options of [{ actorCode: "0x6001" }, { missingCode: true }]) {
    const h = harness(options);
    try {
      const result = await h.run(); assert.equal(result.status, "unresolved");
      if (result.status === "unresolved") {
        assert.equal(result.failure.code, "aborted");
        assert(!JSON.stringify(result.failure).includes("resource-limited"));
      }
      assert.equal(h.created.length, 0); assert.equal(h.dispatched.length, 0);
    } finally { await h.simulation.closeAndDrain(); }
  }
  const matching = harness({ actorCode: code.code });
  try { assert.equal((await matching.run()).status, "resolved"); assert.deepEqual(matching.created, [{ actor, override: false }]); }
  finally { await matching.simulation.closeAndDrain(); }
});

test("selection rejects unsealed actors, authority changes, and another source before code reads", async () => {
  const h = harness();
  try {
    const base = invocation();
    for (const invalid of [
      { ...base, source: { ...source, generation: source.generation + 1 } },
      { ...base, source: { ...source, hash: `0x${"dd".repeat(32)}` } },
      { ...base, callerAuthority: { ...base.callerAuthority, executor: secondActor } },
      { ...base, callerAuthority: { ...base.callerAuthority, transactionOrigin: secondActor } },
      { ...base, callerAuthority: { ...base.callerAuthority, verifiedActors: { proof: secondActor } } },
      invocation("unregistered"),
    ]) await assert.rejects(h.simulation.transport.forRequest!(invalid), RevmStrictError);
    assert.equal(h.reads.length, 0); assert.equal(h.created.length, 0);
    const top = { ...base, request: { ...base.request, call: { ...base.request.call, executionMode: "top-level" as const } } };
    assert.equal(await h.simulation.transport.forRequest!(top), h.primary.transport, "top-level semantics are unchanged");
    assert.equal(h.reads.length, 0);
  } finally { await h.simulation.closeAndDrain(); }
});

test("simultaneous proof requests share preparation; cancelled caller cannot poison another waiter", async () => {
  let release!: (value: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; });
  const h = harness({ readCode: () => gate }), controller = new AbortController();
  const first = h.simulation.transport.forRequest!({ ...invocation(), control: { signal: controller.signal } });
  const second = h.simulation.transport.forRequest!(invocation());
  await Promise.resolve(); controller.abort(); release("0x");
  await assert.rejects(first, /cancelled/);
  const chosen = await second; assert.equal(chosen.counterfactualExecutorCode?.address, actor);
  assert.equal(h.reads.length, 1); assert.equal(h.created.length, 1);
  await h.simulation.closeAndDrain();
  await assert.rejects(h.simulation.transport.forRequest!(invocation()), /closed/);
});

test("source retirement joins pending preparation without creating a late proof context", async () => {
  let release!: (value: string) => void;
  const gate = new Promise<string>(resolve => { release = resolve; }), h = harness({ readCode: () => gate });
  const selected = h.simulation.transport.forRequest!(invocation());
  const rejected = assert.rejects(selected, /closed/);
  await Promise.resolve();
  let settled = false;
  const drain = h.simulation.closeAndDrain().then(() => { settled = true; });
  await Promise.resolve(); assert.equal(settled, false);
  release("0x"); await Promise.all([rejected, drain]);
  assert.equal(h.created.length, 0); assert.equal(h.dispatched.length, 0);
});
