import "../../shared/adapters/index.js";

import {
  type AdapterDescriptor,
} from "../../adapters/adapter-descriptors.js";
import {
  assertDescriptorCoverage,
  classifyCall,
  get,
  listAll,
  listDescriptors,
} from "../../adapters/registry.js";
import type { EdgeKind } from "../strategy-taxonomy.js";
import {
  PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS,
} from "../venues/production-family-composition.js";

type EdgeKindKey = EdgeKind | "null";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
}

function edgeKindKey(edgeKind: EdgeKind | null): EdgeKindKey {
  return edgeKind ?? "null";
}

function assertDescriptor(
  descriptor: AdapterDescriptor | null,
  expected: Partial<Pick<AdapterDescriptor, "lineage" | "edgeKind" | "action">>,
  label: string,
): asserts descriptor is AdapterDescriptor {
  assert(descriptor !== null, `${label}: descriptor missing`);
  if (expected.lineage !== undefined) {
    assert(descriptor.lineage === expected.lineage, `${label}: lineage ${descriptor.lineage}`);
  }
  if ("edgeKind" in expected) {
    assert(descriptor.edgeKind === expected.edgeKind, `${label}: edgeKind ${descriptor.edgeKind}`);
  }
  if (expected.action !== undefined) {
    assert(descriptor.action === expected.action, `${label}: action ${descriptor.action}`);
  }
}

function testCoverage(): void {
  assertDescriptorCoverage();
  const registeredIds = listAll().map((adapter) => adapter.id);
  const descriptors = listDescriptors();
  const descriptorIds = descriptors.map((descriptor) => descriptor.adapterId);
  const descriptorById = new Map(
    descriptors.map((descriptor) => [descriptor.adapterId, descriptor]),
  );

  assert(new Set(registeredIds).size === registeredIds.length, "registered adapter IDs must be unique");
  assert(descriptorIds.length === registeredIds.length, `descriptor count ${descriptorIds.length}`);
  for (const id of registeredIds) {
    const descriptor = descriptorById.get(id);
    assert(descriptor !== undefined, `descriptor missing for ${id}`);
    assert(descriptor.adapterId === id, `${id}: descriptor adapterId ${descriptor.adapterId}`);
  }
  console.log("[adapter-descriptors] coverage: PASS");
}

function testEdgeKindCounts(): void {
  const counts: Record<EdgeKindKey, number> = {
    swap: 0,
    credit: 0,
    lp: 0,
    flash: 0,
    protocol: 0,
    null: 0,
  };

  for (const descriptor of listDescriptors()) {
    counts[edgeKindKey(descriptor.edgeKind)] += 1;
  }

  const expected: Record<EdgeKindKey, number> = {
    swap: 0,
    credit: 0,
    lp: 0,
    flash: 0,
    protocol: 0,
    null: 0,
  };
  for (const action of PRODUCTION_STRICT_SHADOW_ACTION_ADAPTERS) {
    assert(action.descriptor !== undefined, `${action.id}: inline descriptor missing`);
    expected[edgeKindKey(action.descriptor.edgeKind)] += 1;
  }
  for (const kind of Object.keys(counts) as EdgeKindKey[]) {
    assert(
      counts[kind] === expected[kind],
      `${kind} count ${counts[kind]} does not match strict closure ${expected[kind]}`,
    );
  }
  assert(counts.swap > 0, "strict closure must contain swap actions");
  assert(counts.flash > 0, "strict closure must contain funding actions");
  assert(counts.protocol > 0, "strict closure must contain protocol actions");
  assert(counts.credit > 0, "strict closure must contain credit actions");
  assert(counts.null > 0, "strict closure must contain infrastructure actions");
  assert(counts.lp === 0, "strict closure must not admit unsupported LP actions");
  console.log("[adapter-descriptors] strict edgeKind closure: PASS");
}

function testClassifyCall(): void {
  assertDescriptor(
    classifyCall("0x0000000000000000000000000000000000000001", "0xbd6015b4"),
    { lineage: "dodo-v2", edgeKind: "swap", action: "swap" },
    "dodo-v2 sellBase",
  );
  assertDescriptor(
    classifyCall("0x0000000000000000000000000000000000000001", "0x128acb08"),
    { lineage: "univ3", edgeKind: "swap" },
    "univ3 swap",
  );
  assertDescriptor(
    classifyCall("0x0000000000000000000000000000000000000002", "0x95991276"),
    { lineage: "psm", edgeKind: "protocol", action: "convert" },
    "psm sellGem",
  );
  assertDescriptor(
    classifyCall("0x0000000000000000000000000000000000000003", "0xdf791e50"),
    { lineage: "metronome", edgeKind: "protocol", action: "convert" },
    "metronome synth swap",
  );
  assertDescriptor(
    classifyCall("0x0000000000000000000000000000000000000004", "0x032d2276"),
    { edgeKind: "credit" },
    "fluid-vault operate",
  );
  assertDescriptor(
    classifyCall("0x0000000000000000000000000000000000000005", "0x095ea7b3"),
    { edgeKind: null },
    "erc20 approve",
  );
  console.log("[adapter-descriptors] classifyCall: PASS");
}

function testValueSenders(): void {
  const valueSenderIds = listDescriptors()
    .filter((descriptor) => descriptor.canSendValue)
    .map((descriptor) => descriptor.adapterId)
    .sort();

  for (const baselineId of [
    "univ4-settle-value",
    "weth-deposit-value",
  ]) {
    assert(valueSenderIds.includes(baselineId), `${baselineId}: value sender`);
  }
  for (const adapterId of valueSenderIds) {
    if (
      adapterId !== "univ4-settle-value" &&
      adapterId !== "weth-deposit-value"
    ) {
      assert(
        get(adapterId).descriptor?.canSendValue === true,
        `${adapterId}: new value sender must declare its descriptor inline`,
      );
    }
  }
  console.log("[adapter-descriptors] canSendValue: PASS");
}

function testCreditStandingPositionDefault(): void {
  const creditDescriptors = listDescriptors()
    .filter((descriptor) => descriptor.edgeKind === "credit");
  assert(creditDescriptors.length === 2, `credit descriptor count ${creditDescriptors.length}`);
  for (const descriptor of creditDescriptors) {
    // Must match the runtime fail-closed law (deriveEdgeTaxonomy: credit -> true). Never fail-open.
    assert(
      descriptor.leavesStandingPositionDefault === true,
      `${descriptor.adapterId}: credit standing-position default must be true (fail-closed, matches deriveEdgeTaxonomy)`,
    );
  }
  console.log("[adapter-descriptors] credit standing-position default: PASS");
}

function main(): void {
  testCoverage();
  testEdgeKindCounts();
  testClassifyCall();
  testValueSenders();
  testCreditStandingPositionDefault();
  console.log("adapter-descriptors PASS (5/5)");
}

main();
