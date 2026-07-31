import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { ethers } from "ethers";
import {
  semanticJsonSha256,
  type SemanticJson,
} from "../../shared/evidence/semantic-six-step.js";
import {
  assertRouteReferenceWitnesses,
  assertSplitRouteIdentityPhasesMatch,
  assertTrustedReference,
  type HuntEdge,
  type SplitRouteReferenceWitnessLeg,
  type TrustedReferenceRoute,
} from "./production-replay.js";
import type {
  ResolvedActionExecutionSurface,
  ResolvedRouteExecutionSurface,
} from "./route-execution-witness.js";

const ZERO = ethers.ZeroAddress.toLowerCase();
const GRAPH_NATIVE =
  "0x1111111111111111111111111111111111111111";
const TOKEN =
  "0x2222222222222222222222222222222222222222";
const OTHER_TOKEN =
  "0x2323232323232323232323232323232323232323";
const ROUTER =
  "0x3333333333333333333333333333333333333333";
const HOOK =
  "0x3434343434343434343434343434343434343434";
const RETURN_POOL =
  "0x4444444444444444444444444444444444444444";
const EXECUTOR =
  "0x5555555555555555555555555555555555555555";
const CONFIG = `0x${"66".repeat(32)}`;
const CHANGED_CONFIG = `0x${"77".repeat(32)}`;
const TX = `0x${"88".repeat(32)}`;
const BLOCK_HASH = `0x${"99".repeat(32)}`;
const STATE_ROOT = `0x${"aa".repeat(32)}`;

const PARTIAL_SIGNATURE =
  "swapPartial((address,address,bytes32),bool,uint256)";
const STRICT_SIGNATURE =
  "swapStrict((address,address,bytes32),bool,uint256,uint256)";
const RETURN_SIGNATURE = "swapBack(address,address,uint256)";
const UNWRAP_SIGNATURE = "withdraw(uint256)";
const HELPER_SIGNATURE =
  "swapHelper(address,address,uint256,uint256,address,bytes)";
const partial = new ethers.Interface([`function ${PARTIAL_SIGNATURE}`]);
const strict = new ethers.Interface([`function ${STRICT_SIGNATURE}`]);
const returns = new ethers.Interface([`function ${RETURN_SIGNATURE}`]);
const unwrap = new ethers.Interface([`function ${UNWRAP_SIGNATURE}`]);
const helper = new ethers.Interface([`function ${HELPER_SIGNATURE}`]);
const POOL_KEY_TYPES = ["address", "address", "bytes32"] as const;

const poolId = (config = CONFIG): string =>
  ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "bytes32"],
      [ZERO, TOKEN, config],
    ),
  ).toLowerCase();

const firstEdge: HuntEdge = {
  adapterId: "custom-swap-a",
  target: ROUTER,
  tokenIn: GRAPH_NATIVE,
  tokenOut: TOKEN,
  slotKind: "swap",
  edgeKind: "swap",
  leavesStandingPosition: false,
  poolId: poolId(),
};
const secondEdge: HuntEdge = {
  adapterId: "custom-swap-b",
  target: RETURN_POOL,
  tokenIn: TOKEN,
  tokenOut: GRAPH_NATIVE,
  slotKind: "swap",
  edgeKind: "swap",
  leavesStandingPosition: false,
};

function field<T extends "address" | "bool" | "bytes32">(
  callId: string,
  path: readonly number[],
  type: T,
): {
  readonly op: "call-field";
  readonly callId: string;
  readonly path: readonly number[];
  readonly type: T;
} {
  return { op: "call-field", callId, path, type };
}

function decodedField<T extends "address" | "bytes32">(
  callId: string,
  path: readonly number[],
  index: number,
  type: T,
): {
  readonly op: "abi-decode-bytes-field";
  readonly callId: string;
  readonly path: readonly number[];
  readonly types: typeof POOL_KEY_TYPES;
  readonly index: number;
  readonly type: T;
} {
  return {
    op: "abi-decode-bytes-field",
    callId,
    path,
    types: POOL_KEY_TYPES,
    index,
    type,
  };
}

function identityWitness(
  callId: string,
): SplitRouteReferenceWitnessLeg["targetWitness"]["routeIdentity"] {
  return {
    schemaVersion: 1,
    token0: field(callId, [0, 0], "address"),
    token1: field(callId, [0, 1], "address"),
    direction: {
      value: field(callId, [1], "bool"),
      trueMeans: "token1-to-token0",
    },
    poolId: {
      op: "keccak256-abi",
      types: ["address", "address", "bytes32"],
      values: [
        field(callId, [0, 0], "address"),
        field(callId, [0, 1], "address"),
        field(callId, [0, 2], "bytes32"),
      ],
    },
    addressAliases: [{ raw: ZERO, graph: GRAPH_NATIVE }],
  };
}

function orderedIdentityWitness(
  callId: string,
): SplitRouteReferenceWitnessLeg["targetWitness"]["routeIdentity"] {
  return {
    schemaVersion: 1,
    token0: decodedField(callId, [5], 0, "address"),
    token1: decodedField(callId, [5], 1, "address"),
    direction: {
      mode: "ordered-token-pair",
      tokenIn: field(callId, [0], "address"),
      tokenOut: field(callId, [1], "address"),
    },
    poolId: {
      op: "keccak256-abi",
      types: POOL_KEY_TYPES,
      values: [
        decodedField(callId, [5], 0, "address"),
        decodedField(callId, [5], 1, "address"),
        decodedField(callId, [5], 2, "bytes32"),
      ],
    },
    addressAliases: [{ raw: ZERO, graph: GRAPH_NATIVE }],
  };
}

function splitLeg(): SplitRouteReferenceWitnessLeg {
  return {
    seq: 1,
    edgeAdapterId: firstEdge.adapterId,
    tokenIn: firstEdge.tokenIn,
    tokenOut: firstEdge.tokenOut,
    poolId: firstEdge.poolId,
    targetWitness: {
      executionTarget: ROUTER,
      witness: {
        calls: [{
          id: "root",
          target: "execution-target",
          signature: PARTIAL_SIGNATURE,
          args: [{ index: 2, op: "positive" }],
          value: "positive",
        }],
        receiptTransfers: [],
      },
      routeIdentity: identityWitness("root"),
    },
    executionWitness: {
      witness: {
        rootCallId: "swap-root",
        calls: [
          {
            id: "unwrap",
            target: "token-in",
            signature: UNWRAP_SIGNATURE,
            args: [{ index: 0, op: "positive" }],
            value: null,
          },
          {
            id: "swap-root",
            target: "execution-target",
            signature: STRICT_SIGNATURE,
            args: [
              { index: 2, op: "positive" },
              { index: 3, op: "positive" },
            ],
            value: "positive",
          },
        ],
        receiptTransfers: [],
      },
      routeIdentity: identityWitness("swap-root"),
    },
  };
}

function orderedTargetSplitLeg(): SplitRouteReferenceWitnessLeg {
  const leg = splitLeg();
  return {
    ...leg,
    targetWitness: {
      executionTarget: ROUTER,
      witness: {
        calls: [{
          id: "root",
          target: "execution-target",
          signature: HELPER_SIGNATURE,
          args: [
            { index: 2, op: "positive" },
            { index: 3, op: "positive" },
          ],
          value: "positive",
        }],
        receiptTransfers: [],
      },
      routeIdentity: orderedIdentityWitness("root"),
    },
  };
}

function legacyReturnLeg() {
  return {
    seq: 2,
    edgeAdapterId: secondEdge.adapterId,
    tokenIn: secondEdge.tokenIn,
    tokenOut: secondEdge.tokenOut,
    referenceWitness: {
      calls: [{
        id: "root",
        target: "execution-target",
        signature: RETURN_SIGNATURE,
        args: [
          { index: 0, op: "eq", ref: "token-in" },
          { index: 1, op: "eq", ref: "token-out" },
          { index: 2, op: "positive" },
        ],
        value: null,
      }],
      receiptTransfers: [],
    },
  } as const;
}

function reference(
  leg: SplitRouteReferenceWitnessLeg = splitLeg(),
): TrustedReferenceRoute {
  const route = [firstEdge, secondEdge];
  return {
    schemaVersion: 3,
    artifact: "trusted-production-reference-route",
    sampleTxHash: TX,
    targetInputSha256: "bb".repeat(32),
    stateAnchor: {
      opportunityBlock: 101,
      baseBlock: 100,
      baseBlockHash: BLOCK_HASH,
      baseStateRoot: STATE_ROOT,
    },
    route,
    routeSha256: semanticJsonSha256(
      route as unknown as SemanticJson,
    ),
    routeWitnesses: [leg, legacyReturnLeg()],
  };
}

function targetCalldata(config = CONFIG, isToken1 = false): string {
  return partial.encodeFunctionData("swapPartial", [
    [ZERO, TOKEN, config],
    isToken1,
    10n,
  ]).toLowerCase();
}

function helperCalldata(
  tokenIn = ZERO,
  tokenOut = TOKEN,
  token0 = ZERO,
  token1 = TOKEN,
  config = CONFIG,
  encodedPoolKey = ethers.AbiCoder.defaultAbiCoder().encode(
    POOL_KEY_TYPES,
    [token0, token1, config],
  ),
): string {
  return helper.encodeFunctionData("swapHelper", [
    tokenIn,
    tokenOut,
    10n,
    9n,
    HOOK,
    encodedPoolKey,
  ]).toLowerCase();
}

function strictCalldata(
  config = CONFIG,
  isToken1 = false,
  token0 = ZERO,
  token1 = TOKEN,
): string {
  return strict.encodeFunctionData("swapStrict", [
    [token0, token1, config],
    isToken1,
    10n,
    9n,
  ]).toLowerCase();
}

const unwrapCalldata = unwrap.encodeFunctionData(
  "withdraw",
  [10n],
).toLowerCase();
const returnCalldata = returns.encodeFunctionData(
  "swapBack",
  [TOKEN, GRAPH_NATIVE, 9n],
).toLowerCase();

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function surfaces(
  strictInput = strictCalldata(),
): readonly ResolvedRouteExecutionSurface[] {
  return [
    {
      adapterId: firstEdge.adapterId,
      familyId: "custom-swap:test-a",
      rootActionAdapterId: firstEdge.adapterId,
      target: ROUTER,
      selector: strictInput.slice(0, 10),
      calldataSha256: sha256(strictInput),
      subtreeActionAdapterIds: [firstEdge.adapterId],
      actionCalls: [{
        actionAdapterId: firstEdge.adapterId,
        target: ROUTER,
        selector: strictInput.slice(0, 10),
        calldataSha256: sha256(strictInput),
      }],
    },
    {
      adapterId: secondEdge.adapterId,
      familyId: "custom-swap:test-b",
      rootActionAdapterId: secondEdge.adapterId,
      target: RETURN_POOL,
      selector: returnCalldata.slice(0, 10),
      calldataSha256: sha256(returnCalldata),
      subtreeActionAdapterIds: [secondEdge.adapterId],
      actionCalls: [{
        actionAdapterId: secondEdge.adapterId,
        target: RETURN_POOL,
        selector: returnCalldata.slice(0, 10),
        calldataSha256: sha256(returnCalldata),
      }],
    },
  ];
}

const supportCalls: readonly ResolvedActionExecutionSurface[] = [{
  actionAdapterId: "wrapped-native-withdraw",
  target: GRAPH_NATIVE,
  selector: unwrapCalldata.slice(0, 10),
  calldataSha256: sha256(unwrapCalldata),
}];

function trace(calls: readonly unknown[]): unknown {
  return {
    to: EXECUTOR,
    input: "0x12345678",
    calls,
  };
}

test("schema v3 separately proves partial target and strict execution identity", () => {
  const trusted = reference();
  assert.doesNotThrow(() => assertTrustedReference(trusted, TX));
  const targetIdentities = assertRouteReferenceWitnesses({
    trace: trace([
      { to: ROUTER, input: targetCalldata(), value: "0x1" },
      { to: RETURN_POOL, input: returnCalldata },
    ]),
    receipt: { logs: [] },
    reference: trusted,
    executionSurfaces: surfaces(),
    supportExecutionCalls: supportCalls,
    label: "target",
    requireResolvedCallBytes: false,
  });
  const executionIdentities = assertRouteReferenceWitnesses({
    trace: trace([
      { to: GRAPH_NATIVE, input: unwrapCalldata },
      { to: ROUTER, input: strictCalldata(), value: "0x1" },
      { to: RETURN_POOL, input: returnCalldata },
    ]),
    receipt: { logs: [] },
    reference: trusted,
    executionSurfaces: surfaces(),
    supportExecutionCalls: supportCalls,
    label: "execution",
    requireResolvedCallBytes: true,
  });
  assert.doesNotThrow(() =>
    assertSplitRouteIdentityPhasesMatch(
      targetIdentities,
      executionIdentities,
      trusted.route,
    ));
});

test("ordered target pair and bool execution prove the same identity", () => {
  const trusted = reference(orderedTargetSplitLeg());
  assert.doesNotThrow(() => assertTrustedReference(trusted, TX));
  const targetIdentities = assertRouteReferenceWitnesses({
    trace: trace([
      { to: ROUTER, input: helperCalldata(), value: "0x1" },
      { to: RETURN_POOL, input: returnCalldata },
    ]),
    receipt: { logs: [] },
    reference: trusted,
    executionSurfaces: surfaces(),
    supportExecutionCalls: supportCalls,
    label: "ordered target",
    requireResolvedCallBytes: false,
  });
  const executionIdentities = assertRouteReferenceWitnesses({
    trace: trace([
      { to: GRAPH_NATIVE, input: unwrapCalldata },
      { to: ROUTER, input: strictCalldata(), value: "0x1" },
      { to: RETURN_POOL, input: returnCalldata },
    ]),
    receipt: { logs: [] },
    reference: trusted,
    executionSurfaces: surfaces(),
    supportExecutionCalls: supportCalls,
    label: "bool execution",
    requireResolvedCallBytes: true,
  });
  assert.doesNotThrow(() =>
    assertSplitRouteIdentityPhasesMatch(
      targetIdentities,
      executionIdentities,
      trusted.route,
    ));
});

test("ordered target pair rejects reversal and a third token", () => {
  const trusted = reference(orderedTargetSplitLeg());
  for (const input of [
    helperCalldata(TOKEN, ZERO),
    helperCalldata(ZERO, OTHER_TOKEN),
  ]) {
    assert.throws(
      () => assertRouteReferenceWitnesses({
        trace: trace([
          { to: ROUTER, input, value: "0x1" },
          { to: RETURN_POOL, input: returnCalldata },
        ]),
        receipt: { logs: [] },
        reference: trusted,
        executionSurfaces: surfaces(),
        supportExecutionCalls: supportCalls,
        label: "ordered target",
        requireResolvedCallBytes: false,
      }),
      /does not bind both tokens|ordered token pair does not match|canonical route identity differs/,
    );
  }
});

test("ABI-decoded PoolKey bytes fail on length and config tampering", () => {
  const trusted = reference(orderedTargetSplitLeg());
  for (const [input, expected] of [
    [
      helperCalldata(
        ZERO,
        TOKEN,
        ZERO,
        TOKEN,
        CONFIG,
        "0x1234",
      ),
      /exact static tuple length/,
    ],
    [
      helperCalldata(ZERO, TOKEN, ZERO, TOKEN, CHANGED_CONFIG),
      /canonical route identity differs from the frozen edge/,
    ],
  ] as const) {
    assert.throws(
      () => assertRouteReferenceWitnesses({
        trace: trace([
          { to: ROUTER, input, value: "0x1" },
          { to: RETURN_POOL, input: returnCalldata },
        ]),
        receipt: { logs: [] },
        reference: trusted,
        executionSurfaces: surfaces(),
        supportExecutionCalls: supportCalls,
        label: "ordered target",
        requireResolvedCallBytes: false,
      }),
      expected,
    );
  }
});

test("ABI bytes declarations reject wrong type, index, and call source", () => {
  for (const [mutate, expected] of [
    [
      (fieldValue: Record<string, unknown>) => {
        fieldValue.type = "bytes32";
      },
      /type must match types\[index\] and address/,
    ],
    [
      (fieldValue: Record<string, unknown>) => {
        fieldValue.index = 3;
      },
      /index is outside decoded fields/,
    ],
    [
      (fieldValue: Record<string, unknown>) => {
        fieldValue.callId = "candidate-self-reported";
      },
      /identity references undeclared call candidate-self-reported/,
    ],
  ] as const) {
    const trusted = structuredClone(
      reference(orderedTargetSplitLeg()),
    ) as TrustedReferenceRoute;
    const leg =
      trusted.routeWitnesses[0] as SplitRouteReferenceWitnessLeg;
    mutate(
      leg.targetWitness.routeIdentity.token0 as unknown as
        Record<string, unknown>,
    );
    assert.throws(
      () => assertTrustedReference(trusted, TX),
      expected,
    );
  }
});

test("partial target calldata cannot satisfy the strict execution witness", () => {
  const trusted = reference();
  assert.throws(
    () => assertRouteReferenceWitnesses({
      trace: trace([
        { to: GRAPH_NATIVE, input: unwrapCalldata },
        { to: ROUTER, input: targetCalldata(), value: "0x1" },
        { to: RETURN_POOL, input: returnCalldata },
      ]),
      receipt: { logs: [] },
      reference: trusted,
      executionSurfaces: surfaces(),
      supportExecutionCalls: supportCalls,
      label: "execution",
      requireResolvedCallBytes: true,
    }),
    /witness swap-root failed/,
  );
});

test("PoolKey config tampering changes derived poolId and fails closed", () => {
  const trusted = reference();
  assert.throws(
    () => assertRouteReferenceWitnesses({
      trace: trace([
        {
          to: ROUTER,
          input: targetCalldata(CHANGED_CONFIG),
          value: "0x1",
        },
        { to: RETURN_POOL, input: returnCalldata },
      ]),
      receipt: { logs: [] },
      reference: trusted,
      executionSurfaces: surfaces(),
      supportExecutionCalls: supportCalls,
      label: "target",
      requireResolvedCallBytes: false,
    }),
    /canonical route identity differs from the frozen edge/,
  );
});

test("target/execution token or direction disagreement fails closed", () => {
  const trusted = reference();
  for (const strictInput of [
    strictCalldata(CONFIG, true),
    strictCalldata(CONFIG, false, ZERO, OTHER_TOKEN),
  ]) {
    assert.throws(
      () => assertRouteReferenceWitnesses({
        trace: trace([
          { to: GRAPH_NATIVE, input: unwrapCalldata },
          { to: ROUTER, input: strictInput, value: "0x1" },
          { to: RETURN_POOL, input: returnCalldata },
        ]),
        receipt: { logs: [] },
        reference: trusted,
        executionSurfaces: surfaces(strictInput),
        supportExecutionCalls: supportCalls,
        label: "execution",
        requireResolvedCallBytes: true,
      }),
      /does not bind both tokens|canonical route identity differs from the frozen edge/,
    );
  }
});

test("same graph edge cannot hide a target/execution raw identity mismatch", () => {
  const targetIdentity = {
    schemaVersion: 1,
    rawToken0: ZERO,
    rawToken1: TOKEN,
    tokenIn: TOKEN,
    tokenOut: GRAPH_NATIVE,
    token1IsInput: true,
    poolId: null,
  } as const;
  const executionIdentity = {
    schemaVersion: 1,
    rawToken0: TOKEN,
    rawToken1: ZERO,
    tokenIn: TOKEN,
    tokenOut: GRAPH_NATIVE,
    token1IsInput: false,
    poolId: null,
  } as const;
  assert.throws(
    () => assertSplitRouteIdentityPhasesMatch(
      [targetIdentity],
      [executionIdentity],
      [secondEdge],
    ),
    /target and execution witnesses prove different route identities/,
  );
});

test("schema and field-path language stay bounded and trusted", () => {
  const trusted = reference();
  const bad = structuredClone(trusted) as TrustedReferenceRoute;
  const split = bad.routeWitnesses[0] as SplitRouteReferenceWitnessLeg;
  (split.targetWitness.routeIdentity.token0.path as number[]).push(
    0, 0, 0, 0, 0, 0, 0, 0,
  );
  assert.throws(
    () => assertTrustedReference(bad, TX),
    /path must contain 1..8 indexes/,
  );

  assert.throws(
    () => assertTrustedReference({
      ...trusted,
      schemaVersion: 2,
    }, TX),
    /split target\/execution witnesses require reference schemaVersion 3/,
  );

  const missingCall = structuredClone(trusted) as TrustedReferenceRoute;
  const missingSplit =
    missingCall.routeWitnesses[0] as SplitRouteReferenceWitnessLeg;
  (
    missingSplit.targetWitness.routeIdentity.token0 as {
      callId: string;
    }
  ).callId = "candidate-self-reported";
  assert.throws(
    () => assertTrustedReference(missingCall, TX),
    /identity references undeclared call candidate-self-reported/,
  );
});

test("split identity is rejected without a calldata-derived frozen poolId", () => {
  const trusted = structuredClone(reference()) as TrustedReferenceRoute;
  delete trusted.route[0].poolId;
  const leg = trusted.routeWitnesses[0] as unknown as {
    poolId?: string;
    targetWitness: { routeIdentity: { poolId?: unknown } };
    executionWitness: { routeIdentity: { poolId?: unknown } };
  };
  delete leg.poolId;
  delete leg.targetWitness.routeIdentity.poolId;
  delete leg.executionWitness.routeIdentity.poolId;
  trusted.routeSha256 = semanticJsonSha256(
    trusted.route as unknown as SemanticJson,
  );
  assert.throws(
    () => assertTrustedReference(trusted, TX),
    /split identity requires a calldata-derived frozen poolId/,
  );
});

test("schema v2 legacy references remain accepted", () => {
  const trusted = reference();
  const legacy: TrustedReferenceRoute = {
    ...trusted,
    schemaVersion: 2,
    routeWitnesses: [
      {
        seq: 1,
        edgeAdapterId: firstEdge.adapterId,
        tokenIn: firstEdge.tokenIn,
        tokenOut: firstEdge.tokenOut,
        poolId: firstEdge.poolId,
        referenceWitness: {
          calls: [{
            id: "root",
            target: "execution-target",
            signature:
              "swapStrictLegacy((address,address,bytes32),bool,uint256,uint256,bytes32)",
            args: [
              { index: 2, op: "positive" },
              { index: 4, op: "eq", ref: "pool-id" },
            ],
            value: "positive",
          }],
          receiptTransfers: [],
        },
      },
      legacyReturnLeg(),
    ],
  };
  assert.doesNotThrow(() => assertTrustedReference(legacy, TX));
});
