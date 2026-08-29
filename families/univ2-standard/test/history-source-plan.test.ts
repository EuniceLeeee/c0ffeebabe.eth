import assert from "node:assert/strict";
import test from "node:test";
import { encodeCanonicalBytes, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { mergeAndDedupeNominations, sealSourceCoverage, type CanonicalCutoffV1, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilySourcePlanExecutionResultV1, FamilySourcePlanPhysicalPortV1, FamilySourcePlanPhysicalRequestV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import { UNIV2_PAIR_CREATED_TOPIC0, UNIV2_STANDARD_FAMILY_DEFINITION_HASH, UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM, UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME, UNIV2_STANDARD_STAGE_DEFINITIONS } from "../src/public.ts";

const h = (value: string): Hash => hashDomain("test/univ2-history", value);
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => value.toString(16).padStart(64, "0");
const topicAddress = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH, completeness: "contiguous-history", historyStartBlock: "0" });
const cutoff = Object.freeze({ chainId: "1", number: "20000", hash: h("block-20000"), stateRoot: h("state") });
function log(block: bigint, pair: string): CanonicalJson { return { address: address("f"), blockHash: h(`block-${block}`), blockNumber: `0x${block.toString(16)}`, data: `0x${"0".repeat(24)}${pair.slice(2)}${word(1n)}`, logIndex: "0x0", removed: false, topics: [UNIV2_PAIR_CREATED_TOPIC0, topicAddress(address("1")), topicAddress(address("2"))], transactionHash: h(`tx-${block}`), transactionIndex: "0x0" }; }
function physical(responses: readonly CanonicalJson[], mutate?: (observation: Record<string, unknown>, request: FamilySourcePlanPhysicalRequestV1, index: number) => void): FamilySourcePlanPhysicalPortV1 { let index = 0; return { async request(request: FamilySourcePlanPhysicalRequestV1) { const response = responses[index]!; const observation: Record<string, unknown> = { kind: "family-source-plan-physical-observation", version: 1, requestId: h(`request-${index}`), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response }; mutate?.(observation, request, index); const bytes = encodeCanonicalBytes(observation); const rawLocatorHash = sha256Hex(bytes); index += 1; return { response, rawLocatorHash, evidenceRef: h(`evidence-${index}`), rawEvidenceLocator: { kind: "raw-evidence-locator", version: 1, rawLocatorHash, bytes } }; } }; }
function recent(value: CanonicalCutoffV1 = cutoff) { const first = BigInt(value.number) - 49n; const blocks = []; let parentHash = h(`block-${first - 1n}`); for (let n = first; n <= BigInt(value.number); n += 1n) { const hash = n === BigInt(value.number) ? value.hash : h(`recent-${n}`); blocks.push({ number: String(n), hash, parentHash, evidence: [] }); parentHash = hash; } return sealRecentObservation(value, { from: first.toString(), to: value.number }, blocks, []); }
function predecessor(result: FamilySourcePlanExecutionResultV1) { const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes])); return Object.freeze({ persistedExecutionRoot: h(`persisted-${result.execution.through}`), execution: result.execution, sourceEvidence: result.sourceEvidence, rawEvidence: Object.freeze({ read(hash: Hash) { const bytes = raw.get(hash); if (!bytes) throw new Error("missing predecessor raw"); return bytes; } }) }); }

test("UniV2 PairCreated history covers bounded chunks and preserves an empty middle chunk", async () => {
  const pair0 = address("a"); const pair1 = address("b"); const ranges: CanonicalJson[] = [];
  const result = await UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, { async request(request) { ranges.push(request.request.lookback); return physical(request.request.lookback === ranges[0] ? [[log(5n, pair0)]] : request.request.lookback === ranges[1] ? [[]] : [[log(20000n, pair1)]]).request(request, new AbortController().signal); } }, new AbortController().signal);
  assert.deepEqual(ranges, [{ from: "0", through: "9999" }, { from: "10000", through: "19999" }, { from: "20000", through: "20000" }]);
  assert.equal(result.rawEvidenceLocators.length, 3); assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
  const raw = new Map(result.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes])); const nominations = await UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { return raw.get(hash)!; } } }, new AbortController().signal);
  assert.deepEqual(nominations.map(value => value.instanceNominationKey), [pair0, pair1]);
  const nomination = nominations[0]!; const prepared = UNIV2_STANDARD_STAGE_DEFINITIONS.find(value => value.stage === "identity")!.prepareIssueValue({ stage: "identity", candidate: mergeAndDedupeNominations([nomination])[0]! as unknown as CanonicalJson, cutoff, identityMemo: null, materializationOutput: null }); assert.equal((prepared as { readonly nomination: { readonly pool: string } }).nomination.pool, pair0);
});

test("UniV2 successor scans only delta and retains the complete prior inventory for empty and non-empty deltas", async () => {
  const pairA = address("a"); const pairB = address("b");
  const firstCutoff = Object.freeze({ chainId: "1", number: "99", hash: h("block-99"), stateRoot: h("state-99") });
  const first = await UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: firstCutoff, previousAppliedThrough: null }, physical([[log(95n, pairA)]]), new AbortController().signal);
  const emptyCutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block-100"), stateRoot: h("state-100") });
  const emptyRanges: CanonicalJson[] = [];
  const empty = await UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: emptyCutoff, previousAppliedThrough: "99", predecessor: predecessor(first) }, { async request(request) { emptyRanges.push(request.request.lookback); return physical([[]]).request(request, new AbortController().signal); } }, new AbortController().signal);
  assert.deepEqual(emptyRanges, [{ from: "100", through: "100" }]);
  const emptyRaw = new Map(empty.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const emptyNominations = await UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: empty.execution, sourceEvidence: empty.sourceEvidence, recent: recent(emptyCutoff), rawEvidence: { read(hash) { return emptyRaw.get(hash)!; } } }, new AbortController().signal);
  assert.deepEqual(emptyNominations.map(value => value.instanceNominationKey), [pairA]);
  const nextCutoff = Object.freeze({ chainId: "1", number: "101", hash: h("block-101"), stateRoot: h("state-101") });
  const next = await UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: nextCutoff, previousAppliedThrough: "100", predecessor: predecessor(empty) }, physical([[log(101n, pairB)]]), new AbortController().signal);
  const nextRaw = new Map(next.rawEvidenceLocators.map(value => [value.rawLocatorHash, value.bytes]));
  const nextNominations = await UNIV2_STANDARD_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: next.execution, sourceEvidence: next.sourceEvidence, recent: recent(nextCutoff), rawEvidence: { read(hash) { return nextRaw.get(hash)!; } } }, new AbortController().signal);
  assert.deepEqual(nextNominations.map(value => value.instanceNominationKey), [pairA, pairB]);
});

test("UniV2 PairCreated history rejects gaps, unordered/cross-range logs, malformed ABI, and raw hash", async () => {
  await assert.rejects(() => UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "10000" }, previousAppliedThrough: null }, physical([[], []], (observation, request, index) => { if (index === 1) observation.request = { ...request.request, lookback: { from: "10001", through: "10000" } }; }), new AbortController().signal), /binding mismatch/);
  await assert.rejects(() => UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "10" }, previousAppliedThrough: null }, physical([[log(5n, address("a")), log(4n, address("b"))]]), new AbortController().signal), /strict chain order/);
  await assert.rejects(() => UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "10" }, previousAppliedThrough: null }, physical([[log(11n, address("a"))]]), new AbortController().signal), /outside the requested range/);
  await assert.rejects(() => UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "10" }, previousAppliedThrough: null }, physical([[{ ...(log(1n, address("a")) as object), data: "0x" } as CanonicalJson]]), new AbortController().signal), /ABI mismatch/);
  const forged: FamilySourcePlanPhysicalPortV1 = { async request(request) { const response: CanonicalJson = []; const bytes = encodeCanonicalBytes({ kind: "family-source-plan-physical-observation", version: 1, requestId: h("x"), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response }); return { response, rawLocatorHash: h("wrong"), evidenceRef: h("e"), rawEvidenceLocator: { kind: "raw-evidence-locator", version: 1, rawLocatorHash: h("wrong"), bytes } }; } };
  await assert.rejects(() => UNIV2_STANDARD_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: { ...cutoff, number: "1" }, previousAppliedThrough: null }, forged, new AbortController().signal), /raw locator mismatch/);
});
