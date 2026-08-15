import { ethers } from "ethers";
import {
  createCanonicalProtocolIdentityAttester,
  createPinnedProtocolDiscoveryContext,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  protocolEdgeKey,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { scanProtocolDiscoveryRange } from "../observed-protocol-discovery.js";
import {
  buildTokenGraph,
  POOL_REGISTRY,
  type TokenEdge,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { buildStrategyViews } from "../strategy-views.js";
import {
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
  PRODUCTION_ADAPTER_FAMILIES,
} from "../venues/production-registry.js";

const ERC4626 = new ethers.Interface([
  "function asset() view returns (address)",
  "event Withdraw(address indexed sender,address indexed receiver,address indexed owner,uint256 assets,uint256 shares)",
]);
const WITHDRAW_TOPIC = ERC4626.getEvent("Withdraw")!.topicHash;

function requiredRpcUrl(): string {
  const value = process.env.SEARCHER_LIVE_RPC_URL ?? process.env.MAINNET_RPC_URL;
  if (!value) throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required");
  return value;
}

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(requiredRpcUrl());
  const timeoutMs = Number(process.env.SEARCHER_PROTOCOL_DISCOVERY_RPC_TIMEOUT_MS ?? "15000");
  const lookback = Math.max(1, Number(process.env.SEARCHER_PROTOCOL_DISCOVERY_SMOKE_BLOCKS ?? "100"));
  const pinnedBlock = process.env.SEARCHER_DISCOVERY_TO_BLOCK === undefined
    ? await provider.getBlockNumber()
    : Number(process.env.SEARCHER_DISCOVERY_TO_BLOCK);
  const fromBlock = Math.max(0, pinnedBlock - lookback + 1);

  try {
    const logs = await provider.getLogs({
      topics: [WITHDRAW_TOPIC],
      fromBlock,
      toBlock: pinnedBlock,
    });
    const logsPerBlock = new Map<number, number>();
    for (const log of logs) {
      logsPerBlock.set(log.blockNumber, (logsPerBlock.get(log.blockNumber) ?? 0) + 1);
    }
    const staticTargets = new Set(POOL_REGISTRY.map((pool) => pool.address.toLowerCase()));
    const candidates = [...logs]
      .reverse()
      .filter((log) => logsPerBlock.get(log.blockNumber) === 1)
      .filter((log) => !staticTargets.has(log.address.toLowerCase()));

    const baselineBackend: TokenQueryBackend = {
      call: (req) => provider.send("eth_call", [req, ethers.toQuantity(pinnedBlock)]),
    };
    const baselineGraph = await buildTokenGraph(baselineBackend, POOL_REGISTRY);
    const baselineProtocol = baselineGraph.filter((edge) => edge.slotKind === "protocol");
    const baselineKeys = new Set(baselineProtocol.map(protocolEdgeKey));
    const baselineTokens = [...new Set(
      baselineGraph.flatMap((edge) => [edge.tokenIn.toLowerCase(), edge.tokenOut.toLowerCase()]),
    )];
    const baselineTokenSet = new Set(baselineTokens);
    const attester = createCanonicalProtocolIdentityAttester();

    for (const log of candidates) {
      const target = ethers.getAddress(log.address);
      let asset: string;
      try {
        const raw = await provider.send("eth_call", [{
          to: target,
          data: ERC4626.encodeFunctionData("asset"),
        }, ethers.toQuantity(pinnedBlock)]);
        asset = ethers.getAddress(String(ERC4626.decodeFunctionResult("asset", raw)[0]));
      } catch {
        continue;
      }
      if (
        !baselineTokenSet.has(target.toLowerCase()) &&
        !baselineTokenSet.has(asset.toLowerCase())
      ) continue;

      const context = createPinnedProtocolDiscoveryContext({
        provider,
        blockNumber: pinnedBlock,
        fromBlock: log.blockNumber,
        toBlock: log.blockNumber,
        rpcTimeoutMs: timeoutMs,
        // The scanner receives no target seed; graph tokens only gate loop closability.
        graphTokens: baselineTokens,
      });
      const scanned = await scanProtocolDiscoveryRange({
        adapters: PRODUCTION_ADAPTER_FAMILIES.protocols(),
        context,
      });
      const result = await runProtocolDiscovery({
        adapters: PRODUCTION_ADAPTER_FAMILIES.protocols(),
        context,
        protocolEdgesEnabled: true,
        attestIdentity: attester,
        candidatesByAdapter: scanned.candidatesByAdapter,
        sourceComplete: scanned.sourceComplete,
        sourceErrors: scanned.sourceErrors,
      });
      const admission = result.wouldAdmit.find(
        (item) => item.instance.pool.address.toLowerCase() === target.toLowerCase(),
      );
      if (!admission) continue;

      const projection = prepareProtocolDiscoveryProjection({
        currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
        result,
        currentBackrunPools: POOL_REGISTRY,
        currentBackrunGraph: baselineGraph,
        currentKnownPoolKeys: new Set(POOL_REGISTRY.map((pool) => pool.address.toLowerCase())),
        buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
          blockscanMaxPools: 10_000,
          poolUniverseGeneratedAt: "protocol-discovery-live-smoke",
        }),
      });
      const afterProtocol = projection.backrunGraph.filter((edge) => edge.slotKind === "protocol");
      const added = afterProtocol.filter((edge) => !baselineKeys.has(protocolEdgeKey(edge)));
      if (added.length === 0) continue;

      console.log(
        `[protocol-discovery-live-smoke] PASS block=${log.blockNumber} tx=${log.transactionHash} ` +
          `target=${target} sourceComplete=${result.sourceComplete} ` +
          `protocolEdges=${baselineProtocol.length}->${afterProtocol.length} added=${added.length}`,
      );
      for (const edge of added) printEdge(edge);
      return;
    }

    throw new Error(
      `no unseeded ERC4626 admission found in ${fromBlock}-${pinnedBlock} ` +
        `(withdrawLogs=${logs.length}, singleLogCandidates=${candidates.length})`,
    );
  } finally {
    provider.destroy();
  }
}

function printEdge(edge: TokenEdge): void {
  console.log(
    `[protocol-discovery-live-smoke] graph+ adapter=${edge.adapterId} target=${edge.target} ` +
      `${edge.tokenIn}->${edge.tokenOut}`,
  );
}

main().catch((error) => {
  console.error(
    `[protocol-discovery-live-smoke] FAIL ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
