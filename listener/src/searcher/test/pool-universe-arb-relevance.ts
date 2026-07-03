import { selectArbRelevantPools, type RankablePool } from "../pool-universe-arb-relevance.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

interface TestPool extends RankablePool {
  label: string;
}

// Mainnet provenance:
// WETH 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
// USDC 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
// DAI  0x6B175474E89094C44Da98b954EedeAC495271d0F
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const MEME = "0x1111111111111111111111111111111111111111";
const CFG = "0x39484A066aF5fEdFdef7ebf828E95CFB035fd1BC";

function pool(
  label: string,
  token0: string | undefined,
  token1: string | undefined,
  count: number,
  lastSwapBlock: number,
): TestPool {
  return { key: label, label, token0, token1, count, lastSwapBlock };
}

function labels(pools: TestPool[]): string[] {
  return pools.map((item) => item.label);
}

function main(): void {
  const island = pool("I", MEME, WETH, 100, 40);
  const loop = pool("L", USDC, WETH, 3, 30);
  const usdcDaiReturn = pool("U", USDC, DAI, 2, 20);
  // U is only a loop-completer if DAI also has another venue.
  const daiReturnVenue = pool("D", DAI, WETH, 1, 10);
  const candidates = [island, loop, usdcDaiReturn, daiReturnVenue];

  const enabled = selectArbRelevantPools(candidates, [], { enabled: true, maxPools: 2 });
  const enabledLabels = labels(enabled);
  assert(enabledLabels.includes("L"), "enabled: low-count loop-completer L should be selected");
  assert(enabledLabels.includes("U"), "enabled: low-count loop-completer U should be selected");
  assert(!enabledLabels.includes("I"), "enabled: high-count island I should be excluded");

  const disabled = selectArbRelevantPools(candidates, [], { enabled: false, maxPools: 2 });
  assert(labels(disabled).join(",") === "I,L", "disabled: should preserve count-only top-2 [I,L]");

  const cfgIsland = pool("X", CFG, WETH, 1, 25);
  const wethVenue = pool("W", USDC, WETH, 100, 35);
  const external = selectArbRelevantPools(
    [wethVenue, cfgIsland],
    [{ token0: CFG, token1: DAI }],
    { enabled: true, maxPools: 1 },
  );
  assert(labels(external).join(",") === "X", "external v4 token-degree: CFG pool should become a completer");

  const missingToken = pool("M", USDC, undefined, 100, 50);
  const complete = pool("C", USDC, WETH, 1, 45);
  const missing = selectArbRelevantPools(
    [missingToken, complete],
    [{ token0: USDC, token1: WETH }],
    { enabled: true, maxPools: 1 },
  );
  assert(labels(missing).join(",") === "C", "missing tokens: incomplete pool should stay an island");

  console.log(
    "[pool-universe-arb-relevance] PASS enabled_flip=true disabled_baseline=true " +
      "external_v4=true missing_tokens=true",
  );
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[pool-universe-arb-relevance] FAIL ${msg}`);
  process.exit(1);
}
