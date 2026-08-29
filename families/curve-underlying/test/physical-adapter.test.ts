import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../packages/canonical-codec/src/index.ts";
import type { FamilyPhysicalRpcCompletionV1, FamilyPhysicalRpcRequestV1 } from "../../../packages/family-sdk/runtime/index.ts";
import {
  CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
} from "../src/family-definition.ts";
import { CURVE_METAREGISTRY, CURVE_UNDERLYING_FAMILY_ID } from "../src/manifest.ts";
import { CURVE_UNDERLYING_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY } from "../src/runtime/physical-adapter.ts";

const h = (value: string): Hash => hashDomain("aloha/curve-physical-test/v1", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const addressWord = (value: string): string => word(BigInt(value));
const fixedArray = (values: readonly bigint[], count: number): string =>
  `0x${[...values, ...Array.from({ length: count - values.length }, () => 0n)].map(word).join("")}`;
const dynamicArray = (values: readonly bigint[]): string => `0x${[32n, BigInt(values.length), ...values].map(word).join("")}`;
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const source = Object.freeze({ chainId: "1", number: "100", hash: cutoff.hash, stateRoot: cutoff.stateRoot });
const rawEvidence = Object.freeze({ read(): Uint8Array { throw new TypeError("Curve physical adapter does not read raw evidence"); } });

function decoded(value: string): CanonicalJson {
  const raw = value.slice(2);
  const bytes = new Uint8Array(raw.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(raw.slice(index * 2, index * 2 + 2), 16);
  }
  return decodeCanonicalJson(new TextDecoder().decode(bytes));
}

test("Curve physical lifecycle reverse-verifies registry identity at one EIP-1898 source", async () => {
  const pool = address("1");
  const token0 = address("2");
  const token1 = address("3");
  const handler = address("4");
  const requestId = h("identity-request");
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      requests.push(input);
      if (input.method === "eth_getCode") return { kind: "returned", dataHex: "0x6000" };
      const call = (input.params as readonly { readonly data: string }[])[0]!;
      if (call.data.startsWith("0x308d1b6d")) return { kind: "returned", dataHex: fixedArray([BigInt(handler)], 10) };
      if (call.data.startsWith("0xa77576ef")) return { kind: "returned", dataHex: fixedArray([BigInt(token0), BigInt(token1)], 8) };
      if (call.data.startsWith("0x4cb088f1")) return { kind: "returned", dataHex: fixedArray([6n, 18n], 8) };
      if (call.data.startsWith("0x07211ef7")) {
        const i = BigInt(`0x${call.data.slice(10, 74)}`);
        return i === 1n
          ? { kind: "reverted", dataHex: "0x" }
          : { kind: "returned", dataHex: `0x${word(99n)}` };
      }
      if (call.data.startsWith("0x85f11d1e")) return { kind: "reverted", dataHex: "0x" };
      throw new TypeError("unexpected Curve physical request");
    },
  });
  const adapter = CURVE_UNDERLYING_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const result = await adapter.execute({
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: {
      kind: "curve-underlying-identity-input",
      candidate: { instanceNominationKey: pool, candidateSubjectHash: h("candidate") },
      cutoff,
      readPlan: ["identity"],
      requestId,
    },
  }, { rpc, rawEvidence }, new AbortController().signal);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.kind, "returned");
  const fact = decoded((result[0] as { readonly dataHex: string }).dataHex) as {
    readonly reads: {
      readonly pool: string;
      readonly metaRegistry: string;
      readonly registryPool: string;
      readonly handlers: readonly string[];
      readonly underlyingCoins: readonly string[];
      readonly underlyingDecimals: readonly number[];
      readonly verifiedDirections: readonly { readonly selectorVariant: string }[];
    };
  };
  assert.equal(fact.reads.pool, pool);
  assert.equal(fact.reads.metaRegistry, CURVE_METAREGISTRY);
  assert.equal(fact.reads.registryPool, pool);
  assert.deepEqual(fact.reads.handlers, [handler]);
  assert.deepEqual(fact.reads.underlyingCoins, [token0, token1]);
  assert.deepEqual(fact.reads.underlyingDecimals, [6, 18]);
  assert.equal(fact.reads.verifiedDirections.length, 1);
  assert.equal(fact.reads.verifiedDirections[0]!.selectorVariant, "int128");
  assert.equal(requests.length, 13);
  for (const request of requests) {
    const params = request.params as readonly unknown[];
    assert.deepEqual(params[1], { blockHash: cutoff.hash, requireCanonical: true });
  }
});

test("Curve physical lifecycle binds a uint256-only behavior witness", async () => {
  const pool = address("1");
  const requestId = h("uint-identity-request");
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      if (input.method === "eth_getCode") return { kind: "returned", dataHex: "0x6000" };
      const call = (input.params as readonly { readonly data: string }[])[0]!;
      if (call.data.startsWith("0x308d1b6d")) return { kind: "returned", dataHex: fixedArray([BigInt(address("4"))], 10) };
      if (call.data.startsWith("0xa77576ef")) return { kind: "returned", dataHex: fixedArray([BigInt(address("2")), BigInt(address("3"))], 8) };
      if (call.data.startsWith("0x4cb088f1")) return { kind: "returned", dataHex: fixedArray([18n, 18n], 8) };
      if (call.data.startsWith("0x07211ef7")) return { kind: "reverted", dataHex: "0x" };
      if (call.data.startsWith("0x85f11d1e")) {
        const i = BigInt(`0x${call.data.slice(10, 74)}`);
        return i === 0n ? { kind: "returned", dataHex: `0x${word(99n)}` } : { kind: "reverted", dataHex: "0x" };
      }
      throw new TypeError("unexpected Curve uint identity request");
    },
  });
  const result = await CURVE_UNDERLYING_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: { kind: "curve-underlying-identity-input", candidate: { instanceNominationKey: pool, candidateSubjectHash: h("uint-candidate") }, cutoff, readPlan: ["identity"], requestId },
  }, { rpc, rawEvidence }, new AbortController().signal);
  const fact = decoded((result[0] as { readonly dataHex: string }).dataHex) as { readonly reads: { readonly verifiedDirections: readonly { readonly selectorVariant: string }[] } };
  assert.deepEqual(fact.reads.verifiedDirections.map(value => value.selectorVariant), ["uint256"]);
});

test("Curve physical lifecycle reads NG state without caller-supplied protocol callbacks", async () => {
  const pool = address("1");
  const requestId = h("state-request");
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      requests.push(input);
      const call = (input.params as readonly { readonly data: string }[])[0]!;
      if (call.data === "0xf446c1d0") return { kind: "returned", dataHex: `0x${word(100n)}` };
      if (call.data === "0xddca3f43") return { kind: "returned", dataHex: `0x${word(4_000_000n)}` };
      if (call.data.startsWith("0x59f4f351")) return { kind: "returned", dataHex: fixedArray([1_000_000n, 2_000_000_000_000_000_000n], 8) };
      if (call.data === "0x8edfdd5f") return { kind: "returned", dataHex: `0x${word(20_000_000_000n)}` };
      if (call.data === "0xfd0684b1") return { kind: "returned", dataHex: dynamicArray([10n ** 30n, 2n * 10n ** 18n]) };
      throw new TypeError("unexpected Curve state request");
    },
  });
  const adapter = CURVE_UNDERLYING_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const result = await adapter.execute({
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    stage: "materialization",
    source,
    programInput: {
      kind: "curve-underlying-materialization-input",
      identityMemo: { identity: { instanceKey: pool, facts: { underlyingDecimals: [6, 18] } } },
      cutoff,
      readPlan: ["state"],
      requestId,
    },
  }, { rpc, rawEvidence }, new AbortController().signal);
  const fact = decoded((result[0] as { readonly dataHex: string }).dataHex) as {
    readonly read: { readonly variant: string; readonly balances: readonly string[]; readonly rates: readonly string[] };
  };
  assert.equal(fact.read.variant, "ng");
  assert.deepEqual(fact.read.balances, ["1000000", "2000000000000000000"]);
  assert.deepEqual(fact.read.rates, ["1000000000000000000000000000000", "2000000000000000000"]);
  assert.equal(requests.length, 5);
});

test("Curve physical lifecycle classifies only deterministic offpeg revert as plain", async () => {
  const pool = address("1");
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      const call = (input.params as readonly { readonly data: string }[])[0]!;
      if (call.data === "0xf446c1d0") return { kind: "returned", dataHex: `0x${word(100n)}` };
      if (call.data === "0xddca3f43") return { kind: "returned", dataHex: `0x${word(4_000_000n)}` };
      if (call.data.startsWith("0x59f4f351")) return { kind: "returned", dataHex: fixedArray([1_000_000n, 2_000_000_000_000_000_000n], 8) };
      if (call.data === "0x8edfdd5f") return { kind: "reverted", dataHex: "0x" };
      throw new TypeError("unexpected Curve plain-state request");
    },
  });
  const result = await CURVE_UNDERLYING_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    stage: "projection",
    source,
    programInput: {
      kind: "curve-underlying-projection-input",
      identityMemo: { identity: { instanceKey: pool, facts: { underlyingDecimals: [6, 18] } } },
      materialization: {},
      cutoff,
      readPlan: ["state"],
      requestId: h("plain-state-request"),
    },
  }, { rpc, rawEvidence }, new AbortController().signal);
  const fact = decoded((result[0] as { readonly dataHex: string }).dataHex) as {
    readonly read: { readonly variant: string; readonly offpegFeeMultiplier?: string };
  };
  assert.equal(fact.read.variant, "plain");
  assert.equal(fact.read.offpegFeeMultiplier, undefined);
});

test("Curve physical lifecycle propagates transport failure and performs no dependent probes", async () => {
  const pool = address("1");
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      requests.push(input);
      const operation = input.requestId;
      if (operation === hashDomain("aloha/curve-underlying/physical-subrequest/v1", { requestId: h("transport-request"), operation: "registry-handlers" })) {
        return { kind: "transportFailure", failureCode: "deadline" };
      }
      if (input.method === "eth_getCode") return { kind: "returned", dataHex: "0x6000" };
      const call = (input.params as readonly { readonly data: string }[])[0]!;
      if (call.data.startsWith("0xa77576ef")) return { kind: "returned", dataHex: fixedArray([BigInt(address("2")), BigInt(address("3"))], 8) };
      return { kind: "returned", dataHex: fixedArray([18n, 18n], 8) };
    },
  });
  const result = await CURVE_UNDERLYING_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY().execute({
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: {
      kind: "curve-underlying-identity-input",
      candidate: { instanceNominationKey: pool, candidateSubjectHash: h("candidate") },
      cutoff,
      readPlan: ["identity"],
      requestId: h("transport-request"),
    },
  }, { rpc, rawEvidence }, new AbortController().signal);
  assert.deepEqual(result, [{ kind: "transportFailure", requestId: h("transport-request"), failureCode: "deadline" }]);
  assert.equal(requests.some(request => {
    if (request.method !== "eth_call") return false;
    return ((request.params as readonly { readonly data: string }[])[0]!.data).startsWith("0x07211ef7");
  }), false);
});

test("Curve physical lifecycle fails closed on malformed ABI and foreign releases", async () => {
  const adapter = CURVE_UNDERLYING_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const rpc = Object.freeze({ async request() { return { kind: "returned" as const, dataHex: `0x${word(1n)}` }; } });
  await assert.rejects(() => adapter.execute({
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: h("foreign"),
    stage: "identity",
    source,
    programInput: {} as CanonicalJson,
  }, { rpc, rawEvidence }, new AbortController().signal), /release binding/);

  await assert.rejects(() => adapter.execute({
    familyId: CURVE_UNDERLYING_FAMILY_ID,
    familyDefinitionHash: CURVE_UNDERLYING_FAMILY_AUTHORING_HASH,
    stage: "identity",
    source,
    programInput: {
      kind: "curve-underlying-identity-input",
      candidate: { instanceNominationKey: address("1"), candidateSubjectHash: h("candidate") },
      cutoff,
      readPlan: ["identity"],
      requestId: h("bad-abi"),
    },
  }, { rpc, rawEvidence }, new AbortController().signal), /ABI result mismatch/);
});
