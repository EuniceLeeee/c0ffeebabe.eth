import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  encodeCanonicalBytes,
  sha256Hex,
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
  HISTORICAL_POOL_IDENTITY_OBSERVER_SOURCE_DIGEST_V1,
  observeHistoricalPoolIdentityV1,
  type HistoricalPoolIdentityJsonRpcV1,
} from "../src/pool-identity-observer.ts";
import { observeHistoricalExecutionVariantsV1 } from "../src/variant-observer.ts";

const txHash = `0x${"1".repeat(64)}` as Hash;
const blockHash = `0x${"2".repeat(64)}` as Hash;
const stateRoot = `0x${"3".repeat(64)}` as Hash;
const changedStateRoot = `0x${"4".repeat(64)}` as Hash;
const otherTxHash = `0x${"5".repeat(64)}` as Hash;
const sender = `0x${"6".repeat(40)}`;
const router = `0x${"7".repeat(40)}`;
const poolV2 = `0x${"8".repeat(40)}`;
const poolV3 = `0x${"9".repeat(40)}`;
const factory = `0x${"a".repeat(40)}`;
const token0 = `0x${"b".repeat(40)}`;
const token1 = `0x${"c".repeat(40)}`;
const wrongPool = `0x${"d".repeat(40)}`;
const zeroAddress = `0x${"0".repeat(40)}`;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string): string {
  return value.slice(2).padStart(64, "0");
}

function addressReturn(value: string): string {
  return `0x${addressWord(value)}`;
}

function v2Swap(): string {
  return `0x022c0d9f${word(0n)}${word(10n)}${addressWord(router)}${word(128n)}${word(2n)}${
    "abcd".padEnd(64, "0")
  }`;
}

function v3Swap(): string {
  return `0x128acb08${addressWord(router)}${word(1n)}${word(10n)}${word(4_295_128_740n)}${word(160n)}${
    word(2n)
  }${"abcd".padEnd(64, "0")}`;
}

const header: CanonicalJson = Object.freeze({
  hash: blockHash,
  number: "0x10",
  stateRoot,
  transactions: [otherTxHash, txHash],
});

const roleMethod: Readonly<Record<HistoricalRpcRole, HistoricalRpcMethod>> = Object.freeze({
  transaction: "eth_getTransactionByHash",
  receipt: "eth_getTransactionReceipt",
  trace: "debug_traceTransaction",
  header: "eth_getBlockByHash",
});

function params(method: HistoricalRpcMethod): readonly CanonicalJson[] {
  if (method === "eth_getBlockByHash") return [blockHash, false];
  if (method === "debug_traceTransaction") {
    return [txHash, { tracer: "callTracer", tracerConfig: { onlyTopCall: false } }];
  }
  return [txHash];
}

function fixtureInputs(
  family: "v2" | "v3",
  pool = family === "v2" ? poolV2 : poolV3,
): readonly HistoricalRpcObjectInputV1[] {
  const rootInput = "0xdeadbeef";
  const results: Readonly<Record<HistoricalRpcRole, CanonicalJson>> = Object.freeze({
    transaction: {
      hash: txHash,
      blockHash,
      transactionIndex: "0x1",
      from: sender,
      to: router,
      input: rootInput,
      value: "0x0",
    },
    receipt: {
      transactionHash: txHash,
      blockHash,
      transactionIndex: "0x1",
      status: "0x1",
      logs: [],
    },
    trace: {
      type: "CALL",
      from: sender,
      to: router,
      input: rootInput,
      value: "0x0",
      calls: [{
        type: "CALL",
        from: router,
        to: pool,
        input: family === "v2" ? v2Swap() : v3Swap(),
        value: "0x0",
      }],
    },
    header,
  });
  return (Object.keys(roleMethod) as HistoricalRpcRole[]).map((role) => ({
    role,
    key: {
      chainId: "1",
      canonicalBlockHash: blockHash,
      txHash,
      method: roleMethod[role],
      canonicalParams: params(roleMethod[role]),
    },
    resultBytes: encodeCanonicalBytes(results[role]),
  }));
}

interface MockOptions {
  readonly wrongReverse?: boolean;
  readonly zeroFactory?: boolean;
  readonly zeroToken?: boolean;
  readonly zeroReverse?: boolean;
  readonly reversedTokens?: boolean;
  readonly fee?: bigint;
  readonly tickSpacing?: bigint;
  readonly chainIdBefore?: string;
  readonly chainIdAfter?: string;
  readonly malformedFactory?: boolean;
  readonly nullFactory?: boolean;
  readonly unsupportedEip1898?: boolean;
  readonly mutateBefore?: boolean;
  readonly mutateAfter?: boolean;
}

class MockRpc implements HistoricalPoolIdentityJsonRpcV1 {
  readonly calls: Array<Readonly<{ method: string; params: readonly CanonicalJson[] }>> = [];
  private fenceCount = 0;
  private chainIdCount = 0;
  private readonly options: MockOptions;

  constructor(options: MockOptions = {}) {
    this.options = options;
  }

  async request(method: string, params: readonly CanonicalJson[]): Promise<unknown> {
    this.calls.push(Object.freeze({ method, params }));
    if (method === "eth_chainId") {
      this.chainIdCount += 1;
      return this.chainIdCount === 1
        ? this.options.chainIdBefore ?? "0x1"
        : this.options.chainIdAfter ?? "0x1";
    }
    if (method === "eth_getBlockByNumber") {
      this.fenceCount += 1;
      const mutate = this.fenceCount === 1 ? this.options.mutateBefore : this.options.mutateAfter;
      return mutate ? { ...header as Record<string, CanonicalJson>, stateRoot: changedStateRoot } : header;
    }
    assert.equal(method, "eth_call");
    const call = params[0] as Readonly<{ to: string; data: string }>;
    const cutoff = params[1];
    assert.deepEqual(cutoff, { blockHash, requireCanonical: true });
    if (this.options.unsupportedEip1898) {
      throw Object.assign(new Error("blockHash with requireCanonical unsupported"), { code: -32602 });
    }
    const selector = call.data.slice(0, 10);
    if (selector === "0xc45a0155") {
      if (this.options.nullFactory) return null;
      if (this.options.malformedFactory) return "0x1234";
      return addressReturn(this.options.zeroFactory ? zeroAddress : factory);
    }
    if (selector === "0x0dfe1681") {
      return addressReturn(this.options.zeroToken ? zeroAddress : this.options.reversedTokens ? token1 : token0);
    }
    if (selector === "0xd21220a7") return addressReturn(this.options.reversedTokens ? token0 : token1);
    if (selector === "0xe6a43905" || selector === "0x1698ee82") {
      return addressReturn(this.options.zeroReverse ? zeroAddress : this.options.wrongReverse ? wrongPool : call.to === factory ?
        (selector === "0xe6a43905" ? poolV2 : poolV3) : wrongPool);
    }
    if (selector === "0xddca3f43") return `0x${word(this.options.fee ?? 3000n)}`;
    if (selector === "0xd0c93a7c") {
      const spacing = this.options.tickSpacing ?? 60n;
      return `0x${word(spacing < 0n ? (1n << 256n) + spacing : spacing)}`;
    }
    throw new Error(`unexpected call ${call.to} ${call.data}`);
  }
}

interface StoredCase {
  readonly directory: string;
  readonly manifestRoot: Hash;
  readonly caseId: Hash;
}

function storeCase(family: "v2" | "v3", pool?: string): StoredCase {
  const directory = mkdtempSync(join(tmpdir(), "aloha-pool-identity-"));
  const manifest = materializeHistoricalFamilyFactBundleV1(directory, fixtureInputs(family, pool));
  const variants = observeHistoricalExecutionVariantsV1(directory, manifest.manifestRoot);
  assert.equal(variants.status, "observed");
  assert.equal(variants.cases.length, 1);
  return { directory, manifestRoot: manifest.manifestRoot, caseId: variants.cases[0]!.caseId };
}

async function withCase(
  family: "v2" | "v3",
  run: (stored: StoredCase) => Promise<void>,
): Promise<void> {
  const stored = storeCase(family);
  try {
    await run(stored);
  } finally {
    rmSync(stored.directory, { recursive: true, force: true });
  }
}

test("reverse-verifies UniV2 at the exact EIP-1898 cutoff in both token orders", async () => {
  await withCase("v2", async (stored) => {
    const rpc = new MockRpc();
    const result = await observeHistoricalPoolIdentityV1(rpc, {
      rootDirectory: stored.directory,
      manifestRoot: stored.manifestRoot,
      caseId: stored.caseId,
    });
    assert.equal(result.status, "reverse-verified-ephemeral");
    assert.equal(result.sourceDigest, HISTORICAL_POOL_IDENTITY_OBSERVER_SOURCE_DIGEST_V1);
    assert.equal(
      result.sourceDigest,
      sha256Hex(Uint8Array.from(readFileSync(new URL("../src/pool-identity-observer.ts", import.meta.url)))),
    );
    assert.equal(result.caseBinding?.target, poolV2);
    assert.equal(result.caseBinding?.selector, "0x022c0d9f");
    assert.deepEqual(result.caseBinding?.framePath, ["0"]);
    assert.equal(result.cutoff?.blockHash, blockHash);
    assert.equal(result.cutoff?.stateRoot, stateRoot);
    assert.equal(result.cutoff?.chainId, "1");
    assert.equal(result.cutoff?.statePosition, "canonical-block-post-state");
    assert.equal(result.statePosition, "canonical-block-post-state");
    assert.equal(result.identity?.reversePool, poolV2);
    assert.equal(result.identity?.reversePoolReversed, poolV2);
    assert.equal(result.requests.filter((item) => item.method === "eth_call").length, 5);
    assert.deepEqual(result.requests.map((item) => item.label).filter((label) => label.startsWith("canonical-fence")), [
      "canonical-fence.before",
      "canonical-fence.after",
    ]);
    assert.deepEqual(result.requests.filter((item) => item.method === "eth_chainId").map((item) => item.label), [
      "chain-id.before",
      "chain-id.after",
    ]);
    assert.equal(
      result.requests.find((item) => item.label === "pool.factory")?.responseRoot,
      sha256Hex(encodeCanonicalBytes(addressReturn(factory))),
    );
    assert.ok(result.requests.every((item) => /^0x[0-9a-f]{64}$/.test(item.requestRoot)));
    assert.equal(result.actionCoverage.status, "unresolved");
    assert.equal(result.effectsCoverage.status, "unresolved");
    assert.equal("pass" in result, false);
  });
});

test("reverse-verifies UniV3 factory, fee, and tickSpacing at the same cutoff", async () => {
  await withCase("v3", async (stored) => {
    const result = await observeHistoricalPoolIdentityV1(new MockRpc(), {
      rootDirectory: stored.directory,
      manifestRoot: stored.manifestRoot,
      caseId: stored.caseId,
    });
    assert.equal(result.status, "reverse-verified-ephemeral");
    assert.equal(result.identity?.family, "univ3-standard");
    assert.equal(result.identity?.fee, "3000");
    assert.equal(result.identity?.tickSpacing, "60");
    assert.equal(result.identity?.reversePool, poolV3);
    assert.equal(result.identity?.reversePoolReversed, null);
  });
});

test("wrong factory reverse lookup is contradicted without action or effects claims", async () => {
  await withCase("v2", async (stored) => {
    const result = await observeHistoricalPoolIdentityV1(new MockRpc({ wrongReverse: true }), {
      rootDirectory: stored.directory,
      manifestRoot: stored.manifestRoot,
      caseId: stored.caseId,
    });
    assert.equal(result.status, "contradicted");
    assert.match(result.reasons[0]!, /reverse lookup/);
    assert.equal(result.identity?.reversePool, wrongPool);
    assert.equal(result.actionCoverage.status, "unresolved");
  });
});

test("zero and unordered identity addresses cannot be reverse-verified", async () => {
  for (const options of [
    { zeroFactory: true },
    { zeroToken: true },
    { zeroReverse: true },
    { reversedTokens: true },
  ]) {
    await withCase("v2", async (stored) => {
      const result = await observeHistoricalPoolIdentityV1(new MockRpc(options), {
        rootDirectory: stored.directory,
        manifestRoot: stored.manifestRoot,
        caseId: stored.caseId,
      });
      assert.equal(result.status, "contradicted");
      assert.notEqual(result.status, "reverse-verified-ephemeral");
    });
  }
  const stored = storeCase("v2", zeroAddress);
  try {
    const result = await observeHistoricalPoolIdentityV1(new MockRpc(), {
      rootDirectory: stored.directory,
      manifestRoot: stored.manifestRoot,
      caseId: stored.caseId,
    });
    assert.equal(result.status, "contradicted");
    assert.match(result.reasons[0]!, /pool address is zero/);
  } finally {
    rmSync(stored.directory, { recursive: true, force: true });
  }
});

test("V3 fee and tickSpacing must satisfy their exact identity ranges", async () => {
  for (const options of [{ fee: 0n }, { fee: 0xff_ffffn }, { tickSpacing: 0x7f_ffffn }]) {
    await withCase("v3", async (stored) => {
      const result = await observeHistoricalPoolIdentityV1(new MockRpc(options), {
        rootDirectory: stored.directory,
        manifestRoot: stored.manifestRoot,
        caseId: stored.caseId,
      });
      assert.equal(result.status, "reverse-verified-ephemeral");
    });
  }
  for (const [options, status] of [
    [{ fee: 0x100_0000n }, "unresolved"],
    [{ tickSpacing: 0n }, "contradicted"],
    [{ tickSpacing: -1n }, "contradicted"],
    [{ tickSpacing: 0x80_0000n }, "unresolved"],
  ] as const) {
    await withCase("v3", async (stored) => {
      const result = await observeHistoricalPoolIdentityV1(new MockRpc(options), {
        rootDirectory: stored.directory,
        manifestRoot: stored.manifestRoot,
        caseId: stored.caseId,
      });
      assert.equal(result.status, status);
      assert.notEqual(result.status, "reverse-verified-ephemeral");
    });
  }
});

test("selector collision and malformed or null ABI results remain unresolved", async () => {
  for (const options of [{ malformedFactory: true }, { nullFactory: true }]) {
    await withCase("v2", async (stored) => {
      const result = await observeHistoricalPoolIdentityV1(new MockRpc(options), {
        rootDirectory: stored.directory,
        manifestRoot: stored.manifestRoot,
        caseId: stored.caseId,
      });
      assert.equal(result.status, "unresolved");
      assert.equal(result.identity, null);
      assert.ok(result.requests.some((item) => item.label === "pool.factory"));
    });
  }
});

test("unsupported EIP-1898 never falls back to latest", async () => {
  await withCase("v2", async (stored) => {
    const rpc = new MockRpc({ unsupportedEip1898: true });
    const result = await observeHistoricalPoolIdentityV1(rpc, {
      rootDirectory: stored.directory,
      manifestRoot: stored.manifestRoot,
      caseId: stored.caseId,
    });
    assert.equal(result.status, "unsupported");
    assert.equal(rpc.calls.filter((item) => item.method === "eth_call").length, 1);
    assert.equal(rpc.calls.filter((item) => item.method === "eth_getBlockByNumber").length, 2);
    assert.equal(rpc.calls.filter((item) => item.method === "eth_chainId").length, 2);
    assert.ok(rpc.calls.every((item) => item.method !== "eth_getBlockByNumber" || item.params[0] === "0x10"));
    assert.ok(rpc.calls.every((item) => !item.params.includes("latest")));
  });
});

test("chainId mismatch before or drift after observation is unresolved", async () => {
  for (const [options, expectedChainRequests] of [
    [{ chainIdBefore: "0x2" }, 1],
    [{ chainIdAfter: "0x2" }, 2],
  ] as const) {
    await withCase("v2", async (stored) => {
      const rpc = new MockRpc(options);
      const result = await observeHistoricalPoolIdentityV1(rpc, {
        rootDirectory: stored.directory,
        manifestRoot: stored.manifestRoot,
        caseId: stored.caseId,
      });
      assert.equal(result.status, "unresolved");
      assert.match(result.reasons[0]!, /chainId/);
      assert.equal(rpc.calls.filter((item) => item.method === "eth_chainId").length, expectedChainRequests);
      assert.notEqual(result.status, "reverse-verified-ephemeral");
    });
  }
});

test("cross-case identity and canonical-fence block mutations are unresolved", async () => {
  const first = storeCase("v2");
  const second = storeCase("v3");
  try {
    const crossCase = await observeHistoricalPoolIdentityV1(new MockRpc(), {
      rootDirectory: first.directory,
      manifestRoot: first.manifestRoot,
      caseId: second.caseId,
    });
    assert.equal(crossCase.status, "unresolved");
    assert.equal(crossCase.requests.length, 0);
    for (const options of [{ mutateBefore: true }, { mutateAfter: true }]) {
      const changed = await observeHistoricalPoolIdentityV1(new MockRpc(options), {
        rootDirectory: first.directory,
        manifestRoot: first.manifestRoot,
        caseId: first.caseId,
      });
      assert.equal(changed.status, "unresolved");
      assert.match(changed.reasons[0]!, /canonical fence/);
    }
  } finally {
    rmSync(first.directory, { recursive: true, force: true });
    rmSync(second.directory, { recursive: true, force: true });
  }
});
