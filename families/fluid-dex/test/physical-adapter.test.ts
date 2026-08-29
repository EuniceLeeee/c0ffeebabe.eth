import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, sha256Hex, type CanonicalJson, type Hash } from "../../../packages/canonical-codec/src/index.ts";
import type {
  FamilyPhysicalLifecyclePortsV1,
  FamilyPhysicalRpcCompletionV1,
  FamilyPhysicalRpcRequestV1,
} from "../../../packages/family-sdk/runtime/index.ts";
import { FLUID_DEX_FAMILY_DEFINITION_HASH } from "../src/family-definition.ts";
import { FLUID_DEX_FAMILY_ID } from "../src/manifest.ts";
import { FLUID_DEX_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY } from "../src/runtime/physical-adapter.ts";

const h = (value: string): Hash => hashDomain("aloha/fluid-dex-physical-test/v1", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
const addressWord = (value: string): string => value.slice(2).padStart(64, "0");
const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
const source = Object.freeze({ chainId: "1", number: "100", hash: cutoff.hash, stateRoot: cutoff.stateRoot });

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

function execution(stage: "identity" | "materialization", programInput: CanonicalJson) {
  return Object.freeze({ familyId: FLUID_DEX_FAMILY_ID, familyDefinitionHash: FLUID_DEX_FAMILY_DEFINITION_HASH, stage, source, programInput });
}

test("Fluid DEX physical lifecycle reverse-binds factory identity and current quote facts", async () => {
  const pool = address("1");
  const token0 = address("2");
  const token1 = address("3");
  const raw = Uint8Array.of(7, 8, 9);
  const rawLocatorHash = sha256Hex(raw);
  const ids = [h("target"), h("reverse"), h("input"), h("output"), h("evidence")];
  const constants = Array.from({ length: 18 }, () => word(0n));
  constants[0] = word(7n);
  constants[9] = addressWord(token0);
  constants[10] = addressWord(token1);
  const calls: FamilyPhysicalRpcRequestV1[] = [];
  const rpc = Object.freeze({
    async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
      calls.push(input);
      const data = ((input.params as readonly { readonly data: string }[])[0]!).data;
      if (data === "0xb7791bf2") return { kind: "returned", dataHex: `0x${constants.join("")}` };
      if (data.startsWith("0x12e366aa")) return { kind: "returned", dataHex: `0x${addressWord(pool)}` };
      if (data.startsWith("0x2668dfaa")) return { kind: "returned", dataHex: `0x${word(2_000n)}` };
      throw new TypeError("unexpected Fluid physical request");
    },
  });
  const adapter = FLUID_DEX_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const identity = await adapter.execute(execution("identity", {
    kind: "fluid-dex-identity-input",
    binding: { candidate: { target: pool, evidence: { rawLocatorHash } } },
    cutoff,
    readPlan: ["target", "reverseTarget", "inputAsset", "outputAsset", "candidateEvidence"],
    requestIds: ids,
  }), ports(rpc, rawLocatorHash, raw), new AbortController().signal);
  assert.deepEqual(identity.map(value => value.requestId), ids);
  assert.equal(identity[0]!.kind === "returned" && identity[0].dataHex, `0x${addressWord(pool)}`);
  assert.equal(identity[2]!.kind === "returned" && identity[2].dataHex, `0x${addressWord(token0)}`);
  assert.equal(identity[4]!.kind === "returned" && identity[4].dataHex, "0x070809");

  const stateId = h("quote-state");
  const state = await adapter.execute(execution("materialization", {
    kind: "fluid-dex-materialization-input",
    binding: {},
    identityMemo: { identity: { instanceKey: pool } },
    cutoff,
    readPlan: ["state"],
    requestId: stateId,
  }), ports(rpc, rawLocatorHash, raw), new AbortController().signal);
  assert.deepEqual(state, [{ kind: "returned", requestId: stateId, dataHex: `0x${word(10n ** 18n)}${word(2_000n)}` }]);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.deepEqual((call.params as readonly unknown[])[1], { blockHash: cutoff.hash, requireCanonical: true });
});

test("Fluid DEX physical lifecycle preserves transport failure and evidence hash mismatch", async () => {
  const pool = address("4");
  const raw = Uint8Array.of(1);
  const rawLocatorHash = sha256Hex(raw);
  const adapter = FLUID_DEX_PHYSICAL_LIFECYCLE_ADAPTER_FACTORY();
  const requestId = h("failed-state");
  const result = await adapter.execute(execution("materialization", {
    kind: "fluid-dex-materialization-input",
    binding: {},
    identityMemo: { identity: { instanceKey: pool } },
    cutoff,
    readPlan: ["state"],
    requestId,
  }), ports(Object.freeze({ async request(): Promise<FamilyPhysicalRpcCompletionV1> { return { kind: "transportFailure", failureCode: "source-stale" }; } }), rawLocatorHash, raw), new AbortController().signal);
  assert.deepEqual(result, [{ kind: "transportFailure", requestId, failureCode: "source-stale" }]);
});
