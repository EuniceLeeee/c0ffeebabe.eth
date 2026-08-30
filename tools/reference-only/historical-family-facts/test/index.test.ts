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
  historicalRpcObjectKeyV1,
  loadHistoricalFamilyFactBundleV1,
  materializeHistoricalFamilyFactBundleV1,
  type HistoricalRpcMethod,
  type HistoricalRpcObjectInputV1,
  type HistoricalRpcRole,
} from "../src/index.ts";

const txHash = `0x${"1".repeat(64)}` as Hash;
const blockHash = `0x${"2".repeat(64)}` as Hash;
const otherTxHash = `0x${"3".repeat(64)}` as Hash;

const roleMethod: Readonly<Record<HistoricalRpcRole, HistoricalRpcMethod>> = Object.freeze({
  transaction: "eth_getTransactionByHash",
  receipt: "eth_getTransactionReceipt",
  trace: "debug_traceTransaction",
  header: "eth_getBlockByHash",
});

function params(
  method: HistoricalRpcMethod,
  selectedTxHash = txHash,
  selectedBlockHash = blockHash,
): readonly CanonicalJson[] {
  if (method === "eth_getBlockByHash") return [selectedBlockHash, false];
  if (method === "debug_traceTransaction") {
    return [selectedTxHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }];
  }
  return [selectedTxHash];
}

function inputs(
  changes: Partial<Record<HistoricalRpcRole, Partial<HistoricalRpcObjectInputV1["key"]>>> = {},
): readonly HistoricalRpcObjectInputV1[] {
  return (Object.keys(roleMethod) as HistoricalRpcRole[]).map((role) => {
    const method = roleMethod[role];
    return {
      role,
      key: {
        chainId: "1",
        canonicalBlockHash: blockHash,
        txHash,
        method,
        canonicalParams: params(method),
        ...changes[role],
      },
      resultBytes: encodeCanonicalBytes({ role, txHash, blockHash }),
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

test("stores and reloads one immutable exact four-object byte closure", () => {
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs());
    assert.deepEqual(manifest.entries.map((entry) => entry.role), [
      "transaction",
      "receipt",
      "trace",
      "header",
    ]);
    for (const entry of manifest.entries) {
      assert.equal(entry.objectKey, historicalRpcObjectKeyV1(entry.key));
      assert.match(entry.resultBytesSha256, /^0x[0-9a-f]{64}$/);
    }
    const loaded = loadHistoricalFamilyFactBundleV1(directory, manifest.manifestRoot);
    assert.deepEqual(loaded.manifest, manifest);
    assert.deepEqual(Object.keys(loaded.results).sort(), ["header", "receipt", "trace", "transaction"]);
  });
});

test("exact request schema rejects cross-chain, block, transaction, and parameter splices", () => {
  for (const changed of [
    { transaction: { chainId: "2" } },
    { receipt: { canonicalBlockHash: `0x${"8".repeat(64)}` as Hash } },
    { trace: { txHash: otherTxHash, canonicalParams: params("debug_traceTransaction", otherTxHash) } },
  ]) {
    withStore((directory) => {
      assert.throws(
        () => materializeHistoricalFamilyFactBundleV1(directory, inputs(changed)),
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

test("missing or changed object bytes fail closed", () => {
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs());
    const receipt = manifest.entries.find((entry) => entry.role === "receipt")!;
    unlinkSync(join(directory, "objects", receipt.resultBytesSha256.slice(2)));
    assert.throws(
      () => loadHistoricalFamilyFactBundleV1(directory, manifest.manifestRoot),
      /historical object missing for receipt/,
    );
  });
  withStore((directory) => {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs());
    const trace = manifest.entries.find((entry) => entry.role === "trace")!;
    const path = join(directory, "objects", trace.resultBytesSha256.slice(2));
    const changed = Buffer.from(readFileSync(path));
    changed[changed.length - 2] = changed[changed.length - 2] === 48 ? 49 : 48;
    writeFileSync(path, changed);
    assert.throws(
      () => loadHistoricalFamilyFactBundleV1(directory, manifest.manifestRoot),
      /historical object bytes changed for trace/,
    );
  });
});

test("an existing object path cannot be overwritten with different bytes", () => {
  withStore((directory) => {
    const material = inputs();
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, material);
    const transaction = manifest.entries.find((entry) => entry.role === "transaction")!;
    writeFileSync(
      join(directory, "objects", transaction.resultBytesSha256.slice(2)),
      encodeCanonicalBytes({ forged: true }),
    );
    assert.throws(
      () => materializeHistoricalFamilyFactBundleV1(directory, material),
      /immutable content-addressed object changed/,
    );
  });
});
