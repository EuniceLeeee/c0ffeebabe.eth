import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { PoolUniverseEntry } from "../../pool-universe.js";
import type { ExactQuoteContext, PlanBuildContext, PlanFragment, SwapAdapter } from "../route-leg-adapter.js";
import { balancerV3IdentityResolver } from "../identity.js";
import { createBalancerV3SwapObservation } from "../swap-observation.js";
import {
  BALANCER_V3_SWAP_TOPIC,
  defineSwapLandedEvents,
  singletonIndexedAddressEmitter,
} from "../landed-event-registry.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanErc20Iface,
  currentBlockRead,
  decodeMulticall,
  encodeMulticall,
  optionalMulticallData,
  requireRead,
  type MulticallItem,
} from "./blockscan-state-shared.js";
import {
  createAdaptiveCurrentBlockViewQuoteCapability,
  type AdaptiveFallbackContext,
  type AdaptiveViewQuoteContext,
} from "./adaptive-view-quote-blockscan-state.js";
import type {
  LandedPoolDiscoveryLog,
  LandedPoolMaterializationCapability,
} from "../landed-pool-discovery.js";

const vaultIface = new ethers.Interface([
  "function getPoolTokens(address pool) view returns (address[] tokens)",
  "function getPoolTokenInfo(address pool) view returns (address[] tokens,tuple(uint8 tokenType,address rateProvider,bool paysYieldFees)[] tokenInfo,uint256[] balancesRaw,uint256[] lastBalancesLiveScaled18)",
  "function getPoolTokenRates(address pool) view returns (uint256[] decimalScalingFactors,uint256[] tokenRates)",
  "function getCurrentLiveBalances(address pool) view returns (uint256[] balancesLiveScaled18)",
  "function getHooksConfig(address pool) view returns (tuple(bool enableHookAdjustedAmounts,bool shouldCallBeforeInitialize,bool shouldCallAfterInitialize,bool shouldCallComputeDynamicSwapFee,bool shouldCallBeforeSwap,bool shouldCallAfterSwap,bool shouldCallBeforeAddLiquidity,bool shouldCallAfterAddLiquidity,bool shouldCallBeforeRemoveLiquidity,bool shouldCallAfterRemoveLiquidity,address hooksContract) hooksConfig)",
  "function getMinimumTradeAmount() view returns (uint256 minimumTradeAmount)",
]);
const routerIface = new ethers.Interface([
  "function querySwapSingleTokenExactIn(address pool,address tokenIn,address tokenOut,uint256 exactAmountIn,address sender,bytes userData) returns (uint256 amountOut)",
  "function querySwapSingleTokenExactOut(address pool,address tokenIn,address tokenOut,uint256 exactAmountOut,address sender,bytes userData) returns (uint256 amountIn)",
]);
const gyroEclpIface = new ethers.Interface([
  "function getGyroECLPPoolDynamicData() view returns (tuple(uint256[] balancesLiveScaled18,uint256[] tokenRates,uint256 staticSwapFeePercentage,uint256 totalSupply,uint256 bptRate,bool isPoolInitialized,bool isPoolPaused,bool isPoolInRecoveryMode) data)",
  "function getVault() view returns (address)",
]);
const poolFactoryIface = new ethers.Interface([
  "function isPoolFromFactory(address pool) view returns (bool)",
]);
const ASSET_BOUNDS_EXCEEDED_SELECTOR =
  ethers.id("AssetBoundsExceeded()").slice(0, 10).toLowerCase();
const ONE_18 = 10n ** 18n;
// Canonical factory is an identity source, never a Balancer-v3 admission
// allowlist. Unknown or newer factories still enter the graph and quote
// normally; they simply cannot use the ECLP-specific unavailable proof.
const BALANCER_V3_GYRO_ECLP_FACTORY =
  "0xe9b0a3bc48178d7fe2f5453c8bc1415d73f966d0";
const balancerV3LandedEvents = defineSwapLandedEvents({
  swaps: [{
    id: "balancer-v3-swap",
    topic: BALANCER_V3_SWAP_TOPIC,
    emitter: singletonIndexedAddressEmitter(ADDR.BALANCER_V3_VAULT, 1),
    materialization: "family",
    discovery: { poolAdapter: "balancer-v3", label: "balancer-v3" },
    invalidatesWarmState: true,
  }],
  mutations: [],
});

const balancerV3PoolDiscovery = Object.freeze({
  version: "balancer-v3-indexed-pool-v1",
  eventIds: ["balancer-v3-swap"],
  async materialize(context) {
    const malformed = context.logs.filter((log) =>
      !isBalancerV3DiscoveryLogMaterializable(log)
    ).length;
    return {
      pools: buildBalancerV3PoolEntries(context.logs, context.minSwaps),
      complete: malformed === 0,
      ...(malformed === 0
        ? {}
        : { issues: [`${malformed} malformed indexed pool/token events`] }),
    };
  },
} satisfies LandedPoolMaterializationCapability);

export function buildBalancerV3PoolEntries(
  logs: readonly LandedPoolDiscoveryLog[],
  minSwaps: number,
): PoolUniverseEntry[] {
  const pools = new Map<string, PoolUniverseEntry>();
  for (const log of logs) {
    const poolTopic = log.topics[1];
    const tokenInTopic = log.topics[2];
    const tokenOutTopic = log.topics[3];
    if (!poolTopic || !tokenInTopic || !tokenOutTopic) continue;
    try {
      const address = indexedAddress(poolTopic);
      const tokenIn = indexedAddress(tokenInTopic);
      const tokenOut = indexedAddress(tokenOutTopic);
      const key = address.toLowerCase();
      const existing = pools.get(key);
      if (existing) {
        existing.score = (existing.score ?? 0) + 1;
        existing.swapCount30d = (existing.swapCount30d ?? 0) + 1;
        existing.lastSwapBlock = Math.max(
          existing.lastSwapBlock ?? 0,
          logBlockNumber(log.blockNumber),
        );
      } else {
        pools.set(key, {
          address,
          adapter: "balancer-v3",
          venueId: "balancer-v3",
          identitySource: "balancer-v3-vault",
          token0: tokenIn,
          token1: tokenOut,
          score: 1,
          swapCount30d: 1,
          lastSwapBlock: logBlockNumber(log.blockNumber),
          source: "balancer-v3-vault-swap",
        });
      }
    } catch {
      // Malformed events do not nominate an executable instance.
    }
  }
  return [...pools.values()]
    .filter((pool) => (pool.swapCount30d ?? 0) >= minSwaps)
    .sort((left, right) =>
      (right.swapCount30d ?? 0) - (left.swapCount30d ?? 0)
    );
}

interface BalancerV3StateSchema {
  readonly pool: string;
}

export const balancerV3BlockScanState = Object.freeze({
  ...createAdaptiveCurrentBlockViewQuoteCapability<BalancerV3StateSchema>({
    kind: "external-swap",
    edgeAdapterIds: new Set(["balancer-v3-unlock"]),
    compileDirection(edge) {
      const pool = ethers.getAddress(edge.target).toLowerCase();
      return Object.freeze({ pool });
    },
    initialReads(ctx) {
      return Object.freeze([
        currentBlockRead({
          id: balancerPoolInfoReadId(ctx.stateKey),
          sourceBlock: ctx.sourceBlock,
          sourceBlockHash: ctx.sourceBlockHash,
          to: ADDR.BALANCER_V3_VAULT,
          data: vaultIface.encodeFunctionData("getPoolTokenInfo", [
            ctx.static.pool,
          ]),
        }),
        currentBlockRead({
          id: balancerTokenDecimalsReadId(ctx.edge.tokenIn),
          sourceBlock: ctx.sourceBlock,
          sourceBlockHash: ctx.sourceBlockHash,
          to: BLOCKSCAN_MULTICALL3,
          data: encodeMulticall(
            balancerTokenDecimalsItems(ctx.edge.tokenIn),
          ),
          transport: "rpc-batch",
        }),
      ]);
    },
    quoteCandidates(ctx) {
      return balancerQuoteCandidates(ctx);
    },
    quoteCall(ctx, amountIn) {
      return Object.freeze({
        target: ADDR.BALANCER_V3_ROUTER,
        data: routerIface.encodeFunctionData("querySwapSingleTokenExactIn", [
          ctx.edge.target,
          ctx.edge.tokenIn,
          ctx.edge.tokenOut,
          amountIn,
          ethers.ZeroAddress,
          "0x",
        ]),
      });
    },
    decodeQuote(_edge, data) {
      return BigInt(
        routerIface.decodeFunctionResult("querySwapSingleTokenExactIn", data)[0],
      );
    },
    fallback: {
      buildDependentReads(ctx) {
        return buildBalancerFallbackReads(ctx);
      },
      decode(ctx) {
        const proof = decodeBalancerEclpProof(ctx);
        if (!proof) return null;
        const exactOut = decodeBalancerExactOut(ctx, proof);
        if (!exactOut) return null;
        if (exactOut.status === "asset-bounds") {
          return Object.freeze({
            status: "unavailable" as const,
            reason:
              "source-pinned Gyro ECLP cannot satisfy the Vault minimum " +
              "exact-out within its current asset bounds",
          });
        }
        return Object.freeze({
          status: "quote" as const,
          amountIn: exactOut.amountIn,
          amountOut: proof.minimumRawAmountOut,
        });
      },
    },
    dependencies() {
      return Object.freeze([
        ADDR.BALANCER_V3_ROUTER,
        ADDR.BALANCER_V3_VAULT,
      ]);
    },
  }),
  mutationCoverage: "complete" as const,
});

function balancerQuoteCandidates(
  ctx: AdaptiveViewQuoteContext<BalancerV3StateSchema>,
): readonly bigint[] {
  const poolInfo = requireRead(
    ctx.priorResults,
    balancerPoolInfoReadId(ctx.stateKey),
  );
  const decoded = vaultIface.decodeFunctionResult(
    "getPoolTokenInfo",
    poolInfo.data,
  );
  const tokens = (decoded[0] as string[]).map((token) =>
    ethers.getAddress(token)
  );
  const balancesRaw = (decoded[2] as bigint[]).map((balance) =>
    BigInt(balance)
  );
  if (tokens.length !== balancesRaw.length) {
    throw new Error(
      `balancer-v3 pool ${ctx.static.pool} returned inconsistent token balances`,
    );
  }
  const inputIndex = tokens.findIndex((token) =>
    token.toLowerCase() === ctx.edge.tokenIn.toLowerCase()
  );
  const outputIndex = tokens.findIndex((token) =>
    token.toLowerCase() === ctx.edge.tokenOut.toLowerCase()
  );
  if (inputIndex < 0 || outputIndex < 0 || inputIndex === outputIndex) {
    throw new Error(
      `balancer-v3 pool ${ctx.static.pool} omitted quoted token direction`,
    );
  }
  const decimalsItems = balancerTokenDecimalsItems(ctx.edge.tokenIn);
  const decimalsResults = decodeMulticall(
    requireRead(
      ctx.priorResults,
      balancerTokenDecimalsReadId(ctx.edge.tokenIn),
    ),
    decimalsItems,
  );
  const decimalsData = optionalMulticallData(
    decimalsResults,
    "token-decimals",
  );
  if (!decimalsData) {
    throw new Error(
      `balancer-v3 input token ${ctx.edge.tokenIn} has no decimals scale`,
    );
  }
  const decimals = Number(
    blockScanErc20Iface.decodeFunctionResult("decimals", decimalsData)[0],
  );
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(
      `balancer-v3 input token ${ctx.edge.tokenIn} returned invalid decimals`,
    );
  }
  const unit = 10n ** BigInt(decimals);
  const balance = balancesRaw[inputIndex];
  const liquidityProbe = balance >= 100n
    ? balance / 100n
    : balance > 0n
    ? balance / 4n
    : 0n;
  const candidates: bigint[] = [];
  if (liquidityProbe > 0n) {
    candidates.push(liquidityProbe < unit ? liquidityProbe : unit);
  }
  for (let exponent = 0; exponent <= decimals + 6; exponent += 3) {
    candidates.push(10n ** BigInt(exponent));
  }
  return Object.freeze(candidates);
}

function balancerTokenDecimalsReadId(token: string): string {
  return `balancer-v3:token-decimals:${ethers.getAddress(token).toLowerCase()}`;
}

function balancerTokenDecimalsItems(token: string): readonly MulticallItem[] {
  return Object.freeze([{
    label: "token-decimals",
    target: token,
    callData: blockScanErc20Iface.encodeFunctionData("decimals"),
    allowFailure: true,
  }]);
}

interface BalancerFallbackReadContext
  extends AdaptiveViewQuoteContext<BalancerV3StateSchema> {
  readonly candidates: readonly bigint[];
}

interface BalancerEclpProof {
  readonly minimumRawAmountOut: bigint;
}

type BalancerExactOutResult =
  | { readonly status: "quote"; readonly amountIn: bigint }
  | { readonly status: "asset-bounds" };

function buildBalancerFallbackReads(
  ctx: AdaptiveFallbackContext<BalancerV3StateSchema>,
): readonly ReturnType<typeof currentBlockRead>[] {
  if (ctx.completedRound === 1) {
    return Object.freeze([
      currentBlockRead({
        id: balancerProofReadId(ctx.stateKey),
        sourceBlock: ctx.sourceBlock,
        sourceBlockHash: ctx.sourceBlockHash,
        to: BLOCKSCAN_MULTICALL3,
        data: encodeMulticall(balancerProofItems(ctx.edge)),
        transport: "rpc-batch",
      }),
      currentBlockRead({
        id: balancerMinimumTradeReadId(),
        sourceBlock: ctx.sourceBlock,
        sourceBlockHash: ctx.sourceBlockHash,
        to: ADDR.BALANCER_V3_VAULT,
        data: vaultIface.encodeFunctionData("getMinimumTradeAmount"),
        transport: "rpc-batch",
      }),
    ]);
  }
  if (ctx.completedRound === 2) {
    const proof = decodeBalancerEclpProof(ctx);
    if (!proof) return Object.freeze([]);
    return Object.freeze([
      currentBlockRead({
        id: balancerExactOutReadId(ctx.stateKey),
        sourceBlock: ctx.sourceBlock,
        sourceBlockHash: ctx.sourceBlockHash,
        to: BLOCKSCAN_MULTICALL3,
        data: encodeMulticall(balancerExactOutItems(ctx, proof)),
        transport: "rpc-batch",
      }),
    ]);
  }
  return Object.freeze([]);
}

function decodeBalancerEclpProof(
  ctx: BalancerFallbackReadContext,
): BalancerEclpProof | null {
  try {
    const poolInfo = vaultIface.decodeFunctionResult(
      "getPoolTokenInfo",
      requireRead(
        ctx.priorResults,
        balancerPoolInfoReadId(ctx.stateKey),
      ).data,
    );
    const tokens = Array.from(poolInfo[0] as readonly string[]).map((token) =>
      ethers.getAddress(token).toLowerCase()
    );
    const outputIndex = tokens.indexOf(
      ethers.getAddress(ctx.edge.tokenOut).toLowerCase(),
    );
    if (outputIndex < 0) {
      return null;
    }

    const proofItems = balancerProofItems(ctx.edge);
    const proofResults = decodeMulticall(
      requireRead(
        ctx.priorResults,
        balancerProofReadId(ctx.stateKey),
      ),
      proofItems,
    );
    const dynamicData = optionalMulticallData(
      proofResults,
      "gyro-eclp-dynamic",
    );
    const tokenRatesData = optionalMulticallData(
      proofResults,
      "vault-pool-token-rates",
    );
    const hooksData = optionalMulticallData(
      proofResults,
      "vault-hooks-config",
    );
    const currentBalancesData = optionalMulticallData(
      proofResults,
      "vault-current-live-balances",
    );
    const factoryData = optionalMulticallData(
      proofResults,
      "gyro-eclp-factory",
    );
    const poolVaultData = optionalMulticallData(
      proofResults,
      "gyro-eclp-vault",
    );
    if (
      !dynamicData ||
      !tokenRatesData ||
      !hooksData ||
      !currentBalancesData ||
      !factoryData ||
      !poolVaultData
    ) {
      return null;
    }

    const dynamic = gyroEclpIface.decodeFunctionResult(
      "getGyroECLPPoolDynamicData",
      dynamicData,
    )[0] as readonly unknown[];
    const liveBalances = Array.from(dynamic[0] as readonly bigint[]).map(BigInt);
    const tokenRates = Array.from(dynamic[1] as readonly bigint[]).map(BigInt);
    const initialized = Boolean(dynamic[5]);
    const paused = Boolean(dynamic[6]);
    const recovery = Boolean(dynamic[7]);

    const tokenRatesResult = vaultIface.decodeFunctionResult(
      "getPoolTokenRates",
      tokenRatesData,
    );
    const decimalScalingFactors = Array.from(
      tokenRatesResult[0] as readonly bigint[],
    ).map(BigInt);
    const vaultTokenRates = Array.from(
      tokenRatesResult[1] as readonly bigint[],
    ).map(BigInt);
    const vaultLiveBalances = Array.from(
      vaultIface.decodeFunctionResult(
        "getCurrentLiveBalances",
        currentBalancesData,
      )[0] as readonly bigint[],
    ).map(BigInt);

    const hooks = vaultIface.decodeFunctionResult(
      "getHooksConfig",
      hooksData,
    )[0] as readonly unknown[];
    const hasSwapAlteringHooks =
      hooks.length !== 11 ||
      hooks.slice(0, 10).some((flag) => flag !== false) ||
      ethers.getAddress(String(hooks[10])) !== ethers.ZeroAddress;

    const fromCanonicalFactory = Boolean(
      poolFactoryIface.decodeFunctionResult(
        "isPoolFromFactory",
        factoryData,
      )[0],
    );
    const poolVault = ethers.getAddress(
      String(
        gyroEclpIface.decodeFunctionResult(
          "getVault",
          poolVaultData,
        )[0],
      ),
    );
    if (
      !fromCanonicalFactory ||
      poolVault !== ethers.getAddress(ADDR.BALANCER_V3_VAULT) ||
      hasSwapAlteringHooks ||
      !initialized ||
      paused ||
      recovery ||
      liveBalances.length !== tokens.length ||
      vaultLiveBalances.length !== tokens.length ||
      tokenRates.length !== tokens.length ||
      decimalScalingFactors.length !== tokens.length ||
      vaultTokenRates.length !== tokens.length ||
      liveBalances.some((balance, index) =>
        balance !== vaultLiveBalances[index]
      ) ||
      tokenRates.some((rate, index) =>
        rate !== vaultTokenRates[index]
      ) ||
      decimalScalingFactors.some((factor) => factor <= 0n) ||
      vaultTokenRates.some((rate) => rate <= 0n)
    ) {
      return null;
    }

    const minimumTradeAmount = BigInt(
      vaultIface.decodeFunctionResult(
        "getMinimumTradeAmount",
        requireRead(
          ctx.priorResults,
          balancerMinimumTradeReadId(),
        ).data,
      )[0],
    );
    const decimalScalingFactor = decimalScalingFactors[outputIndex];
    const tokenRate = vaultTokenRates[outputIndex];
    if (
      minimumTradeAmount <= 0n ||
      !decimalScalingFactor ||
      decimalScalingFactor <= 0n ||
      !tokenRate ||
      tokenRate <= 0n
    ) {
      return null;
    }
    const roundedRate = tokenRate % ONE_18 === 0n
      ? tokenRate
      : tokenRate + 1n;
    const minimumRawAmountOut =
      ((minimumTradeAmount - 1n) * ONE_18) /
        (decimalScalingFactor * roundedRate) +
      1n;
    if (minimumRawAmountOut <= 0n) return null;
    return Object.freeze({ minimumRawAmountOut });
  } catch {
    // An unknown ABI, malformed return, or failed proof read is not evidence
    // of unavailability. The original exact-in failure remains unresolved.
    return null;
  }
}

function decodeBalancerExactOut(
  ctx: BalancerFallbackReadContext,
  proof: BalancerEclpProof,
): BalancerExactOutResult | null {
  const read = ctx.priorResults.find(
    (result) => result.id === balancerExactOutReadId(ctx.stateKey),
  );
  if (!read?.ok) return null;
  try {
    const result = decodeMulticall(
      read,
      balancerExactOutItems(ctx, proof),
    ).get("minimum-exact-out");
    if (!result) return null;
    if (!result.success) {
      return result.returnData.toLowerCase() ===
          ASSET_BOUNDS_EXCEEDED_SELECTOR
        ? Object.freeze({ status: "asset-bounds" as const })
        : null;
    }
    const amountIn = BigInt(
      routerIface.decodeFunctionResult(
        "querySwapSingleTokenExactOut",
        result.returnData,
      )[0],
    );
    return amountIn > 0n
      ? Object.freeze({ status: "quote" as const, amountIn })
      : null;
  } catch {
    return null;
  }
}

function balancerExactOutItems(
  ctx: BalancerFallbackReadContext,
  proof: BalancerEclpProof,
): readonly MulticallItem[] {
  return Object.freeze([{
    label: "minimum-exact-out",
    target: ADDR.BALANCER_V3_ROUTER,
    callData: routerIface.encodeFunctionData(
      "querySwapSingleTokenExactOut",
      [
        ctx.edge.target,
        ctx.edge.tokenIn,
        ctx.edge.tokenOut,
        proof.minimumRawAmountOut,
        ethers.ZeroAddress,
        "0x",
      ],
    ),
    allowFailure: true,
  }]);
}

function balancerProofItems(
  edge: TokenEdge,
): readonly MulticallItem[] {
  return Object.freeze([
    {
      label: "vault-pool-token-rates",
      target: ADDR.BALANCER_V3_VAULT,
      callData: vaultIface.encodeFunctionData(
        "getPoolTokenRates",
        [edge.target],
      ),
      allowFailure: true,
    },
    {
      label: "vault-hooks-config",
      target: ADDR.BALANCER_V3_VAULT,
      callData: vaultIface.encodeFunctionData(
        "getHooksConfig",
        [edge.target],
      ),
      allowFailure: true,
    },
    {
      label: "vault-current-live-balances",
      target: ADDR.BALANCER_V3_VAULT,
      callData: vaultIface.encodeFunctionData(
        "getCurrentLiveBalances",
        [edge.target],
      ),
      allowFailure: true,
    },
    {
      label: "gyro-eclp-dynamic",
      target: edge.target,
      callData: gyroEclpIface.encodeFunctionData(
        "getGyroECLPPoolDynamicData",
      ),
      allowFailure: true,
    },
    {
      label: "gyro-eclp-factory",
      target: BALANCER_V3_GYRO_ECLP_FACTORY,
      callData: poolFactoryIface.encodeFunctionData(
        "isPoolFromFactory",
        [edge.target],
      ),
      allowFailure: true,
    },
    {
      label: "gyro-eclp-vault",
      target: edge.target,
      callData: gyroEclpIface.encodeFunctionData("getVault"),
      allowFailure: true,
    },
  ]);
}

function balancerProofReadId(stateKey: string): string {
  return `balancer-v3:${stateKey}:gyro-eclp-proof`;
}

function balancerMinimumTradeReadId(): string {
  return "balancer-v3:vault-minimum-trade";
}

function balancerExactOutReadId(stateKey: string): string {
  return `balancer-v3:${stateKey}:minimum-exact-out`;
}

export const balancerV3Adapter = Object.freeze({
  id: "balancer-v3",
  kind: "swap",
  poolAdapters: ["balancer-v3"],
  planExecutionIdentity: {
    resolve(node) {
      const swaps = node.children.filter((child) =>
        child.adapterId === "balancer-v3-swap"
      );
      if (swaps.length !== 1 || typeof swaps[0].params.pool !== "string") {
        throw new Error(
          "balancer-v3 resolved plan must contain one pool-bound swap child",
        );
      }
      return { routeTarget: swaps[0].params.pool };
    },
  },
  identityPolicies: [{
    poolAdapter: "balancer-v3",
    policy: "onchain-resolver",
    resolve: balancerV3IdentityResolver,
  }],
  edgeAdapterIds: ["balancer-v3-unlock"],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: [
    "balancer-v3-unlock",
    "balancer-v3-settle",
    "balancer-v3-swap",
    "balancer-v3-send-to",
  ],
  requiredInfraActionAdapterIds: ["erc20-transfer"],
  landedEvents: balancerV3LandedEvents,
  poolDiscovery: balancerV3PoolDiscovery,
  observation: createBalancerV3SwapObservation({
    adapterIds: ["balancer-v3-unlock"],
    canonicalIntakeTargets: [ADDR.BALANCER_V3_ROUTER, ADDR.BALANCER_V3_VAULT],
    landedEvents: balancerV3LandedEvents.swaps,
  }),
  victimModel: {
    id: "pool-swap:balancer-v3-detect-only",
    mode: "detect-only",
  },
  pricingState: balancerV3BlockScanState,
  prepared: null,

  buildEdges: buildBalancerV3Edges,
  quoteExact: quoteBalancerV3Exact,
  buildPlanFragment: buildBalancerV3PlanFragment,
} satisfies SwapAdapter);

function indexedAddress(topic: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(topic)) {
    throw new Error("invalid indexed address");
  }
  return ethers.getAddress(`0x${topic.slice(-40)}`);
}

function isBalancerV3DiscoveryLogMaterializable(
  log: LandedPoolDiscoveryLog,
): boolean {
  try {
    indexedAddress(log.topics[1] ?? "");
    indexedAddress(log.topics[2] ?? "");
    indexedAddress(log.topics[3] ?? "");
    return true;
  } catch {
    return false;
  }
}

function logBlockNumber(value: string | number): number {
  const parsed = typeof value === "number"
    ? value
    : value.startsWith("0x")
    ? parseInt(value, 16)
    : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function balancerPoolInfoReadId(stateKey: string): string {
  return `balancer-v3:${stateKey}:pool-token-info`;
}

export async function quoteBalancerV3(
  state: { call(req: { to: string; data: string }): Promise<string> },
  pool: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
): Promise<bigint> {
  const data = routerIface.encodeFunctionData("querySwapSingleTokenExactIn", [
    pool,
    tokenIn,
    tokenOut,
    amountIn,
    ethers.ZeroAddress,
    "0x",
  ]);
  const result = await state.call({ to: ADDR.BALANCER_V3_ROUTER, data });
  return BigInt(routerIface.decodeFunctionResult("querySwapSingleTokenExactIn", result)[0]);
}

async function buildBalancerV3Edges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const data = vaultIface.encodeFunctionData("getPoolTokens", [pool.address]);
  const result = await backend.call({ to: ADDR.BALANCER_V3_VAULT, data });
  const tokens = (vaultIface.decodeFunctionResult("getPoolTokens", result)[0] as string[])
    .map((token) => ethers.getAddress(token));
  if (tokens.length < 2) {
    throw new Error(`balancer-v3 pool ${pool.address} returned fewer than two tokens`);
  }
  const taxonomy = deriveEdgeTaxonomy("swap");
  const edges: TokenEdge[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = 0; j < tokens.length; j++) {
      if (i === j) continue;
      edges.push({
        adapterId: "balancer-v3-unlock",
        target: ethers.getAddress(pool.address),
        tokenIn: tokens[i],
        tokenOut: tokens[j],
        slotKind: "swap",
        score: pool.score,
        ...taxonomy,
      });
    }
  }
  return edges;
}

async function quoteBalancerV3Exact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, target, tokenIn, tokenOut, amountIn } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("balancer-v3 quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  return quoteBalancerV3(state, target, tokenIn, tokenOut, amountIn);
}

async function buildBalancerV3PlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, amountOut, rawOut } = ctx;
  const outputAmount = rawOut ?? amountOut;
  const vault = ADDR.BALANCER_V3_VAULT;
  return {
    requirements: [],
    nodes: [{
      adapterId: "balancer-v3-unlock",
      target: vault,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: 0n,
      params: {},
      children: [
        {
          adapterId: "erc20-transfer",
          target: edge.tokenIn,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenIn,
          amount: amountIn,
          params: { to: vault, amount: amountIn },
          children: [],
        },
        {
          adapterId: "balancer-v3-settle",
          target: vault,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenIn,
          amount: amountIn,
          params: { token: edge.tokenIn },
          children: [],
        },
        {
          adapterId: "balancer-v3-swap",
          target: vault,
          tokenIn: edge.tokenIn,
          tokenOut: edge.tokenOut,
          amount: amountIn,
          params: { kind: 0n, pool: edge.target, limitRaw: 0n, userData: "0x" },
          children: [],
        },
        {
          adapterId: "balancer-v3-send-to",
          target: vault,
          tokenIn: edge.tokenOut,
          tokenOut: edge.tokenOut,
          amount: outputAmount,
          params: { token: edge.tokenOut },
          children: [],
        },
      ],
    }],
  };
}
