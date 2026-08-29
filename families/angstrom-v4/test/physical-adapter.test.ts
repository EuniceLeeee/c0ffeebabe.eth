import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type {
  FamilyPhysicalLifecyclePortsV1,
  FamilyPhysicalRpcCompletionV1,
  FamilyPhysicalRpcRequestV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { ANGSTROM_V4_FAMILY_DEFINITION_HASH } from "../src/family-definition.ts";
import { ANGSTROM_V4_FAMILY_ID } from "../src/manifest.ts";
import { ANGSTROM_V4_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY } from "../src/runtime/physical-adapter.ts";

const h = (value: string): Hash => hashDomain("aloha/angstrom-v4-physical-test/v1", value);
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const source = Object.freeze({ chainId: "1", number: "100", hash: cutoff.hash, stateRoot: cutoff.stateRoot });
const word = (value: bigint): string => value.toString(16).padStart(64, "0");

function ports(
  rpc: FamilyPhysicalLifecyclePortsV1["rpc"],
  rawLocatorHash: Hash,
  raw: Uint8Array,
): FamilyPhysicalLifecyclePortsV1 {
  return Object.freeze({
    rpc,
    rawEvidence: Object.freeze({
      read(value: Hash): Uint8Array {
        if (value !== rawLocatorHash) throw new TypeError("foreign raw locator");
        return new Uint8Array(raw);
      },
    }),
  });
}

function execution(stage: "identity" | "materialization" | "rehydration", programInput: CanonicalJson) {
  return Object.freeze({
    familyId: ANGSTROM_V4_FAMILY_ID,
    familyDefinitionHash: ANGSTROM_V4_FAMILY_DEFINITION_HASH,
    stage,
    source,
    programInput,
  });
}

test("Angstrom V4 physical lifecycle reads exact qualified evidence and current virtual reserves", async () => {
  const raw = Uint8Array.of(1, 2, 3, 4);
  const rawLocatorHash = sha256Hex(raw);
  const calls: FamilyPhysicalRpcRequestV1[] = [];
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      calls.push(input);
      const data = ((input.params as readonly { readonly data: string }[])[0]!).data;
      if (data.startsWith("0xc815641c")) return { kind: "returned", dataHex: `0x${word(1n << 96n)}${word(0n)}${word(0n)}${word(0n)}` };
      return { kind: "returned", dataHex: `0x${word(1_000n)}` };
    },
  });
  const adapter = ANGSTROM_V4_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const identityId = h("identity");
  const identity = await adapter.execute(execution("identity", {
    kind: "angstrom-v4-identity-input",
    binding: { evidence: [{ rawLocatorHash }] },
    cutoff,
    readPlan: ["initializeEvidence"],
    requestIds: [identityId],
  }), ports(rpc, rawLocatorHash, raw), new AbortController().signal);
  assert.deepEqual(identity, [{ kind: "returned", requestId: identityId, dataHex: "0x01020304" }]);

  const stateId = h("state-request");
  const state = await adapter.execute(execution("materialization", {
    kind: "angstrom-v4-materialization-input",
    binding: {},
    identityMemo: { identity: { instanceKey: h("pool") } },
    cutoff,
    readPlan: ["state"],
    requestId: stateId,
  }), ports(rpc, rawLocatorHash, raw), new AbortController().signal);
  assert.deepEqual(state, [{ kind: "returned", requestId: stateId, dataHex: `0x${word(1_000n)}${word(1_000n)}` }]);
  assert.equal(calls.length, 2);
  for (const call of calls) assert.deepEqual((call.params as readonly unknown[])[1], { blockHash: cutoff.hash, requireCanonical: true });
});

test("Angstrom V4 physical lifecycle preserves transport failure and rejects unqualified evidence", async () => {
  const raw = Uint8Array.of(5, 6);
  const rawLocatorHash = sha256Hex(raw);
  const adapter = ANGSTROM_V4_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const requestId = h("failed-state");
  const failed = await adapter.execute(execution("materialization", {
    kind: "angstrom-v4-materialization-input",
    binding: {},
    identityMemo: { identity: { instanceKey: h("pool-failure") } },
    cutoff,
    readPlan: ["state"],
    requestId,
  }), ports(Object.freeze({ async request(): Promise<FamilyPhysicalRpcCompletionV1> { return { kind: "transportFailure", failureCode: "deadline" }; } }), rawLocatorHash, raw), new AbortController().signal);
  assert.deepEqual(failed, [{ kind: "transportFailure", requestId, failureCode: "deadline" }]);

  await assert.rejects(() => adapter.execute(execution("identity", {
    kind: "angstrom-v4-identity-input",
    binding: { evidence: [{ rawLocatorHash: h("forged") }] },
    cutoff,
    readPlan: ["initializeEvidence"],
    requestIds: [h("forged-request")],
  }), ports(Object.freeze({ async request(): Promise<FamilyPhysicalRpcCompletionV1> { throw new Error("unused"); } }), h("forged"), raw), new AbortController().signal), /raw evidence hash mismatch/);
});
