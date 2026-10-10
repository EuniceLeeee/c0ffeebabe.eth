import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { createTxEvidenceNomination, matchCalls } from "../venues/tx-evidence-nomination.js";
import type { CallPattern, CaptureNominationProvider, LogPattern } from "../venues/adapter-family-plugin.js";
import { createBoundedRequestExecutor, type AdapterRequest, type AdapterRequestResult } from "../venues/adapter-request-program.js";
import type { CentralAdapterRuntime } from "../adapter-work-intent.js";
import { attestPoolIdentitiesStrict, mergeStartupFamilyPublications } from "../strict-identity-attestation.js";
import { executeCatalogCaptureNominations } from "../venues/capture-materialization.js";
import type { FamilyCapabilityCatalog } from "../venues/family-capability-catalog.js";
import { PRODUCTION_STRICT_SHADOW_FAMILY_CAPABILITY_CATALOG as productionCatalog } from "../venues/production-family-composition.js";
import { ASTRA_MULTITOKEN_INTERFACE as astraAbi, ASTRA_ERC20_INTERFACE as tokenAbi } from "../venues/protocols/astra-multitoken-family/codec.js";

const A = ethers.getAddress("0x00000000000000000000000000000000000000a1");
const B = ethers.getAddress("0x00000000000000000000000000000000000000b2");
const ENTRY = `0x${"33".repeat(20)}`;
const ACTOR = `0x${"44".repeat(20)}`;
const TOKENS = [`0x${"55".repeat(20)}`, `0x${"66".repeat(20)}`];
const TX = `0x${"77".repeat(32)}`;
const SOURCE = { number: 100, hash: `0x${"88".repeat(32)}`, generation: 100 };
const ABI = new ethers.Interface([
  "event Changed(uint256 amount)",
  "event Routed(address indexed pool, uint256 amount)",
  "event Shared(bytes32 indexed poolId, uint256 amount)",
  "function change(uint256 amount)",
  "function route(address pool, uint256 amount)",
]);
const CALL: CallPattern = { id: "change", selector: ABI.getFunction("change")!.selector as `0x${string}`,
  signature: "change(uint256)", candidateAddress: { from: "call-target" } };
const LOG: LogPattern = { id: "changed", topic: ABI.getEvent("Changed")!.topicHash as `0x${string}`,
  signature: "Changed(uint256)" };
type ReceiptLog = NonNullable<Awaited<ReturnType<CaptureNominationProvider["getTransactionReceipt"]>>>["logs"][number];

function log(address: string, name = "Changed", args: readonly unknown[] = [1n]): ReceiptLog {
  return { address, ...ABI.encodeEventLog(ABI.getEvent(name)!, [...args]), transactionHash: TX };
}
function call(to: string, name = "change", args: readonly unknown[] = [1n]) {
  return { to, from: ACTOR, input: ABI.encodeFunctionData(name, [...args]) };
}
function provider(logs: readonly ReceiptLog[], trace: unknown = { calls: [] }): CaptureNominationProvider {
  return {
    call: async () => assert.fail("unexpected RPC call"),
    getCode: async () => "0x60006000",
    getStorage: async () => assert.fail("unexpected storage read"),
    getLogs: async () => assert.fail("unexpected history scan"),
    getTransactionReceipt: async hash => {
      assert.equal(hash, TX);
      return { blockNumber: SOURCE.number, logs };
    },
    traceTransaction: async hash => { assert.equal(hash, TX); return trace; },
  };
}
const nomination = (address: string, opaque: Record<string, string> = {}) =>
  ({ address, opaque: { adapter: "fixture", transactionHash: TX, ...opaque } });
const helper = createTxEvidenceNomination({ opaqueLabels: ["fixture"], callPatterns: [CALL], logPatterns: [LOG] });

test("bound receipt nominations are independent of receipt and candidate order", async () => {
  for (const addresses of [[A, B], [B, A]]) {
    for (const nominees of [[A, B], [B, A]]) {
      const observations = await helper.nominate({ source: SOURCE, provider: provider(addresses.map(a => log(a))),
        nominations: nominees.map(address => nomination(address.toLowerCase())) });
      assert.deepEqual(observations.map(o => o.kind === "log" && o.address), nominees.map(a => a.toLowerCase()));
    }
  }
});

test("foreign-only receipt and trace cannot replace the nominated target", async () => {
  const observations = await helper.nominate({ source: SOURCE, provider: provider([log(A)], { calls: [call(A)] }),
    nominations: [nomination(B)] });
  assert.deepEqual(observations, []);
});

test("trace binding searches nested frames, including below a foreign matching parent", async () => {
  for (const targets of [[A, B], [B, A]]) {
    const trace = { ...call(A), calls: [{ to: ENTRY, input: "0x", calls: targets.map(a => call(a)) }] };
    for (const target of [A, B]) {
      const observations = await helper.nominate({ source: SOURCE, provider: provider([], trace), nominations: [nomination(target)] });
      assert.equal(observations.length, 1);
      assert.equal(observations[0].kind === "call" && observations[0].target, target.toLowerCase());
    }
  }
});

test("foreign logs may fall through only to the nominated trace target", async () => {
  const observations = await helper.nominate({ source: SOURCE, provider: provider([log(A)], { calls: [call(A), call(B)] }),
    nominations: [nomination(B)] });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].kind, "call");
  assert.equal(observations[0].kind === "call" && observations[0].target, B.toLowerCase());
});

test("failed trace targets and ancestors cannot nominate their matching descendants", async () => {
  for (const trace of [
    { ...call(B), error: "reverted" },
    { to: ENTRY, input: "0x", error: "reverted", calls: [call(B)] },
    { to: ENTRY, input: "0x", revertReason: "denied", calls: [call(B)] },
  ]) {
    assert.deepEqual(await helper.nominate({ source: SOURCE, provider: provider([], trace), nominations: [nomination(B)] }), []);
  }
  const actual = await helper.nominate({ source: SOURCE,
    provider: provider([], { calls: [{ ...call(B), error: "reverted" }, call(B)] }), nominations: [nomination(B)] });
  assert.equal(actual.length, 1, "a successful sibling remains discoverable");
});

test("same-target duplicates retain evidence and do not borrow other targets", async () => {
  const observations = await helper.nominate({ source: SOURCE, provider: provider([log(B), log(A), log(A)]),
    nominations: [nomination(A), nomination(A.toLowerCase())] });
  assert.equal(observations.length, 2);
  assert(observations.every(o => o.kind === "log" && o.address === A.toLowerCase()));
});

test("unbound TX seeds keep natural first-match discovery", async () => {
  for (const address of ["", ethers.ZeroAddress]) {
    const logs = await helper.nominate({ source: SOURCE, provider: provider([log(B), log(A)]), nominations: [nomination(address)] });
    assert.equal(logs[0].kind === "log" && logs[0].address, B.toLowerCase());
    const calls = await helper.nominate({ source: SOURCE, provider: provider([], { calls: [call(B), call(A)] }), nominations: [nomination(address)] });
    assert.equal(calls[0].kind === "call" && calls[0].target, B.toLowerCase());
  }
  assert.equal(matchCalls([CALL], { calls: [call(B), call(A)] })?.target, B,
    "the existing unbound call-seed scanner contract is unchanged");
});

test("malformed address bindings fail closed instead of becoming unbound seeds", async () => {
  assert.deepEqual(await helper.nominate({ source: SOURCE, provider: provider([log(A)]), nominations: [nomination("not-an-address")] }), []);
});

test("shared call entrypoint binds the declared address argument, not call.to", async () => {
  const routed: CallPattern = { id: "route", selector: ABI.getFunction("route")!.selector as `0x${string}`,
    signature: "route(address,uint256)", candidateAddress: { from: "argument", index: 0 } };
  const nominate = createTxEvidenceNomination({ opaqueLabels: ["fixture"], callPatterns: [routed] });
  for (const addresses of [[A, B], [B, A]]) {
    const observations = await nominate.nominate({ source: SOURCE,
      provider: provider([], { calls: [{ to: ENTRY, input: routed.selector }, ...addresses.map(a => call(ENTRY, "route", [a, 1n]))] }),
      nominations: [nomination(B)] });
    assert.equal(observations.length, 1);
    const observation = observations[0];
    assert.equal(observation.kind, "call");
    if (observation.kind !== "call") assert.fail();
    assert.equal(observation.target, ENTRY);
    assert.equal(ABI.decodeFunctionData("route", observation.data)[0], B);
  }
  assert.deepEqual(await nominate.nominate({ source: SOURCE, provider: provider([], call(ENTRY, "route", [A, 1n])), nominations: [nomination(B)] }), []);
});

test("singleton log emitter binds its indexed logical address", async () => {
  const pattern: LogPattern = { id: "routed", topic: ABI.getEvent("Routed")!.topicHash as `0x${string}`,
    signature: "Routed(address,uint256)", emitter: { mode: "singleton-indexed-address", address: ENTRY, topicIndex: 1, fromBlock: 0 } };
  const nominate = createTxEvidenceNomination({ opaqueLabels: ["fixture"], logPatterns: [pattern] });
  for (const addresses of [[A, B], [B, A]]) {
    const observations = await nominate.nominate({ source: SOURCE, provider: provider(addresses.map(a => log(ENTRY, "Routed", [a, 1n]))),
      nominations: [nomination(B)] });
    assert.equal(observations.length, 1);
    const observation = observations[0];
    assert.equal(observation.kind === "log" && observation.address, ENTRY);
    assert.equal(observation.kind === "log" && observation.topics[1], ethers.zeroPadValue(B, 32).toLowerCase());
  }
  for (const logs of [[log(ENTRY, "Routed", [A, 1n])], [log(A, "Routed", [B, 1n])]]) {
    assert.deepEqual(await nominate.nominate({ source: SOURCE, provider: provider(logs), nominations: [nomination(B)] }), []);
  }
});

test("shared bytes32 instances remain distinct behind one public emitter", async () => {
  const ids = [`0x${"aa".repeat(32)}`, `0x${"bb".repeat(32)}`];
  const pattern: LogPattern = { id: "shared", topic: ABI.getEvent("Shared")!.topicHash as `0x${string}`,
    signature: "Shared(bytes32,uint256)", emitter: { mode: "singleton-indexed-bytes32", address: ENTRY, topicIndex: 1, fromBlock: 0 } };
  const nominate = createTxEvidenceNomination({ opaqueLabels: ["fixture"], logPatterns: [pattern], callPatterns: [CALL] });
  for (const order of [ids, [...ids].reverse()]) {
    const observations = await nominate.nominate({ source: SOURCE, provider: provider(order.map(id => log(ENTRY, "Shared", [id, 1n]))),
      nominations: ids.map(poolId => nomination(ENTRY, { poolId })) });
    assert.deepEqual(observations.map(o => o.kind === "log" && o.topics[1]), ids);
    assert(observations.every(o => o.kind === "log" && o.address === ENTRY));
  }
  assert.deepEqual(await nominate.nominate({ source: SOURCE, provider: provider([log(ENTRY, "Shared", [ids[0], 1n])]),
    nominations: [nomination(ENTRY, { poolId: ids[1] })] }), []);
  assert.deepEqual(await nominate.nominate({ source: SOURCE, provider: provider([], call(ENTRY)),
    nominations: [nomination(ENTRY, { poolId: ids[1] })] }), [],
    "an address-only call cannot prove a missing bytes32 instance");
  for (const receiptLogs of [[], ids.map(id => log(ENTRY, "Shared", [id, 1n]))]) {
    assert.deepEqual(await nominate.nominate({ source: SOURCE, provider: provider(receiptLogs, call(ENTRY)),
      nominations: [nomination(ENTRY)] }), [],
      "a bound shared entrypoint without poolId must not select a sibling log or address-only trace");
    assert.deepEqual(await nominate.nominate({ source: SOURCE, provider: provider(receiptLogs, call(ENTRY)),
      nominations: [nomination(ENTRY, { poolId: "malformed" })] }), []);
  }
  const seed = await nominate.nominate({ source: SOURCE, provider: provider([log(ENTRY, "Shared", [ids[0], 1n])]),
    nominations: [nomination("")] });
  assert.equal(seed.length, 1);
  assert.equal(seed[0].kind === "log" && seed[0].topics[1], ids[0]);
});

// Real installed discovery, identity, instance, and publication code. Only the
// state/simulation transport below is a deterministic fixture, NOT historical EVM.
const FAMILY = "protocol:astra-multitoken";
const family = productionCatalog.forStrictFamily(FAMILY as never);
const catalog = {
  listAll: () => [family],
  matches: observation => productionCatalog.matches(observation).filter(m => m.familyId === FAMILY),
  forStrictFamily: id => productionCatalog.forStrictFamily(id),
  ownerOfPoolAdapter: id => productionCatalog.ownerOfPoolAdapter(id),
  ownerOfAction: id => productionCatalog.ownerOfAction(id),
} as FamilyCapabilityCatalog;
const astraLog = (target: string): ReceiptLog => ({ address: target, transactionHash: TX,
  ...astraAbi.encodeEventLog(astraAbi.getEvent("Change")!, [TOKENS[0], TOKENS[1], ACTOR, 10n, 20n]) });
const astraCall = (target: string) => ({ to: target, from: ACTOR,
  input: astraAbi.encodeFunctionData("change", [TOKENS[0], TOKENS[1], 10n, 20n]) });
const pool = (address: string) => ({ address, adapter: "astra-multitoken", transactionHash: TX });

function runtime(): CentralAdapterRuntime {
  return {
    clock: { nowMs: () => 1_000 }, generationFence: { assertCurrent() {} },
    callerAuthority: { bind: () => ({ executor: ACTOR, observedSender: ACTOR, verifiedActors: {} }) },
    policy: { bind: input => ({ lane: input.stage === "identity" ? "critical-proof" : "foreground",
      deadlineAtMs: 99_999, maxAttempts: 1, transportPool: "state-read", fairnessKey: input.subjectKey }) },
    budgets: { assertAdmitted() {} },
    scheduler: { issueExecutor: input => ({
      executor: createBoundedRequestExecutor({
        assertSupported: requirements => assert.deepEqual(requirements, input.requirements),
        assertCallerBinding() {},
        assertWithinBudget: (id, requests) => { assert.equal(id, input.subject.familyId); assert.deepEqual(requests, input.requests); },
        execute: async execution => execution.requests.map(request => fixtureResult(request)),
        sealStaticEvidenceReuseProof: () => ({ proofHash: "ab".repeat(32) }),
      }),
      timing: () => ({ queueWaitMs: 0, transportWallMs: 1, attempts: 1 }),
    }) },
  };
}

function fixtureResult(request: AdapterRequest): AdapterRequestResult {
  const base = { id: request.id, ok: true as const, source: SOURCE,
    provenance: { kind: "tx-nomination-offline-fixture", fingerprint: "v1" }, completion: "returned" as const };
  if (request.kind === "get-code") return { ...base, data: "0x60006000" };
  if (request.kind === "eth-call") {
    if (TOKENS.includes(request.to)) return { ...base, data: tokenAbi.encodeFunctionResult("decimals", [18]) };
    assert([A, B].includes(ethers.getAddress(request.to)));
    const parsed = astraAbi.parseTransaction({ data: request.data });
    assert(parsed);
    const args = Array.from(parsed.args);
    const values: Record<string, readonly unknown[]> = {
      supportsInterface: [true], inLendingMode: [0n], tokensCount: [2n], changesEnabled: [true], changeFee: [0n], TOTAL_PERCRENTS: [1_000_000n],
      tokens: [TOKENS[Number(args[0])]], weights: [1n], getReturn: [BigInt(args[2] ?? 0) * 2n],
    };
    assert(values[parsed.name], `unexpected fixture request ${parsed.name}`);
    return { ...base, data: astraAbi.encodeFunctionResult(parsed.name, values[parsed.name]) };
  }
  assert.equal(request.kind, "effect-delta-simulation");
  if (request.kind !== "effect-delta-simulation") assert.fail("unexpected fixture request");
  const target = ethers.getAddress(request.call.to);
  assert([A, B].includes(target));
  const [tokenIn, tokenOut, amountIn] = astraAbi.decodeFunctionData("change", request.call.data);
  const output = BigInt(amountIn) * 2n;
  return { ...base, data: astraAbi.encodeFunctionResult("change", [output]), effects: {
    tokenDeltas: [
      { token: tokenIn, account: ACTOR, delta: -BigInt(amountIn) }, { token: tokenIn, account: target, delta: BigInt(amountIn) },
      { token: tokenOut, account: target, delta: -output }, { token: tokenOut, account: ACTOR, delta: output },
    ],
    logs: [{ address: target, ...astraAbi.encodeEventLog(astraAbi.getEvent("Change")!, [tokenIn, tokenOut, ACTOR, amountIn, output]) }],
  } };
}

test("production single-target fixture reaches a verified publication", async () => {
  const result = await attestPoolIdentitiesStrict({ catalog, source: SOURCE, provider: provider([astraLog(B)]), runtime: runtime(), pools: [pool(B)] });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.publications[0]?.instances[0].instanceKey, B.toLowerCase());
});

test("production nomination -> strict identity -> publication keeps each target (receipt and trace)", async () => {
  for (const mode of ["receipt", "trace"]) {
    for (const targets of [[A, B], [B, A]]) {
      for (const nominees of [[A, B], [B, A]]) {
        // Reuse one provider, as production does across per-candidate calls.
        const io = provider(mode === "receipt" ? targets.map(astraLog) : [], { calls: targets.map(astraCall) });
        const publications = [];
        for (const target of nominees) {
          const observations = await executeCatalogCaptureNominations({ catalog, source: SOURCE, provider: io,
            nominations: [{ address: target, opaque: pool(target) }] });
          assert.equal(observations.length, 1);
          const result = await attestPoolIdentitiesStrict({ catalog, source: SOURCE, provider: io, runtime: runtime(), pools: [pool(target)] });
          assert.deepEqual(result.rejected, []);
          assert.equal(result.accepted.length, 1);
          assert.equal(result.accepted[0].subject, target);
          const publication = result.publications[0];
          assert(publication);
          assert.equal(publication.instances.length, 1);
          const instance = publication.instances[0];
          assert.equal(instance.instanceKey, target.toLowerCase());
          assert.equal((instance.descriptor as { target: string }).target, target);
          assert(publication.outcomes.some(o => o.stage === "identity" && o.status === "verified" && o.candidateKey.startsWith(target.toLowerCase())));
          publications.push(publication);
        }
        assert.equal(mergeStartupFamilyPublications(publications)[0].publication.instances.length, 2);
      }
    }
  }
});

test("production attestation keeps missing-B evidence rejected, never publishes A for B", async () => {
  for (const logs of [[astraLog(A)], []]) {
    const result = await attestPoolIdentitiesStrict({ catalog, source: SOURCE, provider: provider(logs, { calls: [astraCall(A)] }),
      runtime: runtime(), pools: [pool(B)] });
    assert.deepEqual(result.accepted, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, "no_catalog_match");
    assert(result.publications.every(p => p === null));
  }
});

test("production same-target observations still merge to one instance", async () => {
  const io = provider([astraLog(B), astraLog(A), astraLog(A)]);
  const result = await attestPoolIdentitiesStrict({ catalog, source: SOURCE, provider: io, runtime: runtime(), pools: [pool(A), pool(A)] });
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted.length, 2);
  const instances = mergeStartupFamilyPublications(result.publications)[0].publication.instances;
  assert.equal(instances.length, 1);
  assert.equal(instances[0].instanceKey, A.toLowerCase());
});
