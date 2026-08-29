import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanonicalJson,
  encodeCanonicalBytes,
  hashDomain,
  sha256Hex,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type {
  FamilyPhysicalRpcCompletionV1,
  FamilyPhysicalRpcRequestV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { encodeEvmLogObservation } from "../../../packages/observation/src/index.ts";
import { DODO_V2_FAMILY_AUTHORING_HASH } from "../src/family-definition.ts";
import {
  DODO_V2_FACTORIES,
  DODO_V2_FAMILY_ID,
  DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
  DODO_V2_QUOTE_ACTOR,
  DODO_V2_SWAP_TOPIC,
} from "../src/manifest.ts";
import { DODO_V2_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY } from "../src/runtime/physical-adapter.ts";

const h = (value: string): Hash => hashDomain("aloha/dodo-physical-test/v1", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const words = (...values: readonly bigint[]): string => `0x${values.map(word).join("")}`;
const addressArray = (values: readonly string[]): string => words(32n, BigInt(values.length), ...values.map(BigInt));
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const source = Object.freeze({ chainId: "1", number: "100", hash: cutoff.hash, stateRoot: cutoff.stateRoot });
const pool = address("5");
const baseToken = address("1");
const quoteToken = address("2");
const indexedAddress = (value: string): Hash => `0x${word(BigInt(value))}` as Hash;
const evidenceBytes = encodeEvmLogObservation({
  kind: "evm-log",
  version: 1,
  blockNumber: cutoff.number,
  blockHash: cutoff.hash,
  transactionHash: h("tx"),
  logIndex: "0",
  address: pool,
  topics: [DODO_V2_SWAP_TOPIC, indexedAddress(baseToken), indexedAddress(quoteToken)],
  data: words(100n, 99n),
});
const evidenceHash = sha256Hex(evidenceBytes);
const evidence = Object.freeze({
  kind: "recent-log" as const,
  version: 1 as const,
  sourcePlanRef: null,
  ownerRef: null,
  blockNumber: cutoff.number,
  blockHash: cutoff.hash,
  txHash: h("tx"),
  logIndex: "0",
  address: pool,
  topic: DODO_V2_SWAP_TOPIC,
  rawLocatorHash: evidenceHash,
});

function decoded(value: string): CanonicalJson {
  const raw = value.slice(2);
  const bytes = new Uint8Array(raw.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16);
  }
  return decodeCanonicalJson(new TextDecoder().decode(bytes));
}

function identityInput(requestId: Hash, selectedEvidence: CanonicalJson = evidence): CanonicalJson {
  return {
    kind: "dodo-v2-identity-input",
    candidate: { instanceNominationKey: pool, candidateSubjectHash: h("candidate") },
    evidence: selectedEvidence,
    cutoff,
    readPlan: ["identity"],
    requestId,
  };
}

function rawEvidence(bytes = evidenceBytes, expectedHash = evidenceHash) {
  return Object.freeze({
    read(rawLocatorHash: Hash): Uint8Array {
      assert.equal(rawLocatorHash, expectedHash);
      return new Uint8Array(bytes);
    },
  });
}

function successRpc(requests: FamilyPhysicalRpcRequestV1[] = [], listedFactoryIndex: number | null = 1) {
  return Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      requests.push(input);
      const call = (input.params as readonly { readonly to: string; readonly data: string; readonly from?: string }[])[0]!;
      if (call.data === "0x4a248d2a") return { kind: "returned", dataHex: words(BigInt(baseToken)) };
      if (call.data === "0xd4b97046") return { kind: "returned", dataHex: words(BigInt(quoteToken)) };
      if (call.data === "0xfd1ed7e9") return { kind: "returned", dataHex: words(2n * 10n ** 18n, 0n, 1_000n, 2_000n, 1_000n, 2_000n, 0n) };
      if (call.data.startsWith("0x44096609")) return { kind: "returned", dataHex: words(10n ** 17n, 0n) };
      if (call.data.startsWith("0x57a281dc")) {
        const listed = listedFactoryIndex === null ? null : DODO_V2_FACTORIES[listedFactoryIndex];
        return { kind: "returned", dataHex: listed !== null && listed !== undefined && call.to === listed.address ? addressArray([pool]) : addressArray([]) };
      }
      throw new TypeError("unexpected DODO physical request");
    },
  });
}

test("DODO physical lifecycle reads exact archived evidence and finds an exact canonical registry binding", async () => {
  const requestId = h("identity-request");
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const result = await DODO_V2_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: DODO_V2_FAMILY_ID,
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: identityInput(requestId),
  }, { rpc: successRpc(requests), rawEvidence: rawEvidence() }, new AbortController().signal);
  const fact = decoded((result[0] as { readonly dataHex: string }).dataHex) as {
    readonly candidateEvidenceBytesHex: string;
    readonly reads: { readonly factory: string; readonly registryPool: string; readonly quoteActor: string };
  };
  assert.equal(fact.candidateEvidenceBytesHex, `0x${Array.from(evidenceBytes, byte => byte.toString(16).padStart(2, "0")).join("")}`);
  assert.equal(fact.reads.factory, DODO_V2_FACTORIES[1]!.address);
  assert.equal(fact.reads.registryPool, pool);
  assert.equal(fact.reads.quoteActor, DODO_V2_QUOTE_ACTOR);
  assert.equal(requests.filter(request => {
    const call = (request.params as readonly { readonly data: string }[])[0]!;
    return call.data.startsWith("0x57a281dc");
  }).length, 2);
  const fee = requests.find(request => ((request.params as readonly { readonly data: string }[])[0]!.data).startsWith("0x44096609"))!;
  assert.equal((fee.params as readonly { readonly from: string }[])[0]!.from, DODO_V2_QUOTE_ACTOR);
  for (const request of requests) {
    assert.deepEqual((request.params as readonly unknown[])[1], { blockHash: cutoff.hash, requireCanonical: true });
  }
});

test("DODO physical lifecycle preserves an all-registry chain-proven negative", async () => {
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const result = await DODO_V2_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: DODO_V2_FAMILY_ID,
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: identityInput(h("unregistered-request")),
  }, { rpc: successRpc(requests, null), rawEvidence: rawEvidence() }, new AbortController().signal);
  const fact = decoded((result[0] as { readonly dataHex: string }).dataHex) as {
    readonly reads: { readonly registryPool: string };
  };
  assert.equal(fact.reads.registryPool, `0x${"0".repeat(40)}`);
  assert.equal(requests.filter(request => {
    const call = (request.params as readonly { readonly data: string }[])[0]!;
    return call.data.startsWith("0x57a281dc");
  }).length, DODO_V2_FACTORIES.length);
});

test("DODO physical lifecycle uses a qualified history witness to query only its exact factory", async () => {
  const declaration = DODO_V2_FACTORIES[2]!;
  const ownerRef = h("history-owner");
  const sourcePlanRef = h("history-plan");
  const historyBytes = encodeCanonicalBytes({
    kind: "family-source-plan-physical-observation",
    version: 1,
    requestId: h("history-physical-request"),
    releaseBindingId: h("release-binding"),
    releaseProvenanceHash: h("release-provenance"),
    sourceAuthorityRoot: h("source-authority"),
    sourceAnchorRoot: h("source-anchor"),
    provider: "reth",
    backendEpoch: "1",
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    plan: { ownerRef, sourcePlanRef, familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH, completeness: "contiguous-history", historyStartBlock: "0" },
    cutoff,
    requestSchemaHash: DODO_V2_HISTORY_SOURCE_PLAN_SCHEMA_HASH,
    request: { kind: "family-source-plan-rpc", version: 1, method: "eth_getLogs", params: [], target: declaration.address, manager: declaration.address, topic: declaration.creationTopic, lookback: { from: "0", through: cutoff.number }, chunk: { maxBlocks: "10000" } },
    response: [],
  });
  const historyHash = sha256Hex(historyBytes);
  const historyEvidence: CanonicalJson = { kind: "source-plan", version: 1, ownerRef, sourcePlanRef, evidenceRef: h("history-evidence"), rawLocatorHash: historyHash };
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const result = await DODO_V2_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: DODO_V2_FAMILY_ID,
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: identityInput(h("history-identity"), historyEvidence),
  }, { rpc: successRpc(requests, 2), rawEvidence: rawEvidence(historyBytes, historyHash) }, new AbortController().signal);
  const fact = decoded((result[0] as { readonly dataHex: string }).dataHex) as { readonly reads: { readonly factory: string } };
  assert.equal(fact.reads.factory, declaration.address);
  const registryCalls = requests.filter(request => ((request.params as readonly { readonly data: string }[])[0]!.data).startsWith("0x57a281dc"));
  assert.equal(registryCalls.length, 1);
  assert.equal((registryCalls[0]!.params as readonly { readonly to: string }[])[0]!.to, declaration.address);
});

test("DODO physical lifecycle reads PMM state and actor-bound fee at the same source", async () => {
  const result = await DODO_V2_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: DODO_V2_FAMILY_ID,
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    stage: "materialization",
    source,
    programInput: {
      kind: "dodo-v2-materialization-input",
      identityMemo: { identity: { instanceKey: pool } },
      cutoff,
      readPlan: ["state"],
      requestId: h("state-request"),
    },
  }, { rpc: successRpc(), rawEvidence: rawEvidence() }, new AbortController().signal);
  const fact = decoded((result[0] as { readonly dataHex: string }).dataHex) as {
    readonly read: { readonly pool: string; readonly lpFeeRate: string; readonly pmm: { readonly i: string; readonly R: number } };
  };
  assert.equal(fact.read.pool, pool);
  assert.equal(fact.read.lpFeeRate, "100000000000000000");
  assert.deepEqual(fact.read.pmm, { i: "2000000000000000000", K: "0", B: "1000", Q: "2000", B0: "1000", Q0: "2000", R: 0 });
});

test("DODO physical lifecycle rejects wrong archived bytes before any RPC", async () => {
  let calls = 0;
  const rpc = Object.freeze({ async request(): Promise<FamilyPhysicalRpcCompletionV1> { calls += 1; return { kind: "transportFailure", failureCode: "rpc" }; } });
  await assert.rejects(() => DODO_V2_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: DODO_V2_FAMILY_ID,
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: identityInput(h("wrong-evidence")),
  }, { rpc, rawEvidence: rawEvidence(new TextEncoder().encode("forged")) }, new AbortController().signal), /raw evidence hash mismatch/);
  assert.equal(calls, 0);
});

test("DODO physical lifecycle propagates transport failure and does not query registries", async () => {
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      requests.push(input);
      const call = (input.params as readonly { readonly data: string }[])[0]!;
      if (call.data === "0x4a248d2a") return { kind: "transportFailure", failureCode: "source-stale" };
      if (call.data === "0xd4b97046") return { kind: "returned", dataHex: words(BigInt(quoteToken)) };
      if (call.data === "0xfd1ed7e9") return { kind: "returned", dataHex: words(1n, 0n, 1n, 1n, 1n, 1n, 0n) };
      return { kind: "returned", dataHex: words(0n, 0n) };
    },
  });
  const requestId = h("transport-request");
  const result = await DODO_V2_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: DODO_V2_FAMILY_ID,
    familyDefinitionHash: DODO_V2_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: identityInput(requestId),
  }, { rpc, rawEvidence: rawEvidence() }, new AbortController().signal);
  assert.deepEqual(result, [{ kind: "transportFailure", requestId, failureCode: "source-stale" }]);
  assert.equal(requests.some(request => ((request.params as readonly { readonly data: string }[])[0]!.data).startsWith("0x57a281dc")), false);
});
