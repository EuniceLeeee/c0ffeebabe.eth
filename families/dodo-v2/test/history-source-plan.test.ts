import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { sealSourceCoverage, sourcePlanEvidenceRoot, sourcePlanExecutionRoot, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type {
  FamilySourcePlanPhysicalPortV1,
  FamilySourcePlanPhysicalRequestV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import { DODO_V2_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import {
  DODO_V2_FACTORIES,
  DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
} from "../src/manifest.ts";
import {
  DODO_V2_HISTORY_NOMINATION_PROGRAM,
  DODO_V2_HISTORY_SOURCE_PLAN_RUNTIME,
} from "../src/history-source-plan.ts";

const h = (value: string): Hash => hashDomain("test/dodo-history", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const addressWord = (value: string): string => `${"0".repeat(24)}${value.slice(2)}`;
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH, completeness: "contiguous-history", historyStartBlock: "0" });
const cutoff = Object.freeze({ chainId: "1", number: "10000", hash: h("block"), stateRoot: h("state") });

function recent() {
  const blocks = [];
  let parentHash = h("parent");
  for (let number = 9951n; number <= 10000n; number += 1n) {
    const hash = number === 10000n ? cutoff.hash : h(`b-${number}`);
    blocks.push({ number: number.toString(), hash, parentHash, evidence: [] });
    parentHash = hash;
  }
  return sealRecentObservation(cutoff, { from: "9951", to: "10000" }, blocks, []);
}

function creation(factoryIndex: number, block: bigint, pool: string): CanonicalJson {
  const declaration = DODO_V2_FACTORIES[factoryIndex]!;
  return Object.freeze({
    address: declaration.address,
    blockHash: h(`log-block-${factoryIndex}-${block}`),
    blockNumber: `0x${block.toString(16)}`,
    data: `0x${addressWord(address("1"))}${addressWord(address("2"))}${addressWord(address("3"))}${addressWord(pool)}`,
    logIndex: "0x0",
    removed: false,
    topics: Object.freeze([declaration.creationTopic]),
    transactionHash: h(`tx-${factoryIndex}-${block}`),
    transactionIndex: "0x0",
  });
}

function physical(
  respond: (request: FamilySourcePlanPhysicalRequestV1, index: number) => CanonicalJson,
  mutate?: (observation: Record<string, unknown>, request: FamilySourcePlanPhysicalRequestV1, index: number) => void,
): FamilySourcePlanPhysicalPortV1 {
  let index = 0;
  return {
    async request(request) {
      const response = respond(request, index);
      const observation: Record<string, unknown> = {
        kind: "family-source-plan-physical-observation",
        version: 1,
        requestId: h(`request-${index}`),
        releaseBindingId: h("release-binding"),
        releaseProvenanceHash: h("release-provenance"),
        sourceAuthorityRoot: h("source-authority"),
        sourceAnchorRoot: h("source-anchor"),
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
      const bytes = encodeCanonicalBytes(observation);
      const rawLocatorHash = sha256Hex(bytes);
      index += 1;
      return { response, rawLocatorHash, evidenceRef: h(`evidence-${index}`), rawEvidenceLocator: { kind: "raw-evidence-locator", version: 1, rawLocatorHash, bytes } };
    },
  };
}

test("DODO complete creation history owns the three-factory grid and nominates never-traded pools", async () => {
  const pools = [address("a"), address("b"), address("c")];
  const requested: unknown[] = [];
  const result = await DODO_V2_HISTORY_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    physical((request, index) => {
      requested.push({ target: request.request.target, topic: request.request.topic, range: request.request.lookback });
      return index < 3 ? [creation(index, BigInt(index + 1), pools[index]!)] : [];
    }),
    new AbortController().signal,
  );
  assert.equal(requested.length, 6);
  assert.deepEqual(requested.slice(0, 3).map(item => (item as { range: unknown }).range), Array(3).fill({ from: "0", through: "9999" }));
  assert.deepEqual(requested.slice(0, 3).map(item => (item as { target: string }).target), DODO_V2_FACTORIES.map(item => item.address));
  assert.deepEqual(requested.slice(0, 3).map(item => (item as { topic: Hash }).topic), DODO_V2_FACTORIES.map(item => item.creationTopic));
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
  const raw = new Map(result.rawEvidenceLocators.map(locator => [locator.rawLocatorHash, locator.bytes]));
  const nominations = await DODO_V2_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const bytes = raw.get(hash); if (bytes === undefined) throw new Error("missing raw"); return bytes; } } }, new AbortController().signal);
  assert.deepEqual(nominations.map(item => item.instanceNominationKey), pools);
});

test("DODO history rejects factory/topic injection, malformed creation ABI and a missing grid cell", async () => {
  await assert.rejects(() => DODO_V2_HISTORY_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    physical(() => [], (observation, request) => { observation.request = { ...(request.request as Record<string, CanonicalJson>), target: address("f") }; }),
    new AbortController().signal,
  ), /binding mismatch/);
  await assert.rejects(() => DODO_V2_HISTORY_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    physical((_request, index) => index === 0 ? [{ ...(creation(0, 1n, address("a")) as Record<string, CanonicalJson>), data: "0x01" }] : []),
    new AbortController().signal,
  ), /malformed/);

  const result = await DODO_V2_HISTORY_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    physical(() => []),
    new AbortController().signal,
  );
  const raw = new Map(result.rawEvidenceLocators.map(locator => [locator.rawLocatorHash, locator.bytes]));
  const refs = result.sourceEvidence.refs.slice(1);
  const rawLocatorHashes = refs.map(ref => ref.rawLocatorHash).sort();
  const evidenceRoot = sourcePlanEvidenceRoot({ plan: result.sourceEvidence.plan, cutoff: result.sourceEvidence.cutoff, refs, rawLocatorHashes });
  const forgedEvidence = Object.freeze({ ...result.sourceEvidence, refs, rawLocatorHashes, evidenceRoot });
  const { executionRoot: _discarded, ...executionWithoutRoot } = result.execution;
  const forgedExecutionWithoutRoot = Object.freeze({ ...executionWithoutRoot, sourceEvidenceRefs: refs, rawLocatorHashes, sourceEvidenceRoot: evidenceRoot });
  const forgedExecution = Object.freeze({ ...forgedExecutionWithoutRoot, executionRoot: sourcePlanExecutionRoot(forgedExecutionWithoutRoot) });
  await assert.rejects(() => DODO_V2_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: forgedExecution, sourceEvidence: forgedEvidence, recent: recent(), rawEvidence: { read(hash) { const bytes = raw.get(hash); if (bytes === undefined) throw new Error("missing raw"); return bytes; } } }, new AbortController().signal), /grid coverage gap/);
  assert.equal(DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH.length, 66);
});
