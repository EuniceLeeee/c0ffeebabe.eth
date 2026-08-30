import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hashDomain,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  acquireHistoricalFamilyFactsV1,
  type HistoricalFamilyFactsJsonRpcV1,
} from "@aloha/historical-family-fact-probe/acquisition";
import { loadHistoricalFamilyFactBundleV1 } from "../src/index.ts";

const txHash = `0x${"1".repeat(64)}` as Hash;
const otherTxHash = `0x${"2".repeat(64)}` as Hash;
const blockHash = `0x${"3".repeat(64)}` as Hash;
const otherBlockHash = `0x${"4".repeat(64)}` as Hash;
const topic0 = `0x${"5".repeat(64)}` as Hash;
const venue = `0x${"6".repeat(40)}`;
const blockNumber = "0x65";
const transactionIndex = "0x3";
const transactionInput = "0x1234";

interface FixtureOptions {
  readonly transactionHash?: Hash;
  readonly transactionIndex?: string;
  readonly receiptTransactionHash?: Hash;
  readonly receiptTransactionIndex?: string;
  readonly receiptLogs?: readonly CanonicalJson[];
  readonly header?: CanonicalJson;
  readonly afterHeader?: CanonicalJson;
  readonly chainId?: unknown;
  readonly afterChainId?: unknown;
  readonly trace?: unknown;
}

function log(options: {
  readonly selectedTxHash?: Hash;
  readonly selectedBlockHash?: Hash;
  readonly selectedBlockNumber?: string;
  readonly logIndex?: string;
} = {}): CanonicalJson {
  return {
    address: venue,
    blockHash: options.selectedBlockHash ?? blockHash,
    blockNumber: options.selectedBlockNumber ?? blockNumber,
    data: "0x",
    logIndex: options.logIndex ?? "0x2",
    removed: false,
    topics: [topic0],
    transactionHash: options.selectedTxHash ?? txHash,
    transactionIndex,
  };
}

function header(
  selectedHash: Hash = blockHash,
  selectedTransactionAtIndex: Hash = txHash,
): Readonly<Record<string, CanonicalJson>> {
  return {
    hash: selectedHash,
    number: blockNumber,
    parentHash: `0x${"7".repeat(64)}`,
    stateRoot: `0x${"8".repeat(64)}`,
    transactions: [
      `0x${"9".repeat(64)}`,
      `0x${"a".repeat(64)}`,
      `0x${"b".repeat(64)}`,
      selectedTransactionAtIndex,
    ],
  };
}

function fixture(options: FixtureOptions = {}): Readonly<Record<string, unknown>> {
  const selectedLog = log();
  const selectedHeader = options.header ?? header();
  return Object.freeze({
    chainId: options.chainId ?? "0x1",
    afterChainId: options.afterChainId ?? options.chainId ?? "0x1",
    transaction: {
      hash: options.transactionHash ?? txHash,
      blockHash,
      blockNumber,
      from: venue,
      to: venue,
      input: transactionInput,
      value: "0x0",
      transactionIndex: options.transactionIndex ?? transactionIndex,
    },
    receipt: {
      transactionHash: options.receiptTransactionHash ?? txHash,
      blockHash,
      blockNumber,
      transactionIndex: options.receiptTransactionIndex ?? transactionIndex,
      status: "0x1",
      logs: options.receiptLogs ?? [selectedLog],
    },
    trace: options.trace === undefined ? {
      type: "CALL",
      from: venue,
      to: venue,
      input: transactionInput,
      value: "0x0",
    } : options.trace,
    header: selectedHeader,
    afterHeader: options.afterHeader ?? selectedHeader,
  });
}

class FakeRpc implements HistoricalFamilyFactsJsonRpcV1 {
  readonly calls: Array<Readonly<{ method: string; params: readonly CanonicalJson[] }>> = [];
  private blockFenceReads = 0;
  private chainFenceReads = 0;
  private readonly values: Readonly<Record<string, unknown>>;
  private readonly logs: (
    filter: Readonly<Record<string, CanonicalJson>>,
  ) => readonly CanonicalJson[];

  constructor(
    values: Readonly<Record<string, unknown>>,
    logs: (
      filter: Readonly<Record<string, CanonicalJson>>,
    ) => readonly CanonicalJson[] = (filter) =>
      BigInt(filter.fromBlock as string) <= 0x65n && BigInt(filter.toBlock as string) >= 0x65n
        ? [log()]
        : [],
  ) {
    this.values = values;
    this.logs = logs;
  }

  async request(method: string, params: readonly CanonicalJson[]): Promise<unknown> {
    this.calls.push(Object.freeze({ method, params }));
    switch (method) {
      case "eth_getLogs":
        return this.logs(params[0] as Readonly<Record<string, CanonicalJson>>);
      case "eth_chainId":
        return this.chainFenceReads++ === 0 ? this.values.chainId : this.values.afterChainId;
      case "eth_getBlockByNumber":
        return this.blockFenceReads++ === 0 ? this.values.header : this.values.afterHeader;
      case "eth_getTransactionByHash":
        return this.values.transaction;
      case "eth_getTransactionReceipt":
        return this.values.receipt;
      case "debug_traceTransaction":
        return this.values.trace;
      case "eth_getBlockByHash":
        return this.values.header;
      default:
        throw new Error(`unexpected RPC method ${method}`);
    }
  }
}

function request(rootDirectory: string) {
  return {
    rootDirectory,
    discovery: {
      fromBlock: "0x60",
      toBlock: "0x6f",
      maxBlocksPerRequest: "4",
      address: venue,
      topic0,
    },
  } as const;
}

async function withStore(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aloha-historical-acquisition-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("discovers newest-first, fences canonical identity, and materializes four immutable raw objects", async () => {
  await withStore(async (directory) => {
    const ranges: Array<readonly [string, string]> = [];
    const rpc = new FakeRpc(fixture(), (filter) => {
      ranges.push([filter.fromBlock as string, filter.toBlock as string]);
      if (filter.fromBlock === "0x64") {
        return [
          log({ selectedBlockNumber: "0x64", logIndex: "0x9" }),
          log(),
          log({ logIndex: "0x1" }),
        ];
      }
      return [];
    });
    const acquisition = await acquireHistoricalFamilyFactsV1(rpc, request(directory));
    assert.deepEqual(ranges, [
      ["0x6c", "0x6f"],
      ["0x68", "0x6b"],
      ["0x64", "0x67"],
    ]);
    assert.deepEqual(acquisition.locator, {
      blockNumber,
      blockHash,
      txHash,
      transactionIndex,
      logIndex: "0x2",
      address: venue,
      topic0,
    });
    assert.equal(acquisition.chainId, "1");
    assert.equal(acquisition.advisoryOnly, true);
    assert.equal(rpc.calls.filter((call) => call.method === "eth_chainId").length, 2);
    assert.equal(rpc.calls[0]?.method, "eth_chainId");
    assert.equal(rpc.calls.at(-1)?.method, "eth_chainId");
    assert.equal("status" in acquisition, false);
    assert.equal("pass" in acquisition, false);
    assert.equal(
      acquisition.identityRoot,
      hashDomain("aloha/historical-family-facts-acquisition-identity/v1", {
        chainId: "1",
        canonicalBlockHash: blockHash,
        txHash,
      }),
    );
    assert.ok(Object.isFrozen(acquisition));
    assert.ok(Object.isFrozen(acquisition.locator));
    const bundle = loadHistoricalFamilyFactBundleV1(directory, acquisition.manifestRoot);
    assert.deepEqual(bundle.manifest.entries.map((entry) => entry.role), [
      "transaction",
      "receipt",
      "trace",
      "header",
    ]);
    const traceCall = rpc.calls.find((call) => call.method === "debug_traceTransaction")!;
    assert.deepEqual(traceCall.params, [
      txHash,
      { tracer: "callTracer", tracerConfig: { onlyTopCall: false } },
    ]);
  });
});

test("fails closed when the canonical block changes across the acquisition fence", async () => {
  await withStore(async (directory) => {
    const rpc = new FakeRpc(fixture({ afterHeader: header(otherBlockHash) }));
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(rpc, request(directory)),
      /canonicalFence\.after block hash mismatch/,
    );
  });
  await withStore(async (directory) => {
    const rpc = new FakeRpc(fixture({
      afterHeader: { ...header(), timestamp: "0x2" },
    }));
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(rpc, request(directory)),
      /canonical block changed during acquisition/,
    );
  });
});

test("fails closed when the RPC chain changes across the acquisition fence", async () => {
  await withStore(async (directory) => {
    const rpc = new FakeRpc(fixture({ afterChainId: "0x2" }));
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(rpc, request(directory)),
      /chainId changed during acquisition/,
    );
  });
});

test("rejects cross-transaction material and a discovery locator absent from the receipt", async () => {
  await withStore(async (directory) => {
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(
        new FakeRpc(fixture({ transactionHash: otherTxHash })),
        request(directory),
      ),
      /transaction hash mismatch/,
    );
  });
  await withStore(async (directory) => {
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(
        new FakeRpc(fixture({ receiptTransactionHash: otherTxHash })),
        request(directory),
      ),
      /receipt transaction hash mismatch/,
    );
  });
  await withStore(async (directory) => {
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(
        new FakeRpc(fixture({ receiptLogs: [log({ logIndex: "0x3" })] })),
        request(directory),
      ),
      /discovered log locator is absent from receipt/,
    );
  });
});

test("rejects transaction-index, canonical-membership, and trace-root splices", async () => {
  await withStore(async (directory) => {
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(
        new FakeRpc(fixture({ transactionIndex: "0x2" })),
        request(directory),
      ),
      /transaction index mismatch/,
    );
  });
  await withStore(async (directory) => {
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(
        new FakeRpc(fixture({ receiptTransactionIndex: "0x2" })),
        request(directory),
      ),
      /receipt transaction index mismatch/,
    );
  });
  await withStore(async (directory) => {
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(
        new FakeRpc(fixture({ header: header(blockHash, otherTxHash) })),
        request(directory),
      ),
      /transaction is absent from its claimed canonical header index/,
    );
  });
  await withStore(async (directory) => {
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(
        new FakeRpc(fixture({
          trace: {
            type: "CALL",
            from: venue,
            to: venue,
            input: "0xbeef",
            value: "0x0",
          },
        })),
        request(directory),
      ),
      /trace root input mismatch/,
    );
  });
});

test("rejects null and malformed RPC results instead of converting them into missing evidence", async () => {
  await withStore(async (directory) => {
    const rpc = new FakeRpc(fixture(), () => null as unknown as readonly CanonicalJson[]);
    await assert.rejects(acquireHistoricalFamilyFactsV1(rpc, request(directory)), /expected array from eth_getLogs/);
  });
  await withStore(async (directory) => {
    const rpc = new FakeRpc(fixture({ chainId: "0x01" }));
    await assert.rejects(acquireHistoricalFamilyFactsV1(rpc, request(directory)), /canonical hex quantity/);
  });
  await withStore(async (directory) => {
    const rpc = new FakeRpc(fixture({ trace: null }));
    await assert.rejects(acquireHistoricalFamilyFactsV1(rpc, request(directory)), /expected plain object at \$\.trace/);
  });
});

test("propagates RPC errors without manufacturing an advisory receipt", async () => {
  await withStore(async (directory) => {
    const cause = new Error("transport unavailable");
    const rpc: HistoricalFamilyFactsJsonRpcV1 = {
      async request(method, params) {
        if (method === "eth_chainId") throw cause;
        if (method === "eth_getLogs") {
          const filter = params[0] as Readonly<Record<string, CanonicalJson>>;
          return BigInt(filter.fromBlock as string) <= 0x65n && BigInt(filter.toBlock as string) >= 0x65n
            ? [log()]
            : [];
        }
        throw new Error(`unexpected RPC method ${method}`);
      },
    };
    await assert.rejects(acquireHistoricalFamilyFactsV1(rpc, request(directory)), (error) => error === cause);
  });
});

test("refuses to overwrite changed bytes at an existing content-addressed object", async () => {
  await withStore(async (directory) => {
    const first = await acquireHistoricalFamilyFactsV1(new FakeRpc(fixture()), request(directory));
    const bundle = loadHistoricalFamilyFactBundleV1(directory, first.manifestRoot);
    const transaction = bundle.manifest.entries.find((entry) => entry.role === "transaction")!;
    const objectPath = join(directory, "objects", transaction.resultBytesSha256.slice(2));
    const changed = Buffer.from(readFileSync(objectPath));
    changed[changed.length - 2] = changed[changed.length - 2] === 48 ? 49 : 48;
    writeFileSync(objectPath, changed);
    await assert.rejects(
      acquireHistoricalFamilyFactsV1(new FakeRpc(fixture()), request(directory)),
      /immutable content-addressed object changed/,
    );
  });
});
