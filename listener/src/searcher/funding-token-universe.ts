import { ethers } from "ethers";
import { readFile, writeFile } from "node:fs/promises";
import { ADDR } from "../shared/constants/addresses.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "./blockscan-multicall.js";

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
const SCAN_CONCURRENCY = 8;
const MULTICALL_BATCH_SIZE = 256;

interface FundingRead {
  readonly target: string;
  readonly callData: string;
}

interface FundingReadResult {
  readonly success: boolean;
  readonly returnData: string;
}

async function scanLogs(
  provider: ethers.JsonRpcProvider,
  address: string,
  topic: string,
  from0: number,
  toBlock: number,
  label: string,
): Promise<readonly ethers.Log[]> {
  const ranges: Array<{ readonly fromBlock: number; readonly toBlock: number }> = [];
  for (let from = from0; from <= toBlock; from += SCAN_CHUNK_BLOCKS) {
    ranges.push(Object.freeze({
      fromBlock: from,
      toBlock: Math.min(toBlock, from + SCAN_CHUNK_BLOCKS - 1),
    }));
  }
  const batches = new Array<readonly ethers.Log[]>(ranges.length);
  let nextRange = 0;
  let completed = 0;
  console.log(
    `[searcher/live] funding token universe: ${label} log scan ` +
      `ranges=${ranges.length} concurrency=${SCAN_CONCURRENCY}`,
  );
  await Promise.all(Array.from(
    { length: Math.min(SCAN_CONCURRENCY, Math.max(1, ranges.length)) },
    async () => {
      while (true) {
        const index = nextRange++;
        if (index >= ranges.length) return;
        const range = ranges[index];
        batches[index] = await provider.getLogs({
          address,
          topics: [topic],
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
        });
        completed++;
        if (
          completed === 1 ||
          completed % 16 === 0 ||
          completed === ranges.length
        ) {
          console.log(
            `[searcher/live] funding token universe: ${label} log scan ` +
              `completed=${completed}/${ranges.length}`,
          );
        }
      }
    },
  ));
  return Object.freeze(batches.flatMap((batch) => [...batch]));
}

async function executeFundingReads(
  provider: ethers.JsonRpcProvider,
  blockNumber: number,
  reads: readonly FundingRead[],
  label: string,
): Promise<readonly FundingReadResult[]> {
  const results: FundingReadResult[] = [];
  const batches = Math.ceil(reads.length / MULTICALL_BATCH_SIZE);
  console.log(
    `[searcher/live] funding token universe: ${label} reads=${reads.length} ` +
      `multicallBatches=${batches}`,
  );
  for (let index = 0; index < reads.length; index += MULTICALL_BATCH_SIZE) {
    const chunk = reads.slice(index, index + MULTICALL_BATCH_SIZE);
    let decoded: readonly FundingReadResult[];
    try {
      const raw = await provider.call({
        to: BLOCKSCAN_MULTICALL3,
        data: blockScanMulticallIface.encodeFunctionData("aggregate3", [
          chunk.map((read) => Object.freeze({
            target: read.target,
            allowFailure: true,
            callData: read.callData,
          })),
        ]),
        blockTag: blockNumber,
      });
      const [multicallResults] = blockScanMulticallIface.decodeFunctionResult(
        "aggregate3",
        raw,
      ) as unknown as [readonly FundingReadResult[]];
      if (multicallResults.length !== chunk.length) {
        throw new Error(`${label} Multicall3 result cardinality mismatch`);
      }
      decoded = multicallResults;
    } catch (error) {
      // One adversarial/non-standard token can make the outer aggregate call
      // fail. Preserve the old per-token isolation for that bounded chunk;
      // this fallback changes transport only, never which failures are kept.
      console.log(
        `[searcher/live] funding token universe: ${label} Multicall3 ` +
          `fallback offset=${index} reason=${error instanceof Error
            ? error.message.slice(0, 160)
            : String(error).slice(0, 160)}`,
      );
      const direct: FundingReadResult[] = [];
      for (let directIndex = 0; directIndex < chunk.length; directIndex += 64) {
        direct.push(...await Promise.all(
          chunk.slice(directIndex, directIndex + 64).map(async (read) => {
            try {
              return Object.freeze({
                success: true,
                returnData: await provider.call({
                  to: read.target,
                  data: read.callData,
                  blockTag: blockNumber,
                }),
              });
            } catch {
              return Object.freeze({ success: false, returnData: "0x" });
            }
          }),
        ));
      }
      decoded = direct;
    }
    results.push(...decoded.map((result) => Object.freeze({
      success: result.success,
      returnData: result.returnData,
    })));
    const completed = Math.min(index + chunk.length, reads.length);
    if (
      completed === reads.length ||
      Math.floor(index / MULTICALL_BATCH_SIZE) % 16 === 0
    ) {
      console.log(
        `[searcher/live] funding token universe: ${label} progress ` +
          `${completed}/${reads.length}`,
      );
    }
  }
  return Object.freeze(results);
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
    "morpho-market",
  );
  const marketIds = marketLogs.flatMap((log) => {
    const parsed = MORPHO_BLUE_IFACE.parseLog({
      topics: log.topics,
      data: log.data,
    });
    return parsed === null ? [] : [parsed.args[0] as bigint];
  });
  const marketResults = await executeFundingReads(
    provider,
    head,
    marketIds.map((id) => Object.freeze({
      target: ADDR.MORPHO,
      callData: MORPHO_BLUE_IFACE.encodeFunctionData("market", [id]),
    })),
    "morpho-market",
  );
  for (let index = 0; index < marketResults.length; index++) {
    const result = marketResults[index];
    if (!result.success) {
      throw new Error(`Morpho market(${marketIds[index]}) lookup failed`);
    }
    const [market] = MORPHO_BLUE_IFACE.decodeFunctionResult(
      "market",
      result.returnData,
    );
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
  const balanceResults = await executeFundingReads(
    provider,
    head,
    candidates.map((token) => Object.freeze({
      target: token,
      callData: balanceOfData,
    })),
    "balancer-balance",
  );
  for (let index = 0; index < balanceResults.length; index++) {
    const result = balanceResults[index];
    if (!result.success) continue;
    try {
      const [balance] = ERC20_BALANCE_OF_IFACE.decodeFunctionResult(
        "balanceOf",
        result.returnData,
      );
      if (BigInt(balance) > 0n) tokens.add(candidates[index]);
    } catch {
      // Not an ERC20 (or empty return): cannot be flash-loaned.
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
