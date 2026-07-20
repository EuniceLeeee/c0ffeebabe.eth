import type { ethers } from "ethers";
import type { PoolEntry, TokenEdge } from "./planner/token-graph.js";
import {
  createCanonicalProtocolIdentityAttester,
  createPinnedProtocolDiscoveryContext,
  prepareProtocolDiscoveryProjection,
  runProtocolDiscovery,
  type ProtocolDiscoveryOwnership,
  type ProtocolDiscoveryProjection,
  type ProtocolDiscoveryResult,
} from "./protocol-instance-discovery.js";
import { scanObservedProtocolTrace } from "./observed-protocol-discovery.js";
import type { StrategyViews } from "./strategy-views.js";
import type { IdentityResolverRegistry } from "./venues/identity.js";
import type {
  ProtocolConversionAdapter,
  ProtocolDiscoveryReceipt,
} from "./venues/route-leg-adapter.js";

export interface ProtocolDiscoveryRuntimeInput {
  readonly provider: ethers.JsonRpcProvider;
  readonly adapters: readonly ProtocolConversionAdapter[];
  readonly identityRegistry: IdentityResolverRegistry;
  readonly protocolEdgesEnabled: boolean;
  readonly currentOwnership: ProtocolDiscoveryOwnership;
  readonly currentBackrunPools: readonly PoolEntry[];
  readonly currentBackrunGraph: readonly TokenEdge[];
  readonly currentBlockscanGraph?: readonly TokenEdge[];
  readonly currentKnownPoolKeys?: ReadonlySet<string>;
  readonly buildStrategyViews: (pools: PoolEntry[]) => StrategyViews;
}

export async function prepareActiveProtocolDiscoveryPass(
  input: ProtocolDiscoveryRuntimeInput & {
    readonly blockNumber: number;
    readonly fromBlock: number;
    readonly candidateTokens: readonly string[];
    readonly graphTokens?: readonly string[];
    readonly shadow: boolean;
  },
): Promise<{ result: ProtocolDiscoveryResult; projection: ProtocolDiscoveryProjection | null }> {
  const retainedInstances = [...input.currentOwnership.admissions.values()].map((item) => item.instance);
  const context = createPinnedProtocolDiscoveryContext({
    provider: input.provider,
    blockNumber: input.blockNumber,
    fromBlock: input.fromBlock,
    candidateTokens: input.candidateTokens,
    graphTokens: input.graphTokens,
    retainedInstances,
  });
  const result = await runProtocolDiscovery({
    adapters: input.adapters,
    context,
    protocolEdgesEnabled: input.protocolEdgesEnabled,
    attestIdentity: createCanonicalProtocolIdentityAttester({
      identityRegistry: input.identityRegistry,
    }),
  });
  return {
    result,
    projection: input.shadow
      ? null
      : prepareProtocolDiscoveryProjection({
        currentOwnership: input.currentOwnership,
        result,
        currentBackrunPools: input.currentBackrunPools,
        currentBackrunGraph: input.currentBackrunGraph,
        currentBlockscanGraph: input.currentBlockscanGraph,
        currentKnownPoolKeys: input.currentKnownPoolKeys,
        buildStrategyViews: input.buildStrategyViews,
      }),
  };
}

export async function prepareObservedProtocolDiscoveryPass(
  input: ProtocolDiscoveryRuntimeInput & {
    readonly blockNumber: number;
    readonly txHash: string;
    readonly receipt: ProtocolDiscoveryReceipt;
    readonly trace: unknown;
    readonly candidateTokens: readonly string[];
    readonly graphTokens?: readonly string[];
    readonly seenAddressSelectors?: ReadonlySet<string>;
  },
): Promise<{
  result: ProtocolDiscoveryResult;
  projection: ProtocolDiscoveryProjection;
  unknownSelectors: Awaited<ReturnType<typeof scanObservedProtocolTrace>>["unknownSelectors"];
}> {
  const context = createPinnedProtocolDiscoveryContext({
    provider: input.provider,
    blockNumber: input.blockNumber,
    fromBlock: input.blockNumber,
    candidateTokens: input.candidateTokens,
    graphTokens: input.graphTokens,
    retainedInstances: [],
  });
  const observed = await scanObservedProtocolTrace({
    adapters: input.adapters,
    context,
    txHash: input.txHash,
    receipt: input.receipt,
    trace: input.trace,
    seenAddressSelectors: input.seenAddressSelectors,
  });
  const result = await runProtocolDiscovery({
    adapters: input.adapters,
    context,
    protocolEdgesEnabled: input.protocolEdgesEnabled,
    attestIdentity: createCanonicalProtocolIdentityAttester({
      identityRegistry: input.identityRegistry,
    }),
    observedCandidates: observed.candidatesByAdapter,
    runActiveDiscovery: false,
    includeRetained: false,
  });
  const projection = prepareProtocolDiscoveryProjection({
    currentOwnership: input.currentOwnership,
    result,
    currentBackrunPools: input.currentBackrunPools,
    currentBackrunGraph: input.currentBackrunGraph,
    currentBlockscanGraph: input.currentBlockscanGraph,
    currentKnownPoolKeys: input.currentKnownPoolKeys,
    buildStrategyViews: input.buildStrategyViews,
  });
  return { result, projection, unknownSelectors: observed.unknownSelectors };
}
