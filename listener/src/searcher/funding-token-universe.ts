import { ethers } from "ethers";
import { readFile, writeFile } from "node:fs/promises";
import { ADDR } from "../shared/constants/addresses.js";

/**
 * Funding token universe: the flash-loan tokens the funding families can
 * actually lend, enumerated from chain truth and solidified into a table
 * once ("一开始就固化下来"). The per-block funding stage reads flash
 * liquidity for exactly this set: it is bounded by the providers' real
 * support surface, not by the routing graph's token count (the 14400-window
 * graph carries thousands of tokens; reading all of them blew the block
 * budget and one unreadable result crashed the funding decode).
 *
 * Sources (chain truth, no allowlist):
 *  - Morpho Blue: every registered market's loan token (CreateMarket
 *    events + market(id)); Morpho flash loans borrow the market loan token.
 *  - Balancer V2 Vault: every registered pool's tokens (PoolRegistered
 *    events + getPoolTokens); the Vault flash-loans the tokens it holds.
 */
export const FUNDING_TOKEN_UNIVERSE_FORMAT = "funding-token-universe-v1";

export interface FundingTokenUniverseTable {
  readonly format: "funding-token-universe-v1";
  readonly enumeratedAtBlock: number;
  /** Lowercase token addresses, sorted. */
  readonly tokens: readonly string[];
}

const MORPHO_BLUE_IFACE = new ethers.Interface([
  "event CreateMarket(uint256 indexed id)",
  "function market(uint256 id) view returns " +
    "(tuple(address loanToken,address collateralToken,address oracle," +
    "address irm,uint256 lltv))",
]);

const BALANCER_VAULT_IFACE = new ethers.Interface([
  "event PoolRegistered(bytes32 indexed poolId,address indexed poolAddress," +
    "uint8 specialization)",
  "function getPoolTokens(bytes32 poolId) view returns " +
    "(address[] tokens,uint256[] balances,uint256 lastChangeBlock)",
]);

// Scan origins: comfortably before the provider deploy blocks.
const MORPHO_BLUE_DEPLOY_FROM = 19_600_000;
const BALANCER_VAULT_DEPLOY_FROM = 12_200_000;
// reth caps eth_getLogs ranges at 100000 blocks and results at 20000.
const SCAN_CHUNK_BLOCKS = 100_000;
const POOL_TOKEN_CALL_CONCURRENCY = 8;

async function scanLogs(
  provider: ethers.JsonRpcProvider,
  address: string,
  topic: string,
  from0: number,
  toBlock: number,
): Promise<readonly ethers.Log[]> {
  const logs: ethers.Log[] = [];
  for (let from = from0; from < toBlock; from += SCAN_CHUNK_BLOCKS) {
    const batch = await provider.getLogs({
      address,
      topics: [topic],
      fromBlock: from,
      toBlock: Math.min(toBlock, from + SCAN_CHUNK_BLOCKS - 1),
    });
    logs.push(...batch);
  }
  return logs;
}

export async function enumerateFundingTokenUniverse(
  provider: ethers.JsonRpcProvider,
): Promise<FundingTokenUniverseTable> {
  const head = await provider.getBlockNumber();
  const tokens = new Set<string>();

  // Morpho Blue: one market entry per CreateMarket event; the flash loan
  // borrows the market loan token.
  const marketTopic = MORPHO_BLUE_IFACE.getEvent("CreateMarket")!.topicHash;
  const marketLogs = await scanLogs(
    provider,
    ADDR.MORPHO,
    marketTopic,
    MORPHO_BLUE_DEPLOY_FROM,
    head,
  );
  for (const log of marketLogs) {
    const parsed = MORPHO_BLUE_IFACE.parseLog({
      topics: log.topics,
      data: log.data,
    });
    if (parsed === null) continue;
    const id = parsed.args[0] as bigint;
    const result = await provider.call({
      to: ADDR.MORPHO,
      data: MORPHO_BLUE_IFACE.encodeFunctionData("market", [id]),
    });
    const [market] = MORPHO_BLUE_IFACE.decodeFunctionResult("market", result);
    tokens.add(String(market.loanToken).toLowerCase());
  }

  // Balancer V2 Vault: every registered pool's tokens (the Vault holds and
  // flash-loans them).
  const poolTopic = BALANCER_VAULT_IFACE.getEvent("PoolRegistered")!.topicHash;
  const poolLogs = await scanLogs(
    provider,
    ADDR.BALANCER_VAULT,
    poolTopic,
    BALANCER_VAULT_DEPLOY_FROM,
    head,
  );
  const poolIds = poolLogs.flatMap((log) => {
    const parsed = BALANCER_VAULT_IFACE.parseLog({
      topics: log.topics,
      data: log.data,
    });
    return parsed === null ? [] : [String(parsed.args[0])];
  });
  for (
    let index = 0;
    index < poolIds.length;
    index += POOL_TOKEN_CALL_CONCURRENCY
  ) {
    const batch = await Promise.all(
      poolIds.slice(index, index + POOL_TOKEN_CALL_CONCURRENCY).map((poolId) =>
        provider.call({
          to: ADDR.BALANCER_VAULT,
          data: BALANCER_VAULT_IFACE.encodeFunctionData(
            "getPoolTokens",
            [poolId],
          ),
        })
      ),
    );
    for (const result of batch) {
      const [tokenList] = BALANCER_VAULT_IFACE.decodeFunctionResult(
        "getPoolTokens",
        result,
      );
      for (const token of tokenList as readonly string[]) {
        tokens.add(token.toLowerCase());
      }
    }
  }

  return Object.freeze({
    format: FUNDING_TOKEN_UNIVERSE_FORMAT,
    enumeratedAtBlock: head,
    tokens: Object.freeze([...tokens].sort()),
  });
}

export async function loadFundingTokenUniverse(
  path: string,
): Promise<FundingTokenUniverseTable | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Partial<FundingTokenUniverseTable>;
  const enumeratedAtBlock = record.enumeratedAtBlock;
  const tokens = record.tokens;
  if (
    record.format !== FUNDING_TOKEN_UNIVERSE_FORMAT ||
    !Number.isSafeInteger(enumeratedAtBlock) ||
    !Array.isArray(tokens) ||
    tokens.some((token) => !/^0x[0-9a-f]{40}$/.test(token))
  ) {
    return null;
  }
  return Object.freeze({
    format: FUNDING_TOKEN_UNIVERSE_FORMAT,
    enumeratedAtBlock: enumeratedAtBlock as number,
    tokens: Object.freeze([...tokens].sort()),
  });
}

export async function writeFundingTokenUniverse(
  path: string,
  table: FundingTokenUniverseTable,
): Promise<void> {
  await writeFile(path, JSON.stringify(table, null, 2) + "\n", {
    mode: 0o600,
  });
}

/** Load the solidified table, or enumerate + solidify once on first boot. */
export async function ensureFundingTokenUniverse(input: {
  readonly provider: ethers.JsonRpcProvider;
  readonly path: string;
}): Promise<readonly string[]> {
  const existing = await loadFundingTokenUniverse(input.path);
  if (existing !== null) {
    console.log(
      `[searcher/live] funding token universe: table ${input.path} ` +
        `${existing.tokens.length} tokens @block ${existing.enumeratedAtBlock}`,
    );
    return existing.tokens;
  }
  console.log(
    `[searcher/live] funding token universe: no table at ${input.path}, ` +
      "enumerating from chain truth (one-time)",
  );
  const table = await enumerateFundingTokenUniverse(input.provider);
  await writeFundingTokenUniverse(input.path, table);
  console.log(
    `[searcher/live] funding token universe: enumerated ${table.tokens.length} ` +
      `tokens @block ${table.enumeratedAtBlock}, solidified to ${input.path}`,
  );
  return table.tokens;
}
