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
import {
  protocolCandidateAddressesFromDexUniverse,
  protocolDiscoveryCandidateAddressHints,
} from "../protocol-discovery-runtime.js";
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
  STRICT_PROJECTED_FAMILY_TEST_REGISTRY,
} from "./strict-family-test-compat.js";
import { PRODUCTION_STRICT_VERIFIED_ACTORS } from
  "../venues/production-verified-actors.js";
import { createStrictCentralAdapterRuntime } from
  "../strict-central-adapter-runtime.js";
import { RevmSimClient } from "../revm-sim-client.js";
import { createRevmStrictSimulationTransport } from
  "../revm-strict-simulation-transport.js";

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
      STRICT_PROJECTED_FAMILY_TEST_REGISTRY.swaps().flatMap((adapter) => [...adapter.poolAdapters]),
    );
    const dexCandidateAddresses = protocolCandidateAddressesFromDexUniverse(
      dexUniverse,
      dexPoolAdapters,
    );
    const candidateAddressHints = protocolDiscoveryCandidateAddressHints(
      STRICT_PROJECTED_FAMILY_TEST_REGISTRY.protocols(),
    );
    const candidateAddresses = [...new Set([
      ...dexCandidateAddresses,
      ...candidateAddressHints,
    ])].sort();
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
    // F8: identity for effect-delta families (erc4626/fluid/silo) requires
    // the production revm simulation transport; wire the same strict
    // central runtime main.ts assembles when the revm binary is available.
    const revmSimBin = process.env.SEARCHER_REVM_SIM_BIN;
    const botvmAddress = process.env.BOTVM_ADDRESS;
    const identityRuntime = revmSimBin === undefined || botvmAddress === undefined
      ? undefined
      : createStrictCentralAdapterRuntime({
          provider: provider as never,
          generationFence: Object.freeze({
            kind: "catalog-relative" as const,
            assertCurrent: () => undefined,
            verifyCanonicalSource: () => true,
          }),
          verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
          simulator: createRevmStrictSimulationTransport({
            client: new RevmSimClient({
              executablePath: revmSimBin,
            }),
            executor: ethers.getAddress(botvmAddress),
            verifiedActors: PRODUCTION_STRICT_VERIFIED_ACTORS,
          }),
        });
    const firstScan = await scanProtocolDiscoveryRange({
      adapters: STRICT_PROJECTED_FAMILY_TEST_REGISTRY.protocols(),
      context,
      candidateAddresses,
      evidenceCache: cache,
    });
    const result = await runProtocolDiscovery({
      adapters: STRICT_PROJECTED_FAMILY_TEST_REGISTRY.protocols(),
      context,
      protocolEdgesEnabled: true,
      attestIdentity: createCanonicalProtocolIdentityAttester(
        identityRuntime === undefined ? {} : { identityRuntime },
      ),
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
      adapters: STRICT_PROJECTED_FAMILY_TEST_REGISTRY.protocols(),
      context,
      candidateAddresses,
      evidenceCache: cache,
    });
    if (
      secondScan.addressStats.probes + secondScan.addressStats.cacheHits === 0 &&
      candidateAddresses.length > 0
    ) {
      throw new Error("second DEX pass neither re-probed nor safely reused address evidence");
    }
    const admittedSet = new Set(
      result.wouldAdmit.map((item) => item.instance.pool.address.toLowerCase()),
    );
    const dexCandidateSet = new Set(dexCandidateAddresses);
    const legacyCandidates = candidateAddressHints.filter(
      (address) => dexCandidateSet.has(address),
    );
    const legacyRecalled = candidateAddressHints.filter(
      (address) => admittedSet.has(address),
    );
    const legacyMissing = candidateAddressHints.filter(
      (address) => !admittedSet.has(address),
    );
    if (
      process.env.SEARCHER_PROTOCOL_DISCOVERY_REQUIRE_LEGACY_RECALL === "1" &&
      legacyMissing.length > 0
    ) {
      throw new Error(
        `legacy recall incomplete ${legacyRecalled.length}/${candidateAddressHints.length}: ` +
          legacyMissing.join(","),
      );
    }
    console.log(
      `[protocol-discovery-dex-live-smoke] PASS block=${blockNumber} pools=${dexUniverse.length} ` +
        `addresses=${candidateAddresses.length} sourceComplete=${firstScan.sourceComplete} ` +
        `admissions=${result.wouldAdmit.length} protocolEdges=${baselineProtocol.length}->${afterProtocol.length} ` +
        `added=${added.length} firstProbes=${firstScan.addressStats.probes} ` +
        `secondProbes=${secondScan.addressStats.probes} secondCacheHits=${secondScan.addressStats.cacheHits} ` +
        `legacyCandidateRecall=${legacyCandidates.length}/${candidateAddressHints.length} ` +
        `legacyAdmissionRecall=${legacyRecalled.length}/${candidateAddressHints.length} ` +
        `wallMs=${Date.now() - startedAt}`,
    );
    if (legacyMissing.length > 0) {
      console.log(
        `[protocol-discovery-dex-live-smoke] legacy-recall-incomplete ` +
          `missing=${legacyMissing.join(",")}`,
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
