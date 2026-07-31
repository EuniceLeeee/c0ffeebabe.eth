import { ethers } from "ethers";
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
} from "../route-leg-adapter.js";

export const ASTRA_MULTITOKEN_POOL_ADAPTER =
  poolAdapterId("astra-multitoken");
export const ASTRA_MULTITOKEN_EDGE_ADAPTER =
  "astra-multitoken-change" as const;
export const ASTRA_MULTITOKEN_VENUE =
  venueId("behavior:astra-multitoken");
export const ASTRA_MULTITOKEN_IDENTITY_SOURCE =
  venueIdentitySource("astra-multitoken-call-surface");

export const astraMultiTokenIface = new ethers.Interface([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function tokensCount() view returns (uint256)",
  "function tokens(uint256 index) view returns (address)",
  "function weights(address token) view returns (uint256)",
  "function changesEnabled() view returns (bool)",
  "function inLendingMode() view returns (uint256)",
  "function changeFee() view returns (uint256)",
  "function TOTAL_PERCRENTS() view returns (uint256)",
  "function getReturn(address fromToken,address toToken,uint256 amount) view returns (uint256)",
  "function change(address fromToken,address toToken,uint256 amount,uint256 minReturn) returns (uint256)",
  "event Change(address indexed fromToken,address indexed toToken,address indexed changer,uint256 amount,uint256 returnAmount)",
]);
const erc20Iface = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Transfer(address indexed from,address indexed to,uint256 amount)",
]);

export const ASTRA_MULTITOKEN_CHANGE_SELECTOR = astraMultiTokenIface
  .getFunction("change")!.selector.toLowerCase();
export const ASTRA_MULTITOKEN_CHANGE_EVENT_TOPIC = astraMultiTokenIface
  .getEvent("Change")!.topicHash.toLowerCase();

const ASTRA_MULTITOKEN_INTERFACE_ID = "0x81624e24";
const ASTRA_MULTITOKEN_BASE_INTERFACE_ID = "0xd5c368b6";
const IMPLEMENTATION_SLOT = BigInt(
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
);
const TRANSFER_TOPIC = erc20Iface.getEvent("Transfer")!.topicHash.toLowerCase();
const MAX_ASTRA_TOKENS = 32;
const MAX_ACTIVE_PROBE_SAMPLES = 3;
const FALLBACK_PROBE_CALLER = ethers.getAddress(
  `0x${"00".repeat(18)}a57a`,
);

export interface AstraMultiTokenObservation {
  readonly kind: "astra-multitoken-change-observation";
  readonly txHash: string;
  readonly blockNumber: number;
  readonly changer: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly minAmountOut: bigint;
}

interface AstraTokenSet {
  readonly tokens: readonly string[];
  readonly totalPercents: bigint;
  readonly changeFee: bigint;
  readonly inLendingMode: bigint;
}

export const astraMultiTokenDiscovery = Object.freeze({
  candidateSources: Object.freeze(["observed-interaction"] as const),
  eventTopics: Object.freeze([ASTRA_MULTITOKEN_CHANGE_EVENT_TOPIC]),
  callSelectors: Object.freeze([ASTRA_MULTITOKEN_CHANGE_SELECTOR]),
  observedMatcherVersion: "astra-multitoken-observed-v1",

  async candidateFromObservedCall(call) {
    return candidateFromObservedChange(call);
  },

  async probeCandidate(instance, context) {
    return probeAstraMultiTokenCandidate(instance, context);
  },
} satisfies ProtocolDiscoveryCapability);

export const astraMultiTokenIdentityResolver: OnchainIdentityResolver = async ({
  backend,
  pool,
  poolAdapter,
  candidate,
}) => {
  if (
    poolAdapter !== ASTRA_MULTITOKEN_POOL_ADAPTER ||
    candidate.logicalInstanceId !== astraMultiTokenInstanceId(pool) ||
    !backend.getCode
  ) {
    return { ok: false, reason: "behavior_mismatch" };
  }
  try {
    const code = await backend.getCode(pool);
    if (code === "0x") return { ok: false, reason: "behavior_mismatch" };
    const surface = await readAstraTokenSet(backend, pool, true);
    const zeroQuote = await quoteAstraMultiToken(
      backend,
      pool,
      surface.tokens[0],
      surface.tokens[1],
      0n,
    );
    if (zeroQuote !== 0n) return { ok: false, reason: "behavior_mismatch" };
    return {
      ok: true,
      adapter: ASTRA_MULTITOKEN_POOL_ADAPTER,
      venueId: ASTRA_MULTITOKEN_VENUE,
      identitySource: ASTRA_MULTITOKEN_IDENTITY_SOURCE,
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

export async function probeAstraMultiTokenCandidate(
  instance: AttestedProtocolInstance,
  context: ProtocolDiscoveryContext,
): Promise<readonly TokenEdge[]> {
  const target = ethers.getAddress(instance.pool.address);
  if (
    instance.pool.adapter !== ASTRA_MULTITOKEN_POOL_ADAPTER ||
    instance.pool.logicalInstanceId !== astraMultiTokenInstanceId(target)
  ) {
    throw new Error("AstraMultiToken candidate has a mismatched instance identity");
  }
  const surface = await readAstraTokenSet(context.backend, target, true);
  const tokenSet = new Set(surface.tokens.map((token) => token.toLowerCase()));
  const samples = instance.evidence
    .filter(isAstraMultiTokenObservation)
    .filter((item) =>
      item.amountIn > 0n &&
      item.amountOut > 0n &&
      tokenSet.has(item.tokenIn.toLowerCase()) &&
      tokenSet.has(item.tokenOut.toLowerCase()))
    .sort((a, b) =>
      a.blockNumber - b.blockNumber ||
      a.tokenIn.localeCompare(b.tokenIn) ||
      a.tokenOut.localeCompare(b.tokenOut))
    .slice(-MAX_ACTIVE_PROBE_SAMPLES);
  if (samples.length === 0) {
    throw new Error("AstraMultiToken candidate lacks a registry-bound observed pair");
  }
  if (!context.backend.simulateCalls) {
    throw new Error("AstraMultiToken requires state-override execution simulation");
  }
  let executionVerified = false;
  for (const sample of samples) {
    if (await activelyProbeAstraChange(context, target, sample)) {
      executionVerified = true;
      break;
    }
  }
  if (!executionVerified) {
    throw new Error("AstraMultiToken nonzero execution probe failed");
  }

  const edges: TokenEdge[] = [];
  for (const tokenIn of surface.tokens) {
    for (const tokenOut of surface.tokens) {
      if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) continue;
      edges.push(astraMultiTokenEdge(target, tokenIn, tokenOut, instance.pool.score));
    }
  }
  return Object.freeze(edges);
}

export async function readAstraTokenSet(
  backend: {
    call(req: { to: string; data: string; from?: string }): Promise<string>;
    getCode?(address: string): Promise<string>;
  },
  target: string,
  verifyTokenCode: boolean,
): Promise<AstraTokenSet> {
  const normalizedTarget = ethers.getAddress(target);
  const [
    supportsPrimaryRaw,
    supportsBaseRaw,
    tokenCountRaw,
    changesEnabledRaw,
    lendingModeRaw,
    changeFeeRaw,
    totalPercentsRaw,
  ] = await Promise.all([
    backend.call({
      to: normalizedTarget,
      data: astraMultiTokenIface.encodeFunctionData("supportsInterface", [
        ASTRA_MULTITOKEN_INTERFACE_ID,
      ]),
    }),
    backend.call({
      to: normalizedTarget,
      data: astraMultiTokenIface.encodeFunctionData("supportsInterface", [
        ASTRA_MULTITOKEN_BASE_INTERFACE_ID,
      ]),
    }),
    backend.call({
      to: normalizedTarget,
      data: astraMultiTokenIface.encodeFunctionData("tokensCount"),
    }),
    backend.call({
      to: normalizedTarget,
      data: astraMultiTokenIface.encodeFunctionData("changesEnabled"),
    }),
    backend.call({
      to: normalizedTarget,
      data: astraMultiTokenIface.encodeFunctionData("inLendingMode"),
    }),
    backend.call({
      to: normalizedTarget,
      data: astraMultiTokenIface.encodeFunctionData("changeFee"),
    }),
    backend.call({
      to: normalizedTarget,
      data: astraMultiTokenIface.encodeFunctionData("TOTAL_PERCRENTS"),
    }),
  ]);
  const supportsPrimary = Boolean(
    astraMultiTokenIface.decodeFunctionResult(
      "supportsInterface",
      supportsPrimaryRaw,
    )[0],
  );
  const supportsBase = Boolean(
    astraMultiTokenIface.decodeFunctionResult(
      "supportsInterface",
      supportsBaseRaw,
    )[0],
  );
  const tokenCount = Number(
    astraMultiTokenIface.decodeFunctionResult("tokensCount", tokenCountRaw)[0],
  );
  const changesEnabled = Boolean(
    astraMultiTokenIface.decodeFunctionResult(
      "changesEnabled",
      changesEnabledRaw,
    )[0],
  );
  const inLendingMode = BigInt(
    astraMultiTokenIface.decodeFunctionResult(
      "inLendingMode",
      lendingModeRaw,
    )[0],
  );
  const changeFee = BigInt(
    astraMultiTokenIface.decodeFunctionResult("changeFee", changeFeeRaw)[0],
  );
  const totalPercents = BigInt(
    astraMultiTokenIface.decodeFunctionResult(
      "TOTAL_PERCRENTS",
      totalPercentsRaw,
    )[0],
  );
  if (
    !supportsPrimary ||
    !supportsBase ||
    !changesEnabled ||
    !Number.isSafeInteger(tokenCount) ||
    tokenCount < 2 ||
    tokenCount > MAX_ASTRA_TOKENS ||
    inLendingMode < 0n ||
    totalPercents <= 0n ||
    changeFee < 0n ||
    changeFee > totalPercents
  ) {
    throw new Error("AstraMultiToken identity surface is not supported");
  }

  const tokenResults = await Promise.all(
    Array.from({ length: tokenCount }, (_, index) =>
      backend.call({
        to: normalizedTarget,
        data: astraMultiTokenIface.encodeFunctionData("tokens", [index]),
      })),
  );
  const tokens = tokenResults.map((raw) =>
    ethers.getAddress(String(
      astraMultiTokenIface.decodeFunctionResult("tokens", raw)[0],
    )));
  const uniqueTokens = new Set(tokens.map((token) => token.toLowerCase()));
  if (
    uniqueTokens.size !== tokens.length ||
    tokens.some((token) => token === ethers.ZeroAddress)
  ) {
    throw new Error("AstraMultiToken registry contains duplicate or zero tokens");
  }
  const weightResults = await Promise.all(tokens.map((token) =>
    backend.call({
      to: normalizedTarget,
      data: astraMultiTokenIface.encodeFunctionData("weights", [token]),
    })));
  const weights = weightResults.map((raw) =>
    BigInt(astraMultiTokenIface.decodeFunctionResult("weights", raw)[0]));
  if (weights.some((weight) => weight <= 0n)) {
    throw new Error("AstraMultiToken registry contains a nonpositive weight");
  }
  if (verifyTokenCode) {
    if (!backend.getCode) {
      throw new Error("AstraMultiToken token-code proof is unavailable");
    }
    const codes = await Promise.all(tokens.map((token) => backend.getCode!(token)));
    if (codes.some((code) => code === "0x")) {
      throw new Error("AstraMultiToken registry contains a non-contract token");
    }
  }
  return Object.freeze({
    tokens: Object.freeze(tokens),
    totalPercents,
    changeFee,
    inLendingMode,
  });
}

export async function quoteAstraMultiToken(
  backend: {
    call(req: { to: string; data: string; from?: string }): Promise<string>;
  },
  target: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const normalizedIn = ethers.getAddress(tokenIn);
  const normalizedOut = ethers.getAddress(tokenOut);
  if (
    normalizedIn.toLowerCase() === normalizedOut.toLowerCase() ||
    amountIn < 0n
  ) {
    throw new Error("AstraMultiToken quote requires a distinct pair and nonnegative input");
  }
  const raw = await backend.call({
    to: ethers.getAddress(target),
    data: astraMultiTokenIface.encodeFunctionData("getReturn", [
      normalizedIn,
      normalizedOut,
      amountIn,
    ]),
  });
  const amountOut = BigInt(
    astraMultiTokenIface.decodeFunctionResult("getReturn", raw)[0],
  );
  if (
    amountOut < 0n ||
    (amountIn === 0n && amountOut !== 0n) ||
    (amountIn > 0n && amountOut <= 0n)
  ) {
    throw new Error("AstraMultiToken quote returned an invalid exact-in amount");
  }
  return amountOut;
}

export function astraMultiTokenInstanceId(target: string): string {
  return `astra-multitoken:${ethers.getAddress(target).toLowerCase()}`;
}

export function astraMultiTokenEdge(
  target: string,
  tokenIn: string,
  tokenOut: string,
  score?: number,
): TokenEdge {
  const normalizedIn = ethers.getAddress(tokenIn);
  const normalizedOut = ethers.getAddress(tokenOut);
  if (normalizedIn.toLowerCase() === normalizedOut.toLowerCase()) {
    throw new Error("AstraMultiToken edge requires distinct tokens");
  }
  return {
    adapterId: ASTRA_MULTITOKEN_EDGE_ADAPTER,
    target: ethers.getAddress(target),
    tokenIn: normalizedIn,
    tokenOut: normalizedOut,
    slotKind: "protocol",
    protocolAction: "convert",
    score,
    ...deriveEdgeTaxonomy("protocol", "convert"),
  };
}

function candidateFromObservedChange(call: {
  readonly target: string;
  readonly selector: string;
  readonly input: string;
  readonly from?: string;
  readonly txHash: string;
  readonly receipt: {
    readonly status: number | null;
    readonly logs: readonly ProtocolDiscoveryLog[];
  };
}): ProtocolCandidate | null {
  if (
    call.receipt.status !== 1 ||
    !call.from ||
    call.selector.toLowerCase() !== ASTRA_MULTITOKEN_CHANGE_SELECTOR
  ) return null;
  let target: string;
  let changer: string;
  let tokenIn: string;
  let tokenOut: string;
  let amountIn: bigint;
  let minAmountOut: bigint;
  try {
    target = ethers.getAddress(call.target);
    changer = ethers.getAddress(call.from);
    const decoded = astraMultiTokenIface.decodeFunctionData(
      "change",
      call.input,
    );
    tokenIn = ethers.getAddress(String(decoded[0]));
    tokenOut = ethers.getAddress(String(decoded[1]));
    amountIn = BigInt(decoded[2]);
    minAmountOut = BigInt(decoded[3]);
  } catch {
    return null;
  }
  if (
    tokenIn.toLowerCase() === tokenOut.toLowerCase() ||
    amountIn <= 0n ||
    minAmountOut < 0n
  ) return null;

  const observations: AstraMultiTokenObservation[] = [];
  for (const log of call.receipt.logs) {
    if (
      log.address.toLowerCase() !== target.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== ASTRA_MULTITOKEN_CHANGE_EVENT_TOPIC
    ) continue;
    let parsed: ethers.LogDescription | null;
    try {
      parsed = astraMultiTokenIface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
    } catch {
      parsed = null;
    }
    if (!parsed) continue;
    const eventTokenIn = ethers.getAddress(String(parsed.args.fromToken));
    const eventTokenOut = ethers.getAddress(String(parsed.args.toToken));
    const eventChanger = ethers.getAddress(String(parsed.args.changer));
    const eventAmountIn = BigInt(parsed.args.amount);
    const eventAmountOut = BigInt(parsed.args.returnAmount);
    const blockNumber = log.blockNumber;
    if (
      eventTokenIn.toLowerCase() !== tokenIn.toLowerCase() ||
      eventTokenOut.toLowerCase() !== tokenOut.toLowerCase() ||
      eventChanger.toLowerCase() !== changer.toLowerCase() ||
      eventAmountIn !== amountIn ||
      eventAmountOut <= 0n ||
      eventAmountOut < minAmountOut ||
      blockNumber === undefined ||
      !Number.isSafeInteger(blockNumber) ||
      blockNumber < 0 ||
      !transferMatches(
        call.receipt.logs,
        tokenIn,
        changer,
        target,
        amountIn,
      ) ||
      !transferMatches(
        call.receipt.logs,
        tokenOut,
        target,
        changer,
        eventAmountOut,
      )
    ) continue;
    observations.push({
      kind: "astra-multitoken-change-observation",
      txHash: call.txHash,
      blockNumber,
      changer,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: eventAmountOut,
      minAmountOut,
    });
  }
  const unique = new Map(observations.map((item) => [
    [
      item.tokenIn.toLowerCase(),
      item.tokenOut.toLowerCase(),
      item.amountIn,
      item.amountOut,
    ].join("|"),
    item,
  ]));
  if (unique.size !== 1) return null;
  return {
    pool: {
      address: target,
      adapter: ASTRA_MULTITOKEN_POOL_ADAPTER,
      fixedSlotKind: "protocol",
      fixedProtocolAction: "convert",
      logicalInstanceId: astraMultiTokenInstanceId(target),
    },
    source: "observed-calltrace",
    selector: call.selector,
    evidence: [[...unique.values()][0]],
  };
}

async function activelyProbeAstraChange(
  context: ProtocolDiscoveryContext,
  target: string,
  sample: AstraMultiTokenObservation,
): Promise<boolean> {
  const caller = ethers.getAddress(
    context.probeExecutor ?? FALLBACK_PROBE_CALLER,
  );
  const amountOut = await quoteAstraMultiToken(
    context.backend,
    target,
    sample.tokenIn,
    sample.tokenOut,
    sample.amountIn,
  );
  const tokenCode = await context.backend.getCode(sample.tokenIn);
  if (tokenCode === "0x") return false;
  const implementationWord = await context.backend.getStorageAt(
    sample.tokenIn,
    IMPLEMENTATION_SLOT,
  );
  const stateFingerprint = ethers.keccak256(ethers.concat([
    ethers.getBytes(ethers.keccak256(tokenCode)),
    ethers.getBytes(implementationWord),
  ]));
  const balanceSlot = await discoverErc20BalanceStorageSlot({
    context,
    token: sample.tokenIn,
    holder: caller,
    codeHash: stateFingerprint,
    probeValue: sample.amountIn,
  });
  if (!balanceSlot || !context.backend.simulateCalls) return false;
  const balanceInData = erc20Iface.encodeFunctionData("balanceOf", [caller]);
  const balanceOutData = erc20Iface.encodeFunctionData("balanceOf", [caller]);
  const calls = [
    {
      from: caller,
      to: sample.tokenIn,
      data: erc20Iface.encodeFunctionData("approve", [
        target,
        sample.amountIn,
      ]),
    },
    { from: caller, to: sample.tokenIn, data: balanceInData },
    { from: caller, to: sample.tokenOut, data: balanceOutData },
    {
      from: caller,
      to: target,
      data: astraMultiTokenIface.encodeFunctionData("change", [
        sample.tokenIn,
        sample.tokenOut,
        sample.amountIn,
        amountOut,
      ]),
    },
    { from: caller, to: sample.tokenIn, data: balanceInData },
    { from: caller, to: sample.tokenOut, data: balanceOutData },
  ] as const;
  const results = await context.backend.simulateCalls({
    calls,
    stateOverrides: {
      [sample.tokenIn]: {
        stateDiff: {
          [balanceSlot]: ethers.toBeHex(sample.amountIn, 32),
        },
      },
    },
  });
  if (
    results.length !== calls.length ||
    results.some((result) => result.status !== 1)
  ) return false;
  try {
    const inputBefore = decodeErc20Balance(results[1].returnData);
    const outputBefore = decodeErc20Balance(results[2].returnData);
    const returned = BigInt(
      astraMultiTokenIface.decodeFunctionResult(
        "change",
        results[3].returnData,
      )[0],
    );
    const inputAfter = decodeErc20Balance(results[4].returnData);
    const outputAfter = decodeErc20Balance(results[5].returnData);
    return (
      inputBefore === sample.amountIn &&
      inputAfter === 0n &&
      returned === amountOut &&
      outputAfter === outputBefore + amountOut &&
      changeLogMatches(
        results[3].logs,
        target,
        sample.tokenIn,
        sample.tokenOut,
        caller,
        sample.amountIn,
        amountOut,
      ) &&
      transferMatches(
        results[3].logs,
        sample.tokenIn,
        caller,
        target,
        sample.amountIn,
      ) &&
      transferMatches(
        results[3].logs,
        sample.tokenOut,
        target,
        caller,
        amountOut,
      )
    );
  } catch {
    return false;
  }
}

function changeLogMatches(
  logs: readonly ProtocolDiscoveryLog[],
  target: string,
  tokenIn: string,
  tokenOut: string,
  changer: string,
  amountIn: bigint,
  amountOut: bigint,
): boolean {
  return logs.some((log) => {
    if (
      log.address.toLowerCase() !== target.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== ASTRA_MULTITOKEN_CHANGE_EVENT_TOPIC
    ) return false;
    try {
      const parsed = astraMultiTokenIface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      return parsed !== null &&
        ethers.getAddress(String(parsed.args.fromToken)).toLowerCase() ===
          tokenIn.toLowerCase() &&
        ethers.getAddress(String(parsed.args.toToken)).toLowerCase() ===
          tokenOut.toLowerCase() &&
        ethers.getAddress(String(parsed.args.changer)).toLowerCase() ===
          changer.toLowerCase() &&
        BigInt(parsed.args.amount) === amountIn &&
        BigInt(parsed.args.returnAmount) === amountOut;
    } catch {
      return false;
    }
  });
}

function transferMatches(
  logs: readonly ProtocolDiscoveryLog[],
  token: string,
  from: string,
  to: string,
  amount: bigint,
): boolean {
  return logs.some((log) => {
    if (
      log.address.toLowerCase() !== token.toLowerCase() ||
      log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC
    ) return false;
    try {
      const parsed = erc20Iface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      return parsed !== null &&
        ethers.getAddress(String(parsed.args.from)).toLowerCase() ===
          from.toLowerCase() &&
        ethers.getAddress(String(parsed.args.to)).toLowerCase() ===
          to.toLowerCase() &&
        BigInt(parsed.args.amount) === amount;
    } catch {
      return false;
    }
  });
}

function decodeErc20Balance(raw: string): bigint {
  return BigInt(erc20Iface.decodeFunctionResult("balanceOf", raw)[0]);
}

function isAstraMultiTokenObservation(
  value: unknown,
): value is AstraMultiTokenObservation {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<AstraMultiTokenObservation>;
  return item.kind === "astra-multitoken-change-observation" &&
    typeof item.txHash === "string" &&
    typeof item.blockNumber === "number" &&
    typeof item.changer === "string" &&
    typeof item.tokenIn === "string" &&
    typeof item.tokenOut === "string" &&
    typeof item.amountIn === "bigint" &&
    typeof item.amountOut === "bigint" &&
    typeof item.minAmountOut === "bigint";
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
