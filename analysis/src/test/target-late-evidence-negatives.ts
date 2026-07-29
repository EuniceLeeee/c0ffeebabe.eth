import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { ethers } from "ethers";
import {
  assertProducerExplicitInputBindings,
  assertImpactedFamilyParticipates,
  assertRouteExecutionOwnership,
  assertFrozenArtifactsUnchanged,
  assertTargetAbsentFromProcessInput,
  expectedProducerExplicitInputBindings,
  hideTrustedReferencesFromProducerWorktree,
  isolatedChildEnvironment,
  sealArtifact,
  targetBlindProducerArgs,
} from "../six-step-validation-controller.js";
import type {
  FamilyOwnershipManifest,
  FamilyOwnershipManifestEntry,
} from "../../../listener/src/searcher/test/family-ownership-manifest.js";
import {
  assertCanonicalTargetReceipt,
  assertClosedProfitToken,
  assertFundingTransfersFromReceipt,
  assertFrozenResult,
  assertRouteReferenceWitnesses,
  assertTargetBlindExplicitInputBindings,
  assertTargetBlindScanCompleteness,
  assertTrustedReference,
  executorTransferTokensFromReceipt,
  resolveFrozenFundingHolder,
  resolvedPlanScriptSha256,
  targetBlindHuntEnvironment,
  type HuntEdge,
  type HuntSolve,
  type TrustedReferenceRoute,
} from "../../../listener/src/searcher/test/production-replay.js";
import {
  semanticJsonSha256,
  type SemanticJson,
} from "../../../listener/src/shared/evidence/semantic-six-step.js";
import {
  DEFAULT_SEARCHER_EXECUTOR,
} from "../../../listener/src/shared/executor/botvm-executor.js";

const TX = `0x${"1".repeat(64)}`;
const HASH = `0x${"2".repeat(64)}`;
const ROOT = `0x${"3".repeat(64)}`;
const TOKEN_A = "0x00000000000000000000000000000000000000a1";
const TOKEN_B = "0x00000000000000000000000000000000000000b2";
const TARGET_A = "0x00000000000000000000000000000000000000c3";
const TARGET_B = "0x00000000000000000000000000000000000000d4";
const SIG_A = "swapA(address,address,uint256)";
const SIG_B = "swapB(address,address,uint256)";
const IFACE_A = new ethers.Interface([`function ${SIG_A}`]);
const IFACE_B = new ethers.Interface([`function ${SIG_B}`]);
const SELECTOR_A = IFACE_A.getFunction("swapA")!.selector.toLowerCase();
const SELECTOR_B = IFACE_B.getFunction("swapB")!.selector.toLowerCase();

const route: HuntEdge[] = [
  {
    adapterId: "test-a",
    target: TARGET_A,
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  },
  {
    adapterId: "test-b",
    target: TARGET_B,
    tokenIn: TOKEN_B,
    tokenOut: TOKEN_A,
    slotKind: "swap",
    edgeKind: "swap",
    leavesStandingPosition: false,
  },
];

test("producer argv/env cannot carry the target or expected controls", () => {
  const args = targetBlindProducerArgs({
    producerPath: "/repo/production-replay.ts",
    anchor: {
      base_block: 100,
      base_block_hash: HASH,
      base_state_root: ROOT,
    },
    fromBlock: 50,
    universe: "/tmp/universe.json",
    anvilPort: 18555,
    workspace: "/tmp/workspace",
    config: {
      maxPools: 20_000,
      maxHops: 4,
      maxCandidates: 100,
      refineCandidates: 512,
      topK: 100,
      minSpreadBps: 10,
      prewarmBudgetMs: 120_000,
      scanBudgetMs: 1_500,
      passBudgetMs: 11_000,
      largeGraphPassBudgetMs: 30_000,
      largeGraphEdgeThreshold: 20_000,
      refineFamilyTimeoutMs: 1_000,
    },
    out: "/tmp/pending.json",
  });
  assert(!args.includes("--winner-tx"));
  assert(!args.includes("--trusted-reference"));
  assert.doesNotThrow(() =>
    assertTargetAbsentFromProcessInput(TX, args, {}, "producer"));
  assert.throws(
    () => assertTargetAbsentFromProcessInput(
      TX,
      [...args, "--winner-tx", TX],
      {},
      "producer",
    ),
    /contains target transaction/,
  );

  const outer = isolatedChildEnvironment({
    SEARCHER_POOL_UNIVERSE_TOP_N: "20000",
    SEARCHER_EXPECTED_ROUTE: TX,
    SEARCHER_TARGET_TX: TX,
    HUNT_EXPECTED_ROUTE: TX,
    AB_EXPECTED_ROUTE_JSON: TX,
    MAINNET_RPC_URL: "http://127.0.0.1:8545",
  });
  assert.equal(outer.SEARCHER_POOL_UNIVERSE_TOP_N, "20000");
  assert.equal(outer.SEARCHER_EXPECTED_ROUTE, undefined);
  assert.equal(outer.SEARCHER_TARGET_TX, undefined);
  assert.equal(outer.HUNT_EXPECTED_ROUTE, undefined);
  assert.equal(outer.AB_EXPECTED_ROUTE_JSON, undefined);
  const huntEnv = targetBlindHuntEnvironment({
    ...outer,
    PRODUCTION_REPLAY_ALLOWED_SEARCHER_CONFIG_KEYS:
      "SEARCHER_POOL_UNIVERSE_TOP_N,SEARCHER_EXPECTED_ROUTE",
    SEARCHER_EXPECTED_ROUTE: TX,
  }, {
    SEARCHER_TEST_DISABLE_DOTENV: "1",
    SEARCHER_TARGET_BLIND_EVIDENCE: "1",
    HUNT_BLOCK: "100",
  });
  assert.equal(huntEnv.SEARCHER_POOL_UNIVERSE_TOP_N, "20000");
  assert.equal(huntEnv.SEARCHER_EXPECTED_ROUTE, undefined);
  assert.equal(huntEnv.SEARCHER_TARGET_BLIND_EVIDENCE, "1");
  assert.equal(huntEnv.HUNT_BLOCK, "100");
});

test("target-blind scan evidence rejects budget-censored ranks", () => {
  const complete = {
    outcome: "ran" as const,
    rankComplete: true,
    refinementDeadlineHit: false,
    evaluationComplete: true,
    enumeratedCount: 12,
    selectedCount: 8,
    forcedSelectionCount: 0,
    scannedPairs: 20,
  };
  assert.doesNotThrow(() =>
    assertTargetBlindScanCompleteness(complete));
  assert.throws(
    () => assertTargetBlindScanCompleteness({
      ...complete,
      outcome: "budget_exceeded",
      rankComplete: false,
      evaluationComplete: false,
    }),
    /budget-censored or incomplete/,
  );
  assert.throws(
    () => assertTargetBlindScanCompleteness({
      ...complete,
      refinementDeadlineHit: true,
      evaluationComplete: false,
    }),
    /budget-censored or incomplete/,
  );
  assert.throws(
    () => assertTargetBlindScanCompleteness({
      ...complete,
      selectedCount: 13,
    }),
    /budget-censored or incomplete/,
  );
});

test("target-blind producer binds the exact explicit input tuple", () => {
  const expected = expectedProducerExplicitInputBindings({
    universeSha256: "a".repeat(64),
    universeManifestSha256: "b".repeat(64),
    runtimeJsonInputs: [
      { key: "SEARCHER_Z_JSON_PATH", sha256: "d".repeat(64) },
      { key: "SEARCHER_A_JSON_PATH", sha256: "c".repeat(64) },
    ],
  });
  assert.deepEqual(
    expected.runtimeJsonInputs.map((item) => item.key),
    ["SEARCHER_A_JSON_PATH", "SEARCHER_Z_JSON_PATH"],
  );
  assert.doesNotThrow(() =>
    assertTargetBlindExplicitInputBindings(expected));
  assert.doesNotThrow(() =>
    assertProducerExplicitInputBindings(expected, expected));
  assert.throws(
    () => assertProducerExplicitInputBindings(
      {
        ...expected,
        universeSha256: "e".repeat(64),
      },
      expected,
    ),
    /did not consume the frozen/,
  );
  assert.throws(
    () => assertProducerExplicitInputBindings(
      {
        ...expected,
        runtimeJsonInputs: expected.runtimeJsonInputs.slice(1),
      },
      expected,
    ),
    /did not consume the frozen/,
  );
  assert.throws(
    () => assertTargetBlindExplicitInputBindings({
      ...expected,
      universeManifestSha256: "f".repeat(64),
    }),
    /binding hash is invalid/,
  );
});

test("artifact seal is atomic/read-only and mutation fails recheck", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "target-late-seal-"));
  try {
    const pending = resolve(dir, "result.pending.json");
    const sealed = resolve(dir, "result.sealed.json");
    writeFileSync(pending, "{\"natural\":true}\n", { mode: 0o600 });
    const digest = sealArtifact(pending, sealed);
    assert.equal(
      digest,
      createHash("sha256").update(readFileSync(sealed)).digest("hex"),
    );
    assert.equal(statSync(sealed).mode & 0o777, 0o400);
    assertFrozenArtifactsUnchanged([{ path: sealed, sha256: digest }]);
    chmodSync(sealed, 0o600);
    writeFileSync(sealed, "{\"natural\":false}\n");
    assert.throws(
      () => assertFrozenArtifactsUnchanged([
        { path: sealed, sha256: digest },
      ]),
      /frozen artifact mutated/,
    );
    assert.throws(
      () => sealArtifact(sealed, resolve(dir, "nested", "bad.json")),
      /same-directory/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("candidate producer worktree does not expose trusted references", () => {
  const worktree = mkdtempSync(resolve(tmpdir(), "target-late-worktree-"));
  try {
    const references = resolve(
      worktree,
      "docs/research/references/production-routes",
    );
    mkdirSync(references, { recursive: true });
    writeFileSync(resolve(references, "sample.json"), "{}\n");
    const retained = resolve(worktree, "listener/src/adapter.ts");
    mkdirSync(resolve(retained, ".."), { recursive: true });
    writeFileSync(retained, "export {};\n");
    hideTrustedReferencesFromProducerWorktree(worktree);
    assert.equal(existsSync(references), false);
    assert.equal(existsSync(retained), true);
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
});

test("route/frozen hash and profit-token claims fail closed", () => {
  const routeSha256 = semanticJsonSha256(
    route as unknown as SemanticJson,
  );
  const frozen = frozenResult(routeSha256);
  assert.doesNotThrow(() => assertFrozenResult(frozen, routeSha256));
  assert.throws(
    () => assertFrozenResult(
      { ...frozen, routeSha256: "0".repeat(64) },
      routeSha256,
    ),
    /malformed/,
  );
  assert.throws(
    () => assertFrozenResult(
      { ...frozen, calldataSha256: "0".repeat(64) },
      routeSha256,
    ),
    /malformed/,
  );
  assert.throws(
    () => assertFrozenResult(
      { ...frozen, resolvedPlanSha256: "0".repeat(64) },
      routeSha256,
    ),
    /malformed/,
  );
  assert.doesNotThrow(() => assertClosedProfitToken(route, TOKEN_A));
  assert.throws(
    () => assertClosedProfitToken(route, TOKEN_B),
    /closed profit-token ring/,
  );
  assert.throws(
    () => assertClosedProfitToken(
      [{ ...route[0], tokenOut: TOKEN_A }, route[1]],
      TOKEN_A,
    ),
    /closed profit-token ring/,
  );
});

test("selected route exercises the changed family and owns its action closure", () => {
  const frozen = frozenResult(
    semanticJsonSha256(route as unknown as SemanticJson),
  );
  const selected = {
    fundingActionId: frozen.fundingActionId,
    executionSurfaces: frozen.executionSurfaces,
    supportActionAdapterIds: frozen.supportActionAdapterIds,
    supportExecutionCalls: frozen.supportExecutionCalls,
  };
  const manifest = ownershipManifest();
  assert.doesNotThrow(() =>
    assertImpactedFamilyParticipates(
      ["swap:test"],
      ["swap:test"],
    ));
  assert.throws(
    () => assertImpactedFamilyParticipates(
      ["swap:foreign"],
      ["swap:test"],
    ),
    /not exercised/,
  );
  assert.doesNotThrow(() =>
    assertRouteExecutionOwnership(
      selected,
      route,
      manifest,
    ));

  const ownerlessRoot = JSON.parse(JSON.stringify(selected));
  ownerlessRoot.executionSurfaces[0].rootActionAdapterId =
    "erc20-transfer";
  ownerlessRoot.executionSurfaces[0].subtreeActionAdapterIds[0] =
    "erc20-transfer";
  ownerlessRoot.executionSurfaces[0].actionCalls[0].actionAdapterId =
    "erc20-transfer";
  assert.throws(
    () => assertRouteExecutionOwnership(
      ownerlessRoot,
      route,
      manifest,
    ),
    /family-owned execution root/,
  );

  const foreignSubtree = JSON.parse(JSON.stringify(selected));
  foreignSubtree.executionSurfaces[0].subtreeActionAdapterIds.push(
    "foreign-action",
  );
  assert.throws(
    () => assertRouteExecutionOwnership(
      foreignSubtree,
      route,
      manifest,
    ),
    /foreign action/,
  );

  assert.throws(
    () => assertRouteExecutionOwnership(
      {
        ...selected,
        supportActionAdapterIds: ["foreign-action"],
        supportExecutionCalls: [{
          actionAdapterId: "foreign-action",
        }],
      },
      route,
      manifest,
    ),
    /undeclared support action/,
  );
  assert.throws(
    () => assertRouteExecutionOwnership(
      {
        ...selected,
        supportExecutionCalls: [{
          actionAdapterId: "erc20-transfer",
        }],
      },
      route,
      manifest,
    ),
    /outside the declared support closure/,
  );
});

test("funding and declarative target/final witnesses fail closed", () => {
  assert.equal(
    resolveFrozenFundingHolder("balancer-flash").toLowerCase(),
    "0xba12222222228d8ba445958a75a0704d566bf2c8",
  );
  assert.throws(
    () => resolveFrozenFundingHolder("candidate-invented-funding"),
    /rollback registry does not own/,
  );
  const reference = trustedReference();
  const calldataA = IFACE_A.encodeFunctionData(
    "swapA",
    [TOKEN_A, TOKEN_B, 10n],
  );
  const calldataB = IFACE_B.encodeFunctionData(
    "swapB",
    [TOKEN_B, TOKEN_A, 9n],
  );
  const surfaces = [
    {
      adapterId: route[0].adapterId,
      familyId: "swap:test",
      rootActionAdapterId: route[0].adapterId,
      target: TARGET_A,
      selector: SELECTOR_A,
      calldataSha256: createHash("sha256").update(calldataA).digest("hex"),
      subtreeActionAdapterIds: [route[0].adapterId],
      actionCalls: [{
        actionAdapterId: route[0].adapterId,
        target: TARGET_A,
        selector: SELECTOR_A,
        calldataSha256:
          createHash("sha256").update(calldataA).digest("hex"),
      }],
    },
    {
      adapterId: route[1].adapterId,
      familyId: "swap:test",
      rootActionAdapterId: route[1].adapterId,
      target: TARGET_B,
      selector: SELECTOR_B,
      calldataSha256: createHash("sha256").update(calldataB).digest("hex"),
      subtreeActionAdapterIds: [route[1].adapterId],
      actionCalls: [{
        actionAdapterId: route[1].adapterId,
        target: TARGET_B,
        selector: SELECTOR_B,
        calldataSha256:
          createHash("sha256").update(calldataB).digest("hex"),
      }],
    },
  ];
  const trace = {
    to: DEFAULT_SEARCHER_EXECUTOR,
    input: "0x11111111",
    calls: [
      { to: TARGET_A, input: calldataA },
      { to: TOKEN_A, input: "0xa9059cbb00" },
      { to: TARGET_B, input: calldataB },
    ],
  };
  const check = (
    candidateTrace: unknown,
    requireResolvedCallBytes = true,
    candidateReference = reference,
  ) => assertRouteReferenceWitnesses({
    trace: candidateTrace,
    receipt: { logs: [] },
    reference: candidateReference,
    executionSurfaces: surfaces,
    supportExecutionCalls: [],
    label: "test",
    requireResolvedCallBytes,
  });
  assert.doesNotThrow(() => check(trace));
  assert.throws(
    () => check(
      {
        ...trace,
        calls: [...trace.calls].reverse(),
      },
    ),
    /witness root failed/,
  );
  assert.throws(
    () => check({
      ...trace,
      calls: [{
        to: TARGET_A,
        input: calldataA,
        calls: [{ to: TARGET_B, input: calldataB }],
      }],
    }),
    /witness root failed/,
  );
  assert.throws(
    () => check(
      {
        ...trace,
        calls: [
          { ...trace.calls[0], success: false },
          trace.calls[2],
        ],
      },
    ),
    /witness root failed/,
  );
  const weakDirection = JSON.parse(
    JSON.stringify(reference),
  ) as any;
  weakDirection.routeWitnesses[0].referenceWitness.calls[0].args =
    weakDirection.routeWitnesses[0].referenceWitness.calls[0].args
      .filter((rule: { readonly ref?: string }) =>
        !("ref" in rule) || rule.ref !== "token-out");
  assert.throws(
    () => check(trace, false, weakDirection),
    /does not bind both tokens/,
  );
  assert.throws(
    () => check({
      ...trace,
      calls: [
        {
          to: TARGET_A,
          input: IFACE_A.encodeFunctionData(
            "swapA",
            [TOKEN_B, TOKEN_A, 10n],
          ),
        },
        trace.calls[2],
      ],
    }, false),
    /witness root failed/,
  );
  assert.throws(
    () => check(
      {
        ...trace,
        calls: [
          { ...trace.calls[0], error: "execution reverted" },
          trace.calls[2],
        ],
      },
    ),
    /witness root failed/,
  );
  assert.throws(
    () => check(
      {
        ...trace,
        calls: [
          {
            to: TARGET_A,
            input: IFACE_A.encodeFunctionData(
              "swapA",
              [TOKEN_A, TOKEN_B, 11n],
            ),
          },
          trace.calls[2],
        ],
      },
      true,
    ),
    /differs from the solver-selected resolved subtree/,
  );
});

test("ownerless support calls require semantic and exact trace coverage", () => {
  const reference = JSON.parse(
    JSON.stringify(trustedReference()),
  ) as any;
  const supportInterface = new ethers.Interface([
    "function transfer(address to,uint256 amount)",
  ]);
  const supportCalldata = supportInterface.encodeFunctionData(
    "transfer",
    [TARGET_A, 1n],
  );
  const supportSelector = supportCalldata.slice(0, 10).toLowerCase();
  reference.routeWitnesses[0].referenceWitness.calls.push({
    id: "support",
    target: "token-in",
    signature: "transfer(address,uint256)",
    args: [
      { index: 0, op: "eq", ref: "execution-target" },
      { index: 1, op: "positive" },
    ],
    value: null,
  });
  const frozen = frozenResult(
    semanticJsonSha256(route as unknown as SemanticJson),
  );
  const trace = {
    to: DEFAULT_SEARCHER_EXECUTOR,
    input: "0x11111111",
    calls: [
      {
        to: TARGET_A,
        input: IFACE_A.encodeFunctionData(
          "swapA",
          [TOKEN_A, TOKEN_B, 10n],
        ),
      },
      { to: TOKEN_A, input: supportCalldata },
      {
        to: TARGET_B,
        input: IFACE_B.encodeFunctionData(
          "swapB",
          [TOKEN_B, TOKEN_A, 9n],
        ),
      },
    ],
  };
  const supportExecutionCalls = [{
    actionAdapterId: "erc20-transfer",
    target: TOKEN_A,
    selector: supportSelector,
    calldataSha256: createHash("sha256")
      .update(supportCalldata)
      .digest("hex"),
  }];
  const verify = (
    candidateTrace: unknown,
    exact: boolean,
  ) => assertRouteReferenceWitnesses({
    trace: candidateTrace,
    receipt: { logs: [] },
    reference,
    executionSurfaces: frozen.executionSurfaces,
    supportExecutionCalls,
    label: "support-test",
    requireResolvedCallBytes: exact,
  });
  assert.doesNotThrow(() => verify(trace, false));
  assert.doesNotThrow(() => verify(trace, true));
  assert.throws(
    () => verify({
      ...trace,
      calls: [trace.calls[0], trace.calls[2]],
    }, false),
    /witness support failed/,
  );
  const changedSupport = supportInterface.encodeFunctionData(
    "transfer",
    [TARGET_A, 2n],
  );
  assert.throws(
    () => verify({
      ...trace,
      calls: [
        trace.calls[0],
        { to: TOKEN_A, input: changedSupport },
        trace.calls[2],
      ],
    }, true),
    /support action erc20-transfer is not byte-bound/,
  );
});

test("a declared child call cannot be borrowed from a sibling branch", () => {
  const reference = JSON.parse(
    JSON.stringify(trustedReference()),
  ) as any;
  reference.routeWitnesses[0].referenceWitness.calls.push({
    id: "settle",
    within: "root",
    target: "token-out",
    calldata: "empty",
    args: [],
    value: null,
  });
  const calldataA = IFACE_A.encodeFunctionData(
    "swapA",
    [TOKEN_A, TOKEN_B, 10n],
  );
  const calldataB = IFACE_B.encodeFunctionData(
    "swapB",
    [TOKEN_B, TOKEN_A, 9n],
  );
  const surface = frozenResult(
    semanticJsonSha256(route as unknown as SemanticJson),
  ).executionSurfaces;
  const run = (calls: unknown[]) => assertRouteReferenceWitnesses({
    trace: {
      to: DEFAULT_SEARCHER_EXECUTOR,
      input: "0x11111111",
      calls,
    },
    receipt: { logs: [] },
    reference,
    executionSurfaces: surface,
    supportExecutionCalls: [],
    label: "branch-test",
    requireResolvedCallBytes: false,
  });
  assert.throws(
    () => run([
      { to: TARGET_A, input: calldataA },
      { to: TOKEN_B, input: "0x" },
      { to: TARGET_B, input: calldataB },
    ]),
    /witness settle failed/,
  );
  assert.doesNotThrow(() => run([
    {
      to: TARGET_A,
      input: calldataA,
      calls: [{ to: TOKEN_B, input: "0x" }],
    },
    { to: TARGET_B, input: calldataB },
  ]));
});

test("one physical trace call cannot satisfy two declarative rules", () => {
  const reference = JSON.parse(
    JSON.stringify(trustedReference()),
  ) as any;
  reference.routeWitnesses[0].referenceWitness.calls.push(
    {
      id: "child-a",
      within: "root",
      target: "token-in",
      calldata: "empty",
      args: [],
      value: null,
    },
    {
      id: "child-b",
      within: "root",
      target: "token-in",
      calldata: "empty",
      args: [],
      value: null,
    },
  );
  const calldataA = IFACE_A.encodeFunctionData(
    "swapA",
    [TOKEN_A, TOKEN_B, 10n],
  );
  const calldataB = IFACE_B.encodeFunctionData(
    "swapB",
    [TOKEN_B, TOKEN_A, 9n],
  );
  const surfaces = frozenResult(
    semanticJsonSha256(route as unknown as SemanticJson),
  ).executionSurfaces;
  const verify = (childCount: number) => assertRouteReferenceWitnesses({
    trace: {
      to: DEFAULT_SEARCHER_EXECUTOR,
      input: "0x11111111",
      calls: [
        {
          to: TARGET_A,
          input: calldataA,
          calls: Array.from(
            { length: childCount },
            () => ({ to: TOKEN_A, input: "0x" }),
          ),
        },
        { to: TARGET_B, input: calldataB },
      ],
    },
    receipt: { logs: [] },
    reference,
    executionSurfaces: surfaces,
    supportExecutionCalls: [],
    label: "unique-call-test",
    requireResolvedCallBytes: true,
  });
  assert.throws(
    () => verify(1),
    /reference trace witness child-b failed/,
  );
  assert.doesNotThrow(() => verify(2));
});

test("one physical Transfer log cannot satisfy two receipt rules", () => {
  const reference = JSON.parse(
    JSON.stringify(trustedReference()),
  ) as any;
  const transferRule = {
    token: "token-in",
    from: "any",
    to: "any",
    amount: "positive",
  };
  reference.routeWitnesses[0].referenceWitness.receiptTransfers = [
    transferRule,
    transferRule,
  ];
  const calldataA = IFACE_A.encodeFunctionData(
    "swapA",
    [TOKEN_A, TOKEN_B, 10n],
  );
  const calldataB = IFACE_B.encodeFunctionData(
    "swapB",
    [TOKEN_B, TOKEN_A, 9n],
  );
  const transferLog = {
    address: TOKEN_A,
    topics: [
      ethers.id("Transfer(address,address,uint256)"),
      ethers.zeroPadValue(TARGET_A, 32),
      ethers.zeroPadValue(TARGET_B, 32),
    ],
    data: ethers.zeroPadValue(ethers.toBeHex(1n), 32),
  };
  const surfaces = frozenResult(
    semanticJsonSha256(route as unknown as SemanticJson),
  ).executionSurfaces;
  const verify = (logCount: number) => assertRouteReferenceWitnesses({
    trace: {
      to: DEFAULT_SEARCHER_EXECUTOR,
      input: "0x11111111",
      calls: [
        { to: TARGET_A, input: calldataA },
        { to: TARGET_B, input: calldataB },
      ],
    },
    receipt: {
      logs: Array.from({ length: logCount }, () => transferLog),
    },
    reference,
    executionSurfaces: surfaces,
    supportExecutionCalls: [],
    label: "unique-transfer-test",
    requireResolvedCallBytes: true,
  });
  assert.throws(
    () => verify(1),
    /reference receipt transfer witness failed/,
  );
  assert.doesNotThrow(() => verify(2));
});

test("one physical Transfer log cannot satisfy two route legs", () => {
  const reference = JSON.parse(
    JSON.stringify(trustedReference()),
  ) as any;
  reference.routeWitnesses[0].referenceWitness.receiptTransfers = [{
    token: "token-in",
    from: "any",
    to: "any",
    amount: "positive",
  }];
  reference.routeWitnesses[1].referenceWitness.receiptTransfers = [{
    token: "token-out",
    from: "any",
    to: "any",
    amount: "positive",
  }];
  const calldataA = IFACE_A.encodeFunctionData(
    "swapA",
    [TOKEN_A, TOKEN_B, 10n],
  );
  const calldataB = IFACE_B.encodeFunctionData(
    "swapB",
    [TOKEN_B, TOKEN_A, 9n],
  );
  const transferLog = {
    address: TOKEN_A,
    topics: [
      ethers.id("Transfer(address,address,uint256)"),
      ethers.zeroPadValue(TARGET_A, 32),
      ethers.zeroPadValue(TARGET_B, 32),
    ],
    data: ethers.zeroPadValue(ethers.toBeHex(1n), 32),
  };
  const surfaces = frozenResult(
    semanticJsonSha256(route as unknown as SemanticJson),
  ).executionSurfaces;
  const verify = (logCount: number) => assertRouteReferenceWitnesses({
    trace: {
      to: DEFAULT_SEARCHER_EXECUTOR,
      input: "0x11111111",
      calls: [
        { to: TARGET_A, input: calldataA },
        { to: TARGET_B, input: calldataB },
      ],
    },
    receipt: {
      logs: Array.from({ length: logCount }, () => transferLog),
    },
    reference,
    executionSurfaces: surfaces,
    supportExecutionCalls: [],
    label: "cross-leg-unique-transfer-test",
    requireResolvedCallBytes: true,
  });
  assert.throws(
    () => verify(1),
    /reference receipt transfer witness failed/,
  );
  assert.doesNotThrow(() => verify(2));
});

test("trusted reference binds route hash and declarative witnesses", () => {
  const reference = trustedReference();
  assert.doesNotThrow(() => assertTrustedReference(reference, TX));
  assert.throws(
    () => assertTrustedReference(
      { ...reference, routeSha256: "0".repeat(64) },
      TX,
    ),
    /route hash/,
  );
  assert.throws(
    () => assertTrustedReference({
      ...reference,
      routeWitnesses: [
        reference.routeWitnesses[0],
        {
          ...reference.routeWitnesses[1],
          tokenIn: TOKEN_A,
        },
      ],
    }, TX),
    /witness identity/,
  );
  const singletonRoute = [
    {
      ...reference.route[0],
      poolId: `0x${"ab".repeat(32)}`,
    },
    reference.route[1],
  ];
  assert.throws(
    () => assertTrustedReference({
      ...reference,
      route: singletonRoute,
      routeSha256: semanticJsonSha256(
        singletonRoute as unknown as SemanticJson,
      ),
      routeWitnesses: [
        {
          ...reference.routeWitnesses[0],
          poolId: singletonRoute[0].poolId,
        },
        reference.routeWitnesses[1],
      ],
    }, TX),
    /does not bind singleton poolId/,
  );
});

test("target receipt must be successful and canonically block-bound", () => {
  const receipt = {
    status: "0x1",
    blockNumber: "0x65",
    blockHash: HASH,
  };
  const header = {
    number: "0x65",
    hash: HASH,
    parentHash: ROOT,
  };
  assert.doesNotThrow(() =>
    assertCanonicalTargetReceipt(receipt, header, 101, ROOT));
  assert.throws(
    () => assertCanonicalTargetReceipt(
      { ...receipt, status: "0x0" },
      header,
      101,
      ROOT,
    ),
    /reverted or not bound/,
  );
  assert.throws(
    () => assertCanonicalTargetReceipt(
      { ...receipt, blockHash: `0x${"4".repeat(64)}` },
      header,
      101,
      ROOT,
    ),
    /reverted or not bound/,
  );
  assert.throws(
    () => assertCanonicalTargetReceipt(
      receipt,
      { ...header, parentHash: `0x${"5".repeat(64)}` },
      101,
      ROOT,
    ),
    /reverted or not bound/,
  );
});

test("final-sim Transfer logs expand executor conservation tokens", () => {
  const transferTopic = ethers.id(
    "Transfer(address,address,uint256)",
  );
  const executorTopic = ethers.zeroPadValue(
    DEFAULT_SEARCHER_EXECUTOR,
    32,
  );
  const other = "0x00000000000000000000000000000000000000e5";
  const otherTopic = ethers.zeroPadValue(other, 32);
  const amount = ethers.zeroPadValue("0x64", 32);
  const tokens = executorTransferTokensFromReceipt({
    logs: [
      {
        address: TOKEN_A,
        topics: [transferTopic, otherTopic, executorTopic],
        data: amount,
      },
      {
        address: TOKEN_B,
        topics: [transferTopic, otherTopic, otherTopic],
        data: amount,
      },
      {
        address: TARGET_A,
        topics: [ethers.id("Approval(address,address,uint256)")],
      },
    ],
  }, DEFAULT_SEARCHER_EXECUTOR);
  assert.deepEqual(tokens, [TOKEN_A]);
  assert.throws(
    () => executorTransferTokensFromReceipt({
      logs: [{
        address: TOKEN_A,
        topics: [transferTopic, "0x01", executorTopic],
        data: amount,
      }],
    }, DEFAULT_SEARCHER_EXECUTOR),
    /Transfer log is malformed/,
  );
});

test("final-sim receipt proves declared funding borrow and repayment", () => {
  const holder = resolveFrozenFundingHolder("balancer-flash");
  const topic = ethers.id("Transfer(address,address,uint256)");
  const holderTopic = ethers.zeroPadValue(holder, 32);
  const executorTopic = ethers.zeroPadValue(
    DEFAULT_SEARCHER_EXECUTOR,
    32,
  );
  const log = (from: string, to: string, amount: bigint) => ({
    address: TOKEN_A,
    topics: [topic, from, to],
    data: ethers.zeroPadValue(ethers.toBeHex(amount), 32),
  });
  const valid = {
    logs: [
      log(holderTopic, executorTopic, 100n),
      log(executorTopic, holderTopic, 101n),
    ],
  };
  assert.doesNotThrow(() =>
    assertFundingTransfersFromReceipt(valid, {
      token: TOKEN_A,
      holder,
      executor: DEFAULT_SEARCHER_EXECUTOR,
      flashAmount: 100n,
    }));
  assert.throws(
    () => assertFundingTransfersFromReceipt({
      logs: [
        log(holderTopic, executorTopic, 100n),
        log(executorTopic, holderTopic, 99n),
      ],
    }, {
      token: TOKEN_A,
      holder,
      executor: DEFAULT_SEARCHER_EXECUTOR,
      flashAmount: 100n,
    }),
    /does not prove declared funding/,
  );
  assert.throws(
    () => assertFundingTransfersFromReceipt({
      logs: [log(executorTopic, holderTopic, 101n)],
    }, {
      token: TOKEN_A,
      holder,
      executor: DEFAULT_SEARCHER_EXECUTOR,
      flashAmount: 100n,
    }),
    /does not prove declared funding/,
  );
});

function frozenResult(
  routeSha256: string,
): NonNullable<HuntSolve["frozenResult"]> {
  const resolvedPlan = ethers.getBytes("0x12345678");
  const rawCalldata = ethers.concat([
    "0x09c5eabe",
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes"], [resolvedPlan]),
  ]);
  const calldataA = IFACE_A.encodeFunctionData(
    "swapA",
    [TOKEN_A, TOKEN_B, 10n],
  );
  const calldataB = IFACE_B.encodeFunctionData(
    "swapB",
    [TOKEN_B, TOKEN_A, 9n],
  );
  const core = {
    schemaVersion: 2 as const,
    executor: DEFAULT_SEARCHER_EXECUTOR.toLowerCase(),
    routeSha256,
    flashAmount: "1000",
    quotedNetProfit: "10",
    profitToken: TOKEN_A,
    rawCalldata,
    calldataSha256: createHash("sha256")
      .update(rawCalldata)
      .digest("hex"),
    resolvedPlanSha256: resolvedPlanScriptSha256(rawCalldata),
    fundingActionId: "balancer-flash",
    executionSurfaces: [
      {
        adapterId: route[0].adapterId,
        familyId: "swap:test",
        rootActionAdapterId: route[0].adapterId,
        target: TARGET_A,
        selector: SELECTOR_A,
        calldataSha256:
          createHash("sha256").update(calldataA).digest("hex"),
        subtreeActionAdapterIds: [route[0].adapterId],
        actionCalls: [{
          actionAdapterId: route[0].adapterId,
          target: TARGET_A,
          selector: SELECTOR_A,
          calldataSha256:
            createHash("sha256").update(calldataA).digest("hex"),
        }],
      },
      {
        adapterId: route[1].adapterId,
        familyId: "swap:test",
        rootActionAdapterId: route[1].adapterId,
        target: TARGET_B,
        selector: SELECTOR_B,
        calldataSha256:
          createHash("sha256").update(calldataB).digest("hex"),
        subtreeActionAdapterIds: [route[1].adapterId],
        actionCalls: [{
          actionAdapterId: route[1].adapterId,
          target: TARGET_B,
          selector: SELECTOR_B,
          calldataSha256:
            createHash("sha256").update(calldataB).digest("hex"),
        }],
      },
    ],
    supportActionAdapterIds: [],
    supportExecutionCalls: [],
    leavesStandingPosition: false,
    requiredFamilyIds: ["swap:test"],
    shardCompleteness: {
      schemaVersion: 1 as const,
      selection: "selected" as const,
      dexShard: {
        shardId: "dex",
        sourceKind: "dex-universe" as const,
        status: "complete" as const,
        required: true,
        edgeCount: 2,
        sha256: "0".repeat(64),
        issues: [],
      },
      familyShards: [],
      requiredFamilyIds: ["swap:test"],
      requiredComplete: true,
      isolatedIncompleteFamilyIds: [],
      cacheReuse: {
        status: "not_measured" as const,
        claimedHit: false as const,
      },
    },
  };
  return {
    ...core,
    bindingSha256: semanticJsonSha256(
      core as unknown as SemanticJson,
    ),
  };
}

function trustedReference(): TrustedReferenceRoute {
  return {
    schemaVersion: 2,
    artifact: "trusted-production-reference-route",
    sampleTxHash: TX,
    targetInputSha256: "4".repeat(64),
    stateAnchor: {
      opportunityBlock: 101,
      baseBlock: 100,
      baseBlockHash: HASH,
      baseStateRoot: ROOT,
    },
    route,
    routeSha256: semanticJsonSha256(
      route as unknown as SemanticJson,
    ),
    routeWitnesses: [
      {
        seq: 1,
        edgeAdapterId: route[0].adapterId,
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_B,
        referenceWitness: {
          calls: [{
            id: "root",
            target: "execution-target",
            signature: SIG_A,
            args: [
              { index: 0, op: "eq", ref: "token-in" },
              { index: 1, op: "eq", ref: "token-out" },
              { index: 2, op: "positive" },
            ],
            value: null,
          }],
          receiptTransfers: [],
        },
      },
      {
        seq: 2,
        edgeAdapterId: route[1].adapterId,
        tokenIn: TOKEN_B,
        tokenOut: TOKEN_A,
        referenceWitness: {
          calls: [{
            id: "root",
            target: "execution-target",
            signature: SIG_B,
            args: [
              { index: 0, op: "eq", ref: "token-in" },
              { index: 1, op: "eq", ref: "token-out" },
              { index: 2, op: "positive" },
            ],
            value: null,
          }],
          receiptTransfers: [],
        },
      },
    ],
  };
}

function ownershipManifest(): FamilyOwnershipManifest {
  const families: FamilyOwnershipManifestEntry[] = [
    ownershipFamily({
      id: "flash:balancer",
      kind: "flash-loan",
      owned: ["balancer-flash"],
      required: ["assert-balance", "erc20-transfer"],
    }),
    ownershipFamily({
      id: "swap:test",
      kind: "swap",
      edges: ["test-a", "test-b"],
      owned: ["test-a", "test-b"],
      required: ["erc20-transfer"],
    }),
    ownershipFamily({
      id: "swap:foreign",
      kind: "swap",
      edges: ["foreign-edge"],
      owned: ["foreign-action"],
    }),
  ];
  return {
    schema_version: 1,
    registry_order: families.map((family) => family.id),
    action_catalog_ids: [
      "assert-balance",
      "balancer-flash",
      "erc20-transfer",
      "foreign-action",
      "test-a",
      "test-b",
    ],
    registry_skeleton_sha256: "0".repeat(64),
    action_index_skeleton_sha256: "0".repeat(64),
    families,
  };
}

function ownershipFamily(input: {
  id: string;
  kind: string;
  edges?: string[];
  owned: string[];
  required?: string[];
}): FamilyOwnershipManifestEntry {
  return {
    id: input.id,
    kind: input.kind,
    root_source: `src/searcher/venues/${input.id}.ts`,
    root_export: input.id,
    source_files: [`src/searcher/venues/${input.id}.ts`],
    pool_adapter_ids: [],
    edge_adapter_ids: input.edges ?? [],
    owned_action_adapter_ids: input.owned,
    owned_action_bindings: input.owned.map((id) => ({
      id,
      binding: id,
    })),
    required_action_adapter_ids: input.required ?? [],
    required_action_bindings: (input.required ?? []).map((id) => ({
      id,
      binding: id,
    })),
    candidate_source_ids: [],
    requires_current_head_execution_evidence: false,
    activation_sha256: "0".repeat(64),
  };
}
