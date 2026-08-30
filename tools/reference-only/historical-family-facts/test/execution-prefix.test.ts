import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeCanonicalBytes,
  encodeCanonicalBytes,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  materializeHistoricalFamilyFactBundleV1,
  type HistoricalRpcMethod,
  type HistoricalRpcObjectInputV1,
  type HistoricalRpcRole,
} from "../src/index.ts";
import {
  HistoricalExecutionPrefixUnavailableErrorV1,
  acquireHistoricalExecutionPrefixV1,
  decodeHistoricalExecutionPrefixAcquisitionTranscriptV1,
  decodeHistoricalExecutionPrefixManifestV1,
  keccak256RawTransactionV1,
  loadHistoricalExecutionPrefixV1,
  materializeHistoricalExecutionPrefixV1,
  type HistoricalExecutionPrefixInputEntryV1,
  type HistoricalExecutionPrefixJsonRpcV1,
} from "../src/execution-prefix.ts";

const targetBlockHash = `0x${"a".repeat(64)}` as Hash;
const parentBlockHash = `0x${"b".repeat(64)}` as Hash;
const parentStateRoot = `0x${"c".repeat(64)}` as Hash;
const targetStateRoot = `0x${"d".repeat(64)}` as Hash;
const targetTxHash = `0x${"e".repeat(64)}` as Hash;
const otherHash = `0x${"f".repeat(64)}` as Hash;
const miner = `0x${"1".repeat(40)}`;

const rawTransactions = [
  Uint8Array.from([0x01, 0x02, 0x03]),
  Uint8Array.from([0x02, 0x80, 0x04, 0x05]),
] as const;
const prefixHashes = rawTransactions.map(keccak256RawTransactionV1);

const roleMethod: Readonly<Record<HistoricalRpcRole, HistoricalRpcMethod>> = Object.freeze({
  transaction: "eth_getTransactionByHash",
  receipt: "eth_getTransactionReceipt",
  trace: "debug_traceTransaction",
  header: "eth_getBlockByHash",
});

function targetHeader(prefixCount: number, changes: Record<string, unknown> = {}): Record<string, CanonicalJson> {
  return {
    number: "0xa",
    hash: targetBlockHash,
    parentHash: parentBlockHash,
    stateRoot: targetStateRoot,
    transactionsRoot: `0x${"2".repeat(64)}`,
    receiptsRoot: `0x${"3".repeat(64)}`,
    timestamp: "0x64",
    gasLimit: "0x1c9c380",
    gasUsed: "0x5208",
    baseFeePerGas: "0x7",
    miner,
    mixHash: `0x${"4".repeat(64)}`,
    difficulty: "0x0",
    transactions: [...prefixHashes.slice(0, prefixCount), targetTxHash],
    ...changes,
  } as Record<string, CanonicalJson>;
}

function parentHeader(changes: Record<string, unknown> = {}): Record<string, CanonicalJson> {
  return {
    number: "0x9",
    hash: parentBlockHash,
    stateRoot: parentStateRoot,
    ...changes,
  } as Record<string, CanonicalJson>;
}

function receipt(txHash: Hash, index: number, changes: Record<string, unknown> = {}): Record<string, CanonicalJson> {
  return {
    transactionHash: txHash,
    blockHash: targetBlockHash,
    blockNumber: "0xa",
    transactionIndex: `0x${index.toString(16)}`,
    status: "0x1",
    logs: [],
    ...changes,
  } as Record<string, CanonicalJson>;
}

function familyInputs(
  prefixCount: number,
  resultChanges: Partial<Record<HistoricalRpcRole, CanonicalJson>> = {},
): readonly HistoricalRpcObjectInputV1[] {
  const targetIndex = prefixCount;
  const results: Readonly<Record<HistoricalRpcRole, CanonicalJson>> = {
    transaction: {
      hash: targetTxHash,
      blockHash: targetBlockHash,
      blockNumber: "0xa",
      transactionIndex: `0x${targetIndex.toString(16)}`,
    },
    receipt: receipt(targetTxHash, targetIndex),
    trace: { type: "CALL" },
    header: targetHeader(prefixCount),
    ...resultChanges,
  };
  return (Object.keys(roleMethod) as HistoricalRpcRole[]).map((role) => {
    const method = roleMethod[role];
    const canonicalParams: readonly CanonicalJson[] = method === "eth_getBlockByHash"
      ? [targetBlockHash, false]
      : method === "debug_traceTransaction"
        ? [targetTxHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }]
        : [targetTxHash];
    return {
      role,
      key: {
        chainId: "1",
        canonicalBlockHash: targetBlockHash,
        txHash: targetTxHash,
        method,
        canonicalParams,
      },
      resultBytes: encodeCanonicalBytes(results[role]),
    };
  });
}

function prefixInputs(count: number): readonly HistoricalExecutionPrefixInputEntryV1[] {
  return rawTransactions.slice(0, count).map((rawSignedTransaction, index) => ({
    index: String(index),
    txHash: prefixHashes[index]!,
    rawSignedTransaction,
    receiptBytes: encodeCanonicalBytes(receipt(prefixHashes[index]!, index)),
  }));
}

function withStore(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "aloha-execution-prefix-"));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function withStoreAsync(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "aloha-execution-prefix-"));
  try {
    await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function materialize(directory: string, prefixCount: number) {
  const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(prefixCount));
  const manifest = materializeHistoricalExecutionPrefixV1(directory, {
    historicalFamilyFactManifestRoot: family.manifestRoot,
    parentHeader: parentHeader(),
    prefix: prefixInputs(prefixCount),
  });
  return { family, manifest };
}

async function acquireFromStaticRequestPort(directory: string) {
  const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(1));
  const rpc: HistoricalExecutionPrefixJsonRpcV1 = {
    async request(method, params) {
      if (method === "eth_chainId") return "0x1";
      if (method === "eth_getBlockByHash") {
        return params[0] === targetBlockHash ? targetHeader(1) : parentHeader();
      }
      if (method === "eth_getRawTransactionByHash") {
        return `0x${Buffer.from(rawTransactions[0]).toString("hex")}`;
      }
      if (method === "eth_getTransactionReceipt") return receipt(prefixHashes[0]!, 0);
      throw new Error(`unexpected method ${method}`);
    },
  };
  return acquireHistoricalExecutionPrefixV1(rpc, {
    rootDirectory: directory,
    historicalFamilyFactManifestRoot: family.manifestRoot,
  });
}

test("targetIndex zero materializes an empty prefix without treating target stateRoot as prestate", () => {
  withStore((directory) => {
    const { manifest } = materialize(directory, 0);
    assert.equal(manifest.target.targetIndex, "0");
    assert.deepEqual(manifest.prefix, []);
    assert.equal(manifest.parent.stateRoot, parentStateRoot);
    assert.equal(manifest.target.stateRoot, targetStateRoot);
    assert.notEqual(manifest.parent.stateRoot, manifest.target.stateRoot);
    assert.equal(manifest.chainStateQualified, false);
    assert.equal(manifest.origin, "caller-materialized");
    assert.equal(manifest.acquisitionTrust, "untrusted-caller-material");
    assert.equal(manifest.parentStateRootProof, "hash-link-only");
    assert.equal(manifest.receiptProof, "identity-only-no-trie-proof");
    assert.equal(manifest.acquisitionTranscript, null);
    assert.equal(manifest.target.beneficiary, null);
    assert.equal(manifest.target.prevRandao, null);
    assert.equal(manifest.target.blobGasUsed, null);
    assert.deepEqual(loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot).manifest, manifest);
  });
});

test("non-empty exact prefix is continuous, reloadable, and idempotent", () => {
  withStore((directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(2));
    const request = {
      historicalFamilyFactManifestRoot: family.manifestRoot,
      parentHeader: parentHeader(),
      prefix: prefixInputs(2),
    };
    const first = materializeHistoricalExecutionPrefixV1(directory, request);
    const second = materializeHistoricalExecutionPrefixV1(directory, request);
    assert.deepEqual(second, first);
    assert.deepEqual(first.prefix.map((entry) => entry.index), ["0", "1"]);
    assert.equal(readdirSync(join(directory, "execution-prefix", "objects")).length, 4);
    const loaded = loadHistoricalExecutionPrefixV1(directory, first.manifestRoot);
    assert.deepEqual(loaded.rawSignedTransactions, [...rawTransactions]);
    assert.deepEqual(loaded.receipts, [receipt(prefixHashes[0]!, 0), receipt(prefixHashes[1]!, 1)]);
  });
});

test("raw transaction hash mismatch fails before publishing", () => {
  withStore((directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(1));
    const [entry] = prefixInputs(1);
    assert.throws(() => materializeHistoricalExecutionPrefixV1(directory, {
      historicalFamilyFactManifestRoot: family.manifestRoot,
      parentHeader: parentHeader(),
      prefix: [{ ...entry!, rawSignedTransaction: Uint8Array.from([0xff]) }],
    }), /raw signed transaction hash mismatch/);
    assert.equal(existsSync(join(directory, "execution-prefix")), false);
  });
});

test("missing, reordered, and duplicate prefix indexes fail closed", () => {
  withStore((directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(2));
    const entries = prefixInputs(2);
    const attempt = (prefix: readonly HistoricalExecutionPrefixInputEntryV1[]) =>
      materializeHistoricalExecutionPrefixV1(directory, {
        historicalFamilyFactManifestRoot: family.manifestRoot,
        parentHeader: parentHeader(),
        prefix,
      });
    assert.throws(() => attempt(entries.slice(0, 1)), /exactly indexes/);
    assert.throws(() => attempt([entries[1]!, entries[0]!]), /indexes are missing or reordered/);
    assert.throws(() => attempt([{ ...entries[0]!, index: "0" }, { ...entries[1]!, index: "0" }]), /indexes are missing or reordered/);
  });
});

test("parent and target identity must be consecutive and hash-linked", () => {
  withStore((directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(0));
    const attempt = (header: CanonicalJson) => materializeHistoricalExecutionPrefixV1(directory, {
      historicalFamilyFactManifestRoot: family.manifestRoot,
      parentHeader: header,
      prefix: [],
    });
    assert.throws(() => attempt(parentHeader({ number: "0x8" })), /not consecutive/);
    assert.throws(() => attempt(parentHeader({ hash: otherHash })), /does not bind parent header/);
  });
});

test("existing family manifest transaction and membership splices fail closed", () => {
  withStore((directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(1, {
      transaction: {
        hash: targetTxHash,
        blockHash: otherHash,
        blockNumber: "0xa",
        transactionIndex: "0x1",
      },
    }));
    assert.throws(() => materializeHistoricalExecutionPrefixV1(directory, {
      historicalFamilyFactManifestRoot: family.manifestRoot,
      parentHeader: parentHeader(),
      prefix: prefixInputs(1),
    }), /existing manifest transaction identity splice/);
  });
  withStore((directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(0, {
      header: targetHeader(0, { transactions: [otherHash] }),
    }));
    assert.throws(() => materializeHistoricalExecutionPrefixV1(directory, {
      historicalFamilyFactManifestRoot: family.manifestRoot,
      parentHeader: parentHeader(),
      prefix: [],
    }), /target transaction membership is not exact/);
  });
});

test("prefix receipt transaction, block, and index splices fail closed", () => {
  for (const changes of [
    { transactionHash: otherHash },
    { blockHash: otherHash },
    { transactionIndex: "0x1" },
  ]) {
    withStore((directory) => {
      const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(1));
      const [entry] = prefixInputs(1);
      assert.throws(() => materializeHistoricalExecutionPrefixV1(directory, {
        historicalFamilyFactManifestRoot: family.manifestRoot,
        parentHeader: parentHeader(),
        prefix: [{ ...entry!, receiptBytes: encodeCanonicalBytes(receipt(prefixHashes[0]!, 0, changes)) }],
      }), /receipt (transaction hash|block hash|transaction index) splice/);
    });
  }
});

test("receipt bytes must already be exact canonical JSON", () => {
  withStore((directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(1));
    const [entry] = prefixInputs(1);
    const canonicalText = new TextDecoder().decode(entry!.receiptBytes);
    assert.throws(() => materializeHistoricalExecutionPrefixV1(directory, {
      historicalFamilyFactManifestRoot: family.manifestRoot,
      parentHeader: parentHeader(),
      prefix: [{ ...entry!, receiptBytes: Uint8Array.from(Buffer.from(` ${canonicalText}`)) }],
    }), /not canonical|non-canonical/i);
    assert.equal(existsSync(join(directory, "execution-prefix")), false);
  });
});

test("receipt status and logs remain advisory identity-only objects", () => {
  withStore((directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(1));
    const [entry] = prefixInputs(1);
    const first = materializeHistoricalExecutionPrefixV1(directory, {
      historicalFamilyFactManifestRoot: family.manifestRoot,
      parentHeader: parentHeader(),
      prefix: [entry!],
    });
    const second = materializeHistoricalExecutionPrefixV1(directory, {
      historicalFamilyFactManifestRoot: family.manifestRoot,
      parentHeader: parentHeader(),
      prefix: [{
        ...entry!,
        receiptBytes: encodeCanonicalBytes(receipt(prefixHashes[0]!, 0, {
          status: "0x0",
          logs: [{ advisory: "changed" }],
        })),
      }],
    });
    assert.notEqual(second.receiptRoot, first.receiptRoot);
    assert.notEqual(second.prefixRoot, first.prefixRoot);
    assert.notEqual(second.manifestRoot, first.manifestRoot);
    assert.equal(second.advisoryOnly, true);
    assert.equal(second.chainStateQualified, false);
    assert.equal(second.origin, "caller-materialized");
    assert.equal(second.acquisitionTrust, "untrusted-caller-material");
    assert.equal(second.acquisitionTranscript, null);
    assert.equal(second.receiptProof, "identity-only-no-trie-proof");
    assert.equal(second.parentStateRootProof, "hash-link-only");
  });
});

test("duplicate header execution aliases must agree exactly", () => {
  for (const changes of [
    { beneficiary: `0x${"2".repeat(40)}` },
    { prevRandao: otherHash },
  ]) {
    withStore((directory) => {
      const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(0, {
        header: targetHeader(0, changes),
      }));
      assert.throws(() => materializeHistoricalExecutionPrefixV1(directory, {
        historicalFamilyFactManifestRoot: family.manifestRoot,
        parentHeader: parentHeader(),
        prefix: [],
      }), /disagree/);
    });
  }
});

test("missing, changed, and symlinked CAS objects fail closed", () => {
  withStore((directory) => {
    const { manifest } = materialize(directory, 1);
    const rawPath = join(directory, "execution-prefix", "objects", manifest.prefix[0]!.rawObjectHash.slice(2));
    unlinkSync(rawPath);
    assert.throws(() => loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot), /raw object missing/);
  });
  withStore((directory) => {
    const { manifest } = materialize(directory, 1);
    const receiptPath = join(directory, "execution-prefix", "objects", manifest.prefix[0]!.receiptObjectHash.slice(2));
    writeFileSync(receiptPath, encodeCanonicalBytes({ forged: true }));
    assert.throws(() => loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot), /receipt object changed/);
  });
  withStore((directory) => {
    const { manifest } = materialize(directory, 1);
    const rawPath = join(directory, "execution-prefix", "objects", manifest.prefix[0]!.rawObjectHash.slice(2));
    const target = `${rawPath}.target`;
    writeFileSync(target, readFileSync(rawPath));
    unlinkSync(rawPath);
    symlinkSync(target, rawPath);
    assert.throws(() => loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot), /not a regular file/);
  });
});

test("public materialization cannot select an origin", () => {
  withStore((directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(0));
    assert.throws(() => materializeHistoricalExecutionPrefixV1(directory, {
      historicalFamilyFactManifestRoot: family.manifestRoot,
      parentHeader: parentHeader(),
      prefix: [],
      origin: "rpc-port-observed",
    } as Parameters<typeof materializeHistoricalExecutionPrefixV1>[1]), /unknown field.*origin/);
  });
});

test("manifest exact decoder binds chain qualification, origin, trust, proofs, and transcript", () => {
  withStore((directory) => {
    const { manifest } = materialize(directory, 0);
    assert.throws(() => decodeHistoricalExecutionPrefixManifestV1({ ...manifest, extra: true }), /unknown field/);
    assert.throws(() => decodeHistoricalExecutionPrefixManifestV1({ ...manifest, prefixRoot: otherHash }), /prefix root mismatch/);
    assert.throws(
      () => decodeHistoricalExecutionPrefixManifestV1({ ...manifest, origin: "rpc-port-observed" }),
      /origin, trust, and acquisition transcript disagree/,
    );
    assert.throws(
      () => decodeHistoricalExecutionPrefixManifestV1({ ...manifest, chainStateQualified: true }),
      /discriminator/,
    );
    assert.throws(
      () => decodeHistoricalExecutionPrefixManifestV1({ ...manifest, acquisitionTrust: "untrusted-request-port" }),
      /origin, trust, and acquisition transcript disagree/,
    );
    assert.throws(
      () => decodeHistoricalExecutionPrefixManifestV1({ ...manifest, parentStateRootProof: "verified" }),
      /parent stateRoot proof level/,
    );
    assert.throws(
      () => decodeHistoricalExecutionPrefixManifestV1({ ...manifest, receiptProof: "trie-proof" }),
      /receipt proof level/,
    );
    assert.throws(
      () => decodeHistoricalExecutionPrefixManifestV1({
        ...manifest,
        acquisitionTranscript: { objectHash: otherHash, byteLength: "1", observationRoot: otherHash },
      }),
      /origin, trust, and acquisition transcript disagree/,
    );
    const manifestPath = join(directory, "execution-prefix", "manifests", `${manifest.manifestRoot.slice(2)}.json`);
    const canonicalManifestBytes = readFileSync(manifestPath);
    writeFileSync(manifestPath, Buffer.concat([Buffer.from(" "), canonicalManifestBytes]));
    assert.throws(() => loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot), /not canonical|non-canonical/i);
    writeFileSync(manifestPath, encodeCanonicalBytes({ ...manifest, manifestRoot: otherHash }));
    assert.throws(() => loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot), /manifest root mismatch/);
  });
});

test("RPC acquisition fences both headers and materializes exact raw bytes and receipts", async () => {
  await withStoreAsync(async (directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(1));
    let targetCalls = 0;
    let parentCalls = 0;
    const rpc: HistoricalExecutionPrefixJsonRpcV1 = {
      async request(method, params) {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getBlockByHash" && params[0] === targetBlockHash) {
          targetCalls += 1;
          return targetHeader(1);
        }
        if (method === "eth_getBlockByHash" && params[0] === parentBlockHash) {
          parentCalls += 1;
          return parentHeader();
        }
        if (method === "eth_getRawTransactionByHash") {
          return `0x${Buffer.from(rawTransactions[0]).toString("hex")}`;
        }
        if (method === "eth_getTransactionReceipt") return receipt(prefixHashes[0]!, 0);
        throw new Error(`unexpected method ${method}`);
      },
    };
    const manifest = await acquireHistoricalExecutionPrefixV1(rpc, {
      rootDirectory: directory,
      historicalFamilyFactManifestRoot: family.manifestRoot,
    });
    assert.equal(targetCalls, 2);
    assert.equal(parentCalls, 2);
    assert.equal(manifest.chainStateQualified, false);
    assert.equal(manifest.origin, "rpc-port-observed");
    assert.equal(manifest.acquisitionTrust, "untrusted-request-port");
    assert.equal(manifest.parentStateRootProof, "hash-link-only");
    assert.equal(manifest.receiptProof, "identity-only-no-trie-proof");
    assert.match(manifest.acquisitionTranscript!.observationRoot, /^0x[0-9a-f]{64}$/);
    const loaded = loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot);
    assert.equal(loaded.acquisitionTranscript!.acquisitionTrust, "untrusted-request-port");
    assert.equal(loaded.acquisitionTranscript!.observations.length, 8);
    assert.throws(
      () => decodeHistoricalExecutionPrefixManifestV1({
        ...manifest,
        acquisitionTranscript: { ...manifest.acquisitionTranscript!, observationRoot: otherHash },
      }),
      /manifest root mismatch/,
    );
    assert.deepEqual(loaded.rawSignedTransactions, [rawTransactions[0]]);
  });
});

test("acquisition transcript rejects ref splice, missing object, and response-byte mutation", async () => {
  await withStoreAsync(async (directory) => {
    const manifest = await acquireFromStaticRequestPort(directory);
    assert.throws(() => decodeHistoricalExecutionPrefixManifestV1({
      ...manifest,
      acquisitionTranscript: { ...manifest.acquisitionTranscript!, objectHash: otherHash },
    }), /manifest root mismatch/);
  });
  await withStoreAsync(async (directory) => {
    const manifest = await acquireFromStaticRequestPort(directory);
    const transcriptPath = join(
      directory,
      "execution-prefix",
      "objects",
      manifest.acquisitionTranscript!.objectHash.slice(2),
    );
    unlinkSync(transcriptPath);
    assert.throws(
      () => loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot),
      /acquisition transcript missing/,
    );
  });
  await withStoreAsync(async (directory) => {
    const manifest = await acquireFromStaticRequestPort(directory);
    const transcriptPath = join(
      directory,
      "execution-prefix",
      "objects",
      manifest.acquisitionTranscript!.objectHash.slice(2),
    );
    const transcript = decodeCanonicalBytes(Uint8Array.from(readFileSync(transcriptPath))) as Record<string, CanonicalJson>;
    const observations = [...transcript.observations as readonly Record<string, CanonicalJson>[]];
    observations[0] = {
      ...observations[0]!,
      responseCanonicalBytes: `0x${Buffer.from(encodeCanonicalBytes("forged")).toString("hex")}`,
    };
    writeFileSync(transcriptPath, encodeCanonicalBytes({ ...transcript, observations }));
    assert.throws(
      () => loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot),
      /acquisition transcript changed/,
    );
  });
});

test("acquisition transcript exact decoder rejects reordered and extra observations", async () => {
  await withStoreAsync(async (directory) => {
    const manifest = await acquireFromStaticRequestPort(directory);
    const transcript = loadHistoricalExecutionPrefixV1(directory, manifest.manifestRoot).acquisitionTranscript!;
    assert.throws(
      () => decodeHistoricalExecutionPrefixAcquisitionTranscriptV1({
        ...transcript,
        observations: [transcript.observations[1], transcript.observations[0], ...transcript.observations.slice(2)],
      }),
      /missing or reordered/,
    );
    assert.throws(
      () => decodeHistoricalExecutionPrefixAcquisitionTranscriptV1({
        ...transcript,
        observations: [{ ...transcript.observations[0]!, extra: true }, ...transcript.observations.slice(1)],
      }),
      /unknown field.*extra/,
    );
  });
});

test("RPC acquisition request cannot select an origin", async () => {
  await withStoreAsync(async (directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(0));
    const rpc: HistoricalExecutionPrefixJsonRpcV1 = { async request() { throw new Error("must not call port"); } };
    await assert.rejects(acquireHistoricalExecutionPrefixV1(rpc, {
      rootDirectory: directory,
      historicalFamilyFactManifestRoot: family.manifestRoot,
      origin: "caller-materialized",
    } as Parameters<typeof acquireHistoricalExecutionPrefixV1>[1]), /unknown field.*origin/);
  });
});

test("RPC acquisition rejects a parent-header splice without publishing a manifest", async () => {
  await withStoreAsync(async (directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(0));
    let parentCalls = 0;
    const rpc: HistoricalExecutionPrefixJsonRpcV1 = {
      async request(method, params) {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getBlockByHash" && params[0] === targetBlockHash) return targetHeader(0);
        if (method === "eth_getBlockByHash" && params[0] === parentBlockHash) {
          parentCalls += 1;
          return parentCalls === 1 ? parentHeader() : parentHeader({ stateRoot: otherHash });
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    await assert.rejects(acquireHistoricalExecutionPrefixV1(rpc, {
      rootDirectory: directory,
      historicalFamilyFactManifestRoot: family.manifestRoot,
    }), /parent header changed during acquisition/);
    assert.equal(existsSync(join(directory, "execution-prefix")), false);
  });
});

test("provider raw-RPC unavailability is typed and publishes no successful prefix manifest", async () => {
  await withStoreAsync(async (directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(1));
    const rpc: HistoricalExecutionPrefixJsonRpcV1 = {
      async request(method, params) {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getBlockByHash") {
          return params[0] === targetBlockHash ? targetHeader(1) : parentHeader();
        }
        if (method === "eth_getRawTransactionByHash") {
          throw Object.assign(new Error("method not found"), { code: -32601 });
        }
        throw new Error(`unexpected method ${method}`);
      },
    };
    await assert.rejects(
      acquireHistoricalExecutionPrefixV1(rpc, {
        rootDirectory: directory,
        historicalFamilyFactManifestRoot: family.manifestRoot,
      }),
      (error: unknown) => {
        assert.ok(error instanceof HistoricalExecutionPrefixUnavailableErrorV1);
        assert.equal(error.reason, "method-not-found");
        assert.equal(error.method, "eth_getRawTransactionByHash");
        return true;
      },
    );
    assert.equal(existsSync(join(directory, "execution-prefix")), false);
  });
});

test("provider unsupported variants and resolved error envelopes are typed", async () => {
  const failures: readonly unknown[] = [
    Object.assign(new Error("provider rejection"), { code: "-32601" }),
    new Error("method not supported by provider"),
    new Error("request wrapper", { cause: Object.assign(new Error("nested"), { code: -32601 }) }),
    { jsonrpc: "2.0", id: 1, error: { code: "-32601", message: "unavailable" } },
  ];
  for (const failure of failures) {
    await withStoreAsync(async (directory) => {
      const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(1));
      const rpc: HistoricalExecutionPrefixJsonRpcV1 = {
        async request(method, params) {
          if (method === "eth_chainId") return "0x1";
          if (method === "eth_getBlockByHash") {
            return params[0] === targetBlockHash ? targetHeader(1) : parentHeader();
          }
          if (method === "eth_getRawTransactionByHash") {
            if (failure instanceof Error) throw failure;
            return failure;
          }
          throw new Error(`unexpected method ${method}`);
        },
      };
      await assert.rejects(
        acquireHistoricalExecutionPrefixV1(rpc, {
          rootDirectory: directory,
          historicalFamilyFactManifestRoot: family.manifestRoot,
        }),
        (error: unknown) => {
          assert.ok(error instanceof HistoricalExecutionPrefixUnavailableErrorV1);
          assert.equal(error.reason, "method-not-found");
          assert.equal(error.method, "eth_getRawTransactionByHash");
          return true;
        },
      );
    });
  }
});

test("unknown provider logic errors are rethrown unchanged", async () => {
  await withStoreAsync(async (directory) => {
    const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(0));
    const sentinel = new Error("application invariant failed");
    const rpc: HistoricalExecutionPrefixJsonRpcV1 = {
      async request(method, params) {
        if (method === "eth_chainId") return "0x1";
        if (method === "eth_getBlockByHash" && params[0] === targetBlockHash) return targetHeader(0);
        throw sentinel;
      },
    };
    await assert.rejects(
      acquireHistoricalExecutionPrefixV1(rpc, {
        rootDirectory: directory,
        historicalFamilyFactManifestRoot: family.manifestRoot,
      }),
      (error: unknown) => error === sentinel,
    );
  });
});

test("provider null, pruned, and transport failures retain typed unavailable reasons", async () => {
  const cases: readonly [unknown, "null-result" | "pruned" | "transport"][] = [
    [null, "null-result"],
    [new Error("historical state pruned"), "pruned"],
    [new Error("socket closed"), "transport"],
  ];
  for (const [failure, reason] of cases) {
    await withStoreAsync(async (directory) => {
      const family = materializeHistoricalFamilyFactBundleV1(directory, familyInputs(0));
      let targetCalls = 0;
      const rpc: HistoricalExecutionPrefixJsonRpcV1 = {
        async request(method, params) {
          if (method === "eth_chainId") return "0x1";
          if (method === "eth_getBlockByHash" && params[0] === targetBlockHash) {
            targetCalls += 1;
            return targetCalls === 1 ? targetHeader(0) : targetHeader(0);
          }
          if (method === "eth_getBlockByHash") {
            if (failure instanceof Error) throw failure;
            return failure;
          }
          throw new Error(`unexpected method ${method}`);
        },
      };
      await assert.rejects(
        acquireHistoricalExecutionPrefixV1(rpc, {
          rootDirectory: directory,
          historicalFamilyFactManifestRoot: family.manifestRoot,
        }),
        (error: unknown) => {
          assert.ok(error instanceof HistoricalExecutionPrefixUnavailableErrorV1);
          assert.equal(error.reason, reason);
          return true;
        },
      );
      assert.equal(existsSync(join(directory, "execution-prefix")), false);
    });
  }
});

test("independent Keccak-256 vectors cover empty, abc, rate boundary, and multiple blocks", () => {
  const vectors: readonly [Uint8Array, Hash][] = [
    [new Uint8Array(), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"],
    [Uint8Array.from(Buffer.from("abc")), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"],
    [Uint8Array.from({ length: 136 }, (_, index) => index), "0x7ce759f1ab7f9ce437719970c26b0a66ff11fe3e38e17df89cf5d29c7d7f807e"],
    [Uint8Array.from({ length: 137 }, (_, index) => index), "0xac73d4fae68b8453f764007c1a20ce95994187861f0c3227a3a8e99a73a3b1db"],
    [Uint8Array.from({ length: 272 }, (_, index) => index % 256), "0xfdf2ec49e749960d3c8521a0219af8d03e30e2b3bf19bd16150ee0eaf133d66e"],
  ];
  for (const [input, expected] of vectors) assert.equal(keccak256RawTransactionV1(input), expected);
});
