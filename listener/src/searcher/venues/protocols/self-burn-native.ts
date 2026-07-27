import { ethers } from "ethers";
import { ADDR } from "../../../shared/constants/addresses.js";
import type {
  PoolEntry,
  TokenEdge,
  TokenQueryBackend,
} from "../../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../../strategy-taxonomy.js";
import type {
  BlockScanStateCapability,
  BuildCurrentBlockReadsInput,
  StateRead,
  StateReadResult,
} from "../blockscan-state-capability.js";
import { blockScanEdgeKey } from "../blockscan-state-capability.js";
import type {
  ExactQuoteContext,
  ProtocolConversionAdapter,
} from "../route-leg-adapter.js";
import {
  protocolMid,
  tokenDecimalsStateRead,
} from "./protocol-state-framework.js";
import {
  SELF_BURN_NATIVE_EDGE_ADAPTER,
  SELF_BURN_NATIVE_IDENTITY_SOURCE,
  SELF_BURN_NATIVE_POOL_ADAPTER,
  SELF_BURN_NATIVE_VENUE,
  SYNTHETIC_NATIVE_TRANSFER_EMITTER,
  selfBurnNativeDiscovery,
  selfBurnNativeIdentityResolver,
  selfBurnNativeInstanceId,
  selfBurnNativeProbeAmounts,
} from "./self-burn-native-discovery.js";

const erc20 = new ethers.Interface([
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const PRICING_CALLER = ethers.getAddress(`0x${"00".repeat(18)}b10c`);
const BALANCE_PROBE_VALUE = 0x51f_ba11n;
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)").toLowerCase();

interface SelfBurnNativeInstanceSchema {
  readonly token: string;
  readonly caller: string;
  readonly amountIns: readonly bigint[];
  readonly balanceSlotCandidates: readonly string[];
  readonly staticIssue?: string;
}

interface SelfBurnNativeSchema {
  readonly instances: readonly SelfBurnNativeInstanceSchema[];
}

interface SelfBurnNativeSnapshot {
  readonly token: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}

const pricingStateDefinition: BlockScanStateCapability<
  SelfBurnNativeSchema,
  SelfBurnNativeSnapshot
> = {
  stateKey(edge) {
    requireOwnedEdge(edge);
    return edge.target.toLowerCase();
  },

  compileStaticSchema({ edges, signal, deadlineAtMs }) {
    if (signal.aborted) throw signal.reason;
    if (Date.now() >= deadlineAtMs) {
      throw new Error("self-burn-native schema deadline expired");
    }
    if (edges.length === 0) throw new Error("self-burn-native owns no edges");
    for (const edge of edges) requireOwnedEdge(edge);
    const tokens = [...new Set(
      edges.map((edge) => ethers.getAddress(edge.target).toLowerCase()),
    )].sort();
    return Object.freeze({
      instances: Object.freeze(tokens.map((token) => Object.freeze({
        token: ethers.getAddress(token),
        caller: PRICING_CALLER,
        amountIns: Object.freeze([]),
        balanceSlotCandidates: Object.freeze([]),
      }))),
    });
  },

  buildStaticSchemaReads(input): readonly StateRead[] {
    return Object.freeze(input.schema.instances.flatMap((instance) => {
      const balanceData = erc20.encodeFunctionData("balanceOf", [
        instance.caller,
      ]);
      return [
        tokenDecimalsStateRead(input, instance.token),
        Object.freeze({
          id: `balance-access-list:${instance.token.toLowerCase()}`,
          sourceBlock: input.sourceBlock,
          sourceBlockHash: input.sourceBlockHash,
          to: instance.token,
          from: instance.caller,
          data: balanceData,
          transport: "eth-create-access-list" as const,
        }),
      ];
    }));
  },

  hydrateStaticSchema(schema, results) {
    return Object.freeze({
      instances: Object.freeze(schema.instances.map((instance) =>
        hydrateInstanceSchema(instance, results)
      )),
    });
  },

  buildCurrentBlockReads(input): readonly StateRead[] {
    const instance = schemaForEdges(input.schema, input.edges);
    return Object.freeze(
      instance.balanceSlotCandidates.map((slot, index) =>
        balanceSlotVerificationRead(input, instance, slot, index)
      ),
    );
  },

  buildDependentBlockReads(input): readonly StateRead[] {
    if (input.completedRound !== 0) return Object.freeze([]);
    const instance = schemaForEdges(input.schema, input.edges);
    const matches = instance.balanceSlotCandidates.filter((_slot, index) => {
      const result = input.priorResults.find(
        (item) =>
          item.id === `balance-slot:${instance.token.toLowerCase()}:${index}`,
      );
      if (!result?.ok) return false;
      try {
        const [call] = simulationCalls(decodeJsonResult(result.data));
        return call?.status === 1 &&
          BigInt(call.returnData) === BALANCE_PROBE_VALUE;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      throw new Error(
        `self-burn-native balance slot proof expected one match, got ${matches.length}`,
      );
    }
    return Object.freeze(
      instance.amountIns.map((amountIn, index) =>
        fullPricingSimulationRead(
          input,
          instance,
          matches[0],
          amountIn,
          index,
        )
      ),
    );
  },

  decodeState(schema, results) {
    const instance = schema.instances.find((candidate) =>
      results.some((result) =>
        result.id.startsWith(
          `self-burn-native-quote:${candidate.token.toLowerCase()}:`,
        )
      )
    );
    if (!instance) {
      throw new Error("self-burn-native state results omitted instance");
    }
    for (const [index, amountIn] of instance.amountIns.entries()) {
      const result = results.find(
        (item) =>
          item.id ===
            `self-burn-native-quote:${instance.token.toLowerCase()}:${index}`,
      );
      if (!result?.ok) continue;
      try {
        const calls = simulationCalls(decodeJsonResult(result.data));
        if (calls.length !== 5 || calls.some((call) => call.status !== 1)) {
          continue;
        }
        const balanceBefore = BigInt(calls[0].returnData);
        const supplyBefore = BigInt(calls[1].returnData);
        const balanceAfter = BigInt(calls[3].returnData);
        const supplyAfter = BigInt(calls[4].returnData);
        if (
          balanceAfter > balanceBefore ||
          supplyAfter > supplyBefore ||
          balanceBefore - balanceAfter !== amountIn ||
          supplyBefore - supplyAfter !== amountIn
        ) continue;
        const amountOut = nativeOutFromLogs(
          calls[2].logs,
          instance.token,
          instance.caller,
        );
        if (amountOut > 0n) {
          return Object.freeze({
            token: instance.token,
            amountIn,
            amountOut,
          });
        }
      } catch {
        // Another deterministic probe amount may still establish the mid.
      }
    }
    throw new Error("self-burn-native current-block behavior proof failed");
  },

  deriveMids(snapshot, edges) {
    if (edges.length === 0) {
      throw new Error("self-burn-native mid requires an edge");
    }
    return new Map(edges.map((edge) => {
      requireOwnedEdge(edge);
      if (edge.target.toLowerCase() !== snapshot.token.toLowerCase()) {
        throw new Error("self-burn-native snapshot/edge instance drifted");
      }
      return [
        blockScanEdgeKey(edge),
        protocolMid(edge, snapshot.amountIn, snapshot.amountOut),
      ] as const;
    }));
  },

  dependencies(edges) {
    for (const edge of edges) requireOwnedEdge(edge);
    return Object.freeze([
      ...new Set(edges.flatMap((edge) => [
        edge.target.toLowerCase(),
        ADDR.WETH.toLowerCase(),
      ])),
    ]);
  },
};
const pricingState = Object.freeze(pricingStateDefinition);

export const selfBurnNativeAdapter = Object.freeze({
  id: "protocol:self-burn-native",
  kind: "protocol-conversion",
  poolAdapters: [SELF_BURN_NATIVE_POOL_ADAPTER],
  identityPolicies: [{
    poolAdapter: SELF_BURN_NATIVE_POOL_ADAPTER,
    policy: "trusted-singleton-seed",
    registeredVenueIds: [SELF_BURN_NATIVE_VENUE],
    registeredIdentitySources: [SELF_BURN_NATIVE_IDENTITY_SOURCE],
  }],
  declaredVenues: [],
  undeclaredVenueReason:
    "instances require observed self-transfer plus current-block burn/native-payout proof",
  discovery: selfBurnNativeDiscovery,
  discoveryIdentityResolver: selfBurnNativeIdentityResolver,
  discoveryIdentityAuthority: {
    class: "canonical-onchain",
    strength: 300,
  },
  edgeAdapterIds: [SELF_BURN_NATIVE_EDGE_ADAPTER],
  allowedTaxonomy: [{ slotKind: "protocol", protocolAction: "redeem" }],
  requiresProtocolEdgesFlag: true,
  ownedActionAdapterIds: [SELF_BURN_NATIVE_EDGE_ADAPTER],
  requiredInfraActionAdapterIds: ["weth-deposit-value"],
  pricingState,
  prepared: null,

  async buildEdges(
    pool: PoolEntry,
    backend: TokenQueryBackend,
  ): Promise<TokenEdge[]> {
    if (
      pool.adapter !== SELF_BURN_NATIVE_POOL_ADAPTER ||
      pool.verifiedRoutes?.length !== 1 ||
      pool.logicalInstanceId !== selfBurnNativeInstanceId(pool.address)
    ) {
      throw new Error(
        "self-burn-native pool requires one discovery-verified instance route",
      );
    }
    const route = pool.verifiedRoutes[0];
    if (
      route.edgeAdapterId !== SELF_BURN_NATIVE_EDGE_ADAPTER ||
      route.tokenIn.toLowerCase() !== pool.address.toLowerCase() ||
      route.tokenOut.toLowerCase() !== ADDR.WETH.toLowerCase() ||
      route.slotKind !== "protocol" ||
      route.protocolAction !== "redeem"
    ) {
      throw new Error("self-burn-native verified route shape drifted");
    }
    const raw = await backend.call({
      to: pool.address,
      data: erc20.encodeFunctionData("totalSupply"),
    });
    erc20.decodeFunctionResult("totalSupply", raw);
    return [{
      adapterId: SELF_BURN_NATIVE_EDGE_ADAPTER,
      target: ethers.getAddress(pool.address),
      tokenIn: ethers.getAddress(pool.address),
      tokenOut: ADDR.WETH,
      slotKind: "protocol",
      protocolAction: "redeem",
      score: pool.score,
      ...deriveEdgeTaxonomy("protocol", "redeem"),
    }];
  },

  async quoteExact(ctx: ExactQuoteContext): Promise<bigint> {
    if (!ctx.executor) {
      throw new Error("self-burn-native exact quote requires executor");
    }
    if (!ctx.state.simulateTokenToNativeDelta) {
      throw new Error(
        "self-burn-native exact quote requires value-delta simulation",
      );
    }
    const token = ethers.getAddress(ctx.target);
    const result = await ctx.state.simulateTokenToNativeDelta({
      token,
      caller: ctx.executor,
      amountIn: ctx.amountIn,
      callData: erc20.encodeFunctionData("transfer", [
        token,
        ctx.amountIn,
      ]),
    });
    if (
      result.tokenInSpent !== ctx.amountIn ||
      result.totalSupplyBurned !== ctx.amountIn ||
      result.nativeOut <= 0n
    ) {
      throw new Error("self-burn-native exact quote invariants failed");
    }
    return result.nativeOut;
  },

  async buildPlanFragment(ctx) {
    if (
      ctx.edge.adapterId !== SELF_BURN_NATIVE_EDGE_ADAPTER ||
      ctx.edge.tokenIn.toLowerCase() !== ctx.edge.target.toLowerCase() ||
      ctx.edge.tokenOut.toLowerCase() !== ADDR.WETH.toLowerCase()
    ) {
      throw new Error("self-burn-native plan received a foreign edge");
    }
    return {
      requirements: [],
      nodes: [
        {
          adapterId: SELF_BURN_NATIVE_EDGE_ADAPTER,
          target: ctx.edge.target,
          tokenIn: ctx.edge.tokenIn,
          tokenOut: ctx.edge.tokenIn,
          amount: ctx.amountIn,
          params: {},
          children: [],
        },
        {
          adapterId: "weth-deposit-value",
          target: ADDR.WETH,
          tokenIn: ADDR.ZERO,
          tokenOut: ADDR.WETH,
          amount: ctx.amountOut,
          params: {},
          children: [],
        },
      ],
    };
  },
} satisfies ProtocolConversionAdapter);

function requireOwnedEdge(edge: TokenEdge): void {
  if (
    edge.adapterId !== SELF_BURN_NATIVE_EDGE_ADAPTER ||
    edge.target.toLowerCase() !== edge.tokenIn.toLowerCase() ||
    edge.tokenOut.toLowerCase() !== ADDR.WETH.toLowerCase()
  ) {
    throw new Error("self-burn-native pricing received a foreign edge");
  }
}

function hydrateInstanceSchema(
  schema: SelfBurnNativeInstanceSchema,
  results: readonly StateReadResult[],
): SelfBurnNativeInstanceSchema {
  try {
    return hydrateVerifiedInstanceSchema(schema, results);
  } catch (error) {
    return Object.freeze({
      ...schema,
      staticIssue: error instanceof Error ? error.message : String(error),
    });
  }
}

function hydrateVerifiedInstanceSchema(
  schema: SelfBurnNativeInstanceSchema,
  results: readonly StateReadResult[],
): SelfBurnNativeInstanceSchema {
  const decimalsResult = requiredSuccess(
    results,
    `decimals:${schema.token.toLowerCase()}`,
  );
  const decimals = Number(
    erc20.decodeFunctionResult("decimals", decimalsResult)[0],
  );
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`self-burn-native invalid token decimals ${decimals}`);
  }
  const oneToken = 10n ** BigInt(decimals);
  const accessList = decodeJsonResult(requiredSuccess(
    results,
    `balance-access-list:${schema.token.toLowerCase()}`,
  )) as { accessList?: unknown };
  const accessKeys = Array.isArray(accessList?.accessList)
    ? accessList.accessList.flatMap((entry) => {
        const item = entry as { address?: unknown; storageKeys?: unknown };
        if (
          typeof item.address !== "string" ||
          item.address.toLowerCase() !== schema.token.toLowerCase() ||
          !Array.isArray(item.storageKeys)
        ) return [];
        return item.storageKeys.filter(
          (key): key is string =>
            typeof key === "string" && ethers.isHexString(key, 32),
        );
      })
    : [];
  const conventional = conventionalBalanceSlots(schema.caller);
  const accessSet = new Set(accessKeys.map((item) => item.toLowerCase()));
  const conventionalMatches = conventional.filter((key) => accessSet.has(key));
  const candidates = conventionalMatches.length > 0
    ? conventionalMatches
    : accessSet.size > 0
      ? [...accessSet].slice(0, 64)
      : conventional;
  return Object.freeze({
    ...schema,
    amountIns: Object.freeze(selfBurnNativeProbeAmounts(oneToken)),
    balanceSlotCandidates: Object.freeze(candidates),
  });
}

function schemaForEdges(
  schema: SelfBurnNativeSchema,
  edges: readonly TokenEdge[],
): SelfBurnNativeInstanceSchema {
  if (edges.length === 0) {
    throw new Error("self-burn-native state key owns no edges");
  }
  for (const edge of edges) requireOwnedEdge(edge);
  const token = edges[0].target.toLowerCase();
  if (edges.some((edge) => edge.target.toLowerCase() !== token)) {
    throw new Error("self-burn-native state key mixed instances");
  }
  const instance = schema.instances.find(
    (candidate) => candidate.token.toLowerCase() === token,
  );
  if (!instance) throw new Error("self-burn-native state key omitted schema");
  if (instance.staticIssue) {
    throw new Error(
      `self-burn-native instance static schema failed: ${instance.staticIssue}`,
    );
  }
  return instance;
}

function balanceSlotVerificationRead(
  input: BuildCurrentBlockReadsInput<SelfBurnNativeSchema>,
  instance: SelfBurnNativeInstanceSchema,
  slot: string,
  index: number,
): StateRead {
  const data = erc20.encodeFunctionData("balanceOf", [instance.caller]);
  return Object.freeze({
    id: `balance-slot:${instance.token.toLowerCase()}:${index}`,
    sourceBlock: input.sourceBlock,
    sourceBlockHash: input.sourceBlockHash,
    to: instance.token,
    from: instance.caller,
    data,
    transport: "eth-simulate-v1" as const,
    simulation: {
      calls: [{
        from: instance.caller,
        to: instance.token,
        data,
      }],
      stateOverrides: {
        [instance.token]: {
          stateDiff: {
            [slot]: ethers.toBeHex(BALANCE_PROBE_VALUE, 32),
          },
        },
      },
      traceTransfers: false,
    },
  });
}

function fullPricingSimulationRead(
  input: BuildCurrentBlockReadsInput<SelfBurnNativeSchema>,
  instance: SelfBurnNativeInstanceSchema,
  balanceSlot: string,
  amountIn: bigint,
  index: number,
): StateRead {
  const balanceData = erc20.encodeFunctionData("balanceOf", [
    instance.caller,
  ]);
  const supplyData = erc20.encodeFunctionData("totalSupply");
  return Object.freeze({
    id: `self-burn-native-quote:${instance.token.toLowerCase()}:${index}`,
    sourceBlock: input.sourceBlock,
    sourceBlockHash: input.sourceBlockHash,
    to: instance.token,
    from: instance.caller,
    data: erc20.encodeFunctionData("transfer", [
      instance.token,
      amountIn,
    ]),
    transport: "eth-simulate-v1" as const,
    simulation: {
      calls: [
        { from: instance.caller, to: instance.token, data: balanceData },
        { from: instance.caller, to: instance.token, data: supplyData },
        {
          from: instance.caller,
          to: instance.token,
          data: erc20.encodeFunctionData("transfer", [
            instance.token,
            amountIn,
          ]),
        },
        { from: instance.caller, to: instance.token, data: balanceData },
        { from: instance.caller, to: instance.token, data: supplyData },
      ],
      stateOverrides: {
        [instance.token]: {
          stateDiff: {
            [balanceSlot]: ethers.toBeHex(amountIn, 32),
          },
        },
      },
      traceTransfers: true,
    },
  });
}

function requiredSuccess(
  results: readonly StateReadResult[],
  id: string,
): string {
  const result = results.find((item) => item.id === id);
  if (!result) throw new Error(`self-burn-native missing state read ${id}`);
  if (!result.ok) {
    throw new Error(`self-burn-native state read ${id} failed: ${result.error}`);
  }
  return result.data;
}

function decodeJsonResult(data: string): unknown {
  return JSON.parse(ethers.toUtf8String(data));
}

interface SimulatedCall {
  readonly status: number;
  readonly returnData: string;
  readonly logs: readonly {
    readonly address: string;
    readonly topics: readonly string[];
    readonly data: string;
  }[];
}

function simulationCalls(value: unknown): readonly SimulatedCall[] {
  const block = Array.isArray(value) ? value[0] as { calls?: unknown } : null;
  const calls = block && Array.isArray(block.calls) ? block.calls : [];
  return calls.map((entry): SimulatedCall => {
    const call = entry as {
      status?: unknown;
      returnData?: unknown;
      logs?: unknown;
    };
    let status = 0;
    try {
      status = Number(BigInt(String(call.status ?? "0x0")));
    } catch {
      status = 0;
    }
    return {
      status,
      returnData:
        typeof call.returnData === "string" ? call.returnData : "0x",
      logs: Array.isArray(call.logs)
        ? call.logs.flatMap((entry) => {
            const log = entry as {
              address?: unknown;
              topics?: unknown;
              data?: unknown;
            };
            if (
              typeof log.address !== "string" ||
              !Array.isArray(log.topics) ||
              typeof log.data !== "string"
            ) return [];
            return [{
              address: log.address,
              topics: log.topics.filter(
                (topic): topic is string => typeof topic === "string",
              ),
              data: log.data,
            }];
          })
        : [],
    };
  });
}

function nativeOutFromLogs(
  logs: readonly SimulatedCall["logs"][number][],
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
    total += BigInt(log.data);
  }
  return total;
}

function conventionalBalanceSlots(holder: string): string[] {
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const keys: string[] = [];
  for (let slot = 0; slot < 32; slot++) {
    keys.push(ethers.keccak256(
      abi.encode(["address", "uint256"], [holder, BigInt(slot)]),
    ));
    keys.push(ethers.keccak256(
      abi.encode(["uint256", "address"], [BigInt(slot), holder]),
    ));
  }
  return keys.map((key) => key.toLowerCase());
}

function topicAddress(topic: string | undefined): string {
  if (!topic || !ethers.isHexString(topic, 32)) return "";
  return `0x${topic.slice(-40)}`.toLowerCase();
}
