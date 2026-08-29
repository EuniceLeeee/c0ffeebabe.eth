import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import { sealSourceCoverage, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type {
  FamilySourcePlanPhysicalPortV1,
  FamilySourcePlanPhysicalRequestV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import { ASTRA_FAMILY_DEFINITION_HASH } from "../src/family-definition.ts";
import { ASTRA_CHANGE_TOPIC } from "../src/manifest.ts";
import {
  ASTRA_HISTORY_NOMINATION_PROGRAM,
  ASTRA_HISTORY_SOURCE_PLAN_RUNTIME,
} from "../src/history-source-plan.ts";

const h = (value: string): Hash => hashDomain("test/astra-history", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const indexedAddress = (value: string): string => `0x${"0".repeat(24)}${value.slice(2)}`;
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: ASTRA_FAMILY_DEFINITION_HASH, completeness: "contiguous-history", historyStartBlock: "0" });
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

function changed(block: bigint, target: string, actor = address("4")): CanonicalJson {
  return Object.freeze({
    address: target,
    blockHash: h(`log-block-${block}`),
    blockNumber: `0x${block.toString(16)}`,
    data: `0x${word(100n)}${word(99n)}`,
    logIndex: "0x0",
    removed: false,
    topics: Object.freeze([ASTRA_CHANGE_TOPIC, indexedAddress(address("1")), indexedAddress(address("2")), indexedAddress(actor)]),
    transactionHash: h(`tx-${block}`),
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
      const observation: Record<string, unknown> = { kind: "family-source-plan-physical-observation", version: 1, requestId: h(`request-${index}`), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response };
      mutate?.(observation, request, index);
      const bytes = encodeCanonicalBytes(observation);
      const rawLocatorHash = sha256Hex(bytes);
      index += 1;
      return { response, rawLocatorHash, evidenceRef: h(`evidence-${index}`), rawEvidenceLocator: { kind: "raw-evidence-locator", version: 1, rawLocatorHash, bytes } };
    },
  };
}

test("Astra complete Change history owns exact chunks and nominates every observed target", async () => {
  const first = address("a");
  const second = address("b");
  const requested: unknown[] = [];
  const result = await ASTRA_HISTORY_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    physical((request, index) => {
      requested.push(request.request.lookback);
      return index === 0 ? [changed(1n, first), changed(2n, first), changed(3n, second)] : [];
    }),
    new AbortController().signal,
  );
  assert.deepEqual(requested, [{ from: "0", through: "9999" }, { from: "10000", through: "10000" }]);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
  const raw = new Map(result.rawEvidenceLocators.map(locator => [locator.rawLocatorHash, locator.bytes]));
  const nominations = await ASTRA_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const bytes = raw.get(hash); if (bytes === undefined) throw new Error("missing raw"); return bytes; } } }, new AbortController().signal);
  assert.deepEqual(nominations.map(item => item.instanceNominationKey), [first, second]);
});

test("Astra history rejects filter injection, malformed ABI and coverage splice", async () => {
  await assert.rejects(() => ASTRA_HISTORY_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    physical(() => [], (observation, request) => { observation.request = { ...(request.request as Record<string, CanonicalJson>), topic: h("wrong-topic") }; }),
    new AbortController().signal,
  ), /binding mismatch/);
  await assert.rejects(() => ASTRA_HISTORY_SOURCE_PLAN_RUNTIME.execute(
    { plan, cutoff, previousAppliedThrough: null },
    physical((_request, index) => index === 0 ? [{ ...(changed(1n, address("a")) as Record<string, CanonicalJson>), data: "0x01" }] : []),
    new AbortController().signal,
  ), /malformed/);
});
