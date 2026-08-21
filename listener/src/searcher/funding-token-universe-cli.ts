import { ethers } from "ethers";
import { readFile, readdir } from "node:fs/promises";
import {
  enumerateFundingTokenUniverse,
  writeFundingTokenUniverse,
} from "./funding-token-universe.js";

/**
 * Standalone funding token universe builder: enumerates the flash-loan
 * tokens the funding providers actually support from chain truth and
 * solidifies the table ("一开始就固化下来"). Run once after a deploy when
 * the node is quiet; the searcher then only reads the table.
 *
 * Sources:
 *  - Morpho Blue: market loan tokens (CreateMarket events + market(id)).
 *  - Balancer V2 Vault: current balanceOf(vault) > 0 over the candidate
 *    tokens (pool universe token0/token1), via the balanceOf interface -
 *    never pool-registration history.
 *
 * Usage: node --import tsx src/searcher/funding-token-universe-cli.ts
 *   [table-path] [candidates-file]
 * Table path defaults to SEARCHER_FUNDING_TOKEN_UNIVERSE_PATH or
 * /opt/MEV-runtime/funding-token-universe.json. Candidates file defaults to
 * the newest /opt/MEV-runtime/universe/active-pools-*.json (token0/token1).
 * RPC from MAINNET_RPC_URL (archive) or SEARCHER_LIVE_RPC_URL.
 */
async function loadCandidateTokens(path: string): Promise<readonly string[]> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as { readonly pools?: readonly unknown[] };
  const pools = Array.isArray(parsed.pools) ? parsed.pools : [];
  const tokens = new Set<string>();
  for (const pool of pools) {
    const record = pool as { readonly token0?: unknown; readonly token1?: unknown };
    for (const token of [record.token0, record.token1]) {
      if (
        typeof token === "string" &&
        /^0x[0-9a-fA-F]{40}$/.test(token)
      ) {
        tokens.add(ethers.getAddress(token).toLowerCase());
      }
    }
  }
  return [...tokens].sort();
}

async function newestPoolUniversePath(): Promise<string | null> {
  const entries = await readdir("/opt/MEV-runtime/universe", {
    withFileTypes: true,
  });
  const matches = entries
    .filter((entry) =>
      entry.isFile() &&
      entry.name.startsWith("active-pools-") &&
      entry.name.endsWith(".json")
    )
    .map((entry) => entry.name)
    .sort();
  return matches.length === 0
    ? null
    : "/opt/MEV-runtime/universe/" + matches[matches.length - 1]!;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.MAINNET_RPC_URL ??
    process.env.SEARCHER_LIVE_RPC_URL;
  if (rpcUrl === undefined || rpcUrl.trim().length === 0) {
    throw new Error(
      "funding token universe CLI requires MAINNET_RPC_URL or SEARCHER_LIVE_RPC_URL",
    );
  }
  const path = process.argv[2] ??
    process.env.SEARCHER_FUNDING_TOKEN_UNIVERSE_PATH ??
    "/opt/MEV-runtime/funding-token-universe.json";
  const candidatesFile = process.argv[3] ?? await newestPoolUniversePath();
  if (candidatesFile === null) {
    throw new Error("no pool universe file found for Balancer candidates");
  }
  const candidateTokens = await loadCandidateTokens(candidatesFile);
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const startedAtMs = Date.now();
  const table = await enumerateFundingTokenUniverse({
    provider,
    candidateTokens,
  });
  await writeFundingTokenUniverse(path, table);
  console.log(
    `funding token universe: ${table.tokens.length} tokens (candidates ` +
      `${candidateTokens.length}) @block ${table.enumeratedAtBlock} in ` +
      `${Date.now() - startedAtMs}ms -> ${path}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
