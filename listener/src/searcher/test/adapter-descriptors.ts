import "../../shared/adapters/index.js";

import {
  ADAPTER_DESCRIPTORS,
  descriptorFor,
  type AdapterDescriptor,
} from "../../adapters/adapter-descriptors.js";
import {
  assertDescriptorCoverage,
  classifyCall,
  listAll,
} from "../../adapters/registry.js";
import type { EdgeKind } from "../strategy-taxonomy.js";

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
  const descriptorIds = Object.keys(ADAPTER_DESCRIPTORS);

  assert(new Set(registeredIds).size === registeredIds.length, "registered adapter IDs must be unique");
  assert(descriptorIds.length === registeredIds.length, `descriptor count ${descriptorIds.length}`);
  for (const id of registeredIds) {
    const descriptor = descriptorFor(id);
    assert(descriptor !== null, `descriptor missing for ${id}`);
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

  for (const descriptor of Object.values(ADAPTER_DESCRIPTORS)) {
    counts[edgeKindKey(descriptor.edgeKind)] += 1;
  }

  assert(counts.swap >= 16, `swap count regressed below baseline: ${counts.swap}`);
  assert(counts.flash === 2, `flash count ${counts.flash}`);
  assert(counts.protocol >= 11, `protocol count regressed below baseline: ${counts.protocol}`);
  assert(counts.credit === 2, `credit count ${counts.credit}`);
  assert(counts.null === 3, `null count ${counts.null}`);
  assert(counts.lp === 0, `lp count ${counts.lp}`);
  console.log("[adapter-descriptors] edgeKind counts: PASS");
}

function testClassifyCall(): void {
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
  const valueSenderIds = Object.values(ADAPTER_DESCRIPTORS)
    .filter((descriptor) => descriptor.canSendValue)
    .map((descriptor) => descriptor.adapterId)
    .sort();

  assert(
    valueSenderIds.join(",") === "univ4-settle-value,weth-deposit-value",
    `value sender ids ${valueSenderIds.join(",")}`,
  );
  console.log("[adapter-descriptors] canSendValue: PASS");
}

function testCreditStandingPositionDefault(): void {
  const creditDescriptors = Object.values(ADAPTER_DESCRIPTORS)
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
