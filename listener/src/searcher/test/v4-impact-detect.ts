// v4-impact-detection gate (v4 epic slice-2): a Uniswap v4 PoolManager Swap log
// must produce a PoolImpact, keyed by poolId (topics[1]) matched to a pinned v4
// edge's PoolKey. Before this decoder, v4 victims produced NO impact.
//
// Also gates the identity fix (Codex slice-2 review, blocking): every v4 pool
// shares the singleton PoolManager address, so the impact must carry `poolId` and
// two same-pair v4 pools (different fee) must NOT collapse in dedupe / matching.
import { ethers } from "ethers";
import { detectImpactFromLogs } from "../detector/pool-impact.js";
import { v4PoolId, type TokenEdge } from "../planner/token-graph.js";
import { deriveEdgeTaxonomy } from "../strategy-taxonomy.js";

const POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ZERO = "0x0000000000000000000000000000000000000000";

// Real pinned pool: USDC/USDT fee 8 / tickSpacing 1 / no hooks.
const key8 = { currency0: USDC, currency1: USDT, fee: 8, tickSpacing: 1, hooks: ZERO };
// A second REAL pinned same-pair v4 pool at a different fee tier (fee 7).
const key7 = { currency0: USDC, currency1: USDT, fee: 7, tickSpacing: 1, hooks: ZERO };
const id8 = v4PoolId(key8);
const id7 = v4PoolId(key7);

const edge = (k: typeof key8, id: string, tin: string, tout: string) =>
  ({ adapterId: "univ4-unlock", target: POOL_MANAGER, tokenIn: tin, tokenOut: tout, slotKind: "swap", ...deriveEdgeTaxonomy("swap"), v4PoolKey: k, poolId: id }) as unknown as TokenEdge;
const edges = [
  edge(key8, id8, USDC, USDT), edge(key8, id8, USDT, USDC),
  edge(key7, id7, USDC, USDT), edge(key7, id7, USDT, USDC),
];

const UNIV4_SWAP = ethers.id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
const swapLog = (poolId: string, a0: bigint, a1: bigint) => ({
  address: POOL_MANAGER,
  topics: [UNIV4_SWAP, poolId, "0x000000000000000000000000e08d97e151473a848c3d9ca3f323cb720472d015"],
  data: ethers.AbiCoder.defaultAbiCoder().encode(
    ["int128", "int128", "uint160", "uint128", "int24", "uint24"], [a0, a1, 0n, 0n, 0, 8]),
});

async function main() {
  let pass = true;
  const fail = (m: string) => { pass = false; console.log("FAIL: " + m); };

  // Sanity: computed poolIds match the TWO real pinned USDC/USDT v4 pools.
  if (id8 !== "0x395f91b34aa34a477ce3bc6505639a821b286a62b1a164fc1887fa3a5ef713a5") {
    fail(`v4PoolId(fee8) = ${id8} != on-chain 0x395f91b3...`);
  }
  if (id7 !== "0x0fb0e40cec3bb23e13abc585958a93c796fbea56955e19a23727a716a0423239") {
    fail(`v4PoolId(fee7) = ${id7} != on-chain 0x0fb0e40c...`);
  }
  if (id8 === id7) fail("fee 8 and fee 7 hashed to the same poolId");

  // Real on-chain swap on the fee-8 pool (tx 0xd60d80df): USDT in / USDC out.
  const i8 = await detectImpactFromLogs([swapLog(id8, -35013321757n, 35045872323n)], edges);
  const v8 = i8.filter((i) => i.matchedAdapterId === "univ4-unlock");
  if (v8.length !== 1) fail(`fee8 swap: expected 1 v4 impact, got ${v8.length}`);
  else {
    if (v8[0].tokenIn.toLowerCase() !== USDT.toLowerCase()) fail(`tokenIn ${v8[0].tokenIn} != USDT`);
    if (v8[0].tokenOut.toLowerCase() !== USDC.toLowerCase()) fail(`tokenOut ${v8[0].tokenOut} != USDC`);
    if (v8[0].amountIn !== 35045872323n) fail(`amountIn ${v8[0].amountIn} != 35045872323`);
    if (v8[0].poolId !== id8) fail(`impact.poolId ${v8[0].poolId} != id8 (identity lost)`);
  }

  // Identity: two same-pair pools (fee 8 + fee 7) in one log batch must yield
  // TWO distinct impacts with the right poolId — no collapse.
  const both = await detectImpactFromLogs(
    [swapLog(id8, -1000n, 2000n), swapLog(id7, 3000n, -4000n)], edges);
  const vb = both.filter((i) => i.matchedAdapterId === "univ4-unlock");
  if (vb.length !== 2) fail(`two pools: expected 2 distinct impacts, got ${vb.length} (dedupe collapsed?)`);
  if (!vb.some((i) => i.poolId === id8) || !vb.some((i) => i.poolId === id7)) fail("missing one of the two poolIds");

  // Negative control: no v4 edge => no v4 impact.
  const none = await detectImpactFromLogs([swapLog(id8, -1n, 2n)], []);
  if (none.some((i) => i.matchedAdapterId === "univ4-unlock")) fail("emitted v4 impact with no v4 edge");

  console.log(pass ? "\nV4 IMPACT DETECT: PASS" : "\nV4 IMPACT DETECT: FAIL");
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
