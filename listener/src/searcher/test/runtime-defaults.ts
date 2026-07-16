import { readFileSync } from "node:fs";
import { evaluateEv } from "../ev-evaluator.js";
import { DEFAULT_BRIBE_BPS } from "../live-envelope.js";

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { scripts: Record<string, string> };
assert(packageJson.scripts.start === "node dist/searcher/main.js", `start=${packageJson.scripts.start}`);
assert(packageJson.scripts.dev === "tsx src/searcher/main.ts", `dev=${packageJson.scripts.dev}`);
assert(packageJson.scripts["legacy:start"] === "node dist/index.js", "legacy start is not explicit");
assert(packageJson.scripts["legacy:dev"] === "tsx src/index.ts", "legacy dev is not explicit");
console.log("[runtime-defaults] start/dev target the production searcher: PASS");

assert(DEFAULT_BRIBE_BPS === 5_000, `default bribe ${DEFAULT_BRIBE_BPS}`);
const ev = await evaluateEv(
  { async getBlock() { return { baseFeePerGas: 20n }; } },
  WETH,
  100_000n,
  100n,
  {
    ethUsd: 3_500,
    profitHaircutBps: 0,
    defaultGasUsed: 100,
    gasBufferMultX10: 10,
    evGate: true,
    bribeAllAboveGas: false,
    bribeBps: DEFAULT_BRIBE_BPS,
  },
);
assert(ev.expectedProfitEth === 100_000n, `expected profit ${ev.expectedProfitEth}`);
assert(ev.gasCostEth === 2_000n, `gas ${ev.gasCostEth}`);
assert(ev.bidEth === 50_000n, `bid ${ev.bidEth}`);
assert(ev.netEvWei === 48_000n, `net EV ${ev.netEvWei}`);
console.log("[runtime-defaults] production defaults retain positive EV: PASS");

console.log("runtime-defaults PASS (2/2)");
