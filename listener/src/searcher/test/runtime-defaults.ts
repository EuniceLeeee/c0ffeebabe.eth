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

assert(
  deployNode.includes('POOL_UNIVERSE_TO_BLOCK="$DISCOVERY_TO_BLOCK"'),
  "deploy must build the universe at the same frozen source as the searcher",
);
assert(
  deployNode.includes(
    '[ "$REINDEX_CUR_TOBLOCK" -le "$DISCOVERY_TO_BLOCK" ]',
  ),
  "deploy freshness check must reject a universe newer than its frozen source",
);
assert(
  !deployNode.includes("REINDEX_HEAD="),
  "deploy freshness must not compare against a later, independently-read head",
);
const universeLockAt = deployNode.indexOf('exec 9>"$UNIVERSE_LOCK"');
const universeSelectionAt = deployNode.indexOf("REINDEX_CUR_TOBLOCK=");
const universeSnapshotAt = deployNode.indexOf("UNIVERSE_HASH=");
const universeUnlockAt = deployNode.indexOf("flock -u 9");
assert(
  universeLockAt >= 0 &&
    universeLockAt < universeSelectionAt &&
    universeSelectionAt < universeSnapshotAt &&
    universeSnapshotAt < universeUnlockAt,
  "deploy must hold the cron universe lock from selection through immutable snapshot",
);
assert(
  deployNode.includes("loadPoolUniverseCoverageMetadata") &&
    deployNode.includes("loadPoolUniverse") &&
    deployNode.includes("!metadata.manifestVerified") &&
    deployNode.includes("toBlock > frozenSource") &&
    deployNode.includes("metadata.source?.number !== toBlock"),
  "deploy must use the production universe/manifest validator before selection",
);
assert(
  deployNode.includes(
    'pool universe re-indexed: $POOLS pools (toBlock=$DISCOVERY_TO_BLOCK)',
  ),
  "deploy must report the exact frozen universe source",
);
console.log("[runtime-defaults] deploy pins universe and searcher to one source: PASS");

const universeCron = readFileSync(
  new URL(
    "../../../../scripts/reindex-pool-universe-cron.sh",
    import.meta.url,
  ),
  "utf8",
);
const cronLockAt = universeCron.indexOf("flock -n 9");
const cronUniversePublishAt = universeCron.indexOf('mv "$TMP" "$OUT"');
const cronManifestPublishAt = universeCron.indexOf(
  'mv "$TMP_MANIFEST" "$OUT_MANIFEST"',
);
assert(
  cronLockAt >= 0 &&
    cronLockAt < cronUniversePublishAt &&
    cronUniversePublishAt < cronManifestPublishAt &&
    !universeCron.includes("flock -u 9"),
  "cron must hold the shared universe lock across both canonical publications",
);
console.log("[runtime-defaults] deploy/cron universe publication is serialized: PASS");

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

const mainSource = readFileSync(
  new URL("../main.ts", import.meta.url),
  "utf8",
);
assert(
  mainSource.includes(
    'process.env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_FALLBACK === "1"',
  ),
  "N-1 degraded fallback must remain explicit opt-in",
);
assert(
  mainSource.includes(
    'process.env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_STATE_BUDGET_MS ?? "20000"',
  ),
  "N-1 background pricing must retain its declared 20s default",
);
console.log("[runtime-defaults] N-1 fallback remains explicit opt-in: PASS");

const atomicStart = mainSource.indexOf(
  "async function maybeSubmitBlockScanAtomic",
);
const atomicSource = mainSource.slice(atomicStart);
const simulationAt = atomicSource.indexOf("simulator.simulate(resolved)");
const postSimulationFenceAt = atomicSource.indexOf(
  '"post-simulation source-head verification"',
);
const finalSimSucceededAt = atomicSource.indexOf(
  'finalSimStatus = "succeeded"',
);
const evEvaluationAt = atomicSource.indexOf("evaluateEv(");
assert(
  atomicStart >= 0 &&
    simulationAt >= 0 &&
    simulationAt < postSimulationFenceAt &&
    postSimulationFenceAt < finalSimSucceededAt &&
    finalSimSucceededAt < evEvaluationAt &&
    atomicSource.includes('"blockscan_stale_after_sim"'),
  "post-simulation block/hash fence must precede success and EV evaluation",
);
console.log("[runtime-defaults] final-sim head/hash fence ordering: PASS");

console.log("runtime-defaults PASS (8/8)");
