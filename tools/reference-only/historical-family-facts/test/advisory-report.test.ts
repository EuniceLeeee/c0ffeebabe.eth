import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  encodeCanonicalBytes,
  type CanonicalJson,
  type Hash,
} from "../../../../packages/canonical-codec/src/index.ts";
import {
  buildHistoricalFamilyAdvisoryReportV1,
  loadHistoricalFamilyAdvisoryReportV1,
  materializeHistoricalFamilyAdvisoryReportV1,
  type HistoricalFamilyAdvisoryReportV1,
} from "../src/advisory-report.ts";
import {
  materializeHistoricalFamilyFactBundleV1,
  type HistoricalRpcMethod,
  type HistoricalRpcObjectInputV1,
  type HistoricalRpcRole,
} from "../src/index.ts";

const txHash = `0x${"1".repeat(64)}` as Hash;
const blockHash = `0x${"2".repeat(64)}` as Hash;
const stateRoot = `0x${"3".repeat(64)}` as Hash;
const router = `0x${"4".repeat(40)}`;
const poolV2 = `0x${"5".repeat(40)}`;
const poolV3 = `0x${"6".repeat(40)}`;
const recipient = `0x${"7".repeat(40)}`;
const token0 = `0x${"8".repeat(40)}`;
const token1 = `0x${"9".repeat(40)}`;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function addressWord(value: string): string {
  return value.slice(2).padStart(64, "0");
}

function dynamicTail(data: string): string {
  return `${word(BigInt(data.length / 2))}${data.padEnd(Math.ceil(data.length / 64) * 64, "0")}`;
}

function uniV2CallbackCalldata(): string {
  return `0x022c0d9f${word(0n)}${word(10n)}${addressWord(recipient)}${word(128n)}${dynamicTail("aa")}`;
}

function uniV2EmptyCalldata(): string {
  return `0x022c0d9f${word(0n)}${word(10n)}${addressWord(recipient)}${word(128n)}${dynamicTail("")}`;
}

function transferCalldata(to: string, amount: bigint): string {
  return `0xa9059cbb${addressWord(to)}${word(amount)}`;
}

function canonicalUniV3Calldata(): string {
  return `0x128acb08${addressWord(recipient)}${word(0n)}${word(5n)}${word(1n)}${word(160n)}${dynamicTail("bb")}`;
}

const methods: Readonly<Record<HistoricalRpcRole, HistoricalRpcMethod>> = Object.freeze({
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

function inputs(calls: readonly CanonicalJson[] = [
  { type: "CALL", from: router, to: poolV2, input: uniV2CallbackCalldata(), value: "0x0" },
  { type: "CALL", from: router, to: poolV3, input: canonicalUniV3Calldata(), value: "0x0" },
]): readonly HistoricalRpcObjectInputV1[] {
  const transaction = {
    hash: txHash,
    blockHash,
    transactionIndex: "0x0",
    from: router,
    to: router,
    input: "0xdeadbeef",
    value: "0x0",
  };
  const results: Readonly<Record<HistoricalRpcRole, CanonicalJson>> = Object.freeze({
    transaction,
    receipt: {
      transactionHash: txHash,
      blockHash,
      transactionIndex: "0x0",
      status: "0x1",
      logs: [],
    },
    trace: {
      type: "CALL",
      from: router,
      to: router,
      input: transaction.input,
      value: transaction.value,
      calls,
    },
    header: {
      hash: blockHash,
      number: "0x10",
      stateRoot,
      transactions: [txHash],
    },
  });
  return (Object.keys(methods) as HistoricalRpcRole[]).map((role) => ({
    role,
    key: {
      chainId: "1",
      canonicalBlockHash: blockHash,
      txHash,
      method: methods[role],
      canonicalParams: params(methods[role]),
    },
    resultBytes: encodeCanonicalBytes(results[role]),
  }));
}

test("joins immutable historical cases to the current generated action closure without manufacturing a gate", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-advisory-report-"));
  try {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs());
    const report = buildHistoricalFamilyAdvisoryReportV1(directory, manifest.manifestRoot);
    assert.equal(report.advisoryOnly, true);
    assert.equal(report.observation.status, "observed");
    assert.deepEqual(
      report.cases.map((item) => [item.selectorCandidate, item.comparison.status, item.comparison.reasonCodes]),
      [
        ["univ2-standard", "unresolved", ["variant-not-covered"]],
        ["univ3-standard", "contradicted", ["current-action-abi-invalid"]],
      ],
    );
    for (const item of report.cases) {
      assert.equal(item.identityStatus, "selector-candidate-only");
      assert.equal(item.comparisonScope, "encoding-and-settlement-shape-only");
      assert.equal(item.settlementCoverage.status, "unresolved");
      assert.equal(item.effectsCoverage.status, "unresolved");
      if (item.comparison.currentClosureBinding.releaseDecision === "include") {
        assert.match(item.comparison.currentClosureBinding.definitionCatalogLeafDigest!, /^0x[0-9a-f]{64}$/);
      } else {
        assert.equal(item.comparison.currentClosureBinding.definitionCatalogLeafDigest, null);
        assert.deepEqual(item.comparison.currentClosureBinding.actionOwnerRefs, []);
      }
      assert.equal("pass" in item.comparison, false);
      assert.equal("qualified" in item.comparison, false);
    }
    const firstPath = materializeHistoricalFamilyAdvisoryReportV1(directory, report);
    const secondPath = materializeHistoricalFamilyAdvisoryReportV1(directory, report);
    assert.equal(secondPath, firstPath);
    assert.deepEqual(JSON.parse(readFileSync(firstPath, "utf8")), report);
    assert.deepEqual(
      loadHistoricalFamilyAdvisoryReportV1(directory, manifest.manifestRoot, report.reportRoot),
      report,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a derived report whose nested facts were changed without rebuilding from raw CAS", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-advisory-tamper-"));
  try {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs());
    const report = buildHistoricalFamilyAdvisoryReportV1(directory, manifest.manifestRoot);
    const path = materializeHistoricalFamilyAdvisoryReportV1(directory, report);
    const tampered = structuredClone(report) as unknown as {
      observation: { manifestIdentity: { txHash: Hash | null } };
      reportRoot: Hash;
    };
    tampered.observation.manifestIdentity.txHash = `0x${"a".repeat(64)}` as Hash;
    tampered.reportRoot = report.reportRoot;
    assert.throws(
      () => materializeHistoricalFamilyAdvisoryReportV1(
        directory,
        tampered as unknown as HistoricalFamilyAdvisoryReportV1,
      ),
      /does not exactly match a rebuild/,
    );

    writeFileSync(path, encodeCanonicalBytes(tampered as unknown as CanonicalJson));
    assert.throws(
      () => loadHistoricalFamilyAdvisoryReportV1(directory, manifest.manifestRoot, report.reportRoot),
      /does not exactly match a rebuild/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("report preserves the trace-bound prepaid witness but keeps a synthetic shape probe unresolved", () => {
  const directory = mkdtempSync(join(tmpdir(), "aloha-advisory-prepaid-"));
  try {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs([
      { type: "CALL", from: router, to: token0, input: transferCalldata(poolV2, 100n), value: "0x0" },
      {
        type: "CALL",
        from: router,
        to: poolV2,
        input: uniV2EmptyCalldata(),
        value: "0x0",
        calls: [
          { type: "CALL", from: poolV2, to: token1, input: transferCalldata(recipient, 10n), value: "0x0" },
        ],
      },
    ]));
    const report = buildHistoricalFamilyAdvisoryReportV1(directory, manifest.manifestRoot);
    assert.equal(report.cases.length, 1);
    const item = report.cases[0]!;
    assert.equal(item.settlementMode, "empty-callback-with-pretransfer-witness");
    assert.equal(item.settlementCoverage.status, "observed");
    assert.deepEqual(
      { status: item.comparison.status, reasonCodes: item.comparison.reasonCodes },
      {
        status: "unresolved",
        reasonCodes: ["synthetic-probe-not-byte-comparable", "effects-not-qualified"],
      },
    );
    assert.equal(item.effectsCoverage.status, "unresolved");
    assert.equal("pass" in item.comparison, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
