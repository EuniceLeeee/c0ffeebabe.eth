import assert from "node:assert/strict";
import test from "node:test";

import {
  encodeCanonicalJson,
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../canonical-codec/src/index.ts";
import type {
  FamilySourcePlanPhysicalRequestV1,
} from "../../family-sdk/runtime/index.ts";
import type { CanonicalCutoffV1 } from "../../discovery/src/index.ts";
import type { DiscoveryTransport } from "../../discovery-transport/src/index.ts";
import {
  createCentralHistoryReader,
  type RuntimeDiscoveryBindingV1,
} from "../src/internal/discovery-owner.ts";

const h = (value: string): Hash => hashDomain("test/central-history-reader", value);
const topicA = h("topic-a");
const topicB = h("topic-b");
const cutoff: CanonicalCutoffV1 = Object.freeze({
  chainId: "1",
  number: "1",
  hash: h("cutoff"),
  stateRoot: h("state"),
});
const plan = Object.freeze({
  ownerRef: h("owner"),
  sourcePlanRef: h("plan"),
  familyDefinitionHash: h("family"),
  completeness: "rolling-observation" as const,
  historyStartBlock: null,
});
const runtime: RuntimeDiscoveryBindingV1 = Object.freeze({
  runtimeAuthority: Object.freeze({
    authorityBindingHash: h("runtime"),
    implementationCommit: "a".repeat(40),
  }),
  processEpoch: "process",
});

function requestFor(
  topic: Hash,
  observationCutoff: CanonicalCutoffV1 = cutoff,
  range: Readonly<{ readonly from: string; readonly through: string }> = Object.freeze({ from: "0", through: "1" }),
): FamilySourcePlanPhysicalRequestV1 {
  const filter = Object.freeze({
    fromBlock: `0x${BigInt(range.from).toString(16)}`,
    toBlock: `0x${BigInt(range.through).toString(16)}`,
    topics: Object.freeze([topic]),
  });
  return Object.freeze({
    familyDefinitionHash: plan.familyDefinitionHash,
    plan,
    cutoff: observationCutoff,
    requestSchemaHash: h("schema"),
    request: Object.freeze({
      kind: "family-source-plan-rpc" as const,
      version: 1 as const,
      method: "eth_getLogs",
      params: Object.freeze([filter]),
      target: null,
      manager: null,
      topic,
      lookback: Object.freeze(range),
      chunk: Object.freeze({ maxBlocks: "500" }),
    }),
  });
}

function request(topic: Hash): FamilySourcePlanPhysicalRequestV1 {
  return requestFor(topic);
}

function log(topic: Hash, blockNumber: string): CanonicalJson {
  return Object.freeze({
    address: `0x${"11".repeat(20)}`,
    topics: Object.freeze([topic]),
    data: "0x",
    blockNumber: `0x${BigInt(blockNumber).toString(16)}`,
    blockHash: h(`block-${blockNumber}`),
    transactionHash: h(`tx-${blockNumber}-${topic}`),
    transactionIndex: "0x0",
    logIndex: `0x${BigInt(blockNumber).toString(16)}`,
    removed: false,
  });
}

function readerFixture(options: { readonly malformed?: boolean; readonly empty?: boolean; readonly cutoff?: CanonicalCutoffV1 } = {}) {
  const calls: CanonicalJson[] = [];
  const transport = {
    async request(input: { readonly params: CanonicalJson }): Promise<CanonicalJson> {
      calls.push(input.params);
      if (options.malformed) return Object.freeze([{ malformed: true }]);
      if (options.empty) return Object.freeze([]);
      return Object.freeze([log(topicA, "0"), log(topicB, "1")]);
    },
  } as unknown as DiscoveryTransport;
  const reader = createCentralHistoryReader({
    cutoff: options.cutoff ?? cutoff,
    sourceAnchorRoot: h("anchor"),
    runtime,
    sourceAuthorityRoot: h("source-authority"),
    provider: Object.freeze({ provider: "fixture", backendEpoch: "1" }),
    transport,
  });
  return Object.freeze({ reader, calls });
}

test("central history coalesces same-range Family filters and projects each subset", async () => {
  const fixture = readerFixture();
  const signal = new AbortController().signal;
  const [a, b] = await Promise.all([
    fixture.reader.read(request(topicA), signal),
    fixture.reader.read(request(topicB), signal),
  ]);
  assert.equal(fixture.calls.length, 1);
  assert.equal(Array.isArray(a), true);
  assert.equal(Array.isArray(b), true);
  assert.equal(encodeCanonicalJson(a), encodeCanonicalJson([log(topicA, "0")]));
  assert.equal(encodeCanonicalJson(b), encodeCanonicalJson([log(topicB, "1")]));
  await fixture.reader.read(request(topicA), signal);
  assert.equal(fixture.calls.length, 1);
  await fixture.reader.read(request(h("new-topic")), signal);
  assert.equal(fixture.calls.length, 2, "a filter not covered by the cached union must not become a false negative");
});

test("central history does not shrink-retry malformed log data", async () => {
  const fixture = readerFixture({ malformed: true });
  await assert.rejects(fixture.reader.read(request(topicA), new AbortController().signal), /blockNumber/);
  assert.equal(fixture.calls.length, 1);
});

test("central history honors an already-aborted run before scheduling a scan", async () => {
  const fixture = readerFixture();
  const controller = new AbortController();
  controller.abort(new Error("run stopped"));
  await assert.rejects(fixture.reader.read(request(topicA), controller.signal), /run stopped/);
  assert.equal(fixture.calls.length, 0);
});

test("central history scans the complete owner window once and reuses it for later chunks", async () => {
  const largeCutoff: CanonicalCutoffV1 = Object.freeze({
    chainId: "1",
    number: "1200",
    hash: h("large-cutoff"),
    stateRoot: h("large-state"),
  });
  const fixture = readerFixture({ cutoff: largeCutoff, empty: true });
  const signal = new AbortController().signal;
  const first = await fixture.reader.read(requestFor(topicA, largeCutoff, { from: "0", through: "499" }), signal);
  assert.deepEqual(first, []);
  assert.equal(fixture.calls.length, 3, "the owner window is split into 500-block physical ranges");
  const second = await fixture.reader.read(requestFor(topicA, largeCutoff, { from: "500", through: "999" }), signal);
  assert.deepEqual(second, []);
  assert.equal(fixture.calls.length, 3, "a later Family chunk reuses the completed owner scan");
});
