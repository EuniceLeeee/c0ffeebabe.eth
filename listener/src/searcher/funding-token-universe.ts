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
 *  - Balancer V2 Vault: current balanceOf(vault) > 0 over the candidate
 *    tokens - the Vault flash-loans any ERC20 it holds (its flashLoan only
 *    checks vault balance), queried via the balanceOf interface, never via
 *    pool-registration history.
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

const ERC20_BALANCE_OF_IFACE = new ethers.Interface([
  "function balanceOf(address account) view returns (uint256)",
]);

// Scan origin: comfortably before the Morpho Blue deploy block.
const MORPHO_BLUE_DEPLOY_FROM = 19_600_000;
// reth caps eth_getLogs ranges at 100000 blocks and results at 20000.
const SCAN_CHUNK_BLOCKS = 100_000;
const BALANCE_CONCURRENCY = 64;

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

export async function enumerateFundingTokenUniverse(input: {
  readonly provider: ethers.JsonRpcProvider;
  /**
   * Balancer balance candidates: the Vault flash-loans any ERC20 it holds
   * (its flashLoan only checks balanceOf(vault) >= amount), so the support
   * surface is current balances over the loop-relevant tokens - queried via
   * the balanceOf interface, never pool-registration history (which the
   * local node prunes).
   */
  readonly candidateTokens: readonly string[];
}): Promise<FundingTokenUniverseTable> {
  const provider = input.provider;
  const head = await provider.getBlockNumber();
  const tokens = new Set<string>();

  // Morpho Blue: one market entry per CreateMarket event; the flash loan
  // borrows the market loan token. (2024+ history, retained by the local
  // node.)
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

  // Balancer V2 Vault: current balanceOf > 0 over the candidate tokens (a
  // loan needs vault liquidity; empty balance means no flash loan).
  const balanceOfData = ERC20_BALANCE_OF_IFACE.encodeFunctionData(
    "balanceOf",
    [ADDR.BALANCER_VAULT],
  );
  const candidates = [...new Set(input.candidateTokens.map((token) =>
    ethers.getAddress(token).toLowerCase()
  ))].sort();
  for (let index = 0; index < candidates.length; index += BALANCE_CONCURRENCY) {
    const batch = await Promise.all(
      candidates.slice(index, index + BALANCE_CONCURRENCY).map((token) =>
        provider.call({ to: token, data: balanceOfData })
          .then((result) => ({ token, result }))
          .catch(() => ({ token, result: "0x" })),
      ),
    );
    for (const item of batch) {
      try {
        const [balance] = ERC20_BALANCE_OF_IFACE.decodeFunctionResult(
          "balanceOf",
          item.result,
        );
        if (BigInt(balance) > 0n) tokens.add(item.token);
      } catch {
        // Not an ERC20 (or empty return): cannot be flash-loaned.
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
  readonly candidateTokens: readonly string[];
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
  const table = await enumerateFundingTokenUniverse({
    provider: input.provider,
    candidateTokens: input.candidateTokens,
  });
  await writeFundingTokenUniverse(input.path, table);
  console.log(
    `[searcher/live] funding token universe: enumerated ${table.tokens.length} ` +
      `tokens @block ${table.enumeratedAtBlock}, solidified to ${input.path}`,
  );
  return table.tokens;
}
