import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type {
  FamilyPhysicalLifecyclePortsV1,
  FamilyPhysicalRpcCompletionV1,
  FamilyPhysicalRpcRequestV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import {
  UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
  UNIV2_STANDARD_FAMILY_ID,
} from "../src/family-definition.ts";
import { UNIV2_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY } from "../src/runtime/physical-adapter.ts";
import {
  UNIV2_FACTORY_SELECTOR,
  UNIV2_GET_PAIR_SELECTOR,
  UNIV2_GET_RESERVES_SELECTOR,
  UNIV2_TOKEN0_SELECTOR,
  UNIV2_TOKEN1_SELECTOR,
} from "../src/schema/index.ts";

const h = (value: string): Hash => hashDomain("aloha/univ2-physical-test/v1", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: string): string => `0x${"0".repeat(24)}${value.slice(2)}`;
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const source = Object.freeze({ chainId: "1", number: "100", hash: cutoff.hash, stateRoot: cutoff.stateRoot });

function ports(rpc: FamilyPhysicalLifecyclePortsV1["rpc"]): FamilyPhysicalLifecyclePortsV1 {
  return Object.freeze({
    rpc,
    rawEvidence: Object.freeze({
      read(): Uint8Array { throw new TypeError("UniV2 physical lifecycle does not consume raw evidence"); },
    }),
  });
}

test("UniV2 physical lifecycle performs exact canonical identity and reserve reads", async () => {
  const pool = address("1");
  const token0 = address("2");
  const token1 = address("3");
  const factory = address("4");
  const ids = [h("token0"), h("token1"), h("factory"), h("forward"), h("reverse")];
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      requests.push(input);
      const call = (input.params as readonly { readonly data?: string }[])[0]!;
      if (call.data === UNIV2_TOKEN0_SELECTOR) return { kind: "returned", dataHex: word(token0) };
      if (call.data === UNIV2_TOKEN1_SELECTOR) return { kind: "returned", dataHex: word(token1) };
      if (call.data === UNIV2_FACTORY_SELECTOR) return { kind: "returned", dataHex: word(factory) };
      if (call.data?.startsWith(UNIV2_GET_PAIR_SELECTOR)) return { kind: "returned", dataHex: word(pool) };
      if (call.data === UNIV2_GET_RESERVES_SELECTOR) return { kind: "returned", dataHex: `0x${"0".repeat(64 * 3)}` };
      throw new TypeError("unexpected UniV2 physical request");
    },
  });
  const adapter = UNIV2_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const identity = await adapter.execute({
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    stage: "identity",
    source,
    programInput: {
      kind: "family-identity-input",
      nomination: { pool },
      cutoff,
      readPlan: ["token0", "token1", "factory", "getPair-forward", "getPair-reverse"],
      requestIds: ids,
      evidenceRoot: h("evidence"),
    },
  }, ports(rpc), new AbortController().signal);
  assert.deepEqual(identity.map(value => value.requestId), ids);
  assert.deepEqual(requests.map(value => value.method), ["eth_call", "eth_call", "eth_call", "eth_call", "eth_call"]);
  for (const request of requests) {
    assert.deepEqual((request.params as readonly unknown[])[1], { blockHash: cutoff.hash, requireCanonical: true });
  }
  assert.equal(((requests[3]!.params as readonly { readonly data: string }[])[0]!.data).startsWith(UNIV2_GET_PAIR_SELECTOR), true);

  const reserveId = h("reserves");
  const reserveFacts = await adapter.execute({
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    stage: "materialization",
    source,
    programInput: {
      kind: "family-materialization-input",
      identity: { identity: { facts: { pool } } },
      cutoff,
      readPlan: ["getReserves"],
      requestId: reserveId,
    },
  }, ports(rpc), new AbortController().signal);
  assert.equal(reserveFacts[0]!.requestId, reserveId);
  assert.equal((requests.at(-1)!.params as readonly { readonly data: string }[])[0]!.data, UNIV2_GET_RESERVES_SELECTOR);
});

test("UniV2 physical lifecycle keeps memo rehydration local and rejects foreign releases", async () => {
  const adapter = UNIV2_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  let calls = 0;
  const rpc = Object.freeze({ async request(): Promise<FamilyPhysicalRpcCompletionV1> { calls += 1; return { kind: "returned", dataHex: "0x" }; } });
  const requestId = h("rehydration-request");
  const referenceHash = h("reference");
  const result = await adapter.execute({
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    stage: "rehydration",
    source,
    programInput: {
      kind: "univ2-verified-memo-reuse-input",
      candidate: {},
      cutoff,
      priorPublication: {},
      identityMemo: {},
      readPlan: ["reference"],
      referenceHash,
      requestId,
    },
  }, ports(rpc), new AbortController().signal);
  assert.deepEqual(result, [{ kind: "returned", requestId, dataHex: referenceHash }]);
  assert.equal(calls, 0);
  await assert.rejects(() => adapter.execute({
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: h("foreign"),
    stage: "rehydration",
    source,
    programInput: {} as CanonicalJson,
  }, ports(rpc), new AbortController().signal), /release binding/);
});

test("UniV2 physical lifecycle preserves revert and transport failure facts", async () => {
  const adapter = UNIV2_STANDARD_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const ids = [h("typed-token0"), h("typed-token1"), h("typed-factory"), h("typed-forward"), h("typed-reverse")];
  const completions: FamilyPhysicalRpcCompletionV1[] = [
    { kind: "returned", dataHex: word(address("2")) },
    { kind: "reverted", dataHex: "0x08c379a0" },
    { kind: "transportFailure", failureCode: "deadline" },
  ];
  const result = await adapter.execute({
    familyId: UNIV2_STANDARD_FAMILY_ID,
    familyDefinitionHash: UNIV2_STANDARD_FAMILY_DEFINITION_HASH,
    stage: "identity",
    source,
    programInput: {
      kind: "family-identity-input",
      nomination: { pool: address("1") },
      cutoff,
      readPlan: ["token0", "token1", "factory", "getPair-forward", "getPair-reverse"],
      requestIds: ids,
      evidenceRoot: h("typed-evidence"),
    },
  }, ports(Object.freeze({
    async request(): Promise<FamilyPhysicalRpcCompletionV1> {
      const next = completions.shift();
      if (next === undefined) throw new TypeError("unexpected dependent request");
      return next;
    },
  })), new AbortController().signal);
  assert.deepEqual(result, [
    { kind: "returned", requestId: ids[0], dataHex: word(address("2")) },
    { kind: "reverted", requestId: ids[1], dataHex: "0x08c379a0" },
    { kind: "transportFailure", requestId: ids[2], failureCode: "deadline" },
  ]);
});
