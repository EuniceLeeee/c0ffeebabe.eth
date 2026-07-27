import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { TokenEdge } from "../../planner/token-graph.js";
import { discoverErc20BalanceStorageSlot } from "../../protocol-discovery-erc20-state.js";
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

const erc20 = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);

export const SELF_BURN_NATIVE_POOL_ADAPTER =
  poolAdapterId("self-burn-native-token");
export const SELF_BURN_NATIVE_EDGE_ADAPTER =
  "self-burn-native-redeem" as const;
export const SELF_BURN_NATIVE_VENUE =
  venueId("behavior:self-burn-native");
export const SELF_BURN_NATIVE_IDENTITY_SOURCE =
  venueIdentitySource("active-self-burn-native-simulation");
export const SELF_BURN_NATIVE_TRANSFER_SELECTOR =
  erc20.getFunction("transfer")!.selector.toLowerCase();

/**
 * Cheap receipt shortlist shared by compatible implementations. This topic is
 * candidate provenance only; a matching log never admits an instance.
 */
export const SELF_BURN_NATIVE_EVENT_TOPIC =
  "0x5dd085b6070b4cae004f84daafd199fd55b0bdfa11c3a802baffe89c2419d8c2";
export const SYNTHETIC_NATIVE_TRANSFER_EMITTER =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();
const FALLBACK_PROBE_CALLER = ethers.getAddress(
  `0x${"00".repeat(18)}b07a`,
);

export interface SelfBurnNativeObservation {
  readonly kind: "self-burn-native-observation";
  readonly txHash: string;
  readonly blockNumber: number;
  readonly token: string;
  readonly caller: string;
  readonly amountIn: bigint;
  readonly nativeOut: bigint;
}

export const selfBurnNativeDiscovery = Object.freeze({
  candidateSources: Object.freeze([
    "dex-token-domain",
    "observed-interaction",
  ] as const),
  eventTopics: Object.freeze([SELF_BURN_NATIVE_EVENT_TOPIC]),
  callSelectors: Object.freeze([SELF_BURN_NATIVE_TRANSFER_SELECTOR]),
  observedMatcherVersion: "self-burn-native-observed-v1",
  addressMatcherVersion: "self-burn-native-eip1967-shortlist-v1",
  addressMatcherCachePolicy: {
    kind: "current-block-dependency-fingerprint",
    invariant:
      "matcher-output-immutable-while-code-implementation-and-dependencies-match",
    version: "self-burn-native-address-dependencies-v1",
    async currentDependencyFingerprint(candidate) {
      return `${candidate.codeHash.toLowerCase()}:${candidate.implementationWord.toLowerCase()}`;
    },
  },

  async candidateFromAddress(candidate) {
    if (
      !ethers.isAddress(candidate.target) ||
      !ethers.isHexString(candidate.codeHash, 32) ||
      !ethers.isHexString(candidate.implementationWord, 32) ||
      candidate.implementationWord === ethers.ZeroHash
    ) return null;
    const token = ethers.getAddress(candidate.target);
    return {
      pool: {
        address: token,
        adapter: SELF_BURN_NATIVE_POOL_ADAPTER,
        fixedTokenIn: token,
        fixedTokenOut: ADDR.WETH,
        fixedSlotKind: "protocol",
        fixedProtocolAction: "redeem",
        logicalInstanceId: selfBurnNativeInstanceId(token),
      },
      source: "dex-token-domain:eip1967-proxy-shortlist",
      evidence: [],
    };
  },

  async candidateFromObservedCall(call) {
    return candidateFromObservedSelfBurn(call);
  },

  async probeCandidate(instance, context) {
    return probeSelfBurnNativeCandidate(instance, context);
  },
} satisfies ProtocolDiscoveryCapability);

export const selfBurnNativeIdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
  candidate,
}) => {
  if (
    poolAdapter !== SELF_BURN_NATIVE_POOL_ADAPTER ||
    pool.toLowerCase() !== candidate.fixedTokenIn?.toLowerCase() ||
    candidate.fixedTokenOut?.toLowerCase() !== ADDR.WETH.toLowerCase() ||
    candidate.logicalInstanceId !== selfBurnNativeInstanceId(pool) ||
    !backend.getCode
  ) {
    return { ok: false, reason: "behavior_mismatch" };
  }
  try {
    const code = await backend.getCode(pool);
    if (code === "0x") return { ok: false, reason: "behavior_mismatch" };
    const [balance, supply] = await Promise.all([
      backend.call({
        to: pool,
        data: erc20.encodeFunctionData("balanceOf", [pool]),
      }),
      backend.call({
        to: pool,
        data: erc20.encodeFunctionData("totalSupply"),
      }),
    ]);
    erc20.decodeFunctionResult("balanceOf", balance);
    erc20.decodeFunctionResult("totalSupply", supply);
    return {
      ok: true,
      adapter: SELF_BURN_NATIVE_POOL_ADAPTER,
      venueId: SELF_BURN_NATIVE_VENUE,
      identitySource: SELF_BURN_NATIVE_IDENTITY_SOURCE,
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

export async function probeSelfBurnNativeCandidate(
  instance: AttestedProtocolInstance,
  context: ProtocolDiscoveryContext,
): Promise<readonly TokenEdge[]> {
  const token = ethers.getAddress(instance.pool.address);
  if (
    instance.pool.adapter !== SELF_BURN_NATIVE_POOL_ADAPTER ||
    instance.pool.fixedTokenIn?.toLowerCase() !== token.toLowerCase() ||
    instance.pool.fixedTokenOut?.toLowerCase() !== ADDR.WETH.toLowerCase() ||
    instance.pool.logicalInstanceId !== selfBurnNativeInstanceId(token)
  ) {
    throw new Error("self-burn-native candidate shape drifted");
  }
  if (
    !context.graphTokens.some((item) => item.toLowerCase() === token.toLowerCase()) ||
    !context.graphTokens.some((item) => item.toLowerCase() === ADDR.WETH.toLowerCase())
  ) {
    throw new Error("self-burn-native candidate is not loop-closable");
  }
  const evidence = instance.evidence
    .filter(isSelfBurnNativeObservation)
    .filter((item) => item.token.toLowerCase() === token.toLowerCase())
    .sort((a, b) => Number(a.amountIn - b.amountIn))[0];
  const probeAmounts = evidence
    ? [evidence.amountIn]
    : await genericProbeAmounts(context, token);
  if (probeAmounts.length === 0) {
    throw new Error("self-burn-native probe amount is zero");
  }
  const caller = ethers.getAddress(
    context.probeExecutor ?? FALLBACK_PROBE_CALLER,
  );
  const code = await context.backend.getCode(token);
  if (code === "0x") throw new Error("self-burn-native token has no code");
  const slot = await discoverErc20BalanceStorageSlot({
    context,
    token,
    holder: caller,
    codeHash: ethers.keccak256(code),
    probeValue: probeAmounts[0],
  });
  if (slot === null) {
    throw new Error("self-burn-native balance storage could not be proven");
  }
  for (const probeAmount of probeAmounts) {
    const facts = await simulateSelfBurnNative({
      context,
      token,
      caller,
      amountIn: probeAmount,
      balanceSlot: slot,
    });
    if (
      facts !== null &&
      facts.tokenInSpent === probeAmount &&
      facts.totalSupplyBurned === probeAmount &&
      facts.nativeOut > 0n
    ) {
      return [{
        adapterId: SELF_BURN_NATIVE_EDGE_ADAPTER,
        target: token,
        tokenIn: token,
        tokenOut: ADDR.WETH,
        slotKind: "protocol",
        protocolAction: "redeem",
        score: instance.pool.score,
        ...deriveEdgeTaxonomy("protocol", "redeem"),
      }];
    }
  }
  throw new Error("self-burn-native active behavior proof failed");
}

async function genericProbeAmounts(
  context: ProtocolDiscoveryContext,
  token: string,
): Promise<bigint[]> {
  const decimalsIface = new ethers.Interface([
    "function decimals() view returns (uint8)",
  ]);
  const raw = await context.backend.call({
    to: token,
    data: decimalsIface.encodeFunctionData("decimals"),
  });
  const decimals = Number(
    decimalsIface.decodeFunctionResult("decimals", raw)[0],
  );
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`self-burn-native invalid decimals ${decimals}`);
  }
  const one = 10n ** BigInt(decimals);
  return selfBurnNativeProbeAmounts(one);
}

export function selfBurnNativeProbeAmounts(one: bigint): bigint[] {
  return [...new Set([
    one >= 100n ? one / 100n : 1n,
    one >= 10n ? one / 10n : 1n,
    one,
    one >= 1_000n ? one / 1_000n : 1n,
  ])].filter((amount) => amount > 0n);
}

export async function simulateSelfBurnNative(input: {
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
  if (!simulate) return null;
  const balanceData = erc20.encodeFunctionData("balanceOf", [input.caller]);
  const supplyData = erc20.encodeFunctionData("totalSupply");
  const calls = await simulate({
    calls: [
      { from: input.caller, to: input.token, data: balanceData },
      { from: input.caller, to: input.token, data: supplyData },
      {
        from: input.caller,
        to: input.token,
        data: erc20.encodeFunctionData("transfer", [
          input.token,
          input.amountIn,
        ]),
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
  if (calls.length !== 5 || calls.some((call) => call.status !== 1)) return null;
  const balanceBefore = decodeUint(calls[0], "balance before");
  const supplyBefore = decodeUint(calls[1], "supply before");
  const balanceAfter = decodeUint(calls[3], "balance after");
  const supplyAfter = decodeUint(calls[4], "supply after");
  if (
    balanceBefore === null ||
    supplyBefore === null ||
    balanceAfter === null ||
    supplyAfter === null ||
    balanceAfter > balanceBefore ||
    supplyAfter > supplyBefore
  ) return null;
  return {
    tokenInSpent: balanceBefore - balanceAfter,
    totalSupplyBurned: supplyBefore - supplyAfter,
    nativeOut: nativeOutFromLogs(calls[2].logs, input.token, input.caller),
  };
}

function candidateFromObservedSelfBurn(call: {
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
    call.selector.toLowerCase() !== SELF_BURN_NATIVE_TRANSFER_SELECTOR
  ) return null;
  let token: string;
  let caller: string;
  let amountIn: bigint;
  try {
    token = ethers.getAddress(call.target);
    caller = ethers.getAddress(call.from);
    const decoded = erc20.decodeFunctionData("transfer", call.input);
    if (ethers.getAddress(String(decoded[0])).toLowerCase() !== token.toLowerCase()) {
      return null;
    }
    amountIn = BigInt(decoded[1]);
  } catch {
    return null;
  }
  if (amountIn <= 0n) return null;
  const burnLog = call.receipt.logs.find((log) =>
    log.address.toLowerCase() === token.toLowerCase() &&
    log.topics[0]?.toLowerCase() === SELF_BURN_NATIVE_EVENT_TOPIC
  );
  const blockNumber = burnLog?.blockNumber;
  if (
    blockNumber === undefined ||
    !Number.isSafeInteger(blockNumber) ||
    blockNumber < 0
  ) return null;
  const nativeOut = causalNativePayout(
    call.trace,
    token,
    caller,
    call.input,
  );
  if (nativeOut <= 0n) return null;
  const evidence: SelfBurnNativeObservation = {
    kind: "self-burn-native-observation",
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
      adapter: SELF_BURN_NATIVE_POOL_ADAPTER,
      fixedTokenIn: token,
      fixedTokenOut: ADDR.WETH,
      fixedSlotKind: "protocol",
      fixedProtocolAction: "redeem",
      logicalInstanceId: selfBurnNativeInstanceId(token),
    },
    source: "observed-calltrace",
    selector: call.selector,
    evidence: [evidence],
  };
}

export function selfBurnNativeInstanceId(token: string): string {
  return `self-burn-native:${ethers.getAddress(token).toLowerCase()}`;
}

function isSelfBurnNativeObservation(
  value: unknown,
): value is SelfBurnNativeObservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SelfBurnNativeObservation>;
  return item.kind === "self-burn-native-observation" &&
    typeof item.token === "string" &&
    typeof item.caller === "string" &&
    typeof item.amountIn === "bigint" &&
    typeof item.nativeOut === "bigint";
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

function decodeUint(
  result: ProtocolDiscoverySimulatedCallResult,
  label: string,
): bigint | null {
  try {
    if (!ethers.isHexString(result.returnData)) return null;
    return BigInt(result.returnData);
  } catch {
    void label;
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
    ) continue;
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
  return `0x${topic.slice(-40)}`.toLowerCase();
}
