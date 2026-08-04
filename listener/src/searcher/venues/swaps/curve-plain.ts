import { ethers } from "ethers";
import { isStateCallAbortedError } from "../../../shared/state/state-backend.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type { PoolEntry, TokenEdge, TokenQueryBackend } from "../../planner/token-graph.js";
import type { CurvePostImpactSeed } from "../../solver/pool-state-cache.js";
import {
  curveNgGetDy,
  curvePlainGetDy,
  type CurveNgState,
  type CurvePlainState,
} from "../../solver/curve-math.js";
import type {
  BlockScanStateCapability,
  StateReadResult,
} from "../blockscan-state-capability.js";
import type {
  ExactQuoteContext,
  PlanBuildContext,
  PlanFragment,
  PreparedRouteContext,
  PreparedRouteQuoteResult,
  SwapAdapter,
} from "../route-leg-adapter.js";
import {
  curveIdentityResolver,
  isRetryablePoolIdentityFailure,
} from "../identity.js";
import { createAddressLandedPoolMaterializer } from "../landed-pool-discovery.js";
import {
  curveNativeRateMultiplier,
  curveRateMultiplierFromDecimals,
} from "../curve-assets.js";
import {
  createCurveSwapObservation,
  type PoolImpact,
} from "../swap-observation.js";
import type {
  LocalVictimApplyContext,
  LocalVictimApplyResult,
  VictimOverlayBuildContext,
} from "../victim-runtime-capability.js";
import {
  buildApprovedSwapVictimOverlay,
  buildTransferredInputSwapVictimOverlay,
  VICTIM_REPLAY_WHALE,
} from "../victim-runtime-shared.js";
import {
  decodeCurveUint256Result,
  queryCurveCoins,
  quoteCurvePlain,
  resolveCurveIndices,
} from "./curve-shared.js";
import { curvePlainLandedEvents } from "./curve-landed-events.js";
import {
  assertPoolGroup,
  BLOCKSCAN_MULTICALL3,
  blockScanErc20Iface,
  canonicalPoolStateKey,
  currentBlockRead,
  decodeMulticall,
  encodeMulticall,
  midsForDirectedEdges,
  optionalMulticallData,
  quotedPoolMid,
  requireMulticallData,
  requireRead,
  type MulticallItem,
} from "./blockscan-state-shared.js";

const MAX_UINT = (1n << 256n) - 1n;
const curvePlainSwapObservation = createCurveSwapObservation({
  adapterIds: [
    "curve-exchange",
    "curve-exchange-nr",
    "curve-exchange-plain",
    "curve-exchange-received-uint",
  ],
  canonicalIntakeTargets: [
    "0x99a58482bd75cbab83b27ec03ca68ff489b5788f",
    "0x16c6521dff6bab339122a0fe25a9116693265353",
  ],
  landedEvents: curvePlainLandedEvents.swaps,
});
const curveIntIface = new ethers.Interface([
  "function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)",
]);
const curveUintIface = new ethers.Interface([
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
]);
const curveExchangeIface = new ethers.Interface([
  "function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);
const curveExchangeReceivedIface = new ethers.Interface([
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy, address receiver)",
]);
const curveExchangeReceivedUintIface = new ethers.Interface([
  "function exchange_received(uint256 i, uint256 j, uint256 dx, uint256 min_dy, address receiver)",
]);
const curveExchangeReceivedNoReceiverIface = new ethers.Interface([
  "function exchange_received(int128 i, int128 j, uint256 dx, uint256 min_dy)",
]);
const curveStateIface = new ethers.Interface([
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function offpeg_fee_multiplier() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function stored_rates() view returns (uint256[])",
]);
const curveIntBalanceIface = new ethers.Interface([
  "function balances(int128 i) view returns (uint256)",
]);

type CurveBalanceAbi = "uint256" | "int128";

interface CurvePoolStateSchema {
  readonly coins: readonly string[];
  readonly items: readonly MulticallItem[];
  readonly plainRates: readonly bigint[];
  readonly balanceAbi: CurveBalanceAbi | null;
}

interface CurveStateSchema {
  readonly pools: ReadonlyMap<string, CurvePoolStateSchema>;
}

type CurveCurrentState =
  | {
      readonly pool: string;
      readonly coins: readonly string[];
      readonly kind: "plain";
      readonly state: CurvePlainState;
    }
  | {
      readonly pool: string;
      readonly coins: readonly string[];
      readonly kind: "ng";
      readonly state: CurveNgState;
    };

const CURVE_PLAIN_EDGE_IDS = new Set([
  "curve-exchange",
  "curve-exchange-nr",
  "curve-exchange-plain",
  "curve-exchange-received-uint",
]);

const curvePlainPoolDiscovery = createAddressLandedPoolMaterializer({
  version: "curve-plain-address-metadata-v1",
  eventIds: ["curve-exchange-i128", "curve-exchange-uint"],
  async materializePool(candidate, context) {
    const identity = await curveIdentityResolver({
      backend: context.backend,
      pool: candidate.address,
      poolAdapter: "curve",
      candidate: {
        address: candidate.address,
        adapter: "curve",
      },
      admissionPolicy: context.admissionPolicy,
      isPoolAdapterSupported: (poolAdapter) =>
        poolAdapter === "curve" || poolAdapter === "curve-nr",
    });
    if (!identity.ok) {
      if (isRetryablePoolIdentityFailure(identity.reason)) {
        throw new Error(`Curve identity read incomplete: ${identity.reason}`);
      }
      return null;
    }
    let coins: string[];
    try {
      coins = await queryCurveCoins(context.backend, candidate.address);
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
      if (/exposed no coins/i.test(
        error instanceof Error ? error.message : String(error),
      )) {
        return null;
      }
      throw error;
    }
    return {
      address: candidate.address,
      adapter: identity.adapter,
      venueId: identity.venueId,
      identitySource: identity.identitySource,
      ...(identity.factory === undefined ? {} : { factory: identity.factory }),
      underlyingCoins: coins,
    };
  },
});

export const curvePlainBlockScanState = Object.freeze({
  stateKey: canonicalPoolStateKey,

  compileStaticSchema({ edges }) {
    const indexedCoins = new Map<string, Map<number, string>>();
    for (const edge of edges) {
      const pool = canonicalPoolStateKey(edge);
      if (
        !CURVE_PLAIN_EDGE_IDS.has(edge.adapterId) ||
        edge.curveI === undefined ||
        edge.curveJ === undefined
      ) {
        throw new Error(`curve block-scan edge ${pool} is missing graph indices`);
      }
      const indices = indexedCoins.get(pool) ?? new Map<number, string>();
      addCurveCoin(indices, edge.curveI, edge.tokenIn, pool);
      addCurveCoin(indices, edge.curveJ, edge.tokenOut, pool);
      indexedCoins.set(pool, indices);
    }

    const pools = new Map<string, {
      coins: readonly string[];
      items: readonly MulticallItem[];
      plainRates: readonly bigint[];
      balanceAbi: CurveBalanceAbi | null;
    }>();
    for (const [pool, indexed] of indexedCoins) {
      const coins = contiguousCurveCoins(indexed, pool);
      const items: MulticallItem[] = [
        {
          label: "A",
          target: pool,
          callData: curveStateIface.encodeFunctionData("A"),
          allowFailure: true,
        },
        {
          label: "fee",
          target: pool,
          callData: curveStateIface.encodeFunctionData("fee"),
          allowFailure: true,
        },
        {
          label: "offpeg",
          target: pool,
          callData: curveStateIface.encodeFunctionData("offpeg_fee_multiplier"),
          allowFailure: true,
        },
        {
          label: "stored-rates",
          target: pool,
          callData: curveStateIface.encodeFunctionData("stored_rates"),
          allowFailure: true,
        },
      ];
      pools.set(pool, Object.freeze({
        coins: Object.freeze(coins),
        items: Object.freeze(items),
        plainRates: Object.freeze([]),
        balanceAbi: null,
      }));
    }
    return Object.freeze({ pools });
  },

  buildStaticSchemaReads({ sourceBlock, sourceBlockHash, schema }) {
    const tokens = [
      ...new Set(
        [...schema.pools.values()]
          .flatMap((descriptor) => descriptor.coins)
          .map((token) => ethers.getAddress(token).toLowerCase()),
      ),
    ]
      .filter((token) => curveNativeRateMultiplier(token) === null)
      .sort();
    const decimalsReads = tokens.map((token) => currentBlockRead({
      id: `curve-decimals:${token}`,
      sourceBlock,
      sourceBlockHash,
      to: token,
      data: blockScanErc20Iface.encodeFunctionData("decimals"),
    }));
    const balanceAbiReads = [...schema.pools.keys()].map((pool) =>
      currentBlockRead({
        id: curveBalanceAbiReadId(pool),
        sourceBlock,
        sourceBlockHash,
        to: BLOCKSCAN_MULTICALL3,
        data: encodeMulticall(curveBalanceAbiProbeItems(pool)),
        transport: "multicall-safe",
      })
    );
    return Object.freeze([...decimalsReads, ...balanceAbiReads]);
  },

  hydrateStaticSchema(schema, results) {
    const byToken = new Map<string, bigint>();
    for (const result of results) {
      if (!result.id.startsWith("curve-decimals:")) continue;
      if (!result.ok) {
        throw new Error(`curve static decimals unresolved ${result.id}`);
      }
      const token = result.id.slice("curve-decimals:".length);
      const decimals = Number(
        blockScanErc20Iface.decodeFunctionResult("decimals", result.data)[0],
      );
      byToken.set(token, curveRateMultiplierFromDecimals(decimals));
    }
    const pools = new Map();
    for (const [pool, descriptor] of schema.pools) {
      const balanceAbi = decodeCurveBalanceAbi(pool, results);
      const balanceIface = balanceAbi === "int128"
        ? curveIntBalanceIface
        : curveStateIface;
      const items = [
        ...descriptor.items,
        ...descriptor.coins.map((_, index) => ({
          label: `balance:${index}`,
          target: pool,
          callData: balanceIface.encodeFunctionData("balances", [index]),
          allowFailure: true,
        })),
      ];
      const plainRates = descriptor.coins.map((coin) => {
        const rate =
          curveNativeRateMultiplier(coin) ??
          byToken.get(coin.toLowerCase());
        if (!rate) throw new Error(`curve static decimals missing ${coin}`);
        return rate;
      });
      pools.set(pool, Object.freeze({
        ...descriptor,
        items: Object.freeze(items),
        plainRates: Object.freeze(plainRates),
        balanceAbi,
      }));
    }
    return Object.freeze({ pools });
  },

  buildCurrentBlockReads({ sourceBlock, sourceBlockHash, schema, edges }) {
    const pool = assertPoolGroup(edges, CURVE_PLAIN_EDGE_IDS);
    const descriptor = schema.pools.get(pool);
    if (!descriptor) throw new Error(`curve block-scan schema missing ${pool}`);
    return Object.freeze([
      currentBlockRead({
        id: `curve:${pool}`,
        sourceBlock,
        sourceBlockHash,
        to: BLOCKSCAN_MULTICALL3,
        data: encodeMulticall(descriptor.items),
        transport: "multicall-safe",
      }),
    ]);
  },

  buildDependentBlockReads({
    sourceBlock,
    sourceBlockHash,
    schema,
    edges,
    priorResults,
  }) {
    const pool = assertPoolGroup(edges, CURVE_PLAIN_EDGE_IDS);
    const descriptor = schema.pools.get(pool);
    if (!descriptor) throw new Error(`curve block-scan schema missing ${pool}`);
    const inner = decodeMulticall(
      requireRead(priorResults, `curve:${pool}`),
      descriptor.items,
    );
    if (
      !optionalMulticallData(inner, "offpeg") ||
      optionalMulticallData(inner, "stored-rates")
    ) {
      return Object.freeze([]);
    }
    if (
      priorResults.some(
        (result) => result.id === curveFallbackWitnessReadId(pool),
      )
    ) {
      return Object.freeze([]);
    }
    const witnesses = curveFallbackWitnesses(descriptor.plainRates);
    return Object.freeze([
      currentBlockRead({
        id: curveFallbackWitnessReadId(pool),
        sourceBlock,
        sourceBlockHash,
        to: BLOCKSCAN_MULTICALL3,
        data: encodeMulticall(
          curveFallbackWitnessItems(pool, witnesses),
        ),
        transport: "multicall-safe",
      }),
    ]);
  },

  decodeState(schema, results) {
    const pool = statePoolFromResults(results, "curve:");
    const descriptor = schema.pools.get(pool);
    if (!descriptor) throw new Error(`curve block-scan schema missing ${pool}`);
    const inner = decodeMulticall(
      requireRead(results, `curve:${pool}`),
      descriptor.items,
    );
    const A = decodeCurveUint256Result(
      requireMulticallData(inner, "A"),
      `curve ${pool} A`,
    );
    const fee = decodeCurveUint256Result(
      requireMulticallData(inner, "fee"),
      `curve ${pool} fee`,
    );
    const balances = descriptor.coins.map((_, index) =>
      decodeCurveUint256Result(
        requireMulticallData(inner, `balance:${index}`),
        `curve ${pool} balance ${index}`,
      )
    );
    if (balances.some((balance) => balance <= 0n)) {
      throw new Error(`curve block-scan pool ${pool} has non-positive balance`);
    }

    const offpegData = optionalMulticallData(inner, "offpeg");
    if (offpegData) {
      const ratesData = optionalMulticallData(inner, "stored-rates");
      const rates = ratesData
        ? (
            curveStateIface.decodeFunctionResult("stored_rates", ratesData)[0] as bigint[]
          ).map(BigInt)
        : descriptor.plainRates;
      if (
        rates.length !== descriptor.coins.length ||
        rates.some((rate) => rate <= 0n)
      ) {
        throw new Error(
          `curve dynamic-fee block-scan pool ${pool} returned no usable rates`,
        );
      }
      const state = Object.freeze({
        A,
        fee,
        offpegFeeMultiplier: decodeCurveUint256Result(
          offpegData,
          `curve ${pool} offpeg_fee_multiplier`,
        ),
        balances: Object.freeze(balances) as unknown as bigint[],
        rates: Object.freeze([...rates]) as unknown as bigint[],
      });
      if (!ratesData) {
        assertCurveFallbackWitness(pool, state, descriptor, results);
      }
      return Object.freeze({
        pool,
        coins: descriptor.coins,
        kind: "ng" as const,
        state,
      });
    }

    const rates = descriptor.plainRates;
    if (
      rates.length !== descriptor.coins.length ||
      rates.some((rate) => rate <= 0n)
    ) {
      throw new Error(`curve block-scan static rates unresolved for ${pool}`);
    }
    return Object.freeze({
      pool,
      coins: descriptor.coins,
      kind: "plain" as const,
      state: Object.freeze({
        A,
        fee,
        balances: Object.freeze(balances) as unknown as bigint[],
        rates: Object.freeze(rates) as unknown as bigint[],
      }),
    });
  },

  deriveMids(snapshot, edges) {
    return midsForDirectedEdges(edges, (edge) => {
      if (
        canonicalPoolStateKey(edge) !== snapshot.pool ||
        edge.curveI === undefined ||
        edge.curveJ === undefined
      ) {
        throw new Error(`curve snapshot ${snapshot.pool} does not match edge`);
      }
      if (
        snapshot.coins[edge.curveI]?.toLowerCase() !== edge.tokenIn.toLowerCase() ||
        snapshot.coins[edge.curveJ]?.toLowerCase() !== edge.tokenOut.toLowerCase()
      ) {
        throw new Error(`curve edge indices do not match snapshot ${snapshot.pool}`);
      }
      const reserveIn = snapshot.state.balances[edge.curveI];
      const reserveOut = snapshot.state.balances[edge.curveJ];
      let amountIn = reserveIn / 1_000_000n > 0n
        ? reserveIn / 1_000_000n
        : 1n;
      const maxProbe = reserveIn / 100n > 0n ? reserveIn / 100n : reserveIn;
      let amountOut = 0n;
      while (amountIn > 0n && amountIn <= maxProbe) {
        amountOut = snapshot.kind === "plain"
          ? curvePlainGetDy(snapshot.state, edge.curveI, edge.curveJ, amountIn)
          : curveNgGetDy(snapshot.state, edge.curveI, edge.curveJ, amountIn);
        if (amountOut > 0n) break;
        const next = amountIn * 10n;
        amountIn = next > maxProbe ? maxProbe : next;
        if (amountIn === maxProbe && amountOut === 0n) {
          amountOut = snapshot.kind === "plain"
            ? curvePlainGetDy(snapshot.state, edge.curveI, edge.curveJ, amountIn)
            : curveNgGetDy(snapshot.state, edge.curveI, edge.curveJ, amountIn);
          break;
        }
      }
      return quotedPoolMid({
        kind: "curve",
        edge,
        amountIn,
        amountOut,
        depthIn: reserveIn,
        depthOut: reserveOut,
      });
    });
  },

  dependencies(edges) {
    const pool = assertPoolGroup(edges, CURVE_PLAIN_EDGE_IDS);
    return Object.freeze([
      pool,
      ...new Set(edges.flatMap((edge) => [edge.tokenIn, edge.tokenOut])),
    ]);
  },
} satisfies BlockScanStateCapability<CurveStateSchema, CurveCurrentState>);

function curveBalanceAbiReadId(pool: string): string {
  return `curve-balance-abi:${ethers.getAddress(pool).toLowerCase()}`;
}

function curveBalanceAbiProbeItems(pool: string): readonly MulticallItem[] {
  return Object.freeze([
    {
      label: "uint256",
      target: pool,
      callData: curveStateIface.encodeFunctionData("balances", [0]),
      allowFailure: true,
    },
    {
      label: "int128",
      target: pool,
      callData: curveIntBalanceIface.encodeFunctionData("balances", [0]),
      allowFailure: true,
    },
  ]);
}

function decodeCurveBalanceAbi(
  pool: string,
  results: readonly StateReadResult[],
): CurveBalanceAbi {
  const items = curveBalanceAbiProbeItems(pool);
  const decoded = decodeMulticall(
    requireRead(results, curveBalanceAbiReadId(pool)),
    items,
  );
  const uintData = optionalMulticallData(decoded, "uint256");
  const intData = optionalMulticallData(decoded, "int128");
  if (!uintData && !intData) {
    throw new Error(`curve pool ${pool} exposes no supported balances getter`);
  }
  if (
    uintData &&
    intData &&
    decodeCurveUint256Result(uintData, `curve ${pool} balances(uint256)`) !==
      decodeCurveUint256Result(intData, `curve ${pool} balances(int128)`)
  ) {
    throw new Error(`curve pool ${pool} returned ambiguous balance getters`);
  }
  return uintData ? "uint256" : "int128";
}

function curveFallbackWitnessReadId(pool: string): string {
  return `curve-fallback-witness:${pool}`;
}

function curveFallbackProbeAmount(rate: bigint): bigint {
  const scale = 10n ** 36n;
  if (rate <= 0n || scale % rate !== 0n) {
    throw new Error(`curve fallback rate ${rate} has no exact one-token probe`);
  }
  const amount = scale / rate;
  if (amount <= 0n) throw new Error("curve fallback probe amount is zero");
  return amount;
}

function curveFallbackWitnessItems(
  pool: string,
  witnesses: readonly CurveFallbackWitness[],
): readonly MulticallItem[] {
  return Object.freeze(witnesses.flatMap(({ i, j, amountIn }) => {
    const args = [BigInt(i), BigInt(j), amountIn] as const;
    return [
      {
        label: `int128:${i}:${j}`,
        target: pool,
        callData: curveIntIface.encodeFunctionData("get_dy", args),
        allowFailure: true,
      },
      {
        label: `uint256:${i}:${j}`,
        target: pool,
        callData: curveUintIface.encodeFunctionData("get_dy", args),
        allowFailure: true,
      },
    ];
  }));
}

function assertCurveFallbackWitness(
  pool: string,
  state: CurveNgState,
  descriptor: CurvePoolStateSchema,
  results: readonly StateReadResult[],
): void {
  if (descriptor.coins.length < 2) {
    throw new Error(`curve fallback pool ${pool} has fewer than two coins`);
  }
  const witnesses = curveFallbackWitnesses(descriptor.plainRates);
  const decoded = decodeMulticall(
    requireRead(results, curveFallbackWitnessReadId(pool)),
    curveFallbackWitnessItems(pool, witnesses),
  );
  for (const { i, j, amountIn } of witnesses) {
    const intData = optionalMulticallData(decoded, `int128:${i}:${j}`);
    const uintData = optionalMulticallData(decoded, `uint256:${i}:${j}`);
    if (!intData && !uintData) {
      throw new Error(
        `curve fallback pool ${pool} has no executable get_dy ${i}->${j}`,
      );
    }
    const intOut = intData
      ? BigInt(curveIntIface.decodeFunctionResult("get_dy", intData)[0])
      : null;
    const uintOut = uintData
      ? BigInt(curveUintIface.decodeFunctionResult("get_dy", uintData)[0])
      : null;
    if (intOut !== null && uintOut !== null && intOut !== uintOut) {
      throw new Error(
        `curve fallback pool ${pool} returned ambiguous get_dy ${i}->${j}`,
      );
    }
    const onchain = intOut ?? uintOut!;
    const local = curveNgGetDy(state, i, j, amountIn);
    const difference = local > onchain ? local - onchain : onchain - local;
    if (onchain <= 0n || local <= 0n || difference > 2n) {
      throw new Error(
        `curve fallback pool ${pool} failed local get_dy witness ${i}->${j}: ` +
          `local=${local} onchain=${onchain} diff=${difference}`,
      );
    }
  }
}

interface CurveFallbackWitness {
  readonly i: number;
  readonly j: number;
  readonly amountIn: bigint;
}

function curveFallbackWitnesses(
  rates: readonly bigint[],
): readonly CurveFallbackWitness[] {
  const witnesses: CurveFallbackWitness[] = [];
  for (let i = 0; i < rates.length; i++) {
    for (let j = 0; j < rates.length; j++) {
      if (i === j) continue;
      witnesses.push(Object.freeze({
        i,
        j,
        amountIn: curveFallbackProbeAmount(rates[i]),
      }));
    }
  }
  return Object.freeze(witnesses);
}

export const curvePlainAdapter = Object.freeze({
  id: "curve-plain",
  kind: "swap",
  poolAdapters: ["curve", "curve-nr"],
  identityPolicies: [
    { poolAdapter: "curve", policy: "onchain-resolver", resolve: curveIdentityResolver },
    { poolAdapter: "curve-nr", policy: "onchain-resolver", resolve: curveIdentityResolver },
  ],
  edgeAdapterIds: [
    "curve-exchange",
    "curve-exchange-nr",
    "curve-exchange-plain",
    "curve-exchange-received-uint",
  ],
  allowedTaxonomy: [{ slotKind: "swap" }],
  requiresProtocolEdgesFlag: false,
  ownedActionAdapterIds: ["curve-exchange-plain"],
  requiredInfraActionAdapterIds: ["erc20-approve"],
  landedEvents: curvePlainLandedEvents,
  poolDiscovery: curvePlainPoolDiscovery,
  observation: curvePlainSwapObservation,
  victimModel: {
    id: "pool-swap:curve",
    mode: "replay",
    runtime: {
      localApply: {
        cacheBacked: true,
        needsMutablePoolRefresh: false,
        apply: applyCurveVictim,
      },
      exactPostImpact: null,
      buildOverlay: buildCurveVictimOverlay,
    },
  },
  pricingState: curvePlainBlockScanState,
  prepared: {
    quote: quoteCurvePlainPrepared,
    quoteUnsupportedReason: null,
    encodeQuotePrewarm: async (ctx: PreparedRouteContext) => {
      const [i, j] = preparedCurveIndices(ctx);
      const args = [BigInt(i), BigInt(j), ctx.request.amountIn] as const;
      return [
        {
          from: ethers.ZeroAddress,
          to: ctx.request.target,
          calldata: curveIntIface.encodeFunctionData("get_dy", args),
          gasLimit: 3_000_000,
        },
        {
          from: ethers.ZeroAddress,
          to: ctx.request.target,
          calldata: curveUintIface.encodeFunctionData("get_dy", args),
          gasLimit: 3_000_000,
        },
      ];
    },
    allowanceSpender: (request) => ethers.getAddress(request.target),
    prewarmAddresses: () => [],
  },

  buildEdges: buildCurvePlainEdges,
  quoteExact: quoteCurvePlainExact,
  buildPlanFragment: buildCurvePlainPlanFragment,
} satisfies SwapAdapter);

async function applyCurveVictim(
  ctx: LocalVictimApplyContext,
): Promise<LocalVictimApplyResult | null> {
  const { cache, impact, blockNumber, state } = ctx;
  let pre = cache.snapshotCurve(impact.pool, blockNumber);
  if (!pre && state) {
    try {
      await cache.quoteCurve(
        state,
        impact.pool,
        impact.tokenIn,
        impact.tokenOut,
        impact.amountIn,
      );
      pre = cache.snapshotCurve(impact.pool, blockNumber);
    } catch {
      return null;
    }
  }
  if (!pre) return null;

  const i = pre.coins.indexOf(impact.tokenIn.toLowerCase());
  const j = pre.coins.indexOf(impact.tokenOut.toLowerCase());
  if (i < 0 || j < 0) return null;

  const amountOut = pre.kind === "plain"
    ? curvePlainGetDy(pre.plain!, i, j, impact.amountIn)
    : curveNgGetDy(pre.ng!, i, j, impact.amountIn);
  if (amountOut <= 0n) return null;

  const postImpact: CurvePostImpactSeed = {
    kind: "curve",
    pool: impact.pool,
    curveKind: pre.kind,
    coins: [...pre.coins],
    blockNumber,
  };
  if (pre.kind === "plain") {
    const plain = {
      A: pre.plain!.A,
      fee: pre.plain!.fee,
      balances: [...pre.plain!.balances],
      rates: [...pre.plain!.rates],
    };
    if (amountOut >= plain.balances[j]) return null;
    plain.balances[i] += impact.amountIn;
    plain.balances[j] -= amountOut;
    postImpact.plain = plain;
  } else {
    const ng = {
      A: pre.ng!.A,
      fee: pre.ng!.fee,
      offpegFeeMultiplier: pre.ng!.offpegFeeMultiplier,
      balances: [...pre.ng!.balances],
      rates: [...pre.ng!.rates],
    };
    if (amountOut >= ng.balances[j]) return null;
    ng.balances[i] += impact.amountIn;
    ng.balances[j] -= amountOut;
    postImpact.ng = ng;
  }
  return { postImpact, amountOut };
}

async function buildCurveVictimOverlay(
  ctx: VictimOverlayBuildContext,
) {
  const edge = ctx.graph.find(
    (candidate) =>
      candidate.adapterId === ctx.impact.matchedAdapterId &&
      candidate.target.toLowerCase() === ctx.impact.pool.toLowerCase() &&
      candidate.tokenIn.toLowerCase() === ctx.impact.tokenIn.toLowerCase() &&
      candidate.tokenOut.toLowerCase() === ctx.impact.tokenOut.toLowerCase() &&
      candidate.curveI !== undefined,
  );
  if (!edge || edge.curveI === undefined || edge.curveJ === undefined) {
    throw new Error(`overlay: no curve edge for ${ctx.impact.pool}`);
  }
  const pool = ethers.getAddress(ctx.impact.pool);
  const args = [edge.curveI, edge.curveJ, ctx.impact.amountIn, 0] as const;
  if (ctx.impact.matchedAdapterId === "curve-exchange") {
    return buildTransferredInputSwapVictimOverlay({
      impact: ctx.impact,
      inputRecipient: pool,
      swapTarget: pool,
      swapCalldata: curveExchangeReceivedIface.encodeFunctionData(
        "exchange_received",
        [...args, VICTIM_REPLAY_WHALE],
      ),
      gasLimit: 0x1000000,
    });
  }
  if (ctx.impact.matchedAdapterId === "curve-exchange-received-uint") {
    return buildTransferredInputSwapVictimOverlay({
      impact: ctx.impact,
      inputRecipient: pool,
      swapTarget: pool,
      swapCalldata: curveExchangeReceivedUintIface.encodeFunctionData(
        "exchange_received",
        [...args, VICTIM_REPLAY_WHALE],
      ),
      gasLimit: 0x1000000,
    });
  }
  if (ctx.impact.matchedAdapterId === "curve-exchange-nr") {
    return buildTransferredInputSwapVictimOverlay({
      impact: ctx.impact,
      inputRecipient: pool,
      swapTarget: pool,
      swapCalldata: curveExchangeReceivedNoReceiverIface.encodeFunctionData(
        "exchange_received",
        args,
      ),
      gasLimit: 0x1000000,
    });
  }
  if (ctx.impact.matchedAdapterId !== "curve-exchange-plain") {
    throw new Error(
      `overlay: unsupported Curve adapter ${ctx.impact.matchedAdapterId}`,
    );
  }
  return buildApprovedSwapVictimOverlay({
    impact: ctx.impact,
    approveTarget: pool,
    swapTarget: pool,
    swapCalldata: curveExchangeIface.encodeFunctionData("exchange", [
      edge.curveI,
      edge.curveJ,
      ctx.impact.amountIn,
      0,
    ]),
    gasLimit: 0x1000000,
  });
}

async function quoteCurvePlainPrepared(
  ctx: PreparedRouteContext,
): Promise<PreparedRouteQuoteResult> {
  const [i, j] = preparedCurveIndices(ctx);
  const args = [BigInt(i), BigInt(j), ctx.request.amountIn] as const;
  try {
    const quoted = await ctx.callPrepared(
      ctx.request.target,
      curveIntIface.encodeFunctionData("get_dy", args),
    );
    return {
      amountOut: BigInt(curveIntIface.decodeFunctionResult("get_dy", quoted.output)[0]),
      latencyMs: quoted.latencyMs,
      cacheStats: quoted.cacheStats,
    };
  } catch {
    const quoted = await ctx.callPrepared(
      ctx.request.target,
      curveUintIface.encodeFunctionData("get_dy", args),
    );
    return {
      amountOut: BigInt(curveUintIface.decodeFunctionResult("get_dy", quoted.output)[0]),
      latencyMs: quoted.latencyMs,
      cacheStats: quoted.cacheStats,
    };
  }
}

function preparedCurveIndices(ctx: PreparedRouteContext): [number, number] {
  if (ctx.edge?.curveI === undefined || ctx.edge.curveJ === undefined) {
    throw new Error(`revm curve quote missing graph indices for ${ctx.request.target}`);
  }
  return [ctx.edge.curveI, ctx.edge.curveJ];
}

async function buildCurvePlainEdges(
  pool: PoolEntry,
  backend: TokenQueryBackend,
): Promise<TokenEdge[]> {
  const coins = await queryCurveCoins(backend, pool.address);
  const adapterId = pool.adapter === "curve-nr" ? "curve-exchange-nr" : "curve-exchange-plain";
  const taxonomy = deriveEdgeTaxonomy("swap");
  const edges: TokenEdge[] = [];
  for (let i = 0; i < coins.length; i++) {
    for (let j = 0; j < coins.length; j++) {
      if (i === j) continue;
      edges.push({
        adapterId,
        target: pool.address,
        tokenIn: coins[i],
        tokenOut: coins[j],
        slotKind: "swap",
        curveI: i,
        curveJ: j,
        score: pool.score,
        ...taxonomy,
      });
    }
  }
  return edges;
}

async function quoteCurvePlainExact(ctx: ExactQuoteContext): Promise<bigint> {
  const { state, target, tokenIn, tokenOut, amountIn, cache } = ctx;
  if (!tokenIn || !tokenOut) throw new Error("curve quote requires tokenIn/tokenOut");
  if (amountIn <= 0n) return 0n;
  if (cache) {
    try {
      return await cache.quoteCurve(state, target, tokenIn, tokenOut, amountIn);
    } catch (error) {
      if (isStateCallAbortedError(error)) throw error;
      // Pools outside the warmed local-math domain retain the get_dy fallback.
    }
  }
  return quoteCurvePlain(state, target, tokenIn, tokenOut, amountIn);
}

async function buildCurvePlainPlanFragment(ctx: PlanBuildContext): Promise<PlanFragment> {
  const { edge, amountIn, state } = ctx;
  const [i, j] = await resolveCurveIndices(state, edge.target, edge.tokenIn, edge.tokenOut);
  return {
    requirements: [{
      kind: "approve",
      token: edge.tokenIn,
      spender: edge.target,
      amount: MAX_UINT,
    }],
    nodes: [{
      adapterId: "curve-exchange-plain",
      target: edge.target,
      tokenIn: edge.tokenIn,
      tokenOut: edge.tokenOut,
      amount: amountIn,
      params: { i: BigInt(i), j: BigInt(j), minDy: 0n },
      children: [],
    }],
  };
}

function addCurveCoin(
  indexed: Map<number, string>,
  index: number,
  token: string,
  pool: string,
): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`curve block-scan pool ${pool} has invalid coin index ${index}`);
  }
  const normalized = ethers.getAddress(token);
  const existing = indexed.get(index);
  if (existing && existing !== normalized) {
    throw new Error(`curve block-scan pool ${pool} has conflicting coin ${index}`);
  }
  indexed.set(index, normalized);
}

function contiguousCurveCoins(
  indexed: ReadonlyMap<number, string>,
  pool: string,
): string[] {
  const indices = [...indexed.keys()].sort((a, b) => a - b);
  if (
    indices.length < 2 ||
    indices.some((index, position) => index !== position)
  ) {
    throw new Error(`curve block-scan pool ${pool} has non-contiguous coin indices`);
  }
  return indices.map((index) => indexed.get(index)!);
}

function statePoolFromResults(
  results: readonly StateReadResult[],
  prefix: string,
): string {
  const read = results.find((candidate) => candidate.id.startsWith(prefix));
  if (!read) throw new Error(`missing block-scan read prefix ${prefix}`);
  return read.id.slice(prefix.length);
}
