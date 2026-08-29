import assert from "node:assert/strict";
import test from "node:test";
import { hashDomain, type Hash } from "../../canonical-codec/src/index.ts";
import { DiscoveryTransport, type UnderlyingRpcRequest } from "../../discovery-transport/src/index.ts";
import { recentObservationRange } from "../../discovery/src/index.ts";
import { WorkScheduler } from "../../scheduler/src/index.ts";
import {
  decodeEvmLogObservationBytes,
  sealRecentObservation,
} from "../../observation/src/index.ts";
import {
  assertIssuedRecentObservationRpcObserver,
  RecentObservationRpcError,
  RecentObservationRpcObserver,
} from "../src/index.ts";

const h = (value: string): Hash => hashDomain("test/recent-observation-rpc", value);
const address = `0x${"ab".repeat(20)}`;
const topic = h("topic");
const transactionHash = h("transaction");
const cutoff = Object.freeze({
  chainId: "1",
  number: "100",
  hash: h("block:100"),
  stateRoot: h("state:100"),
});

function fromTag(tag: string): string {
  return BigInt(tag).toString();
}

function fixtureTransport(options: {
  readonly brokenParentAt?: string;
  readonly malformedLog?: boolean;
} = {}) {
  const requests: UnderlyingRpcRequest[] = [];
  const numberByHash = new Map(Array.from({ length: 50 }, (_, index) => {
    const number = String(51 + index);
    return [h(`block:${number}`), number] as const;
  }));
  return Object.freeze({
    requests,
    transport: new DiscoveryTransport({
      scheduler: new WorkScheduler(),
      caller: { callerId: "recent-observation-test", authorityToken: "recent-observation-test-authority" },
      port: Object.freeze({
      async request<T>(input: UnderlyingRpcRequest): Promise<T> {
        requests.push(input);
        if (input.method === "eth_getBlockByNumber") {
          const params = input.params as readonly unknown[];
          const number = fromTag(String(params[0]));
          const parentNumber = BigInt(number) - 1n;
          return {
            number: String(params[0]),
            hash: h(`block:${number}`),
            parentHash: options.brokenParentAt === number ? h("broken-parent") : h(`block:${parentNumber}`),
            stateRoot: number === cutoff.number ? cutoff.stateRoot : h(`state:${number}`),
            ignoredProviderField: "not authority",
          } as T;
        }
        if (input.method === "eth_getLogs") {
          const params = input.params as readonly [{ readonly blockHash: Hash }];
          const number = numberByHash.get(params[0].blockHash);
          if (number === undefined) throw new Error("unknown block hash");
          if (number !== "99") return [] as T;
          return [{
            address,
            topics: [topic, h("topic:1")],
            data: "0x0102",
            blockNumber: "0x63",
            blockHash: h("block:99"),
            transactionHash,
            transactionIndex: "0x0",
            logIndex: "0x2",
            removed: options.malformedLog ? true : false,
          }] as T;
        }
        throw new Error(`unexpected method ${input.method}`);
      },
      }),
    }),
  });
}

test("observes exactly cutoff-49..cutoff through scheduler-backed blockHash reads", async () => {
  const fixture = fixtureTransport();
  const observer = new RecentObservationRpcObserver({
    transport: fixture.transport,
    provider: { provider: "reth", backendEpoch: "epoch-1" },
  });
  const scan = await observer.scan(cutoff, new AbortController().signal);
  assert.equal(scan.blocks.length, 50);
  assert.equal(scan.blocks[0]!.number, "51");
  assert.equal(scan.blocks.at(-1)!.number, "100");
  assert.equal(scan.blocks.at(-1)!.hash, cutoff.hash);
  assert.equal(scan.blocks[48]!.evidence.length, 1);
  assert.equal(scan.rawEvidenceLocators.length, 1);
  assert.equal(fixture.requests.filter(request => request.method === "eth_getBlockByNumber").length, 50);
  assert.equal(fixture.requests.filter(request => request.method === "eth_getLogs").length, 50);
  for (const request of fixture.requests.filter(request => request.method === "eth_getLogs")) {
    const params = request.params as readonly [{ readonly blockHash?: unknown }];
    assert.equal(typeof params[0].blockHash, "string");
    assert.deepEqual(Object.keys(params[0]), ["blockHash"]);
  }
  const raw = decodeEvmLogObservationBytes(scan.rawEvidenceLocators[0]!.bytes);
  assert.equal(raw.address, address);
  assert.equal(raw.topics[0], topic);
  assert.equal(raw.blockNumber, "99");
  assert.equal(raw.logIndex, "2");
  const receipt = sealRecentObservation(
    cutoff,
    recentObservationRange(cutoff.number),
    scan.blocks,
    scan.rawEvidenceLocators,
  );
  assert.equal(receipt.range.from, "51");
  assert.equal(receipt.range.to, "100");
  assert.equal(receipt.evidence.length, 1);
});

test("does no physical work when a complete 50-block window is unavailable", async () => {
  const fixture = fixtureTransport();
  const observer = new RecentObservationRpcObserver({
    transport: fixture.transport,
    provider: { provider: "reth", backendEpoch: "epoch-1" },
  });
  await assert.rejects(
    observer.scan({ ...cutoff, number: "48", hash: h("block:48"), stateRoot: h("state:48") }, new AbortController().signal),
    (error: unknown) => error instanceof RecentObservationRpcError && error.code === "window-unavailable",
  );
  assert.equal(fixture.requests.length, 0);
});

test("observer construction and use require owner-issued transport identities", () => {
  const fixture = fixtureTransport();
  const observer = new RecentObservationRpcObserver({
    transport: fixture.transport,
    provider: { provider: "reth", backendEpoch: "epoch-1" },
  });
  assert.doesNotThrow(() => assertIssuedRecentObservationRpcObserver(observer));
  assert.throws(() => assertIssuedRecentObservationRpcObserver({ ...observer }), /not owner-issued/);
  assert.throws(
    () => new RecentObservationRpcObserver({
      transport: { request: fixture.transport.request.bind(fixture.transport) } as never,
      provider: { provider: "reth", backendEpoch: "epoch-1" },
    }),
    /discovery transport is not owner-issued/,
  );
});

test("rejects a self-consistent response whose header lineage is broken", async () => {
  const fixture = fixtureTransport({ brokenParentAt: "75" });
  const observer = new RecentObservationRpcObserver({
    transport: fixture.transport,
    provider: { provider: "reth", backendEpoch: "epoch-1" },
  });
  await assert.rejects(
    observer.scan(cutoff, new AbortController().signal),
    (error: unknown) => error instanceof RecentObservationRpcError && error.code === "header-chain-mismatch",
  );
  assert.equal(fixture.requests.filter(request => request.method === "eth_getLogs").length, 0);
});

test("removed or source-mismatched logs are unavailable facts, never evidence", async () => {
  const fixture = fixtureTransport({ malformedLog: true });
  const observer = new RecentObservationRpcObserver({
    transport: fixture.transport,
    provider: { provider: "reth", backendEpoch: "epoch-1" },
  });
  await assert.rejects(
    observer.scan(cutoff, new AbortController().signal),
    (error: unknown) => error instanceof RecentObservationRpcError && error.code === "malformed-log",
  );
});
