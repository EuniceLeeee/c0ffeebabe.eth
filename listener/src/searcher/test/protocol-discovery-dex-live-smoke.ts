import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import {
  createCanonicalProtocolIdentityAttester,
  createPinnedProtocolDiscoveryContext,
  EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
  prepareProtocolDiscoveryProjection,
  protocolEdgeKey,
  runProtocolDiscovery,
} from "../protocol-instance-discovery.js";
import { createProtocolDiscoveryEvidenceCache } from "../protocol-discovery-cache.js";
import { protocolCandidateAddressesFromDexUniverse } from "../protocol-discovery-runtime.js";
import { scanProtocolDiscoveryRange } from "../observed-protocol-discovery.js";
import {
  buildTokenGraph,
  buildTokenIndex,
  POOL_REGISTRY,
  type PoolEntry,
  type TokenQueryBackend,
} from "../planner/token-graph.js";
import { buildStrategyViews } from "../strategy-views.js";
import {
  PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
  PRODUCTION_ROUTE_ADAPTERS,
} from "../venues/production-registry.js";

interface UniversePool {
  readonly address?: unknown;
  readonly adapter?: unknown;
  readonly token0?: unknown;
  readonly token1?: unknown;
  readonly currency0?: unknown;
  readonly currency1?: unknown;
  readonly fixedTokenIn?: unknown;
  readonly fixedTokenOut?: unknown;
  readonly underlyingCoins?: unknown;
}

function requiredRpcUrl(): string {
  const value = process.env.SEARCHER_LIVE_RPC_URL ?? process.env.MAINNET_RPC_URL;
  if (!value) throw new Error("SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL required");
  return value;
}

function requiredUniversePath(): string {
  const value = process.env.SEARCHER_PROTOCOL_DISCOVERY_UNIVERSE_PATH;
  if (!value) throw new Error("SEARCHER_PROTOCOL_DISCOVERY_UNIVERSE_PATH required");
  return value;
}

function universePools(path: string, maxPools: number): PoolEntry[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { pools?: unknown };
  if (!Array.isArray(parsed.pools)) throw new Error("universe snapshot missing pools[]");
  const pools: PoolEntry[] = [];
  const selected = maxPools > 0 ? parsed.pools.slice(0, maxPools) : parsed.pools;
  for (const raw of selected) {
    if (!raw || typeof raw !== "object") continue;
    const pool = raw as UniversePool;
    if (typeof pool.address !== "string" || typeof pool.adapter !== "string") continue;
    pools.push(pool as PoolEntry);
  }
  return pools;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const provider = new ethers.JsonRpcProvider(requiredRpcUrl());
  const universePath = requiredUniversePath();
  const maxPools = Math.max(
    0,
    Number(process.env.SEARCHER_PROTOCOL_DISCOVERY_SMOKE_MAX_POOLS ?? "0"),
  );
  try {
    const blockNumber = await provider.getBlockNumber();
    const dexUniverse = universePools(universePath, maxPools);
    const dexPoolAdapters = new Set(
      PRODUCTION_ROUTE_ADAPTERS.swaps.flatMap((adapter) => [...adapter.poolAdapters]),
    );
    const candidateAddresses = protocolCandidateAddressesFromDexUniverse(
      dexUniverse,
      dexPoolAdapters,
    );
    if (candidateAddresses.length === 0) throw new Error("DEX universe produced zero token candidates");

    // Remove the entire family by type, not selected addresses. The legacy rows
    // remain outside the candidate path and therefore cannot make this test green.
    const noErc4626SeedPools = POOL_REGISTRY.filter((pool) => pool.adapter !== "erc4626");
    const tokenBackend: TokenQueryBackend = {
      call: (req) => provider.send("eth_call", [req, ethers.toQuantity(blockNumber)]),
    };
    const baselineGraph = await buildTokenGraph(tokenBackend, noErc4626SeedPools);
    const baselineProtocol = baselineGraph.filter((edge) => edge.slotKind === "protocol");
    const baselineKeys = new Set(baselineProtocol.map(protocolEdgeKey));
    const graphTokens = [...new Set([
      ...buildTokenIndex(baselineGraph).keys(),
      ...candidateAddresses,
    ])];
    const pinned = createPinnedProtocolDiscoveryContext({
      provider,
      blockNumber,
      fromBlock: blockNumber,
      graphTokens,
    });
    const context = {
      ...pinned,
      backend: {
        ...pinned.backend,
        async getLogs() { return []; },
        async getTransactionReceipt() {
          throw new Error("DEX address smoke must not read receipts");
        },
        async traceTransaction() {
          throw new Error("DEX address smoke must not read traces");
        },
      },
    };
    const cache = createProtocolDiscoveryEvidenceCache();
    const firstScan = await scanProtocolDiscoveryRange({
      adapters: PRODUCTION_ROUTE_ADAPTERS.protocols,
      context,
      candidateAddresses,
      evidenceCache: cache,
    });
    const result = await runProtocolDiscovery({
      adapters: PRODUCTION_ROUTE_ADAPTERS.protocols,
      context,
      protocolEdgesEnabled: true,
      attestIdentity: createCanonicalProtocolIdentityAttester({
        identityRegistry: PRODUCTION_PROTOCOL_DISCOVERY_IDENTITY_RESOLVERS,
      }),
      candidatesByAdapter: firstScan.candidatesByAdapter,
      sourceComplete: firstScan.sourceComplete,
      sourceErrors: firstScan.sourceErrors,
    });
    const projection = prepareProtocolDiscoveryProjection({
      currentOwnership: EMPTY_PROTOCOL_DISCOVERY_OWNERSHIP,
      result,
      currentBackrunPools: noErc4626SeedPools,
      currentBackrunGraph: baselineGraph,
      currentKnownPoolKeys: new Set(noErc4626SeedPools.map((pool) => pool.address.toLowerCase())),
      buildStrategyViews: (pools) => buildStrategyViews(pools, [], [], {
        blockscanMaxPools: 10_000,
        poolUniverseGeneratedAt: "protocol-discovery-dex-live-smoke",
      }),
    });
    const afterProtocol = projection.backrunGraph.filter((edge) => edge.slotKind === "protocol");
    const added = afterProtocol.filter((edge) => !baselineKeys.has(protocolEdgeKey(edge)));
    if (result.wouldAdmit.length === 0 || added.length === 0) {
      throw new Error(
        `DEX candidates produced no unseeded admission ` +
          `(addresses=${candidateAddresses.length}, probes=${firstScan.addressStats.probes})`,
      );
    }

    const secondScan = await scanProtocolDiscoveryRange({
      adapters: PRODUCTION_ROUTE_ADAPTERS.protocols,
      context,
      candidateAddresses,
      evidenceCache: cache,
    });
    if (secondScan.addressStats.cacheHits === 0) {
      throw new Error("second DEX pass did not reuse positive/negative address evidence");
    }
    const candidateSet = new Set(candidateAddresses.map((address) => address.toLowerCase()));
    const admittedSet = new Set(
      result.wouldAdmit.map((item) => item.instance.pool.address.toLowerCase()),
    );
    const legacyStandard = POOL_REGISTRY.filter(
      (pool) => pool.adapter === "erc4626" && !pool.nonStandardRedeem,
    );
    const legacyCandidates = legacyStandard.filter(
      (pool) => candidateSet.has(pool.address.toLowerCase()),
    );
    const legacyRecalled = legacyStandard.filter(
      (pool) => admittedSet.has(pool.address.toLowerCase()),
    );
    const legacyMissing = legacyStandard.filter(
      (pool) => !admittedSet.has(pool.address.toLowerCase()),
    );
    if (
      process.env.SEARCHER_PROTOCOL_DISCOVERY_REQUIRE_LEGACY_RECALL === "1" &&
      legacyMissing.length > 0
    ) {
      throw new Error(
        `legacy recall incomplete ${legacyRecalled.length}/${legacyStandard.length}: ` +
          legacyMissing.map((pool) => pool.address).join(","),
      );
    }
    console.log(
      `[protocol-discovery-dex-live-smoke] PASS block=${blockNumber} pools=${dexUniverse.length} ` +
        `addresses=${candidateAddresses.length} sourceComplete=${firstScan.sourceComplete} ` +
        `admissions=${result.wouldAdmit.length} protocolEdges=${baselineProtocol.length}->${afterProtocol.length} ` +
        `added=${added.length} firstProbes=${firstScan.addressStats.probes} ` +
        `secondProbes=${secondScan.addressStats.probes} secondCacheHits=${secondScan.addressStats.cacheHits} ` +
        `legacyCandidateRecall=${legacyCandidates.length}/${legacyStandard.length} ` +
        `legacyAdmissionRecall=${legacyRecalled.length}/${legacyStandard.length} ` +
        `wallMs=${Date.now() - startedAt}`,
    );
    if (legacyMissing.length > 0) {
      console.log(
        `[protocol-discovery-dex-live-smoke] legacy-recall-incomplete ` +
          `missing=${legacyMissing.map((pool) => pool.address).join(",")}`,
      );
    }
    for (const edge of added.slice(0, 12)) {
      console.log(
        `[protocol-discovery-dex-live-smoke] graph+ adapter=${edge.adapterId} target=${edge.target} ` +
          `${edge.tokenIn}->${edge.tokenOut}`,
      );
    }
  } finally {
    provider.destroy();
  }
}

main().catch((error) => {
  console.error(
    `[protocol-discovery-dex-live-smoke] FAIL ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
