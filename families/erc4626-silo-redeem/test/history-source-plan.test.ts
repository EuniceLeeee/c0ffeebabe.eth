import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import {
  sealSourceCoverage,
  sourcePlanEvidenceRoot,
  sourcePlanExecutionRoot,
  type CanonicalCutoffV1,
  type SourcePlanRefV1,
} from "../../../packages/discovery/src/index.ts";
import {
  decodeFamilySourcePlanPhysicalObservation,
  type FamilySourcePlanExecutionResultV1,
  type FamilySourcePlanPhysicalPortV1,
  type FamilySourcePlanPhysicalRequestV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import {
  ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH,
  ERC4626_SILO_REDEEM_HISTORY_NOMINATION_PROGRAM,
  ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME,
  ERC4626_SILO_REDEEM_WITHDRAW_TOPIC,
} from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/erc4626-silo-redeem-history", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const indexedAddress = (value: string): Hash => `0x${"0".repeat(24)}${value.slice(2)}` as Hash;
const vault = address("5");
const sender = address("2");
const receiver = address("3");
const owner = address("4");
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: ERC4626_SILO_REDEEM_FAMILY_AUTHORING_HASH, completeness: "contiguous-history", historyStartBlock: "0" });
const cutoff: CanonicalCutoffV1 = Object.freeze({ chainId: "1", number: "20050", hash: h("block-20050"), stateRoot: h("state-20050") });

function withdraw(block: bigint, target = vault, data = `0x${word(10n)}${word(9n)}`): CanonicalJson {
  return Object.freeze({
    address: target,
    blockHash: h(`block-${block}`),
    blockNumber: `0x${block.toString(16)}`,
    data,
    logIndex: "0x0",
    removed: false,
    topics: Object.freeze([ERC4626_SILO_REDEEM_WITHDRAW_TOPIC, indexedAddress(sender), indexedAddress(receiver), indexedAddress(owner)]),
    transactionHash: h(`tx-${block}`),
    transactionIndex: "0x0",
  });
}

function physical(
  respond: (request: FamilySourcePlanPhysicalRequestV1, index: number) => CanonicalJson,
  mutate?: (observation: Record<string, unknown>, request: FamilySourcePlanPhysicalRequestV1, index: number) => void,
  resultEvidenceRef?: Hash,
): FamilySourcePlanPhysicalPortV1 {
  let index = 0;
  return Object.freeze({
    async request(request: FamilySourcePlanPhysicalRequestV1) {
      const response = respond(request, index);
      const requestId = h(`request-${index}`);
      const releaseBindingId = h("release-binding");
      const releaseProvenanceHash = h("release-provenance");
      const sourceAuthorityRoot = h("source-authority");
      const sourceAnchorRoot = h("source-anchor");
      const observation: Record<string, unknown> = {
        kind: "family-source-plan-physical-observation",
        version: 1,
        requestId,
        releaseBindingId,
        releaseProvenanceHash,
        sourceAuthorityRoot,
        sourceAnchorRoot,
        provider: "reth",
        backendEpoch: "epoch",
        familyDefinitionHash: request.familyDefinitionHash,
        plan: request.plan,
        cutoff: request.cutoff,
        requestSchemaHash: request.requestSchemaHash,
        request: request.request,
        response,
      };
      mutate?.(observation, request, index);
      const bytes = encodeCanonicalBytes(observation as CanonicalJson);
      const rawLocatorHash = sha256Hex(bytes);
      const evidenceRef = resultEvidenceRef ?? hashDomain("aloha/source-plan-physical-evidence/v1", { releaseBindingId, releaseProvenanceHash, sourceAuthorityRoot, sourceAnchorRoot, requestId, rawLocatorHash });
      index += 1;
      return Object.freeze({ response, rawLocatorHash, evidenceRef, rawEvidenceLocator: Object.freeze({ kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash, bytes }) });
    },
  });
}

function recent(value: CanonicalCutoffV1): ReturnType<typeof sealRecentObservation> {
  const from = BigInt(value.number) - 49n;
  const blocks = [];
  let parentHash = h(`block-${from - 1n}`);
  for (let number = from; number <= BigInt(value.number); number += 1n) {
    const hash = number === BigInt(value.number) ? value.hash : h(`recent-${number}`);
    blocks.push({ number: number.toString(), hash, parentHash, evidence: [] });
    parentHash = hash;
  }
  return sealRecentObservation(value, { from: from.toString(), to: value.number }, blocks, []);
}

function rawPort(result: FamilySourcePlanExecutionResultV1) {
  const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  return Object.freeze({ read(hash: Hash): Uint8Array { const bytes = raw.get(hash); if (bytes === undefined) throw new Error("missing raw evidence"); return bytes; } });
}

function predecessor(result: FamilySourcePlanExecutionResultV1) {
  return Object.freeze({ persistedExecutionRoot: h(`persisted-${result.execution.through}`), execution: result.execution, sourceEvidence: result.sourceEvidence, rawEvidence: rawPort(result) });
}

test("Silo Withdraw history scans the exact 10,000-block grid and nominates outside the empty recent window", async () => {
  const ranges: CanonicalJson[] = [];
  const result = await ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    physical((request, index) => {
      ranges.push(request.request.lookback);
      if (index === 0) return [withdraw(5n)];
      if (index === 1) return [
        withdraw(15_000n, address("8"), `0x${word(0n)}${word(9n)}`),
        withdraw(15_001n, address("9"), `0x${word(10n)}${word(0n)}`),
        withdraw(15_002n, address("7"), "0x"),
      ];
      return [];
    }),
    new AbortController().signal,
  );
  assert.deepEqual(ranges, [{ from: "0", through: "9999" }, { from: "10000", through: "19999" }, { from: "20000", through: "20050" }]);
  assert.equal(result.rawEvidenceLocators.length, 3);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]?.contributesOmissionAuthority, true);
  const nominations = await ERC4626_SILO_REDEEM_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(cutoff), rawEvidence: rawPort(result) }, new AbortController().signal);
  assert.deepEqual(nominations.map(value => value.instanceNominationKey), [vault, address("8"), address("9")]);
});

test("Silo Withdraw history successor scans only the delta and retains predecessor inventory", async () => {
  const firstCutoff = Object.freeze({ chainId: "1", number: "99", hash: h("block-99"), stateRoot: h("state-99") });
  const first = await ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: firstCutoff, previousAppliedThrough: null }, physical(() => [withdraw(95n)]), new AbortController().signal);
  const nextCutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block-100"), stateRoot: h("state-100") });
  const ranges: CanonicalJson[] = [];
  const next = await ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff: nextCutoff, previousAppliedThrough: "99", predecessor: predecessor(first) },
    physical(request => { ranges.push(request.request.lookback); return []; }),
    new AbortController().signal,
  );
  assert.deepEqual(ranges, [{ from: "100", through: "100" }]);
  assert.equal(next.execution.from, "100");
  assert.equal(sealSourceCoverage(nextCutoff, [plan], [next.execution]).entries[0]?.contributesOmissionAuthority, true);
  const nominations = await ERC4626_SILO_REDEEM_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: next.execution, sourceEvidence: next.sourceEvidence, recent: recent(nextCutoff), rawEvidence: rawPort(next) }, new AbortController().signal);
  assert.deepEqual(nominations.map(value => value.instanceNominationKey), [vault]);
  await assert.rejects(() => ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: nextCutoff, previousAppliedThrough: "99" }, physical(() => []), new AbortController().signal), /durable predecessor/);
});

test("Silo Withdraw history rejects physical binding, evidence, order and range mutations", async () => {
  await assert.rejects(() => ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "1" }, previousAppliedThrough: null }, physical(() => [], (observation, request) => { observation.request = { ...request.request, params: [{ fromBlock: "0x1", toBlock: "0x1", topics: [ERC4626_SILO_REDEEM_WITHDRAW_TOPIC] }] }; }), new AbortController().signal), /binding mismatch/);
  await assert.rejects(() => ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "1" }, previousAppliedThrough: null }, physical(() => [], undefined, h("forged-evidence")), new AbortController().signal), /binding mismatch/);
  await assert.rejects(() => ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "10" }, previousAppliedThrough: null }, physical(() => [withdraw(5n), withdraw(4n)]), new AbortController().signal), /strict chain order/);
  await assert.rejects(() => ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "10" }, previousAppliedThrough: null }, physical(() => [withdraw(11n)]), new AbortController().signal), /outside requested range/);
  const forged: FamilySourcePlanPhysicalPortV1 = Object.freeze({ async request(request: FamilySourcePlanPhysicalRequestV1) { const response: CanonicalJson = []; const bytes = encodeCanonicalBytes({ kind: "family-source-plan-physical-observation", version: 1, requestId: h("forged"), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response }); return { response, rawLocatorHash: h("wrong"), evidenceRef: h("evidence"), rawEvidenceLocator: { kind: "raw-evidence-locator" as const, version: 1 as const, rawLocatorHash: h("wrong"), bytes } }; } });
  await assert.rejects(() => ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "1" }, previousAppliedThrough: null }, forged, new AbortController().signal), /raw locator mismatch/);
});

test("Silo Withdraw history rejects a self-consistent missing-chunk splice", async () => {
  const result = await ERC4626_SILO_REDEEM_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical(() => []), new AbortController().signal);
  const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const refs = result.sourceEvidence.refs.filter(ref => {
    const observation = decodeFamilySourcePlanPhysicalObservation(raw.get(ref.rawLocatorHash)!);
    return (observation.request.lookback as { readonly from: string }).from !== "10000";
  });
  const rawLocatorHashes = refs.map(ref => ref.rawLocatorHash).sort();
  const evidenceRoot = sourcePlanEvidenceRoot({ plan: result.sourceEvidence.plan, cutoff: result.sourceEvidence.cutoff, refs, rawLocatorHashes });
  const sourceEvidence = Object.freeze({ ...result.sourceEvidence, refs, rawLocatorHashes, evidenceRoot });
  const { executionRoot: _discarded, ...executionWithoutRoot } = result.execution;
  const forgedWithoutRoot = Object.freeze({ ...executionWithoutRoot, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: evidenceRoot });
  const execution = Object.freeze({ ...forgedWithoutRoot, executionRoot: sourcePlanExecutionRoot(forgedWithoutRoot) });
  await assert.rejects(() => ERC4626_SILO_REDEEM_HISTORY_NOMINATION_PROGRAM.evaluate({ execution, sourceEvidence, recent: recent(cutoff), rawEvidence: { read(hash) { return raw.get(hash)!; } } }, new AbortController().signal), /coverage gap/);
});
