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

const deployNode = readFileSync(
  new URL("../../../../scripts/deploy-node.sh", import.meta.url),
  "utf8",
);
assert(
  deployNode.includes("obsolete .bribe-all-above-gas marker"),
  "deploy must fail fast on obsolete all-above-gas marker",
);
assert(
  !deployNode.includes('echo "SEARCHER_BRIBE_ALL_ABOVE_GAS=1"'),
  "deploy must not re-enable all-above-gas from a marker",
);
for (const retiredKey of [
  "SEARCHER_BRIBE_ALL_ABOVE_GAS",
  "SEARCHER_ETH_USD",
  "SEARCHER_GAS_BUFFER_MULT_X10",
]) {
  const occurrences = deployNode.match(new RegExp(retiredKey, "g"))?.length ?? 0;
  assert(occurrences >= 2, `deploy does not strip retired key ${retiredKey}`);
}
console.log("[runtime-defaults] deploy rejects/strips retired EV controls: PASS");

const deployAb = readFileSync(
  new URL("../../../../scripts/deploy-ab-challenger.sh", import.meta.url),
  "utf8",
);
assert(
  deployAb.includes("champion SEARCHER_BRIBE_ALL_ABOVE_GAS is obsolete and forbidden") &&
    deployAb.includes("challenger SEARCHER_BRIBE_ALL_ABOVE_GAS is obsolete and forbidden"),
  "A/B preflight must reject all-above-gas on both nodes",
);
console.log("[runtime-defaults] A/B preflight rejects all-above-gas: PASS");

assert(DEFAULT_BRIBE_BPS === 5_000, `default bribe ${DEFAULT_BRIBE_BPS}`);
const ev = await evaluateEv(
  {
    async getBlock() {
      return { baseFeePerGas: 20n, gasUsed: 100n, gasLimit: 200n };
    },
  },
  WETH,
  100_000n,
  100n,
  {
    profitHaircutBps: 0,
    evGate: true,
    bribeAllAboveGas: false,
    bribeBps: DEFAULT_BRIBE_BPS,
  },
);
assert(ev.expectedProfitEth === 100_000n, `expected profit ${ev.expectedProfitEth}`);
assert(ev.gasCostEth === 2_000n, `gas ${ev.gasCostEth}`);
assert(ev.bidEth === 49_000n, `bid ${ev.bidEth}`);
assert(ev.netEvWei === 49_000n, `net EV ${ev.netEvWei}`);
console.log("[runtime-defaults] production defaults retain positive EV: PASS");

console.log("runtime-defaults PASS (4/4)");
