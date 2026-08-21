import { ethers } from "ethers";
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
 * Usage: node --import tsx src/searcher/funding-token-universe-cli.ts [path]
 * Path defaults to SEARCHER_FUNDING_TOKEN_UNIVERSE_PATH or
 * /opt/MEV-runtime/funding-token-universe.json. RPC from
 * SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL.
 */
async function main(): Promise<void> {
  const rpcUrl = process.env.SEARCHER_LIVE_RPC_URL ??
    process.env.MAINNET_RPC_URL;
  if (rpcUrl === undefined || rpcUrl.trim().length === 0) {
    throw new Error(
      "funding token universe CLI requires SEARCHER_LIVE_RPC_URL or MAINNET_RPC_URL",
    );
  }
  const path = process.argv[2] ??
    process.env.SEARCHER_FUNDING_TOKEN_UNIVERSE_PATH ??
    "/opt/MEV-runtime/funding-token-universe.json";
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const startedAtMs = Date.now();
  const table = await enumerateFundingTokenUniverse(provider);
  await writeFundingTokenUniverse(path, table);
  console.log(
    `funding token universe: ${table.tokens.length} tokens @block ` +
      `${table.enumeratedAtBlock} in ${Date.now() - startedAtMs}ms -> ${path}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
