import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import {
  loadPoolUniverse,
  loadPoolUniverseCoverageMetadata,
  poolUniverseCanonicalAnchorMatches,
  type PoolUniverseCoverageMetadata,
} from "./pool-universe.js";
import { productionPoolUniverseSourceFingerprintsStrict } from "./venues/production-registry.js";

export type PoolUniverseDeployTrustReason =
  | "trusted"
  | "invalid_runtime_window"
  | "empty_universe"
  | "unverified_manifest"
  | "future_source"
  | "canonical_source_mismatch"
  | "registry_source_mismatch"
  | "landed_window_not_bridged";

export interface PoolUniverseDeployTrustResult {
  readonly trusted: boolean;
  readonly reason: PoolUniverseDeployTrustReason;
  readonly toBlock: number | null;
}

export function evaluatePoolUniverseDeployTrust(input: {
  readonly poolCount: number;
  readonly metadata: PoolUniverseCoverageMetadata;
  readonly canonicalSource: {
    readonly number?: number;
    readonly hash?: string | null;
    readonly stateRoot?: string | null;
  } | null;
  readonly currentRegistrySourceFingerprints: readonly string[];
  readonly frozenSource: number;
  readonly discoveryBlocks: number;
}): PoolUniverseDeployTrustResult {
  const { metadata } = input;
  const toBlock = metadata.toBlock;
  if (
    !Number.isSafeInteger(input.frozenSource) ||
    input.frozenSource <= 0 ||
    !Number.isSafeInteger(input.discoveryBlocks) ||
    input.discoveryBlocks < 0
  ) {
    return rejected("invalid_runtime_window", toBlock);
  }
  if (input.poolCount <= 0) return rejected("empty_universe", toBlock);
  if (
    !metadata.manifestVerified ||
    toBlock === null ||
    toBlock <= 0 ||
    metadata.source?.number !== toBlock
  ) {
    return rejected("unverified_manifest", toBlock);
  }
  if (toBlock > input.frozenSource) {
    return rejected("future_source", toBlock);
  }
  if (!poolUniverseCanonicalAnchorMatches(metadata, input.canonicalSource)) {
    return rejected("canonical_source_mismatch", toBlock);
  }
  if (!sameStrings(
    metadata.registrySourceFingerprints,
    input.currentRegistrySourceFingerprints,
  )) {
    return rejected("registry_source_mismatch", toBlock);
  }
  const landedDiscoveryFloor = Math.max(
    0,
    input.frozenSource - input.discoveryBlocks,
  );
  if (toBlock < landedDiscoveryFloor - 1) {
    return rejected("landed_window_not_bridged", toBlock);
  }
  return Object.freeze({ trusted: true, reason: "trusted", toBlock });
}

function rejected(
  reason: Exclude<PoolUniverseDeployTrustReason, "trusted">,
  toBlock: number | null,
): PoolUniverseDeployTrustResult {
  return Object.freeze({ trusted: false, reason, toBlock });
}

function sameStrings(
  left: readonly string[] | null,
  right: readonly string[],
): boolean {
  return left !== null &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

async function main(): Promise<void> {
  const [
    universePath,
    manifestPath,
    frozenSourceRaw,
    discoveryBlocksRaw,
    rpcUrl,
  ] = process.argv.slice(2);
  if (
    !universePath ||
    !manifestPath ||
    !frozenSourceRaw ||
    !discoveryBlocksRaw ||
    !rpcUrl
  ) {
    throw new Error(
      "usage: pool-universe-deploy-trust <universe> <manifest> " +
        "<frozen-source> <discovery-blocks> <rpc-url>",
    );
  }
  const pools = loadPoolUniverse(universePath, {
    missingOk: false,
    maxPools: 0,
    minScore: 0,
  });
  const metadata = loadPoolUniverseCoverageMetadata(
    universePath,
    manifestPath,
  );
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  try {
    const canonicalSource = metadata.source === null
      ? null
      : await provider.getBlock(metadata.source.number);
    const result = evaluatePoolUniverseDeployTrust({
      poolCount: pools.length,
      metadata,
      canonicalSource,
      currentRegistrySourceFingerprints:
        productionPoolUniverseSourceFingerprintsStrict(),
      frozenSource: Number(frozenSourceRaw),
      discoveryBlocks: Number(discoveryBlocksRaw),
    });
    if (!result.trusted) {
      throw new Error(
        `pool universe is not runtime-trusted: ${result.reason}`,
      );
    }
    process.stdout.write(String(result.toBlock));
  } finally {
    provider.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
