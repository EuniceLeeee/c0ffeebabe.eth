import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { asOwnerRef } from "../../capability-contracts/src/index.ts";
import type {
  FamilyPhysicalLifecyclePortsV1,
  FamilyPhysicalRpcCompletionV1,
  FamilyPhysicalRpcRequestV1,
} from "../../family-sdk/runtime/index.ts";
import {
  executeGeneratedFamilyPhysicalLifecycle,
  readGeneratedFamilyPhysicalLifecycleAdapters,
} from "../src/internal/generated-runtime-composition.ts";
import { createReleaseFamilyRuntimeComposition } from "../../../generated/runtime-composition/index.ts";
import {
  UNIV2_FACTORY_SELECTOR,
  UNIV2_GET_PAIR_SELECTOR,
  UNIV2_TOKEN0_SELECTOR,
  UNIV2_TOKEN1_SELECTOR,
} from "../../../families/univ2-standard/src/schema/index.ts";

const h = (value: string): Hash => hashDomain("aloha/generated-physical-router-test/v1", value);
const address = (digit: string): string => `0x${digit.repeat(40)}`;
const word = (value: string): string => `0x${"0".repeat(24)}${value.slice(2)}`;

test("generated physical router installs seven Families and invokes only the nominated lifecycle", async () => {
  const bindings = readGeneratedFamilyPhysicalLifecycleAdapters(createReleaseFamilyRuntimeComposition);
  assert.deepEqual(bindings.map(binding => binding.familyId), [
    "angstrom-v4",
    "curve-underlying",
    "dodo-v2",
    "fluid-dex",
    "univ2-standard",
    "univ3-standard",
    "univ4",
  ]);
  const binding = bindings.find(value => value.familyId === "univ2-standard")!;
  const pool = address("1");
  const token0 = address("2");
  const token1 = address("3");
  const factory = address("4");
  const cutoff = Object.freeze({ chainId: "1", number: "100", hash: h("block"), stateRoot: h("state") });
  const requestIds = Object.freeze([h("token0"), h("token1"), h("factory"), h("forward"), h("reverse")]);
  const requests: FamilyPhysicalRpcRequestV1[] = [];
  const ports: FamilyPhysicalLifecyclePortsV1 = Object.freeze({
    rpc: Object.freeze({
      async request(input: FamilyPhysicalRpcRequestV1): Promise<FamilyPhysicalRpcCompletionV1> {
        requests.push(input);
        const data = (input.params as readonly { readonly data?: string }[])[0]?.data;
        if (data === UNIV2_TOKEN0_SELECTOR) return { kind: "returned", dataHex: word(token0) };
        if (data === UNIV2_TOKEN1_SELECTOR) return { kind: "returned", dataHex: word(token1) };
        if (data === UNIV2_FACTORY_SELECTOR) return { kind: "returned", dataHex: word(factory) };
        if (data?.startsWith(UNIV2_GET_PAIR_SELECTOR)) return { kind: "returned", dataHex: word(pool) };
        throw new TypeError("unexpected generated physical request");
      },
    }),
    rawEvidence: Object.freeze({
      read(): Uint8Array { throw new TypeError("UniV2 does not read raw evidence"); },
    }),
  });
  const route = Object.freeze({
    stageRef: binding.lifecycleRefs.identity,
    execution: Object.freeze({
      familyId: binding.familyId,
      familyDefinitionHash: binding.familyDefinitionHash,
      stage: "identity" as const,
      source: cutoff,
      programInput: Object.freeze({
        kind: "family-identity-input",
        nomination: Object.freeze({ pool }),
        cutoff,
        readPlan: Object.freeze(["token0", "token1", "factory", "getPair-forward", "getPair-reverse"]),
        requestIds,
        evidenceRoot: h("evidence"),
      }),
    }),
  });
  const results = await executeGeneratedFamilyPhysicalLifecycle(
    createReleaseFamilyRuntimeComposition,
    route,
    ports,
    new AbortController().signal,
  );
  assert.deepEqual(results.map(result => result.requestId), requestIds);
  assert.equal(requests.length, 5);

  await assert.rejects(() => executeGeneratedFamilyPhysicalLifecycle(
    createReleaseFamilyRuntimeComposition,
    {
      ...route,
      stageRef: Object.freeze({ ...route.stageRef, ownerRef: asOwnerRef(h("foreign-owner")) }),
    },
    ports,
    new AbortController().signal,
  ), /lifecycle ref mismatch/);
  assert.equal(requests.length, 5);
});
