/**
 * Self-contained resolution replay for the tx 0x149df3ec...fde60 gap.
 *
 * This is intentionally a pinned test fixture, not production admission
 * logic and not a general replay CLI. It regenerates the production universe
 * from the same frozen log window, then asks the unchanged blockscan-hunt to
 * self-enumerate and fork-simulate the landed core route. No path or amount is
 * injected into the planner/solver.
 */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cli = parseCli(process.argv.slice(2));
const LISTENER_ROOT = realpathSync(
  cli.runtimeListenerRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
);
const HUNT_PASS_BUDGET_MS = cli.huntPassBudgetMs ?? "300000";
if (HUNT_PASS_BUDGET_MS !== "300000" && HUNT_PASS_BUDGET_MS !== "600000") {
  throw new Error("--hunt-pass-budget-ms must be 300000|600000");
}
const RPC_URL = process.env.TX149_REPLAY_RPC_URL
  ?? process.env.SEARCHER_LIVE_RPC_URL
  ?? process.env.MAINNET_RPC_URL
  ?? "http://127.0.0.1:8545";

const UNIVERSE_FROM_BLOCK = 25_523_961;
const UNIVERSE_TO_BLOCK = 25_538_361;
const FORK_BLOCK = 25_535_055;

const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const PAXG = "0x45804880de22913dafe09f4980848ece6ecbaf78";
const GOLDX = "0x355c665e101b9da58704a8fddb5feef210ef20c0";
const USDX = "0xeb269732ab75a6fd61ea60b06fe994cd32a83549";
const V3_POOL = "0x7cb85f75e61226060453a997a7733f76707df337";
const V2_POOL = "0xef6317e783b22b2a2fc073e68260450236c20779";
const CURVE_POOL = "0xfe0a8e9d60131404ffaee95b48ebf908f4d8d808";

const EXPECTED_ROUTE = [
  {
    adapterId: "univ3-swap",
    slotKind: "swap",
    target: V3_POOL,
    tokenIn: USDT,
    tokenOut: PAXG,
  },
  {
    adapterId: "goldx-mint",
    slotKind: "protocol",
    target: GOLDX,
    tokenIn: PAXG,
    tokenOut: GOLDX,
  },
  {
    adapterId: "univ2-swap",
    slotKind: "swap",
    target: V2_POOL,
    tokenIn: GOLDX,
    tokenOut: USDX,
  },
  {
    adapterId: "curve-exchange-underlying",
    slotKind: "swap",
    target: CURVE_POOL,
    tokenIn: USDX,
    tokenOut: USDT,
  },
] as const;

const EXPECTED_SWAP_PATH = [
  { pool_id: V3_POOL, direction: "1for0" },
  { pool_id: V2_POOL, direction: "0for1" },
  { pool_id: CURVE_POOL, direction: "1for0" },
] as const;

interface HuntResult {
  stage?: string;
  matched_route?: unknown;
  final_sim_success?: boolean;
  net_profit_raw?: string | null;
}

function parseCli(args: string[]): {
  runtimeListenerRoot?: string;
  huntPassBudgetMs?: string;
} {
  const parsed: { runtimeListenerRoot?: string; huntPassBudgetMs?: string } = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires one value`);
    if (name === "--runtime-listener-root") {
      if (parsed.runtimeListenerRoot !== undefined) throw new Error(`${name} may appear only once`);
      parsed.runtimeListenerRoot = value;
    } else if (name === "--hunt-pass-budget-ms") {
      if (parsed.huntPassBudgetMs !== undefined) throw new Error(`${name} may appear only once`);
      parsed.huntPassBudgetMs = value;
    } else {
      throw new Error(`unsupported tx149 replay option ${name}`);
    }
  }
  return parsed;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("POOL_UNIVERSE_") || key.startsWith("HUNT_") || key.startsWith("AB_EXPECTED_")) {
      delete env[key];
    }
  }
  delete env.NODE_OPTIONS;
  delete env.npm_config_script_shell;
  delete env.NPM_CONFIG_SCRIPT_SHELL;
  return env;
}

function run(): void {
  const work = mkdtempSync(join(tmpdir(), "mev-tx149-replay-"));
  const universe = join(work, "active-pools.json");
  const huntOut = join(work, "hunt.json");
  const baseEnv = cleanEnv();

  try {
    const generated = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/searcher/build-active-pool-universe.ts"],
      {
        cwd: LISTENER_ROOT,
        encoding: "utf8",
        timeout: 20 * 60 * 1_000,
        env: {
          ...baseEnv,
          MAINNET_RPC_URL: RPC_URL,
          POOL_UNIVERSE_FROM_BLOCK: String(UNIVERSE_FROM_BLOCK),
          POOL_UNIVERSE_TO_BLOCK: String(UNIVERSE_TO_BLOCK),
          POOL_UNIVERSE_OUT: universe,
          POOL_UNIVERSE_MAX_POOLS: "0",
          POOL_UNIVERSE_ARB_RELEVANCE: "1",
          POOL_UNIVERSE_V4_BACKFILL_LOOKBACK_BLOCKS: "0",
        },
      },
    );
    if (generated.error || generated.status !== 0) {
      throw new Error(
        `universe generation failed (${generated.status ?? "signal"}): `
        + `${generated.error?.message ?? tail(generated.stderr)}`,
      );
    }

    const universeFile = JSON.parse(readFileSync(universe, "utf8")) as {
      fromBlock?: number;
      toBlock?: number;
      pools?: unknown[];
    };
    if (universeFile.fromBlock !== UNIVERSE_FROM_BLOCK
        || universeFile.toBlock !== UNIVERSE_TO_BLOCK
        || !Array.isArray(universeFile.pools)
        || universeFile.pools.length === 0) {
      throw new Error("generated universe does not match the pinned non-empty window");
    }
    console.log(
      `[tx149-replay] universe=${universeFile.pools.length} `
      + `window=${UNIVERSE_FROM_BLOCK}..${UNIVERSE_TO_BLOCK}`,
    );

    const hunted = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/searcher/test/blockscan-hunt.ts"],
      {
        cwd: LISTENER_ROOT,
        encoding: "utf8",
        timeout: 20 * 60 * 1_000,
        env: {
          ...baseEnv,
          SEARCHER_LIVE_RPC_URL: RPC_URL,
          MAINNET_RPC_URL: RPC_URL,
          SEARCHER_BLOCKSCAN_HUNT_ANVIL_PORT: "8574",
          HUNT_BLOCK: String(FORK_BLOCK),
          HUNT_UNIVERSE_PATH: universe,
          HUNT_MAX_POOLS: "20000",
          HUNT_MAX_HOPS: "4",
          HUNT_MIN_SPREAD_BPS: "0",
          HUNT_SCAN_BUDGET_MS: "120000",
          HUNT_PASS_BUDGET_MS,
          HUNT_MAX_CANDIDATES: "100",
          HUNT_TOP_K: "8",
          HUNT_OUT: huntOut,
          AB_EXPECTED_POOL_IDS: [V3_POOL, GOLDX, V2_POOL, CURVE_POOL].join(","),
          AB_EXPECTED_SWAP_PATH_JSON: JSON.stringify(EXPECTED_SWAP_PATH),
          AB_EXPECTED_ROUTE_JSON: JSON.stringify(EXPECTED_ROUTE),
          AB_EXPECTED_ROUTE_SCOPE: "dex-permissionless-protocol",
        },
      },
    );
    if (hunted.error || hunted.status !== 0) {
      throw new Error(
        `blockscan hunt failed (${hunted.status ?? "signal"}): `
        + `${hunted.error?.message ?? tail(`${hunted.stdout}\n${hunted.stderr}`)}`,
      );
    }
    const marker = String(hunted.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("BLOCKSCAN_HUNT_RESULT="))
      .at(-1);
    if (!marker) throw new Error(`blockscan hunt emitted no machine result: ${tail(hunted.stdout)}`);
    const result = JSON.parse(marker.slice("BLOCKSCAN_HUNT_RESULT=".length)) as HuntResult;
    console.log(`TX149_RESOLUTION_RESULT=${JSON.stringify(result)}`);
    if (result.stage !== "final_sim_success"
        || result.final_sim_success !== true
        || BigInt(result.net_profit_raw ?? "0") <= 0n
        || JSON.stringify(result.matched_route) !== JSON.stringify(EXPECTED_ROUTE)) {
      throw new Error(`expected not_admitted -> final_sim_success, got ${result.stage ?? "missing"}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function tail(value: unknown): string {
  return String(value ?? "").trim().slice(-4_000);
}

try {
  run();
} catch (error) {
  console.error(`[tx149-replay] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
