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

const blockscanMulticallWrites =
  deployNode.match(
    /echo "SEARCHER_BLOCKSCAN_STATE_MULTICALL=\$BLOCKSCAN_STATE_MULTICALL"/g,
  )?.length ?? 0;
assert(
  blockscanMulticallWrites === 2 &&
    deployNode.includes(
      "BLOCKSCAN_STATE_MULTICALL=${SEARCHER_BLOCKSCAN_STATE_MULTICALL:-${RUNNING_BLOCKSCAN_STATE_MULTICALL:-0}}",
    ) &&
    deployNode.includes(
      "BLOCKSCAN_STATE_MULTICALL=${SEARCHER_BLOCKSCAN_STATE_MULTICALL:-${EXISTING_BLOCKSCAN_STATE_MULTICALL:-0}}",
    ) &&
    deployNode.includes("SEARCHER_BLOCKSCAN_STATE_MULTICALL must be 0 or 1") &&
    deployNode.includes(
      'process_env_count SEARCHER_BLOCKSCAN_STATE_MULTICALL "$NEWPID"',
    ) &&
    deployNode.includes(
      "restarted process SEARCHER_BLOCKSCAN_STATE_MULTICALL != $BLOCKSCAN_STATE_MULTICALL",
    ),
  "deploy must persist and verify block-scan multicall mode on both restart paths",
);
console.log("[runtime-defaults] deploy preserves block-scan multicall mode: PASS");

const searcherMain = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
const blockscanHunt = readFileSync(
  new URL("./blockscan-hunt.ts", import.meta.url),
  "utf8",
);
for (const source of [searcherMain, blockscanHunt]) {
  assert(
    source.includes("SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_SIZE") &&
      source.includes("SEARCHER_BLOCKSCAN_STATE_RPC_BATCH_CONCURRENCY") &&
      /STATE_RPC_BATCH_SIZE[\s\S]{0,120}(?:\?\? \"500\"|,\s*500,)/.test(source) &&
      /STATE_RPC_BATCH_CONCURRENCY[\s\S]{0,120}(?:\?\? \"4\"|,\s*4,)/.test(source),
    "live and trusted hunt must share the 500x4 block-scan RPC defaults",
  );
}
console.log("[runtime-defaults] live/hunt block-scan RPC defaults match: PASS");

const protocolTouchWrites =
  deployNode.match(
    /echo "SEARCHER_BLOCKSCAN_PROTOCOL_TOUCH_MODE=\$PROTOCOL_TOUCH_MODE"/g,
  )?.length ?? 0;
assert(
  protocolTouchWrites === 2 &&
    deployNode.includes(
      "PROTOCOL_TOUCH_MODE=${SEARCHER_BLOCKSCAN_PROTOCOL_TOUCH_MODE:-${RUNNING_PROTOCOL_TOUCH_MODE:-off}}",
    ) &&
    deployNode.includes(
      "PROTOCOL_TOUCH_MODE=${SEARCHER_BLOCKSCAN_PROTOCOL_TOUCH_MODE:-${EXISTING_PROTOCOL_TOUCH_MODE:-off}}",
    ) &&
    deployNode.includes(
      "SEARCHER_BLOCKSCAN_PROTOCOL_TOUCH_MODE must be off, shadow or enabled",
    ) &&
    deployNode.includes(
      'process_env_count SEARCHER_BLOCKSCAN_PROTOCOL_TOUCH_MODE "$NEWPID"',
    ) &&
    deployNode.includes(
      "restarted process SEARCHER_BLOCKSCAN_PROTOCOL_TOUCH_MODE != $PROTOCOL_TOUCH_MODE",
    ),
  "deploy must persist and verify protocol touch mode on both restart paths",
);
console.log("[runtime-defaults] deploy preserves protocol touch mode: PASS");

for (const retiredUniverseAuthority of [
  "build-active-pool-universe.ts",
  "pool-universe-deploy-trust.ts",
  "REINDEX_CUR_TOBLOCK",
  "UNIVERSE_LOCK",
  "UNIVERSE_MANIFEST_SNAPSHOT",
]) {
  assert(
    !deployNode.includes(retiredUniverseAuthority),
    `deploy must not restore legacy universe authority ${retiredUniverseAuthority}`,
  );
}
const checkpointWrites = deployNode.match(
  /echo "SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH=\$UNIVERSE_REBUILD_CHECKPOINT_PATH"/g,
)?.length ?? 0;
assert(
  deployNode.includes(
    'UNIVERSE_REBUILD_CHECKPOINT_PATH="${SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH:-/opt/MEV-runtime/universe-rebuild-checkpoint.json}"',
  ) &&
    checkpointWrites === 2 &&
    deployNode.includes("PROCESS_REBUILD_CHECKPOINT=$(process_env_value") &&
    deployNode.includes(
      'SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH "$NEWPID")',
    ) &&
    deployNode.includes(
      'process_env_count SEARCHER_UNIVERSE_REBUILD_CHECKPOINT_PATH "$NEWPID"',
    ) &&
    deployNode.includes(
      'READY_BANNER=$(printf \'%s\\n\' "$STARTUP_LOG"',
    ) &&
    deployNode.includes("universe rebuild ready generation=") &&
    deployNode.includes(
      'STARTUP_BANNER_TIMEOUT_SECONDS="${SEARCHER_STARTUP_BANNER_TIMEOUT_SECONDS:-3600}"',
    ) &&
    !deployNode.includes("pool universe loaded zero pools after restart"),
  "deploy must bind and verify the sole durable startup universe authority",
);
console.log("[runtime-defaults] deploy binds startup-only durable universe authority: PASS");

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
const adapterReplaySource = readFileSync(
  new URL("./adapter-replay.ts", import.meta.url),
  "utf8",
);
const productionReplaySource = readFileSync(
  new URL("./production-replay.ts", import.meta.url),
  "utf8",
);
const backrunHuntSource = readFileSync(
  new URL("./backrun-hunt.ts", import.meta.url),
  "utf8",
);
const blockscanHuntSource = readFileSync(
  new URL("./blockscan-hunt.ts", import.meta.url),
  "utf8",
);
const deployHaircutStripCount =
  deployNode.match(/\|SEARCHER_PROFIT_HAIRCUT_BPS\|/g)?.length ?? 0;
const deployHaircutWriteCount =
  deployNode.match(/echo "SEARCHER_PROFIT_HAIRCUT_BPS=\$PROFIT_HAIRCUT_BPS"/g)
    ?.length ?? 0;
assert(
  mainSource.includes(
    'process.env.SEARCHER_PROFIT_HAIRCUT_BPS ?? "0"',
  ) &&
    adapterReplaySource.includes("profitHaircutBps: 0,") &&
    productionReplaySource.includes(
      'numberEnv("SEARCHER_PROFIT_HAIRCUT_BPS", 0)',
    ) &&
    backrunHuntSource.includes(
      'process.env.SEARCHER_PROFIT_HAIRCUT_BPS ?? "0"',
    ) &&
    blockscanHuntSource.includes(
      'process.env.SEARCHER_PROFIT_HAIRCUT_BPS ?? "0"',
    ) &&
    deployNode.includes(
      'PROFIT_HAIRCUT_BPS="${SEARCHER_PROFIT_HAIRCUT_BPS:-0}"',
    ) &&
    deployHaircutStripCount === 2 &&
    deployHaircutWriteCount === 2,
  "live, historical harnesses and deploy must share the zero-haircut default",
);
console.log("[runtime-defaults] profit haircut defaults to zero everywhere: PASS");
const pricingSourceModeSource = readFileSync(
  new URL("../blockscan-pricing-source-mode.ts", import.meta.url),
  "utf8",
);
assert(
  mainSource.includes(
    "resolveBlockScanPricingSourceMode(",
  ) &&
    mainSource.includes(
      'blockScanPricingSource.mode === "n-1"',
    ) &&
    pricingSourceModeSource.includes(
      'environmentFallback === "1" ? "n-1" : "n"',
    ),
  "N-1 degraded fallback must remain an explicit CLI/environment selection",
);
assert(
  mainSource.includes(
    'process.env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_STATE_BUDGET_MS ?? "40000"',
  ),
  "N-1 background pricing must retain its declared 40s default",
);
assert(
  mainSource.includes(
    'process.env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_FAMILY_SETTLE_MS ?? "24000"',
  ),
  "N-1 family settlement must retain the declared 24s allocation",
);
assert(
  mainSource.includes(
    'process.env.SEARCHER_BLOCKSCAN_N_MINUS_ONE_MAX_GRAPH_LAG_BLOCKS ?? "10"',
  ),
  "N-1 graph reuse must retain its declared 10-block ceiling",
);
console.log("[runtime-defaults] N-1 fallback remains explicit opt-in: PASS");
assert(
  deployNode.includes("N_MINUS_ONE_MARKER=$REPO/.blockscan-nminus1") &&
    deployNode.includes(
      '[ -f "$N_MINUS_ONE_MARKER" ] && echo "SEARCHER_BLOCKSCAN_N_MINUS_ONE_FALLBACK=1"',
    ) &&
    deployNode.includes(
      "N-1 fallback remained enabled without its marker",
    ),
  "deploy must own N-1 activation through one reversible marker",
);
console.log("[runtime-defaults] deploy marker owns N-1 activation: PASS");

const atomicStart = mainSource.indexOf(
  "async function maybeSubmitBlockScanAtomic",
);
const atomicSource = mainSource.slice(atomicStart);
const simulationAt = atomicSource.indexOf(
  "const sim = await executeFinalSimulationWork({",
);
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

console.log("runtime-defaults PASS (9/9)");
