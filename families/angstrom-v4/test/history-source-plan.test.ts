import assert from "node:assert/strict";
import test from "node:test";
import { encodeCanonicalBytes, hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import { sealSourceCoverage, type SourcePlanRefV1 } from "../../../packages/discovery/src/index.ts";
import type { FamilySourcePlanPhysicalPortV1, FamilySourcePlanPhysicalRequestV1 } from "../../../packages/family-sdk/runtime/index.ts";
import { sealRecentObservation } from "../../../packages/observation/src/index.ts";
import { ANGSTROM_MAINNET_HOOK, ANGSTROM_V4_POOL_MANAGER, poolIdForKey, type AngstromV4PoolKey } from "../src/abi.ts";
import { ANGSTROM_V4_FAMILY_DEFINITION_HASH } from "../src/family-definition.ts";
import { ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC } from "../src/manifest.ts";
import { ANGSTROM_V4_HISTORY_NOMINATION_PROGRAM, ANGSTROM_V4_HISTORY_SOURCE_PLAN_RUNTIME } from "../src/history-source-plan.ts";

const h = (value: string): Hash => hashDomain("test/angstrom-v4-history", value);
const address = (digit: string) => `0x${digit.repeat(40)}`;
const word = (value: bigint) => BigInt.asUintN(256, value).toString(16).padStart(64, "0");
const addressTopic = (value: string) => `0x${"0".repeat(24)}${value.slice(2)}`;
const plan: SourcePlanRefV1 = Object.freeze({ ownerRef: h("owner"), sourcePlanRef: h("plan"), familyDefinitionHash: ANGSTROM_V4_FAMILY_DEFINITION_HASH, completeness: "contiguous-history", historyStartBlock: "0" });
const cutoff = Object.freeze({ chainId: "1", number: "49", hash: h("block"), stateRoot: h("state") });
function recent() { const blocks = []; let parentHash = h("parent"); for (let number = 0n; number <= 49n; number++) { const hash = number === 49n ? cutoff.hash : h(`b-${number}`); blocks.push({ number: number.toString(), hash, parentHash, evidence: [] }); parentHash = hash; } return sealRecentObservation(cutoff, { from: "0", to: "49" }, blocks, []); }
function initialized(block: bigint, key: AngstromV4PoolKey): CanonicalJson { const poolId = poolIdForKey(key); return Object.freeze({ address: ANGSTROM_V4_POOL_MANAGER.toLowerCase(), blockHash: h(`log-block-${block}`), blockNumber: `0x${block.toString(16)}`, data: `0x${word(BigInt(key.fee))}${word(BigInt(key.tickSpacing))}${word(BigInt(key.hooks))}${word(1n << 96n)}${word(0n)}`, logIndex: `0x${block.toString(16)}`, removed: false, topics: Object.freeze([ANGSTROM_V4_CONTRACT_EVIDENCE_TOPIC, poolId, addressTopic(key.currency0), addressTopic(key.currency1)]), transactionHash: h(`tx-${block}`), transactionIndex: "0x0" }); }
function physical(response: CanonicalJson, mutate?: (observation: Record<string, unknown>, request: FamilySourcePlanPhysicalRequestV1) => void): FamilySourcePlanPhysicalPortV1 { return { async request(request) { const observation: Record<string, unknown> = { kind: "family-source-plan-physical-observation", version: 1, requestId: h("request"), releaseBindingId: h("release-binding"), releaseProvenanceHash: h("release-provenance"), sourceAuthorityRoot: h("source-authority"), sourceAnchorRoot: h("source-anchor"), provider: "reth", backendEpoch: "epoch", familyDefinitionHash: request.familyDefinitionHash, plan: request.plan, cutoff: request.cutoff, requestSchemaHash: request.requestSchemaHash, request: request.request, response }; mutate?.(observation, request); const bytes = encodeCanonicalBytes(observation); const rawLocatorHash = sha256Hex(bytes); return { response, rawLocatorHash, evidenceRef: h("evidence"), rawEvidenceLocator: { kind: "raw-evidence-locator", version: 1, rawLocatorHash, bytes } }; } }; }

test("Angstrom history filters the complete PoolManager history by exact hook binding", async () => {
  const angstrom = { currency0: address("1"), currency1: address("2"), fee: "3000", tickSpacing: "60", hooks: ANGSTROM_MAINNET_HOOK };
  const foreign = { ...angstrom, hooks: address("9") };
  const result = await ANGSTROM_V4_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([initialized(1n, foreign), initialized(2n, angstrom)]), new AbortController().signal);
  assert.equal(sealSourceCoverage(cutoff, [plan], [result.execution]).entries[0]!.contributesOmissionAuthority, true);
  const raw = new Map(result.rawEvidenceLocators.map(locator => [locator.rawLocatorHash, locator.bytes]));
  const nominations = await ANGSTROM_V4_HISTORY_NOMINATION_PROGRAM.evaluate({ execution: result.execution, sourceEvidence: result.sourceEvidence, recent: recent(), rawEvidence: { read(hash) { const bytes = raw.get(hash); if (!bytes) throw new Error("missing raw"); return bytes; } } }, new AbortController().signal);
  assert.deepEqual(nominations.map(item => item.instanceNominationKey), [poolIdForKey(angstrom)]);
});

test("Angstrom history rejects a forged manager binding", async () => {
  await assert.rejects(() => ANGSTROM_V4_HISTORY_SOURCE_PLAN_RUNTIME.execute({ plan, cutoff, previousAppliedThrough: null }, physical([], (observation, request) => { observation.request = { ...request.request, target: address("9") }; }), new AbortController().signal), /binding mismatch/);
});
