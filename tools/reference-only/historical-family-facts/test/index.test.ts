import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  encodeCanonicalBytes,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  TX149_ACQUISITION_DESCRIPTOR_V1,
  evaluateHistoricalFamilyFactsV1,
  historicalRpcObjectKeyV1,
  materializeHistoricalFamilyFactBundleV1,
  type HistoricalRpcMethod,
  type HistoricalRpcObjectInputV1,
  type HistoricalRpcRole,
} from "../src/index.ts";

const txHash = `0x${"1".repeat(64)}` as Hash;
const blockHash = `0x${"2".repeat(64)}` as Hash;
const otherTxHash = `0x${"3".repeat(64)}` as Hash;
const poolV2 = `0x${"4".repeat(40)}`;
const poolV3 = `0x${"5".repeat(40)}`;
const caller = `0x${"6".repeat(40)}`;
const UNIV2_SWAP_TOPIC =
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";
const UNIV3_SWAP_TOPIC =
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

function uintWord(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function intWord(value: bigint): string {
  return (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, "0");
}

function fixtureResults(options: {
  readonly failedV3?: boolean;
  readonly reverseLogs?: boolean;
  readonly malformedV2Amounts?: boolean;
  readonly truncatedV3Data?: boolean;
  readonly unsupportedTraceCalls?: boolean;
  readonly transactionHash?: Hash;
  readonly missingTransactionHash?: boolean;
  readonly missingReceiptStatus?: boolean;
  readonly missingV2LogIndex?: boolean;
  readonly missingV2Data?: boolean;
  readonly missingV3Call?: boolean;
} = {}): Readonly<Record<HistoricalRpcRole, CanonicalJson>> {
  const v2Data = options.malformedV2Amounts
    ? `0x${uintWord(10n)}${uintWord(5n)}${uintWord(0n)}${uintWord(7n)}`
    : `0x${uintWord(10n)}${uintWord(0n)}${uintWord(0n)}${uintWord(7n)}`;
  const v3Data = options.truncatedV3Data
    ? `0x${intWord(-8n)}`
    : `0x${intWord(-8n)}${intWord(11n)}${uintWord(0n)}${uintWord(0n)}${uintWord(0n)}`;
  const v2Log = {
    address: poolV2,
    ...(options.missingV2Data ? {} : { data: v2Data }),
    ...(options.missingV2LogIndex ? {} : { logIndex: "0x1" }),
    topics: [UNIV2_SWAP_TOPIC],
  };
  const v3Log = {
    address: poolV3,
    data: v3Data,
    logIndex: "0x2",
    topics: [UNIV3_SWAP_TOPIC],
  };
  return Object.freeze({
    transaction: {
      ...(options.missingTransactionHash ? {} : { hash: options.transactionHash ?? txHash }),
      blockHash,
      from: caller,
      to: caller,
    },
    receipt: {
      transactionHash: txHash,
      blockHash,
      ...(options.missingReceiptStatus ? {} : { status: "0x1" }),
      logs: options.reverseLogs ? [v3Log, v2Log] : [v2Log, v3Log],
    },
    trace: {
      type: "CALL",
      from: caller,
      to: caller,
      input: "0xdeadbeef",
      calls: options.unsupportedTraceCalls ? { malformed: true } : [
        {
          type: "CALL",
          from: caller,
          to: poolV2,
          input: "0x022c0d9f",
        },
        ...options.missingV3Call ? [] : [{
          type: "CALL",
          from: caller,
          to: poolV3,
          input: "0x128acb08",
          ...(options.failedV3 ? { error: "execution reverted" } : {}),
        }],
      ],
    },
    header: {
      hash: blockHash,
      number: "0x10",
      parentHash: `0x${"7".repeat(64)}`,
    },
  });
}

function params(method: HistoricalRpcMethod, selectedTxHash = txHash, selectedBlockHash = blockHash): readonly CanonicalJson[] {
  if (method === "eth_getBlockByHash") return [selectedBlockHash, false];
  if (method === "debug_traceTransaction") {
    return [selectedTxHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }];
  }
  return [selectedTxHash];
}

const roleMethod: Readonly<Record<HistoricalRpcRole, HistoricalRpcMethod>> = Object.freeze({
  transaction: "eth_getTransactionByHash",
  receipt: "eth_getTransactionReceipt",
  trace: "debug_traceTransaction",
  header: "eth_getBlockByHash",
});

function inputs(
  results = fixtureResults(),
  changes: Partial<Record<HistoricalRpcRole, Partial<HistoricalRpcObjectInputV1["key"]>>> = {},
): readonly HistoricalRpcObjectInputV1[] {
  return (Object.keys(roleMethod) as HistoricalRpcRole[]).map((role) => {
    const method = roleMethod[role];
    const key = {
      chainId: "1",
      canonicalBlockHash: blockHash,
      txHash,
      method,
      canonicalParams: params(method),
      ...changes[role],
    };
    return {
      role,
      key,
      resultBytes: encodeCanonicalBytes(results[role]),
    };
  });
}

function withStore(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "aloha-historical-family-facts-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("stores an immutable exact four-object closure and independently validates ordered UniV2/UniV3 evidence", () => {
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs());
    assert.deepEqual(manifest.entries.map((entry) => entry.role), ["transaction", "receipt", "trace", "header"]);
    for (const entry of manifest.entries) {
      assert.equal(entry.objectKey, historicalRpcObjectKeyV1(entry.key));
      assert.match(entry.resultBytesSha256, /^0x[0-9a-f]{64}$/);
    }
    const result = evaluateHistoricalFamilyFactsV1(directory, manifest.manifestRoot, {
      expectedFamilies: ["univ2-standard", "univ3-standard"],
    });
    assert.equal(result.advisoryOnly, true);
    assert.equal(result.status, "validated");
    assert.deepEqual(result.facts.map((fact) => [fact.family, fact.logIndex, fact.successfulCallIndex]), [
      ["univ2-standard", "1", "1"],
      ["univ3-standard", "2", "2"],
    ]);
    assert.deepEqual(result.facts.map((fact) => [fact.amount0, fact.amount1, fact.direction]), [
      ["10", "-7", "zero-for-one"],
      ["-8", "11", "one-for-zero"],
    ]);
    assert.equal("verdict" in result, false);
    assert.equal("pass" in result, false);
  });
});

test("exact request schema rejects cross-chain, block, and transaction splices", () => {
  for (const changed of [
    { transaction: { chainId: "2" } },
    { receipt: { canonicalBlockHash: `0x${"8".repeat(64)}` as Hash } },
    { trace: { txHash: otherTxHash, canonicalParams: params("debug_traceTransaction", otherTxHash) } },
  ]) {
    withStore((directory) => {
      assert.throws(
        () => materializeHistoricalFamilyFactBundleV1(directory, inputs(fixtureResults(), changed)),
        /cross-chain\/block\/tx historical RPC splice/,
      );
    });
  }
  withStore((directory) => {
    const malformed = inputs().map((input) => input.role === "receipt"
      ? { ...input, key: { ...input.key, canonicalParams: [otherTxHash] } }
      : input);
    assert.throws(
      () => materializeHistoricalFamilyFactBundleV1(directory, malformed),
      /canonicalParams do not exactly bind eth_getTransactionReceipt/,
    );
  });
});

test("a transaction or receipt from another tx is contradicted even under a self-consistent manifest", () => {
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(
      directory,
      inputs(fixtureResults({ transactionHash: otherTxHash })),
    );
    const result = evaluateHistoricalFamilyFactsV1(directory, manifest.manifestRoot, {
      expectedFamilies: ["univ2-standard", "univ3-standard"],
    });
    assert.equal(result.status, "contradicted");
    assert.deepEqual(result.reasons, ["transaction hash mismatch"]);
  });
});

test("missing blobs and changed bytes are unresolved rather than silently reconstructed", () => {
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs());
    const receipt = manifest.entries.find((entry) => entry.role === "receipt")!;
    unlinkSync(join(directory, "objects", receipt.resultBytesSha256.slice(2)));
    const result = evaluateHistoricalFamilyFactsV1(directory, manifest.manifestRoot, {
      expectedFamilies: ["univ2-standard", "univ3-standard"],
    });
    assert.equal(result.status, "unresolved");
    assert.match(result.reasons[0]!, /historical object missing for receipt/);
  });
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs());
    const trace = manifest.entries.find((entry) => entry.role === "trace")!;
    const path = join(directory, "objects", trace.resultBytesSha256.slice(2));
    const changed = Buffer.from(readFileSync(path));
    changed[changed.length - 2] = changed[changed.length - 2] === 48 ? 49 : 48;
    writeFileSync(path, changed);
    const result = evaluateHistoricalFamilyFactsV1(directory, manifest.manifestRoot, {
      expectedFamilies: ["univ2-standard", "univ3-standard"],
    });
    assert.equal(result.status, "unresolved");
    assert.match(result.reasons[0]!, /historical object bytes changed for trace/);
  });
});

test("failed call frames contradict an otherwise successful receipt log", () => {
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs(fixtureResults({ failedV3: true })));
    const result = evaluateHistoricalFamilyFactsV1(directory, manifest.manifestRoot, {
      expectedFamilies: ["univ2-standard", "univ3-standard"],
    });
    assert.equal(result.status, "contradicted");
    assert.ok(result.reasons.includes("univ3-standard successful call evidence missing"));
    assert.equal(result.facts.find((fact) => fact.family === "univ3-standard")?.successfulCallIndex, null);
  });
});

test("receipt log order and amount mutations are contradicted", () => {
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs(fixtureResults({ reverseLogs: true })));
    const result = evaluateHistoricalFamilyFactsV1(directory, manifest.manifestRoot, {
      expectedFamilies: ["univ2-standard", "univ3-standard"],
    });
    assert.equal(result.status, "contradicted");
    assert.deepEqual(result.reasons, ["receipt log order is not strictly increasing"]);
  });
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs(fixtureResults({ malformedV2Amounts: true })));
    const result = evaluateHistoricalFamilyFactsV1(directory, manifest.manifestRoot, {
      expectedFamilies: ["univ2-standard", "univ3-standard"],
    });
    assert.equal(result.status, "contradicted");
    assert.match(result.reasons[0]!, /UniV2 Swap amounts do not describe one exact direction/);
  });
});

test("decoder failures and unsupported observer coverage are unresolved, not chain contradictions", () => {
  for (const changed of [
    fixtureResults({ truncatedV3Data: true }),
    fixtureResults({ unsupportedTraceCalls: true }),
  ]) {
    withStore((directory) => {
      const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs(changed));
      const result = evaluateHistoricalFamilyFactsV1(directory, manifest.manifestRoot, {
        expectedFamilies: ["univ2-standard", "univ3-standard"],
      });
      assert.equal(result.status, "unresolved");
      assert.equal(result.chainId, "1");
      assert.equal(result.canonicalBlockHash, blockHash);
      assert.equal(result.txHash, txHash);
      assert.equal(result.facts.length, 0);
    });
  }
});

test("recognized identity, status, order, amount, and call evidence omissions remain contradictions", () => {
  const cases = [
    [fixtureResults({ missingTransactionHash: true }), "transaction hash missing"],
    [fixtureResults({ missingReceiptStatus: true }), "receipt status missing"],
    [fixtureResults({ missingV2LogIndex: true }), "receipt log order missing"],
    [fixtureResults({ missingV2Data: true }), "univ2-standard amount data missing"],
    [fixtureResults({ missingV3Call: true }), "univ3-standard successful call evidence missing"],
  ] as const;
  for (const [changed, reason] of cases) {
    withStore((directory) => {
      const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs(changed));
      const result = evaluateHistoricalFamilyFactsV1(directory, manifest.manifestRoot, {
        expectedFamilies: ["univ2-standard", "univ3-standard"],
      });
      assert.equal(result.status, "contradicted");
      assert.ok(result.reasons.includes(reason), JSON.stringify(result.reasons));
    });
  }
});

test("tx149 descriptor remains acquisition-only and does not claim facts or a canonical block hash", () => {
  assert.equal(TX149_ACQUISITION_DESCRIPTOR_V1.advisoryOnly, true);
  assert.equal(TX149_ACQUISITION_DESCRIPTOR_V1.canonicalBlockHash, null);
  assert.equal(TX149_ACQUISITION_DESCRIPTOR_V1.txHash, "0x149df3ec17a6044e0c66c25aa55ce044abe33bf14cedea26295e1b6d4c9fde60");
  assert.deepEqual(TX149_ACQUISITION_DESCRIPTOR_V1.expectedFamilies, ["univ2-standard", "univ3-standard"]);
  assert.equal("status" in TX149_ACQUISITION_DESCRIPTOR_V1, false);
  assert.equal("verdict" in TX149_ACQUISITION_DESCRIPTOR_V1, false);
});
