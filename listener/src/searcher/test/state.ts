import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import { AnvilStateBackend } from "../../shared/state/state-backend.js";
import { ManualVictimSource, type OrderflowEvent } from "../orderflow/manual-source.js";
import { quote } from "../solver/quoter.js";
import { VICTIM_FIXTURES, assertVictimFixturesAreNotArbs } from "../fixtures/victims.js";

const QUOTE_IN = 100n * 10n ** 18n; // 100 DOLA
const MAX_DIFF_BPS = 1n; // 0.01%

function loadEnv(): void {
  const envPath = resolve("..", ".env");
  let text = "";
  try {
    text = readFileSync(envPath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.replace(/^export\s+/, "");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

async function main(): Promise<void> {
  loadEnv();
  assertVictimFixturesAreNotArbs();
  if (VICTIM_FIXTURES.length < 2) {
    throw new Error(`AC-state requires >= 2 victim fixtures, got ${VICTIM_FIXTURES.length}`);
  }

  const rpcUrl = process.env.MAINNET_RPC_URL;
  if (!rpcUrl) throw new Error("MAINNET_RPC_URL required");
  const mainProvider = new ethers.JsonRpcProvider(rpcUrl);
  const source = new ManualVictimSource(mainProvider, VICTIM_FIXTURES);
  const events: OrderflowEvent[] = [];
  for await (const event of source.next()) events.push(event);

  if (!events.some((event) => (event.transactionIndex ?? 0) > 0)) {
    throw new Error("AC-state requires at least one fixture with transactionIndex > 0");
  }
  for (const fixture of VICTIM_FIXTURES) {
    const event = events.find((e) => e.txHash.toLowerCase() === fixture.victimTxHash.toLowerCase());
    if (!event) throw new Error(`missing loaded event for ${fixture.victimTxHash}`);
    if (fixture.requiresPrefix && (event.transactionIndex ?? 0) <= 0) {
      throw new Error(`fixture ${fixture.victimTxHash} requires prefix but txIndex <= 0`);
    }
  }

  const state = new AnvilStateBackend(rpcUrl);
  await state.start();
  try {
    for (const event of events) {
      const txIndex = event.transactionIndex ?? 0;
      const result = await state.prepareVictimPostState({
        txHash: event.txHash,
        rawTx: event.rawTx,
        blockNumber: event.blockNumber,
        transactionIndex: txIndex,
        previousTxHash: event.previousTxHash,
        from: event.from,
        nonce: event.nonce,
        preferSequentialPrefix: event.preferSequentialPrefix,
      });
      console.log(
        `[searcher/state] ${event.txHash.slice(0, 10)}... mode=${result.mode} ` +
          `nonce=${result.nonceBefore}->${result.nonceAfter}`,
      );

      if (txIndex > 0 && result.mode !== "sequential-prefix") {
        const preparedQuote = await quoteDolaToWstUsr(state);
        await state.forkAfterTx(event.txHash);
        const txHashAnchorQuote = await quoteDolaToWstUsr(state);
        const diff = abs(preparedQuote - txHashAnchorQuote);
        const denom = preparedQuote > txHashAnchorQuote ? preparedQuote : txHashAnchorQuote;
        const diffBps = denom === 0n ? 0n : (diff * 10000n) / denom;
        if (diffBps > MAX_DIFF_BPS) {
          throw new Error(
            `prefix quote mismatch for ${event.txHash}: prepared=${preparedQuote} ` +
              `txHashAnchor=${txHashAnchorQuote} diffBps=${diffBps}`,
          );
        }
        console.log(
          `[searcher/state] prefix equivalence quote=${preparedQuote} diffBps=${diffBps}`,
        );
      } else if (txIndex > 0) {
        const preparedQuote = await quoteDolaToWstUsr(state);
        console.log(
          `[searcher/state] prefix replay quote=${preparedQuote} prefixCount=${result.replayedPrefixCount}`,
        );
      }
    }
  } finally {
    state.stop();
  }
  console.log("[searcher/state] PASS");
}

async function quoteDolaToWstUsr(state: AnvilStateBackend): Promise<bigint> {
  return quote(
    "curve-exchange-nr",
    ADDR.CURVE_DOLA_WSTUSR,
    ADDR.DOLA,
    ADDR.WSTUSR,
    QUOTE_IN,
    state,
  );
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

main().catch((err) => {
  console.error(`[searcher/state] FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
