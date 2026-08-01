import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { discoverErc20BalanceStorageSlot } from "../../protocol-discovery-erc20-state.js";
import type { TokenEdge } from "../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { OnchainIdentityResolver } from "../identity.js";
import {
  poolAdapterId,
  venueId,
  venueIdentitySource,
} from "../registry-ids.js";
import type {
  AttestedProtocolInstance,
  ProtocolCandidate,
  ProtocolDiscoveryCapability,
  ProtocolDiscoveryContext,
  ProtocolDiscoveryLog,
  ProtocolDiscoverySimulatedCallResult,
} from "../route-leg-adapter.js";

const iface = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function withdraw(uint256 amount)",
]);

export const ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER =
  poolAdapterId("ethertoken-native-redeem-token");
export const ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER =
  "ethertoken-native-redeem" as const;
export const ETHERTOKEN_NATIVE_REDEEM_VENUE =
  venueId("behavior:ethertoken-native-redeem");
export const ETHERTOKEN_NATIVE_REDEEM_IDENTITY_SOURCE =
  venueIdentitySource("active-ethertoken-native-redeem-simulation");
export const ETHERTOKEN_WITHDRAW_SELECTOR =
  iface.getFunction("withdraw")!.selector.toLowerCase();

/**
 * EtherToken-compatible withdrawals emit a family-specific Destruction event.
 * It is candidate provenance for bounded historical backfill; admission still
 * requires the ERC20 surface and an active state-override delta proof.
 */
export const ETHERTOKEN_DESTRUCTION_EVENT_TOPIC =
  "0x9a1b418bc061a5d80270261562e6986a35d995f8051145f277be16103abd3453";

const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const SYNTHETIC_NATIVE_TRANSFER_EMITTER =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const FALLBACK_PROBE_CALLER = ethers.getAddress(`0x${"00".repeat(18)}e7e2`);

export interface EtherTokenNativeRedeemObservation {
  readonly kind: "ethertoken-native-redeem-observation";
  readonly txHash: string;
  readonly blockNumber: number;
  readonly token: string;
  readonly caller: string;
  readonly amountIn: bigint;
  readonly nativeOut: bigint;
}

export const etherTokenNativeRedeemDiscovery = Object.freeze({
  candidateSources: Object.freeze(["observed-interaction"] as const),
  eventTopics: Object.freeze([ETHERTOKEN_DESTRUCTION_EVENT_TOPIC]),
  callSelectors: Object.freeze([ETHERTOKEN_WITHDRAW_SELECTOR]),
  observedMatcherVersion: "ethertoken-native-redeem-observed-v1",

  async candidateFromObservedCall(call) {
    return candidateFromObservedWithdrawal(call);
  },

  async probeCandidate(instance, context) {
    return probeEtherTokenNativeRedeemCandidate(instance, context);
  },
} satisfies ProtocolDiscoveryCapability);

export const etherTokenNativeRedeemIdentityResolver:
  OnchainIdentityResolver = async ({
    backend,
    pool,
    poolAdapter,
    candidate,
  }) => {
    if (
      poolAdapter !== ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER ||
      pool.toLowerCase() !== candidate.fixedTokenIn?.toLowerCase() ||
      candidate.fixedTokenOut?.toLowerCase() !== ADDR.WETH.toLowerCase() ||
      candidate.logicalInstanceId !== etherTokenNativeRedeemInstanceId(pool) ||
      !backend.getCode
    ) {
      return { ok: false, reason: "behavior_mismatch" };
    }
    try {
      const code = await backend.getCode(pool);
      if (code === "0x") return { ok: false, reason: "behavior_mismatch" };
      const [balance, supply, decimals] = await Promise.all([
        backend.call({
          to: pool,
          data: iface.encodeFunctionData("balanceOf", [pool]),
        }),
        backend.call({
          to: pool,
          data: iface.encodeFunctionData("totalSupply"),
        }),
        backend.call({
          to: pool,
          data: iface.encodeFunctionData("decimals"),
        }),
      ]);
      iface.decodeFunctionResult("balanceOf", balance);
      iface.decodeFunctionResult("totalSupply", supply);
      const decodedDecimals = Number(
        iface.decodeFunctionResult("decimals", decimals)[0],
      );
      if (
        !Number.isSafeInteger(decodedDecimals) ||
        decodedDecimals < 0 ||
        decodedDecimals > 36
      ) {
        return { ok: false, reason: "behavior_mismatch" };
      }
      return {
        ok: true,
        adapter: ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER,
        venueId: ETHERTOKEN_NATIVE_REDEEM_VENUE,
        identitySource: ETHERTOKEN_NATIVE_REDEEM_IDENTITY_SOURCE,
      };
    } catch (error) {
      return {
        ok: false,
        reason: isPermanentBehaviorFailure(error)
          ? "behavior_mismatch"
          : "identity_call_failed",
      };
    }
  };

export async function probeEtherTokenNativeRedeemCandidate(
  instance: AttestedProtocolInstance,
  context: ProtocolDiscoveryContext,
): Promise<readonly TokenEdge[]> {
  const token = ethers.getAddress(instance.pool.address);
  if (
    instance.pool.adapter !== ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER ||
    instance.pool.fixedTokenIn?.toLowerCase() !== token.toLowerCase() ||
    instance.pool.fixedTokenOut?.toLowerCase() !== ADDR.WETH.toLowerCase() ||
    instance.pool.logicalInstanceId !== etherTokenNativeRedeemInstanceId(token)
  ) {
    throw new Error("ethertoken-native-redeem candidate shape drifted");
  }
  if (
    !context.graphTokens.some(
      (item) => item.toLowerCase() === ADDR.WETH.toLowerCase(),
    )
  ) {
    throw new Error(
      "ethertoken-native-redeem candidate lacks the canonical WETH anchor",
    );
  }
  const observations = instance.evidence
    .filter(isEtherTokenNativeRedeemObservation)
    .filter((item) => item.token.toLowerCase() === token.toLowerCase())
    .sort((a, b) =>
      a.amountIn < b.amountIn ? -1 : a.amountIn > b.amountIn ? 1 : 0
    );
  if (observations.length === 0) {
    throw new Error("ethertoken-native-redeem candidate lacks observed amount");
  }
  const caller = ethers.getAddress(
    context.probeExecutor ?? FALLBACK_PROBE_CALLER,
  );
  const code = await context.backend.getCode(token);
  if (code === "0x") {
    throw new Error("ethertoken-native-redeem token has no code");
  }
  const probeAmounts = [
    ...new Set(observations.map((item) => item.amountIn)),
  ].slice(0, 4);
  const slot = await discoverErc20BalanceStorageSlot({
    context,
    token,
    holder: caller,
    codeHash: ethers.keccak256(code),
    probeValue: probeAmounts[0],
  });
  if (slot === null) {
    throw new Error(
      "ethertoken-native-redeem balance storage could not be proven",
    );
  }
  for (const amountIn of probeAmounts) {
    const facts = await simulateEtherTokenNativeRedeem({
      context,
      token,
      caller,
      amountIn,
      balanceSlot: slot,
    });
    if (
      facts !== null &&
      facts.tokenInSpent === amountIn &&
      facts.totalSupplyBurned === amountIn &&
      facts.nativeOut === amountIn
    ) {
      return Object.freeze([{
        adapterId: ETHERTOKEN_NATIVE_REDEEM_EDGE_ADAPTER,
        target: token,
        tokenIn: token,
        tokenOut: ADDR.WETH,
        slotKind: "protocol",
        protocolAction: "redeem",
        score: instance.pool.score,
        ...deriveEdgeTaxonomy("protocol", "redeem"),
      }]);
    }
  }
  throw new Error("ethertoken-native-redeem active behavior proof failed");
}

export async function simulateEtherTokenNativeRedeem(input: {
  readonly context: ProtocolDiscoveryContext;
  readonly token: string;
  readonly caller: string;
  readonly amountIn: bigint;
  readonly balanceSlot: string;
}): Promise<{
  readonly tokenInSpent: bigint;
  readonly totalSupplyBurned: bigint;
  readonly nativeOut: bigint;
} | null> {
  const simulate = input.context.backend.simulateCalls?.bind(
    input.context.backend,
  );
  if (!simulate || input.amountIn <= 0n) return null;
  const balanceData = iface.encodeFunctionData("balanceOf", [input.caller]);
  const supplyData = iface.encodeFunctionData("totalSupply");
  const calls = await simulate({
    calls: [
      { from: input.caller, to: input.token, data: balanceData },
      { from: input.caller, to: input.token, data: supplyData },
      {
        from: input.caller,
        to: input.token,
        data: iface.encodeFunctionData("withdraw", [input.amountIn]),
      },
      { from: input.caller, to: input.token, data: balanceData },
      { from: input.caller, to: input.token, data: supplyData },
    ],
    stateOverrides: {
      [input.token]: {
        stateDiff: {
          [input.balanceSlot]: ethers.toBeHex(input.amountIn, 32),
        },
      },
    },
  });
  if (calls.length !== 5 || calls.some((call) => call.status !== 1)) {
    return null;
  }
  const balanceBefore = decodeUint(calls[0]);
  const supplyBefore = decodeUint(calls[1]);
  const balanceAfter = decodeUint(calls[3]);
  const supplyAfter = decodeUint(calls[4]);
  if (
    balanceBefore === null ||
    supplyBefore === null ||
    balanceAfter === null ||
    supplyAfter === null ||
    balanceAfter > balanceBefore ||
    supplyAfter > supplyBefore
  ) {
    return null;
  }
  return {
    tokenInSpent: balanceBefore - balanceAfter,
    totalSupplyBurned: supplyBefore - supplyAfter,
    nativeOut: nativeOutFromLogs(calls[2].logs, input.token, input.caller),
  };
}

function candidateFromObservedWithdrawal(call: {
  readonly target: string;
  readonly selector: string;
  readonly input: string;
  readonly from?: string;
  readonly txHash: string;
  readonly receipt: {
    readonly status: number | null;
    readonly logs: readonly ProtocolDiscoveryLog[];
  };
  readonly trace: unknown;
}): ProtocolCandidate | null {
  if (
    call.receipt.status !== 1 ||
    !call.from ||
    call.selector.toLowerCase() !== ETHERTOKEN_WITHDRAW_SELECTOR
  ) {
    return null;
  }
  let token: string;
  let caller: string;
  let amountIn: bigint;
  try {
    token = ethers.getAddress(call.target);
    caller = ethers.getAddress(call.from);
    const decoded = iface.decodeFunctionData("withdraw", call.input);
    amountIn = BigInt(decoded[0]);
  } catch {
    return null;
  }
  if (amountIn <= 0n) return null;

  const transfer = call.receipt.logs.find((log) =>
    log.address.toLowerCase() === token.toLowerCase() &&
    log.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
    topicAddress(log.topics[1]) === caller.toLowerCase() &&
    topicAddress(log.topics[2]) === token.toLowerCase() &&
    hexUintEquals(log.data, amountIn)
  );
  const destruction = call.receipt.logs.find((log) =>
    log.address.toLowerCase() === token.toLowerCase() &&
    log.topics[0]?.toLowerCase() === ETHERTOKEN_DESTRUCTION_EVENT_TOPIC &&
    hexUintEquals(log.data, amountIn)
  );
  const blockNumber = destruction?.blockNumber ?? transfer?.blockNumber;
  if (
    !transfer ||
    !destruction ||
    blockNumber === undefined ||
    !Number.isSafeInteger(blockNumber) ||
    blockNumber < 0
  ) {
    return null;
  }
  const nativeOut = causalNativePayout(
    call.trace,
    token,
    caller,
    call.input,
  );
  if (nativeOut !== amountIn) return null;

  const evidence: EtherTokenNativeRedeemObservation = {
    kind: "ethertoken-native-redeem-observation",
    txHash: call.txHash,
    blockNumber,
    token,
    caller,
    amountIn,
    nativeOut,
  };
  return {
    pool: {
      address: token,
      adapter: ETHERTOKEN_NATIVE_REDEEM_POOL_ADAPTER,
      fixedTokenIn: token,
      fixedTokenOut: ADDR.WETH,
      fixedSlotKind: "protocol",
      fixedProtocolAction: "redeem",
      logicalInstanceId: etherTokenNativeRedeemInstanceId(token),
    },
    source: "observed-calltrace",
    selector: call.selector,
    evidence: [evidence],
  };
}

export function etherTokenNativeRedeemInstanceId(token: string): string {
  return `ethertoken-native-redeem:${
    ethers.getAddress(token).toLowerCase()
  }`;
}

function isEtherTokenNativeRedeemObservation(
  value: unknown,
): value is EtherTokenNativeRedeemObservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<EtherTokenNativeRedeemObservation>;
  return item.kind === "ethertoken-native-redeem-observation" &&
    typeof item.token === "string" &&
    typeof item.caller === "string" &&
    typeof item.amountIn === "bigint" &&
    typeof item.nativeOut === "bigint";
}

function decodeUint(
  result: ProtocolDiscoverySimulatedCallResult,
): bigint | null {
  try {
    if (!ethers.isHexString(result.returnData)) return null;
    return BigInt(result.returnData);
  } catch {
    return null;
  }
}

function nativeOutFromLogs(
  logs: readonly ProtocolDiscoveryLog[],
  token: string,
  caller: string,
): bigint {
  let total = 0n;
  for (const log of logs) {
    if (
      log.address.toLowerCase() !== SYNTHETIC_NATIVE_TRANSFER_EMITTER ||
      log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
      topicAddress(log.topics[1]) !== token.toLowerCase() ||
      topicAddress(log.topics[2]) !== caller.toLowerCase()
    ) {
      continue;
    }
    try {
      total += BigInt(log.data);
    } catch {
      return 0n;
    }
  }
  return total;
}

function causalNativePayout(
  trace: unknown,
  token: string,
  caller: string,
  expectedInput: string,
): bigint {
  const root = asTraceNode(trace);
  if (!root) return 0n;
  let total = 0n;
  const visit = (node: TraceNode): void => {
    if (
      node.to?.toLowerCase() === token.toLowerCase() &&
      node.from?.toLowerCase() === caller.toLowerCase() &&
      node.input?.toLowerCase() === expectedInput.toLowerCase() &&
      !node.error
    ) {
      total += descendantNativeValue(node, token, caller);
    }
    for (const child of node.calls ?? []) visit(child);
  };
  visit(root);
  return total;
}

interface TraceNode {
  readonly from?: string;
  readonly to?: string;
  readonly input?: string;
  readonly value?: string;
  readonly error?: string;
  readonly calls?: readonly TraceNode[];
}

function asTraceNode(value: unknown): TraceNode | null {
  return value && typeof value === "object" ? value as TraceNode : null;
}

function descendantNativeValue(
  node: TraceNode,
  token: string,
  caller: string,
): bigint {
  let total = 0n;
  for (const child of node.calls ?? []) {
    if (
      !child.error &&
      child.from?.toLowerCase() === token.toLowerCase() &&
      child.to?.toLowerCase() === caller.toLowerCase()
    ) {
      try {
        total += BigInt(child.value ?? "0x0");
      } catch {
        return 0n;
      }
    }
    total += descendantNativeValue(child, token, caller);
  }
  return total;
}

function topicAddress(topic: string | undefined): string {
  if (!topic || !ethers.isHexString(topic, 32)) return "";
  return ethers.getAddress(`0x${topic.slice(-40)}`).toLowerCase();
}

function hexUintEquals(data: string, expected: bigint): boolean {
  try {
    return ethers.isHexString(data) && BigInt(data) === expected;
  } catch {
    return false;
  }
}

function isPermanentBehaviorFailure(error: unknown): boolean {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code).toUpperCase()
    : "";
  return new Set([
    "CALL_EXCEPTION",
    "BAD_DATA",
    "INVALID_ARGUMENT",
    "NUMERIC_FAULT",
  ]).has(code);
}
