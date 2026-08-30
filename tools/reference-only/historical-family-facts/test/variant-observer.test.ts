import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  HISTORICAL_EXECUTION_VARIANT_OBSERVER_IMPLEMENTATION_DIGEST_V1,
  HISTORICAL_EXECUTION_VARIANT_OBSERVER_SPEC_DIGEST_V1,
  observeHistoricalExecutionVariantsV1,
} from "../src/variant-observer.ts";

const txHash =
  "0x149df3ec17a6044e0c66c25aa55ce044abe33bf14cedea26295e1b6d4c9fde60" as Hash;
const blockHash = `0x${"2".repeat(64)}` as Hash;
const router = `0x${"3".repeat(40)}`;
const poolV2A = `0x${"4".repeat(40)}`;
const poolV2B = `0x${"5".repeat(40)}`;
const poolV3 = `0x${"6".repeat(40)}`;
const recipient = `0x${"7".repeat(40)}`;
const token0 = `0x${"a".repeat(40)}`;
const token1 = `0x${"b".repeat(40)}`;
const trader = `0x${"c".repeat(40)}`;
const stateRoot = `0x${"8".repeat(64)}`;
const otherTxHash = `0x${"9".repeat(64)}` as Hash;

function word(value: bigint): string {
  return value.toString(16).padStart(64, "0");
}

function signedWord(value: bigint): string {
  return word(value < 0n ? (1n << 256n) + value : value);
}

function addressWord(value: string): string {
  return value.slice(2).padStart(64, "0");
}

function bytesTail(value: string): string {
  const body = value.slice(2);
  const padded = body.padEnd(Math.ceil(body.length / 64) * 64, "0");
  return `${word(BigInt(body.length / 2))}${padded}`;
}

function uniV2Calldata(options: {
  readonly amount0Out?: bigint;
  readonly amount1Out?: bigint;
  readonly callback?: string;
  readonly offset?: bigint;
  readonly toWord?: string;
  readonly suffix?: string;
} = {}): string {
  const callback = options.callback ?? "0x1234";
  return `0x022c0d9f${word(options.amount0Out ?? 0n)}${word(options.amount1Out ?? 9n)}${
    options.toWord ?? addressWord(recipient)
  }${word(options.offset ?? 128n)}${bytesTail(callback)}${options.suffix ?? ""}`;
}

function uniV3Calldata(options: {
  readonly zeroForOne?: bigint;
  readonly amountSpecified?: bigint;
  readonly callback?: string;
  readonly offset?: bigint;
  readonly recipientWord?: string;
  readonly sqrtPriceLimitWord?: string;
  readonly suffix?: string;
} = {}): string {
  const callback = options.callback ?? "0xabcdef";
  return `0x128acb08${options.recipientWord ?? addressWord(recipient)}${word(
    options.zeroForOne ?? 1n,
  )}${signedWord(options.amountSpecified ?? 12n)}${
    options.sqrtPriceLimitWord ?? word(4_295_128_740n)
  }${word(options.offset ?? 160n)}${bytesTail(callback)}${options.suffix ?? ""}`;
}

function erc20TransferCalldata(to: string, amount: bigint): string {
  return `0xa9059cbb${addressWord(to)}${word(amount)}`;
}

function erc20TransferFromCalldata(from: string, to: string, amount: bigint): string {
  return `0x23b872dd${addressWord(from)}${addressWord(to)}${word(amount)}`;
}

function call(to: string, input: string, changes: Record<string, CanonicalJson> = {}): CanonicalJson {
  return {
    type: "CALL",
    from: router,
    to,
    value: "0x0",
    input,
    ...changes,
  };
}

function fixtureTrace(calls: readonly CanonicalJson[]): CanonicalJson {
  return {
    type: "CALL",
    from: router,
    to: router,
    value: "0x0",
    input: "0xdeadbeef",
    calls,
  };
}

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

function inputs(
  trace: CanonicalJson,
  options: {
    readonly transactionIndex?: string;
    readonly receiptTransactionIndex?: string;
    readonly receiptStatus?: string;
    readonly indexedTxHash?: Hash;
    readonly missingStateRoot?: boolean;
  } = {},
): readonly HistoricalRpcObjectInputV1[] {
  const transactionIndex = options.transactionIndex ?? "0x1";
  const results: Readonly<Record<HistoricalRpcRole, CanonicalJson>> = Object.freeze({
    transaction: {
      hash: txHash,
      blockHash,
      transactionIndex,
      from: router,
      to: router,
      input: "0xdeadbeef",
      value: "0x0",
    },
    receipt: {
      transactionHash: txHash,
      blockHash,
      transactionIndex: options.receiptTransactionIndex ?? transactionIndex,
      status: options.receiptStatus ?? "0x1",
      logs: [],
    },
    trace,
    header: {
      hash: blockHash,
      ...(options.missingStateRoot ? {} : { stateRoot }),
      transactions: [otherTxHash, options.indexedTxHash ?? txHash],
    },
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

function withObservation(
  trace: CanonicalJson,
  run: (result: ReturnType<typeof observeHistoricalExecutionVariantsV1>) => void,
  options: Parameters<typeof inputs>[1] = {},
): void {
  const directory = mkdtempSync(join(tmpdir(), "aloha-variant-observer-"));
  try {
    const manifest = materializeHistoricalFamilyFactBundleV1(directory, inputs(trace, options));
    run(observeHistoricalExecutionVariantsV1(directory, manifest.manifestRoot));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("observes tx149-shaped canonical UniV3 and two UniV2 callback executions without qualifying effects", () => {
  const v3Input = uniV3Calldata();
  withObservation(
    fixtureTrace([
      call(poolV3, v3Input),
      call(poolV2A, uniV2Calldata({ amount1Out: 9n, callback: "0x1234" })),
      call(poolV2B, uniV2Calldata({ amount0Out: 7n, amount1Out: 0n, callback: "0xbeef" })),
    ]),
    (result) => {
      assert.equal(result.status, "observed");
      assert.equal(result.advisoryOnly, true);
      assert.equal(result.manifestIdentity.txHash, txHash);
      assert.equal(result.observerSpecDigest, HISTORICAL_EXECUTION_VARIANT_OBSERVER_SPEC_DIGEST_V1);
      assert.equal(
        result.observerImplementationDigest,
        HISTORICAL_EXECUTION_VARIANT_OBSERVER_IMPLEMENTATION_DIGEST_V1,
      );
      assert.match(result.caseRoot, /^0x[0-9a-f]{64}$/);
      assert.deepEqual(
        result.cases.map((item) => [
          item.selectorCandidate,
          item.executionVariant,
          item.direction,
          item.settlementMode,
          item.framePath,
        ]),
        [
          ["univ3-standard", "exact-input", "zero-for-one", "callback", ["0"]],
          ["univ2-standard", "canonical-swap", "zero-for-one", "callback", ["1"]],
          ["univ2-standard", "canonical-swap", "one-for-zero", "callback", ["2"]],
        ],
      );
      assert.ok(result.cases.every((item) => item.identityStatus === "selector-candidate-only"));
      assert.equal(result.cases[0]!.from, router);
      assert.equal(result.cases[0]!.to, poolV3);
      assert.equal(result.cases[0]!.value, "0x0");
      assert.equal(result.cases[0]!.selector, "0x128acb08");
      assert.equal(result.cases[0]!.calldataSha256, sha256Hex(Uint8Array.from(Buffer.from(v3Input.slice(2), "hex"))));
      assert.equal(result.cases[0]!.logCoverage.status, "unresolved");
      assert.equal(result.cases[0]!.effectsCoverage.status, "unresolved");
      assert.equal(result.groups.length, 3);
      assert.equal("validated" in result, false);
      assert.equal("effectsQualified" in result, false);
      assert.equal("currentAdapterPass" in result, false);
    },
  );
});

test("empty UniV2 callback without a trace-local pre-transfer stays settlement-unproven", () => {
  withObservation(
    fixtureTrace([
      call(poolV2A, uniV2Calldata({ callback: "0x" })),
      call(poolV3, uniV3Calldata({ zeroForOne: 0n, amountSpecified: -5n, callback: "0x" })),
    ]),
    (result) => {
      assert.equal(result.status, "observed");
      assert.deepEqual(
        result.cases.map((item) => [item.executionVariant, item.direction, item.settlementMode]),
        [
          ["canonical-swap", "zero-for-one", "empty-callback-settlement-unproven"],
          ["exact-output", "one-for-zero", "callback"],
        ],
      );
      assert.equal(result.cases[0]!.settlementCoverage.status, "unresolved");
      assert.match(result.cases[0]!.settlementCoverage.reason, /output-token transfer descendant/);
    },
  );
});

test("qualifies prepaid UniV2 shape only from unique ordered input and output transfer trace witnesses", () => {
  withObservation(
    fixtureTrace([
      call(token0, erc20TransferFromCalldata(trader, poolV2A, 100n)),
      call(poolV2A, uniV2Calldata({ amount1Out: 9n, callback: "0x" }), {
        calls: [call(token1, erc20TransferCalldata(recipient, 9n), { from: poolV2A })],
      }),
    ]),
    (result) => {
      assert.equal(result.status, "observed");
      const item = result.cases[0]!;
      assert.equal(item.settlementMode, "empty-callback-with-pretransfer-witness");
      assert.equal(item.settlementCoverage.status, "observed");
      if (item.settlementCoverage.status !== "observed") throw new Error("prepaid witness unavailable");
      assert.deepEqual(item.settlementCoverage, {
        status: "observed",
        kind: "univ2-prepaid-transfer-before-swap",
        associationPolicy:
          "unique-successful-pre-transfer-since-prior-same-pair-swap-and-exact-output-transfer-descendant",
        inputTransferMethod: "transferFrom",
        inputTransferFramePath: ["0"],
        inputTransferFrameIndex: "1",
        inputToken: token0,
        inputTokenRole: "token0",
        inputSender: trader,
        pair: poolV2A,
        inputAmount: "100",
        outputTransferFramePath: ["1", "0"],
        outputTransferFrameIndex: "3",
        outputToken: token1,
        outputTokenRole: "token1",
        outputRecipient: recipient,
        outputAmount: "9",
      });
      assert.equal(item.effectsCoverage.status, "unresolved");
      assert.match(item.effectsCoverage.reason, /no frame-local token or balance effects/);
    },
  );
});

test("failed, ambiguous, wrong-token, and stale pre-transfers never manufacture prepaid settlement", () => {
  const traces = [
    fixtureTrace([
      call(token0, erc20TransferCalldata(poolV2A, 100n), { error: "transfer reverted" }),
      call(poolV2A, uniV2Calldata({ callback: "0x" }), {
        calls: [call(token1, erc20TransferCalldata(recipient, 9n), { from: poolV2A })],
      }),
    ]),
    fixtureTrace([
      call(token0, erc20TransferCalldata(poolV2A, 40n)),
      call(token0, erc20TransferCalldata(poolV2A, 60n)),
      call(poolV2A, uniV2Calldata({ callback: "0x" }), {
        calls: [call(token1, erc20TransferCalldata(recipient, 9n), { from: poolV2A })],
      }),
    ]),
    fixtureTrace([
      call(token1, erc20TransferCalldata(poolV2A, 100n)),
      call(poolV2A, uniV2Calldata({ callback: "0x" }), {
        calls: [call(token1, erc20TransferCalldata(recipient, 9n), { from: poolV2A })],
      }),
    ]),
    fixtureTrace([
      call(token0, erc20TransferCalldata(poolV2A, 100n)),
      call(poolV2A, uniV2Calldata({ callback: "0x" }), {
        calls: [call(token1, erc20TransferCalldata(recipient, 9n), { from: poolV2A })],
      }),
      call(poolV2A, uniV2Calldata({ callback: "0x" }), {
        calls: [call(token1, erc20TransferCalldata(recipient, 9n), { from: poolV2A })],
      }),
    ]),
  ];
  for (const trace of traces) {
    withObservation(trace, (result) => {
      assert.ok(result.cases.length >= 1);
      const last = result.cases.at(-1)!;
      assert.equal(last.settlementMode, "empty-callback-settlement-unproven");
      assert.equal(last.settlementCoverage.status, "unresolved");
    });
  }
});

test("failed frames and descendants of failed ancestors never form observed cases", () => {
  withObservation(
    fixtureTrace([
      call(poolV2A, uniV2Calldata(), { error: "execution reverted" }),
      call(router, "0xdeadbeef", {
        revertReason: "ancestor reverted",
        calls: [call(poolV3, uniV3Calldata())],
      }),
      call(poolV2B, uniV2Calldata(), { failed: true }),
      call(poolV3, uniV3Calldata(), { success: false }),
    ]),
    (result) => {
      assert.equal(result.status, "unresolved");
      assert.equal(result.cases.length, 0);
      assert.match(result.reasons[0]!, /no successful strictly decoded/);
    },
  );
  withObservation(
    {
      ...fixtureTrace([call(poolV2A, uniV2Calldata())]) as Record<string, CanonicalJson>,
      error: "root reverted",
    },
    (result) => {
      assert.equal(result.status, "unresolved");
      assert.equal(result.cases.length, 0);
    },
  );
});

test("strict canonical ABI decoder rejects offset, padding, trailing, and semantic mutations", () => {
  const invalid = [
    uniV2Calldata({ offset: 160n }),
    uniV2Calldata({ toWord: `${"f".repeat(24)}${recipient.slice(2)}` }),
    uniV2Calldata({ suffix: "00" }),
    uniV2Calldata({ amount0Out: 1n, amount1Out: 1n }),
    uniV3Calldata({ offset: 192n }),
    uniV3Calldata({ recipientWord: `${"f".repeat(24)}${recipient.slice(2)}` }),
    uniV3Calldata({ zeroForOne: 2n }),
    uniV3Calldata({ sqrtPriceLimitWord: `${"f".repeat(24)}${word(1n).slice(24)}` }),
    uniV3Calldata({ suffix: "00" }),
    uniV3Calldata({ amountSpecified: 0n }),
  ];
  for (const calldata of invalid) {
    withObservation(
      fixtureTrace([call(calldata.startsWith("0x022c0d9f") ? poolV2A : poolV3, calldata)]),
      (result) => {
        assert.equal(result.status, "unresolved", calldata);
        assert.equal(result.cases.length, 0);
        assert.ok(result.reasons.length > 0);
      },
    );
  }
});

test("strict decoder rejects non-zero dynamic bytes padding", () => {
  const canonical = uniV3Calldata({ callback: "0xab" });
  const mutated = `${canonical.slice(0, -2)}01`;
  withObservation(fixtureTrace([call(poolV3, mutated)]), (result) => {
    assert.equal(result.status, "unresolved");
    assert.match(result.reasons[0]!, /non-zero dynamic bytes padding/);
  });
});

test("recognized swap selectors require CALL frames", () => {
  withObservation(
    fixtureTrace([call(poolV3, uniV3Calldata(), { type: "DELEGATECALL" })]),
    (result) => {
      assert.equal(result.status, "unresolved");
      assert.match(result.reasons[0]!, /swap frame must have CALL type/);
    },
  );
});

test("old CAS bundles must independently join transaction, receipt, header, and trace-root identity", () => {
  const base = fixtureTrace([call(poolV3, uniV3Calldata())]) as Record<string, CanonicalJson>;
  const cases: readonly [CanonicalJson, Parameters<typeof inputs>[1], RegExp][] = [
    [base, { receiptTransactionIndex: "0x0" }, /transactionIndex mismatch/],
    [base, { receiptStatus: "0x0" }, /receipt status is not successful/],
    [base, { indexedTxHash: otherTxHash }, /header transaction at transactionIndex/],
    [base, { missingStateRoot: true }, /stateRoot/],
    [{ ...base, type: "DELEGATECALL" }, {}, /trace root type/],
    [{ ...base, from: recipient }, {}, /trace root from/],
    [{ ...base, to: recipient }, {}, /trace root to/],
    [{ ...base, input: "0xfeedbeef" }, {}, /trace root input/],
    [{ ...base, value: "0x1" }, {}, /trace root value/],
  ];
  for (const [trace, options, reason] of cases) {
    withObservation(trace, (result) => {
      assert.equal(result.status, "unresolved");
      assert.equal(result.cases.length, 0);
      assert.match(result.reasons[0]!, reason);
    }, options);
  }
});

test("case root commits to the exact manifest and full calldata", () => {
  let firstRoot: Hash | null = null;
  withObservation(fixtureTrace([call(poolV2A, uniV2Calldata({ callback: "0x12" }))]), (result) => {
    firstRoot = result.caseRoot;
  });
  withObservation(fixtureTrace([call(poolV2A, uniV2Calldata({ callback: "0x13" }))]), (result) => {
    assert.notEqual(result.caseRoot, firstRoot);
  });
});
