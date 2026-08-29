import assert from "node:assert/strict";
import test from "node:test";
import { decodeCanonicalJson, hashDomain, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type {
  FamilyPhysicalLifecyclePortsV1,
  FamilyPhysicalRpcCompletionV1,
  FamilyPhysicalRpcRequestV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import {
  UNIV3_STANDARD_DEFINITION,
  UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
} from "../src/family-definition.ts";
import { UNIV3_STANDARD_FAMILY_ID } from "../src/manifest.ts";
import { UNIV3_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY } from "../src/runtime/physical-adapter.ts";
import { UNIV3_SEARCH_SELECTORS } from "../src/search-codec.ts";

const h = (value: string): Hash => hashDomain("aloha/univ3-physical-test/v1", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const UINT256 = 1n << 256n;
const word = (value: bigint): string => (value < 0n ? UINT256 + value : value).toString(16).padStart(64, "0");
const words = (...values: bigint[]): string => `0x${values.map(word).join("")}`;
const addressResult = (value: string): string => `0x${"0".repeat(24)}${value.slice(2)}`;
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const source = Object.freeze({ chainId: "1", number: "100", hash: cutoff.hash, stateRoot: cutoff.stateRoot });

function decodeFact(value: string): CanonicalJson {
  const body = value.slice(2);
  const bytes = new Uint8Array(body.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16);
  }
  return decodeCanonicalJson(new TextDecoder().decode(bytes));
}

function ports(rpc: FamilyPhysicalLifecyclePortsV1["rpc"]): FamilyPhysicalLifecyclePortsV1 {
  return Object.freeze({
    rpc,
    rawEvidence: Object.freeze({ read(): Uint8Array { throw new TypeError("UniV3 physical lifecycle does not consume raw evidence"); } }),
  });
}

test("UniV3 physical identity reads static fields and exact factory reverse binding", async () => {
  const pool = address("1");
  const token0 = address("2");
  const token1 = address("3");
  const factory = address("4");
  const requestId = h("identity");
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      requests.push(input);
      const data = String((input.params as readonly Record<string, unknown>[])[0]!.data);
      if (data === "0x0dfe1681") return { kind: "returned", dataHex: addressResult(token0) };
      if (data === "0xd21220a7") return { kind: "returned", dataHex: addressResult(token1) };
      if (data === "0xc45a0155") return { kind: "returned", dataHex: addressResult(factory) };
      if (data === "0xddca3f43") return { kind: "returned", dataHex: words(3000n) };
      if (data === "0xd0c93a7c") return { kind: "returned", dataHex: words(60n) };
      if (data.startsWith("0x1698ee82")) return { kind: "returned", dataHex: addressResult(pool) };
      throw new TypeError(`unexpected UniV3 identity call ${data}`);
    },
  });
  const result = await UNIV3_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: {
      kind: "univ3-identity-input",
      candidate: { instanceNominationKey: pool, candidateSubjectHash: h("candidate") },
      cutoff,
      readPlan: ["identity"],
      requestId,
    },
  }, ports(rpc), new AbortController().signal);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.kind, "returned");
  const fact = decodeFact((result[0] as { readonly dataHex: string }).dataHex) as Record<string, unknown>;
  assert.equal(fact.kind, "univ3-identity-facts");
  assert.deepEqual((fact.reads as Record<string, unknown>), {
    cutoff,
    pool,
    factory,
    token0,
    token1,
    fee: "3000",
    tickSpacing: 60,
    reversePool: pool,
  });
  assert.equal(requests.length, 6);
  for (const request of requests) {
    assert.deepEqual((request.params as readonly unknown[])[1], { blockHash: cutoff.hash, requireCanonical: true });
  }
});

test("UniV3 physical state reads the current bitmap word and every initialized tick", async () => {
  const pool = address("1");
  const requestId = h("state-request");
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      requests.push(input);
      const data = String((input.params as readonly Record<string, unknown>[])[0]!.data);
      if (data === UNIV3_SEARCH_SELECTORS.slot0) return { kind: "returned", dataHex: words(1n << 96n, 0n, 0n, 1n, 1n, 0n, 1n) };
      if (data === UNIV3_SEARCH_SELECTORS.liquidity) return { kind: "returned", dataHex: words(1_000_000n) };
      if (data === UNIV3_SEARCH_SELECTORS.fee) return { kind: "returned", dataHex: words(3000n) };
      if (data === UNIV3_SEARCH_SELECTORS.tickSpacing) return { kind: "returned", dataHex: words(60n) };
      if (data.startsWith(UNIV3_SEARCH_SELECTORS.tickBitmap)) return { kind: "returned", dataHex: words(1n) };
      if (data.startsWith(UNIV3_SEARCH_SELECTORS.ticks)) return { kind: "returned", dataHex: words(100n, 10n, 0n, 0n, 0n, 0n, 0n, 1n) };
      throw new TypeError(`unexpected UniV3 state call ${data}`);
    },
  });
  const result = await UNIV3_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
    stage: "materialization",
    source,
    programInput: {
      kind: "univ3-materialization-input",
      identityMemo: { identity: { instanceKey: pool, facts: { fee: "3000", tickSpacing: 60 } } },
      cutoff,
      readPlan: ["state"],
      requestId,
    },
  }, ports(rpc), new AbortController().signal);
  assert.equal(result[0]!.kind, "returned");
  const fact = decodeFact((result[0] as { readonly dataHex: string }).dataHex) as Record<string, unknown>;
  const read = fact.read as Record<string, unknown>;
  assert.equal(read.sqrtPriceX96, (1n << 96n).toString());
  assert.equal(read.liquidity, "1000000");
  assert.deepEqual(read.tickBitmap, [{ word: 0, bits: "1" }]);
  assert.deepEqual(read.ticks, [{ tick: 0, liquidityNet: "10" }]);
  assert.equal(requests.length, 6);
});

test("UniV3 physical lifecycle preserves failures, keeps local acknowledgements, and is declared", async () => {
  const pool = address("1");
  let calls = 0;
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      calls += 1;
      const data = String((input.params as readonly Record<string, unknown>[])[0]!.data);
      return data === "0xd21220a7"
        ? { kind: "reverted", dataHex: "0x08c379a0" }
        : { kind: "returned", dataHex: data === "0xc45a0155" ? addressResult(address("4")) : data === "0x0dfe1681" ? addressResult(address("2")) : words(data === "0xddca3f43" ? 3000n : 60n) };
    },
  });
  const adapter = UNIV3_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const failed = await adapter.execute({
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: { kind: "univ3-identity-input", candidate: { instanceNominationKey: pool, candidateSubjectHash: h("failed-candidate") }, cutoff, readPlan: ["identity"], requestId: h("failed") },
  }, ports(rpc), new AbortController().signal);
  assert.deepEqual(failed, [{ kind: "reverted", requestId: h("failed"), dataHex: "0x08c379a0" }]);
  assert.equal(calls, 5, "failed static reads must not issue a dependent getPool call");

  const nomination = await adapter.execute({
    familyId: UNIV3_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV3_STANDARD_FAMILY_AUTHORING_HASH,
    stage: "nomination",
    source,
    programInput: { kind: "univ3-nomination-input", candidate: { candidateSubjectHash: h("nomination") }, cutoff, readPlan: ["candidate"], requestId: h("nomination-request") },
  }, ports(rpc), new AbortController().signal);
  assert.equal((decodeFact((nomination[0] as { readonly dataHex: string }).dataHex) as Record<string, unknown>).value, h("nomination"));
  assert.equal(calls, 5);

  assert.deepEqual(UNIV3_STANDARD_DEFINITION.runtimeAdapters?.["physical-lifecycle/v1"], {
    modulePath: "families/univ3-standard/src/runtime/physical-adapter.ts",
    exportName: "UNIV3_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY",
    capabilityIds: {},
    actionOwnerIds: {},
  });
});
