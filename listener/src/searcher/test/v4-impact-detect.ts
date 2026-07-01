// v4-impact-detection gate (v4 epic slice): a Uniswap v4 PoolManager Swap log
// must now produce a PoolImpact, keyed by poolId (topics[1]) matched to a pinned
// v4 edge's PoolKey. Before this decoder, v4 victims produced NO impact (0/80
// opportunities were v4). Uses the real on-chain swap from tx 0xd60d80df
// (block 25436883): amount0 -35013321757 USDC out / amount1 +35045872323 USDT in.
import { ethers } from "ethers";
import { detectImpactFromLogs } from "../detector/pool-impact.js";
import type { TokenEdge } from "../planner/token-graph.js";

const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ZERO = "0x0000000000000000000000000000000000000000";
const POOL_ID = "0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5";
const key = { currency0: USDC, currency1: USDT, fee: 8, tickSpacing: 1, hooks: ZERO };

// The two v4 edges the USDC/USDT pin produces (target = PoolManager singleton).
const edges = [
  { adapterId: "univ4-unlock", target: POOL_MANAGER, tokenIn: USDC, tokenOut: USDT, slotKind: "swap", v4PoolKey: key },
  { adapterId: "univ4-unlock", target: POOL_MANAGER, tokenIn: USDT, tokenOut: USDC, slotKind: "swap", v4PoolKey: key },
] as unknown as TokenEdge[];

const UNIV4_SWAP = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const data = ethers.AbiCoder.defaultAbiCoder().encode(
  ["int128", "int128", "uint160", "uint128", "int24", "uint24"],
  [-35013321757n, 35045872323n, 0n, 0n, 0, 8],
);
const log = {
  address: POOL_MANAGER,
  topics: [UNIV4_SWAP, POOL_ID, "0x000000000000000000000000e08d97e151473a848c3d9ca3f323cb720472d015"],
  data,
};

async function main() {
  let pass = true;

  // AFTER (pinned v4 edge present): the swap must yield a v4 impact, USDT->USDC.
  const impacts = await detectImpactFromLogs([log], edges);
  console.log("impacts:", JSON.stringify(impacts, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  const v4 = impacts.filter((i) => i.matchedAdapterId === "univ4-unlock");
  if (v4.length !== 1) {
    pass = false;
    console.log(`FAIL: expected exactly 1 v4 impact, got ${v4.length}`);
  } else {
    const i = v4[0];
    if (i.tokenIn.toLowerCase() !== USDT.toLowerCase()) { pass = false; console.log(`FAIL: tokenIn ${i.tokenIn} != USDT`); }
    if (i.tokenOut.toLowerCase() !== USDC.toLowerCase()) { pass = false; console.log(`FAIL: tokenOut ${i.tokenOut} != USDC`); }
    if (i.amountIn !== 35045872323n) { pass = false; console.log(`FAIL: amountIn ${i.amountIn} != 35045872323`); }
  }

  // BEFORE / negative control: with no v4 edge (nothing pinned), no v4 impact.
  const none = await detectImpactFromLogs([log], []);
  if (none.some((i) => i.matchedAdapterId === "univ4-unlock")) {
    pass = false;
    console.log("FAIL: emitted a v4 impact with no v4 edge in the graph");
  }

  console.log(pass ? "\nV4 IMPACT DETECT: PASS" : "\nV4 IMPACT DETECT: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
