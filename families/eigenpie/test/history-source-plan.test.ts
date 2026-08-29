import assert from "node:assert/strict";
import test from "node:test";
import { encodeCanonicalBytes, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type { FamilySourcePlanPhysicalPortV1, FamilySourcePlanPhysicalRequestV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import { EIGENPIE_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import { EIGENPIE_ASSET_DEPOSIT_TOPIC } from "../src/manifest.ts";
import { EIGENPIE_HISTORY_NOMINATION_PROGRAM, EIGENPIE_HISTORY_SOURCE_PLAN_RUNTIME } from "../src/history-source-plan.ts";

const h = (value: string): Hash => hashDomain("test/eigenpie-history/v1", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const addressTopic = (value: string): Hash => `0x${value.slice(2).padStart(64, "0")}` as Hash;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const cutoff = (number: string) => Object.freeze({ chainId: "1", number, hash: h(`block-${number}`), stateRoot: h(`state-${number}`) });
const plan = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: EIGENPIE_FAMILY_AUTHORING_HASH, completeness: "contiguous-history" as const, historyStartBlock: "0" });

function deposit(target: string, block: bigint): CanonicalJson {
  return Object.freeze({ address: target, blockHash: h(`log-block-${block}`), blockNumber: `0x${block.toString(16)}`, data: `0x${word(10n)}${word(9n)}${word(0n)}`, logIndex: "0x0", removed: false, topics: Object.freeze([EIGENPIE_ASSET_DEPOSIT_TOPIC, addressTopic(address("1")), addressTopic(address("2")), addressTopic(address("3"))]), transactionHash: h(`tx-${block}`), transactionIndex: "0x0" });
}

function physical(respond: (request: FamilySourcePlanPhysicalRequestV1, index: number) => CanonicalJson, mutate?: (observation: Record<string, unknown>) => void): FamilySourcePlanPhysicalPortV1 {
  let index = 0;
  return { async request(request) { const response = respond(request, index); const observation: Record<string, unknown> = { kind: "family-source-plan-physical-observation", version: 1, requestId: h(`request-${index}`), releaseBindingId: h("release"), releaseProvenanceHash: h("provenance"), sourceAuthorityRoot: h("authority"), sourceAnchorRoot: h("anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response }; mutate?.(observation); const bytes = encodeCanonicalBytes(observation); const rawLocatorHash = sha256Hex(bytes); index += 1; return { response, rawLocatorHash, evidenceRef: h(`evidence-${index}`), rawEvidenceLocator: { kind: "raw-evidence-locator", version: 1, rawLocatorHash, bytes } }; } };
}

function rawPort(locators: readonly { readonly rawLocatorHash: Hash; readonly bytes: Uint8Array }[]) { const byHash = new Map(locators.map(value => [value.rawLocatorHash, value.bytes])); return Object.freeze({ read(hash: Hash) { const bytes = byHash.get(hash); if (bytes === undefined) throw new Error("missing raw"); return new Uint8Array(bytes); } }); }
function recent(number: string) { const c = cutoff(number); const through = BigInt(number); const from = through - 49n; const blocks = []; let parentHash = h("parent"); for (let block = from; block <= through; block += 1n) { const hash = block === through ? c.hash : h(`recent-${block}`); blocks.push({ number: block.toString(), hash, parentHash, evidence: [] }); parentHash = hash; } return sealRecentObservation(c, { from: from.toString(), to: number }, blocks, []); }

test("Eigenpie history preserves genesis-through-cutoff bytes across a durable predecessor", async () => {
  const target = address("a");
  const first = await EIGENPIE_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: cutoff("50"), previousAppliedThrough: null }, physical(() => [deposit(target, 2n)]), new AbortController().signal);
  assert.equal(first.execution.from, "0"); assert.equal(first.execution.through, "50");
  const second = await EIGENPIE_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: cutoff("52"), previousAppliedThrough: "50", predecessor: { persistedExecutionRoot: h("persisted"), execution: first.execution, sourceEvidence: first.sourceEvidence, rawEvidence: rawPort(first.rawEvidenceLocators) } }, physical(() => []), new AbortController().signal);
  assert.equal(second.execution.from, "0"); assert.equal(second.execution.through, "52"); assert.equal(second.sourceEvidence.refs.length, 2); assert.equal(second.rawEvidenceLocators.length, 2);
  const nominations = await EIGENPIE_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: second.execution, sourceEvidence: second.sourceEvidence, recent: recent("52"), rawEvidence: rawPort(second.rawEvidenceLocators) }, new AbortController().signal);
  assert.deepEqual(nominations.map(value => value.instanceNominationKey), [target]);
});

test("Eigenpie history rejects a forged owner physical observation", async () => {
  await assert.rejects(() => EIGENPIE_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff: cutoff("5"), previousAppliedThrough: null }, physical(() => [], observation => { observation.familyDefinitionHash = h("forged"); }), new AbortController().signal), /binding mismatch/);
});
